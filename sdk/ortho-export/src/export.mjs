// ortho-export の本体：範囲（bbox）→ anchor.json・terrain.glb・buildings.glb・README.md（docs/notes/unity-roundtrip.md §3）。
//   fetchFn は注入口（検定は合成の fetch を渡す）。
import fs from "node:fs";
import path from "node:path";
import { makeAnchor } from "./geo.mjs";
import { createDem, GSI_DEM_PNG } from "./dem.mjs";
import { buildTerrain, GSI_IMAGERY } from "./terrain.mjs";
import { buildBuildings, pickPlateauSets } from "./buildings.mjs";
import { attributeTable } from "./features.mjs";
import { transcodeGlbImages, findImageConverter, foreignImages } from "./textures.mjs";
import { toGlb, parseGlb, buildGlb } from "glbconv";

export const VERSION = "0.1.0";
const GSI_GEOID_API = "https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl?outputType=json&latitude={lat}&longitude={lon}";

/** ジオイド高（m）：数なら定数、"auto" なら地理院のジオイド計算 API（日本のジオイド 2011） */
export async function resolveGeoid(geoid, lon, lat, fetchFn) {
	if (typeof geoid === "number") return { value: geoid, source: "given" };
	if (geoid !== "auto") throw new Error(`geoid: number or "auto" (got ${geoid})`);
	const r = await fetchFn(GSI_GEOID_API.replace("{lat}", lat).replace("{lon}", lon), {});
	if (!r.ok) throw new Error(`geoid api ${r.status}: pass --geoid <m> (Tokyo ≈ 36.7)`);
	const j = await r.json(), v = Number(j?.OutputData?.geoidHeight);
	if (!Number.isFinite(v)) throw new Error(`geoid api: unexpected answer ${JSON.stringify(j).slice(0, 200)}`);
	return { value: v, source: "GSI geoid model (GSIGEO2011)" };
}

/** glb の asset.extras.orthoEarth を書く（§2.3） */
export function stampGlb(glb, extras) {
	const { json, bin } = parseGlb(glb);
	json.asset = { ...(json.asset || { version: "2.0" }), generator: `ortho-earth ortho-export ${VERSION}`, extras: { ...(json.asset?.extras || {}), orthoEarth: extras } };
	return buildGlb(json, bin);
}

/**
 * @param {object} o
 * @param {number[]} o.bbox  [w,s,e,n]（度）
 * @param {string} o.out  出力フォルダ
 * @param {{lon,lat,height?}|null} [o.anchor]  省略＝bbox の中心・高さ＝その地点の地面（楕円体高）
 * @param {number|"auto"} [o.geoid]  既定 "auto"
 * @param {object} [o.terrain]  { zoom=17, imagery="seamlessphoto"|"std"|"pale"|"none", dem=GSI_DEM_PNG, demZoom=14, segments=32 } ／ null＝地形なし
 * @param {object} [o.buildings]  { tilesets: string[] } か { catalog: [...], textured }・共通で { split=true, clip=true, decodeDraco } ／ null＝建物なし
 * @param {object} [o.textures]  { converter, to="image/jpeg", quality=85, maxSize=2048 }＝webp などを Unity の読める形式へ（converter 省略＝手元の物を探す）
 * @param {(glb)=>glb} [o.fixup]  建物 glb の前処理（split=false の時だけ）
 */
export async function exportArea({ bbox, out, anchor: anchorIn = null, geoid = "auto", terrain = {}, buildings = {}, textures = {}, fixup = null, fetchFn = (u, i) => fetch(u, i), log = () => {} }) {
	if (!Array.isArray(bbox) || bbox.length !== 4 || !(bbox[0] < bbox[2] && bbox[1] < bbox[3])) throw new Error("bbox must be [w,s,e,n] in degrees");
	fs.mkdirSync(out, { recursive: true });
	const cx = anchorIn?.lon ?? (bbox[0] + bbox[2]) / 2, cy = anchorIn?.lat ?? (bbox[1] + bbox[3]) / 2;
	const g = await resolveGeoid(geoid, cx, cy, fetchFn);
	log(`geoid ${g.value.toFixed(2)} m (${g.source})`);

	const dem = createDem({ template: terrain?.dem ?? GSI_DEM_PNG, zoom: terrain?.demZoom ?? 14, fetchFn });
	let height = anchorIn?.height;
	if (height == null) { const h = await dem.heightAt(cx, cy); height = h + g.value; log(`ground at anchor: ${h.toFixed(2)} m (orthometric) → ${height.toFixed(2)} m (ellipsoidal)`); }
	const anchor = makeAnchor({ lon: cx, lat: cy, height });
	const sources = [];
	const extrasBase = { version: 1, anchor: { lon: cx, lat: cy, height }, frame: "enu", heading: 0, geoid: g.value, bbox, generator: `ortho-export ${VERSION}` };
	const result = { anchor: extrasBase.anchor, geoid: g.value, bbox, files: [] };

	// 地形
	if (terrain) {
		const imName = terrain.imagery ?? "seamlessphoto", imagery = imName === "none" ? null : GSI_IMAGERY[imName];
		if (imName !== "none" && !imagery) throw new Error(`imagery: ${Object.keys(GSI_IMAGERY).join("|")}|none`);
		const t = await buildTerrain({ bbox, anchor, dem, geoid: g.value, zoom: terrain.zoom ?? 17, imagery, segments: terrain.segments ?? 32, fetchFn });
		const src = [{ kind: "terrain", name: "地理院標高タイル（DEM10B・dem_png）", url: dem.template, license: "国土地理院コンテンツ利用規約（出典の明記）", attribution: "国土地理院" }];
		if (imagery) src.push({ kind: "imagery", name: `地理院タイル（${imagery.name}）`, url: imagery.template, license: "国土地理院コンテンツ利用規約（出典の明記）", attribution: "国土地理院" });
		const [file] = toGlb({ rtc: null, prims: t.prims, bbox: bboxOf(t.prims) }, { name: "terrain" });
		const glb = stampGlb(file.bytes, { ...extrasBase, source: src });
		fs.writeFileSync(path.join(out, "terrain.glb"), glb);
		result.files.push({ name: "terrain.glb", bytes: glb.length, tiles: t.tiles, vertices: t.vertices, zoom: t.zoom });
		sources.push(...src);
		log(`terrain.glb: ${t.tiles} tiles, ${t.vertices} vertices, ${(glb.length / 1e6).toFixed(1)} MB (dem ${JSON.stringify(dem.stats())})`);
	}

	// 建物
	if (buildings) {
		let tilesets = buildings.tilesets;
		if (!tilesets) {
			const sets = pickPlateauSets(buildings.catalog || [], bbox, { textured: !!buildings.textured });
			if (!sets.length) log("buildings: no PLATEAU set covers the bbox center");
			tilesets = sets.map(s => s.base.replace(/\/?$/, "/") + "tileset.json");
		}
		if (tilesets.length) {
			const split = buildings.split ?? true;
			const b = await buildBuildings({ tilesets, bbox, anchor, split, clip: buildings.clip ?? true, decodeDraco: buildings.decodeDraco ?? null, fetchFn, fixup, log });
			if (b.glb) {
				const src = b.sources.map(u => ({ kind: "buildings", name: "Project PLATEAU 3D 都市モデル（建築物）", url: u, license: "CC BY 4.0", attribution: "国土交通省 Project PLATEAU" }));
				let glb = b.glb, tex = null;
				if (textures && foreignImages(glb)) {   // webp（PLATEAU のテクスチャ付き）→ jpeg/png：glTFast は webp を解かない
					const converter = textures.converter !== undefined ? textures.converter : await findImageConverter(textures.tool ?? null);
					tex = await transcodeGlbImages(glb, { converter, to: textures.to ?? "image/jpeg", quality: textures.quality ?? 85, maxSize: textures.maxSize ?? 2048, log });
					glb = tex.glb;
					if (tex.converted || tex.failed) log(`textures: ${tex.converted} image(s) → ${textures.to ?? "image/jpeg"} with ${converter?.name}${tex.failed ? `, ${tex.failed} failed (left as is)` : ""} (${(tex.before / 1e6).toFixed(1)} → ${(tex.after / 1e6).toFixed(1)} MB)`);
				}
				glb = stampGlb(glb, { ...extrasBase, source: src, ...(b.features ? { features: { count: b.features.length, node: "name = gml_id", extras: "plateau", table: "buildings.attributes.json" } } : {}) });
				fs.writeFileSync(path.join(out, "buildings.glb"), glb);
				result.files.push({ name: "buildings.glb", bytes: glb.length, tiles: b.tiles, buildings: b.features?.length, textures: tex?.converted || 0 });
				sources.push(...src);
				log(`buildings.glb: ${b.tiles} tiles${b.features ? `, ${b.features.length} buildings` : ""}, ${(glb.length / 1e6).toFixed(1)} MB`);
				if (b.features) {
					const table = { ...attributeTable(b.features), source: "Project PLATEAU（国土交通省）CC BY 4.0", glb: "buildings.glb" };
					const f = path.join(out, "buildings.attributes.json");
					fs.writeFileSync(f, JSON.stringify(table) + "\n");
					result.files.push({ name: "buildings.attributes.json", bytes: fs.statSync(f).size, buildings: table.buildings.length, keys: table.keys.length });
					log(`buildings.attributes.json: ${table.buildings.length} buildings × ${table.keys.length} keys`);
				}
			}
		}
	}

	const anchorJson = { ...extrasBase, source: sources, unity: { note: "glTF axes are (east, up, -north). glTFast flips X on import, so the raw prefabs are (west, up, south): rotate their parent 180 deg about Y (the package's Place menu does this) to get X=east, Y=up, Z=north, 1 unit = 1 m.", gltfAxes: { x: "east", y: "up", z: "south" }, axesAfterPlace: { x: "east", y: "up", z: "north" } }, unreal: { note: "Unreal's glTF importer (Interchange) maps glTF (x, y, z) to Unreal (x, z, y) and metres to centimetres, so the levels come in as X=east, Y=south, Z=up (the Cesium for Unreal frame): the plugin's Place puts them under one OrthoEarthAnchor actor at the origin.", axes: { x: "east", y: "south", z: "up" }, units: "cm" } };
	fs.writeFileSync(path.join(out, "anchor.json"), JSON.stringify(anchorJson, null, "\t") + "\n");
	fs.writeFileSync(path.join(out, "README.md"), readme(anchorJson, result));
	result.files.push({ name: "anchor.json" }, { name: "README.md" });
	return result;
}

function bboxOf(prims) {
	const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (const p of prims) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], p.positions[i + k]); b[3 + k] = Math.max(b[3 + k], p.positions[i + k]); }
	return b;
}
function readme(a, r) {
	const f = r.files.filter(x => x.bytes).map(x => `| \`${x.name}\` | ${(x.bytes / 1e6).toFixed(1)} MB | ${x.keys ? `${x.buildings} buildings × ${x.keys} attribute keys` : `${x.tiles ?? ""} tiles${x.buildings ? ` · ${x.buildings} buildings (one node each, name = gml_id)` : ""}${x.textures ? ` · ${x.textures} textures (jpeg/png)` : ""}${x.vertices ? ` · ${x.vertices} vertices · z${x.zoom}` : ""}`} |`).join("\n");
	const s = a.source.map(x => `- ${x.name} — ${x.attribution} — ${x.license} — ${x.url}`).join("\n");
	return `# ortho-export: ${a.bbox.map(v => v.toFixed(5)).join(", ")}

Generated by ${a.generator} on ${new Date().toISOString().slice(0, 10)}.

## Anchor

- lon ${a.anchor.lon}, lat ${a.anchor.lat}, ellipsoidal height ${a.anchor.height.toFixed(2)} m (geoid ${a.geoid.toFixed(2)} m)
- Frame: ENU at the anchor. glTF axes = (east, up, −north), the Cesium convention. glTFast flips X on import, so the imported prefabs are (west, up, south):
  the Ortho Earth package's "Place export folder in scene…" puts them under a node rotated 180° about Y, giving X = east, Y = up, Z = north, 1 unit = 1 m.
- All GLBs of this folder share the anchor: keep them on the same parent.
- The anchor is also inside each GLB as \`asset.extras.orthoEarth\`.
${r.files.some(x => x.keys) ? `
## Building attributes

- \`buildings.glb\` has one node per building: node name = PLATEAU \`gml_id\`, node \`extras.plateau\` = its row of the 3D Tiles batch table (CityGML attributes).
- \`buildings.attributes.json\` is the same as a flat table for Unity (\`keys\` + one \`values\` row per building, nested keys joined with \`/\`).
  "Place export folder in scene…" adds an \`OrthoEarthBuilding\` component to each building GameObject; select a building to see its attributes.
` : ""}
## Files

| file | size | contents |
| --- | --- | --- |
${f}

## Sources and licenses

${s}

Keep this attribution with any redistribution of the files above.
`;
}
