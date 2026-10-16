// 変換 worker の便（main ⇄ src/worker.ts）の形＝型だけ（TS 化 段 3・2026-10）。
// 呼び手（pbf-base.js／pbf.js／pbf-io.js＝まだ JS）と受け手（decoder/*.ts・encoder/*.ts）が同じ名前で読む。
// 形式ごとに使う鍵が違う＝使わない鍵は無視される（json デコーダは e.data を丸ごと GeoPBF の options に渡す）。
import type { CleanTopologyOptions, UnPackGint } from "../types/geopbf.js";
import type { FMapEntry } from "./pbf-base.ts";
import type { GridSource } from "./convert/datum.ts";   // JGD 変換のパラメータ（convert/datum＝文字列・バイト列・焼いた格子）

/** ヘッダのメタ（全デコーダ共通） */
export interface DecodeMeta { name?: string; precision?: number; description?: string; license?: string; attribution?: string }

/** main → decoder:<形式>（file は必ずある） */
export interface DecodeRequest extends DecodeMeta {
	file: File;
	/** 文字コード（"utf8"・"sjis" …）と、UTF-8 で読めない時の予備 */
	encoding?: string; fallbackEncoding?: string;
	/** csv／tsv／xlsx：経緯度の列名・WKT の列名・シート・区切り */
	lon?: string; lat?: string; wkt?: string; sheet?: string; delimiter?: string;
	/** dxf／shape：CRS（EPSG 番号か WKT）・CRS を無視・単位倍率・閉じた線を面に */
	crs?: string | number; ignoreCrs?: boolean; unitScale?: number; closedAsPolygon?: boolean;
	/** JGD の変換（TKY2JGD・PatchJGD のパラメータ） */
	tky2jgd?: GridSource; patchjgd?: GridSource;
	/** 多層ファイル（gpkg・gdb・spatialite）の層・GeoParquet の幾何列 */
	layer?: string; geometryColumn?: string;
	/** spatialite：読む表・読まない表 */
	include?: readonly string[]; exclude?: readonly string[]; excludeAll?: boolean;
	/** shape：zip の中の 1 本だけ読む（末尾一致） */
	shpTarget?: string;
	[key: string]: unknown;
}
/** decoder → main：GeoPBF のバイト列（data は transfer）。warning は呼び手が console へ・stats は形式ごと */
export interface DecodeResponse { type: string; data: ArrayBuffer; warning?: string; stats?: unknown }
/** decoder:moj の途中経過 */
export interface DecodeProgress { type: "progress"; loaded: number; total: number; name?: string }
/** null＝失敗（呼び手は null を「失敗」として扱う） */
export type DecodeReply = DecodeResponse | DecodeProgress | null;

/** decoder:pbf（GeoPBF バイト列のヘッダ解析＝props は送らない・main が遅延復号） */
export interface PbfDecodeRequest { buf: ArrayBuffer }
export interface PbfDecodeResponse {
	buf: ArrayBuffer; fmap: FMapEntry[]; keys: string[]; bufs: ArrayBuffer[];
	_name: string; _description: string; _license: string; _attribution: string;
	_minZoom: number | null; _maxZoom: number | null;
	_precision: number; _bodyPos: number; end: number;
}
/** decoder:gint（GintBUF → unPackGint・SAB なら共有のまま） */
export interface GintDecodeRequest { sab: ArrayBuffer | SharedArrayBuffer }
export type GintDecodeResponse = UnPackGint | null;

/** 書き出しの options（createGeopbf の ExportOptions のうち worker が読む分） */
export interface EncodeOptions {
	/** 文字形式を gzip */
	gz?: boolean;
	/** kmz（既定 true・false＝素の kml） */
	kmz?: boolean;
	/** shape の DBF の文字コード（"utf8"・"sjis"） */
	encoding?: string;
	/** encoder:gint：GintBUF を SAB に直に組む・焼いた後に交差修復 */
	shared?: boolean; clean?: boolean | CleanTopologyOptions;
	[key: string]: unknown;
}
/** main → encoder:<形式>（gintbuf は profile／topojson） */
export interface EncodeRequest { buf: ArrayBuffer; name: string; opts?: EncodeOptions | null; gintbuf?: ArrayBuffer | SharedArrayBuffer }
/** main → encoder:preview（canvas＝OffscreenCanvas か無し） */
export interface PreviewRequest { buf: ArrayBuffer; canvas?: OffscreenCanvas | null; name?: string; props?: Record<string, unknown> }
/** encoder → main：File／Blob（書き出し）・ArrayBuffer／SAB（gint）・ImageBitmap（preview）・string（profile）・null＝失敗 */
export type EncodeResponse = File | Blob | ArrayBuffer | SharedArrayBuffer | ImageBitmap | string | null;
