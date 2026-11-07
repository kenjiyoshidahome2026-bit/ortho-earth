// PLATEAU 建物（3D Tiles）→ 錨の glTF 座標の 1 枚の GLB（docs/notes/unity-roundtrip.md §3.2）。
//   既定（split）：棟ごとのノード（name＝gml_id・extras.plateau＝batch table の行）・頂点は錨の座標に畳む・Draco は解く（src/features.mjs）。
//   --attributes none（split=false）：以下の従来の道＝タイルを束ねるだけ。
//   木を降りて bbox に重なる葉（b3dm）を集め（src/tiles3d＝apps/uploader から移した）、1 枚に束ね（mergeGlb＝CESIUM_RTC の差で平行移動・中身は解かない＝Draco もそのまま）、
//   束の根に「3D Tiles の glb（Y-up・RTC）→ ECEF → 錨の glTF」の 4x4 を持つ親ノードを 1 つ挟む。頂点は書き換えない＝読み手（glTFast）が行列を畳む。
//   CESIUM_RTC は外す（頂点はもう錨の座標＝残すと ECEF へ二重に動かす読み手がある）。錨は asset.extras.orthoEarth（§2.3）。
import { collectTiles } from "./tiles3d/tiles3d.mjs";
import { mergeGlb, parseGlb } from "./tiles3d/glbmerge.mjs";
import { ecefToGltfMatrix, tileGltfToEcefMatrix, mat4Mul } from "./geo.mjs";
import { readB3dm, batchTableRows, featureIdOf, createDracoDecoder, splitPrims, rowInside } from "./features.mjs";
import { buildGlb, glbToScene, toGlb } from "glbconv";

/** 台帳（packages/jp/assets/plateau-sets.json）から bbox の中心を含む建物セットを選ぶ（橋梁などは除く） */
export function pickPlateauSets(catalog, bbox, { textured = false } = {}) {
	const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
	const hit = catalog.filter(s => /-bldg-/.test(s.base) && s.bbox && cx >= s.bbox[0] && cx <= s.bbox[2] && cy >= s.bbox[1] && cy <= s.bbox[3]);
	return hit.map(s => ({ ...s, base: textured ? s.base.replace("-notexture-", "-texture-") : s.base }));
}

/**
 * @param {object} o
 * @param {string[]} o.tilesets  tileset.json の URL（複数可）
 * @param {number[]} o.bbox
 * @param {object} o.anchor  makeAnchor の戻り
 * @param {boolean} [o.split]  true（既定）＝棟ごとのノードに割り、属性を載せる（Draco を解く＝無圧縮）。false＝タイルを束ねるだけ（Draco のまま・属性なし）
 * @param {boolean} [o.clip]  split の時、中心（batch table の _x/_y）が bbox の外の棟を落とす（既定 true）
 * @param {Function} [o.decodeDraco]  Draco の解き手（省略＝draco3d）
 * @param {(glb:Uint8Array)=>Uint8Array} [o.fixup]  split=false の時、束ねる前に各 glb へ掛ける
 * @returns {Promise<{ glb: Uint8Array|null, tiles: number, bytes: number, sources: string[], features: Array<{id:string,row:object}>|null }>}
 */
export async function buildBuildings({ tilesets, bbox, anchor, split = true, clip = true, decodeDraco = null, fetchFn = (u, i) => fetch(u, i), fixup = null, concurrency = 6, log = () => {} }) {
	const sources = [];
	const fetched = [];   // { b3dm: readB3dm の戻り, transform }
	for (const ts of tilesets) {
		const hits = await collectTiles(ts, bbox);
		log(`${ts}: ${hits.length} tiles`);
		let i = 0;
		const got = new Array(hits.length);
		await Promise.all(Array.from({ length: concurrency }, async () => {
			while (i < hits.length) {
				const k = i++, h = hits[k];
				const r = await fetchFn(h.url, {});
				if (!r.ok) { log(`skip ${r.status} ${h.url}`); continue; }
				got[k] = { b3dm: readB3dm(new Uint8Array(await r.arrayBuffer())), transform: h.transform, url: h.url };
			}
		}));
		for (const g of got) if (g) fetched.push(g);
		sources.push(ts);
	}
	if (!fetched.length) return { glb: null, tiles: 0, bytes: 0, sources, features: null };
	if (!split) {
		if (fetched.some(f => !isIdentity(f.transform))) log("warning: tileset transform is not identity; positions may be off without per-building split");
		const parts = fetched.map(f => fixup ? fixup(f.b3dm.glb) : f.b3dm.glb);
		const glb = reframeGlb(mergeGlb(parts), anchor);
		return { glb, tiles: parts.length, bytes: glb.length, sources, features: null };
	}

	// 棟ごと：タイルの glTF（Y-up・RTC）→（タイルの transform）→ ECEF → 錨の glTF を頂点に畳み、_BATCHID で割る
	const draco = decodeDraco || (fetched.some(f => /KHR_draco_mesh_compression/.test(glbJsonText(f.b3dm.glb))) ? await createDracoDecoder() : null);
	const toAnchor = ecefToGltfMatrix(anchor);
	const nodes = new Map();   // gml_id → SceneNode（タイルをまたぐ棟は 1 ノード）
	const features = [];
	const prims = [];
	let dropped = 0, tiles = 0;
	for (const [ti, f] of fetched.entries()) {
		const scene = await glbToScene(f.b3dm.glb, { decodeDraco: draco, anchor: false });
		const rtc = scene.rtc || f.b3dm.rtc || [0, 0, 0];
		const M = mat4Mul(toAnchor, mat4Mul(f.transform || I4, tileGltfToEcefMatrix(rtc)));
		const rows = batchTableRows(f.b3dm.bt, f.b3dm.batchLength);
		const keep = new Map();   // batch id → node | null（落とす）
		const nodeOf = b => {
			if (keep.has(b)) return keep.get(b);
			const row = rows[b];
			let nd = null;
			if (!row) nd = nodeFor(nodes, `tile${ti}_${b < 0 ? "mesh" : b}`, null, features);
			else if (clip && !rowInside(row, bbox)) { dropped++; nd = false; }
			else nd = nodeFor(nodes, featureIdOf(row) ?? `tile${ti}_${b}`, row, features);
			keep.set(b, nd); return nd;
		};
		for (const p of splitPrims(scene.prims, M, nodeOf)) if (p.node !== false) prims.push(p);
		tiles++;
	}
	if (!prims.length) return { glb: null, tiles, bytes: 0, sources, features };
	if (dropped) log(`clip: dropped ${dropped} building(s) whose centre is outside the bbox (--no-clip keeps whole tiles)`);
	const [file] = toGlb({ rtc: null, prims, bbox: [0, 0, 0, 0, 0, 0] }, { name: "buildings" });
	return { glb: file.bytes, tiles, bytes: file.bytes.length, sources, features };
}
function nodeFor(nodes, id, row, features) {
	let nd = nodes.get(id);
	if (!nd) {
		nd = { name: id, extras: row ? { plateau: row } : undefined };
		nodes.set(id, nd);
		if (row) features.push({ id, row });
	}
	return nd;
}
const glbJsonText = glb => { const n = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true); return new TextDecoder().decode(glb.subarray(20, 20 + n)); };
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 3D Tiles 由来の glb（CESIUM_RTC）を錨の座標へ：親ノード 1 つに行列を持たせ、RTC を外す */
export function reframeGlb(glb, anchor) {
	const { json, bin } = parseGlb(glb);
	const rtc = json.extensions?.CESIUM_RTC?.center || [0, 0, 0];
	const M = mat4Mul(ecefToGltfMatrix(anchor), tileGltfToEcefMatrix(rtc));
	const scene = json.scenes?.[json.scene ?? 0] || (json.scenes = [{ nodes: [] }])[0];
	json.nodes = json.nodes || [];
	const root = json.nodes.length;
	json.nodes.push({ name: "ortho-earth anchor", matrix: M, children: scene.nodes || [] });
	scene.nodes = [root];
	if (json.extensions) { delete json.extensions.CESIUM_RTC; if (!Object.keys(json.extensions).length) delete json.extensions; }
	for (const k of ["extensionsUsed", "extensionsRequired"]) if (json[k]) { json[k] = json[k].filter(e => e !== "CESIUM_RTC"); if (!json[k].length) delete json[k]; }
	return buildGlb(json, bin);
}
const isIdentity = m => !m || m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
