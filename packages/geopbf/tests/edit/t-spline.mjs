// t-spline: @spline（球面 Catmull-Rom 細分＝単位ベクトルで補間し正規化）：antimeridian 跨ぎ＝縫い目を短い方で結び出力経度は
// [-180,180)・制御点は標本点にそのまま含まれる・球の回転で不変（極/縫い目で形が変わらない）・小さい図形は旧経緯度版に近い。
import { smoothRing, unwrapLons, wrapLon } from "../../src/edit/spline.js";
import { quatFromAxisAngle, rotateLL, gcDistanceDeg, smallCircle } from "../../src/edit/sphere.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const shortStep = cs => { let m = 0; for (let i = 1; i < cs.length; i++) { const d = Math.abs(cs[i][0] - cs[i - 1][0]); m = Math.max(m, Math.min(d, 360 - d)); } return m; };

// ① 縫い目を跨ぐ矩形（±179.9 混在＝エディタの正規化表現）
{
	const am = [[179.9, 35.0], [-179.9, 35.0], [-179.9, 35.2], [179.9, 35.2], [179.9, 35.0]];
	const s = smoothRing(am, true);
	ok(s.every(c => c[0] >= -180 && c[0] < 180), "閉リング：出力経度は [-180,180)");
	ok(shortStep(s) < 0.05, `閉リング：隣接点の最短経度差が小さい＝裏側回りしない（max ${shortStep(s).toFixed(4)}）`);
	ok(s.some(c => c[0] > 179.9) && s.some(c => c[0] < -179.9), "閉リング：曲線は縫い目の両側へ膨らむ（跨ぎを維持）");
	ok(s.length === 4 * 12 + 1 && s[0][0] === s[s.length - 1][0] && s[0][1] === s[s.length - 1][1], "閉リング：点数と閉じは従来どおり");
}
// ② 縫い目を跨ぐ開いた線＝終端は制御点そのもの
{
	const ln = [[179.9, 0], [-179.9, 0.1], [-179.8, 0.2], [-179.7, 0.2]];
	const s = smoothRing(ln, false);
	ok(shortStep(s) < 0.05 && s.every(c => c[0] >= -180 && c[0] < 180), "開線：最短側で結び範囲内");
	ok(s[0][0] === 179.9 && s[0][1] === 0 && s[s.length - 1][0] === -179.7 && s[s.length - 1][1] === 0.2, "開線：始点/終点は制御点そのもの");
}
// ③ 跨がないリング＝制御点は標本点そのもの・点数と閉じは従来どおり・旧経緯度版（写し）との差は小図形では小さい
{
	const ring = [[139.75, 35.68], [139.76, 35.68], [139.765, 35.69], [139.75, 35.69], [139.75, 35.68]];
	const ref = (coords, steps = 12) => {   // 旧実装の写し（経緯度で Catmull-Rom）
		const pts = coords.slice(0, -1), n = pts.length, P = i => pts[(i % n + n) % n], out = [];
		for (let i = 0; i < n; i++) { const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2); for (let j = 0; j < steps; j++) { const t = j / steps, t2 = t * t, t3 = t2 * t; out.push([
			0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
			0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]); } }
		out.push([out[0][0], out[0][1]]); return out;
	};
	const s = smoothRing(ring, true), r = ref(ring);
	ok(s.length === r.length && s[0][0] === s[s.length - 1][0] && s[0][1] === s[s.length - 1][1], "点数と閉じは従来どおり");
	ok([0, 12, 24, 36].every(k => s[k][0] === ring[k / 12][0] && s[k][1] === ring[k / 12][1]), "制御点は標本点そのもの（1ulp も動かない）");
	const dev = Math.max(...s.map((p, i) => gcDistanceDeg(p, r[i])));
	ok(dev < 5e-4, `旧経緯度版との差＝小図形では小さい（max ${(dev * 111000).toFixed(1)} m／図形 1.6km）`);
	ok(unwrapLons(ring).every((c, i) => c[0] === ring[i][0] && c[1] === ring[i][1]), "unwrapLons：範囲内の連続列は無変換");
	const near = (a, b) => Math.abs(a - b) < 1e-9;
	ok(wrapLon(139.75) === 139.75 && wrapLon(-180) === -180 && wrapLon(180) === -180 && near(wrapLon(180.4), -179.6) && near(wrapLon(-180.4), 179.6), "wrapLon：範囲内は素通し（同値）・±180 の畳み");
	ok(smoothRing([[0, 0], [1, 1]], false).length === 2, "2点は細分しない（従来）");
}
// ④ 球面性＝球の回転で不変（東京の曲線を極へ回しても同じ形）・極を囲む環・経度スパンの大きい曲線は経緯度版と違う
{
	const ring = [[139.75, 35.68], [139.76, 35.68], [139.765, 35.69], [139.75, 35.69], [139.75, 35.68]];
	const q = quatFromAxisAngle([1, 0, 0], 1.2);   // 適当な回転（極付近・縫い目付近へ運ぶ）
	const rot = pts => pts.map(p => rotateLL(q, p[0], p[1]));
	const a = rot(smoothRing(ring, true)), b = smoothRing(rot(ring), true);
	const err = Math.max(...a.map((p, i) => gcDistanceDeg(p, b[i])));
	ok(err < 1e-9, `回転不変＝先に回しても後で回しても同じ曲線（max ${err.toExponential(1)}°）`);
	const polar = smoothRing([[0, 85], [90, 85], [180, 85], [-90, 85], [0, 85]], true);
	ok(polar.every(p => p[1] >= 85 && p[1] < 86) && polar.every(p => p[0] >= -180 && p[0] < 180), "極を囲む環＝辺が極側へ膨らみ（85〜86°）経度は [-180,180)（180 の制御点も畳む）");
	const c = [139.7, 35.7], oct = smallCircle(c, 0.5, 8); oct.push([oct[0][0], oct[0][1]]);
	const sc = smoothRing(oct, true).map(p => gcDistanceDeg(c, p));
	ok(Math.min(...sc) > 0.49 && Math.max(...sc) < 0.51, `小円上の 8 点を通す曲線は小円に沿う（半径 ${Math.min(...sc).toFixed(4)}〜${Math.max(...sc).toFixed(4)}°）`);
}

console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
