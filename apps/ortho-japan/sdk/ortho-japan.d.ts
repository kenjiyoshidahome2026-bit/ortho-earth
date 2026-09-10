// ortho-japan SDK 型定義（公開面のみ・手書きの正典）。実装＝apps/ortho-japan/app.js。
// AIエージェント/エディタ補完のための共有語彙＝散文（README/llms.txt）とセットで配布する。
// gint系（applyGintData等）は現行v1の単一スロット口＝将来 map.addGint()（v2）で置換予定。
// 消費側は必ず薄いモジュール1枚に封じること（gint draw spec §10.2）。

export type LonLat = [lon: number, lat: number];
export type Bbox = [w: number, s: number, e: number, n: number];

export interface OrthoJapanOptions {
	/** 埋め込み先（セレクタ or 要素）。idは"map"へ正規化される＝サイズ指定は#idセレクタ禁止 */
	target?: string | HTMLElement;
	/** 初期視点 "#zoom/lat/lon/45t/30r/l=…/c=…"（t=チルト°・r=回転°） */
	view?: string;
	/** 配色の焼き付け（"mono"|"dark"|"gsi"|"sepia" または台帳と同形のカスタム） */
	theme?: string | object;
	/** 表示項目の固定。true=常時表示・false=封印・未記述=チップで利用者が選ぶ */
	layers?: Partial<Record<"place" | "terrain" | "rail" | "road" | "facility", boolean>>;
	/** 右上チップ帯の表示（既定true） */
	chips?: boolean;
	/** 下部計器盤。true=全部／配列=選択（"attr"を消すならページ側で出典明記の義務） */
	instruments?: boolean | Array<"pos" | "scale" | "attr" | "log">;
	/** 建物3D（PLATEAU）機能スイッチ。false=関連通信・workerごと停止（既定true） */
	plateau?: boolean;
	/** UI言語（地図中の地名は対象外） */
	lang?: "ja" | "en";
	/** チルト上限（**ラジアン**）。0=俯瞰固定。共有URLのt=も同上限でクランプ（既定 75°） */
	maxPitch?: number;
	/** 実行時アセット（plateau-sets.json等）の配信ベースURL */
	assetBase?: string;
}

/** 右クリックメニュー項目（map.gadget.contextmenu({items})） */
export interface ContextMenuItem {
	name: string;
	onClick(c: { lng?: number; lat?: number; x: number; y: number; map: OrthoJapanMap }): void;
}

export interface Gadgets {
	search(opts?: object): unknown;
	zoom(): unknown;
	compass(): unknown;
	full(): unknown;              // 全画面（ショートカット=Z単キー）
	shot(): unknown;              // 画面保存
	measure(): unknown;
	profile(): unknown;           // 断面図（クリックで経路指定→標高プロファイルのグラフ）
	contextmenu(opts?: { items?: ContextMenuItem[] }): unknown;
	legend(): unknown;
	palette(): unknown;
	hint(): unknown;
	qr(): unknown;
	print(): unknown;
	cpos(): unknown;
	tip(opts?: object): unknown;
	pop(opts?: object): unknown;
	/** 自作ガジェットの登録（this===map で呼ばれる） */
	(name: string, fn: (this: OrthoJapanMap, ...args: unknown[]) => unknown): void;
	[name: string]: unknown;
}

/** gint 層の描画スタイル（applyGintData opts.style。未指定＝既定色：面 #FF6B35 / 線 #00B4D8） */
export interface GintDrawStyle {
	/** 線幅 CSS px（既定 1） */
	lineWidth?: number;
	/** 塗り色 [r,g,b,a]（0..1） */
	fillColor?: [number, number, number, number];
	/** styleId(0..255)→色 [r,g,b,a] の平坦配列（256×4） */
	styleTable?: Float32Array | number[];
	/** styleId→[dash, gap] px の平坦配列（256×2・gap 0＝実線） */
	dashTable?: Float32Array | number[];
	/** 点の半径 CSS px（既定 1.5。fid 別は paintTable の radius が優先） */
	ptRadius?: number;
	/** 表示レンジの上書き（データ導出レンジとの積＝下限は max、上限は min） */
	minZoom?: number;
	maxZoom?: number;
	[k: string]: unknown;
}

/** gintユーザー層の搭載オプション（現行v1・単一スロット） */
export interface GintApplyOptions {
	style?: GintDrawStyle;
	/**
	 * この層を描く最小ズーム。未指定＝エンジンがデータ範囲から自動導出（狭域データは 13〜14 等・console に
	 * "[gint] minZoom auto-set" が出る）。**自動導出は線/面（arc）を含むデータのみ**＝点だけのデータは自動なし（ログも出ない）
	 * で z≥7 から描く。指定すれば自動値を上書き（下げられる）。ただし z<7 は世界海岸線と
	 * 交替する（単一スロットの固定閾値＝この値では変えられない）
	 */
	minZoom?: number;
	/** ホバー/クリック識別を有効に（既定 true） */
	interactive?: boolean;
	/** ホバー処理（tip・ハイライト）。false＝オフ（クリックは interactive のまま生きる。既定 true） */
	hover?: boolean;
	/** 地形沿い線（moj 筆など）を自動で立てる */
	drape?: boolean;
	/** ドレープ時も塗りを維持する */
	drapeFill?: boolean;
	/** ホバー tip の整形：properties→行の配列。空配列/null＝tip を出さない。未指定＝全属性を "key: value" で列挙 */
	tip?: (props: Record<string, unknown>) => string[] | null | undefined;
	/** この層だけ塗りの辺数上限を上げる（既定 2M） */
	fillMaxEdges?: number;
	/** 低ズーム帯（z<outlineZoom）の単色ベタ塗りだけ生かす（大規模データの遠景用） */
	lowFill?: boolean;
	/** 焼きが表示束に着地した瞬間の通知（層差し替えで捨てられた場合は呼ばれない） */
	onReady?: () => void;
}

export interface OrthoJapanMap {
	// ---- 基本 ----
	flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): void;
	getZoom(): number;
	readonly view: { center: LonLat; zoom: number; pitch: number; bearing: number; hash: string;[k: string]: unknown };
	destroy(): void;
	readonly mapEl: HTMLElement;
	readonly gadget: Gadgets;

	// ---- 座標変換・フレーム ----
	/** 経緯度→mapEl（canvas）左上原点の CSS px（ページ座標ではない＝pointer を合成するなら getBoundingClientRect を足す）。unprojectXY と同じ座標系。front<0=裏半球 */
	projectLL(lon: number, lat: number): [x: number, y: number, front: number];
	/** canvasローカルCSS座標→経緯度（球外はnull。onClick/setEditClickのx,yと同座標系） */
	unprojectXY(x: number, y: number): LonLat | null;
	/** カメラ状態を1回束ねた投影関数（多点を1フレームで投影する時用） */
	makeProjector(): (lon: number, lat: number) => [x: number, y: number, front: number];
	/** 描画フレーム毎フック。戻り値=解除関数 */
	onFrame(fn: () => void): () => void;
	/** 次フレームの描画を1回点火（オーバレイ更新後に） */
	requestDraw(): void;
	/** クリック横取りスロット（編集アプリ用）。null=解除。クリックvsドラッグ弁別はエンジン側が済ませる */
	setEditClick(fn: ((x: number, y: number) => void) | null): void;
	getHeight(lon: number, lat: number): Promise<number>;
	fitZoomForBbox(bbox: Bbox): number;

	// ---- gint（現行v1の派生アプリ口＝将来v2 addGint()で置換。薄い1モジュールに封じること）----
	/** ユーザー知性層の搭載（単一スロット＝呼ぶたび置換）。pbfは gint ベイク済みであること */
	applyGintData(pbf: GeoPBF, label: string, moveCamera?: boolean, opts?: GintApplyOptions): GeoPBF | null;
	/**
	 * クリック識別（fid・properties・経緯度）。lnglat＝ホバー pick が当たった**カーソル位置**の球面座標であって
	 * フィーチャの座標ではない（点をクリックしても同じ。座標が要るなら properties に持たせる）。クリックはホバーの識別結果に依存する
	 */
	onGintClick(fn: (fid: number, props: Record<string, unknown>, lnglat: LonLat) => void): void;
	/** fid整列のproperties配列（式評価・表直書きの入力。.geojsonは詰めズレするので使わない） */
	gintFeatures(): Array<{ properties: Record<string, unknown> }> | null;
	/** Mapbox風paint式（null=解除） */
	paint(expr: object | null): void;
	/**
	 * fid→スタイル表の直書き。u32レコード=4要素/fid:
	 * [0]=fill RGBA8(r<<24|g<<16|b<<8|a) [1]=line/circle色 [2]=(width*8)<<24|dash<<16|(radius*4)<<8|flags [3]=0。
	 * flags bit0=visible（フィーチャ単位の表示/非表示）
	 * Point は [1]（circle 色・α=0 で既定色）と radius（1/4 CSS px・0=描かない）を使う。線は width（1/8px・0=描かない）。[3]＝予備（0）。
	 * count＝レコード数（fid 数＝gintFeatures().length）。applyGintData() 直後に同期で呼べる（onReady を待つ必要はない）
	 */
	paintTable(u32: Uint32Array, count: number): void;
	/** 地形沿い線化（liftM=null で解除） */
	standupGint(liftM: number | null): Promise<void> | void;
	/** e-Stat/geopbfオーバーレイの手綱 */
	readonly overlay: Record<string, unknown>;
}

/** 1行で地球儀が立ち上がる入口。await 必須 */
export default function orthoJapan(opts?: OrthoJapanOptions): Promise<OrthoJapanMap>;

// ---- geopbf（SDK 同梱・1.0.3〜 named export）----
export interface GeoJSONFeature { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null;[k: string]: unknown }
export interface GeoJSONFeatureCollection { type: "FeatureCollection"; features: GeoJSONFeature[];[k: string]: unknown }
export type GeopbfInput = File | Blob | ArrayBuffer | string | GeoJSONFeatureCollection | GeoJSONFeature | object;
export interface GeopbfOptions {
	/** データ名（キャッシュ鍵・ファイル名の元） */
	name?: string;
	/** false＝gint（GPU 可読トポロジ）を焼かない。既定は焼く */
	gint?: boolean;
	/** 座標の小数桁（既定 6） */
	precision?: number;
	[k: string]: unknown;
}
/** GeoPBF＝geopbf() が返す。主要面のみ型付け（全面は https://www.npmjs.com/package/geopbf） */
export interface GeoPBF {
	readonly features: GeoJSONFeature[];
	readonly geojson: GeoJSONFeatureCollection;
	/** GeoPBF バイナリ（保存・再読込用） */
	readonly arrayBuffer: ArrayBuffer;
	/** gint を焼く。geopbf() は既定で焼き済み＝再呼びは no-op（害なし） */
	gint(opts?: { gint?: boolean; clean?: boolean | object }): Promise<GeoPBF>;
	/** 描画レス識別：点→線→面の優先・面は smallest-wins。許容半径 m（既定 point 50 / polyline 30）。該当なし＝null */
	identifyAt(lng: number, lat: number, opts?: { point?: number; polyline?: number }): number | null;
	/** 点を含む面の fid（smallest-wins）。該当なし＝null */
	contain(lnglat: LonLat): number | null;
	getBbox(): Bbox;
	geopbfFile(opts?: object): Promise<File>;
	geojsonFile(opts?: object): Promise<File>;
	topojsonFile(opts?: object): Promise<File>;
	fgbFile(opts?: object): Promise<File>;
	shapeFile(opts?: object): Promise<File>;
	kmzFile(opts?: object): Promise<File>;
	gmlFile(opts?: object): Promise<File>;
	gpxFile(opts?: object): Promise<File>;
	[k: string]: unknown;
}
/**
 * SDK 同梱・初期化済みの geopbf ローダー。GeoJSON オブジェクト / File / URL / ArrayBuffer（geopbf/geojson/topojson/fgb/
 * shape(zip)/kmz/gpx/gml/moj(zip)/gz）→ GeoPBF。createGeopbf は不要（export していない）。opts を文字列で渡すと name 扱い
 */
export function geopbf(data: GeopbfInput, opts?: GeopbfOptions | string): Promise<GeoPBF>;
