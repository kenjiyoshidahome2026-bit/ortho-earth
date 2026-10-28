// 3D Tiles の境界体積 → 球（sphereOf）＝Node 単体（2026-10-28）。
//   全球の region（Cesium OSM Buildings の根）の球が地球全体を覆うこと：旧＝8 角だけで半径を出し、経度 ±86° しか覆わず、
//   ポートランド（-122°）では根ごと間引かれて建物が 1 枚も出なかった（Cesium の clouds 例）
import { sphereOf } from "../src/gadgets/tiles3d.ts";

let fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "ok " : "NG "} ${name}${extra ? "  " + extra : ""}`); if (!cond) fail++; };
const D = Math.PI / 180, I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ecef = (lon, lat, h) => { const a = 6378137, e2 = 0.00669437999014, s = Math.sin(lat * D), N = a / Math.sqrt(1 - e2 * s * s); return [(N + h) * Math.cos(lat * D) * Math.cos(lon * D), (N + h) * Math.cos(lat * D) * Math.sin(lon * D), (N * (1 - e2) + h) * s]; };
const inside = (sp, p) => Math.hypot(p[0] - sp.c[0], p[1] - sp.c[1], p[2] - sp.c[2]) <= sp.r + 1e-6;

const whole = sphereOf({ region: [-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2, -100, 600] }, I);
ok("whole-globe region covers Portland, the antimeridian and the poles", [ecef(-122.65, 45.52, 50), ecef(180, 0, 600), ecef(0, -90, 0), ecef(90, 30, 300)].every(p => inside(whole, p)), JSON.stringify(whole));
ok("whole-globe region: radius about the earth's (not twice)", whole.r < 6.4e6, whole.r);
const half = sphereOf({ region: [-170 * D, -10 * D, 10 * D, 60 * D, 0, 100] }, I);
ok("a wide region covers its middle longitudes", [ecef(-80, 25, 100), ecef(-122, 45, 0), ecef(-170, 60, 100), ecef(10, -10, 0)].every(p => inside(half, p)), JSON.stringify(half));
const city = sphereOf({ region: [-122.7 * D, 45.5 * D, -122.6 * D, 45.55 * D, 0, 300] }, I);
ok("a city region stays small", city.r < 6000 && inside(city, ecef(-122.65, 45.52, 100)), city.r);

console.log(fail ? `${fail} NG` : "tiles3d-sphere: all ok");
process.exit(fail ? 1 : 0);
