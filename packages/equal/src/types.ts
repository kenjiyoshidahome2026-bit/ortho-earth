// equal の部品が共有する型（TS 化 段 3・2026-10）＝型だけ（実行時の中身は無い）。
// レンダラ（renderer.ts＝WebGL2・renderer-gpu.ts＝WebGPU）は同じ API＝ここの Renderer を両方が満たす。
import type { Nation } from "@ortho-earth/core/worldcontent";
import type { Geometry } from "geopbf";

/** カメラ＝{ lon=中央経線=画面中心の経度, lat=画面中心の緯度, zoom }（equalearth.ts） */
export interface View { lon: number; lat: number; zoom: number }
/** 地物の属性（geopbf の getProperties＝鍵は大小が揺れる＝field()/f() で引く） */
export type Props = Record<string, unknown>;

/** GL の色 [r, g, b, a]（0..1）。PALETTE の配列はテーマ切替で中身だけ書き換わる */
export type Color = number[];
/** styles[cls] = { color, width }（線）／{ color, size }（点）＝renderer の setStyles */
export interface LineStyle { color: Color; width?: number; size?: number }
export interface PointStyle { color: Color; size: number }

/** 変形（球 ⇄ Equal Earth）の 1 フレーム：t 0..1・ppuS＝球の中心の CSS px/単位・lat＝球の中心緯度(rad)・cam＝eye の球面からの距離・dlon＝球の中心経度−地図の中心経度(deg) */
export interface Morph { t: number; ppuS: number; lat: number; cam: number; dlon?: number }
/** 両レンダラが beginFrame で決める共通 uniform の値 */
export interface FrameState {
	lon0: number; ix0: number; yc: number; ppu: number; vp: [number, number]; zoom: number; dpr: number;
	morph: number; ppuS: number; sphLat: number; camS: number; sphDlon: number;
}

/** 標高の等経緯度アトラス（行0=南）＝hypso.ts が焼き、setElevation へ */
export interface ElevAtlas { data: Float32Array; width: number; height: number }
/** 近景 R10 の窓アトラス（bounds＝[x0, y0, spanLon, spanLat]・度） */
export interface NearAtlas extends ElevAtlas { bounds: number[] }
/** 全球ハイプソの色（ortho-core worldpal の resolveWorldPal＝鍵 → [r, g, b]） */
export type WorldPal = Record<string, number[]>;

/** 頂点テクスチャ（レンダラ固有の実体＋折り返し幅 w） */
export interface VertexTexture { readonly w: number }
/** インスタンス配列（レンダラ固有の実体＋件数） */
export interface InstanceBuffer { readonly count: number }

/** Equal Earth の描画 API＝WebGL2（renderer.ts）と WebGPU（renderer-gpu.ts）が同じ口・同じ絵 */
export interface Renderer {
	readonly backend: "webgl2" | "webgpu";
	readonly maxTex: number;
	/** 国 ID（R32F 加算）を作れる機体か。無ければコロプレス／ホバーは成立しない（陸マスクはステンシル） */
	readonly hasFloatId: boolean;
	uploadVertices(xy: Uint32Array, count: number): VertexTexture;
	instanceVAO(u32: Uint32Array, comps: number): InstanceBuffer;
	freeVAO(v: InstanceBuffer | null | undefined): void;
	beginFrame(view: View, clearRGB: ArrayLike<number>, morph?: Morph | null): void;
	drawSea(sea: Color, bg: Color, edge: Color): void;
	drawLines(vtx: VertexTexture, vao: InstanceBuffer | null | undefined, styles: LineStyle[]): void;
	drawFill(vtx: VertexTexture, vao: InstanceBuffer | null | undefined, color: Color): void;
	drawVeil(color: Color): void;
	drawIds(vtx: VertexTexture, vao: InstanceBuffer | null | undefined): boolean;
	drawLand(o: { land: Color; hypso?: number; pal: WorldPal }): void;
	drawChoropleth(o?: { alpha?: number; hover?: number; hoverColor?: Color }): void;
	drawPoints(vao: InstanceBuffer | null | undefined, styles: LineStyle[]): void;
	/** 画面 CSS px（左上原点）の国 → fid | -1。WebGPU は Promise（読み戻しは非同期） */
	readFid(cssX: number, cssY: number): number | Promise<number>;
	setElevation(f32: Float32Array, w: number, h: number): void;
	setNearElevation(atlas: NearAtlas | null): void;
	setClimate(img: HTMLImageElement): void;
	/** rgba8 = Uint8Array(count*4)（0..255・a=0 は塗らない） */
	setPaint(rgba8: Uint8Array, count: number): void;
	flush(): void;
	destroy(): void;
}

/** コロプレスの主題（nations.ts PRESETS・csvjoin.ts csvPreset）。value(nation, index, year) → 数値 | 文字列 | null */
export interface Preset {
	label: string;
	type: "quantile" | "equal" | "diverging" | "categorical" | "political";
	scale?: "log";
	ramp?: string | string[];
	classes?: number;
	unit?: string;
	ref?: string;
	member?: string;
	/** ドロップした CSV の主題（URL には残らない） */
	csv?: boolean;
	column?: number;
	value?: (n: Nation, i: number, year?: number | null) => unknown;
	/** 吹き出しに添える年（year 指定＝その年・無ければ最新年） */
	year?: (n: Nation, year: number | null | undefined) => number | null | undefined;
	/** 統計の年の範囲 [lo, hi]（無ければ null） */
	years?: (items: Nation[]) => [number, number] | null;
}

/** ラベル層の 1 項目（labels.ts）。kind: "country" | "capital" | "city" | "airport" */
export interface Label {
	text: string; lon: number; lat: number; size: number; minZoom: number; maxZoom?: number; priority: number; kind: string;
	color: string; halo: string; dot?: number; dotColor?: string; spacing?: string;
	/** 記号だけのラベル（"plane"＝空港の✈） */
	mark?: string;
}
/** ラベルの配色（テーマの labelColor＋capital／airport） */
export interface LabelPal { country: string; city: string; halo: string; capital?: string; airport?: string }
/** 点の地物（都市・空港）＝geopbf から { properties, geometry } で取り出した物 */
export interface PointFeature { properties: Props; geometry: Geometry | null }
