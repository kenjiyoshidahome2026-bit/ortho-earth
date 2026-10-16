// 後処理の設定の正規化（deck.gl 差分 PR-8・計画 段 D・2026-10-12／第 3 波 W1 で fxaa・tonemap・lut を足す）＝main（map.setPostProcess／setPostChain）・GL2（gl/depthout.js）・WebGPU（gpu/postfx.js）が同じ既定を見る。
// 入力：{ bloom?: true | { threshold, strength, radius }, vignette?: true | { strength, radius, softness }, fxaa?: true | { enabled }, tonemap?: true | { mode, exposure }, lut?: { url, size, intensity } } | null
//   bloom.threshold＝これより明るい画素だけが滲む（輝度 0〜1・既定 0.75）・strength＝足す量（既定 0.5）・radius＝ぼかしの半径の倍率（半解像度の texel・既定 1）
//   vignette.strength＝四隅の暗さ（0〜1・既定 0.5）・radius＝暗くなり始める距離（中心 0〜角 1・既定 0.8）・softness＝移り変わりの幅（既定 0.5）
//   fxaa＝FXAA 3.11 の簡約版（本体の色の縁を均す・true/false）
//   tonemap.mode＝linear | reinhard | aces | agx | filmic（既定 aces）・exposure＝露出の倍率（0〜16・既定 1）。本体の色は LDR（表示用の 8bit）＝ここでの tone mapping は「見え方（look）」の調整
//   lut.url＝3D LUT（.cube の文章か、横に size 枚の板を並べた size²×size の画像＝x に R と B の板・y に G）・size＝板の一辺（16/32/64・既定 32・.cube は中の LUT_3D_SIZE が勝つ）・intensity＝混ぜる量（0〜1・既定 1）
// 掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette（鎖の順番は保つが描く順はこれ）
// 戻り＝null（全部 off）か { bloom: {...}|null, vignette: {...}|null, fxaa?: true, tonemap?: {...}, lut?: {...} }（fxaa/tonemap/lut の鍵は on の時だけ生える＝従来の { bloom, vignette } の形を壊さない）。数値は有限に・範囲に畳む
const num = (v, d, lo, hi) => { const x = typeof v === "number" && Number.isFinite(v) ? v : d; return Math.min(hi, Math.max(lo, x)); };
export const TONEMAP_MODES = Object.freeze(["linear", "reinhard", "aces", "agx", "filmic"]);
export const LUT_SIZES = Object.freeze([16, 32, 64]);
export function normPost(p) {
	if (!p || typeof p !== "object") return null;
	const b = p.bloom, v = p.vignette, f = p.fxaa, t = p.tonemap, l = p.lut;
	const bloom = b ? { threshold: num(b.threshold, 0.75, 0, 1), strength: num(b.strength, 0.5, 0, 4), radius: num(b.radius, 1, 0.25, 4) } : null;
	const vignette = v ? { strength: num(v.strength, 0.5, 0, 1), radius: num(v.radius, 0.8, 0, 1.5), softness: num(v.softness, 0.5, 0.01, 1.5) } : null;
	const fxaa = f === true || (f && typeof f === "object" && f.enabled !== false);
	const tonemap = t && (t === true || typeof t === "object") ? { mode: TONEMAP_MODES.includes(t.mode) ? t.mode : "aces", exposure: num(t.exposure, 1, 0, 16) } : null;
	const lut = l && typeof l === "object" && typeof l.url === "string" && l.url ? { url: l.url, size: LUT_SIZES.includes(+l.size) ? +l.size : 32, intensity: num(l.intensity, 1, 0, 1) } : null;
	const bOn = bloom && bloom.strength > 0, vOn = vignette && vignette.strength > 0, lOn = lut && lut.intensity > 0;
	if (!bOn && !vOn && !fxaa && !tonemap && !lOn) return null;
	const out = { bloom: bOn ? bloom : null, vignette: vOn ? vignette : null };
	if (fxaa) out.fxaa = true;
	if (tonemap) out.tonemap = tonemap;
	if (lOn) out.lut = lut;
	return out;
}
