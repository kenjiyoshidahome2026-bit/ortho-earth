// ズーム連続の paint（描画の統合ロードマップ 波 4 の 14＝V-Ph3 の paint 表と S-P1-2 の一本化・(a) 類＝表の行 0・2026-10-22）。
// 基図の色・不透明度・線幅は build.ts が作ったタイルの z で頂点に焼く＝ズームの途中で段になる（MapLibre は毎フレーム今の z で連続）。
// 地物に依らない式（exprDeps の kind が constant／zoom・global／camera／vertex を読まない）だけで決まる性質は層の中で 1 つの値
// ＝描き手が毎フレーム今の z で評価して頂点の値に差し替える（色は不透明度を掛けた RGBA・線幅は半幅）。
// 地物に依る式（data・zoom×data）は従来どおり作ったタイルの z で焼く（実在 14 本の zoom×data は地理院 optimal_bvmap だけ）。
// 線幅は line-gap-width を持つ層では差し替えない（両脇の 2 本のずらしを build.ts が焼いた線幅で決める）。
// 評価の意味は build.ts と同じ（色の式が無ければ #000・不透明度の評価エラーは外来の層で 1・線幅の不正値と 0 以下は 1・ずらしの不正値は 0）。
// line-offset（波 4 の 14 の続き・2026-10-22）：地物に依らないずらし（定数も）は層で 1 つの値＝描き手が今の z の px を uniform で置く。
// 頂点（GL2 の線分プールの語 6）が空く＝ずらす層もシェーダの破線（S-P1-3）で描ける（語 6＝距離・語 7＝角の継ぎの tS/tE）。
// 定数のずらしも持つ（破線の口を空けるため・0 は build.ts がずらさない層に倒す）。line-gap-width を持つ層は両脇の 2 本のずらしを線幅から焼く＝持たない
import { evalExpr, exprDeps } from "./expr.ts";
import { parseRGBA } from "./color.ts";
import type { ExprContext, ExprOrigin } from "./expr.ts";

/** 層の差し替えの式（op と描く列に添える）。o＝式の出自・c／a＝色と不透明度（c を持つ時だけ色を差し替える）・w＝線幅・of＝line-offset */
export interface PaintZoom { o: ExprOrigin; c?: unknown; a?: unknown; w?: unknown; of?: unknown }

// 地物に依らず、実行時の状態（global-state・カメラ・描く所の値）も読まない
const free = (e: unknown): boolean => {
	if (e == null) return true;
	const d = exprDeps(e);
	return (d.kind === "constant" || d.kind === "zoom") && !d.global && !d.camera && !d.vertex;
};
const zoomy = (e: unknown): boolean => e != null && exprDeps(e).kind === "zoom";

/** 層 → 差し替えの式（無ければ null）。type＝"fill"｜"line"・paint＝層の paint・eo＝式の出自。
 *  all＝定数の色・線幅も持つ（setPaintProperty の速い道＝build.ts の paintFast・作ったタイルの焼いた値を上書きする） */
export function layerPaintZoom(type: "fill" | "line", paint: Record<string, unknown> | null | undefined, eo: ExprOrigin, all = false): PaintZoom | null {
	const P = paint || {}, cK = type === "fill" ? "fill-color" : "line-color", aK = type === "fill" ? "fill-opacity" : "line-opacity";
	const out: PaintZoom = { o: eo };
	let any = false;
	if ((all || zoomy(P[cK]) || zoomy(P[aK])) && free(P[cK]) && free(P[aK])) {
		out.c = P[cK] ?? "#000";
		if (P[aK] != null) out.a = P[aK];
		any = true;
	}
	if (type === "line" && P["line-width"] != null && (all || zoomy(P["line-width"])) && free(P["line-width"]) && P["line-gap-width"] == null) { out.w = P["line-width"]; any = true; }
	if (type === "line" && P["line-offset"] != null && P["line-offset"] !== 0 && free(P["line-offset"]) && P["line-gap-width"] == null) { out.of = P["line-offset"]; any = true; }
	return any ? out : null;
}

/** 今の z（外来の style の目盛り）で評価。c＝RGBA（0〜1・不透明度を掛けた値）｜null・hw＝半幅（CSS px）｜null・off＝ずらし（CSS px・右が正）｜null */
export function evalPaintZoom(pz: PaintZoom, zoom: number): { c: number[] | null; hw: number | null; off: number | null } {
	const ctx: ExprContext = { zoom, props: {}, geom: null, vars: {}, origin: pz.o };
	let c: number[] | null = null, hw: number | null = null, off: number | null = null;
	if (pz.c != null) {
		const k = parseRGBA(evalExpr(pz.c, ctx)), ov = pz.a != null ? evalExpr(pz.a, ctx) : 1;
		const a = k[3] * ((ov === undefined && pz.o ? 1 : ov) as number);
		c = [k[0], k[1], k[2], a > 0 ? Math.min(1, a) : 0];   // NaN・負は 0（build.ts の b255 と同じ）
	}
	if (pz.w != null) {
		const w0 = evalExpr(pz.w, ctx);
		hw = (typeof w0 !== "number" || isNaN(w0) || w0 <= 0 ? 1 : w0) * 0.5;
	}
	if (pz.of != null) { off = +(evalExpr(pz.of, ctx) as number); if (!isFinite(off)) off = 0; }
	return { c, hw, off };
}
