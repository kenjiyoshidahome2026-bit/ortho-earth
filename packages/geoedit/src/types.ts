// geoedit の共有型（型だけ＝実行時の中身は無い・TS 化 段 3・2026-10）。
// 編集モデルは小規模（geopbf/edit/model の EditModel）と大規模（geopbf/edit/large-model の LargeModel）の 2 系統＝
// controller は `st.model.large` で分岐する＝ここでは判別可能な合併型（Model）に束ねる。
import type { EditModel, EditCmd, FeatureVerts } from "geopbf/edit/model";
import type { LargeModel, LargeFeature, LargeArc, LargeAddr } from "geopbf/edit/large-model";
import type { TopoFeature, TopoArc } from "geopbf/edit/topo-extract";
import type { History } from "geopbf/edit/history";
import type { SnapEntry } from "geopbf/edit/snap";
import type { Vec3, Quat, LonLat } from "geopbf/edit/sphere";
import type { GeoPBF as GeoPBFPublic } from "geopbf";

import type { PbfCore } from "./worker-msg.ts";
export type { PbfCore };
/** 編集器が扱う GeoPBF＝器（PbfCore）に "geopbf" の拡張（gint・identifyAt・*File）が載った物。実体は同じインスタンス＝型だけ合わせる */
export type Pbf = GeoPBFPublic & PbfCore;

/** 小規模モデル＝EditModel（large 欄を持たない＝判別用に undefined を明示） */
export type SmallModel = EditModel & { readonly large?: undefined };
/** 編集モデル（小規模／大規模）。`m.large` で判別 */
export type Model = SmallModel | LargeModel;
/** どちらのモデルの feats にも入る地物（type・arcs?・coords?・properties は共通） */
export type Feature = TopoFeature | LargeFeature;
/** どちらのモデルの arcs にも入る arc（refs は Set（小規模）か number[]（大規模）） */
export type Arc = TopoArc | LargeArc;

/** 大規模モードの頂点移動（addr が LargeAddr＝gaid+idx） */
export interface LargeMoveCmd { op: "move"; addr: LargeAddr; from: number[]; to: number[] }
/** history が持つコマンド＝小規模の EditCmd か大規模の move */
export type Cmd = EditCmd | LargeMoveCmd;

/** applyGintData に渡す搭載オプション（globe の GintApplyOptions の、ここで使う分） */
export interface GintOpts {
	interactive?: boolean; hover?: boolean; minZoom?: number; lowFill?: boolean;
	style?: { styleTable?: Float32Array; [k: string]: unknown };
	onReady?: () => void;
}
/** 右クリックメニューの 1 項目（globe の ContextMenuItem と同形） */
export interface MenuCtx { lng?: number; lat?: number; x: number; y: number; map: unknown }
export interface MenuItem { name: string; icon?: string; onClick(c: MenuCtx): unknown }
export type MenuItems = MenuItem[] | ((c: MenuCtx) => MenuItem[]);
/** map.gadget.contextmenu の戻り＝初回搭載は差し替え関数・二重搭載は { setItems } */
export type ContextMenuHandle = ((items: MenuItems | null) => void) | { setItems?(items: MenuItems | null): void } | null | undefined;
/** map.gadget.pop() の戻り＝吹き出し箱を 1 つ作る関数（箱の div は _setContent／_remove を持つ） */
export type PopBox = HTMLElement & { _setContent(c: string): void; _remove?(): void };
export type PopFn = (content: string, at: { lng: number; lat: number; x?: number; y?: number; hideOffscreen?: boolean; onClose?: () => void }) => PopBox | null | undefined;

/** 編集器が触る地図の面（globe の OrthoJapanMap の、ここで使う分＝素の map でも旗つきの map でも可） */
export interface EditorMap {
	mapEl: HTMLElement;
	unprojectXY(x: number, y: number): LonLat | null;
	projectLL(lon: number, lat: number): ArrayLike<number>;
	makeProjector(): (lon: number, lat: number) => ArrayLike<number>;
	getZoom(): number;
	onFrame(fn: () => void): () => void;
	requestDraw(): void;
	setEditClick(fn: ((x: number, y: number) => void) | null): void;
	applyGintData(pbf: Pbf | null, label: string, moveCamera?: boolean, opts?: GintOpts): unknown;
	paintTable(table: Uint32Array, count: number): void;
	userPbf?(): Pbf | null;
	maxPitch?(): number; setMaxPitch?(deg: number | null): void;
	zoomMin?(): number; setZoomMin?(z: number | null): void;
	ellipsoidOn?(): boolean;
	view?: { center?: ArrayLike<number>; hash?: string; [k: string]: unknown };
	gadget: {
		contextmenu(opts?: { items?: MenuItems }): ContextMenuHandle;
		pop(opts?: object): unknown;
	};
}

/** オーバレイのハンドル（描画時キャッシュ＝pointerdown の命中判定と同じ真実源） */
export type HandleV = { kind: "v"; arcId: number; idx: number };
export type HandleM = { kind: "m"; arcId: number; idx: number; ll: LonLat };
export type HandleP = { kind: "p"; eid: number; ptIdx: number };
export type Handle = (HandleV | HandleM | HandleP) & { x: number; y: number };

/** 回転移動の進行状態（drag.ts） */
export interface RotState { base: FeatureVerts; c: LonLat; cVec: Vec3; qm: Quat | null; angRaw: number; deg: number; snapped: boolean; spun: boolean }
export type Drag =
	| { kind: "f"; eid: number; a: Vec3; r: RotState; q: Quat | null; pointerId: number; moved: boolean }
	| ((HandleV | HandleP) & { start: number[]; last: number[]; pointerId: number; moved: boolean });

/** 作図中の状態（描くのは overlay） */
export interface Sketch { kind: string; coords: number[][]; cursor: number[] | null; preview?: number[][] | null; xy?: number[][]; pointerId?: number }

/** 可変状態＝全部ここ（各入力モジュールと共有） */
export interface EditorState {
	model: Model | null;
	selection: number | null;
	dragEids: Set<number> | null;
	hidden: Set<number> | null;
	sketch: Sketch | null;
	snapMark: number[] | null;
	rot: { c: ArrayLike<number>; deg: number; snapped: boolean } | null;
	busy: boolean;
	multi: Set<number> | null;
	focus: Set<number> | null;
	tool: string;
	drag: Drag | null;
	editGen: number;
	envGen: number;
	largeDirty: boolean;
}

/** 作図ツールの既定スタイル（「次に描くもの」の @プロパティ） */
export type DrawDefaults = Record<string, Record<string, unknown>>;

/** 確定層（gint-layer.ts の createGintLayer の戻り） */
export interface GintLayer {
	readonly pbf: Pbf | null;
	readonly saveBuffer: ArrayBuffer | null;
	commit(model: EditModel, opts?: { moveCamera?: boolean }): Promise<Pbf | null>;
	applyLarge(built: Pbf, featsArr: LargeFeature[], opts?: { moveCamera?: boolean }): Promise<Pbf | null>;
	resendLarge(model: LargeModel): Promise<Pbf | null>;
	identify(lng: number, lat: number, zoom?: number, px?: { point: number; polyline: number }): number | null;
	hide(eids: Iterable<number>): void;
	focus(eids: Set<number> | null): void;
	unhide(): void;
	restyleProps(model: Model): void;
	restyleOne(model: Model, eid: number): void;
	exportPbf(model: EditModel): Promise<Pbf>;
}
/** 編集オーバレイ（overlay.ts） */
export interface Overlay {
	canvas: HTMLCanvasElement;
	redraw(): void;
	handleAt(x: number, y: number, touch: boolean): Handle | null;
	symbolAt(x: number, y: number, pad?: number): number | null;
	destroy(): void;
}
/** @pop の再生層（pop-layer.ts） */
export interface PopLayer {
	open(eid: number, at?: { x: number; y: number; ll?: LonLat | undefined } | null): void;
	close(eid: number): void;
	sync(): void;
	clear(): void;
	destroy(): void;
}
/** 選択パネル（properties.ts） */
export interface PropsPanel { render(eid: number): void; close(): void; readonly eid: number | null }
/** ツールバー（toolbar.ts） */
export interface Toolbar { syncTool(tool: string): void; syncHist(canUndo: boolean, canRedo: boolean): void }
/** 作図（sketch.ts） */
export interface SketchApi { start(kind: string, ll?: LonLat | null): void; click(kind: string, ll: LonLat): void; finish(): void; cancel(): void }

/** スナップ候補の除外判定（ドラッグ中の自分自身など） */
export type SnapSkip = ((en: SnapEntry) => boolean) | null | undefined;

/** 共有文脈 ed＝入力モジュールへ渡す。関数の一部は controller が後から足す（呼ばれる時点で揃っていればよい） */
export interface EditorContext {
	map: EditorMap; mapEl: HTMLElement; signal: AbortSignal; st: EditorState;
	hist: History<Cmd>; layer: GintLayer; overlay: Overlay; popLayer: PopLayer;
	toast(msg: string): void;
	drawDefaults: DrawDefaults;
	localXY(e: { clientX: number; clientY: number }): [number, number];
	pick(x: number, y: number, ll?: LonLat | null, wide?: boolean): number | null;
	onSurface(e: Event): boolean;
	// ---- controller が後で足す ----
	scheduleCommit(force?: boolean): void;
	snapLL(ll: LonLat, skip?: SnapSkip): LonLat;
	doCmd(cmd: Cmd): boolean;
	props: PropsPanel;
	placePointAt(ll: LonLat, defs: Record<string, unknown>): void;
	select(eid: number | null, opts?: { keepMulti?: boolean }): void;
	toggleMulti(eid: number | null | undefined): void;
	groupMulti(): void;
	isMulti(eid: number | null | undefined): boolean;
	explodeEid(eid: number): void;
	sketch: SketchApi;
	hideTip(): void;
	flushRot?: () => void;
	bar: Toolbar;
	setTool(tool: string): void;
}
