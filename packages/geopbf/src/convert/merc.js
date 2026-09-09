// convert/merc.js ── 固定小数点 Web メルカトル（整数だけ・GPU/CPU で bit 一致）。
//
// 入力は gint 整数（ix=(lon+180)·1e7 / iy=(lat+90)·1e7・符号なし）。出力は世界を [0,2^32) に張った固定小数点
// X32/Y32。ズーム z・extent 2^s のタイル座標は X32 >> (32-z-s)＝シフトだけ＝ズーム毎の再投影が無い。
//
// ・X32 = floor(ix · 2^32 / 360e7)。360e7 は 2^9·7031250 なので double では正確に割れない（ix·2^23 > 2^53）＝
//   CPU は「近似商→厳密剰余で ±1 補正」、GPU は 32 段の復元除算。どちらも数学的に厳密な floor＝一致する。
// ・Y32 = 北半球 [0°,90°] を 2^13 e-7 度（≈0.00082°）刻みの表（値 t と区間傾き dy）で整数線形補間。南半球は対称
//   y(-φ) = 1 - y(φ) で折り返す。極側の限界（85.0511…°）を含む区間は「その緯度でちょうど 0 に達する」傾きを dy に
//   持たせ、飽和減算で 0 に貼り付く＝限界を跨ぐ区間でも補間が壊れない。線形補間の誤差は最大 ≈2.3 単位
//   （2^-32 単位・85° 付近）＝z18/extent4096 でも 0.6 タイル単位未満＝入力精度（1e-6°≈0.11m）より小さい。
//   f32 の log/tan を GPU で回すより精度が高く、しかも決定的。
export const LON_FULL = 3600000000;         // 360e7
export const LAT_FULL = 1800000000;         // 180e7
export const LAT_HALF = 900000000;          // 90e7
export const YT_SHIFT = 13, YT_STEP = 1 << YT_SHIFT, YT_MASK = YT_STEP - 1;
export const YT_LEN = (LAT_HALF >>> YT_SHIFT) + 2;   // 109,864 entries（最終区間の右端 +1）
const MAX_LAT = 85.05112877980659;
const IY_MAX = Math.round(MAX_LAT * 1e7);   // 北限（0° 起点の e-7 単位）

let _table = null;
// Uint32Array(2·YT_LEN): [0,YT_LEN)=値 t[i]（緯度 i·2^13 e-7 度）、[YT_LEN,2·YT_LEN)=区間傾き dy[i]（2^13 e-7 度あたり）
export function mercTable() {
	if (_table) return _table;
	const T = new Uint32Array(YT_LEN * 2);
	for (let i = 0; i < YT_LEN; i++) {
		const lat = (i * YT_STEP) / 1e7;
		if (lat >= MAX_LAT) { T[i] = 0; continue; }
		const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI);
		T[i] = Math.max(0, Math.min(4294967295, Math.round(y * 4294967296)));
	}
	for (let i = 1; i < YT_LEN; i++) if (T[i] > T[i - 1]) T[i] = T[i - 1];   // 単調非増加を固定
	const iStar = IY_MAX >>> YT_SHIFT, fStar = IY_MAX & YT_MASK;
	for (let i = 0; i + 1 < YT_LEN; i++) {
		if (i === iStar && fStar > 0) T[YT_LEN + i] = Math.ceil(T[i] * YT_STEP / fStar);   // 北限でちょうど 0
		else T[YT_LEN + i] = T[i] - T[i + 1];
	}
	return _table = T;
}

// floor(ix · 2^32 / 360e7)。ix ∈ [0, 360e7]。ix=360e7（東経180°）は 2^32 に溢れるので 2^32-1 へ寄せる。
export function lonToX32(ix) {
	if (ix >= LON_FULL) return 4294967295;
	const D = 7031250;                                   // 360e7 = 2^9 · D  →  ix·2^32/360e7 = ix·2^23/D
	let q = Math.floor(ix * 8388608 / D);                // 近似（ix·2^23 が 2^53 を超え得る＝±1 ずれ得る）
	// 厳密剰余 r = ix·2^23 − q·D を 2^53 未満の部分積で組む（ql·D<2^48・qh·D<2^48・差は厳密）
	const qh = Math.floor(q / 65536), ql = q - qh * 65536;
	const A = ix * 128 - qh * D;                          // 2^23 = 2^16 · 2^7
	let r = A * 65536 - ql * D;
	while (r < 0) { q--; r += D; }
	while (r >= D) { q++; r -= D; }
	return q;
}

export function latToY32(iy, T = mercTable()) {
	const south = iy < LAT_HALF;
	let v = south ? LAT_HALF - iy : iy - LAT_HALF;   // 赤道からの距離（e-7 度）
	if (v > LAT_HALF) v = LAT_HALF;
	const i = v >>> YT_SHIFT, f = v & YT_MASK;
	const y0 = T[i], d = Math.floor(T[YT_LEN + i] * f / YT_STEP);
	const yN = y0 - Math.min(y0, d);
	if (!south) return yN >>> 0;
	return yN === 0 ? 4294967295 : (4294967296 - yN);
}

// WGSL 側の同じ関数（カーネルの先頭に連結して使う）
export const MERC_WGSL = /* wgsl */`
fn lonToX32(ix: u32) -> u32 {
	if (ix >= 3600000000u) { return 0xFFFFFFFFu; }
	var rem = ix; var q = 0u;
	for (var i = 0u; i < 32u; i++) {
		let carry = rem >> 31u;
		rem = rem << 1u; q = q << 1u;
		if (carry == 1u || rem >= 3600000000u) { rem = rem - 3600000000u; q = q | 1u; }
	}
	return q;
}
fn latToY32(iy: u32) -> u32 {
	let south = iy < 900000000u;
	var v = select(iy - 900000000u, 900000000u - iy, south);
	v = min(v, 900000000u);
	let i = v >> ${YT_SHIFT}u; let f = v & ${YT_MASK}u;
	let y0 = ytab[i]; let d = (ytab[${YT_LEN}u + i] * f) >> ${YT_SHIFT}u;
	let yN = y0 - min(y0, d);
	if (!south) { return yN; }
	return select(0u - yN, 0xFFFFFFFFu, yN == 0u);
}
fn compact16(m0: u32) -> u32 {
	var m = m0 & 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}
`;

// JS 側の Morton 展開（ortho-core normalizeRingOrientation と同式）
export function compact16(m) {
	m &= 0x55555555;
	m = (m | (m >>> 1)) & 0x33333333;
	m = (m | (m >>> 2)) & 0x0F0F0F0F;
	m = (m | (m >>> 4)) & 0x00FF00FF;
	m = (m | (m >>> 8)) & 0x0000FFFF;
	return m;
}
// gint u64（lo,hi）→ [ix, iy, rank]。L2 は下位 6bit が rank＝座標側ではマスク。
export function decodeGint(lo, hi, out) {
	const l1 = (hi & 0x80000000) !== 0;
	const loC = l1 ? lo : (lo & 0xFFFFFFC0), hiC = hi & 0x7FFFFFFF;
	out[0] = ((compact16(hiC) << 16) | compact16(loC)) >>> 0;
	out[1] = ((compact16(hiC >>> 1) << 16) | compact16(loC >>> 1)) >>> 0;
	out[2] = l1 ? 63 : (lo & 0x3F);
	return out;
}
