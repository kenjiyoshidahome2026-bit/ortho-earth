// f32→f16（IEEE half）＝標高アトラス（r16float）へ上げる前の変換（perf plan P1 step 0・2026-09-27）。
// 標高(m)は -500..9000 級＝half で ±0.25〜2m 精度（GL の R16F と同じ土俵）。
// 速い道＝Float16Array（ES2025・2025 のモダンブラウザで揃った）：native の一括変換＝JS のビット演算ループ（1024² で 3〜4ms）が消える。
// 無い環境は JS ループ（IEEE の最近接偶数丸め・Inf/NaN→0・巨大→最大有限・subnormal 域は 0 へフラッシュ）。
// 丸め＝native と同じ roundTiesToEven（GL の texImage2D のドライバ変換も同じ）。旧ループ（〜2026-09-27）は「半 ULP 足して切り捨て」＝タイを上へ丸めていた
// ＝3377m が 3378 に（native は 3376）。タイの時だけ 1 ULP の差＝標高では 2m 級・実害なしだが、両経路を bit 一致にする（門＝tests/elevation-resample.mjs）。
// native との残る差＝Inf/NaN が Inf/NaN のまま・subnormal（6e-5m 未満）を保つ＝標高の入力は Int16 由来で有限＝実害なし。
// 変換済み（Uint16Array）はそのまま通す＝呼び手が半精度で作って渡す道を残す。
const HAS_F16 = typeof Float16Array !== "undefined";
export function f32ToF16(src) {
	if (src instanceof Uint16Array) return src;
	if (HAS_F16) return new Uint16Array(new Float16Array(src).buffer);
	return f32ToF16Loop(src);
}
// JS のループ（native が無い環境の本番経路・検定は native と両方を参照と突き合わせる）
export function f32ToF16Loop(src) {
	const n = src.length, out = new Uint16Array(n);
	const u = new Uint32Array(src.buffer, src.byteOffset, n);
	for (let i = 0; i < n; i++) {
		const x = u[i], s = (x >>> 16) & 0x8000;
		let e = (x >>> 23) & 0xff, m = x & 0x7fffff;
		if (e === 0xff) { out[i] = s; continue; }
		if (e < 113) { out[i] = s; continue; }
		const rem = m & 0x1fff; m >>= 13;                   // 捨てる 13 bit＝丸めの余り
		if (rem > 0x1000 || (rem === 0x1000 && (m & 1))) { m++; if (m === 0x400) { m = 0; e++; } }   // 最近接・タイは偶数へ（IEEE roundTiesToEven）
		out[i] = e > 142 ? (s | 0x7bff) : (s | ((e - 112) << 10) | m);
	}
	return out;
}

// f16→f32（1 値）＝検定の読み戻し（readElevCell）用。subnormal・Inf・NaN も IEEE どおり
export function f16ToF32(h) {
	const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}
