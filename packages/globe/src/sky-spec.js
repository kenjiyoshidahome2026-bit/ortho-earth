// style の sky（MapLibre の sky・setSky/getSky・B4 2026-10-12）＝既定の補完と、レンダラへ渡す形（色は 0..1 の rgb・式は今の zoom で評価）。
// 鍵は MapLibre の 7 つ：sky-color・horizon-color・fog-color（色）、fog-ground-blend・horizon-fog-blend・sky-horizon-blend・atmosphere-blend（0..1）。
// 意味は文書どおりに写す（本物の shader の式は未照合）：
//   空＝地平線の horizon-color から天頂の sky-color へ（sky-horizon-blend＝混ざる幅・0＝境でスパッと）。地平線の際は fog-color を horizon-fog-blend の分だけ重ねる。
//   atmosphere-blend＝従来のリム光（大気の霞）を空の上にどれだけ重ねるか。fog-ground-blend＝地面の霧の濃さ（0＝霧なし・0.5＝従来の距離・1＝近くから）。
// 名前の `sky` はエンジンでは星空劇場（opts.sky）が先に使っている＝エンジンの中では mlSky と呼ぶ。
import { parseRGBA, isColor, evalExpr } from "@ortho-earth/core";

export const SKY_DEFAULT = Object.freeze({
	"sky-color": "#88C6FC", "horizon-color": "#ffffff", "fog-color": "#ffffff",
	"fog-ground-blend": 0.5, "horizon-fog-blend": 0.8, "sky-horizon-blend": 0.8, "atmosphere-blend": 0.8,
});
const COLORS = ["sky-color", "horizon-color", "fog-color"], BLENDS = ["fog-ground-blend", "horizon-fog-blend", "sky-horizon-blend", "atmosphere-blend"];
const isExpr = v => Array.isArray(v) && typeof v[0] === "string";

// 入力（部分指定・不正値）→ 既定で補った sky（新しい object・鍵の順は既定どおり）。式（配列）はそのまま持つ。null/undefined → 既定
export function normSky(s) {
	const o = s && typeof s === "object" ? s : {}, r = {};
	for (const k of COLORS) r[k] = typeof o[k] === "string" || isExpr(o[k]) ? o[k] : SKY_DEFAULT[k];
	for (const k of BLENDS) r[k] = isExpr(o[k]) ? o[k] : Number.isFinite(+o[k]) && o[k] !== null && o[k] !== "" ? Math.max(0, Math.min(1, +o[k])) : SKY_DEFAULT[k];
	return r;
}
// 式を含むか（zoom で変わる＝onMove で送り直す）
export function skyHasExpr(s) { return !!s && Object.values(s).some(isExpr); }
const evalAt = (v, zoom) => isExpr(v) ? evalExpr(v, { zoom, props: {}, geom: null, vars: {}, gs: {}, origin: null }) : v;
const rgb = (v, zoom, dflt) => { const s = evalAt(v, zoom), c = parseRGBA(typeof s === "string" && isColor(s) ? s : dflt); return [c[0], c[1], c[2]]; };   // 色でない物（式の答えも）＝既定の色
const num = (v, zoom, dflt) => { const x = +evalAt(v, zoom); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : dflt; };
// renderer へ渡す形：{ sky, horizon, fog:[r,g,b]（0..1）, groundBlend, horizonFogBlend, skyHorizonBlend, atmosphereBlend }
export function skyPayload(s, zoom = 0) {
	const S = normSky(s);
	return {
		sky: rgb(S["sky-color"], zoom, SKY_DEFAULT["sky-color"]), horizon: rgb(S["horizon-color"], zoom, SKY_DEFAULT["horizon-color"]), fog: rgb(S["fog-color"], zoom, SKY_DEFAULT["fog-color"]),
		groundBlend: num(S["fog-ground-blend"], zoom, SKY_DEFAULT["fog-ground-blend"]), horizonFogBlend: num(S["horizon-fog-blend"], zoom, SKY_DEFAULT["horizon-fog-blend"]),
		skyHorizonBlend: num(S["sky-horizon-blend"], zoom, SKY_DEFAULT["sky-horizon-blend"]), atmosphereBlend: num(S["atmosphere-blend"], zoom, SKY_DEFAULT["atmosphere-blend"]),
	};
}
