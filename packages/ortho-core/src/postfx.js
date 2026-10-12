// 後処理（bloom・vignette）の設定の正規化（deck.gl 差分 PR-8・計画 段 D・2026-10-12）＝main（map.setPostProcess）・GL2（gl/depthout.js）・WebGPU（gpu/postfx.js）が同じ既定を見る。
// 入力：{ bloom?: true | { threshold, strength, radius }, vignette?: true | { strength, radius, softness } } | null
//   bloom.threshold＝これより明るい画素だけが滲む（輝度 0〜1・既定 0.75）・strength＝足す量（既定 0.5）・radius＝ぼかしの半径の倍率（半解像度の texel・既定 1）
//   vignette.strength＝四隅の暗さ（0〜1・既定 0.5）・radius＝暗くなり始める距離（中心 0〜角 1・既定 0.8）・softness＝移り変わりの幅（既定 0.5）
// 戻り＝null（両方 off）か { bloom: {...}|null, vignette: {...}|null }。数値は有限に・範囲に畳む
const num = (v, d, lo, hi) => { const x = typeof v === "number" && Number.isFinite(v) ? v : d; return Math.min(hi, Math.max(lo, x)); };
export function normPost(p) {
	if (!p || typeof p !== "object") return null;
	const b = p.bloom, v = p.vignette;
	const bloom = b ? { threshold: num(b.threshold, 0.75, 0, 1), strength: num(b.strength, 0.5, 0, 4), radius: num(b.radius, 1, 0.25, 4) } : null;
	const vignette = v ? { strength: num(v.strength, 0.5, 0, 1), radius: num(v.radius, 0.8, 0, 1.5), softness: num(v.softness, 0.5, 0.01, 1.5) } : null;
	if ((!bloom || bloom.strength === 0) && (!vignette || vignette.strength === 0)) return null;
	return { bloom: bloom && bloom.strength > 0 ? bloom : null, vignette: vignette && vignette.strength > 0 ? vignette : null };
}
