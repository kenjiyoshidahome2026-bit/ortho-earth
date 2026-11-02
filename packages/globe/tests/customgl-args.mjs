// custom 層の args（gadgets/customgl-args.ts）の球の variant＝mainMatrix と面が MapLibre の球の軸（x＝sinλcosφ・y＝sinφ・z＝cosλcosφ）で渡ること
// （2026-11-02：add-a-3d-model-to-globe-using-threejs の getGlobeModelMatrix が MapLibre の軸で模型を置く＝この地図の軸のままだと裏側に置かれ描かれなかった）
import { makeCustomArgs } from "../src/gadgets/customgl-args.ts";
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const D2R = Math.PI / 180;
const cam = { center: [148.98, -35.40], zoom: 5, bearing: 0, pitch: 0 };
const a = makeCustomArgs(cam, 800, 600, { earthM: 6371008.8, globe: true });
const M = a.defaultProjectionData.mainMatrix;
const ndc = p => { const o = [0, 0, 0, 0]; for (let r = 0; r < 4; r++) o[r] = M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + M[12 + r]; return [o[0] / o[3], o[1] / o[3], o[3]]; };
const sph = (lon, lat) => [Math.sin(lon * D2R) * Math.cos(lat * D2R), Math.sin(lat * D2R), Math.cos(lon * D2R) * Math.cos(lat * D2R)];   // MapLibre の軸
const c = ndc(sph(148.98, -35.40));
ok(Math.abs(c[0]) < 1e-6 && Math.abs(c[1]) < 1e-6 && c[2] > 0, `視点の中心（MapLibre の軸）は画面の中央・目の前（ndc ${c.map(v => v.toFixed(3))}）`);
const e = ndc(sph(150, -35.40));
ok(e[0] > 0.01 && Math.abs(e[1]) < 0.05, `東の点は右へ（ndc ${e.map(v => v.toFixed(3))}）`);
const n = ndc(sph(148.98, -34));
ok(n[1] > 0.01 && Math.abs(n[0]) < 0.05, `北の点は上へ（ndc ${n.map(v => v.toFixed(3))}）`);
const cp = a.defaultProjectionData.clippingPlane, dot = p => cp[0] * p[0] + cp[1] * p[1] + cp[2] * p[2] + cp[3];
ok(dot(sph(148.98, -35.40)) > 0 && dot(sph(148.98 + 180, 35.40)) < 0, `裏側の面も MapLibre の軸（表 ${dot(sph(148.98, -35.40)).toFixed(2)}・裏 ${dot(sph(148.98 + 180, 35.40)).toFixed(2)}）`);
ok(a.defaultProjectionData.projectionTransition === 1 && /sin\(lon\) \* cosLat, sinLat, cos\(lon\) \* cosLat/.test(a.shaderData.vertexShaderPrelude), "prelude の projectToSphere も MapLibre の軸");
const m = makeCustomArgs(cam, 800, 600, { earthM: 6371008.8, globe: false });
const mm = m.defaultProjectionData.mainMatrix, mx = (180 + 148.98) / 360, my = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + -35.40 * Math.PI / 360))) / 360;
const o = [0, 0, 0, 0]; for (let r = 0; r < 4; r++) o[r] = mm[r] * mx + mm[4 + r] * my + mm[12 + r];
ok(Math.abs(o[0] / o[3]) < 1e-6 && Math.abs(o[1] / o[3]) < 1e-6, "メルカトルの variant は変わらない（中心→中央）");
if (fail) { console.log(`\n✗ customgl-args ${fail} 件 FAIL`); process.exit(1); } console.log("\n✓ customgl-args 全 PASS");
