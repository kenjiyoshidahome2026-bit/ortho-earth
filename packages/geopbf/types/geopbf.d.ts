// geopbf の値の型（公開面のみ・手書きの正典。class の型は実装＝src/pbf-base.ts・src/pbf.ts・src/index.ts）。2026-10-12（改良点 10）・段 4（2026-10-16）で class を実装へ。
// 散文の正典は reference.md（§番号はそれに合わせる）。
// GeoJSON の型は @types/geojson に依らず最小限を自前で持つ（利用者の GeoJSON 型とは構造的に互換）。

export type Position = number[];
export type BBox = [number, number, number, number] | number[];
export type LngLat = [lng: number, lat: number];
export interface Point { type: "Point"; coordinates: Position }
export interface MultiPoint { type: "MultiPoint"; coordinates: Position[] }
export interface LineString { type: "LineString"; coordinates: Position[] }
export interface MultiLineString { type: "MultiLineString"; coordinates: Position[][] }
export interface Polygon { type: "Polygon"; coordinates: Position[][] }
export interface MultiPolygon { type: "MultiPolygon"; coordinates: Position[][][] }
export interface GeometryCollection { type: "GeometryCollection"; geometries: Geometry[] }
export type Geometry = Point | MultiPoint | LineString | MultiLineString | Polygon | MultiPolygon | GeometryCollection;
export type GeometryType = Geometry["type"];
export type Properties = { [key: string]: any } | null;
export interface Feature<G extends Geometry | null = Geometry | null, P = Properties> { type: "Feature"; geometry: G; properties: P; id?: string | number; bbox?: BBox }
export interface FeatureCollection<G extends Geometry | null = Geometry | null, P = Properties> { type: "FeatureCollection"; features: Feature<G, P>[]; bbox?: BBox }

/** 符号化の検証層（§1 `options.validate`・1.20〜。"legacy" は 2.0 で撤去） */
export type ValidateMode = "lenient" | "strict";
export type IssueKind = "nullGeometry" | "emptyCoords" | "badCoordinate" | "latitude" | "degenerateRing" | "badNumber" | "multiDegraded";
export interface ValidateIssue { kind: IssueKind; /** setFeature が見た地物の通し番号 */ index: number; detail?: string }

/** ヘッダのメタデータ（§3） */
export interface HeaderMeta { name?: string; description?: string; license?: string; attribution?: string; minZoom?: number | null; maxZoom?: number | null }

/** `new GeoPBF(options)`（§1） */
export interface GeoPBFOptions extends HeaderMeta {
	/** 座標の精度（10^n・既定 6） */
	precision?: number;
	/** 属性を書かない */
	noprop?: boolean;
	/** false＝符号化時の antimeridian 切断を掛けない（既定 true・切った数は pbf.cutCount） */
	cut?: boolean;
	/** false＝このインスタンスの set(ArrayBuffer)／setGintBUF を呼んだスレッドで解く（createGeopbf が worker を配線していても） */
	worker?: boolean;
	/** 符号化の検証層（既定 "lenient"） */
	validate?: ValidateMode;
}

/** 描画レス識別の許容（§4 identifyAt）。point／polyline＝半径 m・accept＝偽の fid は無い物として次の候補へ */
export interface IdentifyAtOptions { point?: number; polyline?: number; accept?: (fid: number) => boolean }
/** 画面座標からの識別（pbf.identify）。point／polyline＝半径 px */
export interface IdentifyOptions { point?: number; polyline?: number; accept?: (fid: number) => boolean }
/** identify が受ける投影（d3-geo の projection と同形） */
export interface Projection { invert(xy: [number, number]): [number, number] | null; scale(): number }

/** `await pbf.gint(options)`（§6）。clean＝焼いた後に交差修復（true か cleanTopology の options） */
export interface GintOptions { gint?: boolean; clean?: boolean | CleanTopologyOptions; shared?: boolean }
export interface CleanTopologyOptions { gridUnit?: number; maxPasses?: number; snapDistSq?: number }

/** GintBUF（format 5）を解いた物（§6 `pbf.unPackGint`）。typed array は _gintBuffer の上の view・polygon／polyline／bbox 表は初回の読みで組む */
export interface UnPackGint {
	polygonCount: number; polylineCount: number; pointCount: number; nodeCount: number; arcCount: number;
	/** [w, s, e, n]（度） */
	bbox: number[];
	arcBuffer: BigUint64Array | null;
	/** arc ごとに 8 u32（off, len, …, minx, miny, maxx, maxy） */
	arcMeta: Uint32Array | null;
	/** fid, nGroups, [arcCount, arcs…]… */
	polyStream: Int32Array | null;
	lineStream: Int32Array | null;
	neighborStream: Int32Array | null;
	pointBuffer: BigUint64Array | null;
	point: Uint32Array | null;
	readonly polygon: any; readonly polyline: any;
	readonly polyBboxByFid: Map<number, number[]> | null;
	readonly lineBboxByFid: Map<number, number[]> | null;
	[key: string]: any;
}

/** topojson()／mesh()／merge() の filter（§6） */
export interface TopoFilterOptions { filter?: (a: Properties, b?: Properties) => boolean; arc?: boolean }

/** createGeopbf() が足す書き出し（§7 Export）。gz＝文字形式を gzip・silent／message＝ConvertStart/End イベントを出さない */
export interface ExportOptions { gz?: boolean; silent?: boolean; message?: boolean; [key: string]: any }

/** ワイヤのタグ番号（pbf spec.md・GeoPBF.TAGS） */
export interface WireTags { readonly NAME: 1; readonly KEYS: 2; readonly PRECISION: 3; readonly BUFS: 4; readonly FARRAY: 5; readonly FEATURE: 6; readonly GEOMETRY: 7; readonly GTYPE: 8; readonly LENGTH: 9; readonly COORDS: 10; readonly VALUE: 11; readonly INDEX: 12; readonly GARRAY: 13; readonly DESCRIPTION: 14; readonly LICENSE: 15; readonly ATTRIBUTION: 16; readonly MIN_ZOOM: 17; readonly MAX_ZOOM: 18 }
/** 属性の行から鍵の一覧（dotted・ソート済み）と Blob／ImageData の中身（BUFS）を集める（setHead の引数）。行の Blob／ImageData には id が書き込まれる */
export type MakeKeys = (properties: readonly (object | null | undefined)[]) => Promise<[keys: string[], bufs: ArrayBuffer[]]>;

// GeoPBF の器（GeoPBFBase＝"geopbf/pbf-base"・"geopbf/core" の GeoPBF）と拡張つきの GeoPBF（"geopbf"）の型は実装の class が正本（TS 化 段 4・2026-10-16）。
// 旧＝ここに手書きの declare class があった。class の型は "geopbf"（src/index.ts）から取る。入口の入力（GeopbfInput・GeopbfOptions・GeopbfFn）も src/index.ts

/** worker の入口（役割名 "decoder:shape"・"encoder:gint" …→ Worker・null＝既定） */
export type WorkerFactory = (role: string) => Worker | null | undefined;

/** bucket provider が返す棚（名前引き・保存・削除）。url＝null は素の代役（名前引き不可） */
export interface BucketStore { url: string | null; list(): Promise<any[]>; put(file: File | Blob): Promise<unknown>; del(name: string): Promise<unknown>; etag(name: string): Promise<string | null>; [key: string]: any }
/** IDB の控え（3 形）＝cache()（鍵の一覧）・cache(key)（読む）・cache(key, value)（置く・null＝消す） */
export type BucketCache = (key?: string, value?: any) => Promise<any>;
/** bucket provider（createGeopbf(apiBase, { bucket })・例: native-bucket の nativeBucket）。(apiBase, options) → { Bucket, Cache, Fetch } */
export type BucketProvider = (apiBase: string | undefined, options: CreateGeopbfOptions) => {
	Bucket: (dir: string, options?: Record<string, any>) => Promise<BucketStore>;
	Cache: (dir: string) => Promise<BucketCache>;
	/** URL（zip の中は { target }）→ File */
	Fetch: (url: string, options?: { target?: string; encoding?: string; [key: string]: any }) => Promise<File | Blob>;
};

export interface CreateGeopbfOptions {
	/** false＝全インスタンスを呼んだスレッドで解く（Worker を起こさない） */
	worker?: boolean;
	/** ホストの worker の入口（setWorkerFactory と同じ） */
	workerFactory?: WorkerFactory;
	/** 復号レーンを起動直後に起こす（既定 false） */
	prewarm?: boolean;
	/** bucket provider の注入口（IDB の控え・proxy fetch・バケツ名前引き）。未注入＝素の fetch・控え無し */
	bucket?: BucketProvider;
	/** JGD の変換（TKY2JGD・PatchJGD のパラメータ）の既定＝geopbf(input, { tky2jgd, patchjgd }) が無い時に使う */
	tky2jgd?: any; patchjgd?: any;
	[key: string]: any;
}
