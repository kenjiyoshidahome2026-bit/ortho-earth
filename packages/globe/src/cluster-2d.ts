// 点の集約（クラスタ）＝canvas2D のオーバーレイ（レンダーワーカー内で地球と同じフレーム・同じカメラ・MapLibre の cluster 相当・2026-09-21）。
// main（gadgets/aggregate.js）がズームの段ごとに集約済みの丸（経緯度・半径・色・件数の文字）を渡す。ここは今のズームの段を選んで描くだけ。
// 段の選び方＝MapLibre と同じ floor(zoom)（maxLevel より上は最後の段＝ばらした点）。地球の裏側（投影の front<0）は描かない。
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size, api) / destroy()。依存ゼロ。
import type { CameraPose, CameraState, OverlayApi, OverlaySize } from "./types/overlay.ts";
/** 集約済みの丸 1 つ（u＝ばらした点） */
interface Circle { lon: number; lat: number; r: number; fill: string; stroke?: string; sw?: number; text?: string | number; tc?: string; ts?: number; op?: number; u?: boolean }
/** [minzoom, maxzoom) */
type ZoomRange = [number, number];
type ClusterMsg = { type: "clear" } | { type: "levels"; minLevel: number; maxLevel: number; levels: Circle[][]; textLayer?: string | null } | { type: "range"; clusters: ZoomRange; unclustered: ZoomRange };
/** 直近フレームで描いた文字 */
interface PlacedText { layer: string | null; text: string; icon: null; lon: number; lat: number; x: number; y: number; w: number; h: number }

let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null, levels: Circle[][] = [], minLevel = 0, maxLevel = 0, range: { clusters: ZoomRange; unclustered: ZoomRange } = { clusters: [-Infinity, Infinity], unclustered: [-Infinity, Infinity] };
let textLayer: string | null = null, lastPlaced: PlacedText[] = [];   // 件数の文字の層 id・直近フレームで描いた文字＝{ layer, text, lon, lat, x, y, w, h }（公式例の門 段 0＝文字を測る材料）
export function placed(): PlacedText[] { return lastPlaced; }   // range＝層ごとの出しズーム（MapLibre の minzoom 包含・maxzoom 排他）
export function init(canvas: HTMLCanvasElement | OffscreenCanvas): void { ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null; }
// data＝{ type:"levels", minLevel, maxLevel, levels:[[{ lon, lat, r, fill, stroke, sw, text, tc, ts, op }…] …] } | { type:"clear" }
export function message(d: ClusterMsg): void {
	if (d.type === "clear") { levels = []; return; }
	if (d.type === "levels") { levels = d.levels; minLevel = d.minLevel; maxLevel = d.maxLevel; textLayer = d.textLayer ?? null; }
	if (d.type === "range") range = { clusters: d.clusters, unclustered: d.unclustered };
}
export function frame(cam: CameraPose, s: CameraState, { w, h }: OverlaySize, api: OverlayApi | null): boolean {
	if (!ctx) return false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, w, h);
	if (!levels.length || !api) return false;
	const dpr = api.dpr || 1, L = levels[Math.max(0, Math.min(levels.length - 1, Math.floor(cam.zoom || 0) - minLevel))] || [];
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	const W = w / dpr, H = h / dpr;
	ctx.textAlign = "center"; ctx.textBaseline = "middle";
	const placedNow: PlacedText[] = [];
	const z = cam.zoom || 0, inR = (r: ZoomRange) => z >= r[0] && z < r[1], showC = inR(range.clusters), showU = inR(range.unclustered);
	for (const c of L) {
		if (!(c.u ? showU : showC)) continue;
		const [x, y, f] = api.project(c.lon, c.lat);
		if (f < 0 || x < -c.r || y < -c.r || x > W + c.r || y > H + c.r) continue;
		ctx.globalAlpha = c.op ?? 1;
		ctx.beginPath(); ctx.arc(x, y, c.r, 0, Math.PI * 2);
		ctx.fillStyle = c.fill; ctx.fill();
		if (c.sw! > 0) { ctx.lineWidth = c.sw!; ctx.strokeStyle = c.stroke!; ctx.stroke(); }
		if (c.text) { ctx.font = `600 ${c.ts || 12}px "Noto Sans JP",system-ui,sans-serif`; ctx.fillStyle = c.tc || "#222"; ctx.fillText(c.text as string, x, y + 0.5); placedNow.push({ layer: textLayer, text: String(c.text), icon: null, lon: c.lon, lat: c.lat, x, y, w: c.r * 2, h: c.ts || 12 }); }
	}
	ctx.globalAlpha = 1;
	lastPlaced = placedNow;
	return false;
}
export function destroy(): void { ctx = null; levels = []; }
