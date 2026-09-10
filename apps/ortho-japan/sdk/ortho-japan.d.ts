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
	/** 配色の焼き付け（"mono"|"dark"|"gsi"|"sepia" または台帳と同形のカスタム）。**指定すると palette ガジェットは載らない**（固定＝切替不可）。
	 *  利用者が切り替えられる初期配色は view の "…/c=dark" で */
	theme?: string | object;
	/** 表示項目の固定。true=常時表示・false=封印・未記述=チップで利用者が選ぶ */
	layers?: Partial<Record<"place" | "terrain" | "rail" | "road" | "facility", boolean>>;
	/** 右上チップ帯の表示（既定true） */
	chips?: boolean;
	/** 下部計器盤。true=全部／配列=選択（"attr"を消すならページ側で出典明記の義務） */
	instruments?: boolean | Array<"pos" | "scale" | "attr" | "log">;
	/** 建物3D（PLATEAU）機能スイッチ。false=関連通信・workerごと停止（既定true） */
	plateau?: boolean;
	/** UI言語（地図中の地名は対象外）。live 切替 API は無い＝変えるなら view: map.view.hash を持って destroy()→再生成 */
	lang?: "ja" | "en";
	/** チルト上限（**ラジアン**）。0=俯瞰固定。共有URLのt=も同上限でクランプ（既定 75°） */
	maxPitch?: number;
	/** 実行時アセット（plateau-sets.json等）の配信ベースURL（既定 "./"＝ページと同じ階層） */
	assetBase?: string;
	/** ページ URL のハッシュに視点を書き続ける（history.replaceState）。埋め込み（target 指定）では既定 false（1.0.4〜）＝SPA のルータを汚さない */
	urlHash?: boolean;
	/** window.__cam 等のデバッグ手を生やす（target 指定時は既定で生えない） */
	debugGlobals?: boolean;
}

/** map.on("plateau") の合図。catalog＝一覧取得（count=収録自治体数）／start＝区の読込開始／done＝完了（描画済み）／cancelled＝視野離脱で中止／failed＝読めない */
export type PlateauEvent =
	| { phase: "catalog"; count: number }
	| { phase: "start" | "done" | "cancelled" | "failed"; name: string; base: string };

/** 右クリックメニュー項目（map.gadget.contextmenu({items})） */
export interface ContextMenuItem {
	name: string;
	/** 任意の HTML（アイコン） */
	icon?: string;
	onClick(c: { lng?: number; lat?: number; x: number; y: number; map: OrthoJapanMap }): void;
}

/** measure/profile の手綱（ガジェットは UI ボタン＝クリックで頂点・ダブルクリック確定・Esc 中断。プログラムからは start/stop） */
export interface PathGadget { (): void; start(): void; stop(): void; open(): void; close(): void; stats(): Record<string, number> }
export interface Gadgets {
	search(opts?: object): unknown;
	zoom(): unknown;
	compass(): unknown;           // 3D（チルト中）のみ表示
	full(): unknown;              // 全画面（ショートカット=Z単キー）
	/** 画面保存（webp・出典焼き込み）。open()＝即保存、composite()＝Blob を返す（引数省略＝今の画面）。
	 *  戻り値は最初の呼び出しで受け取って保持する（二重搭載・モバイル(coarse pointer)では undefined） */
	shot(): { open(): void; composite(snap?: unknown): Promise<Blob> } | undefined;
	measure(): PathGadget;
	profile(): PathGadget;        // 断面図（経路指定→標高プロファイルのグラフ。stats()={points,total,sampled,min,max}）
	/** 右クリックメニュー。既定で「この地点へ寄る／座標をコピー」の 2 項目を持ち、items は**置換**（関数形＝クリック位置ごとに組める）。戻り値＝項目差し替え関数（再搭載時は {setItems}） */
	contextmenu(opts?: { items?: ContextMenuItem[] | ((c: { lng?: number; lat?: number; x: number; y: number; map: OrthoJapanMap }) => ContextMenuItem[]) }): ((items: ContextMenuItem[]) => void) | { setItems(items: ContextMenuItem[]): void };
	legend(): unknown;
	palette(): { open(): void; close(): void };
	hint(): unknown;
	qr(): { open(): void; close(): void };
	print(): { open(): void; close(): void };
	cpos(): unknown;
	/** 建物3D データ管理（先読み/削除）。plateau:false では載らない */
	plateau(): unknown;
	/** GIS ファイルのドラッグ&ドロップ受け口（GeoJSON/Shapefile/KML/GPX/FGB/GML…） */
	dropFile(): unknown;
	/** ホバー tip 箱。戻り値＝setter（rows=文字列の配列・null で消す）。orthoJapan() が自動搭載済み＝呼ぶと同じ setter が返る */
	tip(opts?: object): (rows: string[] | null) => void;
	pop(opts?: object): unknown;
	/** 自作ガジェットの登録（this===map で呼ばれる） */
	(name: string, fn: (this: OrthoJapanMap, ...args: unknown[]) => unknown): void;
	[name: string]: unknown;
}

/** paint() の式（リテラルか Mapbox 風の配列式） */
export type GintExpr = string | number | boolean | unknown[];
/** paint() が受けるキー（fill-* は面、line-* は線/面の輪郭、circle-* は点） */
export interface GintPaint {
	"fill-color"?: GintExpr;
	"fill-opacity"?: GintExpr;
	"line-color"?: GintExpr;
	"line-opacity"?: GintExpr;
	"line-width"?: GintExpr;
	"circle-color"?: GintExpr;
	"circle-radius"?: GintExpr;
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
	 * ＝全ズームで描く。指定すれば自動値を上書き（下げられる）。省メモリ端末（deviceMemory≤4 等）だけは z<minZoom（既定 7）で
	 * 層を眠らせる（通常の端末には効かない）
	 */
	minZoom?: number;
	/** ホバー/クリック識別を有効に（既定 true） */
	interactive?: boolean;
	/** ホバー処理（tip・ハイライト）。false＝オフ（クリックは interactive のまま生きる。既定 true） */
	hover?: boolean;
	/**
	 * 地形沿いの「線」を別描画（standupGint）で立てる＝細い固定幅・色は style.fillColor（paintTable/lineWidth は効かない）。moj 筆向け。
	 * ⚠ この層自体は海面高で描かれ、**チルト時（pitch>約1°）は非表示**＝スタイル付きの線/塗りをチルトでも出すなら drapeFill
	 */
	drape?: boolean;
	/** チルト時もこの層（線・塗り・paintTable のスタイル）を地形の上に描き続ける＝トレイル/区画をチルトで見せる時は true */
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
	/** 現在の視点。pitch/bearing は**ラジアン**（flyTo の tiltDeg/bearingDeg は度）。theme＝現在の配色名。hash＝共有/再生成用の "#z/lat/lon/…" */
	readonly view: { center: LonLat; zoom: number; pitch: number; bearing: number; theme?: string; hash: string;[k: string]: unknown };
	/** 描画バックエンド（初回フレーム前は null） */
	readonly backend: "webgpu" | "webgl2" | null;
	/** イベント購読（戻り値＝map・解除 API は無い）。load＝初回フレーム（登録時に済んでいれば即呼ぶ）／move＝カメラ更新／
	 *  plateau＝建物3D の読込合図（catalog→start→done|cancelled|failed）／click＝gint 多層の照会（v2） */
	on(ev: "load", cb: (e: {}) => void): OrthoJapanMap;
	on(ev: "move", cb: (e: { center: LonLat; zoom: number; pitch: number; bearing: number }) => void): OrthoJapanMap;
	on(ev: "plateau", cb: (e: PlateauEvent) => void): OrthoJapanMap;
	on(ev: "click", cb: (e: { lngLat: LonLat; hits: Array<{ layer: unknown; fid: number }> }) => void): OrthoJapanMap;
	destroy(): void;
	readonly mapEl: HTMLElement;
	readonly gadget: Gadgets;

	// ---- 座標変換・フレーム ----
	/** 経緯度→mapEl（canvas）左上原点の CSS px（ページ座標ではない＝pointer を合成するなら getBoundingClientRect を足す）。unprojectXY と同じ座標系。front<0=裏半球。
	 *  **海面基準**＝チルト時は地形に乗った描画と視差がある（地形込みは makeProjectorH） */
	projectLL(lon: number, lat: number): [x: number, y: number, front: number];
	/** canvasローカルCSS座標→経緯度（球外はnull。onClick/setEditClickのx,yと同座標系） */
	unprojectXY(x: number, y: number): LonLat | null;
	/** カメラ状態を1回束ねた投影関数（多点を1フレームで投影する時用・海面基準） */
	makeProjector(): (lon: number, lat: number) => [x: number, y: number, front: number];
	/** 地形込みの投影（表示中の標高に乗せる）。liftM＝地表からの追加持ち上げ m（0＝地表。標高そのものを渡すと二重に浮く） */
	makeProjectorH(): (lon: number, lat: number, liftM?: number) => [x: number, y: number, front: number];
	/** 描画フレーム毎フック。戻り値=解除関数 */
	onFrame(fn: () => void): () => void;
	/** 次フレームの描画を1回点火（オーバレイ更新後に） */
	requestDraw(): void;
	/** クリック横取りスロット（編集アプリ用。gint の onGintClick より優先）。null=解除。クリックvsドラッグ弁別はエンジン側が済ませる */
	setEditClick(fn: ((x: number, y: number) => void) | null): void;
	/** 標高 m（GSI DEM10B / AW3D30 のタイルを api.ortho-earth.com 経由で取得・粗い格子＝鋭い山頂は低めに出る）。
	 *  1.0.4〜ローダ着荷（数秒）を待って返す（初期化失敗は reject）。1.0.3 以前は未着の間 0 を返す＝>0 になるまで再照会 */
	getHeight(lon: number, lat: number): Promise<number>;
	fitZoomForBbox(bbox: Bbox): number;

	// ---- gint（現行v1の派生アプリ口＝将来v2 addGint()で置換。薄い1モジュールに封じること）----
	/** ユーザー知性層の搭載（単一スロット＝呼ぶたび置換）。pbfは gint ベイク済みであること */
	applyGintData(pbf: GeoPBF, label: string, moveCamera?: boolean, opts?: GintApplyOptions): GeoPBF | null;
	/**
	 * クリック識別（fid・properties・経緯度）。lnglat＝ホバー pick が当たった**カーソル位置**の球面座標であって
	 * フィーチャの座標ではない（点をクリックしても同じ。座標が要るなら properties に持たせる）。クリックはホバーの識別結果に依存する。
	 * 識別（GPU pick）は**海面基準**＝チルトで地形に乗った線とは視差があり当たりにくい（代替＝setEditClick＋makeProjectorH の最近傍、または pbf.identifyAt）。
	 * **非ヒット（海など）では呼ばれない**＝選択解除は mapEl の click ＋ unprojectXY ＋ pbf.contain(ll)===null で組む
	 */
	onGintClick(fn: (fid: number, props: Record<string, unknown>, lnglat: LonLat) => void): void;
	/** fid整列のproperties配列（式評価・表直書きの入力。.geojsonは詰めズレするので使わない） */
	gintFeatures(): Array<{ properties: Record<string, unknown> }> | null;
	/**
	 * Mapbox 風 paint 式で fid スタイル表を組む（null=解除）。評価は呼び出し時に一度だけ（zoom 追随は再呼び）。
	 * 式の演算子サブセット：get has ! all any == != > >= < <= in match step case let var interpolate coalesce
	 * to-number to-string concat zoom geometry-type feature-state + - * / % ^ min max literal。色は #hex / rgb() / rgba()
	 * （名前色は transparent/white/black のみ）。filter＝真偽式（偽の feature は非表示）。
	 * 例：{ "fill-color": ["step", ["get", "pop"], "#eff3ff", 1, "#bdd7e7", 4, "#3182bd"], "fill-opacity": 0.85,
	 *      "line-width": ["case", ["==", ["get", "id"], 13], 3.5, 0.9] }
	 */
	paint(paint: GintPaint | null, filter?: unknown[]): Promise<void>;
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
	/** 全体 bbox [w,s,e,n] */
	readonly bbox: Bbox;
	/** フィーチャ別 bbox の配列 */
	readonly bboxes: Bbox[];
	/** getBbox(i)＝feature i の bbox。引数なし＝全フィーチャの bbox 配列（全体は .bbox） */
	getBbox(i: number): Bbox;
	getBbox(): Bbox[];
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
