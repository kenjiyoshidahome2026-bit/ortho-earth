// PLATEAU 建物（3D Tiles）→ 錨の glTF 座標の 1 枚の GLB（docs/notes/unity-roundtrip.md §3.2）。
//   木を降りて bbox に重なる葉（b3dm）を集め（src/tiles3d＝apps/uploader から移した）、1 枚に束ね（mergeGlb＝CESIUM_RTC の差で平行移動・中身は解かない＝Draco もそのまま）、
//   束の根に「3D Tiles の glb（Y-up・RTC）→ ECEF → 錨の glTF」の 4x4 を持つ親ノードを 1 つ挟む。頂点は書き換えない＝読み手（glTFast）が行列を畳む。
//   CESIUM_RTC は外す（頂点はもう錨の座標＝残すと ECEF へ二重に動かす読み手がある）。錨は asset.extras.orthoEarth（§2.3）。
import { collectTiles, b3dmToGlb } from "./tiles3d/tiles3d.mjs";
import { mergeGlb, parseGlb } from "./tiles3d/glbmerge.mjs";
import { ecefToGltfMatrix, tileGltfToEcefMatrix, mat4Mul } from "./geo.mjs";
import { buildGlb } from "glbconv";

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
 * @param {(glb:Uint8Array)=>Uint8Array} [o.fixup]  束ねる前に各 glb へ掛ける（webp→jpeg など）
 * @returns {Promise<{ glb: Uint8Array|null, tiles: number, bytes: number, sources: string[] }>}
 */
export async function buildBuildings({ tilesets, bbox, anchor, fetchFn = (u, i) => fetch(u, i), fixup = null, concurrency = 6, log = () => {} }) {
	const parts = [], sources = [];
	let tiles = 0;
	for (const ts of tilesets) {
		const hits = await collectTiles(ts, bbox);
		log(`${ts}: ${hits.length} tiles`);
		if (hits.some(h => !isIdentity(h.transform))) log("warning: tileset transform is not identity; positions may be off (v1 assumes RTC-only tiles like PLATEAU)");
		let i = 0;
		const got = new Array(hits.length);
		await Promise.all(Array.from({ length: concurrency }, async () => {
			while (i < hits.length) {
				const k = i++, h = hits[k];
				const r = await fetchFn(h.url, {});
				if (!r.ok) { log(`skip ${r.status} ${h.url}`); continue; }
				let { glb } = b3dmToGlb(new Uint8Array(await r.arrayBuffer()));
				if (fixup) glb = fixup(glb);
				got[k] = glb;
			}
		}));
		for (const g of got) if (g) { parts.push(g); tiles++; }
		sources.push(ts);
	}
	if (!parts.length) return { glb: null, tiles: 0, bytes: 0, sources };
	const merged = mergeGlb(parts);
	const glb = reframeGlb(merged, anchor);
	return { glb, tiles, bytes: glb.length, sources };
}

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
