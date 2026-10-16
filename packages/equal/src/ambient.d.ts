// equal の TS 化（段 3・2026-10）で型の無い物に当てる最小の宣言。
// ・.scss＝vite が束ねる（型は要らない）
// ・import.meta.glob＝vite の口（i18n.ts＝言語辞書の遅延 import）
// ・@ortho-earth/globe のサブパス（i18n・gadgets）＝globe はまだ JS で globe.d.ts は入口 "." だけ＝ここで使う口だけを宣言する（any に広げない）
declare module "*.scss" {}

// WebGPU：lib.dom（TS 6.0）は GPUDevice 等の型は持つが、定数の名前空間 4 つと canvas.getContext("webgpu") の overload を持たない＝renderer-gpu.ts が使う分だけ補う
declare var GPUShaderStage: { readonly VERTEX: number; readonly FRAGMENT: number; readonly COMPUTE: number };
declare var GPUTextureUsage: { readonly COPY_SRC: number; readonly COPY_DST: number; readonly TEXTURE_BINDING: number; readonly STORAGE_BINDING: number; readonly RENDER_ATTACHMENT: number };
declare var GPUBufferUsage: { readonly MAP_READ: number; readonly MAP_WRITE: number; readonly COPY_SRC: number; readonly COPY_DST: number; readonly INDEX: number; readonly VERTEX: number; readonly UNIFORM: number; readonly STORAGE: number; readonly INDIRECT: number; readonly QUERY_RESOLVE: number };
declare var GPUMapMode: { readonly READ: number; readonly WRITE: number };
interface HTMLCanvasElement {
	getContext(contextId: "webgpu"): GPUCanvasContext | null;
}

interface ImportMeta {
	/** vite の glob import（遅延）：パス → 読み込み関数。辞書 JSON は default が英語キー → 訳 */
	glob(pattern: string): Record<string, () => Promise<{ default?: Record<string, string> }>>;
}

declare module "@ortho-earth/globe/i18n/langs.js" {
	/** 言語一覧（world が正本・globe が写しを持つ）＝{ code, name, rtl } */
	const LANGS: { code: string; name: string; rtl: boolean }[];
	export default LANGS;
}

declare module "@ortho-earth/globe/i18n/core.js" {
	export interface I18nLang { code: string; name: string; rtl: boolean }
	/** t("Loading $1 …", name)＝英語キー・$n 置換・" ##" 以降は文脈（表示では捨てる） */
	export type Translate = (key: string, ...args: unknown[]) => string;
	export interface I18n {
		getLang(): string;
		setLang(code?: string | null): Promise<string>;
		loadLang(code?: string | null): Promise<string>;
		loadPage(importer: (code: string) => Promise<{ default: Record<string, string> }>, code?: string): Promise<string>;
		registerPack(code: string, table: Record<string, string>): void;
		isRTL(code?: string): boolean;
		langName(code: string): string;
		LANGUAGES: I18nLang[];
		norm(code: unknown): string | null;
		t: Translate;
		tr(): Translate;
		has(key: string): boolean;
		applyDom(root?: ParentNode): void;
		applyHtml(el?: HTMLElement): HTMLElement;
	}
	export function createI18n(opts: { langs: I18nLang[]; load: (code: string) => Promise<Record<string, string> | null | undefined> }): I18n;
}

declare module "@ortho-earth/globe/i18n.js" {
	import type { I18n } from "@ortho-earth/globe/i18n/core.js";
	export const getLang: I18n["getLang"];
	export const setLang: I18n["setLang"];
	export const loadLang: I18n["loadLang"];
	export const loadPage: I18n["loadPage"];
	export const registerPack: I18n["registerPack"];
	export const isRTL: I18n["isRTL"];
	export const langName: I18n["langName"];
	export const LANGUAGES: I18n["LANGUAGES"];
	export const t: I18n["t"];
	export const tr: I18n["tr"];
}

declare module "@ortho-earth/globe/gadgets/anno-draw.js" {
	/** 同一フレームのオーバーレイ（japan の map.overlay と同じ契約・#13）＝init(canvas, opts, host) / message / frame(cam, camState, size, api) / destroy */
	export interface OverlayHost { requestDraw(): void; post(d: unknown): void }
	export interface OverlayApi {
		W: number; H: number; dpr: number;
		/** lon, lat → [x, y, front]（CSS px・左上原点） */
		project: (lon: number, lat: number) => number[];
		projectH: (lon: number, lat: number, h?: number) => number[];
	}
	export function init(cv: HTMLCanvasElement, opts: Record<string, unknown>, h: OverlayHost): void;
	export function message(d: unknown): void;
	export function destroy(): void;
	/** 戻り＝まだ動く（次のフレームも要る） */
	export function frame(cam: { zoom: number; pitch: number; bearing: number }, camState: unknown, size: [number, number], api: OverlayApi): boolean;
}

declare module "@ortho-earth/globe/gadgets/anno.js" {
	import type { GeoPBF } from "geopbf";
	/** map.overlay() が返す同一フレームのオーバーレイの口（japan の map.overlay と同じ契約） */
	export interface OverlayHandle { el: HTMLElement; onmessage: ((d: unknown) => void) | null; post(d: unknown): void; remove(): void }
	export interface PopOptions { lng?: number; lat?: number; x: number; y: number; hideOffscreen?: boolean; onClose?: () => void }
	export type PopFn = (html: string, opts?: PopOptions) => (HTMLElement & { _remove?: () => void }) | null | undefined;
	/** createAnno が使う map の口（mapEl / overlay / unprojectXY / getZoom / requestDraw / gadget.tip・pop） */
	export interface AnnoMap {
		mapEl: HTMLElement;
		overlay(url: string | { builtin: string }, opts?: { name?: string }): OverlayHandle;
		unprojectXY(x: number, y: number): number[] | null;
		getZoom(): number;
		requestDraw(): void;
		gadget: { tip(): (html: string | null) => void; pop(): PopFn };
	}
	export interface Anno {
		set(pbf: GeoPBF | null): void;
		clear(): void;
		/** 検定用＝実画素（worker から） */
		pixels(): Promise<unknown>;
		readonly pbf: GeoPBF | null;
		readonly count: number;
		readonly hits: unknown[];
	}
	export function createAnno(map: AnnoMap, opts?: { signal?: AbortSignal }): Anno;
}

declare module "@ortho-earth/globe/gadgets/searchbox.js" {
	export interface SearchOptions {
		/** 世界の既定（国・州・都市・地形・26 言語）＝true か { url, lang } */
		world?: boolean | { url?: string; lang?: string; [k: string]: unknown };
		signal?: AbortSignal;
		onGo?: (lon: number, lat: number, zoom: number, tilt?: number) => void;
		/** 範囲 [w, s, e, n] が収まる視点（cameraForBounds の無い地図＝equal が渡す） */
		fit?: (bbox: number[]) => { lon: number; lat: number; zoom: number } | null | undefined;
		maxZoom?: number;
		placeholder?: string;
		[k: string]: unknown;
	}
	/** 地名検索の窓（this＝map：mapEl を持つ物） */
	export function search(this: { mapEl: HTMLElement; [k: string]: unknown }, opts?: SearchOptions): void;
}
