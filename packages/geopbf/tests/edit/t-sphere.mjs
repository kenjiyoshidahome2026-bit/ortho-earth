// t-sphere: 完全球体の幾何（geopbf/edit/sphere）＋モデルの球面回転 rotateFeature（node tests/edit/t-sphere.mjs）
//   ①slerp/gcMidpoint/gcDistance の基本性質 ②quatBetween/rotateVec＝a→b・距離保存・逆回転 ③smallCircle＝全点等距離
//   ④rotateFeature＝隣接ポリゴンの共有ノードが一緒に動く・辺の中心角が保たれる・restore で厳密復元・applyCmd/invertCmd 往復
import { toVec, toLL, slerp, gcMidpoint, gcInterpolate, gcDistanceDeg, quatBetween, quatInverse, quatMul, quatAngle, quatFromAxisAngle, rotateVec, rotateLL, smallCircle, gcCentroid, gcRect } from "../../src/edit/sphere.js";
import { buildTopology } from "../../src/edit/topo-extract.js";
import { createModel } from "../../src/edit/model.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ① 大円補間
{
	const p = [100, 65], q = [-160, 65];
	const [m0, m1] = [gcMidpoint(p, q), gcMidpoint(q, p)];
	ok(near(m0[0], m1[0], 1e-9) && near(m0[1], m1[1], 1e-9), "大円中点は向きに依らない");
	ok(m0[1] > 65, `65°N 同士の大円中点は極側（${m0[1].toFixed(2)}°N）`);
	ok(near(gcDistanceDeg(p, m0), gcDistanceDeg(m0, q), 1e-9), "中点は両端から等距離");
	const e0 = toLL(slerp(toVec(...p), toVec(...q), 0)), e1 = toLL(slerp(toVec(...p), toVec(...q), 1));
	ok(near(e0[0], p[0], 1e-9) && near(e0[1], p[1], 1e-9) && near(e1[0], q[0], 1e-9) && near(e1[1], q[1], 1e-9), "t=0/1 は端点そのもの");
	ok(near(gcDistanceDeg([0, 0], [90, 0]), 90) && near(gcDistanceDeg([0, 0], [0, 90]), 90), "中心角＝赤道上90°・極まで90°");
	const seam = gcMidpoint([170, 10], [-170, 10]);
	ok(Math.abs(seam[0]) > 179.999 || Math.abs(seam[0]) < 1e-9 ? near(Math.abs(seam[0]), 180, 1e-6) : false, `縫い目跨ぎは最短側（中点 lon=${seam[0]}）`);
}
// ② 回転
{
	const a = toVec(139.7, 35.7), b = toVec(141.2, 36.1);
	const q = quatBetween(a, b), ab = rotateVec(q, a);
	ok(Math.hypot(ab[0] - b[0], ab[1] - b[1], ab[2] - b[2]) < 1e-12, "quatBetween は a を b へ運ぶ");
	const pts = [[139.5, 35.5], [140.0, 35.9], [139.8, 35.2], [175, 80]];
	const rp = pts.map(p => rotateLL(q, ...p));
	let err = 0; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) err = Math.max(err, Math.abs(gcDistanceDeg(pts[i], pts[j]) - gcDistanceDeg(rp[i], rp[j])));
	ok(err < 1e-9, `回転は中心角を保つ（最大誤差 ${err.toExponential(1)}）`);
	const back = rp.map(p => rotateLL(quatInverse(q), ...p));
	ok(back.every((p, i) => near(p[0], pts[i][0], 1e-9) && near(p[1], pts[i][1], 1e-9)), "逆回転で戻る");
	const id = quatMul(q, quatInverse(q));
	ok(quatAngle(id) < 1e-12, "q∘q⁻¹＝恒等");
	ok(quatAngle(quatBetween(a, a)) === 0, "同一点＝恒等（角0）");
}
// ③ 小円
{
	const c = [139.7455, 35.6715], ring = smallCircle(c, 0.003, 36);
	const ds = ring.map(p => gcDistanceDeg(c, p));
	ok(ring.length === 36 && Math.max(...ds) - Math.min(...ds) < 1e-12, "小円＝全点が中心から等しい中心角");
	const polar = smallCircle([10, 89.5], 2, 36), dp = polar.map(p => gcDistanceDeg([10, 89.5], p));
	ok(Math.max(...dp) - Math.min(...dp) < 1e-9 && polar.some(p => p[0] < -170 || p[0] > 170), "極を跨ぐ小円も真円（経度が縫い目を跨ぐ）");
}
// ③′ 球面矩形（対角線から 4 角）
{
	const a = [0, 0], b = [60, 40], r = gcRect(a, b), M = gcMidpoint(a, b);
	ok(r.length === 5 && r[0][0] === a[0] && r[0][1] === a[1] && r[2][0] === b[0] && r[2][1] === b[1] && r[4] !== r[0] && r[4][0] === a[0], "矩形＝閉リング・a/b はそのまま角");
	const dM = r.slice(0, 4).map(p => gcDistanceDeg(M, p));
	ok(Math.max(...dM) - Math.min(...dM) < 1e-9, `4 角は対角線の大円中点から等距離（${dM[0].toFixed(4)}°＝小円上）`);
	const side = i => gcDistanceDeg(r[i], r[i + 1]);
	ok(near(side(0), side(2), 1e-9) && near(side(1), side(3), 1e-9), "対辺の中心角が等しい");
	ok(!(near(r[1][0], b[0], 1e-6) && near(r[1][1], a[1], 1e-6)), `角は経緯度の角 (b.lon,a.lat) ではない（${r[1].map(v => v.toFixed(3))}）`);
	// a が赤道上だと a を通る辺（M の東向き＝水平）は赤道そのもの＝角の緯度は 0 のまま・経度が 60→51.25 にずれる。赤道を外すと緯度もずれる
	const r2 = gcRect([0, 10], [60, 50]);
	ok(Math.hypot(r2[1][0] - 60, r2[1][1] - 10) > 1 && Math.hypot(r2[3][0] - 0, r2[3][1] - 50) > 1, `幅 60° の矩形＝角は経緯度の角から 1° 以上ずれる（${r2[1].map(v => v.toFixed(2))}／${r2[3].map(v => v.toFixed(2))}）`);
	const small = gcRect([139.744, 35.677], [139.747, 35.679]);
	ok(Math.abs(small[1][0] - 139.747) < 1e-5 && Math.abs(small[1][1] - 35.677) < 1e-5, "小さい矩形は経緯度の角とほぼ一致");
	const seam = gcRect([179, 10], [-179, 12]);
	ok(seam && seam.every(p => p[0] >= -180 && p[0] < 180) && seam.some(p => p[0] > 178) && seam.some(p => p[0] < -178), "縫い目跨ぎ＝経度は [-180,180) に畳まれ両側に角");
	const polar = gcRect([-10, 88], [170, 88]);   // 対角線が極を通る
	ok(polar && polar.slice(0, 4).every(p => Math.abs(gcDistanceDeg([0, 90], p) - 2) < 1e-9), "極を通る対角線＝4 角は極から等距離");
	ok(gcRect([0, 0], [10, 0]) === null && gcRect([0, 0], [0, 10]) === null && gcRect([0, 0], [180, 0]) === null, "幅/高さゼロ・対蹠は null");
}
// ④ モデルの球面回転
{
	const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
	const fc = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: { name: "A" }, geometry: { type: "Polygon", coordinates: [sq(139.70, 35.60, 139.80, 35.70)] } },
		{ type: "Feature", properties: { name: "B" }, geometry: { type: "Polygon", coordinates: [sq(139.80, 35.60, 139.90, 35.70)] } },
		{ type: "Feature", properties: { name: "P" }, geometry: { type: "MultiPoint", coordinates: [[139.75, 35.65], [139.77, 35.66]] } },
	] };
	const model = createModel(buildTopology(fc, 6));
	const eidOf = name => [...model.feats.entries()].find(([, f]) => f.properties.name === name)[0];
	const A = eidOf("A"), B = eidOf("B"), P = eidOf("P");
	const before = JSON.stringify(model.toGeoJSON());
	const ringA0 = model.featureGeoJSON(A, false).geometry.coordinates[0];
	const base = model.featureVerts(A);
	ok(base.rings.length === 1 && base.rings[0].pts.length === 5, `featureVerts＝安定アドレス順の頂点列（${base.rings[0].pts.length} 点）`);
	const q = quatBetween(toVec(139.75, 35.65), toVec(139.76, 35.67));
	ok(model.rotateFeature(A, q, base) === true, "rotateFeature 適用");
	const ringA1 = model.featureGeoJSON(A, false).geometry.coordinates[0], ringB1 = model.featureGeoJSON(B, false).geometry.coordinates[0];
	let err = 0; for (let i = 0; i < 4; i++) err = Math.max(err, Math.abs(gcDistanceDeg(ringA0[i], ringA0[i + 1]) - gcDistanceDeg(ringA1[i], ringA1[i + 1])));
	ok(err < 3e-6, `辺の中心角が保たれる（格子 1e-6 の丸め込み・最大誤差 ${err.toExponential(1)}）`);
	const key = p => p.join(",");
	const sharedA = new Set(ringA1.map(key)), touching = ringB1.filter(p => sharedA.has(key(p)));
	ok(touching.length >= 2, `共有ノードは隣 B も一緒に動く（B が A と共有する頂点 ${touching.length} ≥ 2）`);
	const cmd = { op: "rot", eid: A, q, base, restore: false };
	model.applyCmd(model.invertCmd(cmd));   // undo＝restore
	ok(JSON.stringify(model.toGeoJSON()) === before, "restore で全体が厳密復元（隣・共有ノード込み）");
	model.applyCmd(cmd);
	ok(JSON.stringify(model.featureGeoJSON(A, false).geometry.coordinates[0]) === JSON.stringify(ringA1), "redo は決定的（同じ座標）");
	model.applyCmd(model.invertCmd(cmd));
	// 点フィーチャ
	const bp = model.featureVerts(P), pb = JSON.stringify(model.featureGeoJSON(P, false));
	ok(bp.coords.length === 2, "点フィーチャの base＝coords");
	model.rotateFeature(P, q, bp);
	const pa = model.featureGeoJSON(P, false).geometry.coordinates;
	ok(pa[0][0] !== 139.75 && Math.abs(gcDistanceDeg(pa[0], pa[1]) - gcDistanceDeg([139.75, 35.65], [139.77, 35.66])) < 3e-6, "点列も回転（間隔保持）");
	model.rotateFeature(P, null, bp);
	ok(JSON.stringify(model.featureGeoJSON(P, false)) === pb, "点列の restore も厳密");
}
// ⑤ 重心（ホイール回転の軸）＝辺長重み・頂点密度に引かれない／軸まわり回転で重心が不動
{
	const sq = [[10, 70], [11, 70], [11, 70.4], [10, 70.4], [10, 70]];
	const c = gcCentroid([sq]);
	ok(Math.abs(c[0] - 10.5) < 1e-3 && Math.abs(c[1] - 70.2) < 1e-3, `矩形の重心≈中心（${c.map(v => v.toFixed(4))}）`);
	const dense = [...Array.from({ length: 10 }, (_, i) => gcInterpolate([10, 70], [11, 70], i / 10)), [11, 70], [11, 70.4], [10, 70.4], [10, 70]];   // 南辺だけ大円上に頂点が密（緯線上に刻むと別の形＝大円は極側へ膨らむ）
	const cd = gcCentroid([dense]);
	ok(Math.abs(cd[0] - c[0]) < 1e-9 && Math.abs(cd[1] - c[1]) < 1e-9, "頂点密度が偏っても重心は同じ（弧上の積分＝細分不変）");
	ok(JSON.stringify(gcCentroid([[[0, 0], [2, 0]]]).map(v => +v.toFixed(9))) === "[1,0]", "2点線分の重心＝中点");
	const one = gcCentroid([[[5, 5]]]);
	ok(Math.abs(one[0] - 5) < 1e-9 && Math.abs(one[1] - 5) < 1e-9, "単点＝自身");
	const q = quatFromAxisAngle(toVec(c[0], c[1]), -37 * Math.PI / 180);   // 重心を軸に時計回り 37°
	const rq = sq.map(p => rotateLL(q, p[0], p[1])), cq = gcCentroid([rq]);
	ok(Math.abs(cq[0] - c[0]) < 1e-9 && Math.abs(cq[1] - c[1]) < 1e-9, "重心を軸に回すと重心は動かない");
	ok(Math.abs(gcDistanceDeg(rq[0], rq[1]) - gcDistanceDeg(sq[0], sq[1])) < 1e-9, "高緯度でも辺の中心角が保たれる（lon/lat 平面回転なら潰れる）");
	const e = rotateLL(quatFromAxisAngle(toVec(0, 0), -Math.PI / 2), 1, 0);
	ok(Math.abs(e[0]) < 1e-9 && Math.abs(e[1] + 1) < 1e-9, "軸=外向き法線・負の角＝画面で時計回り（東→南）");
}
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
