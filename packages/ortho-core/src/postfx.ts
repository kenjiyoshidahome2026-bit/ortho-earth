// 後処理の設定の正規化（deck.gl 差分 PR-8・計画 段 D・2026-10-12／第 3 波 W1 で fxaa・tonemap・lut を足す）＝main（map.setPostProcess／setPostChain）・GL2（gl/depthout.js）・WebGPU（gpu/postfx.js）が同じ既定を見る。
// 入力：{ bloom?: true | { threshold, strength, radius }, vignette?: true | { strength, radius, softness }, fxaa?: true | { enabled }, tonemap?: true | { mode, exposure }, lut?: { url, size, intensity } } | null
//   bloom.threshold＝これより明るい画素だけが滲む（輝度 0〜1・既定 0.75）・strength＝足す量（既定 0.5）・radius＝ぼかしの半径の倍率（半解像度の texel・既定 1）
//   vignette.strength＝四隅の暗さ（0〜1・既定 0.5）・radius＝暗くなり始める距離（中心 0〜角 1・既定 0.8）・softness＝移り変わりの幅（既定 0.5）
//   fxaa＝FXAA 3.11 の簡約版（本体の色の縁を均す・true/false）
//   tonemap.mode＝linear | reinhard | aces | agx | filmic（既定 aces）・exposure＝露出の倍率（0〜16・既定 1）。本体の色は LDR（表示用の 8bit）＝ここでの tone mapping は「見え方（look）」の調整
//   lut.url＝3D LUT（.cube の文章か、横に size 枚の板を並べた size²×size の画像＝x に R と B の板・y に G）・size＝板の一辺（16/32/64・既定 32・.cube は中の LUT_3D_SIZE が勝つ）・intensity＝混ぜる量（0〜1・既定 1）
// 掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette（鎖の順番は保つが描く順はこれ）
// 戻り＝null（全部 off）か { bloom: {...}|null, vignette: {...}|null, fxaa?: true, tonemap?: {...}, lut?: {...} }（fxaa/tonemap/lut の鍵は on の時だけ生える＝従来の { bloom, vignette } の形を壊さない）。数値は有限に・範囲に畳む
export type TonemapMode = "linear" | "reinhard" | "aces" | "agx" | "filmic";
export interface BloomOptions { threshold?: number; strength?: number; radius?: number }
export interface VignetteOptions { strength?: number; radius?: number; softness?: number }
export interface FxaaOptions { enabled?: boolean }
export interface TonemapOptions { mode?: TonemapMode; exposure?: number }
/** url＝.cube の文章か size²×size の板画像。 */
export interface LutOptions { url: string; size?: number; intensity?: number }
export interface PostProcessOptions {
	bloom?: true | BloomOptions;
	vignette?: true | VignetteOptions;
	fxaa?: boolean | FxaaOptions;
	tonemap?: true | TonemapOptions;
	lut?: LutOptions | null;
	/** 画面の段（Cesium の postProcessStages 相当・2026-10-28）＝固定の鎖の後に並び順どおり 1 段ずつ掛ける。 */
	stages?: PostStage[] | null;
}
/** 画面の段（固定の鎖＝fxaa→bloom→tonemap→lut→vignette の後に、並び順どおり 1 段ずつ掛ける・Cesium の postProcessStages 相当・2026-10-28）
 *  silhouette＝深度の縁取り（Cesium の EdgeDetection＋Silhouette：length＝縁と見る深度差の閾値・color＝縁の色 rgba 0..1）／grey＝白黒（gradations 段）／brightness＝明るさ（value＝0 で黒・1 で素）／
 *  nightVision＝暗視（緑＋雑音）／lensFlare・depthOfField（下）／glsl＝利用者の GLSL ES 3.00 の fragment（Cesium の PostProcessStage の書き方＝colorTexture・depthTexture・v_textureCoordinates・out_FragColor・czm_* の一部）＝GL2 だけ（WebGPU は飛ばす）。uniforms＝名前 → 数か数の並び（2〜4＝vec）か真偽 */
export type PostStage =
	| { type: "silhouette"; color: number[]; length: number }
	| { type: "grey"; gradations: number }
	| { type: "brightness"; value: number }
	| { type: "nightVision" }
	| { type: "glsl"; src: string; uniforms: Record<string, number | number[] | boolean> }
	| LensFlareStage | DepthOfFieldStage;
/** レンズフレア（Cesium の PostProcessStageLibrary.createLensFlareStage と同式・2026-10-28）。sun＝太陽の画面位置（NDC x,y）・earth＝地球の中心の NDC（x,y）と、
 *  目の座標で中心を earthRadius×1.5 だけ横へずらした点の NDC x（isInEarth の尺）・space＝目が宇宙（地心から 6500 km 超）・camrot＝czm_view[0].z＋czm_view[1].y（星形の回り）・
 *  dirt／star＝レンズの汚れ・星形の画像の URL（無ければ汚れ無し・星形無し）。太陽が画面外（|NDC|＞1.1）か宇宙でない時は素の色（Cesium と同じ） */
export type LensFlareStage = { type: "lensFlare"; intensity: number; distortion: number; ghostDispersal: number; haloWidth: number; dirtAmount: number; sun: number[]; earth: number[]; space: boolean; camrot: number; dirt?: string; star?: string };
/** 被写界深度（Cesium の createDepthOfFieldStage と同式）：Gaussian の 2 段のぼかし（delta・sigma・stepSize px）と、目からの奥行きで素とぼかしを混ぜる（focalDistance m・near／far＝Cesium の frustum）。
 *  earth＝地球の中心の目の座標と半径 [x,y,z,R]・tan＝画角の半分の tan [x,y]：深度の無い画素（地面を深度に書かない描き方）は、目の光線が球に当たる奥行きで見る */
export type DepthOfFieldStage = { type: "depthOfField"; focalDistance: number; delta: number; sigma: number; stepSize: number; near: number; far: number; earth?: number[]; tan?: number[] };
/** 正規化の戻り。fxaa/tonemap/lut の鍵は on の時だけ生える（従来の { bloom, vignette } の形を壊さない）。 */
export interface PostProcessNormalized {
	bloom: { threshold: number; strength: number; radius: number } | null;
	vignette: { strength: number; radius: number; softness: number } | null;
	fxaa?: true;
	tonemap?: { mode: TonemapMode; exposure: number };
	lut?: { url: string; size: number; intensity: number };
	/** 画面の段（並び順・正規化済み）＝有る時だけ生える */
	stages?: PostStage[];
}
const num = (v: unknown, d: number, lo: number, hi: number): number => { const x = typeof v === "number" && Number.isFinite(v) ? v : d; return Math.min(hi, Math.max(lo, x)); };
/** tonemap.mode の語彙（既定 "aces"）。 */
export const TONEMAP_MODES: readonly TonemapMode[] = Object.freeze(["linear", "reinhard", "aces", "agx", "filmic"]);
/** lut.size の語彙＝[16, 32, 64]（既定 32）。 */
export const LUT_SIZES: readonly number[] = Object.freeze([16, 32, 64]);
/** 設定を正規化する。全部 off なら null。数値は有限に・範囲に畳む（型の外の値も受けて既定へ倒す）。 */
export function normPost(p: PostProcessOptions | null | undefined): PostProcessNormalized | null {
	if (!p || typeof p !== "object") return null;
	const b = p.bloom as BloomOptions | undefined, v = p.vignette as VignetteOptions | undefined, f = p.fxaa, t = p.tonemap as TonemapOptions | true | undefined, l = p.lut;
	const bloom = b ? { threshold: num(b.threshold, 0.75, 0, 1), strength: num(b.strength, 0.5, 0, 4), radius: num(b.radius, 1, 0.25, 4) } : null;
	const vignette = v ? { strength: num(v.strength, 0.5, 0, 1), radius: num(v.radius, 0.8, 0, 1.5), softness: num(v.softness, 0.5, 0.01, 1.5) } : null;
	const fxaa = f === true || (f && typeof f === "object" && f.enabled !== false);
	const tonemap = t && (t === true || typeof t === "object") ? { mode: TONEMAP_MODES.includes((t as TonemapOptions).mode!) ? (t as TonemapOptions).mode! : "aces", exposure: num((t as TonemapOptions).exposure, 1, 0, 16) } : null;
	const lut = l && typeof l === "object" && typeof l.url === "string" && l.url ? { url: l.url, size: LUT_SIZES.includes(+l.size!) ? +l.size! : 32, intensity: num(l.intensity, 1, 0, 1) } : null;
	const stages = normStages(p.stages);
	const bOn = bloom && bloom.strength > 0, vOn = vignette && vignette.strength > 0, lOn = lut && lut.intensity > 0;
	if (!bOn && !vOn && !fxaa && !tonemap && !lOn && !stages.length) return null;
	const out: PostProcessNormalized = { bloom: bOn ? bloom : null, vignette: vOn ? vignette : null };
	if (fxaa) out.fxaa = true;
	if (tonemap) out.tonemap = tonemap;
	if (lOn) out.lut = lut!;
	if (stages.length) out.stages = stages;
	return out;
}
/** 画面の段を正規化する（知らない type・壊れた物は落とす）。1 段ずつ新しい object（uniforms の数は有限に・並びは 1〜4 の数）。 */
export function normStages(list: unknown): PostStage[] {
	if (!Array.isArray(list)) return [];
	const out: PostStage[] = [];
	for (const s of list) {
		const o = s && typeof s === "object" ? s as Record<string, unknown> : null; if (!o) continue;
		switch (o.type) {
			case "silhouette": { const c = Array.isArray(o.color) ? o.color.map(v => num(v, 1, 0, 1)) : [1, 1, 0, 1]; while (c.length < 4) c.push(c.length === 3 ? 1 : 0); out.push({ type: "silhouette", color: c.slice(0, 4), length: num(o.length, 0.25, 0, 10) }); break; }
			case "grey": out.push({ type: "grey", gradations: num(o.gradations, 5, 1, 256) }); break;
			case "brightness": out.push({ type: "brightness", value: num(o.value, 0.5, 0, 4) }); break;
			case "nightVision": out.push({ type: "nightVision" }); break;
			case "glsl": {
				if (typeof o.src !== "string" || !o.src) break;
				const u: Record<string, number | number[] | boolean> = {};
				const src = o.uniforms && typeof o.uniforms === "object" ? o.uniforms as Record<string, unknown> : {};
				for (const k of Object.keys(src)) {
					if (!/^[A-Za-z_]\w*$/.test(k)) continue;
					const v = src[k];
					if (typeof v === "boolean") u[k] = v;
					else if (typeof v === "number") u[k] = Number.isFinite(v) ? v : 0;
					else if (Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every(x => typeof x === "number")) u[k] = v.map(x => Number.isFinite(x) ? x : 0);
				}
				out.push({ type: "glsl", src: o.src, uniforms: u }); break;
			}
			case "lensFlare": {
				const v2 = (a: unknown, n: number): number[] => { const r = Array.isArray(a) ? a.slice(0, n).map(x => num(x, 0, -1e6, 1e6)) : []; while (r.length < n) r.push(0); return r; };
				const url = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
				const lf: LensFlareStage = { type: "lensFlare", intensity: num(o.intensity, 2, 0, 100), distortion: num(o.distortion, 10, 0, 1000), ghostDispersal: num(o.ghostDispersal, 0.4, 0, 10), haloWidth: num(o.haloWidth, 0.4, 0, 10),
					dirtAmount: num(o.dirtAmount, 0.4, 0, 10), sun: v2(o.sun, 2), earth: v2(o.earth, 3), space: o.space !== false, camrot: num(o.camrot, 0, -100, 100) };
				const d = url(o.dirt), st = url(o.star); if (d) lf.dirt = d; if (st) lf.star = st;
				out.push(lf); break;
			}
			case "depthOfField": {
				const d: DepthOfFieldStage = { type: "depthOfField", focalDistance: num(o.focalDistance, 5, 0, 1e9), delta: num(o.delta, 1, 0, 100), sigma: num(o.sigma, 2, 0.01, 100), stepSize: num(o.stepSize, 1, 0, 100), near: num(o.near, 1, 1e-3, 1e9), far: num(o.far, 5e8, 1, 1e12) };
				if (Array.isArray(o.earth) && o.earth.length === 4) d.earth = o.earth.map(x => num(x, 0, -1e12, 1e12));
				if (Array.isArray(o.tan) && o.tan.length === 2) d.tan = o.tan.map(x => num(x, 1, 1e-6, 1e6));
				out.push(d); break;
			}
		}
	}
	return out;
}
