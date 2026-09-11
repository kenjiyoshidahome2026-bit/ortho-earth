// t-spline: @spline（Catmull-Rom 細分）の antimeridian 跨ぎ＝縫い目を短い方で結び、出力経度は [-180,180)。
// 跨がないリングは従来実装（生の経度で補間）と byte-exact（node tests/edit/t-spline.mjs）。
import { smoothRing, unwrapLons, wrapLon } from "../../src/edit/spline.js";

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
// ③ 跨がないリング＝従来実装（生の経度で Catmull-Rom）と byte-exact
{
	const ring = [[139.75, 35.68], [139.76, 35.68], [139.765, 35.69], [139.75, 35.69], [139.75, 35.68]];
	const ref = (coords, steps = 12) => {   // 旧実装の写し（unwrap/wrap なし）
		const pts = coords.slice(0, -1), n = pts.length, P = i => pts[(i % n + n) % n], out = [];
		for (let i = 0; i < n; i++) { const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2); for (let j = 0; j < steps; j++) { const t = j / steps, t2 = t * t, t3 = t2 * t; out.push([
			0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
			0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]); } }
		out.push([out[0][0], out[0][1]]); return out;
	};
	ok(JSON.stringify(smoothRing(ring, true)) === JSON.stringify(ref(ring)), "跨がないリング＝従来と byte-exact");
	ok(unwrapLons(ring).every((c, i) => c[0] === ring[i][0] && c[1] === ring[i][1]), "unwrapLons：範囲内の連続列は無変換");
	const near = (a, b) => Math.abs(a - b) < 1e-9;
	ok(wrapLon(139.75) === 139.75 && wrapLon(-180) === -180 && wrapLon(180) === -180 && near(wrapLon(180.4), -179.6) && near(wrapLon(-180.4), 179.6), "wrapLon：範囲内は素通し（同値）・±180 の畳み");
	ok(smoothRing([[0, 0], [1, 1]], false).length === 2, "2点は細分しない（従来）");
}

console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
