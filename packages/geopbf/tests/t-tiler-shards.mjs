#!/usr/bin/env node
// t-tiler-shards: tiler の「worker 数に依らず byte 同一」と点の間引き（geopbf 改良点 13・2026-10-12・俯瞰 §2-F 18）。
//   ・極小面の積算（tinyPolygon の代わりの正方形）が列の分担（shard）をまたいでも同じ＝workers 0 と 4 で PMTiles が byte 同一
//     （旧＝積算が job（1 ズーム×列範囲）ごとだったので、小島の群れが shard 境界をまたぐと正方形の数と置き場が worker 数で変わった）
//   ・MultiPoint の低ズーム間引き（dropRate）が点単位（tippecanoe の -r と同じ）＝1 feature の点が全部一蓮托生にならない・残る点はズームで入れ子
import { GeoPBF } from "../src/pbf-base.js";
import { bakeGint } from "../src/convert/node-gint.js";
import { toPMTiles } from "../src/convert/tiler.js";
import { readPMTiles } from "../src/convert/pmtiles.js";
import { decodeTile } from "../src/convert/mvt-decode.js";

let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const sq = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
// 小島の群れ 3 feature（経度 −170〜170 に散る 60 個ずつ・1 辺 0.02°＝z4 でも極小）＋大きい面 1 つ＋MultiPoint 1 つ（400 点）＋単独の点 50
const features = [];
for (let f = 0; f < 3; f++) features.push({ type: "Feature", properties: { id: "isles" + f }, geometry: { type: "MultiPolygon", coordinates: Array.from({ length: 60 }, (_, i) => sq(-170 + i * 5.7 + f * 1.3, -40 + ((i * 37 + f * 11) % 80), 0.02)) } });
features.push({ type: "Feature", properties: { id: "big" }, geometry: { type: "Polygon", coordinates: sq(-30, -20, 50) } });
features.push({ type: "Feature", properties: { id: "mp" }, geometry: { type: "MultiPoint", coordinates: Array.from({ length: 400 }, (_, i) => [-175 + (i * 0.877) % 350, -60 + (i * 0.613) % 120]) } });
for (let i = 0; i < 50; i++) features.push({ type: "Feature", properties: { id: "pt" + i }, geometry: { type: "Point", coordinates: [-160 + i * 6.3, 10 + (i * 1.7) % 50] } });
const pbf = await new GeoPBF({ precision: 7 }).set({ type: "FeatureCollection", features });
const gint = await bakeGint(pbf);
const mpFid = features.findIndex(f => f.properties.id === "mp");
const base = { gint, gpu: false, minZoom: 0, maxZoom: 4, dropRate: 2.5, tileCompression: "none" };

// 1) shard をまたぐ極小面＝worker 数で変わらない
const r0 = await toPMTiles(pbf, { ...base, workers: 0 });
const r4 = await toPMTiles(pbf, { ...base, workers: 4 });
ok(r4.stats.workers === 4 && r0.stats.workers === 0, `workers 0 と 4 で回した（${r0.stats.tiles} タイル）`);
ok(r0.buffer.length === r4.buffer.length && Buffer.compare(Buffer.from(r0.buffer), Buffer.from(r4.buffer)) === 0, `PMTiles が byte 同一（${r0.buffer.length} bytes）`);
const pm0 = await readPMTiles(r0.buffer);
const tile = async (pm, z, x, y) => { const b = await pm.getTile(z, x, y); return b ? decodeTile(b) : null; };
const layer0 = await tile(pm0, 0, 0, 0);
const isles = layer0[0].features.filter(f => f.id < 3);
const squares = isles.reduce((n, f) => n + f.geometry.length, 0);
ok(isles.length === 3 && squares > 0 && squares < 180 && isles.every(f => f.geometry.every(r => r.length === 8)), `z0 の小島は代わりの正方形（${squares} 個・3 feature・各環 4 点）`);
// 2) MultiPoint は点単位の間引き（全部か無しかではない）・ズームで入れ子
const mpCount = async (z) => { let n = 0; const m = 1 << z; for (let x = 0; x < m; x++) for (let y = 0; y < m; y++) { const t = await tile(pm0, z, x, y); if (!t) continue; for (const f of t[0].features) if (f.id === mpFid) n += f.geometry.length; } return n; };
const counts = []; for (let z = 0; z <= 4; z++) counts.push(await mpCount(z));
ok(counts[0] > 0 && counts[0] < 400, `MultiPoint 400 点の z0 は一部だけ残る（${counts[0]} 点・旧＝0 か 400）`);
ok(counts.every((c, i) => !i || c >= counts[i - 1]) && counts[4] >= 400, `ズームで単調に増えて maxZoom は全点（${counts.join(" → ")}・タイル境界の複製込み）`);
// 単独の点＝旧と同じ鍵（fid のハッシュ）で選ばれる＝入れ子
const single = async (z) => { const s = new Set(); const m = 1 << z; for (let x = 0; x < m; x++) for (let y = 0; y < m; y++) { const t = await tile(pm0, z, x, y); if (!t) continue; for (const f of t[0].features) if (f.id > mpFid) s.add(f.id); } return s; };
const s0 = await single(0), s2 = await single(2), s4 = await single(4);
ok(s4.size === 50 && [...s0].every(i => s2.has(i)) && [...s2].every(i => s4.has(i)) && s0.size < 50, `単独の点は入れ子（z0 ${s0.size} ⊆ z2 ${s2.size} ⊆ z4 ${s4.size}）`);

if (fails) { console.error(`t-tiler-shards: ${fails} 件失敗`); process.exit(1); }
console.log("t-tiler-shards: all passed");
