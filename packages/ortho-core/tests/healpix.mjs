// t-healpix: HEALPix（NESTED）の純関数（src/healpix.ts）の検定。
// 守るもの＝「番地が healpy と同じ」＝焼き手・選抜・シェーダが同じセルを指す。基準値は tests/fixtures/healpix-healpy.json（scripts/healpix-fixtures.py・healpy 1.20）。
import { readFileSync } from "node:fs";
import { interleave, deinterleave, lonLatToXYF, xyfToLonLat, lonLatToNest, nestToLonLat, nestOf, cellOf, hpxCount, hpxParent, hpxChildren, hpxCorners, hpxBoundary, hpxNeighbors, hpxWrap, hpxId, hpxOfId, hpxPath, hpxPixelLonLat, HPX_MAX_ORDER } from "../src/healpix.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const fx = JSON.parse(readFileSync(new URL("./fixtures/healpix-healpy.json", import.meta.url), "utf8"));
const dLon = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// 1. ビットの織り込み（32 bit を超える番号）
{
	let bad = 0, seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
	for (let i = 0; i < 2000; i++) {
		const ix = rnd() & 0xffffff, iy = rnd() & 0xffffff, n = interleave(ix, iy), xy = deinterleave(n);
		let ref = 0n; for (let b = 0n; b < 24n; b++) ref |= ((BigInt(ix) >> b) & 1n) << (2n * b) | ((BigInt(iy) >> b) & 1n) << (2n * b + 1n);
		if (BigInt(n) !== ref || xy[0] !== ix || xy[1] !== iy) bad++;
	}
	ok(bad === 0, "interleave／deinterleave：24 bit の組 2000 個が BigInt の素朴な実装と一致・往復する");
	ok(Number.isSafeInteger(hpxCount(HPX_MAX_ORDER)), `order ${HPX_MAX_ORDER} の総数が安全な整数`);
}

// 2. 経緯度 → 番号（healpy.ang2pix）
{
	let bad = 0, n = 0;
	for (const [lon, lat, ...pix] of fx.points) fx.orders.forEach((k, i) => { n++; if (lonLatToNest(lon, lat, k) !== pix[i]) { bad++; if (bad < 5) console.error("  ", lon, lat, k, lonLatToNest(lon, lat, k), pix[i]); } });
	ok(bad === 0, `lonLatToNest：${n} 個（order ${fx.orders.join("/")}・極と面の境界を含む）が healpy と一致`);
}

// 3. 番号 → 中心（healpy.pix2ang）と往復
{
	let worst = 0, back = 0;
	for (const [k, p, lon, lat] of fx.centers) {
		const ll = nestToLonLat(k, p);
		worst = Math.max(worst, dLon(ll[0], lon) * Math.cos(lat * Math.PI / 180), Math.abs(ll[1] - lat));
		if (lonLatToNest(ll[0], ll[1], k) !== p) back++;
		const c = cellOf(k, p); if (nestOf(k, c.face, c.ix, c.iy) !== p) back++;
	}
	ok(worst < 1e-9, `nestToLonLat：${fx.centers.length} 個の中心が healpy と一致（最大差 ${worst.toExponential(1)}°）`);
	ok(back === 0, "中心 → 番号、番号 → 面と座標 → 番号が往復する");
}

// 4. 8 近傍（healpy.get_all_neighbours）
{
	let bad = 0;
	for (const [k, p, ...nb] of fx.neighbors) { const got = hpxNeighbors(k, p); if (got.join() !== nb.join()) { bad++; if (bad < 4) console.error("  ", k, p, got.join(), nb.join()); } }
	ok(bad === 0, `hpxNeighbors：${fx.neighbors.length} 個（order 0 の全 12 面＝面をまたぐ全部の型を含む）が healpy と一致`);
	ok(hpxWrap(2, 0, 4, -1) === null && hpxWrap(2, 4, 4, 4) === null && hpxWrap(2, 0, 4, 4).face === 2, "hpxWrap：隣の無い角（冠の面の東・赤道の面の北）は null・冠の面の北の角の先は向かいの面");
}

// 5. 隅（healpy.boundaries＝北・西・南・東の順）
{
	let worst = 0;
	for (const [k, p, N, W, S, E] of fx.corners) {
		const c = hpxCorners(k, p);   // 南・東・北・西
		[[c[0], S], [c[1], E], [c[2], N], [c[3], W]].forEach(([a, b]) => {
			const pole = Math.abs(b[1]) > 89.999999;   // 極の経度は不定
			worst = Math.max(worst, Math.abs(a[1] - b[1]), pole ? 0 : dLon(a[0], b[0]) * Math.cos(b[1] * Math.PI / 180));
		});
	}
	ok(worst < 1e-9, `hpxCorners：${fx.corners.length} 個の隅（南・東・北・西）が healpy と一致（最大差 ${worst.toExponential(1)}°）`);
	const b = hpxBoundary(1, 17, 4), c = hpxCorners(1, 17);
	ok(b.length === 16 && [0, 4, 8, 12].every((i, j) => b[i][0] === c[j][0] && b[i][1] === c[j][1]), "hpxBoundary：1 辺 4 分割＝16 点・4 点ごとが隅");
}

// 6. 親子・画素・鍵・置き場
{
	const k = 3, p = 421, ch = hpxChildren(p), c = cellOf(k, p), W = 8;
	ok(ch.every(x => hpxParent(x) === p), "親子：子 4 つの親は自分");
	// 画素 (col,row) はちょうど order k+log2(W) の NESTED セル。子 i は列 (i&1)·W/2・行 (i>>1)·W/2 の象限
	let bad = 0;
	for (let row = 0; row < W; row++) for (let col = 0; col < W; col++) {
		const ll = hpxPixelLonLat(k, c, W, col, row), deep = lonLatToNest(ll[0], ll[1], k + 3);
		if (deep !== nestOf(k + 3, c.face, c.ix * W + col, c.iy * W + row)) bad++;
		if (hpxParent(hpxParent(deep)) !== ch[(col >= W / 2 ? 1 : 0) | (row >= W / 2 ? 2 : 0)]) bad++;
	}
	ok(bad === 0, "画素の規約：タイルの画素 (col,row) ＝ order k+log2(W) のセル・子 i の象限＝列 (i&1)・行 (i>>1)");
	const f = lonLatToXYF(139.7, 35.68), ll = xyfToLonLat(f.face, f.x, f.y);
	ok(Math.abs(ll[0] - 139.7) < 1e-10 && Math.abs(ll[1] - 35.68) < 1e-10, "lonLatToXYF ⇄ xyfToLonLat が往復する");
	const ids = new Set(); for (let o = 0; o <= 3; o++) for (let n = 0; n < hpxCount(o); n++) ids.add(hpxId(o, n));
	const t = hpxOfId(hpxId(11, 1234567));
	ok(ids.size === 12 + 48 + 192 + 768 && t.order === 11 && t.npix === 1234567 && hpxId(0, 0) === 4, "hpxId：order を跨いで一意（UNIQ）・hpxOfId で戻る");
	ok(hpxPath(5, 12287, "altpbf") === "Norder5/Dir10000/Npix12287.altpbf" && hpxPath(0, 3, "jpg") === "Norder0/Dir0/Npix3.jpg", "hpxPath：HiPS の置き場");
}

if (fails) { console.error(`\n${fails} failed`); process.exit(1); }
console.log("\nall passed");
