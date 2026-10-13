#!/usr/bin/env node
// 太陽直下点と恒星時（sun.js・#42）の常設ハーネス。期待値＝天文年鑑の値（赤緯）と均時差（経度）。
import { sunSubpoint, gmstAt, moonSubpoint, sunAltAz, moonAltAz } from "../src/sun.js";
const R = 180 / Math.PI;
let fails = 0;
const near = (a, b, tol, label) => { if (Math.abs(a - b) <= tol) return; fails++; console.error(`  ✗ ${label}: ${a.toFixed(3)} vs ${b}`); };
const at = s => sunSubpoint(Date.parse(s)).map(v => v * R);
near(gmstAt(Date.parse("2000-01-01T12:00:00Z")) * R, 280.4606, 1e-3, "GMST at J2000");
near(at("2026-06-21T12:00:00Z")[1], 23.44, 0.05, "June solstice declination");
near(at("2026-12-21T12:00:00Z")[1], -23.44, 0.05, "December solstice declination");
near(at("2026-03-20T12:00:00Z")[1], 0, 0.3, "March equinox declination");
near(at("2026-11-03T12:00:00Z")[0], -4.1, 0.15, "early November: equation of time +16.4 min = sun 4.1° west at 12:00 UTC");
near(at("2026-02-11T12:00:00Z")[0], 3.55, 0.15, "mid February: equation of time −14.2 min = sun 3.6° east");
near(at("2026-09-23T00:00:00Z")[0], 178.1, 0.15, "midnight UTC, late September: equation of time +7.5 min = 178.1° (near the antimeridian)");
// 高度・方位（F2・2026-10-12）：東京（139.69E 35.69N）の夏至の視太陽の正午（11:43 JST＝02:43Z・経度差 −19 分・均時差 −1.5 分）＝太陽は真南・高度 ≈ 90−(35.69−23.44)=77.7°（均時差で数分ずれる）
{ const a = sunAltAz(Date.parse("2026-06-21T02:43:00Z"), 139.69, 35.69); near(a.altitude, 77.7, 0.3, "Tokyo noon altitude"); near(a.azimuth, 180, 4, "Tokyo noon azimuth"); near(Math.hypot(...a.enu), 1, 1e-9, "enu unit"); near(a.enu[2], Math.sin(a.altitude * Math.PI / 180), 1e-9, "enu up"); }
// 春分の朝＝太陽は真東から昇る（赤緯 ≈ 0）：東京の日の出 2026-03-20 は 05:44 JST ≈ 20:44Z（前日）＝高度 ≈ 0・方位 ≈ 90
{ const a = sunAltAz(Date.parse("2026-03-19T20:44:00Z"), 139.69, 35.69); near(a.altitude, 0, 1.5, "equinox sunrise altitude"); near(a.azimuth, 90, 2, "equinox sunrise azimuth"); }
// 真夜中（12:00Z）＝経度 180 付近で正午・東京は地平の下・方位は北寄り
{ const a = sunAltAz(Date.parse("2026-06-21T15:00:00Z"), 139.69, 35.69); if (a.altitude > -10) { fails++; console.error(`  ✗ Tokyo midnight should be below horizon: ${a.altitude.toFixed(1)}`); } }
// 月：直下点の緯度は ±29° の中・新月（2026-10-10 15:50Z）には太陽の直下点のそば（黄経が同じ＝経度差は数度・赤緯差は黄道からの緯度だけ）
{ const m = moonSubpoint(Date.parse("2026-10-10T15:50:00Z")), s = sunSubpoint(Date.parse("2026-10-10T15:50:00Z")); const dl = ((m[0] - s[0]) * R + 540) % 360 - 180; near(Math.abs(dl), 0, 6, "new moon: moon subpoint longitude ≈ sun"); near(m[1] * R, s[1] * R, 6, "new moon: declination ≈ sun"); if (Math.abs(m[1] * R) > 29.5) { fails++; console.error("  ✗ moon declination out of range"); } }
{ const a = moonAltAz(Date.parse("2026-10-10T15:50:00Z"), 139.69, 35.69), b = sunAltAz(Date.parse("2026-10-10T15:50:00Z"), 139.69, 35.69); near(a.altitude, b.altitude, 7, "new moon: altitude ≈ sun from Tokyo"); }
console.log(fails ? `✗ sun: ${fails} failed` : "✓ sun: all passed");
process.exit(fails ? 1 : 0);
