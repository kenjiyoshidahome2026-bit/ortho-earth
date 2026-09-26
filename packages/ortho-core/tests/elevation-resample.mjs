// 標高セルの再標本化（elevation.js downsampleFlipped）と f16 変換の門（perf plan P1 step 0・2026-09-27）。
// 守るもの＝「速くしても値は同じ」：①downsampleFlipped は規約の写し（texel 中心 (i+0.5)/N・最外周 M=2 を読まない・異常値 <-420/>9000 は 0・負は 0・row0=南）と
// 全 texel で bit 一致 ②f32→f16 は IEEE half の最近接丸め（Float16Array が使える環境ではそれと一致・無い環境は JS ループ）。
// node tests/elevation-resample.mjs
import { downsampleFlipped, cropResample } from "../src/elevation.js";
import { f32ToF16, f32ToF16Loop } from "../src/gpu/f16.js";

let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log(`${c ? "✓" : "✗"} ${msg}`); };

// 規約の写し（elevation-worldatlas.mjs と同じ原本＝2026-09-27 以前の downsampleFlipped をそのまま）
function reference(tile, N) {
	const { data, width: w, height: h } = tile;
	const out = new Float32Array(N * N);
	const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };
	const M = 2;
	for (let j = 0; j < N; j++) {
		const gy = Math.min(Math.max((j + 0.5) / N * (h - 1), M), h - 1 - M), y0 = Math.min(gy | 0, h - 2), fy = gy - y0;
		for (let i = 0; i < N; i++) {
			const gx = Math.min(Math.max((i + 0.5) / N * (w - 1), M), w - 1 - M), x0 = Math.min(gx | 0, w - 2), fx = gx - x0;
			const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
			const v = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
			out[j * N + i] = v < 0 ? 0 : v;
		}
	}
	return out;
}
// 合成タイル：斜面＋段差＋海（負）＋異常値（-9999・no-data）＋縁の fill 値（最外周に巨大値）
let seed = 20260927; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
function synth(w, h) {
	const data = new Int16Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let v = 800 * Math.sin(x / 37) + 600 * Math.cos(y / 53) + (x > w / 2 ? 900 : 0) + (rnd() - 0.5) * 30;
		if (y < h / 8) v = -300 - rnd() * 3000;                           // 海（負の水深）
		if (rnd() < 0.002) v = -9999;                                      // no-data
		if (x === 0 || y === 0 || x === w - 1 || y === h - 1) v = 32000;   // 縁の fill 値（規約＝読まない）
		data[y * w + x] = Math.max(-32768, Math.min(32767, Math.round(v)));
	}
	return { data, width: w, height: h };
}
for (const [w, h, N] of [[3600, 3600, 1024], [3600, 3600, 512], [1201, 1201, 1024], [2400, 2400, 400], [64, 64, 1024], [16, 9, 8]]) {
	const t = synth(w, h);
	const want = reference(t, N), got = downsampleFlipped(t, N);
	let diff = 0, maxd = 0;
	for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) { diff++; maxd = Math.max(maxd, Math.abs(want[i] - got[i])); }
	ok(got.length === N * N && diff === 0, `downsampleFlipped ${w}x${h}→${N}²：規約の写しと bit 一致（違い ${diff} texel・最大 ${maxd}）`);
}
// cropResample（R10 親タイル→1°セル）＝旧 terrain.js の写しと bit 一致（縁のクランプ・fx/fy の [0,1] クランプ込み）
function referenceCrop(tile, lng0, lat0, span, N) {
	const { data, width: w, height: h, lng: lo, lat: la, range: r } = tile;
	const out = new Float32Array(N * N);
	const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };
	for (let j = 0; j < N; j++) {
		const gy = ((lat0 - la) + span * (j + 0.5) / N) / r * (h - 1);
		const y0 = Math.max(0, Math.min(h - 2, gy | 0)), fy = Math.min(1, Math.max(0, gy - y0));
		for (let i = 0; i < N; i++) {
			const gx = ((lng0 - lo) + span * (i + 0.5) / N) / r * (w - 1);
			const x0 = Math.max(0, Math.min(w - 2, gx | 0)), fx = Math.min(1, Math.max(0, gx - x0));
			const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
			const v = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
			out[j * N + i] = v < 0 ? 0 : v;
		}
	}
	return out;
}
for (const [w, N, cell] of [[2400, 512, [3, 7]], [2400, 1024, [0, 0]], [2400, 1024, [9, 9]], [1200, 400, [4, 2]]]) {   // R10 親（10°・2400²）から 1° セル（左下・右上の縁セル込み）
	const t = { ...synth(w, w), lng: 130, lat: 30, range: 10 };
	const want = referenceCrop(t, 130 + cell[0], 30 + cell[1], 1, N), got = cropResample(t, 130 + cell[0], 30 + cell[1], 1, N);
	let diff = 0; for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) diff++;
	ok(got.length === N * N && diff === 0, `cropResample R10 ${w}²→1°セル(${cell})→${N}²：旧 terrain.js の写しと bit 一致（違い ${diff} texel）`);
}
// f16：IEEE half の最近接偶数丸め（roundTiesToEven＝Float16Array・GL のドライバ変換と同じ）。参照＝ビット演算の素朴な写し。
// Inf/NaN→0・巨大→最大有限（フォールバックの約束）・subnormal 域は 0。旧ループ（〜2026-09-27）はタイを上へ丸めていた（3377→3378）＝ここで両経路を偶数丸めに揃えた
function refHalf(x) {
	if (!Number.isFinite(x)) return 0;
	const f = new Float32Array([x]), u = new Uint32Array(f.buffer)[0], s = (u >>> 16) & 0x8000; let e = (u >>> 23) & 0xff, m = u & 0x7fffff;
	if (e < 113) return s;
	const rem = m & 0x1fff; m >>= 13;
	if (rem > 0x1000 || (rem === 0x1000 && (m & 1))) { m++; if (m === 0x400) { m = 0; e++; } }
	return e > 142 ? (s | 0x7bff) : (s | ((e - 112) << 10) | m);
}
const src = new Float32Array(200000);
for (let i = 0; i < src.length; i++) src[i] = i % 7 === 0 ? -(rnd() * 500) : rnd() * 9000 * (rnd() < 0.5 ? 1 : 0.001);
src[0] = 0; src[1] = 3776; src[2] = 8848.86; src[3] = -420; src[4] = 65504; src[5] = 1e-6;
for (const [name, fn] of [["f32ToF16（既定＝native があれば native）", f32ToF16], ["f32ToF16Loop（JS の写し）", f32ToF16Loop]]) {
	const half = fn(src);
	let bad = 0, firstBad = -1;
	for (let i = 0; i < src.length; i++) {
		const r = refHalf(src[i]), g = half[i];
		// Float16Array（native）は subnormal を保つ・ループは 0 へフラッシュ＝標高で 6e-5m 未満の差＝どちらも「0m」＝許す。それ以外は bit 一致
		if (g !== r && !(r === 0 && Math.abs(src[i]) < 6.2e-5)) { bad++; if (firstBad < 0) firstBad = i; }
	}
	ok(half instanceof Uint16Array && half.length === src.length && bad === 0, `${name}：${src.length} 値が IEEE half 最近接偶数丸めと一致（不一致 ${bad}${firstBad >= 0 ? `・最初 [${firstBad}]=${src[firstBad]}→${half[firstBad]} 期待 ${refHalf(src[firstBad])}` : ""}）・native=${typeof Float16Array !== "undefined"}`);
}
// タイの値（half の刻みのちょうど中間）＝偶数へ：3377（刻み 2）→3376・2049（刻み 2）→2048・4098（刻み 4）→4096（mantissa 偶数）
{ const t = new Float32Array([3377, 2049, 4098, 1025.5]); const n = f32ToF16(t), l = f32ToF16Loop(t); const dec = h => { const e = (h >> 10) & 31, m = h & 1023; return e ? Math.pow(2, e - 15) * (1 + m / 1024) : m * Math.pow(2, -24); };
	ok([...n].map(dec).join() === "3376,2048,4096,1026" && [...l].join() === [...n].join(), `タイは偶数丸め（3377→${dec(n[0])}・2049→${dec(n[1])}・4098→${dec(n[2])}・1025.5→${dec(n[3])}＝1026）・native とループが bit 一致`); }
ok(f32ToF16(new Uint16Array([1, 2, 3])) instanceof Uint16Array, "f32ToF16：Uint16Array（変換済み）はそのまま通す");
console.log(fails ? `FAIL ${fails}` : "PASS");
process.exit(fails ? 1 : 0);
