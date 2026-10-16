// 2D の雲（W6）＝回転の向き・画素の α・板のメッシュ（DOM 無し）
import { cloudRotation, wrapLon, cloudPixels, parseHex, shellMesh, STEP_DEG } from "../src/clouds.ts";
import { lonlatTo3D } from "@ortho-earth/core";
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const ap = (L, v) => [L[0]*v[0] + L[3]*v[1] + L[6]*v[2], L[1]*v[0] + L[4]*v[1] + L[7]*v[2], L[2]*v[0] + L[5]*v[1] + L[8]*v[2]];
const toLL = p => [Math.atan2(p[2], p[0]) * 180 / Math.PI, Math.asin(p[1] / Math.hypot(...p)) * 180 / Math.PI];
// 東西：経度 140 の点が θ=3 で経度 143 へ（緯度は変わらない）
let q = toLL(ap(cloudRotation(3, 0, 140), lonlatTo3D(140, 35)));
ok("rot.lon", near(q[0], 143, 1e-6) && near(q[1], 35, 1e-6), q.join());
// 南北：中心の子午線（140）の点が φ=2 で緯度 37 へ（経度は変わらない）
q = toLL(ap(cloudRotation(0, 2, 140), lonlatTo3D(140, 35)));
ok("rot.lat", near(q[0], 140, 1e-6) && near(q[1], 37, 1e-6), q.join());
q = toLL(ap(cloudRotation(0, -2, -70), lonlatTo3D(-70, -10)));
ok("rot.latSouth", near(q[0], -70, 1e-6) && near(q[1], -12, 1e-6), q.join());
// 回転＝直交（長さ 1）
const L = cloudRotation(7, -3, 20); ok("rot.orthonormal", near(L[0]*L[0] + L[1]*L[1] + L[2]*L[2], 1, 1e-12) && near(L[0]*L[3] + L[1]*L[4] + L[2]*L[5], 0, 1e-12));
ok("wrapLon", near(wrapLon(190), -170) && near(wrapLon(-200), 160) && wrapLon(0) === 0 && near(wrapLon(179.5), 179.5));
// 画素：α あり＝画像の α×opacity・色は画像×color／α 無し＝輝度が α・色は color
const src = Uint8ClampedArray.of(255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255);
const lum = cloudPixels(src, 3, 1, { opacity: 0.5 });
ok("px.luminance", lum.mode === "luminance" && lum.rgba[3] === 128 && lum.rgba[7] === 0 && lum.rgba[11] === 64 && lum.rgba[0] === 255 && lum.rgba[4] === 255, [...lum.rgba].join());
const src2 = Uint8ClampedArray.of(255, 255, 255, 200, 255, 0, 0, 0);
const al = cloudPixels(src2, 2, 1, { color: "#80ff00" });
ok("px.alpha", al.mode === "alpha" && al.rgba[3] === 200 && al.rgba[7] === 0 && al.rgba[0] === 128 && al.rgba[1] === 255 && al.rgba[2] === 0, [...al.rgba].join());
ok("px.forced", cloudPixels(src2, 2, 1, { alphaFrom: "luminance" }).mode === "luminance" && cloudPixels(src2, 2, 1, { alphaFrom: "luminance" }).rgba[3] === 255);
ok("parseHex", parseHex("#fff").join() === "255,255,255" && parseHex("#123456").join() === "18,52,86" && parseHex("red").join() === "255,255,255");
// 殻：頂点数・三角形数・uv の端（左上＝西経 180/北緯 90）・高さ（単位球 + hr）・bbox＝全球
const m = shellMesh(2000 / 6371000, 5), NX = 73, NY = 37;
ok("shell.size", m.pos.length === NX * NY * 3 && m.idx.length === 72 * 36 * 6 && m.uv[0] === 0 && m.uv[1] === 0 && m.uv[(NX * NY - 1) * 2] === 1 && m.uv[(NX * NY - 1) * 2 + 1] === 1 && m.nrm.length === NX * NY * 4);
const k = 10 * NX + 20, r0 = Math.hypot(m.pos[k*3], m.pos[k*3+1], m.pos[k*3+2]);
ok("shell.height", near(r0, 1 + 2000 / 6371000, 1e-7) && toLL([m.pos[k*3], m.pos[k*3+1], m.pos[k*3+2]]).every((v, i) => near(v, [-80, 40][i], 1e-4)), String(r0));
ok("shell.bbox", m.bbox.join() === [-180, -90, 180, 90].join() && m.origin.join() === "0,0,0" && m.col.every(v => v === 255) && STEP_DEG === 0.5);
if (fails) { console.error(`${fails} failed`); process.exit(1); } else console.log("ALL PASS clouds");
