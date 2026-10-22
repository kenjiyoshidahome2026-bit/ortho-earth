// ズーム連続の paint（描画の統合ロードマップ 波 4 の 14＝V-Ph3 の paint 表と S-P1-2 の一本化・(a) 類＝表の行 0・2026-10-22）。
// 基図の色・不透明度・線幅は build.ts が作ったタイルの z で頂点に焼く＝ズームの途中で段になる（MapLibre は毎フレーム今の z で連続）。
// 地物に依らない式（exprDeps の kind が constant／zoom・global／camera／vertex を読まない）だけで決まる性質は層の中で 1 つの値
// ＝描き手が毎フレーム今の z で評価して頂点の値に差し替える（色は不透明度を掛けた RGBA・線幅は半幅）。
// 地物に依る式（data・zoom×data）は従来どおり作ったタイルの z で焼く（実在 14 本の zoom×data は地理院 optimal_bvmap だけ）。
// 線幅は line-gap-width を持つ層では差し替えない（両脇の 2 本のずらしを build.ts が焼いた線幅で決める）。
// 評価の意味は build.ts と同じ（色の式が無ければ #000・不透明度の評価エラーは外来の層で 1・線幅の不正値と 0 以下は 1）。
import { evalExpr, exprDeps } from "./expr.ts";
import { parseRGBA } from "./color.ts";
import type { ExprContext, ExprOrigin } from "./expr.ts";

/** 層の差し替えの式（op と描く列に添える）。o＝式の出自・c／a＝色と不透明度（c を持つ時だけ色を差し替える）・w＝線幅 */
export interface PaintZoom { o: ExprOrigin; c?: unknown; a?: unknown; w?: unknown }

// 地物に依らず、実行時の状態（global-state・カメラ・描く所の値）も読まない
const free = (e: unknown): boolean => {
	if (e == null) return true;
	const d = exprDeps(e);
	return (d.kind === "constant" || d.kind === "zoom") && !d.global && !d.camera && !d.vertex;
};
const zoomy = (e: unknown): boolean => e != null && exprDeps(e).kind === "zoom";

/** 層 → 差し替えの式（無ければ null）。type＝"fill"｜"line"・paint＝層の paint・eo＝式の出自 */
export function layerPaintZoom(type: "fill" | "line", paint: Record<string, unknown> | null | undefined, eo: ExprOrigin): PaintZoom | null {
	const P = paint || {}, cK = type === "fill" ? "fill-color" : "line-color", aK = type === "fill" ? "fill-opacity" : "line-opacity";
	const out: PaintZoom = { o: eo };
	let any = false;
	if ((zoomy(P[cK]) || zoomy(P[aK])) && free(P[cK]) && free(P[aK])) {
		out.c = P[cK] ?? "#000";
		if (P[aK] != null) out.a = P[aK];
		any = true;
	}
	if (type === "line" && zoomy(P["line-width"]) && free(P["line-width"]) && P["line-gap-width"] == null) { out.w = P["line-width"]; any = true; }
	return any ? out : null;
}

/** 今の z（外来の style の目盛り）で評価。c＝RGBA（0〜1・不透明度を掛けた値）｜null・hw＝半幅（CSS px）｜null */
export function evalPaintZoom(pz: PaintZoom, zoom: number): { c: number[] | null; hw: number | null } {
	const ctx: ExprContext = { zoom, props: {}, geom: null, vars: {}, origin: pz.o };
	let c: number[] | null = null, hw: number | null = null;
	if (pz.c != null) {
		const k = parseRGBA(evalExpr(pz.c, ctx)), ov = pz.a != null ? evalExpr(pz.a, ctx) : 1;
		const a = k[3] * ((ov === undefined && pz.o ? 1 : ov) as number);
		c = [k[0], k[1], k[2], a > 0 ? Math.min(1, a) : 0];   // NaN・負は 0（build.ts の b255 と同じ）
	}
	if (pz.w != null) {
		const w0 = evalExpr(pz.w, ctx);
		hw = (typeof w0 !== "number" || isNaN(w0) || w0 <= 0 ? 1 : w0) * 0.5;
	}
	return { c, hw };
}
