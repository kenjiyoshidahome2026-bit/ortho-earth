// 3D Tiles のスタイル（地物ごとの color・show・2026-10-16）を評価する純関数（DOM なし＝node の検定 tests/tiles3d-style.mjs が読む）。
//   式＝MapLibre の式（core の evalExpr）。["get", 名] が引く属性＝tileset ＜ group ＜ tile ＜ content の metadata ＜ 地物の属性（後ろほど強い）・
//   ["id"]＝地物の番号・["feature-state", 名]＝setFeatureState の状態。color の結果＝CSS 色か [r,g,b(,a)]（0..1）・show の結果＝真偽。
//   描きは頂点色の書き換え（feature state と同じ "meshCol"）＝show:false は α 0（tiles3d が OPAQUE の束を MASK に切り替えて抜く）。
import { evalExpr, parseRGBA, isColor, truthy } from "@ortho-earth/core";
import { NO_FEATURE } from "./mesh-features.ts";

/** スタイル（MapLibre の式）。Cesium の 3D Tiles Styling（文字列の式・conditions・defines）は tiles3d-cesium-style.ts が訳してから来る */
export interface StyleSpec { color?: unknown; show?: unknown; /** 式の意味："ml"（既定・MapLibre どおり型に厳しい）｜"native"（寛容・Cesium の式を訳した物） */ origin?: "ml" | "native" }
/** 評価の入口（props＝重ねた属性・id＝地物の番号・state＝feature state） */
export interface StyleInput { props: Record<string, unknown>; id: number | null; state: Record<string, unknown> | null }
/** 組んだスタイル＝color は [r,g,b,a]（0..255）か null（元の色のまま）・show は真偽 */
export interface CompiledStyle { color: ((x: StyleInput) => number[] | null) | null; show: ((x: StyleInput) => boolean) | null }

/** スタイルを組む（無ければ null）。式の誤りは評価の時に null（元の色・表示のまま）＝1 回だけ警告 */
export function compileStyle(s: StyleSpec | null | undefined): CompiledStyle | null {
	if (!s || (s.color == null && s.show == null)) return null;
	let warned = false;
	const origin = s.origin ?? "ml", ctxOf = (x: StyleInput) => ({ props: x.props, id: x.id, state: x.state, origin });
	const safe = <T>(f: () => T, dflt: T): T => { try { return f(); } catch (e) { if (!warned) { warned = true; console.warn("[tiles3d] style", (e as Error)?.message || e); } return dflt; } };
	const color = s.color == null ? null : (x: StyleInput) => safe(() => {
		const v = evalExpr(s.color, ctxOf(x));
		if (v == null || !isColor(v)) return null;   // 色に読めない結果＝元の色のまま
		const c = parseRGBA(v);
		return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), Math.round((c[3] ?? 1) * 255)];
	}, null as number[] | null);
	const show = s.show == null ? null : (x: StyleInput) => safe(() => { const v = evalExpr(s.show, ctxOf(x)); return v == null || truthy(v); }, true);   // 値が無い＝見せる（Cesium の既定と同じ）
	return { color, show };
}

/** 束の頂点色を塗り直す。rgbaOf(地物の番号｜null, 表の番号｜null) → [r,g,b,a]（0..255・NaN＝その成分は元のまま）か null（全部元のまま）。
 *  ids＝頂点ごとの地物の番号（無ければ束で 1 つ＝null で 1 回）・tableAt＝頂点の property table の番号 */
export function paintBatch(col0: Uint8Array, ids: ArrayLike<number> | null | undefined, tableAt: (i: number) => number | null, rgbaOf: (id: number | null, table: number | null) => ArrayLike<number> | null): Uint8Array {
	const out = new Uint8Array(col0), n = col0.length >> 2;
	if (!ids) { const c = rgbaOf(null, null); if (c) for (let i = 0; i < n; i++) put(out, i, c); return out; }
	let lastId = -2, lastT: number | null = -2, lastC: ArrayLike<number> | null = null;
	for (let i = 0; i < n; i++) {
		const raw = ids[i], id = raw === NO_FEATURE ? null : raw, t = id == null ? null : tableAt(i);
		if (raw !== lastId || t !== lastT) { lastId = raw; lastT = t; lastC = rgbaOf(id, t); }
		if (lastC) put(out, i, lastC);
	}
	return out;
}
const put = (o: Uint8Array, i: number, c: ArrayLike<number>) => { if (!Number.isNaN(c[0])) { o[i * 4] = c[0]; o[i * 4 + 1] = c[1]; o[i * 4 + 2] = c[2]; } if (c.length > 3 && c[3] != null && !Number.isNaN(c[3])) o[i * 4 + 3] = c[3]; };
