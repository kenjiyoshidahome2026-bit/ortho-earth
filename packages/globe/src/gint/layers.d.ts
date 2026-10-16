// gint/layers.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝gint/layers.js が TS になれば消える。
import type { GeoPBF } from "geopbf";
import type { GintLayerHandle } from "../../globe.d.ts";
import type { GlobeCoreApi } from "../types/map.ts";
import type { GintLayers } from "../types/scope.ts";

/** gint の層の束（createGintLayers の戻り）＝scope.ts の GintLayers（installer が読む分）に globe.ts が読む分を足した物 */
export interface GintLayersCtl extends GintLayers {
	applyGintData: GlobeCoreApi["applyGintData"];
	addGint: GlobeCoreApi["addGint"];
	queryAllGint: GlobeCoreApi["queryAll"];
	standupGint: GlobeCoreApi["standupGint"];
	paintGint: GlobeCoreApi["paint"];
	fitZoomForBbox: GlobeCoreApi["fitZoomForBbox"];
	gintFidFeatures: GlobeCoreApi["gintFeatures"];
	/** fid → 塗りの表の直書き（{ table, count }） */
	sendGintPaint(p: { table: Uint32Array; count: number }): void;
	/** 単一スロットの調停（ユーザー層⇄世界海岸線）＋海岸線の遅延ロード */
	updateGintSlot(): void;
	/** 世界の国の形（既定＝今載っている解像度） */
	ensureAdmin0(res?: string): Promise<GeoPBF | null>;
	admin0DrawStyle(): Record<string, unknown>;
	readonly ADMIN0_Z: number; readonly WORLD_TIP_MAXZ: number;
	readonly interactive: boolean; readonly hover: boolean; visible: boolean; readonly drapedOn: boolean;
	lastHoverXY: [number, number] | null; extTipOwn: boolean;
	clickHandler: ((fid: number, props: Record<string, unknown> | null | undefined, lnglat: [number, number]) => void) | null;
	suppressAdmin0: boolean;
	readonly internalHidden: boolean;
	readonly userGint: (NonNullable<GintLayers["userGint"]> & { tip?: ((props: Record<string, unknown>) => string[] | null) | null; minZoom?: number; drapeFill?: boolean; hover?: boolean }) | null;
	readonly admin0Layer: GintLayerHandle | null; readonly admin0Vis: boolean; readonly admin0Pbf: GeoPBF | null;
	/** テーマ切替＝世界線の色を引き直す */
	repaintWorldLines(): void;
	destroy(): void;
}
/** 多層の台帳（layers.map＝globe の extGint）の 1 件＝公開の手綱＋worker の返信の口 */
export interface ExtGintEntry extends GintLayerHandle {
	_ack(d: unknown): void; _hover(d: unknown): void; _click(d: unknown): void;
	_zoomReeval?(z: number): void; _shown(z: number): boolean; _internal?: boolean; _sendVis(): void;
}
export function createGintLayers(env: object): GintLayersCtl;
