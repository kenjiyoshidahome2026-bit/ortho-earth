#!/usr/bin/env node
// 影のカスケードと濃さ（2026-10-23）の純関数 shadow.ts の検証。外部データ不要＝決定的。
//   1. shadowCascades：傾けた視点（手前の地面ほど近い）では基の窓の内側に細かい窓が立つ・細かい順・各段の半幅は 1/4 段に量子化・中心は自分の texel に吸着
//   2. 段のクリップ xy＝基の窓のクリップ xy·s＋o（受け手のシェーダが FS で使う写し）が、段の mvp で直に投げた値と合う
//   3. 段 k は「目からの距離が d_k 以下の地面の点」を全部含む（窓に入る一番細かい段を選べば、手前の点はいつも細かい段に当たる）
//   4. ほぼ真俯瞰・点が足りない時は段を足さない（基の窓だけ＝従来の絵）
//   5. shadowDarkness：利用者の値はそのまま（0..1 に収める）・既定は高い太陽 0.4・低い太陽 0.6・その間は単調
//   6. shadowBias：texel に比例（細かい段ほど余白が小さい＝足元で影が浮かない）
// 使い方: node packages/ortho-core/tests/shadow-cascade.mjs
import { lonlatTo3D, worldRadiusM } from "../src/camera.ts";
import { shadowWindow, shadowCascades, shadowDarkness, shadowBias, sunVector } from "../src/shadow.ts";

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const Re = worldRadiusM(), N = 2048;
const LON = 139.7, LAT = 35.7, K = 111320, cosL = Math.cos(LAT * Math.PI / 180);
const ll = (e, n) => [LON + e / (K * cosL), LAT + n / K];
const T = Date.parse("2026-12-22T01:00:00Z");   // 冬至の朝 10 時（JST）＝太陽は低め（約 26°）
const clipXY = (m, P) => [m[0] * P[0] + m[4] * P[1] + m[8] * P[2] + m[12], m[1] * P[0] + m[5] * P[1] + m[9] * P[2] + m[13]];
const clipZ = (m, P) => m[2] * P[0] + m[6] * P[1] + m[10] * P[2] + m[14];

// 傾けた視点の地面の点：目は南 900m・高さ 400m、地面は南 600m〜北 700m の帯（手前 400m 先から）
const eye = (() => { const [lo, la] = ll(0, -900), p = lonlatTo3D(lo, la), s = 1 + 400 / Re; return [p[0] * s, p[1] * s, p[2] * s]; })();
const ground = [];
for (let n = -600; n <= 700; n += 100) for (let e = -500; e <= 500; e += 125) { const [lo, la] = ll(e, n); ground.push(lonlatTo3D(lo, la)); }
const base = shadowWindow(sunVector(T), ll(0, 0), 1448, N);
ok(base !== null, "基の窓が立つ（太陽は地平線の上）");

console.log("― 1. 段が立つ ―");
const cas = shadowCascades(base, ground, eye, N, 2);
ok(cas.length >= 1 && cas.length <= 2, `傾けた視点で内側の段が立つ（${cas.length} 段・半幅 ${cas.map(c => Math.round(c.R * Re)).join("/")}m・基 ${Math.round(base.R * Re)}m）`);
ok(cas.every((c, k) => c.R < base.R * 0.7 && (k === 0 || c.R >= cas[k - 1].R * 1.5)), "細かい順・どの段も基の 0.7 倍より狭く、前の段の 1.5 倍以上");
ok(cas.every(c => { const q = Math.log2(c.R * Re) * 4; return Math.abs(q - Math.round(q)) < 1e-9; }), "半幅は 1/4 段に量子化");
ok(cas.every(c => { const t = 2 * c.R / N; return Math.abs(c.cx / t - Math.round(c.cx / t)) < 1e-6 && Math.abs(c.cy / t - Math.round(c.cy / t)) < 1e-6; }), "中心は自分の texel の格子に吸着");
ok(cas.every(c => c.texelM < base.texelM && c.zRangeM === base.zRangeM && c.Z === base.Z && c.z0 === base.z0), "texel は基より細かく、奥行きは基と共通");

console.log("― 2. 基のクリップからの写し ―");
let maxErr = 0, maxZ = 0;
for (const c of cas) for (const P of ground) {
	const [xb, yb] = clipXY(base.mvp, P), [xk, yk] = clipXY(c.mvp, P);
	maxErr = Math.max(maxErr, Math.abs(xb * c.s + c.ox - xk), Math.abs(yb * c.s + c.oy - yk));
	maxZ = Math.max(maxZ, Math.abs(clipZ(base.mvp, P) - clipZ(c.mvp, P)));
}
ok(maxErr < 1e-9, `xy_k＝xy_b·s＋o（最大の差 ${maxErr.toExponential(1)}）`);
ok(maxZ < 1e-12, `z は全段で共通（最大の差 ${maxZ.toExponential(1)}）`);

console.log("― 3. 手前の点はいつも細かい段に入る ―");
const dist = P => Math.hypot(P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]);
const ds = ground.map(dist), dmin = Math.min(...ds);
for (const c of cas) {
	const near = ground.filter(P => dist(P) <= dmin * 1.05);
	const inside = near.every(P => { const [x, y] = clipXY(c.mvp, P); return Math.abs(x) <= 1 && Math.abs(y) <= 1; });
	ok(inside, `段（半幅 ${Math.round(c.R * Re)}m）は一番手前の点 ${near.length} 個を含む`);
}

console.log("― 4. 段を足さない時 ―");
const top = [];   // 真上から：目は中心の真上 1500m＝距離の比はほぼ 1
const eyeTop = (() => { const p = lonlatTo3D(LON, LAT), s = 1 + 1500 / Re; return [p[0] * s, p[1] * s, p[2] * s]; })();
for (let n = -300; n <= 300; n += 100) for (let e = -400; e <= 400; e += 100) { const [lo, la] = ll(e, n); top.push(lonlatTo3D(lo, la)); }
ok(shadowCascades(base, top, eyeTop, N, 2).length === 0, "ほぼ真俯瞰（距離の比 < 1.6）は基の窓だけ");
ok(shadowCascades(base, ground.slice(0, 3), eye, N, 2).length === 0, "点が 4 つ未満は足さない");
ok(shadowCascades(base, ground, eye, N, 0).length === 0, "n=0 は足さない");

console.log("― 5. 濃さ ―");
const D = a => shadowDarkness(a * Math.PI / 180);
ok(Math.abs(D(60) - 0.4) < 1e-9 && Math.abs(D(3) - 0.6) < 1e-9, `高い太陽 0.4・低い太陽 0.6（${D(60).toFixed(2)} / ${D(3).toFixed(2)}）`);
ok([5, 10, 15, 20, 25, 30, 35].every((a, i, A) => i === 0 || D(a) <= D(A[i - 1])), "高度が上がるほど暗く（単調）");
ok(shadowDarkness(0.5, 0.66) === 0.66 && shadowDarkness(0.5, 2) === 1 && shadowDarkness(0.5, -1) === 0, "利用者の値はそのまま（0..1 に収める）");

console.log("― 6. 余白 ―");
const b0 = shadowBias(base), b1 = cas.length ? shadowBias(cas[0]) : b0;
ok(b1 < b0, `細かい段ほど余白が小さい（${(b1 * base.zRangeM).toFixed(2)}m < ${(b0 * base.zRangeM).toFixed(2)}m）`);

if (fails) { console.error(`\n✗ ${fails} 件失敗`); process.exit(1); }
console.log("\n✓ 全部通過");
