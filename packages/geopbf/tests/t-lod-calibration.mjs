#!/usr/bin/env node
// t-lod-calibration: scripts/lod-calibration-report.mjs（改良点 12 の物差し）の常設検定。countries.fgb で
//   ・tiler の較正表（table）は固定則（fixed）より DP の予算に近いか同じ（全ズーム）＝calibrate.js が退行していない
//   ・arc 定数オフセット（constD）は table より悪い＝「1 byte/頂点のオフセット」で描画側を較正する案が成り立たない根拠（台帳 lod-calibration-2026-10-12.md）
//   ・高ズーム（データの解像度を超えた所）では table の誤差 ≤ 2%
import { lodCalibrationReport } from "../scripts/lod-calibration-report.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fgb/countries.fgb");
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const r = await lodCalibrationReport(fx, { minZoom: 0, maxZoom: 14 });
ok(r.arcs > 500 && r.vertices > 10000, `countries: arcs ${r.arcs}・vertices ${r.vertices}`);
ok(r.err.table.every((v, k) => v <= r.err.fixed[k] + 1e-9), `table ≤ fixed（全ズーム）: table ${r.err.table.map(v => (100 * v).toFixed(0)).join("/")}% vs fixed ${r.err.fixed.map(v => (100 * v).toFixed(0)).join("/")}%`);
ok(r.err.constD.slice(0, 8).some((v, k) => v > r.err.table[k] + 0.01), `constD は table より悪いズームがある（定数オフセット案の反証）`);
ok(r.err.table.slice(10).every(v => v <= 0.02), `z ≥ 10 の table の誤差 ≤ 2%`);
ok(r.calibrateMs < 2000, `較正 ${r.calibrateMs.toFixed(0)} ms`);
if (fails) { console.error(`t-lod-calibration: ${fails} 件失敗`); process.exit(1); }
console.log("t-lod-calibration: all passed");
