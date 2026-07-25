// gint v2 描画定義（gint draw spec.md §5-§7.1）── paint/filter 式 → fid スタイル表。
// 式は setPaint 時にここで一度だけ評価し、結果だけを GPU（RGBA32UI テクスチャ）へ渡す＝
// 描画ループに式評価は存在しない（仕様 §6-1）。式サブセットの評価器は expr.js＝MVT 基図と
// 同一のプリコンパイル評価器を共用（get/match/step/interpolate/case/比較/zoom …）。
// GL 非依存＝main thread で評価し、Uint32Array を worker / embedded layer へ transfer する。
//
// レコード（1 texel / fid・仕様 §7.1）:
//   R = fill 色 RGBA8（r<<24|g<<16|b<<8|a）
//   G = line/circle 色 RGBA8
//   B = line-width u8(1/8px) <<24 | dash-id u8 <<16 | circle-radius u8(1/4px) <<8 | flags u8
//   A = 予備（0）
//   flags bit0 = visible（filter の実体）
// width はスタイル正味のみ（pick マージン等のパス増分は uniform 側＝仕様 §7.1）。

import { evalExpr, truthy } from "../../expr.js";
import { parseRGBA } from "../../color.js";

// 色になり得る式の評価 → [r,g,b,a] (0..1)。
// expr.js の interpolate は数値 lerp（色文字列を混ぜると NaN）なので、色停留の interpolate
// だけここで RGBA lerp する。match/step/case は選択枝の色文字列がそのまま返る＝parseRGBA で足りる。
// 制約（初期版）：match/step/case の「枝の中」に interpolate を入れ子にする形は非対応（§6）。
function evalColor(e, ctx) {
	if (Array.isArray(e) && e[0] === "interpolate") {
		const type = e[1], input = +evalExpr(e[2], ctx);
		const n = (e.length - 3) >> 1;
		if (!(n > 0) || !Number.isFinite(input)) return [0, 0, 0, 0];
		const stopIn = i => e[3 + i * 2];
		const stopOut = i => evalColor(e[4 + i * 2], ctx);
		if (input <= stopIn(0)) return stopOut(0);
		if (input >= stopIn(n - 1)) return stopOut(n - 1);
		let k = 0;
		while (k < n - 1 && stopIn(k + 1) <= input) k++;
		const x0 = stopIn(k), x1 = stopIn(k + 1);
		let t = (input - x0) / (x1 - x0);
		if (type?.[0] === "exponential" && type[1] !== 1) t = (Math.pow(type[1], input - x0) - 1) / (Math.pow(type[1], x1 - x0) - 1);
		const c0 = stopOut(k), c1 = stopOut(k + 1);
		if (!c0 || !c1) return null;
		return [c0[0] + t * (c1[0] - c0[0]), c0[1] + t * (c1[1] - c0[1]),
				c0[2] + t * (c1[2] - c0[2]), c0[3] + t * (c1[3] - c0[3])];
	}
	const v = evalExpr(e, ctx);
	return v == null ? null : parseRGBA(v);   // 未知op/欠損プロパティ＝undefined → null＝呼び側が既定値維持（§6-4）
}

// [r,g,b,a](0..1) × opacity → RGBA8 パック u32。
function packColor(c, opacity) {
	const a = Math.round(Math.max(0, Math.min(1, (c[3] ?? 1) * opacity)) * 255);
	if (a === 0) return 0;
	const r = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
	const g = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
	const b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
	return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

const clampU8 = v => Math.max(0, Math.min(255, Math.round(v)));

// paint/filter → fid スタイル表。
//   paint:    { 'fill-color', 'fill-opacity', 'line-color', 'line-opacity', 'line-width',
//               'circle-color', 'circle-radius' }（各値＝リテラル or §6 サブセット式）
//   features: FeatureCollection.features（fid = 配列 index。geopbf の .geojson と同一順序）
//   opts:     { filter, zoom }  zoom＝['zoom'] を含む式の評価スナップショット（既定 0）。
//             zoom×data-driven の毎フレーム追随は初期版非対応＝再評価（本関数の呼び直し）が逃げ道（§6-3）。
// 戻り値 { u32: Uint32Array(count*4), count }。評価エラーはその feature を既定値へ（throw しない・§6-4）。
export function buildFidStyle(paint = {}, features = [], opts = {}) {
	const zoom = opts.zoom ?? 0;
	const filter = opts.filter ?? null;
	const count = features.length;
	const u32 = new Uint32Array(count * 4);
	const pFillC = paint["fill-color"], pFillO = paint["fill-opacity"];
	const pLineC = paint["line-color"] ?? paint["circle-color"], pLineO = paint["line-opacity"];
	const pWidth = paint["line-width"], pRadius = paint["circle-radius"];
	for (let fid = 0; fid < count; fid++) {
		const f = features[fid];
		const ctx = { zoom, props: f?.properties ?? {}, geom: f?.geometry?.type ?? "", vars: {} };
		let fill = 0, line = 0, w8 = 8, r8 = 6, flags = 1;   // 既定: width 1px, radius 1.5px, visible
		try {
			if (filter && !truthy(evalExpr(filter, ctx))) flags = 0;
			const num = (e, dflt) => { const v = +evalExpr(e, ctx); return Number.isFinite(v) ? v : dflt; };
			if (pFillC != null) { const c = evalColor(pFillC, ctx); if (c) fill = packColor(c, pFillO != null ? num(pFillO, 1) : 1); }
			if (pLineC != null) { const c = evalColor(pLineC, ctx); if (c) line = packColor(c, pLineO != null ? num(pLineO, 1) : 1); }
			if (pWidth  != null) { const v = +evalExpr(pWidth, ctx);  if (Number.isFinite(v)) w8 = clampU8(v * 8); }
			if (pRadius != null) { const v = +evalExpr(pRadius, ctx); if (Number.isFinite(v)) r8 = clampU8(v * 4); }
		} catch (e) { /* 既定値のまま（§6-4） */ }
		const j = fid * 4;
		u32[j]     = fill;
		u32[j + 1] = line;
		u32[j + 2] = ((w8 << 24) | (0 << 16) | (r8 << 8) | flags) >>> 0;   // dash-id は初期版 0（solid）
		u32[j + 3] = 0;
	}
	return { u32, count };
}
