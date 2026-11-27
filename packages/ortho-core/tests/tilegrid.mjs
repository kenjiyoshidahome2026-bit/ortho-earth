// t-tilegrid: 格子の口（src/tilegrid.ts）の検定。
// 守るもの：メルカトルの実装は tile.ts と同じ値（1 ビットも変わらない）／HEALPix の実装は healpix.ts・healpixvt.ts と同じ値で、
//          四分木（親子・含む）と範囲が矛盾しない／隣のタイルの縁の点が同じ経緯度に落ちる（継ぎ目が開かない）
import { mercatorGrid as M, healpixGrid as H } from "../src/tilegrid.ts";
import { tileLocalToLonLat, tileBounds, lonLatToTile } from "../src/tile.ts";
import { hpxTilePointLonLat } from "../src/healpixvt.ts";
import { lonLatToNest, nestToLonLat, hpxNeighbors, cellOf } from "../src/healpix.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const places = [[139.767, 35.681], [127.68, 26.21], [141.35, 43.06], [-0.1, 51.5], [-179.9, -16.5], [179.9, 66], [0, 0], [-70.6, -33.4], [25, 89.5], [100, -89.5]];

// ── メルカトル＝tile.ts と同じ値 ──
{
	let bad = 0, n = 0; const out = [0, 0];
	for (const [lon, lat] of places.filter(p => Math.abs(p[1]) < 85)) for (const z of [0, 4, 10, 14, 16]) {
		const t = M.at(lon, lat, z), [x, y] = lonLatToTile(lon, lat, z);
		if (t.x !== x || t.y !== y || t.z !== z) bad++;
		const f = M.toLonLat(t, 4096), [ox, oy] = M.origin(t), g = M.toLonLat(t, 4096, ox, oy), b = tileBounds(t.x, t.y, z);
		if (ox !== b[0] || oy !== b[3] || M.bounds(t).join() !== b.join()) bad++;
		for (let i = 0; i < 40; i++) {
			const px = Math.floor(rnd() * 4400) - 150, py = Math.floor(rnd() * 4400) - 150, want = tileLocalToLonLat(t.x, t.y, z, px, py, 4096);
			f(px, py, out, 0); if (out[0] !== want[0] || out[1] !== want[1]) bad++;
			g(px, py, out, 0); if (out[0] !== want[0] - ox || out[1] !== want[1] - oy) bad++;
			n++;
		}
	}
	ok(bad === 0 && n > 1000, `メルカトル：番地・原点・範囲・タイルの中の点が tile.ts と同じ値（${n} 点・余白込み）`);
	const t = { z: 12, x: 3638, y: 1612 }, ch = M.children(t);
	ok(ch.length === 4 && ch.every(c => M.under(c, t) && M.parent(c).x === t.x && M.parent(c).y === t.y && M.level(c) === 13) && !M.under(t, t) && !M.under(t, ch[0]) && !M.under({ z: 13, x: 0, y: 0 }, t), "メルカトル：親子・含む");
	ok(M.key(t) === "12/3638/1612" && M.styleZoom(t) === 12 && M.name === "mercator", "メルカトル：鍵は今の z/x/y のまま・zoom＝z");
	const c = M.center(t), b = M.bounds(t);
	ok(c[0] > b[0] && c[0] < b[2] && c[1] > b[1] && c[1] < b[3], "メルカトル：中心は範囲の中");
}

// ── HEALPix ──
{
	let bad = 0, n = 0; const out = [0, 0];
	for (const [lon, lat] of places) for (const k of [0, 3, 6, 9, 12]) {
		const t = H.at(lon, lat, k);
		if (t.npix !== lonLatToNest(lon, lat, k) || t.order !== k) bad++;
		const f = H.toLonLat(t, 4096), [ox, oy] = H.origin(t), g = H.toLonLat(t, 4096, ox, oy), c = nestToLonLat(k, t.npix);
		if (ox !== c[0] || oy !== c[1]) bad++;
		for (let i = 0; i < 40; i++) {
			const px = Math.floor(rnd() * 4097), py = Math.floor(rnd() * 4097), want = hpxTilePointLonLat(k, t.npix, px, py, 4096);
			f(px, py, out, 0); if (out[0] !== want[0] || out[1] !== want[1]) bad++;
			g(px, py, out, 0); let d = want[0] - ox; if (d > 180) d -= 360; if (d < -180) d += 360;
			if (Math.abs(out[0] - d) > 1e-12 || out[1] !== want[1] - oy || Math.abs(out[0]) > 180) bad++;
			n++;
		}
	}
	ok(bad === 0 && n > 1000, `HEALPix：番地・原点・タイルの中の点が healpix.ts／healpixvt.ts と同じ値（${n} 点）`);
}
{
	// 範囲：タイルの中の点は範囲の中・元の点も範囲の中・日付変更線は e > 180
	let bad = 0; const out = [0, 0];
	for (const [lon, lat] of places) for (const k of [1, 4, 8, 12]) {
		const t = H.at(lon, lat, k), [w, s, e, n] = H.bounds(t), f = H.toLonLat(t, 64), eps = 1e-9;
		if (!(w <= e) || w < -180 - eps || e - w > 360) bad++;
		const inside = (lo, la) => { if (la < s - eps || la > n + eps) return false; if (Math.abs(la) > 90 - 1e-6) return true; for (const d of [0, 360, -360]) if (lo + d >= w - eps && lo + d <= e + eps) return true; return false; };
		if (!inside(lon, lat)) bad++;
		for (let x = 0; x <= 64; x += 8) for (let y = 0; y <= 64; y += 8) { f(x, y, out, 0); if (!inside(out[0], out[1])) bad++; }
	}
	ok(bad === 0, "HEALPix：範囲はタイルの中の点を全部含む（日付変更線・極の近くも）");
	const dl = H.bounds(H.at(179.99, 10, 3)), tk = H.bounds(H.at(139.767, 35.681, 12));
	ok(dl[0] < 180 && dl[2] > 180, "HEALPix：日付変更線をまたぐタイルは e > 180");
	ok(tk[2] - tk[0] < 0.05 && tk[3] - tk[1] < 0.03 && tk[2] - tk[0] > 0.02, `HEALPix：東京の N12 の範囲は約 0.03° 四方（${(tk[2] - tk[0]).toFixed(4)}° × ${(tk[3] - tk[1]).toFixed(4)}°）`);
}
{
	// 四分木：子 4 枚・親へ戻る・含む・子の中心は親の範囲の中
	let bad = 0;
	for (const [lon, lat] of places) for (const k of [0, 5, 11]) {
		const t = H.at(lon, lat, k), ch = H.children(t), deep = H.at(lon, lat, k + 4);
		if (ch.length !== 4 || new Set(ch.map(H.key)).size !== 4) bad++;
		for (const c of ch) if (!H.under(c, t) || H.parent(c).npix !== t.npix || H.level(c) !== k + 1 || H.under(t, c)) bad++;
		if (!H.under(deep, t) || H.under(t, t) || !ch.some(c => c.npix === H.at(lon, lat, k + 1).npix)) bad++;
		const other = H.at(lon + 90, -lat, k + 4); if (k > 0 && H.under(other, t)) bad++;
	}
	ok(bad === 0, "HEALPix：親子・含む（点を含むタイルの子のどれかが、1 段下でその点を含む）");
	const t = H.at(139.767, 35.681, 12);
	ok(H.key(t) === `h12/${t.npix}` && H.styleZoom(t) === 15 && H.name === "healpix" && cellOf(12, t.npix).face === 1, "HEALPix：鍵は h{order}/{npix}（メルカトルの鍵と重ならない）・N12＝zoom 15");
}
{
	// 継ぎ目：隣のタイルと共有する縁の点が同じ経緯度に落ちる（面の中の隣＝ix+1）
	let bad = 0, n = 0; const a = [0, 0], b = [0, 0], E = 4096;
	for (const [lon, lat] of places.slice(0, 8)) for (const k of [6, 12]) {
		const t = H.at(lon, lat, k), c = cellOf(k, t.npix), N = 2 ** k;
		if (c.ix + 1 >= N) continue;
		const nb = hpxNeighbors(k, t.npix).map(p => ({ order: k, npix: p })).find(u => { const d = cellOf(k, u.npix); return d.face === c.face && d.ix === c.ix + 1 && d.iy === c.iy; });
		if (!nb) { bad++; continue; }
		const f = H.toLonLat(t, E), g = H.toLonLat(nb, E);
		for (let y = 0; y <= E; y += 512) { f(E, y, a, 0); g(0, y, b, 0); if (Math.abs(a[0] - b[0]) > 1e-9 || Math.abs(a[1] - b[1]) > 1e-9) bad++; n++; }
	}
	ok(bad === 0 && n > 50, `HEALPix：隣のタイルと縁の点が一致（${n} 点・1e-9°）`);
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
