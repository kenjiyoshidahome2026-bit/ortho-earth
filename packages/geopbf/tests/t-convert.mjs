#!/usr/bin/env node
// t-convert: convert/* の CPU 参照実装と部品の検定（決定的・外部データ不要・GPU 不要）。
//   ① merc: X32 が BigInt の厳密 floor と一致／Y32 の表補間が double 直算と 3 単位以内・単調・極の飽和
//   ② kernels: gint 展開の往復・wkb（double bit）・lod の閾値/重複除去/bbox
//   ③ clip: 半平面クリップ・タイル分割   ④ mvt: 符号化↔復号・環の向き   ⑤ pmtiles: tileId・ディレクトリ往復
import { lonToX32, latToY32, mercTable, decodeGint, LON_FULL, LAT_FULL } from "../src/convert/merc.js";
import { projectCPU, lodCPU, wkbCPU, bboxCPU } from "../src/convert/kernels.js";
import { clipRingHalf, clipLineHalf, splitToTiles } from "../src/convert/clip.js";
import { encodeTile, signedArea2 } from "../src/convert/mvt.js";
import { decodeTile } from "../src/convert/mvt-decode.js";
import { zxyToTileId, tileIdToZxy, serializeDirectory, deserializeDirectory } from "../src/convert/pmtiles.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ---- ① merc ----------------------------------------------------------------------
{
	let bad = 0;
	const xs = [0, 1, 2, 7031249, 7031250, 1800000000, 1800000001, LON_FULL - 1, LON_FULL, 3515625, 2147483647, 2147483648];
	for (let i = 0; i < 300000; i++) xs.push(Math.floor(rnd() * (LON_FULL + 1)));
	for (const ix of xs) { const exact = ix >= LON_FULL ? 4294967295n : (BigInt(ix) << 32n) / 3600000000n; if (BigInt(lonToX32(ix)) !== exact) bad++; }
	ok(bad === 0, `lonToX32 = floor(ix·2^32/360e7) が BigInt と一致（${xs.length} 値）`);
	const T = mercTable(), MAXL = 85.05112877980659;
	let worst = 0, mono = true, prev = Infinity;
	for (let iy = 0; iy <= LAT_FULL; iy += 991) {
		const y = latToY32(iy, T); if (y > prev) mono = false; prev = y;
		const lat = Math.max(-MAXL, Math.min(MAXL, iy / 1e7 - 90));
		const ref = Math.max(0, Math.min(4294967295, (0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI)) * 4294967296));
		worst = Math.max(worst, Math.abs(ref - y));
	}
	ok(worst <= 3, `latToY32 の表補間誤差 ≤ 3 単位（実測 ${worst.toFixed(2)}・2^-32 単位）`);
	ok(mono, "latToY32 は緯度に対して単調非増加");
	ok(latToY32(900000000, T) === 2147483648 && latToY32(LAT_FULL, T) === 0 && latToY32(0, T) === 4294967295, "赤道=2^31・北極=0・南極=2^32-1");
}

// ---- ② kernels ---------------------------------------------------------------------
const spread16 = x => { x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555; return x >>> 0; };
const pack = (ix, iy, rank, l1) => {
	const lo = (spread16(ix & 0xFFFF) | (spread16(iy & 0xFFFF) << 1)) >>> 0, hi = (spread16((ix >>> 16) & 0xFFFF) | (spread16((iy >>> 16) & 0xFFFF) << 1)) >>> 0;
	return l1 ? [lo, (hi | 0x80000000) >>> 0] : [(lo & 0xFFFFFFC0) | (rank & 63), hi & 0x7FFFFFFF];
};
{
	const v = [0, 0, 0];
	let good = true;
	for (let i = 0; i < 20000; i++) {
		const ix = Math.floor(rnd() * LON_FULL), iy = Math.floor(rnd() * LAT_FULL), l1 = rnd() < 0.5, rank = Math.floor(rnd() * 64);
		const [lo, hi] = pack(ix, iy, rank, l1); decodeGint(lo, hi, v);
		const exIx = l1 ? ix : (ix & ~7) >>> 0, exIy = l1 ? iy : (iy & ~7) >>> 0;   // L2 は Morton 下位 6bit=rank → 各座標の下位 3bit が落ちる
		if (v[0] !== exIx || v[1] !== exIy || v[2] !== (l1 ? 63 : rank)) good = false;
	}
	ok(good, "decodeGint: Morton 展開と rank（L1=63・L2=下位 6bit）");
	const iv = Int32Array.from([0, 1, -1, 1000000, -1800000000, 123456789]);
	const w = wkbCPU(iv, 1e6), f = new Float64Array(w.buffer);
	ok(f[0] === 0 && f[1] === 1e-6 && f[2] === -1e-6 && f[3] === 1 && f[4] === -1800 && f[5] === 123.456789, "wkbCPU: i/10^p の double bit（lo,hi LE）");
	// lod: 1 本の arc（端点 L1・中間 rank 5/40）・ズーム 0 と 14
	const pts = [[1000000000, 900000000, 63, 1], [1000000080, 900000000, 5, 0], [1000000160, 900000000, 40, 0], [1000000240, 900000000, 63, 1]];
	const arcU32 = new Uint32Array(8); pts.forEach((p, i) => { const [lo, hi] = pack(...p); arcU32[i * 2] = lo; arcU32[i * 2 + 1] = hi; });
	const { xy, rk } = projectCPU(arcU32);
	ok(rk.join() === "63,5,40,63", "projectCPU: rank 列");
	const arcs = Uint32Array.from([0, 4]), counts = new Uint32Array(2), bbox = new Uint32Array(8);
	lodCPU({ xy, rk, arcs, arcCount: 1, zoomCount: 2, minZoom: 0, extentShift: 12, thresholds: [51, 9], mode: 0, counts, bbox });
	ok(counts[0] === 1 && counts[1] === 1, `lodCPU: 8e-6° 幅の arc は z0/z14 とも量子化で 1 点に潰れる（${counts.join(",")}）`);
	const pts2 = [[1000000000, 900000000, 63, 1], [1000100000, 900000000, 5, 0], [1000200000, 900000000, 40, 0], [1000300000, 900000000, 63, 1]];
	const a2 = new Uint32Array(8); pts2.forEach((p, i) => { const [lo, hi] = pack(...p); a2[i * 2] = lo; a2[i * 2 + 1] = hi; });
	const p2 = projectCPU(a2), c2 = new Uint32Array(3), b2 = new Uint32Array(12);
	lodCPU({ xy: p2.xy, rk: p2.rk, arcs, arcCount: 1, zoomCount: 3, minZoom: 12, extentShift: 12, thresholds: [51, 30, 0], mode: 0, counts: c2, bbox: b2 });
	ok(c2.join() === "2,3,4", `lodCPU: 閾値 51/30/0 で残る頂点 2/3/4（端点は常時）（${c2.join(",")}）`);
	const offs = Uint32Array.from([0, 2, 5]), out = new Uint32Array(18);
	lodCPU({ xy: p2.xy, rk: p2.rk, arcs, arcCount: 1, zoomCount: 3, minZoom: 12, extentShift: 12, thresholds: [51, 30, 0], mode: 1, offsets: offs, out });
	ok(out[0] === (p2.xy[0] >>> 8) && out[2] === (p2.xy[6] >>> 8) && out[6] === (p2.xy[4] >>> 7), "lodCPU: 書き出し位置と座標（z12 は X32>>8）");
	ok(b2[0] === out[0] && b2[2] === out[2], "lodCPU: bbox は残った頂点の min/max");
	const bx = bboxCPU(Int32Array.from([5, -3, 9, 2, -7, 8]), Uint32Array.from([0, 3]));
	ok(bx.join() === "-7,-3,9,8", "bboxCPU");
}

// ---- ③ clip ---------------------------------------------------------------------------
{
	const sq = [0, 0, 10, 0, 10, 10, 0, 10];
	const r = clipRingHalf(sq, 0, 5, true);
	ok(r && Array.from(r).join() === "0,0,5,0,5,10,0,10", `clipRingHalf x≤5: ${r && Array.from(r).join()}`);
	ok(clipRingHalf(sq, 1, 20, false) === null, "clipRingHalf: 全外なら null");
	// 切断線上の共線点の掃除：線上の頂点と交点が連続しても中央は残らない（面積は不変）
	const spur = clipRingHalf([0, 0, 10, 0, 12, 5, 10, 10, 0, 10], 0, 10, true);
	ok(spur && Array.from(spur).join() === "0,0,10,0,10,10,0,10", `clipRingHalf: 切断線上の共線 4 点 → 2 点（${spur && Array.from(spur).join()}）`);
	const wrap = clipRingHalf([10, 2, 12, 4, 10, 6, 12, 8, 10, 10, 0, 10, 0, 0, 10, 0], 0, 10, true);
	ok(wrap && wrap.length === 8 && Math.abs(signedArea2(wrap)) === 200, `clipRingHalf: 継ぎ目をまたぐ往復の棘も消える（${wrap && Array.from(wrap).join()}）`);
	ok(clipRingHalf([10, 0, 10, 10, 12, 10, 12, 0], 0, 10, true) === null, "clipRingHalf: 線上の往復だけの環は消える");
	const ls = clipLineHalf([0, 0, 10, 0, 10, 10, 0, 10], 0, 5, true);
	ok(ls.length === 2 && ls[0].join() === "0,0,5,0" && ls[1].join() === "5,10,0,10", `clipLineHalf: 出入りで 2 本に分割（${JSON.stringify(ls)}）`);
	const got = [];
	splitToTiles([[100, 100, 8000, 100, 8000, 8000, 100, 8000]], 2, [100, 100, 8000, 8000], 2, 4096, 0, (tx, ty, parts) => got.push([tx, ty, parts[0]]));
	ok(got.length === 4, `splitToTiles: 2×2 タイルに 4 片（${got.length}）`);
	ok(got.every(([tx, ty, ring]) => { for (let i = 0; i < ring.length; i += 2) if (ring[i] < tx * 4096 || ring[i] > (tx + 1) * 4096 || ring[i + 1] < ty * 4096 || ring[i + 1] > (ty + 1) * 4096) return false; return true; }), "splitToTiles: 各片はタイル矩形内");
	const got2 = [];
	splitToTiles([1, 1, 4095, 4095, 5000, 5000], 0, [1, 1, 5000, 5000], 2, 4096, 80, (tx, ty, pts) => got2.push([tx, ty, pts.length / 2]));
	ok(got2.length === 4 && got2.find(g => g[0] === 0 && g[1] === 0)[2] === 2, "splitToTiles: 点はバッファ内の隣接タイルにも入る");
}

// ---- ④ mvt --------------------------------------------------------------------------------
{
	const outer = [0, 0, 0, 100, 100, 100, 100, 0], hole = [20, 20, 80, 20, 80, 80, 20, 80];   // わざと向きを崩す
	const tile = encodeTile({ name: "L", extent: 4096, features: [
		{ id: 7, type: 3, tags: [["n", "a"], ["v", 2], ["b", true], ["neg", -5], ["f", 1.5]], geometry: [[outer, hole]] },
		{ id: 8, type: 2, tags: [], geometry: [[0, 0, 5, 5, 5, 5, 9, 9]] },
		{ id: 9, type: 1, tags: [["n", "a"]], geometry: [1, 2, 3, 4] },
		{ id: 10, type: 3, tags: [], geometry: [[[0, 0, 1, 1, 2, 2]]] },   // 面積ゼロ＝落ちる
	] });
	const [l] = decodeTile(tile);
	ok(l.name === "L" && l.extent === 4096 && l.features.length === 3, `mvt: レイヤ名/extent/退化 feature の除外（${l.features.length}）`);
	const f = l.features[0];
	ok(f.id === 7 && f.props.n === "a" && f.props.v === 2 && f.props.b === true && f.props.neg === -5 && f.props.f === 1.5, "mvt: id と tags（string/uint/bool/sint/double）");
	ok(signedArea2(f.geometry[0]) > 0 && signedArea2(f.geometry[1]) < 0, "mvt: 外環は面積正・穴は負（MVT 2.1 規則）");
	ok(l.features[1].geometry[0].join() === "0,0,5,5,9,9", "mvt: 線の連続重複除去");
	ok(l.features[2].geometry.length === 2, "mvt: MultiPoint");
}

// ---- ⑤ pmtiles ----------------------------------------------------------------------------
{
	ok([zxyToTileId(0, 0, 0), zxyToTileId(1, 0, 0), zxyToTileId(1, 0, 1), zxyToTileId(1, 1, 1), zxyToTileId(1, 1, 0), zxyToTileId(2, 0, 0)].join() === "0,1,2,3,4,5", "tileId: Hilbert 順の既知値");
	let inv = true;
	for (let i = 0; i < 2000; i++) { const z = Math.floor(rnd() * 15), n = 1 << z, x = Math.floor(rnd() * n), y = Math.floor(rnd() * n); const [z2, x2, y2] = tileIdToZxy(zxyToTileId(z, x, y)); if (z2 !== z || x2 !== x || y2 !== y) inv = false; }
	ok(inv, "tileId ↔ zxy の往復");
	const ents = [{ tileId: 0, offset: 0, length: 10, runLength: 1 }, { tileId: 1, offset: 10, length: 5, runLength: 3 }, { tileId: 9, offset: 0, length: 10, runLength: 1 }, { tileId: 40, offset: 15, length: 7, runLength: 0 }];
	const back = deserializeDirectory(serializeDirectory(ents));
	ok(JSON.stringify(back) === JSON.stringify(ents), "directory: 直列化の往復（連続 offset の 0 符号・runLength 0 の leaf）");
}

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
