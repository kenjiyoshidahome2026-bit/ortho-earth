#!/usr/bin/env node
// 断面とクリッピング平面（#111 段 0）の純関数 clip.js の検証。外部データ不要＝決定的。
//   1. 鉛直面は a と b を通り、a→b に向かって右側を残す（東向き＝南を残す／北向き＝東を残す）
//   2. 中点で鉛直（高さを変えても面からの距離が変わらない）＝球と楕円体の両方
//   3. packClip の K（f64 で引いてから f32）＋原点相対の位置（f32）で出した距離が、f64 の直の距離と mm で合う（東京駅・z17 の画面の範囲）
//   4. 日付変更線を跨ぐ 2 点も短い方の中点で鉛直・面の枚数は 6 枚まで
//   6. 段 4：対象ごとの面（群の配列・targets）・同一フレームのオーバーレイへ渡す uniform（clipPackOrigin）
//   7. 多角形（P0 #4）：内側を消す（inverse で外側）・穴・GeoJSON・辺の間引き・packClip の pe/pn/pv（f32・原点相対）で出した距離が f64 と mm で合う
//   5. 段 1：水平面（下を残す／上を残す・中心から 1 km で浮くのは 8 cm 程度）・箱（向きを回しても辺までの距離が幾何と合う・6 枚）・URL の書き方（?clip=）
// 使い方: node packages/ortho-core/tests/clip.mjs
import { lonlatTo3D, ellNormal3D, setEllipsoid, worldRadiusM } from "../src/camera.ts";
import { meridionalRadius, primeVerticalRadius } from "../src/geodesic.ts";
import { clipPlaneEcef, clipPlaneVertical, clipPlaneHorizontal, clipBox, clipPlanes, parseClipParam, packClip, clipDistanceM, clipStyle, CLIP_STYLE, CLIP_F32, CLIP_MAX, normClip, clipPlanesFor, clipPackOrigin, CLIP_TARGETS, clipPolygon, clipPolygonFor, clipPolygonDistanceM, CLIP_POLY_MAX } from "../src/clip.ts";

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };
const f = Math.fround;

for (const ell of [false, true]) {
	setEllipsoid(ell);
	console.log(`― ${ell ? "楕円体" : "球"} ―`);
	const a = [139.760, 35.681], b = [139.770, 35.681];   // 東京駅の北を東向き
	const P = clipPlanes({ vertical: [[a, b]] });
	ok(P.length === 1 && Math.abs(Math.hypot(P[0][0], P[0][1], P[0][2]) - 1) < 1e-12, "面は 1 枚・法線は単位");
	ok(Math.abs(clipDistanceM(P, ...a)) < 1e-6 && Math.abs(clipDistanceM(P, ...b)) < 1e-6, "a と b を通る");
	ok(clipDistanceM(P, 139.765, 35.680) > 100 && clipDistanceM(P, 139.765, 35.682) < -100, "東向き＝南（右）を残し北を切る");
	const Pn = clipPlanes({ vertical: [[[139.765, 35.67], [139.765, 35.69]]] });
	ok(clipDistanceM(Pn, 139.766, 35.68) > 80 && clipDistanceM(Pn, 139.764, 35.68) < -80, "北向き＝東（右）を残し西を切る");
	const mid = [139.765, 35.681];
	const dH = Math.abs(clipDistanceM(P, ...mid, 0) - clipDistanceM(P, ...mid, 600));
	ok(dH < 1e-6, `中点で鉛直（0m と 600m の距離の差 ${dH.toExponential(1)} m）`);
	// 3. f32 の原点相対で出した距離（シェーダと同じ式）と f64 の直の距離
	const origin = [139.7671, 35.6812], O = lonlatTo3D(...origin), Re = worldRadiusM();
	const U = packClip(P, O);
	let worst = 0;
	for (let i = 0; i < 200; i++) {
		const lon = origin[0] + (Math.sin(i * 1.7) * 0.01), lat = origin[1] + (Math.cos(i * 2.3) * 0.008), h = (i % 7) * 50;
		const u = lonlatTo3D(lon, lat), m = ellNormal3D(lon, lat), k = h / Re;
		const rel = [f(u[0] + m[0] * k - O[0]), f(u[1] + m[1] * k - O[1]), f(u[2] + m[2] * k - O[2])];   // シェーダの relW（f32）
		const dGpu = f(f(f(U[0] * rel[0]) + f(U[1] * rel[1])) + f(U[2] * rel[2])) + U[3];
		const X = [u[0] + m[0] * k, u[1] + m[1] * k, u[2] + m[2] * k], dRef = P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] - P[0][3];   // 同じ β の距離を f64 で
		worst = Math.max(worst, Math.abs(dGpu - dRef) * Re);
	}
	ok(worst < 0.01, `原点相対 f32 の距離が f64 と合う（最大の差 ${(worst * 1000).toFixed(2)} mm・±1km・高さ 0〜300m）`);
}
setEllipsoid(false);
console.log("― 日付変更線と枚数 ―");
const Pd = clipPlaneVertical([179.99, -17], [-179.99, -17]);
ok(!!Pd && clipDistanceM([Pd], 180, -17.01) > 0 && clipDistanceM([Pd], 180, -16.99) < 0, "跨ぐ 2 点（東向き）＝南を残す");
ok(clipPlaneVertical([139, 35], [139, 35]) === null, "同じ 2 点は面にならない");
const many = clipPlanes({ vertical: Array.from({ length: 9 }, (_, i) => [[139 + i * 0.01, 35], [139 + i * 0.01 + 0.001, 35.001]]) });
ok(many.length === CLIP_MAX, `面は ${CLIP_MAX} 枚まで`);
const U0 = packClip([], [1, 0, 0]);
ok(U0.subarray(0, CLIP_MAX * 4 + 1).every(v => v === 0), "面 0 枚＝面の欄は全部 0（p.x＝0）");
const US = packClip([], [1, 0, 0], undefined, clipStyle({ cap: false, edge: { width: 3, color: [1, 0, 0] } }));
ok(US[CLIP_MAX * 4 + 1] === 3 && US[CLIP_MAX * 4 + 7] === 0 && US[CLIP_MAX * 4 + 11] === 0 && US[CLIP_MAX * 4 + 12] === 1, "段 2：帯の幅と色・蓋を消す（cap:false）");
const UD = packClip([], [1, 0, 0]);
ok(UD[CLIP_MAX * 4 + 1] === CLIP_STYLE.edgeWidth && UD[CLIP_MAX * 4 + 7] === 1 && UD[CLIP_MAX * 4 + 11] === 1 && UD.length === CLIP_F32, "既定＝帯 2 px・蓋あり・160B");

console.log("― 段 1：水平面・箱・URL ―");
for (const ell of [false, true]) {
	setEllipsoid(ell);
	const at = [139.7, 35.7], D = 180 / Math.PI, Rm = ell ? meridionalRadius(at[1]) : worldRadiusM(), Rn = (ell ? primeVerticalRadius(at[1]) : worldRadiusM()) * Math.cos(at[1] / D);
	const ll = (e, n) => [at[0] + e / Rn * D, at[1] + n / Rm * D];   // ENU(m)→経緯度（楕円体は子午線・卯酉線の曲率半径）
	const H = [clipPlaneHorizontal(at, 30)];
	ok(Math.abs(clipDistanceM(H, ...at, 10) - 20) < 1e-3 && Math.abs(clipDistanceM(H, ...at, 45) + 15) < 1e-3, `${ell ? "楕円体" : "球"}：水平面 30m は下を残す（10m＝+20・45m＝−15）`);
	const Ha = [clipPlaneHorizontal(at, 30, "above")];
	ok(clipDistanceM(Ha, ...at, 45) > 14.99 && clipDistanceM(Ha, ...at, 10) < -19.99, "above は上を残す");
	const sag = clipDistanceM(H, ...ll(1000, 0), 30);
	ok(sag > 0 && sag < 0.12, `平面なので 1 km 先では地表の 30m より ${(sag * 100).toFixed(1)} cm 上に来る（接平面の垂れ）`);
	const B = clipBox({ center: at, size: [100, 200], h: [0, 50], bearing: 30 }), t = 30 * Math.PI / 180;
	ok(B.length === 6, "箱は 6 枚");
	let worst = 0;
	for (const [e, n, h] of [[0, 0, 25], [40, 0, 25], [60, 0, 25], [0, 90, 25], [0, 110, 25], [0, 0, -5], [0, 0, 55], [-30, -70, 5]]) {
		const r = e * Math.cos(t) - n * Math.sin(t), f = n * Math.cos(t) + e * Math.sin(t);   // 回した軸での位置
		const want = Math.min(50 - Math.abs(r), 100 - Math.abs(f), h, 50 - h);
		worst = Math.max(worst, Math.abs(clipDistanceM(B, ...ll(e, n), h) - want));
	}
	ok(worst < 0.1, `箱（北から 30° 回す）の内外と辺までの距離が幾何と合う（最大の差 ${(worst * 100).toFixed(1)} cm）`);
}
setEllipsoid(false);
const q = parseClipParam("139.7,35.6,139.8,35.6;h:139.7,35.7,30;box:139.7,35.7,100,200,0,50,30;xx:1,2");
ok(q && q.vertical.length === 1 && q.horizontal[0].h === 30 && q.horizontal[0].keep === "below" && q.box.size[1] === 200 && q.box.h[1] === 50 && q.box.bearing === 30, "URL の書き方：鉛直・水平・箱（読めない項は捨てる）");
ok(parseClipParam("h:139.7,35.7,30,above").horizontal[0].keep === "above" && parseClipParam("box:139.7,35.7,100,200").box.h === undefined, "above と箱の既定の高さ");
ok(parseClipParam("") === null && parseClipParam("a,b") === null, "読めなければ null");
ok(clipPlanes({ param: "box:139.7,35.7,100,200" }).length === 6 && clipPlanes({ param: "box:139.7,35.7,100,200", vertical: [[[139, 35], [140, 35]]] }).length === 6, "param も面にする・7 枚目は捨てる");

console.log("― 段 4：対象ごとの面 ―");
{
	const at = [139.7, 35.7];
	const n = normClip([{ box: { center: at, size: [100, 100] }, targets: ["terrain"] }, { horizontal: [{ at, h: 30 }], targets: ["buildings", "models"], edge: { width: 3 } }, { vertical: [[[139.7, 36], [139.7, 35]]] }]);
	const cnt = Object.fromEntries(CLIP_TARGETS.map(t => [t, clipPlanesFor(n, t).length]));
	ok(cnt.terrain === 6 && cnt.buildings === 2 && cnt.models === 2 && cnt.vector === 1 && cnt.labels === 1, `群ごとの対象（${JSON.stringify(cnt)}）・terrain は箱 6＋鉛直 1＝6 枚で打ち切り`);
	ok(n.style.edgeWidth === 3 && n.style.capOn, "蓋と帯は最初に cap／edge を書いた群の値");
	ok(normClip(null) === null && normClip({ on: false }) === null && normClip([]) === null && normClip([{ on: false }]) === null, "切らない（null・on:false・空の配列）");
	ok(clipPlanesFor(normClip({ vertical: [[[139.7, 36], [139.7, 35]]] }), "labels").length === 1, "targets 省略＝全部の対象");
	const P = clipPlanesFor(n, "vector"), O = [139.71, 35.69], U = clipPackOrigin(P, O), Ok = lonlatTo3D(...O);
	ok(U.length === (CLIP_MAX + 1) * 4 && U[CLIP_MAX * 4] === 1 && Math.abs(U[3] - (P[0][0] * Ok[0] + P[0][1] * Ok[1] + P[0][2] * Ok[2] - P[0][3])) < 1e-7, "オーバーレイへ渡す uniform（pl[6]＋p・K はその原点）");
}

// 7. 多角形（P0 #4）
for (const ell of [false, true]) {
	setEllipsoid(ell);
	console.log(`― 多角形・${ell ? "楕円体" : "球"} ―`);
	const lng0 = 139.7671, lat0 = 35.6812, dLng = 100 / (111320 * Math.cos(lat0 * Math.PI / 180)), dLat = 100 / 110950;
	const sq = [[lng0 - dLng, lat0 - dLat], [lng0 + dLng, lat0 - dLat], [lng0 + dLng, lat0 + dLat], [lng0 - dLng, lat0 + dLat], [lng0 - dLng, lat0 - dLat]];
	const pg = clipPolygon({ polygon: { type: "Polygon", coordinates: [sq] } });
	ok(pg && pg.edges.length === 4 && !pg.inverse, "四角＝辺 4 本（閉じの重複は落とす）");
	const dc = clipPolygonDistanceM(pg, lng0, lat0), de = clipPolygonDistanceM(pg, lng0 + dLng * 3, lat0);
	ok(Math.abs(dc + 100) < 1.5 && Math.abs(de - 200) < 1.5, `内側は負（中心 ${dc.toFixed(2)}m）・外は正（東 300m で ${de.toFixed(2)}m）`);
	const inv = clipPolygon({ polygon: [sq], inverse: true });
	ok(Math.abs(clipPolygonDistanceM(inv, lng0, lat0) - 100) < 1.5 && clipPolygonDistanceM(inv, lng0 + dLng * 3, lat0) < 0, "inverse＝内側だけ残す");
	const hole = clipPolygon({ polygon: { type: "Feature", geometry: { type: "Polygon", coordinates: [sq, sq.map(([x, y]) => [lng0 + (x - lng0) / 2, lat0 + (y - lat0) / 2])] } } });
	ok(hole.edges.length === 8 && clipPolygonDistanceM(hole, lng0, lat0) > 40 && clipPolygonDistanceM(hole, lng0 + dLng * 0.75, lat0) < -20, "穴の中は残る・穴と外の輪の間は消える（Feature も読む）");
	const circ = Array.from({ length: 200 }, (_, i) => [lng0 + dLng * Math.cos(i / 200 * 2 * Math.PI), lat0 + dLat * Math.sin(i / 200 * 2 * Math.PI)]);
	const cg = clipPolygon({ polygon: [circ] });
	ok(cg.edges.length <= CLIP_POLY_MAX && cg.edges.length >= 32 && clipPolygonDistanceM(cg, lng0, lat0) < -95, `辺が多い輪は間引く（${cg.edges.length} 本）`);
	// 細長い L 字（道路の外形）＝直線上の頂点が多い：間引いても角は残り、角の外は切らない（一様に間引くと弦が角を横切った・aec-clipping）
	const Lpath = [[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10]], Lr = [];
	for (let i = 0; i < Lpath.length; i++) { const a = Lpath[i], b = Lpath[(i + 1) % Lpath.length]; const m = Math.hypot(b[0] - a[0], b[1] - a[1]) > 5 ? 90 : 1; for (let t = 0; t < m; t++) Lr.push([lng0 + dLng * (a[0] + (b[0] - a[0]) * t / m), lat0 + dLat * (a[1] + (b[1] - a[1]) * t / m)]); }
	const Lg = clipPolygon({ polygon: [Lr] });
	ok(Lg.edges.length <= CLIP_POLY_MAX && clipPolygonDistanceM(Lg, lng0 + dLng * 3, lat0 + dLat * 3) > 50 && clipPolygonDistanceM(Lg, lng0 + dLng * 9.95, lat0 + dLat * 0.95) < 0 && clipPolygonDistanceM(Lg, lng0 + dLng * 0.05, lat0 + dLat * 9.95) < 0, `L 字を間引いても角が残る（${Lr.length} 点 → 辺 ${Lg.edges.length} 本）`);
	ok(clipPolygon({ polygon: { type: "Point", coordinates: [0, 0] } }) === null && clipPolygon({}) === null, "多角形が無い＝null");
	ok(clipPolygonFor(normClip({ polygon: [sq], targets: ["models"] }), "terrain") === null && clipPolygonFor(normClip({ polygon: [sq], targets: ["models"] }), "models") !== null, "対象ごと（targets）");
	// シェーダと同じ式（f32・原点相対）：polyXY(rel)＝(pe·rel + pe.w, pn·rel + pn.w)・polyD＝辺までの最短（偶奇で符号）
	const Oo = lonlatTo3D(lng0 + dLng * 0.3, lat0 - dLat * 0.2), U = packClip([], Oo, undefined, undefined, pg), q = CLIP_MAX * 4 + 16;
	ok(U[CLIP_MAX * 4 + 2] === 4 && U[CLIP_MAX * 4 + 3] === 0 && U.length === CLIP_F32, "packClip＝辺の数・inverse・長さ");
	const polyD = (rel) => {
		const x = f(f(U[q] * f(rel[0])) + f(U[q + 1] * f(rel[1])) + f(U[q + 2] * f(rel[2])) + U[q + 3]), y = f(f(U[q + 4] * f(rel[0])) + f(U[q + 5] * f(rel[1])) + f(U[q + 6] * f(rel[2])) + U[q + 7]);
		let d2 = Infinity, ins = false;
		for (let i = 0; i < U[CLIP_MAX * 4 + 2]; i++) { const [ax, ay, bx, by] = U.subarray(q + 8 + i * 4, q + 12 + i * 4); if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) ins = !ins; const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy))); d2 = Math.min(d2, (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2); }
		return (ins ? -1 : 1) * Math.sqrt(d2) * worldRadiusM();
	};
	let worst = 0;
	for (const [lx, ly] of [[0, 0], [0.9, 0.3], [1.1, -0.5], [-2, 1.5], [0.5, 0.99]]) {
		const P = lonlatTo3D(lng0 + dLng * lx, lat0 + dLat * ly), rel = [P[0] - Oo[0], P[1] - Oo[1], P[2] - Oo[2]];
		worst = Math.max(worst, Math.abs(polyD(rel) - clipPolygonDistanceM(pg, lng0 + dLng * lx, lat0 + dLat * ly)));
	}
	ok(worst < 0.01, `シェーダの式（f32・原点相対）と f64 が合う（最大 ${(worst * 1000).toFixed(2)} mm）`);
}
setEllipsoid(false);

console.log("― ECEF の平面（Cesium の ClippingPlane）―");
{
	setEllipsoid(true);
	const at = [139.7, 35.7], D = Math.PI / 180, a = 6378137, e2 = 6.69437999014e-3, la = at[0] * D, fa = at[1] * D;
	const N = a / Math.sqrt(1 - e2 * Math.sin(fa) ** 2), h = 30;
	const P = [(N + h) * Math.cos(fa) * Math.cos(la), (N + h) * Math.cos(fa) * Math.sin(la), (N * (1 - e2) + h) * Math.sin(fa)];
	const up = [Math.cos(fa) * Math.cos(la), Math.cos(fa) * Math.sin(la), Math.sin(fa)], d = -(up[0] * P[0] + up[1] * P[1] + up[2] * P[2]);
	const E = [clipPlaneEcef([up[0], up[1], up[2], d])], Ed = clipPlanes({ ecef: [[-up[0] * 2, -up[1] * 2, -up[2] * 2, -d * 2]] });
	ok(Math.abs(clipDistanceM(E, ...at, 45) - 15) < 0.01 && Math.abs(clipDistanceM(E, ...at, 10) + 20) < 0.01, "ECEF の面（測地の上向き・高さ 30m）は n·P + d ≥ 0＝上を残す");
	ok(Ed.length === 1 && Math.abs(clipDistanceM(Ed, ...at, 10) - 20) < 0.01, "spec.ecef は長さの違う法線も正規化して下を残す");
	ok(clipPlaneEcef([0, 0, 0, 1]) === null, "法線 0 は捨てる");
}
setEllipsoid(false);

if (fails) { console.error(`FAIL ${fails}`); process.exit(1); }
console.log("PASS clip");
