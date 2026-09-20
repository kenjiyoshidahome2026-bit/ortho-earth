#!/usr/bin/env node
// 名所の 3D 模型を作る：PLATEAU の 3D Tiles（建築物 LOD3・テクスチャ付き）から名所のまわりのタイルを集め、
// 1 枚の glb に束ねて out/ へ置く（→ npm run models -- --dir out/ --any で bucket GIS/models へ）。
//
//   npm run landmarks                 … scripts/tiles3d/landmarks.json の全件
//   npm run landmarks -- tokyo-tower  … id 指定
//   npm run landmarks -- --jpeg       … webp テクスチャを jpeg へ焼き直す（大きくなる。ふつうは不要）
//   npm run landmarks -- --out <dir>
//
// 置き場所は glb 自身が持つ（CESIUM_RTC か絶対 ECEF）＝台帳の lon/lat は「飛び先」の指定だけで、錨にはならない。
// ⚠検証でテクスチャが出ない時は、まずブラウザの HTTP キャッシュを疑う（URL に ?v= を付けて確かめる。2026-09-21 に丸一周した）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTiles, b3dmToGlb } from "./tiles3d/tiles3d.mjs";
import { mergeGlb, parseGlb } from "./tiles3d/glbmerge.mjs";
import { webpToJpeg } from "./tiles3d/webp2jpeg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "tiles3d/landmarks.json"), "utf8"));
const args = process.argv.slice(2);
const jpeg = args.includes("--jpeg");
const oi = args.indexOf("--out"), outDir = oi >= 0 ? args[oi + 1] : path.join(HERE, "../out/models");
const want = args.filter((a, i) => !a.startsWith("--") && !(oi >= 0 && i === oi + 1));
fs.mkdirSync(outDir, { recursive: true });

for (const L of cfg.landmarks.filter(l => !want.length || want.includes(l.id))) {
	const ts = cfg.base + cfg.sets[L.set];
	const dLat = L.r / 111320, dLon = L.r / (111320 * Math.cos(L.lat * Math.PI / 180));
	const tiles = await collectTiles(ts, [L.lon - dLon, L.lat - dLat, L.lon + dLon, L.lat + dLat]);
	const parts = []; let tri = 0;
	for (const t of tiles) {
		const r = await fetch(t.url); if (!r.ok) { console.warn(`  skip ${r.status}`); continue; }
		try {
			const { glb } = b3dmToGlb(new Uint8Array(await r.arrayBuffer()));
			const { json } = parseGlb(glb);
			for (const m of json.meshes || []) for (const p of m.primitives || [])
				tri += ((p.indices != null ? json.accessors[p.indices]?.count : json.accessors[p.attributes.POSITION]?.count) || 0) / 3;
			parts.push(glb);
		} catch (e) { console.warn("  skip", e.message); }
	}
	if (!parts.length) { console.error(`✖ ${L.id}: no tiles`); continue; }
	const glb = jpeg ? webpToJpeg(mergeGlb(parts)) : mergeGlb(parts);
	const f = path.join(outDir, `${L.id}.glb`);
	fs.writeFileSync(f, glb);
	console.log(`✓ ${L.id}: ${parts.length} tiles, ~${Math.round(tri)} tris, ${(glb.length / 1e6).toFixed(2)} MB → ${f}`);
}
