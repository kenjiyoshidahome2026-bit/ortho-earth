// 画面格子の集約（deck.gl の ScreenGridLayer 相当・差分 PR-5・2026-10-12）＝同一フレームのオーバーレイ（canvas2D・レンダーワーカー内）。
// 点を毎フレーム画面に投影して cellPx の格子に数え、色の段（colorRange）で塗る＝カメラが動けば格子も動く（画面に固定）。
// 契約（map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"data", lon: Float64Array(n), lat: Float64Array(n), w?: Float32Array(n) }／{ type:"style", cellPx, colorRange: [[r,g,b,a], …]（0〜255）, agg:"sum"|"count"|"max", opacity, gap }／{ type:"clear" }／{ type:"probe", id }
// 当たり判定（統一 picking・PR-1）：pick(x, y)＝その画素のセル → { id, index, distance 0, properties:{ count, value, col, row } }（セルが空なら null）
// render worker の組み込み（BUILTIN_OVERLAYS の "screengrid"・create() で実体を作る）。
import type { CameraPose, CameraState, OverlayApi, OverlayHost, OverlaySize } from "../types/overlay.ts";
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** 色の段の 1 つ（0〜255・a は省略可） */
type Rgba = [number, number, number, number?];
interface GridStyle { cellPx: number; colorRange: Rgba[]; agg: "sum" | "count" | "max"; opacity: number; gap: number }
type GridMsg = { type: "probe"; id: unknown } | { type: "data"; lon: Float64Array; lat: Float64Array; w?: Float32Array } | ({ type: "style" } & Partial<GridStyle>) | { type: "clear" };
/** 最後に描いた格子 */
interface Grid { cols: number; rows: number; cell: number; counts: Float64Array; values: Float64Array; max: number; dpr: number }

// 一つのオーバーレイ＝一つの閉包（2026-10-17・旧＝URL ごとに別のモジュール実体＝?ov=）。render worker の BUILTIN_OVERLAYS が create() で作る
export function create() {
	let canvas: HTMLCanvasElement | OffscreenCanvas | null = null, ctx: Ctx2D | null = null, host: OverlayHost | null = null;
	let lon: Float64Array | null = null, lat: Float64Array | null = null, wt: Float32Array | null = null;
	let style: GridStyle = { cellPx: 24, colorRange: [[255, 255, 178, 40], [254, 217, 118, 120], [254, 178, 76, 170], [253, 141, 60, 200], [240, 59, 32, 230], [189, 0, 38, 255]], agg: "sum", opacity: 1, gap: 1 };
	let last: Grid | null = null;   // 最後に描いた格子 { cols, rows, cell, counts, values, max, dpr }
	const probes: unknown[] = [];
	function init(cv: HTMLCanvasElement | OffscreenCanvas, _opts: unknown, h: OverlayHost): void { canvas = cv; host = h; ctx = canvas.getContext("2d") as Ctx2D | null; }
	function message(d: GridMsg): void {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (d.type === "data") { lon = d.lon; lat = d.lat; wt = d.w || null; }
		else if (d.type === "style") style = { ...style, ...d };
		else if (d.type === "clear") { lon = lat = wt = null; }
		host?.requestDraw?.();
	}
	function frame(cam: CameraPose, s: CameraState, { w, h }: OverlaySize, api: OverlayApi): boolean {
		if (!ctx) return false;
		ctx.clearRect(0, 0, w, h);
		const n = lon?.length || 0, dpr = api?.dpr || cam?.dpr || 1, cell = Math.max(2, style.cellPx * dpr);
		const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell), counts = new Float64Array(cols * rows), values = new Float64Array(cols * rows);
		let max = 0;
		for (let i = 0; i < n; i++) {
			const p = api.project(lon![i], lat![i]); if (!p || p[2] <= 0) continue;   // 裏・画面外は数えない
			const x = p[0] * dpr, y = p[1] * dpr; if (x < 0 || y < 0 || x >= w || y >= h) continue;
			const k = Math.floor(y / cell) * cols + Math.floor(x / cell), v = wt ? wt[i] : 1;
			counts[k]++; if (style.agg === "max") values[k] = Math.max(values[k], v); else values[k] += style.agg === "count" ? 1 : v;
		}
		for (let k = 0; k < values.length; k++) if (values[k] > max) max = values[k];
		last = { cols, rows, cell, counts, values, max, dpr };
		if (max > 0) {
			const CR = style.colorRange, gap = style.gap * dpr;
			ctx.globalAlpha = style.opacity;
			for (let k = 0; k < values.length; k++) {
				if (!counts[k]) continue;
				const c = CR[Math.min(CR.length - 1, Math.floor(values[k] / max * CR.length))];
				ctx!.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;
				ctx!.fillRect((k % cols) * cell + gap / 2, Math.floor(k / cols) * cell + gap / 2, cell - gap, cell - gap);
			}
			ctx.globalAlpha = 1;
		}
		if (probes.length) { const ids = probes.splice(0); try { const img = ctx!.getImageData(0, 0, w, h); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: false, data: id === ids[ids.length - 1] ? new Uint8Array(img.data.buffer) : new Uint8Array(img.data) }); } catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as Error)?.message || e) }); } }
		return false;
	}
	function pick(x: number, y: number) {
		if (!last) return null;
		const col = Math.floor(x / last.cell), row = Math.floor(y / last.cell); if (col < 0 || row < 0 || col >= last.cols || row >= last.rows) return null;
		const k = row * last.cols + col; if (!last.counts[k]) return null;
		return { id: k + 1, index: k, distance: 0, lngLat: null, properties: { count: last.counts[k], value: last.values[k], col, row, max: last.max } };
	}
	function destroy(): void { ctx = null; canvas = null; lon = lat = wt = null; last = null; }
	return { init, message, frame, pick, destroy };
}
