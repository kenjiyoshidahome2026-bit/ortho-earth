#!/usr/bin/env node
// 地形適応細分（gint 線の 3D ドレープ貫きの根治・2026-09-21）の常設ハーネス。
//   1. bake：chunk.sx/sy（チャンク最長辺スパン）と result.spanX/spanY が、meta の辺を全部 decode した総当たりと一致
//      （基準メタ・tier メタ・境界メタ・reversed arc・360e7 周期ラップ込み）
//   2. drawdata.drapeSubs：run 上限 N の決め方（2の冪・セル数以上・未知=SUB_MAX・予算半減・dep 無し/noSub＝全1）
//   3. subRange（programs.js/gintwgsl.js の VS 関数の JS ミラー）の不変条件：
//      区間の和が [0,1] を過不足なく覆う・区間数 ≤ N・近傍窓内の区間は 1 セル以下（上限未達なら）・
//      N を倍にしても既存の区間境界は残る（入れ子＝カメラが動いても頂点が滑らない）
// 使い方: node packages/ortho-core/tests/gint-drape.mjs
import { buildEdgeMeta, buildBoundaryEdgeMeta, SUB_S0, SUB_NB, SUB_DUP } from '../src/gl/gint/utility.js';
import { drapeSubs, subPlan, SUB_MAX, SUB_BUDGET } from '../src/gl/gint/drawdata.js';

let fails = 0;
const ok = (cond, label) => { if (cond) return; fails++; console.error(`  ✗ ${label}`); };

// ── Morton 符号化（shader decodeDLL / utility _compact16 の逆）──
const spread16 = v => { v &= 0xFFFF; v = (v | (v << 8)) & 0x00FF00FF; v = (v | (v << 4)) & 0x0F0F0F0F; v = (v | (v << 2)) & 0x33333333; v = (v | (v << 1)) & 0x55555555; return v >>> 0; };
const enc = (ix, iy, term, w) => {   // 非 terminal は座標 8 単位丸め（下位 3bit＝lo の下位 6bit を rank に使う）
	if (!term) { ix &= ~7; iy &= ~7; }
	const lo = (spread16(ix & 0xFFFF) | (spread16(iy & 0xFFFF) << 1)) >>> 0;
	const hi = (spread16(ix >>> 16) | (spread16(iy >>> 16) << 1)) >>> 0;
	return [term ? (lo >>> 0) : ((lo & ~0x3F) | (w & 0x3F)) >>> 0, term ? (hi | 0x80000000) >>> 0 : (hi & 0x7FFFFFFF) >>> 0];
};
const compact16 = m => { m &= 0x55555555; m = (m | (m >>> 1)) & 0x33333333; m = (m | (m >>> 2)) & 0x0F0F0F0F; m = (m | (m >>> 4)) & 0x00FF00FF; m = (m | (m >>> 8)) & 0x0000FFFF; return m; };
const dec = (u32, idx) => { const lo = u32[idx * 2], hi = u32[idx * 2 + 1]; const loC = (hi & 0x80000000) ? lo : (lo & 0xFFFFFFC0), hiC = hi & 0x7FFFFFFF;
	return [((compact16(hiC) << 16) | compact16(loC)) >>> 0, ((compact16(hiC >>> 1) << 16) | compact16(loC >>> 1)) >>> 0]; };
const spanOf = (u32, a, b) => { const A = dec(u32, a), B = dec(u32, b); let dx = Math.abs(A[0] - B[0]); if (dx > 1800000000) dx = 3600000000 - dx; return [dx, Math.abs(A[1] - B[1])]; };

function mulberry32(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }
// 合成データ：arc は実座標つき（ランダムウォーク・一部は長い直線辺＝スパン検定の主役・一部は ±180 跨ぎ）
function genData(rnd, nArcs = 120, maxLen = 30) {
	const lens = []; for (let a = 0; a < nArcs; a++) lens.push(2 + Math.floor(rnd() * (maxLen - 2)));
	const total = lens.reduce((s, l) => s + l, 0);
	const arcU32 = new Uint32Array(total * 2), arcMeta = new Uint32Array(nArcs * 8);
	let off = 0;
	lens.forEach((len, aid) => {
		arcMeta[aid * 8] = off; arcMeta[aid * 8 + 1] = len;
		const seam = aid % 17 === 0;   // 縫い目跨ぎ（経度 ±180 付近）＝ラップの検定
		let x = seam ? 3599000000 + Math.floor(rnd() * 900000) : 200000000 + Math.floor(rnd() * 3.0e9), y = 100000000 + Math.floor(rnd() * 1.6e9);
		let x0 = 1e12, y0 = 1e12, x1 = -1, y1 = -1;
		for (let i = 0; i < len; i++) {
			const term = (i === 0 || i === len - 1);
			let w = 0; while (w < 62 && rnd() < 0.72) w++;
			const [lo, hi] = enc(x, y, term, w); arcU32[(off + i) * 2] = lo; arcU32[(off + i) * 2 + 1] = hi;
			const d = dec(arcU32, off + i); x0 = Math.min(x0, d[0]); y0 = Math.min(y0, d[1]); x1 = Math.max(x1, d[0]); y1 = Math.max(y1, d[1]);
			const big = rnd() < 0.05;   // 長い直線辺（最大 ~0.9°）
			x = (x + Math.floor((rnd() - 0.5) * (big ? 18000000 : 60000))) % 3600000000; if (x < 0) x += 3600000000;
			y = Math.max(8, Math.min(1799999990, y + Math.floor((rnd() - 0.5) * (big ? 18000000 : 60000))));
		}
		arcMeta[aid * 8 + 4] = x0; arcMeta[aid * 8 + 5] = y0; arcMeta[aid * 8 + 6] = x1; arcMeta[aid * 8 + 7] = y1;
		off += len;
	});
	const poly = []; for (let f = 0; f < Math.floor(nArcs / 3); f++) { const a1 = f * 3, a2 = f * 3 + 1; poly.push(f, 1, 2, a1, a2, 1000 + f, 1, 2, ~a2, ~a1); }
	const line = []; for (let a = Math.floor(nArcs / 3) * 3, f = 5000; a < nArcs; a += 2, f++) { const two = a + 1 < nArcs; line.push(f, 1, two ? 2 : 1, (a % 4 === 0) ? ~a : a); if (two) line.push((a % 3 === 0) ? ~(a + 1) : a + 1); }
	return { arcU32, arcBuffer: { buffer: arcU32.buffer, byteOffset: 0, byteLength: arcU32.byteLength, length: total }, arcMeta, polyStream: Int32Array.from(poly), lineStream: Int32Array.from(line) };
}

// 複製行（長辺の細分用）の検定：各行が SUB_DUP 印・元の辺 id・元の辺のバケット b・チャンク内、長辺は全て 1 回ずつ現れる
const bucketOfSpan = sp => { if (sp < SUB_S0) return -1; const b = 31 - Math.clz32(Math.floor(sp / SUB_S0)); return b >= SUB_NB ? SUB_NB - 1 : b; };
function checkSub(label, u32, meta, edgeCount, subCount, list, ranges) {   // list=[b,start,count,…]・ranges=[[start,end,list]…]（チャンク）
	ok(meta.length === (edgeCount + subCount) * 4, `${label}: メタ行数 = 辺 ${edgeCount} + 複製 ${subCount}`);
	const seen = new Uint8Array(edgeCount);
	let rows = 0;
	for (const [cs, ce, lst] of ranges) {
		if (!lst) continue;
		for (let i = 0; i < lst.length; i += 3) {
			const b = lst[i], st = lst[i + 1], n = lst[i + 2];
			ok(st >= edgeCount && st + n <= edgeCount + subCount, `${label}: 複製区間 [${st},${st + n}) はメタ末尾`);
			for (let r = st; r < st + n; r++) {
				const m2 = meta[r * 4 + 2];
				ok((m2 & SUB_DUP) !== 0, `${label}: 行 ${r} に SUB_DUP 印`);
				const e = m2 >>> 8;
				ok(e >= cs && e < ce, `${label}: 元の辺 ${e} はチャンク [${cs},${ce}) 内`);
				ok(meta[r * 4] === meta[e * 4] && meta[r * 4 + 1] === meta[e * 4 + 1] && (m2 & 0x7F) === (meta[e * 4 + 2] & 0xFF) && meta[r * 4 + 3] === meta[e * 4 + 3], `${label}: 行 ${r} は辺 ${e} の複製`);
				const [dx, dy] = spanOf(u32, meta[e * 4], meta[e * 4 + 1]);
				ok(bucketOfSpan(Math.max(dx, dy)) === b, `${label}: 辺 ${e} のバケット ${bucketOfSpan(Math.max(dx, dy))} == ${b}`);
				seen[e]++; rows++;
			}
		}
	}
	ok(rows === subCount, `${label}: 複製行 ${rows} == subCount ${subCount}`);
	let longN = 0;
	for (let e = 0; e < edgeCount; e++) { const [dx, dy] = spanOf(u32, meta[e * 4], meta[e * 4 + 1]); const long = Math.max(dx, dy) >= SUB_S0; if (long) longN++; ok(seen[e] === (long ? 1 : 0), `${label}: 辺 ${e}（長辺=${long}）の複製 ${seen[e]} 回`); }
	ok(longN === subCount, `${label}: 長辺 ${longN} == 複製 ${subCount}`);
}

// ── 1. bake のスパン ──
console.log('■ bake：chunk.sx/sy・spanX/Y ＝ 総当たり・複製行');
{
	const g = genData(mulberry32(7));
	for (const [label, minW, chunkEdges] of [['基準メタ', 0, 64], ['tier w20', 20, 64], ['基準メタ（台帳なし）', 0, 0]]) {
		const r = buildEdgeMeta(g.arcMeta, g.polyStream, g.lineStream, g.arcBuffer, minW, { chunkEdges });
		ok(r.subCount > 0, `${label}: 複製行あり（${r.subCount}）`);
		checkSub(label, g.arcU32, r.metaU32, r.edgeCount, r.subCount, r.sub, r.chunks ? r.chunks.map(c => [c.start, c.end, c.sub]) : [[0, r.edgeCount, r.sub]]);
		let gx = 0, gy = 0;
		if (r.chunks) {
			ok(r.chunks.length > 1, `${label}: チャンクが複数（${r.chunks.length}）`);
			for (const c of r.chunks) {
				let sx = 0, sy = 0;
				for (let e = c.start; e < c.end; e++) { const [dx, dy] = spanOf(g.arcU32, r.metaU32[e * 4], r.metaU32[e * 4 + 1]); sx = Math.max(sx, dx); sy = Math.max(sy, dy); }
				ok(c.sx === sx && c.sy === sy, `${label}: chunk[${c.start},${c.end}) sx/sy ${c.sx}/${c.sy} == ${sx}/${sy}`);
				gx = Math.max(gx, sx); gy = Math.max(gy, sy);
			}
		} else for (let e = 0; e < r.edgeCount; e++) { const [dx, dy] = spanOf(g.arcU32, r.metaU32[e * 4], r.metaU32[e * 4 + 1]); gx = Math.max(gx, dx); gy = Math.max(gy, dy); }
		ok(r.spanX === gx && r.spanY === gy, `${label}: spanX/Y ${r.spanX}/${r.spanY} == ${gx}/${gy}`);
		ok(gx > 5000000, `${label}: 長い直線辺が含まれる（spanX=${gx}）`);
	}
	const b = buildBoundaryEdgeMeta(g.arcMeta, g.polyStream, g.lineStream, g.arcBuffer, 0);
	let gx = 0, gy = 0;
	for (let e = 0; e < b.edgeCount; e++) { const [dx, dy] = spanOf(g.arcU32, b.metaU32[e * 4], b.metaU32[e * 4 + 1]); gx = Math.max(gx, dx); gy = Math.max(gy, dy); }
	ok(b.spanX === gx && b.spanY === gy, `境界メタ: spanX/Y ${b.spanX}/${b.spanY} == ${gx}/${gy}`);
	checkSub('境界メタ', g.arcU32, b.metaU32, b.edgeCount, b.subCount, b.sub, [[0, b.edgeCount, b.sub]]);
	const r0 = buildEdgeMeta(g.arcMeta, g.polyStream, g.lineStream, null, 0, { chunkEdges: 64 });
	ok(r0.spanX === -1 && r0.chunks.every(c => c.sx === -1 && c.sy === -1), 'arcBuffer 無し＝スパン未知(-1)');
	ok(r0.subCount === 0 && r0.metaU32.length === r0.edgeCount * 4 && r0.chunks.every(c => c.sub == null), 'arcBuffer 無し＝複製行なし');
	// 縫い目跨ぎのスパンは 360e7 で畳まれている（1.8e9 を超えない）
	ok(gx <= 1800000000, `縫い目跨ぎ辺のスパンは最短側（${gx} ≤ 1.8e9）`);
}

// ── 2. subPlan（バケット別 N と skip 下限）／drapeSubs（ハイライト用） ──
console.log('■ subPlan：バケット別 N・skip 下限・予算');
{
	const cell = 1 / 768;   // 1°窓 G=769 相当（deg）＝0.0013°＝e7 13021
	const dep = { elevScale: 1, hasElev: 1, meshQ: [0, 0, 1, 1], meshG: 769 };
	const runs = b => { const a = new Array(SUB_NB).fill(null); for (let i = 0; i < SUB_NB; i++) a[i] = [[1000 + i * 10, 10]]; return a; };
	let pl = subPlan(null, runs());
	ok(pl.skipE7 === 0 && pl.N.every(n => n === 1), 'dep 無し＝N 全1・skip 0');
	ok(subPlan({ ...dep, noSub: true }, runs()).skipE7 === 0, 'noSub＝skip 0');
	pl = subPlan(dep, runs());
	// バケット b の上限 S0·2^(b+1)：b=3 → 16000e7=0.0016° > 1 セル(0.0013°) ⇒ N=2 が最初。b=2 → 8000e7=0.0008° < 1 セル ⇒ N=1
	ok(pl.N[2] === 1 && pl.N[3] === 2, `b=2→1, b=3→2（${Array.from(pl.N).join(',')}）`);
	ok(pl.skipE7 === SUB_S0 * 8, `skip 下限 = S0·2^3 = ${SUB_S0 * 8}（${pl.skipE7}）`);
	for (let b = 1; b < SUB_NB; b++) ok(pl.N[b] >= pl.N[b - 1] && (pl.N[b] & (pl.N[b] - 1)) === 0 && pl.N[b] <= SUB_MAX, `N 単調・2 の冪・上限（b=${b}）`);
	for (let b = 0; b < SUB_NB; b++) { const cells = SUB_S0 * Math.pow(2, b + 1) * 1e-7 / cell; ok(pl.N[b] >= Math.min(cells, SUB_MAX) || pl.N[b] === SUB_MAX, `N[${b}] ≥ 上限セル数 ${cells.toFixed(1)}`); }
	ok(pl.N[13] === SUB_MAX && pl.N[15] === SUB_MAX, '1° 級のバケットは SUB_MAX');
	// 予算：巨大な複製区間＝全バケット半減（下位が 1 に落ちて skip が上がる）
	const big = runs(); big[3] = [[0, SUB_BUDGET]];
	const pb = subPlan(dep, big);
	ok(pb.N[3] === 1 && pb.skipE7 > SUB_S0 * 8 && pb.total <= SUB_BUDGET, `予算超過＝半減して skip 上昇（N[3]=${pb.N[3]} skip=${pb.skipE7} total=${pb.total}）`);
	ok(subPlan(dep, null).skipE7 === SUB_S0 * 8, 'subRuns 無し（区間ゼロ）でも skip 下限は決まる');
}
console.log('■ drapeSubs：ハイライト用の一様 N');
{
	const cell = 1 / 768;   // 1°窓 G=769 相当（deg）
	const dep = { elevScale: 1, hasElev: 1, meshQ: [0, 0, 1, 1], meshG: 769 };
	ok(drapeSubs(null, [[0, 10, 5e7, 5e7]]).every(n => n === 1), 'dep 無し＝全 1');
	ok(drapeSubs({ ...dep, elevScale: 0 }, [[0, 10, 5e7, 5e7]])[0] === 1, 'elevScale=0（真俯瞰）＝1');
	ok(drapeSubs({ ...dep, noSub: true }, [[0, 10, 5e7, 5e7]])[0] === 1, 'noSub（?nosub=1）＝1');
	ok(drapeSubs(dep, [[0, 10, 0, 0]])[0] === 1, 'スパン 0＝1');
	ok(drapeSubs(dep, [[0, 10, Math.round(cell * 0.9 * 1e7), 0]])[0] === 1, '0.9 セル＝1');
	ok(drapeSubs(dep, [[0, 10, Math.round(cell * 1.5 * 1e7), 0]])[0] === 2, '1.5 セル＝2');
	ok(drapeSubs(dep, [[0, 10, 0, Math.round(cell * 5 * 1e7)]])[0] === 8, '5 セル（緯度側）＝8');
	ok(drapeSubs(dep, [[0, 10, 1e7, 1e7]])[0] === SUB_MAX, '1°（768 セル）＝上限 SUB_MAX');
	ok(drapeSubs(dep, [[0, 10, -1, -1]])[0] === SUB_MAX, 'スパン未知＝上限 SUB_MAX');
	const many = drapeSubs(dep, [[0, SUB_BUDGET, 1e7, 1e7], [SUB_BUDGET, 100, Math.round(cell * 3 * 1e7), 0]]);
	ok(many[0] === 1 && many[1] === 1, `予算超過＝全 run を半減して 1 まで（${many}）`);
	const mid = drapeSubs(dep, [[0, 100000, 1e7, 1e7], [100000, 100, Math.round(cell * 3 * 1e7), 0]]);
	ok(mid[0] === 8 && mid[1] === 1, `予算内に収まるまで全 run を一様に半減（64→8・4→1）（${mid}）`);
	ok(drapeSubs(dep, [[0, 10, 1e7, 1e7]]).every(n => (n & (n - 1)) === 0), '2 の冪');
}

// ── 3. subRange の JS ミラー（programs.js VS_RENDER subRange と同一ロジック）──
const pow2ceil = x => { let p = 1; while (p < x) p <<= 1; return p; };
function subRange(dA, dB, s, N, near, cell, G = 769) {
	let ts = 0, te = 1;
	if (N <= 1 || G < 1.5) return { ok: s === 0, ts, te };
	const d = [dB[0] - dA[0], dB[1] - dA[1]];
	let t0 = 0, t1 = 1;
	if (near[0] > 0) {
		for (let i = 0; i < 2; i++) {
			let p = -d[i], q = dA[i] + near[i];
			if (p === 0) { if (q < 0) { t0 = 1; t1 = 0; } } else { const r = q / p; if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r); }
			p = d[i]; q = near[i] - dA[i];
			if (p === 0) { if (q < 0) { t0 = 1; t1 = 0; } } else { const r = q / p; if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r); }
		}
		if (t0 > t1) { t0 = 0; t1 = 0; } else { t0 = Math.floor(t0 * 32) / 32; t1 = Math.ceil(t1 * 32) / 32; }
	}
	const pre = t0 > 0 ? 1 : 0, post = t1 < 1 ? 1 : 0;
	if (N < pre + post + 1) return { ok: s === 0, ts, te };
	let nIn = 0, L = -1;
	if (t1 > t0) {
		const cAll = Math.max(Math.abs(d[0]) / cell[0], Math.abs(d[1]) / cell[1]);
		let Ln = 0; while ((1 << Ln) < cAll && Ln < 12) Ln++;
		let Lc = 0; while ((1 << (Lc + 1)) * (t1 - t0) <= N - pre - post && Lc < 12) Lc++;
		L = Math.min(Ln, Lc);
		nIn = L >= 5 ? Math.floor((t1 - t0) * (1 << L) + 0.5) : Math.min(pow2ceil(Math.ceil(Math.min(cAll * (t1 - t0), 4096))), N - pre - post);
		nIn = Math.max(nIn, 1);
	}
	const rem = N - nIn; let nPre = 0, nPost = 0;
	const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
	if (pre) { const c = Math.max(Math.abs(d[0]) * t0 / cell[0], Math.abs(d[1]) * t0 / cell[1]) * 0.125; nPre = clamp(pow2ceil(Math.ceil(Math.min(c, 4096))), 1, post ? Math.floor(rem / 2) : rem); }
	if (post) { const c = Math.max(Math.abs(d[0]) * (1 - t1) / cell[0], Math.abs(d[1]) * (1 - t1) / cell[1]) * 0.125; nPost = clamp(pow2ceil(Math.ceil(Math.min(c, 4096))), 1, rem - nPre); }
	const n = nPre + nIn + nPost;
	if (s >= n) return { ok: false, ts, te };
	if (s < nPre) { ts = t0 * s / nPre; te = t0 * (s + 1) / nPre; }
	else if (s < nPre + nIn) { const k = s - nPre; ts = t0 + (t1 - t0) * k / nIn; te = t0 + (t1 - t0) * (k + 1) / nIn; }
	else { const k = s - nPre - nIn; ts = t1 + (1 - t1) * k / nPost; te = t1 + (1 - t1) * (k + 1) / nPost; }
	return { ok: true, ts, te, n, nIn, nPre, nPost, t0, t1, L };
}
function segsOf(dA, dB, N, near, cell) { const out = []; for (let s = 0; s < N; s++) { const r = subRange(dA, dB, s, N, near, cell); if (r.ok) out.push(r); } return out; }
console.log('■ subRange ミラー：被覆・上限・セル長・入れ子');
{
	const rnd = mulberry32(11);
	const cell = [1 / 768, 1 / 768];
	let nested = 0, clamped = 0, cases = 0, fine = 0, shifted = 0;
	for (let it = 0; it < 4000; it++) {
		const long = rnd() < 0.3;
		const dA = [(rnd() - 0.5) * 2, (rnd() - 0.5) * 2], L = long ? 0.5 + rnd() * 0.5 : rnd() * 0.02, ang = rnd() * Math.PI * 2;
		const dB = [dA[0] + Math.cos(ang) * L, dA[1] + Math.sin(ang) * L];
		const near = rnd() < 0.2 ? [0, 0] : [0.02 + rnd() * 0.3, 0.02 + rnd() * 0.3];
		const N = 1 << Math.floor(rnd() * 8);   // 1..128
		const segs = segsOf(dA, dB, N, near, cell);
		cases++;
		ok(segs.length >= 1 && segs.length <= N, `区間数 1..N（${segs.length}/${N}）`);
		// 被覆：昇順・隙間なし・重なりなし・[0,1]
		let good = Math.abs(segs[0].ts) < 1e-12 && Math.abs(segs[segs.length - 1].te - 1) < 1e-12;
		for (let i = 1; i < segs.length; i++) if (Math.abs(segs[i].ts - segs[i - 1].te) > 1e-9) good = false;
		for (const sg of segs) if (!(sg.te > sg.ts)) good = false;
		ok(good, `被覆 [0,1] 過不足なし（N=${N} near=${near.map(v => v.toFixed(3))} L=${L.toFixed(4)}）`);
		// 近傍窓内の区間 ≤ 1 セル（上限未達なら）
		const r0 = segs[0];
		const cAll = Math.max(Math.abs(dB[0] - dA[0]) / cell[0], Math.abs(dB[1] - dA[1]) / cell[1]);
		let Ln = 0; while ((1 << Ln) < cAll && Ln < 12) Ln++;
		if (r0.n != null && r0.nIn > 0 && r0.L === Ln && r0.L >= 5) {   // 上限（N）でなくセル数で L が決まった＝窓内区間 ≤ 1 セル
			for (const sg of segs) if (sg.ts >= r0.t0 - 1e-12 && sg.te <= r0.t1 + 1e-12 && r0.t1 > r0.t0) {
				const cx = Math.abs(dB[0] - dA[0]) * (sg.te - sg.ts) / cell[0], cy = Math.abs(dB[1] - dA[1]) * (sg.te - sg.ts) / cell[1];
				ok(Math.max(cx, cy) <= 1 + 1e-9, `窓内区間 ≤ 1 セル（${Math.max(cx, cy).toFixed(3)}）`);
				ok(Math.abs(sg.ts * (1 << r0.L) - Math.round(sg.ts * (1 << r0.L))) < 1e-9, `窓内境界は 1/2^L 格子上（L=${r0.L}）`);
			}
			fine++;
		} else clamped++;
		// 窓が動いても窓内の境界は同じ格子（L が等しい限り集合として一致・異なれば入れ子）
		if (near[0] > 0 && r0.n != null && r0.L >= 5) {
			const near2 = [near[0] * (0.7 + rnd() * 0.6), near[1] * (0.7 + rnd() * 0.6)];
			const segs2 = segsOf(dA, dB, N, near2, cell), q0 = segs2[0];
			if (q0.n != null && q0.L >= 5 && q0.t1 > q0.t0 && r0.t1 > r0.t0) {
				const lo = Math.max(r0.t0, q0.t0), hi = Math.min(r0.t1, q0.t1);
				if (hi > lo) {
					const fineL = r0.L >= q0.L ? segs : segs2, coarse = r0.L >= q0.L ? segs2 : segs;
					const fb = new Set(fineL.map(sg => sg.ts.toFixed(12)));
					let keep = true;
					for (const sg of coarse) if (sg.ts > lo + 1e-12 && sg.ts < hi - 1e-12 && !fb.has(sg.ts.toFixed(12))) keep = false;
					ok(keep, `窓シフトで窓内境界が滑らない（L ${r0.L} vs ${q0.L}）`);
					shifted++;
				}
			}
		}
		// 入れ子：N→2N で既存の区間境界が残る（区間数が上限で刻まれた非 2 冪の時だけ免除）
		if (N < 128) {
			const segs2 = segsOf(dA, dB, N * 2, near, cell);
			const isPow2 = v => (v & (v - 1)) === 0;
			const a = segs[0], b = segs2[0];
			if (a.n != null && b.n != null && isPow2(a.nIn || 1) && isPow2(a.nPre || 1) && isPow2(a.nPost || 1) && isPow2(b.nIn || 1) && isPow2(b.nPre || 1) && isPow2(b.nPost || 1)) {
				const bounds2 = new Set(segs2.map(sg => sg.ts.toFixed(12)));
				let keep = true; for (const sg of segs) if (!bounds2.has(sg.ts.toFixed(12))) keep = false;
				ok(keep, `入れ子 N=${N}→${N * 2}（境界が消えない）`);
				nested++;
			}
		}
	}
	console.log(`  ${cases} ケース（窓内 1 セル以下を検定 ${fine}・上限で刻んだ ${clamped}・入れ子検定 ${nested}・窓シフト検定 ${shifted}）`);
	// 端点の恒等：細分されない辺（N=1）は [0,1] 1 本
	const one = segsOf([0, 0], [0.001, 0.001], 1, [0.1, 0.1], cell);
	ok(one.length === 1 && one[0].ts === 0 && one[0].te === 1, 'N=1＝従来の 1 本');
	// 米加国境の型：1° の辺・z15 相当の近傍窓（±0.03°）＝窓内は 1 セル刻み・外は 1/8 密度で N=64 に収まる
	const usca = segsOf([-0.4, 0.0], [0.6, 0.0], SUB_MAX, [0.03, 0.03], cell), u0 = usca[0];
	const inWin = usca.filter(sg => sg.ts >= u0.t0 - 1e-9 && sg.te <= u0.t1 + 1e-9);
	const maxCells = Math.max(...inWin.map(sg => (sg.te - sg.ts) * 768));
	ok(usca.length <= SUB_MAX && inWin.length >= 40 && maxCells <= 2.01, `1° 辺×近傍窓 [${u0.t0},${u0.t1}]：窓内 ${inWin.length} 区間（最大 ${maxCells.toFixed(1)} セル）・全 ${usca.length} 区間`);
}

if (fails) { console.error(`✗ ${fails} 件失敗`); process.exit(1); }
console.log('✓ gint-drape 全項目 PASS');
