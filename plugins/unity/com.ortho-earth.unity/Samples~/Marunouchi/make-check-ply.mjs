// 点群の配置を確かめる 4 点の PLY（pointcloud-check.ply）を作る＝/japan/pointcloud の「PLY（点・Unity 向け）」と同じ dumpToPly で書く。
//   PLY の錨はフォルダの錨（anchor.json）からわざとずらす＝Place が錨の差を足して置く所を試す。
//   実行：node plugins/unity/com.ortho-earth.unity/Samples~/Marunouchi/make-check-ply.mjs（Node 22.18 以上＝.ts の型を剥がして読む）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpToPly } from "../../../../../apps/pointcloud/pc-ply.ts";
import { makeAnchor, lonLatToEcef } from "../../../../../sdk/ortho-export/src/geo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const folder = JSON.parse(fs.readFileSync(path.join(here, "anchor.json"), "utf8"));
const geoid = folder.geoid;
const ply = { lon: 139.768, lat: 35.68, h: 3.0 };   // PLY の錨＝標高（ジオイド上）で持つ（PLY の約束）
const a = makeAnchor({ lon: ply.lon, lat: ply.lat, height: ply.h + geoid });
// [lon, lat, 楕円体高, r, g, b, class]
const rows = [
	[139.76916, 35.67951, 278.2, 255, 0, 0, 6],                       // 最も高い建物の頂点（東京ミッドタウン八重洲）
	[folder.bbox[0], folder.bbox[1], 3.0 + geoid, 0, 255, 0, 2],      // bbox の南西角（地面）
	[folder.bbox[2], folder.bbox[3], 3.0 + geoid, 0, 0, 255, 2],      // bbox の北東角（地面）
	[ply.lon, ply.lat, ply.h + geoid, 255, 255, 0, 0],                // PLY の錨そのもの＝原点
];
const pts = new Float32Array(rows.flatMap(([lon, lat, h]) => a.toEnu(lonLatToEcef(lon, lat, h))));   // (E, N, U) m
const rgb = new Uint8Array(rows.flatMap(r => r.slice(3, 6))), cls = new Uint8Array(rows.map(r => r[6]));
const bytes = dumpToPly({ n: rows.length, anchor: [ply.lon, ply.lat, ply.h], pts, rgb, cls }, { source: "Samples~/Marunouchi/make-check-ply.mjs (synthetic, 4 points)" });
fs.writeFileSync(path.join(here, "pointcloud-check.ply"), bytes);
// 期待値：フォルダの錨から見た Unity 座標（X=東・Y=上・Z=北）＝Place の結果と見比べる
const f = makeAnchor({ lon: folder.anchor.lon, lat: folder.anchor.lat, height: folder.anchor.height });
console.log("pointcloud-check.ply:", rows.length, "points; PLY anchor", ply, "→ offset from folder anchor (E,N,U)", f.toEnu(lonLatToEcef(ply.lon, ply.lat, ply.h + geoid)).map(v => v.toFixed(2)));
for (const [lon, lat, h] of rows) { const [e, n, u] = f.toEnu(lonLatToEcef(lon, lat, h)); console.log(`  ${lon} ${lat} ${h}  → Unity (${e.toFixed(2)}, ${u.toFixed(2)}, ${n.toFixed(2)})`); }
