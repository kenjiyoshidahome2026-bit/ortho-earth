// geopbf の型定義（公開面のみ・手書きの正典。実装＝src/pbf-base.js・src/pbf.js・src/index.js）。2026-10-12（改良点 10）。
// 散文の正典は reference.md（§番号はそれに合わせる）。ここに無い subpath は types/subpaths.d.ts の省略宣言（any）で通す。
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

/** 符号化の検証層（§1 `options.validate`・1.20〜） */
export type ValidateMode = "lenient" | "strict" | "legacy";
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
	/** FUNC 型の属性を new Function で復元しない（既定 true・1.19〜）。false＝旧挙動（関数へ復元） */
	noeval?: boolean;
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

/** GeoPBF の器（geopbf/pbf-base）＝符号化・復号・ヘッダ・地物の読み書き。
 *  型だけの名前（実行時には "geopbf"／"geopbf/core"／"geopbf/pbf-base" のどれも GeoPBFBase を export しない＝器の class は各入口の GeoPBF）。`import type { GeoPBFBase }` で使う */
declare class GeoPBFBase {
	constructor(options?: GeoPBFOptions);
	static setProperty(name: string | Record<string, any>, value?: any): void;
	static setGetter(name: string, func: (this: GeoPBF) => any): void;
	static setPrototype(name: string, func: (this: GeoPBF, ...args: any[]) => any): void;
	/** createGeopbf() が配線する復号 worker の入口（ブラウザ用） */
	static _workerFactory?: () => Worker | null;
	static _gintWorkerFactory?: () => Worker | null;
	// ── 静的な名簿（pbf-base.js が GeoPBF.setProperty で載せる）
	static readonly TAGS: WireTags;
	static readonly makeKeys: MakeKeys;
	/** 属性値のワイヤ型（dataTypeNames の添字・不明＝-1） */
	static dataType(value: unknown): number;
	static readonly dataTypeNames: readonly string[];
	static readonly geometryTypes: readonly GeometryType[];
	static readonly geometryMap: Readonly<Record<GeometryType, number>>;

	// ── §1 の options の写し
	readonly noprop: boolean; readonly noeval: boolean; readonly validate: ValidateMode;
	/** 符号化の検証層が見つけた問題（先頭 100 件） */
	readonly issues: ValidateIssue[];
	/** 種類ごとの件数 */
	readonly issueCount: Partial<Record<IssueKind, number>>;
	/** 幾何なし・修復不能で落とした地物数 */
	readonly dropped: number;
	/** antimeridian で切った地物数 */
	readonly cutCount: number;

	// ── §2 読み込みと出力
	/** FeatureCollection・ArrayBuffer・TypedArray（SharedArrayBuffer の上の view も可）を読む。ArrayBuffer は worker 経路では転送されて detached になる。
	 *  Feature／Geometry 単体・裸の SharedArrayBuffer は受けない（createGeopbf() の入口 geopbf(input) は Feature／Geometry／TopoJSON も FeatureCollection に包む） */
	set(data: FeatureCollection | ArrayBuffer | ArrayBufferView): Promise<this>;
	readonly geojson: FeatureCollection;
	readonly arrayBuffer: ArrayBuffer;
	readonly headerBuffer: ArrayBuffer;
	/** 符号化した bytes */
	readonly size: number;
	/** 地物数 */
	readonly length: number;
	readonly features: Feature[];
	readonly geometries: (Geometry | null)[];
	readonly properties: Properties[];
	readonly propertiesTable: any[][];
	/** 属性の鍵（keys の順が propsRow の順） */
	keys: string[];
	empty(): this;
	destroy(): void;

	// ── §3 メタデータ
	name(): string; name(value: string): this;
	description(): string; description(value: string): this;
	license(): string; license(value: string): this;
	attribution(): string; attribution(value: string): this;
	minZoom(): number | null; minZoom(value: number | null): this;
	maxZoom(): number | null; maxZoom(value: number | null): this;
	/** 引数なし＝精度（10^n）。geopbf/pbf の拡張では引数ありで再符号化した新インスタンスを返す */
	precision(): number;
	updateHeader(meta: HeaderMeta): this;
	copyHead(pbf: GeoPBFBase): this;

	// ── 地物の読み書き
	each<T>(func: (index: number, fmap: number[]) => T): T[];
	forEach(func: (index: number, fmap: number[]) => void): this;
	getFeature(index: number): Feature;
	getGeometry(index: number, j?: number): Geometry | null;
	getProperties(index: number): Properties;
	getType(): GeometryType[]; getType(index: number): GeometryType;
	/** keys の順の属性値（遅延復号） */
	propsRow(index: number): any[];
	/** ストリーム符号化（set() を自前でなぞる呼び手向け）。setHead → setFeature… → close */
	setHead(keys: string[], bufs?: any[], meta?: HeaderMeta): this;
	setFeature(feature: Feature): this;
	/** 幾何そのものを書く（setFeature の内側・検証層は通らない） */
	setGeometry(geometry: Geometry): this;
	/** 属性そのものを書く（返り値なし） */
	setProperties(properties: Properties | undefined): void;
	/** FARRAY を書く＝FeatureCollection の全地物か、setFeature／setMessage を自前で呼ぶ関数 */
	setBody(body: FeatureCollection | (() => void)): this;
	close(): this;
	getGeometryBuffer(index: number, j?: number): Uint8Array;
	setGeometryBuffer(bytes: Uint8Array): this;
	copyGeometry(pbf: GeoPBFBase, index: number): void;
	copyProperties(pbf: GeoPBFBase, index: number): void;

	/** Gint を焼いた後に付く（§6） */
	unPackGint?: UnPackGint | null;
	_gintBuffer?: ArrayBuffer | SharedArrayBuffer | null;
	/** geopbf(input, { cacheKey }) で置いた鍵・meta */
	_cacheKey?: string;
	cacheMeta?: Record<string, any> | null;
}
export type { GeoPBFBase };

/** GeoPBF（geopbf/pbf・"geopbf"）＝器＋解析・操作・位相の拡張メソッド */
export class GeoPBF extends GeoPBFBase {
	// ── §4 幾何の解析
	centroid(index: number): LngLat;
	/** m² */
	area(index: number): number;
	/** m */
	lineLength(index: number): number;
	getBbox(index: number): BBox;
	readonly bbox: BBox;
	readonly bboxes: BBox[];
	/** 点を含む最小のポリゴンの fid（Gint が無ければ null） */
	contain(lngLat: LngLat): number | null;
	/** 描画レス識別（点→線→面）。fid か null */
	identifyAt(lng: number, lat: number, options?: IdentifyAtOptions): number | null;
	identify(mx: number, my: number, proj: Projection, options?: IdentifyOptions): number | null;

	// ── §5 操作
	dissolve(property?: string | true): Promise<GeoPBF>;
	map(map: (properties: Properties, index: number) => Properties): Promise<GeoPBF>;
	closeFilter(filter: (properties: Properties, index: number) => boolean): Promise<GeoPBF>;
	cloneMap(options?: { map?: (properties: Properties, index: number) => Properties; filter?: (properties: Properties, index: number) => boolean }): Promise<GeoPBF>;
	classify(keyOrFunc: string | ((properties: Properties, index: number) => string | number)): Promise<Record<string, GeoPBF>>;
	/** 丸ごとの写し（arrayBuffer を読み直す＝非同期） */
	clone(): Promise<GeoPBF>;
	/** ヘッダだけの写し（keys・bufs・meta） */
	cloneHead(): Promise<GeoPBF>;
	/** 自分と others を 1 つに（名前は自分の name・precision が揃っていなければ null） */
	concat(...others: GeoPBF[]): Promise<GeoPBF | null>;
	getPropertyTable(): any[][];
	getCSV(): string;
	/** Gint の rank ≥ minRank の頂点に間引いた FeatureCollection */
	simplified(minRank: number): FeatureCollection;
	/** 引数なし＝精度（同期）。引数あり（1〜9）＝再符号化した新インスタンス（受け手は不変） */
	precision(): number; precision(value: number): Promise<GeoPBF>;

	// ── §6 位相（Gint）
	topojson(): any;
	neighbors(): number[][]; neighbors(index: number): number[];
	mesh(options?: TopoFilterOptions): MultiLineString | number[];
	merge(options?: TopoFilterOptions): Polygon | MultiPolygon | number[];
	/** GintBUF を焼く（createGeopbf() 後は encoder worker・無ければ呼んだスレッド） */
	gint(options?: GintOptions): Promise<this>;
	/** GintBUF を掴む（所有権を取る＝残したい時は buf.slice(0) を渡す） */
	setGintBUF(buf: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Promise<this>;
	cleanTopology(options?: CleanTopologyOptions | true): this;
	fileSize(): Promise<number>;

	// ── §7 書き出し（createGeopbf() を呼んだ後に使える・worker が無い環境は null）
	geopbfFile(options?: ExportOptions): Promise<File | Blob | null>;
	geojsonFile(options?: ExportOptions): Promise<File | Blob | null>;
	topojsonFile(options?: ExportOptions): Promise<File | Blob | null>;
	shapeFile(options?: ExportOptions): Promise<File | Blob | null>;
	kmzFile(options?: ExportOptions): Promise<File | Blob | null>;
	gpxFile(options?: ExportOptions): Promise<File | Blob | null>;
	czmlFile(options?: ExportOptions): Promise<File | Blob | null>;
	gmlFile(options?: ExportOptions): Promise<File | Blob | null>;
	fgbFile(options?: ExportOptions): Promise<File | Blob | null>;
	gintbuf(options?: ExportOptions): Promise<ArrayBuffer | null>;
	profile(options?: ExportOptions): Promise<any>;
	/** 縮小図を描く（HTMLCanvasElement へ描く・OffscreenCanvas を渡す・props だけ渡して ImageBitmap を受ける） */
	preview(canvas?: HTMLCanvasElement | OffscreenCanvas | Record<string, any>, props?: Record<string, any>): Promise<ImageBitmap | null>;
	/** 設定した bucket へ保存（無ければ null） */
	save(): Promise<this | null>;
}

/** `geopbf(input, options)` の options（createGeopbf の返す入口・README「Usage」）。形式ごとの口は README を参照 */
export interface GeopbfOptions extends GeoPBFOptions {
	/** Gint を焼く（既定 true） */
	gint?: boolean;
	/** 焼いた後に交差修復 */
	clean?: boolean | CleanTopologyOptions;
	/** IDB の控えを使わない */
	nocache?: boolean;
	/** 呼び手の鍵で控えを置く（geopbfCached で引く） */
	cacheKey?: string;
	cacheMeta?: Record<string, any>;
	/** 文字コード（"utf8"・"sjis" …） */
	encoding?: string;
	/** イベント（ConvertStart／ConvertProgress／ConvertEnd）を dispatch する先（既定 window） */
	eventTarget?: EventTarget | null;
	/** 形式の明示（拡張子から判らない時） */
	format?: string;
	/** 多層ファイル（GeoPackage・FileGDB・XLSX）の層・シート */
	layer?: string; sheet?: string;
	/** CRS（EPSG コード・WKT）と、ファイルの CRS を無視する印 */
	crs?: string | number; wkt?: string; ignoreCrs?: boolean;
	/** JGD の変換（TKY2JGD・PatchJGD のパラメータ・createGeopbf の options と同名で、こちらが優先） */
	tky2jgd?: any; patchjgd?: any;
	/** CSV／TSV の列名と区切り */
	lon?: string; lat?: string; geometryColumn?: string; delimiter?: string; fallbackEncoding?: string;
	/** GPX／KML の閉じた線を面に */
	closedAsPolygon?: boolean;
	unitScale?: number;
	target?: any;
	[key: string]: any;
}

export type GeopbfInput = string | File | Blob | ArrayBuffer | ArrayBufferView | FeatureCollection | Feature | Geometry | GeoPBF;
/** createGeopbf() が返す入口。文字列は URL（相対は自サイト）・zip の中は "x.zip#inner" */
export type GeopbfFn = (input: GeopbfInput, options?: GeopbfOptions | string) => Promise<GeoPBF | null>;

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
