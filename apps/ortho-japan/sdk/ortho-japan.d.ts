// ortho-japan SDK 型定義（公開面のみ・手書きの正典）。実装＝apps/ortho-japan/app.js。
// AIエージェント/エディタ補完のための共有語彙＝散文（README/llms.txt）とセットで配布する。
// gint系（applyGintData等）は現行v1の単一スロット口＝将来 map.addGint()（v2）で置換予定。
// 消費側は必ず薄いモジュール1枚に封じること（gint draw spec §10.2）。

export type LonLat = [lon: number, lat: number];
export type Bbox = [w: number, s: number, e: number, n: number];
/** 画面の縁から中身を寄せる余白（CSS px）＝UI パネルに隠れる分（#35） */
export interface PaddingOptions { top: number; right: number; bottom: number; left: number }
/** MapLibre の CameraOptions と同じ意味（角は度）。padding＝中身の中心を寄せる（真俯瞰として解く近似） */
export interface CameraOptions { center?: LonLat | { lng: number; lat: number }; zoom?: number; pitch?: number; bearing?: number; padding?: Partial<PaddingOptions> | number }
export interface FitBoundsOptions { padding?: Partial<PaddingOptions> | number; maxZoom?: number; pitch?: number; bearing?: number; animate?: boolean; linear?: boolean; duration?: number }

/** UI 言語（26 言語・1.1.0〜。1.0.5 以前は ja/en のみ）。ar/fa/ur/he は右横書き（容れ物に dir=rtl）。"ja-JP" 等の地域付きは基底へ寄せる */
export type OrthoJapanLang = "ja" | "en" | "zh" | "ko" | "fr" | "de" | "es" | "pt" | "it" | "nl" | "pl" | "ru" | "uk" | "hu" | "sv" | "tr" | "el" | "id" | "vi" | "th" | "bn" | "hi" | "ar" | "fa" | "ur" | "he";

export interface OrthoJapanOptions {
	/** 埋め込み先（セレクタ or 要素）。idは"map"へ正規化される＝サイズ指定は#idセレクタ禁止 */
	target?: string | HTMLElement;
	/** 初期視点 "#zoom/lat/lon/45t/30r/l=…/c=…"（t=チルト°・r=回転°） */
	view?: string;
	/** 配色の焼き付け（"mono"|"dark"|"gsi"|"sepia" または台帳と同形のカスタム）。**指定すると palette ガジェットは載らない**（固定＝切替不可）。
	 *  利用者が切り替えられる初期配色は view の "…/c=dark" で。theme をここで渡すと view.hash に c= は入らない＝view: map.view.hash で再生成する時は theme も渡し直す */
	theme?: string | object;
	/** 基図を外来の MapLibre style で描く（1.2.0〜・#33）。URL か style の object（?style=<URL> と同じ）。地域の基図・?pm= より優先。
	 *  基図に入るのは style の中のひとつのベクタ source（XYZ・TileJSON・pmtiles://）の fill / line / 点ラベル / background。旧式フィルタ・stops 関数・"{name}" 記法は読み替える。
	 *  style のズームは MapLibre の z（この地図の z−1 が同じ縮尺）として読む。画像（raster source）の層は基図の塗りより上に書かれた物だけ重ねる・geojson source の層は map.addLayer へ。
	 *  描かない層（fill-extrusion・線に沿うラベル・模様・基図の塗りより下の画像）は console に数える。書体（glyphs / text-font）はこの地図の文字で描く */
	style?: string | Record<string, unknown>;
	/** 取得の前の手入れ（1.2.0〜・#37・MapLibre と同名）。基図タイル・3D Tiles・style/TileJSON・sprite は取得ごと、画像タイルはソースごと（型紙で一度）に呼ぶ。
	 *  headers は画像タイル・3D Tiles・基図タイル（PMTiles 以外）に効く */
	transformRequest?: TransformRequestFunction;
	/** 外来の標高タイル（1.2.0〜・#36・MapLibre の terrain と同じ形）。source＝raster-dem の spec。?dem=<型紙>&demenc=&demmax=&demdtm=1 と同じ */
	terrain?: { source: RasterDemSource; exaggeration?: number };
	/** 地域の申告（1.2.0〜）。渡さなければ URL で決まる（既定＝日本・/nl/＝オランダ）。**[] や null＝申告なし**＝
	 *  基図・裸地標高・ラスタ台帳・出典・戻り先・地名検索・施設・鉄道が丸ごと来ない＝世界データだけで描く「globe 仕様」。
	 *  世界の陸の段彩（ハイプソ）・湖・罫線は zoomMax まで出たままになる（地域の基図が入場しないため）。 */
	region?: object | object[] | null;
	/** ズームの上限（既定 20）。データが在る所までしか寄らせない器のため（世界データだけ＝8 が目安）。
	 *  入力（ホイール/ピンチ）・飛行・共有 hash・fit の全経路がこの値に従う。 */
	zoomMax?: number;
	/** 表示項目の固定。true=常時表示・false=封印・未記述=チップで利用者が選ぶ */
	layers?: Partial<Record<"place" | "terrain" | "rail" | "road" | "facility", boolean>>;
	/** 右上チップ帯の表示（既定true） */
	chips?: boolean;
	/** 下部計器盤。true=全部／配列=選択（"attr"を消すならページ側で出典明記の義務） */
	instruments?: boolean | Array<"pos" | "scale" | "attr" | "log">;
	/** 建物3D（建物メッシュ・日本では PLATEAU）機能スイッチ。false=関連通信・workerごと停止（既定true・1.2.0〜） */
	mesh?: boolean;
	/** @deprecated 1.2.0〜 mesh を使う（同じ意味・両方あれば mesh が優先）。次の大版で撤去 */
	plateau?: boolean;
	/** UI言語（地図中の地名は対象外）。live 切替 API は無い＝変えるなら view: map.view.hash を持って destroy()→再生成 */
	lang?: OrthoJapanLang;
	/** チルト上限（**ラジアン**）。0=俯瞰固定。共有URLのt=も同上限でクランプ（既定 75°） */
	maxPitch?: number;
	/** 恒星（stars.6）。false=恒星だけ描かない。惑星・月・星座・太陽系圏は従来どおり（既定true） */
	stars?: boolean;
	/** このページは map.overlay(...) で WebGL2 のオーバーレイを重ねる、の宣言。WebKit（iPadOS/Safari）では
	 *  本体が WebGPU だとその 2 枚目が描かれないため、宣言したページだけ WebGL2 を既定にする（?gpu=1 で破れる） */
	glOverlay?: boolean;
	/** 世界ビュー（z<5.5）のホバー国名 tip。false=出さない（自前の tip と重ねないページ向け。既定true） */
	countryTip?: boolean;
	/** 実行時アセット（plateau-sets.json等）の配信ベースURL（既定 "./"＝ページと同じ階層） */
	assetBase?: string;
	/** ページ URL のハッシュに視点を書き続ける（history.replaceState）。埋め込み（target 指定）では既定 false（1.0.4〜）＝SPA のルータを汚さない */
	urlHash?: boolean;
	/** 矢印キーのカメラ操作（window で受ける）。false＝取らない／関数＝真を返す間だけ取る（背景に置く時にページのスクロールを奪わない。既定 true・1.1.0〜） */
	keyboard?: boolean | (() => boolean);
	/** 前回ビューの保存と復元（localStorage）。false＝読まない・書かない（同じオリジンの本体の「前回の続き」を上書きしない背景用途向け。既定 true・1.1.0〜） */
	persistView?: boolean;
	/** window.__cam 等のデバッグ手を生やす（target 指定時は既定で生えない） */
	debugGlobals?: boolean;
}

/** map.on("mesh")（1.2.0〜・旧名 "plateau"）の合図。catalog＝一覧取得（count=収録自治体数）／start＝区の読込開始／done＝完了（描画済み）／cancelled＝視野離脱で中止／failed＝読めない */
export type MeshEvent =
	| { phase: "catalog"; count: number }
	| { phase: "start" | "done" | "cancelled" | "failed"; name: string; base: string };
/** @deprecated 1.2.0〜 MeshEvent を使う（同じ型）。次の大版で撤去 */
export type PlateauEvent = MeshEvent;

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
	/** 地域の全体へ戻るボタン（1.2.0〜・着地点/顔/札は地域宣言 home・宣言が無い地域＝載らない）。J キー */
	home(): unknown;
	/** @deprecated 1.2.0〜 home() を使う（同じもの）。次の大版で撤去 */
	japan(): unknown;
	qr(): { open(): void; close(): void };
	print(): { open(): void; close(): void };
	cpos(): unknown;
	/** 建物3D データ管理（先読み/削除）。mesh:false では載らない（1.2.0〜・アイコンは地域の宣言＝日本は PLATEAU 公式ロゴ） */
	mesh(): unknown;
	/** @deprecated 1.2.0〜 mesh() を使う（同じもの）。次の大版で撤去 */
	plateau(): unknown;
	/**
	 * GIS ファイルのドラッグ&ドロップ受け口（geopbf() が読める全形式）。受け口は mapEl のみ（ページ他所は自前）。既定＝geopbf(file)→applyGintData
	 * （単一スロット＝最後の 1 枚が勝つ）→カメラ寄せ。onLoad(pbf,file)＝読込成功の通知（1.0.5〜）。loadFile を渡すと既定ローダを置換
	 * （GeoPBF か .length を持つ物を返す・falsy=「読込失敗」表示）。戻り値＝{say,clear,destroy}（二重搭載時は no-op 関数）。mapEl に #dropzone/#drop-toast/#dropclear-btn を生やす
	 */
	dropFile(opts?: { onLoad?(pbf: GeoPBF, file: File): void; loadFile?(file: File): Promise<GeoPBF | { length?: number } | null>; clearGint?(): void }): { say(text: string, sticky?: boolean): void; clear(): void; destroy(): void } | (() => void);
	/** glTF/GLB（3D 模型）を PLATEAU と同じ建物メッシュとして立てる（法線陰影・両面・地形に接地。マテリアル＝baseColor の factor×頂点色×テクスチャ・マテリアルごとに 1 バッチ）。at＝置き場所（省略＝画面中心）／glb に CESIUM_RTC・ECEF が埋まっていればそちらが勝つ。真俯瞰では建物ごと描かれない（fit はチルト付き） */
	model(src: File | string, opts?: { at?: [number, number]; heading?: number; scale?: number; name?: string; fit?: boolean; textures?: boolean }): Promise<{ readonly stats: { vertices: number; triangles: number; instances: number; mode: "anchor" | "rtc" | "ecef"; bbox: [number, number, number, number]; materials: number; textures: number; blended: number } | null; readonly bbox: [number, number, number, number] | null; readonly name: string | null; clear(): void; destroy(): void }>;
	/** 任意ポリゴンの 3D 押し出し（MapLibre の fill-extrusion 相当）。src＝GeoJSON（Feature/FeatureCollection/features 配列）・GeoPBF・File・URL。
	 *  height＝列名 | 定数 | (props)=>メートル（省略＝height / building:height / measuredHeight / 高さ … を自動・階数だけなら ×3m）。
	 *  base＝下端（min_height 相当・省略＝min_height / base_height を自動）。color＝CSS 色 | (props, h)=>CSS 色（省略＝@fill → color → 高さの段彩）。
	 *  scale＝高さの倍率。mask＝足元の基図建物を伏せる（既定 "auto"＝面の中央値が 500m 未満の建物らしいデータの時だけ・市区町村のような広い面では伏せない）。fit＝寄る（既定 true・傾きは今のまま。真俯瞰では建物を描かない＝立体は傾けた時に見える）。
	 *  null を渡すと外す。戻り値＝stats、立つ面が無ければ null。ドロップ/?g= の図形に高さの列があれば自動で立つ（?extrude=0 で止める／?extrude=<列名>[,倍率]）。 */
	extrude(src: GeoJSONFeatureCollection | GeoJSONFeature | GeoJSONFeature[] | File | string | { geojson: GeoJSONFeatureCollection } | FillExtrusionLayer | null, opts?: ExtrudeOptions | FillExtrusionLayer): Promise<{ polygons: number; vertices: number; triangles: number; bbox: [number, number, number, number] } | null>;
	/** スポットライト＝「その国（その面）を指す」。周りを薄い黒で覆い、指した形だけ素の地図を残す。
	 *  src＝ISO 3166-1（"JP"/"JPN"）・国名・Wikidata の ID・それらを束ねた物（ortho-world の on("map") の合図がそのまま入る）、
	 *  または GeoJSON（Feature/FeatureCollection/Geometry）を直に。null で外す。国の形は世界の行政界（Natural Earth）から引く。
	 *  寄り先は一番大きい塊の外接矩形（飛び地は含めない＝本土が見える）。pad＝余白（既定 1.25）／maxZoom＝寄りの上限。 */
	spotlight(src: string | { iso2?: string; iso3?: string; key?: string; qid?: string; ioc?: string; name?: string } | GeoJSONFeatureCollection | GeoJSONFeature | { type: string; coordinates: unknown } | null,
		opts?: { opacity?: number; fit?: boolean; color?: [number, number, number, number]; pad?: number; maxZoom?: number }):
		Promise<{ bbox: [number, number, number, number] | null; name: string | null; iso2: string | null; clear(): void } | null>;
	/** ホバー tip 箱。戻り値＝setter（rows=文字列の配列・null で消す）。orthoJapan() が自動搭載済み＝呼ぶと同じ setter が返る */
	/** ヒートマップ（MapLibre の heatmap 層相当・同一フレームのオーバーレイ＝WebGL2）。src＝点の GeoJSON/GeoPBF/File/URL か層を丸ごと（source つき）。
	 *  paint の意味と既定値は MapLibre どおり（radius 30・weight 1・intensity 1・opacity 1・color は ["heatmap-density"] 0..1 の既定の青→赤）。null で外す */
	heatmap(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | HeatmapLayer | null, layer?: Omit<HeatmapLayer, "type" | "source">): Promise<{ points: number } | null>;
	/** 点の集約（MapLibre の cluster 相当・canvas2D のオーバーレイ）。src＝点のデータか MapLibre の source（{ type:"geojson", data, cluster:true, clusterRadius, clusterMaxZoom }）。
	 *  集約の属性＝cluster / point_count / point_count_abbreviated。丸のクリック＝ばらけるズームへ寄る。queryRenderedFeatures の点の問い合わせに "clusters"/"unclustered-point" で出る */
	cluster(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | { type: "geojson"; data: GeoJSONFeatureCollection | string; cluster?: boolean; clusterRadius?: number; clusterMaxZoom?: number } | null, opts?: ClusterOptions): Promise<{ points: number; clusters: number[] } | null>;
	/** 日影のボタンとパネル（日影図／その時刻の影・測定面 1.5/4/6.5m）＝map.sunShadow の UI */
	sunshadow(opts?: { zoom?: [number, number]; narrow?: boolean }): void;
	viewshed(opts?: { zoom?: [number, number]; narrow?: boolean }): void;
	/** 任意の 3D Tiles（map.add3DTiles と同じ）。null＝全部（opts.id＝その 1 つ）を外す */
	tiles3d(url: string | null, opts?: Tiles3DOptions): Promise<Tiles3DHandle | null>;
	/** 記号の層（MapLibre の symbol 層：icon-image/-size/-rotate/-anchor/-offset/-allow-overlap/-color（SDF）・text-field/-size/-anchor/-offset/-color/-halo・symbol-sort-key）。null＋{id} で外す */
	symbols(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | ({ type: "symbol" } & Omit<MapLibreLayer, "type">) | null, layer?: Partial<MapLibreLayer>): Promise<{ features: number } | null>;
	tip(opts?: object): (rows: string[] | null) => void;
	pop(opts?: object): unknown;
	/** 自作ガジェットの登録（this===map で呼ばれる） */
	(name: string, fn: (this: OrthoJapanMap, ...args: unknown[]) => unknown): void;
	[name: string]: unknown;
}

/** paint() の式（リテラルか Mapbox 風の配列式） */
export type GintExpr = string | number | boolean | unknown[];
/** paint() が受けるキー（fill-* は面、line-* は線/面の輪郭、circle-* は点） */
/** paint() のキー。表の色欄は fill と line/circle の 2 つ＝circle-color は点（Point/MultiPoint）に、line-color は線/面の輪郭に使われる
 *  （1.0.5〜ジオメトリで選ぶ。1.0.4 以前は line-color があると circle-color が無視された）。["geometry-type"] 式も 1.0.5〜有効 */
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

export type RasterSpec =
	| { url: string; tileSize?: number; minZoom?: number; maxZoom?: number; bbox?: Bbox; attribution?: string; subdomains?: string[]; tms?: boolean; headers?: Record<string, string>; name?: string;
		/** 色調整（1.2.0〜・#39・MapLibre の raster-hue-rotate / -saturation / -contrast / -brightness-min / -max と同じ意味）。addLayer の raster 層は paint から自動で作る */
		adjust?: { hueRotate?: number; saturation?: number; contrast?: number; brightnessMin?: number; brightnessMax?: number } }
	| { pmtiles: string; name?: string; attribution?: string }
	/** WMS（1.2.0〜・#45）＝GetMap を画面のタイルに割る（EPSG:3857）。url に {bbox-epsg-3857} を直に書いた XYZ 形でも可（MapLibre と同じ記法） */
	| { wms: { url: string; layers: string; styles?: string; format?: string; transparent?: boolean; version?: "1.3.0" | "1.1.1"; params?: Record<string, string> }; minZoom?: number; maxZoom?: number; bbox?: Bbox; attribution?: string; name?: string }
	/** WMTS（#45）＝capabilities（GetCapabilities の URL）を読むか、KVP を手で（url・layer・tileMatrixSet）。ウェブメルカトルの行列だけ描ける。REST の型紙は url に {TileMatrix}/{TileRow}/{TileCol} を書いて XYZ 形で渡してもよい */
	| { wmts: { capabilities: string; layer?: string; style?: string; format?: string } | { url: string; layer: string; tileMatrixSet: string; style?: string; format?: string; matrixIds?: string[] }; minZoom?: number; maxZoom?: number; attribution?: string; name?: string }
	| { file: File; table?: string; name?: string; attribution?: string }
	| { port: MessagePort; name?: string; attribution?: string }
	| { image: Blob | ImageBitmap; corners: [LonLat, LonLat, LonLat, LonLat]; name?: string };
export interface RasterOptions { order?: "under" | "over"; opacity?: number; visible?: boolean; hideFills?: boolean; minZoom?: number; maxZoom?: number }
export interface RasterInfo { id: string; kind: string; tileSize: number; minZoom: number; maxZoom: number; bbox: Bbox | null; attribution: string | null; name: string | null; order: "under" | "over"; opacity: number; hideFills: boolean }
export interface RasterAPI {
	/** 足す（同じ id は置き換え）。戻り値＝ソースの自己申告（タイル寸・ズーム域・範囲・出典） */
	add(id: string, spec: RasterSpec, opts?: RasterOptions): Promise<RasterInfo>;
	remove(id: string): boolean;
	/** 表示の変更（不透明度・重ね順・表示/非表示） */
	set(id: string, opts: RasterOptions): boolean;
	list(): Array<{ id: string; info: RasterInfo | null; spec: RasterSpec; opts: RasterOptions; error: string | null }>;
	info(id: string): RasterInfo | null;
	onChange(cb: () => void): () => void;
	/** 地域パックのカタログ（基図＝1 枚のラジオ・重ね＝トグル）。?r= と同期 */
	select(catalogId: string | null): Promise<RasterInfo | null>;
	toggle(catalogId: string, on?: boolean): Promise<boolean>;
}

/** 式（MapLibre style expression の部分集合：get has ! all any == != > >= < <= in match step case let var interpolate coalesce to-number to-string concat zoom geometry-type + - * / % ^ min max literal） */
export type StyleExpression = unknown[] | number | string | boolean;
export interface ExtrudeOptions { height?: string | number | ((props: Record<string, unknown>) => number); base?: string | number | ((props: Record<string, unknown>) => number); color?: string | ((props: Record<string, unknown>, height: number) => string); scale?: number; mask?: boolean | "auto"; fit?: boolean;
	/** 床の高さ[m]＝その高さの平面に浮かせる（1.2.0〜・高さはその平面から測る）。"drape"＝地形に沿わせる。無指定＝広い面（統計）は 2000m の平面・建物らしい小さい面は接地 */
	bottom?: number | "drape" }
/** MapLibre の fill-extrusion 層をそのまま（extrude の第 2 引数、または source つきで第 1 引数に）。意味・既定値は MapLibre の仕様どおり（height/base 0・color "#000000"・opacity 1）。
 *  式は呼んだ時に一度評価（["zoom"] はその時のズーム）。color の interpolate は色として補間。legacy filter（["==","key",v] の旧式）は非対応＝現代式で */
export interface FillExtrusionLayer extends Omit<ExtrudeOptions, "height" | "base" | "color"> {
	type: "fill-extrusion"; id?: string;
	source?: { type: "geojson"; data: GeoJSONFeatureCollection | string } | GeoJSONFeatureCollection;
	paint: { "fill-extrusion-height"?: StyleExpression; "fill-extrusion-base"?: StyleExpression; "fill-extrusion-color"?: StyleExpression; "fill-extrusion-opacity"?: number };
	filter?: StyleExpression;
}

export interface HeatmapLayer { type: "heatmap"; id?: string; source?: { type: "geojson"; data: GeoJSONFeatureCollection | string } | GeoJSONFeatureCollection; minzoom?: number; maxzoom?: number;
	paint?: { "heatmap-radius"?: StyleExpression; "heatmap-weight"?: StyleExpression; "heatmap-intensity"?: StyleExpression; "heatmap-color"?: StyleExpression; "heatmap-opacity"?: number } }
export interface CirclePaint { "circle-color"?: StyleExpression; "circle-radius"?: StyleExpression; "circle-stroke-color"?: StyleExpression; "circle-stroke-width"?: StyleExpression; "circle-opacity"?: StyleExpression }
export interface ClusterOptions { clusterRadius?: number; clusterMaxZoom?: number; paint?: CirclePaint; unclustered?: { paint?: CirclePaint }; text?: { color?: string; size?: number } }
export type MapLibreSource =
	| { type: "geojson"; data: GeoJSONFeatureCollection | string; cluster?: boolean; clusterRadius?: number; clusterMaxZoom?: number }
	| { type: "image"; url: string; coordinates: [LonLat, LonLat, LonLat, LonLat] }
	| { type: "raster"; tiles?: string[]; url?: string; tileSize?: number; minzoom?: number; maxzoom?: number; bounds?: Bbox; attribution?: string };
export interface MapLibreLayer { id: string; type: "fill" | "line" | "circle" | "symbol" | "fill-extrusion" | "heatmap" | "raster"; source: string | MapLibreSource; filter?: StyleExpression; minzoom?: number; maxzoom?: number; layout?: Record<string, StyleExpression>; paint?: Record<string, StyleExpression> }
export interface QueryOptions { layers?: string[]; filter?: StyleExpression; tolerance?: number }
/** 外来の標高タイル（MapLibre の raster-dem 相当・#36）。encoding＝terrarium｜mapbox（MapLibre の既定）｜gsi（地理院 PNG 標高タイル）。
 *  地形の段 R01（1°）・R10（10°）のセルを、DEM が有効な画素だけ上書きする（アトラスは 1°あたり最大 1024 px＝見た目の細かさは約 100m 格子のまま）。
 *  1 点の標高（getHeight・断面図）は DEM の最大ズームを直に読む＝細かい DEM が効く。dtm:true＝裸地の申告＝地域の申告が無い所ではこの範囲で建物を地面へ持ち上げる */
export interface RasterDemSource { tiles?: string[]; url?: string; encoding?: "terrarium" | "mapbox" | "gsi"; tileSize?: number; minzoom?: number; maxzoom?: number; bounds?: Bbox; dtm?: boolean; cellZoom?: number }
export type ResourceType = "Style" | "Source" | "Tile" | "SpriteJSON" | "SpriteImage" | "Image" | "Unknown";
export type TransformRequestFunction = (url: string, resourceType: ResourceType) => { url?: string; headers?: Record<string, string>; credentials?: RequestCredentials } | undefined | null;
export type ProtocolLoader = (params: { url: string; type: "arrayBuffer" | "json" | "image" | "string"; headers?: Record<string, string> }, abortController: AbortController) => Promise<{ data: ArrayBuffer | ArrayBufferView | Blob | string | object | null }>;
export interface Tiles3DOptions { id?: string; maxSSE?: number; heightOffset?: number; ground?: "absolute" | "terrain"; pointSize?: number; textures?: boolean; fit?: boolean }
export interface Tiles3DHandle { id: string; readonly stats: { loaded: number; shown: number; failed: number; triangles: number; points: number; bytes: number; gpuMB: number; inflight: number }; readonly bbox: Bbox | null; remove(): void; setVisible(v: boolean): void; setOptions(o: Partial<Tiles3DOptions>): void }
export interface LayerMouseEvent { type: string; point: { x: number; y: number }; lngLat: { lng: number; lat: number } | null; features: RenderedFeature[]; originalEvent: PointerEvent | MouseEvent; target: OrthoJapanMap }
export interface RenderedFeature { type: "Feature"; id?: number | string; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null; layer: { id: string; type: string; "source-layer"?: string }; sourceLayer?: string; source: "basemap" | "user" | "extrude" | "image" | "cluster" | "symbols" | (string & {}); expansionZoom?: number }

export interface OrthoJapanMap {
	// ---- 基本 ----
	/** 飛行（度）。戻り値＝着地または cancel で解決する Promise（1.0.5〜。以前は void＝on("move") の無音で判定していた）。静止の合図は on("settle") */
	flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): Promise<void>;
	/** MapLibre の形の飛行（1.2.0〜・#35）。省略した項目は今の値。animate:false＝jumpTo と同じ */
	flyTo(options: CameraOptions & { animate?: boolean }): Promise<void>;
	/** 即座に移る（MapLibre 同名・角は度） */
	jumpTo(options: CameraOptions): OrthoJapanMap;
	/** 全項目を一本の緩急で同時に動かす（MapLibre 同名）。duration 既定 500ms。着地（または中断）で解決 */
	easeTo(options: CameraOptions & { duration?: number; animate?: boolean }): Promise<void>;
	/** bbox が収まる所へ（MapLibre 同名）。west>east＝±180 跨ぎ。linear:true＝easeTo・既定＝flyTo・animate:false＝jumpTo */
	fitBounds(bounds: Bbox | [LonLat, LonLat], options?: FitBoundsOptions): Promise<void>;
	/** fitBounds が向かうカメラ（動かさない） */
	cameraForBounds(bounds: Bbox | [LonLat, LonLat], options?: FitBoundsOptions): (Required<Pick<CameraOptions, "center" | "zoom" | "pitch" | "bearing">> & { padding: PaddingOptions }) | null;
	/** 既定の padding（以後の jumpTo/easeTo/flyTo/fitBounds の中身の中心）。数値＝四辺同じ */
	setPadding(padding: PaddingOptions | number): OrthoJapanMap;
	getPadding(): PaddingOptions;
	/** 中心の可動域。null で解除。west>east＝±180 跨ぎ。入力・飛行・URL 復元のどれで動いても締まる */
	setMaxBounds(bounds: Bbox | [LonLat, LonLat] | null): OrthoJapanMap;
	getMaxBounds(): Bbox | null;
	setMinZoom(zoom: number | null): OrthoJapanMap;
	getMinZoom(): number;
	/** 寄りの上限（起動時の zoomMax を超えない）。null＝起動時の上限へ */
	setMaxZoom(zoom: number | null): OrthoJapanMap;
	getMaxZoom(): number;
	getCenter(): { lng: number; lat: number };
	/** 度（map.view.pitch はラジアン） */
	getPitch(): number;
	/** 度（map.view.bearing はラジアン） */
	getBearing(): number;
	setCenter(center: LonLat | { lng: number; lat: number }): OrthoJapanMap;
	setZoom(zoom: number): OrthoJapanMap;
	setPitch(pitchDeg: number): OrthoJapanMap;
	setBearing(bearingDeg: number): OrthoJapanMap;
	/** 見えている範囲の概算 [w,s,e,n]（画面の四隅と辺の中点の逆投影）。球の縁が画面に入る時は null */
	getBounds(): Bbox | null;
	isMoving(): boolean;
	/** 飛行・easeTo を止める */
	stop(): OrthoJapanMap;
	getZoom(): number;
	/** 現在の視点。pitch/bearing は**ラジアン**（flyTo の tiltDeg/bearingDeg は度）。theme＝現在の配色名。hash＝共有/再生成用の "#z/lat/lon/…" */
	readonly view: { center: LonLat; zoom: number; pitch: number; bearing: number; theme?: string; hash: string;[k: string]: unknown };   // 未記載のキー（sky/eye 等）は内部用＝使わない
	/** UI 文言の訳（英語キー → 表示言語・$1… は args で埋める）。SDK が読んだ辞書で引く（1.2.0〜） */
	t(key: string, ...args: Array<string | number>): string;
	/** 表示言語コード（ja/en/…・1.2.0〜） */
	readonly lang: string;
	/** 描画バックエンド（初回フレーム前は null） */
	readonly backend: "webgpu" | "webgl2" | null;
	/** イベント購読（戻り値＝map・解除 API は無い）。load＝初回フレーム（登録時に済んでいれば即呼ぶ）／move＝カメラ更新／
	 *  mesh＝建物3D の読込合図（1.2.0〜・旧名 plateau も同じ合図を受ける）（catalog→start→done|cancelled|failed）／click＝gint 多層の照会（v2） */
	on(ev: "load", cb: (e: {}) => void): OrthoJapanMap;
	on(ev: "move", cb: (e: { center: LonLat; zoom: number; pitch: number; bearing: number }) => void): OrthoJapanMap;
	on(ev: "mesh", cb: (e: MeshEvent) => void): OrthoJapanMap;
	/** @deprecated 1.2.0〜 "mesh" を使う（同じ合図）。次の大版で撤去 */
	on(ev: "plateau", cb: (e: MeshEvent) => void): OrthoJapanMap;
	on(ev: "click", cb: (e: { lngLat: LonLat; hits: Array<{ layer: unknown; fid: number }> }) => void): OrthoJapanMap;
	/** 層ごとのイベント（MapLibre 同名・1.2.0〜・#34）。layerId＝addLayer の層 id か基図の層 id（配列可）。click はドラッグを除く・mousemove は rAF に畳む */
	on(ev: "click" | "mousemove" | "mouseenter" | "mouseleave", layerId: string | string[], cb: (e: LayerMouseEvent) => void): OrthoJapanMap;
	off(ev: "click" | "mousemove" | "mouseenter" | "mouseleave", layerId: string | string[], cb: (e: LayerMouseEvent) => void): OrthoJapanMap;
	/** 一度だけ。cb 省略＝Promise */
	once(ev: string, layerIdOrCb?: string | string[] | ((e: any) => void), cb?: (e: any) => void): OrthoJapanMap | Promise<any>;
	/** カメラ静止（移動が 150ms 止まった時・1.0.5〜）。ツアー/オーバレイの「止まった」合図 */
	on(ev: "settle", cb: (e: { center: LonLat; zoom: number; pitch: number; bearing: number; hash: string }) => void): OrthoJapanMap;
	/** 購読解除（1.0.5〜） */
	off(ev: string, cb: (e: any) => void): OrthoJapanMap;
	destroy(): void;
	readonly mapEl: HTMLElement;
	readonly gadget: Gadgets;

	// ---- 座標変換・フレーム ----
	/** 経緯度→mapEl（canvas）左上原点の CSS px（ページ座標ではない＝pointer を合成するなら getBoundingClientRect を足す）。unprojectXY と同じ座標系。
	 *  front<0＝**見えない**（裏半球ではなく「現在のカメラ高度の地平線より外」＝チルト時は数°先でも負）。見えない点の x,y は**地平線（可視キャップの縁）へ射影クランプした位置**
	 *  ＝塗りの経路はそのまま結んでよい（可視部＋地平線沿いで閉じる）。線は符号で切る。カメラ後方など写せない時だけ [0,0,-1]。
	 *  front の絶対値は未正規化＝符号だけ使う。**海面基準**＝チルト時は地形に乗った描画と視差がある（地形込みは makeProjectorH） */
	projectLL(lon: number, lat: number): [x: number, y: number, front: number];
	/** canvasローカルCSS座標→経緯度（球外はnull。onClick/setEditClickのx,yと同座標系） */
	unprojectXY(x: number, y: number): LonLat | null;
	/** カメラ状態を1回束ねた投影関数（多点を1フレームで投影する時用・海面基準） */
	makeProjector(): (lon: number, lat: number) => [x: number, y: number, front: number];
	/** 地形込みの投影。標高は 100m 格子のメモから引く＝**その地点の初回は 0（海面）で、非同期に取得して次フレームから乗る**（毎フレーム呼ぶ
	 *  DOM マーカー用途向け。1 回きりの呼び出しには乗らない）。liftM＝地表からの追加持ち上げ m（0＝地表。標高を渡すと二重に浮く） */
	makeProjectorH(opts?: { terrain?: boolean }): (lon: number, lat: number, liftM?: number) => [x: number, y: number, front: number];   // liftM<0＝地中。terrain:false＝地形リフト無し（海面球＋liftM）＝**数百点以上を毎フレーム投影する overlay は必ずこちら**（既定の地形リフトは点ごとに標高照会を起こす）
	/** 描画フレーム毎フック（戻り値=解除関数）。**描画はオンデマンド＝静止中は呼ばれない**。オーバレイを載せた/更新した直後は requestDraw() で 1 フレーム点火する */
	onFrame(fn: () => void): () => void;
	/** 次フレームの描画を1回点火（オーバレイ更新後に） */
	requestDraw(): void;
	/** 同一フレームのオーバーレイ：レンダーワーカー内で地球・注記と同じフレーム・同じカメラで描く自前 canvas（main の onFrame は 1〜2 フレーム先行する）。
	 *  url＝worker が import() する依存ゼロのモジュール { init(canvas, opts), message(data), frame(cam, camState, {w,h}) → boolean, destroy() }。
	 *  戻り値の post(data, transfer) で状態やデータを渡す（描画要求を兼ねる）。remove() で外す */
	overlay(src: string | { builtin: string }, opts?: { name?: string; opts?: Record<string, unknown>; above?: boolean }): { name: string; el: HTMLCanvasElement; onmessage: ((data: unknown) => void) | null; post(data: unknown, transfer?: Transferable[]): void; remove(): void };
	/** 不透明度（0..1）。base＝紙と線（塗り/線）・globe＝球体（globe/terrain/海面下/湖/夜面）。表示パネル「基図」スライダーは両方を一緒に動かす。globe<1 で地中に置いた overlay（makeProjectorH の負の高さ）が透けて見える */
	setOpacity(o: { base?: number; globe?: number }): void;
	/** クリック横取りスロット（編集アプリ用。gint の onGintClick より優先）。null=解除。クリックvsドラッグ弁別はエンジン側が済ませる */
	setEditClick(fn: ((x: number, y: number) => void) | null): void;
	/** 標高 m（GSI DEM10B / AW3D30 のタイルを api.ortho-earth.com 経由で取得・粗い格子＝鋭い山頂は低めに出る）。
	 *  1.0.4〜ローダ着荷（数秒）を待って返す（初期化失敗は reject）。1.0.3 以前は未着の間 0 を返す＝>0 になるまで再照会 */
	getHeight(lon: number, lat: number): Promise<number>;
	fitZoomForBbox(bbox: Bbox): number;
	/** 画像タイル層（ラスタ）。地形へドレープされる（地面の塗りと同じ合成）。order:"under"＝基図（塗りを伏せる）／"over"＝重ね（線と注記は上に残る）。
	 *  spec＝XYZ テンプレ｜ラスタ PMTiles｜ローカル容器（.gpkg/.mbtiles）｜外部プロバイダの MessagePort｜**四隅で貼る画像**（MapLibre の image source 相当・1.1〜）。
	 *  四隅の順＝左上→右上→右下→左下（[lon,lat]）＝射影変換で貼る（台形も歪まない）。geoedit の @image（4 頂点の面）と同じ表し方。戻り値＝ソースの自己申告 */
	raster: RasterAPI;
	/** 記号帳（MapLibre の addImage 相当）。img＝ImageBitmap/HTMLImageElement/Blob/URL/{width,height,data}。sdf＝icon-color で塗れる記号 */
	addImage(name: string, img: ImageBitmap | HTMLImageElement | HTMLCanvasElement | Blob | string | { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, opts?: { pixelRatio?: number; sdf?: boolean }): Promise<unknown>;
	removeImage(name: string): void;
	hasImage(name: string): boolean;
	listImages(): string[];
	/** MapLibre の sprite を丸ごと記号帳へ（base.json＋base.png・高解像度画面は base@2x.*）。戻り値＝足した記号の数 */
	loadSprite(base: string): Promise<number>;
	/** MapLibre の addSource／addLayer をそのまま（source＝geojson（cluster 可）/image/raster・layer.type＝fill/line/circle/symbol/fill-extrusion/heatmap/raster。fill-pattern/line-pattern＝記号帳の画像を敷き詰め）。
	 *  どの種類も何枚でも持てる（1.2.0〜・#34）：fill/line/circle＝source ごとに gint の追加層・押し出し/ヒートマップ＝層ごと・集約＝source ごと。
	 *  重ね順（beforeId・moveLayer）は同じ描き方の中で効く。描き方の違う層の上下は描画の段で決まる（下から 基図→画像→gint→押し出し→ヒートマップ→集約→記号→模様）。
	 *  式は呼んだ時に評価（symbol の zoom 式は止まるたび）。removeSource は使われている間は投げる（MapLibre と同じ） */
	addSource(id: string, source: MapLibreSource): OrthoJapanMap;
	getSource(id: string): (MapLibreSource & { setData(data: GeoJSONFeatureCollection | string): Promise<void> }) | undefined;
	removeSource(id: string): OrthoJapanMap;
	isSourceLoaded(id: string): boolean;
	addLayer(layer: MapLibreLayer, beforeId?: string): Promise<unknown>;
	getLayer(id: string): MapLibreLayer | undefined;
	/** 利用者の層（登録順＝下から） */
	getLayers(): MapLibreLayer[];
	removeLayer(id: string): OrthoJapanMap;
	/** 重ね順を変える（beforeId の下へ・省略＝一番上）。同じ描き方の中で効く */
	moveLayer(id: string, beforeId?: string): OrthoJapanMap;
	/** paint の性質を変える（gint の層は fid 表の書き換えだけ＝安い・raster-opacity は即時）。undefined＝既定へ */
	setPaintProperty(id: string, name: string, value: StyleExpression | undefined): OrthoJapanMap;
	getPaintProperty(id: string, name: string): StyleExpression | undefined;
	/** layout の性質を変える。visibility:"none"｜"visible" で出し入れ（層は残る） */
	setLayoutProperty(id: string, name: string, value: StyleExpression | undefined): OrthoJapanMap;
	getLayoutProperty(id: string, name: string): StyleExpression | undefined;
	setFilter(id: string, filter: StyleExpression | null): OrthoJapanMap;
	getFilter(id: string): StyleExpression | undefined;
	setLayerZoomRange(id: string, minzoom: number, maxzoom: number): OrthoJapanMap;
	/** feature-state（MapLibre 同名）。id＝その source の地物の番号（GeoJSON の並び順）。効くのは fill/line/circle の paint の ["feature-state", key]。基図の地物には効かない */
	setFeatureState(feature: { source: string; id: number | string }, state: Record<string, unknown>): OrthoJapanMap;
	removeFeatureState(feature: { source: string; id?: number | string }, key?: string): OrthoJapanMap;
	/** MapLibre の style の形（version 8）。layers＝基図の層（外来 style ならその source 名・地域の基図は "basemap"・読むだけ）の上に利用者の層 */
	getStyle(): { version: 8; sources: Record<string, unknown>; layers: Array<MapLibreLayer | Record<string, unknown>> };
	/** 任意の 3D Tiles を画面上の誤差で流す（1.2.0〜・#41）。url＝tileset.json（?tiles3d=<URL> と同じ）。
	 *  中身＝b3dm・i3dm・pnts（点群）・cmpt・glb/glTF（3D Tiles 1.1）・外部 tileset。refine REPLACE（子が揃うまで親）/ ADD。GPU 予算を超えたら使っていないタイルから捨てる。
	 *  高さ＝既定は tileset の高さのまま（写真測量・点群）。建物の tileset は ground:"terrain"＝1 棟ずつ地面へ接地。点群は同一フレームのオーバーレイ（深度は共有しない＝#47）。
	 *  未対応＝implicit tiling・メタデータとスタイル・API キーの要る配信 */
	add3DTiles(url: string, opts?: Tiles3DOptions): Promise<Tiles3DHandle>;
	/** I3S（ArcGIS の Indexed 3D Scene Layer・1.2.0〜・#48）を 3D Tiles と同じ選び・同じ GPU 経路で流す。url＝…/SceneServer か …/SceneServer/layers/N（?i3s=<URL> と同じ）。
	 *  nodepages 形式（I3S 1.6 以降）の 3D Object / IntegratedMesh。lodScale＞1 で粗く。点群と旧形式は未対応。解読は @loaders.gl/i3s（MIT） */
	addI3S(url: string, opts?: Tiles3DOptions & { lodScale?: number; token?: string }): Promise<{ id: string; name: string | null; copyright: string | null; readonly stats: Tiles3DHandle["stats"]; remove(): void; setVisible(v: boolean): void; setOptions(o: Partial<Tiles3DOptions> & { lodScale?: number }): void }>;
	/** 日影（1.2.0〜・#44）。建物（既定＝地域の建物台帳＝日本は PLATEAU・tilesets で任意の 3D Tiles）の影を測定面へ投影し、地面に画像として貼る（map.raster の "sunshadow"）。
	 *  mode "duration"＝日影図（既定＝冬至・真太陽時 8〜16 時・30 分刻みで日影になる時間の段彩と 2〜5 時間の境線）／"instant"＝date の時刻の影。範囲＝既定は画面に見えている所（一辺 3km まで）。
	 *  probe＝指定地点の日影時間（時・instant は 0|1）。ボタンとパネルは map.gadget.sunshadow() */
	sunShadow(opts?: { mode?: "duration" | "instant"; date?: Date | string; planeH?: number; hours?: [number, number]; step?: number; decl?: number; bbox?: Bbox; tilesets?: string[]; probe?: LonLat[] }): Promise<{ triangles: number; tiles: number; steps: number; maxHours: number; decl: number; planeH: number; mode: string; probes: number[] }>;
	/** 可視域（1.2.0〜・#44）。observer（既定＝画面の中心）に目の高さ eyeH（m・既定 1.6）で立ち、半径 radius（m・既定 1000・最大 5000）の中で高さ targetH（m）の点が見えるか。
	 *  地表＝地形（setTerrain の DEM があればそれ）＋建物（buildings:false で地形だけ・tilesets で任意の 3D Tiles）・地球の丸みと大気の屈折（k＝0.13）込み。
	 *  結果は地面に画像として貼る（map.raster の "viewshed"＝見える所が緑）。probe＝指定地点が見えるか（1|0）。ボタンとパネルは map.gadget.viewshed() */
	viewshed(opts?: { observer?: LonLat; eyeH?: number; targetH?: number; radius?: number; buildings?: boolean; tilesets?: string[]; cell?: number; probe?: LonLat[] }): Promise<{ cells: number; visibleRatio: number; triangles: number; eyeZ: number; cell: number; probes: number[] }>;
	/** 見通し線（1.2.0〜・#44）。a（視点・高さ eyeH）から b（目標・高さ targetH）が見えるか。遮る最初の点 blockAt・距離（m）・断面 profile（[距離, 地表, 視線] m）。
	 *  地図に線を引く（source/layer "los"＝見える区間が緑・遮られた先が赤） */
	lineOfSight(a: LonLat, b: LonLat, opts?: { eyeH?: number; targetH?: number; buildings?: boolean; tilesets?: string[]; cell?: number }): Promise<{ visible: boolean; blockAt: LonLat | null; distance: number; profile: [number, number, number][]; triangles: number }>;
	/** 可視域の画像と見通し線を消す */
	clearViewshed(): Promise<void>;
	/** import しなくても使える Marker / Popup（new map.Marker().setLngLat(…).addTo(map)） */
	/** 標高を外来の DEM に（MapLibre 同名・#36）。source＝addSource した raster-dem の id か spec。null＝既定の標高へ。exaggeration は受け流す（地形は誇張しない） */
	setTerrain(terrain: { source: string | RasterDemSource; exaggeration?: number } | null): Promise<OrthoJapanMap>;
	getTerrain(): { source: RasterDemSource; exaggeration: 1 } | null;
	/** 以後の取得に効く transformRequest（MapLibre 同名）。null で外す */
	setTransformRequest(fn: TransformRequestFunction | null): OrthoJapanMap;
	/** 独自スキーム（"myscheme://…"）の取得を関数に任せる（大域・export の addProtocol と同じ） */
	addProtocol(scheme: string, loader: ProtocolLoader): void;
	removeProtocol(scheme: string): void;
	/** 同じ手入れ（transformRequest・addProtocol）で取る fetch（部品・アプリ用） */
	fetchResource(url: string, type?: ResourceType, init?: RequestInit): Promise<Response | { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; blob(): Promise<Blob> }>;
	readonly Marker: typeof Marker;
	readonly Popup: typeof Popup;
	/** 基図の style を生き替える（opts.style で起動した地図だけ・地域の基図で起動した地図では投げる）。解決＝新しい style の基図が描き始めた後 */
	setStyle(style: string | Record<string, unknown>): Promise<OrthoJapanMap>;
	/** 描画結果への問い合わせ（MapLibre の queryRenderedFeatures 相当）。geometry＝省略（画面全体）｜[x,y]（CSS px）｜[[x0,y0],[x1,y1]]（箱）。
	 *  返り値は上に描かれたものから：四隅の画像（layer.id "img:<n>"）→押し出し（addLayer の層 id・ガジェット直呼びは "extrude"）→addLayer の fill/line/circle（層 id・source＝source id）→利用者の図形（"user"）→基図（スタイルの層 id・属性つき）。
	 *  layers に基図の層が無ければ基図のタイルは取り直さない（層ごとのイベントが軽い）。
	 *  MapLibre と違い**非同期**（描いている基図タイルを取り直して今のスタイルで当てる・キャッシュ命中で ~1ms）。箱は外接箱の重なりで判定 */
	queryRenderedFeatures(geometry?: [number, number] | [[number, number], [number, number]] | QueryOptions, opts?: QueryOptions): Promise<RenderedFeature[]>;

	// ---- gint（現行v1の派生アプリ口＝将来v2 addGint()で置換。薄い1モジュールに封じること）----
	/** ユーザー知性層の搭載（単一スロット＝呼ぶたび置換）。pbfは gint ベイク済みであること */
	/** ユーザー知性層の搭載（単一スロット＝呼ぶたび置換・null＝スロットを空に）。複数データは fid 空間で合成（各 .geojson.features に一意キーを足して 1 本に再エンコード）。pbf は gint ベイク済みであること */
	applyGintData(pbf: GeoPBF | null, label: string, moveCamera?: boolean, opts?: GintApplyOptions): GeoPBF | null;
	/**
	 * クリック識別（fid・properties・経緯度）。lnglat＝ホバー pick が当たった**カーソル位置**の球面座標であって
	 * フィーチャの座標ではない（点をクリックしても同じ。座標が要るなら properties に持たせる）。クリックはホバーの識別結果に依存する。
	 * 識別（GPU pick）は**海面基準**＝チルトで地形に乗った線とは視差があり当たりにくい（代替＝setEditClick＋makeProjectorH の最近傍、または pbf.identifyAt）。
	 * **非ヒット（海など）では呼ばれない**＝選択解除は mapEl の click ＋ unprojectXY ＋ pbf.contain(ll)===null で組む
	 */
	onGintClick(fn: (fid: number, props: Record<string, unknown>, lnglat: LonLat) => void): void;
	/** fid整列のproperties配列（式評価・表直書きの入力。.geojsonは詰めズレするので使わない） */
	gintFeatures(): Array<{ properties: Record<string, unknown>; geometry: { type: string } | null }> | null;   // geometry は type のみ（座標なし・1.0.5〜。以前は null）
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
}

/** 1行で地球儀が立ち上がる入口。await 必須 */
export default function orthoJapan(opts?: OrthoJapanOptions): Promise<OrthoJapanMap>;
/** 地球儀のホスト＝地域の申告なしで起動（世界データだけ・日本固有ゼロ）。region を渡せば地域を足せる。
 *  内製アプリ（world 等）はこちらを使う（LAYERS.md・2026-09-23）。orthoJapan は「globe＋日本の申告」の薄い包み */
export function createGlobe(opts?: OrthoJapanOptions): ReturnType<typeof orthoJapan>;
/** DOM の Marker（MapLibre と同名・1.2.0〜・#38）。描くたびに地形の高さへ投影し直す・球の裏では隠す。map.Marker でも同じ */
/** 独自スキームの取得を関数に任せる（MapLibre の addProtocol と同じ形・大域）。基図タイル・画像タイル・3D Tiles・style・sprite に効く */
export function addProtocol(scheme: string, loader: ProtocolLoader): void;
export function removeProtocol(scheme: string): void;
export interface MarkerOptions { element?: HTMLElement; color?: string; scale?: number; anchor?: "center" | "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right"; offset?: [number, number]; draggable?: boolean; altitude?: number }
export class Marker {
	constructor(opts?: MarkerOptions | HTMLElement);
	setLngLat(ll: LonLat | { lng: number; lat: number }): this; getLngLat(): { lng: number; lat: number } | null;
	addTo(map: OrthoJapanMap): this; remove(): this; getElement(): HTMLElement;
	setOffset(o: [number, number]): this; setAltitude(m: number): this; setDraggable(on: boolean): this; isDraggable(): boolean;
	setPopup(p: Popup | null): this; getPopup(): Popup | null; togglePopup(): this;
	on(type: "dragstart" | "drag" | "dragend", cb: (e: { type: string; target: Marker }) => void): this; off(type: string, cb: Function): this; once(type: string, cb: Function): this;
}
/** DOM の吹き出し（MapLibre と同名・#38）。setHTML は呼び手の HTML をそのまま入れる＝外来の文字列は setText */
export interface PopupOptions { closeButton?: boolean; closeOnClick?: boolean; anchor?: "top" | "bottom" | "left" | "right"; offset?: number | [number, number]; maxWidth?: string; className?: string }
export class Popup {
	constructor(opts?: PopupOptions);
	setLngLat(ll: LonLat | { lng: number; lat: number }): this; getLngLat(): { lng: number; lat: number } | null;
	setHTML(html: string): this; setText(s: string): this; setDOMContent(node: Node): this; setMaxWidth(w: string): this;
	addTo(map: OrthoJapanMap): this; remove(): this; isOpen(): boolean; getElement(): HTMLElement;
	on(type: "open" | "close", cb: (e: { type: string; target: Popup }) => void): this; off(type: string, cb: Function): this; once(type: string, cb: Function): this;
}

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
	/** フィーチャ数 */
	readonly length: number;
	/** feature i のジオメトリ型（"Point"…"MultiPolygon"）。引数なし＝全件の配列 */
	getType(i: number): string;
	getType(): string[];
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
	/** 書き出し（File 名＝opts.name 由来＝"myapp/data" のような階層名はダウンロード名にスラッシュが入る）。忠実度：geopbf/geojson＝完全、
	 *  kmz＝件数維持・属性は全て文字列化、gpx＝点と線のみ（面は落ちる）・属性は name/desc/type と各点の ele/time 配列、
	 *  czml＝静的パケットは等価（幾何にした部分以外は czml 属性に温存）・時刻付きの線は sampled position */
	geopbfFile(opts?: object): Promise<File>;
	geojsonFile(opts?: object): Promise<File>;
	topojsonFile(opts?: object): Promise<File>;
	fgbFile(opts?: object): Promise<File>;
	shapeFile(opts?: object): Promise<File>;
	kmzFile(opts?: object): Promise<File>;
	gmlFile(opts?: object): Promise<File>;
	gpxFile(opts?: object): Promise<File>;
	czmlFile(opts?: object): Promise<File>;
	[k: string]: unknown;
}
/**
 * SDK 同梱・初期化済みの geopbf ローダー。GeoJSON オブジェクト / File / URL / ArrayBuffer（geopbf/geojson/topojson/fgb/
 * shape(zip)/kmz/gpx/gml/moj(zip)/gz）→ GeoPBF。createGeopbf は不要（export していない）。opts を文字列で渡すと name 扱い
 */
export function geopbf(data: GeopbfInput, opts?: GeopbfOptions | string): Promise<GeoPBF>;
