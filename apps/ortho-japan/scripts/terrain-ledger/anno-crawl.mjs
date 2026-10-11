#!/usr/bin/env node
// 地理院ベクトルタイルの注記（Anno）を日本の範囲（lon 122〜154.5・lat 20〜46）の z4〜z9 で全部読み、.cache/anno-<source>-<zmin>-<zmax>.json に書く。
//   node anno-crawl.mjs optimal_bvmap-v1 4 9      … 山・湖・山地・平野・岬・湾・島…（vt_code / vt_text）
//   node anno-crawl.mjs experimental_bvmap 4 8    … 川（annoCtg 322）は experimental にしか無い（annoChar＝全名・kana＝英字）
// 読むのは MVT（geopbf の検定用デコーダ）。タイルの無い所（海・圏外）は 404＝正常。8 並列・約 3 分（z9 の 2,100 枚込み）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTile } from "../../../../packages/geopbf/src/convert/mvt-decode.js";
const DIR = path.dirname(fileURLToPath(import.meta.url)), CACHE = path.join(DIR, ".cache");
const src = process.argv[2] || "optimal_bvmap-v1", zmin = +(process.argv[3] || 4), zmax = +(process.argv[4] || 9);
const bbox = [122, 20, 154.5, 46];
const x2lon = (x, z) => x / 2 ** z * 360 - 180, y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z), lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
const out = []; let n = 0, miss = 0;
for (let z = zmin; z <= zmax; z++) {
	const x0 = lon2x(bbox[0], z), x1 = lon2x(bbox[2], z), y0 = lat2y(bbox[3], z), y1 = lat2y(bbox[1], z);
	const jobs = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
	let i = 0;
	await Promise.all(Array.from({ length: 8 }, async () => { while (i < jobs.length) { const [x, y] = jobs[i++];
		let r; for (let k = 0; k < 4; k++) { try { r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${src}/${z}/${x}/${y}.pbf`); if (r.status < 500) break; } catch {} await new Promise(s => setTimeout(s, 500 * (k + 1))); }
		if (!r || r.status !== 200) { miss++; continue; } n++;
		for (const l of decodeTile(new Uint8Array(await r.arrayBuffer()))) { if (!/^(Anno|label)$/i.test(l.name)) continue;
			for (const f of l.features) { const g = f.geometry?.[0]; if (!g) continue;
				out.push({ z, src, ...f.props, lon: +x2lon(x + g[0] / l.extent, z).toFixed(4), lat: +y2lat(y + g[1] / l.extent, z).toFixed(4) }); } }
	} }));
	console.error(src, "z", z, "tiles", jobs.length, "ok", n, "miss", miss, "anno", out.length);
}
fs.mkdirSync(CACHE, { recursive: true });
fs.writeFileSync(path.join(CACHE, `anno-${src}-${zmin}-${zmax}.json`), JSON.stringify(out));
