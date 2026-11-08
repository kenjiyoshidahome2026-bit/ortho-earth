// 点群の配置を確かめる 4 点の LAS（pointcloud-check.las）を作る＝/japan/pointcloud の「LAS（点・Unreal 向け）」と同じ dumpToLas で書く。
//   Unity の見本（make-check-ply.mjs）と同じ 4 点・同じ錨のずらし（158 m 東・139 m 南）。Place が錨の差を足して置く所を試す。
//   実行：node plugins/unreal/Samples/Marunouchi/make-check-las.mjs（Node 22.18 以上＝.ts の型を剥がして読む）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpToLas } from "../../../../apps/pointcloud/pc-las.ts";
import { makeAnchor, lonLatToEcef } from "../../../../sdk/ortho-export/src/geo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const folder = JSON.parse(fs.readFileSync(path.join(here, "anchor.json"), "utf8"));
const geoid = folder.geoid;
const las = { lon: 139.768, lat: 35.68, h: 3.0 };   // LAS の錨＝標高（ジオイド上）で持つ（VLR の datum: orthometric）
const a = makeAnchor({ lon: las.lon, lat: las.lat, height: las.h + geoid });
// [lon, lat, 楕円体高, r, g, b, class]
const rows = [
	[139.76916, 35.67951, 278.2, 255, 0, 0, 6],                       // 最も高い建物の頂点（東京ミッドタウン八重洲）
	[folder.bbox[0], folder.bbox[1], 3.0 + geoid, 0, 255, 0, 2],      // bbox の南西角（地面）
	[folder.bbox[2], folder.bbox[3], 3.0 + geoid, 0, 0, 255, 2],      // bbox の北東角（地面）
	[las.lon, las.lat, las.h + geoid, 255, 255, 0, 0],                // LAS の錨そのもの＝原点
];
const pts = new Float32Array(rows.flatMap(([lon, lat, h]) => a.toEnu(lonLatToEcef(lon, lat, h))));   // (E, N, U) m
const rgb = new Uint8Array(rows.flatMap(r => r.slice(3, 6))), cls = new Uint8Array(rows.map(r => r[6]));
const bytes = dumpToLas({ n: rows.length, anchor: [las.lon, las.lat, las.h], pts, rgb, cls }, { source: "plugins/unreal/Samples/Marunouchi/make-check-las.mjs (synthetic, 4 points)", date: new Date(Date.UTC(2026, 10, 8)) });
fs.writeFileSync(path.join(here, "pointcloud-check.las"), bytes);
// 期待値：フォルダの錨から見た Unreal 座標（X=東・Y=南・Z=上・cm）＝Place の結果と見比べる
const f = makeAnchor({ lon: folder.anchor.lon, lat: folder.anchor.lat, height: folder.anchor.height });
const ue = ([e, n, u]) => `(${(e * 100).toFixed(0)}, ${(-n * 100).toFixed(0)}, ${(u * 100).toFixed(0)})`;
console.log("pointcloud-check.las:", rows.length, "points; LAS anchor", las, "→ actor at", ue(f.toEnu(lonLatToEcef(las.lon, las.lat, las.h + geoid))), "cm");
for (const [lon, lat, h] of rows) console.log(`  ${lon} ${lat} ${h}  → Unreal ${ue(f.toEnu(lonLatToEcef(lon, lat, h)))} cm`);
