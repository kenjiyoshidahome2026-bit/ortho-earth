#!/usr/bin/env node
// 模型の置き方（gadgets/model.js・2026-10-18）の算術の検定（DOM 無し）：
//   modelWorldXf＝「焼いた置き方 → 今の置き方」の世界座標の剛体変換（移動・回転・倍率・高さ）、transformBbox＝外接矩形の写し、composeXf＝束の変換の合成。
import { modelWorldXf, transformBbox, composeXf } from "../src/gadgets/model.ts";
import { lonlatTo3D, worldRadiusM } from "@ortho-earth/core";

let fails = 0; const ok = (name, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${info ? " " + info : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const nearV = (a, b, e = 1e-9) => a.length === b.length && a.every((v, i) => near(v, b[i], e));
const apply = (xf, p) => xf ? [xf.L[0]*p[0] + xf.L[3]*p[1] + xf.L[6]*p[2] + xf.t[0], xf.L[1]*p[0] + xf.L[4]*p[1] + xf.L[7]*p[2] + xf.t[1], xf.L[2]*p[0] + xf.L[5]*p[1] + xf.L[8]*p[2] + xf.t[2]] : [...p];
const R = worldRadiusM();
const M_LAT = R * Math.PI / 180, mLon = lat => M_LAT * Math.cos(lat * Math.PI / 180);   // 1° の実寸（m）＝世界の球の半径で（lonlatTo3D と同じ球＝東と北の 10 m が同じ長さ）
// 錨 at から東 e・北 n・上 u（m）の世界座標（球＝lonlatTo3D×(1+u/R)）
const world = (at, e, n, u = 0) => { const p = lonlatTo3D(at[0] + e / mLon(at[1]), at[1] + n / M_LAT), k = 1 + u / R; return [p[0] * k, p[1] * k, p[2] * k]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * R;   // m

const A = [139.7671, 35.6812], base = { at: A, heading: 0, scale: 1 };
const now0 = { at: A, heading: 0, scale: 1, altitude: 0 };
ok("identity → null", modelWorldXf(base, now0) === null);
ok("identity (heading 360) → null", modelWorldXf(base, { ...now0, heading: 360 }) === null || dist(apply(modelWorldXf(base, { ...now0, heading: 360 }), world(A, 10, 0)), world(A, 10, 0)) < 1e-6);

// 移動＝錨の点が新しい錨へ・錨から 10 m 北の点は新しい錨の 10 m 北へ（1 km 東）
const B = [A[0] + 1000 / mLon(A[1]), A[1]];
let xf = modelWorldXf(base, { at: B, heading: 0, scale: 1, altitude: 0 });
ok("move: anchor → anchor", dist(apply(xf, lonlatTo3D(...A)), lonlatTo3D(...B)) < 1e-6, dist(apply(xf, lonlatTo3D(...A)), lonlatTo3D(...B)).toExponential(2) + " m");
ok("move: 10 m north stays 10 m north", dist(apply(xf, world(A, 0, 10)), world(B, 0, 10)) < 1e-3, dist(apply(xf, world(A, 0, 10)), world(B, 0, 10)).toExponential(2) + " m");
ok("move: 30 m up stays up", dist(apply(xf, world(A, 0, 0, 30)), world(B, 0, 0, 30)) < 1e-3);
// 遠い移動（東京→大阪 400 km）でも「上」が倒れない＝錨の 100 m 上は新しい錨の 100 m 上
const OSAKA = [135.5, 34.7];
xf = modelWorldXf(base, { at: OSAKA, heading: 0, scale: 1, altitude: 0 });
ok("far move: up stays up", dist(apply(xf, world(A, 0, 0, 100)), world(OSAKA, 0, 0, 100)) < 1e-2, dist(apply(xf, world(A, 0, 0, 100)), world(OSAKA, 0, 0, 100)).toExponential(2) + " m");
ok("far move: north stays north", dist(apply(xf, world(A, 0, 100)), world(OSAKA, 0, 100)) < 0.5, dist(apply(xf, world(A, 0, 100)), world(OSAKA, 0, 100)).toFixed(3) + " m");   // 経緯度の m 換算（近似）の差の分だけ

// 回転＝heading 90（北から時計回り）＝北向きが東へ
xf = modelWorldXf(base, { at: A, heading: 90, scale: 1, altitude: 0 });
ok("heading 90: north → east", dist(apply(xf, world(A, 0, 10)), world(A, 10, 0)) < 1e-3, dist(apply(xf, world(A, 0, 10)), world(A, 10, 0)).toExponential(2) + " m");
ok("heading 90: anchor fixed", dist(apply(xf, lonlatTo3D(...A)), lonlatTo3D(...A)) < 1e-6);
ok("heading 90: up fixed", dist(apply(xf, world(A, 0, 0, 20)), world(A, 0, 0, 20)) < 1e-3);
// 焼いた heading からの差＝base.heading 90・now 180 ＝ 90 回す
xf = modelWorldXf({ at: A, heading: 90, scale: 1 }, { at: A, heading: 180, scale: 1, altitude: 0 });
ok("heading delta (90→180)", dist(apply(xf, world(A, 0, 10)), world(A, 10, 0)) < 1e-3);

// 倍率＝錨の周り
xf = modelWorldXf(base, { at: A, heading: 0, scale: 2, altitude: 0 });
ok("scale 2: 10 m north → 20 m north", dist(apply(xf, world(A, 0, 10)), world(A, 0, 20)) < 1e-3);
ok("scale 2: 15 m up → 30 m up", dist(apply(xf, world(A, 0, 0, 15)), world(A, 0, 0, 30)) < 1e-3);
xf = modelWorldXf({ at: A, heading: 0, scale: 2 }, { at: A, heading: 0, scale: 1, altitude: 0 });
ok("scale relative to baked (2→1 = half)", dist(apply(xf, world(A, 0, 20)), world(A, 0, 10)) < 1e-3);

// 高さ＝錨を 50 m 持ち上げる
xf = modelWorldXf(base, { at: A, heading: 0, scale: 1, altitude: 50 });
ok("altitude 50: anchor lifted", dist(apply(xf, lonlatTo3D(...A)), world(A, 0, 0, 50)) < 1e-3);

// 全部まとめて＝移動＋回転＋倍率＋高さ
xf = modelWorldXf(base, { at: B, heading: 90, scale: 3, altitude: 10 });
ok("combined", dist(apply(xf, world(A, 0, 10, 5)), world(B, 30, 0, 25)) < 1e-2, dist(apply(xf, world(A, 0, 10, 5)), world(B, 30, 0, 25)).toExponential(2) + " m");

// 外接矩形の写し
const bb = [A[0] - 10 / mLon(A[1]), A[1] - 20 / M_LAT, A[0] + 10 / mLon(A[1]), A[1] + 20 / M_LAT];   // 20 m × 40 m
let tb = transformBbox(bb, base, { at: B, heading: 0, scale: 1 });
ok("bbox move: center", near((tb[0] + tb[2]) / 2, B[0], 1e-9) && near((tb[1] + tb[3]) / 2, B[1], 1e-9));
tb = transformBbox(bb, base, { at: A, heading: 90, scale: 1 });
ok("bbox heading 90: 20x40 → 40x20 (±1%)", near((tb[2] - tb[0]) * mLon(A[1]), 40, 0.4) && near((tb[3] - tb[1]) * M_LAT, 20, 0.2), `${((tb[2] - tb[0]) * mLon(A[1])).toFixed(2)}x${((tb[3] - tb[1]) * M_LAT).toFixed(2)}`);
tb = transformBbox(bb, base, { at: A, heading: 0, scale: 2 });
ok("bbox scale 2: 20x40 → 40x80 (±1%)", near((tb[2] - tb[0]) * mLon(A[1]), 40, 0.4) && near((tb[3] - tb[1]) * M_LAT, 80, 0.8));   // transformBbox の度→m は近似（111320/110950）＝1% で見る

// 束の変換の合成：m ∘ a
const T = (L, xt) => Float32Array.of(...L, ...xt);
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
ok("compose(null, a) = a", composeXf(null, T(I, [1, 2, 3])) !== null && nearV([...composeXf(null, T(I, [1, 2, 3]))], [...T(I, [1, 2, 3])]));
ok("compose(m, null) = m", nearV([...composeXf(T(I, [4, 5, 6]), null)], [...T(I, [4, 5, 6])]));
ok("compose: translations add", nearV([...composeXf(T(I, [1, 2, 3]), T(I, [10, 20, 30]))].slice(9), [11, 22, 33], 1e-6));
const Rz = [0, 1, 0, -1, 0, 0, 0, 0, 1];   // z 軸まわり 90°（列優先）：x→y
const c = composeXf(T(Rz, [0, 0, 0]), T(I, [1, 0, 0]));   // 先に x へ 1 動かし、それを回す＝(0,1,0)
ok("compose: m rotates a's translation", nearV([...c].slice(9), [0, 1, 0], 1e-6) && nearV([...c].slice(0, 9), Rz, 1e-6));
ok("compose: null∘null = null", composeXf(null, null) === null);

console.log(fails ? `\n${fails} FAIL` : "\nall PASS");
process.exit(fails ? 1 : 0);// rot（姿勢まるごと・2026-10-28 Cesium の orientation の pitch・roll）
{
	const h = 30 * Math.PI / 180, c = Math.cos(h), s = Math.sin(h);
	const a = modelWorldXf(base, { ...now0, heading: 30 }), b = modelWorldXf(base, { ...now0, heading: 0, rot: [c, -s, 0, s, c, 0, 0, 0, 1] });
	const p = world(A, 7, 11, 3);
	ok("rot = Rh(heading) moves as heading does", dist(apply(a, p), apply(b, p)) < 1e-6, String(dist(apply(a, p), apply(b, p))));
	const up = modelWorldXf(base, { ...now0, rot: [1, 0, 0, 0, 0, 1, 0, -1, 0] });   // east stays, north → up, up → south (nose up about the east axis)
	ok("rot tips north up", dist(apply(up, world(A, 0, 10)), world(A, 0, 0, 10)) < 0.01, String(dist(apply(up, world(A, 0, 10)), world(A, 0, 0, 10))));
	ok("rot tips up south", dist(apply(up, world(A, 0, 0, 10)), world(A, 0, -10)) < 0.01);
	const hb = modelWorldXf({ at: A, heading: 90, scale: 1 }, { ...now0, heading: 90, rot: [0, -1, 0, 1, 0, 0, 0, 0, 1] });   // baked at heading 90, rot = Rh(90): no change
	ok("rot over a baked heading", dist(apply(hb, p), p) < 1e-6, String(dist(apply(hb, p), p)));
	const bb = transformBbox([A[0] - 1e-4, A[1] - 1e-4, A[0] + 1e-4, A[1] + 1e-4], base, { ...now0, rot: [1, 0, 0, 0, 0, 1, 0, -1, 0] });
	ok("rot widens the bbox", bb[2] - bb[0] > 2e-4 && bb[3] - bb[1] > 2e-4);
}

