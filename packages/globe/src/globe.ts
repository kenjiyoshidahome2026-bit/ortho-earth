// 地球儀のホスト（LAYERS.md の globe 層）＝createGlobe(opts)。地域（基図・標高・台帳・語彙・起動後の拡張）は opts.region の申告で足す＝このファイルは地域名を知らない。
// 意匠：quiet-mono（トークン→部品）→ app固有 の順を 1 枚に焼いた素の CSS（scripts/build-css.mjs・scss を変えたら npm run build:css）＝利用者に sass が要らない
import "./globe.css";
import { evalExpr, truthy, KNOWN_OPS, parseRGBA, isColor, cameraState, project, unproject, buildGeoJSONOverlay, createFlight, shortBearingOf, parseViewHash, buildViewHash, wrapLon, createInput, WORLD_PX, primeVerticalRadius, setEllipsoid, ellipsoidOn, worldRadiusM, betaToLonLat } from "@ortho-earth/core";
import { createGeopbf, geopbf, geopbfCached, geopbfCachePrune } from "geopbf";
import { normLight, lightPayload, LIGHT_TYPES } from "./light.ts";
import { normSky, skyHasExpr, skyPayload } from "./sky-spec.ts";
import { normSprite, spritePrefix, tilesFromPoints, fontFaceArgs } from "./mlsmall.ts";   // MapLibre の小口（B6・2026-10-12）   // style の sky（B4・2026-10-12）＝簡易の空と霧の色・濃さ（エンジンの名 sky は星空劇場＝こちらは mlSky）   // style の light（B3・2026-10-12）   // paint の transition（B1・2026-10-12）＝main 側の走者   // follow の的＝CZML/GPX の軌跡（時計の時刻の位置・A4）
import { curveZoomKey } from "./extrude-ml.ts";
import { createRawStore } from "./vtraw.ts";   // vector source の生のタイルの写し（querySourceFeatures・C7）   // 押し出し（fill-extrusion）の描き直しの鍵と立体の当たり（純関数・台帳 R22/R23）
import { normPostChain, POST_TYPES } from "./postchain.ts";   // 後処理の鎖（F3）
import { createPluginHost } from "./plugin.ts";   // plugin 契約・registry・supports/capabilities（第 2 波 PR-F0・2026-10-12）
import { installOverlays } from "./api/overlays.ts";
import { installQuery } from "./api/query.ts";
import { installTerrain } from "./api/terrain.ts";
import { installData } from "./api/data.ts";
import { installIntake } from "./api/intake.ts";
import { installImages } from "./api/images.ts";
import { installShadows } from "./api/shadows.ts";
import { installGadgets } from "./api/gadgets.ts";
import { installRaster } from "./api/raster.ts";
import { installCamera } from "./api/camera.ts";
import { installTools } from "./api/tools.ts";
import { installStyle } from "./api/style.ts";
export { definePlugin, STATIC_CAPABILITIES } from "./plugin.ts";
import { registerTileFormat, hasTileFormat, tileFormatNames } from "@ortho-earth/core/tileformat";   // registry.tileFormats＝core の表へ（process-wide）
import { POINTCLOUD_NAMES } from "#pointcloud-formats";   // capabilities の pointcloud.laz（alias で差し替わる・既定は []）＝名前だけ読む（表を読むと解読器のチャンクが本体側にもできる）   // 後処理の設定の正規化（PR-8）   // MapLibre の custom 層を worker で描く（addLayer の url・深度の前置き・PR-7）
import { nativeBucket } from "native-bucket";
import { createGetHeight, setApiUrl as setAltApiUrl, setWorkerFactory as setCoreWorkerFactory } from "@ortho-earth/core/elevation";   // 標高のローダ＝core（2026-09-25 に altpbf から移設）
import { setWorkerFactory as setGeoeditWorkerFactory } from "geoedit/worker-factory";   // 口だけの小さな入口（geoedit 本体は遅延 chunk のまま）＝起動時に設定＝initEditor を直に呼ぶ検定ページも入口を通る
// 部品の worker（geopbf の変換・解析・COG・タイル書き出し／エンジンのタイル・シーン／エンジンの標高／geoedit の編集モデル）も
// アプリの入口 1 本（worker.js）で走らせる＝共有部品（geopbf の核など）を render/estat 等と共有（2026-09-22・標準の作法）。
// 役割名は部品が付ける（"decoder:fgb" "ortho:tile" 等）＝options は静的でない＝@vite-ignore（worker の組み立て自体は vite が行う）。
// ⚠部品の組み込み worker はビルドの alias で「作らない版」に差し替え済み（vite.config.js）＝この口が必ず Worker を返すこと
const hostWorker = (role: string) => new Worker(new URL("./worker.ts", import.meta.url), /* @vite-ignore */ { type: "module", name: role });
setCoreWorkerFactory(hostWorker);   // core の worker（標高 ortho:height・タイル・シーン）も入口 1 本で
setGeoeditWorkerFactory(hostWorker);
createGeopbf("https://api.ortho-earth.com", { bucket: nativeBucket as BucketProvider, prewarm: true, workerFactory: hostWorker });   // bucket 基盤（標高と同じ）。読み出しはキー不要・bucket=native-bucket注入（geopbf自体は依存ゼロ化 8/21）。prewarm＝復号レーンを先に起こす（起動直後に海岸線/湖/星を必ず解く）
// SDK 公開面：初期化済みの geopbf を再エクスポート（2026-09-10・npm 利用者が別途 `npm i geopbf` せず、バンドラも import map も無しで
// データを載せられる＝同梱の worker チャンクがそのまま動く）。createGeopbf は出さない＝利用者が呼び直すと上の bucket 設定ごと
// アクティブインスタンスが差し替わる（同一モジュールのグローバル）ため。型は globe.d.ts。
export { geopbf };
import { Marker, Popup } from "./gadgets/marker.ts";   // DOM の Marker / Popup（#38・MapLibre と同名）＝小さい部品なので静的
export { Marker, Popup };
import { createRequester, addProtocol, removeProtocol } from "./request.ts";   // 取得の前の手入れ（#37・transformRequest / addProtocol）
export { addProtocol, removeProtocol };
export { Compare } from "./compare.ts";   // 2 枚の地図をスワイプで比べる（maplibre-gl-compare と同じ形・#173）
import { MAP_THEMES } from "./palettes.ts";
import { WORLD_STYLE_THEMES, normWorldTheme } from "@ortho-earth/core/worldstyle";
import { clipDistanceM } from "@ortho-earth/core/clip";   // 断面とクリッピング平面（#111）＝main 側の問い合わせ・地中フェードも切った側を外す   // 世界の地図面の配色の正本（名札・世界線の色・c= の別名）
import { createLabelSender } from "@ortho-earth/core/labelsync";   // 注記の集合は差分で worker へ（持っている物は番号だけ・2026-10-03）
import { GEOJSON_LAYER } from "@ortho-earth/core/geojsonvt";   // geojson を切ったタイルの source-layer 名（geojson vt plan G-2）
import { mergeChome } from "./chome.ts";   // 町丁名の二系統(210/800)の畳み込み
import { createThemes, defaultLayerState, isFacility, isTerrain, CHOME_MINZOOM, CHOME800_MINZOOM, RAILTR_MINZOOM } from "./themes.ts";
import { createOverlay } from "./overlay.ts";

// planets.js と星座/メシエ名（Pages の sky/names）は z<4（星空）でしか使わない＝初期バンドルから外し、下の ensureSkyMod で動的読込。
import { createPipeline, pmtilesInfo, isRasterTileType, splitMapLibreStyle, loadMapLibreStyle, resolveVectorSource, tileUrlOf, createDemSource, normalizeMLLayer, layerDzOf, rescaleZoomNum, DZ_KEY, shiftZoomExpr, originOfLayer, packMLLayers, buildMLTable, zoomSensitivity, mlUnknownOps, ML_ID_KEY, ML_IX_KEY, ML_CZ0_KEY, ML_CZ1_KEY, ML_CEZ_KEY, setGlobalState, mlTileZoomOf, validateMLStyle, layerPaintTable } from "@ortho-earth/core";
import { zoomScaleOf, bootOptsIn, ML_DZ, mercatorDz } from "./zoomscale.ts";
import { createFacade } from "./mlfacade.ts";
export { RAW } from "./zoomscale.ts";   // 旗つきの地図（外側の顔）から素の map へ＝map[RAW]（部品が入口で使う）。mercatorDz は zoomscale.js の物＝root からは出さない（2.0.0・MapLibre の口は "../zoomscale.js" から読む）
import { pmLayers, pmRoles } from "./style-pm.ts";   // ?pm= の層名→役割→描画規則（静的import＝?pm= を使わない構成でも数百バイト）
import { escHtml, propLines } from "./html-safe.ts";   // ホバー tip の既定整形（属性のキー・値を逃がす・2026-10-16）
import { sanitizeHTML } from "geopbf/sanitize";   // ?pm= のアーカイブが宣言する出典 HTML は非信頼入力＝出力境界で消毒   // tile/scene worker のスポーンごとエンジン側
import { createGintLayers } from "./gint/layers.ts";
import { createWorldContent } from "./gint/worldcontent.ts";
import { createHillshadeProvider } from "./hillshade.ts";
import { createColorReliefProvider } from "./colorrelief.ts";
import { createDemTiles } from "./demtiles.ts";   // raster-dem のタイルの在庫＝source ごとに 1 つ（hillshade と color-relief が共有・#114 段 3）   // MapLibre の color-relief 層（標高の段彩・#114）＝hillshade と同じ port プロバイダ
import { createCustomGL } from "./gadgets/customgl.ts";   // MapLibre の custom 層（main の透明な WebGL2 canvas・mainMatrix＝メルカトル→クリップ・公式例の門 4 巡目）   // MapLibre の hillshade 層（raster-dem→陰影の画像タイル・公式例の門 3 巡目）   // 世界帯に Equal Earth と同じ中身（opts.worldContent・2026-09-24）   // gint（知性の層）＝単一スロット・多層・admin0・bake-ahead・ドレープ・fid 塗り（同）
import { createClock, fmtUTC } from "@ortho-earth/ephem/clock";
import { createSkyTheater } from "./sky/theater.ts";   // 星空劇場（z<4）＝星・惑星・月・星座・日時計・太陽系圏との交代（同）
import { lowMem, classifyTier, ellipsoidMode, renderFx, probeGL as probeWebGL2, fatalOverlay as showFatal, deadMap } from "./boot/tier.ts";   // 起動時の裁き＝純関数（t-tier で検定）   // シーン再生プレーヤー＝上映・停止・タイムライン・黒幕・待ちパネル（同）
import { mountGadgets } from "./gadgets/mount.ts";
import { attributionHTML, setAttrHTML, attrFullHTML } from "./gadgets/instruments.ts";   // 地域宣言の出典→HTML（#attr と、#attr の無い画面の焼き込みで共用）
import { dockStack } from "./gadgets/stack.ts";   // 左下ドック（座標計器・読込トーストの容れ物＝重なりの構造的排除）
import { stac as stacGadget } from "./gadgets/stac-stub.ts";   // 衛星シーン検索の玄関スタブ（本体 stac.js は初回クリックで遅延）   // 玄関スタブ＝ボタン+Mキー常駐、本体(measure.js＝球面測地/専用canvas)は初回クリック/Mで import()
import { raster as rasterGadget } from "./gadgets/raster.ts";   // 画像タイル（ラスタ）の切替＝v1 Layers/setBase の後継（地域パックのカタログ・2026-09-21）
import { globe as globeGadget } from "./gadgets/globe.ts";     // ミニ地球儀（右下・視野の枠）＝v1 accessories globe の移植（2026-09-21）
import { modalOpen, registerKeyOwner, isKeyOwner } from "./gadgets/keys.ts";   // 矢印キーのモーダル抑止に使う共通判定（ショートカット群と共有）
import { setLang, getLang, isRTL, tr } from "./i18n.ts";   // UI 多言語化（英語キー・26 言語・詳細は i18n.js）。地図の中身（地名等）は対象外
// 型（TS 化 段 4・batch 3）＝createGlobe の口と内側の部品の形
import type { Bbox, Gadgets, GintLayerHandle, GintLayerOptions, GlobeOptions, LonLat, OverlayHandle, QuantizedMeshSource, RasterDemSource, RasterOptions, Tiles3DOptions } from "../globe.d.ts";
import type { GlobeInternals, GlobeMap } from "./types/map.ts";
import type { GlobeMapBuilding } from "./types/install.ts";
import type { ExtStyleDoc, GlobeLive, GlobeScope, MlPass, ModelCtl, ParsedView, PatItem, QueryGeometry, T3dCtl, UserLayerRec, UserSource, VtxDesc } from "./types/scope.ts";
import type { MLLayer, Pipeline } from "@ortho-earth/core";
import type { CameraPose } from "@ortho-earth/core/camera";
import type { BucketProvider, GeoPBF, GeopbfInput } from "geopbf";
import type { PluginHostOptions } from "./plugin.ts";
import type { ClusterSource } from "./gadgets/aggregate-core.ts";
import type { createCOPC } from "./gadgets/copc.ts";
import type { CustomLayer } from "./gadgets/customgl.ts";
import type { HudSnapshot } from "./gadgets/hud.ts";
import type { AttributionDecl } from "./gadgets/instruments.ts";
import type { ExtrudeSrc, ModelExtrudeOptions, ModelGadget } from "./gadgets/model.ts";
import type { TileTex, createTiles3D } from "./gadgets/tiles3d.ts";
import type { createVTDraw } from "./gadgets/vtdraw.ts";
import type { createVTExtrude } from "./gadgets/vtextrude.ts";
import type { DemTiles } from "./demtiles.ts";
import type { GintLayerH } from "./gint/layers.ts";
import type { WorldContent } from "./gint/worldcontent.ts";
import type { MeshManager, MeshProgressTap } from "./mesh/manager.ts";
import type { MapTheme } from "./palettes.ts";
import type { LayerState } from "./themes.ts";

// app.js 持参のUI辞書（ja文字列がキー・未訳はjaのまま出る）。ガジェット各自の辞書は各ファイル冒頭に。
const t: GlobeScope["t"] = tr();

// ============================================================================================
// ortho-japan：1行で日本が立ち上がる入口（v1 orthoMap の作法の継承）。
//   const map = await orthoJapan();                    // body直下の #map（無ければ自作）に起動
//   const map = await orthoJapan({ target: "#here" }); // 任意のdivへ埋め込み（idはmapに正規化＝家具規格）
//   opts.view="#z/lat/lon..." で初期視点を上書き。戻り値＝{ cam, flyTo, renderer, mapEl, gadget, destroy }
//   map.destroy()＝worker・リスナー・ループ全停止＋DOM撤去（SPAで剥がす時。IDBキャッシュは残す）
//   opts.layers＝表示項目の固定（キー: place地名/terrain地形/rail鉄道/road道路/facility施設）：
//     true=常時表示・false=常時非表示（どちらもチップ非搭載＝客に触らせない）、未記述=既定値から開始＋チップで選択
//     例: { rail: true, facility: false }＝鉄道焼き付け・施設封印・残り3つは客に委ねる
//   opts.chips＝チップ帯そのものの表示（true=搭載[既定]／false=出さない）。1.x の配列形式は 2.0 で外した
//   opts.instruments＝下部の計器盤の表示（true=全部[既定]／["pos","scale","attr","log"]から選択的／false=出さない）
//   ★"attr"（出典）を消す場合は埋め込みページ側で出典明記が必要（README「出典表記」）
//   opts.mesh＝建物3D（建物メッシュ）機能スイッチ（true=[既定]／false=カタログ・worker・自動ロード・ガジェットごと停止）。旧名 opts.plateau は 2.0 で外した
//   opts.maxPitch＝チルト上限（度・0=俯瞰固定。geoedit等の編集アプリ用。未記述=既定MAXPITCH＝従来どおり）
//   opts.stars＝恒星（stars.6）のスイッチ（true=[既定]／false=恒星だけ描かない。惑星・月・星座・太陽系圏は従来どおり＝人工衛星ページ用）
//   opts.sky／opts.night／opts.coastline＝星空劇場と太陽系圏／低ズームの夜面／世界の海岸線（true=[既定]／false=持たない・描かない＝MapLibre の口 src/maplibre/ の既定）
//   opts.terrain＝false：setTerrain まで平ら（既定の標高を取らない＝MapLibre と同じ意味）。{ source, exaggeration }＝外来の標高タイル
//   opts.countryTip＝世界ビュー(z<5.5)のホバー国名 tip（true=[既定]／false=出さない＝自前の tip と重ねない器）
//   opts.theme＝配色テーマの固定（"dark"等の台帳名＝焼き付け・URLに書かない／台帳と同形のオブジェクト＝カスタムテーマ）。
//     未記述＝共有URLの c=<name> で選択（既定 mono＝白地図。台帳は palettes.js）
//   検索・操作説明はオプトインガジェット＝ map.gadget.search() / map.gadget.hint() で画面ごとに追加（v1 ortho-map の作法）
// ============================================================================================
// ★地球儀のホスト（LAYERS.md の globe 層）。地域は opts.region の申告だけで足す＝この関数は地域名を知らない（JP/日本/地理院を書かない）。
//   region＝地域宣言（packages/jp の JP_REGION の形）。配列でも単体でもよい。**省略・[]・null＝申告なし**＝基図・裸地標高・ラスタ台帳・
//   出典・戻り先・検索・POI・鉄道が来ない＝世界データだけの地球儀（apps/world の国の地図パネル）。
//   有効な地域宣言は**使う所より前で決める**（render worker の init が最初の利用者・TDZ の轍 2026-09-17）。
// 同じ頁の地図が決めた世界の形（#43）＝core の setEllipsoid はモジュール状態＝頁に 1 つ。2 枚目以降は最初の決定に従う（違えば警告）
let ELL_PAGE: ReturnType<typeof ellipsoidMode> | null = null;
// 地図が載っている容れ物（頁に 1 つの台帳・#173 段 2）＝target 無しの既定（頁の #map）を 2 枚目が掴まない・同じ容れ物への二重起動を止める
const LIVE_CONTAINERS = new Set<HTMLElement>();
// URL の持ち主（#173 段 3・2026-09-30）＝頁の URL（hash の視点・?r=）と前回ビュー（localStorage）を読み書きする地図は頁に 1 枚。
// 起動順で最初の地図（opts.urlHash:false は辞退）。持ち主でない地図は hash を読まず・hashchange に応じず・書かない・前回ビューも使わない。
// 1 枚の頁は従来と同じ。持ち主が畳まれても、生きている他の地図が持ち主を継ぐことはない（起動の時に決まる）
let URL_OWNER: object | null = null;
/** createGlobe の opts＝公開の OrthoJapanOptions＋MapLibre の口（src/maplibre/map.js）が渡す内部の物 */
interface HostOptions extends GlobeOptions {
	/** 注視点の高さ（"ground"＝地形の上の中心点・数＝固定［m］・A3） */
	centerElevation?: "ground" | number;
	/** 内製の大気を点ける（MapLibre の目盛りの既定は透明の縁） */
	atmosphere?: boolean;
	/** false＝霧を焚かない（MapLibre の口の既定） */
	fog?: boolean;
}
/** 建物の台帳の 1 区（地域宣言の buildings.sets／catalog の JSON の要素） */
/** 注記の 1 件＝基図のタイル注記（core の Label）か、ホストが足す名札（空港マーク・ランドマーク・POI＝書体・層の添字・ズーム域は持たない）。labelSender で worker へ */
interface HostLabel extends Omit<CoreLabel, "font" | "li" | "minZ" | "maxZ" | "color" | "halo">, Partial<Pick<CoreLabel, "font" | "li" | "minZ" | "maxZ">> {
	color: readonly number[]; halo: readonly number[];
	/** 測量点＝真俯瞰の作法（傾けたら消す） */
	flat?: boolean;
	/** 記号だけ（空港マーク） */
	markOnly?: boolean;
}
/** POI 台帳の本物（地域宣言 poi.create の戻り）＝globe が読む分 */
interface PoiLedgerHost extends NonNullable<GlobeLive["poiReal"]> {
	load(cam: GlobeScope["cam"]): void;
	injectLabels(labels: HostLabel[], o: { zoom: number; ink: unknown; landmarkCode: number }): unknown;
	readonly ver: number;
}
/** POI 台帳の代理の窓口（起こすまで）＝scope の PoiProxy に globe が読む分を足した物 */
interface PoiProxyHost extends NonNullable<GlobeScope["poi"]> {
	load(cam: GlobeScope["cam"]): void;
	injectLabels(...a: Parameters<PoiLedgerHost["injectLabels"]>): unknown;
	readonly ver: number;
}
/** buildGeoJSONOverlay の地物の列 */
type OvFeatures = Parameters<typeof buildGeoJSONOverlay>[0];
/** 基図のタイル注記（core の Label） */
type CoreLabel = ReturnType<Pipeline["tiles"]["labels"]>[number];
/** 基図のタイルの並び（tiles.update の order） */
type TileOrder = Parameters<Pipeline["tiles"]["labels"]>[0];
/** navigator の標準外（Chromium の connection・deviceMemory・userAgentData） */
type NavigatorPlus = Navigator & { connection?: { effectiveType?: string; downlink?: number }; deviceMemory?: number; userAgentData?: { platform?: string } };
/** shot の生スナップ（map.requestSnapshot の答え） */
type Snapshot = Awaited<ReturnType<GlobeMap["requestSnapshot"]>>;
/** render worker の labelsPlaced の答え（検定窓 __placed／__placedDebug） */
interface PlacedMsgLabel { set?: string | null; li?: number | null; text?: string; icon?: string | null; ibox?: unknown; line?: unknown; lon?: number; lat?: number; x?: number; y?: number; w?: number; h?: number; font?: string | null }
interface PlacedMsg { labels?: PlacedMsgLabel[]; symbols?: Array<PlacedMsgLabel & { layer?: string }>; debug?: Record<string, unknown> | null }
/** spotlight／outline の形（GeoJSON の Feature・FeatureCollection・Geometry か ISO 3166-1 の 2／3 字） */
interface SpotGeom { type: string; coordinates?: unknown }
interface SpotFeature { type?: string; properties?: Record<string, unknown> | null; geometry?: SpotGeom | null }
interface SpotShape extends SpotFeature { features?: Array<SpotFeature | null> | null; coordinates?: unknown }
/** GeoJSON の座標の入れ子（葉は [lon, lat]） */
interface NestedCoords extends Array<number & NestedCoords> {}
/** 押し出しの模型（gadgets/model.js の createModel の戻り）＝installer の ModelCtl を兼ねる */
type ModelLive = ModelGadget & ModelCtl;
/** 任意の 3D Tiles（gadgets/tiles3d.js の createTiles3D の戻り）＝installer の T3dCtl を兼ねる */
type T3dLive = ReturnType<typeof createTiles3D> & T3dCtl;
/** extrude の入口（GeoJSON・File・URL・{ geojson }・MapLibre の fill-extrusion の層を丸ごと） */
type ExtrudeIn = Parameters<Gadgets["extrude"]>[0] | undefined;
/** extrude の opts（ネイティブの opts か MapLibre の fill-extrusion の層） */
type ExtrudeOptsIn = ModelExtrudeOptions & { id?: string; source?: unknown };
/** 形を見て分ける GeoJSON らしき物（Feature・FeatureCollection・Geometry・{ geojson }） */
interface GjLike { type?: string; features?: GjLike[]; coordinates?: unknown; geometry?: unknown; id?: unknown; properties?: Record<string, unknown> | null; geojson?: unknown }
/** IIIF の言語つきの文字（none／en／@value／value・配列） */
type IiifVal = string | number | boolean | null | undefined | IiifVal[] | { [k: string]: IiifVal };
/** core の MapLibre の pass（packMLLayers の 1 件） */
type MLPass = ReturnType<typeof packMLLayers>[number];
type MLTableStates = NonNullable<Parameters<typeof buildMLTable>[2]>["states"];
/** pass の表の持ち手（buildTable が読む・drawn＝層 id → 地物ごとの描いている） */
interface MlHolder { pass: MLPassML; zs: ReturnType<typeof zoomSensitivity>; drawn: Record<string, Uint8Array> | null }
/** mlGintData の値（source の焼き） */
interface MlGintEntry { data: unknown; pbf: GeoPBF; idToFid: Map<unknown, number>; fidToId: Array<number | string | undefined> }
/** mlPasses の値（MlPass＋手綱の全部） */
interface MlPassFull extends Omit<MlPass, "h" | "holder"> { h: GintLayerHandle & MlPass["h"]; holder: MlHolder }
/** 模様・線の飾り（addPattern）の地物と出す物 */
interface PatFeature { type?: string; properties?: Record<string, unknown> | null; geometry?: QueryGeometry | null }
interface PatFeatOut { f: PatFeature | null; width: number; offset: number; lines: number[][][] }
interface PatIt { pattern: unknown; opacity: number; width: number; color?: string; offset?: number; dash?: unknown[]; grad?: { lut: string[] } }
interface PatOut extends Omit<PatIt, "grad"> { rings: Float64Array[]; grad?: { lut: string[]; prog?: Float32Array[] } }
/** core の式の評価の文脈 */
type ExprCtx = NonNullable<Parameters<typeof evalExpr>[1]>;
/** image／video／canvas の source の四隅（左上・右上・右下・左下） */
type Corners4 = [LonLat, LonLat, LonLat, LonLat];
/** MapLibre の custom 層の器の map（setCustomLayerHost が渡す物・投影の名前だけ読む） */
interface CustomHostLike { getProjection?(): { type?: string } | null }
/** pass（packMLLayers の 1 件）＝層は drawLayerOf の MLLayer そのもの */
type MLPassML = MLPass & { layers: MLLayer[] };
type TerrainOpt = Exclude<HostOptions["terrain"], false | undefined>;
interface MeshSetDecl { base: string; bbox: number[]; bakeBase?: string; [k: string]: unknown }
/** 地域宣言（opts.region の 1 件＝packages/jp の JP_REGION の形）のうち globe が読む分。globe は地域名を知らない＝中身は宣言のまま */
interface RegionDecl {
	code?: string;
	dtm?: GlobeScope["REGION_DTM"];
	buildings?: {
		sets?: MeshSetDecl[]; catalog?: string; bakeBase?: string; exclude?: string; landmarks?: string;
		labels?: GlobeScope["REGION_BLD_LABELS"]; icon?: string;
		group?(set: { base: string }): { order: number; key: number; label: string };
	} | null;
	basemap?: {
		kind: string; tileUrl(z: number, x: number, y: number): string | null | undefined; coverage: number[] | null;
		tileMinZoom: number | null; lodFloor: { minViewZoom: number; z: number } | null; minZ: number | undefined; printAttribution?: string;
	} | null;
	attribution?: AttributionDecl | null;
	view?: string | null;
	home?: GlobeScope["REGION_HOME"];
	search?: GlobeScope["REGION_SEARCH"];
	poi?: { create(env: { viewBbox: GlobeScope["approxViewBbox"]; requestDraw(): void }): PoiLedgerHost | Promise<PoiLedgerHost> } | null;
	rail?: ((env: { renderer: GlobeScope["renderer"]; readonly land: number[]; BASEMAP_MINZOOM: number; requestDraw(): void }) => { load(): unknown; loaded: boolean }) | null;
	rasters?: GlobeScope["REGION_RASTERS"];
	airports?: string;
	/** 起動の後に地域が足す物（e-Stat 小地域など）＝拡張面（hostEnv）だけを受ける */
	install?(map: GlobeMap, host: object): unknown;
}
export async function createGlobe(opts: HostOptions = {}): Promise<GlobeMap> {
const urlToken = {};   // この地図の URL の持ち主の札
const URL_OWN: GlobeScope["URL_OWN"] = opts.urlHash !== false && !URL_OWNER;
if (URL_OWN) URL_OWNER = urlToken;
const releaseUrl = () => { if (URL_OWNER === urlToken) URL_OWNER = null; };
const pageHash: GlobeScope["pageHash"] = URL_OWN ? location.hash : "";   // 持ち主でない地図は頁の hash を視点に使わない
// 式の global-state（MapLibre の setGlobalStateProperty・外来 style の state）＝地図ごと（#173 段 3b）。
// 正本はこの MAP_GS：worker（基図の tile worker・vtdraw）へ送る値と、main の評価の ctx.gs はここから。
// core のスレッドの状態（setGlobalState）にも写す＝ctx.gs を渡し損ねた評価は今までどおり（1 枚の頁は不変）
let MAP_GS: GlobeLive["MAP_GS"] = Object.create(null);
const setMapGS: GlobeScope["setMapGS"] = obj => { MAP_GS = Object.assign(Object.create(null), obj || {}); setGlobalState(MAP_GS); };
// ズームの目盛り（MapLibre 互換の台帳 maplibre-compat.md）：旗 zoomScale:"maplibre" の地図は公開面の数の zoom を MapLibre の z で受け渡す。
// 換算は 3 か所だけ＝ここ（起動オプション）・最後の外側の顔（mlfacade）・MapLibre 形の層と source の dz（PUBLIC_DZ）。内部は素の map＝エンジンの z
// "mercator"＝ML_DZ＋log2(sec φ0)（φ0＝起動の視点の緯度・zoomscale.js の mercatorDz）＝MapLibre のメルカトルの縮尺に合わせる。外来 style の目盛り STYLE_DZ も同じ（style.json は MapLibre の z）
const ZOOM_SCALE = zoomScaleOf(opts);
const PUBLIC_DZ: GlobeScope["PUBLIC_DZ"] = ZOOM_SCALE === "maplibre" ? ML_DZ : ZOOM_SCALE === "mercator" ? mercatorDz(parseViewHash(opts.view || pageHash)?.lat ?? 0) : 0;
const STYLE_DZ: GlobeScope["STYLE_DZ"] = ZOOM_SCALE === "mercator" ? PUBLIC_DZ : ML_DZ;   // style.json の層と source の目盛り（旗なし・maplibre＝1）
// タイルの z は MapLibre と同じに（mercator）：カメラが緯度の分だけ寄っても、選ぶタイルの z は MapLibre の z のまま（MapLibre は floor(zoom) のタイルを引き伸ばす）＝
// 分割の閾（画面 px）を 2^(dz−1) 倍する。基図（tiles.update）と vector source（vtextrude/vtdraw）の選びに掛ける。⚠これが無いと一段細かいタイルを選び、問い合わせの答え（地物の集合）が MapLibre と違う（o8 で 43→30）
const TILE_BIAS: GlobeScope["TILE_BIAS"] = ZOOM_SCALE === "mercator" ? 2 ** (PUBLIC_DZ - ML_DZ) : 1;
// 目盛りが MapLibre（mercator／maplibre）の時は、タイルの z を MapLibre の coveringTiles と同じ規則で選ぶ（core mlcover.js）＝傾き 60° 以下・地形なしなら floor(MapLibre の z)、それ以外は距離の式。
// TILE_BIAS（画面 px の閾）だけでは z の小数部が 0.13 を超えると一段細かく、静止時の手前詳細化（IDLE_TILE_PX）でさらに一段細かくなっていた（o44＝z11.15 で z12 を選び、問い合わせの答えが揃わない）。
// 内製（ortho）は従来の閾（null）。terrain＝MapLibre の地形が出ている（setTerrain）＝距離の式へ
const ML_COVER: { dz: number; maxLevels?: number; maxMinRatio?: number } | null = ZOOM_SCALE === "ortho" ? null : { dz: PUBLIC_DZ };
opts = bootOptsIn(opts, PUBLIC_DZ);
const requester: GlobeScope["requester"] = createRequester();   // 取得の前の手入れ（#37）＝opts.transformRequest／map.setTransformRequest・独自スキームは addProtocol（大域）
requester.setTransform(opts.transformRequest);
const REGIONS = ([] as RegionDecl[]).concat((opts.region || []) as RegionDecl | RegionDecl[]).filter(Boolean);
const REGIONLESS = !REGIONS.length;   // 地域の申告が一つも無い＝世界データだけで描く（地域の台帳も読まない）
const hostHooks: { hover: Array<(x: number, y: number) => boolean> } = { hover: [] };   // 地域パックが差す口（hover(x,y)→true＝処理した）＝拡張面（region.install が使う・S3）
const hostDestroy: Array<() => void> = [];            // 地域パックの片付け（map.destroy が呼ぶ）
// 本体の遅く生まれる持ち物（日影・gint の焼き・ラスタの提供側・列チャンク層・標高の問い合わせの worker）の片付け（2026-09-25）。
// destroy() より後ろで宣言される let/const を destroy から直に触ると、起動途中の destroy で TDZ に落ちる＝生まれた所で登録する
const ownDestroy: GlobeScope["ownDestroy"] = [];
const REGION_DTM: GlobeScope["REGION_DTM"] = REGIONS.find(r => r.dtm)?.dtm ?? null;            // 裸地標高の申告（今は日本だけが持つ）
// 建物の申告＝「台帳の在り処」と「焼きの置き場」の対。どちらも地域が持ち、ホストは中身を知らない。
const stampBake = (sets: MeshSetDecl[], b: { bakeBase?: string }) => b.bakeBase ? sets.map(s => s.bakeBase ? s : { ...s, bakeBase: b.bakeBase }) : sets;   // 台帳の各 set へ焼きの置き場を刻む（区ごとの別置き場も許す）。無宣言＝焼き無し＝生経路のみ
const REGION_SETS = REGIONS.flatMap(r => r.buildings ? stampBake(r.buildings.sets ?? [], r.buildings) : []);   // その場で配る建物台帳（オランダ 3 件）
const REGION_CATALOG = REGIONS.map(r => r.buildings).filter(b => b?.catalog) as Array<NonNullable<RegionDecl["buildings"]> & { catalog: string }>;   // 取得する台帳の申告（日本の 336 件）＝{ catalog, bakeBase? }
const REGION_EXCLUDE = REGIONS.map(r => r.buildings?.exclude).filter(Boolean) as string[];   // 除外タイル表
const REGION_LANDMARK = REGIONS.map(r => r.buildings?.landmarks).filter(Boolean) as string[];   // ランドマークの名札
const REGION_ATTR = REGIONS.map(r => r.attribution).filter(Boolean) as AttributionDecl[];   // 出典（表示義務）＝入口ごとに差し替わる
const REGION_PRINT_ATTR: GlobeScope["REGION_PRINT_ATTR"] = REGIONS.map(r => r.basemap?.printAttribution).filter(Boolean) as string[];   // 印刷の出典（i18n の英語キー）＝基図の申告。無ければ今の圏の出典
const REGION_HOME: GlobeScope["REGION_HOME"] = REGIONS.map(r => r.home).find(Boolean) ?? null;    // 「全体へ戻る」の着地点（日本＝列島ビュー）・null＝戻りボタン無し。{ view:[lon,lat,zoom], span?:[経度幅,緯度幅]（デモの終演で画面に収める全体）, label, id, icon }
const REGION_SEARCH: GlobeScope["REGION_SEARCH"] = REGIONS.map(r => r.search).find(Boolean) ?? null;   // 地名検索の供給元（日本＝地理院 AddressSearch）・null＝検索窓無し
const REGION_POI = REGIONS.map(r => r.poi).find(Boolean) ?? null;      // 施設の点の台帳（日本＝POI 台帳 z14）・null＝読まない
const REGION_RAIL = REGIONS.map(r => r.rail).find(Boolean) ?? null;    // 路線オーバーレイ（日本＝N02 新幹線）・null＝作らない
// UI言語を最初に確定（opts.lang > ?lang= > ブラウザ言語）。以降のfatal/トースト/ガジェットが全て従う。
await setLang(opts.lang);   // 訳の用意まで待つ（ja/en は静的＝即返り・他言語は 1 本取る）
// 起動の容れ物：target指定（selector/要素）→ 無ければ頁の #map（まだ地図が載っていない物）→ それも無ければbody直下に自作。
// 1 枚の頁は今までどおり <div id="map"> が既定。2 枚目以降は target で別の div を渡す（#173・2026-09-30 本人裁定）。
// 容れ物の id は付け替えない（旧＝map へ改名＝2 枚目で id が重なる）。意匠（quiet-mono）は :is(.qm, #map) で当たり、
// .qm はエンジンが付ける印＝利用者はクラスを書かない。中の家具は固定 id（#c・#pos…）のまま＝探す時は必ず mapEl から
// （document.getElementById は頁で最初の物＝1 枚目の家具を掴む）。
const targetEl = typeof opts.target === "string" ? document.querySelector<HTMLElement>(opts.target) : opts.target;
if (targetEl && LIVE_CONTAINERS.has(targetEl)) { releaseUrl(); throw new Error("createGlobe: the target already holds a live map — destroy() it first"); }
const pageMapEl = document.getElementById("map");
let mapEl: GlobeLive["mapEl"] = (targetEl || (pageMapEl && !LIVE_CONTAINERS.has(pageMapEl) ? pageMapEl : null)) as GlobeLive["mapEl"];   // null＝下で自作（ownMapEl）
const ownMapEl = !mapEl;   // 容れ物を自作した＝destroy で丸ごと消してよい（預かった div は中身だけ空にして返す）
// 容れ物を自作した＝このページを預かった＝ビューポート全面を取りに行く。寸法は html/body へ
// **inline で**入れる（スタイルシートからは一切書かない＝埋め込み時は発火しようがない・destroy で元に戻す）。
// ★これが無いと「body に height の無いページ」で #map(height:100%) が 0 になり射影が退化する
//   ＝スタンドアロンの tests/*.html が全滅する（2026-08-19 の意匠移設で実際に踏んだ轍）。
// ★mapEl 自身を position:fixed で浮かせる手もあるが不可：流れから外れると画面分割（親を flex 化して
//   mapEl.flex を効かせる型・旧 AI ガジェットで踏んだ轍）が死ぬ。容れ物は流れの中に置く。
// 預かった div（target 指定）とホストの html/body には指一本触れない＝寸法はホストの領分。
const pageStyle: { html: string | null; body: string | null } = { html: null, body: null };
if (ownMapEl) {
	mapEl = document.body.appendChild(document.createElement("div"));
	if (!pageMapEl) mapEl.id = "map";   // 頁に #map が無い時の自作＝#map（1 枚の頁の既定の名前・利用者の CSS/JS が当てられる）
	const root = document.documentElement;
	pageStyle.html = root.style.cssText; pageStyle.body = document.body.style.cssText;
	root.style.height = "100%";
	Object.assign(document.body.style, { height: "100%", margin: "0", overflow: "hidden" });
}
LIVE_CONTAINERS.add(mapEl);
const mapElHadQm = mapEl.classList.contains("qm");   // 預かった div に最初から付いていた .qm は destroy で外さない
mapEl.classList.add("qm");   // 意匠（quiet-mono）の容れ物の印＝エンジンが付ける（利用者は書かない）
// 言語と書字方向は容れ物に付ける（html/body には触れない＝埋め込み先の領分）。dir=rtl で
// 論理プロパティ（inset-inline-start 等）が鏡像になり、ブラウザの bidi がアラビア/ヘブライの行を正しく並べる。
const mapElPrevLang = mapEl.lang, mapElPrevDir = mapEl.dir;   // destroy で返す
mapEl.lang = getLang();
mapEl.dir = isRTL() ? "rtl" : "ltr";
// 舞台のcanvas 2層（基図GL＝知性gintも同居/ラベル）も自給＝index.htmlは空のdivだけでよい
// （旧・#gint 別canvas は 1canvas統合で撤去＝gint は render worker の GL パスとして #c に描かれる）
// 注記の字は既定で WebGPU（テキスト GPU 化・本人の Mac の門 2026-10-22 の後に既定化）＝注記の上の webgpu canvas（#labelsgpu）と地図のパスの中（層の位置）へ。
// WebGPU で起動できた時だけ worker が使う（GL2 に落ちたら空のまま＝Canvas2D）。?text=2d＝今までの Canvas2D（逃げ道）・?text=gpu は既定と同じ
// geojson の線のずらしの層＝geojson を worker でタイルに切って vtdraw へ（geojson vt plan G-2・2026-10-22）。?gjvt=0＝今までの pattern-2d（canvas2D の重ね描き）。
// 面の模様は ?gjvt=2 の時だけ（名前が定数の層）＝core の模様の塗りは地形ありの 3D で地面アトラスに焼かない（描かれない）・名前は層で一度（属性を読まない）＝そこが埋まるまで既定は canvas2D
const GJVT = !/[?&]gjvt=0(?:&|$)/.test(location.search), GJVT_FILL = /[?&]gjvt=2(?:&|$)/.test(location.search);
const PER_FEATURE = /"(get|has|properties|feature-state|id|geometry-type)"/;   // 式が地物を読む（データ駆動）
const TEXT_GPU = "gpu" in navigator && !/[?&]text=2d(?:&|$)/.test(location.search);
for (const cid of ["c", "labels", ...(TEXT_GPU ? ["labelsgpu"] : [])]) { const cv = (cid === "c" && mapEl.querySelector<HTMLCanvasElement>(":scope > canvas#c")) || document.createElement("canvas"); cv.id = cid; mapEl.appendChild(cv); }   // #c は預かった容れ物に先に置かれていれば使う（MapLibre の口の getCanvas は起動前でも同じ canvas を返す＝terra-draw 等が構築時に掴む）
// 地中フェードの覆い（カメラが地表より下へ潜った時に暗くする＝クランプの代替。updateUnderground が opacity を駆動）。
// canvas 2層の直後・UI より前＝基図/ラベル/gint を覆い、計器・検索は上に残す（脱出できる）。スタイルは style.css の #underground。
const undergroundEl = mapEl.appendChild(document.createElement("div"));
undergroundEl.id = "underground";

// 実行時アセット（plateau-sets.json / airports.json / plateau-landmarks.json）の置き場。
// 既定＝自分の配信ベース（vite の BASE_URL＝"/japan/"）。★SDK として第三者のビルドへ取り込まれると
// import.meta.env.BASE_URL は「相手のベース」に置換される＝これらのファイルは相手のサイトに存在しない。
// opts.assetBase で指し直せる口を開けておく（相対でも絶対URLでもよい・末尾スラッシュは自動で整える）。
// 例: orthoJapan({ assetBase: "https://cdn.example.com/ortho-japan/" })
const ASSET_BASE = (b => { let i = b.length; while (i && b[i - 1] === "/") i--; return b.slice(0, i) + "/"; })(String(opts.assetBase ?? import.meta.env.BASE_URL));   // 末尾の / を 1 つに（正規表現 /\/*$/ は / の連なりで遅くなる＝CodeQL・2026-10-15）
// デバッグ手（__cam / __coast / __mesh …）の宿主。自前ページのコンソールから叩く道具を窓に生やすが、
// SDK として第三者ページへ埋め込まれた時にホストの window を汚すのは筋が悪い（2026-08-19）。
// 既定＝容れ物を預かっていない時（target 未指定＝自前ページ）だけ本物の window、埋め込み時は使い捨ての器。
// 器に変えても内部の読み書き（__backend の frame1 判定・__drawSendN の起動HUD）はそのまま通る＝挙動は不変。
// opts.debugGlobals で明示上書き可（埋め込みでも道具が欲しい時は true）。テスト（t-opts/t-webgpu 等）は
// target を渡さない起動なので従来どおり窓に生える。
const DEBUG_GLOBALS: GlobeScope["DEBUG_GLOBALS"] = opts.debugGlobals ?? !opts.target;
const dbgHost: GlobeScope["dbgHost"] = DEBUG_GLOBALS ? window as unknown as GlobeScope["dbgHost"] : {};
// 全球ビュー（既定＝2026-09-01 本人裁定「world=1をデフォルトに」・?world=0 が逃げ道）：
// z<BASEMAP_MINZOOM(6.5) はタイルなし＝全球ハイプソ（GEBCO×気候・シェーダ計算）＋NE admin0 の gint 線＋
// NE lakes のエンジン湖スロット（下記 loadLakes）。旧・Protomaps PMTiles（OSM/ODbL・world-water 湖のみ消費）は
// 2026-09-03 本人裁定「湖はNE経由＝B案」で撤去＝出典から © OpenStreetMap が消えた（pmtiles 配管と
// public/world-z3.pmtiles は 2026-09-14 に撤去済）。タイルは全z で optbv（日本域）のみ。
const WORLD_VT: GlobeScope["WORLD_VT"] = !/[&?]world=0/.test(location.search);
// 気候場テクスチャ（全球ハイプソ cross-blend・Köppen-Geiger/Beck et al. CC-BY 720x360 焼き縮め・public 資産）。
// boot と switchTheme の両方が worldHypso.clim に積む（再送は両レンダラとも取得済みキャッシュで no-op）
const CLIM_URL = opts.assetBase != null ? new URL("koppen-clim.png", new URL(ASSET_BASE, location.href)).href   // assetBase を指した時は従来どおりそこ（japan の SDK 等）
	: new URL("./assets/koppen-clim.png", import.meta.url).href;   // 既定＝パッケージ同梱（npm の globe を使う人の手元にも届く＝バンドラが資産として出す・2026-09-25）
// 汎用 PMTiles 基図（?pm=<URL>）＝任意の PMTiles アーカイブを基図ソースにする口。2026-09-03 に湖の NE 化で
// 撤去した pmtiles 配管（世界固定・world-z3.pmtiles 専用）を、ソース非依存の形で戻したもの。
// **範囲の制御はアーカイブの自己申告に任せる**：bbox もズーム域も層名も PMTiles のヘッダ/metadata が持って
// いる（エンジン pmtilesInfo）。GSI の JP_COVERAGE は「配信元が黙って 404 を返す」HTTP タイルに外から与える
// 知識だが、PMTiles は自分がどこを持つか知っている＝手で bbox を書かない（初めにデータありき）。
//   ・範囲外/ズーム域外のタイル … エンジン側の門が索引を歩く前に空タイルで返す（追加リクエスト 0）
//   ・maxZ … LOD の分割上限をアーカイブの maxZoom で止める＝そもそも要求を作らない（門は保険）
//   ・層名 … metadata の vector_layers から面/線の素の規則を自動生成＝どのアーカイブでも「とりあえず出る」
// 作り込んだ配色が要るなら style を書く（bvmap 用 style-gsi.js が前例）。
const PM_SPEC = new URLSearchParams(location.search).get("pm");
const PM_URL = PM_SPEC ? "pmtiles://" + new URL(PM_SPEC, new URL(import.meta.env?.BASE_URL || "/", location.href)).href : null;

// ── 外来の MapLibre style（#33・2026-09-23）──────────────────────────────────
// opts.style（URL か style の object）／?style=<URL>＝基図をその style で描く（地域の基図・?pm= より優先）。
// 基図に入るのは style の中の「ひとつのベクタ source」の fill / line / 点ラベル / background（読み替えは core の mlstyle.js）。
// 同じ style の raster source の層＝画像層（map.raster）・geojson/image source の層＝利用者の層（map.addLayer）へ振り分ける。
// 描けない層（fill-extrusion・線に沿うラベル・模様…）は数えて console に出す。書体（glyphs）はこの地図の文字で描く（text-font は読まない）。
// この形で起動した地図は map.setStyle(別の style) で生き替えできる（地域の基図で起動した地図は setStyle しない＝基図の門が違う）。
const STYLE_SPEC = opts.style ?? (q => {   // ?style= は URL の門（?g= と同じ＝https 限定・localhost の http は可）。opts.style は呼び手の責任
	if (!q) return null;
	try { const u = new URL(q, location.href); const local = u.hostname === "localhost" || u.hostname === "127.0.0.1"; if (u.protocol === "https:" || (u.protocol === "http:" && (local || u.origin === location.origin))) return u.href; } catch { /* 下で warn */ }
	console.warn("[style] ?style= must be an https URL", q); return null;
})(new URLSearchParams(location.search).get("style"));
// style.json の vector source の層のうち、利用者の層の口で描く物（段 8①・8⑤）：押し出し（どの vector source でも）・2 本目以降の vector source の fill／line／circle／symbol・
// 基図の source の circle（基図は円を描かない）。基図の source の fill／line／点ラベルは基図が描く（今まで通り）
const VT_DRAW = new Set(["fill", "line", "circle", "symbol", "heatmap"]);   // heatmap＝C1（2026-10-12）：worker は点集め・描くのは heatmap-gl（画面単位の密度）
const vtRouted: GlobeScope["vtRouted"] = (L, ms, baseSid) => ms.sources?.[L.source!]?.type === "vector" && !mlUnknownOps(L).length && (L.type === "fill-extrusion" || (VT_DRAW.has(L.type) && (L.source !== baseSid || L.type === "circle" || L.type === "heatmap")));   // 基図の配管が描けない型（circle・heatmap）は基図の source でも vtdraw へ
const loadExtStyle: GlobeScope["loadExtStyle"] = async (spec, transformStyle = null) => {
	let { style: ms, baseUrl } = await loadMapLibreStyle(spec, { fetchFn: ((u: string, init?: RequestInit) => requester.fetch(u, "Style", init)) as typeof fetch }) as { style: ExtStyleDoc; baseUrl: string | undefined };
	// setStyle(spec, { transformStyle })（MapLibre 同名・公式例の門 2 巡目）＝当てる前に書き換える（前の style と次の style を渡し、返りを使う）
	if (typeof transformStyle === "function") ms = transformStyle(EXT ? map.getStyle() : undefined, structuredClone(ms)) as ExtStyleDoc | undefined ?? ms;
	// sources の無い style（background だけ等＝MapLibre は通す）＝{} と見る（旧＝getStyle・基図の source の照会が EXT.ms.sources![id] で TypeError）。無い時だけ写す＝渡された object は書き換えない
	if (ms.sources == null) ms = { ...ms, sources: {} };
	// style の root の state（MapLibre v5：{ 鍵: { default } }）＝global-state の既定値。新しい style は状態を入れ替える（MapLibre の setStyle と同じ）
	if (ms.state && typeof ms.state === "object") setMapGS(Object.fromEntries(Object.entries(ms.state).map(([k, d]) => [k, d && typeof d === "object" && "default" in d ? d.default : null])));
	// spec の外の名前・置き場の取り違え（MapLibre は error 事象にして style を読まない＝ここは読んだ上で 1 回だけ警告・互換の計画 P0-5）
	const issues = validateMLStyle(ms);
	if (issues.length) console.warn(`[style] ${ms.name || spec}: ${issues.length} problem(s) against the MapLibre style spec —`, issues.slice(0, 10).map(i => (i.layer ? `"${i.layer}": ` : "") + i.message).join("; ") + (issues.length > 10 ? "; …" : ""));
	const split = splitMapLibreStyle(ms, { zoomOffset: STYLE_DZ });
	const src = split.vectorSource ? await resolveVectorSource(ms.sources![split.vectorSource], baseUrl, { fetchFn: ((u: string, init?: RequestInit) => requester.fetch(u, "Source", init)) as typeof fetch }) : null;
	const isVtx = (k: { id: string }) => { const L = (ms.layers || []).find(x => x.id === k.id); return !!L && vtRouted(L, ms, split.vectorSource); };   // vector の押し出し・2 本目以降の vector の描く層＝利用者の層の口で描く（段 8①・8⑤・mountExtExtras）
	const skipped = split.skipped.filter(k => !isVtx(k));
	if (skipped.length) console.info(`[style] ${ms.name || spec}: ${skipped.length} layers not drawn —`, [...new Set(skipped.map(k => `${k.type} (${k.why})`))].join(", "));
	return { ms, split, src, baseUrl, url: typeof spec === "string" ? baseUrl : null };
};
// 外来の標高タイル（raster-dem・#36）：opts.terrain＝{ source: raster-dem の spec, exaggeration } ／ ?dem=<XYZ の型紙>&demenc=terrarium|mapbox|gsi&demmax=<z>&demdtm=1
// quantized-mesh（#110）＝{ type:"quantized-mesh", url:"…/layer.json" | ion:{ assetId, accessToken }, heights, heightOffset, … }＝相対の url は頁基準で絶対に
const qmSpecOf: GlobeScope["qmSpecOf"] = sp => ({ ...sp, ...(sp.url ? { url: new URL(sp.url, location.href).href } : {}) });
const DEM0 = (() => {
	const absT = (sp: RasterDemSource) => ({ ...sp, tiles: (sp.tiles || []).map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")) });   // 相対の型紙は頁基準（render worker で解決させない）
	if ((opts.terrain as TerrainOpt | undefined)?.source && typeof (opts.terrain as TerrainOpt).source === "object") return ((opts.terrain as TerrainOpt).source as { type?: string }).type === "quantized-mesh" ? qmSpecOf((opts.terrain as TerrainOpt).source as QuantizedMeshSource) : absT((opts.terrain as TerrainOpt).source as RasterDemSource);
	const q = new URLSearchParams(location.search), u = q.get("dem");
	if (!u) return null;
	try { const x = new URL(u, location.href); if (x.protocol !== "https:" && !(x.protocol === "http:" && (x.hostname === "localhost" || x.origin === location.origin))) throw 0; if (q.get("demenc") === "quantized-mesh" || /\/layer\.json$/.test(x.pathname)) return { type: "quantized-mesh", url: x.href, heights: q.get("demheights") === "orthometric" ? "orthometric" : "ellipsoidal", dtm: q.get("demdtm") === "1" };   // ?dem=<layer.json>＝quantized-mesh（#110）・demheights=orthometric＝標高で配る物（swisstopo）
	return { tiles: [x.href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")], encoding: q.get("demenc") || "terrarium", maxzoom: +q.get("demmax")! || 14, dtm: q.get("demdtm") === "1" }; }
	catch { console.warn("[dem] ?dem= must be an https URL template", u); return null; }
})();
let EXT: GlobeLive["EXT"] = null;
if (STYLE_SPEC) { try { EXT = await loadExtStyle(STYLE_SPEC); } catch (err) { console.error("[style] cannot load the style — falling back to the default basemap", err); } }
const extBaseStyle: GlobeScope["extBaseStyle"] = ext => ({ version: 8, name: ext.ms.name, sources: { v: { type: "vector" } }, layers: ext.split.base, ext: true, globalState: { ...MAP_GS } });   // globalState＝tile worker の式の状態（setGlobalStateProperty で restyleBase が載せ直す）
const extSourceFields: GlobeScope["extSourceFields"] = ext => {   // BASE_SOURCE の中身（setStyle でも同じ形で差し替える）
	const s = ext.src;
	return { kind: s?.pmtiles ? "pmtiles" : "style", url: s?.pmtiles || s?.tiles?.[0] || ext.url || null, tileUrl: s ? tileUrlOf(s) : () => null,
		encoding: s?.encoding || "mvt",   // タイルの形式（style の vector source の "encoding"＝mvt｜mlt・#88）。PMTiles はアーカイブのヘッダが決める
		coverage: null, tileMinZoom: 0, lodFloor: null, minZ: Math.max(0, s?.minzoom ?? 0), info: s && !s.pmtiles ? { maxZoom: s.maxzoom ?? 14, minZoom: s.minzoom ?? 0 } : null,
		attrHTML: s?.attribution ? sanitizeHTML(String(s.attribution)) : null };
};
// ── 基図ソースの記述子 ───────────────────────────────────────────────────────
// 「どこから引くか・どこを持つか・どのズームから出すか・LOD の床・出典」を **一つの物** に束ねる。
// 旧構造ではこの5つが createPipeline の別々の引数と散在する門に分解されており、ソースを1種類増やすたびに
// `PM_URL ? A : B` が各所へ増えた（実測 8 箇所・6 つの関心事）。三種類目を足せばまた 8 箇所。
// 記述子にすれば「増えるのはここだけ」になる＝門は記述子を読むだけの受け身になる。
//   tileUrl     … (z,x,y)=>URL。pmtiles:// を返せばエンジンが PMTiles 経路へ入る
//   coverage    … 配信圏 bbox（外は fetch しない）。null＝外から与えない
//                 ＝PMTiles は自分の bbox をヘッダで宣言するのでエンジンの門に任せる（初めにデータありき）
//   tileMinZoom … タイルを出す下限。null＝BASEMAP_MINZOOM（「日本の基図を出す圏」と同一）に従う
//   lodFloor    … LOD の床。bvmap 固有の装置（z8 から海が全面WA）＝他人のアーカイブには当てはまらない
//   minZ        … タイル z の床（選抜・下地・毛布）
//   info        … ソース自身の申告（PMTiles のみ・非同期に届く）。maxZoom/層名/出典の出所
//   attrHTML    … 出典（消毒済み・info 到着時に入る）
// 記述子の出所は三通り：①?pm=（客が持ち込むアーカイブ）②地域宣言の basemap（日本＝地理院）
// ③宣言が basemap を持たない地域（オランダ）＝タイルを一枚も要求しない空ソース＝図郭外と同じ扱い
// （＝標高ゲート付き全面水域。日本の配信圏の外なので移設前の見え方と同じ・2026-09-17）。
const REGION_BASEMAP = REGIONS.map(r => r.basemap).find(Boolean) ?? null;
const REGION_RASTERS: GlobeScope["REGION_RASTERS"] = REGIONS.flatMap(r => r.rasters || []);   // 画像タイル（XYZ ラスタ）のカタログ＝地域パックが宣言（エンジンは知らない・?r= と切替ガジェットの鍵）
const BASE_SOURCE: GlobeScope["BASE_SOURCE"] = EXT ? extSourceFields(EXT) : PM_URL ? {
	kind: "pmtiles", url: PM_URL, tileUrl: () => PM_URL,
	coverage: null, tileMinZoom: 0, lodFloor: null, minZ: 0, info: null, attrHTML: null,
} : REGION_BASEMAP ? {
	kind: REGION_BASEMAP.kind, url: null, tileUrl: REGION_BASEMAP.tileUrl,
	coverage: /[?&]nocov=1/.test(location.search) ? null : REGION_BASEMAP.coverage,   // ?nocov=1＝A/B 検証ノブ
	tileMinZoom: REGION_BASEMAP.tileMinZoom, lodFloor: REGION_BASEMAP.lodFloor, minZ: REGION_BASEMAP.minZ,
	info: null, attrHTML: null,
} : {
	kind: "none", url: null, tileUrl: () => null,
	coverage: [0, 0, 0, 0],   // どのタイルとも重ならない＝fetch せず空タイル扱い
	tileMinZoom: null, lodFloor: null, minZ: undefined, info: null, attrHTML: null,
};
const TILE = 512, D2R: GlobeScope["D2R"] = Math.PI / 180, R2D: GlobeScope["R2D"] = 180 / Math.PI;

// 表示項目の固定（opts.layers）：true/false は状態を焼き付けてチップも出さない。未記述だけが客のトグル。
// 旧romajiキー（chimei/chikei/shisetsu）は公開済み共有URL（l=）の互換のため、URL からの読みだけ受ける（opts.layers の読み替えは 2.0 で外した）。
const LEGACY_LAYER_KEYS: Record<string, string> = { chimei: "place", chikei: "terrain", shisetsu: "facility" };
const normLayerKey = (k: string) => LEGACY_LAYER_KEYS[k] || k;
const fixedLayers: Record<string, boolean> = {};
if (opts.layers) for (const [k, v] of Object.entries(opts.layers)) {
	if (!(k in defaultLayerState)) { console.warn(`[layers] unknown key "${k}" (valid: ${Object.keys(defaultLayerState).join(", ")})`); continue; }
	if (typeof v === "boolean") fixedLayers[k] = v;   // boolean だけが固定。それ以外は「記述無し」と同じ＝既定＋チップ
}
const FREE_LAYER_KEYS = Object.keys(defaultLayerState).filter(k => !(k in fixedLayers));   // 客が触れる＝URLに載る集合
// 星座線の表示状態も共有URLの l= に載せる疑似キー（layerState/チップとは別系統＝z<4の星空劇場のトグル）。
// defaultLayerState には無い＝チップ選抜・themes には一切干渉しない（点火/ラベルの経路を汚さない）。
const SKY_LAYER = "sky";
// 配色テーマ（palettes.js の台帳）：共有URLの c=<name>（sky/l= と同じ後置トークン＝夜のまま人に渡る）。
// style は起動時に pipeline/worker へ焼き付くため一度だけ選ぶ：ハッシュ手編集での切替は hashchange が reload で応える。
const themeFixed: GlobeScope["themeFixed"] = !!opts.theme;   // 埋め込みの焼き付け＝URLに書かず、ハッシュでも破れない
const themeBootV: GlobeScope["themeBootV"] = parseViewHash(opts.view || pageHash);
let themeName: GlobeLive["themeName"] = typeof opts.theme === "string" ? opts.theme
	: themeBootV?.theme || (themeBootV?.layers?.includes("dark") ? "dark" : "mono");   // l=dark＝c=移行前の互換読み
if (typeof opts.theme !== "object" && themeName && !MAP_THEMES[themeName] && normWorldTheme(themeName)) themeName = normWorldTheme(themeName)!;   // 旧名を正名へ（c=gsi → topo・c=night → dark）＝別名の台帳は ortho-core worldstyle 一本
if (typeof opts.theme !== "object" && !MAP_THEMES[themeName]) console.warn(`[theme] unknown theme "${themeName}" = starting as mono (valid: ${Object.keys(MAP_THEMES).join(", ")})`);
let theme: MapTheme = typeof opts.theme === "object" ? { ...MAP_THEMES.mono, ...opts.theme }   // カスタム＝mono を土台に部分上書き
	: (MAP_THEMES[themeName] || MAP_THEMES.mono);
// 基図の層への実行時の上書き（MapLibre 互換の段 7）＝id → { paint, layout, filter, minzoom, maxzoom, removed }。有効な基図 style＝元の style＋上書き。
// 出し入れ（visibility）は別の台帳 baseVis＝結合の時に層の添字で外す安い経路（組み直さない）。テーマを切り替えても上書きは残し、setStyle では捨てる（MapLibre と同じ）
const baseOverrides: GlobeScope["baseOverrides"] = new Map(), baseVis: GlobeScope["baseVis"] = new Map();
// 検査表示（#174）の間＝基図の全層を結合から外す（baseHiddenIdx・焼き直さない・注記も出さない）。利用者の基図の出し入れ（baseVis）はそのまま＝戻すと元の絵
let inspectHide: GlobeLive["inspectHide"] = false;
let inspectReapply: GlobeLive["inspectReapply"] = () => {};   // テーマ・基図の style を替えた後に検査表示の下地（陸の色・世界の帯）を掛け直す（inspectView が差す）
const baseMoves: GlobeScope["baseMoves"] = [];
const moveBefore: GlobeScope["moveBefore"] = (arr, id, before, idOf) => {
	const i = arr.findIndex(x => idOf(x) === id); if (i < 0) return;
	const [x] = arr.splice(i, 1), j = before == null ? -1 : arr.findIndex(y => idOf(y) === before);
	arr.splice(j < 0 ? arr.length : j, 0, x);
};
const withBaseOverrides: GlobeScope["withBaseOverrides"] = st => {
	if (!baseOverrides.size && !baseMoves.length) return st;
	const layers = [];
	for (const L of st.layers) {
		const o = baseOverrides.get(L.id);
		if (!o) { layers.push(L); continue; }
		if (o.removed) continue;
		const L2 = { ...L };
		for (const k of ["paint", "layout"] as const) if (o[k]) { L2[k] = { ...(L[k] || {}), ...o[k] }; for (const [p, v] of Object.entries(o[k])) if (v === undefined) delete L2[k]![p]; }   // undefined＝その性質の既定へ（MapLibre）
		for (const k of ["filter", "minzoom", "maxzoom"] as const) if (k in o) { if (o[k] == null) delete L2[k]; else (L2 as Record<string, unknown>)[k] = o[k]; }
		layers.push(L2);
	}
	for (const [id, , bb] of baseMoves) moveBefore(layers, id, bb, L => L.id);   // 基図の moveLayer（S-P2-2）＝描く順（li）も style の順も
	return { ...st, layers };
};
// addLayer({type:"background"})（B5）＝実行時に足した background 層。基図の層の先頭に置く（beforeId は見ない）。setStyle で捨てる（MapLibre と同じ）
const userBg: GlobeScope["userBg"] = [];
const withUserBg: GlobeScope["withUserBg"] = st => (userBg.length ? { ...st, layers: [...userBg.map(L => ({ ...L })), ...st.layers] } : st);
let style: GlobeLive["style"] = withBaseOverrides(withUserBg(EXT ? extBaseStyle(EXT) : theme.style));   // 外来 style＝基図はその層（テーマの配色は背景・大気・建物色だけに効く）
// 旧・世界層前置（withWorld＝world-water 湖タイル層）は撤去（2026-09-03 湖のNE化）＝style はテーマの素のまま。
// 湖の色は worldPal.sea をレンダラが直接読む（u_seaC と単一の出所＝テーマの worldHypso.sea が両方へ届く）。
// window/document 級のリスナーは全てこの signal で登録＝destroy() の abort 一発で束ごと外れる（外し漏れゼロ）。
// 家具（チップの Esc）とキーの持ち主も使う＝家具を生やす前に作る（#173 段 3）
const ac: GlobeScope["ac"] = new AbortController();
registerKeyOwner(mapEl, ac.signal);   // 頁に地図が複数ある時のキーの持ち主（最後に触った地図・gadgets/keys.js）
mountGadgets(mapEl, { chips: opts.chips, instruments: opts.instruments, fixedLayers, attribution: REGION_ATTR, signal: ac.signal });   // UI を #map に生やす＝以降の getElementById が実体を掴めるよう、全lookupの前で
// 非搭載（chips:false / instruments:false）でも配線コードは無改造＝繋ぎ先が無ければ宙のdiv（どこにも描画されない）へ。
const orDetached = (el: HTMLElement | null) => el || document.createElement("div");
const canvas: GlobeScope["canvas"] = mapEl.querySelector<HTMLCanvasElement>("#c")!;
const labelCanvas: GlobeScope["labelCanvas"] = mapEl.querySelector<HTMLCanvasElement>("#labels")!;
const labelGpuCanvas = mapEl.querySelector<HTMLCanvasElement>("#labelsgpu");   // ?text=gpu の時だけ
const logEl = orDetached(mapEl.querySelector<HTMLElement>("#log"));
// 低メモリ端末判定（boot/tier.js lowMem＝≤4GB のスマホ帯・iOS はタッチで一律）。renderWorker（R10キャッシュ縮小）と
// plateau worker（キャッシュ0・バッチ縮小）の両方に配るため、worker生成より前＝ここで定義。
const LOW_MEM: GlobeScope["LOW_MEM"] = lowMem(navigator);

// --- 初見が死なない：起動できない環境・壊れた環境を白画面でなく言葉で受け止める（boot/tier.js fatalOverlay / deadMap）---
const fatalOverlay = (title: string, detail: string, reload?: boolean) => showFatal(mapEl, title, detail, reload ? t("Reload") : null);   // reload=true で「再読み込み」ボタン付き
// 対応判定：このアプリの土台は WebGL2 ＋ OffscreenCanvas（GL を worker に置く設計）。無い環境では静かに案内して止まる。
// 「非対応」の確実な判別器は transferControlToOffscreen の欠落だけ（これを持つ世代のブラウザは全て WebGL2 対応）。
// webgl2=null 単独は非対応と断定できない：GPUプロセスのクラッシュ直後（OOM→contextlost の自動リロード直後）は
// 対応ブラウザでも一時的に null を返す＝以前はここで「ブラウザ非対応」と誤診して行き止まりになっていた（M1実機で発生）。
// → 復帰を10秒リトライ（クラッシュ直後は1〜数秒で戻る）。復帰すればそのまま起動続行、ダメなら環境向け案内＋再読み込み。
let gpuRenderer = "";   // GPU 素性の文字列（下の MID_TIER 判定用）。probe の使い捨てコンテキストから同乗で頂く
{
	const probeGL = () => { const r = probeWebGL2(); if (r.renderer != null) gpuRenderer = r.renderer; return r.ok; };   // 判定用の 1 枚に相乗りして GPU 素性も頂く（boot/tier.js）
	if (!HTMLCanvasElement.prototype.transferControlToOffscreen) {
		fatalOverlay(t("This map cannot be displayed in your browser"),
			t("This 3D globe is drawn with WebGL2 and OffscreenCanvas. Please try the latest Chrome / Edge / Firefox, or Safari 17 or later."));
		console.warn("[boot] unsupported: offscreencanvas = quiet exit (guidance overlay shown)");
		LIVE_CONTAINERS.delete(mapEl); releaseUrl(); ac.abort(); return deadMap() as GlobeMap;   // 起動しなかった＝容れ物は空き（同じ容れ物で起動し直せる）
	}
	if (!probeGL()) {
		const waiting = fatalOverlay(t("Waiting for the GPU to respond…"),
			t("This can appear right after the graphics process restarts. It should start automatically in a few seconds."));
		let ok = false;
		for (let i = 0; i < 10 && !ok; i++) { await new Promise(r => setTimeout(r, 1000)); ok = probeGL(); }
		waiting.remove();
		if (!ok) {
			fatalOverlay(t("Cannot start 3D rendering"),
				t("Your browser is supported, but the GPU (WebGL2) is not responding. Quit the browser completely and reopen it, or check that hardware acceleration is enabled in the settings."), true);
			console.warn("[boot] webgl2 unavailable after 10s retry (hardware acceleration off?) = quiet exit (guidance overlay shown)");
			LIVE_CONTAINERS.delete(mapEl); releaseUrl(); ac.abort(); return deadMap() as GlobeMap;   // 起動しなかった＝容れ物は空き
		}
	}
}
// --- 機体のティア（boot/tier.js classifyTier）：非力デスクトップ MID_TIER（内蔵GPU・4コア以下・RAM の多いスマホ）は PLATEAU の山を半分に、
// ハイスペック HI_TIER（12コア以上）はロード並行度だけ上へ。根拠と実測は module の注記・台帳は fallback-ladder.md。?mid=0/1・?hi=0/1 が戻し口。
const { MID_TIER, HI_TIER } = classifyTier({ LOW_MEM, gpuRenderer, search: location.search, nav: navigator, coarse: () => matchMedia("(pointer: coarse)").matches });
if (MID_TIER) console.log(`[boot] mid-tier device = PLATEAU to safe side (gpu="${gpuRenderer || "unknown"}" cores=${navigator.hardwareConcurrency || "?"})`);
if (HI_TIER) console.log(`[boot] hi-tier device = PLATEAU wide lanes (cores=${navigator.hardwareConcurrency}, bldCap=3, tileConc=16, decPool)`);
// ── 世界の形（現在＝通常・HI のデスクトップは WGS84 楕円体・LOW_MEM と MID_TIER は球・?ell=1／?ell=0・opts.ellipsoid で上書き。計測は常時WGS84＝段階A無条件）──
// 楕円体（段階B 2026-08-11）＝WGS84 を「β（更成緯度）単位球×S」に分解して立てる（ortho-core camera.js の
// setEllipsoid・ELL 時は世界単位＝a）。決定はこの1点のみ＝worker 文脈（render/plateau/tile）へは各 init の
// ell: で搬送（モジュール状態のため必須）。PLATEAU キャッシュは meta.ell 印で世代分離＝モードを往復すると
// 全区焼き直しになるため、フラグ2本とも開発時の切り分け専用（常用しない）。
// 裁定の歴史：
//  ①既定化（2026-08-11 本人「見た目では全く区別つかない・ell=1をデフォルトに」＝?gpu=1→既定化と同じ道）。
//  ②実機事故（同日）：①の世代分離が全端末で一斉発火＝焼き済み PLATEAU 全区無効→「再訪＝直読み」の堀を失い、
//    全区の再DL+再デコード＋60秒ローテ先読みが重なって iPad Air3(3GB) が jetsam ループ
//    （基図はマスクで伏せ済み×メッシュ未着＝「ビルが消えた」絵）。
//  ③★凍結（同日 本人「モバイルは現状維持。動く・落ちないが大前提」＝発表 8/24 LT 前）：LOW_MEM は球に
//    据え置き＝焼き済み資産・挙動とも改修前とビット同値。将来のモバイル楕円体は別途の裁定
//    （その時はキャッシュ移行＝球焼き→β変換復元とセット）。
//  ④★表示は球へ戻し（2026-08-19 本人「表示は球・計測はWGS84。ell=1で表示もWGS84」）：?perf=1 実測で
//    楕円体表示が GPU 約1割の固定費（dβ 補正＝楕円体ONでは毎頂点の定価・wgsl.js dBeta）と判明。一方で
//    視覚差は扁平率 0.34%・局所異方性 ≤0.5%＝知覚限界以下、層間は同一写像＝ズレ厳密ゼロ、計測の正しさは
//    段階A（Vincenty/authalic・無条件）が担う＝表示の楕円体は絵に寄与しない。モバイル恒久球（③）とも
//    世界の形が揃う。⚠この切替でデスクトップの焼き済み PLATEAU は世代交代（meta.ell 印）＝初回のみ再焼き。
//  ⑤★通常・HI のデスクトップで楕円体を既定に（2026-09-28 本人「LOW_MEM 以外は適用できるように」・MID_TIER も球＝裁定 B・#43）：
//    段 0＝測る台（tests/t-ellparity）・段 1＝楕円体で落ちていた物（3D Tiles・heatmap・GL2 の床…）を直した上で。決定＝boot/tier.js ellipsoidMode
//    （URL › opts.ellipsoid › 自動）。PLATEAU の楕円体の焼きは R2 に全区そろい（段 2）＝初回は R2 から取り直すだけ。GPU 約1割の固定費は承知の上。
//    格付け（classifyTier の MID_TIER）が要る＝決定はこの下（旧＝LOW_MEM の直後・URL だけ）
const ellDec = ellipsoidMode({ opt: opts.ellipsoid ?? "auto", search: location.search, LOW_MEM, MID_TIER });
if (ELL_PAGE && ELL_PAGE.ell !== ellDec.ell) console.warn(`[geo] this page already renders the ${ELL_PAGE.ell ? "ellipsoid" : "sphere"} (${ELL_PAGE.why}); this map follows it instead of ${ellDec.why}`);
ELL_PAGE ??= ellDec;
const ELL_ON: GlobeScope["ELL_ON"] = ELL_PAGE.ell;
console.log(`[geo] world=${ELL_ON ? "WGS84 ellipsoid (beta-sphere x S)" : "sphere 6371km"} (${ELL_PAGE.why}; ?ell=1 / ?ell=0 to override; measurement always WGS84)`);   // 実機切り分けの計器（スクショのコンソールで世界が判る・走らせ台 ui-runner が読む）
setEllipsoid(ELL_ON);
const EARTH_M: GlobeScope["EARTH_M"] = worldRadiusM(), TERR_EXAG: GlobeScope["TERR_EXAG"] = 1.0;   // m→世界単位の換算半径は camera.js が正本（球6371000/楕円体a）。標高は実スケール（誇張しない＝地形を歪めない）。ラベル・地形・建物で共有
// 通信断トースト：offline イベント＋タイル連続失敗で表示、回復（online/タイル成功）で消える。地図は粗い下地で生き続ける。
const netEl = document.createElement("div");
netEl.id = "net-toast";   // スタイルは style.css
netEl.textContent = t("Failed to load map data (please check your connection)");
mapEl.appendChild(netEl);
// 縦向き案内：スマホ横向き（coarseポインタ＋低い横長ビューポート）で縦向きを促す。表示制御は CSS メディアクエリのみ
// ＝JSは要素を置くだけ（回転すれば自然に消える）。タップで閉じたら inline display:none がメディアクエリに勝つ＝再表示しない。
const rotEl = document.createElement("div");
rotEl.id = "rotate-toast";   // スタイルと表示条件は components.scss（#rotate-toast）
rotEl.textContent = t("Please rotate your device to portrait (tap to dismiss)");
rotEl.onclick = () => { rotEl.style.display = "none"; };
mapEl.appendChild(rotEl);
let tileFails = 0;
const onTile = (ok: boolean) => {
	if (ok) { tileFails = 0; if (navigator.onLine !== false) netEl.style.display = "none"; }
	else if (++tileFails >= 3) netEl.style.display = "block";   // 3連続失敗＝ネット全滅の疑い（単発404では出さない）
};
window.addEventListener("offline", () => { netEl.style.display = "block"; }, { signal: ac.signal });
window.addEventListener("online", () => { netEl.style.display = "none"; requestDraw(); }, { signal: ac.signal });

// 効いている background 層＝一番上（後ろ）の、見えている物（MapLibre は後の層が上に塗る）。baseVis の none（setLayoutProperty）も見る
const bgOf: GlobeScope["bgOf"] = st => { let b = null; for (const L of st.layers) if (L.type === "background" && L.layout?.visibility !== "none" && baseVis.get(L.id) !== "none") b = L; return b; };
let bg: GlobeLive["bg"] = bgOf(style);
// MapLibre の目盛りの地図で style に background 層が無い＝MapLibre の canvas は透明（頁の白が見える）＝球の地（陸も海も）を白で（2026-09-30・公式例 20 本の地の色）。内製の既定は従来の紙色と海の色
const NO_BG_WHITE: GlobeScope["NO_BG_WHITE"] = !!ML_COVER;
const landDefault: GlobeScope["landDefault"] = () => (NO_BG_WHITE ? [1, 1, 1, 0] : [0.96, 0.96, 0.95, 1]);   // MapLibre の口＝透明（本人裁定 2026-10-12・B5。WebGPU は白に畳む）
const seaOf: GlobeScope["seaOf"] = bg => (NO_BG_WHITE && !bg ? [1, 1, 1] : null);
// background 層 → 球の床の色（rgb）と不透明度（a＝background-opacity）。MapLibre の口で層が無い＝a 0（透明・頁の色）。式は z10 で評価（従来どおり）
const landOf: GlobeScope["landOf"] = (bg, dflt) => {
	if (!bg) return dflt;
	const ev = (v: unknown, d: string | number) => evalExpr<string | number>(v ?? d, { zoom: 10, props: {}, geom: null, vars: {}, gs: MAP_GS, origin: originOfLayer(bg) }) ?? d;
	const c = parseRGBA(ev(bg.paint?.["background-color"], "#fff")), op = +ev(bg.paint?.["background-opacity"], 1);
	return [c[0], c[1], c[2], c[3] * (Number.isFinite(op) ? Math.max(0, Math.min(1, op)) : 1)];
};
let land: GlobeLive["land"] = landOf(bg, landDefault());
// 白抜き家具（本人裁定 2026-08-05「紙の世界を司る神」）：計器・アイコン・出典を地図の明暗に依らず常に黒硝子＋白線へ（quiet-mono #map.ui-dark）。
// 旧＝land輝度<0.45（暗い紙）の時だけ夜家具。今は常時ON＝昼夜で意匠がブレず、白線 on 黒硝子で輪郭が締まる（状態HUDと同族）。戻すなら下の add を輝度条件へ。
mapEl.classList.add("ui-dark");
// 宇宙（球の外側）。MapLibre の口＝透明（MapLibre の canvas は描かない所が透明＝頁の色が見える・地平線の上も同じ・本人裁定 2026-10-12・B5）。opts.clearColor（色か "transparent"）で変えられる
const clearOf = (c: unknown): readonly number[] | null => (c === "transparent" ? [0, 0, 0, 0] : typeof c === "string" && isColor(c) ? parseRGBA(c) : Array.isArray(c) && c.length === 4 ? c : null);
let clear = clearOf(opts.clearColor) ?? (ML_COVER ? [0, 0, 0, 0] : [0.03, 0.04, 0.07, 1]);

let dpr: GlobeLive["dpr"] = Math.min(2, window.devicePixelRatio || 1);

// --- render worker：GL を OffscreenCanvas で worker に置く。main は set/draw を postMessage する薄いプロキシ ---
// transfer 後は main から canvas.width を触れないので、論理サイズ(size)を main が自前で持つ。
// 下限 1px（2026-09-29）：容れ物の高さ 0 で起動すると縦横比が無限大＝投影行列の逆が作れず（unproject が null を読んで例外）・WebGPU は大きさ 0 のテクスチャで落ちた。
// 1px で描いておき、大きさが付けば ResizeObserver の resize が追う（MapLibre も大きさ 0 の容れ物で壊れない）
const size: GlobeScope["size"] = { w: Math.max(1, Math.round(mapEl.clientWidth * dpr)), h: Math.max(1, Math.round(mapEl.clientHeight * dpr)) };
canvas.width = size.w; canvas.height = size.h;             // transfer 前に初期サイズ
labelCanvas.width = size.w; labelCanvas.height = size.h;
const offscreen = canvas.transferControlToOffscreen();
if (labelGpuCanvas) { labelGpuCanvas.width = size.w; labelGpuCanvas.height = size.h; }
const labelOffscreen = labelCanvas.transferControlToOffscreen();
const labelGpuOffscreen = labelGpuCanvas ? labelGpuCanvas.transferControlToOffscreen() : null;
const renderWorker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "render" });   // 入口 1 本（worker.js）＝役割は name で指名
// scene worker → render worker の直結パイプ（main を経由しない geometry）。両端を各 worker へ渡す。
const sceneChan = new MessageChannel();
// ?maxact=N / ?tbudget=N ＝低メモリ端末の安全側の絞りを実機で緩めて jetsam 完走を A/B する数値ノブ（?nomd と同格）。
// 狙いは②GPU常駐（表示区数）と④タイル予算だけを動かすこと＝①過渡デコードメモリ（jetsamの主犯）には触れない
// ＝bldCap・BATCH_TILES・TILE_CONCURRENCY は据置。基準機は 4GB 実機（タブ予算は 8GB 機の~1.4GBより小さい）。
const qNum = (re: RegExp, def: number) => { const m = location.search.match(re); return m ? +m[1] : def; };
// ?nomd=1 ＝multi_draw（タイルGPU常駐）を切って従来の CPU merge へ強制フォールバック。同一ビルドで A/B 比較する検証ノブ。
// 低メモリ端末は既定OFF：iOSではWebGLバッファがWebContentプロセス＝タブ予算(~1.4GB)に直接乗り、常駐プールは
// 伸びる一方＝鉄道地図(z14.5都心)級の密度でjetsam（iPhone 16 Pro実機の?nomd=1 A/Bでデモ完走＝犯人確定）。
// 従来のCPU mergeは常駐プール無し＋小画面はタイル数も少ない＝軽い。?md=1＝強制ON（将来の再検証ノブ）。
const noMultiDraw = /[?&]nomd=1/.test(location.search) || (LOW_MEM && !/[?&]md=1/.test(location.search));
// MSAA：LOW_MEM は既定 1x（裁定2026-08-12・Air3「時たま落ちる」対策）＝フルRetina面積の 4x カラー＋深度は
// ~100MB級のGPU固定費（WebGPU実測概算・GL2はブラウザ暗黙確保で同格）。?msaa=0＝どの端末でも常時 1x
//（従来からの診断ノブ）。線は SDF カプセル（シェーダAA）＝主に効くのは建物エッジ。
// WebGPU の既定＝遷移時AA（裁定2026-08-19）：カメラ遷移中は 1x 直描き・静止フレームだけ 4x（?perf=1 実測で
// MSAA の store/load/resolve 帯域が最大の固定費＝1x なら動的解像度も落ちない）。?msaa=1＝常時 4x 固定
//（旧挙動・実機A/B用。LOW_MEM の MSAA 復帰ノブも兼ねる）。GL2 は context 生成時固定＝遷移時AAの対象外。
const MSAA_OFF = /[?&]msaa=0/.test(location.search) || (LOW_MEM && !/[?&]msaa=1/.test(location.search));
const MSAA_PIN = /[?&]msaa=1/.test(location.search);   // 常時4x固定（遷移時AAを無効化）
// ?nogint=1 ＝gint（海岸線/知性層）を丸ごと停止＝1canvas統合の負荷・メモリを A/B 比較する検証ノブ（?nomd=1 と同格）。
const noGint = /[?&]nogint=1/.test(location.search);
// ?perf=1 ＝render worker がフレーム内訳（map/gint の CPU ms・フレームEMA・JSヒープ）を2秒毎に console へ出す。
const perfLog = /[?&]perf=1/.test(location.search);
// 状態盤HUD（旧 mem=1）。左上スタックの「計測器」ボタンで右下（出典の上）のテーブルを開閉する。実機で「落ちる」の切り分け用＝
// device(RAM/DPR/UA)・backend(WebGPU/GL2)・FPS・メモリ台帳(合計/ピーク/予算残)を一望。三態＝?hud=1 は計測器ボタン＋最初から開く／
// ?hud=0 はボタンのみ（畳んだ状態で搭載＝落ちそうな時だけ開く）／無指定は非搭載（ボタンもテレメトリも無し）。どちらの値でも render/plateau
// worker へテレメトリ送出を要求し、本体 gadgets/hud.js は hud= 指定時だけ遅延 import＝通常ユーザーの初期バンドルには一切乗らない。
const hudParam = /[?&]hud=([01])/.exec(location.search);
const hudOn = !!hudParam, hudOpenInit = hudParam?.[1] === "1";   // hudOn＝ボタン＋テレメトリを載せる（1でも0でも）・hudOpenInit＝パネルの初期表示（1=開く/0=畳む）
// ?drawhud=1 ＝描画実績HUD（実機用の計器）。「背景が黒くなる」瞬間に、塗りが何枚描かれたか・退場フラグ・
// フェード進行・PLATEAUバッチ数を画面へ出す。塗り0枚なら CPU/状態側（シーンが空・退場）、
// 枚数が出ているのに黒なら GPU 側＝二分の起点になる（Android 実機の反転 2026-08-03・USB接続なしで読める）。
const drawHud = /[?&]drawhud=1/.test(location.search);
let memTerrain = 0, memHeap = 0, memGpu: { atlas: number; mesh: number; msaa: number; pool?: number } | null = null, memRaster = 0;   // render worker から届く terrain LRU バイト・JS ヒープ・GPU固定常駐概算（?hud=1 時のみ更新）
let memFps = 0, memFrameMs = 0, memRes = 1, memBackend: string | null = null, memGpuName = "";   // 同テレメトリの描画実測＝FPS・frame ms・動的解像度・backend(webgpu/webgl2)・GPU名
let memLab: unknown = null;   // 注記の計器（テキスト GPU 化 T-P0）＝{ ms, collideMs, labels, glyphs }＝labels2d の draw の EMA・衝突判定・描いた数（t-perfbench の lab 列）
let memGpuMap = 0, memGpuGint = 0, memAa = 0, memHitch: unknown = null, memTerr: unknown = null, memGpuShadow = 0, memShadow: Omit<NonNullable<HudSnapshot["shadow"]>, "gpuMs"> | null = null;   // 同テレメトリ（perf plan Phase 0）＝GPU 実時間の EMA・AA 段・引っ掛かり累計・地形チャンクの刈り（P4）。ベンチ台（t-perfbench）が dbgHost.__perf で読む
// 計器 e／f（`vt perf plan.md` §2・Phase 0）：e＝基図のタイルが「選抜で必要になった→main のシーンに載った」の遅れ（tiles.shown が ack 時に返す・主層だけ）・
// f＝main merge の要求 1 回あたりの「変わった枚数／全枚数」（P2 が消す仕事の量）。どちらも直近 512 件の環＝ベンチ台（t-perfbench）が at で窓を切る（dbgHost.__vtLog）。__perf には直近 10 秒の要約
interface VtLatRec { at: number; key: string; z: number; total: number; ready: number; wait: number; fetch: number; build: number }
interface VtMergeRec { at: number; add: number; del: number; n: number }
const vtLat: VtLatRec[] = [], vtMerge: VtMergeRec[] = [];
const vtPush = <T,>(a: T[], v: T): void => { a.push(v); if (a.length > 512) a.shift(); };
const vtSummary = (sinceMs = 10000) => {
	const t0 = performance.now() - sinceMs, q = (a: number[], f: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]; };
	const L = vtLat.filter(r => r.at >= t0), M = vtMerge.filter(r => r.at >= t0);
	const tot = L.map(r => r.total);
	return { lat: { n: L.length, med: q(tot, 0.5), p90: q(tot, 0.9), wait: q(L.map(r => r.wait), 0.5), fetch: q(L.map(r => r.fetch), 0.5), build: q(L.map(r => r.build), 0.5) },
		merge: { n: M.length, changed: M.length ? M.reduce((s, r) => s + r.add + r.del, 0) / M.length : 0, tiles: M.length ? M.reduce((s, r) => s + r.n, 0) / M.length : 0 } };
};
dbgHost.__vtLog = () => ({ lat: vtLat.slice(), merge: vtMerge.slice() });
dbgHost.__perf = () => ({ fps: memFps, frameMs: memFrameMs, res: memRes, gpuMap: memGpuMap, gpuGint: memGpuGint, aa: memAa, hitch: memHitch, terr: memTerr, backend: memBackend, gpu: memGpuName, gpuShadow: memGpuShadow, shadow: memShadow, lab: memLab, vt: vtSummary() });   // gpuShadow/shadow＝影の深度パス（#112 段 0・t-shadowbench）。lab＝注記の計器（T-P0）。vt＝計器 e／f の直近 10 秒
// 混成R01近景（高チルト山岳の細かい起伏）は全端末で既定ON（lowMem含む）。旧・lowMemはR10止まり（富士3Dのjetsam対策80170b8）
// だったが、標高アトラスR16F化（GPU半減）＋iOS 4GB実機で peak 84MB・完走を実測して安全確認済み。
// ?nor01=1 ＝過渡デコードで落ちる端末が出た時の逃げ道（無効化＝全面R10へ）。
const noMixedR01: GlobeScope["noMixedR01"] = /[?&]nor01=1/.test(location.search);
// ?gpu=1 ＝WebGPU バックエンド（実験・Phase 1: globe+基図 fill/line）。非対応/失敗は worker 内で WebGL2 へ
// 自動フォールバック＝既定挙動と同一。既定経路には dynamic import すら発生しない（バンドル・実行とも無負担）。
// ?gpu=1＝WebGPU 実験フラグ。oj.nogpu＝この環境で「初期化は成功するのに絵が出ない」を検出済み（下の present 検証）
// ＝次の1ブートだけ WebGL2（起動時に消費・累積2回で固定＝柔らか鍵、下の定義部）。iOS Safari 実測 2026-08-02：backend=webgpu ログまで
// 進むが画面に画素が届かない（worker×OffscreenCanvas×WebGPU の present 未接続系）＝例外ゼロの沈黙故障。
// モバイル：ページ自体のネイティブズーム禁止＝地図のズームだけが生きる。iOS Safari は viewport の
// user-scalable=no を無視するため gesture 系 preventDefault が本丸（canvas の touch-action:none は
// canvas 起点タッチのみ＝UI 跨ぎピンチやダブルタップは素通りする。Kenji 指示 2026-08-02）。
for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(t, e => e.preventDefault(), { passive: false, signal: ac.signal });   // signal＝destroy で外す（#173 段 3・旧は取り残し）
// 【既定化 2026-08-02】WebGPU を既定へ（本人裁定「デフォルトgpu」）。根拠＝同日の実機実測：メモリが構造的に軽く
// （mdプール不在）、3GB機(iPad Air3)の走行距離が伸びる。navigator.gpu の無い環境（iOS≤18=XS級・旧ブラウザ）は
// 最初から WebGL2 直結＝dynamic import もリレー迂回も発生しない＝従来と完全同一。落ち先の網は3枚：
// ①worker内 adapter/初期化失敗→GL2 自動フォールバック ②present沈黙故障→oj.nogpu＋reload ③frame1 20秒→GL2再起動。
// ?gl2=1＝手動逃げ道（強制GL2）。?gpu=1＝nogpu印を無視して再試行（診断用）。⚠Windows実機は未確認＝網の内側の残リスク。
// 【Android は一律 GL2・2026-08-03 本人裁定】入門機実機で「遷移中に基図だけ黒く落ちる」（?gl2=1 は正常＝WebGPU 経路で
// 確定・エラー無しの沈黙故障・Mac 再現せず）。外部調査＝Adreno/Mali の Vulkan には黒画面バグ族が多数記録され、
// 最有力の正しさバグ（Adreno 830 の非決定的コマンド化け）は**2025年フラッグシップの報告**＝「高級機なら安全」は
// 成り立たない。一方 GL2 に落として失うものは Android では計測上ない（WebGPU のメモリ優位は Apple 実機の実測・
// スマホは画面が狭く classic merge でも体感差なしの裁定済み）。機種別 allowlist は検証手段が無く作らない＝一律。
// iOS は非対称のまま WebGPU 既定（実機検証済み＋メモリ優位実測済み）。将来 Dawn が枯れたら ?gpu=1 で再評価
//（?gpu=1 はこのゲートも突破する＝再評価の入口を残す）。⚠デスクトップモード偽装 UA は Android を名乗らない＝
// 素通りするが、稀ケースかつ落ち網3枚の内側なので許容。
const IS_ANDROID = /Android/.test(navigator.userAgent) || (navigator as NavigatorPlus).userAgentData?.platform === "Android";
const forceGl2 = /[?&]gl2=1/.test(location.search);
// 【WebKit × WebGPU × 重ねた WebGL2 は描かれない・2026-09-21 本人 iPad 実機】同一フレームのオーバーレイ（#13）は
// 自前の OffscreenCanvas に WebGL2 で描く。本体が WebGPU の時、WebKit（iPadOS/Safari）ではこの 2 枚目だけが
// 出ない（?gl2=1 なら出る＝WebGPU 経路で確定・エラー無しの沈黙故障・Chrome の WebGPU では再現せず）。
// 対処＝Android と同じ形：オーバーレイを重ねるページが opts.glOverlay:true を宣言し、WebKit ではそのページだけ
// WebGL2 を選ぶ（落とすのは本体の backend 選択だけ＝他のページと機能は変わらない）。?gpu=1 はこの封も破る（再評価の入口）。
const IS_WEBKIT = navigator.vendor === "Apple Computer, Inc." || (/Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Android|CriOS|FxiOS|Edg\//.test(navigator.userAgent));
const sealGpuForOverlay = !!opts.glOverlay && IS_WEBKIT;
// 【柔らか鍵 2026-08-04】旧 oj.nogpu は「一発失敗＝タブが生きている限り GL2 固定・表示なし」＝黙殺だった。
// だが失敗2経路のうち watchdog(20秒 frame1 不達)は遅い回線でも誤爆する＝一度の躓きで 3GB 機が重い GL2 に
// 落ちたまま jetsam（タブ落ち→Safari 自動リロードでも sessionStorage は生き残る＝固定が続く悪循環）。
// 新方式＝①印は起動時に消費（このブートだけ GL2・次のリロードは WebGPU 再試行）②累積 oj.nogpuN が
// 2 回に達したら本物の故障とみなしタブセッション固定 ③フォールバック中は画面チップで明示＋タップで
// 印を全部消して再試行（CNG フリートの見回り診断）。WebGPU の present 検証が通ったら累積もリセット。
const nogpuN = +(sessionStorage.getItem("oj.nogpuN") || 0);
const nogpuMark = sessionStorage.getItem("oj.nogpu");
if (nogpuMark && nogpuN < 2) sessionStorage.removeItem("oj.nogpu");   // 一発分を消費＝次のリロードで WebGPU 再試行
const markNoGpu = (why: string) => { sessionStorage.setItem("oj.nogpu", why); sessionStorage.setItem("oj.nogpuN", String(nogpuN + 1)); };
const gpuBackend: GlobeScope["gpuBackend"] = !forceGl2 && "gpu" in navigator && (/[?&]gpu=1/.test(location.search) || (!IS_ANDROID && !sealGpuForOverlay && !nogpuMark && nogpuN < 2));
// 描画の質（#46）：大気散乱・PBR と環境光・AO の旗＝ell と同じ作法で **既定は全端末で 0**・URL の ?atmosphere=1／?pbr=1／?ao=1 で点ける（本人裁定 2026-09-26）。
// opts.render.<name>:true は組み込みの口。WebGPU だけが読む（GL2 は実装を持たない）。boot/tier.js renderFx＝純関数。
const RENDER_FX = renderFx({ render: opts.render, search: location.search });
// フォールバック起因の GL2（＝WebGPU が使えるはずの環境で印により落ちている）だけチップを出す。
// Android 既定 GL2・?gl2=1・navigator.gpu 無しの「設計どおり GL2」には出さない（ノイズにしない）。
const gl2Fallback = !forceGl2 && "gpu" in navigator && !IS_ANDROID && !sealGpuForOverlay && !gpuBackend;   // 設計どおりの GL2（封・Android・?gl2=1）にはチップを出さない
if (sealGpuForOverlay && "gpu" in navigator && !gpuBackend) console.log("[boot] WebKit + glOverlay = WebGL2 by default (WebGPU main + WebGL2 overlay is not composited on WebKit; retry with ?gpu=1)");
if (IS_ANDROID && "gpu" in navigator && !gpuBackend && !forceGl2) console.log("[boot] Android = WebGL2 by default (WebGPU sealed due to driver black-screen family; retry with ?gpu=1)");
// stay=1 の診断HUD：コンソールを見なくても分かるよう、判定を画面へ大書（iOS 実機診断 2026-08-02）
const diagHud = /[?&]stay=1/.test(location.search) ? (() => {
	const d = document.createElement("div");
	d.style.cssText = "position:fixed;left:8px;top:8px;z-index:99999;background:rgba(0,0,0,.82);color:#7f7;font:13px/1.5 monospace;padding:8px 10px;border-radius:8px;max-width:86vw;word-break:break-all;white-space:pre-wrap";
	d.textContent = "diag HUD starting…";
	addEventListener("DOMContentLoaded", () => document.body.appendChild(d));
	if (document.body) document.body.appendChild(d);
	const t0 = performance.now();
	const lines = new Map<string, string>();
	const put = (k: string, v: string) => { lines.set(k, v); d.textContent = [...lines.entries()].map(([a, b]) => a + ": " + b).join("\n"); };
	put("build", "v-fade1");
	put("elapsed", "0s"); setInterval(() => put("elapsed", ((performance.now() - t0) / 1000).toFixed(0) + "s"), 1000);
	setInterval(() => put("main tx", `draw x${dbgHost.__drawSendN || 0}${dbgHost.__drawSendErr ? " send error:" + dbgHost.__drawSendErr : ""}`), 1000);
	put("frame1", "not received ✗");
	return put;
})() : null;
if (/[?&]gpu=1/.test(location.search) && !gpuBackend) console.warn("[boot] gpu=1 requested but WebGPU unavailable (no navigator.gpu, or gl2=1 also set) = starting as WebGL2");
if (gl2Fallback) console.warn(`[boot] WebGPU fallback active = WebGL2 (reason=${nogpuMark || "accumulated" }, count ${nogpuN}${nogpuN >= 2 ? " = pinned for this tab" : " = retry on next reload"})`);
// ?noterr=1 ＝標高（アトラス・地形メッシュ・タイルLRU）を丸ごと停止する A/B 計測ノブ（?nogint=1 と同格）。
// opts.terrain＝false：MapLibre と同じ「setTerrain まで平ら」（公式例の門 段 2・2026-09-27）＝既定の標高を取らない・描かない。
// setTerrain の DEM が来たら render worker が地形を作る（terrLazy）。?noterr=1 は従来どおり丸ごと停止（後から入れる口も無い）
const terrLazy: GlobeScope["terrLazy"] = opts.terrain === false && !/[?&]noterr=1/.test(location.search);
let noTerr: GlobeLive["noTerr"] = /[?&]noterr=1/.test(location.search) || opts.terrain === false;
const LINESUB = /[?&]linesub=1/.test(location.search);   // vt perf plan §3.2 の逃げ道＝地形の無い地図でも線を 700m ごとに細分する（旧挙動）
// 注視点の高さ（opts.centerElevation）："ground"＝地形がある間は中心の地面の標高（MapLibre の centerClampedToGround＝既定）・数＝固定［m］（centerClampedToGround:false＋elevation）・
// 無指定＝従来（海面・内製の既定）。cam.centerAlt へ毎フレーム写す（core cameraState が注視点を持ち上げる）。jumpTo({ elevation }) は固定値を上書き（2026-09-30）
let centerElevMode: GlobeLive["centerElevMode"] = opts.centerElevation === "ground" || Number.isFinite(opts.centerElevation) ? opts.centerElevation : undefined;   // 実行時に map.setCenterClampedToGround／setCenterElevation で変わる（A3・2026-10-12）
let centerElevFixed: GlobeLive["centerElevFixed"] = Number.isFinite(centerElevMode) ? centerElevMode as number : null;
function syncCenterAlt() {
	if (centerElevMode === undefined && centerElevFixed == null) return;
	if (centerElevMode === "ground" && !noTerr) sampleGroundElev();   // 基図の無い地図（style 無し・基図の門の外）でも中心の地面を引く（基図圏の tiles.update の前でも呼ぶ＝二重は geKey で潰れる）
	const v = centerElevMode === "ground" && !noTerr ? groundElevM : (centerElevFixed ?? 0);
	if ((cam.centerAlt || 0) !== v) { cam.centerAlt = v; requestDraw(); }
}
const GMAX = +(/[?&]gmax=(\d+)/.exec(location.search)?.[1] ?? 0) || null;   // 地形メッシュ格子の天井（perf plan §1 計器 c・?gmax=768＝P4 の上限見積り。既定 null＝1536/lowMem 1024）
const GNDFAST = !/[?&]gndfast=0/.test(location.search);   // perf plan P6 の逃げ道＝0 で gndMix0 を旧順序（4 本標本化してから捨てる）へ。既定 true
const QUAD4 = !/[?&]quad4=0/.test(location.search);   // perf plan P3 の逃げ道＝0 で線・点を旧 6 頂点の draw に（既定＝index の 4 頂点）
const CPUELEV = /[?&]cpuelev=1/.test(location.search);   // perf plan P1 step 1 の逃げ道＝1 で標高セルの再標本化を従来の CPU（描画スレッドの JS ループ）に（既定＝GPU・WebGPU のみ）
const TERRLOD = !/[?&]terrlod=0/.test(location.search);   // perf plan P4 の逃げ道＝0 で地形メッシュのチャンク刈りを止める（全量 1 draw＝従来）
// ?farterr=0 ＝遠景地形層（深ズーム×チルトの R10 第2アトラス＝ズームインしても遠方の山が消えない一般則）を
// 無効化する逃げ道。コスト＝GPU 10-16MB＋遠景メッシュ2度描き（チルト深ズーム時のみ）。
const noFarTerr = /[?&]farterr=0/.test(location.search);
// ⚠iOS WebKit の轍（2026-08-02 実機確定）：WebGPU 構成の worker への「直結 postMessage」は init 以降
// 黙って消える（main送信8回/worker受信0回・エラー皆無。MessageChannel ポート経由は全て配達される＝
// scene/plateau ポートが生きている実証つき）。よって init 以外の制御メッセージは全部 ctrlPort 経由。
const ctrlChan = new MessageChannel();
// iOS（iPadOS の Mac 偽装込み）＝WebGPU worker への直接配達が死ぬ環境：生きている scene worker 経由のリレーへ。
const IOS_RELAY = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) || /[?&]relay=1/.test(location.search);   // relay=1＝他環境でのリレー経路検証用
let relayCtl: GlobeScope["wPost"] | null = null; const relayPending: Array<[Parameters<GlobeScope["wPost"]>[0], Transferable[] | undefined]> = [];   // pipeline 生成前の制御は待機列（生成直後に順序どおり流す）
const wPost: GlobeScope["wPost"] = (msg, transfer) => {
	if (IOS_RELAY && gpuBackend) {   // リレーが要るのは WebGPU 構成の時だけ（WebGL2 は直結が健在）
		if (relayCtl) relayCtl(msg, transfer); else relayPending.push([msg, transfer]);
		return;
	}
	ctrlChan.port1.postMessage(msg, transfer || []);
};
// ?flat=消える,全部出る（CSS px）＝傾きで潰れた道の名（線に沿う注記）を薄くして消す高さの調整（注記層の lineFlatPx・既定 4.5,5.5）。?flat=0＝潰れても出す（MapLibre と同じ）
const flatParam = /[?&]flat=([\d.]+)(?:,([\d.]+))?/.exec(location.search), lineFlatPx = !flatParam ? undefined : +flatParam[1] > 0 ? [+flatParam[1], Math.max(+flatParam[1], +(flatParam[2] ?? +flatParam[1] + 1))] : null;
renderWorker.postMessage({ type: "init", lineFlatPx, ctrlPort: ctrlChan.port2, canvas: offscreen, labelCanvas: labelOffscreen, ...(labelGpuOffscreen ? { labelGpuCanvas: labelGpuOffscreen } : {}), elevBase: TERR_EXAG / EARTH_M, terrainExag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com", scenePort: sceneChan.port2, noMultiDraw, perf: perfLog, mem: hudOn, lowMem: LOW_MEM, noMixed: noMixedR01, noFarTerr, dtm: REGION_DTM, dem: DEM0, noBld: /[?&]nobld=1/.test(location.search), gpu: gpuBackend, noTQ: /[?&]notq=1/.test(location.search), noFragDepth: /[?&]fd=0/.test(location.search), noGint: /[?&]nogint=1/.test(location.search), noGintSB: /[?&]gintsb=0/.test(location.search), noFade: /[?&]nofade=1/.test(location.search) || !!ML_COVER, noLx: /[?&]nolx=1/.test(location.search), noPt: /[?&]pt=0/.test(location.search), msaa1: MSAA_OFF, msaa4: MSAA_PIN, fx: RENDER_FX, drawHud: drawHud, stay: /[?&]stay=1/.test(location.search), noTerr, terrLazy, gmax: GMAX, gndFast: GNDFAST, quad4: QUAD4, cpuElev: CPUELEV, terrLod: TERRLOD, ell: ELL_ON }, [ctrlChan.port2, offscreen, labelOffscreen, sceneChan.port2, ...(labelGpuOffscreen ? [labelGpuOffscreen] : [])]);
// 薄いプロキシ：有線(関数呼び)を無線(postMessage)に載せ替え。set/draw 統一済なので pipeline/overlay は無改造。
// draw は worker 側で「cam を記録するだけ」に受け、実描画は worker 自前 rAF が最新 cam で回す（worker-driven）。
// 標高アトラス(terrain)も worker 側に住む＝main はもう視野→セル計算・ダウンサンプルを一切やらない。読込インジケータだけ elevPending で受ける。
const renderer: GlobeScope["renderer"] = {
	set: (cmd, data, prop, layer) => wPost({ type: "set", cmd, data, prop, ...(layer != null ? { layer } : {}) }),   // layer＝gint 多層（spec §4）の層指名。無指定＝既定層（従来と同形）
	draw: (cam, opts) => {
		try { wPost({ type: "draw", cam, opts }); dbgHost.__drawSendN = ((dbgHost.__drawSendN as number) || 0) + 1; }
		catch (e) { dbgHost.__drawSendErr = String(e && (e as Error).message); console.error("[boot] draw send failed:", e); }
	},
};
let elevBusy: GlobeLive["elevBusy"] = false;   // 標高タイル（R01/R10/R90）読込中＝PLATEAU先読みの柵（デモの地形シーンで起伏が立たない事故の防止）
let elevN: GlobeLive["elevN"] = 0;          // 読込中の枚数＝デモ行送りゲートの進捗指紋（枚数が動いている間は「進んでいる」）
const elevEl = document.createElement("div");
elevEl.id = "elev-toast";   // スタイルは quiet-mono。左下ドック＝#pos の上へ積まれる（bottom手打ち廃止 2026-09-03）
dockStack(mapEl).append(elevEl);
// 等高線(真俯瞰の茶線)・測量点標高・地形読込表示は「地形」チップ(layerState.terrain)に統合＝独立トグル無し。
// zoom/tileのデバッグログ(#log)はユーザー向けチップから切り離し常時非表示（必要なら devtools で #log を出す）。
logEl.style.display = "none";
// 毎フレームの診断行：文面が変わった時だけ DOM に書く（同じ文字列の textContent 代入も文字ノードを作り直す）
let logText = "";
const setLog = (t: string) => { if (t !== logText) { logText = t; logEl.textContent = t; } };
// 起動ウォッチドッグ：最初のフレーム(frame1)が10秒来なければ原因不明でも案内を出す（健全なら1秒未満で来る）。
// glfail=worker内のWebGL2初期化失敗、contextlost=GPUコンテキスト喪失（1回だけ自動リロード→再発なら案内）。
let bootT: number | null = setTimeout(() => {
	fatalOverlay(t("Startup is taking longer than usual"), t("On a slow connection the first load can take a while (loading is still in progress). Please wait a moment. If it does not improve, reload the page — and if that fails, check that hardware acceleration is enabled in your browser settings."), true);
}, 10000);
// gpu=1 の frame1 不達（20秒）＝WebGPU 経路が固まっている疑い＝WebGL2 で仕切り直し（遅い回線のコールドブート実測
// 16秒@400kbps を考慮した余裕。present 沈黙故障と対で、実験フラグがどう転んでも WebGL2 の絵に必ず着地させる）。
// ★destroy() で必ず clearTimeout（旧＝生成後 20 秒以内に destroy すると __backend が消えた後に番犬が起き、**ホストページごと reload**＝
//   SDK ドッグフード 2026-09-10 で発覚。埋め込み先の SPA がタブ切替で destroy する典型で踏む）
let gpuWatchT: ReturnType<typeof setTimeout> | null = null;
if (gpuBackend) gpuWatchT = setTimeout(() => {
	gpuWatchT = null;
	if (!dbgHost.__backend && !/[?&]stay=1/.test(location.search)) {
		console.error("[boot] gpu=1: no frame1 in 20s -> restarting as WebGL2");
		markNoGpu("frame1-20s");
		location.reload();
	}
}, 20000);
// 印刷（平面図）撮影中の抑止フラグ：autoMesh/settle保存を止める。描画は noTerrain にしない＝
// 標高アトラスは生かす（真俯瞰 pitch0 なので elevScaleEff=0＝地形サーフェス/陰影/変位は自然に消え、
// 等高線(ベクタ)だけが敷かれた厳密な正射平面図になる）。noTerrain にすると等高線もアトラスごと消えるので不可。
let printHold = false;
// gint 多層（map.addGint）の台帳＝onmessage ルーティングより先に宣言（boot 中の遅着メッセージ TDZ 回避）
let gintLayerSeq = 0;
const extGint = new Map<string, GintLayerH>();   // layer id → handle（identify/click/ack ルーティング先）
let extActive: string | null = null;        // カーソルを持つ追加層の id（null＝既定層＝従来ゲート）
const mapOn: GlobeScope["mapOn"] = { click: [], move: [], load: [], mesh: [], settle: [], time: [], idle: [], clouds: [], styleimagemissing: [], sourcedata: [], boxzoomstart: [], boxzoomend: [], boxzoomcancel: [], cooperativegestureprevented: [] };   // boxzoom*＝shift＋ドラッグの矩形（A2・MapLibre 同名・end は { bbox, x0,y0,x1,y1 }）・cooperativegestureprevented＝協調モードで止めた操作（{ kind:"wheel"|"touch" }）   // styleimagemissing＝記号帳に無い名前（MapLibre 同名・{ id }・名前ごとに 1 回）   // idle＝MapLibre 同名（公式例の門 段 2）＝下の checkIdle   // time＝共通の時計の状態が変わった（#42）   // settle＝カメラ静止（onMove の 150ms 無音）＝ツアー/オーバレイの「止まった」合図（2026-09-11）   // map.on の登録簿（§4: click=hits 同型／move=カメラ更新／load=frame1／mesh=建物3D の読込合図）
// map.on("mesh")（1.x の旧名 "plateau" は 2.0 で外した）：{phase:"catalog",count} → {phase:"start"|"done"|"cancelled"|"failed", name(区名), base(URL)}。旧＝コンソール文字列しか合図が無く
// 埋め込み側が console.log をフックしていた（SDK ドッグフード 2026-09-10）。
const emitMesh = (e: unknown) => { for (const cb of [...mapOn.mesh]) { try { cb(e); } catch (err) { console.error("[map.on mesh]", err); } } };
let mapLoaded: GlobeLive["mapLoaded"] = false;   // 'load' 後の登録は即発火（maplibre 同様の耳）
renderWorker.onmessage = e => {
	const d = e.data;
	// --- gint（知性の層＝render worker に同居）の返信面（action=旧 gint worker と同形） ---
	// --- gint 多層（map.addGint 層）のルーティング：layer 付きは handle へ・既定層（layer 無し）は従来経路 ---
	if (d.action === "gintAck") { extGint.get(d.layer)?._ack(d); return; }
	if ((d.action === "identify" || d.action === "click" || d.action === "tiers") && d.layer != null) {
		const h = extGint.get(d.layer);
		if (h) { if (d.action === "identify") h._hover(d); else if (d.action === "click") h._click(d); }
		return;   // 追加層のメッセージを既定層の tip/click 機構に触らせない（除去済み層の遅着も同様に握る）
	}
	if (d.action === "identify") {   // ホバー識別＝当たった feature の全 properties を指先 tip へ。外れ(featureId=null)は消す。
		if (!gint.hoverTip) return;
		if (gint.extTipOwn) return;   // 町丁目tipが所有中＝gint側のackでtipを消したり上書きしない（正着は毎moveのhovertipが再設定）
		const p = (d.featureId != null && gint.userGint?.pbf) ? gint.userGint.pbf.getFeature(d.featureId)?.properties : null;
		// 層持参の tip 整形（applyGintData opts.tip・census2020 筆層のみ＝フラグゲート）。無指定＝従来の全属性そのまま（融通なし）
		const lines = p ? (gint.userGint?.tip ? gint.userGint.tip(p) : propLines(p)) : null;   // propLines＝キーも値も escHtml（属性は外から来る＝tip は HTML で入る）
		gint.hoverTip(lines?.length ? lines : null);   // null/空＝tip を消す
		return;
	}
	if (d.action === "click") {
		gint.clickHandler?.(d.featureId, (d.featureId != null && gint.userGint?.pbf) ? gint.userGint.pbf.getFeature(d.featureId)?.properties : null, [d.lng, d.lat]);
		return void console.log("[gint] fid=%s  lng=%s lat=%s", d.featureId, d.lng?.toFixed?.(6), d.lat?.toFixed?.(6));
	}
	if (d.action === "tiers") return;   // gint LOD tier 構築完了の報告（ベンチ用メタ）＝アプリでは使わない
	if (d.type === "snapshot") return snapPart(d.id, "render", orderSnapOverlays(d));   // shot 用：基図+ラベル(+同一フレームのオーバーレイ)の生画素
	if (d.type === "dlApplied") return onSceneApplied(d.slot, d.sig);   // multi_draw の ack＝renderer が draw list を適用した瞬間（＝画面に載った）
	if (d.type === "overlayPickResult") { const f = pickWait.get(d.seq); pickWait.delete(d.seq); f?.(d.hits || []); return; }   // 統一 picking（PR-1）の答え
	if (d.type === "overlayEvent") return overlays.get(d.name)?.onmessage?.(d.data);   // 同一フレームのオーバーレイ → main（hit 矩形・画素の返送など）
	if (d.type === "overlayStage") { ((dbgHost.__overlay ??= {}) as Record<string, unknown>)[d.name] = d; if (d.stage === "failed") console.error("[overlay]", d.name, "failed:", d.error, d.url); return; }   // 読み込み段階（importing/imported/ready/failed）＝沈黙故障の診断
	if (d.type === "frame1") {
		clearTimeout(bootT); bootT = null; renderBackend = dbgHost.__backend = d.backend || "webgl2"; paintTable = !!d.pt; sessionStorage.removeItem("oj.ctxlost");   // 初描画成功＝自動リロード回数もリセット。__backend＝スモークテスト用（webgl2/webgpu）
		mapEl.querySelector("#fatal")?.remove();   // 遅い回線でウォッチドッグ(10s)が先に出た後の遅着 frame1＝案内を畳む（地図は生きているのに被さったまま＝「何も出ない」の正体・モバイル実測 2026-08-02）
		console.log(`[boot] frame1 received backend=${dbgHost.__backend}`);
		if (!mapLoaded) { mapLoaded = true; for (const cb of mapOn.load) { try { cb({}); } catch (e) { console.error("[map.on load]", e); } } }
		diagHud && diagHud("frame1", `received ✓ backend=${dbgHost.__backend}`);
		// フォールバック GL2 の画面表示（柔らか鍵の③）：黙って重いモードで走らない。タップ＝印を全消しして
		// WebGPU 再試行（CNG フリートで端末を覗いた瞬間に状態が分かる・観客の端末でも1タップで復帰を試せる）。
		if (dbgHost.__backend !== "webgpu" && gl2Fallback) {
			// 左下ドックへ搭載（2026-09-03 被り総括）：旧・body直下の position:fixed は #pos（座標計器）と真被り＝
			// ドックなら座標計器やトーストの上へ積まれる。destroy の replaceChildren でも一緒に畳まれる（旧はbodyに残った）
			const chip = document.createElement("div");
			chip.id = "gl2-chip";
			chip.style.cssText = "background:rgba(20,24,34,.78);color:#ffd479;font:11px/1.4 system-ui,sans-serif;padding:5px 9px;border-radius:14px;cursor:pointer;user-select:none;-webkit-user-select:none";
			chip.textContent = nogpuN >= 2 ? t("Compatibility rendering (WebGL2) — tap to retry fast mode") : t("Started in compatibility rendering (WebGL2) — reload to retry fast mode");
			chip.onclick = () => { sessionStorage.removeItem("oj.nogpu"); sessionStorage.removeItem("oj.nogpuN"); location.reload(); };
			dockStack(mapEl).append(chip);
		}
		// WebGPU の present 検証：worker 側は例外ゼロで描けている「つもり」でも、環境によっては canvas に画素が
		// 届かない（iOS Safari 実測＝worker×OffscreenCanvas×WebGPU の present 未接続）。placeholder canvas を
		// drawImage→getImageData し、全画素ゼロなら WebGL2 で自動再起動（Chrome は正常時 全画素非ゼロを実測確認済）。
		if (dbgHost.__backend === "webgpu") setTimeout(() => {
			const stay = /[?&]stay=1/.test(location.search);   // 診断閲覧モード＝フォールバックせず留まる（白画面のままエラー行を読む）
			const bail = (why: string) => {
				if (stay) { console.error(`[boot] WebGPU present verification failed (${why}). stay=1 = fallback suppressed; inspect the diag lines`); diagHud && diagHud("present", `failed ✗ (${why})`); return; }
				console.error(`[boot] WebGPU present verification failed (${why}) -> restarting as WebGL2 in 3s (waiting for GPU diagnostics)`);
				markNoGpu("present:" + why);
				setTimeout(() => location.reload(), 3000);
			};
			try {
				const t = document.createElement("canvas"); t.width = 16; t.height = 16;
				const g = t.getContext("2d", { willReadFrequently: true })!;
				g.drawImage(canvas, 0, 0, 16, 16);
				const px = g.getImageData(0, 0, 16, 16).data;
				let nz = 0; for (let i = 0; i < px.length; i += 4) if (px[i] | px[i + 1] | px[i + 2] | px[i + 3]) nz++;
				if (nz === 0) bail("no pixels reached the canvas");
				else { console.log(`[boot] WebGPU present verified (pixels ${nz}/256)`); diagHud && diagHud("present", `OK ✓ pixels ${nz}/256`); sessionStorage.removeItem("oj.nogpuN"); }   // 検証通過＝この環境の WebGPU は本物＝過去の躓きの累積を消す
			} catch (e) { bail("exception during verification: " + (e && (e as Error).message)); }
		}, 1500);
		return;
	}
	if (d.type === "pingReq") {   // stay診断：両チャネルで即応答＝どちらが届くかをworker側で数える
		try { renderWorker.postMessage({ type: "pongD" }); } catch {}
		try { wPost({ type: "pongC" }); } catch {}
		return;
	}
	if (d.type === "beat") {   // stay診断：ループ実行数＋描画ゲートの生死（dirty/cam/draw受信）
		diagHud && diagHud("frame loop", `${d.n}x (pump ${d.pump})`);
		diagHud && diagHud("gate", `draw recv ${d.drawMsgN}x cam=${d.hasCam ? "✓" : "✗"} dirty=${d.dirty ? "✓" : "✗"} renderer=${d.hasRenderer ? "✓" : "✗"} frame1 sent=${d.sentFrame1 ? "✓" : "✗"}`);
		diagHud && diagHud("delivery", `pong direct ${d.pongD} port ${d.pongC} BC ${d.pongB} self ${d.loopN}`);
		diagHud && diagHud("route", `scenePort recv ${d.sceneMsgN} relay final ${d.relayRecvN} hop1 recv ${(globalThis as { __relayCtlN?: number }).__relayCtlN || 0}`);
		diagHud && diagHud("boot", `${d.bootStage} queued=${d.iqLen}`);
		return;
	}
	if (d.type === "gpuPix") {   // stay診断：present 前の GPU テクスチャ実画素（rendering と present の切り分け）
		console.log(`[boot] GPU-side pixels ${d.nz}/${d.total} (readback before present)`);
		diagHud && diagHud("GPU pixels", `${d.nz}/${d.total} ${d.nz > 0 ? "-> rendering alive = present-side issue" : "-> not even a clear = submit-side issue"}`);
		return;
	}
	if (d.type === "drawErr") {   // worker の draw 例外（初回のみ）＝毎フレーム失敗系の一次診断。モバイルは worker コンソールが見づらい＝main 側へ転写
		console.error("[render] draw failed (worker report, once):", d.msg, d.stack);
		dbgHost.__drawErr = d.msg;
		diagHud && diagHud("GPU error", d.msg.slice(0, 300));
		return;
	}
	if (d.type === "glfail") {
		clearTimeout(bootT);
		fatalOverlay(t("Could not start 3D rendering"), t("WebGL2 initialization failed ($1). Hardware acceleration may be disabled in your browser.", d.error), true);
		return;
	}
	if (d.type === "gpuTier") { gpuFast = d.fast; return; }   // GPU格付け（renderworker tuneRes）＝静止時の手前詳細化の可否
	if (d.type === "contextlost") {
		const n = +(sessionStorage.getItem("oj.ctxlost") || 0);
		// まず黙って1回だけ立て直す。1秒待ってから＝GPUプロセスの再起動を待つ（即リロードだと復帰前の
		// getContext が null＝旧・probe が「ブラウザ非対応」と誤診した。probe側のリトライと二段の保険）。
		if (n < 1) { sessionStorage.setItem("oj.ctxlost", String(n + 1)); setTimeout(() => location.reload(), 1000); }
		else fatalOverlay(t("GPU rendering was interrupted"), t("The rendering context was lost (this can happen when GPU memory runs low). Close other tabs or apps, then reload."), true);
		return;
	}
	if (d.type === "terrStats") { console.log("[terr]", JSON.stringify(d.data)); return; }   // __terr()の返答＝コンソールに1行
	if (d.type === "rasterInfo") return onRasterInfo(d.id, d.info);       // 画像タイル層：ソースの自己申告が届いた（bbox/zoom 域/出典）
	if (d.type === "rasterError") return onRasterError(d.id, d.error);   // 同・開けなかった/取得が続けて失敗
	if (d.type === "elevGrid") { const f = elevGridWait.get(d.id); if (f) { elevGridWait.delete(d.id); f(d.data); } return; }
	if (d.type === "rasterStats") { const f = rasterStatWait.get(d.id); if (f) { rasterStatWait.delete(d.id); f(d.data); } return; }
	if (d.type === "labelsPlaced") { const f = placedWait.get(d.id); if (f) { placedWait.delete(d.id); f(d.data); } return; }
	if (d.type === "labelsResync") { labelSender.reset(); renderer.set("labels", labelSender(lastLabels)); return; }   // worker が持たない番号を受けた（同期ずれ）＝全部送り直す
	if (d.type === "frame") { for (const fn of workerFrameFns) { try { fn(d.cam, d.t); } catch (err) { console.error("[frame hook]", err); } } return; }   // worker が描いた絵の cam（custom 層の同期・frameEvents を頼んだ時だけ来る）
	if (d.type === "labelImageMissing") { for (const n of d.names || []) imageMissing(n); return; }   // 基図/vector の注記の記号帳に無い名前
	if (d.type === "rasterPending") { rasterPend.clear(); for (const k in d.layers) rasterPend.set(k, d.layers[k]); rasterPendTotal = d.total; rasterFading = !!d.fading; return; }   // 画像タイル層の未着（層 id→枚数・raster.js の申告）＝idle と isSourceLoaded の材料
	if (d.type === "mem") { memTerrain = d.terrain || 0; memHeap = d.heap || 0; memGpu = d.gpu || null; memRaster = d.raster || 0; memFps = d.fps ?? memFps; memFrameMs = d.frameMs ?? memFrameMs; memRes = d.res ?? memRes; memBackend = d.backend || memBackend; memGpuName = d.gpuName || memGpuName; memGpuMap = d.gpuMap ?? memGpuMap; memGpuGint = d.gpuGint ?? memGpuGint; memAa = d.aa ?? memAa; memHitch = d.hitch || memHitch; memTerr = d.terr || memTerr; memGpuShadow = d.gpuShadow ?? memGpuShadow; memShadow = d.shadow ?? null; memLab = d.lab ?? memLab; return; }   // ?hud=1：render worker からのメモリ台帳＋描画実測（HUD が合算・表示）
	if (d.type === "drawhud") { showDrawHud(d); return; }                                   // ?drawhud=1：直近フレームの描画実績を画面へ（実機計器）
	if (d.type !== "elevPending") return;
	const { count, range, stat } = d;
	elevBusy = count > 0; elevN = count;   // 標高タイル読込中＝PLATEAU先読みポンプの柵（地形シーンの起伏が先・下記 runPrefetch）
	// stat＝標高ローダの自己申告（初期化中/初期化失敗:理由）。旧・沈黙死は「山が平ら・トーストも出ない・
	// 理由は誰にも見えない」＝借り物端末（インスペクタ不可）で追跡不能だった。地形チップに関係なく出す＝診断が主目的。
	if (stat) { elevEl.style.display = "block"; elevEl.textContent = t("⛰ Elevation loader $1", stat); return; }
	if (count > 0 && layerState.terrain) { elevEl.style.display = "block"; elevEl.textContent = t("⛰ Loading terrain $1 … ×$2", range === 1 ? t("R01 (takes seconds)") : range === 10 ? "R10" : "R90", count); }
	else elevEl.style.display = "none";
};

let needsDraw = true, readySig: GlobeLive["readySig"] = "", lastLabels: HostLabel[] = [], sceneOrigin: [number, number] | null = null;
const requestDraw: GlobeScope["requestDraw"] = () => { needsDraw = true; };   // 次のフレームで描き直す（needsDraw を立てる口はこれ 1 本＝切り出したファイルにも渡せる）
let coverOk = true;   // 最後の render で「基図が視野を隙間なく覆い、その枠がそのまま載っている」（idle の材料・公式例の門 段 2）
const rasterPend: GlobeScope["rasterPend"] = new Map(); let rasterPendTotal = 0, rasterFading = false;   // rasterFading＝到着フェード（raster-fade-duration・C4）の最中＝idle はこれも待つ（MapLibre の hasTransition）   // 画像タイル層（raster/hillshade/image/video）の未着＝raster.js の rasterPending（開く途中・見えている選抜の queued/loading）。idle は合計 0 を待ち、isSourceLoaded は source を使う層の分を見る（2026-09-28・門では hillshade の例が 10 秒の timeout で撮られていた）
let renderBackend: GlobeLive["renderBackend"] = null, paintTable = false;   // paintTable＝描き手が paint 表の (b) 類を読む（frame1 で確定）   // 初描画で確定（"webgpu"／"webgl2"）。建物の影は WebGPU だけ（GL2＝フォールバックは影をかけない仕様）
// mainDesired＝「今この視点で載っているべき main の sig」（swapScene が毎回更新。request の dedupe とは独立）。
// base(粗い下地)の退場判定に使う：readySig がこれに追いつく＝穴なしが確定するまで下地を敷いたままにする。
let mainDesired: GlobeLive["mainDesired"] = "";
let readyKeys: Set<string> | null = null, readyTail = "";   // readySig 確定時に一度だけ作る Set＋署名末尾（styleSig/鉄道帯）＝render の下地退場判定（毎フレーム文字列を作らない）
// ズームアウト時は「古い詳細シーンを縮めて見せ続ける」をしない＝写真タイルなら拡縮で誤魔化せるが、
// ベクタはズーム専用の線幅・密度を焼いているので縮めると質感が浮く。下地(base)に揃えて退場させる。
// keepFine＝ズームアウトで常駐子孫を親に差し替えない深さ（tilemanager の子孫代打・0=従来）。細かい絵のまま
// 引ける＝「消して同じものを描き直す」を集合不変（mergeシグネチャ不変）で構造的に回避。頂点は増える方向なので
// WebGPU×非LOW_MEM 限定（PLATEAU全保持と同じゲート）。?keepfine=N で深さ変更・?keepfine=0 で従来動作。
const KEEP_FINE = (gpuBackend && !LOW_MEM) ? qNum(/[?&]keepfine=(\d+)/, 2) : 0;
// 子孫代打は 3D（チルト）限定：真俯瞰=2D は「素の選抜と同じベクトルタイル」を見せる（本人裁定 2026-08-04）。
// チルトから回復した平面図に細密パッチが残ると、周囲と線幅・密度の質感が違う継ぎはぎになる（横浜実絵）。
// 閾値は flat2d/hideBldFill と同じ 0.02rad＝「3Dが立つ瞬間」と同期。
const keepFineNow = () => (cam.pitch || 0) >= 0.02 ? KEEP_FINE : 0;
// mainSceneZoom＝render workerに現在乗っているmainシーンのzoom（mergeのackで確定）。
let mainSceneZoom = -1;
const mergePendingZoom = new Map();   // merge要求sig → 要求時のzoom
const STALE_ZOOMOUT = 0.5;            // これ以上ズームアウトしたら古い詳細を隠す（微小ズームでは点滅させない）
// keepFine 時はズームアウト隠しを無効化：保持中の細集合は「古い詳細」でなく望みの絵そのもの（sig不変で merge も
// 来ない＝隠すと戻す契機がなくパッと消えたままになる・実機で露見）。集合が変わる引き方でも隠さず、新 merge の
// ack で原子的に差し替え＝連続した絵を保つ。従来動作（GL2/LOW_MEM）は据置。
const mainStale = () => !keepFineNow() && mainSceneZoom > cam.zoom + STALE_ZOOMOUT;
let lastSkipBase = false;   // render() が最後に決めた skipBase（onMove の draw が同じ値を送る・#58）
let basemapHidden = false;                 // z<BASEMAP_MINZOOM で基図(GSI)を止めてるか（全球ビュー＝海岸線のみ）
let gSrcText: string | null = null;   // ?g= の出所の行（文字・#attr を圏で書き直しても残す＝attrHTMLOf が末尾に足す・#176 で出典の組み立てへ移した）
const setGSrc: GlobeScope["setGSrc"] = txt => { if (txt === gSrcText) return; gSrcText = txt; attrZone = null; requestDraw(); };
let attrZone: GlobeLive["attrZone"] = null, attrRegionHTML: string | null = null;   // 出典（#attr）の圏＝"region"（地域の基図圏）|"world"|"sky"（render() が z 跨ぎで一枚を差し替え＝各ズーム統合 2026-09-03）
// 出典の圏（z で決まる）と、その圏の出典の HTML＝#attr の中身と、#attr の無い画面（instruments に "attr" を出さない構成）で
// shot／print が焼く出典の共通の源。地域の文面は宣言（REGION_ATTR）から＝globe は地域の出典を持たない（2026-09-24・旧＝shot に日本の出典を直書き）
const attrZoneNow = () => cam.zoom < STARSKY_Z ? "sky" : (WORLD_VT && cam.zoom < BASEMAP_MINZOOM) ? "world" : "region";
function attrHTMLOf(zone: string | null) {
	const A = (url: string, label: string) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
	// 世界の出典束：world=NE(国界・湖)+GEBCO+気候Beck／?world=0=NE海岸線+GEBCO（気候場なし）
	const worldSrc = A("https://www.naturalearthdata.com/", "Natural Earth") + "・" + A("https://www.gebco.net/", "GEBCO")
		+ (WORLD_VT ? "・" + A("https://www.gloh2o.org/koppen/", "Beck et al. (CC BY)") : "");
	const tail = `<br>${t("(processed from each source)")}© 2026 ` + A("https://www.ortho-earth.com/docs/introduction.html", "Kenji Yoshida");
	// ?pm= の基図は他人のデータ＝地理院の出典を出したままにしない（義務以前に嘘。2026-09-03 の
	// 「日本のデータを出していない画面に地理院を並べない」と同じ筋）。宣言が無いアーカイブは
	// 出所（ホスト名）だけでも出す＝無出典で他人の絵を出さない。門が 0 まで開く＝world/sky 圏でも
	// アーカイブは描かれている＝そちらにも併記する（球のハイプソの出典と両方が要る）。
	const pmSrc = BASE_SOURCE.url ? (BASE_SOURCE.attrHTML || new URL(BASE_SOURCE.url.replace("pmtiles://", "")).host) : null;
	// 画像タイル層（ラスタ基図/重ね）の出典＝各層の自己申告（消毒済み）を 1 行足す。基図の線・注記は従来どおり（地理院）＝その出典も残す
	const rasterSrc = rasterAttrHTML();
	const rasTail = (rasterSrc ? `<br>${t("Imagery: $1", rasterSrc)}` : "") + vtxAttrTail(pmSrc);   // ＋利用者の vector source の出典（段 8①）＝MapLibre は source の出典を自動で出す・OSM 等は表示が利用の条件
	// 出典は文単位で組む（"出典：" + 名前 の足し算は言語で語順が壊れる＝i18n.js の掟）。$1 に列を差す
	const head = pmSrc ? pmSrc + "・" : "";
	const body = zone === "region" ? ((pmSrc ? t("Source: $1", pmSrc) + rasTail + tail : (attrRegionHTML ?? attributionHTML(REGION_ATTR)) + rasTail))
		: zone === "world" ? t("Source: $1", head + worldSrc) + rasTail + tail
		: t("Source: $1", head + A("https://github.com/ofrohn/d3-celestial", "d3-celestial") + "・" + worldSrc) + rasTail + tail;   // sky＝星図が先頭（星空劇場の主役）
	return body + (gSrcText ? `<div class="g-src">${String(gSrcText).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c])}</div>` : "");   // ?g= の出所（#176・圏の書き直しでも残す）
}
const attrTextNow: GlobeScope["attrTextNow"] = () => { const d = document.createElement("div"); d.innerHTML = attrHTMLOf(attrZoneNow()).replace(/<br\s*\/?>/gi, "\n"); return d.textContent.split("\n").map(x => x.trim()).filter(Boolean); };
// 日本固有（GSI基図）の出番：従来5。世界下地（ハイプソ＋admin0国線）がある ?world=1 は 6.5 から
// （本人裁定 2026-08-31「下地ができたので日本固有はz>6.5でいい」）。標高はz5.5からR10（terrain.js・
// 旧6.5＝9/2裁定でハイプソ帯の海岸ギザ根治）＝GSI入場前にハイプソが精細化して受け渡す。
// 星空・星座・太陽系の門は別（STARSKY_Z＝従来の5のまま）。
// ズームの上限＝器ごとの頭打ち（opts.zoomMax・1.2.0〜 2026-09-23）＝データが在る所までしか寄らせない
// （apps/world の国の地図＝世界データだけ＝z8）。入力・飛行・共有hash・fit の全経路がこの値に従う。
// 既定 20＝15cm/px（正射z＝緯度フリー。精度は原点相対RTEが担保）。21でも動くが余裕を持って1段残す。
const ZOOM_MAX: GlobeScope["ZOOM_MAX"] = Math.max(1, Math.min(20, opts.zoomMax ?? 20));
let zoomMaxCur: GlobeLive["zoomMaxCur"] = ZOOM_MAX, camBounds: GlobeLive["camBounds"] = null;   // 実行時の寄りの上限と中心の可動域（map.setMaxZoom / setMaxBounds・#35）＝onMove が毎移動で締める（使う所より前で宣言＝TDZ の轍）
// 地域の申告が無い器（globe 仕様）＝日本固有の圏そのものが無い＝上限より上に置いて「来ない」ことを表す。
// 世界ハイプソ・湖・罫線はこの値まで描かれる＝ズーム上限まで世界の色のまま（2026-09-23）。
const BASEMAP_MINZOOM: GlobeScope["BASEMAP_MINZOOM"] = EXT ? 0 : REGIONLESS ? ZOOM_MAX + 0.8 : WORLD_VT ? 6.5 : 5;   // 外来 style＝全ズームがその基図（世界のハイプソは出さない＝MapLibre と同じ見え方）
// タイルの門だけを分ける：BASEMAP_MINZOOM は「日本の基図（GSI）を出す圏」の意味も兼ねており、注記・空港マーク・
// 出典圏の判定にも使われている。?pm= の基図は日本固有ではない＝タイルを出す下限はアーカイブの持ち分に従う
// （実際の下限は minZoom で、それ未満はエンジンの門が空タイルを返す）。旧・世界タイルの !WORLD_VT 例外と同じ役割。
const TILE_MINZOOM: GlobeScope["TILE_MINZOOM"] = BASE_SOURCE.tileMinZoom ?? BASEMAP_MINZOOM;
const STARSKY_Z = 5;                       // 星空劇場（星・星座クリック・惑星）の圏＝renderer の worldFade(z<5) と同期
// 静止時の詳細化＝主層の分割閾を下げる（既定560→この値）。近景ほど画面上のタイルが大きい＝真っ先に
// 閾を越えて割れる＝チルトで「手前だけズームが上がる」（遠景は小さく閾に届かず据置＝奥のPLATEAUと詳細が拮抗）。
// 移動中は渡さない＝560のまま重くしない。値を下げるほど手前が細かくなる（=負荷↑）＝ここが唯一の調律つまみ。
const IDLE_TILE_PX = 384;   // 静止時の手前詳細化は gpuFast（renderworker の実測格付け）が立つマシンだけ＝M1+dpr2級は
                            // 自動落選（256は dpr=2 で停止毎に~10秒の描き直しラッシュ＋gpuMap 1.5倍＝「モサっと」の実測正体。
                            // 384 は fast マシンなら静止後の連鎖再描画ゼロ）。560=移動中と同値＝詳細化オフの値。
let gpuFast = false;        // renderworker からの格付け通知（gpuTier）。既定 false＝格付け確定まで詳細化しない安全側
// idleCalm＝settle(150ms)からさらに待った「本当の静止」でだけ手前詳細化を許す。ホイールのノッチ刻み
//（間隔150〜500ms）が「詳細化merge→次ノッチで破棄→通常merge」のチャーンを毎ノッチ起こすのを防ぐ
//（fast格付け機でズームがかえってモサつく実害＝ノッチの隙間は静止ではない）。
let idleCalm = false, calmT: number | null = null;
let moving = false, settleT: number | null = null;
// 移動中は幾何を再結合しない（タイルのポップ＝チラチラ防止）。停止後に再結合。
// PLATEAU LOD2 データ登録簿：寄ると自動で出す。bbox は自動トリガ用の緩い矩形（実描画は被覆マスクが実フットプリントに沿わせる）。
// 全国 300 市区町村分は scripts/plateau-catalog-build.mjs で datacatalog API から生成＝public/plateau-sets.json を起動時に fetch。
// opts.mesh=false＝建物3D機能ごと停止：カタログ・workerプール・自動ロード・データ管理ガジェットの全部
//（1地区あたり数十〜百MB級の重い機能＝軽い埋め込みが丸ごと切れる口。UIのchips/instrumentsと対になる機能側スイッチ）。
// 省メモリ端末（LOW_MEM）で頁に地図がもう 1 枚生きている＝2 枚目は建物 3D を既定で切る（#173 段 3・本人裁定「全端末・LOW_MEM は軽い設定」）。
// 建物メッシュが常駐メモリの最大の持ち主（GPU 固定常駐行＝数百 MB）＝2 枚ぶん持つと jetsam の危険。opts.mesh:true で入れられる
const SECOND_LOWMEM = LOW_MEM && LIVE_CONTAINERS.size > 1;
const MESH_ASKED = opts.mesh;   // 明示の指定＝無ければ undefined
const meshOn: GlobeScope["meshOn"] = (MESH_ASKED ?? !SECOND_LOWMEM) !== false && !/[?&]nopl=1/.test(location.search);   // ?nopl=1＝建物3D層別切り（iOS診断）
const REGION_BLD_LABELS: GlobeScope["REGION_BLD_LABELS"] = REGIONS.map(r => r.buildings?.labels).find(Boolean) ?? {};   // 建物 UI の文言（i18n キー）＝出所の名を出す地域の申告（日本＝PLATEAU）・無ければ汎用
const REGION_BLD_ICON: GlobeScope["REGION_BLD_ICON"] = REGIONS.map(r => r.buildings?.icon).find(Boolean) ?? null;   // 建物データ管理ボタンの顔（日本＝PLATEAU 公式ロゴ・無ければ汎用）
// 登録簿の取得＝地域宣言の合成（catalog の JSON＋地域が直書きする set）。到着後の裁き（合図・自動ロード・失敗の扱い）は mesh/manager.js（env.catalog）。
const loadMeshCatalog = () => !meshOn ? null :   // 呼ばれるのは manager を起こす時だけ（wakeMesh）
	Promise.all(REGION_CATALOG.map(b => fetch(ASSET_BASE + b.catalog).then(r => r.json()).then(list => stampBake(list, b)))).then(lists => {   // BASE_URL＝サブパス配信(/ortho-japan/)対応
		let sets = lists.flat();
		if (REGION_SETS.length) { sets = sets.concat(REGION_SETS); console.log(`[mesh] added ${REGION_SETS.length} set(s) declared by region ${REGIONS.map(r => r.code).join("+")}`); }
		return sets;
	});
// 空港マーク台帳：optbv の空港名注記(441)は z11 以上のタイルにしか無い＝低ズームでは
// scripts/airports-build.mjs で全国収穫した静的リスト(86空港)から「マークだけ」を注入する（本家地理院地図Vectorの見え方に合わせる）。
// z11+ はタイル注記が✈＋名称を描くので、静的分は同名をスキップ＝二重表示なし。鉄道チップのON/OFFは filterLabels(441) がそのまま効く。
const AIRPORT_MARK_MAXZ = 13;              // これ未満のズームで静的マークを注入
let airportMarks: HostLabel[] = [];
const REGION_AIRPORTS = REGIONS.map(r => r.airports).find(Boolean) ?? null;   // 低ズームの空港マーク台帳（地域の申告・日本＝airports.json）
if (REGION_AIRPORTS) fetch(ASSET_BASE + REGION_AIRPORTS).then(r => r.json()).then((list: Array<{ name: string; lon: number; lat: number }>) => {
	airportMarks = list.map(a => ({ text: a.name, code: 441, anchor: [a.lon, a.lat], size: 10, sort: 2, color: [0.53, 0.53, 0.5, 1], halo: [0.965, 0.965, 0.957, 1], haloW: 1.1, markOnly: true }));
	readySig = ""; mergeReq.main.sig = "";   // 読み込めた時点でラベル再結合（要求記憶も消す＝即出し直し）
}).catch(() => {});
// ── PLATEAU ランドマークの名札（施設チップONの時だけ）──────────────────────────
// 台帳＝scripts/plateau-names-build.mjs（採取）→ plateau-names-merge.mjs --emit-landmarks（h≥60m・
// タイル注記に同名がある棟は焼いた時点で除外済み）。数百棟・数十KB＝施設チップが初めてONになった時に取りに行く。
// ★「建物名を全部名札にする」はやらない（本人指摘 2026-08-05）：PLATEAU整備は336/1741市区町村で、
// 整備された町だけ名札だらけ・隣町はゼロ＝地図が壊れて見える。高さで足切りすると穴は原理的に見えない
// ——未整備の町にはそもそも高層建築が無いため。実測（101地区10476棟）でも h≥60m は108棟(1.0%)・17地区のみ。
// PLATEAUメッシュのロードとは無関係＝遠景（z11〜）から超高層の名前だけが静かに立つ。
const LANDMARK_CODE = 9101;                                   // 合成コード（optbv の実コードは 8105 まで＝9xxx帯は空き）。isFacility が真＝施設チップの傘下に入り、色も施設の紫になる
const LANDMARK_LADDER = [[11, 150], [12.5, 100], [14, 60]];   // [このズーム以上, 出す高さの下限m]＝寄るほど低い建物まで降りてくる
const landmarkMinH = (z: number) => { let h = Infinity; for (const [lz, lh] of LANDMARK_LADDER) if (z >= lz) h = Math.min(h, lh); return h; };
let landmarks: Array<{ text: string; anchor: [number, number]; h: number; pair: unknown }> | null = null, landmarkReq: Promise<void> | null = null;
function loadLandmarks() {
	if (landmarkReq) return landmarkReq;   // 一度だけ（失敗しても再試行しない＝名札は無くても地図は成立する）
	if (!REGION_LANDMARK.length) return landmarkReq = Promise.resolve();   // 名札を宣言しない地域（オランダ）＝取りに行かない
	return landmarkReq = fetch(ASSET_BASE + REGION_LANDMARK[0]).then(r => r.json()).then((j: { f: Array<[string, number, number, number, unknown]>; h: number }) => {
		landmarks = j.f.map(([text, lon, lat, h, pair]: [string, number, number, number, unknown]) => ({ text, anchor: [lon, lat], h, pair }));
		console.log(`[landmark] ledger loaded -> ${landmarks.length} buildings (h>=${j.h}m)`);
		readySig = ""; mergeReq.main.sig = ""; requestDraw();   // 到着＝ラベル再結合（空港台帳と同じ作法）
	}).catch(e => console.warn("[landmark] ledger fetch failed", e));
}
// --- 建物3D（PLATEAU）の管理＝mesh/manager.js（表示判定・ロード順・常駐予算・遠景・先読み・読込トースト・データ管理モーダル）。
// ここは配線だけ＝装置の旗・描画側の口・app の状態の覗き窓（getter）・生成後に定義される関数のラップ（一本道の下流＝呼ぶ時に解決）。
// 現在の画面に映る範囲をラフに見積もる（フラスタム厳密解ではなく自動ロードのゲート用）。z14+の寄った状態でしか呼ばれない＝視野は元々狭く、この近似で十分。
function approxViewBbox(cam: GlobeScope["cam"]): Bbox {
	// z＝正射スケール（緯度フリー）に伴い cos(lat) を撤去。係数は従来の東京相当(cos35°≈0.819)を固定＝
	// PLATEAU区選抜のゲート挙動を全国で従来の東京と同じに（緩めのbboxで拾い、最終判定は点距離が裁く）。
	// 156543=256px世界の赤道m/px。旧512世界のzで割っていた頃は実質2倍の余裕マージンがあり、それがチルトの
	// 奥行き（画面奥の区の選抜）を担っていた＝256統一(2026-07-26)で式が正確になった分、係数1.5で明示復元
	//（0.75のままだと札幌60°チルトで東区・北区がbbox外＝奥の建物が立たない回帰を実測）。
	const metersPerPx = 156543.03392 * 0.819 / Math.pow(2, cam.zoom);
	const halfM = Math.max(size.w, size.h) / dpr * 1.5 * metersPerPx;   // 対角余裕込みの半幅×旧実効マージン
	const dLat = halfM / 111320, dLon = dLat / Math.max(0.15, Math.cos(cam.center[1] * D2R));
	const [lon, lat] = cam.center;
	return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}
// --- POI台帳（施設の点・z14+）＝地域宣言 poi が実装を持参する（日本＝packages/jp/src/poi.ts：在庫マニフェスト・タイル・§12 手差分・ラベル注入）。ここは配線だけ。
// 実装は poi.create(env)（動的 import を宣言側が握る＝ホストは地域のパッケージを知らない）＝施設層 ON×z14+ で初めて要った時に読む＝代理の窓口（読み取りは空・ver=0）。台帳を宣言しない地域＝null。
let poiReal: PoiLedgerHost | null = null, poiWake: Promise<PoiLedgerHost | null> | null = null;
const poiReady = () => poiWake ??= Promise.resolve(REGION_POI!.create({ viewBbox: approxViewBbox, requestDraw: requestDraw })).then(led => {
	poiReal = led;
	requestDraw();
	return poiReal;
});
const poi: PoiProxyHost | null = !REGION_POI ? null : {
	load(c: GlobeScope["cam"]) { if (poiReal) poiReal.load(c); else poiReady(); },
	injectLabels: (...a: Parameters<PoiLedgerHost["injectLabels"]>) => poiReal?.injectLabels(...a),
	get ver() { return poiReal?.ver ?? 0; },
	ready: poiReady,
};
let flying: GlobeLive["flying"] = false;                        // フライト中フラグ＝meshMgr.update のゲート（flyTo が立て、着地/中断で下ろす）
// 建物メッシュの管理（mesh/manager.js＋データ管理画面）は寄った時（z≥MESH_WAKE_Z）か明示の呼び出し（台本の先読み・区の立ち上げ・
// データ管理ボタン）で初めて読む＝起動の JS と登録簿（plateau-sets.json）を列島ビューの起動から外す（2026-09-22・約 22KB gz）。
// 表向きの形（meshMgr.*）は従来と同じ代理の窓口：本物が来るまでの読み取りは空（登録簿 []・進捗は空 Map・HUD は 0）、
// 非同期の口は本物を待って渡す。除外表と進捗の中継口は本物が来た時に渡す。自動ロード（z15）は起こす線（z12）より深い＝寄る間に届く。
const MESH_WAKE_Z = 12;
const meshEnv = {
	meshOn, device: { LOW_MEM, MID_TIER, HI_TIER, gpuBackend, hudOn, ELL_ON, RENDER_FX },
	renderer, attachMeshPort: (port: MessagePort) => wPost({ type: "meshPort", port }, [port]), mapEl, dbgHost, emit: emitMesh,
	requestDraw: requestDraw,
	get cam() { return cam; }, get moving() { return moving; }, get flying() { return flying; }, get printHold() { return printHold; }, get elevBusy() { return elevBusy; },
	// 足元＝チルト時（pitch>20°）は画面下端中央の接地点（球外なら null）。真俯瞰では下端＝単に南＝優先の意味が無いので使わない
	footPoint: () => cam.pitch > 0.35 ? unprojectXY(size.w / dpr / 2, size.h / dpr * 0.98) : null,
	viewBbox: approxViewBbox, playingNow: () => scenes.playingNow(), flyTo: (...args: Parameters<GlobeScope["flyTo"]>) => flyTo(...args),
	groupOf: REGIONS.map(r => r.buildings?.group).find(Boolean) ?? null,   // データ管理モーダルの見出し・並び（日本＝都道府県）＝地域の申告
	bldLabels: REGION_BLD_LABELS,   // データ管理モーダルの題（地域の申告・無ければ汎用）
};
let meshReal: MeshManager | null = null, meshWake: Promise<MeshManager | null> | null = null, meshGone = false, meshTap: MeshProgressTap = null, meshVisible = true;   // meshVisible＝map.setMeshVisible（起こす前に来ても覚えておく）
const MESH_NO_PROGRESS: MeshManager["progress"] = new Map();
const wakeMesh = () => meshWake ??= !meshOn ? Promise.resolve(null) : import("./mesh/manager.ts").then(async ({ createMeshManager }) => {
	if (meshGone) return null;   // 起こしている間に destroy された
	const catalog = loadMeshCatalog();
	meshReal = createMeshManager(Object.assign(Object.create(meshEnv), { catalog }));   // スプレッド禁止＝cam/moving 等の getter をその瞬間の値に固めてしまう（原型鎖で生きたまま覗かせる）
	if (meshTap) meshReal.setProgressTap(meshTap);
	if (!meshVisible) meshReal.setVisible(false);
	// 捨てる地物（精査で不要と裁定した gml_id）＝生経路も焼きと同じ。manager が起きている worker と後から起きる worker の両方へ配る
	if (REGION_EXCLUDE.length) fetch(ASSET_BASE + REGION_EXCLUDE[0]).then(r => r.ok ? r.json() : null).then(map => { if (map) meshReal?.setExcludeMap(map); }).catch(() => {});
	await catalog?.catch(() => {});   // 登録簿が manager に入ってから解決（manager の受け取りは先に登録済み＝この後に走る）
	requestDraw();
	return meshReal;
}).catch(e => { console.error("[mesh] manager load failed", e); return null; });
// 代理の窓口の型＝本物（MeshManager）と同じ口。違いは standUp／openDb が本物を起こしてから呼ぶ（非同期・起こせなければ undefined）・
// firstRevealSets は台本の視点（検めていない列）をそのまま受けて本物へ渡す・ready が増える
const meshMgr: Omit<MeshManager, "setExcludeMap" | "standUp" | "openDb" | "firstRevealSets" | "setVisible" | "visible"> & {
	standUp(...a: Parameters<MeshManager["standUp"]>): Promise<boolean | undefined>; openDb(): Promise<void>;
	firstRevealSets(views: unknown[]): ReturnType<MeshManager["firstRevealSets"]>; ready: typeof wakeMesh;
} = {
	// settled（カメラ静止＝onMove の 150ms 無音）は本物へ必ず渡す＝新しい区のロードは settled の時だけ始まる。
	// ⚠落とすと、止まっても何も読まない（2026-09-22〜24：デモの全幕で PLATEAU が出ず、手動でも「他の区の読み込み完了」等の一突き次第＝再現性のない不表示）
	update(settled?: boolean) { if (meshReal) meshReal.update(settled); else if (meshOn && !meshGone && cam.zoom >= MESH_WAKE_Z) wakeMesh(); },   // 起こした時は登録簿の到着で autoMesh(true) が一度走る（manager 側）
	standUp: async (...a: Parameters<MeshManager["standUp"]>) => (await wakeMesh())?.standUp(...a),
	prefetch: async (...a: Parameters<MeshManager["prefetch"]>) => (await wakeMesh())?.prefetch(...a) ?? [],
	openDb: async () => (await wakeMesh())?.openDb(),
	firstRevealSets: (views: unknown[]) => meshReal?.firstRevealSets(views as Parameters<MeshManager["firstRevealSets"]>[0]) ?? [],
	trimForScript: (views: string[]) => meshReal?.trimForScript(views),
	setProgressTap: (fn: MeshProgressTap) => { meshTap = fn; meshReal?.setProgressTap(fn); },
	terminate: () => { meshGone = true; meshReal?.terminate(); },
	get sets() { return meshReal?.sets ?? []; },
	get progress() { return meshReal?.progress ?? MESH_NO_PROGRESS; },
	isActive: (name: string) => meshReal?.isActive(name) ?? false,
	isDead: (name: string) => meshReal?.isDead(name) ?? false,
	visibleLoading: () => meshReal?.visibleLoading() ?? [],
	memStats: () => meshReal?.memStats() ?? { bytes: 0, regions: 0, transient: { cache: 0, live: 0, bytes: 0 }, tier: null },
	ready: wakeMesh,
};
// --- 地中フェード（クランプの代替・2026-07-28）: カメラが地表(DTM)より下へ潜ったら全画面を暗色で覆う ---
// 旧・カメラ地形クランプ（eye 押し上げ）は廃止：山頂×高チルトで eye が sea-level 軌道ごと山体に埋まり、
// eye直下サンプルは下った斜面を見る＝山頂が計算に入らず効かなかった（富士 z15/75° で裏面を見上げる絵）。
// 代替はカメラを一切動かさず「入ったら暗くする」。判定は eye が自分の直下の地表柱より下か＝1サンプルで完結
// （山も建物も同じ地べた基準。土管など地中構造が要るなら別案）。カメラ数学に触れない＝「妙なブレ」ゼロ。
// 覆いは #map 直下の DOM オーバーレイ（#underground）＝基図GL(#c)・ラベル(#labels)・gint を一度に覆う
// （GL板だと別canvasのラベルや renderer.draw 後に描かれる gint を覆えない）。UI(計器/検索)より下＝脱出はできる。
//   ・空間フェード（smoothstep）：eye直下の余裕 d[m] を d=+20m(0)→d=-15m(1) で不透明度へ＝地表手前から翳り、
//     15m 潜れば全面。連続量＝閾値のパチつき無し（＝ヒステリシス相当の帯）。
//   ・時間フェード：opacity の CSS transition（style.css の #underground＝.1s）が ~16Hz サンプルのジッタ/遅れを均す。
//   ・静止コミット：止まったら帯を捨てて確定＝地中なら全黒（commitUnderground、下の settle）。中途半端なグレーを残さない。
//   ・真俯瞰(pitch<0.06)=2D は無効（山頂への 2D オーバーズームを妨げない＝地形表示も無い平面地図）。
//   ・★サンプルは wait:true（2026-09-21）：旧＝wait なしは標高ローダ（1スロット直列）が HUD の照会等で使用中だと
//     「到着まで 0m」を返す＝地中なのに d=眼高>0 で「地上」と誤判定し、静止コミットもその値を信じて透明のまま。
//     実測：上高地の谷底（眼高460m・直下1837m）に共有URLで着地→40秒放置で黒くならず、動かして初めて黒。
//     wait は順番待ちだけ（ローダ死は 20 秒で諦め＝不透明度は据え置き＝「地上」とは言わない）。
//   ・★再サンプルの契機（同日）：onMove だけでは「起動時に地中で開いた」「静止中にタイルが届いた」を拾えない
//     → ローダ準備完了（getHeightP）・settle・タイル到着（onend）で force サンプル。静止中に届いた答えは帯でなく確定値。
let ugT = 0, ugBusy = false, ugLastD = Infinity;   // ugLastD＝直近サンプルの eye直下地表からの余裕[m]（静止時コミット用。Infinity=地上/不明）
const UG_FADE_TOP_M = 20, UG_FADE_FULL_M = -15, UG_WAIT_MS = 20000;
function updateUnderground(force = false) {   // ~16Hz サンプラ（onMove から）：eye直下の地表との高低差→オーバーレイ不透明度。force＝スロットル無視（起動/settle/到着）
	if (!getHeight || ugBusy || (!force && performance.now() - ugT < 60)) return;
	ugT = performance.now(); ugBusy = true;
	// 動作中＝帯（smoothstep）で滑らかに／静止中に届いた答え＝確定（地中なら全黒・地上なら解除）＝commitUnderground と同じ裁定
	const done = (t: number, d: number) => { ugBusy = false; ugLastD = d; (undergroundEl.style as { opacity: string | number }).opacity = moving ? t : (d < 0 ? 1 : 0); };
	if ((cam.pitch || 0) < 0.06) return done(0, Infinity);   // 2D=地中判定なし
	if (noTerr) return done(0, Infinity);   // 地形を描かない地図（terrain:false・MapLibre の口の既定）＝地面は海抜 0 の平面＝潜らない。旧＝描いていない自前の標高で判定し、z18・傾き 60° の公式例（add-a-3d-model-using-threejs）が全面灰色（2026-09-29）
	const st = cameraState(cam, size.w, size.h);
	const len = Math.hypot(st.eye[0], st.eye[1], st.eye[2]);
	const [lon, lat] = betaToLonLat(st.eye);   // ★eye は β空間（cameraState が S⁻¹ 済み）＝β→測地緯度の一段だけ。生 asin=地心(−10km)・worldToLonLat=S⁻¹二重(+10km) はどちらも ?ell=1 で直下点が 10km 飛ぶ（8/15・9/21）
	const eyeAltM = (len - 1) * EARTH_M;   // eye の海抜[m]（軌道は sea-level 球なので len-1 がそのまま高度）
	const UG_TIMEOUT = Symbol("ug-timeout");
	Promise.race([Promise.resolve(getHeight(lon, lat, cam.zoom, { wait: true })), new Promise(r => setTimeout(r, UG_WAIT_MS, UG_TIMEOUT))])
		.then(h => {
			if (h === UG_TIMEOUT) { ugBusy = false; return; }   // ローダ無応答＝今の不透明度を据え置き（次の契機で再挑戦）
			if (clipFor("terrain") && clipDistanceM(clipFor("terrain")!, lon, lat, eyeAltM) < 0) return done(0, Infinity);   // 断面（#111）＝目が地形の面で切られた側（周りに地面が無い）＝地中でない
			const d = eyeAltM - (+(h as number) || 0);   // 直下地表からの余裕[m]（d<0=地中）
			const x = Math.max(0, Math.min(1, (UG_FADE_TOP_M - d) / (UG_FADE_TOP_M - UG_FADE_FULL_M)));
			done(x * x * (3 - 2 * x), d);   // smoothstep
		})
		.catch(() => done(0, Infinity));
}
// 静止（settle＝描画確定）時のコミット：動作中は帯（smoothstep）で滑らかに翳らせるが、止まったら確定する
// ＝地中(d<0)なら中途半端なグレーを残さず全黒（opacity=1）、地上なら解除（0）。Kenji「止まった時はヒステリシスが
// あっても真っ黒に」。直近サンプル ugLastD を同期で使う（新規fetchの競合なし。静止時は eye≈最終onMove位置＝十分新鮮）。
function commitUnderground() {
	(undergroundEl.style as { opacity: string | number }).opacity = ((cam.pitch || 0) >= 0.06 && ugLastD < 0) ? 1 : 0;
}

// --- 選抜リフト球（タイル被覆の地形補正・2026-08-03）: 中心の地面標高 → tiles.update の groundR ---
// selectLOD の unproject は海面球が既定＝標高の高い土地ではチルト時に「持ち上がった地面が画面下端へ
// 映り込む手前領域」が画面外扱いになり、主層/下地/毛布とも被覆が欠けて紙色のくさびが残る
//（実測: 草津1200m・z15.8・チルト52°で画面左下1/3が空白。Node被覆シミュで海面欠け0/リフト欠け48%）。
// 表示中の地形変位と同式（renderer elevScaleEff と同じ pitch フェード）で半径を作る＝真俯瞰は1（従来通り）。
// 標高は getHeight の非同期サンプル＝到着まで0（海面挙動）、到着時 needsDraw で選抜し直し＝自己回復。
let groundElevM = 0, geBusy: GlobeLive["geBusy"] = false, geKey: GlobeLive["geKey"] = "", geGen: GlobeLive["geGen"] = 0;
function sampleGroundElev() {
	if ((!getHeight && !demMain) || geBusy) return;
	const k = Math.round(cam.center[0] * 1000) + "," + Math.round(cam.center[1] * 1000);   // ~100m格子＝微パンで照会を積まない
	if (k === geKey) return;
	geBusy = true;
	// 世代＝DEM の差し替え（setDem）で古い照会の答えを捨てる・3 秒で答えが無ければ手を放す（答えの来ない照会で geBusy が立ちっぱなし＝以後一度も引き直さない事故の柵・2026-09-30）
	const gen = ++geGen, timer = setTimeout(() => { if (gen === geGen) geBusy = false; }, 3000);
	// 外来の DEM（setTerrain・style の terrain）がある地図は描いている地形と同じ出どころ（heightAt＝外来が先・無い所は既定）。旧＝既定の DTM だけ＝mapterhorn の山で 0m（注視点の高さが効かない・2026-09-30）
	Promise.resolve(demMain ? heightAt(cam.center[0], cam.center[1]) : getHeight!(cam.center[0], cam.center[1], cam.zoom))
		.then(h => { clearTimeout(timer); if (gen !== geGen) return; geBusy = false; geKey = k; const v = Math.max(0, +h || 0); if (Math.abs(v - groundElevM) > 1) { groundElevM = v; requestDraw(); } })
		.catch(() => { clearTimeout(timer); if (gen === geGen) geBusy = false; });   // 失敗は geKey 据置＝次の render で再挑戦
}
// MapLibre の目盛りの時のタイルの z（ML_COVER）＝selectLOD の zOf。tileSize＝source のタイルの大きさ・round＝raster（roundZoom）。内製の目盛りは null＝従来の閾
function mlZoomOf(tileSize = 512, round = false) {
	return ML_COVER ? mlTileZoomOf(cam, size.h / dpr, { ...ML_COVER, terrain: !noTerr }, { tileSize, round }) : null;
}
const groundRNow = () => {
	const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14)), pf = pt * pt * (3 - 2 * pt);
	if (noTerr || pf <= 0 || groundElevM <= 0) return 1;   // 真俯瞰 or 海面＝従来挙動・地形を描かない地図も海面（描く側と同じ＝持ち上げの pf と揃える）
	// リフト量は eye の下に留める（-30m マージン）：球が eye を呑むと unproject の出口が地球の裏側＝
	// ゴミサンプル。谷を見下ろす縁などで中心標高が eye を超えても、選抜は海面球との和集合が受け持つ。
	const st = cameraState(cam, size.w, size.h);
	const eyeAltM = (Math.hypot(st.eye[0], st.eye[1], st.eye[2]) - 1) * EARTH_M;
	const lift = Math.min(groundElevM * pf, Math.max(0, eyeAltM - 30));
	return 1 + lift * (TERR_EXAG / EARTH_M);
};

function onMove() {
	clampCamLimits();   // 実行時の上限・可動域（#35）＝入力・飛行・URL 復元のどの経路で動いても同じ所で締める（聞き手へ渡す前に）
	cam.center[0] = wrapLon(cam.center[0]);   // パン/回転/フライトの累積を毎移動で正規化＝float32原点相対の前提を守る（階段バグ根治）。聞き手より先＝move も settle／getCenter と同じ ±180° の経度を受け取る（旧＝move だけ 190° 等の生の値）
	for (const cb of mapOn.move) { try { cb({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, roll: cam.roll || 0 }); } catch (e) { console.error("[map.on move]", e); } }
	moving = true; requestDraw();
	idleCalm = false; clearTimeout(calmT);     // 動いた瞬間に「本当の静止」を取り下げ（詳細化は許可待ちに戻る）
	updateUnderground();                       // 地中フェード（非同期・10Hz＝eye直下の地表との高低差→#underground の opacity。時間フェードはCSS transition）
	gint.updateGintSlot();                                                                // gint 単一スロットを z=4 で調停（ユーザー層⇄世界海岸線）＋海岸線の遅延ロード
	sky.ensureStars();                                                                // 星空も同じ流儀＝初めて z<4 に出た瞬間に読む
	meshMgr.update();                                                                 // 寄る/離れるで PLATEAU を自動ロード/解放（ガードで実質タダ）
	// skipBase＝render() が最後に決めた値を使う（#58・2026-09-27）。旧＝常に false＝rAF の render()（covered&&merged＝true）と交互に worker へ届き、
	// 3D では地面アトラスの鍵（焼くスロット）が毎フレーム変わって全窓を焼き直し、中身も「粗い下地の水域あり／なし」で交互＝海岸の水域がちらつく（2 度描き）
	if (mlLight && mlLight.anchor === "viewport" && cam.bearing !== lightBearingSent) sendLight();   // style の light（viewport の錨＝画面の上）＝方位が変わった時だけ
	if (mlSky && skyHasExpr(mlSky) && cam.zoom !== skyZoomSent) sendSky();   // style の sky（B4）＝["zoom"] の式を持つ時だけ zoom が変わったら評価し直す
	renderer.draw(cam, { skipBase: lastSkipBase, skipMain: mainStale(), noTerrain: false, terrainGate: false });   // 入力の瞬間に最新camをworkerへ（全球z<4も標高の塗りは描く）。terrainGate:false＝入力中はアトラス再構築を起こさない（停止時に一回だけ）
	// 知性の層(gint)は render worker が frame 末尾に同フレーム同カメラで描く（1canvas統合＝泳ぎ・チルト opacity 手当てとも消滅）。
	clearTimeout(settleT);
	settleT = setTimeout(() => {
		for (const cb of mapOn.settle) { try { cb({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, roll: cam.roll || 0, hash: viewHash() }); } catch (e) { console.error("[map.on settle]", e); } }
		moving = false; requestDraw(); commitUnderground(); updateUnderground(true); wPost({ type: "gintDrawn" }); for (const hh of extGint.values()) hh._zoomReeval?.(cam.zoom); meshMgr.update(true); if (!printHold) saveView();   // 停止後に identify(picking)＋PLATEAU確定（settled＝ロード発火/レーン切替はこの瞬間だけ）＋ビュー保存＋地中フェード確定（止まったら地中=全黒）
		calmT = setTimeout(() => { idleCalm = true; requestDraw(); }, 550);   // さらに550ms（停止から計700ms）＝ホイール刻みを跨いだ「本当の静止」でだけ手前詳細化
	}, 150);
	schedulePos();   // 座標読み取りもカメラに追随（rAF畳み込み＝タダ同然）
}

// データパイプライン（tile/scene worker）。実装は pipeline.js。
// tiles＝LOD管理（update/labels）、requestMerge＝結合要求（scene worker が結合→render worker へ直行）。
// 図郭外フォールバック水域：optimal_bvmap が 404 を返す提供圏外（韓国・台湾等の外国域）に、water 層の色で
// 「標高ゲート付き全面水域」を敷く（FS が標高h>0を discard＝海は地理院・陸は標高(GEBCO/R10) の管轄裁定。
// 敷かないと圏外は紙色＝l=terrain の等高線が乗ると「白い偽の陸」に見える）。z≥8・sea.minzoom(z9) ゲート共有。
if (!style.ext) style.emptySea = "water";   // 外来 style＝空タイルに水を敷かない（誰の「水」か分からない）
let vtdAnchorsOn = false;   // #123：vtdraw が作られてから差し込む位置を配る（それまで＝起動の途中のテーマ・生成層の再ビルドから呼ばれても何もしない＝後で宣言する束縛に触れない）
const { relayCtl: pipelineRelay, tiles, requestMerge, setStyle: setPipelineStyle0, setDrape: setPipelineDrape, destroy: destroyPipeline } = createPipeline({
	style, tileUrl: (z, x, y) => BASE_SOURCE.tileUrl(z, x, y) as string, requestDraw: requestDraw, scenePort: sceneChan.port1, onTile, ell: ELL_ON, workerFactory: hostWorker, request: requester.forTiles(),   // タイル/シーン worker もアプリの入口で・request＝transformRequest/addProtocol（#37）・tileUrl は関数で包む＝map.setStyle で基図の置き場を差し替えられる
	encoding: () => BASE_SOURCE.encoding || "mvt",   // 基図タイルの形式（mvt｜mlt・#88）＝tileUrl と同じく関数で包む（setStyle で置き場と一緒に替わる）
	tileQueue: !/[?&]tileq=0/.test(location.search),   // 優先付き共有キュー（vt perf plan §3.1）＝?tileq=0 で旧の round-robin（A/B・計器 e で比べる）
	drape: LINESUB || (() => !noTerr),   // 線の細分（vt perf plan §3.2）＝地形を描かない地図（terrain:false・?noterr=1）は細分しない。?linesub=1 で従来どおり常に細分（A/B）。setTerrain で地形が入ったら setPipelineDrape（api/terrain.ts）
	coverage: BASE_SOURCE.coverage,   // 記述子が持つ（GSI=日本域 bbox／PMTiles=null＝アーカイブの自己申告に任せる）

	// LOD下限＝タイルz8（sea gate と同じ閾値）：optbv は z8 から海が全面WA（沖合タイル=WA一枚50B級）、z7以下は
	// 「陸=AdmArea・海=背景」モデルでWA無し＝チルトの遠景（z5-7混在）だけ海が紙色に抜けてまだらになる。
	// 遠景もタイルz8 以上で敷けば海色がズーム段間で揃う（根治）。ビューz<9 は従来どおり紙の海＋gint海岸線。
	// PMTiles 基図では床を外す＝この床は「optbv は z8 から海が全面 WA」という bvmap 固有の事情のための装置で、
	// 他人のアーカイブには当てはまらない。加えて床(z8) と maxZ(アーカイブの maxZoom・例 z3) が矛盾すると
	// 選抜が空になり高ズームで真っ白になる（実測）。minZ も 0 へ＝低ズームまで選抜・下地・毛布を降ろす。
	lodFloor: BASE_SOURCE.lodFloor,
	minZ: BASE_SOURCE.minZ,
	// 低メモリ端末はタイル予算を絞る：multi_draw の常駐プールは tess 予算の約2倍（idx u32化・線分32B化）を
	// GPU に占める＝既定の自動予算(48MB)だと従来比で実質メモリが膨らみ、PLATEAU の百MB級が乗った時に
	// タブごと落ちる（スマホ実機で発生）。24MB でも可視タイル(keep)は余裕で収まり、削るのはパン戻り履歴だけ。
	memBudgetMB: qNum(/[?&]tbudget=(\d+)/, LOW_MEM ? 24 : 0) || undefined,   // ?tbudget=48 でタイル予算を戻すA/B（未指定=LOW_MEM 24 / 非LOW_MEM auto、?tbudget=0 で強制auto）
	// merge の ack（fallback＝CPU merge 経路のみ。multi_draw では renderer 適用時の dlApplied が同じ関数を呼ぶ）
	onMerged: (slot, sig) => onSceneApplied(slot as string, sig as string),
});
const setPipelineStyle: GlobeScope["setPipelineStyle"] = (st, keep) => { setPipelineStyle0(st, keep); if (!keep) sendUserAnchors(); sendPtFsLayers(st); };   // 基図の層の添字（li）が動く＝vector の描く層の差し込む位置も配り直す（#123）
// 基図の feature-state を読む層（paint 表の (b) 類の段 3・GL2 の md）＝描き手が状態の置かれた地物の行を評価し直す（状態は api/style.ts の setFeatureState が "ptFs" で送る）。
// style が変わるたびに全部を置き換える（表を読まない描き手＝WebGPU は知らない命令として捨てる）
const sendPtFsLayers = (st: Parameters<GlobeScope["setPipelineStyle"]>[0]): void => {
	const list: [string, string, ReturnType<typeof layerPaintTable> & object][] = [];
	for (const L of st.layers) { const sl = L["source-layer"], eo = originOfLayer(L), T = sl && eo ? layerPaintTable(L.type, L.paint as Record<string, unknown> | undefined, eo) : null; if (T?.fs) list.push([L.id, sl!, T]); }
	renderer.set("ptFsLayers", list);
};
sendPtFsLayers(style);   // 起動の style（以後は setPipelineStyle ごと）
if (IOS_RELAY && gpuBackend) { relayCtl = pipelineRelay; const pend = relayPending.splice(0); for (const [m2, t2] of pend) relayCtl(m2, t2); console.log("[boot] iOS relay path active (page -> scene worker -> render worker); flushed", pend.length, "queued messages"); }
// ack＝「このシーンが画面に載った（fallback は次フレーム、multi_draw は適用の瞬間）」。sig はここで初めて確定する
// （要求時の楽観確定をやめた＝失敗が永続穴にならない）。hoisted 関数＝renderWorker.onmessage（上方）からも呼ばれる。
function onSceneApplied(slot: string, sig: string) {
	// 基図の門(z<BASEMAP_MINZOOM)より下へ移行後に着地した投げっぱなしmerge：結合結果は scene worker→render worker 直行＝
	// main では止められないため、render() が空にした後から道路/鉄道が復活する（ズームアウト中の要求が遅れて届く）。
	// ack＝着地の合図なので、ここで検知して即座に空へ戻す（sig は確定させない＝復帰時に再結合させる）。
	// 世界タイル(Protomaps)撤去（2026-09-03 湖のNE化）＝world でも基図の門の下はタイルなし＝例外撤廃。
	// ?pm= のときだけ門が 0 まで開く（TILE_MINZOOM）＝汎用アーカイブは低ズームを持っていることがある。
	if (cam.zoom < TILE_MINZOOM) {
		renderer.set("scene", { origin: [cam.center[0], cam.center[1]], layers: [] }, slot);
		requestDraw();
		return;
	}
	if (slot === "main") {
		const ml = mergeLog.find(m => m.ackAt === 0 && sig.startsWith(m.sig)); if (ml) ml.ackAt = Math.round(performance.now());
		readySig = sig;
		readyKeys = new Set(sig.split("#")[0].split("|").filter(Boolean)); readyTail = sig.slice(sig.indexOf("#"));   // render の Set 照合用（ここが readySig 確定の唯一の点）
		const lat = tiles.shown(readyKeys), at = performance.now();   // 計器 e＝この ack で初めて画面に載った主層タイルの「必要になった→画面」
		for (const r of lat) vtPush(vtLat, { at, key: r.key, z: r.z, total: r.total, ready: r.ready, wait: r.wait, fetch: r.t?.fetch ?? 0, build: r.t?.build ?? 0 });
		if (perfLog && lat.length) { const v = vtSummary(1e9).lat; console.log(`[vt] shown +${lat.length} tiles  need→screen med ${vtSummary().lat.med.toFixed(0)}ms p90 ${vtSummary().lat.p90.toFixed(0)}ms (10s)  all: med ${v.med.toFixed(0)} p90 ${v.p90.toFixed(0)}  wait ${v.wait.toFixed(0)} fetch ${v.fetch.toFixed(0)} build ${v.build.toFixed(1)}`); }
		const z = mergePendingZoom.get(sig);
		if (z != null) { mainSceneZoom = z; mergePendingZoom.delete(sig); }
		slog("main merge applied on screen (visible from here)");
	} else if (slot === "base") { baseSig = sig; slog("base swap applied"); }
	requestDraw();
}
dbgHost.__mergeFail = () => requestMerge.debugFail();   // 次の merge を故意に失敗させ ack 自己修復を実地検証
dbgHost.__vtPool = () => requestMerge.stats();          // multi_draw 常駐プールの占有を scene worker の console に出す
// ?pm= のアーカイブ自己申告を読む → 層名を役割へ振って描画規則を組み → style へ前置 → 再ビルド。
// 規則の中身は style-pm.js（役割表・紙→インクの階調・描かないものの裁定）。ここは配線だけ。
const withPM: GlobeScope["withPM"] = s => EXT ? extBaseStyle(EXT) : BASE_SOURCE.info?.layers?.length ? { ...s, layers: [...pmLayers(BASE_SOURCE.info, theme), ...s.layers] } : s;   // テーマ切替でも掛け直す（switchTheme が theme.style へ戻す・階調は新テーマの紙から作り直る）
// 画像タイル層の起動待ち行列：map.raster（下方で定義）と初フレームが揃ってから実行＝アーカイブのヘッダが先に届いても TDZ/未初期化を踏まない
const rasterBootQ: GlobeScope["rasterBootQ"] = [];
let rasterBoot: GlobeLive["rasterBoot"] = fn => rasterBootQ.push(fn);
if (BASE_SOURCE.kind === "pmtiles") pmtilesInfo(BASE_SOURCE.url!).then(info => {
	BASE_SOURCE.info = info;   // maxZ（LOD 上限）にも即効く＝次フレームから分割が maxZoom で止まる
	// ラスタのアーカイブ（tileType＝png/jpeg/webp/avif）＝ベクタ配管はエンジンの門が空タイルで返す＝画像タイル層（基図・塗りは伏せる）へ回す。
	// データが自分の種別を申告する＝同じ ?pm= で済む（初めにデータありき）。出典もアーカイブの自己申告（rasterInfo で消毒）
	if (isRasterTileType(info.tileType)) {
		rasterBoot(() => map.raster.add("pm", { pmtiles: BASE_SOURCE.url! }, { order: "under", hideFills: true }).catch(err => console.warn("[pm] raster archive failed", err)));
		console.info(`[pm] ${info.name || PM_SPEC}  raster ${info.tileType}  z${info.minZoom}-${info.maxZoom}  -> imagery layer (fills hidden)`);
		return;
	}
	// 出典：アーカイブが metadata で宣言したものを使う。**他人の置き場の HTML＝非信頼入力**につき
	// innerHTML の直前で消毒する（docs/geopbf §11 の作法・?pm=<攻撃者URL> を踏んでも script が走らない）。
	BASE_SOURCE.attrHTML = info.attribution ? sanitizeHTML(info.attribution) : null;
	attrZone = null;   // 圏を無効化＝既に "region" に居ても次フレームで出典が差し替わる
	style = withBaseOverrides(withUserBg(withPM(theme.style)));
	setPipelineStyle(style);   // 生成層込みで再ビルド
	requestDraw();
	console.info(`[pm] ${info.name || PM_SPEC}  z${info.minZoom}-${info.maxZoom}  bbox ${info.bbox ? info.bbox.map(v => v.toFixed(2)).join(", ") : "global"}\n     layer -> role: ${pmRoles(info).join(" ") || "no metadata"} (ground/label are not drawn or decoded)`);
}).catch(err => console.warn("[pm] cannot read PMTiles", BASE_SOURCE.url, err));

dbgHost.__style = () => style;   // 現在の style＝検証フック（t-world：world-water 層が「無い」こと＝湖はエンジン lakes スロットへ移行済 2026-09-03）

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH: GlobeScope["MAXPITCH"] = 75 * D2R;
// チルト上限の単位（1.3.0〜・台帳 R15）：MapLibre と同じ度で受ける（1.x の「1.6 以下はラジアン」の読み替えは 2.0 で外した）
const pitchIn: GlobeScope["pitchIn"] = v => v == null ? v : v * D2R;
let maxPitchCur: GlobeLive["maxPitchCur"] = pitchIn(opts.maxPitch) ?? MAXPITCH;   // 現在のチルト上限＝起動オプション（geoedit.html=0）を実行時に map.setMaxPitch で上書きできる（編集ガジェットの真上固定）   // 山岳ビュー(z<13)は地形が深度で自遮蔽・混成アトラスが地平線までカバー＝高チルトの根拠が揃ったので75°まで開放
// ZOOM_MAX は上方（基図の門より前）で決めている＝BASEMAP_MINZOOM が参照する（使う所より前で決める・TDZ の轍）
const ZOOM_MIN: GlobeScope["ZOOM_MIN"] = 1;          // 床1＝地球全体を余白つきで（z1=世界512px＝スマホ縦にも収まる。旧床2は縦画面で地球がはみ出し、モバイルΔ補正が床に潰される素だった 2026-08-02）
// 太陽系圏（2026-08-10）：256pxの梯子を負へ延長＝ズームアウトの続きで太陽系へ（z≈-16.4で冥王星軌道が視野に収まる）。
// 飛行系（デモ・scene・flyTo）も CAM_ZOOM_MIN 床＝台本から太陽系へ飛べる（2026-08-21・LT台本の z=-17 行が動機。
// 旧・飛行系だけ床1の保守的縫い目は撤去＝呼び出し側は皆 z≥3 か Math.max 済みで、床1に頼る呼び出しは無いのを検分済み）。
// ?nosolar=1 で圏ごと停止（?nofar 等と同じ逃げ道の作法）＝その時は飛行床も従来の1へ戻る。
const SOLAR_ZOOM_MIN = -17;
const solarOff = new URLSearchParams(location.search).has("nosolar") || opts.sky === false;   // opts.sky＝false（MapLibre の口）＝太陽系圏も持たない
const CAM_ZOOM_MIN: GlobeScope["CAM_ZOOM_MIN"] = solarOff ? ZOOM_MIN : SOLAR_ZOOM_MIN;   // カメラ実床（手動系はこちら）
let zoomMinCur: GlobeLive["zoomMinCur"] = CAM_ZOOM_MIN;   // 現在のズーム床＝map.setZoomMin で実行時に上げられる（編集ガジェット＝z2.5・解除で CAM_ZOOM_MIN へ）
let editDropOwner: GlobeLive["editDropOwner"] = false;       // 編集ガジェットがドロップを所有中＝dropFile ガジェットは譲る
// 大気の霞（球の地を大気色へ寄せる・縁のリム光）＝MapLibre は sky／fog を書かない限り持たない＝MapLibre の目盛りでは強さ 0（options.ortho.atmosphere:true で戻す・2026-09-30）
const atmoOf = (a: number[] | undefined) => (ML_COVER && opts.atmosphere !== true && Array.isArray(a) ? [a[0], a[1], a[2], 0] : a);
let atmo = atmoOf(theme.atmo);      // 大気色 rgb + 強さ（テーマ台帳のノブ＝palettes.js）※生き替えで差し替わる
let bldColor = theme.bldColor;      // 建物色（テーマ台帳のノブ＝palettes.js）※生き替えで差し替わる
// cam＝幾何のみ（center/zoom/pitch/bearing/dpr）＝毎フレームの draw payload（将来の worker 境界）。
// 色（clear/land/atmo/bldColor）は静的なので setView で一度きりアップロード＝hot path から追い出す。
// style の light（B3・2026-10-12・MapLibre の light/setLight/getLight）：起動の style と setStyle の根の light を読む。null＝従来の固定光（renderer の既定・ビット同一）。
// viewport の錨は画面の上＝bearing で回る＝onMove で bearing が変わった時だけ送り直す（軽い message）
let mlLight: GlobeLive["mlLight"] = null, lightBearingSent: number | null = null;
let mlSky: GlobeLive["mlSky"] = null, skyZoomSent: number | null = null;
// MapLibre の小口（B6）の状態：glyphs（記録だけ＝文字は Canvas2D）・sprite の一覧（id → url・読んだ記号の名前）・font-faces の記録・最小チルト・カメラの後処理・連続描画・debug の表示
let mlGlyphs: GlobeLive["mlGlyphs"] = EXT?.ms.glyphs ?? null, spriteList: GlobeLive["spriteList"] = normSprite(EXT?.ms.sprite), fontFacesList: Array<Record<string, unknown>> = [];
const spriteNames: GlobeScope["spriteNames"] = new Map();   // sprite の id → その sprite から読んだ記号の名前（removeSprite で消す）
let minPitchCur: GlobeLive["minPitchCur"] = 0, camUpdateFn: GlobeLive["camUpdateFn"] = null, repaintAlways = false, lastCoverOrder: TileOrder | null = null;
const dbgState = { tileBoundaries: false, padding: false };   // style の sky（B4）＝normSky 済み｜null（従来＝宇宙へ抜けるリム光）
const sendSky: GlobeScope["sendSky"] = () => { skyZoomSent = cam.zoom; renderer.set("sky", mlSky ? skyPayload(mlSky, cam.zoom) : null); };
const sendLight: GlobeScope["sendLight"] = () => { lightBearingSent = cam.bearing; renderer.set("light", mlLight ? lightPayload(mlLight, cam.bearing * R2D) : null); };
const HOME_VIEW: GlobeScope["HOME_VIEW"] = REGION_HOME?.view ?? [0, 20, 1.6];   // 既定起動の視点＝地域宣言の home（日本＝列島ビュー z6.6＝デモ初景）・申告が無ければ世界（globe）
const cam: GlobeScope["cam"] = { center: [HOME_VIEW[0], HOME_VIEW[1]], zoom: HOME_VIEW[2], pitch: 0, bearing: 0, roll: 0, dpr };   // roll＝視線まわりの回転（MapLibre の roll・2026-10-12 A1）。fovy は無指定＝エンジン既定 50°（setVerticalFieldOfView で書く）   // 初訪問時のみ＝共有URL→前回ビューの順で下で復元
// --- 共有URL（パーマリンク）：codec は engine（viewurl.js）。ここは起動の優先度と app 固有クランプだけ ---
// 起動の優先度：URLハッシュ > localStorage(前回ビュー) > 既定の世界ビュー。settle 毎に replaceState で
// 書き戻す＝アドレスバーが常に「今この視点の共有URL」（コピーするだけで人に渡る＝発表・拡散の生命線）。
function applyCamView(v: { lon: number; lat: number; zoom: number; pitch?: number; bearing?: number; roll?: number }) {
	cam.center = [wrapLon(v.lon), Math.max(-90, Math.min(90, v.lat))];
	cam.zoom = Math.max(zoomMinCur, Math.min(ZOOM_MAX, v.zoom));   // URL/復元は太陽系圏の深度も受ける（編集中は z2.5 床）
	cam.pitch = Math.max(0, Math.min(maxPitchCur, v.pitch || 0));   // 共有hashのtiltも派生アプリの上限に従う（geoedit=0）
	cam.bearing = Number.isFinite(v.bearing) ? v.bearing as number : 0;
	cam.roll = Number.isFinite(v.roll) ? v.roll as number : 0;
}
const bootView = parseViewHash(opts.view || pageHash || REGIONS.map(r => r.view).filter(Boolean).pop() || "");   // 裸で開いた時の視点は地域宣言が持つ（/nl/ ＝デルフト上空・日本は既定のまま）
// 前回ビューの復元（ortho-earth 本体と同じ流儀）：settle 毎に localStorage へ保存し、起動時にそこから立ち上がる。
// IDBのPLATEAUキャッシュと合わさると「開いた瞬間に前回の街が数秒で立ち上がる」起動になる。
const PERSIST = opts.persistView !== false && URL_OWN;   // 前回ビュー（localStorage はオリジンで 1 つ）＝URL の持ち主だけ（#173 段 3）
const CAM_KEY = "ortho-japan.cam256";   // 256px世界のz移行(2026-07-26)でキー更新＝旧512世界の保存ビュー（zが1小さい）を読まない
if (bootView) applyCamView(bootView);
else if (PERSIST) try {   // 前回ビューは URL／opts.view が無い時だけ（優先度＝URL ハッシュ > 前回ビュー > 既定）
	const saved = JSON.parse(localStorage.getItem(CAM_KEY) || "null");
	if (saved && Array.isArray(saved.center) && saved.center.every(Number.isFinite) && Number.isFinite(saved.zoom))
		applyCamView({ lon: saved.center[0], lat: saved.center[1], zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing });
} catch { /* 壊れた保存値は無視して既定の世界ビュー */ }
// ── 共通の時計（#42・2026-09-23）＝ephem/clock（solar と同じ部品）。既定＝実時間（Date.now に張り付く）。
// 起動の優先度＝URL の t=/s=（共有リンク）> opts.time（Date｜ISO 文字列｜ms）> 実時間。状態が変わった時だけ worker へ基準を送る（下の sky の後で結線）
const clock: GlobeScope["clock"] = createClock();
const clockParamsOf = (v: { time?: string | null; speed?: number | null }) => { const p = new URLSearchParams(); if (v.time) p.set("t", v.time); if (v.speed != null) p.set("s", String(v.speed)); return p; };
if (opts.time != null) clock.setTime(opts.time instanceof Date ? opts.time.getTime() : typeof opts.time === "string" ? Date.parse(opts.time) : +opts.time);
// ⚠ここに前回ビューの else を繋がない（2026-09-23 #42 で時計の if に繋がり、t= の無い共有 URL が前回ビューに上書きされていた＝9/24 根治）
if (bootView && (bootView.time || bootView.speed != null)) clock.fromParams(clockParamsOf(bootView));
// opts.persistView=false＝前回ビューを読まない・書かない。localStorage はオリジン単位＝同じドメインの別ページ
// （www トップの背景・gishub の待ち受け）で回した視点が /japan/ の「前回の続き」を上書きするのを防ぐ（2026-09-21）
const saveCam = () => { if (!PERSIST) return; try { localStorage.setItem(CAM_KEY, JSON.stringify({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, roll: cam.roll || 0 })); } catch { /* private mode 等 */ } };
// 現在ビュー→ハッシュ（codec は engine）。app 固有の後置トークン＝チップ状態 l=…
// 固定キー(opts.layers)はURLに書かない＝そのURLを本家で開いた人には既定が適用される（埋め込み構成を持ち出さない）。
const viewHash: GlobeScope["viewHash"] = () => {
	const on = FREE_LAYER_KEYS.filter(k => layerState[k]);
	if (sky.constelVisible) on.push(SKY_LAYER);   // 星座ON＝l= に sky を追加（既定OFF＝差分ありで l= を必ず書き出す）
	const changed = sky.constelVisible || FREE_LAYER_KEYS.some(k => layerState[k] !== defaultLayerState[k]);
	const extras = changed ? ["l=" + on.join(".")] : [];
	// 配色テーマ＝c=<name>（既定 mono は書かない＝素の視点はURLも素。固定(opts.theme)も書かない＝埋め込み構成を持ち出さない）
	if (!themeFixed && themeName !== "mono" && MAP_THEMES[themeName]) extras.push("c=" + themeName);
	// 時計＝実時間なら書かない（開いた人の「今」）。止めた・早送り・過去未来＝t=（UTC）と s=（段）＝solar と同じ書式
	if (!clock.isLive()) extras.push("t=" + fmtUTC(clock.time));
	if (clock.step !== 1) extras.push("s=" + clock.step);
	return buildViewHash(cam, extras);
};
const saveView: GlobeScope["saveView"] = () => { saveCam(); if (URL_OWN && (ownMapEl || opts.urlHash)) try { history.replaceState(null, "", viewHash()); } catch { /* file:// 等 */ } };   // 埋め込み（target 指定）ではホストページの URL を書かない（1.0.4〜・opts.urlHash=true で従来どおり）
// 配色テーマの生き替え（reload無し restyle）：基図タイルを新styleで組み直し、静的色・夜家具(ui-dark)・海岸線色・
// N02芯色を差し替える。★URLは書かない＝呼び出し側が「全状態が揃った後」に1回だけ書く（applyView 末尾の saveView／
// palette は switchTheme 後に saveView）＝URL⇄状態の一元化・順序取りこぼしの防止。色は dl.ops に焼き込まれるため基図は
// 再ビルド必須（setPipelineStyle が evict→新styleビルド＝GPU入れ替え＝ピーク約1倍）。一瞬の貼り直しは許容（fade不要）。
function switchTheme(name: string) {
	if (name === themeName || !MAP_THEMES[name]) return;
	queueMicrotask(() => mapEl.querySelectorAll<HTMLElement>("#theme-row .lp-theme").forEach(b => b.classList.toggle("on", b.dataset.theme === themeName)));   // 表示パネルのテーマ列同期（themeName確定後＝microtask）
	themeName = name; theme = MAP_THEMES[name]; style = withBaseOverrides(withUserBg(withPM(theme.style)));   // 基図の層の上書き（段 7）はテーマを越えて残す   // 湖はエンジンの lakes スロット（worldPal.sea 直読）＝style 側の世界層前置は廃止（2026-09-03）
	bg = bgOf(style);
	land = landOf(bg, [0.96, 0.96, 0.95, 1]);
	atmo = atmoOf(theme.atmo); bldColor = theme.bldColor;
	setPipelineStyle(style);   // 基図タイルを全捨て→新styleで再ビルド（生バイトはIDB/HTTP温間キャッシュ命中で速い）
	gint.repaintWorldLines?.();   // 世界線の色も新テーマへ（正本 worldstyle）
	worldContentH?.repaint();     // 世界帯の中身（州境・道路・注記…）も新テーマへ
	// ★任意ノブ(等高線色/遠山/標高段彩)は「新テーマが持たなければ null」で必ず既定へ戻す＝前テーマの居座り防止。
	// 条件付きspreadだと未指定キーが setView のマージで残る＝例: sepia/dark の暖茶hypso が mono/topo へ漏れて「山が茶色」になる。
	renderer.set("view", { clear, land, atmo, bldColor,
		contourColor: theme.contourColor || null,
		distColor: theme.distColor || null,
		hypso: theme.hypso || null,
		// 世界パレット＝オブジェクト丸ごと再送（前テーマのキー居座りなし・レンダラは参照変化で再解決）。
		// clim 再送は無害（両レンダラとも取得済みキャッシュで no-op）。boot（下方の初期 set("view")）と同形
		graticule: WORLD_VT, worldHypsoZ: BASEMAP_MINZOOM,
		worldHypso: WORLD_VT ? { clim: CLIM_URL, ...(theme.worldHypso || {}) } : null });
	inspectReapply();   // 検査表示の間（#174）＝陸の色と世界の帯の退場をテーマの値で上書きしない
	renderer.set("sea", { li: seaLi(style, "water"), li2: seaLi(style, "water-hi"), minzoom: 9 });
	renderer.set("bldFill", { li: bldFillLi(style) });   // 建物塗りの層添字も新styleへ（sea と同じ「li はテーマ依存」の流儀）
	themes = mkThemes(style);   // ★層添字（LI_RAILHI 等）を新テーマの層配列で焼き直す＝hidden(点火ゲート)の添字ズレ根治。
	// 旧＝boot の style で一度だけ生成→テーマごとに層数/順が違い添字が全ズレ＝「チップOFFなのに rail-hi/road-hi/航路が点き、土台の道路網が消える」（本人報告・実機/本番でも再現・両バックエンド共通）
	mapEl.classList.add("ui-dark");   // 白抜き家具＝常時ON（本人裁定2026-08-05）＝テーマ生き替えでも外さない（旧＝land輝度で付け外し）
	gint.admin0Layer?.style(gint.admin0DrawStyle());   // admin0 独立層＝新テーマの coastLine で塗り直し（色の居座り根治）
	if (layerState.rail && railOverlay?.loaded) { railOverlay.loaded = false; railOverlay.load(); }   // N02新幹線の芯(land色)を新テーマで引き直す（データは温間）
	readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; requestDraw(); onMove();   // 下地・主層を強制再結合（次のupdateで新styleビルド→順次merge）
}
// contourColor/distColor/hypso はテーマの任意ノブ（無指定＝renderer 既定：セピア等高線・遠山ブルー・単色陰影）
renderer.set("view", { clear, land, atmo, bldColor, showRail: false, sea: seaOf(bg), ...(opts.fog === false ? { fog: false } : {}),   // opts.fog:false＝霧を焚かない（MapLibre の口の既定）
	...(opts.night === false && { night: false }),   // opts.night＝false：低ズームの夜面を描かない（MapLibre の口・公式例の門 段 2）
	gintSub: !/[?&]nosub=1/.test(location.search),
	dashDz: STYLE_DZ,   // 破線（core S-P1-3）の段＝外来 style の floor(z)（MapLibre の tileZoom）
	gintFarPivot: !/[?&]nofarpivot=1/.test(location.search),   // ?nofarpivot=1＝塗り扇の遠方の要（画面カリング）を切る＝旧挙動との見比べ用   // ?nosub=1＝gint 線の地形適応細分を切る（3D ドレープ貫きの切り分け用・?nofar と同じ逃げ道の作法）
	...(theme.contourColor && { contourColor: theme.contourColor }),
	...(theme.distColor && { distColor: theme.distColor }),
	...(theme.hypso && { hypso: theme.hypso }),
	// 全球ハイプソ（?world=1）＝球/地形シェーダの標高×気候 cross-blend。clim＝気候場テクスチャ
	// （Köppen-Geiger/Beck et al. CC-BY を 720x360 に焼き縮め・public 資産）。theme.worldHypso で色ノブ上書き可。
	// null 明示＝居座り防止の流儀。showRail＝路線（地域の申告 rail・日本＝N02 の新幹線等）の表示。鉄道チップで切替
	graticule: WORLD_VT,   // 10度レチクル（v1 geoGraticule10 の移植・本人指名 2026-09-01）＝シェーダ計算（z帯はレンダラ側）
	worldHypsoZ: BASEMAP_MINZOOM,   // 世界の色（ハイプソ・湖・罫線）が退場するズーム＝地域の基図が入場する所と同値
	worldHypso: WORLD_VT ? { clim: CLIM_URL, ...(theme.worldHypso || {}) } : null });
if (EXT?.ms.light) { mlLight = normLight(EXT.ms.light); sendLight(); }   // 起動の style の根の light（B3）
if (EXT?.ms.sky) { mlSky = normSky(EXT.ms.sky); sendSky(); }   // 起動の style の根の sky（B4）
// 海：水レイヤ(WA)をビュー一律にゲート＝cam.zoom<9 では描かない（＝紙の海・まだら無し）、z9+で一律点火。
const seaLi: GlobeScope["seaLi"] = (st, id) => st.ext ? -1 : st.layers.findIndex(L => L.id === id);   // 外来 style＝地理院の「海は z9 から」「建物の塗りはチルトで伏せる」の門を当てない（層 id が偶然同じでも）
// 地域の基図の自動の建物（style.schema.buildings の押し出し＝推定の高さ）＝層 "building-extrusion"（段 8① の続き・2026-09-27）。
// MapLibre の style の層と同じ口で出し入れだけできる（setLayoutProperty の visibility・removeLayer）＝vector の押し出し（OSM など）へ差し替える時に伏せる。
// 色・filter・出しズームは変えられない（投げる）。描き方は render worker の noBld（?nobld=1 の診断ノブを実行時に）。伏せている間は足元の塗り（building）を
// チルトでも出す（bldFill の門を外す＝押し出しと二重にならない）。テーマを切り替えても残る（render worker の旗と下の bldFillLi）
const AUTO_BLD: GlobeScope["AUTO_BLD"] = "building-extrusion";
let autoBldHidden: GlobeLive["autoBldHidden"] = false, autoBldRemoved: GlobeLive["autoBldRemoved"] = false;   // ?nobld=1（診断ノブ）とは切り離す＝ノブの見え方（足元の塗りの門）は今のまま
const bldFillLi: GlobeScope["bldFillLi"] = st => autoBldHidden ? -1 : seaLi(st, "building");
const autoBldOn: GlobeScope["autoBldOn"] = () => !autoBldRemoved && !mlLayers.has(AUTO_BLD) && !!style?.schema?.buildings;   // 利用者の層に同じ id があればそちらが勝つ
const autoBldLayer: GlobeScope["autoBldLayer"] = () => autoBldOn() ? { id: AUTO_BLD, type: "fill-extrusion", source: baseSidNow(), "source-layer": style.schema!.buildings!.layer, ...(autoBldHidden ? { layout: { visibility: "none" } } : {}), metadata: { "ortho:auto": true, [DZ_KEY]: 0 } } : null;
const setAutoBld: GlobeScope["setAutoBld"] = hidden => { if (autoBldHidden === hidden) return; autoBldHidden = hidden; wPost({ type: "set", cmd: "noBld", data: hidden }); renderer.set("bldFill", { li: bldFillLi(style) }); requestDraw(); };
const autoBldReadOnly: GlobeScope["autoBldReadOnly"] = what => { throw new Error(`${what}: layer "${AUTO_BLD}" is the basemap's automatic 3D buildings — only visibility can be changed (removeLayer hides it)`); };
renderer.set("sea", { li: seaLi(style, "water"), li2: seaLi(style, "water-hi"), minzoom: 9 });   // li2＝水系点火面も同じ海ゲート
renderer.set("bldFill", { li: bldFillLi(style) });   // 建物フットプリント塗り＝3D（チルト）時は伏せる（押し出しと二重表現のため）

// --- gint（知性の層）＝gint/layers.js（単一スロットのユーザー層・多層 addGint・admin0 独立層・bake-ahead・地形ドレープ・fid 塗り・queryAll）。
// ここは配線だけ：定数と道具を渡し、テーマは getter、多層の台帳（extGint / extActive / gintLayerSeq）は onmessage より先に宣言した
// 上のものを束ねて渡す。生成後に定義される関数（flyTo / loadBelowSea / loadLakes）はラップ＝呼ぶ時に解決。外が読み書きしていた
// 状態（hoverTip / extTipOwn / suppressAdmin0 …）は gint.* のアクセサで同名の意味のまま。
let worldContentH: WorldContent | null = null;   // opts.worldContent の手綱（テーマ切替で塗り直す・下の install が入れる）
const gint = createGintLayers({
	gs: () => MAP_GS,   // 地図の global-state（#173 段 3b）
	gpuExpr: !!opts.gpuExpr || /[?&]gintexpr=1/.test(location.search),   // fid 表を GPU で組む（geopbf 改良点 ⑦・opt-in＝WebGPU の層だけ・GL2 や載らない式は CPU の表へ自動で落ちる）
	canvas, mapEl, renderer, wPost, dbgHost, ASSET_BASE, WORLD_VT, LOW_MEM, noGint, ZOOM_MIN, ZOOM_MAX, cam,
	worldContent: !!opts.worldContent,   // 海岸線・国境＝全ズーム＋最初から 10m・河川/海洋境界＝z1.5 から（equal と同じ出し方）
	worldLines: opts.worldLines,   // false＝世界帯の河川・海洋境界線（NE 10m）を読まない／["rivers"|"maritime"]＝その種類だけ（既定＝全部）
	coastline: opts.coastline,   // false＝世界の海岸線（NE admin0 の gint 層・z<9）を持たない（MapLibre の口・公式例の門 段 2）
	worldBandZ: BASEMAP_MINZOOM,   // 湖・海面下の陸が見える帯＝世界ハイプソと同じ所で退場（地域の基図が入場する所）
	get theme() { return theme; },
	get worldStyle() { return WORLD_STYLE_THEMES[themeName] || WORLD_STYLE_THEMES.mono; },   // 世界線（河川・海洋境界線）の色＝ortho-core worldstyle の正本（段階 3）
	layers: { map: extGint, get active() { return extActive; }, set active(v) { extActive = v; }, nextId: () => ++gintLayerSeq },
	smallAreaHover: !!opts.smallAreaHover,
	requestDraw: requestDraw, onMove: () => onMove(), flyTo: (...args: Parameters<GlobeScope["flyTo"]>) => flyTo(...args), loadBelowSea: () => { if (!flying && opts.worldFill !== false) loadBelowSea(); }, loadLakes: () => { if (!flying && opts.worldFill !== false) loadLakes(); },   // 飛行の通過点で重い層を発火させない（着地の onMove で再評価）。worldFill:false＝湖・海面下の陸を読まない（旧＝切る口が無く、世界帯を通るだけで必ず読んでいた・2026-10-19）
	get flying() { return flying; },   // 国境の細密版（10m）も飛行の通過点では読まない
});
ownDestroy.push(() => gint.destroy());   // gint の bake worker
// --- 海面下の陸地（?world=1・全球ハイプソの一部）--------------------------------------------
// bucket の below_sea_land（uploader「below-sea land」ボタンで焼成＝admin0 陸マスク∧GEBCO≤-1m のシードを
// e≤3m の低平地へ成長させたポリゴン）を塗り専用シーンとしてエンジンの wdepr スロットへ。
// 描画順＝globe/地形の後・タイル(湖)の前＝「海→海面下→陸」（2026-09-01 本人設計）：海側の境界だけ焼きが正確
//（admin0 海岸線でクリップ＝描かれる海岸線 gint と自己整合）ならよく、湖側は上に乗る湖の塗りが誤差を隠し、
// 陸側は cover シェーダ（landK=1 強制のハイプソ本体）が外側の陸色と画素単位で一致＝広く荒くてよい。
// 色はエンジンが画素単位で計算（標高ランプ×Köppen cross-blend×hillshade）＝ポルダーは湿潤の緑・
// カッタラ/デスバレーは乾燥帯の砂系に自動で分かれる（「砂漠の中の海面下も同じ緑」への本人疑義の答え）。
let deprState = 0;   // 0=未 1=着手済（bucket 未収録も1＝毎 onMove で再試行しない）
async function loadBelowSea() {
	if (deprState) return; deprState = 1;
	const pbf = await geopbf("below_sea_land", { gint: false }).catch(() => null);   // gint 不要（identify なし・塗りだけ）＝GintBUF 復号を払わない
	if (!pbf?.length) { console.warn("[wdepr] below_sea_land missing in bucket (below-sea-level fill stays off until baked by uploader)"); return; }
	const scene = buildGeoJSONOverlay(pbf.geojson.features, [0, 0], { lines: false, ranges: true });   // 塗り専用＝境界線バッファなし（焼きの90°タイル継ぎ目も塗りだけなら見えない）
	renderer.set("wdepr", scene);
	requestDraw();
	console.log("[wdepr] below_sea_land loaded: %d features", pbf.length);
}
// デバッグ手：任意 FC を wdepr へ直載せ（焼き差し替え前の見た目確認。null で解除）
dbgHost.__terr = () => wPost({ type: "terrStats" });   // 標高アトラスの内部状態を worker から吸い出してコンソールへ（dev診断）
dbgHost.__wdepr = (fc: { features?: OvFeatures } | OvFeatures | null) => { renderer.set("wdepr", fc ? buildGeoJSONOverlay((fc as { features?: OvFeatures }).features || fc as OvFeatures, [0, 0], { lines: false, ranges: true }) : null); requestDraw(); };
dbgHost.__rset = (cmd: string, data?: unknown, prop?: unknown) => { renderer.set(cmd, data, prop); requestDraw(); };   // 検定手：renderer.set を直接（例 "terrLod"＝地形チャンク刈りの A/B・t-terrcull）

// --- 湖（?world=1・Natural Earth lakes）-----------------------------------------------------
// 旧・Protomaps 世界タイルの world-water 層（OSM/ODbL・湖だけ消費）の置き換え（2026-09-03 本人裁定「B案」）：
// NE lakes → buildGeoJSONOverlay（塗り専用）→ エンジンの lakes スロット（wdepr の兄弟＝stencil fan 共用・
// cover は worldPal.sea の平色一枚＝海と同じ顔・テーマ追随はレンダラが毎フレ直読み）。出自も海岸線・国境
//（NE admin0）と揃い、© OpenStreetMap の出典義務が消えた。表示は whK 連動＝z≥6.5 は自動不可視（日本の湖=GSI基図）。
// bucket 未収録の間は NE S3 の生 zip へフォールバック（coast と同じ作法＝geopbf が shp を食い IDB キャッシュ）。
let lakesState = 0;   // 0=未 1=着手済（失敗も1＝毎 onMove で再試行しない）
async function loadLakes() {
	if (lakesState) return; lakesState = 1;
	const RES = LOW_MEM ? "50m" : "10m";   // モバイルは 50m 版＝頂点数一桁小（coast と同じ裁き）
	const NAME = `ne_${RES}_lakes`;
	let pbf = await geopbf(NAME, { gint: false }).catch(() => null);   // gint 不要（identify なし・塗りだけ）
	if (!pbf?.length) {
		console.warn(`[lakes] no geopbf in bucket -> falling back to raw zip (NE S3 -> shp decode)`);
		pbf = await geopbf(`https://naturalearth.s3.amazonaws.com/${RES}_physical/${NAME}.zip`, { name: NAME, gint: false }).catch(e => { console.warn("[lakes] load failed", e); return null; });
	}
	if (!pbf?.length) return;
	renderer.set("lakes", buildGeoJSONOverlay(pbf.geojson.features, [0, 0], { lines: false, ranges: true }));   // ranges＝feature毎レンジ+外接円（球体カリング）
	requestDraw();
	console.log(`[lakes] NE ${RES} lakes loaded: ${pbf.length} features (fill = worldPal sea)`);
	lakesState = 2;   // 2=搭載済（renderer へ送達）＝検証フック用
}
dbgHost.__lakes = () => lakesState;   // 検証フック（t-world）：0=未 1=着手 2=搭載済

// --- 星空劇場＝sky/theater.js（星・惑星・月・星座・黄道/天の赤道・日時計・太陽系圏との交代）。ここは配線だけ。
const sky = createSkyTheater({ mapEl, renderer, dpr, cam, STARSKY_Z, solarOff, now: () => clock.time, stars: opts.stars, sky: opts.sky, get printHold() { return printHold; }, saveView: () => saveView(), requestDraw: requestDraw });
// 時計の状態が変わった（段・日時・今へ戻る・範囲の端で停止・URL の読み込み）＝worker へ基準・空と惑星・URL・map.on("time")
let clockSentAt = 0;
function sendClock() { clockSentAt = performance.now(); wPost({ type: "set", cmd: "clock", data: clock.isLive() ? null : clock.anchor() }); }
clock.on("change", () => {
	sendClock(); sky.timeChanged(); requestDraw();
	if (!printHold) saveView();
	for (const cb of mapOn.time) { try { cb({ time: clock.time, step: clock.step, live: clock.isLive(), ticking: false }); } catch (e) { console.error("[map.on time]", e); } }
});
if (!clock.isLive()) sendClock();   // 起動時に過去/未来の t= か opts.time が来ていた
// --- 路線オーバーレイ＝地域宣言 rail（日本＝packages/jp/src/n02.ts の N02 新幹線・路線＋駅のビーズ・鉄道チップで点灯）。宣言しない地域＝null。land＝紙色はテーマで差し替わる＝getter。
const railOverlay = REGION_RAIL?.({ renderer, get land() { return land; }, BASEMAP_MINZOOM, requestDraw: requestDraw });
// デバッグ用カメラジャンプ：__cam(lon, lat, zoom, pitchDeg, bearingDeg)。検証スクリプトやコンソールから任意視点へ。
dbgHost.__cam = (lon: number, lat: number, zoom = cam.zoom, pitchDeg = cam.pitch * R2D, bearingDeg = cam.bearing * R2D) => {
	cam.center = [lon, lat]; cam.zoom = zoom; cam.pitch = pitchDeg * D2R; cam.bearing = bearingDeg * D2R;
	onMove();
};

// 手打ちデモ：地区名(部分一致)かbase URLを指定して読み込み、カメラもそこへ寄せる（自動と違いカメラを動かす）。省略時は登録簿の先頭。
dbgHost.__mesh = async (nameOrBase?: string, tiles?: string[]) => {
	if (!meshOn) { console.warn(SECOND_LOWMEM && MESH_ASKED == null ? "[mesh] second map on a low-memory device = 3D buildings off by default (opts.mesh:true to enable)" : "[mesh] opts.mesh=false = 3D buildings feature disabled"); return; }
	await meshMgr.ready();   // manager と登録簿が揃うまで待つ（寄る前に呼ばれた時）
	const sets = meshMgr.sets;
	const set = !nameOrBase ? sets[0]
		: sets.find(s => s.base === nameOrBase || s.name === nameOrBase || s.name.includes(nameOrBase));
	if (!set) { console.error("[mesh] ward not found:", nameOrBase, `(catalog ${sets.length} entries)`); return; }
	await meshMgr.standUp(set, tiles);   // 立ち上げ（常駐ヒット＝vis戻し／未常駐＝ロード）。二重ロードは standUp 内の読込中ガードで防ぐ
	const [w, s, e, n] = set.bbox;
	cam.center = [(w + e) / 2, (s + n) / 2]; cam.zoom = 16; cam.pitch = 45 * D2R; cam.bearing = 0;   // 地区中心・傾けて建物を見る
	onMove();
	console.log(`[mesh] done -> ${set.name} z16 tilt45°. right-drag to adjust tilt`);
};

function resize() {
	const w = mapEl.clientWidth, h = mapEl.clientHeight;
	size.w = Math.max(1, Math.round(w * dpr)); size.h = Math.max(1, Math.round(h * dpr));   // 下限 1px（起動時と同じ理由）
	// GL canvas：バッファサイズは worker が持つ（transfer 済）。main は CSS と論理サイズ(size)だけ。
	canvas.style.width = w + "px"; canvas.style.height = h + "px";
	wPost({ type: "resize", width: size.w, height: size.h });
	// label canvas：worker が持つ（transfer 済）＝main は CSS だけ。バッファは resize メッセージで worker が更新。
	labelCanvas.style.width = w + "px"; labelCanvas.style.height = h + "px";
	if (labelGpuCanvas) { labelGpuCanvas.style.width = w + "px"; labelGpuCanvas.style.height = h + "px"; }
	requestDraw();
}
const ro = new ResizeObserver(resize);   // destroy で disconnect するため手綱を持つ
ro.observe(mapEl);   // #map のサイズ変化に追随（ウィンドウでも埋め込み先のレイアウトでも同じ経路）

resize();

// --- 操作：左ドラッグ=パン / 右(or Shift/Ctrl)ドラッグ=チルト+方位 / ホイール=ズーム ---
// --- 入力（パン/チルト/ホイール/アンカー）：実装は engine（input.js＝grab+レート併走・縁縮退対策の結晶）。
// ここは日本アプリ固有の反応だけ注入：クリック→identify（基図overlay＋知性gint）、ホバー→gintの筆識別、
// ジェスチャ開始→フライト中断（主導権は常に人）。z範囲＝1(宇宙の余白)〜19(z20はタイルの切れ目が目立つ)。
let measureClick: GlobeLive["measureClick"] = null;   // 測距モード中だけ非null＝クリックを測距へ奪う（識別・星座トグルより先）
let profileClick: GlobeLive["profileClick"] = null;   // 断面図の経路指定中だけ非null＝同上（ガジェット毎に1スロット＝相互に潰さない）
let poiClick: GlobeLive["poiClick"] = null;       // POI台帳編集のarmed中だけ非null＝同上
// 道具の排他（後から開いた方が勝つ）：計測・断面図・日影・可視域・操作方法カードは同時に一つだけ
// ＝クリックの行き先が常に一意・左下のパネルが重ならない（計測⇄断面図 本人裁定2026-08-27 → 2026-09-24 に仲間を拡張）。
// 配線は登録側＝ここ（ガジェット同士は独立の掟＝相互を知らない）：開いた瞬間に toolOpen(名) → 他の全員の close を呼ぶ。
// close は「開いていなければ何もしない」こと・toolOpen を呼び返さないこと（再入しない）。新しい道具は toolClose へ登録し onOpen を渡す。
// 計測/断面図の本体ハンドルは onBody で到着（スタブ経由の遅延 import 後）＝未ロードの相方は必然的にOFF＝何もしなくてよい。
let measureBody: GlobeLive["measureBody"] = null, profileBody: GlobeLive["profileBody"] = null;
const toolClose: GlobeScope["toolClose"] = new Map();   // 名 → close()
const toolOpen: GlobeScope["toolOpen"] = name => { for (const [k, f] of toolClose) if (k !== name) { try { f(); } catch (e) { console.warn("[tool] close", k, e); } } };
toolClose.set("measure", () => measureBody?.stop?.());
toolClose.set("profile", () => profileBody?.stop?.());
let editClick: ((x: number, y: number) => unknown) | null = null;      // 派生アプリ編集モード（geoedit）中だけ非null＝同上（map.setEditClick で装着/解除）
// zoomMin の二重指定（前:ZOOM_MIN 後:2＝後勝ちで床2）を解消（2026-08-10）＝ホイール/ピンチも太陽系圏へ潜れる
const input: GlobeScope["input"] = createInput({
	wheelZoom: ML_COVER ? "maplibre" : "linear",   // MapLibre の目盛り＝ホイールの 1 目盛りも MapLibre と同じ量（並べて触った時に同じ所へ寄る）
	canvas, cam, size, dpr, maxPitch: maxPitchCur, zoomMin: zoomMinCur, zoomMax: ZOOM_MAX, onMove, signal: ac.signal,   // opts.maxPitch＝派生アプリのチルト上限（0=俯瞰固定＝geoedit）。??＝0を殺さない
	// 手触りの旗（A2・2026-10-12・MapLibre 同名）：opts.handlers={scrollZoom:false,…}・opts.interactive:false＝全部 off・opts.cooperativeGestures・opts.zoomSnap。実行時は map.setHandler
	handlers: opts.handlers || {}, interactive: opts.interactive, cooperativeGestures: opts.cooperativeGestures, zoomSnap: opts.zoomSnap,
	onBoxZoom: (phase, d) => {
		if (phase === "end") { for (const cb of mapOn.boxzoomend) { try { cb({ bbox: d.bbox, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 }); } catch (e) { console.error("[map.on boxzoomend]", e); } } map.fitBounds(d.bbox!, { linear: true, duration: 500 }); }   // MapLibre の BoxZoomHandler＝fitScreenCoordinates(linear)
		else for (const cb of mapOn[phase === "start" ? "boxzoomstart" : "boxzoomcancel"]) { try { cb({}); } catch (e) { console.error("[map.on boxzoom]", e); } }
	},
	onBlocked: kind => { for (const cb of mapOn.cooperativegestureprevented) { try { cb({ kind }); } catch (e) { console.error("[map.on cooperativegestureprevented]", e); } } },
	// モーダル表示中は矢印キーで背後の地図を動かさない（文字入力中は input.js が自前で判定）。
	// opts.keyboard＝false で矢印キーを地図に取らない／関数なら真の間だけ取る（背景に置く埋め込みでページのスクロールや一覧の矢印移動を奪わない・2026-09-21）
	blocked: () => modalOpen(mapEl) || !isKeyOwner(mapEl) || opts.keyboard === false || (typeof opts.keyboard === "function" && !opts.keyboard()),   // !isKeyOwner＝頁の別の地図がキーの持ち主（#173 段 3）
	onGesture: () => { flightCtl.cancel(); if (followSt?.stopOnGesture) followSt = null; },
	onClick: dbgHost.__mapClickAt = (x: number, y: number) => {   // __mapClickAt＝検証窓（画面のクリックと同じ処理を CDP・検定から・#113 段 4）
		if (measureClick) return measureClick(x, y);   // 測距モード＝クリックは頂点追加へ（識別/星座は止める）
		if (profileClick) return profileClick(x, y);   // 断面図モード＝クリックは経路の頂点追加へ（同上）
		if (poiClick) return poiClick(x, y);           // 台帳編集モード＝クリックは対象選択/置き先へ（同上）
		if (editClick) return editClick(x, y);         // 派生アプリ編集モード＝同上（geoedit の選択/作図）
		if (czmlCtl?.clickAt(x, y)) return;            // 時刻再生の点（CZML・GPX・#113）＝名前と説明の吹き出し（地面の識別はしない）
		// 旧・全球ビューの画面クリック＝星座線トグルは表示パネルの「星空」チップへ移設（本人裁定 2026-09-02
		// 「画面クリックの切り替えはいずれ何かとぶつかる」）＝クリックは全ズームで識別に一本化。
		const cut = clipCutXY(x, y);   // 断面で切られた側の地面（#111）＝地面の識別は当てない（gint は描画 worker の拾いが面で切る）
		if (!cut) overlay.identifyAt(x, y); if (gint.interactive || extActive) wPost({ type: "gintClick", x, y });
		if (mapOn.click.length) {   // §4 map.on('click')＝層をまたぐ照会（main 同期 JS レイキャスト・手前の層から）
			const ll = unprojectXY(x, y);
			if (ll) { const hits = cut ? [] : gint.queryAllGint(ll); for (const cb of mapOn.click) cb({ lngLat: ll, hits }); }
		}
	},
	onHover: (x, y) => {
		gint.lastHoverXY = [x, y];
		// smallAreaHover＝census2020限定＝estat中は町丁目を点in面で識別し名前tip＋境界太線（ミスは gint へフォールバック）。
		// デモ（フラグ無し）は従来どおり gint ホバーのみ＝凍結挙動を一切変えない。
		// tip 持参層（筆＝moj/maff）がホバー可で載っている間は gint が主導＝町丁目tip/太線と排他（本人裁定2026-08-18）。
		const fudeOwn = (gint.userGint?.tip && gint.interactive && gint.hover) || !!extActive;   // 追加層がカーソル保持中（§4.1 アクティブ層＝主導権）も gint が主
		if (fudeOwn && gint.extTipOwn) { gint.extTipOwn = false; renderer.set("overlayHover", null); requestDraw(); }   // 跨ぎ瞬間＝残った町丁目tip/太線を掃除（tip本文は直後の識別ackが上書き）
		const cutH = clipCutXY(x, y);   // 断面で切られた側（#111）＝地域パックのホバーと国名 tip を出さない
		if (!fudeOwn && !cutH && !inspectHide && hostHooks.hover.some(h => h(x, y))) return;   // 地域パックのホバー（e-Stat の町丁目 tip＝日本の install が差す）・検査表示の間は出さない（#174）
		if ((gint.interactive && gint.hover) || extActive) wPost({ type: "gintMove", x, y });
		// 世界ビュー＝admin0 国ポリゴンの国名 tip（本人裁定 2026-08-30「国の認識」）。識別は main 同期
		// （admin0Pbf.identifyAt＝findPolygon smallest-wins・エンジン往復なし）。面のみ探索＝点/線半径は0。
		countryTipAt(x, y, cutH, fudeOwn);
	},
});

// 世界ビューの国名 tip（opts.countryTip）。"shift"＝Shift を押している間だけ（地物の tip を持つ頁が国名を出し分ける・/globe/physical・2026-10-01）
let shiftHeld = false;
const countryTipMode = () => opts.countryTip === "shift" ? shiftHeld : opts.countryTip !== false;
function countryTipAt(x: number, y: number, cutH = false, fudeOwn = false) {
	const a0TipOn = countryTipMode()  && gint.admin0Layer && gint.admin0Vis && !gint.internalHidden && cam.zoom < gint.ADMIN0_Z && !(gint.userGint && cam.zoom >= (gint.userGint.minZoom ?? 0));   // opts.countryTip=false＝国名 tip を出さない（自前の tip を持つ器）
	if (a0TipOn && gint.admin0Pbf && gint.hoverTip && !fudeOwn) {
		// z≥5.5＝国名 tip の圏外（本人裁定 2026-09-02）：基図接近帯は注記が主役＝国名の板は出さない
		if (cam.zoom >= gint.WORLD_TIP_MAXZ) { if (gint.worldTipOn) { gint.hoverTip(null); gint.worldTipOn = false; } return; }
		const ll = unprojectXY(x, y);
		const fid = ll && !cutH ? gint.admin0Pbf.identifyAt(ll[0], ll[1], { point: 0, polyline: 0 }) : null;
		let name = null;
		// 国名＝表示言語の列（NE の NAME_JA/NAME_FR/NAME_AR…＝25 言語・th は無し）→ 英語 → NAME。地図の中身だが「国名 tip が日本語のまま」（本人 2026-09-19）＝UI 側の穴
		if (fid != null) { try { const p = gint.admin0Pbf.getProperties(fid) || {}; name = p["NAME_" + getLang().toUpperCase()] || p.NAME_EN || p.NAME || null; } catch (e) { /* 壊れfeature＝tipなし */ } }
		gint.hoverTip(name ? [escHtml(name)] : null);   // 国名はデータ（NE の列）＝tip は HTML で入る＝逃がす
		gint.worldTipOn = !!name;
	}
}
if (opts.countryTip === "shift") {
	const setShift = (on: boolean) => {
		if (on === shiftHeld) return; shiftHeld = on;
		if (!on) { if (gint.worldTipOn) { gint.hoverTip?.(null); gint.worldTipOn = false; } return; }
		const xy = gint.lastHoverXY; if (xy) countryTipAt(xy[0], xy[1], clipCutXY(xy[0], xy[1]));   // 止まったまま Shift を押しても出る
	};
	window.addEventListener("keydown", e => { if (e.key === "Shift") setShift(true); }, { signal: ac.signal });
	window.addEventListener("keyup", e => { if (e.key === "Shift") setShift(false); }, { signal: ac.signal });
	window.addEventListener("blur", () => setShift(false), { signal: ac.signal });
}
// アイドル退場：マウスを止めると左上/右上のアイコンが静かに消え、動かす（or キー操作）と戻る。
// タッチ端末は対象外（指では常時見えていてほしい＝端末標準の消え方に委ねない）。
// 触れている間（#gadgets/#chips 上）と検索を開いている間は消さない＝操作中に足元が消える事故を防ぐ。
if (!window.matchMedia("(pointer: coarse)").matches) {
	const IDLE_MS = 2500;
	let idleT = 0;
	const overUI = () => { const h = mapEl.querySelector(":hover"); return !!(h && (h.closest("#gadgets") || h.closest("#chips"))); };
	const searchOpen = () => !!mapEl.querySelector("#search.open");
	const panelOpen = () => { const p = mapEl.querySelector<HTMLElement>("#layers-panel"); return !!(p && !p.hidden); };   // 表示パネル展開中＝選んでいる最中に足元が消えない
	const hideUI = () => { if (overUI() || searchOpen() || panelOpen()) { idleT = setTimeout(hideUI, IDLE_MS); return; } mapEl.classList.add("ui-idle"); };   // 操作中は消さず再武装
	const wakeUI = () => { mapEl.classList.remove("ui-idle"); clearTimeout(idleT); idleT = setTimeout(hideUI, IDLE_MS); };
	mapEl.addEventListener("mousemove", wakeUI, { signal: ac.signal, passive: true });
	mapEl.addEventListener("pointerdown", wakeUI, { signal: ac.signal, passive: true });
	mapEl.addEventListener("wheel", wakeUI, { signal: ac.signal, passive: true });   // ホイールズームも「操作」＝ズーム中に退場しない（トラックパッド2本指も wheel）
	window.addEventListener("keydown", wakeUI, { signal: ac.signal });
	idleT = setTimeout(hideUI, IDLE_MS);   // 起動後に無操作なら退場（動かせば戻る）
}
const evXY: GlobeScope["evXY"] = input.evXY;   // 座標読み取り（計器）も同じローカル変換を使う

// --- 座標読み取り（左下）：2段テーブル＝上段ラベル「経度・緯度・標高・z値・傾度」/下段数値（attr右下の複数段と対に）。
// zoom はここ（z値列）が持つ＝スケールバーは距離のみ。表示更新は rAF に畳む＝hot path を汚さない。
// 標高は altpbf の getHeight（ortho-earth 本体と同じ点サンプラ）＝必要タイルをその場でオンデマンド取得
// （R90/R10/R01 をズームで自動選択・IDB は地形アトラスと共有）。render worker のアトラス照会だと
// 未ロード地帯が0mになる劣化版だった。onend＝タイル到着でゲートを開けて再照会（マウス静止中でも値が確定）。
const posEl = orDetached(mapEl.querySelector("#pos"));
const hasPos = posEl.isConnected;   // 座標表示なし（instrumentsで"pos"非搭載）＝標高照会も止める（見えない計器のためのfetchをしない）
// 狭画面＝座標テーブルなし（境界はCSSの掟と同値）。回転や窓リサイズで跨ぐため毎回評価＝posOn が表示と標高fetchの両方を裁く。
const narrowMq: GlobeScope["narrowMq"] = window.matchMedia("(max-width: 480px)");
const posOn = () => hasPos && !narrowMq.matches;
posEl.innerHTML = `<table><thead><tr><th>${t("Lon")}</th><th>${t("Lat")}</th><th>${t("Elev")}</th><th>${t("z")}</th><th>${t("Rot")}</th><th>${t("Tilt")}</th></tr></thead><tbody><tr><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>`;
const posCells = [...posEl.querySelectorAll("td")];   // [経度, 緯度, 標高, z値, 回転, 傾度]（毎フレームはtextContent更新のみ＝DOM再構築しない）
let posMouse: { x: number; y: number } | null = null, posElev: number | null = null, posElevId = 0, posElevAt = 0, posRaf = false, getHeight: Awaited<GlobeScope["getHeightP"]> | null = null;
setAltApiUrl("https://api.ortho-earth.com");
// 標高ローダは作った時点で AW3D30 の一覧（index_alos）などを取りに行く。terrain:false（noTerr）の地図は「setTerrain まで平ら・既定の標高を取らない」約束
// ＝起動では作らず、標高を初めて問われた時（map.getHeight・断面図・setTerrain 後の照会）に作る（旧＝常に起動で作り、地形を切った地図でも一覧を読んでいた・2026-10-19）
let heightLoader: ReturnType<typeof createGetHeight> | null = null;
const ensureHeightLoader = () => heightLoader ??= (() => {
	const p = createGetHeight({ apiUrl: "https://api.ortho-earth.com", dtm: REGION_DTM, onend: () => { posElevAt = 0; schedulePos(); updateUnderground(true); } });   // タイル到着＝地中判定も取り直す（静止中に届いた分）
	p.then(f => { getHeight = f; updateUnderground(true); });   // ローダ準備完了＝最初のサンプル（共有URLで地中に着地した起動を拾う）
	return p;
})();
// 遅延の引き口＝then／catch／finally で初めてローダを作る（Promise の形のまま＝呼ぶ側は今まで通り）。到着を待って照会（起動直後でも0mに化けない）
const getHeightP = {
	then: (ok, ng) => ensureHeightLoader().then(ok, ng),
	catch: ng => ensureHeightLoader().catch(ng),
	finally: f => ensureHeightLoader().finally(f),
	[Symbol.toStringTag]: "Promise",
} as GlobeScope["getHeightP"];
if (!noTerr) ensureHeightLoader();
ownDestroy.push(() => heightLoader?.then(f => f.terminate?.()));
// 距離スケール（真俯瞰=2Dのみ）：ortho-map Accessories draw_scale() と同じ1-2-5系列。
// d256m＝256px当たりの実距離[m]。当アプリも256px世界(2026-07-26統一)＝本家と同じ zoom がそのまま使える。
// px↔角度 は正射図法ゆえ緯度非依存のまま。m換算だけ WGS84 の東西曲率半径 N(φ)（バーは横置き＝東西）で
// 緯度依存に（2026-08-11・段階A）：旧・固定 6372000 は N(35°)=6385.2km 比 -0.2%、高緯度ほどずれた。
// 南北は M(φ)＝N と最大0.5%違うが、バー1本に2値は出せない＝横置きの素直（正確な計測は M ガジェットの Vincenty）。
const scaleEl = orDetached(mapEl.querySelector("#scale")), scaleTxt = orDetached(mapEl.querySelector("#scale-txt")), scaleBar = orDetached(mapEl.querySelector("#scale-bar"));
const comma = (s: string | number) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function updateScale() {
	if ((cam.pitch || 0) > 0.005) { scaleEl.style.display = "none"; return; }
	const d256m = 2 * primeVerticalRadius(cam.center[1]) * Math.PI / Math.pow(2, cam.zoom);
	const r = Math.pow(10, Math.floor(Math.log10(d256m)));
	const vm = (d256m / r) > 5 ? 5 : (d256m / r) > 2 ? 2 : 1;
	const val = vm * r;
	const [n, v, unit] = val >= 1000 ? [256 * val / d256m, val / 1000, "km"] : [256 * val / d256m, val, "m"];
	const decimal = (v < 10 && unit === "km") ? 1 : 0;
	scaleBar.style.width = n.toFixed(1) + "px";
	scaleTxt.textContent = `${comma(v.toFixed(decimal))}${unit}`;   // z値は左下テーブルへ移設＝スケールは距離だけの静かな物差し
	scaleEl.style.display = "block";
}
function updatePos() {
	posRaf = false;
	updateScale();   // スケールはマウス位置と無関係にカメラへ追随（同じrAF窓に相乗り）
	if (!posMouse) return;
	const st = cameraState(cam, size.w, size.h);
	const ll = unproject(st, posMouse.x * dpr, posMouse.y * dpr);
	posCells[3].textContent = cam.zoom.toFixed(2);
	posCells[4].textContent = `${Math.round(shortBearing() * R2D)}°`;   // 回転＝最短角へ正規化(-180..180]＝コンパスと同じ読み
	posCells[5].textContent = `${Math.round((cam.pitch || 0) * R2D)}°`;
	if (!ll) { posCells[0].textContent = posCells[1].textContent = posCells[2].textContent = "—"; posElev = null; return; }   // 球外＝宇宙
	posCells[0].textContent = ll[0].toFixed(5);
	posCells[1].textContent = ll[1].toFixed(5);
	posCells[2].textContent = posElev == null ? "—" : `${Math.round(posElev)}m`;
	if (posOn() && getHeight && performance.now() - posElevAt > 150) {
		posElevAt = performance.now();
		const id = ++posElevId;
		getHeight(ll[0], ll[1], cam.zoom).then(h => {   // 値が変わった時だけ再描画＝静止中の照会ループを断つ
			if (id === posElevId && h != null && h !== posElev) { posElev = h; schedulePos(); }
		});
	}
}
const schedulePos = () => { if (!posRaf) { posRaf = true; requestAnimationFrame(updatePos); } };
canvas.addEventListener("pointermove", e => { const [x, y] = evXY(e); posMouse = { x, y }; if (posOn()) { posEl.style.display = "block"; posEl.style.visibility = ""; } else posEl.style.display = "none"; schedulePos(); });
// 地図の外へ出た＝見えなくするだけで場所は残す（visibility）。display:none だと左下ドックが詰まり、#pos の上に積まれた
// バナー/凡例のボタンへ向かった瞬間にボタンが下へ逃げる→ポインタが地図へ戻る→#pos 復活→ボタンが上へ、の追いかけっこで押せない
//（geoedit の復元バナーで実測 2026-09-24）。一度も出ていない間（初回ホバー前）と狭画面は従来どおり display:none。
canvas.addEventListener("pointerleave", () => { posMouse = null; if (posEl.style.display === "block" && posOn()) posEl.style.visibility = "hidden"; else posEl.style.display = "none"; });
schedulePos();   // 起動直後からスケールを出す（真俯瞰復元時。マウス無しでも updateScale は走る）

// --- 球面フライト：実装は engine（flight.js＝三段振り付け＋van Wijk厳密解）。ここは配線だけ。
// onFlying＝autoMesh のゲート（飛行中はPLATEAU完全停止・着地の瞬間に解禁＝立ち上がりが着陸の演出）。
// 時計の口（C10・2026-10-12）＝map.setNow(ms) が動きの時計（飛行・paint の transition・共通の時計の刻み）を止める／進める＝決定論の撮影（同じ setNow の列は同じ絵）。restoreNow で実時間へ
let nowPin: number | null = null; const animNow: GlobeScope["animNow"] = () => nowPin ?? performance.now();
// 動きを減らす（C10・MapLibre の prefers-reduced-motion と同じ意味）＝easeTo／flyTo／fitBounds は essential:true でなければ jumpTo。opts.reduceMotion（true／false・無指定＝OS の設定を追う）
const reduceMq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
let reduceMotionOpt = typeof opts.reduceMotion === "boolean" ? opts.reduceMotion : null;
const reduceMotionOn: GlobeScope["reduceMotionOn"] = () => reduceMotionOpt ?? !!reduceMq?.matches;
const flightCtl: GlobeScope["flightCtl"] = createFlight({ now: animNow, stepMax: () => nowPin != null ? Infinity : 35, cam, viewW: () => size.w, maxPitch: maxPitchCur, minZoom: zoomMinCur, onMove, onFlying: f => {   // 飛行床＝カメラ実床（太陽系圏へ台本から飛べる・?nosolar時は1）
	flying = f;
	if (f) input.stop();   // 飛行が始まったら慣性・ズームの滑りは止める（A2）
	if (!f && gint.suppressAdmin0) { gint.suppressAdmin0 = false; gint.updateGintSlot(); }   // 着地＝抑制解除→再評価（着地が低ズームなら海岸線が戻る）
} });
// flyTo をラップ：両端が z≥ADMIN0_Z（coast 表示条件外）なら飛行中の海岸線を抑制＝弧の中間の低ズームで
// loadAdmin0 を誘発しない（描画も出さない）。片方でも coast 条件内なら従来どおり（端の海岸線をポップさせない）。
const flyTo: GlobeScope["flyTo"] = (lon, lat, zoom, tiltDeg, bearingDeg) => {
	if (reduceMotionOn()) { map.jumpTo({ center: [lon, lat], zoom, pitch: tiltDeg as number | undefined, bearing: bearingDeg as number | undefined }); return Promise.resolve(); }   // 動きを減らす（C10）＝即座に
	gint.suppressAdmin0 = cam.zoom >= gint.ADMIN0_Z && zoom >= gint.ADMIN0_Z;
	if (gint.suppressAdmin0) gint.updateGintSlot();   // 既に coast がスロットに載っていれば離陸前に降ろす
	return flightCtl.flyTo(lon, lat, zoom, tiltDeg, bearingDeg);
};
// 同一フレームのオーバーレイの実画素（検定用・t-linedeco）＝{ type:"probe" } に { type:"pixels", w, h, data } で答えるモジュール（pattern-2d・imagequad-draw・anno-draw）
dbgHost.__ovPixels = (name: string) => new Promise(res => {
	const h = overlays.get(name); if (!h) return res(null);
	const id = "px" + Math.random(), prev = h.onmessage, tm = setTimeout(() => { h.onmessage = prev; res(null); }, 5000);
	h.onmessage = d => { if ((d as { type?: string } | null)?.type === "pixels" && (d as { id?: string }).id === id) { clearTimeout(tm); h.onmessage = prev; res(d); } else prev?.(d); };
	h.post({ type: "probe", id });
});
dbgHost.__fly = flyTo;   // デバッグ/検証用（__cam の飛行版）

// テーマ・チップ状態：静かな白黒の土台は常に全部見えている。チップは主題の「文字の表示」
// または「色の点火」を切り替えるだけ。すべて既取得データの再スタイル＝再取得・再デコードなし。
//   place/terrain … 文字（注記カテゴリ）の表示ON/OFF
//   rail/road … 色の点火ON/OFF（OFFでも土台グレーは出ている）
const layerState: LayerState = { ...defaultLayerState };   // UIトグル状態は main が保持・変更（チップで反転）
// 共有URLのレイヤ集合は「客が触れるキー」だけ上書き（旧romajiトークンは normLayerKey で読み替え）。
if (bootView?.layers) { const urlSet = new Set(bootView.layers.map(normLayerKey)); for (const k of FREE_LAYER_KEYS) layerState[k] = urlSet.has(k); }
if (bootView?.layers?.includes(SKY_LAYER)) sky.applyConstellations(true);   // l=sky＝星座線ONで起動（z<4で実描画）
if (bootView?.contour && !("terrain" in fixedLayers)) layerState.terrain = true;   // 旧URLの c（等高線トグル時代）＝地形チップに読み替え（後方互換）
Object.assign(layerState, fixedLayers);   // 固定は最後＝共有URLでも破れない（埋め込み主の意図が勝つ）
let styleSig = JSON.stringify(layerState);
let lastTileOrder: GlobeLive["lastTileOrder"] = [];   // 直近フレームで描いた基図タイル [{ key:"z/x/y", z }]（map.queryRenderedFeatures）
// 結合で外す層の添字＝テーマの点火ゲート（チップ）∪ 基図の層の出し入れ（段 7・baseVis）
const baseHiddenIdx = () => { const h = new Set<number>(); if (inspectHide) style.layers.forEach((L, i) => h.add(i)); else if (baseVis.size) style.layers.forEach((L, i) => { if (baseVis.get(L.id) === "none") h.add(i); }); return h; };
const hiddenAll: GlobeScope["hiddenAll"] = () => { const h = themes.hiddenLi(layerState, cam.zoom); for (const i of baseHiddenIdx()) h.add(i); return h; };
const mkThemes: GlobeScope["mkThemes"] = st => { const th = createThemes(st, { suppressAdmin: !!opts.hideAdminBoundary }); if (st.ext) { th.hiddenLi = () => new Set(); th.filterLabels = all => all; } return th; };   // 外来 style＝チップの点火ゲートと注記の分類（地理院の層 id・注記コード）を当てない＝style が描くと言った物を全部
let themes: GlobeLive["themes"] = mkThemes(style);   // 分類（allowlist）は themes.js の純関数。
dbgHost.__hiddenLi = () => [...themes.hiddenLi(layerState, cam.zoom)];   // 点火ゲートの検定窓（t-palette-live＝添字ズレの回帰封じ）hideAdminBoundary＝基図の行政界(赤線)を常に隠す（派生アプリが自前境界を描く時）。⚠層添字（LI_*）は style 依存＝テーマ生き替え(switchTheme)で必ず作り直す（旧添字の hidden が「土台を隠し点火層を出す」実バグ 2026-09-09）

// LOD選択 or テーマ状態(styleSig)が変わった時だけシーンを再結合。原点は安定化（プルプル防止）。
// readySig/baseSig は merge の ack（onMerged）で確定。要求中の sig は mergeReq が持ち、
// MERGE_ACK_MS 以内は同一要求を重ねない。ack が来なければ出し直す＝merge の一過性失敗が自己修復する。
const MERGE_ACK_MS = 1500;
const mergeLog: Array<{ sig: string; n: number; reqAt: number; ackAt: number }> = []; dbgHost.__mergeLog = mergeLog;   // main merge の要求→着地の時刻（切り分け・直近 64 件）
const mergeReq: GlobeScope["mergeReq"] = { main: { sig: "", at: 0 }, base: { sig: "", at: 0 } };
function requestWithAck(slot: "main" | "base", sig: string, doRequest: () => void) {
	const rq = mergeReq[slot];
	if (sig === rq.sig && performance.now() - rq.at < MERGE_ACK_MS) return false;   // 同一要求の ack 待ち
	doRequest();
	if (slot === "main") { mergeLog.push({ sig: sig.slice(0, 40), n: sig.split("#")[0].split("|").length, reqAt: Math.round(performance.now()), ackAt: 0 }); if (mergeLog.length > 64) mergeLog.shift(); }   // 計測（要求→着地）
	rq.sig = sig; rq.at = performance.now();
	setTimeout(() => {   // ack 喪失→要求記憶を消して次フレームで出し直させる（静止中でも needsDraw で起こす）
		const confirmed = slot === "main" ? readySig : baseSig;
		if (rq.sig === sig && confirmed !== sig) { rq.sig = ""; requestDraw(); }
	}, MERGE_ACK_MS + 100);
	return true;
}
// 政令指定都市（全20市・静的台帳）：区名が見えるズームでは市名を「背景ラベル」へ＝主役を区名に譲る。
const SEIREI = new Set(["札幌市", "仙台市", "さいたま市", "千葉市", "横浜市", "川崎市", "相模原市", "新潟市", "静岡市", "浜松市",
	"名古屋市", "京都市", "大阪市", "堺市", "神戸市", "岡山市", "広島市", "北九州市", "福岡市", "熊本市"]);
let zoomAtBuild = -1, lastMainReqT = 0;   // lastMainReqT＝main merge 要求の合流用（タイル流入中の細切れ merge を間引く）
// 移動中の詳細再結合の最小間隔（≈8Hz）：パン中は選定が毎フレーム揺れて sig が変わり、フルシーン結合＋
// GPU全アップロードを毎秒~25回やり直していた（チルト75°・z8.46実測）。8Hzでも下地(base)が隙間を敷くので
// 見た目の追従は落ちない。静止時は無条件（settle の鮮度確定を遅らせない）＝間引くのは移動中だけ。
let lastMoveSwapT = 0;
// V-Ph4 結合頻度（vt perf plan §6・描画の統合ロードマップの 16・2026-10-22）：md（タイルの GPU 常駐・multi_draw）では「新しいタイルが 1 枚増えた」＝up 1 件＋draw list の差し替え
// ＝classic の全枚 merge と違って軽い＝移動中の要求の間引きを 1 フレーム（16ms）まで詰める＝届いたタイルが次のフレームで載る（MapLibre と同じ「届いた順に描く」）。
// classic（?nomd=1・LOW_MEM の既定）は従来の 125／60／60 のまま。?mdgap=N＝md の 3 つの間隔を N ms に（A/B の逃げ道＝?mdgap=60 で旧のズーム・要求の間隔、?mdgap=0 で間引き無し）。
// 追い越しは scene worker の dl の FIFO（dlApplied）が防ぐ＝sig が同じなら要求しない（swapScene）のも従来どおり。効きの物差し＝Mac の bench-perf（計器 e の move 中央値と hitch）。
const MD_GAP_MS = noMultiDraw ? null : qNum(/[?&]mdgap=(\d+)/, 16);
const MOVE_SWAP_MS = MD_GAP_MS ?? 125, MOVE_SWAP_ZOOM_MS = MD_GAP_MS ?? 60, MAIN_REQ_GAP_MS = MD_GAP_MS ?? 60;   // MAIN_REQ_GAP_MS＝新 sig の merge 要求の最短間隔（旧 200＝届いたタイルが画面に出るまでの主因・merge 自体は数 ms・sig が同じなら要求しない）2026-09-30   // MOVE_SWAP_ZOOM_MS＝ズーム中（zoomStable でない間）の merge 要求の間隔＝新しい段のタイルは届き次第（止まるまで待たない・LOW_MEM は従来どおり止まってから）2026-09-30
// ラベルはGLシーンと別経路（render worker のテキスト描画）＝丁目(z15.5)/空港マーク(z13)のz門で GL バッファを
// 全再結合する理由は無い（本人指摘 2026-08-04「テキストにmergeは要らない」）。両者を merge シグネチャから外し、
// ラベルだけ独立に更新＝ズームアウトで z15.5/z13 を跨いでも基図の書き直しゼロ。駅軌道(z14.5)は本物のGL層
//（hiddenLi）なので merge 側に残す（railチップON時のみ効く）。
let lastLabelGate = "";
const labelGate = () => "" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= CHOME800_MINZOOM ? 1 : 0)
	+ (cam.zoom < AIRPORT_MARK_MAXZ && cam.zoom >= BASEMAP_MINZOOM && airportMarks.length ? "A" : "")
	+ (landmarks && layerState.facility ? "L" + landmarkMinH(cam.zoom) : "")   // 高さ梯子の段を跨いだらラベルだけ作り直す
	+ (poi && layerState.facility && cam.zoom >= 14 ? "P" + poi.ver + "z" + Math.floor(cam.zoom * 2) : "")   // POI台帳＝タイル到着(poiVer)・半ズーム(rank解禁)で作り直す
	+ "Z" + Math.floor(cam.zoom);   // 整数の z を跨いだら作り直す＝rebuildLabels が層の出しズーム（minZ/maxZ）で外した注記を、次の整数 z で拾い直す（2026-09-28）
// ?swaplog=1＝「書き直し」イベントの計器：main merge（タイル集合の増減つき）・ラベル再構築・base差し替えを
// 時刻つきで出す。ズームアウトのポップがどのイベントと同時刻かで犯人を特定する切り分け用。
const swapLog = /[?&]swaplog=1/.test(location.search);
const slog = (...a: unknown[]) => swapLog && console.log(`[swap ${(performance.now() / 1000).toFixed(2)}s z${cam.zoom.toFixed(2)}]`, ...a);
function swapScene(order: TileOrder) {
	lastCoverOrder = order;   // debug の表示（showTileBoundaries・B6）が読む今の基図のタイル集合
	const sig = order.map(o => o.key).join("|") + "#" + styleSig + "#z" + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0);
	mainDesired = sig;
	// 望みのシーンが既に載っている＝この zoom の現行として扱う（zoomAtBuild を追認しないと、微ズーム往復で
	// sig 不変のまま zoomStable が偽に固定され、base が静止中も退場できなくなる）。ラベル門だけ跨いだ時は
	// ラベルのみ作り直す（merge なし）。
	if (sig === readySig) { zoomAtBuild = cam.zoom; if (labelGate() !== lastLabelGate) rebuildLabels(order); return; }
	if (!order.length) return;
	if (!sceneOrigin || Math.abs(sceneOrigin[0] - cam.center[0]) > 0.4 || Math.abs(sceneOrigin[1] - cam.center[1]) > 0.4)
		sceneOrigin = [cam.center[0], cam.center[1]];
	// merge 合流：新 sig の要求は最短200ms間隔（タイル流入中の細切れ merge 連発＝classic のパラパラ感の素）。
	// needsDraw 維持で次フレーム再試行＝取りこぼしなし。同一 sig の ack 待ちは requestWithAck が従来どおり看る。
	if (performance.now() - lastMainReqT < MAIN_REQ_GAP_MS) { requestDraw(); return; }
	if (!requestWithAck("main", sig, () => {
		lastMainReqT = performance.now();
		mergePendingZoom.set(sig, cam.zoom);   // ackが来たらこのzoomのシーンが乗る（ズームアウト退場判定の基準）
		if (mergePendingZoom.size > 32) mergePendingZoom.clear();   // ack喪失の残骸が溜まらないよう頭打ち
		{   // 計器 f（vt perf plan §2）＝集合の増減＝この merge が「何を書き直すか」。classic は変わった枚数に関わらず全枚を結合し直す＝P2 が消す仕事の量
			const prev = readyKeys ?? new Set<string>();
			let add = 0; for (const o of order) if (!prev.has(o.key)) add++;
			const cur = new Set(order.map(o => o.key)); let del = 0; for (const k of prev) if (!cur.has(k)) del++;
			vtPush(vtMerge, { at: performance.now(), add, del, n: order.length });
			if (swapLog) { const zHist: Record<number, number> = {}; for (const o of order) zHist[o.z] = (zHist[o.z] || 0) + 1; slog(`main merge request: +${add} -${del} / ${cur.size} tiles`, "z dist", zHist); }   // z の分布も出す（keepFine 深さ切れの検出）
		}
		requestMerge("main", order, sceneOrigin, hiddenAll(), sig);
	})) return;   // 結合は scene worker（非同期）→ render worker へ直行
	rebuildLabels(order);
	zoomAtBuild = cam.zoom;   // readySig は ack（onMerged）で確定
}
// 町丁名の二系統を畳む＝Anno の 210「下落合（三）」と 800「下落合三丁目」は同じ町丁の別表記。
// 表記は（N）へ統一し（本人指定 2026-08-05「札幌が丁目で長いので（N）で統一・重複は出さない」）、
// 210 と重なる 800 は捨てる。残った 800 は code を 210 に化かす＝以降の全経路（allowlist・色・サイズ・
// 衝突優先度・labelGate）が既存の丁目と同じ扱いになる＝分岐を増やさない。
// 実測（z16・市中心5km四方）：重複除去が効くのは東京(566中274=48%)・高知(205中157=77%)で、
// 札幌(1330中37)・京都(2081中4)は 210 側がほぼ空＝800 が本体なので減らない。密度は丁目の低い
// symbol-sort-key と labels2d の衝突間引きに任せ、足りなければ CHOME800_MINZOOM を上げる。
// 実体＝src/chome.ts の mergeChome（実タイルの検査 tests/t-chome.mjs が同じ物を読む）
// 作り直すたびに同じ中身の物を新しく作らない＝worker へ送るのは初めての物だけ（labelsync）。インクが変わった（テーマ）時だけ作り直す
const landmarkLabels = new WeakMap<object, { color: readonly number[]; halo: readonly number[]; haloW: number; L: HostLabel }>();
const landmarkLabel = (m: { text: string; anchor: [number, number] }, color: readonly number[], halo: readonly number[], haloW: number) => { let e = landmarkLabels.get(m); if (!e || e.color !== color || e.halo !== halo || e.haloW !== haloW) landmarkLabels.set(m, e = { color, halo, haloW, L: { text: m.text, code: LANDMARK_CODE, anchor: m.anchor, size: 15, sort: 3, color, halo, haloW } }); return e.L; };   // size 15＝施設の再スタイル(×0.9)を通ると13.5＝並の施設注記(12.2)より一回り大きい。sort 3＝施設の中では優先して残る
let facInkMemo: { lp: object; ink: { color: readonly number[]; halo: readonly number[]; haloW: number } } | null = null;
const restyled = new WeakMap<HostLabel, { gen: string; out: HostLabel }>();   // 元の注記 → { gen, out }＝再スタイルの写し（入力が同じなら同じ物）
function restyle(L: HostLabel, kuVisible: boolean): HostLabel {
	// 都道府県は大きく薄い背景ラベルに（コピーしてキャッシュ側を壊さない）。他はそのまま。
	if (L.code === 140) return { ...L, size: L.size * 1.25, color: [L.color[0], L.color[1], L.color[2], L.color[3] * 0.5] };
	// 郡名は同サイズのままやや薄く＝行政の骨格であって主役ではない。
	if (L.code === 130) return { ...L, color: [L.color[0], L.color[1], L.color[2], L.color[3] * 0.65] };
	// 区名が表示されるズームでは、政令指定都市名は大きく薄い背景ラベルに（都道府県と同じ作法＝主役は区名）。
	if (kuVisible && SEIREI.has(L.text)) return { ...L, size: L.size * 1.2, color: [L.color[0], L.color[1], L.color[2], L.color[3] * 0.5] };
	// 測量点(7102三角点/7201・7221標高点)は shieldFor が記号＋標高値を描く。flat=真俯瞰の作法＝傾けたら等高線と一緒に消す。
	if (L.code === 7102 || L.code === 7201 || L.code === 7221) return { ...L, flat: true };
	// 施設は濃い紫＝チップと同色（--qm-accent-facility #6a3d9a。点火の掟：チップ色＝地図上の色）。名前は一回り小さく＝地名の脇役。
	// 色はテーマ台帳のノブ（夜は同色相のまま明度を持ち上げた別値＝palettes.js）
	// 施設は「小さい方」に統一：基図の並施設はスタイル既定(13.5)を丁目(12)へ頭打ち＝重要でない施設が大きく出る問題を消す
	// （本人指摘 2026-08-08）。ただし 9xxx 合成コード（landmark/POI＝超高層の名前・意図的に大きい）は据え置く。
	if (layerState.facility && isFacility(L)) return { ...L, size: (L.code >= 9000 ? L.size : Math.min(L.size, 12)) * 0.9, color: [...theme.facilityRGB, L.color[3]] };
	// 地形名（3xx帯）は濃い茶＝チップと同色（--qm-accent-terrain #754c24＝等高線の茶の同族）
	if (layerState.terrain && isTerrain(L.code)) return { ...L, color: [...theme.terrainRGB, L.color[3]] };
	return L;
	}
const labelSender = createLabelSender<HostLabel>();
function rebuildLabels(order: TileOrder) {
	lastLabelGate = labelGate();
	slog("labels rebuilt (no merge)");
	const allLabels: HostLabel[] = tiles.labels(order);
	if (airportMarks.length && cam.zoom < AIRPORT_MARK_MAXZ && cam.zoom >= BASEMAP_MINZOOM) {   // 低ズーム＝静的台帳から空港マークのみ注入（タイル注記441と同名は二重にしない）。下限＝基図の門（world帯(z<6.5)に日本固有の✈を漏らさない）
		const have = new Set(allLabels.filter(L => L.code === 441).map(L => L.text));
		for (const a of airportMarks) if (!have.has(a.text)) allLabels.push(a);
	}
	// 施設名札（landmark/POI 共通）のインク＝現テーマの注記層から一度だけ取る＝テーマ生き替え(switchTheme)に
	// そのまま追随する（読み込み時に焼くと夜テーマで紙色のハローが残る）。
	const facInk = () => {
		const lp = style.layers.find(l => l.id === "label")?.paint || {};
		if (facInkMemo && facInkMemo.lp === lp) return facInkMemo.ink;   // 同じ paint なら同じ配列（landmark/POI の名札を作り直さない）
		const ink = { color: parseRGBA(lp["text-color"] ?? "#333") || [0.2, 0.2, 0.2, 1],
			halo: parseRGBA(lp["text-halo-color"] ?? "#fff") || [1, 1, 1, 1], haloW: +(lp["text-halo-width"] ?? 1.1) };
		facInkMemo = { lp, ink };
		return ink;
	};
	// PLATEAU ランドマーク（施設チップON時のみ・高さの梯子で段階表示）
	if (landmarks && layerState.facility) {
		const minH = landmarkMinH(cam.zoom);
		if (minH < Infinity) {
			const { color, halo, haloW } = facInk();
			const have = new Set(allLabels.map(L => L.text));   // タイル注記に同名があれば出さない（焼いた時の d2 除外に対する実行時の保険）
			for (const m of landmarks) {
				if (m.h < minH || have.has(m.text)) continue;
				// size 15＝施設の再スタイル(×0.9)を通ると13.5＝並の施設注記(12.2)より一回り大きい。sort 3＝施設の中では優先して残る
				allLabels.push(landmarkLabel(m, color, halo, haloW));
			}
		}
	}
	// POI台帳（施設チップON・z14+）：rank 解禁・案A dedup・権威位置の上書き＝packages/jp/src/poi.ts injectLabels
	if (poi && layerState.facility && cam.zoom >= 14) poi.injectLabels(allLabels, { zoom: cam.zoom, ink: facInk(), landmarkCode: LANDMARK_CODE });
	const bh = baseHiddenIdx();   // 隠した基図の層のラベル（worker のラベルは層の添字 li を持つ・段 7）
	const merged = inspectHide ? [] : mergeChome(bh.size ? allLabels.filter(L => L.li == null || !bh.has(L.li)) : allLabels, cam.zoom);   // 町丁名の二系統(210/800)を（N）表記ひとつへ畳んでから allowlist へ（検査表示の間は基図の注記を出さない＝層の添字を持たない台帳の注記も）
	// 層の出しズームの外の注記は送らない（labels.js が焼いた minZ/maxZ＝エンジンの z）＝この整数 z の間（labelGate の "Z"）に出る可能性のある物だけ。
	// 旧＝全部送って描く側が zoom 域で捨てていた＝OpenFreeMap の poi_r20（minzoom 18）が z15 で 15753 個＝送るのも 150ms ごとの衝突判定の走査も重かった（2026-09-28）
	const zf = Math.floor(cam.zoom), inZ = (L: HostLabel) => (L.minZ == null || L.minZ < zf + 1) && (L.maxZ == null || L.maxZ >= zf);
	const filtered = themes.filterLabels(merged.filter(inZ), layerState, cam.zoom, layerState.terrain);   // 地形ON＝測量点の標高数値も通す
	const kuVisible = filtered.some(L => L.code === 110);   // 区名が見えている＝政令市名は「背景ラベル」へ格下げする合図
	// 再スタイルの写しは元の注記ごとに覚える＝入力（区名の有無・チップ・テーマ）が同じなら同じ物＝labelsync が worker へ送り直さない
	const gen = (kuVisible ? "k" : "") + (layerState.facility ? "f" : "") + (layerState.terrain ? "t" : "") + "|" + themeName;
	lastLabels = filtered.map(L => {
		const e = restyled.get(L);
		if (e && e.gen === gen) return e.out;
		const out = restyle(L, kuVisible);
		if (out !== L) restyled.set(L, { gen, out });
		return out;
	});
	renderer.set("labels", labelSender(lastLabels));   // ラベル集合を render worker へ（差分＝持っている物は番号だけ）。標高付与(sampleElev)も terrain と一緒に worker 側で行う（同期して描く）
}

// 粗い下地（base スロット）：移動中も常に敷き直して先端の空白・ちらつきを消す。低zで少数＝安く広い。
let baseSig: GlobeLive["baseSig"] = "";
// 線レイヤは merge には含める（間引かない）。main と重なって出る時だけ renderer が draw 時に伏せる
//（「LODの荒い線」対策は描画側の判断へ移設）＝ズームアウトで下地が主役の間は線も描く。低ズームの
// 地図は線（行政界・道路）が絵の本体＋海は紙の海＝塗り だけだと真っ白になるため。
function swapBase(coarseOrder: TileOrder) {
	const sig = coarseOrder.map(o => o.key).join("|") + "#" + styleSig;
	if (sig === baseSig || !coarseOrder.length) return;
	requestWithAck("base", sig, () =>
		requestMerge("base", coarseOrder, [cam.center[0], cam.center[1]], hiddenAll(), sig));   // 下地も scene worker で結合。baseSig は ack で確定
}

// 地形チップの GL 側副作用：等高線(真俯瞰の茶線)の表示切替と、OFF時の地形読込インジケータ消灯。
// ラベル集合も再結合＝測量点の標高数値を即反映し、動かさなくても1枚描き直す。
function applyTerrain() {
	renderer.set("view", { showContour: layerState.terrain });
	if (!layerState.terrain) elevEl.style.display = "none";
	readySig = ""; mergeReq.main.sig = "";
	renderer.draw(cam, { skipBase: false, noTerrain: false, terrainGate: true });
	requestDraw();
}
// チップの見た目同期：点火クラスと aria-pressed（支援技術向けのトグル状態）を常に一緒に更新する。
const syncChip = (b: HTMLElement) => { const on = !!layerState[b.dataset.k as string]; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); };
// レイヤ点火/消灯の正規経路（チップclickの本体を関数化）：状態＋見た目＋styleSig再結合＋per-key副作用＋URL書き戻し
// を一手に。チップ以外の搭載者（poiedit の施設自動点灯など）もここを呼ぶ＝DOMをAPIにしない・チップ不在でも動く。
function setLayer(k: string, on: boolean) {
	if (!!layerState[k] === !!on) return;   // 既にその状態＝no-op（副作用も焚かない）
	layerState[k] = !!on;
	const b = mapEl.querySelector<HTMLElement>(`.chip[data-k="${k}"]`); if (b) syncChip(b);   // チップ不在（chips:false等）でも状態は成立
	styleSig = JSON.stringify(layerState); readySig = ""; requestDraw();
	if (k === "rail") { renderer.set("view", { showRail: layerState.rail }); if (layerState.rail) railOverlay?.load(); }   // 鉄道ON＝N02新幹線も表示＋初回fetch
	if (k === "facility" && layerState.facility) loadLandmarks();   // 施設ON＝PLATEAUランドマーク台帳も初回fetch
	if (k === "terrain") applyTerrain();   // 地形＝等高線・測量点標高・水系も一緒に点火
	saveView();   // レイヤ状態も共有URLの一部＝即書き戻す
}
// チップ操作：状態を反転し、styleSig を更新して即再結合（再取得なし・一瞬）。
mapEl.querySelectorAll<HTMLElement>(".chip").forEach(b => b.addEventListener("click", () => {
	const k = b.dataset.k; if (!k) return;   // data-k 無し＝UIトグル（数字など）は別ハンドラ
	setLayer(k, !layerState[k]);
}));
// 星空チップ（表示パネル内）＝旧・全球ビューの画面クリックから移設。見た目同期は constelApply 側（点火の一本道）
mapEl.querySelector("#chip-sky")?.addEventListener("click", () => sky.toggleConstellations().then(saveView));
// 基図の濃さスライダー（表示パネル）＝fill/line の α を両バックエンド一括で（COG/オーバーレイを主役にする時に引く）
mapEl.querySelector("#base-alpha")?.addEventListener("input", e => { const a = (+(e.target as HTMLInputElement).value) / 100; renderer.set("view", { baseAlpha: a, globeAlpha: a }); requestDraw(); });   // 2026-09-13 本人裁定＝球体（globe/terrain）まで一緒に引く（地中の震源等を透かす）
// テーマ列（表示パネル内）＝palette ガジェットの即決版（ライブ見本はガジェットの領分・こちらは名前+紙色スウォッチ）。
// themeFixed（opts.theme 焼き付け）は列ごと出さない。現在テーマの点火同期は switchTheme 側。
{
	const row = mapEl.querySelector("#theme-row");
	if (row && themeFixed) row.remove();
	else if (row) {
		const THEME_META = Object.fromEntries(Object.entries(WORLD_STYLE_THEMES).map(([k, T]) => [k, [T.label, T.swatch]]));   // 名札とスウォッチ（紙色）＝ortho-core worldstyle の正本（equal と同じ表・段階 3）
		for (const name of Object.keys(MAP_THEMES)) {
			const [label, sw] = THEME_META[name] || [name, "#ccc"];
			const b = document.createElement("button");
			b.className = "lp-theme"; b.dataset.theme = name; b.type = "button";
			b.innerHTML = `<span class="sw" style="background:${sw}"></span>${t(label)}`;
			b.classList.toggle("on", name === themeName);
			b.addEventListener("click", () => { switchTheme(name); saveView(); });
			row.appendChild(b);
		}
	}
}
// 起動時の初期同期（共有URL復元＋opts.layersの固定を含む）：チップの見た目と rail/terrain 副作用を layerState に合わせる（既定どおりなら実質 no-op）
mapEl.querySelectorAll<HTMLElement>(".chip[data-k]").forEach(syncChip);
if (layerState.rail) { renderer.set("view", { showRail: true }); railOverlay?.load(); }
if (layerState.facility) loadLandmarks();   // 起動時に共有URL(l=facility)や opts.layers で施設ONなら台帳も取りに行く
renderer.set("view", { showContour: layerState.terrain });

// 操作方法カード（#hint）はオプトインガジェットへ移設＝gadgets/hint.js（6秒の自動表示・×の記憶ごと）。

// ハッシュの手編集・ペーストで視点ジャンプ（replaceState は hashchange を発火しない＝自分の書き戻しとは無干渉）
if (URL_OWN) window.addEventListener("hashchange", () => {   // URL の持ち主だけ（#173 段 3）
	const v = parseViewHash(location.hash);
	if (!v) return;
	// 手編集/貼り付けは共有URLの「完全再現」＝c= 無しは既定 mono へ戻す（旧 l=dark 互換もここで前処理）。
	// デモの「無指定=現状維持」とは掟が違う＝入口ごとの方針は v.theme へ焼き、適用は applyView 一本に委ねる（画面維持・reload無し）。
	if (!themeFixed && !v.theme) v.theme = v.layers?.includes("dark") ? "dark" : "mono";
	applyView(v);   // 即時適用（l=→c=→カメラ→URL を1本の順序で・固定(opts.theme)は applyView 内で不変）
}, { signal: ac.signal });
// 共有URLの l=/c(等高線) をチップ・描画へ反映（hashchange とデモ台本 flyView の共通部）。
// 固定キー(opts.layers)はどの経路でも破れない＝客が触れるキーだけ反映（旧romajiトークンは読み替え）
function applyViewLayers(v: ParsedView) {
	if (!v.layers && !v.contour) return;
	if (v.layers) { const urlSet = new Set(v.layers.map(normLayerKey)); for (const k of FREE_LAYER_KEYS) layerState[k] = urlSet.has(k); }
	if (v.layers) sky.applyConstellations(v.layers.includes(SKY_LAYER));   // 星座ON/OFFも反映
	if (v.contour && !("terrain" in fixedLayers)) layerState.terrain = true;   // 旧URLの c＝地形チップに読み替え（後方互換）
	mapEl.querySelectorAll<HTMLElement>(".chip[data-k]").forEach(syncChip);
	styleSig = JSON.stringify(layerState); readySig = "";
	renderer.set("view", { showRail: layerState.rail }); if (layerState.rail) railOverlay?.load();
	if (layerState.facility) loadLandmarks();
	applyTerrain();
}
// デモ台本の一行＝共有URLハッシュへ「飛ぶ」（hashchangeのジャンプと違い球面フライトで向かう）。
// ・l= があるシーンだけがチップに触る。無ければ現状維持＝hashchange と同じ意味論
//   （当初「無し＝既定へリセット」にしたら、手動で消した地名が l= 無しシーンのたびに復活する「時たま出現」を生んだ。
//    発表者の手が台本に勝つ＝デモ中も地図は生きたままの哲学。シーンの見た目を固定したい時は明示的に l= を書く）
// ・c= はここで生き替え（switchTheme・reload無し）＝飛行はそのまま進む＝デモの幕替わりの暗転が消える（demo.js は素の送りに徹する）
// ・点火は離陸時＝データは飛行中に読まれ、着地には灯って待つ（PLATEAUだけは着地後＝flight ③の流儀）
// ・opts.glide＝近距離滑走（シーン内の動き）：三段振り付けでなく 位置→方位→チルト の時分割で滑る（引き・回り込み・立ち上がり）
// ・opts.jump＝遷移なしの即時反映（カメラ直書き＋l=反映）。デモの pre→view（同座標で l= だけ点ける見せ玉）用
// ★共有ビュー（parseViewHash 済み v）→ 表示状態を「1本の固定順」で適用する唯一の道＝全入口(hashchange/flyView/デモ)が通る。
// 順序＝ l=(チップ) → c=(テーマ) → カメラ → URL。saveView は末尾で1回（全状態が揃った後）＝即時は確定視点、
// フライトは離陸視点＋新テーマ/チップを書き、着地(settle)で dest cam に更新＝l=/coast の順序取りこぼしが構造的に起きない（URL⇄状態の一元化）。
// mode: {fly}=球面フライト / {fly,glide}=滑走 / {jump}=即時カメラ直書き(pre→view) / 無し=即時(hashchange貼付け)。
// テーマ方針の違い（貼付け=c=無しはmonoへ／デモ=無指定は現状維持）は入口側で v.theme を前処理して吸収＝ここは一様。
function applyView(v: ParsedView | null, { fly = false, glide = false, jump = false } = {}) {
	if (!v) return false;
	applyViewLayers(v);                                                        // 1) l=（チップ）＝先に反映
	if (v.time || v.speed != null) clock.fromParams(clockParamsOf(v));   // 時計（t=/s=・#42）＝貼り替え・台本のビューが時刻を持つ時だけ（無ければ今の時計のまま）
	if (!themeFixed && v.theme && v.theme !== themeName) switchTheme(v.theme);  // 2) c=（テーマ生き替え・switchThemeはURLを書かない＝ここで束ねる）
	if (fly && !jump) { cam.roll = Number.isFinite(v.roll) ? v.roll : 0; (glide ? flightCtl.glideTo : flyTo)(wrapLon(v.lon), v.lat, v.zoom, v.pitch * R2D, v.bearing * R2D); }   // 3a) フライト（離陸＝現視点のまま animate・roll は飛行が補間しない＝離陸で書く）
	else { if (jump) flightCtl.cancel(); applyCamView(v); onMove(); }          // 3b) 即時＝カメラ直書き（jump／hashchange貼付け）
	saveView();   // 4) URL書込＝全状態が揃った後に1回。即時=確定視点／フライト=離陸時に(新テーマ/チップ+離陸視点)、着地settleで dest cam へ更新
	return true;
}
// デモ台本／内部から共有ビューへ「飛ぶ」薄いラッパ（applyView に委譲＝順序と URL 書込を一本化）。glide=滑走・jump=即時。
function flyView(hash: string | ParsedView, opts: { glide?: boolean; jump?: boolean } = {}) {
	const v = typeof hash === "string" ? parseViewHash(hash) : hash;
	if (!v) { console.warn(`[flyView] unparsable view "${hash}"`); return false; }
	return applyView(v, { fly: true, glide: opts.glide, jump: opts.jump });
}
// シーン台本の連続ドリー（glidePath）＝{view,travel} の列を parseViewHash → flightCtl.glidePath へ（via 連続を1本の centripetal Catmull-Rom で貫く＝隅田川ドリー）。
// travel＝その点に到達するまでの区間尺[秒]（エンジン側キーは secs）。カメラのみ＝l=/c= は道中で触らない（直前シーンが設定済み）。pitch/bearing はラジアンのまま cam へ。
function glidePathView(entries: Parameters<GlobeScope["glidePathView"]>[0]) {
	const pts = (entries || []).map(h => {
		const e = typeof h === "string" ? { view: h } : h;
		const v = typeof e.view === "string" ? parseViewHash(e.view) : e.view;
		return v ? { lon: wrapLon(v.lon), lat: v.lat, zoom: v.zoom, pitch: v.pitch || 0, bearing: v.bearing || 0, secs: e.travel } : null;
	}).filter(Boolean) as Parameters<typeof flightCtl.glidePath>[0];
	if (pts.length) flightCtl.glidePath(pts);
	return true;
}

// コンパス兼リセット（#reset）はオプトインガジェットへ移設＝gadgets/compass.js（針の追従・リセットアニメごと）。
// 針の毎フレーム追従は render が呼ぶフック＝搭載時に差し替わる（未搭載なら no-op）。
// render のフレームフック：搭載したガジェットが毎描画で姿勢/位置を追随させる置き場（コンパスの針・現在地マーカー等）。
// onMove→needsDraw→render のたびに全員呼ぶ＝静止中は呼ばれない（動いた時だけ追随＝タダに近い）。
const frameHooks: GlobeScope["frameHooks"] = new Set();
const runFrameHooks = () => frameHooks.forEach(fn => fn());
const shortBearing = () => shortBearingOf(cam.bearing);   // 最短回転へ正規化（実装はengine）＝計器盤の回転列と共用

function render() {
	// gint 表示ゲート（旧 #gint canvas の display:none 相当。変更時だけ post）：
	// ・ユーザー層（筆/ドロップ/AI）＝真俯瞰でのみ表示（Kenji決定 2026-07-23「平面＋3D」：真俯瞰=平面地図の
	//   世界＝筆界・ユーザー層、チルト=3Dの世界＝地形・建物。anchor支配層はチルト＝広可視域で LOD/カリングとも
	//   利かない重描画の主戦場でもある）。閾は show3d と同じ 0.02rad＝建物3Dと入れ替わりに消える。
	// ・世界海岸線＝z8+ では非表示（海岸は WA 塗りが担う。gint の2D線は球の自遮蔽を持たず地平線の先が
	//   リムに残影として浮く）。チルトは表示のまま＝地形ドレープ＋隠線の見せ場。
	// draped 層（moj筆）＝視覚はオレンジ draped 一本に統一し gint層の2D視覚は常に出さない（識別は裏で生存＝二重線解消）。
	// 非draped層（ドロップ/AI）＝従来通り真俯瞰でのみ表示（平面=2D筆界／チルト=3D）。海岸線＝z8+で非表示。
	// drapeFill 層（防災 A33/A31 面）＝チルトでも塗りを消さず描き続ける＝fetchClipDrape が斜面に乗せる（面ドレープ）。
	// 通常層は従来どおり真俯瞰(pitch<0.02)限定＝チルトは gintBld ドレープ線へ譲る。
	const gv = gint.userGint ? (gint.userGint.drapeFill ? true : (gint.drapedOn ? false : (cam.pitch || 0) < 0.02)) : true;   // 単一スロット＝user 専用（空なら値は不問）
	if (gv !== gint.visible) { gint.visible = gv; renderer.set("gintVis", gv); }
	// パン/チルト中（ズーム不変）は詳細も再結合。ズーム中はLODポップ回避で停止まで待つ。
	const zoomStable = Math.abs(cam.zoom - zoomAtBuild) < 0.12;
	// 地形アトラスもズーム中は再構築しない：cellRes/セル数が連続変化して全再ロード＆勾配密度の跳びで
	// 陰影がチラつくため（terrainGate＝render worker 側の terrain.ensure() 呼び出しを止める合図）。
	// ズーム中は現アトラスを再投影（球面メッシュなので拡縮は追従）、停止後に再構築。
	// 下地(base)の要否＝「主層がこの視野を隙間なく覆っているか」の厳密判定（2026-09-03）：
	//   covered＝tiles.update の選抜枠（keepFine 子孫代打後）が全部 ready（tilemanager が返す）
	//   merged ＝その枠集合がそのまま merge 済みで載っている（ack 時に作った readyKeys の Set 照合＝文字列を作らない）
	// 両立すれば base は1画素も見えない＝落として安全（白フラッシュ＝「覆っていない領域の紙色露出」は起こり得ない）。
	// 旧 !moving && readySig===mainDesired は、mainDesired が移動中 MOVE_SWAP_MS 毎にしか更新されない古い署名
	// なので !moving と zoomStable で二重に保険を掛けていた＝移動中は必ず base+main の2枚重ね＝全画面の塗りが2度。
	// ⚠ 描画命令（下の renderer.draw）の位置は動かさない：この下に基図の門（z<BASEMAP_MINZOOM）の早期 return が
	// あり、命令をその後ろへ動かすと世界帯で描画要求が一度も出ず frame1 が来ない（前回の t-anno 不安定の正体）。
	// 判定材料の方を先に作る＝基図圏でだけ tiles.update をここで回す（出典/家具の DOM 処理より僅かに早いだけ）。
	syncCenterAlt();   // 注視点の高さ（MapLibre の目盛り＝地形の上の中心点）を cam へ＝この下の描画・選抜・投影が同じカメラを見る
	const basemap = cam.zoom >= TILE_MINZOOM;
	let tu: ReturnType<typeof tiles.update> | null = null, skipBase = false;
	if (!basemap) { lastTileOrder = []; lastSkipBase = false; coverOk = true; }
	if (basemap) {
		sampleGroundElev();   // 中心の地面標高を追随（非同期・~100m格子メモ）＝groundR の材料
		tu = tiles.update(cam, size.w, size.h, { tilePx: ((moving || !gpuFast || !idleCalm) ? 560 : IDLE_TILE_PX) * TILE_BIAS, zOf: mlZoomOf(), groundR: groundRNow(), keepFine: ML_COVER ? 0 : keepFineNow(), maxZ: BASE_SOURCE.info ? BASE_SOURCE.info.maxZoom : undefined });   // maxZ＝PMTiles 基図のときアーカイブの maxZoom で分割を止める（それ以上は最細段を引き伸ばす＝空タイル要求を作らない）   // tilePx＝「本当の静止」（settle+550ms）だけ主層を一段細かく（手前の詳細化・GPU格付け fast 限定・undefined=既定560）。groundR＝地形リフト球（チルト×高標高地の手前くさび欠け根治）。keepFine＝ズームアウトの子孫代打（3D限定）。calm が needsDraw を立て、細タイルの ready は requestDraw で連鎖再描画
		lastTileOrder = tu.order;   // 描いている基図タイル＝map.queryRenderedFeatures の問い合わせ先
		const o = tu.order, tailNow = "#" + styleSig + "#z" + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0);   // tailNow＝swapScene の署名末尾と同式
		const merged = !!readySig && readyKeys !== null && readyTail === tailNow && readyKeys.size === o.length && o.every(t => readyKeys!.has(t.key));
		skipBase = tu.covered && merged;
		lastSkipBase = skipBase; coverOk = skipBase;   // onMove（入力直結の draw）が同じ値を送る＝worker へ届く opts がフレームごとに交互にならない（#58）
		dbgHost.__cover = { covered: tu.covered, merged, ready: o.length, sel: tu.sel, moving };   // 検証/切り分け用：なぜ base が落ちた/落ちないか
	}
	// terrainGate: 標高アトラスの再構築（窓選定108unproject＋staging＋セルfetch）は重い＝移動中は一切行わず、
	// 停止時に一回だけ綺麗に作り直す（staging が旧アトラスを見せたまま静かに差し替える）。移動中の遅れは
	// 縁フェードと R90/旧窓の残像が受け持つ＝「無理せず、描画終了時に綺麗に描く」方針。
	renderer.draw(cam, { skipBase, skipMain: mainStale(), noTerrain: false, terrainGate: !moving });     // 先に最新camをworkerへ（全球でも標高の塗りは生かす）。印刷撮影中も標高アトラスは生かす＝真俯瞰(pitch0)で地形サーフェスは自然に平ら(elevScaleEff=0)なまま等高線だけ敷ける。海岸線は render worker が従属で追随
	// 全球ビュー（z<4）：基図(GSI)の詳細は不要＝タイル/結合/地形を止め、基図シーンを空に＝海岸線(gint)だけの軽い地球。
	// これで pan 中も main の毎フレーム負荷（tiles.update/merge/terrain）が消える。
	// 星空劇場（.world＝z<5）：逆相家具（日時計）の点灯と、紙の計器（#scale/#hint）の退場だけ。
	// アイコン配列は全z共通（2026-09-03 シンプル化＝旧・扉2枚残しの一括退場を廃止。表示域はガジェット毎の
	// zoom=[zmin,zmax) 宣言）。#pos（座標テーブル）も全z表示。表示パネルも生きたまま＝テーマ切替は宇宙でも効く（世界パレット）。
	const inWorld = cam.zoom < STARSKY_Z;
	mapEl.classList.toggle("world", inWorld);
	// 出典（#attr）の各ズーム統合（2026-09-03 本人号令「綺麗に統合」）：一枚の #attr を3圏で差し替え＝
	//   jp（z≥6.5 基図圏）＝GSI/PLATEAU/JAXA（instruments の静的版を初回退避・nl 入口はその nl 版）
	//   world（5≤z<6.5 世界帯・world時）＝NE・GEBCO・Beck＝日本のデータを出していない画面に地理院を並べない（義務以前に嘘）
	//   sky（z<5 星空圏）＝星図 d3-celestial を加えた世界版（旧 #sky-attr 別要素＋CSS隠しの二重機構を廃止）
	// shot の焼き込み（attrLines＝#attr の文面共用）も自動で圏に追随＝宇宙のスクショに正しい出典が焼かれる。
	{
		const zone = attrZoneNow();
		if (zone !== attrZone) {
			attrZone = zone;
			const attr = mapEl.querySelector("#attr");
			if (attr) {
				if (attrRegionHTML == null) attrRegionHTML = attrFullHTML(attr as HTMLElement);   // 地域版（起動時の静的な出典）を初回に退避（復帰用）
				setAttrHTML(attr as HTMLElement, attrHTMLOf(zone));   // 1 行の銘＋「データ一覧」の札（全文は札の中）
			}
		}
	}
	sky.solarFrame(size.w, size.h);   // 太陽系圏（z<1）＝solarsky.js の遅延ロード・実位置の惑星・ドーム惑星/星座注記との交代（sky/theater.js）
	if (cam.zoom < TILE_MINZOOM) {   // 基図の門の下＝タイルなし（全球ハイプソ＋gint線＋湖スロットの領分。世界タイル撤去 2026-09-03。?pm= のときだけ 0 まで開く）
		if (!basemapHidden) {
			const o = [cam.center[0], cam.center[1]];
			renderer.set("scene", { origin: o, layers: [] }, "main");
			renderer.set("scene", { origin: o, layers: [] }, "base");
			renderer.set("labels", labelSender([]));
			readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; lastLabels = []; mainSceneZoom = -1; basemapHidden = true;   // 復帰時に再結合させる
		}
		runFrameHooks();
		setLog(`world  zoom=${cam.zoom.toFixed(1)}  basemap off / coastline + elevation fill`);
		return;
	}
	basemapHidden = false;
	// 旧・世界帯の選抜cap（maxZ=世界タイルz3・keepFine切り）は世界タイル撤去（2026-09-03）で不要＝
	// ここへ来るのは z≥TILE_MINZOOM だけ（門の下は上の早期returnでタイルなし）。?pm= は maxZ を
	// アーカイブの maxZoom で掛けている（tiles.update）＝旧・世界帯の cap と同じ役割を汎用化したもの。
	const { order, coarseOrder, total } = tu!;   // 選抜は上（描画命令の前・基図圏のみ）で実施済み
	if (poi && layerState.facility && cam.zoom >= 14) poi.load(cam);   // z14+×施設ON＝POI台帳タイル(poi/14/x/y)を可視ぶん先読み（既取得は素通り）
	dbgHost.__lastOrder = order;   // デバッグ：現在の選択タイル（コンソール/検証スクリプトから確認）
	dbgHost.__tileStats = () => { const s = tiles.stats(); console.log(`[tiles] resident ${s.tiles} tiles / ${(s.bytes/1048576).toFixed(1)}MB (budget ${(s.budgetBytes/1048576).toFixed(0)}MB, deviceMemory≈${s.deviceMemoryGB}GB, cacheEntries ${s.cacheEntries})`); return s; };   // コンソールから常駐メモリ確認
	dbgHost.__tileCache = tiles.cache;   // デバッグ：タイル台帳の生参照（status/tries/seen を界隈キーで覗く＝矩形再描画の切り分け用）
	swapBase(coarseOrder);                          // 粗い下地は常に敷く（移動中も）＝先端の空白を無くす
	if (!moving) swapScene(order);   // 静止フレームは毎回＝mainDesired 更新と settle 後の穴埋め merge を最速で
	// ズーム中も merge を出す（旧＝zoomStable の間だけ＝ホイールでズームを続けている間は新しい段のタイルが届いても止まるまで載らず、止まってから +200ms で「ポン」＝MapLibre は届いた順に描く）。
	// 間隔は 250ms・sig が同じなら要求しない（swapScene）＝MapLibre の目盛りでは段が変わる時だけ。LOW_MEM は従来（止まってから）
	else if (performance.now() - lastMoveSwapT >= (zoomStable ? MOVE_SWAP_MS : MOVE_SWAP_ZOOM_MS) && (zoomStable || !LOW_MEM)) { lastMoveSwapT = performance.now(); swapScene(order); }
	runFrameHooks();                               // 3D時のみコンパス表示・針を方位／現在地マーカーの追随 等
	setLog(`tiles=${order.length}/${total}  labels=${lastLabels.length}  zoom=${cam.zoom.toFixed(1)} pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°`);
}

// --- 統合スパイク：geopbf/e-Stat を overlay に描き、クリックで identify（実装は overlay.js）---
const overlay = createOverlay({ renderer, cam, size, dpr, mapEl, requestDraw: requestDraw });
// 拡張が tip を握る合図（e-Stat のホバー結果）：ヒット＝名前を tip へ／ミス(市区町村外)＝gint ホバーへフォールバック（他市区町村の tip/リンク）
const ownTip = (name: string | null) => {
	if (name) {
		gint.extTipOwn = true;
		gint.hoverTip?.([name]);
		wPost({ type: "gintLeave" });   // 隣の市区町村に残った gint ホバー(太線)を消す（B→A復帰でBが光ったまま、の根治・本人報告2026-08-14）。leave は idempotent＝毎ヒットでも安価
		return;
	}
	gint.extTipOwn = false;
	if (((gint.interactive && gint.hover) || extActive) && gint.lastHoverXY) wPost({ type: "gintMove", x: gint.lastHoverXY[0], y: gint.lastHoverXY[1] });
};

dbgHost.__loadOverlay = overlay.loadOverlay;   // geopbf 名から（全球等）
// ?hud=1（旧mem=1）のメモリ台帳HUD 本体は下方の hudSnapshot＋gadgets/hud.js（右下・出典の上・計測器ボタンで開閉）。以下は別計器：
// ?drawhud=1：直近フレームの描画実績を実機の画面へ。USB接続やコンソールが要らない＝端末だけで二分できる。
// 読み方：「背景が黒」の瞬間に **塗り(main/base)が 0 枚**なら CPU/状態側（シーンが空・退場フラグ）、
// **枚数が出ているのに黒**なら GPU 側（描いたのに画素にならない）。赤字＝塗り0＝異常の目印。
// hoisted 関数＝renderWorker.onmessage（上方）から呼ばれる。
let drawHudEl: HTMLDivElement | null = null;
function showDrawHud(msg: { backend?: string; d?: { zoom?: number; baseFill?: number; mainFill?: number; baseLine?: number; mainLine?: number; pt?: number; ptw?: number; skipMain?: boolean; skipBase?: boolean; fadeK?: number; pl?: number; terrainDepth?: boolean; aa?: number } | null }) {
	dbgHost.__drawHud = msg;   // 検証用の生値（t-aatrans＝遷移時AAの回帰が d.aa を読む）
	if (!drawHud) return;
	if (!drawHudEl) {
		drawHudEl = document.createElement("div");
		drawHudEl.style.cssText = "position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:99999;font:12px/1.5 ui-monospace,monospace;background:rgba(0,0,0,.78);color:#7ee787;padding:6px 10px;border-radius:6px;white-space:pre;pointer-events:none;text-align:left";
		document.body.appendChild(drawHudEl);
	}
	const d = msg.d;
	if (!d) { drawHudEl.textContent = `${msg.backend || "?"}: no draw stats (backend not instrumented)`; return; }
	const fills = (d.baseFill || 0) + (d.mainFill || 0);
	drawHudEl.style.color = fills ? "#7ee787" : "#ff7b72";   // 塗り0＝赤＝「背景が黒」の犯人が CPU 側である証拠
	drawHudEl.textContent =
		`${msg.backend}  z${d.zoom}  ${fills ? "" : "⚠ fill 0"}\n` +
		`fill base ${d.baseFill} / main ${d.mainFill}\n` +
		`line base ${d.baseLine} / main ${d.mainLine}\n` +
		`skip skipMain=${d.skipMain ? 1 : 0} skipBase=${d.skipBase ? 1 : 0} fade=${(d.fadeK ?? 1).toFixed(2)}\n` +
		`PLATEAU ${d.pl ?? 0} batches  depth=${d.terrainDepth ? "on" : "off"}  AA=${d.aa ?? "-"}x`;
}
// ?hud=1（旧 mem=1）：状態盤HUD。plateau/tiles/terrain/GPU固定/過渡を合算する台帳＋描画実測（backend/FPS/frame/動的解像度）＋
// device（navigator：RAM/コア/DPR/回線/UA）を gadgets/hud.js（計測器ボタンで開閉するガジェット）へ供給する。数値の出所は全て
// この closure＝ガジェットはレイアウトと更新のみ（抽象アクセス）。本体は ?hud=1 の時だけ import＝通常バンドル不干渉（三戒：独立/遅延/抽象アクセス）。
let hudPeak = 0;   // 走行後ピーク（HUD を畳んでいる間も積む＝閉じても最悪値＝落ちる寸前の値を失わない）
function hudSnapshot() {
	const pl = meshMgr.memStats();   // 常駐（表示＋非表示）の実測バイト・区数・過渡・ティア
	const ts = tiles.stats();
	const gpu = (memGpu ? memGpu.atlas + memGpu.mesh + memGpu.msaa + (memGpu.pool || 0) : 0) + memRaster;   // GPU固定＝標高アトラス近/裏/遠＋地形メッシュ＋MSAA（webgpuのみ・GL2は暗黙確保で0表示）＋タイル GPU 常駐プール（WebGPU md・vt perf plan §4）＋画像タイル層のテクスチャ
	const total = pl.bytes + ts.bytes + memTerrain + gpu + pl.transient.bytes;
	if (total > hudPeak) hudPeak = total;
	const nc = (navigator as NavigatorPlus).connection || {};
	return {
		backend: (dbgHost.__backend as string | undefined) || memBackend, gpuName: memGpuName, fps: memFps, frameMs: memFrameMs, res: memRes,
		shadow: memShadow ? { ...memShadow, gpuMs: memGpuShadow } : null,   // 影の深度パス（#112 段 0）
		vt: vtdCtl?.timing?.() ?? null,   // vector の描く層（#109 段 4）＝組み立て・結合・feature-state の反映の直近の時間
		zoom: cam?.zoom ?? 0, pitch: cam?.pitch ?? 0, bearing: cam?.bearing ?? 0,
		device: {   // navigator/画面＝どの端末が落ちたかの特定（RAMは4GB級/8GB級の判別、DPR×viewport＝フレームバッファのGPU圧）
			ram: (navigator as NavigatorPlus).deviceMemory || null, cores: navigator.hardwareConcurrency || null,
			dpr: window.devicePixelRatio || 1, vw: window.innerWidth, vh: window.innerHeight,
			net: nc.effectiveType || null, down: nc.downlink || null, ua: navigator.userAgent,
		},
		mesh: { bytes: pl.bytes, regions: pl.regions }, tiles: { bytes: ts.bytes, budget: ts.budgetBytes },
		terrain: memTerrain, heap: memHeap, gpu: memGpu, gpuBytes: gpu, raster: memRaster,
		transient: pl.transient,
		total, peak: hudPeak, budget: 900 * 1048576,   // 4GB機の推定タブ予算（8GB機の~1.4GBより小さい）＝残りが薄いほど落ちる寸前
		tier: pl.tier,
	};
}
// 本体は遅延 import＝.then は同期init完走後（registerGadget 定義済み）に走る。hud= 指定時だけ計測器ボタンを載せる（open=1/畳=0 は hudOpenInit）。
if (hudOn) import("./gadgets/hud.ts").then(({ hud }) => {
	registerGadget("hud", (m, opts) => { return hud.call(m, { snapshot: hudSnapshot as () => HudSnapshot, open: hudOpenInit, signal: ac.signal, ...opts }); });
	map.gadget.hud!();
}).catch(e => console.error("[hud] failed to load module", e));
// 初期 overlay なし（全球 land は検証用。__loadOverlay(name) で任意に。__tokyo() は日本の install が生やす）

let clockLastT = performance.now(), clockUrlAt = 0;
function frame() {
	if (destroyed) return;   // destroy 後はループを再予約しない＝rAF が自然消滅
	// 共通の時計を進める（#42）：実時間は Date.now に張り付くので何もしない。早送り/巻き戻し中だけ積算し、惑星・日時計・太陽系圏を追わせる。
	// worker の基準は 1 秒ごとに送り直す（main の積算は dt を 0.1 秒で頭打ち＝裏タブ復帰の跳びを防ぐ solar の流儀／worker は壁時計で外挿＝その差を詰める）
	const nowT = performance.now(), aNow = animNow(), dtC = Math.min(0.1, Math.max(0, (aNow - clockLastT) / 1000)); clockLastT = aNow;   // 共通の時計の刻みは動きの時計で（setNow で止まる・C10）
	if (clock.playing && !clock.isLive()) {
		clock.tick(dtC); sky.timeChanged();
		if (cam.zoom < STARSKY_Z) requestDraw();
		if (nowT - clockSentAt > 1000) sendClock();
		if (nowT - clockUrlAt > 1000) { clockUrlAt = nowT; if (!printHold) saveView(); }   // 再生中も URL の t を追わせる＝いつコピーしても今の場面（solar と同じ）
		for (const cb of mapOn.time) { try { cb({ time: clock.time, step: clock.step, live: false, ticking: true }); } catch (e) { console.error("[map.on time]", e); } }
	}
	if (followSt) tickFollow();   // 追従（A4）＝描く前に的の今の位置へ
	if (repaintAlways) requestDraw();   // 連続描画（MapLibre の map.repaint・B6）
	if (needsDraw) { needsDraw = false; render(); if (dbgState.tileBoundaries || dbgState.padding) drawDebug(); }
	if (mapOn.idle.length) checkIdle(nowT);
	requestAnimationFrame(frame);
}
// idle（MapLibre 同名・公式例の門 段 2・2026-09-27）＝動いていない・飛んでいない・描き直し待ちが無い・基図が覆って載っている・
// 標高と建物と画像タイル層（raster/hillshade/image/video＝rasterPendTotal）の読み込みが無い・利用者の source が揃った、が 100ms 続いたら 1 回。忙しくなったら次の静けさでまた 1 回（MapLibre と同じ）。
// 起動直後も（カメラを動かさなくても）来る＝settle（onMove の後だけ）とは別の合図
const noVecBase = () => !!EXT && !EXT.split.vectorSource;   // 外来 style に vector の基図が無い（画像層だけ・空の style）＝基図の覆いは idle の条件にならない（覆う物が無い＝coverOk は永遠に false）
let idleState = 0, idleSince = 0;   // 0＝忙しい・1＝静けさの候補・2＝知らせ済み
// 診断の窓（debugGlobals）＝置いたラベル（基図・vector・gint＝labels2d の当選集合）と記号（symbols overlay）を層 id 付きで返す＝公式例の門 段 0（文字を測る）。
// 基図のラベルは li（style の層の添字）→ id・vector の描く層は "vt:<id>"・gint は層 id。x,y＝CSS px（中心）・w,h＝箱
const placedWait = new Map<number, (d: PlacedMsg | null | undefined) => void>(); let placedSeq = 0;
dbgHost.__placed = () => new Promise(res => {
	const sid = ++placedSeq;
	placedWait.set(sid, d => {
		const layerOf = (L: PlacedMsgLabel) => L.set != null ? String(L.set).replace(/^vt:/, "") : L.li != null ? (style.layers[L.li]?.id ?? null) : null;
		res([...(d?.labels ?? []).map(L => ({ kind: "label", layer: layerOf(L), text: L.text, icon: L.icon ?? null, ibox: L.ibox ?? null, line: !!L.line, lon: L.lon, lat: L.lat, x: L.x, y: L.y, w: L.w, h: L.h, font: L.font ?? null })),   // icon/ibox＝置いた記号（段 3）
			...(d?.symbols ?? []).map(S => ({ kind: "symbol", layer: S.layer, text: S.text, icon: S.icon, ibox: S.ibox ?? null, lon: S.lon, lat: S.lat, x: S.x, y: S.y, w: S.w, h: S.h, font: S.font ?? null }))]);   // font＝据えた書体（段 2 の検定）
	});
	wPost({ type: "labelsPlaced", id: sid });
	setTimeout(() => { if (placedWait.delete(sid)) res([]); }, 5000);
});
dbgHost.__placedDebug = () => new Promise(res => {   // 同・診断＝衝突判定の地図 z と zoom 域で外した数（li→層 id）
	const sid = ++placedSeq;
	placedWait.set(sid, d => { const g = d?.debug; if (!g) return res(null); const sk: Record<string, unknown> = {}; for (const [k, v] of Object.entries(g.outOfZoom || {})) sk[/^li\d+$/.test(k) ? (style.layers[+k.slice(2)]?.id ?? k) : k] = v; const nm = (k: string) => /^li\d+$/.test(k) ? (style.layers[+k.slice(2)]?.id ?? k) : k, pt: Record<string, unknown> = {}, lineBy: Record<string, unknown> = {}; for (const [k, v] of Object.entries(g.pt || {})) pt[nm(k)] = v; for (const [k, v] of Object.entries(g.lineBy || {})) lineBy[nm(k)] = v; res({ zoom: g.zoom, total: g.total, outOfZoom: sk, line: g.line ?? null, lineBy, pt, engineZoom: cam.zoom, styleDz: STYLE_DZ }); });   // line＝線の注記の落ちた理由（段 4）
	wPost({ type: "labelsPlaced", id: sid });
	setTimeout(() => { if (placedWait.delete(sid)) res(null); }, 5000);
});
dbgHost.__labelsMain = () => { const by: Record<string, number> = {}; for (const L of lastLabels) { const k = L.li != null ? (style.layers[L.li]?.id ?? "li" + L.li) : "?"; by[k] = (by[k] || 0) + 1; } return { n: lastLabels.length, by, styleSymbols: style.layers.filter(L => L.type === "symbol").map(L => [L.id, L.minzoom ?? null, L.maxzoom ?? null]) }; };   // 診断（debugGlobals）＝main が worker へ送った基図ラベルの数（層 id ごと）と style の symbol 層の zoom 域
// 診断の窓（debugGlobals）＝idle を塞いでいる材料を全部返す（公式例の門で「idle が来ない」を切り分ける）
dbgHost.__idleWhy = () => ({ rasterFading, mapLoaded, moving, geBusy, groundElevM, noTerr, centerAlt: cam.centerAlt || 0, flight: !!flightCtl.active, needsDraw, coverOk, noVecBase: noVecBase(), extMounting: extExtras.mounting, elevBusy, meshLoading: meshMgr.visibleLoading().length, rasterPendTotal, rasterPend: Object.fromEntries(rasterPend),
	sources: [...mlSources.keys(), ...Object.keys(EXT?.ms.sources || {})].map(id => [id, map.isSourceLoaded(id)]), mounting: [...mlLayers].filter(([, v]) => v.mounting).map(([k]) => k), idleState });
function checkIdle(now: number) {
	const quiet = mapLoaded && !moving && !flightCtl.active && !needsDraw && (coverOk || noVecBase()) && !elevBusy && !(centerElevMode === "ground" && !noTerr && geBusy) && !meshMgr.visibleLoading().length && !rasterPendTotal && !rasterFading && !extExtras.mounting
		&& [...mlSources.keys()].every(id => map.isSourceLoaded(id)) && (!EXT || Object.keys(EXT.ms.sources || {}).every(id => map.isSourceLoaded(id)));
	if (!quiet) { idleState = 0; return; }
	if (idleState === 0) { idleState = 1; idleSince = now; return; }
	if (idleState === 1 && now - idleSince >= 100) {
		idleState = 2;
		for (const cb of [...mapOn.idle]) { try { cb({}); } catch (e) { console.error("[map.on idle]", e); } }
	}
}
requestAnimationFrame(frame);

// --- 後片付け（map.destroy()）：SPA等で地図を剥がす時に呼ぶ。worker・リスナー・ループ・タイマーを全て止める。
// 自作した容れ物（target無指定で body 直下に作った div）は丸ごと消し、預かった div は中身だけ空にして返す。
// IDBキャッシュ（PLATEAU/標高）はオリジン資産＝消さない（再訪の速さはそのまま）。
let destroyed = false;
function destroy() {
	if (destroyed) return;
	destroyed = true;
	flightCtl.cancel();
	ac.abort();                                  // window/document のリスナー一括解除（offline/online/hashchange/検索の外側クリック）
	ro.disconnect();
	clearTimeout(settleT); clearTimeout(calmT); clearTimeout(bootT); clearTimeout(gpuWatchT); sky.terminate();   // gpuWatchT＝WebGPU frame1 番犬（残すとホストページを reload する）
	destroyPipeline();                           // tile/scene worker
	renderWorker.terminate();
	for (const h of overlays.values()) h.el.remove();   // 同一フレームのオーバーレイ canvas（worker は上で terminate 済み）
	overlays.clear();
	meshMgr.terminate();                         // PLATEAU worker・デコーダ（main 所有）・見張りタイマー
	for (const f of ownDestroy) { try { f(); } catch (e) { console.warn("[destroy]", e); } }     // 日影・gint の焼き・ラスタ・列チャンク層・標高の worker
	for (const f of hostDestroy) { try { f(); } catch (e) { console.warn("[region] destroy", e); } }   // 地域パックの片付け（e-Stat worker 等）
	overlay.destroy();
	// デバッグ手はこのインスタンスの閉包を掴んだまま＝GCの錨になるので窓から下ろす
	// 生やした名前は全て下ろす（従来は13名だけ＝取りこぼしが閉包を掴んだまま残っていた）。
	// 埋め込み時は dbgHost が使い捨ての器＝この delete は空振りするが、閉包の錨は器ごと GC される。
	for (const k of ["__backend", "__budget", "__cam", "__admin0", "__a0", "__drawErr", "__drawHud", "__drawSendErr", "__drawSendN", "__farState", "__fly", "__gload", "__hiddenLi", "__lastOrder", "__loadOverlay", "__mergeFail", "__paint", "__paintFid", "__paintOverlap", "__paintParity", "__paintProps", "__mesh", "__meshPurge", "__shadow", "__standup", "__worldContent", "__style", "__tileCache", "__tileStats", "__vtPool"]) delete dbgHost[k];
	mapEl.classList.remove("world", "ui-dark", "ui-idle");   // SDK が付けた class を全部外す（全球フェード・白抜き家具・無操作フェード）＝"as it was" を真に
	if (!mapElHadQm) mapEl.classList.remove("qm");   // 意匠の容れ物の印（エンジンが付けた分だけ）
	if (ownMapEl) {   // 自前ページを預かった時に入れた inline 寸法を元へ（再起動しても二重に残らない）
		document.documentElement.style.cssText = pageStyle.html ?? "";
		document.body.style.cssText = pageStyle.body ?? "";
	}
	LIVE_CONTAINERS.delete(mapEl); releaseUrl();   // 容れ物は空き＝同じ div で起動し直せる（預かった div の id は借りた時から触っていない）・URL の持ち主の札も返す
	mapEl.lang = mapElPrevLang; mapEl.dir = mapElPrevDir;   // 言語/書字方向も借りる前へ返す
	ownMapEl ? mapEl.remove() : mapEl.replaceChildren();
}
// reload/離脱の瞬間に即 destroy＝worker群（renderworker のGL含む）を同期的に畳む。iOSは遷移中
// 「旧ページ＋新ページの二重居住」があり、テーマ切替（c=の暗転reload）連発のデモで boot メモリ×2が
// タブ予算(~1.4GB)を突く＝「淡色/鉄道地図で落ちる」の主犯。旧ページを殻にしてから新ページを立てる。
// persisted=true（bfcache行き）は畳まない＝戻る操作の即復帰を壊さない。
window.addEventListener("pagehide", e => { if (!e.persisted) destroy(); }, { signal: ac.signal });

// 世界海岸線：初期視点が z<9 ならここで即発火（既定の世界ビュー＝従来どおり最初から描画）。await せず＝基図の起動を妨げない。
gint.updateGintSlot();
sky.ensureStars();   // 初期視点が z<5（復元/共有URL）なら星空も最初から
meshMgr.update();   // 初期視点が z12+（復元/共有URL の街）なら建物メッシュの管理も最初から起こす（onMove を通らない起動の経路・2026-09-22 の遅延化で必要になった一突き）

// 呼び出し側の手綱（視点操作・飛行・描画設定）＋ガジェット登録簿（v1 ortho-map createGadgets の作法の継承）。
// registerGadget(name, (map, ...args) => handle) で登録し map.gadget.name() で画面に追加する（判断 2・2.0）。本体は map を第 1 引数に受ける素の関数＝
// mapEl/flyTo 等の手綱がそのまま使える（利用者・plugin の登録は map.registry.gadgets.add＝同じ登録口。1.x の map.gadget(name, func)＝this が map の登録は 2.0 で外した）。検索・操作説明は標準装備から外した最初のオプトインガジェット。
// カメラ実位置（eye）＝透視カメラそのものの経緯度・海抜（updateUnderground と同式・cameraState の eye を球面へ戻す）。
// zoom は「注視点での倍率」＝カメラ高度ではない：チルト時は注視点の後方上空に立つ（scene エディタの参考表示用）。
const eyePose = () => {
	const st = cameraState(cam, size.w, size.h);
	const len = Math.hypot(st.eye[0], st.eye[1], st.eye[2]);
	const [eLon, eLat] = betaToLonLat(st.eye);   // 測地緯度（updateUnderground と同じ逆変換＝eye は β空間・楕円体でも正しい eye 位置）
	return { lon: wrapLon(eLon), lat: eLat,
		altM: (len - 1) * EARTH_M, distM: st.camDist * EARTH_M,   // altM=海抜[m]（sea-level球）・distM=注視点までの実距離[m]
		fovy: cam.fovy || 50 * D2R };   // 垂直視野角[rad]（エンジン既定50°・水平は aspect 依存＝表示側で 2·atan(tan(fovy/2)·W/H)）
};
const map = { cam, renderer, mapEl, destroy, clock,   // flyTo は installCamera が付ける（公開の flyTo＝持ち主は api/camera.ts・内部の位置引数の flyTo は deps で渡す）
	// ★表示状態（共有される「単一の真実」）を map インスタンスから常時参照可能に＝viewHash が直列化するのと同じ状態。
	// center/zoom/pitch/bearing（cam）＋ theme(c=)＋ layers(l=・sky含む)＋ sky ＋ 現在の共有URL文字列(hash)。読み取り専用スナップショット。
	// eye＝カメラ実位置（緯度・経度・海抜m・注視点距離m＝参考値）。
	get view() { return { center: [...cam.center] as LonLat, zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, roll: cam.roll || 0, fovy: cam.fovy || 50 * D2R, theme: themeName, layers: FREE_LAYER_KEYS.filter(k => layerState[k]).concat(sky.constelVisible ? [SKY_LAYER] : []), sky: sky.constelVisible, hash: viewHash(), eye: eyePose() }; },
	// ★scene-player API（v2整備 2026-08-09）＝台本オブジェクトの直接上映（第三の入口・エディタの土台）。要 demo ガジェット搭載。
	//   playScenes(obj, {from, quick, onScene, onEnd})／stopScenes()＝停止（準備中でも安全）。正典＝demo/scene-format.md §7
	playScenes: (obj, opts) => scenes.playScenes(obj, opts), stopScenes: () => scenes.stopScenes(),
	//   sceneTimeline(obj)＝タイムライン（時刻評価・スクラブ）→ {dur, rows, at, seek, end}（再生せず任意秒の絵＝エディタ用）
	sceneTimeline: obj => scenes.sceneTimeline(obj),
	// 録画用（scene エディタ）：動的解像度を固定（映像に縮み絵を混ぜない）。on=true で即 res=1・降段停止／false で通常運転へ
	pinRes: on => renderWorker.postMessage({ type: "pinRes", on: !!on }) } satisfies Partial<GlobeMapBuilding> as Partial<GlobeMapBuilding> as GlobeMapBuilding;   // 残りの口は下の installer と map.X＝が付ける（組み上がった map が GlobeMap）
// ガジェット注入用の座標ブリッジ（engine の project/unproject を今の cam/サイズで束ねた手綱）。
// projectLL＝経緯度→画面CSS座標[x,y,front]（front<0＝裏半球・視界外）。unprojectAt＝画面座標→[lon,lat]（球外は null）。
// DOMオーバーレイ（現在地マーカー/pop/計測）の標高乗せ：radius=1（標高0の球面）へ投影すると、
// DTM開通後はチルトで「地中の位置」が投影され地面とずれる（現在地マーカーで実測。真俯瞰は放射変位＝不変）。
// 表示中の地形変位と同式（TERR_EXAG/EARTH_M × pitchフェード＝renderer elevScaleEff と同形・cityFlatは撤去済み）。
// 標高は heightAt を100m格子でメモ（非同期＝到着まで0m、次フレームで乗る。キーはマーカー/pop地点のみ＝有界）。
// 外来の標高タイル（#36）＝1 点の標高は main で DEM の最大ズームを直に読む（範囲外・無効は既定の標高へ）
let demMain: GlobeLive["demMain"] = DEM0 ? createDemSource(DEM0 as Parameters<typeof createDemSource>[0]) : null, demSpec: GlobeLive["demSpec"] = DEM0;
const demFirst: GlobeScope["demFirst"] = (lon, lat, fallback) => demMain ? demMain.height(lon, lat, Math.floor(cam.zoom - (ML_COVER?.dz ?? ML_DZ))).then(v => (v === v ? v : fallback())).catch(fallback) : fallback();   // z の当たり＝今の視点の MapLibre の z（512px のタイル）＝maxzoom 22 の source でも見えている段から引く（無ければ親へ）
// 1 点の標高＝描いている地形と同じ出どころ（外来の DEM が先・無い所は既定の DTM をタイル着荷まで待つ）。map.getHeight と DOM オーバーレイの持ち上げ（elevOf）が共用
//（旧・elevOf は既定の DTM だけを待たずに引いていた＝setTerrain の DEM ではマーカー/pop/計測/足跡がチルトで描いた地形とずれ、別タイルの読込中に引いた点は 0m のままメモに残った・2026-09-27）
const heightAt: GlobeScope["heightAt"] = (lon, lat) => demFirst(lon, lat, () => getHeightP.then(f => f(lon, lat, cam.zoom, { wait: true }))).then(h => +h || 0);
const elevMemo: GlobeScope["elevMemo"] = new Map();
// ★有界化（2026-09-13）：makeProjectorH を大量点（地震 overlay 2300点×3/フレーム）で呼ぶと、未メモの点ごとに getHeight が一斉発射され
//   renderer が SIGTRAP で落ちた（実測・エラーコード5）。同時在庫を ELEV_INFLIGHT_MAX に絞り、溢れた点は「今回は 0m」（メモに残さない＝次回また試す）。
//   マーカー/pop の数点なら従来どおり即照会。needsDraw も 1 回に束ねる。
// elevGen＝DEM の世代（setTerrain でメモを捨てて進める＝差し替え前に出た照会の答えは新しいメモに書かない）
const ELEV_INFLIGHT_MAX = 64; let elevInflight = 0, elevDrawPending = false, elevGen: GlobeLive["elevGen"] = 0;
const elevOf: GlobeScope["elevOf"] = (lon, lat) => {
	const k = Math.round(lon * 1000) + "," + Math.round(lat * 1000);
	const hit = elevMemo.get(k);
	if (hit !== undefined) return typeof hit === "number" ? hit : 0;
	if (!(demMain || getHeight) || elevInflight >= ELEV_INFLIGHT_MAX) return 0;   // 出どころ未着・溢れ＝照会しない（メモ未登録のまま）
	elevMemo.set(k, null); elevInflight++;
	const gen = elevGen;
	heightAt(lon, lat).then(h => { if (gen === elevGen) elevMemo.set(k, h); }, () => { if (gen === elevGen) elevMemo.set(k, 0); })
		.then(() => { elevInflight--; if (!elevDrawPending) { elevDrawPending = true; requestAnimationFrame(() => { elevDrawPending = false; requestDraw(); }); } });
	return 0;
};
// 負の標高は 0 に切る＝描いている地面（renderer の標高アトラスは負を 0 に切る＝海は海面・ortho-core elevation.js／terrain.js）
const dispRadius = (lon: number, lat: number) => {
	const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14)), pf = noTerr ? 0 : pt * pt * (3 - 2 * pt);   // ?noterr=1＝地形を描かない＝持ち上げも 0（描く側と同じ・vtxGround の当たりも同じ口）
	return pf > 0 ? 1 + Math.max(0, elevOf(lon, lat)) * pf * (TERR_EXAG / EARTH_M) : 1;
};
const projectLL: GlobeScope["projectLL"] = (lon, lat) => { const st = cameraState(cam, size.w, size.h); const [sx, sy, f] = project(st, lon, lat, dispRadius(lon, lat)); return [sx / dpr, sy / dpr, f]; };
const unprojectAt: GlobeScope["unprojectAt"] = (clientX, clientY) => { const r = canvas.getBoundingClientRect(); const st = cameraState(cam, size.w, size.h); return unproject(st, (clientX - r.left) * dpr, (clientY - r.top) * dpr); };
// makeProjector＝カメラ状態を1回だけ束ねた投影関数を返す（多点を1描画で投影＝測距の大圏分割で状態計算を積まない）。
// unprojectXY＝canvasローカルCSS座標→経緯度（input.onClick が渡す x,y と同座標系）。
const makeProjector: GlobeScope["makeProjector"] = () => { const st = cameraState(cam, size.w, size.h); return (lon, lat) => { const [sx, sy, f] = project(st, lon, lat, dispRadius(lon, lat)); return [sx / dpr, sy / dpr, f]; }; };
// makeProjectorH＝高度付き投影（注釈の3Dピン用）：地表（地形持ち上げ込み）から hメートル 上の点を画面へ。
// 真俯瞰では鉛直変位が画面上ほぼ消える＝ピンは自然に「円」へ縮退・チルトで立つ（annoガジェットが使用）。
const makeProjectorH = ({ terrain = true } = {}) => { const st = cameraState(cam, size.w, size.h); return (lon: number, lat: number, hM?: number): [number, number, number] => { const [sx, sy, f] = project(st, lon, lat, (terrain ? dispRadius(lon, lat) : 1) + (hM || 0) * (TERR_EXAG / EARTH_M)); return [sx / dpr, sy / dpr, f]; }; };   // terrain:false＝地形リフト無し（海面球＋hM）＝大量点の overlay 用（getHeight を叩かない・2026-09-13）
const unprojectXY: GlobeScope["unprojectXY"] = (x, y) => unproject(cameraState(cam, size.w, size.h), x * dpr, y * dpr);
// shot（画面保存）用スナップショット：render worker（GLは別スレッド＝mainから読めない）に「今の1枚」を
// 出させる。gint は 1canvas統合で基図と同じ1枚に写り込む＝旧・別撮り合成（wantGint）は消滅。
// 解像度は size（device px＝フル）を正とし、shot 側が各層をこの寸法へ合わせて重ねる。
const snapPending = new Map<number, { need: Set<string>; parts: Record<string, unknown>; resolve(v: Snapshot): void }>();
function snapPart(id: number, key: string, data: unknown) {
	const rec = snapPending.get(id); if (!rec) return;
	rec.parts[key] = data; rec.need.delete(key);
	if (!rec.need.size) { snapPending.delete(id); rec.resolve(rec.parts as Snapshot); }
}
let snapSeq = 0;
const requestSnapshot = (): Promise<Snapshot> => new Promise(resolve => {
	const id = ++snapSeq;
	snapPending.set(id, { need: new Set(["render"]), parts: { W: size.w, H: size.h }, resolve });
	wPost({ type: "snapshot", id });
});
map.requestSnapshot = requestSnapshot;   // ★プラットフォーム公開面（map.playScenes と同格）：生スナップ {W,H,render}。合成は gadgets/compose.js＝geoedit の公開サムネ等が使う
dbgHost.__map = map;   // デバッグ手（__cam 等と同族）＝コンソール/CDP 検証から公開面を叩く取っ手（埋め込み時は器止まり＝窓を汚さない）
// --- 印刷（平面図）用の撮影：ライブパイプラインを一時的に「印刷カメラ」（同中心・真俯瞰・北向き・指定z・
// noTerrain＝紙仕様）へ振り、タイル/注記の読み込みが落ち着いてから readPixels スナップショットを取り、
// 元のカメラへ戻す。printHold が autoMesh と settle保存を抑止（印刷カメラを自動ロードや保存に漏らさない）。
const printSettled = (timeout: number) => new Promise(res => {
	const t0 = performance.now();
	const tick = () => {
		const idle = !moving && (cam.zoom < BASEMAP_MINZOOM || (readySig && readySig === mergeReq.main.sig));
		if (idle || performance.now() - t0 > timeout) return setTimeout(res, 300);   // 一拍おいて描画を確定
		setTimeout(tick, 200);
	};
	setTimeout(tick, 400);
});
async function printCapture({ zoom, cropCss }: { zoom: number; cropCss: { w: number; h: number } }) {
	flightCtl.cancel();
	const saved = { center: [...cam.center] as LonLat, zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing };
	printHold = true;
	try {
		cam.pitch = 0; cam.bearing = 0; cam.zoom = zoom; onMove();
		await printSettled(12000);
		const snap = await requestSnapshot();
		const cw = mapEl.clientWidth, ch = mapEl.clientHeight;
		const rect = { x: (cw - cropCss.w) / 2, y: (ch - cropCss.h) / 2, w: cropCss.w, h: cropCss.h };   // 中央切り出し（CSS座標）
		const corners = {   // 図郭の四隅経緯度（経緯線・隅表記用）。球外は null＝print側が省く
			nw: unprojectXY(rect.x, rect.y), ne: unprojectXY(rect.x + rect.w, rect.y),
			sw: unprojectXY(rect.x, rect.y + rect.h), se: unprojectXY(rect.x + rect.w, rect.y + rect.h),
		};
		return { snap, rect, corners, dpr };
	} finally {
		cam.center = saved.center; cam.zoom = saved.zoom; cam.pitch = saved.pitch; cam.bearing = saved.bearing;
		onMove();
		printHold = false;   // 元カメラの settle は保存してよい（印刷カメラの settle は抑止済み）
	}
}
// ★派生アプリ公式口（census2020 等）＝ window.__* デバッグ手の正式化。additive・ortho-japan 単体の挙動は不変。
// gint系＝ユーザー知性層（単一スロット）の正規口／overlay＝estat小地域・geopbfオーバーレイの手綱。
map.overlay = overlay as unknown as GlobeMapBuilding["overlay"];   // 呼べる形（map.overlay(src)）は installOverlays が被せる
map.applyGintData = gint.applyGintData;
map.clearUserGint = gint.clearUserGint;    // 単一スロットのユーザー層を丸ごと撤去（gint.applyGintData の対＝派生アプリのスロット調停用）
map.addGint = gint.addGint;              // gint 多層（v2 spec §4 の顔・両バックエンド）＝追加であって置換ではない
map.queryAll = gint.queryAllGint;        // 層をまたぐ照会＝{layer, fid} の対（手前の層から・§10.2）
map.on = (ev, cb) => { if (ev === "load" && mapLoaded) queueMicrotask(() => (cb as (e: object) => void)({})); mapOn[ev]?.push(cb as (e: unknown) => void); return map; };
map.off = (ev, cb) => { const a = mapOn[ev]; if (a) { const i = a.indexOf(cb as (e: unknown) => void); if (i >= 0) a.splice(i, 1); } return map; };   // 購読解除（2026-09-11）   // §4: 'click'（hits=queryAll 同型）/'move'/'load'
map.standupGint = gint.standupGint;         // liftM=null で解除
map.gintFeatures = gint.gintFidFeatures;    // fid 整列 properties（式評価・表直書きの入力）
map.paint = gint.paintGint;                 // Mapbox式 → buildFidStyle
map.paintTable = (u32, count) => { gint.sendGintPaint({ table: u32, count }); requestDraw(); };   // fid→RGBA表の直書き（コロプレス切替＝これだけ）
map.fitZoomForBbox = gint.fitZoomForBbox;
map.projectLL = projectLL;             // 経緯度→画面CSS座標[x,y,front]（DOMマーカー用・front<0=裏半球）
map.unprojectXY = unprojectXY;         // canvasローカルCSS座標→[lon,lat]|null（onClick の x,y と同座標系。球外=null）
// MapLibre と同じ形の座標変換（2026-09-25・AI エージェントの試走で「無い」と言われた口）。座標系は projectLL / unprojectXY と同じ＝地図の容れ物の左上原点の CSS px。
// project は見えない所（球の裏・地平線の外）でも地平線へ寄せた位置を返す＝見えるかは projectLL の front（第 3 要素）で。unproject は球の外なら null
const toLonLat = (ll: LonLat | { lng?: number; lon?: number; lat: number }): LonLat => Array.isArray(ll) ? ll : [ll.lng ?? ll.lon, ll.lat] as LonLat;
map.project = ll => { const [lon, lat] = toLonLat(ll); const [x, y] = projectLL(lon, lat); return { x, y }; };
map.unproject = p => { const [x, y] = Array.isArray(p) ? p : [p.x, p.y]; const ll = unprojectXY(x, y); return ll ? { lng: ll[0], lat: ll[1] } : null; };
map.makeProjector = makeProjector;     // カメラ状態を1回束ねた投影関数（多点を1フレームで投影＝編集ハンドル用）
map.ellipsoidOn = () => ellipsoidOn();   // 楕円体表示か（?ell=1）＝geoedit（npm） が「編集は完全球体」の注意書きに使う（ortho-core を直接 import させない）
map.makeProjectorH = makeProjectorH;   // 高度付き投影（注釈の3Dピン＝チルトで立つ。annoガジェット用）
map.setEditClick = fn => { editClick = fn; };   // 派生アプリのクリック横取りスロット（null で解除＝measure/poi と同型）
map.t = (key, ...args) => t(key, ...args);   // UI 文言の訳（SDK が起動時に読んだ辞書で引く＝器の頁が i18n と辞書をもう一度読まない・1.2.0〜 2026-09-22）
Object.defineProperty(map, "lang", { get: () => getLang(), enumerable: true });   // 表示言語（ja/en/…）
map.requestDraw = requestDraw;  // オーバレイ更新後の1フレーム点火（派生アプリの編集描画用）
// 後処理（deck.gl の PostProcessEffect 相当・差分 PR-8・2026-10-12）：map.setPostProcess({ bloom: { threshold, strength, radius }, vignette: { strength, radius, softness } } | null)
//   本体の絵（基図・地形・建物・gint）に掛かる。注記と同一フレームのオーバーレイは別 canvas＝掛からない（順番の裁定＝本体の後・注記の前）。GL2＝深度と同じ FBO の写しの段で合成・WebGPU＝flush の終端
let postCur: ReturnType<typeof normPostChain>["post"] = null, postChain: ReturnType<typeof normPostChain>["passes"] = [];
// 後処理の鎖（第 2 波 F3・2026-10-12・src/postchain.js）：map.setPostChain([{ type:"bloom"|"vignette"|"fxaa"|"smaa"|"tonemap"|"lut"|"dof"|"ssr"|<plugin>, ... }])／getPostChain()。
//   描くのは bloom・vignette（従来の "post"）と fxaa・tonemap・lut（第 3 波 W1・2026-10-12・掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette）。smaa/dof/ssr は受けて保つだけ（capabilities "spec"）。plugin の type は registry.postEffects の { apply(map, passes) } が setPostChain のたびに呼ばれる。
//   setPostProcess({ bloom, vignette }) は従来どおり＝鎖の bloom→vignette に写る（getPostProcess の形は不変・fxaa/tonemap/lut の鍵は on の時だけ生える）
const applyPostChain = (chain: unknown) => {
	const reg = pluginHost.registry.postEffects;
	const r = normPostChain(chain, t => reg.has(t) && !POST_TYPES.includes(t));
	postChain = r.passes; postCur = r.post; renderer.set("post", postCur);
	for (const t of reg.names()) if (!POST_TYPES.includes(t)) { try { reg.get(t)!.apply(map, postChain.filter(x => x.type === t)); } catch (e) { console.warn(`[post] ${t}: apply failed`, e); } }
	requestDraw(); return map;
};
map.setPostChain = chain => applyPostChain(chain);
map.getPostChain = () => postChain.map(x => ({ ...x }));
map.setPostProcess = p => (Array.isArray(p) ? applyPostChain(p) : applyPostChain(p == null ? null : { bloom: p.bloom, vignette: p.vignette, fxaa: p.fxaa, tonemap: p.tonemap, lut: p.lut }));
map.getPostProcess = () => postCur as ReturnType<GlobeMap["getPostProcess"]>;
if (opts.postProcess) map.setPostProcess(opts.postProcess);
// ── plugin 契約・registry・capabilities（拡張点の整備・第 2 波 PR-F0・2026-10-12・src/plugin.js・台帳 compat §9「拡張点の台帳」）──
//   map.use(definePlugin({ name, install(map, opts), uninstall? }), opts)／unuse(name)／plugins()。install は同期・返した関数は撤去時に呼ぶ。地域パックと同じく素の map を受ける
//   map.registry.dataKinds（addData の kind＝{ create(map, data, opts) → 手綱 }）・gadgets（map.gadget と同じ）・tileFormats（core の registerTileFormat）は効く。lights/postEffects/textureTranscoders は F1/F3/F4 で結線
//   map.supports(key)＝builtin か plugin の時だけ true・map.capabilities()＝鍵ごとの正直な答え（"never"＝Mercator）。opts.plugins＝起動時に use する並び（[p] か [[p, opts]]）
const BUILTIN_DATA_KINDS: GlobeScope["BUILTIN_DATA_KINDS"] = ["points", "arcs", "trips", "polygons", "paths", "columns"];
const pluginHost = createPluginHost(map, {
	getBackend: () => (dbgHost.__backend as string | undefined) || memBackend || (gpuBackend ? "webgpu" : "webgl2"),
	gadgetNames: () => Object.keys(map.gadget || {}), defineGadget: (name, fn) => (registerGadget as NonNullable<PluginHostOptions["defineGadget"]>)(name, fn), removeGadget: name => { delete (map.gadget as Record<string, unknown>)[name]; },
	tileFormats: { register: registerTileFormat as NonNullable<PluginHostOptions["tileFormats"]>["register"], has: hasTileFormat, names: tileFormatNames }, builtinTileFormats: tileFormatNames(),
	pointcloud: Object.fromEntries(POINTCLOUD_NAMES.map(n => [n, true])), builtinDataKinds: BUILTIN_DATA_KINDS, builtinPostEffects: POST_TYPES, builtinLights: LIGHT_TYPES,
});
map.use = (p, o) => pluginHost.use(p, o);
map.unuse = name => pluginHost.unuse(name);
map.plugins = () => pluginHost.plugins();
map.registry = pluginHost.registry;
map.supports = key => pluginHost.supports(key);
map.capabilities = () => pluginHost.capabilities();
ownDestroy.push(() => pluginHost.destroy());
let camPadding: GlobeLive["camPadding"] = { top: 0, right: 0, bottom: 0, left: 0 };
let followSt: GlobeLive["followSt"] = null;
// カメラ・光・空・太陽・雲の口＝src/api/camera.ts（live＝createGlobe の変数を読み書きする口）
const { clampCamLimits, tickFollow } = installCamera(map, {
	get maxPitchCur() { return maxPitchCur; }, set maxPitchCur(v) { maxPitchCur = v; },
	get zoomMinCur() { return zoomMinCur; }, set zoomMinCur(v) { zoomMinCur = v; },
	get camPadding() { return camPadding; }, set camPadding(v) { camPadding = v; },
	get zoomMaxCur() { return zoomMaxCur; },
	get camUpdateFn() { return camUpdateFn; },
	get centerElevFixed() { return centerElevFixed; }, set centerElevFixed(v) { centerElevFixed = v; },
	get centerElevMode() { return centerElevMode; }, set centerElevMode(v) { centerElevMode = v; },
	get minPitchCur() { return minPitchCur; },
	get camBounds() { return camBounds; },
	get dpr() { return dpr; },
	get czmlCtl() { return czmlCtl; },
	get followSt() { return followSt; }, set followSt(v) { followSt = v; },
	get flying() { return flying; },
	get mlLight() { return mlLight; }, set mlLight(v) { mlLight = v; },
	get mlSky() { return mlSky; }, set mlSky(v) { mlSky = v; },
}, { CAM_ZOOM_MIN, D2R, EARTH_M, MAXPITCH, R2D, animNow, cam, clock, flightCtl, flyTo, input, mapOn, onMove, opts, ownDestroy, pitchIn, pluginHost, reduceMotionOn, renderer, requestDraw, sendLight, sendSky, size, syncCenterAlt, unprojectXY, wPost });
// 宇宙（球の外側）の色（B5・エンジンの口）：色の文字列・"transparent"・null＝起動時の既定（MapLibre の口は透明・内製は紺）。GL2 の canvas は α を持つ＝透明なら頁の色が見える。WebGPU は白に畳む
// ── MapLibre の小口（B6・2026-10-12） ──
// sprite：読んだ記号の名前を sprite の id ごとに覚える（removeSprite／setStyle で消すため）。default 以外は "id:名前"
const spriteLoad: GlobeScope["spriteLoad"] = async (id, url) => {
	const c = await symGet(), before = new Set(c.listImages());
	await c.loadSprite(url, spritePrefix(id));
	spriteNames.set(id, c.listImages().filter(n => !before.has(n)));
};
const spriteDrop: GlobeScope["spriteDrop"] = id => { for (const n of spriteNames.get(id) || []) symCtl?.removeImage(n); spriteNames.delete(id); };
map.getSprite = () => spriteList.map(e => ({ id: e.id, url: e.url }));
map.addSprite = (id, url) => { id = String(id ?? "default"); spriteDrop(id); spriteList = [...spriteList.filter(e => e.id !== id), { id, url: String(url) }]; spriteLoad(id, new URL(url, location.href).href).catch(err => console.warn("[addSprite]", id, err)); return map; };
map.removeSprite = id => { id = String(id ?? "default"); spriteDrop(id); spriteList = spriteList.filter(e => e.id !== id); return map; };
map.setSprite = url => { for (const id of [...new Set([...spriteList.map(e => e.id), ...spriteNames.keys()])]) spriteDrop(id); spriteList = []; if (url) return map.addSprite("default", url); return map; };   // 全部入れ替え（MapLibre の setSprite）。null＝全部外す
map.getImage = name => { const e = symCtl?.getImage(name); if (!e?.bitmap) return undefined; const { bitmap: bm, pixelRatio = 1, sdf = false } = e;   // MapLibre の StyleImage の形（data＝RGBA の生画素）
	const cv = new OffscreenCanvas(bm.width, bm.height), g = cv.getContext("2d")!; g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, bm.width, bm.height);
	return { data: { width: d.width, height: d.height, data: d.data }, pixelRatio, sdf, version: 1, ...(e.stretchX ? { stretchX: e.stretchX } : {}), ...(e.stretchY ? { stretchY: e.stretchY } : {}), ...(e.content ? { content: e.content } : {}) }; };
map.getGlyphs = () => mlGlyphs ?? undefined;   // 文字は Canvas2D＝記録だけ（getStyle に echo）
map.setGlyphs = url => { mlGlyphs = url == null ? null : String(url); return map; };
map.getStyleUrl = () => EXT?.url ?? undefined;   // URL で起動した style の URL（object なら undefined）
map.getFontFaces = () => fontFacesList.map(f => ({ ...f }));
map.setFontFaces = async list => {   // [{ "font-family"|family, src, font-weight?, font-style?, unicode-range? }] → addFontFace（段 2 の口）。記録は getFontFaces に
	fontFacesList = Array.isArray(list) ? list.filter(f => f && typeof f === "object").map(f => ({ ...f })) : [];
	await Promise.all((fontFacesList.map(fontFaceArgs).filter(Boolean) as NonNullable<ReturnType<typeof fontFaceArgs>>[]).map(a => map.addFontFace(a.family, a.src as string | ArrayBuffer, a.descriptors).catch(err => console.warn("[setFontFaces]", a.family, err))));
	return map;
};
// タイルの取り直し（MapLibre の refreshTiles）：基図の source＝新 style で組み直す（生バイトは温間キャッシュ命中なら速い＝サーバまでは行かない）・利用者の source＝その source の層を外して載せ直す（geojson の URL は取り直す）
map.refreshTiles = async sid => {
	if (sid == null || sid === baseSidNow()) { setPipelineStyle(style); remergeBase(); return map; }
	const vs = [...mlLayers.values()].filter(v => srcId(v.layer) === sid);
	for (const v of vs) { if (mlVisible(v) && !v.mounting) { await unmountLayer(v); await mountLayer(v); } }
	return map;
};
// 今の画面を覆うタイル（MapLibre の coveringTiles）の近似：画面に 33×21 の点を散らして逆投影し、その点を含むタイルを集める（z＝MapLibre と同じ規則 mlcover.js・内製の目盛りでは cam.zoom の整数部）。
// 球の外・地平線の向こうの点は落ちる＝縁のタイルを取りこぼすことはある。戻り＝[{ canonical:{x,y,z}, overscaledZ, wrap:0, key }]
map.coveringTiles = (o = {}) => {
	const tileSize = o.tileSize || 512, W = size.w / dpr, H = size.h / dpr, pts = [];
	const zf = mlZoomOf(tileSize, !!o.roundZoom);
	const zAt = (lon: number, lat: number) => { if (!zf) return Math.floor(cam.zoom + Math.log2(512 / tileSize)); if (zf.key?.startsWith("c")) return (zf as unknown as () => number)(); const z0 = Math.max(0, Math.floor(cam.zoom - (ML_COVER?.dz || 0) + Math.log2(512 / tileSize))); const [x, y] = tileOfLL(lon, lat, z0); return zf(z0, x, y); };
	for (let j = 0; j <= 20; j++) for (let i = 0; i <= 32; i++) { const ll = unprojectXY(W * i / 32, H * j / 20); pts.push(ll ? [(ll as LonLat & { lng?: number }).lng ?? ll[0], (ll as LonLat & { lat?: number }).lat ?? ll[1]] : null); }
	return tilesFromPoints(pts, zAt, { minzoom: o.minzoom ?? 0, maxzoom: o.maxzoom ?? 25 });
};
const tileOfLL = (lon: number, lat: number, z: number) => { const n = 2 ** z, la = Math.max(-85.05, Math.min(85.05, lat)) * D2R; return [Math.floor(((lon + 180) / 360 % 1 + 1) % 1 * n), Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)]; };
map.setSourceTileLodParams = (maxZoomLevelsOnScreen, tileCountMaxMinimum) => {   // MapLibre 同名＝タイルの z の規則の 2 定数（mlcover.js の maxLevels・maxMinRatio）。内製の目盛り（ML_COVER 無し）では効かない
	if (ML_COVER) { if (Number.isFinite(+maxZoomLevelsOnScreen)) ML_COVER.maxLevels = +maxZoomLevelsOnScreen; if (Number.isFinite(+tileCountMaxMinimum)) ML_COVER.maxMinRatio = +tileCountMaxMinimum; requestDraw(); onMove(); }
	return map;
};
map.setCameraUpdate = fn => { camUpdateFn = typeof fn === "function" ? fn : null; onMove(); return map; };   // MapLibre の setTransformCameraUpdate＝制約の後に {center, zoom, pitch, bearing, roll, elevation} を書き換える。zoom は内製の目盛り（cam.zoom）＝shim が MapLibre の目盛りに往復する
map.setMinPitch = deg => { minPitchCur = Math.max(0, Math.min(maxPitchCur, (+deg || 0) * D2R)); if (cam.pitch < minPitchCur) { flightCtl.cancel(); cam.pitch = minPitchCur; onMove(); } return map; };   // 度（MapLibre の口と同じ・setMaxPitch の rad とは違う＝新しい口は度で揃える）
map.getMinPitch = () => minPitchCur * R2D;
map.setPixelRatio = r => { r = Math.max(0.5, Math.min(4, +r || 1)); if (r === dpr) return map; dpr = r; cam.dpr = r; resize(); return map; };   // 描く解像度（CSS px あたりの画素）。星空劇場・overlay の内部の dpr は起動時の値のまま
map.getPixelRatio = () => dpr;
map.setRepaint = on => { repaintAlways = !!on; if (on) requestDraw(); return map; };   // 連続描画（計測用）
map.getRepaint = () => repaintAlways;
// debug の表示（MapLibre の showTileBoundaries・showPadding）＝main の canvas2D 1 枚（#labels の上・操作は通す）
let dbgCanvas: HTMLCanvasElement | null = null;
const dbgCtx = (): CanvasRenderingContext2D => { if (!dbgCanvas) { dbgCanvas = document.createElement("canvas"); dbgCanvas.id = "debug"; Object.assign(dbgCanvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" }); (labelGpuCanvas ?? labelCanvas).insertAdjacentElement("afterend", dbgCanvas); } if (dbgCanvas.width !== size.w || dbgCanvas.height !== size.h) { dbgCanvas.width = size.w; dbgCanvas.height = size.h; } return dbgCanvas.getContext("2d")!; };
function drawDebug() {
	const g = dbgCtx(); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size.w, size.h);
	if (dbgState.tileBoundaries) {
		const P = makeProjector(); g.lineWidth = 1; g.strokeStyle = "rgba(255,0,0,.8)"; g.fillStyle = "rgba(255,0,0,.9)"; g.font = "11px system-ui, sans-serif";
		for (const o of (lastCoverOrder && lastCoverOrder.length ? lastCoverOrder : map.coveringTiles())) {   // 基図が無い（空の style）時は coveringTiles の近似で引く
			const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(o.key); if (!m) continue;
			const z = +m[1], x = +m[2], y = +m[3], n = 2 ** z, lonOf = (i: number) => x / n * 360 - 180 + i * 360 / n, latOf = (j: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + j) / n))) * R2D;
			const ring = []; for (let k = 0; k <= 8; k++) ring.push([lonOf(k / 8), latOf(0)]); for (let k = 1; k <= 8; k++) ring.push([lonOf(1), latOf(k / 8)]); for (let k = 7; k >= 0; k--) ring.push([lonOf(k / 8), latOf(1)]); for (let k = 7; k >= 1; k--) ring.push([lonOf(0), latOf(k / 8)]);
			const pts = ring.map(([lo, la]) => P(lo, la)); if (pts.some(p => !(p[2] > 0) || !Number.isFinite(p[0]))) continue;
			g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
			const c = P(lonOf(0.5), latOf(0.5)); if (c[2] > 0) g.fillText(o.key, c[0] + 3, c[1] - 3);
		}
	}
	if (dbgState.padding) { const p = camPadding, W = size.w / dpr, H = size.h / dpr; g.fillStyle = "rgba(0,120,255,.18)"; g.fillRect(0, 0, W, p.top); g.fillRect(0, H - p.bottom, W, p.bottom); g.fillRect(0, p.top, p.left, H - p.top - p.bottom); g.fillRect(W - p.right, p.top, p.right, H - p.top - p.bottom); g.strokeStyle = "rgba(0,120,255,.9)"; g.lineWidth = 1; g.strokeRect(p.left + .5, p.top + .5, W - p.left - p.right - 1, H - p.top - p.bottom - 1); }
}
map.setDebug = (o = {}) => { for (const k of ["tileBoundaries", "padding"] as const) if (k in o) dbgState[k] = !!o[k]; if (!dbgState.tileBoundaries && !dbgState.padding) { if (dbgCanvas) dbgCtx().clearRect(0, 0, size.w, size.h); } else requestDraw(); return map; };
map.getDebug = () => ({ ...dbgState });
map.setClearColor = c => { clear = clearOf(c) ?? (ML_COVER ? [0, 0, 0, 0] : [0.03, 0.04, 0.07, 1]); renderer.set("view", { clear }); requestDraw(); return map; };
map.setMaxBounds = b => {
	if (b == null) camBounds = null;
	else { const v = Array.isArray(b[0]) ? [(b as LonLat[])[0][0], (b as LonLat[])[0][1], (b as LonLat[])[1][0], (b as LonLat[])[1][1]] : b as number[]; if (v.length >= 4 && v.every(Number.isFinite)) { const e = wrapLon(v[2]); camBounds = [wrapLon(v[0]), v[1], e === -180 && v[2] > v[0] ? 180 : e, v[3]]; } }   // 東端の 180 は 180 のまま（wrapLon は [-180,180) に畳む＝[-180,…,180] が幅 0 の可動域にならないように）
	onMove(); return map;
};
map.getMaxBounds = () => camBounds ? [...camBounds] : null;
map.setMinZoom = z => { map.setZoomMin(z); return map; };
map.getMinZoom = () => zoomMinCur;
map.setMaxZoom = z => { zoomMaxCur = z == null ? ZOOM_MAX : Math.max(zoomMinCur, Math.min(ZOOM_MAX, z)); onMove(); return map; };
map.getMaxZoom = () => zoomMaxCur;
map.getCenter = () => ({ lng: cam.center[0], lat: cam.center[1] });
map.getPitch = () => cam.pitch * R2D;
map.getBearing = () => cam.bearing * R2D;
// roll（視線まわりの回転・度・MapLibre 同名・2026-10-12 A1）と縦の視野角（度・MapLibre の setVerticalFieldOfView・エンジン既定 50°・MapLibre の既定は 36.87°）
map.getRoll = () => (cam.roll || 0) * R2D;
map.setRoll = r => map.jumpTo({ roll: r });
map.getVerticalFieldOfView = () => (cam.fovy || 50 * D2R) * R2D;
map.setVerticalFieldOfView = deg => { const v = +deg; if (!Number.isFinite(v)) return map; cam.fovy = Math.max(1, Math.min(170, v)) * D2R; onMove(); return map; };   // ズーム↔距離の式は fovy を含む＝同じ z で地表の縮尺は変わらずカメラの距離が変わる（MapLibre と同じ）
map.setCenter = c => map.jumpTo({ center: c });
map.setZoom = z => map.jumpTo({ zoom: z });
map.setPitch = p => map.jumpTo({ pitch: p });
map.setBearing = b => map.jumpTo({ bearing: b });
map.isMoving = () => flightCtl.active || moving;
map.stop = () => { flightCtl.cancel(); input.stop(); followSt = null; return map; };
// 手触りの handler（A2・2026-10-12）：MapLibre の map.scrollZoom.disable() 等の実体。名前＝scrollZoom・dragPan・dragRotate・keyboard・doubleClickZoom・boxZoom・touchZoomRotate・touchRotate・touchPitch・cooperativeGestures
map.setHandler = (name, on) => { input.setHandler(name, on); return map; };
map.handlerOn = name => input.handlerOn(name);
map.setZoomSnap = v => { input.setZoomSnap(v); return map; };
map.getZoomSnap = () => input.zoomSnap();
// 時計と動き（C10・2026-10-12）：setNow(ms)＝動きの時計を ms に止める（続けて呼べば進む・飛行／transition／共通の時計の刻みが従う）・restoreNow＝実時間へ・getNow＝今の動きの時計。
// setReduceMotion(true|false|null)＝動きを減らす（null＝OS の prefers-reduced-motion を追う）・getReduceMotion＝今の値
map.setNow = ms => { nowPin = Number.isFinite(+ms) ? +ms : null; requestDraw(); return map; };
map.restoreNow = () => { nowPin = null; clockLastT = performance.now(); requestDraw(); return map; };
map.getNow = () => animNow();
map.setReduceMotion = v => { reduceMotionOpt = typeof v === "boolean" ? v : null; return map; };
map.getReduceMotion = () => reduceMotionOn();
// 建物 3D（地域の建物メッシュ＝日本は PLATEAU LOD2）を出す／伏せる（2026-10-21・横浜：引いた縮尺で区ごとに有る／無いを出さない）。
// 伏せている間は表示も新しい読み込みもしない（常駐は保つ＝戻すと即）。opts.mesh=false の地図では何もしない（getMeshVisible は false）
map.setMeshVisible = on => { meshVisible = !!on; meshReal?.setVisible(meshVisible); requestDraw(); return map; };
map.getMeshVisible = () => meshOn && meshVisible;
// 基図の表示項目（opts.layers と同じキー：place地名/terrain地形/rail鉄道/road道路/facility施設）を実行時に点ける／消す（2026-10-21・横浜：平面の地区図は全層）。
// チップと同じ正規経路（setLayer＝見た目・副作用・共有URL）。opts.layers で固定したキーと未知のキーは黙って無視（埋め込み主の固定は破れない）
map.setBaseLayers = o => { for (const [k, v] of Object.entries(o || {})) if (FREE_LAYER_KEYS.includes(k) && typeof v === "boolean") setLayer(k, v); return map; };
map.getBaseLayers = () => ({ place: layerState.place, terrain: layerState.terrain, rail: layerState.rail, road: layerState.road, facility: layerState.facility });
// 見えている範囲の概算 [w, s, e, n]（画面四隅と辺の中点を逆投影・球外の点は捨てる＝全球が見える時は null）
map.getBounds = () => {
	const W = size.w / dpr, H = size.h / dpr, pts = [];   // CSS px（unprojectXY の座標系）
	for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) { const ll = unprojectXY(fx * W, fy * H); if (ll) pts.push(ll); }
	if (pts.length < 9) return null;
	const c = cam.center[0];
	const xs = pts.map(p => c + wrapLon(p[0] - c)), ys = pts.map(p => p[1]);
	return [wrapLon(Math.min(...xs)), Math.min(...ys), wrapLon(Math.max(...xs)), Math.max(...ys)];
};
map.userPbf = () => gint.userGint?.pbf ?? null;   // 表示中のユーザー gint（ドロップ/?g=）の geopbf＝編集ガジェットへの受け渡し口（同じデータを一手で編集へ）
map.onFrame = fn => { frameHooks.add(fn); return () => frameHooks.delete(fn); };
const { overlays, isOv, pickWait, orderSnapOverlays, overlayFeature } = installOverlays(map, { mapEl, labelCanvas, size, wPost });   // 同一フレームのオーバーレイの口＝src/api/overlays.ts
// ★互換：map.overlay は 9/20（c246591a）まで「estat 小地域・geopbf オーバーレイ・選択マスク・identify の手綱」（上の overlay）だった。
// 同一フレーム overlay の関数で上書きした結果、census2020（bind.js の map.overlay.loadEstat/setIdentifyHandler、
// choropleth.js の setSelectionMask）が本番で起動に失敗していた（2026-09-23 実測）。関数のまま器のメソッドも載せる＝
// map.overlay(url)（quakes/anno）と map.overlay.loadEstat(...)（census2020）の両方が無傷。正式な別名は裁定待ち。
Object.assign(map.overlay, overlay);   // globe の器（setSelectionMask/setHoverOutline/loadOverlay/clearOverlay）。e-Stat の口は日本の install が map.estat と同名に足す
map.onGintClick = fn => { gint.clickHandler = fn as typeof gint.clickHandler; };
Object.defineProperty(map, "backend", { get: () => dbgHost.__backend ?? null, enumerable: true });   // "webgpu"|"webgl2"|null（frame1 前）
// 外来の標高タイル（#36）の DEM（demMain）と 1 点の標高（heightAt）は elevOf の所＝DOM オーバーレイの持ち上げと同じ出どころ
// 地形と標高の口・一人称歩行＝src/api/terrain.ts（live＝createGlobe の変数を読み書きする口）
installTerrain(map, {
	get mlSources() { return mlSources; },
	get EXT() { return EXT; },
	get demSpec() { return demSpec; }, set demSpec(v) { demSpec = v; },
	get demMain() { return demMain; }, set demMain(v) { demMain = v; },
	get geGen() { return geGen; }, set geGen(v) { geGen = v; },
	get geBusy() { return geBusy; }, set geBusy(v) { geBusy = v; },
	get geKey() { return geKey; }, set geKey(v) { geKey = v; },
	get elevGen() { return elevGen; }, set elevGen(v) { elevGen = v; },
	get noTerr() { return noTerr; }, set noTerr(v) { if (v !== noTerr) { noTerr = v; setPipelineDrape(); } },   // 地形の有無が替わる（setTerrain）＝線の細分（drape）を読み直し全タイルを再ビルド（§3.2・setStyle と同じ道）
	get style() { return style; },
	get baseSidNow() { return baseSidNow; },
	get modelCtl() { return modelCtl; },
}, { EARTH_M, cam, elevMemo, elevOf, heightAt, pluginHost, qmSpecOf, requestDraw, requester, terrLazy, wPost });
let videoCtl: GlobeLive["videoCtl"] = null;
// 画像タイル層（map.raster）＝src/api/raster.ts（live＝createGlobe の変数を読み書きする口）
const { onRasterInfo, onRasterError, rasterStatWait, rasterAttrHTML, imageAttrs, rasterChanged, protocolBitmap } = installRaster(map, {
	get attrZone() { return attrZone; }, set attrZone(v) { attrZone = v; },
	get videoCtl() { return videoCtl; }, set videoCtl(v) { videoCtl = v; },
	get iiifOpen() { return iiifOpen; },
	get rasterBoot() { return rasterBoot; }, set rasterBoot(v) { rasterBoot = v; },
}, { LOW_MEM, REGION_RASTERS, TILE_BIAS, URL_OWN, opts, ownDestroy, rasterBootQ, requestDraw, requester, t, wPost });
// 組み込みの gadget（登録口 registerGadget と各 gadget）＝src/api/gadgets.ts（live＝createGlobe の変数を読み書きする口）。戻りの registerGadget で後の gadget を登録する
const { registerGadget } = installGadgets(map, {
	get mapEl() { return mapEl; },
	get themeName() { return themeName; },
	get zoomMinCur() { return zoomMinCur; },
	get measureClick() { return measureClick; }, set measureClick(v) { measureClick = v; },
	get measureBody() { return measureBody; }, set measureBody(v) { measureBody = v; },
	get profileClick() { return profileClick; }, set profileClick(v) { profileClick = v; },
	get profileBody() { return profileBody; }, set profileBody(v) { profileBody = v; },
	get renderBackend() { return renderBackend; },
}, { REGION_BLD_ICON, REGION_BLD_LABELS, REGION_SEARCH, ZOOM_MAX, ac, cam, demFirst, flightCtl, frameHooks, getHeightP, makeProjector, meshMgr, meshOn, narrowMq, onMove, projectLL, requestDraw, requestSnapshot, saveView, size, switchTheme, themeFixed, toolClose, toolOpen, unprojectAt, unprojectXY });
let clipSpec: GlobeLive["clipSpec"] = null, clipMain: GlobeLive["clipMain"] = null, clipByT: GlobeLive["clipByT"] = null;   // 今の切り方（公開面の写し）・main 側の面（vector＝識別と問い合わせ）・対象ごとの面（段 4）
// 日影・影・切断・可視域・gadget・POI 編集＝src/api/shadows.ts（live＝createGlobe の変数を読み書きする口）
const { elevGridWait, clipFor, clipCutXY, clipAllCut } = installShadows(map, {
	get clipByT() { return clipByT; }, set clipByT(v) { clipByT = v; },
	get renderBackend() { return renderBackend; },
	get clipSpec() { return clipSpec; }, set clipSpec(v) { clipSpec = v; },
	get clipMain() { return clipMain; }, set clipMain(v) { clipMain = v; },
	get mapLoaded() { return mapLoaded; },
	get addSourceAt() { return addSourceAt; },
	get addLayerAt() { return addLayerAt; },
	get noTerr() { return noTerr; },
	get EXT() { return EXT; },
	get poiReal() { return poiReal; },
	get poiClick() { return poiClick; }, set poiClick(v) { poiClick = v; },
}, { BASE_SOURCE, D2R, LOW_MEM, REGION_DTM, REGION_HOME, REGION_PRINT_ATTR, TILE_MINZOOM, ac, approxViewBbox, attrTextNow, cam, dbgHost, makeProjector, mapOn, meshMgr, meshOn, onMove, ownDestroy, registerGadget, poi, printCapture, renderer, requestDraw, requestSnapshot, setLayer, t, toolClose, toolOpen, unprojectXY, viewHash, wPost, wakeMesh });
let gFollow: GlobeLive["gFollow"] = null;   // ?g= の視野追従（別の図形を読んだら止める＝loadUserFile の頭・ドロップの消去）
let columnarCtl: GlobeLive["columnarCtl"] = null;
// データを載せる口（シーン台本・フィーチャーサービス・addColumnar・addThree・addData・addCells 等）＝src/api/data.ts（live＝createGlobe の変数を読み書きする口）
const { scenes, readGeoData, remoteUrl, setSrcAttr, columnarOn, columnarView, columnarProbe, sourceData, dropFollow, fsFollow } = installData(map, {
	get mapEl() { return mapEl; },
	get themeName() { return themeName; },
	get elevBusy() { return elevBusy; },
	get vtxAttrs() { return vtxAttrs; },
	get attrZone() { return attrZone; }, set attrZone(v) { attrZone = v; },
	get remountSource() { return remountSource; },
	get gFollow() { return gFollow; }, set gFollow(v) { gFollow = v; },
	get annoCtl() { return annoCtl; },
	get czmlCtl() { return czmlCtl; },
	get editDocHook() { return editDocHook; },
	get loadUserFile() { return loadUserFile; },
	get columnarCtl() { return columnarCtl; }, set columnarCtl(v) { columnarCtl = v; },
}, { BUILTIN_DATA_KINDS, CAM_ZOOM_MIN, ELL_ON, LOW_MEM, REGION_BLD_LABELS, ac, applyCamView, applyViewLayers, cam, canvas, dbgHost, flightCtl, flyView, gint, gpuBackend, hostWorker, meshMgr, meshOn, onMove, opts, overlays, ownDestroy, pluginHost, requestDraw, requester, saveView, setGSrc, switchTheme, themeBootV, themeFixed, viewHash });
// 注釈レイヤ（geoedit の @スタイル付き geopbf を canvas2D で再生・単一スロット）＝本体は遅延chunk（起動を重くしない）
let annoCtl: GlobeLive["annoCtl"] = null;
registerGadget("anno", async (_map, pbf) => {
	const m = await import("./gadgets/anno.ts");
	annoCtl ??= m.createAnno(map, { signal: ac.signal });
	annoCtl.set(pbf);
	return annoCtl;
});
// COG（Cloud Optimized GeoTIFF）＝geopbf/cog リーダ→cogTex スロット（GLOBE/TERRAIN FS がドレープ）。本体は遅延chunk。
// setCogTex は wPost 直（transfer 付き＝2048²RGBA 16MB の structured clone コピーを回避）
let cogCtl: GlobeLive["cogCtl"] = null;
registerGadget("cog", async (_map, src, opts) => {
	const m = await import("./gadgets/cog.ts");
	cogCtl ??= m.createCog(map, {
		setCogTex: d => wPost({ type: "set", cmd: "cogTex", data: d, prop: null }, (d as { rgba?: { buffer?: ArrayBuffer } } | null)?.rgba?.buffer ? [(d!.rgba as Uint8Array).buffer] : []),
		fit: bb => {   // loadUserFile の fit と同じ視野幅逆解き（30%余白・真俯瞰・北向き）
			const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
			const wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);
			const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
			flyTo(cx, cy, Math.max(3, Math.min(17, z)), 0);
		},
		lowMem: LOW_MEM, signal: ac.signal,
	});
	await cogCtl.load(src, opts);
	return cogCtl;
});
registerGadget("raster", (m, o) => {   // 画像タイル（ラスタ）の切替＝地域パックのカタログ＋map.raster（select/toggle）。表示域は搭載側の zoom 宣言
	return rasterGadget.call(m, { raster: map.raster, catalog: REGION_RASTERS, signal: ac.signal, ...o });
});
// ── スポットライト（本人裁定 2026-09-23「その国の周りを低いオパシティのマスクで覆って、国の形がわかるように」）──────────────
// map.gadget.spotlight(src, { opacity, fit, color }) ＝ 渡した面の「外側」を薄く覆い、その面だけ素の地図のまま残す
//（census の小地域の選択＝周辺マスクと同じ器＝overlayHi の1スロット。線は引かない＝マスクの縁が形を示す）。
//   src … 国の記号（"JP" / "JPN" / "Japan" / { iso2 | iso3 | qid | name }）か GeoJSON（Feature / FeatureCollection / geometry）
//         記号の時はエンジンが持つ世界の国の形（Natural Earth admin_0・LOW_MEM は 50m・他は 10m）から引く＝呼ぶ側はデータを持たなくてよい
//   fit … その国が収まる所まで寄る（既定 true）。opacity … 外側の濃さ（0-1・既定 0.55）
//   戻り … { bbox, name, clear() }（見つからなければ null）
// スポットライト＝「この形を指す」口。周りを薄い黒で覆い、渡された形だけ素の地図を残す（world の国の地図・2026-09-23）。
// 形は**呼び手が持ってくる**（world は自分の DB＝ne-cultural を key で引いて渡す）＝エンジンは国の身分を知らない。
// 文字列（ISO 3166-1 の 2/3 字）も受けるが、これは世界の行政界（Natural Earth）を持っているエンジンの厚意であって、
// 名前や別名での当て推量はしない（当てられなければ null）。
const spotFeature = async (src: SpotShape | null | undefined): Promise<SpotFeature | null> => {
	if (!src) return null;
	if (src.type === "FeatureCollection") {   // 複数の面＝1 枚の MultiPolygon に束ねる（マスクの扇は巻き数＝接する県境は相殺されない）
		const polys: unknown[] = [];
		for (const f of src.features || []) { const g = f?.geometry; if (g?.type === "Polygon") polys.push(g.coordinates); else if (g?.type === "MultiPolygon") polys.push(...(g.coordinates as unknown[])); }
		return polys.length ? { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: polys } } : null;
	}
	if (src.type === "Feature") return src;
	if (src.type && src.coordinates) return { type: "Feature", properties: {}, geometry: src as SpotGeom };
	const up = String(src).trim().toUpperCase();
	if (!up) return null;
	const pbf = await gint.ensureAdmin0().catch(e => { console.warn("[spotlight] admin0", e); return null; });
	const feats = pbf?.features || pbf?.geojson?.features || [];
	return feats.find(f => { const p = f?.properties || {}; return [p.ISO_A2, p.ISO_A3, p.ISO_A2_EH, p.ISO_A3_EH].some(v => v && String(v).toUpperCase() === up); }) || null;
};
const spotBbox = (geom: { coordinates?: unknown } | null | undefined): Bbox | null => {   // 渡された形の外接矩形（経度は跨ぎを解く＝日付変更線でも幅が正しい）
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, lon: number | null = null;
	const walk = (c: NestedCoords): void => { if (Array.isArray(c[0])) { c.forEach(walk); return; } lon = lon == null ? c[0] : c[0] + 360 * Math.round((lon - c[0]) / 360); if (lon < x0) x0 = lon; if (lon > x1) x1 = lon; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; };
	geom?.coordinates && walk(geom.coordinates as NestedCoords);
	return x0 <= x1 ? [x0, y0, x1, y1] : null;
};
// src＝GeoJSON（Feature/FeatureCollection/Geometry）か ISO コード。null で解除。
// 戻り＝{ bbox, clear() }。fit＝外接矩形へ寄る（既定 true・寄り先を自分で決める呼び手は false）／pad＝余白／maxZoom＝寄りの上限。
registerGadget("spotlight", async (m, src, { opacity = 0.55, fit: doFit = true, color = null, pad = 1.25, maxZoom = null } = {}) => {
	if (src == null) { overlay.setSelectionMask(null); return null; }   // null＝解除
	const f = await spotFeature(src as SpotShape);
	if (!f?.geometry) { console.warn("[spotlight] no shape", src); return null; }
	overlay.setSelectionMask(f.geometry, { color: color || [0, 0, 0, opacity] });
	const bbox = spotBbox(f.geometry);
	if (doFit && bbox) {   // 中心は ±180 へ畳んで渡す（矩形は跨ぎを解いたまま＝幅が正）
		const z = gint.fitZoomForBbox(bbox) - Math.log2(Math.max(1, pad));
		flyTo(wrapLon((bbox[0] + bbox[2]) / 2), (bbox[1] + bbox[3]) / 2, maxZoom == null ? z : Math.min(z, maxZoom), 0, 0);
	}
	return { bbox, clear: () => overlay.setSelectionMask(null) };
});
// 輪郭＝「この形の線だけ」（ホバーの合図）。src は spotlight と同じ（GeoJSON か ISO コード）・null で消す。
// マスク（overlayHi）とは別スロット＝スポットライトと両立する。色は [r,g,b,a]（0..1）・width は px。
registerGadget("outline", async (m, src, { color = null, width = 1.6 } = {}) => {
	if (src == null) { overlay.setHoverOutline(null); return null; }
	const f = await spotFeature(src as SpotShape);
	if (!f?.geometry) return null;
	overlay.setHoverOutline(f.geometry, { color: color || undefined, width });
	return { clear: () => overlay.setHoverOutline(null) };
});
registerGadget("globe", (m, o) => {   // ミニ地球儀（右下・視野の枠・z≤8）… 追従は render のフック（戻り値 update を掴む）
	const u = globeGadget.call(m, { signal: ac.signal, ...o });
	if (u) { frameHooks.add(u); u(); }
	return u;
});
// glTF/GLB（3D 模型）＝PLATEAU と同じ建物メッシュとして立てる（gadgets/model.js・遅延chunk・2026-09-20）。落とした地点（無ければ画面中心）の ENU に置く／
// CESIUM_RTC・ECEF 入りの glb は埋め込みを信じる。描画は renderer の meshSet スロット（wPost 直・transfer）＝建物 3D と同じシェーダ。
let modelCtl: ModelLive | null = null;
const modelCtlGet = async (): Promise<ModelLive> => {
	const m = await import("./gadgets/model.ts");
	if (modelCtl) return modelCtl;
	modelCtl = dbgHost.__model = m.createModel(map, {   // __model＝検証窓（t-model・押し出し）
		setMeshXf: (name, data) => { wPost({ type: "set", cmd: "meshXf", data, prop: name }); requestDraw(); },   // バッチの剛体変換（glTF の rigid アニメ・W4）＝Float32Array(12)｜null
		setMeshCol: (name, data) => { wPost({ type: "set", cmd: "meshCol", data, prop: name }, [data.buffer]); requestDraw(); },   // feature state の色（W7）＝頂点色の列（RGBA8）
		pickEnv: meshPickEnv,   // 当たり（W7）＝画面の点 → 三角形と地物の番号
		setMesh: (name, data) => { wPost({ type: "set", cmd: "meshSet", data, prop: name }, data ? [...new Set([data.pos.buffer, data.nrm.buffer, data.idx.buffer, data.uv?.buffer, data.col?.buffer, ...["tex", "texMR", "texN", "texOcc", "texEm"].flatMap(k => [(data[k] as TileTex | undefined)?.bitmap, (data[k] as TileTex | undefined)?.rgba?.buffer])].filter(Boolean) as Transferable[])] : []); requestDraw(); },   // uv/頂点色/テクスチャ（ImageBitmap）も transfer
		fit: bb => {   // 模型へ寄る＝loadUserFile の fit と同じ視野幅逆解き。ただしチルト 55°（建物メッシュは真俯瞰 pitch<0.02 では描かない＝寄って何も無いを避ける）
			const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
			const wDeg = Math.max(2e-5, (bb[2] - bb[0]) * 2.5), hDeg = Math.max(2e-5, (bb[3] - bb[1]) * 2.5);
			const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
			flyTo(cx, cy, Math.max(3, Math.min(18, z)), 55);
		},
		center: () => [cam.center[0], cam.center[1]], ell: ELL_ON, signal: ac.signal,
	}) as ModelLive;
	return modelCtl;
};
registerGadget("model", async (_map, src, opts) => {
	return (await modelCtlGet()).load(src, opts);
});
// 任意ポリゴンの 3D 押し出し（MapLibre の fill-extrusion 相当・2026-09-21）＝模型と同じ建物メッシュ経路（worker で earcut→finishMesh）。
//   src＝GeoJSON（Feature/FeatureCollection/features 配列）・GeoPBF（.geojson を持つもの）・File・URL。
//   opts＝{ height: 鍵名|数|(props)=>m（省略＝height/measuredHeight/高さ…を自動・階数×3m）, base, color: css|(props,h)=>css（省略＝@fill→段彩）,
//          scale（高さの倍率）, mask（足元の基図建物を伏せる・既定 "auto"＝建物らしい大きさの時だけ）, fit（寄る・既定 true・傾きは今のまま） }。
//   MapLibre の書き方もそのまま：opts に { type:"fill-extrusion", paint:{ "fill-extrusion-height"/"-base"/"-color"/"-opacity": 式 }, filter: 式 }、
//   または src に層を丸ごと（source:{ type:"geojson", data }）。式は基図と同じ評価器・色の interpolate も可・既定値は MapLibre の仕様どおり。null を渡すと外す。戻り値＝stats か null（立つ面なし）
registerGadget("extrude", async (m, src: ExtrudeIn, opts: ExtrudeOptsIn = {}) => {
	if (src == null) { (await modelCtlGet()).clearExtrude(opts.slot ?? "default"); return null; }   // slot＝addLayer の層 id（#34・既定 "default"＝ガジェット直呼びの 1 枠）
	// MapLibre の層を丸ごと（{ type:"fill-extrusion", source:{ type:"geojson", data }, paint, filter }）＝source.data を読み、層は opts へ
	if (src && (src as ExtrudeOptsIn).type === "fill-extrusion" && !opts.paint) { const layer = src as ExtrudeOptsIn; src = (layer.source as { data?: ExtrudeIn } | undefined)?.data ?? layer.source as ExtrudeIn; opts = { ...layer, ...opts }; delete opts.source; delete opts.id; }
	if (opts.type === "fill-extrusion" || opts.paint || opts.filter != null) { assertMLLayer(opts as Partial<MLLayer>, "extrude"); opts = normalizeMLLayer(opts as MLLayer, PUBLIC_DZ) as ExtrudeOptsIn; }   // MapLibre 形＝入口 1 本（ネイティブの opts＝height/color の関数などは素通し）
	return extrudeNative(src, opts);
});
// 中身（native）＝MapLibre 形の層は正規化済みで受ける。addLayer の描き出しはこちらを直に呼ぶ
async function extrudeNative(src: ExtrudeIn, opts: ExtrudeOptsIn = {}) {
	const c = await modelCtlGet();
	let gj: unknown = src;
	if (typeof src === "string" || src instanceof Blob) gj = await readGeoData(src);   // URL＝requester で直に（proxy を通らない・#176）
	else if (!(src as GjLike).type && !Array.isArray(src) && (src as GjLike).geojson) gj = (src as GjLike).geojson;
	const { fit: doFit = true, ...rest } = opts;
	const st = await c.extrude(gj as ExtrudeSrc, { zoom: cam.zoom, ...rest, fit: false } as ModelExtrudeOptions);   // zoom＝式の ["zoom"]（評価は呼んだ時に一度＝ズーム追随は呼び直し。gint の paintTable と同じ約束）
	if (doFit && st?.bbox) {   // 寄る＝今の傾きのまま（押し出しでも傾けない＝本人裁定 9/21）
		const bb = st.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, wDeg = Math.max(2e-5, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(2e-5, (bb[3] - bb[1]) * 1.3);
		const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
		flyTo(cx, cy, Math.max(3, Math.min(18, z)), (cam.pitch || 0) * R2D, (cam.bearing || 0) * R2D);
	}
	return st;
}
// 衛星シーン検索（STAC＝Earth Search→選んだシーンの COG を球へ）。スタブ＝ボタンのみ常駐・本体は初回クリック
registerGadget("stac", (m, opts) => {
	return stacGadget.call(m, { loadCog: (src, o) => map.gadget.cog(src, o), clearCog: () => cogCtl?.clear(), signal: ac.signal, ...opts });
});
// ── IIIF の古地図を基準点で重ねる（#177・Georeference Annotation＝Allmaps 互換）──
// 注記（URL か object・1 枚でもページでも）→ geopbf/georef で解く（変換＝多項式・TPS・射影・Helmert＝自前）→ iiif-worker が IIIF の段とタイルを選んで焼く。
// 地面に貼るだけ（画像タイル層・本人裁定）。出典＝spec.attribution → manifest の requiredStatement／attribution → info.json の attribution。
// 取得は requester（transformRequest）＝新しい口（従来の道は無い）。IIIF のタイルは worker が直に（公開の画像サーバー）
const iiifText = (v: IiifVal): string => v == null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map(iiifText).filter(Boolean).join(" ") : typeof v === "object" ? iiifText(v.none ?? v.en ?? v["@value"] ?? v.value ?? Object.values(v)[0]) : String(v);
async function iiifOpen(src: string | object, attribution: string | null | undefined) {
	const G = await import("geopbf/georef");
	let ann = src, base = location.href;
	if (typeof src === "string") { base = new URL(src, location.href).href; const r = await requester.fetch(base, "Source"); if (!r.ok) throw new Error(`iiif: HTTP ${r.status} ${src}`); ann = await r.json(); }
	const maps = G.parseGeoreference(ann);
	for (const m of maps) { m.image.id = new URL(m.image.id!, base).href; if (m.image.manifest) m.image.manifest = new URL(m.image.manifest, base).href; }   // 相対の id＝注記の置き場所から（worker は自分の URL を基準にしてしまう）
	if (!maps.length) throw new Error("iiif: no georeferenced image in the annotation (motivation \"georeferencing\" with resourceCoords)");
	if (attribution == null) {   // manifest の表示義務（requiredStatement／v2 attribution）＝取れなければ info.json の attribution（worker）
		const ids = [...new Set(maps.map(m => m.image.manifest).filter(Boolean) as string[])];
		const parts = await Promise.all(ids.map(async u => { try { const m = await (await requester.fetch(u, "Source")).json(); return iiifText(m.requiredStatement?.value ?? m.attribution) || null; } catch { return null; } }));
		attribution = parts.filter(Boolean).join(" · ") || null;
	}
	const fallback = [...new Set(maps.map(m => { try { return new URL(m.image.id!).host; } catch { return null; } }).filter(Boolean))].join(" · ") || null;   // 宣言がどこにも無い＝画像サーバーのホスト名（無出典で他人の画像を出さない）
	return { maps, attribution, fallback };
}
// ?iiif=<注記の URL>（Allmaps の注記 URL も・門は ?g= と共用＝https 限定）＝重ねの画像タイル層・範囲へ寄る（URL に視点があればそれが勝つ）
{
	const iSpec = new URLSearchParams(location.search).get("iiif");
	const u = iSpec ? remoteUrl(iSpec, "iiif") : null;
	if (u) { const off = map.onFrame(() => { off(); map.raster.add("iiif", { iiif: u.href }, { order: "over", opacity: 1, hideFills: false }).then(info => { const b = info?.bbox || map.raster.info("iiif")?.bbox; if (b && !themeBootV) map.fitBounds(b, { padding: 40 }); }).catch(err => console.warn("[iiif] ?iiif=", u.href, err)); }); }
}
// ── COPC の点群（#178・Cloud Optimized Point Cloud・.copc.laz）＝gadgets/copc.js（遅延 chunk）・worker は copc 役（LAZ の解読器＝"#pointcloud-formats" のプラグイン）──
// map.addPointCloud(url | File, opts)→ 手綱（stats・setOptions・setVisible・remove）・?copc=<URL>[&copcattr=<出典>]（門は ?g= と共用）・.las／.laz のドロップ
let copcCtl: ReturnType<typeof createCOPC> | null = null;
const copcGet = async () => copcCtl ??= (await import("./gadgets/copc.ts")).createCOPC(map, { cam, size: () => size, dpr, lowMem: LOW_MEM, signal: ac.signal, requester, ell: ELL_ON, earthM: EARTH_M,
	setAttr: (id, html) => {   // 出典の欄（#attr）＝opts.attribution・無ければ URL のホスト名（無出典で他人のデータを出さない＝サービスと同じ方針）。鍵は "pc:<id>"＝"src:" でない（様式の組み直しで source に無い "src:" は消される）
		const k = "pc:" + id, v = html ? sanitizeHTML(String(html)) : null;
		if ((vtxAttrs.get(k) ?? null) === v) return;
		if (v) vtxAttrs.set(k, v); else vtxAttrs.delete(k);
		attrZone = null; requestDraw();
	} });
map.addPointCloud = async (src, opts) => (await copcGet()).add(src, opts);   // COPC は節だけ範囲読み・普通の LAS/LAZ は丸ごと読み（点群計画 段 3-3・2,000 万点まで）
map.removePointCloud = async id => copcCtl ? (id == null ? copcCtl.list().every(h => h.remove()) : copcCtl.remove(id)) : false;
{
	const cSpec = new URLSearchParams(location.search).get("copc");
	const u = cSpec ? remoteUrl(cSpec, "copc") : null;
	const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
	const aSpec = new URLSearchParams(location.search).get("copcattr");   // ?copcattr=<出典の文字>（HTML にしない）＝カードから開く見本（段 4-2）の出典
	if (u) { const off = map.onFrame(() => { off(); map.addPointCloud(u.href, { fit: !themeBootV, ...(aSpec ? { attribution: esc(aSpec.slice(0, 200)) } : {}) }).catch(err => console.warn("[copc] ?copc=", u.href, err)); }); }
}
// ?cog=<URL>＝COG の URL ロード（門は ?g=/?scene= と共用＝https 限定・gh: 短縮形）。Range 直読み＝全量 fetch はしない
{
	const cogSpec = new URLSearchParams(location.search).get("cog");
	const u = cogSpec ? remoteUrl(cogSpec, "cog") : null;
	// 初フレーム後に発火＝renderworker 初期化前の set は黙って捨てられる（renderworker:246 の if(renderer) ガード）
	if (u) { const off = map.onFrame(() => { off(); map.gadget.cog(u.href).catch(err => console.warn("[cog] failed", u.href, err)); }); }
}
// ?xyz=<URL テンプレ>＝任意の XYZ 画像タイルを基図に（自前契約のタイル鯖・API キー付きも可＝門は ?g= と共用：https 限定）。出典＝ホスト名（宣言が無いので出所だけは出す）
// ?r=<id,id…>＝地域パックのカタログから（基図 1 枚＋重ね n 枚）。どちらも初フレーム後＝render worker の初期化前の set は捨てられる
{
	const q = new URLSearchParams(location.search);
	const xyzSpec = q.get("xyz"), rSpec = q.get("r");
	if (xyzSpec) {
		const u = remoteUrl(xyzSpec, "xyz");
		if (u) { const tpl = u.href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"); const off = map.onFrame(() => { off(); map.raster.add("xyz", { url: tpl, name: u.host, minZoom: +q.get("xyzmin")! || 0, maxZoom: +q.get("xyzmax")! || 18 }, { order: "under", hideFills: true }).catch(err => console.warn("[xyz] failed", tpl, err)); }); }
	}
	if (rSpec) {
		const ids = rSpec.split(",").map(x => x.trim()).filter(Boolean);
		const off = map.onFrame(() => { off(); for (const id of ids) {
			const c = REGION_RASTERS.find(x => x.id === id); if (!c) { console.warn("[raster] ?r= unknown id", id); continue; }
			(c.order === "over" ? map.raster.toggle(id, true) : map.raster.select(id)).catch(err => console.warn("[raster] ?r=", id, err));
		} });
	}
}
// ── 任意の 3D Tiles（#41・2026-09-23）＝gadgets/tiles3d.js（画面上の誤差で流す・中身は model 役の worker が解く）──
// map.gadget.tiles3d(url, opts) / map.add3DTiles(url, opts)＝戻り値の手綱（remove / setVisible / setOptions / stats）。?tiles3d=<URL>（門は ?g= と共用）・&t3dh=<m>＝高さのずらし
let t3dCtl: T3dLive | null = null;
const t3dGet = async () => { const m = await import("./gadgets/tiles3d.ts"); return t3dCtl ??= m.createTiles3D(map, {
	cam, size: () => size, dpr, lowMem: LOW_MEM, signal: ac.signal, requester, ell: ELL_ON,   // ell＝楕円体表示（#43）＝選びの世界座標と worker の置き方
	setMesh: (name, data) => { wPost({ type: "set", cmd: "meshSet", data, prop: name }, data ? [...new Set([data.pos.buffer, data.nrm.buffer, data.idx.buffer, data.uv?.buffer, data.col?.buffer, ...["tex", "texMR", "texN", "texOcc", "texEm"].flatMap(k => [(data[k] as TileTex | undefined)?.bitmap, (data[k] as TileTex | undefined)?.rgba?.buffer])].filter(Boolean) as Transferable[])] : []); },   // 描き直しは worker が転送を当てた時に決める（伏せた区への転送は描かない＝main から同じカメラの描き直しを頼まない・2026-10-19）
	meshVis: (ward, on) => { wPost({ type: "set", cmd: "meshVis", data: !!on, prop: ward }); },   // 同上＝worker が切替を当てた時（変わった時だけ）描き直す
	setMeshCol: (name, data) => { wPost({ type: "set", cmd: "meshCol", data, prop: name }, [data.buffer]); requestDraw(); },   // feature state の色（W7）
	pickEnv: meshPickEnv,   // 当たり（W7）
	setAttribution: (id, text) => setSrcAttr("t3d:" + id, text ? sanitizeHTML(String(text)) : null),   // tileset の出典（W8・opts.attribution）＝出典の欄（#attr）へ
}) as T3dLive; };
registerGadget("tiles3d", async (m, url, opts = {}) => {
	const c = await t3dGet();
	if (url == null) { if (opts.id) c.remove(opts.id); else for (const id of c.ids) c.remove(id); return null; }
	return c.add(url, opts);
});
map.add3DTiles = ((url: string | null, opts?: Tiles3DOptions) => map.gadget.tiles3d(url, opts)) as GlobeMap["add3DTiles"];
// I3S（ArcGIS の Indexed 3D Scene Layer・#48）＝同じ選び・同じ GPU 経路（gadgets/tiles3d.js の addI3S）。url＝…/SceneServer か …/SceneServer/layers/N
map.addI3S = async (url, opts) => (await t3dGet()).addI3S(url, opts);
let czmlCtl: GlobeLive["czmlCtl"] = null, czmlUrlClock: GlobeLive["czmlUrlClock"] = !!(bootView && (bootView.time || bootView.speed != null));
let editDocHook: GlobeLive["editDocHook"] = null;
// 取得の手入れ・Marker／Popup・取り込みの表とファイル取り込み（loadUserFile）＝src/api/intake.ts（live＝createGlobe の変数を読み書きする口）
const { loadUserFile, IMAGE_KEY } = installIntake(map, {
	get czmlCtl() { return czmlCtl; }, set czmlCtl(v) { czmlCtl = v; },
	get czmlUrlClock() { return czmlUrlClock; }, set czmlUrlClock(v) { czmlUrlClock = v; },
	get annoCtl() { return annoCtl; },
	get rasterDropFile() { return rasterDropFile; },
	get editDocHook() { return editDocHook; },
	get gFollow() { return gFollow; }, set gFollow(v) { gFollow = v; },
	get placeImages() { return placeImages; },
	get clearImages() { return clearImages; },
	get autoExtrude() { return autoExtrude; },
}, { D2R, cam, columnarOn, columnarProbe, columnarView, dbgHost, flyTo, gint, pageHash, remoteUrl, requester, size });
let imageIds: GlobeLive["imageIds"] = [], imageQuads: GlobeLive["imageQuads"] = [];   // imageQuads＝[{ id, corners, properties }]（map.queryRenderedFeatures の画像層）
let aggCtl: GlobeLive["aggCtl"] = null;
let symCtl: GlobeLive["symCtl"] = null;
let gjCtl: GlobeLive["gjCtl"] = null;
// 画像・集約とヒートマップ・記号帳と記号の層＝src/api/images.ts（live＝createGlobe の変数を読み書きする口）
const { imageMissing, symGet, placeImages, clearImages, autoExtrude, readPoints, aggGet, pendingImages, heatmapNative, gjIsLine, gjGet, symbolsNative } = installImages(map, {
	get imageIds() { return imageIds; }, set imageIds(v) { imageIds = v; },
	get imageQuads() { return imageQuads; }, set imageQuads(v) { imageQuads = v; },
	get modelCtl() { return modelCtl; },
	get aggCtl() { return aggCtl; }, set aggCtl(v) { aggCtl = v; },
	get assertMLLayer() { return assertMLLayer; },
	get gjCtl() { return gjCtl; }, set gjCtl(v) { gjCtl = v; },
	get dpr() { return dpr; },
	get MAP_GS() { return MAP_GS; },
	get symCtl() { return symCtl; }, set symCtl(v) { symCtl = v; },
	get addSourceAt() { return addSourceAt; },
	get addLayerAt() { return addLayerAt; },
	get clusterOf() { return clusterOf; },
}, { IMAGE_KEY, LOW_MEM, PUBLIC_DZ, ac, cam, imageAttrs, mapOn, modelCtlGet, ownDestroy, rasterChanged, readGeoData, registerGadget, requestDraw, size, wPost });
// ── MapLibre の addSource／addLayer をそのまま（2026-09-21・「形式で相乗り」の入口）────────────────────────────
// 層の type ごとに今日の部品へ振り分ける：fill/line/circle（集約なし）＝利用者の図形（gint＋map.paint）・fill-extrusion＝押し出し・
// heatmap＝ヒートマップ・circle/symbol（source が cluster:true）＝集約（丸＝paint・件数の文字＝text・filter で集約/単点を見分ける）・
// symbol＝記号の層・raster＝image source（四隅）か raster source（XYZ タイル）＝画像層。source は geojson / image / raster。
// 層はどの種類も何枚でも持てる（#34・2026-09-23）：fill/line/circle＝source ごとに gint の追加層（map.addGint＝paint/filter/feature-state/重ね順を層が持つ）・
// 押し出し／ヒートマップ＝層 id ごとのスロット・集約＝source ごと・symbol と raster は層ごと。
// 重ね順（moveLayer）は「同じ描き方の中」で効く（gint 同士・記号同士・模様同士）。描き方の違う層どうしの上下は描画の段で決まる
//（下から 基図 → 画像 → gint → 押し出し/建物 → ヒートマップ → 集約 → 記号 → 模様）。
// 層の操作は MapLibre と同名：setPaintProperty / setLayoutProperty（visibility）/ setFilter / moveLayer / getStyle / setFeatureState。
const mlSources: GlobeScope["mlSources"] = new Map(), mlLayers: GlobeScope["mlLayers"] = new Map();   // mlLayers の挿入順＝重ね順（下から）
// 目盛り（互換の台帳 maplibre-compat.md・約束 1/5）：層と source は「渡されたまま」＋dz（その数が書かれた目盛り−エンジンの目盛り）を持つ。
// 描き出す時は drawLayerOf（＝normalizeMLLayer：旧書式の読み替え＋dz の換算）を 1 回だけ通す。style.json 由来は dz 1（MapLibre の z）・
// 公開の口は PUBLIC_DZ（createGlobe の最初で旗から決まる＝旗なし 0・maplibre 1）。層の metadata["ortho:dz"] の申告があればそれが勝つ。
// ⚠層の口（addLayer…）は素の map でも公開の目盛り＝内部の呼び手は addLayerAt/addSourceAt に dz を明示する（台帳 R8 の門）
const mlSourceDz: GlobeScope["mlSourceDz"] = new Map();   // source id → dz（clusterMaxZoom は source に住む）
// 集約の source の circle／symbol の層＝filter に段の条件（地物の隠しの属性 [ML_CZ0_KEY, ML_CZ1_KEY)・エンジンの z）を足す（cluster as data・clusterOf）
const CL_ZF = ["all", [">=", ["zoom"], ["get", ML_CZ0_KEY]], ["<", ["zoom"], ["get", ML_CZ1_KEY]]];
const drawLayerOf: GlobeScope["drawLayerOf"] = v => { const L = normalizeMLLayer(v.layer, v.dz); return v.src?.cluster && (v.kind === "gint" || v.kind === "symbol") ? { ...L, filter: L.filter != null ? ["all", CL_ZF, L.filter] : CL_ZF } : L; };
// 層の出しズーム（正規化済み＝エンジンの z・MapLibre の minzoom 包含・maxzoom 排他）と「作り直すべきか」の鍵（段 5・台帳 R17）。
// 押し出し・模様（canvas2D）は一度きりの評価＝止まるたびに鍵を見て、変わったら描き直す（範囲の外は外す・["zoom"] の式は 0.25 刻み）。
// 押し出し（curves）は曲線を見る（台帳 R22・extrude-ml.js）＝一番外の interpolate/step の止まりの外は値が一定＝鍵も一定（全体を上げ直さない）
const inZoomML: GlobeScope["inZoomML"] = (L, z) => (L.minzoom == null || z >= L.minzoom) && (L.maxzoom == null || z < L.maxzoom);
const evalZoomIn = (e: unknown, z: number) => evalExpr(e, { zoom: z, props: {}, geom: null, vars: {}, gs: MAP_GS, origin: "ml" });
const zoomKeyOf = (L: MLLayer, z: number, curves = false) => !inZoomML(L, z) ? "out"
	: curves ? "in" + ((k => k ? "@" + k : "")(curveZoomKey(L, z, evalZoomIn as (e: unknown) => unknown)))
	: "in" + (JSON.stringify([L.filter ?? null, L.paint ?? null, L.layout ?? null]).includes('["zoom"') ? "@" + Math.round(z * 4) / 4 : "");
const mlZoomKeys = new Map<string, string>();   // 層 id → 最後に描いた時の鍵
// 式の検査（段 5）＝知らない演算子があれば MapLibre と同じく投げて層を足さない（名前を挙げる）。within/distance など未対応の演算子も同じ扱い
const assertMLLayer: GlobeScope["assertMLLayer"] = (L, where) => { const bad = mlUnknownOps(L as MLLayer); if (bad.length) throw new Error(`${where}: layer "${L.id ?? "?"}" uses unknown expression operator ${bad.map(o => `"${o}"`).join(", ")}`); };
const srcDzOf = (L: MLLayer) => typeof L.source === "string" ? (mlSourceDz.get(L.source) ?? 0) : layerDzOf(L, 0);
const srcOf: GlobeScope["srcOf"] = L => typeof L.source === "string" ? mlSources.get(L.source) ?? baseSrcSpec(L.source) : L.source;   // 基図の source 名＝vector（段 8①・fill-extrusion だけが読める）
const srcId: GlobeScope["srcId"] = L => typeof L.source === "string" ? L.source : L.id;
// MapLibre の geojson source の data の文字列＝URL（相対は頁から解決・段 6）。geopbf は ^https? だけを URL と見て、それ以外はバケツ名として引く
const dataOf = (sp: UserSource | undefined) => { const d = sp?.data ?? null; return typeof d === "string" && !/^[a-z][\w+.-]*:/i.test(d) ? new URL(d, location.href).href : d; };
const mlGen = new Map<string, number>();   // "cluster:<sid>" / "gint:<sid>" → 世代（組み直しは非同期＝外した後に古い組み直しが着地して復活するのを捨てる）
const bumpGen = (k: string) => { const g = (mlGen.get(k) || 0) + 1; mlGen.set(k, g); return g; };
const mlVisible: GlobeScope["mlVisible"] = v => v.layer.layout?.visibility !== "none";
const mlOrderOf = (id: string) => [...mlLayers.keys()].indexOf(id);
const kindOf: GlobeScope["kindOf"] = (layer, sp) => {
	if (layer.type === "raster") return "raster";
	if (layer.type === "custom") return "custom";   // source を持たない（CustomLayerInterface）
	if (layer.type === "hillshade") { if (sp!.type !== "raster-dem") throw new Error(`addLayer: hillshade layer "${layer.id}" needs a raster-dem source`); return "hillshade"; }   // 2D の陰影（hillshade.js）
	if (layer.type === "color-relief") { if (sp!.type !== "raster-dem") throw new Error(`addLayer: color-relief layer "${layer.id}" needs a raster-dem source`); return "colorrelief"; }   // 標高の段彩（colorrelief.js・#114）
	if (layer.type === "fill-extrusion") return sp!.type === "vector" ? "vtextrude" : "extrude";   // vector source＝ベクタタイルの押し出し（段 8①）
	if (sp!.type === "vector") { if (VT_DRAW.has(layer.type)) return "vtdraw"; throw new Error(`addLayer: layer "${layer.id}" (${layer.type}) on vector source "${layer.source}" is not supported — vector sources feed fill / line / circle / symbol / heatmap / fill-extrusion layers`); }   // vector source の描く層（段 8⑤）＝renderer の "user" の枠（基図の上）・それ以外は黙って壊れない
	if (layer.type === "heatmap") return "heatmap";
	if (layer.type === "symbol") return "symbol";
	if (layer.type === "line" && layer.paint?.["line-pattern"] != null) return GJVT && !sp?.cluster && !PER_FEATURE.test(JSON.stringify(layer.paint["line-pattern"])) ? "vtdraw" : "pattern";   // 線の模様（G-4）＝切ったタイルの線の距離（語 6）で vtdraw のシェーダが画像を敷く・名前は層で一度＝属性で模様を変える層は canvas2D の口
	if (layer.type === "line" && layer.paint?.["line-gradient"] != null) return GJVT && !sp?.cluster ? "vtdraw" : "pattern";   // 色の進み（G-3）＝切ったタイルの線の進み（geojsonvt の prog）を vtdraw のシェーダで
	if (layer.type === "fill" && layer.paint?.["fill-pattern"] != null) return GJVT_FILL && !sp?.cluster && !PER_FEATURE.test(JSON.stringify(layer.paint["fill-pattern"])) ? "vtdraw" : "pattern";   // 面の模様（上の GJVT_FILL）
	if (layer.type === "line" && (layer.paint?.["line-offset"] ?? 0) !== 0) return GJVT && !sp?.cluster ? "vtdraw" : "pattern";   // 線のずらし（#49・数の 0 は gint のまま）＝切ったタイルで vtdraw（G-2）
	if (layer.type === "fill" || layer.type === "line" || layer.type === "circle") return "gint";
	throw new Error(`addLayer: type "${layer.type}" is not supported`);
};
// 集約の source（cluster:true）＝データの側で集約する（cluster as data・2026-10-22・旧＝cluster-2d の canvas2D のオーバーレイ）。
// 全段の丸と単点を 1 つの FeatureCollection にして（aggregate-core の clusterFeatures）、circle の層は gint・symbol の層は注記層（gjlabels の点置き）へ
// ＝MapLibre の paint／filter／zoom 域・衝突・層の順がそのまま効く。段は drawLayerOf が filter に足す。data・半径・最大段・clusterProperties が同じ間は使い回す
const mlClusters = new Map<string, { k: unknown[]; p: Promise<ClusterSource>; r?: ClusterSource }>();
const clusterOf: GlobeScope["clusterOf"] = sid => {
	const v = [...mlLayers.values()].find(x => srcId(x.layer) === sid), sp = mlSources.get(sid) || v?.src;
	if (!sp?.cluster) return null;
	const dz = mlSourceDz.get(sid) ?? (v ? srcDzOf(v.layer) : 0);
	const k = [dataOf(sp), sp.clusterRadius ?? 50, rescaleZoomNum((sp.clusterMaxZoom ?? 14) as number, dz, 0), sp.clusterProperties ?? null];   // clusterMaxZoom＝source の目盛りからエンジンの z へ
	const c = mlClusters.get(sid);
	if (c && c.k.every((x, i) => x === k[i])) return c.p;
	const p = (async () => {
		const m = await import("./gadgets/aggregate-core.ts"), pts = m.pointsOf(await readPoints(k[0]));
		return m.clusterFeatures(pts, m.buildClusters(pts, { clusterRadius: k[1] as number, clusterMaxZoom: k[2] as number, clusterProperties: k[3] as Record<string, unknown> | null, gs: MAP_GS }));
	})();
	const e: { k: unknown[]; p: Promise<ClusterSource>; r?: ClusterSource } = { k, p }; mlClusters.set(sid, e);
	p.then(r => { e.r = r; }, () => { if (mlClusters.get(sid)?.p === p) mlClusters.delete(sid); });
	return p;
};
const clusterNow: GlobeScope["clusterNow"] = sid => mlClusters.get(sid)?.r ?? null;   // 同期の読み（querySourceFeatures）＝組み終えた物だけ
// fill/line/circle（MapLibre 互換の段 4・約束 6）＝MapLibre の重ね順で連続する同じ source の層だけを 1 枚の gint 層（pass）へ詰める（core packMLLayers）。
// 表は core の buildMLTable（MapLibre の意味：層の型がジオメトリを選ぶ・層ごとの filter と zoom 域・既定値）を手綱へ注入＝feature-state・settle の再評価・
// setData の呼び直しも同じ表（台帳 R5）。重ね順は予約の帯 ML_ORDER_BASE＋pass の通し番号（order 0 は自動採番と衝突＝U10）。
// ML の層の gint 層は interactive:false（カーソルを奪わない＝MapLibre に自動のホバーは無い・層イベントは queryRenderedFeatures が引く）。
// 同じ source の pass はジオメトリを別々に焼いて上げる（共有なし＝台帳 R10）＝同じ型が重なった時だけ pass が増える。
const ML_ORDER_BASE = 1000;
const mlGintData = new Map<string, MlGintEntry>();      // sid → { data, pbf }
const mlPasses = new Map<string, MlPassFull>();        // 署名（sid|層 id…|出しズーム）→ { sid, h, holder: { pass, zs, drawn }, order, pbf }
const mlFeatureState: GlobeScope["mlFeatureState"] = new Map();  // sid → Map<fid, state>（source に住む＝pass を作り直しても残す）
// geojson source の焼きの控え（2026-10-13・地形の頁＝25 万頂点の焼き 10 秒を毎回払っていた）＝source の cacheKey で GeoPBF＋GintBUF を IDB へ（geopbf の鍵つきの控え #176）。
// 掃除＝鍵の接頭辞 ML1:: だけ・頁で最初に使う時に一度：置いてから 30 日を超えた物・200 件／256MB を超えた分（最後に使ったのが古い順）
const ML_CACHE_PREFIX = "ML1::", ML_CACHE_PRUNE = { maxAge: 30 * 864e5, maxEntries: 200, maxBytes: 256 * 2 ** 20 };
let mlCachePruned = null;
const pruneMlCache = () => mlCachePruned ??= geopbfCachePrune({ prefix: ML_CACHE_PREFIX, ...ML_CACHE_PRUNE }).catch(err => { console.warn("[addSource] cache prune", err); return null; });
const planGint = () => {   // 全体の詰め方＝gint の層だけを登録順に見て、同じ source が続く所を 1 本にし、その中を packMLLayers
	const runs: Array<{ sid: string; ls: MLLayer[] }> = []; let run: { sid: string; ls: MLLayer[] } | null = null;
	for (const v of mlLayers.values()) {
		if (v.kind !== "gint") continue;   // 隠した層も詰め方に残す（表が効かせない＝出し入れで pass が変わらない＝焼き直さない）
		const sid = srcId(v.layer);
		if (!run || run.sid !== sid) runs.push(run = { sid, ls: [] });
		run.ls.push(drawLayerOf(v));
	}
	return runs.flatMap(r => (packMLLayers(r.ls) as MLPassML[]).map(pass => ({ sid: r.sid, pass })));
};
const gintDataOf = async (sid: string, force: boolean, gen: number) => {
	const sp = mlSources.get(sid) || [...mlLayers.values()].find(v => srcId(v.layer) === sid)?.src;
	let cur = mlGintData.get(sid);
	if (cur && !force && cur.data === dataOf(sp)) return { cur, changed: false };
	let d: unknown = dataOf(sp); const raw = d;
	if (sp?.cluster) d = (await clusterOf(sid))!.fc;   // 集約の source＝全段の丸と単点（clusterOf）
	if (typeof d === "string") d = await sourceData(sid, d, sp);   // URL＝requester で直に・サービス＝丸ごとか視野追従（#176）
	else { dropFollow(sid); setSrcAttr(sid, (sp as { attribution?: unknown } | undefined)?.attribution ? sanitizeHTML(String((sp as { attribution?: unknown }).attribution)) : null); }   // data が object の geojson も attribution（MapLibre の宣言）を出典の欄へ（2026-10-21・横浜の台帳の出典と「非商用」が全部落ちていた＝URL の時だけ渡していた）
	// 焼いた結果の控え（source の cacheKey・data が object の時だけ）＝鍵が同じなら IDB の GeoPBF＋GintBUF を戻して焼かない。
	// 鍵は呼び手が決める＝中身が変われば鍵も変える約束（中身を見比べない）。setData／updateData は鍵を外す＝控えは足した時の data だけ。
	// URL の data は geopbf／サービスの側が自分の控えを持つ
	const ck = typeof raw !== "string" && !sp?.cluster && typeof sp?.cacheKey === "string" && sp.cacheKey ? ML_CACHE_PREFIX + sp.cacheKey : null;
	if (ck) pruneMlCache();
	const pbf = (ck && await geopbfCached(ck, { gint: true, name: `ml/${sid}` }).catch(() => null))
		|| await geopbf(withMlIds(d as GjLike, sp) as GeopbfInput, { gint: true, name: `ml/${sid}`, ...(ck ? { cacheKey: ck } : {}) });
	if (mlGen.get("gint") !== gen) return null;
	const idToFid = new Map<unknown, number>(), fidToId: Array<number | string | undefined> = [];
	for (let i = 0; i < (pbf?.length ?? 0); i++) { const id = pbf!.getFeature?.(i)?.properties?.[ML_ID_KEY] as number | string | undefined; fidToId[i] = id; if (id != null && !idToFid.has(id)) idToFid.set(id, i); }
	cur = { data: raw, pbf, idToFid, fidToId }; mlGintData.set(sid, cur);
	return { cur, changed: true };
};
// MapLibre の feature の id（段 6）＝Feature.id → promoteId の属性 → 並び順（generateId と同じ・MapLibre では id が無いと feature-state が効かない＝その上位）。
// 焼く前に隠しの属性で地物へ写す（geopbf は Feature.id を持たない・同じ属性の地物を 1 つの fid に束ねる＝並びの属性で束ねさせない）
const withMlIds = (d: GjLike, sp: UserSource | undefined) => {
	const feats: GjLike[] = d?.type === "FeatureCollection" ? d.features! : d?.type === "Feature" ? [d] : d?.type && d?.coordinates ? [{ type: "Feature", properties: {}, geometry: d }] : Array.isArray(d) ? d : [];
	const pid = typeof sp?.promoteId === "string" ? sp.promoteId : null;
	return { type: "FeatureCollection", features: feats.map((f, i) => { const p = f?.properties || {}, id = pid != null && p[pid] != null ? p[pid] : f?.id != null ? f.id : i; return { ...f, properties: { ...p, [ML_IX_KEY]: i, [ML_ID_KEY]: id } }; }) };
};
const stripMl: GlobeScope["stripMl"] = p => { if (!p || !(ML_ID_KEY in p || ML_CZ0_KEY in p)) return p || {}; const { [ML_ID_KEY]: _a, [ML_IX_KEY]: _b, [ML_CZ0_KEY]: _c, [ML_CZ1_KEY]: _d, [ML_CEZ_KEY]: _e, ...rest } = p; return rest; };
const mlIdOf: GlobeScope["mlIdOf"] = (sid, fid) => mlGintData.get(sid)?.fidToId?.[fid];
const zoomActiveKey = (pass: MLPassML, z: number) => pass.layers.filter(L => (L.minzoom == null || z >= L.minzoom) && (L.maxzoom == null || z < L.maxzoom) && L.layout?.visibility !== "none").map(L => L.id).join(",");
// 組み直し（層の足し引き・重ね順・性質・出し入れ・データ差し替え＝どれも全体の詰め方から）。同じ署名の pass は手綱を使い回して表だけ作り直す
// 立て続けの呼び出し＝新しい方が勝つ。追い越された呼び出しは新しい方の完了を待って解決する（addLayer が描き終わる前に解決しない）
let mlGintRun: Promise<unknown> | null = null;
const rebuildGint: GlobeScope["rebuildGint"] = (sidChanged = null, opts = {}) => (mlGintRun = rebuildGintNow(sidChanged, opts));
const rebuildGintNow = async (sidChanged: string | null = null, { dataChanged = false }: { dataChanged?: boolean } = {}) => {
	const gen = bumpGen("gint");
	const superseded = () => mlGintRun;   // 世代が進んでいたら新しい方の Promise を返す
	const plan0 = planGint(), data = new Map<string, NonNullable<Awaited<ReturnType<typeof gintDataOf>>>>();
	let failOwn: unknown = null;   // 読めない source は、その source の pass だけ飛ばす（他の source を巻き添えにしない）。呼び出した source 自身なら最後に投げる
	for (const sid of new Set(plan0.map(p => p.sid))) {
		let r;
		try { r = await gintDataOf(sid, dataChanged && sid === sidChanged, gen); }
		catch (err) { console.warn(`[addLayer] source "${sid}" could not be read — its fill/line/circle layers are skipped`, err); if (sid === sidChanged) failOwn = err; mlGintData.delete(sid); continue; }
		if (!r) return superseded();
		data.set(sid, r);
	}
	const plan = plan0.filter(p => data.has(p.sid)), sids = [...data.keys()];
	if (mlGen.get("gint") !== gen) return superseded();
	const keep = new Set<string>();
	for (let i = 0; i < plan.length; i++) {
		const { sid, pass } = plan[i], order = ML_ORDER_BASE + i, { cur, changed } = data.get(sid)!;
		if (!cur.pbf?.unPackGint) continue;   // 地物 0 件の source（terra-draw の空の FeatureCollection 等）＝焼いた pbf に gint が無い＝pass を作らない（前からあれば下で外す）・旧＝描くたびに addGint が invalid source を出した
		// 出しズーム＝MapLibre の既定（minzoom 無し＝z0 から・maxzoom 無し＝上限なし）・pass の層の和。境の内側の出し入れは表（層の zoom 域）が決める
		const minZ = Math.min(...pass.layers.map(L => Number.isFinite(L.minzoom) ? L.minzoom! : 0)), maxs = pass.layers.map(L => L.maxzoom), maxZ = maxs.every(Number.isFinite) ? Math.max(...maxs as number[]) : null;
		const sig = `${sid}|${pass.layers.map(L => L.id).join(",")}|${minZ}|${maxZ}`;
		keep.add(sig);
		let e = mlPasses.get(sig);
		if (!e) {
			const holder: MlHolder = { pass, zs: zoomSensitivity(pass), drawn: null }, isCl = !!(mlSources.get(sid) || [...mlLayers.values()].find(v => srcId(v.layer) === sid)?.src)?.cluster;
			// style＝移動中も地物ごとの表で描く（admin0 と同じ moveBudget=Infinity＋outlineZoom=0）＝MapLibre の層は動かしている間も同じ見た目。
			// 既定のままだと 25 万辺を超える source は移動中に層の単色（既定の #FF6B35／#00B4D8）へ落ち、面がオレンジに塗られた
			//（/globe/physical の形状台帳 39 万頂点・本人指摘 2026-10-01）。単色の色も透明に＝それでも落ちる経路で色を出さない
			const h = map.addGint(cur.pbf, { order, minZoom: minZ, maxZoom: maxZ as number | undefined, origin: "ml", interactive: false, ...(pass.fill ? {} : { fillMaxEdges: 0 }),   // 塗りの層が無い＝縮退 stencil が表を見ずに塗る穴を塞ぐ（U13・R16）
				style: { fillColor: [0, 0, 0, 0], styleTable: new Float32Array(256 * 4), moveBudget: Infinity, outlineZoom: 0 },
				buildTable: ({ feats, zoom, states }: { feats: Parameters<typeof buildMLTable>[1]; zoom: number; states: MLTableStates }) => { const t = buildMLTable(holder.pass, feats, { zoom, states }); holder.drawn = t.drawn; return t; },
				zoomKey: (z: number) => zoomActiveKey(holder.pass, z) + (holder.zs.expr ? "@" + Math.round(z * 4) / 4 : "") + (isCl ? "#" + Math.floor(z) : "") } as GintLayerOptions);   // 集約＝段（floor）の境で必ず作り直す
			if (!h) continue;
			e = { sid, h, holder, order, pbf: cur.pbf }; mlPasses.set(sig, e);
			await h.ready;
			if (mlGen.get("gint") !== gen) return superseded();
			for (const [mid, st] of mlFeatureState.get(sid) || []) { const fid = cur.idToFid?.get(mid); if (fid != null) h.setFeatureState(fid, st); }   // 状態は MapLibre の id で source に住む
		} else {
			e.holder.pass = pass; e.holder.zs = zoomSensitivity(pass);
			if (changed || e.pbf !== cur.pbf) {
				await e.h.setData(cur.pbf); e.pbf = cur.pbf;
				e.h.removeFeatureState(null);   // fid が変わる＝状態は MapLibre の id から当て直す
				for (const [mid, st] of mlFeatureState.get(sid) || []) { const fid = cur.idToFid?.get(mid); if (fid != null) e.h.setFeatureState(fid, st); }
			}
			if (e.order !== order) { e.h.setOrder(order); e.order = order; }
		}
		await e.h.setPaint({}, null);   // 表を作り直す（手綱の buildTable＝MapLibre の意味）
	}
	for (const [sig, e] of mlPasses) if (!keep.has(sig)) { e.h.remove(); mlPasses.delete(sig); }
	for (const sid of [...mlGintData.keys()]) if (!sids.includes(sid)) mlGintData.delete(sid);
	for (const sid of [...fsFollow.keys()]) if (!sids.includes(sid)) dropFollow(sid);   // その source の fill/line/circle が無くなった＝視野追従と出典を下げる
	for (const k of [...vtxAttrs.keys()]) if (k.startsWith("src:") && !sids.includes(k.slice(4))) setSrcAttr(k.slice(4), null);
	if (failOwn) throw failOwn;
	return true;
};
// 塗り/線の模様（MapLibre の fill-pattern／line-pattern）＝記号帳の画像を敷き詰める canvas2D のオーバーレイ（pattern-2d.js）。
// 線の飾り（line-gradient／line-offset・#49）も同じ口＝gint の線は地物ごと一色・ずらしなし。
// ⚠設計原則「紙の遺物を捨てる」の側＝既定では何も描かない。MapLibre の層を受ける互換の口だけ（本人 9/21「残りをお願いします」）
let patOv: OverlayHandle | null = null, patOrder = 0;
const patItems: GlobeScope["patItems"] = new Map();   // 層 id → { fill, sid, feats: [{ f, width, offset, lines }] }＝queryRenderedFeatures が当てる（段 5・台帳 R17）
const patSent = new Set<string>();
const GRAD_N = 64;   // line-gradient の見本の数（進み 0..1 を等分）
const cssRGBA = (v: unknown) => { const [r, g, b, a] = parseRGBA(v); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`; };
// line-progress（MapLibre の lineMetrics）＝線の頭からの長さの割合。長さはメルカトルの平面で測る（MapLibre のタイル座標と同じ尺）
const lineProgress = (r: Float64Array) => {
	const n = r.length >> 1, pr = new Float32Array(n), my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * Math.PI / 360)) * 180 / Math.PI;
	let acc = 0;
	for (let i = 1; i < n; i++) { acc += Math.hypot(r[i * 2] - r[i * 2 - 2], my(r[i * 2 + 1]) - my(r[i * 2 - 1])); pr[i] = acc; }
	if (acc > 0) for (let i = 1; i < n; i++) pr[i] /= acc;
	return pr;
};
// queryOnly＝描くのは vtdraw（G-2）＝問い合わせ用の地物（patItems）だけ作る（オーバーレイは作らない）
const addPattern = async (layer: MLLayer, data: unknown, order?: number, queryOnly = false) => {
	const pf: PatFeatOut[] = [];   // 問い合わせ用の地物（画面の px で当てる）
	const P0 = layer.paint || {}, needSym = P0["fill-pattern"] != null || P0["line-pattern"] != null;
	const c = needSym ? await symGet() : null; if (!queryOnly) patOv ??= map.overlay({ builtin: "pattern" }, { name: "pattern" });
	let d = data as GjLike | string | Blob | undefined; if (typeof d === "string" || d instanceof Blob) d = await readGeoData(d) as GjLike | undefined;
	const feats = (d?.features || (Array.isArray(d) ? d : d?.type === "Feature" ? [d] : d?.type && d?.coordinates ? [{ type: "Feature", properties: {}, geometry: d }] : [])) as Array<PatFeature | null>, P = layer.paint || {}, fill = layer.type === "fill", items: PatOut[] = [];   // FeatureCollection／Feature／素の geometry（MapLibre の geojson source はどれも受ける）
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const ctx = { zoom: cam.zoom, props: f.properties || {}, geom: g.type.replace("Multi", ""), vars: {}, gs: MAP_GS, origin: originOfLayer(layer), geojson: g as ExprCtx["geojson"], pitch: cam.pitch * R2D };   // geojson/pitch＝within・distance・["pitch"]（C2）
		const evd = (e: unknown, d: unknown) => { const v = evalExpr(e ?? d, ctx); return v === undefined && ctx.origin ? d : v; };   // ML の評価エラー＝性質の既定値
		if (layer.filter != null && !truthy(evalExpr(layer.filter, ctx))) continue;
		const patProp = P[fill ? "fill-pattern" : "line-pattern"];
		const pattern = patProp != null ? evalExpr(patProp, ctx) : null;
		if (patProp != null && (!pattern || !c!.getImage(pattern as string))) continue;
		const parts: number[][][][] = fill ? (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) : (g.type === "LineString" ? [[g.coordinates]] : g.type === "MultiLineString" ? g.coordinates.map(l => [l]) : []);
		const it0: PatIt = { pattern, opacity: +(evd(P[fill ? "fill-opacity" : "line-opacity"], 1) as number), width: fill ? 0 : +(evd(P["line-width"], 1) as number) };
		if (!fill) {
			if (!pattern) it0.color = cssRGBA(evd(P["line-color"], "#000"));
			const off = P["line-offset"] != null ? +(evalExpr(P["line-offset"], ctx) as number) : 0;
			if (off && isFinite(off)) it0.offset = off;
			const dash = P["line-dasharray"] != null ? evalExpr(P["line-dasharray"], ctx) : null;
			if (Array.isArray(dash) && dash.length && dash.every(v => typeof v === "number" && v >= 0) && dash.some(v => v > 0)) it0.dash = dash;
			if (P["line-gradient"] != null && !pattern) {   // 見本＝進みを等分して式を評価（["line-progress"] は ctx.vars から引かれる）
				const lut: string[] = [];
				for (let j = 0; j <= GRAD_N; j++) { ctx.vars = { "line-progress": j / GRAD_N }; lut.push(cssRGBA(evalExpr(P["line-gradient"], ctx))); }
				ctx.vars = {};
				it0.grad = { lut };
			}
		}
		pf.push({ f, width: it0.width || 0, offset: it0.offset || 0, lines: fill ? [] : parts.map(rings => rings[0]) });
		if (queryOnly) continue;
		for (const rings of parts) {
			const rr = rings.map(r => Float64Array.from(r.flat()));
			items.push(it0.grad ? { ...it0, rings: rr, grad: { lut: it0.grad.lut, prog: rr.map(lineProgress) } } : { ...it0, rings: rr });
		}
	}
	if (queryOnly || !patOv) { patItems.set(layer.id, { fill, sid: srcId(layer), feats: pf as PatItem["feats"] }); return { features: pf.length }; }
	for (const name of new Set(items.map(i => i.pattern).filter(Boolean) as string[])) if (!patSent.has(name)) { const im = c!.getImage(name)!; const bm = await createImageBitmap(im.bitmap); patOv.post({ type: "image", name, bitmap: bm, pixelRatio: im.pixelRatio }, [bm]); patSent.add(name); }
	patItems.set(layer.id, { fill, sid: srcId(layer), feats: pf as PatItem["feats"] });
	patOv.post({ type: "layer", id: layer.id, kind: fill ? "fill" : "line", items, order: order ?? patOrder++ });
	return { features: items.length };
};
// ラスタの色調整（MapLibre の raster-* paint・#39）＝今のズームで数へ（式も可）。何も無ければ null
const rasterAdjust: GlobeScope["rasterAdjust"] = P => {
	if (!P) return null;
	const n = (k: string, d: number) => { if (P[k] == null) return d; const v = evalExpr(P[k], { zoom: cam.zoom, props: {}, geom: null, vars: {}, gs: MAP_GS, origin: "ml" }); return v === undefined ? d : +v!; };   // MapLibre の raster 層だけが呼ぶ
	const a = { hueRotate: n("raster-hue-rotate", 0), saturation: n("raster-saturation", 0), contrast: n("raster-contrast", 0), brightnessMin: n("raster-brightness-min", 0), brightnessMax: n("raster-brightness-max", 1) };
	return a.hueRotate || a.saturation || a.contrast || a.brightnessMin || a.brightnessMax !== 1 ? a : null;
};
// ── vector source の fill-extrusion（MVT の 3D 建物・段 8①・2026-09-26）＝gadgets/vtextrude.js（遅延 chunk・この層が来た時だけ読む＝他の地図は何も変わらない）──
// 基図の source 名（外来 style＝その名前・地域の基図＝"basemap"）も source として受ける（BASE_SRC の印）。描き方はメッシュ経路（setMesh / meshVis）の使う側を一つ足すだけ
const BASE_SRC: GlobeScope["BASE_SRC"] = Symbol("basemap-source");
const baseSidNow: GlobeScope["baseSidNow"] = () => EXT?.split.vectorSource ?? "basemap";
const baseSrcSpec: GlobeScope["baseSrcSpec"] = id => id === baseSidNow() ? { type: "vector", [BASE_SRC]: true } : undefined;
// 当たりの地面＝描いている地面＝dispRadius（負の標高を 0 に切る＝renderer と同じ・2026-09-27 に projectLL と一本化）
// ?noterr=1（地形を描かない）は dispRadius 側で持ち上げ 0＝projectLL も当たりも描く側と同じ（#77 の意図を一本化の後へ写した・2026-09-27）
const vtxGround: GlobeScope["vtxGround"] = dispRadius;
// feature-state（vector source・MapLibre と同じく sourceLayer が要る）の置き場＝sid → Map<"sourceLayer\0型:id", { id, state }>。層より先に置かれても残る（押し出しの部品は読むだけ）
const vtxFS: GlobeScope["vtxFS"] = new Map();
const vtxFSKey = (sl: string | undefined, id: unknown) => `${sl}\u0000${typeof id}:${id}`;
const vtxStateOf: GlobeScope["vtxStateOf"] = (sid, sl, id) => ({ ...(id == null || sl == null ? null : vtxFS.get(sid)?.get(vtxFSKey(sl, id))?.state) });   // 問い合わせの地物の state（MapLibre と同じく無ければ {}・#109 段 3）
const isVecSrc: GlobeScope["isVecSrc"] = sid => mlSources.get(sid)?.type === "vector" || !!baseSrcSpec(sid);
let vtxCtl: ReturnType<typeof createVTExtrude> | null = null;
const vtxGet = async () => {
	const m = await import("./gadgets/vtextrude.ts");
	if (vtxCtl) return vtxCtl;
	ownDestroy.push(() => vtxCtl?.destroy());   // worker 2 本・ポート・リスナー（map.destroy）
	const ch = new MessageChannel();   // 押し出し専用の送り口（PLATEAU と同じ meshPort＝render worker は適用ごとに受け取りの印を返す＝背圧と「載った」の判定）
	wPost({ type: "meshPort", port: ch.port2 }, [ch.port2]);
	return vtxCtl = dbgHost.__vtx = m.createVTExtrude(map, {
		raw: vtRaw,   // 生のタイルの写し（querySourceFeatures・C7）
		gs: () => MAP_GS,   // 地図の global-state（#173 段 3b）   // __vtx＝検証窓（debugGlobals の時だけ）
		meshPort: ch.port1, requestDraw: requestDraw,
		cam, size: () => size, dpr, lowMem: LOW_MEM, requester, ell: ELL_ON, isFlying: () => flying, fstate: vtxFS, fsKey: vtxFSKey, tileBias: TILE_BIAS, zoomOf: mlZoomOf,
		setMesh: (name, data) => { wPost({ type: "set", cmd: "meshSet", data, prop: name }, data ? [...new Set([data.pos.buffer, data.nrm.buffer, data.idx.buffer, data.uv?.buffer, data.col?.buffer].filter(Boolean) as Transferable[])] : []); requestDraw(); },
		meshVis: (ward, on) => { wPost({ type: "set", cmd: "meshVis", data: !!on, prop: ward }); requestDraw(); },
		hitEnv: () => extView().envOf(vtxGround),   // 当たり＝geojson の押し出しと同じ口（屋根と壁・奥行き＝clip の w・台帳 R23）
		unprojectAt: (x, y, hM) => { const st = cameraState(cam, size.w, size.h); return unproject(st, x * dpr, y * dpr, vtxGround(cam.center[0], cam.center[1]) + (hM || 0) / EARTH_M); },
	});
};
// source の記述子（vtextrude.js の desc）。基図＝外来 style の解決済みの source か地域の基図の記述子・利用者の vector source＝TileJSON/PMTiles を解いて覚える
const vtxDescs: GlobeScope["vtxDescs"] = new Map();   // sid → Promise<desc>（利用者の source・removeSource で忘れる）
const vtxAttrs: GlobeLive["vtxAttrs"] = new Map();   // sid → 出典（消毒済み HTML・宣言が無ければホスト名＝無出典で他人のデータを出さない）＝押し出しの層がその source を使っている間だけ
const vtxAttrTail = (skip: string | null = null) => { const a = [...new Set(vtxAttrs.values())].filter(x => x && x !== skip); return a.length ? `<br>${t("Source: $1", a.join("・"))}` : ""; };   // skip＝基図の出典と同じ文は重ねない
const vtxAttrOf = (desc: VtxDesc & { attribution?: unknown }) => { if (desc.attribution && String(desc.attribution).trim()) return sanitizeHTML(String(desc.attribution)); const u = desc.pmtiles ? desc.pmtiles.replace(/^pmtiles:\/\//, "") : desc.tileUrl?.(0, 0, 0); try { return u ? new URL(u, location.href).host : null; } catch { return null; } };   // 空白だけの宣言（demotiles の " "）＝宣言なしと同じ＝ホスト名
const vtxDescOf: GlobeScope["vtxDescOf"] = async (sid, sp) => {
	if (sp?.[BASE_SRC]) {
		if (EXT) { const s = EXT.src, ms = EXT.ms.sources![sid] || {}; return s ? { tileUrl: s.pmtiles ? null : tileUrlOf(s), pmtiles: s.pmtiles || null, minzoom: s.minzoom, maxzoom: s.maxzoom, bounds: s.bounds ?? null, promoteId: ms.promoteId as VtxDesc["promoteId"] ?? null, encoding: s.encoding || "mvt", tag: JSON.stringify(s.pmtiles || s.tiles) + "|" + (s.encoding || "mvt") } : null; }
		if (BASE_SOURCE.kind === "none") return null;
		return { tileUrl: BASE_SOURCE.kind === "pmtiles" ? null : BASE_SOURCE.tileUrl, pmtiles: BASE_SOURCE.kind === "pmtiles" ? BASE_SOURCE.url : null, minzoom: BASE_SOURCE.minZ ?? 4, maxzoom: BASE_SOURCE.info?.maxZoom ?? 16, coverage: BASE_SOURCE.coverage, promoteId: null, encoding: BASE_SOURCE.encoding || "mvt", tag: "basemap:" + BASE_SOURCE.kind + ":" + (BASE_SOURCE.url || "") };
	}
	let p = vtxDescs.get(sid);
	if (!p) {
		p = resolveVectorSource(sp!, location.href, { fetchFn: ((u, init) => requester.fetch(u as string, "Source", init)) as typeof fetch }).then(r => ({
			tileUrl: r.pmtiles ? null : tileUrlOf(r), pmtiles: r.pmtiles || null, minzoom: sp!.minzoom ?? r.minzoom, maxzoom: sp!.maxzoom ?? r.maxzoom, bounds: sp!.bounds ?? r.bounds ?? null, promoteId: sp!.promoteId ?? null, encoding: r.encoding || "mvt", tag: JSON.stringify(r.pmtiles || r.tiles) + "|" + (r.encoding || "mvt"), attribution: sp!.attribution ?? r.attribution ?? null,   // encoding＝タイルの形式（mvt｜mlt・#88）
			vectorLayers: r.vectorLayers ?? null,   // TileJSON の層の一覧（検査表示 #174 の台帳）
		}));
		vtxDescs.set(sid, p);
		p.catch(() => vtxDescs.delete(sid));   // 失敗は覚えない（次の addLayer で取り直す）
	}
	return p;
};
const vtRaw = createRawStore();   // vector source の生のタイルの写し（main・C7）＝querySourceFeatures が同期で解く。vtdraw／vtextrude の両方が入れ、両方が捨てたら消える
dbgHost.__vtraw = vtRaw;
const vtxWarned = new Set<string>();
const vtxMount = async (v: UserLayerRec, layer: MLLayer) => {
	const sid = srcId(layer), desc = await vtxDescOf(sid, v.src);
	if (mlLayers.get(layer.id) !== v) return null;   // 待っている間に外された・置き換えられた
	if (!desc) { console.warn(`[layers] "${layer.id}": source "${sid}" has no vector tiles here — nothing to extrude`); return null; }
	for (const k of ["fill-extrusion-pattern", "fill-extrusion-translate"]) if (layer.paint?.[k] != null && !vtxWarned.has(layer.id + k)) { vtxWarned.add(layer.id + k); console.warn(`[layers] "${layer.id}": ${k} is not supported yet — drawn without it`); }
	if (!EXT && autoBldOn() && !autoBldHidden && !vtxWarned.has("auto-bld")) { vtxWarned.add("auto-bld"); console.info(`[layers] "${layer.id}": the regional basemap also draws its own 3D buildings — hide them with setLayoutProperty("${AUTO_BLD}", "visibility", "none")`); }
	(await vtxGet()).set(layer.id, layer, sid, desc);
	if (!v.src?.[BASE_SRC] && !vtxAttrs.has(sid)) { vtxAttrs.set(sid, vtxAttrOf(desc)); attrZone = null; requestDraw(); }   // 基図の source の出典は基図の欄が持つ
	return null;
};
// ── vector source の fill／line／circle／symbol（段 8⑤・2026-09-27）＝gadgets/vtdraw.js（遅延 chunk・この層が来た時だけ読む＝他の地図は何も変わらない）──
// 本人の裁定「別の流れ・基図の上」：基図の配管は触らない。結合した scene は render worker の "user" の枠へ（基図の塗りと線の上）・注記は vtLabels（基図と同じ衝突）
let vtdCtl: ReturnType<typeof createVTDraw> | null = null;
const vtdDesc: GlobeScope["vtdDesc"] = new Map();       // sid → 解いた記述子（問い合わせがタイルを取り直す）
const vtdMounting: GlobeScope["vtdMounting"] = new Map();   // sid → 記述子を待っている層の数（isSourceLoaded＝まだ）
const vtdOrder: GlobeScope["vtdOrder"] = () => [...mlLayers.values()].filter(v => v.kind === "vtdraw" && vtdCtl?.has(v.layer.id)).map(v => v.layer.id);   // MapLibre の順（下から）
const vtdGet = async () => {
	const m = await import("./gadgets/vtdraw.ts");
	if (vtdCtl) return vtdCtl;
	ownDestroy.push(() => vtdCtl?.destroy());   // 組み役・結合役の worker・リスナー（map.destroy）
	vtdCtl = dbgHost.__vtd = m.createVTDraw(map, {
		raw: vtRaw,   // 生のタイルの写し（querySourceFeatures・C7）
		gs: () => MAP_GS,   // 地図の global-state（#173 段 3b）   // __vtd＝検証窓（debugGlobals の時だけ）
		cam, size: () => size, dpr, lowMem: LOW_MEM, requester, isFlying: () => flying, requestDraw: requestDraw, tileBias: TILE_BIAS, zoomOf: mlZoomOf, fstate: vtxFS, fsKey: vtxFSKey,   // feature-state の置き場は押し出しと同じ（#109）
		sendScene: (scene, transfer) => { wPost({ type: "set", cmd: "scene", data: scene, prop: "user" }, transfer); requestDraw(); },
		sendLabels: (id, list, meta) => { wPost({ type: "set", cmd: "vtLabels", layer: "vt:" + id, data: { list, ...meta } }); requestDraw(); },
		sendHeat: async (id, ll, w) => {   // heatmap 層の点（C1）＝層 id の枠（slot）の heatmap-gl へ。null＝外す（層が外れた・出すタイルに点が無い）
			const v = mlLayers.get(id);
			if (!v || ll == null) { aggCtl?.clear("heatmap", id); return; }
			const agg = await aggGet(); if (mlLayers.get(id) !== v) { agg.clear("heatmap", id); return; }
			agg.heatmapPoints(ll, w as Float32Array<ArrayBuffer>, drawLayerOf(v), id); requestDraw();
		},
	});
	vtdAnchorsOn = true;   // 基図の層の間への差し込み（#123）を配り始める
	return vtdCtl;
};
// 読まない性質（台帳 §4）＝層ごとに 1 回だけ知らせて、無しで描く
const VTD_UNSUPPORTED: Record<string, string[]> = { fill: [], line: [], circle: [], symbol: [], heatmap: [] };   // line-gradient（G-3）は描く（vector の線の進みは環ごとの近似）・line-pattern（G-4）も描く（名前は層で一度）   // symbol の icon-image は段 3 から読む
const vtdMount = async (v: UserLayerRec, layer: MLLayer) => {
	const sid = srcId(layer);
	if (v.src?.type === "geojson") return gjvtMount(v, layer, sid);
	vtdMounting.set(sid, (vtdMounting.get(sid) || 0) + 1);
	let desc;
	try { desc = await vtxDescOf(sid, v.src); } finally { const n = (vtdMounting.get(sid) || 1) - 1; if (n) vtdMounting.set(sid, n); else vtdMounting.delete(sid); }
	if (mlLayers.get(layer.id) !== v) return null;   // 待っている間に外された・置き換えられた
	if (!desc) { console.warn(`[layers] "${layer.id}": source "${sid}" has no vector tiles here — nothing to draw`); return null; }
	for (const k of VTD_UNSUPPORTED[layer.type] || []) if ((layer.paint?.[k] ?? layer.layout?.[k]) != null && !vtxWarned.has(layer.id + k)) { vtxWarned.add(layer.id + k); console.warn(`[layers] "${layer.id}": ${k} is not supported yet on vector sources — drawn without it`); }
	if (layer.type === "circle" && layer.paint?.["circle-pitch-alignment"] === "map" && !vtxWarned.has(layer.id + "cpa")) { vtxWarned.add(layer.id + "cpa"); console.warn(`[layers] "${layer.id}": circle-pitch-alignment "map" is not supported yet — circles face the viewer`); }
	vtdDesc.set(sid, desc);
	const c = await vtdGet();
	if (mlLayers.get(layer.id) !== v) return null;
	c.set(layer.id, layer, sid, desc);
	c.setOrder(vtdOrder());
	sendUserAnchors();   // 基図の層の間への差し込み（#123）
	if (!v.src?.[BASE_SRC] && !vtxAttrs.has(sid)) { vtxAttrs.set(sid, vtxAttrOf(desc)); attrZone = null; requestDraw(); }   // 基図の source の出典は基図の欄が持つ
	return null;
};
// geojson の層を vtdraw へ（geojson vt plan G-2）＝data を worker が切る（core geojsonvt）＝取得の段が無い手元のタイル（desc.local）。
// 層は source-layer＝GEOJSON_LAYER の vector の層として組む（filter・buildTileDrawList・層の順・#123 の差し込みは vector と同じ）。
// 問い合わせは今までの模様の口（patItems＝画面の px で当てる）・querySourceFeatures は data のまま（vtdDesc には載せない）
const gjvtData = new Map<string, { k: unknown[]; p: Promise<unknown> }>();   // sid → 読んだ data（data の参照と setData の世代が同じ間は使い回す＝層ごとに worker へ送り直さない）
const gjvtDataOf = (sid: string, sp: UserSource) => {
	const k = [sp.data, mlGen.get("gjd:" + sid) || 0], c = gjvtData.get(sid);
	if (c && c.k[0] === k[0] && c.k[1] === k[1]) return c.p;
	const d = dataOf(sp), p = typeof d === "string" || d instanceof Blob ? readGeoData(d) : Promise.resolve(d);
	gjvtData.set(sid, { k, p }); p.catch(() => gjvtData.get(sid)?.p === p && gjvtData.delete(sid));
	return p;
};
const gjvtMount = async (v: UserLayerRec, layer: MLLayer, sid: string) => {
	vtdMounting.set(sid, (vtdMounting.get(sid) || 0) + 1);
	let data;
	try { data = await gjvtDataOf(sid, v.src); } finally { const n = (vtdMounting.get(sid) || 1) - 1; if (n) vtdMounting.set(sid, n); else vtdMounting.delete(sid); }
	if (mlLayers.get(layer.id) !== v) return null;
	await addPattern(layer, data, undefined, true);   // 問い合わせ用の地物
	const c = await vtdGet();
	if (mlLayers.get(layer.id) !== v) return null;
	const sp = v.src;
	c.set(layer.id, { ...layer, "source-layer": GEOJSON_LAYER }, sid, { local: data ?? null, tileUrl: null, pmtiles: null, minzoom: 0, maxzoom: (sp.maxzoom as number | undefined) ?? 18, tileSize: 512, promoteId: sp.promoteId ?? null, tag: "geojson" });   // maxzoom＝MapLibre の geojson source の既定 18（裁定 3）
	c.setOrder(vtdOrder());
	sendUserAnchors();
	return null;
};
const vecAttrDrop = (v: UserLayerRec, sid: string) => { if (![...mlLayers.values()].some(x => x !== v && (x.kind === "vtextrude" || x.kind === "vtdraw") && srcId(x.layer) === sid) && vtxAttrs.delete(sid)) { attrZone = null; requestDraw(); } };   // その source を使う層が無くなった＝出典を下げる
// 層を描き出す／取り下げる（登録簿 mlLayers はそのまま＝visibility と setPaintProperty の往復で使う）
// source の中身が載った合図（C8・MapLibre の sourcedata）＝setData／層が載った後に { sourceId }。通訳は data（isSourceLoaded:true）にも写す（例 display-html-clusters-with-custom-properties）
const emitSourceData: GlobeScope["emitSourceData"] = sourceId => { for (const cb of [...mapOn.sourcedata]) { try { cb({ sourceId }); } catch (e) { console.error("[map.on sourcedata]", e); } } };
// setData の畳み（C8）＝同じ source に連打された setData は走っている載せ直しの後に 1 回だけ（例 update-a-feature-in-realtime＝10ms ごと）。返す約束は最新の中身が載った時に解ける
const setDataQ = new Map<string, { again: boolean; p: Promise<void> | null }>();
const setDataLive: GlobeScope["setDataLive"] = id => {
	bumpGen("gjd:" + id);   // 切ったタイルの data（gjvtDataOf）＝同じ物を書き換えて setData されても読み直す
	let q = setDataQ.get(id); if (q) { q.again = true; return q.p!; }
	q = { again: false, p: null }; setDataQ.set(id, q);
	q.p = (async () => { try { do { q!.again = false; await remountSource(id); } while (q!.again); } finally { setDataQ.delete(id); } })();
	return q.p!;
};
const mountLayer: GlobeScope["mountLayer"] = async v => { v.mounting = true; try { return await mountLayerRaw(v); } finally { v.mounting = false; if (!setDataQ.has(srcId(v.layer))) emitSourceData(srcId(v.layer)); sendLabelOrder(); } };
// 利用者の注記の組（"vt:<id>"＝vector の描く層と geojson の symbol 層）の順＝MapLibre の層の順（下から）。注記層が焼いた sort の代わりにこの順位で比べる（後の層が先に置く・T-P3）
let labelOrderSent = "";
function sendLabelOrder() {
	const ids = [...mlLayers.values()].filter(v => v.kind === "symbol" || v.kind === "vtdraw").map(v => "vt:" + v.layer.id), sig = ids.join("\n");
	if (sig === labelOrderSent) return;
	labelOrderSent = sig; wPost({ type: "set", cmd: "vtLabelOrder", data: ids }); requestDraw();
}   // mounting＝載せる途中（isSourceLoaded の材料・画像タイル層は TileJSON/画像の fetch と worker の open を跨ぐ）
const mountLayerRaw = async (v: UserLayerRec) => {
	if (pendingImages.size) await Promise.allSettled([...pendingImages]);   // 直前の addImage を待つ（上の pendingImages）
	const layer = drawLayerOf(v), { kind, src: sp } = v, sid = srcId(layer), data = dataOf(sp), order = mlOrderOf(layer.id);
	if (kind === "vtextrude") return vtxMount(v, layer);
	if (kind === "vtdraw") return vtdMount(v, layer);
	if (kind === "extrude" || kind === "pattern") {
		mlZoomKeys.set(layer.id, zoomKeyOf(layer, cam.zoom, kind === "extrude"));
		if (!inZoomML(layer, cam.zoom)) { if (kind === "extrude") modelCtl?.clearExtrude(layer.id); else { patOv?.post({ type: "removeLayer", id: layer.id }); patItems.delete(layer.id); } return null; }
	}
	if (kind === "raster") {
		// 層の出しズーム＝表示窓（MapLibre の maxzoom は排他・表示窓の上端は包含＝ほんの少し手前）。source の minzoom/maxzoom は tile の z（spec）
		const ro: RasterOptions = { order: "over", opacity: layer.paint?.["raster-opacity"] as number ?? 1, hideFills: false, ...rasterPaintOpts(layer.paint), ...(layer.minzoom != null ? { minZoom: layer.minzoom } : {}), ...(layer.maxzoom != null ? { maxZoom: layer.maxzoom - 1e-6 } : {}) }, adjust = rasterAdjust(layer.paint);
		if (sp.type === "image") { const b = await (await fetch(sp.url!, { credentials: "omit" })).blob(); return map.raster.add(layer.id, { image: b, corners: sp.coordinates as Corners4, name: layer.id }, ro); }
		if (sp.type === "video") return map.raster.add(layer.id, { video: sp.urls as string[], corners: sp.coordinates as Corners4 }, ro);   // #49
		if (sp.type === "canvas") {   // MapLibre の canvas source（C3）＝canvas は id の文字列か要素・animate（既定 true）
			const el = typeof sp.canvas === "string" ? document.getElementById(sp.canvas) : sp.canvas;
			if (!el) throw new Error(`addLayer: canvas source "${srcId(layer)}": canvas "${sp.canvas}" not found`);
			return map.raster.add(layer.id, { canvas: el as HTMLCanvasElement, corners: sp.coordinates as Corners4, animate: sp.animate !== false }, ro);
		}
		// url＝TileJSON（MapLibre）＝取りに行って tiles を得る（段 6・旧＝url を型紙として使っていた）。既定値は MapLibre の raster source（tileSize 512・maxzoom 22）
		let rs = sp;
		if (!sp.tiles?.length && sp.url) { const r = await resolveVectorSource(sp, location.href, { fetchFn: ((u, init) => requester.fetch(u as string, "Source", init)) as typeof fetch }); rs = { ...sp, tiles: r.tiles, minzoom: sp.minzoom ?? r.minzoom, maxzoom: sp.maxzoom ?? r.maxzoom, bounds: sp.bounds ?? r.bounds, attribution: sp.attribution ?? r.attribution, scheme: sp.scheme ?? r.scheme, tileSize: sp.tileSize ?? r.tileSize ?? undefined }; }
		const tpl = /^[a-z][\w+.-]*:/i.test(rs.tiles?.[0] ?? "") ? rs.tiles![0] : new URL(rs.tiles?.[0] ?? "", location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
		return map.raster.add(layer.id, { url: tpl, tileSize: rs.tileSize ?? 512, minZoom: rs.minzoom ?? 0, maxZoom: rs.maxzoom ?? 22, bbox: rs.bounds as Bbox | undefined, attribution: rs.attribution, tms: rs.scheme === "tms", adjust }, ro);
	}
	if (kind === "custom") {
		// url＝層のモジュール（worker 経路・gadgets/customgl-draw.js・PR-7）＝render worker の同一フレームで描き、renderingMode "3d" は本体の深度を深度バッファに前置き＝shader 無改修で地形・建物に隠れる
		if (typeof v.layer.url === "string") {
			v.ov?.remove();
			const abs = (u: string) => new URL(u, location.href).href;
			v.ov = map.overlay({ builtin: "customgl" }, { name: v.layer.id, opts: { module: abs(v.layer.url), three: typeof v.layer.three === "string" ? abs(v.layer.three) : undefined, addons: typeof v.layer.addons === "string" ? abs(v.layer.addons) : undefined, params: v.layer.params, renderingMode: v.layer.renderingMode ?? "3d", depth: v.layer.depth !== false, projection: (customHost as CustomHostLike | null)?.getProjection?.()?.type ?? "mercator" } });
			return null;
		}
		customGet().add(v.layer as unknown as CustomLayer, order); return null;
	}   // main の WebGL2 canvas（customgl.js）。層の object そのまま（this＝層＝onAdd で this.prog 等を持つ書き方）
	if (kind === "hillshade" || kind === "colorrelief") {   // raster-dem のタイルから陰影（hillshade.js）／段彩（colorrelief.js）の画像タイルを作る port プロバイダ→画像タイル層（基図の上・注記の下）
		const ro: RasterOptions = { order: "over", opacity: kind === "colorrelief" ? reliefOpacity(layer) : 1, hideFills: false, ...rasterPaintOpts(layer.paint), ...(layer.minzoom != null ? { minZoom: layer.minzoom } : {}), ...(layer.maxzoom != null ? { maxZoom: layer.maxzoom - 1e-6 } : {}) };
		let ds = sp;
		if (!sp.tiles?.length && sp.url) { const r = await resolveVectorSource(sp, location.href, { fetchFn: ((u, init) => requester.fetch(u as string, "Source", init)) as typeof fetch }); ds = { ...sp, tiles: r.tiles, minzoom: sp.minzoom ?? r.minzoom, maxzoom: sp.maxzoom ?? r.maxzoom, bounds: sp.bounds ?? r.bounds, attribution: sp.attribution ?? r.attribution, encoding: sp.encoding ?? r.demEncoding ?? undefined, tileSize: sp.tileSize ?? r.tileSize ?? undefined }; }   // encoding/tileSize も TileJSON から（setTerrain と同じ）
		ds = { ...ds, tiles: (ds.tiles || []).map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")), encoding: ds.encoding ?? "mapbox", maxzoom: ds.maxzoom ?? 22, tileSize: ds.tileSize ?? 512 };   // MapLibre の raster-dem の既定（encoding mapbox・tileSize 512・maxzoom 22）。⚠この地図の既定は terrarium＝ここで揃えないと勾配が 25 分の 1（3 巡目の轍）
		if (kind === "colorrelief") {
			v.cr?.close();
			v.cr = createColorReliefProvider({ gs: MAP_GS, dem: ds, color: layer.paint?.["color-relief-color"], name: layer.id, attribution: ds.attribution ?? null, tiles: demTilesFor(srcId(layer), ds, layer.id) });
			dbgHost.__colorRelief = v.cr;   // 切り分けの窓（debugGlobals）
			return map.raster.add(layer.id, { port: v.cr.port, name: layer.id, attribution: ds.attribution ?? null }, ro);
		}
		const num = (x: unknown) => evalExpr(x, { zoom: cam.zoom, props: {}, geom: null, vars: {}, gs: MAP_GS, origin: "ml" });
		const paint = Object.fromEntries(Object.entries(layer.paint || {}).map(([k, x]) => [k, Array.isArray(x) && KNOWN_OPS.has(x[0]) ? num(x) : x]));   // 式は今のズームで（色の式も evalExpr が色文字列に）。頭が演算子の時だけ＝multidirectional の色の配列 ["#f40","#ff0",…] を式と取り違えない（2026-09-30）
		v.hs?.close();
		v.hs = createHillshadeProvider({ dem: ds, paint, name: layer.id, attribution: ds.attribution ?? null, warn: m => console.warn(`[hillshade] ${layer.id}: ${m}`), tiles: demTilesFor(srcId(layer), ds, layer.id) });
		dbgHost.__hillshade = v.hs;   // 切り分けの窓（debugGlobals）
		return map.raster.add(layer.id, { port: v.hs.port, name: layer.id, attribution: ds.attribution ?? null }, ro);
	}
	if (kind === "extrude") return extrudeNative(await readPoints(data) as ExtrudeIn, { ...layer, fit: false, slot: layer.id });
	if (kind === "heatmap") { v.heatPts = await readPoints(data); return heatmapNative(v.heatPts, layer, layer.id); }   // 点は問い合わせにも（MapLibre 6 は heatmap も返す＝半径の円で当てる）
	if (kind === "symbol") {
		const cl = clusterOf(sid);   // 集約の source＝全段の丸と単点（段は filter）
		if (gjIsLine(layer)) { symCtl?.removeLayer(layer.id); const c = await gjGet(); return c.set(layer.id, layer, cl ? (await cl).fc : await readPoints(data), order); }   // 線に沿う配置（C9）＝線の地物だけ・点と面は MapLibre と同じく置かない
		// 点置き＝記号と字は注記層（gjlabels の点置き＝基図と同じ衝突・層の位置・テキスト GPU 化 T-P3）。記号の gadget は評価だけ（queryRenderedFeatures・styleimagemissing）
		const pts = cl ? (await cl).fc : await readPoints(data), c = await symGet(); const r = c.addLayer(layer.id, pts, layer, false); c.setOrder(layer.id, order);
		(await gjGet()).set(layer.id, layer, pts, order, true); return r;
	}
	if (kind === "pattern") return addPattern(layer, data, order);
	if (kind === "gint") return rebuildGint(sid);
};
// raster-dem のタイルの在庫＝source ごとに 1 つ（同じ source の hillshade と color-relief が共有＝同じタイルを 2 度取らない）。使う層が居なくなったら捨てる。
// 鍵＝型紙と符号（setStyle 等で同じ id の source の中身が変われば作り直す）
const demStores = new Map<string, { key: string; tiles: DemTiles; users: Set<string> }>();   // source id → { key, tiles, users:Set<layer id> }
// raster-dem のタイルの取得：独自の読み口は MapLibre と同じく type:"image" で頼み、返りを ImageBitmap で渡す（旧＝"arrayBuffer" で頼み ImageBitmap が JSON の "{}" に化けた＝quantized-mesh の陰影が空・2026-09-30）
const demFetch = async (u: string, init: RequestInit = {}) => {
	const rq = requester.resolve(u, "Tile");
	if (!rq.load) return requester.fetch(u, "Tile", init);
	const bm = await protocolBitmap(await rq.load("image"));
	return bm ? { ok: true, status: 200, bitmap: async () => bm } : { ok: false, status: 404 };
};
function demTilesFor(sid: string, ds: UserSource, lid: string) {
	const key = JSON.stringify([ds.tiles, ds.encoding, ds.tileSize, ds.redFactor, ds.greenFactor, ds.blueFactor, ds.baseShift]);
	let e = demStores.get(sid);
	if (!e || e.key !== key) { e = { key, tiles: createDemTiles(ds, { fetchFn: demFetch }), users: new Set() }; demStores.set(sid, e); }
	e.users.add(lid);
	return e.tiles;
}
const demTilesDrop = (lid: string) => { for (const [sid, e] of demStores) if (e.users.delete(lid) && !e.users.size) demStores.delete(sid); };
// color-relief-opacity（既定 1・["zoom"] の式も）＝今のズームで評価。止まるたびに見直す（下の settle）
// raster-resampling／resampling（raster・hillshade・color-relief）と raster-fade-duration（C4）＝paint から層の opts へ。zoom の式は今の zoom で評価（data-constant）
const rasterSampling: GlobeScope["rasterSampling"] = P => { const x = P?.["raster-resampling"] ?? P?.["resampling"]; if (x == null) return undefined; const v = Array.isArray(x) ? evalExpr(x, { zoom: cam.zoom, props: {}, geom: null, vars: {}, gs: MAP_GS, origin: "ml" }) : x; return v === "nearest" ? "nearest" : "linear"; };
const rasterFade: GlobeScope["rasterFade"] = P => { const x = P?.["raster-fade-duration"]; if (x == null) return undefined; const n = Array.isArray(x) ? +(evalExpr(x, { zoom: cam.zoom, props: {}, geom: null, vars: {}, gs: MAP_GS, origin: "ml" }) as number) : +x; return Number.isFinite(n) ? Math.max(0, n) : undefined; };
const rasterPaintOpts: GlobeScope["rasterPaintOpts"] = P => { const o: ReturnType<GlobeScope["rasterPaintOpts"]> = {}, r = rasterSampling(P), f = rasterFade(P); if (r !== undefined) o.resampling = r; if (f !== undefined) o.fadeDuration = f; return o; };
const reliefOpacity: GlobeScope["reliefOpacity"] = L => { const x = L.paint?.["color-relief-opacity"]; if (x == null) return 1; const n = +(evalExpr(x, { zoom: cam.zoom, props: {}, geom: null, vars: {}, gs: MAP_GS, origin: "ml" }) as number); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; };
const unmountLayer: GlobeScope["unmountLayer"] = v => {
	const { layer, kind } = v, id = layer.id, sid = srcId(layer);
	if (kind === "raster") map.raster.remove(id);
	else if (kind === "custom") { if (v.ov) { v.ov.remove(); v.ov = null; } else customCtl?.remove(id); }
	else if (kind === "hillshade") { map.raster.remove(id); v.hs?.close(); v.hs = null; demTilesDrop(id); }
	else if (kind === "colorrelief") { map.raster.remove(id); v.cr?.close(); v.cr = null; demTilesDrop(id); }
	else if (kind === "extrude") modelCtl?.clearExtrude(id);
	else if (kind === "vtextrude") { vtxCtl?.remove(id); vecAttrDrop(v, sid); }
	else if (kind === "vtdraw") { vtdCtl?.remove(id); patItems.delete(id); if (layer.type === "heatmap") aggCtl?.clear("heatmap", id); vecAttrDrop(v, sid); sendUserAnchors(); }
	else if (kind === "heatmap") aggCtl?.clear("heatmap", id);
	else if (kind === "symbol") { symCtl?.removeLayer(id); gjCtl?.remove(id); }
	else if (kind === "gint") return rebuildGint(sid);
	else if (kind === "pattern") { patOv?.post({ type: "removeLayer", id }); patItems.delete(id); }
};
map.on("settle", () => {   // 押し出し・模様は一度きりの評価＝止まるたびに zoom の鍵を見て、変わった層だけ描き直す（段 5）
	for (const v of mlLayers.values()) if (v.kind === "colorrelief" && mlVisible(v) && Array.isArray(v.layer.paint?.["color-relief-opacity"])) map.raster.set(v.layer.id, { opacity: reliefOpacity(v.layer) });
	for (const v of mlLayers.values()) if ((v.kind === "extrude" || v.kind === "pattern") && mlVisible(v)) { const L = drawLayerOf(v); if (mlZoomKeys.get(L.id) !== zoomKeyOf(L, cam.zoom, v.kind === "extrude")) mountLayer(v); }
});
const reorderLayers: GlobeScope["reorderLayers"] = () => {   // 登録順を各描き方の重ね順へ
	if ([...mlLayers.values()].some(v => v.kind === "gint")) rebuildGint();   // gint の pass は詰め方ごと組み直す（連続の切れ目が変わる）
	for (const v of mlLayers.values()) if (v.kind === "symbol" && mlVisible(v)) { symCtl?.setOrder(v.layer.id, mlOrderOf(v.layer.id)); gjCtl?.setOrder(v.layer.id, mlOrderOf(v.layer.id)); }
	for (const v of mlLayers.values()) if (v.kind === "pattern" && mlVisible(v)) mountLayer(v);   // 模様は送り直しで順が付く
	vtdCtl?.setOrder(vtdOrder());   // vector の描く層（段 8⑤）＝順の鍵（増えている間は組み直さない）
	sendUserAnchors();              // 基図の層の間への差し込み（#123）＝順が変われば差し込む位置も変わる
	sendLabelOrder();
	for (const v of mlLayers.values()) if (v.kind === "custom") customCtl?.setOrder(v.layer.id, mlOrderOf(v.layer.id));
};
// MapLibre の custom 層の器（main の透明な WebGL2 canvas・注記の下）。層が来た時に作る。hostMap＝onAdd/render に渡す map（MapLibre の口が自分を差す口＝map.setCustomLayerHost）
let customCtl: ReturnType<typeof createCustomGL> | null = null, customHost: GlobeLive["customHost"] = null;
// worker が描いた絵ごとの hook（frame 事象）＝custom 層の canvas を地図と同じ cam・同じ時刻で描く。誰かが要る間だけ worker に頼む
const workerFrameFns = new Set<(cam: CameraPose, t: number) => void>();
const onWorkerFrame = (fn: (cam: CameraPose, t: number) => void) => { workerFrameFns.add(fn); if (workerFrameFns.size === 1) wPost({ type: "set", cmd: "frameEvents", data: true }); return () => { workerFrameFns.delete(fn); if (!workerFrameFns.size) wPost({ type: "set", cmd: "frameEvents", data: false }); }; };
dbgHost.__onWorkerFrame = onWorkerFrame;   // 切り分けの窓＝main の cam と worker が描いた cam の差（遅れ）を測る
const customGet = () => customCtl ??= createCustomGL({ mapEl, before: labelCanvas, size: () => size, cam, earthM: EARTH_M, requestDraw: requestDraw, onFrame: fn => map.onFrame(fn), onWorkerFrame, get hostMap() { return customHost ?? map; } });
// #123：vector の描く層（vtdraw）の差し込み＝各層の「直後の基図の層」の li（style.layers の添字＝基図のタイルの op の li）を描画器へ（userAnchor）。
// 描画器は li がそれ以上の基図の項の前でその層を描く・直後に基図の層が無い＝今どおり基図の上（表に載せない）。タイルは組み直さない（基図の sea／bldFill と同じ作法）。
// 巻き上げの関数＝基図の再ビルド（setPipelineStyle・起動の途中にも走る）から呼ばれる＝vtdAnchorsOn（vtdraw を作った後に立つ）までは何もしない
let userAnchorSig = "";
function sendUserAnchors() {
	if (!vtdAnchorsOn || !vtdCtl) return;
	const liOfBase = new Map((style.layers || []).map((L, i) => [L.id, i])), order = styleOrder(), ranges = [];
	let next = null;
	for (let i = order.length - 1; i >= 0; i--) {
		const e = order[i];
		if (e.base) { const li = liOfBase.get(e.id); if (li != null) next = li; continue; }
		if (next != null && e.v?.kind === "vtdraw") { const r = vtdCtl.liRange(e.id); if (r) ranges.push([r[0], r[1], next]); }
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const sig = JSON.stringify(ranges); if (sig === userAnchorSig) return;
	userAnchorSig = sig; renderer.set("userAnchor", { ranges }); requestDraw();
}
// style・source・layer の口＝src/api/style.ts（live＝createGlobe の変数を読み書きする口）
const { extExtras, remergeBase, addSourceAt, addLayerAt, remountSource, styleOrder } = installStyle(map, {
	get customHost() { return customHost; }, set customHost(v) { customHost = v; },
	get customCtl() { return customCtl; },
	get EXT() { return EXT; }, set EXT(v) { EXT = v; },
	get videoCtl() { return videoCtl; },
	get aggCtl() { return aggCtl; },
	get vtdQueryCache() { return vtdQueryCache; },
	get MAP_GS() { return MAP_GS; },
	get style() { return style; }, set style(v) { style = v; },
	get vtxCtl() { return vtxCtl; },
	get vtdCtl() { return vtdCtl; },
	get autoBldRemoved() { return autoBldRemoved; }, set autoBldRemoved(v) { autoBldRemoved = v; },
	get bg() { return bg; }, set bg(v) { bg = v; },
	get land() { return land; }, set land(v) { land = v; },
	get autoBldHidden() { return autoBldHidden; },
	get spriteList() { return spriteList; }, set spriteList(v) { spriteList = v; },
	get mlGlyphs() { return mlGlyphs; }, set mlGlyphs(v) { mlGlyphs = v; },
	get mlLight() { return mlLight; }, set mlLight(v) { mlLight = v; },
	get mlSky() { return mlSky; }, set mlSky(v) { mlSky = v; },
	get theme() { return theme; },
	get inspectReapply() { return inspectReapply; },
	get themes() { return themes; }, set themes(v) { themes = v; },
	get readySig() { return readySig; }, set readySig(v) { readySig = v; },
	get baseSig() { return baseSig; }, set baseSig(v) { baseSig = v; },
	get attrZone() { return attrZone; }, set attrZone(v) { attrZone = v; },
	get dpr() { return dpr; },
	get renderBackend() { return renderBackend; },
	get paintTable() { return paintTable; },
}, { AUTO_BLD, BASE_SOURCE, BASE_SRC, DEBUG_GLOBALS, GJVT, NO_BG_WHITE, PUBLIC_DZ, R2D, STYLE_DZ, animNow, assertMLLayer, autoBldLayer, autoBldOn, autoBldReadOnly, baseOverrides, baseMoves, moveBefore, baseSidNow, baseSrcSpec, baseVis, bgOf, bldFillLi, cam, dbgHost, drawLayerOf, dropFollow, emitSourceData, extBaseStyle, extSourceFields, isVecSrc, kindOf, landDefault, landOf, loadExtStyle, mergeReq, mkThemes, mlFeatureState, mlGintData, mlIdOf, mlLayers, mlPasses, mlSourceDz, mlSources, mlVisible, mountLayer, onMove, rasterAdjust, rasterFade, rasterPaintOpts, rasterPend, rasterSampling, clusterOf, clusterNow, rebuildGint, reliefOpacity, renderer, reorderLayers, requestDraw, requester, seaLi, seaOf, sendLight, sendSky, sendUserAnchors, setAutoBld, setDataLive, setDataQ, setMapGS, setPipelineStyle, setSrcAttr, size, spriteDrop, spriteLoad, spriteNames, srcId, srcOf, stripMl, unmountLayer, userBg, vtRaw, vtRouted, vtdDesc, vtdMounting, vtdOrder, vtxDescs, vtxFS, vtxFSKey, vtxStateOf, wPost, withBaseOverrides, withPM, withUserBg });
// 描画結果への問い合わせと層ごとのイベント＝src/api/query.ts（live＝後から差し替わる変数の口）
const { extView, meshPickEnv, vtdQueryCache } = installQuery(map, {
	get MAP_GS() { return MAP_GS; },
	get clipMain() { return clipMain; },
	get demSpec() { return demSpec; },
	get dpr() { return dpr; },
	get imageQuads() { return imageQuads; },
	get lastTileOrder() { return lastTileOrder; },
	get modelCtl() { return modelCtl; },
	get noTerr() { return noTerr; },
	get style() { return style; },
	get symCtl() { return symCtl; },
	get t3dCtl() { return t3dCtl; },
	get vtdCtl() { return vtdCtl; },
	get vtxCtl() { return vtxCtl; },
}, { BASE_SOURCE, D2R, EARTH_M, ELL_ON, IMAGE_KEY, PUBLIC_DZ, R2D, REGION_DTM, TERR_EXAG, ac, baseSidNow, cam, canvas, clipAllCut, clipCutXY, clipFor, drawLayerOf, evXY, gint, hiddenAll, inZoomML, input, isOv, mlIdOf, mlLayers, mlPasses, mlVisible, noMixedR01, overlayFeature, patItems, requester, size, srcId, stripMl, unprojectXY, vtdDesc, vtdOrder, vtxGround, vtxStateOf });
// 検査表示・ファイルの取り込み・編集・デモの gadget＝src/api/tools.ts（live＝createGlobe の変数を読み書きする口）
const { rasterDropFile } = installTools(map, {
	get lastTileOrder() { return lastTileOrder; },
	get vtdCtl() { return vtdCtl; },
	get EXT() { return EXT; },
	get inspectHide() { return inspectHide; }, set inspectHide(v) { inspectHide = v; },
	get inspectReapply() { return inspectReapply; }, set inspectReapply(v) { inspectReapply = v; },
	get autoBldHidden() { return autoBldHidden; },
	get land() { return land; },
	get annoCtl() { return annoCtl; },
	get cogCtl() { return cogCtl; },
	get gFollow() { return gFollow; }, set gFollow(v) { gFollow = v; },
	get czmlCtl() { return czmlCtl; },
	get modelCtl() { return modelCtl; },
	get columnarCtl() { return columnarCtl; }, set columnarCtl(v) { columnarCtl = v; },
	get editDocHook() { return editDocHook; }, set editDocHook(v) { editDocHook = v; },
	get editDropOwner() { return editDropOwner; }, set editDropOwner(v) { editDropOwner = v; },
	get readySig() { return readySig; },
	get mainDesired() { return mainDesired; },
	get elevBusy() { return elevBusy; },
	get elevN() { return elevN; },
}, { BASEMAP_MINZOOM, BASE_SOURCE, CAM_ZOOM_MIN, HOME_VIEW, REGION_HOME, WORLD_VT, ZOOM_MIN, ac, registerGadget, baseSidNow, baseSrcSpec, cam, canvas, clearImages, evXY, flightCtl, flyTo, flyView, gint, glidePathView, loadUserFile, meshMgr, mlLayers, mlSources, mlVisible, opts, remergeBase, renderer, requestDraw, requester, scenes, setAutoBld, size, t, unprojectAt, vtxDescOf });
// tip（カーソル追従の吹き出し）を既定搭載＝gint 層のホバー識別を指先へ。搭載はここ一箇所（dropFile/14条どの経路でも効く）。
// 見えない div＝gint interactive 層をホバーした時だけ内容が出る＝非gintの埋め込みでは無害。
gint.hoverTip = map.gadget.tip();
// ── 世界帯の中身（opts.worldContent・2026-09-24）＝低ズーム（z<BASEMAP_MINZOOM）に Equal Earth と同じ情報：州境・係争地・市街地・道路・鉄道・
// 湖の岸線・国名・首都/都市・空港（規則と配色は ortho-core の正本 worldcontent/worldstyle＝equal・world と共有・データも同じ bucket を同じキャッシュ名で）。
// 本人「equal に入れた追加情報は最終的に globe に同じ情報を入れるため」＝まず日本を持たない globe（z8 まで）から。japan（z6.5〜8 は基図と重なる）は後日
if (opts.worldContent && WORLD_VT) {
	worldContentH = createWorldContent({ addGint: gint.addGint, geopbf, symbols: symbolsNative, addImage: map.addImage,
		getZoom: () => cam.zoom, lang: getLang(), worldStyle: () => WORLD_STYLE_THEMES[themeName] || WORLD_STYLE_THEMES.mono,
		bandZ: BASEMAP_MINZOOM, lowMem: LOW_MEM, requestDraw: requestDraw, groups: (typeof opts.worldContent === "object" ? opts.worldContent.groups : null) ?? null });
	map.on("settle", () => { if (!flying) worldContentH!.update(); });   // 止まるたび＝見える帯に入った群だけ取りに行く
	map.on("load", () => worldContentH!.update());                          // 初回の描画（起動時の視点が確定した後）でも判定＝動かさなくても detail が来る
	worldContentH.update();
	dbgHost.__worldContent = () => worldContentH!.state();   // 検定窓（t-worldcontent）
}
// 地域パックが起動後に足す物（e-Stat 小地域＝map.estat 等・LAYERS.md 段階 2 S3）。ホストの内部でなく拡張面（hostEnv）だけを渡す
const hostEnv = { opts, renderer, cam, size, dpr, requestDraw: requestDraw, overlay, spawnWorker: hostWorker, ownTip, hooks: hostHooks, t, dbg: dbgHost, assetBase: ASSET_BASE, onDestroy: (f: () => void) => hostDestroy.push(f) };
for (const r of REGIONS) if (r.install) await r.install(map, hostEnv);
for (const p of opts.plugins ?? []) Array.isArray(p) ? map.use(p[0], p[1]) : map.use(p);   // 起動時の plugin（PR-F0）＝地域パックの後・顔を被せる前（素の map を受ける）

// 旗なし＝素の map をそのまま・旗つき＝外側の顔（公開面の数の zoom を MapLibre の z で受け渡す）。地域パック・ガジェットは上で素の map を握った
return createFacade(map, PUBLIC_DZ, { shiftZoomExpr });
}
