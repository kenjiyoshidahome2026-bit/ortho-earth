// 地球儀のホスト（LAYERS.md の globe 層）＝createGlobe(opts)。地域（基図・標高・台帳・語彙・起動後の拡張）は opts.region の申告で足す＝このファイルは地域名を知らない。
// 意匠：quiet-mono（トークン→部品）→ app固有 の順に import＝カスケードの序列そのまま
import "quiet-mono/tokens.scss";
import "quiet-mono/components.scss";
import "./style.scss";
import {
	evalExpr, truthy, parseRGBA, cameraState, project, unproject, buildGeoJSONOverlay,
	createFlight, shortBearingOf, parseViewHash, buildViewHash, wrapLon, createInput, WORLD_PX, lonLatToTile,
	primeVerticalRadius, setEllipsoid, ellipsoidOn, worldRadiusM, betaToLonLat,
} from "@ortho-earth/core";
import { createGeopbf, geopbf } from "geopbf";
import { hasHeightKey } from "./extrude-keys.js";
import patUrl from "./pattern-2d.js?url";   // 塗り/線の模様（fill-pattern/line-pattern）のオーバーレイ＝依存ゼロ（worker が URL で import）   // ドロップ図形の自動押し出し判定（鍵の表は gadgets/model.js と共有）
import { nativeBucket } from "native-bucket";
import { createGetHeight, setApiUrl as setAltApiUrl, setWorkerFactory as setAltWorkerFactory } from "altpbf/loader";
import { setWorkerFactory as setGeoeditWorkerFactory } from "geoedit/worker-factory";   // 口だけの小さな入口（geoedit 本体は遅延 chunk のまま）＝起動時に設定＝initEditor を直に呼ぶ検定ページも入口を通る
// 部品の worker（geopbf の変換・解析・COG・タイル書き出し／エンジンのタイル・シーン／altpbf の標高／geoedit の編集モデル）も
// アプリの入口 1 本（worker.js）で走らせる＝共有部品（geopbf の核など）を render/estat 等と共有（2026-09-22・標準の作法）。
// 役割名は部品が付ける（"decoder:fgb" "ortho:tile" 等）＝options は静的でない＝@vite-ignore（worker の組み立て自体は vite が行う）。
// ⚠部品の組み込み worker はビルドの alias で「作らない版」に差し替え済み（vite.config.js）＝この口が必ず Worker を返すこと
const hostWorker = role => new Worker(new URL("./worker.js", import.meta.url), /* @vite-ignore */ { type: "module", name: role });
setAltWorkerFactory(hostWorker);
setGeoeditWorkerFactory(hostWorker);
createGeopbf("https://api.ortho-earth.com", { bucket: nativeBucket, prewarm: true, workerFactory: hostWorker });   // bucket 基盤（標高と同じ）。読み出しはキー不要・bucket=native-bucket注入（geopbf自体は依存ゼロ化 8/21）。prewarm＝復号レーンを先に起こす（起動直後に海岸線/湖/星を必ず解く）
// SDK 公開面：初期化済みの geopbf を再エクスポート（2026-09-10・npm 利用者が別途 `npm i geopbf` せず、バンドラも import map も無しで
// データを載せられる＝同梱の worker チャンクがそのまま動く）。createGeopbf は出さない＝利用者が呼び直すと上の bucket 設定ごと
// アクティブインスタンスが差し替わる（同一モジュールのグローバル）ため。型は sdk/ortho-japan.d.ts。
export { geopbf };
import { Marker, Popup } from "./gadgets/marker.js";   // DOM の Marker / Popup（#38・MapLibre と同名）＝小さい部品なので静的
export { Marker, Popup };
import { createRequester, addProtocol, removeProtocol } from "./request.js";   // 取得の前の手入れ（#37・transformRequest / addProtocol）
export { addProtocol, removeProtocol };
import { MAP_THEMES } from "./palettes.js";
import { WORLD_STYLE_THEMES, normWorldTheme } from "@ortho-earth/core/worldstyle";   // 世界の地図面の配色の正本（名札・世界線の色・c= の別名）
import { createThemes, defaultLayerState, isFacility, isTerrain, CHOME_MINZOOM, CHOME800_MINZOOM, RAILTR_MINZOOM } from "./themes.js";
import { createOverlay } from "./overlay.js";

// planets.js と星座/メシエ名（bucket GIS/space）は z<4（星空）でしか使わない＝初期バンドルから外し、下の ensureSkyMod で動的読込。
import { createPipeline, pmtilesInfo, isRasterTileType, queryTiles, splitMapLibreStyle, loadMapLibreStyle, resolveVectorSource, tileUrlOf, expandTemplate, wmsTemplate, createDemSource } from "@ortho-earth/core";
import { pmLayers, pmRoles } from "./style-pm.js";   // ?pm= の層名→役割→描画規則（静的import＝?pm= を使わない構成でも数百バイト）
import { sanitizeHTML } from "geopbf/sanitize";   // ?pm= のアーカイブが宣言する出典 HTML は非信頼入力＝出力境界で消毒   // tile/scene worker のスポーンごとエンジン側
import { createGintLayers } from "./gint/layers.js";
import { createWorldContent } from "./gint/worldcontent.js";   // 世界帯に Equal Earth と同じ中身（opts.worldContent・2026-09-24）   // gint（知性の層）＝単一スロット・多層・admin0・bake-ahead・ドレープ・fid 塗り（同）
import { createClock, fmtUTC } from "@ortho-earth/ephem/clock";   // 共通の時計（#42）＝solar と同じ部品。夜の側・星・太陽系圏・overlay（衛星）がこの時刻で描く
import { createSkyTheater } from "./sky/theater.js";   // 星空劇場（z<4）＝星・惑星・月・星座・日時計・太陽系圏との交代（同）
import { createScenePlayer } from "./scenes/player.js";
import { lowMem, classifyTier, probeGL as probeWebGL2, fatalOverlay as showFatal, deadMap } from "./boot/tier.js";   // 起動時の裁き＝純関数（t-tier で検定）   // シーン再生プレーヤー＝上映・停止・タイムライン・黒幕・待ちパネル（同）
import { mountGadgets } from "./gadgets/mount.js";
import { dockStack } from "./gadgets/stack.js";   // 左下ドック（座標計器・読込トーストの容れ物＝重なりの構造的排除）
import { search as searchGadget } from "./gadgets/searchbox.js";
import { hint as hintGadget } from "./gadgets/hint.js";
import { compass as compassGadget } from "./gadgets/compass.js";
import { solar as solarGadget } from "./gadgets/solar.js";
import { equal as equalGadget, equalHereItem, goEqual } from "./gadgets/equal.js";
import { mesh as meshGadget } from "./gadgets/mesh.js";
import { palette as paletteGadget } from "./gadgets/palette-stub.js";   // 玄関スタブ＝ボタン常駐、本体(palette.js＝色域写像＋合成)は起動後アイドルで先読み（常用ゆえ押した時に即開く）
import { zoom as zoomGadget } from "./gadgets/zoom.js";
import { full as fullGadget } from "./gadgets/full.js";
import { cpos as cposGadget } from "./gadgets/cpos.js";
import { contextmenu as contextmenuGadget } from "./gadgets/contextmenu.js";
import { tip as tipGadget } from "./gadgets/tip.js";
import { pop as popGadget } from "./gadgets/pop.js";
import { explain as explainGadget } from "./gadgets/explain.js";
import { legend as legendGadget } from "./gadgets/legend.js";
import { measure as measureGadget } from "./gadgets/measure-stub.js";
import { stac as stacGadget } from "./gadgets/stac-stub.js";   // 衛星シーン検索の玄関スタブ（本体 stac.js は初回クリックで遅延）   // 玄関スタブ＝ボタン+Mキー常駐、本体(measure.js＝球面測地/専用canvas)は初回クリック/Mで import()
import { profile as profileGadget } from "./gadgets/profile-stub.js";
import { clockGadget } from "./gadgets/clock.js";   // 時計の操作盤（#42）＝map.clock の ◀◀ ▶ ▶▶・日時・今
import { viewshed as viewshedGadget } from "./gadgets/viewshed.js";   // 可視域・見通し線（#44）＝同じ worker
import { sunShadow as sunShadowGadget } from "./gadgets/sunshadow.js";   // 日影（#44）＝ボタン＋小さなパネル（計算は model 役の worker・sunshadow.js）   // 玄関スタブ＝ボタン常駐、本体(profile.js＝断面図：経路指定+標高サンプル+グラフ)は初回クリックで import()
import { shot as shotGadget } from "./gadgets/shot-stub.js";   // 玄関スタブ＝デスクトップのみボタン常駐、本体(shot.js＝層合成/webp/出典焼込)は初回クリック/⌘Sで import()。モバイルは stub が即return＝本体も fetch されない
import { qr as qrGadget } from "./gadgets/qr-stub.js";   // 玄関スタブ＝ボタンだけ常駐、本体(qr.js＋自作QRエンコーダ qrcode.js 14KB)は初回クリックで import()＝初期バンドルから隔離
import { home as homeGadget } from "./gadgets/home.js";   // 地域の全体へ戻る（顔と着地点は地域宣言 home が持つ）
import { raster as rasterGadget } from "./gadgets/raster.js";   // 画像タイル（ラスタ）の切替＝v1 Layers/setBase の後継（地域パックのカタログ・2026-09-21）
import { globe as globeGadget } from "./gadgets/globe.js";     // ミニ地球儀（右下・視野の枠）＝v1 accessories globe の移植（2026-09-21）
import { print as printGadget } from "./gadgets/print-stub.js";   // 本体(print.js)は初回起動時にimport()＝初期バンドルから隔離
import { close as closeGadget } from "./gadgets/close.js";
import { dropFile as dropFileGadget, gunzipText } from "./gadgets/dropfile.js";
import { edit as editGadget } from "./gadgets/edit.js";
import { editDocLoad, editDocSave, editDocClear } from "./gadgets/editdoc.js";   // 編集中の図形の置き場（編集ボタンを載せた頁だけ使う）   // 編集ボタン（本体は geoedit（npm） の遅延chunk＝これは入口だけ）   // dropfileは起動時常駐（ドロップ受付）＝静的一本。gunzipTextもここから（動的importと混ぜるとチャンク分割が死ぬ）
import { demo as demoGadget } from "./gadgets/demo-stub.js";   // 玄関スタブ＝同期ファサードを即返し、本体(demo.js＝再生エンジン)は搭載時に import()＝初期バンドルから隔離
import { modalOpen } from "./gadgets/keys.js";   // 矢印キーのモーダル抑止に使う共通判定（ショートカット群と共有）
import { setLang, getLang, isRTL, tr } from "./i18n.js";   // UI 多言語化（英語キー・26 言語・詳細は i18n.js）。地図の中身（地名等）は対象外

// app.js 持参のUI辞書（ja文字列がキー・未訳はjaのまま出る）。ガジェット各自の辞書は各ファイル冒頭に。
const t = tr();

// ============================================================================================
// ortho-japan：1行で日本が立ち上がる入口（v1 orthoMap の作法の継承）。
//   const map = await orthoJapan();                    // body直下の #map（無ければ自作）に起動
//   const map = await orthoJapan({ target: "#here" }); // 任意のdivへ埋め込み（idはmapに正規化＝家具規格）
//   opts.view="#z/lat/lon..." で初期視点を上書き。戻り値＝{ cam, flyTo, renderer, mapEl, gadget, destroy }
//   map.destroy()＝worker・リスナー・ループ全停止＋DOM撤去（SPAで剥がす時。IDBキャッシュは残す）
//   opts.layers＝表示項目の固定（キー: place地名/terrain地形/rail鉄道/road道路/facility施設）：
//     true=常時表示・false=常時非表示（どちらもチップ非搭載＝客に触らせない）、未記述=既定値から開始＋チップで選択
//     例: { rail: true, facility: false }＝鉄道焼き付け・施設封印・残り3つは客に委ねる
//   opts.chips＝チップ帯そのものの表示（true=搭載[既定]／false=出さない）。旧配列形式は後方互換で残存（非推奨）
//   opts.instruments＝下部の計器盤の表示（true=全部[既定]／["pos","scale","attr","log"]から選択的／false=出さない）
//   ★"attr"（出典）を消す場合は埋め込みページ側で出典明記が必要（README「出典表記」）
//   opts.mesh＝建物3D（建物メッシュ）機能スイッチ（true=[既定]／false=カタログ・worker・自動ロード・ガジェットごと停止）。旧名 opts.plateau は非推奨の別名（mesh が優先）
//   opts.maxPitch＝チルト上限rad（0=俯瞰固定。geoedit等の編集アプリ用。未記述=既定MAXPITCH＝従来どおり）
//   opts.stars＝恒星（stars.6）のスイッチ（true=[既定]／false=恒星だけ描かない。惑星・月・星座・太陽系圏は従来どおり＝人工衛星ページ用）
//   opts.countryTip＝世界ビュー(z<5.5)のホバー国名 tip（true=[既定]／false=出さない＝自前の tip と重ねない器）
//   opts.theme＝配色テーマの固定（"dark"等の台帳名＝焼き付け・URLに書かない／台帳と同形のオブジェクト＝カスタムテーマ）。
//     未記述＝共有URLの c=<name> で選択（既定 mono＝白地図。台帳は palettes.js）
//   検索・操作説明はオプトインガジェット＝ map.gadget.search() / map.gadget.hint() で画面ごとに追加（v1 ortho-map の作法）
// ============================================================================================
// ★地球儀のホスト（LAYERS.md の globe 層）。地域は opts.region の申告だけで足す＝この関数は地域名を知らない（JP/日本/地理院を書かない）。
//   region＝地域宣言（packages/jp の JP_REGION の形）。配列でも単体でもよい。**省略・[]・null＝申告なし**＝基図・裸地標高・ラスタ台帳・
//   出典・戻り先・検索・POI・鉄道が来ない＝世界データだけの地球儀（apps/world の国の地図パネル）。
//   有効な地域宣言は**使う所より前で決める**（render worker の init が最初の利用者・TDZ の轍 2026-09-17）。
export async function createGlobe(opts = {}) {
const requester = createRequester();   // 取得の前の手入れ（#37）＝opts.transformRequest／map.setTransformRequest・独自スキームは addProtocol（大域）
requester.setTransform(opts.transformRequest);
const REGIONS = [].concat(opts.region || []).filter(Boolean);
const REGIONLESS = !REGIONS.length;   // 地域の申告が一つも無い＝世界データだけで描く（地域の台帳も読まない）
const hostHooks = { hover: [] };   // 地域パックが差す口（hover(x,y)→true＝処理した）＝拡張面（region.install が使う・S3）
const hostDestroy = [];            // 地域パックの片付け（map.destroy が呼ぶ）
const REGION_DTM = REGIONS.find(r => r.dtm)?.dtm ?? null;            // 裸地標高の申告（今は日本だけが持つ）
// 建物の申告＝「台帳の在り処」と「焼きの置き場」の対。どちらも地域が持ち、ホストは中身を知らない。
const stampBake = (sets, b) => b.bakeBase ? sets.map(s => s.bakeBase ? s : { ...s, bakeBase: b.bakeBase }) : sets;   // 台帳の各 set へ焼きの置き場を刻む（区ごとの別置き場も許す）。無宣言＝焼き無し＝生経路のみ
const REGION_SETS = REGIONS.flatMap(r => r.buildings ? stampBake(r.buildings.sets ?? [], r.buildings) : []);   // その場で配る建物台帳（オランダ 3 件）
const REGION_CATALOG = REGIONS.map(r => r.buildings).filter(b => b?.catalog);   // 取得する台帳の申告（日本の 336 件）＝{ catalog, bakeBase? }
const REGION_EXCLUDE = REGIONS.map(r => r.buildings?.exclude).filter(Boolean);   // 除外タイル表
const REGION_LANDMARK = REGIONS.map(r => r.buildings?.landmarks).filter(Boolean);   // ランドマークの名札
const REGION_ATTR = REGIONS.map(r => r.attribution).filter(Boolean);   // 出典（表示義務）＝入口ごとに差し替わる
const REGION_HOME = REGIONS.map(r => r.home).find(Boolean) ?? null;    // 「全体へ戻る」の着地点（日本＝列島ビュー）・null＝戻りボタン無し
const REGION_SEARCH = REGIONS.map(r => r.search).find(Boolean) ?? null;   // 地名検索の供給元（日本＝地理院 AddressSearch）・null＝検索窓無し
const REGION_POI = REGIONS.map(r => r.poi).find(Boolean) ?? null;      // 施設の点の台帳（日本＝POI 台帳 z14）・null＝読まない
const REGION_RAIL = REGIONS.map(r => r.rail).find(Boolean) ?? null;    // 路線オーバーレイ（日本＝N02 新幹線）・null＝作らない
// UI言語を最初に確定（opts.lang > ?lang= > ブラウザ言語）。以降のfatal/トースト/ガジェットが全て従う。
await setLang(opts.lang);   // 訳の用意まで待つ（ja/en は静的＝即返り・他言語は 1 本取る）
// 起動の容れ物：target指定（selector/要素）→ 無ければ既存#map → それも無ければbody直下に自作。
// 意匠（quiet-mono）とガジェットは id="map" の家具規格で当たるため、容れ物のidはmapへ正規化する。
// ※ id→クラス化（多重化/二本建）は quiet-mono の #map スコープ移設(→中立クラス)とセットでないと
//   容れ物が無スタイル＝0サイズ化して射影が退化する。単独で変えないこと（回帰の轍）。
let mapEl = (typeof opts.target === "string" ? document.querySelector(opts.target) : opts.target)
	|| document.getElementById("map");
const ownMapEl = !mapEl;   // 容れ物を自作した＝destroy で丸ごと消してよい（預かった div は中身だけ空にして返す）
// 容れ物を自作した＝このページを預かった＝ビューポート全面を取りに行く。寸法は html/body へ
// **inline で**入れる（スタイルシートからは一切書かない＝埋め込み時は発火しようがない・destroy で元に戻す）。
// ★これが無いと「body に height の無いページ」で #map(height:100%) が 0 になり射影が退化する
//   ＝スタンドアロンの tests/*.html が全滅する（2026-08-19 の意匠移設で実際に踏んだ轍）。
// ★mapEl 自身を position:fixed で浮かせる手もあるが不可：流れから外れると画面分割（親を flex 化して
//   mapEl.flex を効かせる型・旧 AI ガジェットで踏んだ轍）が死ぬ。容れ物は流れの中に置く。
// 預かった div（target 指定）とホストの html/body には指一本触れない＝寸法はホストの領分。
const pageStyle = { html: null, body: null };
if (ownMapEl) {
	mapEl = document.body.appendChild(document.createElement("div"));
	const root = document.documentElement;
	pageStyle.html = root.style.cssText; pageStyle.body = document.body.style.cssText;
	root.style.height = "100%";
	Object.assign(document.body.style, { height: "100%", margin: "0", overflow: "hidden" });
}
const mapElPrevId = mapEl.id;   // 預かった div の元の id＝destroy で返す（#here が消えたままにしない）
// ★家具規格の代償：預かった div の id を map へ改名する＝ホストが「その id」でCSSを書いていた場合、
//   その指定は改名の瞬間に外れる（寸法を id で与えていると #map{height:100%} が親無しで 0 になり地図が消える）。
//   黙って0サイズにするのが最悪なので、借りる時に一度だけ言う。寸法はクラスか inline style で与えてもらう。
if (mapElPrevId && mapElPrevId !== "map")
	console.warn(`[globe] borrowing container id "${mapElPrevId}" -> "map" (furniture standard). `
		+ `CSS targeting #${mapElPrevId} will no longer apply = give dimensions via class or inline style. `
		+ `destroy() restores the id.`);
mapEl.id = "map";
// 言語と書字方向は容れ物に付ける（html/body には触れない＝埋め込み先の領分）。dir=rtl で
// 論理プロパティ（inset-inline-start 等）が鏡像になり、ブラウザの bidi がアラビア/ヘブライの行を正しく並べる。
const mapElPrevLang = mapEl.lang, mapElPrevDir = mapEl.dir;   // destroy で返す
mapEl.lang = getLang();
mapEl.dir = isRTL() ? "rtl" : "ltr";
// 舞台のcanvas 2層（基図GL＝知性gintも同居/ラベル）も自給＝index.htmlは空のdivだけでよい
// （旧・#gint 別canvas は 1canvas統合で撤去＝gint は render worker の GL パスとして #c に描かれる）
for (const cid of ["c", "labels"]) { const cv = document.createElement("canvas"); cv.id = cid; mapEl.appendChild(cv); }
// 地中フェードの覆い（カメラが地表より下へ潜った時に暗くする＝クランプの代替。updateUnderground が opacity を駆動）。
// canvas 2層の直後・UI より前＝基図/ラベル/gint を覆い、計器・検索は上に残す（脱出できる）。スタイルは style.css の #underground。
const undergroundEl = mapEl.appendChild(document.createElement("div"));
undergroundEl.id = "underground";

// 実行時アセット（plateau-sets.json / airports.json / plateau-landmarks.json）の置き場。
// 既定＝自分の配信ベース（vite の BASE_URL＝"/japan/"）。★SDK として第三者のビルドへ取り込まれると
// import.meta.env.BASE_URL は「相手のベース」に置換される＝これらのファイルは相手のサイトに存在しない。
// opts.assetBase で指し直せる口を開けておく（相対でも絶対URLでもよい・末尾スラッシュは自動で整える）。
// 例: orthoJapan({ assetBase: "https://cdn.example.com/ortho-japan/" })
const ASSET_BASE = String(opts.assetBase ?? import.meta.env.BASE_URL).replace(/\/*$/, "/");
// デバッグ手（__cam / __coast / __mesh …）の宿主。自前ページのコンソールから叩く道具を窓に生やすが、
// SDK として第三者ページへ埋め込まれた時にホストの window を汚すのは筋が悪い（2026-08-19）。
// 既定＝容れ物を預かっていない時（target 未指定＝自前ページ）だけ本物の window、埋め込み時は使い捨ての器。
// 器に変えても内部の読み書き（__backend の frame1 判定・__drawSendN の起動HUD）はそのまま通る＝挙動は不変。
// opts.debugGlobals で明示上書き可（埋め込みでも道具が欲しい時は true）。テスト（t-opts/t-webgpu 等）は
// target を渡さない起動なので従来どおり窓に生える。
const DEBUG_GLOBALS = opts.debugGlobals ?? !opts.target;
const dbgHost = DEBUG_GLOBALS ? window : {};
// 全球ビュー（既定＝2026-09-01 本人裁定「world=1をデフォルトに」・?world=0 が逃げ道）：
// z<BASEMAP_MINZOOM(6.5) はタイルなし＝全球ハイプソ（GEBCO×気候・シェーダ計算）＋NE admin0 の gint 線＋
// NE lakes のエンジン湖スロット（下記 loadLakes）。旧・Protomaps PMTiles（OSM/ODbL・world-water 湖のみ消費）は
// 2026-09-03 本人裁定「湖はNE経由＝B案」で撤去＝出典から © OpenStreetMap が消えた（pmtiles 配管と
// public/world-z3.pmtiles は 2026-09-14 に撤去済）。タイルは全z で optbv（日本域）のみ。
const WORLD_VT = !/[&?]world=0/.test(location.search);
// 気候場テクスチャ（全球ハイプソ cross-blend・Köppen-Geiger/Beck et al. CC-BY 720x360 焼き縮め・public 資産）。
// boot と switchTheme の両方が worldHypso.clim に積む（再送は両レンダラとも取得済みキャッシュで no-op）
const CLIM_URL = new URL("koppen-clim.png", new URL(ASSET_BASE, location.href)).href;   // 実行時アセット＝assetBase 相対（旧＝ページ相対で埋め込み先では必ず 404・2026-09-10）
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
const loadExtStyle = async spec => {
	const { style: ms, baseUrl } = await loadMapLibreStyle(spec, { fetchFn: (u, init) => requester.fetch(u, "Style", init) });
	const split = splitMapLibreStyle(ms);
	const src = split.vectorSource ? await resolveVectorSource(ms.sources[split.vectorSource], baseUrl, { fetchFn: (u, init) => requester.fetch(u, "Source", init) }) : null;
	if (split.skipped.length) console.info(`[style] ${ms.name || spec}: ${split.skipped.length} layers not drawn —`, [...new Set(split.skipped.map(k => `${k.type} (${k.why})`))].join(", "));
	return { ms, split, src, baseUrl, url: typeof spec === "string" ? baseUrl : null };
};
// 外来の標高タイル（raster-dem・#36）：opts.terrain＝{ source: raster-dem の spec, exaggeration } ／ ?dem=<XYZ の型紙>&demenc=terrarium|mapbox|gsi&demmax=<z>&demdtm=1
const DEM0 = (() => {
	const absT = sp => ({ ...sp, tiles: (sp.tiles || []).map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")) });   // 相対の型紙は頁基準（render worker で解決させない）
	if (opts.terrain?.source && typeof opts.terrain.source === "object") return absT(opts.terrain.source);
	const q = new URLSearchParams(location.search), u = q.get("dem");
	if (!u) return null;
	try { const x = new URL(u, location.href); if (x.protocol !== "https:" && !(x.protocol === "http:" && (x.hostname === "localhost" || x.origin === location.origin))) throw 0; return { tiles: [x.href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")], encoding: q.get("demenc") || "terrarium", maxzoom: +q.get("demmax") || 14, dtm: q.get("demdtm") === "1" }; }
	catch { console.warn("[dem] ?dem= must be an https URL template", u); return null; }
})();
let EXT = null;
if (STYLE_SPEC) { try { EXT = await loadExtStyle(STYLE_SPEC); } catch (err) { console.error("[style] cannot load the style — falling back to the default basemap", err); } }
const extBaseStyle = ext => ({ version: 8, name: ext.ms.name, sources: { v: { type: "vector" } }, layers: ext.split.base, ext: true });
const extSourceFields = ext => {   // BASE_SOURCE の中身（setStyle でも同じ形で差し替える）
	const s = ext.src;
	return { kind: s?.pmtiles ? "pmtiles" : "style", url: s?.pmtiles || s?.tiles?.[0] || ext.url || null, tileUrl: s ? tileUrlOf(s) : () => null,
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
const REGION_RASTERS = REGIONS.flatMap(r => r.rasters || []);   // 画像タイル（XYZ ラスタ）のカタログ＝地域パックが宣言（エンジンは知らない・?r= と切替ガジェットの鍵）
const BASE_SOURCE = EXT ? extSourceFields(EXT) : PM_URL ? {
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
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

// 表示項目の固定（opts.layers）：true/false は状態を焼き付けてチップも出さない。未記述だけが客のトグル。
// 旧romajiキー（chimei/chikei/shisetsu）は公開済み共有URL・埋め込みの互換のため読みだけ受ける。
const LEGACY_LAYER_KEYS = { chimei: "place", chikei: "terrain", shisetsu: "facility" };
const normLayerKey = k => LEGACY_LAYER_KEYS[k] || k;
const fixedLayers = {};
if (opts.layers) for (const [k0, v] of Object.entries(opts.layers)) {
	const k = normLayerKey(k0);
	if (!(k in defaultLayerState)) { console.warn(`[layers] unknown key "${k0}" (valid: ${Object.keys(defaultLayerState).join(", ")})`); continue; }
	if (typeof v === "boolean") fixedLayers[k] = v;   // boolean だけが固定。それ以外は「記述無し」と同じ＝既定＋チップ
}
const FREE_LAYER_KEYS = Object.keys(defaultLayerState).filter(k => !(k in fixedLayers));   // 客が触れる＝URLに載る集合
// 星座線の表示状態も共有URLの l= に載せる疑似キー（layerState/チップとは別系統＝z<4の星空劇場のトグル）。
// defaultLayerState には無い＝チップ選抜・themes には一切干渉しない（点火/ラベルの経路を汚さない）。
const SKY_LAYER = "sky";
// 配色テーマ（palettes.js の台帳）：共有URLの c=<name>（sky/l= と同じ後置トークン＝夜のまま人に渡る）。
// style は起動時に pipeline/worker へ焼き付くため一度だけ選ぶ：ハッシュ手編集での切替は hashchange が reload で応える。
const themeFixed = !!opts.theme;   // 埋め込みの焼き付け＝URLに書かず、ハッシュでも破れない
const themeBootV = parseViewHash(opts.view || location.hash);
let themeName = typeof opts.theme === "string" ? opts.theme
	: themeBootV?.theme || (themeBootV?.layers?.includes("dark") ? "dark" : "mono");   // l=dark＝c=移行前の互換読み
if (typeof opts.theme !== "object" && themeName && !MAP_THEMES[themeName] && normWorldTheme(themeName)) themeName = normWorldTheme(themeName);   // 旧名を正名へ（c=gsi → topo・c=night → dark）＝別名の台帳は ortho-core worldstyle 一本
if (typeof opts.theme !== "object" && !MAP_THEMES[themeName]) console.warn(`[theme] unknown theme "${themeName}" = starting as mono (valid: ${Object.keys(MAP_THEMES).join(", ")})`);
let theme = typeof opts.theme === "object" ? { ...MAP_THEMES.mono, ...opts.theme }   // カスタム＝mono を土台に部分上書き
	: (MAP_THEMES[themeName] || MAP_THEMES.mono);
let style = EXT ? extBaseStyle(EXT) : theme.style;   // 外来 style＝基図はその層（テーマの配色は背景・大気・建物色だけに効く）
// 旧・世界層前置（withWorld＝world-water 湖タイル層）は撤去（2026-09-03 湖のNE化）＝style はテーマの素のまま。
// 湖の色は worldPal.sea をレンダラが直接読む（u_seaC と単一の出所＝テーマの worldHypso.sea が両方へ届く）。
mountGadgets(mapEl, { chips: opts.chips, instruments: opts.instruments, fixedLayers, attribution: REGION_ATTR });   // UI を #map に生やす＝以降の getElementById が実体を掴めるよう、全lookupの前で
// 非搭載（chips:false / instruments:false）でも配線コードは無改造＝繋ぎ先が無ければ宙のdiv（どこにも描画されない）へ。
const orDetached = el => el || document.createElement("div");
const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = orDetached(document.getElementById("log"));
// 低メモリ端末判定（boot/tier.js lowMem＝≤4GB のスマホ帯・iOS はタッチで一律）。renderWorker（R10キャッシュ縮小）と
// plateau worker（キャッシュ0・バッチ縮小）の両方に配るため、worker生成より前＝ここで定義。
const LOW_MEM = lowMem(navigator);
// ── 世界の形（現在：全端末＝球6371kmが既定・?ell=1で表示もWGS84楕円体。計測は常時WGS84＝段階A無条件）──
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
const ELL_ON = /[?&]ell=1/.test(location.search);
console.log(`[geo] world=${ELL_ON ? "WGS84 ellipsoid (beta-sphere x S)" : "sphere 6371km (?ell=1 renders WGS84 too; measurement always WGS84)"}`);   // 実機切り分けの計器（スクショのコンソールで世界が判る）
setEllipsoid(ELL_ON);
const EARTH_M = worldRadiusM(), TERR_EXAG = 1.0;   // m→世界単位の換算半径は camera.js が正本（球6371000/楕円体a）。標高は実スケール（誇張しない＝地形を歪めない）。ラベル・地形・建物で共有

// --- 初見が死なない：起動できない環境・壊れた環境を白画面でなく言葉で受け止める（boot/tier.js fatalOverlay / deadMap）---
const fatalOverlay = (title, detail, reload) => showFatal(mapEl, title, detail, reload ? t("Reload") : null);   // reload=true で「再読み込み」ボタン付き
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
		return deadMap();
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
			return deadMap();
		}
	}
}
// --- 機体のティア（boot/tier.js classifyTier）：非力デスクトップ MID_TIER（内蔵GPU・4コア以下・RAM の多いスマホ）は PLATEAU の山を半分に、
// ハイスペック HI_TIER（12コア以上）はロード並行度だけ上へ。根拠と実測は module の注記・台帳は fallback-ladder.md。?mid=0/1・?hi=0/1 が戻し口。
const { MID_TIER, HI_TIER } = classifyTier({ LOW_MEM, gpuRenderer, search: location.search, nav: navigator, coarse: () => matchMedia("(pointer: coarse)").matches });
if (MID_TIER) console.log(`[boot] mid-tier device = PLATEAU to safe side (gpu="${gpuRenderer || "unknown"}" cores=${navigator.hardwareConcurrency || "?"})`);
if (HI_TIER) console.log(`[boot] hi-tier device = PLATEAU wide lanes (cores=${navigator.hardwareConcurrency}, bldCap=3, tileConc=16, decPool)`);
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
const onTile = ok => {
	if (ok) { tileFails = 0; if (navigator.onLine !== false) netEl.style.display = "none"; }
	else if (++tileFails >= 3) netEl.style.display = "block";   // 3連続失敗＝ネット全滅の疑い（単発404では出さない）
};
// window/document 級のリスナーは全てこの signal で登録＝destroy() の abort 一発で束ごと外れる（外し漏れゼロ）。
const ac = new AbortController();
window.addEventListener("offline", () => { netEl.style.display = "block"; }, { signal: ac.signal });
window.addEventListener("online", () => { netEl.style.display = "none"; needsDraw = true; }, { signal: ac.signal });

let bg = style.layers.find(L => L.type === "background");
let land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.96, 0.96, 0.95, 1];
// 白抜き家具（本人裁定 2026-08-05「紙の世界を司る神」）：計器・アイコン・出典を地図の明暗に依らず常に黒硝子＋白線へ（quiet-mono #map.ui-dark）。
// 旧＝land輝度<0.45（暗い紙）の時だけ夜家具。今は常時ON＝昼夜で意匠がブレず、白線 on 黒硝子で輪郭が締まる（状態HUDと同族）。戻すなら下の add を輝度条件へ。
mapEl.classList.add("ui-dark");
const clear = [0.03, 0.04, 0.07, 1];   // 宇宙（球の外側）

let dpr = Math.min(2, window.devicePixelRatio || 1);

// --- render worker：GL を OffscreenCanvas で worker に置く。main は set/draw を postMessage する薄いプロキシ ---
// transfer 後は main から canvas.width を触れないので、論理サイズ(size)を main が自前で持つ。
const size = { w: Math.round(mapEl.clientWidth * dpr), h: Math.round(mapEl.clientHeight * dpr) };
canvas.width = size.w; canvas.height = size.h;             // transfer 前に初期サイズ
labelCanvas.width = size.w; labelCanvas.height = size.h;
const offscreen = canvas.transferControlToOffscreen();
const labelOffscreen = labelCanvas.transferControlToOffscreen();
const renderWorker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "render" });   // 入口 1 本（worker.js）＝役割は name で指名
// scene worker → render worker の直結パイプ（main を経由しない geometry）。両端を各 worker へ渡す。
const sceneChan = new MessageChannel();
// ?maxact=N / ?tbudget=N ＝低メモリ端末の安全側の絞りを実機で緩めて jetsam 完走を A/B する数値ノブ（?nomd と同格）。
// 狙いは②GPU常駐（表示区数）と④タイル予算だけを動かすこと＝①過渡デコードメモリ（jetsamの主犯）には触れない
// ＝bldCap・BATCH_TILES・TILE_CONCURRENCY は据置。基準機は 4GB 実機（タブ予算は 8GB 機の~1.4GBより小さい）。
const qNum = (re, def) => { const m = location.search.match(re); return m ? +m[1] : def; };
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
let memTerrain = 0, memHeap = 0, memGpu = null, memRaster = 0;   // render worker から届く terrain LRU バイト・JS ヒープ・GPU固定常駐概算（?hud=1 時のみ更新）
let memFps = 0, memFrameMs = 0, memRes = 1, memBackend = null, memGpuName = "";   // 同テレメトリの描画実測＝FPS・frame ms・動的解像度・backend(webgpu/webgl2)・GPU名
// 混成R01近景（高チルト山岳の細かい起伏）は全端末で既定ON（lowMem含む）。旧・lowMemはR10止まり（富士3Dのjetsam対策80170b8）
// だったが、標高アトラスR16F化（GPU半減）＋iOS 4GB実機で peak 84MB・完走を実測して安全確認済み。
// ?nor01=1 ＝過渡デコードで落ちる端末が出た時の逃げ道（無効化＝全面R10へ）。
const noMixedR01 = /[?&]nor01=1/.test(location.search);
// ?gpu=1 ＝WebGPU バックエンド（実験・Phase 1: globe+基図 fill/line）。非対応/失敗は worker 内で WebGL2 へ
// 自動フォールバック＝既定挙動と同一。既定経路には dynamic import すら発生しない（バンドル・実行とも無負担）。
// ?gpu=1＝WebGPU 実験フラグ。oj.nogpu＝この環境で「初期化は成功するのに絵が出ない」を検出済み（下の present 検証）
// ＝次の1ブートだけ WebGL2（起動時に消費・累積2回で固定＝柔らか鍵、下の定義部）。iOS Safari 実測 2026-08-02：backend=webgpu ログまで
// 進むが画面に画素が届かない（worker×OffscreenCanvas×WebGPU の present 未接続系）＝例外ゼロの沈黙故障。
// モバイル：ページ自体のネイティブズーム禁止＝地図のズームだけが生きる。iOS Safari は viewport の
// user-scalable=no を無視するため gesture 系 preventDefault が本丸（canvas の touch-action:none は
// canvas 起点タッチのみ＝UI 跨ぎピンチやダブルタップは素通りする。Kenji 指示 2026-08-02）。
for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(t, e => e.preventDefault(), { passive: false });
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
const IS_ANDROID = /Android/.test(navigator.userAgent) || navigator.userAgentData?.platform === "Android";
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
const markNoGpu = why => { sessionStorage.setItem("oj.nogpu", why); sessionStorage.setItem("oj.nogpuN", String(nogpuN + 1)); };
const gpuBackend = !forceGl2 && "gpu" in navigator && (/[?&]gpu=1/.test(location.search) || (!IS_ANDROID && !sealGpuForOverlay && !nogpuMark && nogpuN < 2));
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
	const lines = new Map();
	const put = (k, v) => { lines.set(k, v); d.textContent = [...lines.entries()].map(([a, b]) => a + ": " + b).join("\n"); };
	put("build", "v-fade1");
	put("elapsed", "0s"); setInterval(() => put("elapsed", ((performance.now() - t0) / 1000).toFixed(0) + "s"), 1000);
	setInterval(() => put("main tx", `draw x${dbgHost.__drawSendN || 0}${dbgHost.__drawSendErr ? " send error:" + dbgHost.__drawSendErr : ""}`), 1000);
	put("frame1", "not received ✗");
	return put;
})() : null;
if (/[?&]gpu=1/.test(location.search) && !gpuBackend) console.warn("[boot] gpu=1 requested but WebGPU unavailable (no navigator.gpu, or gl2=1 also set) = starting as WebGL2");
if (gl2Fallback) console.warn(`[boot] WebGPU fallback active = WebGL2 (reason=${nogpuMark || "accumulated" }, count ${nogpuN}${nogpuN >= 2 ? " = pinned for this tab" : " = retry on next reload"})`);
// ?noterr=1 ＝標高（アトラス・地形メッシュ・タイルLRU）を丸ごと停止する A/B 計測ノブ（?nogint=1 と同格）。
const noTerr = /[?&]noterr=1/.test(location.search);
// ?farterr=0 ＝遠景地形層（深ズーム×チルトの R10 第2アトラス＝ズームインしても遠方の山が消えない一般則）を
// 無効化する逃げ道。コスト＝GPU 10-16MB＋遠景メッシュ2度描き（チルト深ズーム時のみ）。
const noFarTerr = /[?&]farterr=0/.test(location.search);
// ⚠iOS WebKit の轍（2026-08-02 実機確定）：WebGPU 構成の worker への「直結 postMessage」は init 以降
// 黙って消える（main送信8回/worker受信0回・エラー皆無。MessageChannel ポート経由は全て配達される＝
// scene/plateau ポートが生きている実証つき）。よって init 以外の制御メッセージは全部 ctrlPort 経由。
const ctrlChan = new MessageChannel();
// iOS（iPadOS の Mac 偽装込み）＝WebGPU worker への直接配達が死ぬ環境：生きている scene worker 経由のリレーへ。
const IOS_RELAY = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) || /[?&]relay=1/.test(location.search);   // relay=1＝他環境でのリレー経路検証用
let relayCtl = null; const relayPending = [];   // pipeline 生成前の制御は待機列（生成直後に順序どおり流す）
const wPost = (msg, transfer) => {
	if (IOS_RELAY && gpuBackend) {   // リレーが要るのは WebGPU 構成の時だけ（WebGL2 は直結が健在）
		if (relayCtl) relayCtl(msg, transfer); else relayPending.push([msg, transfer]);
		return;
	}
	ctrlChan.port1.postMessage(msg, transfer || []);
};
renderWorker.postMessage({ type: "init", ctrlPort: ctrlChan.port2, canvas: offscreen, labelCanvas: labelOffscreen, elevBase: TERR_EXAG / EARTH_M, terrainExag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com", scenePort: sceneChan.port2, noMultiDraw, perf: perfLog, mem: hudOn, lowMem: LOW_MEM, noMixed: noMixedR01, noFarTerr, dtm: REGION_DTM, dem: DEM0, noBld: /[?&]nobld=1/.test(location.search), gpu: gpuBackend, noTQ: /[?&]notq=1/.test(location.search), noGint: /[?&]nogint=1/.test(location.search), noGintSB: /[?&]gintsb=0/.test(location.search), noFade: /[?&]nofade=1/.test(location.search), msaa1: MSAA_OFF, msaa4: MSAA_PIN, drawHud: drawHud, stay: /[?&]stay=1/.test(location.search), noTerr, ell: ELL_ON }, [ctrlChan.port2, offscreen, labelOffscreen, sceneChan.port2]);
// 薄いプロキシ：有線(関数呼び)を無線(postMessage)に載せ替え。set/draw 統一済なので pipeline/overlay は無改造。
// draw は worker 側で「cam を記録するだけ」に受け、実描画は worker 自前 rAF が最新 cam で回す（worker-driven）。
// 標高アトラス(terrain)も worker 側に住む＝main はもう視野→セル計算・ダウンサンプルを一切やらない。読込インジケータだけ elevPending で受ける。
const renderer = {
	set: (cmd, data, prop, layer) => wPost({ type: "set", cmd, data, prop, ...(layer != null ? { layer } : {}) }),   // layer＝gint 多層（spec §4）の層指名。無指定＝既定層（従来と同形）
	draw: (cam, opts) => {
		try { wPost({ type: "draw", cam, opts }); dbgHost.__drawSendN = (dbgHost.__drawSendN || 0) + 1; }
		catch (e) { dbgHost.__drawSendErr = String(e && e.message); console.error("[boot] draw send failed:", e); }
	},
};
let elevBusy = false;   // 標高タイル（R01/R10/R90）読込中＝PLATEAU先読みの柵（デモの地形シーンで起伏が立たない事故の防止）
let elevN = 0;          // 読込中の枚数＝デモ行送りゲートの進捗指紋（枚数が動いている間は「進んでいる」）
const elevEl = document.createElement("div");
elevEl.id = "elev-toast";   // スタイルは quiet-mono。左下ドック＝#pos の上へ積まれる（bottom手打ち廃止 2026-09-03）
dockStack(mapEl).append(elevEl);
// 等高線(真俯瞰の茶線)・測量点標高・地形読込表示は「地形」チップ(layerState.terrain)に統合＝独立トグル無し。
// zoom/tileのデバッグログ(#log)はユーザー向けチップから切り離し常時非表示（必要なら devtools で #log を出す）。
logEl.style.display = "none";
// 起動ウォッチドッグ：最初のフレーム(frame1)が10秒来なければ原因不明でも案内を出す（健全なら1秒未満で来る）。
// glfail=worker内のWebGL2初期化失敗、contextlost=GPUコンテキスト喪失（1回だけ自動リロード→再発なら案内）。
let bootT = setTimeout(() => {
	fatalOverlay(t("Startup is taking longer than usual"), t("On a slow connection the first load can take a while (loading is still in progress). Please wait a moment. If it does not improve, reload the page — and if that fails, check that hardware acceleration is enabled in your browser settings."), true);
}, 10000);
// gpu=1 の frame1 不達（20秒）＝WebGPU 経路が固まっている疑い＝WebGL2 で仕切り直し（遅い回線のコールドブート実測
// 16秒@400kbps を考慮した余裕。present 沈黙故障と対で、実験フラグがどう転んでも WebGL2 の絵に必ず着地させる）。
// ★destroy() で必ず clearTimeout（旧＝生成後 20 秒以内に destroy すると __backend が消えた後に番犬が起き、**ホストページごと reload**＝
//   SDK ドッグフード 2026-09-10 で発覚。埋め込み先の SPA がタブ切替で destroy する典型で踏む）
let gpuWatchT = null;
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
const extGint = new Map();   // layer id → handle（identify/click/ack ルーティング先）
let extActive = null;        // カーソルを持つ追加層の id（null＝既定層＝従来ゲート）
const mapOn = { click: [], move: [], load: [], mesh: [], plateau: [], settle: [], time: [] };   // time＝共通の時計の状態が変わった（#42）   // settle＝カメラ静止（onMove の 150ms 無音）＝ツアー/オーバレイの「止まった」合図（2026-09-11）   // map.on の登録簿（§4: click=hits 同型／move=カメラ更新／load=frame1／plateau=建物3D の読込合図）
// map.on("mesh")（旧名 "plateau"＝非推奨の別名・同じ合図が両方へ）：{phase:"catalog",count} → {phase:"start"|"done"|"cancelled"|"failed", name(区名), base(URL)}。旧＝コンソール文字列しか合図が無く
// 埋め込み側が console.log をフックしていた（SDK ドッグフード 2026-09-10）。
const emitMesh = e => { for (const cb of [...mapOn.mesh, ...mapOn.plateau]) { try { cb(e); } catch (err) { console.error("[map.on mesh]", err); } } };
let mapLoaded = false;   // 'load' 後の登録は即発火（maplibre 同様の耳）
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
		const lines = p ? (gint.userGint?.tip ? gint.userGint.tip(p) : Object.entries(p).map(([k, v]) => `${k}: ${v}`)) : null;
		gint.hoverTip(lines?.length ? lines : null);   // null/空＝tip を消す
		return;
	}
	if (d.action === "click") {
		gint.clickHandler?.(d.featureId, (d.featureId != null && gint.userGint?.pbf) ? gint.userGint.pbf.getFeature(d.featureId)?.properties : null, [d.lng, d.lat]);
		return void console.log("[gint] fid=%s  lng=%s lat=%s", d.featureId, d.lng?.toFixed?.(6), d.lat?.toFixed?.(6));
	}
	if (d.action === "tiers") return;   // gint LOD tier 構築完了の報告（ベンチ用メタ）＝アプリでは使わない
	if (d.type === "snapshot") return snapPart(d.id, "render", d);   // shot 用：基図+ラベルの ImageBitmap
	if (d.type === "dlApplied") return onSceneApplied(d.slot, d.sig);   // multi_draw の ack＝renderer が draw list を適用した瞬間（＝画面に載った）
	if (d.type === "overlayEvent") return overlays.get(d.name)?.onmessage?.(d.data);   // 同一フレームのオーバーレイ → main（hit 矩形・画素の返送など）
	if (d.type === "overlayStage") { (dbgHost.__overlay ??= {})[d.name] = d; if (d.stage === "failed") console.error("[overlay]", d.name, "failed:", d.error, d.url); return; }   // 読み込み段階（importing/imported/ready/failed）＝沈黙故障の診断
	if (d.type === "frame1") {
		clearTimeout(bootT); bootT = null; renderBackend = dbgHost.__backend = d.backend || "webgl2"; sessionStorage.removeItem("oj.ctxlost");   // 初描画成功＝自動リロード回数もリセット。__backend＝スモークテスト用（webgl2/webgpu）
		document.getElementById("fatal")?.remove();   // 遅い回線でウォッチドッグ(10s)が先に出た後の遅着 frame1＝案内を畳む（地図は生きているのに被さったまま＝「何も出ない」の正体・モバイル実測 2026-08-02）
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
			const bail = why => {
				if (stay) { console.error(`[boot] WebGPU present verification failed (${why}). stay=1 = fallback suppressed; inspect the diag lines`); diagHud && diagHud("present", `failed ✗ (${why})`); return; }
				console.error(`[boot] WebGPU present verification failed (${why}) -> restarting as WebGL2 in 3s (waiting for GPU diagnostics)`);
				markNoGpu("present:" + why);
				setTimeout(() => location.reload(), 3000);
			};
			try {
				const t = document.createElement("canvas"); t.width = 16; t.height = 16;
				const g = t.getContext("2d", { willReadFrequently: true });
				g.drawImage(canvas, 0, 0, 16, 16);
				const px = g.getImageData(0, 0, 16, 16).data;
				let nz = 0; for (let i = 0; i < px.length; i += 4) if (px[i] | px[i + 1] | px[i + 2] | px[i + 3]) nz++;
				if (nz === 0) bail("no pixels reached the canvas");
				else { console.log(`[boot] WebGPU present verified (pixels ${nz}/256)`); diagHud && diagHud("present", `OK ✓ pixels ${nz}/256`); sessionStorage.removeItem("oj.nogpuN"); }   // 検証通過＝この環境の WebGPU は本物＝過去の躓きの累積を消す
			} catch (e) { bail("exception during verification: " + (e && e.message)); }
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
		diagHud && diagHud("route", `scenePort recv ${d.sceneMsgN} relay final ${d.relayRecvN} hop1 recv ${globalThis.__relayCtlN || 0}`);
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
	if (d.type === "mem") { memTerrain = d.terrain || 0; memHeap = d.heap || 0; memGpu = d.gpu || null; memRaster = d.raster || 0; memFps = d.fps ?? memFps; memFrameMs = d.frameMs ?? memFrameMs; memRes = d.res ?? memRes; memBackend = d.backend || memBackend; memGpuName = d.gpuName || memGpuName; return; }   // ?hud=1：render worker からのメモリ台帳＋描画実測（HUD が合算・表示）
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

let needsDraw = true, readySig = "", lastLabels = [], sceneOrigin = null;
let renderBackend = null;   // 初描画で確定（"webgpu"／"webgl2"）。建物の影は WebGPU だけ（GL2＝フォールバックは影をかけない仕様）
// mainDesired＝「今この視点で載っているべき main の sig」（swapScene が毎回更新。request の dedupe とは独立）。
// base(粗い下地)の退場判定に使う：readySig がこれに追いつく＝穴なしが確定するまで下地を敷いたままにする。
let mainDesired = "";
let readyKeys = null, readyTail = "";   // readySig 確定時に一度だけ作る Set＋署名末尾（styleSig/鉄道帯）＝render の下地退場判定（毎フレーム文字列を作らない）
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
let basemapHidden = false;                 // z<BASEMAP_MINZOOM で基図(GSI)を止めてるか（全球ビュー＝海岸線のみ）
let attrZone = null, attrRegionHTML = null;   // 出典（#attr）の圏＝"region"（地域の基図圏）|"world"|"sky"（render() が z 跨ぎで一枚を差し替え＝各ズーム統合 2026-09-03）
// 日本固有（GSI基図）の出番：従来5。世界下地（ハイプソ＋admin0国線）がある ?world=1 は 6.5 から
// （本人裁定 2026-08-31「下地ができたので日本固有はz>6.5でいい」）。標高はz5.5からR10（terrain.js・
// 旧6.5＝9/2裁定でハイプソ帯の海岸ギザ根治）＝GSI入場前にハイプソが精細化して受け渡す。
// 星空・星座・太陽系の門は別（STARSKY_Z＝従来の5のまま）。
// ズームの上限＝器ごとの頭打ち（opts.zoomMax・1.2.0〜 2026-09-23）＝データが在る所までしか寄らせない
// （apps/world の国の地図＝世界データだけ＝z8）。入力・飛行・共有hash・fit の全経路がこの値に従う。
// 既定 20＝15cm/px（正射z＝緯度フリー。精度は原点相対RTEが担保）。21でも動くが余裕を持って1段残す。
const ZOOM_MAX = Math.max(1, Math.min(20, opts.zoomMax ?? 20));
let zoomMaxCur = ZOOM_MAX, camBounds = null;   // 実行時の寄りの上限と中心の可動域（map.setMaxZoom / setMaxBounds・#35）＝onMove が毎移動で締める（使う所より前で宣言＝TDZ の轍）
// 地域の申告が無い器（globe 仕様）＝日本固有の圏そのものが無い＝上限より上に置いて「来ない」ことを表す。
// 世界ハイプソ・湖・罫線はこの値まで描かれる＝ズーム上限まで世界の色のまま（2026-09-23）。
const BASEMAP_MINZOOM = EXT ? 0 : REGIONLESS ? ZOOM_MAX + 0.8 : WORLD_VT ? 6.5 : 5;   // 外来 style＝全ズームがその基図（世界のハイプソは出さない＝MapLibre と同じ見え方）
// タイルの門だけを分ける：BASEMAP_MINZOOM は「日本の基図（GSI）を出す圏」の意味も兼ねており、注記・空港マーク・
// 出典圏の判定にも使われている。?pm= の基図は日本固有ではない＝タイルを出す下限はアーカイブの持ち分に従う
// （実際の下限は minZoom で、それ未満はエンジンの門が空タイルを返す）。旧・世界タイルの !WORLD_VT 例外と同じ役割。
const TILE_MINZOOM = BASE_SOURCE.tileMinZoom ?? BASEMAP_MINZOOM;
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
let idleCalm = false, calmT = null;
let moving = false, settleT = null;
// 移動中は幾何を再結合しない（タイルのポップ＝チラチラ防止）。停止後に再結合。
// PLATEAU LOD2 データ登録簿：寄ると自動で出す。bbox は自動トリガ用の緩い矩形（実描画は被覆マスクが実フットプリントに沿わせる）。
// 全国 300 市区町村分は scripts/plateau-catalog-build.mjs で datacatalog API から生成＝public/plateau-sets.json を起動時に fetch。
// opts.mesh=false（旧 opts.plateau=false）＝建物3D機能ごと停止：カタログ・workerプール・自動ロード・データ管理ガジェットの全部
//（1地区あたり数十〜百MB級の重い機能＝軽い埋め込みが丸ごと切れる口。UIのchips/instrumentsと対になる機能側スイッチ）。
if ("plateau" in opts) console.warn('[mesh] opts.plateau is deprecated = use opts.mesh (same meaning)');   // 旧名（1.1.0 まで）＝次の大版まで別名で受ける
const meshOn = (opts.mesh ?? opts.plateau) !== false && !/[?&]nopl=1/.test(location.search);   // ?nopl=1＝建物3D層別切り（iOS診断）
const REGION_BLD_ICON = REGIONS.map(r => r.buildings?.icon).find(Boolean) ?? null;   // 建物データ管理ボタンの顔（日本＝PLATEAU 公式ロゴ・無ければ汎用）
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
let airportMarks = [];
const REGION_AIRPORTS = REGIONS.map(r => r.airports).find(Boolean) ?? null;   // 低ズームの空港マーク台帳（地域の申告・日本＝airports.json）
if (REGION_AIRPORTS) fetch(ASSET_BASE + REGION_AIRPORTS).then(r => r.json()).then(list => {
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
const landmarkMinH = z => { let h = Infinity; for (const [lz, lh] of LANDMARK_LADDER) if (z >= lz) h = Math.min(h, lh); return h; };
let landmarks = null, landmarkReq = null;
function loadLandmarks() {
	if (landmarkReq) return landmarkReq;   // 一度だけ（失敗しても再試行しない＝名札は無くても地図は成立する）
	if (!REGION_LANDMARK.length) return landmarkReq = Promise.resolve();   // 名札を宣言しない地域（オランダ）＝取りに行かない
	return landmarkReq = fetch(ASSET_BASE + REGION_LANDMARK[0]).then(r => r.json()).then(j => {
		landmarks = j.f.map(([text, lon, lat, h, pair]) => ({ text, anchor: [lon, lat], h, pair }));
		console.log(`[landmark] ledger loaded -> ${landmarks.length} buildings (h>=${j.h}m)`);
		readySig = ""; mergeReq.main.sig = ""; needsDraw = true;   // 到着＝ラベル再結合（空港台帳と同じ作法）
	}).catch(e => console.warn("[landmark] ledger fetch failed", e));
}
// --- 建物3D（PLATEAU）の管理＝mesh/manager.js（表示判定・ロード順・常駐予算・遠景・先読み・読込トースト・データ管理モーダル）。
// ここは配線だけ＝装置の旗・描画側の口・app の状態の覗き窓（getter）・生成後に定義される関数のラップ（一本道の下流＝呼ぶ時に解決）。
// 現在の画面に映る範囲をラフに見積もる（フラスタム厳密解ではなく自動ロードのゲート用）。z14+の寄った状態でしか呼ばれない＝視野は元々狭く、この近似で十分。
function approxViewBbox(cam) {
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
// --- POI台帳（施設の点・z14+）＝地域宣言 poi が実装を持参する（日本＝packages/jp/src/poi.js：在庫マニフェスト・タイル・§12 手差分・ラベル注入）。ここは配線だけ。
// 実装は poi.create(env)（動的 import を宣言側が握る＝ホストは地域のパッケージを知らない）＝施設層 ON×z14+ で初めて要った時に読む＝代理の窓口（読み取りは空・ver=0）。台帳を宣言しない地域＝null。
let poiReal = null, poiWake = null;
const poiReady = () => poiWake ??= Promise.resolve(REGION_POI.create({ viewBbox: approxViewBbox, requestDraw: () => { needsDraw = true; } })).then(led => {
	poiReal = led;
	needsDraw = true;
	return poiReal;
});
const poi = !REGION_POI ? null : {
	load(c) { if (poiReal) poiReal.load(c); else poiReady(); },
	injectLabels: (...a) => poiReal?.injectLabels(...a),
	get ver() { return poiReal?.ver ?? 0; },
	ready: poiReady,
};
let flying = false;                        // フライト中フラグ＝meshMgr.update のゲート（flyTo が立て、着地/中断で下ろす）
// 建物メッシュの管理（mesh/manager.js＋データ管理画面）は寄った時（z≥MESH_WAKE_Z）か明示の呼び出し（台本の先読み・区の立ち上げ・
// データ管理ボタン）で初めて読む＝起動の JS と登録簿（plateau-sets.json）を列島ビューの起動から外す（2026-09-22・約 22KB gz）。
// 表向きの形（meshMgr.*）は従来と同じ代理の窓口：本物が来るまでの読み取りは空（登録簿 []・進捗は空 Map・HUD は 0）、
// 非同期の口は本物を待って渡す。除外表と進捗の中継口は本物が来た時に渡す。自動ロード（z15）は起こす線（z12）より深い＝寄る間に届く。
const MESH_WAKE_Z = 12;
const meshEnv = {
	meshOn, device: { LOW_MEM, MID_TIER, HI_TIER, gpuBackend, hudOn, ELL_ON },
	renderer, attachMeshPort: port => wPost({ type: "meshPort", port }, [port]), mapEl, dbgHost, emit: emitMesh,
	requestDraw: () => { needsDraw = true; },
	get cam() { return cam; }, get moving() { return moving; }, get flying() { return flying; }, get printHold() { return printHold; }, get elevBusy() { return elevBusy; },
	// 足元＝チルト時（pitch>20°）は画面下端中央の接地点（球外なら null）。真俯瞰では下端＝単に南＝優先の意味が無いので使わない
	footPoint: () => cam.pitch > 0.35 ? unprojectXY(size.w / dpr / 2, size.h / dpr * 0.98) : null,
	viewBbox: approxViewBbox, playingNow: () => scenes.playingNow(), flyTo: (...args) => flyTo(...args),
	groupOf: REGIONS.map(r => r.buildings?.group).find(Boolean) ?? null,   // データ管理モーダルの見出し・並び（日本＝都道府県）＝地域の申告
};
let meshReal = null, meshWake = null, meshGone = false, meshTap = null;
const MESH_NO_PROGRESS = new Map();
const wakeMesh = () => meshWake ??= !meshOn ? Promise.resolve(null) : import("./mesh/manager.js").then(async ({ createMeshManager }) => {
	if (meshGone) return null;   // 起こしている間に destroy された
	const catalog = loadMeshCatalog();
	meshReal = createMeshManager(Object.assign(Object.create(meshEnv), { catalog }));   // スプレッド禁止＝cam/moving 等の getter をその瞬間の値に固めてしまう（原型鎖で生きたまま覗かせる）
	if (meshTap) meshReal.setProgressTap(meshTap);
	// 捨てる地物（精査で不要と裁定した gml_id）＝生経路も焼きと同じ。manager が起きている worker と後から起きる worker の両方へ配る
	if (REGION_EXCLUDE.length) fetch(ASSET_BASE + REGION_EXCLUDE[0]).then(r => r.ok ? r.json() : null).then(map => { if (map) meshReal?.setExcludeMap(map); }).catch(() => {});
	await catalog?.catch(() => {});   // 登録簿が manager に入ってから解決（manager の受け取りは先に登録済み＝この後に走る）
	needsDraw = true;
	return meshReal;
}).catch(e => { console.error("[mesh] manager load failed", e); return null; });
const meshMgr = {
	// settled（カメラ静止＝onMove の 150ms 無音）は本物へ必ず渡す＝新しい区のロードは settled の時だけ始まる。
	// ⚠落とすと、止まっても何も読まない（2026-09-22〜24：デモの全幕で PLATEAU が出ず、手動でも「他の区の読み込み完了」等の一突き次第＝再現性のない不表示）
	update(settled) { if (meshReal) meshReal.update(settled); else if (meshOn && !meshGone && cam.zoom >= MESH_WAKE_Z) wakeMesh(); },   // 起こした時は登録簿の到着で autoMesh(true) が一度走る（manager 側）
	standUp: async (...a) => (await wakeMesh())?.standUp(...a),
	prefetch: async (...a) => (await wakeMesh())?.prefetch(...a) ?? [],
	openDb: async () => (await wakeMesh())?.openDb(),
	firstRevealSets: views => meshReal?.firstRevealSets(views) ?? [],
	trimForScript: views => meshReal?.trimForScript(views),
	setProgressTap: fn => { meshTap = fn; meshReal?.setProgressTap(fn); },
	terminate: () => { meshGone = true; meshReal?.terminate(); },
	get sets() { return meshReal?.sets ?? []; },
	get progress() { return meshReal?.progress ?? MESH_NO_PROGRESS; },
	isActive: name => meshReal?.isActive(name) ?? false,
	isDead: name => meshReal?.isDead(name) ?? false,
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
	const done = (t, d) => { ugBusy = false; ugLastD = d; undergroundEl.style.opacity = moving ? t : (d < 0 ? 1 : 0); };
	if ((cam.pitch || 0) < 0.06) return done(0, Infinity);   // 2D=地中判定なし
	const st = cameraState(cam, size.w, size.h);
	const len = Math.hypot(st.eye[0], st.eye[1], st.eye[2]);
	const [lon, lat] = betaToLonLat(st.eye);   // ★eye は β空間（cameraState が S⁻¹ 済み）＝β→測地緯度の一段だけ。生 asin=地心(−10km)・worldToLonLat=S⁻¹二重(+10km) はどちらも ?ell=1 で直下点が 10km 飛ぶ（8/15・9/21）
	const eyeAltM = (len - 1) * EARTH_M;   // eye の海抜[m]（軌道は sea-level 球なので len-1 がそのまま高度）
	const UG_TIMEOUT = Symbol("ug-timeout");
	Promise.race([Promise.resolve(getHeight(lon, lat, cam.zoom, { wait: true })), new Promise(r => setTimeout(r, UG_WAIT_MS, UG_TIMEOUT))])
		.then(h => {
			if (h === UG_TIMEOUT) { ugBusy = false; return; }   // ローダ無応答＝今の不透明度を据え置き（次の契機で再挑戦）
			const d = eyeAltM - (+h || 0);   // 直下地表からの余裕[m]（d<0=地中）
			const x = Math.max(0, Math.min(1, (UG_FADE_TOP_M - d) / (UG_FADE_TOP_M - UG_FADE_FULL_M)));
			done(x * x * (3 - 2 * x), d);   // smoothstep
		})
		.catch(() => done(0, Infinity));
}
// 静止（settle＝描画確定）時のコミット：動作中は帯（smoothstep）で滑らかに翳らせるが、止まったら確定する
// ＝地中(d<0)なら中途半端なグレーを残さず全黒（opacity=1）、地上なら解除（0）。Kenji「止まった時はヒステリシスが
// あっても真っ黒に」。直近サンプル ugLastD を同期で使う（新規fetchの競合なし。静止時は eye≈最終onMove位置＝十分新鮮）。
function commitUnderground() {
	undergroundEl.style.opacity = ((cam.pitch || 0) >= 0.06 && ugLastD < 0) ? 1 : 0;
}

// --- 選抜リフト球（タイル被覆の地形補正・2026-08-03）: 中心の地面標高 → tiles.update の groundR ---
// selectLOD の unproject は海面球が既定＝標高の高い土地ではチルト時に「持ち上がった地面が画面下端へ
// 映り込む手前領域」が画面外扱いになり、主層/下地/毛布とも被覆が欠けて紙色のくさびが残る
//（実測: 草津1200m・z15.8・チルト52°で画面左下1/3が空白。Node被覆シミュで海面欠け0/リフト欠け48%）。
// 表示中の地形変位と同式（renderer elevScaleEff と同じ pitch フェード）で半径を作る＝真俯瞰は1（従来通り）。
// 標高は getHeight の非同期サンプル＝到着まで0（海面挙動）、到着時 needsDraw で選抜し直し＝自己回復。
let groundElevM = 0, geBusy = false, geKey = "";
function sampleGroundElev() {
	if (!getHeight || geBusy) return;
	const k = Math.round(cam.center[0] * 1000) + "," + Math.round(cam.center[1] * 1000);   // ~100m格子＝微パンで照会を積まない
	if (k === geKey) return;
	geBusy = true;
	Promise.resolve(getHeight(cam.center[0], cam.center[1], cam.zoom))
		.then(h => { geBusy = false; geKey = k; const v = Math.max(0, +h || 0); if (Math.abs(v - groundElevM) > 1) { groundElevM = v; needsDraw = true; } })
		.catch(() => { geBusy = false; });   // 失敗は geKey 据置＝次の render で再挑戦
}
const groundRNow = () => {
	const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14)), pf = pt * pt * (3 - 2 * pt);
	if (pf <= 0 || groundElevM <= 0) return 1;   // 真俯瞰 or 海面＝従来挙動
	// リフト量は eye の下に留める（-30m マージン）：球が eye を呑むと unproject の出口が地球の裏側＝
	// ゴミサンプル。谷を見下ろす縁などで中心標高が eye を超えても、選抜は海面球との和集合が受け持つ。
	const st = cameraState(cam, size.w, size.h);
	const eyeAltM = (Math.hypot(st.eye[0], st.eye[1], st.eye[2]) - 1) * EARTH_M;
	const lift = Math.min(groundElevM * pf, Math.max(0, eyeAltM - 30));
	return 1 + lift * (TERR_EXAG / EARTH_M);
};

function onMove() {
	clampCamLimits();   // 実行時の上限・可動域（#35）＝入力・飛行・URL 復元のどの経路で動いても同じ所で締める（聞き手へ渡す前に）
	for (const cb of mapOn.move) { try { cb({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing }); } catch (e) { console.error("[map.on move]", e); } }
	cam.center[0] = wrapLon(cam.center[0]);   // パン/回転/フライトの累積を毎移動で正規化＝float32原点相対の前提を守る（階段バグ根治）
	moving = true; needsDraw = true;
	idleCalm = false; clearTimeout(calmT);     // 動いた瞬間に「本当の静止」を取り下げ（詳細化は許可待ちに戻る）
	updateUnderground();                       // 地中フェード（非同期・10Hz＝eye直下の地表との高低差→#underground の opacity。時間フェードはCSS transition）
	gint.updateGintSlot();                                                                // gint 単一スロットを z=4 で調停（ユーザー層⇄世界海岸線）＋海岸線の遅延ロード
	sky.ensureStars();                                                                // 星空も同じ流儀＝初めて z<4 に出た瞬間に読む
	meshMgr.update();                                                                 // 寄る/離れるで PLATEAU を自動ロード/解放（ガードで実質タダ）
	renderer.draw(cam, { skipBase: false, skipMain: mainStale(), noTerrain: false, terrainGate: false });   // 入力の瞬間に最新camをworkerへ（全球z<4も標高の塗りは描く）。terrainGate:false＝入力中はアトラス再構築を起こさない（停止時に一回だけ）
	// 知性の層(gint)は render worker が frame 末尾に同フレーム同カメラで描く（1canvas統合＝泳ぎ・チルト opacity 手当てとも消滅）。
	clearTimeout(settleT);
	settleT = setTimeout(() => {
		for (const cb of mapOn.settle) { try { cb({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, hash: viewHash() }); } catch (e) { console.error("[map.on settle]", e); } }
		moving = false; needsDraw = true; commitUnderground(); updateUnderground(true); wPost({ type: "gintDrawn" }); for (const hh of extGint.values()) hh._zoomReeval?.(cam.zoom); meshMgr.update(true); if (!printHold) saveView();   // 停止後に identify(picking)＋PLATEAU確定（settled＝ロード発火/レーン切替はこの瞬間だけ）＋ビュー保存＋地中フェード確定（止まったら地中=全黒）
		calmT = setTimeout(() => { idleCalm = true; needsDraw = true; }, 550);   // さらに550ms（停止から計700ms）＝ホイール刻みを跨いだ「本当の静止」でだけ手前詳細化
	}, 150);
	schedulePos();   // 座標読み取りもカメラに追随（rAF畳み込み＝タダ同然）
}

// データパイプライン（tile/scene worker）。実装は pipeline.js。
// tiles＝LOD管理（update/labels）、requestMerge＝結合要求（scene worker が結合→render worker へ直行）。
// 図郭外フォールバック水域：optimal_bvmap が 404 を返す提供圏外（韓国・台湾等の外国域）に、water 層の色で
// 「標高ゲート付き全面水域」を敷く（FS が標高h>0を discard＝海は地理院・陸は標高(GEBCO/R10) の管轄裁定。
// 敷かないと圏外は紙色＝l=terrain の等高線が乗ると「白い偽の陸」に見える）。z≥8・sea.minzoom(z9) ゲート共有。
if (!style.ext) style.emptySea = "water";   // 外来 style＝空タイルに水を敷かない（誰の「水」か分からない）
const { relayCtl: pipelineRelay, tiles, requestMerge, setStyle: setPipelineStyle, destroy: destroyPipeline } = createPipeline({
	style, tileUrl: (z, x, y) => BASE_SOURCE.tileUrl(z, x, y), requestDraw: () => { needsDraw = true; }, scenePort: sceneChan.port1, onTile, ell: ELL_ON, workerFactory: hostWorker, request: requester.forTiles(),   // タイル/シーン worker もアプリの入口で・request＝transformRequest/addProtocol（#37）・tileUrl は関数で包む＝map.setStyle で基図の置き場を差し替えられる
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
	onMerged: (slot, sig) => onSceneApplied(slot, sig),
});
if (IOS_RELAY && gpuBackend) { relayCtl = pipelineRelay; const pend = relayPending.splice(0); for (const [m2, t2] of pend) relayCtl(m2, t2); console.log("[boot] iOS relay path active (page -> scene worker -> render worker); flushed", pend.length, "queued messages"); }
// ack＝「このシーンが画面に載った（fallback は次フレーム、multi_draw は適用の瞬間）」。sig はここで初めて確定する
// （要求時の楽観確定をやめた＝失敗が永続穴にならない）。hoisted 関数＝renderWorker.onmessage（上方）からも呼ばれる。
function onSceneApplied(slot, sig) {
	// 基図の門(z<BASEMAP_MINZOOM)より下へ移行後に着地した投げっぱなしmerge：結合結果は scene worker→render worker 直行＝
	// main では止められないため、render() が空にした後から道路/鉄道が復活する（ズームアウト中の要求が遅れて届く）。
	// ack＝着地の合図なので、ここで検知して即座に空へ戻す（sig は確定させない＝復帰時に再結合させる）。
	// 世界タイル(Protomaps)撤去（2026-09-03 湖のNE化）＝world でも基図の門の下はタイルなし＝例外撤廃。
	// ?pm= のときだけ門が 0 まで開く（TILE_MINZOOM）＝汎用アーカイブは低ズームを持っていることがある。
	if (cam.zoom < TILE_MINZOOM) {
		renderer.set("scene", { origin: [cam.center[0], cam.center[1]], layers: [] }, slot);
		needsDraw = true;
		return;
	}
	if (slot === "main") {
		readySig = sig;
		readyKeys = new Set(sig.split("#")[0].split("|").filter(Boolean)); readyTail = sig.slice(sig.indexOf("#"));   // render の Set 照合用（ここが readySig 確定の唯一の点）
		const z = mergePendingZoom.get(sig);
		if (z != null) { mainSceneZoom = z; mergePendingZoom.delete(sig); }
		slog("main merge applied on screen (visible from here)");
	} else if (slot === "base") { baseSig = sig; slog("base swap applied"); }
	needsDraw = true;
}
dbgHost.__mergeFail = () => requestMerge.debugFail();   // 次の merge を故意に失敗させ ack 自己修復を実地検証
dbgHost.__vtPool = () => requestMerge.stats();          // multi_draw 常駐プールの占有を scene worker の console に出す
// ?pm= のアーカイブ自己申告を読む → 層名を役割へ振って描画規則を組み → style へ前置 → 再ビルド。
// 規則の中身は style-pm.js（役割表・紙→インクの階調・描かないものの裁定）。ここは配線だけ。
const withPM = s => EXT ? extBaseStyle(EXT) : BASE_SOURCE.info?.layers?.length ? { ...s, layers: [...pmLayers(BASE_SOURCE.info, theme), ...s.layers] } : s;   // テーマ切替でも掛け直す（switchTheme が theme.style へ戻す・階調は新テーマの紙から作り直る）
// 画像タイル層の起動待ち行列：map.raster（下方で定義）と初フレームが揃ってから実行＝アーカイブのヘッダが先に届いても TDZ/未初期化を踏まない
const rasterBootQ = [];
let rasterBoot = fn => rasterBootQ.push(fn);
if (BASE_SOURCE.kind === "pmtiles") pmtilesInfo(BASE_SOURCE.url).then(info => {
	BASE_SOURCE.info = info;   // maxZ（LOD 上限）にも即効く＝次フレームから分割が maxZoom で止まる
	// ラスタのアーカイブ（tileType＝png/jpeg/webp/avif）＝ベクタ配管はエンジンの門が空タイルで返す＝画像タイル層（基図・塗りは伏せる）へ回す。
	// データが自分の種別を申告する＝同じ ?pm= で済む（初めにデータありき）。出典もアーカイブの自己申告（rasterInfo で消毒）
	if (isRasterTileType(info.tileType)) {
		rasterBoot(() => map.raster.add("pm", { pmtiles: BASE_SOURCE.url }, { order: "under", hideFills: true }).catch(err => console.warn("[pm] raster archive failed", err)));
		console.info(`[pm] ${info.name || PM_SPEC}  raster ${info.tileType}  z${info.minZoom}-${info.maxZoom}  -> imagery layer (fills hidden)`);
		return;
	}
	// 出典：アーカイブが metadata で宣言したものを使う。**他人の置き場の HTML＝非信頼入力**につき
	// innerHTML の直前で消毒する（docs/geopbf §11 の作法・?pm=<攻撃者URL> を踏んでも script が走らない）。
	BASE_SOURCE.attrHTML = info.attribution ? sanitizeHTML(info.attribution) : null;
	attrZone = null;   // 圏を無効化＝既に "region" に居ても次フレームで出典が差し替わる
	style = withPM(theme.style);
	setPipelineStyle(style);   // 生成層込みで再ビルド
	needsDraw = true;
	console.info(`[pm] ${info.name || PM_SPEC}  z${info.minZoom}-${info.maxZoom}  bbox ${info.bbox ? info.bbox.map(v => v.toFixed(2)).join(", ") : "global"}\n     layer -> role: ${pmRoles(info).join(" ") || "no metadata"} (ground/label are not drawn or decoded)`);
}).catch(err => console.warn("[pm] cannot read PMTiles", BASE_SOURCE.url, err));

dbgHost.__style = () => style;   // 現在の style＝検証フック（t-world：world-water 層が「無い」こと＝湖はエンジン lakes スロットへ移行済 2026-09-03）

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 75 * D2R;
let maxPitchCur = opts.maxPitch ?? MAXPITCH;   // 現在のチルト上限＝起動オプション（geoedit.html=0）を実行時に map.setMaxPitch で上書きできる（編集ガジェットの真上固定）   // 山岳ビュー(z<13)は地形が深度で自遮蔽・混成アトラスが地平線までカバー＝高チルトの根拠が揃ったので75°まで開放
// ZOOM_MAX は上方（基図の門より前）で決めている＝BASEMAP_MINZOOM が参照する（使う所より前で決める・TDZ の轍）
const ZOOM_MIN = 1;          // 床1＝地球全体を余白つきで（z1=世界512px＝スマホ縦にも収まる。旧床2は縦画面で地球がはみ出し、モバイルΔ補正が床に潰される素だった 2026-08-02）
// 太陽系圏（2026-08-10）：256pxの梯子を負へ延長＝ズームアウトの続きで太陽系へ（z≈-16.4で冥王星軌道が視野に収まる）。
// 飛行系（デモ・scene・flyTo）も CAM_ZOOM_MIN 床＝台本から太陽系へ飛べる（2026-08-21・LT台本の z=-17 行が動機。
// 旧・飛行系だけ床1の保守的縫い目は撤去＝呼び出し側は皆 z≥3 か Math.max 済みで、床1に頼る呼び出しは無いのを検分済み）。
// ?nosolar=1 で圏ごと停止（?nofar 等と同じ逃げ道の作法）＝その時は飛行床も従来の1へ戻る。
const SOLAR_ZOOM_MIN = -17;
const solarOff = new URLSearchParams(location.search).has("nosolar");
const CAM_ZOOM_MIN = solarOff ? ZOOM_MIN : SOLAR_ZOOM_MIN;   // カメラ実床（手動系はこちら）
let zoomMinCur = CAM_ZOOM_MIN;   // 現在のズーム床＝map.setZoomMin で実行時に上げられる（編集ガジェット＝z2.5・解除で CAM_ZOOM_MIN へ）
let editDropOwner = false;       // 編集ガジェットがドロップを所有中＝dropFile ガジェットは譲る
let atmo = theme.atmo;              // 大気色 rgb + 強さ（テーマ台帳のノブ＝palettes.js）※生き替えで差し替わる
let bldColor = theme.bldColor;      // 建物色（テーマ台帳のノブ＝palettes.js）※生き替えで差し替わる
// cam＝幾何のみ（center/zoom/pitch/bearing/dpr）＝毎フレームの draw payload（将来の worker 境界）。
// 色（clear/land/atmo/bldColor）は静的なので setView で一度きりアップロード＝hot path から追い出す。
const HOME_VIEW = REGION_HOME?.view ?? [0, 20, 1.6];   // 既定起動の視点＝地域宣言の home（日本＝列島ビュー z6.6＝デモ初景）・申告が無ければ世界（globe）
const cam = { center: [HOME_VIEW[0], HOME_VIEW[1]], zoom: HOME_VIEW[2], pitch: 0, bearing: 0, dpr };   // 初訪問時のみ＝共有URL→前回ビューの順で下で復元
// --- 共有URL（パーマリンク）：codec は engine（viewurl.js）。ここは起動の優先度と app 固有クランプだけ ---
// 起動の優先度：URLハッシュ > localStorage(前回ビュー) > 既定の世界ビュー。settle 毎に replaceState で
// 書き戻す＝アドレスバーが常に「今この視点の共有URL」（コピーするだけで人に渡る＝発表・拡散の生命線）。
function applyCamView(v) {
	cam.center = [wrapLon(v.lon), Math.max(-90, Math.min(90, v.lat))];
	cam.zoom = Math.max(zoomMinCur, Math.min(ZOOM_MAX, v.zoom));   // URL/復元は太陽系圏の深度も受ける（編集中は z2.5 床）
	cam.pitch = Math.max(0, Math.min(maxPitchCur, v.pitch || 0));   // 共有hashのtiltも派生アプリの上限に従う（geoedit=0）
	cam.bearing = Number.isFinite(v.bearing) ? v.bearing : 0;
}
const bootView = parseViewHash(opts.view || location.hash || REGIONS.map(r => r.view).filter(Boolean).pop() || "");   // 裸で開いた時の視点は地域宣言が持つ（/nl/ ＝デルフト上空・日本は既定のまま）
// 前回ビューの復元（ortho-earth 本体と同じ流儀）：settle 毎に localStorage へ保存し、起動時にそこから立ち上がる。
// IDBのPLATEAUキャッシュと合わさると「開いた瞬間に前回の街が数秒で立ち上がる」起動になる。
const CAM_KEY = "ortho-japan.cam256";   // 256px世界のz移行(2026-07-26)でキー更新＝旧512世界の保存ビュー（zが1小さい）を読まない
if (bootView) applyCamView(bootView);
else if (opts.persistView !== false) try {   // 前回ビューは URL／opts.view が無い時だけ（優先度＝URL ハッシュ > 前回ビュー > 既定）
	const saved = JSON.parse(localStorage.getItem(CAM_KEY) || "null");
	if (saved && Array.isArray(saved.center) && saved.center.every(Number.isFinite) && Number.isFinite(saved.zoom))
		applyCamView({ lon: saved.center[0], lat: saved.center[1], zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing });
} catch { /* 壊れた保存値は無視して既定の世界ビュー */ }
// ── 共通の時計（#42・2026-09-23）＝ephem/clock（solar と同じ部品）。既定＝実時間（Date.now に張り付く）。
// 起動の優先度＝URL の t=/s=（共有リンク）> opts.time（Date｜ISO 文字列｜ms）> 実時間。状態が変わった時だけ worker へ基準を送る（下の sky の後で結線）
const clock = createClock();
const clockParamsOf = v => { const p = new URLSearchParams(); if (v.time) p.set("t", v.time); if (v.speed != null) p.set("s", String(v.speed)); return p; };
if (opts.time != null) clock.setTime(opts.time instanceof Date ? opts.time.getTime() : typeof opts.time === "string" ? Date.parse(opts.time) : +opts.time);
// ⚠ここに前回ビューの else を繋がない（2026-09-23 #42 で時計の if に繋がり、t= の無い共有 URL が前回ビューに上書きされていた＝9/24 根治）
if (bootView && (bootView.time || bootView.speed != null)) clock.fromParams(clockParamsOf(bootView));
// opts.persistView=false＝前回ビューを読まない・書かない。localStorage はオリジン単位＝同じドメインの別ページ
// （www トップの背景・gishub の待ち受け）で回した視点が /japan/ の「前回の続き」を上書きするのを防ぐ（2026-09-21）
const saveCam = () => { if (opts.persistView === false) return; try { localStorage.setItem(CAM_KEY, JSON.stringify({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing })); } catch { /* private mode 等 */ } };
// 現在ビュー→ハッシュ（codec は engine）。app 固有の後置トークン＝チップ状態 l=…
// 固定キー(opts.layers)はURLに書かない＝そのURLを本家で開いた人には既定が適用される（埋め込み構成を持ち出さない）。
const viewHash = () => {
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
const saveView = () => { saveCam(); if (ownMapEl || opts.urlHash) try { history.replaceState(null, "", viewHash()); } catch { /* file:// 等 */ } };   // 埋め込み（target 指定）ではホストページの URL を書かない（1.0.4〜・opts.urlHash=true で従来どおり）
// 配色テーマの生き替え（reload無し restyle）：基図タイルを新styleで組み直し、静的色・夜家具(ui-dark)・海岸線色・
// N02芯色を差し替える。★URLは書かない＝呼び出し側が「全状態が揃った後」に1回だけ書く（applyView 末尾の saveView／
// palette は switchTheme 後に saveView）＝URL⇄状態の一元化・順序取りこぼしの防止。色は dl.ops に焼き込まれるため基図は
// 再ビルド必須（setPipelineStyle が evict→新styleビルド＝GPU入れ替え＝ピーク約1倍）。一瞬の貼り直しは許容（fade不要）。
function switchTheme(name) {
	if (name === themeName || !MAP_THEMES[name]) return;
	queueMicrotask(() => document.querySelectorAll("#theme-row .lp-theme").forEach(b => b.classList.toggle("on", b.dataset.theme === themeName)));   // 表示パネルのテーマ列同期（themeName確定後＝microtask）
	themeName = name; theme = MAP_THEMES[name]; style = withPM(theme.style);   // 湖はエンジンの lakes スロット（worldPal.sea 直読）＝style 側の世界層前置は廃止（2026-09-03）
	bg = style.layers.find(L => L.type === "background");
	land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.96, 0.96, 0.95, 1];
	atmo = theme.atmo; bldColor = theme.bldColor;
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
	renderer.set("sea", { li: seaLi(style, "water"), li2: seaLi(style, "water-hi"), minzoom: 9 });
	renderer.set("bldFill", { li: seaLi(style, "building") });   // 建物塗りの層添字も新styleへ（sea と同じ「li はテーマ依存」の流儀）
	themes = mkThemes(style);   // ★層添字（LI_RAILHI 等）を新テーマの層配列で焼き直す＝hidden(点火ゲート)の添字ズレ根治。
	// 旧＝boot の style で一度だけ生成→テーマごとに層数/順が違い添字が全ズレ＝「チップOFFなのに rail-hi/road-hi/航路が点き、土台の道路網が消える」（本人報告・実機/本番でも再現・両バックエンド共通）
	mapEl.classList.add("ui-dark");   // 白抜き家具＝常時ON（本人裁定2026-08-05）＝テーマ生き替えでも外さない（旧＝land輝度で付け外し）
	gint.admin0Layer?.style(gint.admin0DrawStyle());   // admin0 独立層＝新テーマの coastLine で塗り直し（色の居座り根治）
	if (layerState.rail && n02?.loaded) { n02.loaded = false; n02.load(); }   // N02新幹線の芯(land色)を新テーマで引き直す（データは温間）
	readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; needsDraw = true; onMove();   // 下地・主層を強制再結合（次のupdateで新styleビルド→順次merge）
}
// contourColor/distColor/hypso はテーマの任意ノブ（無指定＝renderer 既定：セピア等高線・遠山ブルー・単色陰影）
renderer.set("view", { clear, land, atmo, bldColor, showN02: false,
	gintSub: !/[?&]nosub=1/.test(location.search),   // ?nosub=1＝gint 線の地形適応細分を切る（3D ドレープ貫きの切り分け用・?nofar と同じ逃げ道の作法）
	...(theme.contourColor && { contourColor: theme.contourColor }),
	...(theme.distColor && { distColor: theme.distColor }),
	...(theme.hypso && { hypso: theme.hypso }),
	// 全球ハイプソ（?world=1）＝球/地形シェーダの標高×気候 cross-blend。clim＝気候場テクスチャ
	// （Köppen-Geiger/Beck et al. CC-BY を 720x360 に焼き縮め・public 資産）。theme.worldHypso で色ノブ上書き可。
	// null 明示＝居座り防止の流儀。showN02＝N02交通(新幹線等)の表示。鉄道チップで切替
	graticule: WORLD_VT,   // 10度レチクル（v1 geoGraticule10 の移植・本人指名 2026-09-01）＝シェーダ計算（z帯はレンダラ側）
	worldHypsoZ: BASEMAP_MINZOOM,   // 世界の色（ハイプソ・湖・罫線）が退場するズーム＝地域の基図が入場する所と同値
	worldHypso: WORLD_VT ? { clim: CLIM_URL, ...(theme.worldHypso || {}) } : null });
// 海：水レイヤ(WA)をビュー一律にゲート＝cam.zoom<9 では描かない（＝紙の海・まだら無し）、z9+で一律点火。
const seaLi = (st, id) => st.ext ? -1 : st.layers.findIndex(L => L.id === id);   // 外来 style＝地理院の「海は z9 から」「建物の塗りはチルトで伏せる」の門を当てない（層 id が偶然同じでも）
renderer.set("sea", { li: seaLi(style, "water"), li2: seaLi(style, "water-hi"), minzoom: 9 });   // li2＝水系点火面も同じ海ゲート
renderer.set("bldFill", { li: seaLi(style, "building") });   // 建物フットプリント塗り＝3D（チルト）時は伏せる（押し出しと二重表現のため）

// --- gint（知性の層）＝gint/layers.js（単一スロットのユーザー層・多層 addGint・admin0 独立層・bake-ahead・地形ドレープ・fid 塗り・queryAll）。
// ここは配線だけ：定数と道具を渡し、テーマは getter、多層の台帳（extGint / extActive / gintLayerSeq）は onmessage より先に宣言した
// 上のものを束ねて渡す。生成後に定義される関数（flyTo / loadBelowSea / loadLakes）はラップ＝呼ぶ時に解決。外が読み書きしていた
// 状態（hoverTip / extTipOwn / suppressAdmin0 …）は gint.* のアクセサで同名の意味のまま。
let worldContentH = null;   // opts.worldContent の手綱（テーマ切替で塗り直す・下の install が入れる）
const gint = createGintLayers({
	canvas, mapEl, renderer, wPost, dbgHost, ASSET_BASE, WORLD_VT, LOW_MEM, noGint, ZOOM_MIN, ZOOM_MAX, cam,
	worldContent: !!opts.worldContent,   // 海岸線・国境＝全ズーム＋最初から 10m・河川/海洋境界＝z1.5 から（equal と同じ出し方）
	worldBandZ: BASEMAP_MINZOOM,   // 湖・海面下の陸が見える帯＝世界ハイプソと同じ所で退場（地域の基図が入場する所）
	get theme() { return theme; },
	get worldStyle() { return WORLD_STYLE_THEMES[themeName] || WORLD_STYLE_THEMES.mono; },   // 世界線（河川・海洋境界線）の色＝ortho-core worldstyle の正本（段階 3）
	layers: { map: extGint, get active() { return extActive; }, set active(v) { extActive = v; }, nextId: () => ++gintLayerSeq },
	smallAreaHover: !!opts.smallAreaHover,
	requestDraw: () => { needsDraw = true; }, onMove: () => onMove(), flyTo: (...args) => flyTo(...args), loadBelowSea: () => { if (!flying) loadBelowSea(); }, loadLakes: () => { if (!flying) loadLakes(); },   // 飛行の通過点で重い層を発火させない（着地の onMove で再評価）
	get flying() { return flying; },   // 国境の細密版（10m）も飛行の通過点では読まない
});
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
	needsDraw = true;
	console.log("[wdepr] below_sea_land loaded: %d features", pbf.length);
}
// デバッグ手：任意 FC を wdepr へ直載せ（焼き差し替え前の見た目確認。null で解除）
dbgHost.__terr = () => wPost({ type: "terrStats" });   // 標高アトラスの内部状態を worker から吸い出してコンソールへ（dev診断）
dbgHost.__wdepr = fc => { renderer.set("wdepr", fc ? buildGeoJSONOverlay(fc.features || fc, [0, 0], { lines: false, ranges: true }) : null); needsDraw = true; };

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
	needsDraw = true;
	console.log(`[lakes] NE ${RES} lakes loaded: ${pbf.length} features (fill = worldPal sea)`);
	lakesState = 2;   // 2=搭載済（renderer へ送達）＝検証フック用
}
dbgHost.__lakes = () => lakesState;   // 検証フック（t-world）：0=未 1=着手 2=搭載済

// --- 星空劇場＝sky/theater.js（星・惑星・月・星座・黄道/天の赤道・日時計・太陽系圏との交代）。ここは配線だけ。
const sky = createSkyTheater({ mapEl, renderer, dpr, cam, STARSKY_Z, solarOff, now: () => clock.time, stars: opts.stars, get printHold() { return printHold; }, saveView: () => saveView(), requestDraw: () => { needsDraw = true; } });
// 時計の状態が変わった（段・日時・今へ戻る・範囲の端で停止・URL の読み込み）＝worker へ基準・空と惑星・URL・map.on("time")
let clockSentAt = 0;
function sendClock() { clockSentAt = performance.now(); wPost({ type: "set", cmd: "clock", data: clock.isLive() ? null : clock.anchor() }); }
clock.on("change", () => {
	sendClock(); sky.timeChanged(); needsDraw = true;
	if (!printHold) saveView();
	for (const cb of mapOn.time) { try { cb({ time: clock.time, step: clock.step, live: clock.isLive(), ticking: false }); } catch (e) { console.error("[map.on time]", e); } }
});
if (!clock.isLive()) sendClock();   // 起動時に過去/未来の t= か opts.time が来ていた
// --- 路線オーバーレイ＝地域宣言 rail（日本＝packages/jp/src/n02.js の N02 新幹線・路線＋駅のビーズ・鉄道チップで点灯）。宣言しない地域＝null。land＝紙色はテーマで差し替わる＝getter。
const n02 = REGION_RAIL?.({ renderer, get land() { return land; }, BASEMAP_MINZOOM, requestDraw: () => { needsDraw = true; } });
// デバッグ用カメラジャンプ：__cam(lon, lat, zoom, pitchDeg, bearingDeg)。検証スクリプトやコンソールから任意視点へ。
dbgHost.__cam = (lon, lat, zoom = cam.zoom, pitchDeg = cam.pitch * R2D, bearingDeg = cam.bearing * R2D) => {
	cam.center = [lon, lat]; cam.zoom = zoom; cam.pitch = pitchDeg * D2R; cam.bearing = bearingDeg * D2R;
	onMove();
};

// 手打ちデモ：地区名(部分一致)かbase URLを指定して読み込み、カメラもそこへ寄せる（自動と違いカメラを動かす）。省略時は登録簿の先頭。
dbgHost.__mesh = async (nameOrBase, tiles) => {
	if (!meshOn) { console.warn("[mesh] opts.mesh=false = 3D buildings feature disabled"); return; }
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
	size.w = Math.round(w * dpr); size.h = Math.round(h * dpr);
	// GL canvas：バッファサイズは worker が持つ（transfer 済）。main は CSS と論理サイズ(size)だけ。
	canvas.style.width = w + "px"; canvas.style.height = h + "px";
	wPost({ type: "resize", width: size.w, height: size.h });
	// label canvas：worker が持つ（transfer 済）＝main は CSS だけ。バッファは resize メッセージで worker が更新。
	labelCanvas.style.width = w + "px"; labelCanvas.style.height = h + "px";
	needsDraw = true;
}
const ro = new ResizeObserver(resize);   // destroy で disconnect するため手綱を持つ
ro.observe(mapEl);   // #map のサイズ変化に追随（ウィンドウでも埋め込み先のレイアウトでも同じ経路）

resize();

// --- 操作：左ドラッグ=パン / 右(or Shift/Ctrl)ドラッグ=チルト+方位 / ホイール=ズーム ---
// --- 入力（パン/チルト/ホイール/アンカー）：実装は engine（input.js＝grab+レート併走・縁縮退対策の結晶）。
// ここは日本アプリ固有の反応だけ注入：クリック→identify（基図overlay＋知性gint）、ホバー→gintの筆識別、
// ジェスチャ開始→フライト中断（主導権は常に人）。z範囲＝1(宇宙の余白)〜19(z20はタイルの切れ目が目立つ)。
let measureClick = null;   // 測距モード中だけ非null＝クリックを測距へ奪う（識別・星座トグルより先）
let profileClick = null;   // 断面図の経路指定中だけ非null＝同上（ガジェット毎に1スロット＝相互に潰さない）
let poiClick = null;       // POI台帳編集のarmed中だけ非null＝同上
// 道具の排他（後から開いた方が勝つ）：計測・断面図・日影・可視域・操作方法カードは同時に一つだけ
// ＝クリックの行き先が常に一意・左下のパネルが重ならない（計測⇄断面図 本人裁定2026-08-27 → 2026-09-24 に仲間を拡張）。
// 配線は登録側＝ここ（ガジェット同士は独立の掟＝相互を知らない）：開いた瞬間に toolOpen(名) → 他の全員の close を呼ぶ。
// close は「開いていなければ何もしない」こと・toolOpen を呼び返さないこと（再入しない）。新しい道具は toolClose へ登録し onOpen を渡す。
// 計測/断面図の本体ハンドルは onBody で到着（スタブ経由の遅延 import 後）＝未ロードの相方は必然的にOFF＝何もしなくてよい。
let measureBody = null, profileBody = null;
const toolClose = new Map();   // 名 → close()
const toolOpen = name => { for (const [k, f] of toolClose) if (k !== name) { try { f(); } catch (e) { console.warn("[tool] close", k, e); } } };
toolClose.set("measure", () => measureBody?.stop?.());
toolClose.set("profile", () => profileBody?.stop?.());
let editClick = null;      // 派生アプリ編集モード（geoedit）中だけ非null＝同上（map.setEditClick で装着/解除）
// zoomMin の二重指定（前:ZOOM_MIN 後:2＝後勝ちで床2）を解消（2026-08-10）＝ホイール/ピンチも太陽系圏へ潜れる
const input = createInput({
	canvas, cam, size, dpr, maxPitch: maxPitchCur, zoomMin: zoomMinCur, zoomMax: ZOOM_MAX, onMove, signal: ac.signal,   // opts.maxPitch＝派生アプリのチルト上限（0=俯瞰固定＝geoedit）。??＝0を殺さない
	// モーダル表示中は矢印キーで背後の地図を動かさない（文字入力中は input.js が自前で判定）。
	// opts.keyboard＝false で矢印キーを地図に取らない／関数なら真の間だけ取る（背景に置く埋め込みでページのスクロールや一覧の矢印移動を奪わない・2026-09-21）
	blocked: () => modalOpen(mapEl) || opts.keyboard === false || (typeof opts.keyboard === "function" && !opts.keyboard()),
	onGesture: () => flightCtl.cancel(),
	onClick: (x, y) => {
		if (measureClick) return measureClick(x, y);   // 測距モード＝クリックは頂点追加へ（識別/星座は止める）
		if (profileClick) return profileClick(x, y);   // 断面図モード＝クリックは経路の頂点追加へ（同上）
		if (poiClick) return poiClick(x, y);           // 台帳編集モード＝クリックは対象選択/置き先へ（同上）
		if (editClick) return editClick(x, y);         // 派生アプリ編集モード＝同上（geoedit の選択/作図）
		// 旧・全球ビューの画面クリック＝星座線トグルは表示パネルの「星空」チップへ移設（本人裁定 2026-09-02
		// 「画面クリックの切り替えはいずれ何かとぶつかる」）＝クリックは全ズームで識別に一本化。
		overlay.identifyAt(x, y); if (gint.interactive || extActive) wPost({ type: "gintClick", x, y });
		if (mapOn.click.length) {   // §4 map.on('click')＝層をまたぐ照会（main 同期 JS レイキャスト・手前の層から）
			const ll = unprojectXY(x, y);
			if (ll) { const hits = gint.queryAllGint(ll); for (const cb of mapOn.click) cb({ lngLat: ll, hits }); }
		}
	},
	onHover: (x, y) => {
		gint.lastHoverXY = [x, y];
		// smallAreaHover＝census2020限定＝estat中は町丁目を点in面で識別し名前tip＋境界太線（ミスは gint へフォールバック）。
		// デモ（フラグ無し）は従来どおり gint ホバーのみ＝凍結挙動を一切変えない。
		// tip 持参層（筆＝moj/maff）がホバー可で載っている間は gint が主導＝町丁目tip/太線と排他（本人裁定2026-08-18）。
		const fudeOwn = (gint.userGint?.tip && gint.interactive && gint.hover) || !!extActive;   // 追加層がカーソル保持中（§4.1 アクティブ層＝主導権）も gint が主
		if (fudeOwn && gint.extTipOwn) { gint.extTipOwn = false; renderer.set("overlayHover", null); needsDraw = true; }   // 跨ぎ瞬間＝残った町丁目tip/太線を掃除（tip本文は直後の識別ackが上書き）
		if (!fudeOwn && hostHooks.hover.some(h => h(x, y))) return;   // 地域パックのホバー（e-Stat の町丁目 tip＝日本の install が差す）
		if ((gint.interactive && gint.hover) || extActive) wPost({ type: "gintMove", x, y });
		// 世界ビュー＝admin0 国ポリゴンの国名 tip（本人裁定 2026-08-30「国の認識」）。識別は main 同期
		// （admin0Pbf.identifyAt＝findPolygon smallest-wins・エンジン往復なし）。面のみ探索＝点/線半径は0。
		const a0TipOn = opts.countryTip !== false && gint.admin0Layer && gint.admin0Vis && cam.zoom < gint.ADMIN0_Z && !(gint.userGint && cam.zoom >= (gint.userGint.minZoom ?? 0));   // opts.countryTip=false＝国名 tip を出さない（自前の tip を持つ器）
		if (a0TipOn && gint.admin0Pbf && gint.hoverTip && !fudeOwn) {
			// z≥5.5＝国名 tip の圏外（本人裁定 2026-09-02）：基図接近帯は注記が主役＝国名の板は出さない
			if (cam.zoom >= gint.WORLD_TIP_MAXZ) { if (gint.worldTipOn) { gint.hoverTip(null); gint.worldTipOn = false; } return; }
			const ll = unprojectXY(x, y);
			const fid = ll ? gint.admin0Pbf.identifyAt(ll[0], ll[1], { point: 0, polyline: 0 }) : null;
			let name = null;
			// 国名＝表示言語の列（NE の NAME_JA/NAME_FR/NAME_AR…＝25 言語・th は無し）→ 英語 → NAME。地図の中身だが「国名 tip が日本語のまま」（本人 2026-09-19）＝UI 側の穴
			if (fid != null) { try { const p = gint.admin0Pbf.getProperties(fid) || {}; name = p["NAME_" + getLang().toUpperCase()] || p.NAME_EN || p.NAME || null; } catch (e) { /* 壊れfeature＝tipなし */ } }
			gint.hoverTip(name ? [name] : null);
			gint.worldTipOn = !!name;
		}
	},
});

// アイドル退場：マウスを止めると左上/右上のアイコンが静かに消え、動かす（or キー操作）と戻る。
// タッチ端末は対象外（指では常時見えていてほしい＝端末標準の消え方に委ねない）。
// 触れている間（#gadgets/#chips 上）と検索を開いている間は消さない＝操作中に足元が消える事故を防ぐ。
if (!window.matchMedia("(pointer: coarse)").matches) {
	const IDLE_MS = 2500;
	let idleT = 0;
	const overUI = () => { const h = mapEl.querySelector(":hover"); return !!(h && (h.closest("#gadgets") || h.closest("#chips"))); };
	const searchOpen = () => !!mapEl.querySelector("#search.open");
	const panelOpen = () => { const p = document.getElementById("layers-panel"); return !!(p && !p.hidden); };   // 表示パネル展開中＝選んでいる最中に足元が消えない
	const hideUI = () => { if (overUI() || searchOpen() || panelOpen()) { idleT = setTimeout(hideUI, IDLE_MS); return; } mapEl.classList.add("ui-idle"); };   // 操作中は消さず再武装
	const wakeUI = () => { mapEl.classList.remove("ui-idle"); clearTimeout(idleT); idleT = setTimeout(hideUI, IDLE_MS); };
	mapEl.addEventListener("mousemove", wakeUI, { signal: ac.signal, passive: true });
	mapEl.addEventListener("pointerdown", wakeUI, { signal: ac.signal, passive: true });
	mapEl.addEventListener("wheel", wakeUI, { signal: ac.signal, passive: true });   // ホイールズームも「操作」＝ズーム中に退場しない（トラックパッド2本指も wheel）
	window.addEventListener("keydown", wakeUI, { signal: ac.signal });
	idleT = setTimeout(hideUI, IDLE_MS);   // 起動後に無操作なら退場（動かせば戻る）
}
const evXY = input.evXY;   // 座標読み取り（計器）も同じローカル変換を使う

// --- 座標読み取り（左下）：2段テーブル＝上段ラベル「経度・緯度・標高・z値・傾度」/下段数値（attr右下の複数段と対に）。
// zoom はここ（z値列）が持つ＝スケールバーは距離のみ。表示更新は rAF に畳む＝hot path を汚さない。
// 標高は altpbf の getHeight（ortho-earth 本体と同じ点サンプラ）＝必要タイルをその場でオンデマンド取得
// （R90/R10/R01 をズームで自動選択・IDB は地形アトラスと共有）。render worker のアトラス照会だと
// 未ロード地帯が0mになる劣化版だった。onend＝タイル到着でゲートを開けて再照会（マウス静止中でも値が確定）。
const posEl = orDetached(document.getElementById("pos"));
const hasPos = posEl.isConnected;   // 座標表示なし（instrumentsで"pos"非搭載）＝標高照会も止める（見えない計器のためのfetchをしない）
// 狭画面＝座標テーブルなし（境界はCSSの掟と同値）。回転や窓リサイズで跨ぐため毎回評価＝posOn が表示と標高fetchの両方を裁く。
const narrowMq = window.matchMedia("(max-width: 480px)");
const posOn = () => hasPos && !narrowMq.matches;
posEl.innerHTML = `<table><thead><tr><th>${t("Lon")}</th><th>${t("Lat")}</th><th>${t("Elev")}</th><th>${t("z")}</th><th>${t("Rot")}</th><th>${t("Tilt")}</th></tr></thead><tbody><tr><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>`;
const posCells = [...posEl.querySelectorAll("td")];   // [経度, 緯度, 標高, z値, 回転, 傾度]（毎フレームはtextContent更新のみ＝DOM再構築しない）
let posMouse = null, posElev = null, posElevId = 0, posElevAt = 0, posRaf = false, getHeight = null;
setAltApiUrl("https://api.ortho-earth.com");
const getHeightP = createGetHeight({ apiUrl: "https://api.ortho-earth.com", dtm: REGION_DTM, onend: () => { posElevAt = 0; schedulePos(); updateUnderground(true); } });   // タイル到着＝地中判定も取り直す（静止中に届いた分）   // Promiseも保持＝断面図はローダ到着を待って照会（起動直後でも0mに化けない）
getHeightP.then(f => { getHeight = f; updateUnderground(true); });   // ローダ準備完了＝最初のサンプル（共有URLで地中に着地した起動を拾う）
// 距離スケール（真俯瞰=2Dのみ）：ortho-map Accessories draw_scale() と同じ1-2-5系列。
// d256m＝256px当たりの実距離[m]。当アプリも256px世界(2026-07-26統一)＝本家と同じ zoom がそのまま使える。
// px↔角度 は正射図法ゆえ緯度非依存のまま。m換算だけ WGS84 の東西曲率半径 N(φ)（バーは横置き＝東西）で
// 緯度依存に（2026-08-11・段階A）：旧・固定 6372000 は N(35°)=6385.2km 比 -0.2%、高緯度ほどずれた。
// 南北は M(φ)＝N と最大0.5%違うが、バー1本に2値は出せない＝横置きの素直（正確な計測は M ガジェットの Vincenty）。
const scaleEl = orDetached(document.getElementById("scale")), scaleTxt = orDetached(document.getElementById("scale-txt")), scaleBar = orDetached(document.getElementById("scale-bar"));
const comma = s => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
const flightCtl = createFlight({ cam, viewW: () => size.w, maxPitch: maxPitchCur, minZoom: zoomMinCur, onMove, onFlying: f => {   // 飛行床＝カメラ実床（太陽系圏へ台本から飛べる・?nosolar時は1）
	flying = f;
	if (!f && gint.suppressAdmin0) { gint.suppressAdmin0 = false; gint.updateGintSlot(); }   // 着地＝抑制解除→再評価（着地が低ズームなら海岸線が戻る）
} });
// flyTo をラップ：両端が z≥ADMIN0_Z（coast 表示条件外）なら飛行中の海岸線を抑制＝弧の中間の低ズームで
// loadAdmin0 を誘発しない（描画も出さない）。片方でも coast 条件内なら従来どおり（端の海岸線をポップさせない）。
const flyTo = (lon, lat, zoom, tiltDeg, bearingDeg) => {
	gint.suppressAdmin0 = cam.zoom >= gint.ADMIN0_Z && zoom >= gint.ADMIN0_Z;
	if (gint.suppressAdmin0) gint.updateGintSlot();   // 既に coast がスロットに載っていれば離陸前に降ろす
	return flightCtl.flyTo(lon, lat, zoom, tiltDeg, bearingDeg);
};
dbgHost.__fly = flyTo;   // デバッグ/検証用（__cam の飛行版）

// テーマ・チップ状態：静かな白黒の土台は常に全部見えている。チップは主題の「文字の表示」
// または「色の点火」を切り替えるだけ。すべて既取得データの再スタイル＝再取得・再デコードなし。
//   place/terrain … 文字（注記カテゴリ）の表示ON/OFF
//   rail/road … 色の点火ON/OFF（OFFでも土台グレーは出ている）
const layerState = { ...defaultLayerState };   // UIトグル状態は main が保持・変更（チップで反転）
// 共有URLのレイヤ集合は「客が触れるキー」だけ上書き（旧romajiトークンは normLayerKey で読み替え）。
if (bootView?.layers) { const urlSet = new Set(bootView.layers.map(normLayerKey)); for (const k of FREE_LAYER_KEYS) layerState[k] = urlSet.has(k); }
if (bootView?.layers?.includes(SKY_LAYER)) sky.applyConstellations(true);   // l=sky＝星座線ONで起動（z<4で実描画）
if (bootView?.contour && !("terrain" in fixedLayers)) layerState.terrain = true;   // 旧URLの c（等高線トグル時代）＝地形チップに読み替え（後方互換）
Object.assign(layerState, fixedLayers);   // 固定は最後＝共有URLでも破れない（埋め込み主の意図が勝つ）
let styleSig = JSON.stringify(layerState);
let lastTileOrder = [];   // 直近フレームで描いた基図タイル [{ key:"z/x/y", z }]（map.queryRenderedFeatures）
const mkThemes = st => { const th = createThemes(st, { suppressAdmin: !!opts.hideAdminBoundary }); if (st.ext) { th.hiddenLi = () => new Set(); th.filterLabels = all => all; } return th; };   // 外来 style＝チップの点火ゲートと注記の分類（地理院の層 id・注記コード）を当てない＝style が描くと言った物を全部
let themes = mkThemes(style);   // 分類（allowlist）は themes.js の純関数。
dbgHost.__hiddenLi = () => [...themes.hiddenLi(layerState, cam.zoom)];   // 点火ゲートの検定窓（t-palette-live＝添字ズレの回帰封じ）hideAdminBoundary＝基図の行政界(赤線)を常に隠す（派生アプリが自前境界を描く時）。⚠層添字（LI_*）は style 依存＝テーマ生き替え(switchTheme)で必ず作り直す（旧添字の hidden が「土台を隠し点火層を出す」実バグ 2026-09-09）

// LOD選択 or テーマ状態(styleSig)が変わった時だけシーンを再結合。原点は安定化（プルプル防止）。
// readySig/baseSig は merge の ack（onMerged）で確定。要求中の sig は mergeReq が持ち、
// MERGE_ACK_MS 以内は同一要求を重ねない。ack が来なければ出し直す＝merge の一過性失敗が自己修復する。
const MERGE_ACK_MS = 1500;
const mergeReq = { main: { sig: "", at: 0 }, base: { sig: "", at: 0 } };
function requestWithAck(slot, sig, doRequest) {
	const rq = mergeReq[slot];
	if (sig === rq.sig && performance.now() - rq.at < MERGE_ACK_MS) return false;   // 同一要求の ack 待ち
	doRequest();
	rq.sig = sig; rq.at = performance.now();
	setTimeout(() => {   // ack 喪失→要求記憶を消して次フレームで出し直させる（静止中でも needsDraw で起こす）
		const confirmed = slot === "main" ? readySig : baseSig;
		if (rq.sig === sig && confirmed !== sig) { rq.sig = ""; needsDraw = true; }
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
const MOVE_SWAP_MS = 125;
// ラベルはGLシーンと別経路（render worker のテキスト描画）＝丁目(z15.5)/空港マーク(z13)のz門で GL バッファを
// 全再結合する理由は無い（本人指摘 2026-08-04「テキストにmergeは要らない」）。両者を merge シグネチャから外し、
// ラベルだけ独立に更新＝ズームアウトで z15.5/z13 を跨いでも基図の書き直しゼロ。駅軌道(z14.5)は本物のGL層
//（hiddenLi）なので merge 側に残す（railチップON時のみ効く）。
let lastLabelGate = "";
const labelGate = () => "" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= CHOME800_MINZOOM ? 1 : 0)
	+ (cam.zoom < AIRPORT_MARK_MAXZ && cam.zoom >= BASEMAP_MINZOOM && airportMarks.length ? "A" : "")
	+ (landmarks && layerState.facility ? "L" + landmarkMinH(cam.zoom) : "")   // 高さ梯子の段を跨いだらラベルだけ作り直す
	+ (poi && layerState.facility && cam.zoom >= 14 ? "P" + poi.ver + "z" + Math.floor(cam.zoom * 2) : "");   // POI台帳＝タイル到着(poiVer)・半ズーム(rank解禁)で作り直す
// ?swaplog=1＝「書き直し」イベントの計器：main merge（タイル集合の増減つき）・ラベル再構築・base差し替えを
// 時刻つきで出す。ズームアウトのポップがどのイベントと同時刻かで犯人を特定する切り分け用。
const swapLog = /[?&]swaplog=1/.test(location.search);
const slog = (...a) => swapLog && console.log(`[swap ${(performance.now() / 1000).toFixed(2)}s z${cam.zoom.toFixed(2)}]`, ...a);
function swapScene(order) {
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
	if (performance.now() - lastMainReqT < 200) { needsDraw = true; return; }
	if (!requestWithAck("main", sig, () => {
		lastMainReqT = performance.now();
		mergePendingZoom.set(sig, cam.zoom);   // ackが来たらこのzoomのシーンが乗る（ズームアウト退場判定の基準）
		if (mergePendingZoom.size > 32) mergePendingZoom.clear();   // ack喪失の残骸が溜まらないよう頭打ち
		if (swapLog) {   // 集合の増減＝この merge が「何を書き直すか」。zの分布も出す（keepFine深さ切れの検出）
			const prev = new Set((readySig.split("#")[0] || "").split("|").filter(Boolean));
			const cur = new Set(order.map(o => o.key));
			const zHist = {}; for (const o of order) zHist[o.z] = (zHist[o.z] || 0) + 1;
			slog(`main merge request: +${[...cur].filter(k => !prev.has(k)).length} -${[...prev].filter(k => !cur.has(k)).length} / ${cur.size} tiles`, "z dist", zHist);
		}
		requestMerge("main", order, sceneOrigin, themes.hiddenLi(layerState, cam.zoom), sig);
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
const chomeCanon = t => t.replace(/[（(]([一二三四五六七八九十百]+)[)）]$/, "$1丁目");   // 突合キー＝正式表記へ寄せる
const chomeShort = t => t.replace(/([一二三四五六七八九十百]+)丁目$/, "（$1）");        // 表示＝（N）へ（丁目の無い町名はそのまま）
const nearAnchor = (list, a, m) => {   // list（経緯度の列）に a から m メートル以内の点があるか
	if (!list) return false;
	const cos = Math.cos(a[1] * Math.PI / 180);
	return list.some(p => Math.hypot((p[0] - a[0]) * 111320 * cos, (p[1] - a[1]) * 111320) < m);
};
function mergeChome(all, zoom) {
	if (!all.some(L => L.code === 800)) return all;   // 800 が来ないズーム/地域＝素通り（配列コピーもしない）
	if (zoom < CHOME800_MINZOOM) return all.filter(L => L.code !== 800);
	const by = new Map();   // 210 の正規化名 → アンカー列（同名の町丁が全国に居るので位置でも裁く）
	for (const L of all) if (L.code === 210) {
		const k = chomeCanon(L.text);
		let a = by.get(k); if (!a) by.set(k, a = []);
		a.push(L.anchor);
	}
	const seen = new Map();   // 出した町丁名 → アンカー列（同じ注記が隣タイルにも入っている分の重複よけ）
	const out = [];
	for (const L of all) {
		if (L.code !== 800 && L.code !== 210) { out.push(L); continue; }
		const k = chomeCanon(L.text);
		// 1km＝同じ町丁の 210/800 のアンカーずれ（実測で最大300m級）は確実に拾い、
		// 同名の別の町（「本町一丁目」等は全国にある）は拾わない距離。
		if (L.code === 800 && nearAnchor(by.get(k), L.anchor, 1000)) continue;   // 210 が既に出す町丁＝そちらに任せる
		// 30m＝「同じ注記が二度来た」だけを消す距離。GSI は境界の注記を隣タイルにも入れており、
		// 800 は件数が桁違いなので実害が出る（実測 z16 市中心5km四方の同名30m以内ペア：札幌104・京都230。
		// うち大半は距離5m未満＝完全な同一点）。長い町丁を両端に打った正規の二つ（数百m離れ）は残る。
		if (nearAnchor(seen.get(k), L.anchor, 30)) continue;
		let a = seen.get(k); if (!a) seen.set(k, a = []);
		a.push(L.anchor);
		out.push(L.code === 800 ? { ...L, text: chomeShort(L.text), code: 210 } : L);   // コピー＝タイル側のラベルキャッシュを壊さない
	}
	return out;
}
function rebuildLabels(order) {
	lastLabelGate = labelGate();
	slog("labels rebuilt (no merge)");
	const allLabels = tiles.labels(order);
	if (airportMarks.length && cam.zoom < AIRPORT_MARK_MAXZ && cam.zoom >= BASEMAP_MINZOOM) {   // 低ズーム＝静的台帳から空港マークのみ注入（タイル注記441と同名は二重にしない）。下限＝基図の門（world帯(z<6.5)に日本固有の✈を漏らさない）
		const have = new Set(allLabels.filter(L => L.code === 441).map(L => L.text));
		for (const a of airportMarks) if (!have.has(a.text)) allLabels.push(a);
	}
	// 施設名札（landmark/POI 共通）のインク＝現テーマの注記層から一度だけ取る＝テーマ生き替え(switchTheme)に
	// そのまま追随する（読み込み時に焼くと夜テーマで紙色のハローが残る）。
	const facInk = () => {
		const lp = style.layers.find(l => l.id === "label")?.paint || {};
		return { color: parseRGBA(lp["text-color"] ?? "#333") || [0.2, 0.2, 0.2, 1],
			halo: parseRGBA(lp["text-halo-color"] ?? "#fff") || [1, 1, 1, 1], haloW: +(lp["text-halo-width"] ?? 1.1) };
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
				allLabels.push({ text: m.text, code: LANDMARK_CODE, anchor: m.anchor, size: 15, sort: 3, color, halo, haloW });
			}
		}
	}
	// POI台帳（施設チップON・z14+）：rank 解禁・案A dedup・権威位置の上書き＝packages/jp/src/poi.js injectLabels
	if (poi && layerState.facility && cam.zoom >= 14) poi.injectLabels(allLabels, { zoom: cam.zoom, ink: facInk(), landmarkCode: LANDMARK_CODE });
	const merged = mergeChome(allLabels, cam.zoom);   // 町丁名の二系統(210/800)を（N）表記ひとつへ畳んでから allowlist へ
	const filtered = themes.filterLabels(merged, layerState, cam.zoom, layerState.terrain);   // 地形ON＝測量点の標高数値も通す
	const kuVisible = filtered.some(L => L.code === 110);   // 区名が見えている＝政令市名は「背景ラベル」へ格下げする合図
	lastLabels = filtered.map(L => {
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
	});
	renderer.set("labels", lastLabels);   // ラベル集合を render worker へ。標高付与(sampleElev)も terrain と一緒に worker 側で行う（同期して描く）
}

// 粗い下地（base スロット）：移動中も常に敷き直して先端の空白・ちらつきを消す。低zで少数＝安く広い。
let baseSig = "";
// 線レイヤは merge には含める（間引かない）。main と重なって出る時だけ renderer が draw 時に伏せる
//（「LODの荒い線」対策は描画側の判断へ移設）＝ズームアウトで下地が主役の間は線も描く。低ズームの
// 地図は線（行政界・道路）が絵の本体＋海は紙の海＝塗り だけだと真っ白になるため。
function swapBase(coarseOrder) {
	const sig = coarseOrder.map(o => o.key).join("|") + "#" + styleSig;
	if (sig === baseSig || !coarseOrder.length) return;
	requestWithAck("base", sig, () =>
		requestMerge("base", coarseOrder, [cam.center[0], cam.center[1]], themes.hiddenLi(layerState, cam.zoom), sig));   // 下地も scene worker で結合。baseSig は ack で確定
}

// 地形チップの GL 側副作用：等高線(真俯瞰の茶線)の表示切替と、OFF時の地形読込インジケータ消灯。
// ラベル集合も再結合＝測量点の標高数値を即反映し、動かさなくても1枚描き直す。
function applyTerrain() {
	renderer.set("view", { showContour: layerState.terrain });
	if (!layerState.terrain) elevEl.style.display = "none";
	readySig = ""; mergeReq.main.sig = "";
	renderer.draw(cam, { skipBase: false, noTerrain: false, terrainGate: true });
	needsDraw = true;
}
// チップの見た目同期：点火クラスと aria-pressed（支援技術向けのトグル状態）を常に一緒に更新する。
const syncChip = b => { const on = !!layerState[b.dataset.k]; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); };
// レイヤ点火/消灯の正規経路（チップclickの本体を関数化）：状態＋見た目＋styleSig再結合＋per-key副作用＋URL書き戻し
// を一手に。チップ以外の搭載者（poiedit の施設自動点灯など）もここを呼ぶ＝DOMをAPIにしない・チップ不在でも動く。
function setLayer(k, on) {
	if (!!layerState[k] === !!on) return;   // 既にその状態＝no-op（副作用も焚かない）
	layerState[k] = !!on;
	const b = document.querySelector(`.chip[data-k="${k}"]`); if (b) syncChip(b);   // チップ不在（chips:false等）でも状態は成立
	styleSig = JSON.stringify(layerState); readySig = ""; needsDraw = true;
	if (k === "rail") { renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) n02?.load(); }   // 鉄道ON＝N02新幹線も表示＋初回fetch
	if (k === "facility" && layerState.facility) loadLandmarks();   // 施設ON＝PLATEAUランドマーク台帳も初回fetch
	if (k === "terrain") applyTerrain();   // 地形＝等高線・測量点標高・水系も一緒に点火
	saveView();   // レイヤ状態も共有URLの一部＝即書き戻す
}
// チップ操作：状態を反転し、styleSig を更新して即再結合（再取得なし・一瞬）。
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
	const k = b.dataset.k; if (!k) return;   // data-k 無し＝UIトグル（数字など）は別ハンドラ
	setLayer(k, !layerState[k]);
}));
// 星空チップ（表示パネル内）＝旧・全球ビューの画面クリックから移設。見た目同期は constelApply 側（点火の一本道）
document.getElementById("chip-sky")?.addEventListener("click", () => sky.toggleConstellations().then(saveView));
// 基図の濃さスライダー（表示パネル）＝fill/line の α を両バックエンド一括で（COG/オーバーレイを主役にする時に引く）
document.getElementById("base-alpha")?.addEventListener("input", e => { const a = (+e.target.value) / 100; renderer.set("view", { baseAlpha: a, globeAlpha: a }); needsDraw = true; });   // 2026-09-13 本人裁定＝球体（globe/terrain）まで一緒に引く（地中の震源等を透かす）
// テーマ列（表示パネル内）＝palette ガジェットの即決版（ライブ見本はガジェットの領分・こちらは名前+紙色スウォッチ）。
// themeFixed（opts.theme 焼き付け）は列ごと出さない。現在テーマの点火同期は switchTheme 側。
{
	const row = document.getElementById("theme-row");
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
document.querySelectorAll(".chip[data-k]").forEach(syncChip);
if (layerState.rail) { renderer.set("view", { showN02: true }); n02?.load(); }
if (layerState.facility) loadLandmarks();   // 起動時に共有URL(l=facility)や opts.layers で施設ONなら台帳も取りに行く
renderer.set("view", { showContour: layerState.terrain });

// 操作方法カード（#hint）はオプトインガジェットへ移設＝gadgets/hint.js（6秒の自動表示・×の記憶ごと）。

// ハッシュの手編集・ペーストで視点ジャンプ（replaceState は hashchange を発火しない＝自分の書き戻しとは無干渉）
window.addEventListener("hashchange", () => {
	const v = parseViewHash(location.hash);
	if (!v) return;
	// 手編集/貼り付けは共有URLの「完全再現」＝c= 無しは既定 mono へ戻す（旧 l=dark 互換もここで前処理）。
	// デモの「無指定=現状維持」とは掟が違う＝入口ごとの方針は v.theme へ焼き、適用は applyView 一本に委ねる（画面維持・reload無し）。
	if (!themeFixed && !v.theme) v.theme = v.layers?.includes("dark") ? "dark" : "mono";
	applyView(v);   // 即時適用（l=→c=→カメラ→URL を1本の順序で・固定(opts.theme)は applyView 内で不変）
}, { signal: ac.signal });
// 共有URLの l=/c(等高線) をチップ・描画へ反映（hashchange とデモ台本 flyView の共通部）。
// 固定キー(opts.layers)はどの経路でも破れない＝客が触れるキーだけ反映（旧romajiトークンは読み替え）
function applyViewLayers(v) {
	if (!v.layers && !v.contour) return;
	if (v.layers) { const urlSet = new Set(v.layers.map(normLayerKey)); for (const k of FREE_LAYER_KEYS) layerState[k] = urlSet.has(k); }
	if (v.layers) sky.applyConstellations(v.layers.includes(SKY_LAYER));   // 星座ON/OFFも反映
	if (v.contour && !("terrain" in fixedLayers)) layerState.terrain = true;   // 旧URLの c＝地形チップに読み替え（後方互換）
	document.querySelectorAll(".chip[data-k]").forEach(syncChip);
	styleSig = JSON.stringify(layerState); readySig = "";
	renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) n02?.load();
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
function applyView(v, { fly = false, glide = false, jump = false } = {}) {
	if (!v) return false;
	applyViewLayers(v);                                                        // 1) l=（チップ）＝先に反映
	if (v.time || v.speed != null) clock.fromParams(clockParamsOf(v));   // 時計（t=/s=・#42）＝貼り替え・台本のビューが時刻を持つ時だけ（無ければ今の時計のまま）
	if (!themeFixed && v.theme && v.theme !== themeName) switchTheme(v.theme);  // 2) c=（テーマ生き替え・switchThemeはURLを書かない＝ここで束ねる）
	if (fly && !jump) (glide ? flightCtl.glideTo : flyTo)(wrapLon(v.lon), v.lat, v.zoom, v.pitch * R2D, v.bearing * R2D);   // 3a) フライト（離陸＝現視点のまま animate）
	else { if (jump) flightCtl.cancel(); applyCamView(v); onMove(); }          // 3b) 即時＝カメラ直書き（jump／hashchange貼付け）
	saveView();   // 4) URL書込＝全状態が揃った後に1回。即時=確定視点／フライト=離陸時に(新テーマ/チップ+離陸視点)、着地settleで dest cam へ更新
	return true;
}
// デモ台本／内部から共有ビューへ「飛ぶ」薄いラッパ（applyView に委譲＝順序と URL 書込を一本化）。glide=滑走・jump=即時。
function flyView(hash, opts = {}) {
	const v = typeof hash === "string" ? parseViewHash(hash) : hash;
	if (!v) { console.warn(`[flyView] unparsable view "${hash}"`); return false; }
	return applyView(v, { fly: true, glide: opts.glide, jump: opts.jump });
}
// シーン台本の連続ドリー（glidePath）＝{view,travel} の列を parseViewHash → flightCtl.glidePath へ（via 連続を1本の centripetal Catmull-Rom で貫く＝隅田川ドリー）。
// travel＝その点に到達するまでの区間尺[秒]（エンジン側キーは secs）。カメラのみ＝l=/c= は道中で触らない（直前シーンが設定済み）。pitch/bearing はラジアンのまま cam へ。
function glidePathView(entries) {
	const pts = (entries || []).map(h => {
		const e = typeof h === "string" ? { view: h } : h;
		const v = typeof e.view === "string" ? parseViewHash(e.view) : e.view;
		return v ? { lon: wrapLon(v.lon), lat: v.lat, zoom: v.zoom, pitch: v.pitch || 0, bearing: v.bearing || 0, secs: e.travel } : null;
	}).filter(Boolean);
	if (pts.length) flightCtl.glidePath(pts);
	return true;
}

// コンパス兼リセット（#reset）はオプトインガジェットへ移設＝gadgets/compass.js（針の追従・リセットアニメごと）。
// 針の毎フレーム追従は render が呼ぶフック＝搭載時に差し替わる（未搭載なら no-op）。
// render のフレームフック：搭載したガジェットが毎描画で姿勢/位置を追随させる置き場（コンパスの針・現在地マーカー等）。
// onMove→needsDraw→render のたびに全員呼ぶ＝静止中は呼ばれない（動いた時だけ追随＝タダに近い）。
const frameHooks = new Set();
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
	const basemap = cam.zoom >= TILE_MINZOOM;
	let tu = null, skipBase = false;
	if (!basemap) lastTileOrder = [];
	if (basemap) {
		sampleGroundElev();   // 中心の地面標高を追随（非同期・~100m格子メモ）＝groundR の材料
		tu = tiles.update(cam, size.w, size.h, { tilePx: (moving || !gpuFast || !idleCalm) ? undefined : IDLE_TILE_PX, groundR: groundRNow(), keepFine: keepFineNow(), maxZ: BASE_SOURCE.info ? BASE_SOURCE.info.maxZoom : undefined });   // maxZ＝PMTiles 基図のときアーカイブの maxZoom で分割を止める（それ以上は最細段を引き伸ばす＝空タイル要求を作らない）   // tilePx＝「本当の静止」（settle+550ms）だけ主層を一段細かく（手前の詳細化・GPU格付け fast 限定・undefined=既定560）。groundR＝地形リフト球（チルト×高標高地の手前くさび欠け根治）。keepFine＝ズームアウトの子孫代打（3D限定）。calm が needsDraw を立て、細タイルの ready は requestDraw で連鎖再描画
		lastTileOrder = tu.order;   // 描いている基図タイル＝map.queryRenderedFeatures の問い合わせ先
		const o = tu.order, tailNow = "#" + styleSig + "#z" + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0);   // tailNow＝swapScene の署名末尾と同式
		const merged = !!readySig && readyKeys !== null && readyTail === tailNow && readyKeys.size === o.length && o.every(t => readyKeys.has(t.key));
		skipBase = tu.covered && merged;
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
		const zone = cam.zoom < STARSKY_Z ? "sky" : (WORLD_VT && cam.zoom < BASEMAP_MINZOOM) ? "world" : "region";
		if (zone !== attrZone) {
			attrZone = zone;
			const attr = document.querySelector("#attr");
			if (attr) {
				if (attrRegionHTML == null) attrRegionHTML = attr.innerHTML;   // 地域版（起動時の静的な出典）を初回に退避（復帰用）
				const A = (url, label) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
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
				const rasTail = rasterSrc ? `<br>${t("Imagery: $1", rasterSrc)}` : "";
				// 出典は文単位で組む（"出典：" + 名前 の足し算は言語で語順が壊れる＝i18n.js の掟）。$1 に列を差す
				const head = pmSrc ? pmSrc + "・" : "";
				attr.innerHTML = zone === "region" ? ((pmSrc ? t("Source: $1", pmSrc) + rasTail + tail : attrRegionHTML + rasTail))
					: zone === "world" ? t("Source: $1", head + worldSrc) + rasTail + tail
					: t("Source: $1", head + A("https://github.com/ofrohn/d3-celestial", "d3-celestial") + "・" + worldSrc) + rasTail + tail;   // sky＝星図が先頭（星空劇場の主役）
			}
		}
	}
	sky.solarFrame(size.w, size.h);   // 太陽系圏（z<1）＝solarsky.js の遅延ロード・実位置の惑星・ドーム惑星/星座注記との交代（sky/theater.js）
	if (cam.zoom < TILE_MINZOOM) {   // 基図の門の下＝タイルなし（全球ハイプソ＋gint線＋湖スロットの領分。世界タイル撤去 2026-09-03。?pm= のときだけ 0 まで開く）
		if (!basemapHidden) {
			const o = [cam.center[0], cam.center[1]];
			renderer.set("scene", { origin: o, layers: [] }, "main");
			renderer.set("scene", { origin: o, layers: [] }, "base");
			renderer.set("labels", []);
			readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; lastLabels = []; mainSceneZoom = -1; basemapHidden = true;   // 復帰時に再結合させる
		}
		runFrameHooks();
		logEl.textContent = `world  zoom=${cam.zoom.toFixed(1)}  basemap off / coastline + elevation fill`;
		return;
	}
	basemapHidden = false;
	// 旧・世界帯の選抜cap（maxZ=世界タイルz3・keepFine切り）は世界タイル撤去（2026-09-03）で不要＝
	// ここへ来るのは z≥TILE_MINZOOM だけ（門の下は上の早期returnでタイルなし）。?pm= は maxZ を
	// アーカイブの maxZoom で掛けている（tiles.update）＝旧・世界帯の cap と同じ役割を汎用化したもの。
	const { order, coarseOrder, total } = tu;   // 選抜は上（描画命令の前・基図圏のみ）で実施済み
	if (poi && layerState.facility && cam.zoom >= 14) poi.load(cam);   // z14+×施設ON＝POI台帳タイル(poi/14/x/y)を可視ぶん先読み（既取得は素通り）
	dbgHost.__lastOrder = order;   // デバッグ：現在の選択タイル（コンソール/検証スクリプトから確認）
	dbgHost.__tileStats = () => { const s = tiles.stats(); console.log(`[tiles] resident ${s.tiles} tiles / ${(s.bytes/1048576).toFixed(1)}MB (budget ${(s.budgetBytes/1048576).toFixed(0)}MB, deviceMemory≈${s.deviceMemoryGB}GB, cacheEntries ${s.cacheEntries})`); return s; };   // コンソールから常駐メモリ確認
	dbgHost.__tileCache = tiles.cache;   // デバッグ：タイル台帳の生参照（status/tries/seen を界隈キーで覗く＝矩形再描画の切り分け用）
	swapBase(coarseOrder);                          // 粗い下地は常に敷く（移動中も）＝先端の空白を無くす
	if (!moving) swapScene(order);   // 静止フレームは毎回＝mainDesired 更新と settle 後の穴埋め merge を最速で
	else if (zoomStable && performance.now() - lastMoveSwapT >= MOVE_SWAP_MS) { lastMoveSwapT = performance.now(); swapScene(order); }
	runFrameHooks();                               // 3D時のみコンパス表示・針を方位／現在地マーカーの追随 等
	logEl.textContent = `tiles=${order.length}/${total}  labels=${lastLabels.length}  zoom=${cam.zoom.toFixed(1)} pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°`;
}

// --- 統合スパイク：geopbf/e-Stat を overlay に描き、クリックで identify（実装は overlay.js）---
const overlay = createOverlay({ renderer, cam, size, dpr, requestDraw: () => { needsDraw = true; } });
// 拡張が tip を握る合図（e-Stat のホバー結果）：ヒット＝名前を tip へ／ミス(市区町村外)＝gint ホバーへフォールバック（他市区町村の tip/リンク）
const ownTip = name => {
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
let drawHudEl = null;
function showDrawHud(msg) {
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
	const gpu = (memGpu ? memGpu.atlas + memGpu.mesh + memGpu.msaa : 0) + memRaster;   // GPU固定＝標高アトラス近/裏/遠＋地形メッシュ＋MSAA（webgpuのみ・GL2は暗黙確保で0表示）＋画像タイル層のテクスチャ
	const total = pl.bytes + ts.bytes + memTerrain + gpu + pl.transient.bytes;
	if (total > hudPeak) hudPeak = total;
	const nc = navigator.connection || {};
	return {
		backend: dbgHost.__backend || memBackend, gpuName: memGpuName, fps: memFps, frameMs: memFrameMs, res: memRes,
		zoom: cam?.zoom ?? 0, pitch: cam?.pitch ?? 0, bearing: cam?.bearing ?? 0,
		device: {   // navigator/画面＝どの端末が落ちたかの特定（RAMは4GB級/8GB級の判別、DPR×viewport＝フレームバッファのGPU圧）
			ram: navigator.deviceMemory || null, cores: navigator.hardwareConcurrency || null,
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
// 本体は遅延 import＝.then は同期init完走後（map.gadget 定義済み）に走る。hud= 指定時だけ計測器ボタンを載せる（open=1/畳=0 は hudOpenInit）。
if (hudOn) import("./gadgets/hud.js").then(({ hud }) => {
	map.gadget("hud", function (opts) { return hud.call(this, { snapshot: hudSnapshot, open: hudOpenInit, signal: ac.signal, ...opts }); });
	map.gadget.hud();
}).catch(e => console.error("[hud] failed to load module", e));
// 初期 overlay なし（全球 land は検証用。__loadOverlay(name) で任意に。__tokyo() は日本の install が生やす）

let clockLastT = performance.now(), clockUrlAt = 0;
function frame() {
	if (destroyed) return;   // destroy 後はループを再予約しない＝rAF が自然消滅
	// 共通の時計を進める（#42）：実時間は Date.now に張り付くので何もしない。早送り/巻き戻し中だけ積算し、惑星・日時計・太陽系圏を追わせる。
	// worker の基準は 1 秒ごとに送り直す（main の積算は dt を 0.1 秒で頭打ち＝裏タブ復帰の跳びを防ぐ solar の流儀／worker は壁時計で外挿＝その差を詰める）
	const nowT = performance.now(), dtC = Math.min(0.1, (nowT - clockLastT) / 1000); clockLastT = nowT;
	if (clock.playing && !clock.isLive()) {
		clock.tick(dtC); sky.timeChanged();
		if (cam.zoom < STARSKY_Z) needsDraw = true;
		if (nowT - clockSentAt > 1000) sendClock();
		if (nowT - clockUrlAt > 1000) { clockUrlAt = nowT; if (!printHold) saveView(); }   // 再生中も URL の t を追わせる＝いつコピーしても今の場面（solar と同じ）
		for (const cb of mapOn.time) { try { cb({ time: clock.time, step: clock.step, live: false, ticking: true }); } catch (e) { console.error("[map.on time]", e); } }
	}
	if (needsDraw) { needsDraw = false; render(); }
	requestAnimationFrame(frame);
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
	for (const f of hostDestroy) { try { f(); } catch (e) { console.warn("[region] destroy", e); } }   // 地域パックの片付け（e-Stat worker 等）
	overlay.destroy();
	// デバッグ手はこのインスタンスの閉包を掴んだまま＝GCの錨になるので窓から下ろす
	// 生やした名前は全て下ろす（従来は13名だけ＝取りこぼしが閉包を掴んだまま残っていた）。
	// 埋め込み時は dbgHost が使い捨ての器＝この delete は空振りするが、閉包の錨は器ごと GC される。
	for (const k of ["__arakawaFit", "__backend", "__budget", "__cam", "__admin0", "__a0", "__drawErr", "__drawHud", "__drawSendErr", "__drawSendN", "__farState", "__fly", "__gload", "__hiddenLi", "__lastOrder", "__loadEstat", "__loadOverlay", "__mergeFail", "__moj", "__mojFile", "__paint", "__paintFid", "__paintOverlap", "__paintParity", "__paintProps", "__mesh", "__meshPurge", "__sapporo", "__shadow", "__standup", "__worldContent", "__style", "__tileCache", "__tileStats", "__vtPool"]) delete dbgHost[k];
	mapEl.classList.remove("world", "ui-dark", "ui-idle");   // SDK が付けた class を全部外す（全球フェード・白抜き家具・無操作フェード）＝"as it was" を真に
	if (ownMapEl) {   // 自前ページを預かった時に入れた inline 寸法を元へ（再起動しても二重に残らない）
		document.documentElement.style.cssText = pageStyle.html ?? "";
		document.body.style.cssText = pageStyle.body ?? "";
	} else mapEl.id = mapElPrevId;   // 預かった div の id は返す（家具規格で map へ改名していた分の後始末）
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
// map.gadget(name, func) で登録し map.gadget.name() で画面に追加する。func 内の this＝この map＝
// mapEl/flyTo 等の手綱がそのまま使える。検索・操作説明は標準装備から外した最初のオプトインガジェット。
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
const map = { cam, flyTo, renderer, mapEl, destroy, clock,
	// ★表示状態（共有される「単一の真実」）を map インスタンスから常時参照可能に＝viewHash が直列化するのと同じ状態。
	// center/zoom/pitch/bearing（cam）＋ theme(c=)＋ layers(l=・sky含む)＋ sky ＋ 現在の共有URL文字列(hash)。読み取り専用スナップショット。
	// eye＝カメラ実位置（緯度・経度・海抜m・注視点距離m＝参考値）。
	get view() { return { center: [...cam.center], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, theme: themeName, layers: FREE_LAYER_KEYS.filter(k => layerState[k]).concat(sky.constelVisible ? [SKY_LAYER] : []), sky: sky.constelVisible, hash: viewHash(), eye: eyePose() }; },
	// ★scene-player API（v2整備 2026-08-09）＝台本オブジェクトの直接上映（第三の入口・エディタの土台）。要 demo ガジェット搭載。
	//   playScenes(obj, {from, quick, onScene, onEnd})／stopScenes()＝停止（準備中でも安全）。正典＝demo/scene-format.md §7
	playScenes: (obj, opts) => scenes.playScenes(obj, opts), stopScenes: () => scenes.stopScenes(),
	//   sceneTimeline(obj)＝タイムライン（時刻評価・スクラブ）→ {dur, rows, at, seek, end}（再生せず任意秒の絵＝エディタ用）
	sceneTimeline: obj => scenes.sceneTimeline(obj),
	// 録画用（scene エディタ）：動的解像度を固定（映像に縮み絵を混ぜない）。on=true で即 res=1・降段停止／false で通常運転へ
	pinRes: on => renderWorker.postMessage({ type: "pinRes", on: !!on }) };
// ガジェット注入用の座標ブリッジ（engine の project/unproject を今の cam/サイズで束ねた手綱）。
// projectLL＝経緯度→画面CSS座標[x,y,front]（front<0＝裏半球・視界外）。unprojectAt＝画面座標→[lon,lat]（球外は null）。
// DOMオーバーレイ（現在地マーカー/pop/計測）の標高乗せ：radius=1（標高0の球面）へ投影すると、
// DTM開通後はチルトで「地中の位置」が投影され地面とずれる（現在地マーカーで実測。真俯瞰は放射変位＝不変）。
// 表示中の地形変位と同式（TERR_EXAG/EARTH_M × pitchフェード＝renderer elevScaleEff と同形・cityFlatは撤去済み）。
// 標高は getHeight を100m格子でメモ（非同期＝到着まで0m、次フレームで乗る。キーはマーカー/pop地点のみ＝有界）。
const elevMemo = new Map();
// ★有界化（2026-09-13）：makeProjectorH を大量点（地震 overlay 2300点×3/フレーム）で呼ぶと、未メモの点ごとに getHeight が一斉発射され
//   renderer が SIGTRAP で落ちた（実測・エラーコード5）。同時在庫を ELEV_INFLIGHT_MAX に絞り、溢れた点は「今回は 0m」（メモに残さない＝次回また試す）。
//   マーカー/pop の数点なら従来どおり即照会。needsDraw も 1 回に束ねる。
const ELEV_INFLIGHT_MAX = 64; let elevInflight = 0, elevDrawPending = false;
const elevOf = (lon, lat) => {
	const k = Math.round(lon * 1000) + "," + Math.round(lat * 1000);
	const hit = elevMemo.get(k);
	if (hit !== undefined) return typeof hit === "number" ? hit : 0;
	if (!getHeight || elevInflight >= ELEV_INFLIGHT_MAX) return 0;   // 溢れ＝照会しない（メモ未登録のまま）
	elevMemo.set(k, null); elevInflight++;
	Promise.resolve(getHeight(lon, lat, cam.zoom)).then(h => { elevMemo.set(k, +h || 0); }, () => elevMemo.set(k, 0))
		.then(() => { elevInflight--; if (!elevDrawPending) { elevDrawPending = true; requestAnimationFrame(() => { elevDrawPending = false; needsDraw = true; }); } });
	return 0;
};
const dispRadius = (lon, lat) => {
	const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14)), pf = pt * pt * (3 - 2 * pt);
	return pf > 0 ? 1 + elevOf(lon, lat) * pf * (TERR_EXAG / EARTH_M) : 1;
};
const projectLL = (lon, lat) => { const st = cameraState(cam, size.w, size.h); const [sx, sy, f] = project(st, lon, lat, dispRadius(lon, lat)); return [sx / dpr, sy / dpr, f]; };
const unprojectAt = (clientX, clientY) => { const r = canvas.getBoundingClientRect(); const st = cameraState(cam, size.w, size.h); return unproject(st, (clientX - r.left) * dpr, (clientY - r.top) * dpr); };
// makeProjector＝カメラ状態を1回だけ束ねた投影関数を返す（多点を1描画で投影＝測距の大圏分割で状態計算を積まない）。
// unprojectXY＝canvasローカルCSS座標→経緯度（input.onClick が渡す x,y と同座標系）。
const makeProjector = () => { const st = cameraState(cam, size.w, size.h); return (lon, lat) => { const [sx, sy, f] = project(st, lon, lat, dispRadius(lon, lat)); return [sx / dpr, sy / dpr, f]; }; };
// makeProjectorH＝高度付き投影（注釈の3Dピン用）：地表（地形持ち上げ込み）から hメートル 上の点を画面へ。
// 真俯瞰では鉛直変位が画面上ほぼ消える＝ピンは自然に「円」へ縮退・チルトで立つ（annoガジェットが使用）。
const makeProjectorH = ({ terrain = true } = {}) => { const st = cameraState(cam, size.w, size.h); return (lon, lat, hM) => { const [sx, sy, f] = project(st, lon, lat, (terrain ? dispRadius(lon, lat) : 1) + (hM || 0) * (TERR_EXAG / EARTH_M)); return [sx / dpr, sy / dpr, f]; }; };   // terrain:false＝地形リフト無し（海面球＋hM）＝大量点の overlay 用（getHeight を叩かない・2026-09-13）
const unprojectXY = (x, y) => unproject(cameraState(cam, size.w, size.h), x * dpr, y * dpr);
// shot（画面保存）用スナップショット：render worker（GLは別スレッド＝mainから読めない）に「今の1枚」を
// 出させる。gint は 1canvas統合で基図と同じ1枚に写り込む＝旧・別撮り合成（wantGint）は消滅。
// 解像度は size（device px＝フル）を正とし、shot 側が各層をこの寸法へ合わせて重ねる。
const snapPending = new Map();
function snapPart(id, key, data) {
	const rec = snapPending.get(id); if (!rec) return;
	rec.parts[key] = data; rec.need.delete(key);
	if (!rec.need.size) { snapPending.delete(id); rec.resolve(rec.parts); }
}
let snapSeq = 0;
const requestSnapshot = () => new Promise(resolve => {
	const id = ++snapSeq;
	snapPending.set(id, { need: new Set(["render"]), parts: { W: size.w, H: size.h }, resolve });
	wPost({ type: "snapshot", id });
});
map.requestSnapshot = requestSnapshot;   // ★プラットフォーム公開面（map.playScenes と同格）：生スナップ {W,H,render}。合成は gadgets/compose.js＝geoedit の公開サムネ等が使う
dbgHost.__map = map;   // デバッグ手（__cam 等と同族）＝コンソール/CDP 検証から公開面を叩く取っ手（埋め込み時は器止まり＝窓を汚さない）
// --- 印刷（平面図）用の撮影：ライブパイプラインを一時的に「印刷カメラ」（同中心・真俯瞰・北向き・指定z・
// noTerrain＝紙仕様）へ振り、タイル/注記の読み込みが落ち着いてから readPixels スナップショットを取り、
// 元のカメラへ戻す。printHold が autoMesh と settle保存を抑止（印刷カメラを自動ロードや保存に漏らさない）。
const printSettled = timeout => new Promise(res => {
	const t0 = performance.now();
	const tick = () => {
		const idle = !moving && (cam.zoom < BASEMAP_MINZOOM || (readySig && readySig === mergeReq.main.sig));
		if (idle || performance.now() - t0 > timeout) return setTimeout(res, 300);   // 一拍おいて描画を確定
		setTimeout(tick, 200);
	};
	setTimeout(tick, 400);
});
async function printCapture({ zoom, cropCss }) {
	flightCtl.cancel();
	const saved = { center: [...cam.center], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing };
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
map.overlay = overlay;
map.applyGintData = gint.applyGintData;
map.clearUserGint = gint.clearUserGint;    // 単一スロットのユーザー層を丸ごと撤去（gint.applyGintData の対＝派生アプリのスロット調停用）
map.addGint = gint.addGint;              // gint 多層（v2 spec §4 の顔・両バックエンド）＝追加であって置換ではない
map.queryAll = gint.queryAllGint;        // 層をまたぐ照会＝{layer, fid} の対（手前の層から・§10.2）
map.on = (ev, cb) => { if (ev === "load" && mapLoaded) queueMicrotask(() => cb({})); mapOn[ev]?.push(cb); return map; };
map.off = (ev, cb) => { const a = mapOn[ev]; if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } return map; };   // 購読解除（2026-09-11）   // §4: 'click'（hits=queryAll 同型）/'move'/'load'
map.standupGint = gint.standupGint;         // liftM=null で解除
map.gintFeatures = gint.gintFidFeatures;    // fid 整列 properties（式評価・表直書きの入力）
map.paint = gint.paintGint;                 // Mapbox式 → buildFidStyle
map.paintTable = (u32, count) => { gint.sendGintPaint({ table: u32, count }); needsDraw = true; };   // fid→RGBA表の直書き（コロプレス切替＝これだけ）
map.fitZoomForBbox = gint.fitZoomForBbox;
map.projectLL = projectLL;             // 経緯度→画面CSS座標[x,y,front]（DOMマーカー用・front<0=裏半球）
map.unprojectXY = unprojectXY;         // canvasローカルCSS座標→[lon,lat]|null（onClick の x,y と同座標系。球外=null）
map.makeProjector = makeProjector;     // カメラ状態を1回束ねた投影関数（多点を1フレームで投影＝編集ハンドル用）
map.ellipsoidOn = () => ellipsoidOn();   // 楕円体表示か（?ell=1）＝geoedit（npm） が「編集は完全球体」の注意書きに使う（ortho-core を直接 import させない）
map.makeProjectorH = makeProjectorH;   // 高度付き投影（注釈の3Dピン＝チルトで立つ。annoガジェット用）
map.setEditClick = fn => { editClick = fn; };   // 派生アプリのクリック横取りスロット（null で解除＝measure/poi と同型）
map.t = (key, ...args) => t(key, ...args);   // UI 文言の訳（SDK が起動時に読んだ辞書で引く＝器の頁が i18n と辞書をもう一度読まない・1.2.0〜 2026-09-22）
Object.defineProperty(map, "lang", { get: () => getLang(), enumerable: true });   // 表示言語（ja/en/…）
map.requestDraw = () => { needsDraw = true; };  // オーバレイ更新後の1フレーム点火（派生アプリの編集描画用）
map.setOpacity = ({ base, globe } = {}) => { const v = {}; if (base != null) v.baseAlpha = base; if (globe != null) v.globeAlpha = globe; renderer.set("view", v); needsDraw = true; };   // 基図（紙・線）と球体（globe/terrain）の不透明度＝表示パネルのスライダーと同じ口（0..1）
// チルト上限の実行時変更（編集ガジェット＝真上固定 setMaxPitch(0)・null=起動時の上限へ戻す）。入力・飛行・共有hashの3経路が同じ値に従う
map.setMaxPitch = rad => {
	maxPitchCur = rad ?? (opts.maxPitch ?? MAXPITCH);
	input.setMaxPitch(maxPitchCur); flightCtl.setMaxPitch(maxPitchCur);
	if (cam.pitch > maxPitchCur) { flightCtl.cancel(); cam.pitch = maxPitchCur; onMove(); }
	needsDraw = true;
};
map.maxPitch = () => maxPitchCur;
// ズーム床の実行時変更（編集ガジェット＝z2.5・null=カメラ実床へ戻す）。入力・飛行・共有hash・ズームボタンの4経路が従う
map.setZoomMin = z => {
	zoomMinCur = z ?? CAM_ZOOM_MIN;
	input.setZoomMin(zoomMinCur); flightCtl.setMinZoom(zoomMinCur);
	if (cam.zoom < zoomMinCur) { flightCtl.cancel(); cam.zoom = zoomMinCur; onMove(); }
	needsDraw = true;
};
map.zoomMin = () => zoomMinCur;
// ---- カメラの口（#35・2026-09-23・MapLibre と同名）----
// 角は度（MapLibre と同じ）。map.view の pitch/bearing（ラジアン）とは単位が違う＝既存の flyTo(lon, lat, zoom, tiltDeg, bearingDeg) と揃えた。
// padding＝{ top, right, bottom, left }（CSS px）か数値＝「中身の中心」を画面中心から寄せる（UI パネルに隠れる分）。setPadding の値が既定。
// 近似の範囲：寄せはズーム先の地表の度/px で真俯瞰として解く（チルト中の奥行きの伸びは見ない＝MapLibre の厳密解より粗い）。
let camPadding = { top: 0, right: 0, bottom: 0, left: 0 };
const padOf = p => p == null ? camPadding : typeof p === "number" ? { top: p, right: p, bottom: p, left: p } : { top: +p.top || 0, right: +p.right || 0, bottom: +p.bottom || 0, left: +p.left || 0 };
const lngLatOf = c => c == null ? null : Array.isArray(c) ? [+c[0], +c[1]] : [+(c.lng ?? c.lon), +c.lat];
// 目標（中身の中心に置きたい点）→ カメラ中心。画面の右＝(cos b, −sin b)・上＝(sin b, cos b)（東, 北）・b＝方位（時計回り）
function padCenter([lon, lat], zoom, bearingRad, pad) {
	const ox = (pad.left - pad.right) / 2, oy = (pad.top - pad.bottom) / 2;   // 中身の中心の画面上のずれ（右・下が正）
	if (!ox && !oy) return [lon, lat];
	const degPx = 360 / (WORLD_PX * Math.pow(2, zoom));
	const e = (ox * Math.cos(bearingRad) - oy * Math.sin(bearingRad)) * degPx, n = (-ox * Math.sin(bearingRad) - oy * Math.cos(bearingRad)) * degPx;
	return [wrapLon(lon - e / Math.max(0.05, Math.cos(lat * D2R))), Math.max(-89.9, Math.min(89.9, lat - n))];
}
function camTarget(o = {}) {   // MapLibre の CameraOptions → cam の単位（ラジアン）の目標
	const zoom = o.zoom ?? cam.zoom, bearing = o.bearing != null ? o.bearing * D2R : cam.bearing, pitch = o.pitch != null ? o.pitch * D2R : cam.pitch;
	let c = lngLatOf(o.center) ?? [cam.center[0], cam.center[1]];
	if (o.center != null || o.padding != null) c = padCenter(c, zoom, bearing, padOf(o.padding));
	return { lon: c[0], lat: c[1], zoom: Math.max(zoomMinCur, Math.min(zoomMaxCur, zoom)), pitch, bearing };
}
function clampCamLimits() {
	if (cam.zoom > zoomMaxCur) cam.zoom = zoomMaxCur;
	if (!camBounds) return;
	const [w, s, e, n] = camBounds;
	cam.center[1] = Math.max(s, Math.min(n, cam.center[1]));
	const lon = wrapLon(cam.center[0]);
	const inside = w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;   // w>e＝±180 を跨ぐ可動域
	if (inside) return;
	const d = x => { const v = Math.abs(wrapLon(lon - x)); return v; };
	cam.center[0] = d(w) <= d(e) ? w : e;
}
map.jumpTo = (o = {}) => { flightCtl.cancel(); const t = camTarget(o); cam.center = [t.lon, t.lat]; cam.zoom = t.zoom; cam.pitch = Math.max(0, Math.min(maxPitchCur, t.pitch)); cam.bearing = t.bearing; onMove(); return map; };
map.easeTo = (o = {}) => o.animate === false ? (map.jumpTo(o), Promise.resolve()) : flightCtl.easeTo(camTarget(o), o.duration ?? 500);
// flyTo：従来の位置引数（lon, lat, zoom, tiltDeg, bearingDeg）に加え、MapLibre の形 flyTo({ center, zoom, pitch, bearing, padding, animate })
map.flyTo = (a, ...rest) => {
	if (a == null || typeof a !== "object" || Array.isArray(a)) return flyTo(a, ...rest);
	if (a.animate === false) { map.jumpTo(a); return Promise.resolve(); }
	const t = camTarget(a);
	return flyTo(t.lon, t.lat, t.zoom, t.pitch * R2D, t.bearing * R2D);   // 省略した角は今の値（MapLibre の意味論）
};
// bbox＝[west, south, east, north]（west>east＝±180 跨ぎ）か [[w,s],[e,n]]。options＝{ padding, maxZoom, pitch, bearing, animate, linear, duration }
map.cameraForBounds = (bounds, o = {}) => {
	let b = Array.isArray(bounds?.[0]) ? [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]] : bounds;
	if (!b || b.length < 4 || !b.every(Number.isFinite)) return null;
	let [w, s, e, n] = b; if (e < w) e += 360;
	const pad = padOf(o.padding ?? camPadding);
	const W = Math.max(1, size.w / dpr - pad.left - pad.right), H = Math.max(1, size.h / dpr - pad.top - pad.bottom);   // size は device px
	const latC = (s + n) / 2;
	const thX = Math.max(1e-9, (e - w) * Math.cos(latC * D2R) * D2R), thY = Math.max(1e-9, (n - s) * D2R);
	let zoom = Math.log2(Math.min(W / thX, H / thY) / (WORLD_PX / (2 * Math.PI)));
	zoom = Math.max(zoomMinCur, Math.min(o.maxZoom ?? zoomMaxCur, zoomMaxCur, zoom));
	return { center: [wrapLon((w + e) / 2), latC], zoom, pitch: o.pitch ?? 0, bearing: o.bearing ?? 0, padding: pad };
};
map.fitBounds = (bounds, o = {}) => {
	const c = map.cameraForBounds(bounds, o);
	if (!c) return Promise.resolve();
	if (o.animate === false) { map.jumpTo(c); return Promise.resolve(); }
	return o.linear ? map.easeTo({ ...c, duration: o.duration }) : map.flyTo(c);
};
map.setPadding = p => { camPadding = padOf(p ?? 0); return map; };
map.getPadding = () => ({ ...camPadding });
map.setMaxBounds = b => {
	if (b == null) camBounds = null;
	else { const v = Array.isArray(b[0]) ? [b[0][0], b[0][1], b[1][0], b[1][1]] : b; if (v.length >= 4 && v.every(Number.isFinite)) camBounds = [wrapLon(v[0]), v[1], wrapLon(v[2]), v[3]]; }
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
map.setCenter = c => map.jumpTo({ center: c });
map.setZoom = z => map.jumpTo({ zoom: z });
map.setPitch = p => map.jumpTo({ pitch: p });
map.setBearing = b => map.jumpTo({ bearing: b });
map.isMoving = () => flightCtl.active || moving;
map.stop = () => { flightCtl.cancel(); return map; };
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
// 同一フレームのオーバーレイ（#13・2026-09-20）：レンダーワーカー内で地球・注記と同じ rAF・同じ cam で描く自前 canvas。
// main の onFrame で描くと 1〜2 フレーム先行する（地球は worker の次の rAF）＝その根治。url＝worker が import() するモジュール
//（依存ゼロ・{ init(canvas, opts), message(data), frame(cam, camState, size) → true=続きが要る, destroy() }）。
// 戻り値＝{ post(data, transfer), onmessage, remove() }。post は worker 側で dirty を立てる＝描画要求を兼ねる。canvas は #c と #labels の間。
// モジュールには host（requestDraw/post）と、frame には api（project/projectH＝makeProjector/makeProjectorH と同じ規約・地形は worker で同期）が渡る。
const overlays = new Map();
map.overlay = (src, { name, opts, above = false } = {}) => {   // src＝URL（依存ゼロのモジュール・?url）か { builtin: "anno" }（render worker のバンドル内）。above＝注記の canvas より上に重ねる（覆う画像・2026-09-21）
	name ??= "ov" + (overlays.size + 1);
	if (overlays.has(name)) throw new Error(`overlay "${name}" already exists`);
	const cv = document.createElement("canvas");
	cv.className = "overlay-gl"; cv.dataset.overlay = name;
	cv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
	cv.width = size.w; cv.height = size.h;
	if (above) labelCanvas.after(cv); else mapEl.insertBefore(cv, labelCanvas);   // 既定＝注記の下（地震・衛星など）／above＝注記の上（UI 家具は後ろの DOM＝さらに上のまま）
	const off = cv.transferControlToOffscreen();
	wPost({ type: "overlayAdd", name, ...(typeof src === "string" ? { url: new URL(src, location.href).href } : { builtin: src?.builtin }), canvas: off, opts }, [off]);
	const h = {
		name, el: cv, onmessage: null,   // onmessage＝worker 側モジュールの host.post(data) を受ける口
		post: (data, transfer) => { if (overlays.get(name) === h) wPost({ type: "overlayMsg", name, data }, transfer); },
		remove() { if (overlays.get(name) !== h) return; overlays.delete(name); wPost({ type: "overlayRemove", name }); cv.remove(); },
	};
	overlays.set(name, h);
	return h;
};
// ★互換：map.overlay は 9/20（c246591a）まで「estat 小地域・geopbf オーバーレイ・選択マスク・identify の手綱」（上の overlay）だった。
// 同一フレーム overlay の関数で上書きした結果、census2020（bind.js の map.overlay.loadEstat/setIdentifyHandler、
// choropleth.js の setSelectionMask）が本番で起動に失敗していた（2026-09-23 実測）。関数のまま器のメソッドも載せる＝
// map.overlay(url)（quakes/anno）と map.overlay.loadEstat(...)（census2020）の両方が無傷。正式な別名は裁定待ち。
Object.assign(map.overlay, overlay);   // globe の器（setSelectionMask/setHoverOutline/loadOverlay/clearOverlay）。e-Stat の口は日本の install が map.estat と同名に足す
map.onGintClick = fn => { gint.clickHandler = fn; };
Object.defineProperty(map, "backend", { get: () => dbgHost.__backend ?? null, enumerable: true });   // "webgpu"|"webgl2"|null（frame1 前）
// 外来の標高タイル（#36）＝1 点の標高は main で DEM の最大ズームを直に読む（範囲外・無効は既定の標高へ）
let demMain = DEM0 ? createDemSource(DEM0) : null, demSpec = DEM0;
const demFirst = (lon, lat, fallback) => demMain ? demMain.height(lon, lat).then(v => (v === v ? v : fallback())).catch(fallback) : fallback();
map.getHeight = (lon, lat) => demFirst(lon, lat, () => getHeightP.then(f => f(lon, lat, cam.zoom, { wait: true }))).then(h => +h || 0);
// MapLibre 同名：setTerrain({ source: id|spec, exaggeration }) / setTerrain(null)。source＝raster-dem（tiles か TileJSON の url・encoding）。
// exaggeration は受け流す（地形は誇張しない＝本人の方針）。地形のセル（R01）と 1 点の標高の両方がこの DEM を見る
map.setTerrain = async t => {
	let sp = t?.source ?? null;
	if (typeof sp === "string") sp = mlSources.get(sp) ?? EXT?.ms.sources?.[sp] ?? null;
	if (t && !sp) throw new Error("setTerrain: raster-dem source not found");
	if (sp && !sp.tiles && sp.url) { const r = await resolveVectorSource(sp, EXT?.baseUrl || location.href, { fetchFn: (u, init) => requester.fetch(u, "Source", init) }); sp = { ...sp, tiles: r.tiles, minzoom: sp.minzoom ?? r.minzoom, maxzoom: sp.maxzoom ?? r.maxzoom, bounds: sp.bounds ?? r.bounds }; }
	if (t?.exaggeration && t.exaggeration !== 1) console.info("[terrain] exaggeration is ignored (terrain is drawn at true scale)");
	if (sp?.tiles) sp = { ...sp, tiles: sp.tiles.map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")) };
	demSpec = sp ? { tiles: sp.tiles, encoding: sp.encoding || "mapbox", tileSize: sp.tileSize, minzoom: sp.minzoom, maxzoom: sp.maxzoom, bounds: sp.bounds, dtm: !!sp.dtm, cellZoom: sp.cellZoom } : null;   // MapLibre の raster-dem の既定 encoding は mapbox
	demMain = demSpec ? createDemSource(demSpec) : null;
	wPost({ type: "set", cmd: "dem", data: demSpec });
	needsDraw = true;
	return map;
};
map.getTerrain = () => demSpec ? { source: demSpec, exaggeration: 1 } : null;   // ローダ着荷（数秒）を待ってから照会＝初期化中に 0 を返さない（旧＝未着 0。SDK ドッグフード 2026-09-10）。初期化失敗は reject
map.getZoom = () => cam.zoom;             // 現在ズーム（派生アプリのズーム連動 LOD＝集約⇄市区町村の層切替に）
// ── 画像タイル層（メルカトル XYZ ラスタ）＝v1 base.js/Layers の後継（2026-09-21）。本体は render worker（ortho-core/raster）。
// ここは台帳（id→spec/opts/info）と指示（rasterAdd/Remove/Set）・ローカル容器（gpkg/mbtiles）のプロバイダ worker・
// カタログ（地域パック rasters＝外から定義）と ?r= の同期。外から定義できる口＝三つ：地域パック（REGION.rasters）／
// URL（?xyz= ?pm= ?r=）／公開 API（map.raster.add＝自前契約の URL テンプレ・ラスタ PMTiles・MessagePort プロバイダ）。
const rasterReg = new Map();   // id → { spec, opts, info, error, worker, attrHTML, _res, _rej }
const rasterCbs = new Set();
const rasterStatWait = new Map(); let rasterStatSeq = 0;
const rasterChanged = () => { attrZone = null; needsDraw = true; for (const cb of rasterCbs) { try { cb(); } catch (e) { console.error("[raster] onChange", e); } } };
const imageAttrs = new Map();   // 四隅で貼った画像（覆う＝オーバーレイ）の出典 id → 消毒済み HTML（画像層の出典と同じ欄に並べる）
const rasterAttrHTML = () => [...rasterReg.values()].map(r => r.attrHTML).concat([...imageAttrs.values()]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("・");
const hostOf = u => { try { return new URL(String(u).replace(/^pmtiles:\/\//, "")).host; } catch { return null; } };
function onRasterInfo(id, info) {
	const rec = rasterReg.get(id); if (!rec) return;
	rec.info = info;
	// 出典＝ソースの自己申告（PMTiles/MBTiles の metadata・カタログの宣言）を消毒して出す。無ければホスト名（無出典で他人の絵を出さない）
	rec.attrHTML = info?.attribution ? sanitizeHTML(String(info.attribution)) : (rec.spec?.url ? hostOf(rec.spec.url) : rec.spec?.pmtiles ? hostOf(rec.spec.pmtiles) : (info?.name ? sanitizeHTML(String(info.name)) : null));
	rec._res?.(info); rec._res = rec._rej = null;
	rasterChanged();
}
function onRasterError(id, error) {
	const rec = rasterReg.get(id); if (!rec) return;
	rec.error = error;
	if (rec._rej) { rasterReg.delete(id); rec.worker?.terminate(); rec._rej(new Error(error)); rec._res = rec._rej = null; rasterChanged(); }
	else console.warn("[raster]", id, error);
}
const catalogSpec = c => ({ url: c.url, tileSize: c.tileSize || 256, minZoom: c.minZoom, maxZoom: c.maxZoom, bbox: c.bbox || null, subdomains: c.subdomains, tms: c.tms,
	name: c.key ? t(c.key) : (c.name || c.id),
	attribution: c.attribution ? (c.attribution.href ? `<a href="${c.attribution.href}" target="_blank" rel="noopener">${c.attribution.key ? t(c.attribution.key) : c.attribution.text}</a>` : (c.attribution.key ? t(c.attribution.key) : c.attribution.text)) : null });
// ?r=<id,id…>＝今の選択（基図＋重ね）を URL の search に写す（hash＝視点とは別の静的パラメータ）。埋め込み（target）ではホストの URL に触れない
const rasterSyncURL = () => {
	if (opts.target) return;
	try {
		const sel = map.raster.selected(), ids = [sel.base, ...sel.overs].filter(Boolean);
		const u = new URL(location.href);
		if (ids.length) u.searchParams.set("r", ids.join(",")); else u.searchParams.delete("r");
		if (u.href !== location.href) history.replaceState(history.state, "", u.href);
	} catch { /* 履歴 API 不可の環境＝無害 */ }
};
// 独自スキームの画像タイル（addProtocol・#37）＝port プロバイダの契約（raster-src.js）で main から画像を渡す：
// info を 1 通 → 要求 { id, z, x, y } に読み口で本体を取り、ImageBitmap にして返す（transfer）。中断 { id, abort } は読み口の AbortController へ
function serveProtocolRaster(port, tpl, spec) {
	const acs = new Map();
	const subs = typeof spec.subdomains === "string" ? spec.subdomains.split("") : spec.subdomains || null;
	port.postMessage({ type: "info", info: { tileSize: spec.tileSize || 256, minZoom: spec.minZoom ?? 0, maxZoom: spec.maxZoom ?? 18, bbox: spec.bbox || null, attribution: spec.attribution || null, name: spec.name || null } });
	port.onmessage = async e => {
		const { id, z, x, y, abort } = e.data || {};
		if (abort) { acs.get(id)?.abort(); acs.delete(id); return; }
		const ac = new AbortController(); acs.set(id, ac);
		try {
			const rq = requester.resolve(expandTemplate(tpl, z, x, y, subs, !!spec.tms, spec.matrixIds, spec.tileSize || 256), "Tile");
			const ab = rq.load ? await rq.load("arrayBuffer", ac) : await (await requester.fetch(rq.url, "Tile", { signal: ac.signal })).arrayBuffer();
			const bitmap = ab.byteLength ? await createImageBitmap(new Blob([ab]), { premultiplyAlpha: "none", colorSpaceConversion: "none" }) : null;
			port.postMessage({ id, bitmap }, bitmap ? [bitmap] : []);
		} catch (err) { if (!ac.signal.aborted) port.postMessage({ id, bitmap: null, error: String(err?.message || err) }); }
		finally { acs.delete(id); }
	};
}
map.raster = {
	catalog: REGION_RASTERS,
	// add(id, spec, opts)：spec＝{ url:"…/{z}/{x}/{y}.png", minZoom, maxZoom, bbox, attribution, subdomains, tms, headers }｜{ pmtiles:"…" }｜{ file: File(.gpkg/.mbtiles), table? }｜{ port: MessagePort }
	//                     ｜{ image: Blob|ImageBitmap, corners: [[lon,lat]×4 左上→右上→右下→左下], name? }（四隅で貼る＝MapLibre の image source 相当・2026-09-21）
	//                     opts＝{ order:"under"|"over", opacity, visible, hideFills（under 既定 true）, minZoom, maxZoom（表示域） }。戻り＝ソースの自己申告（info）
	async add(id, spec, o = {}) {
		if (rasterReg.has(id)) map.raster.remove(id);
		const rec = { spec, opts: { ...o }, info: null, error: null, worker: null, attrHTML: null, _res: null, _rej: null };
		rasterReg.set(id, rec);
		let wireSpec = spec, transfer = spec && spec.port ? [spec.port] : [];   // 外部プロバイダ（MessagePort）＝そのまま render worker へ transfer
		// 取得の前の手入れ（#37）：URL の型紙は worker が組む＝ヘッダ/credentials はソース単位で一度だけ決める。独自スキーム＝main が読み口で取って port で渡す
		if (spec && (spec.url || spec.wms) && !spec.pmtiles && !/\.pmtiles(\?|#|$)|^pmtiles:/i.test(spec.url || "")) {
			const tpl = spec.url || wmsTemplate(spec.wms), rq = requester.resolve(tpl, "Tile");
			if (rq.load) { const ch = new MessageChannel(); serveProtocolRaster(ch.port1, rq.url, spec); wireSpec = { port: ch.port2, name: spec.name || null, attribution: spec.attribution || null }; transfer = [ch.port2]; rec.port = ch.port1; }
			else if (rq.url !== tpl || rq.headers || rq.credentials) wireSpec = { ...spec, wms: undefined, url: rq.url, headers: rq.headers ? { ...(spec.headers || {}), ...rq.headers } : spec.headers, credentials: rq.credentials ?? spec.credentials };
		}
		if (spec && (spec.file || spec.image)) {   // ローカル容器／四隅で貼る画像＝プロバイダ worker（main 所有・入れ子 worker 禁止）→ port を render worker へ＝タイルは worker→worker
			const w = spec.image
				? new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "imagequad" })   // 四隅の画像＝射影変換でタイルに焼く（imagequad-worker.js）
				: new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "rastertiles" });
			rec.worker = w;
			const ch = new MessageChannel();
			const opened = new Promise((res, rej) => {
				w.onmessage = e => { const d = e.data || {}; if (d.type === "opened") res(d.info); else if (d.type === "error") rej(Object.assign(new Error(d.error), { vectorLayers: d.vectorLayers })); };
				w.onerror = e => rej(new Error(e.message || "raster provider worker error"));
			});
			if (spec.image) w.postMessage({ type: "open", image: spec.image, corners: spec.corners, name: spec.name || null, attribution: spec.attribution || null, maxSide: LOW_MEM ? 2048 : 4096, port: ch.port1 }, [ch.port1]);   // 省メモリ機＝長辺 2048（RGBA＋ミップ ≈21MB・4096 だと ≈85MB＝Air3 jetsam の轍）
			else w.postMessage({ type: "open", file: spec.file, table: spec.table || null, port: ch.port1 }, [ch.port1]);
			try { await opened; } catch (err) { w.terminate(); if (rasterReg.get(id) === rec) rasterReg.delete(id); throw err; }
			if (rasterReg.get(id) !== rec) { w.terminate(); throw new Error("removed while opening"); }
			wireSpec = { port: ch.port2, name: spec.name || spec.file?.name || "image", attribution: spec.attribution || null }; transfer = [ch.port2];
		}
		const done = new Promise((res, rej) => { rec._res = res; rec._rej = rej; });
		wPost({ type: "set", cmd: "rasterAdd", prop: id, data: { spec: wireSpec, opts: rec.opts } }, transfer);
		rasterChanged();
		return done;
	},
	remove(id) { const rec = rasterReg.get(id); if (!rec) return false; rasterReg.delete(id); rec.worker?.terminate(); rec.port?.close(); rec._rej?.(new Error("removed")); wPost({ type: "set", cmd: "rasterRemove", prop: id }); rasterChanged(); return true; },
	set(id, o) { const rec = rasterReg.get(id); if (!rec) return false; Object.assign(rec.opts, o); wPost({ type: "set", cmd: "rasterSet", prop: id, data: o }); rasterChanged(); return true; },
	list: () => [...rasterReg].map(([id, r]) => ({ id, info: r.info, spec: r.spec, opts: r.opts, error: r.error })),
	info: id => rasterReg.get(id)?.info ?? null,
	stats: () => new Promise(res => { const sid = ++rasterStatSeq; rasterStatWait.set(sid, res); wPost({ type: "rasterStats", id: sid }); setTimeout(() => { if (rasterStatWait.delete(sid)) res(null); }, 5000); }),
	onChange(cb) { rasterCbs.add(cb); return () => rasterCbs.delete(cb); },
	// カタログ（地域パック）から：基図（under）はラジオ＝1 枚（null＝ベクタ地図に戻す）／重ね（over）はトグル。?r= を同期
	async select(cid) {
		const c = cid ? REGION_RASTERS.find(x => x.id === cid && (x.order || "under") !== "over") : null;
		if (cid && !c) throw new Error(`raster: unknown base "${cid}"`);
		if (!c) { map.raster.remove("base"); rasterSyncURL(); return null; }
		const info = await map.raster.add("base", catalogSpec(c), { order: "under", opacity: c.opacity ?? 1, hideFills: true, catalogId: c.id });
		rasterSyncURL(); return info;
	},
	async toggle(cid, on) {
		const c = REGION_RASTERS.find(x => x.id === cid && x.order === "over");
		if (!c) throw new Error(`raster: unknown overlay "${cid}"`);
		const id = "ov:" + c.id, has = rasterReg.has(id), want = on == null ? !has : !!on;
		if (want === has) return has;
		if (want) await map.raster.add(id, catalogSpec(c), { order: "over", opacity: c.opacity ?? 0.7, hideFills: false, catalogId: c.id }); else map.raster.remove(id);
		rasterSyncURL(); return want;
	},
	selected: () => ({ base: rasterReg.get("base")?.opts?.catalogId ?? null, overs: [...rasterReg].filter(([id]) => id.startsWith("ov:")).map(([, r]) => r.opts.catalogId).filter(Boolean) }),
};
{	// 起動待ち行列の解放＝初フレーム後（render worker 初期化前の set は捨てられる）
	const off = map.onFrame(() => { off(); rasterBoot = fn => fn(); for (const fn of rasterBootQ.splice(0)) fn(); });
}
// ガジェットの表示宣言（プラットフォームの掟 2026-09-03「アイコン配列は全zで一本」）：搭載時 opts に
//   zoom: [zmin, zmax)  … このズーム域でだけ表示（旧・solar の showBelow 内蔵と z5 一括退場CSSの置き換え）
//   narrow: false       … 狭画面（narrowMq=480px＝#pos の狭画面掟と同じ境界）では出さない（左上溢れ対策）
// を添えると、その搭載でスタック(#gadgets)へ生えた要素をプラットフォームが裁く（圏外は display:none＝
// スタックは上詰め・並び順不変）。ガジェット自身は zoom も画面幅も知らない＝定義がシンプルに保たれる。
// 契約：同期でスタックへ生やすガジェットに効く。自前で display を裁くガジェット（compass の3D限定等）に併用しない。
const gadgetGates = [];
const applyGadgetGate = g => {
	const on = cam.zoom >= g.min && cam.zoom < g.max && !(g.hideNarrow && narrowMq.matches);
	if (on !== g.on) { g.on = on; g.el.style.display = on ? "" : "none"; }
};
frameHooks.add(() => gadgetGates.forEach(applyGadgetGate));   // 圏の出入りは動いた時にしか起きない＝render のフックで足りる
narrowMq.addEventListener("change", () => { gadgetGates.forEach(applyGadgetGate); needsDraw = true; }, { signal: ac.signal });   // 回転・窓リサイズの跨ぎは即応（静止中でも）
map.gadget = function (name, func) {
	typeof name == "function" && name.name && (func = name, name = func.name);
	map.gadget[name] = function (opts) {
		const st = mapEl.querySelector("#gadgets"), before = st && new Set(st.children);
		const ret = func.apply(map, arguments);
		const zr = opts?.zoom, hideNarrow = opts?.narrow === false;
		if (zr || hideNarrow) {
			const now = mapEl.querySelector("#gadgets");
			const added = now ? [...now.children].filter(el => !before?.has(el)) : [];
			if (!added.length) console.warn(`[gadget] ${name}: display declaration (zoom/narrow) but no stack element appeared synchronously (gate not bound)`);
			for (const el of added) { const g = { el, min: zr?.[0] ?? -Infinity, max: zr?.[1] ?? Infinity, hideNarrow, on: null }; gadgetGates.push(g); applyGadgetGate(g); }   // 搭載した瞬間から現状態で裁く（コンパスの update() 即呼びと同じ作法）
		}
		return ret;
	};
};
map.gadget("search", function (opts) {   // 地名・住所検索 … map.gadget.search({ onGo? })。destroy用のsignalはここで注入
	return searchGadget.call(this, { provider: REGION_SEARCH, signal: ac.signal, ...opts });
});
map.gadget("hint", function (opts) {   // 操作説明カード … map.gadget.hint() → { open, close }。キー(?)用に signal を注入
	const h = hintGadget.call(this, { signal: ac.signal, onOpen: () => toolOpen("hint"), ...opts });
	if (h) toolClose.set("hint", () => h.close(false));   // 道具に場所を譲る＝記憶には書かない（次の起動で初見の人にはまた開く）
	return h;
});
map.gadget("compass", function (opts) {   // コンパス兼リセット … 内部の手綱（フライト中断・onMove）はここで注入
	const update = compassGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, signal: ac.signal, ...opts });
	if (update) { frameHooks.add(update); update(); }   // 針の追従を render のフックへ＝搭載した瞬間から現姿勢を指す
});
map.gadget("equal", function (opts) {   // 全球図（ortho-equal・Equal Earth）への口＝球のフレームから開く受け渡し（?morph=1）。右クリック項目は map.gadget.equalHere()
	return equalGadget.call(this, opts);
});
map.gadget("equalHere", function (opts) { return equalHereItem(this, opts); });   // 右クリックメニューの項目＝contextmenu の setter へ渡す材料
map.gadget("equalStart", function (opts) { return goEqual(this, { morph: false, ...opts }); });   // 入口＝Equal Earth を最初から上に（?start=equal）。japan は裏で起動
map.gadget("solar", function (opts) {   // 太陽系への口（ortho-solar）＝34px規格アイコン。表示域を絞るなら搭載側で opts.zoom
	return solarGadget.call(this, opts);
});
map.gadget("mesh", function (opts) {   // 建物3Dデータ管理 … モーダルを開く手綱と地域のアイコンはここで注入
	if (!meshOn) { console.warn("[mesh] opts.mesh=false = feature disabled; gadget not mounted"); return; }
	return meshGadget.call(this, { onOpen: meshMgr.openDb, icon: REGION_BLD_ICON, ...opts });
});
map.gadget("plateau", function (opts) { return map.gadget.mesh.call(this, opts); });   // 旧名（1.1.0 まで）＝非推奨の別名
map.gadget("palette", function (opts) {   // 配色テーマ・ピッカー … 現在テーマ(見本から除く)と切替(switchTheme=c=差替+reload)と撮影(見本=今の視点の実写)を注入
	if (themeFixed) { console.warn("[palette] opts.theme is baked in = c= cannot override; gadget not mounted"); return; }
	return paletteGadget.call(this, { current: themeName, onPick: name => { switchTheme(name); saveView(); }, requestSnapshot, getZoom: () => cam.zoom, getCurrent: () => themeName, signal: ac.signal, ...opts });   // pick=テーマ生き替え→URL即書込（switchThemeはURLを書かない＝ここで saveView）
});
map.gadget("zoom", function (opts) {   // ズーム＋/− … フライト中断・onMove・z範囲はここで注入
	// zoomMin はカメラ実床（太陽系圏込み）＝ズームボタンでも太陽系の底まで降りられる（旧床2の取り残し解消 2026-08-10）
	return zoomGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, zoomMin: () => zoomMinCur, zoomMax: ZOOM_MAX, signal: ac.signal, ...opts });   // 床は関数＝編集中の z2.5 に追随
});
map.gadget("full", function (opts) {   // 全画面トグル … destroy用のsignalはここで注入
	return fullGadget.call(this, { signal: ac.signal, ...opts });
});
map.gadget("cpos", function (opts) {   // 現在地（GPS） … マーカー追随の座標ブリッジを注入し update を render のフックへ
	const update = cposGadget.call(this, { projectLL, signal: ac.signal, ...opts });
	if (update) { frameHooks.add(update); update(); }
});
map.gadget("contextmenu", function (opts) {   // 右クリックメニュー … 逆投影と destroy用signalを注入。戻り値＝項目差し替えの setter
	return contextmenuGadget.call(this, { unprojectAt, signal: ac.signal, ...opts });
});
map.gadget("tip", function (opts) {   // カーソル追従の吹き出し … destroy用signalを注入。戻り値＝内容の setter
	return tipGadget.call(this, { signal: ac.signal, ...opts });
});
map.gadget("pop", function (opts) {   // 地点に紐づく吹き出し … 座標ブリッジを注入し _update を render のフックへ。戻り値＝pop 関数
	const p = popGadget.call(this, { projectLL, signal: ac.signal, ...opts });
	if (p && p._update) { frameHooks.add(p._update); p._update(); }
	return p;
});
map.gadget("explain", function (opts) { return explainGadget.call(this, opts); });   // 上辺の説明パネル … 戻り値＝内容の setter
map.gadget("legend", function (opts) { return legendGadget.call(this, opts); });     // 左下の凡例パネル … 戻り値＝内容の setter
map.gadget("measure", function (opts) {   // 距離・面積の計測 … 投影/逆投影とクリック横取りの手綱を注入。本体は初回クリック/Mで import()＝frame hook は onBody で本体到着後に配線
	return measureGadget.call(this, {
		makeProjector, unprojectXY, signal: ac.signal,
		setClick: fn => { measureClick = fn; fn && toolOpen("measure"); },   // 計測ON＝他の道具OFF（排他）
		requestDraw: () => { needsDraw = true; },
		onBody: m => { measureBody = m; if (m && m._update) { frameHooks.add(m._update); m._update(); } },   // 抽象アクセス：本体(measure.js)到着後に _update を毎フレ描画へ（frameHooks は core 側）
		...opts,
	});
});
map.gadget("profile", function (opts) {   // 断面図 … 投影/逆投影・クリック横取り・標高サンプラを注入。本体は初回クリックで import()
	return profileGadget.call(this, {
		makeProjector, unprojectXY, signal: ac.signal,
		setClick: fn => { profileClick = fn; fn && toolOpen("profile"); },   // 断面図ON＝他の道具OFF（排他）
		// 標高サンプラ＝zoom=99 固定で最良解像度（日本=R01 DEM10B 10m・海外=ALOS/GEBCOへ自動フォールバック）。
		// getHeightP 経由＝ローダ未着でも待って照会（map.getHeight の「未着=0m」縮退はグラフには不適）。
		sampleHeight: (lon, lat) => demFirst(lon, lat, () => getHeightP.then(f => (f ? f(lon, lat, 99) : 0))).then(h => +h || 0),   // 外来の DEM（#36）が先
		onBody: p => { profileBody = p; if (p && p._update) { frameHooks.add(p._update); p._update(); } },   // 抽象アクセス：本体到着後に _update を毎フレ描画へ（measure と同型）
		...opts,
	});
});
// ── 日影（#44・2026-09-23）＝建物の影を地面に描く。map.sunShadow({ mode:"duration"|"instant", date, planeH, hours, step, bbox, tilesets, probe:[[lon,lat]…] })
//   建物＝既定は地域の建物台帳（日本＝PLATEAU）・tilesets で任意の 3D Tiles。範囲＝既定は画面に見えている所（中心から一辺 3km まで）。
//   結果＝四隅の画像として地面に貼る（map.raster の "sunshadow"）。戻り＝stats（三角形数・最大の日影時間ほか）
let sunWorker = null, sunSeq = 0;
const sunWaiting = new Map();
map.sunShadow = async (o = {}) => {
	sunWorker ??= (() => { const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "model" }); w.onmessage = e => { const p = sunWaiting.get(e.data.id); if (!p) return; sunWaiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); }; return w; })();
	let bb = o.bbox || map.getBounds() || approxViewBbox(cam);
	const c = [cam.center[0], cam.center[1]], half = 1500 / 111320, hx = half / Math.max(0.2, Math.cos(c[1] * D2R));
	bb = [Math.max(bb[0], c[0] - hx), Math.max(bb[1], c[1] - half), Math.min(bb[2], c[0] + hx), Math.min(bb[3], c[1] + half)];   // 一辺 3km まで
	const opts = { mode: o.mode || "duration", date: (o.date instanceof Date ? o.date : o.date ? new Date(o.date) : new Date()).toISOString(), planeH: o.planeH ?? 4, hours: o.hours || [8, 16], step: o.step ?? 0.5, decl: o.decl, bbox: bb,
		tilesets: (o.tilesets || []).map(u => new URL(u, location.href).href), sets: o.tilesets ? [] : (meshMgr.sets || []).map(st => ({ base: st.base, bbox: st.bbox })), maxCells: LOW_MEM ? 512 * 512 : 1024 * 1024, probe: o.probe || null };
	const r = await new Promise((res, rej) => { const id = ++sunSeq; sunWaiting.set(id, { res, rej }); sunWorker.postMessage({ id, kind: "sunshadow", opts }); });
	const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba.buffer), r.w, r.h));
	const [w, s, e, n] = r.bbox;
	await map.raster.add("sunshadow", { image, corners: [[w, n], [e, n], [e, s], [w, s]], name: "sunshadow" }, { order: "over", opacity: 1, hideFills: false });
	return { ...r.stats, probes: r.probes };   // probes＝指定地点の日影時間（時）／瞬間は 0|1
};
// ── 建物の影（リアルタイム・2026-09-24）＝描画の中で太陽から建物の深度を描き、地面・建物に落とす（WebGPU 専用。
// GL2 はフォールバック＝影をかけない仕様（本人裁定 2026-09-24）＝GL レンダラは "shadow" を素通しする）。
// map.setShadows(true | false | { on, time: Date|ms|ISO, darkness: 0..1 })。time 無指定＝共通の時計（view.clock）。z13 以上・太陽が出ている時だけ。
// 消している間は描画に一切関与しない（資源も持たない）。
map.setShadows = (o = true) => {
	const v = typeof o === "object" && o ? { ...o, on: o.on !== false } : { on: !!o };
	if (v.time != null) v.time = v.time instanceof Date ? +v.time : typeof v.time === "string" ? Date.parse(v.time) : +v.time;
	renderer.set("shadow", v); needsDraw = true; onMove();
};
dbgHost.__shadow = o => map.setShadows(o);   // 検証窓（t-shadow・実機の切り分け）
// ── 可視域と見通し線（#44・2026-09-23）──────────────────────────────────────
// map.viewshed({ observer:[lon,lat], eyeH:1.6, targetH:0, radius:1000(m), buildings:true, tilesets? , probe? })＝見える所（緑）と見えない所を地面に貼る（map.raster の "viewshed"）
// map.lineOfSight(a, b, { eyeH, targetH, buildings })＝視点 a→目標 b。見えるか・遮る最初の点・断面（距離・地表・視線）。線を地図に引く（見える区間＝緑・遮られた先＝赤）
// 地表＝render worker の地形のセル（外来 DEM の上書き込み）を升目で・建物＝地域の建物台帳（PLATEAU）か任意の 3D Tiles（日影と同じ読み方）
const elevGridWait = new Map(); let elevGridSeq = 0;
const elevGrid = (bbox, N) => new Promise(res => { const id = ++elevGridSeq; elevGridWait.set(id, res); wPost({ type: "elevGrid", id, bbox, N }); });
const sunCall = (kind, opts) => new Promise((res, rej) => {
	sunWorker ??= (() => { const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "model" }); w.onmessage = e => { const p = sunWaiting.get(e.data.id); if (!p) return; sunWaiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); }; return w; })();
	const id = ++sunSeq; sunWaiting.set(id, { res, rej }); sunWorker.postMessage({ id, kind, opts });
});
const visArea = async (center, radius, extra, o) => {
	const R = Math.min(5000, Math.max(50, radius)), dLat = R * 1.02 / 111320, dLon = dLat / Math.max(0.2, Math.cos(center[1] * D2R));
	const bbox = [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat];
	const N = Math.max(64, Math.min(LOW_MEM ? 384 : 768, Math.round(2 * R / (o.cell ?? 2))));
	const ground = await elevGrid(bbox, N);
	return sunCall("viewshed", { bbox, N, ground, eyeH: o.eyeH ?? 1.6, targetH: o.targetH ?? 0, radius: R, buildings: o.buildings !== false,
		tilesets: (o.tilesets || []).map(u => new URL(u, location.href).href), sets: o.tilesets ? [] : (meshMgr.sets || []).map(st => ({ base: st.base, bbox: st.bbox })), ...extra });
};
map.viewshed = async (o = {}) => {
	const obs = o.observer ?? [cam.center[0], cam.center[1]];
	const r = await visArea(obs, o.radius ?? 1000, { observer: obs, probe: o.probe || null }, o);
	const image = await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba.buffer), r.w, r.h));
	const [w, s, e, n] = r.bbox;
	await map.raster.add("viewshed", { image, corners: [[w, n], [e, n], [e, s], [w, s]], name: "viewshed" }, { order: "over", opacity: 1, hideFills: false });
	return { ...r.stats, probes: r.probes };
};
map.lineOfSight = async (a, b, o = {}) => {
	const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], half = Math.hypot((b[0] - a[0]) * 111320 * Math.cos(mid[1] * D2R), (b[1] - a[1]) * 111320) / 2;
	const r = await visArea(mid, half + 60, { observer: a, los: b }, { ...o, cell: o.cell ?? Math.max(1, half / 300) });
	const L = r.los, cut = L.blockAt;
	const line = (c, from, to) => ({ type: "Feature", properties: { c }, geometry: { type: "LineString", coordinates: [from, to] } });
	const data = { type: "FeatureCollection", features: cut ? [line("ok", a, cut), line("ng", cut, b)] : [line("ok", a, b)] };
	if (map.getSource("los")) await map.getSource("los").setData(data);
	else { map.addSource("los", { type: "geojson", data }); await map.addLayer({ id: "los", type: "line", source: "los", paint: { "line-color": ["match", ["get", "c"], "ok", "#1faa55", "#d23c3c"], "line-width": 4 } }); }
	return { ...L, triangles: r.stats.triangles };
};
map.gadget("sunshadow", function (opts) {
	const h = sunShadowGadget.call(this, { run: o => map.sunShadow(o), clear: () => map.raster.remove("sunshadow"), live: o => map.setShadows(o), canLive: () => renderBackend === "webgpu", onOpen: () => toolOpen("sunshadow"), signal: ac.signal, ...opts });
	if (h?.close) toolClose.set("sunshadow", h.close);
	return h;
});
map.clearViewshed = async () => { map.raster.remove("viewshed"); if (map.getLayer("los")) { map.removeLayer("los"); map.removeSource("los"); } };
map.gadget("clock", function (opts) { return clockGadget.call(this, { signal: ac.signal, ...opts }); });
map.gadget("viewshed", function (opts) {
	const h = viewshedGadget.call(this, { run: { viewshed: o => map.viewshed(o), lineOfSight: (a, b, o) => map.lineOfSight(a, b, o), clear: () => map.clearViewshed() }, onOpen: () => toolOpen("viewshed"), signal: ac.signal, ...opts });
	if (h?.close) toolClose.set("viewshed", h.close);
	return h;
});
map.gadget("shot", function (opts) {   // 画面保存 … worker越しの3層+measure層を合成する requestSnapshot を注入
	return shotGadget.call(this, { requestSnapshot, signal: ac.signal, ...opts });
});
map.gadget("qr", function (opts) {   // 共有QR … 現在の共有URL(origin+path+search+viewHash＝今の視点)を注入＝スクリーン投影→スキャンでその視点を開く＝拡散
	// location.search を挟む＝アドレスバーの ?hud=1 等のフラグもQRに載る（スキャン先で同じ計器/条件が点く）。順は path→?query→#hash＝URLの正順。
	return qrGadget.call(this, { getUrl: () => location.origin + location.pathname + location.search + viewHash(), signal: ac.signal, ...opts });
});
map.gadget("home", function (opts) {   // 地域の全体へ戻る（真俯瞰・北向き）… 着地点は地域宣言の home（日本＝列島ビュー）・J キー
	if (!REGION_HOME) return null;   // 戻り先を宣言しない地域（/nl/・地球儀）＝ボタンを出さない
	return homeGadget.call(this, { view: REGION_HOME.view, icon: REGION_HOME.icon, label: REGION_HOME.label, id: REGION_HOME.id, signal: ac.signal, ...opts });
});
map.gadget("japan", function (opts) { return map.gadget.home.call(this, opts); });   // 旧名（1.1.0 まで）＝非推奨の別名
map.gadget("print", function (opts) {   // 印刷（平面図）… 撮影ハイジャック printCapture を注入。プレビュー→印刷/PDF。本体は初回起動時import()
	return printGadget.call(this, { capture: printCapture, signal: ac.signal, ...opts });
});
map.gadget("close", function (opts) {   // 閉じる×（埋め込み用）… ortho:close を飛ばすだけ＝閉じる実務は埋め込み側
	return closeGadget.call(this, { signal: ac.signal, ...opts });
});
// POI台帳の手差分編集（§12）＝?poiedit=1 のときだけ本体を import して搭載＝一般ビルドの死荷重ゼロ（作者用・
// 書込は bucket API key 保持者のみ）。注入＝抽象アクセス：台帳フィード getPOI（パッチ適用済＝表示と同じ景色から
// 対象を選ぶ）・手差分の読み書き getOvr/setOvr（保存成功→差し替え→poiVer++＝ラベルのみ再構築で即反映）・座標ブリッジ。
if (poi && /[?&]poiedit=1/.test(location.search)) poi.ready().then(() => import("./gadgets/poiedit.js")).then(({ poiedit }) => {
	setLayer("facility", true);   // 編集の舞台＝施設層を正規経路で自動点灯（チップ不在の埋め込みでも効く）
	map.gadget("poiedit", function (opts) {
		const L = poiReal;   // ?poiedit=1 は下で poi.ready() を待ってから搭載＝ここでは必ず本物
		return poiedit.call(this, {
			// クリックは createInput の onClick 横取り（measure と同型）＝ドラッグ弁別は input.js が正本・
			// armed中の選択クリックが識別/星座へ素通りしない。座標は unprojectXY/makeProjector と同じ canvas CSS系。
			setClick: fn => { poiClick = fn; }, unprojectXY, makeProjector, distM: L.distM,
			apiBase: L.apiBase, name: L.ovrName,
			getPOI: () => L.patchedAll(), getOvr: L.getOvr,
			setOvr: L.setOvr,
			signal: ac.signal, ...opts,
		});
	});
	map.gadget.poiedit();
}).catch(e => console.error("[poiedit] load failed", e));
// ── 共有シーン台本(type:"scenes")の再生 ── 落とした .scenes（または ?scene=URL）を demo プレーヤーで自動上演する（demo/scene-format.md）。
// demo は起動時に1度マウント済み（index.html）＝その1インスタンスに load() で台本を差し替える（下の demo ラッパが手綱 demoHandle を掴む）。
// --- シーン再生＝scenes/player.js（上映・停止・タイムライン・黒幕・フェード・待ちパネル）。ここは配線だけ＝app の状態は getter、関数はラップ。
const scenes = createScenePlayer({ mapEl, LOW_MEM, gpuBackend, meshOn, meshMgr, flightCtl, CAM_ZOOM_MIN, themeFixed,
	get themeName() { return themeName; }, get elevBusy() { return elevBusy; },
	onMove: () => onMove(), flyView: (...args) => flyView(...args), applyCamView: v => applyCamView(v), applyViewLayers: v => applyViewLayers(v), switchTheme: n => switchTheme(n), viewHash: () => viewHash(), saveView: () => saveView() });
// ?scene=<URL>＝共有シーン台本の URL ロード（ドロップと同じ道＝取得→type 判定→playScene）。相対URL可（同梱サンプル等）。
// gzip（.scenes.gz や gzip 中身）も可＝中身の印(1f 8b)で判定して解凍（サーバが Content-Encoding で解く場合は素通り）。
// demo ガジェットは index.html が少し遅れて搭載する＝居るまで小さく待つ（最大10秒・居なければ諦めて警告）。
// 外部 URL の門（?g= / ?scene= 共用）：gh:user/repo[@ref]/path 短縮形→GitHub raw・https 限定（開発時のみ localhost の http 可）・
// ".." で別リポジトリへ滑るのを封じる。相対 URL は同一オリジン（同梱サンプル等）。通らなければ null（console.warn 済み）。
const remoteUrl = (spec, tag) => {
	const gh = /^gh:([\w.-]+)\/([\w.-]+)(?:@([\w.-]+))?\/(.+)$/.exec(spec);   // ref に / は不可（path との曖昧を避ける）
	if (gh && [gh[1], gh[2], gh[3] || "", ...gh[4].split("/")].some(x => x === "." || x === "..")) { console.warn(`[${tag}] bad gh: path`, spec); return null; }
	let u;
	try { u = new URL(gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3] || "HEAD"}/${gh[4]}` : spec, location.href); }
	catch { console.warn(`[${tag}] bad URL`, spec); return null; }
	const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) { console.warn(`[${tag}] https only`, u.href); return null; }
	return u;
};
{
	const sceneSpec = new URLSearchParams(location.search).get("scene");
	const sceneUrl = sceneSpec ? remoteUrl(sceneSpec, "scene") : null;   // ?g= と同じ門（https 限定・gh: 短縮形・credentials 無し）
	if (sceneUrl) fetch(sceneUrl, { credentials: "omit" }).then(async r => {
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const buf = new Uint8Array(await r.arrayBuffer());
		if (buf.byteLength > 8e6) throw new Error("too large");   // 台本は JSON＝8MB で十分（敵入力の巨大確保よけ）
		return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b) ? await gunzipText(buf) : new TextDecoder().decode(buf));
	}).then(obj => {
		if (obj?.type !== "scenes") { console.warn(`[scene] type is not "scenes" = not playing`, sceneUrl); return; }
		const arm = tries => scenes.demoHandle ? scenes.playScene(obj) : (tries < 100 ? setTimeout(() => arm(tries + 1), 100) : console.warn("[scene] demo never mounted = gave up on ?scene="));
		arm(0);
	}).catch(err => console.warn("[scene] failed to fetch ?scene=", sceneUrl, err));
}
// ?at=lon,lat[,heading[,scale]]＝?g= の glb/gltf をどこに置くか（3D 模型は地理座標を持たない。省略＝画面中心）。他形式は読まない
const modelAt = () => { const v = (new URLSearchParams(location.search).get("at") || "").split(",").map(Number); return Number.isFinite(v[0]) && Number.isFinite(v[1]) ? { at: [v[0], v[1]], heading: v[2] || 0, scale: v[3] || 1 } : {}; };
// ?g=<URL>＝GeoPBF の URL ロード（ドロップと同じ一本道＝取得→loadUserFile）。gh:user/repo[@ref]/path 短縮形は
// GitHub raw へ展開（ref 省略=HEAD・コミットSHA固定も可）。https 限定（開発時のみ localhost の http 可）・
// credentials 無し＝他人の置き場を読むだけの姿勢。読めたら出所（ホスト名）を出典 #attr へ常時表示＝
// 他人の作品を当ドメインで再生する時の看板（docs/geopbf §11 の作法とセット）。
{
	const gSpec = new URLSearchParams(location.search).get("g");
	const u = gSpec ? remoteUrl(gSpec, "g") : null;   // 門は ?scene= と共用（remoteUrl）
	if (u) (async () => {
		try {
			const name = decodeURIComponent(u.pathname.split("/").pop() || "") || "map.geopbf";
			let pbf;
			if (/\.(parquet|geoparquet)$/i.test(u.pathname)) {   // GeoParquet＝footer だけ読んで大きさで振り分け（Range 非対応 host は全量が既に手元＝従来経路）
				const { openParquet } = await import("geopbf/parquet");
				const pq = await openParquet(u.href);
				if (pq.source.size > PARQUET_STREAM_BYTES && !pq.source.wholeFile) { await parquetView(u.href, name); pbf = { length: parquetCtl?.rows }; }
				else pbf = await loadUserFile(new File([await pq.source.read(0, pq.source.size)], name));
			} else {
				const r = await fetch(u, { credentials: "omit" });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				if (+r.headers.get("content-length") > 256e6) throw new Error("too large");   // 正気上限（敵入力の巨大確保よけ・GitHub raw は 100MB 上限）
				pbf = await loadUserFile(new File([await r.blob()], name), { ...modelAt(), fit: !themeBootV });   // URL に視点（#…）があればそれが勝つ＝寄せない（共有した傾き・画角を保つ・2026-09-21）
			}
			if (!pbf) return console.warn("[g] decode failed", u.href);
			const attr = document.querySelector("#attr");   // 出所の常時表示（instruments 非搭載ページは console のみ）
			if (attr && !attr.querySelector(".g-src")) {
				const line = document.createElement("div");
				line.className = "g-src";
				line.textContent = tr()("Map data: $1", u.host);
				attr.append(line);
			}
			console.info("[g] loaded", u.href, `${pbf.length ?? "?"} features`);
		} catch (err) { console.warn("[g] failed to fetch ?g=", u.href, err); }
	})();
}
// GeoParquet の視野追従（部分読み）＝閾値を超えるファイルは全量変換せず、視野の row group だけ Range で読んで描く（本体は遅延chunk）。
// 閾値以下は従来の全量経路（INTAKE geoparquet → fromGeoParquet → gint）。本人裁定 2026-09-20：8MB・属性は列のまま。
const PARQUET_STREAM_BYTES = 8e6;
let parquetCtl = null;
const parquetView = async (src, name) => {
	annoCtl?.clear(); gint.clearUserGint(); parquetCtl?.destroy(); parquetCtl = null;
	const m = await import("./gadgets/parquet-view.js");
	const color = new URLSearchParams(location.search).get("color");   // ?color=<数値列>＝色分けの初期列（状況表示の select でも替えられる）
	try { parquetCtl = await m.createParquetView(map, src, { name, color, signal: ac.signal }); }
	catch (err) {   // 文面は gadget の t()（トーストへ）。zstd＝小さいファイルの経路（INTAKE geoparquet）と同じ文言で言い換える
		console.error("[parquet] view failed", name, err);
		if (/zstd/i.test(err?.message || "")) throw new Error(tr()("zstd-compressed GeoParquet cannot be read in a browser (re-write it with gzip or snappy)."));
		throw err;
	}
	dbgHost.__parquet = parquetCtl;   // dev の検証窓（loaded/deferred/pq）
	return { length: parquetCtl.rows };   // dropFile のトースト用（地物数の代わりに行数）
};
// 注釈レイヤ（geoedit の @スタイル付き geopbf を canvas2D で再生・単一スロット）＝本体は遅延chunk（起動を重くしない）
let annoCtl = null;
map.gadget("anno", async function (pbf) {
	const m = await import("./gadgets/anno.js");
	annoCtl ??= m.createAnno(map, { signal: ac.signal });
	annoCtl.set(pbf);
	return annoCtl;
});
// COG（Cloud Optimized GeoTIFF）＝geopbf/cog リーダ→cogTex スロット（GLOBE/TERRAIN FS がドレープ）。本体は遅延chunk。
// setCogTex は wPost 直（transfer 付き＝2048²RGBA 16MB の structured clone コピーを回避）
let cogCtl = null;
map.gadget("cog", async function (src, opts) {
	const m = await import("./gadgets/cog.js");
	cogCtl ??= m.createCog(map, {
		setCogTex: d => wPost({ type: "set", cmd: "cogTex", data: d, prop: null }, d?.rgba?.buffer ? [d.rgba.buffer] : []),
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
map.gadget("raster", function (o) {   // 画像タイル（ラスタ）の切替＝地域パックのカタログ＋map.raster（select/toggle）。表示域は搭載側の zoom 宣言
	return rasterGadget.call(this, { raster: map.raster, catalog: REGION_RASTERS, signal: ac.signal, ...o });
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
const spotFeature = async src => {
	if (!src) return null;
	if (src.type === "FeatureCollection") {   // 複数の面＝1 枚の MultiPolygon に束ねる（マスクの扇は巻き数＝接する県境は相殺されない）
		const polys = [];
		for (const f of src.features || []) { const g = f?.geometry; if (g?.type === "Polygon") polys.push(g.coordinates); else if (g?.type === "MultiPolygon") polys.push(...g.coordinates); }
		return polys.length ? { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: polys } } : null;
	}
	if (src.type === "Feature") return src;
	if (src.type && src.coordinates) return { type: "Feature", properties: {}, geometry: src };
	const up = String(src).trim().toUpperCase();
	if (!up) return null;
	const pbf = await gint.ensureAdmin0().catch(e => { console.warn("[spotlight] admin0", e); return null; });
	const feats = pbf?.features || pbf?.geojson?.features || [];
	return feats.find(f => { const p = f?.properties || {}; return [p.ISO_A2, p.ISO_A3, p.ISO_A2_EH, p.ISO_A3_EH].some(v => v && String(v).toUpperCase() === up); }) || null;
};
const spotBbox = geom => {   // 渡された形の外接矩形（経度は跨ぎを解く＝日付変更線でも幅が正しい）
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, lon = null;
	const walk = c => { if (Array.isArray(c[0])) { c.forEach(walk); return; } lon = lon == null ? c[0] : c[0] + 360 * Math.round((lon - c[0]) / 360); if (lon < x0) x0 = lon; if (lon > x1) x1 = lon; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; };
	geom?.coordinates && walk(geom.coordinates);
	return x0 <= x1 ? [x0, y0, x1, y1] : null;
};
// src＝GeoJSON（Feature/FeatureCollection/Geometry）か ISO コード。null で解除。
// 戻り＝{ bbox, clear() }。fit＝外接矩形へ寄る（既定 true・寄り先を自分で決める呼び手は false）／pad＝余白／maxZoom＝寄りの上限。
map.gadget("spotlight", async function (src, { opacity = 0.55, fit: doFit = true, color = null, pad = 1.25, maxZoom = null } = {}) {
	if (src == null) { overlay.setSelectionMask(null); return null; }   // null＝解除
	const f = await spotFeature(src);
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
map.gadget("outline", async function (src, { color = null, width = 1.6 } = {}) {
	if (src == null) { overlay.setHoverOutline(null); return null; }
	const f = await spotFeature(src);
	if (!f?.geometry) return null;
	overlay.setHoverOutline(f.geometry, { color: color || undefined, width });
	return { clear: () => overlay.setHoverOutline(null) };
});
map.gadget("globe", function (o) {   // ミニ地球儀（右下・視野の枠・z≤8）… 追従は render のフック（戻り値 update を掴む）
	const u = globeGadget.call(this, { signal: ac.signal, ...o });
	if (u) { frameHooks.add(u); u(); }
	return u;
});
// glTF/GLB（3D 模型）＝PLATEAU と同じ建物メッシュとして立てる（gadgets/model.js・遅延chunk・2026-09-20）。落とした地点（無ければ画面中心）の ENU に置く／
// CESIUM_RTC・ECEF 入りの glb は埋め込みを信じる。描画は renderer の meshSet スロット（wPost 直・transfer）＝建物 3D と同じシェーダ。
let modelCtl = null;
const modelCtlGet = async () => {
	const m = await import("./gadgets/model.js");
	if (modelCtl) return modelCtl;
	modelCtl = dbgHost.__model = m.createModel(map, {   // __model＝検証窓（t-model・押し出し）
		setMesh: (name, data) => { wPost({ type: "set", cmd: "meshSet", data, prop: name }, data ? [...new Set([data.pos.buffer, data.nrm.buffer, data.idx.buffer, data.uv?.buffer, data.col?.buffer, data.tex?.bitmap, data.tex?.rgba?.buffer].filter(Boolean))] : []); needsDraw = true; },   // uv/頂点色/テクスチャ（ImageBitmap）も transfer
		fit: bb => {   // 模型へ寄る＝loadUserFile の fit と同じ視野幅逆解き。ただしチルト 55°（建物メッシュは真俯瞰 pitch<0.02 では描かない＝寄って何も無いを避ける）
			const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
			const wDeg = Math.max(2e-5, (bb[2] - bb[0]) * 2.5), hDeg = Math.max(2e-5, (bb[3] - bb[1]) * 2.5);
			const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
			flyTo(cx, cy, Math.max(3, Math.min(18, z)), 55);
		},
		center: () => [cam.center[0], cam.center[1]], ell: ELL_ON, signal: ac.signal,
	});
	return modelCtl;
};
map.gadget("model", async function (src, opts) {
	return (await modelCtlGet()).load(src, opts);
});
// 任意ポリゴンの 3D 押し出し（MapLibre の fill-extrusion 相当・2026-09-21）＝模型と同じ建物メッシュ経路（worker で earcut→finishMesh）。
//   src＝GeoJSON（Feature/FeatureCollection/features 配列）・GeoPBF（.geojson を持つもの）・File・URL。
//   opts＝{ height: 鍵名|数|(props)=>m（省略＝height/measuredHeight/高さ…を自動・階数×3m）, base, color: css|(props,h)=>css（省略＝@fill→段彩）,
//          scale（高さの倍率）, mask（足元の基図建物を伏せる・既定 "auto"＝建物らしい大きさの時だけ）, fit（寄る・既定 true・傾きは今のまま） }。
//   MapLibre の書き方もそのまま：opts に { type:"fill-extrusion", paint:{ "fill-extrusion-height"/"-base"/"-color"/"-opacity": 式 }, filter: 式 }、
//   または src に層を丸ごと（source:{ type:"geojson", data }）。式は基図と同じ評価器・色の interpolate も可・既定値は MapLibre の仕様どおり。null を渡すと外す。戻り値＝stats か null（立つ面なし）
map.gadget("extrude", async function (src, opts = {}) {
	const c = await modelCtlGet();
	if (src == null) { c.clearExtrude(opts.slot ?? "default"); return null; }   // slot＝addLayer の層 id（#34・既定 "default"＝ガジェット直呼びの 1 枠）
	// MapLibre の層を丸ごと（{ type:"fill-extrusion", source:{ type:"geojson", data }, paint, filter }）＝source.data を読み、層は opts へ
	if (src && src.type === "fill-extrusion" && !opts.paint) { const layer = src; src = layer.source?.data ?? layer.source; opts = { ...layer, ...opts }; delete opts.source; delete opts.id; }
	let gj = src;
	if (typeof src === "string" || src instanceof Blob) gj = (await geopbf(src, { gint: false }))?.geojson;
	else if (!src.type && !Array.isArray(src) && src.geojson) gj = src.geojson;
	const { fit: doFit = true, ...rest } = opts;
	const st = await c.extrude(gj, { zoom: cam.zoom, ...rest, fit: false });   // zoom＝式の ["zoom"]（評価は呼んだ時に一度＝ズーム追随は呼び直し。gint の paintTable と同じ約束）
	if (doFit && st?.bbox) {   // 寄る＝今の傾きのまま（押し出しでも傾けない＝本人裁定 9/21）
		const bb = st.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, wDeg = Math.max(2e-5, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(2e-5, (bb[3] - bb[1]) * 1.3);
		const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
		flyTo(cx, cy, Math.max(3, Math.min(18, z)), (cam.pitch || 0) * R2D, (cam.bearing || 0) * R2D);
	}
	return st;
});
// 衛星シーン検索（STAC＝Earth Search→選んだシーンの COG を球へ）。スタブ＝ボタンのみ常駐・本体は初回クリック
map.gadget("stac", function (opts) {
	return stacGadget.call(this, { loadCog: (src, o) => map.gadget.cog(src, o), clearCog: () => cogCtl?.clear(), signal: ac.signal, ...opts });
});
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
		if (u) { const tpl = u.href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"); const off = map.onFrame(() => { off(); map.raster.add("xyz", { url: tpl, name: u.host, minZoom: +q.get("xyzmin") || 0, maxZoom: +q.get("xyzmax") || 18 }, { order: "under", hideFills: true }).catch(err => console.warn("[xyz] failed", tpl, err)); }); }
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
let t3dCtl = null;
const t3dGet = async () => { const m = await import("./gadgets/tiles3d.js"); return t3dCtl ??= m.createTiles3D(map, {
	cam, size: () => size, dpr, lowMem: LOW_MEM, signal: ac.signal, requester,
	setMesh: (name, data) => { wPost({ type: "set", cmd: "meshSet", data, prop: name }, data ? [...new Set([data.pos.buffer, data.nrm.buffer, data.idx.buffer, data.uv?.buffer, data.col?.buffer, data.tex?.bitmap, data.tex?.rgba?.buffer].filter(Boolean))] : []); needsDraw = true; },
	meshVis: (ward, on) => { wPost({ type: "set", cmd: "meshVis", data: !!on, prop: ward }); needsDraw = true; },
}); };
map.gadget("tiles3d", async function (url, opts = {}) {
	const c = await t3dGet();
	if (url == null) { if (opts.id) c.remove(opts.id); else for (const id of c.ids) c.remove(id); return null; }
	return c.add(url, opts);
});
map.add3DTiles = (url, opts) => map.gadget.tiles3d(url, opts);
// I3S（ArcGIS の Indexed 3D Scene Layer・#48）＝同じ選び・同じ GPU 経路（gadgets/tiles3d.js の addI3S）。url＝…/SceneServer か …/SceneServer/layers/N
map.addI3S = async (url, opts) => (await t3dGet()).addI3S(url, opts);
map.Marker = Marker; map.Popup = Popup;
// 取得の前の手入れ（#37・MapLibre 同名）：setTransformRequest(fn)＝以後の取得に効く（すでに取った基図タイルは取り直さない）・addProtocol は大域（SDK の export と同じ）
map.setTransformRequest = fn => { requester.setTransform(fn); return map; };
map.addProtocol = addProtocol; map.removeProtocol = removeProtocol;
map.fetchResource = (url, type = "Unknown", init) => requester.fetch(url, type, init);   // 部品（記号帳・3D Tiles）が同じ手入れで取るための口   // new map.Marker().setLngLat(…).addTo(map)（import しなくても使える口）
{
	const q = new URLSearchParams(location.search), spec = q.get("tiles3d");
	const u = spec ? remoteUrl(spec, "tiles3d") : null;
	if (u) { const off = map.onFrame(() => { off(); map.gadget.tiles3d(u.href, { heightOffset: +q.get("t3dh") || 0, fit: !location.hash }).catch(err => console.warn("[tiles3d] ?tiles3d=", err)); }); }
	const iu = q.get("i3s") ? remoteUrl(q.get("i3s"), "i3s") : null;   // ?i3s=<SceneServer の URL>（門は ?g= と共用）
	if (iu) { const off = map.onFrame(() => { off(); map.addI3S(iu.href, { heightOffset: +q.get("t3dh") || 0, fit: !location.hash, ground: q.get("i3sground") || "absolute" }).catch(err => console.warn("[i3s] ?i3s=", err)); }); }
}
// @スタイルの見分け＝geopbf のキー表に @属性 があるか（描画系の @キーだけ見る＝他レイヤの誤検知を避ける）
const ANNO_KEYS = new Set(["@shape", "@icon", "@text", "@size", "@fill", "@stroke", "@width", "@tip", "@pop", "@spline", "@blur", "@poly", "@start", "@end", "@cap0", "@cap1", "@cap"]);
// ファイル取り込みの一本道（D&D と ?g= の共用）＝geopbf(File,{gint:true})→ @検知で anno 再生 or applyGintData→bboxへ球面フライト
// ── 取り込みの表（載せる口）─────────────────────────────────────────────────
// 形式ごとに1行。行の型は二つだけ：
//   draw    … その形式が自分で描き切る（GeoPBF 本道へは行かない）。返り値はトーストが使う {length}
//   convert … File を GeoPBF の File へ変え、下の本道（gint 焼き→識別→ドレープ→fit）へ合流する
// 旧構造は if の連なりで、形式が増えるたびに本道の手前が一段伸びた。表なら「行を1つ足す」で済む。
// ⚠ 順序が意味を持つ：上から順に test して最初に当たった行を使う。
const INTAKE = [
	{
		name: "raster-mbtiles",   // MBTiles（画像タイル）＝ローカル容器→プロバイダ worker→画像タイル層（基図・塗りは伏せる・2026-09-21）。ベクタ MBTiles は理由を言って断る
		test: f => /\.mbtiles$/i.test(f.name),
		draw: async file => rasterDropFile(file),
	},
	{
		name: "raster-gpkg",   // GeoPackage のラスタ（タイル表）。タイル表が無い（地物層だけ）なら従来のベクタ本道へ合流
		test: f => /\.gpkg$/i.test(f.name),
		draw: async (file, ctx) => { const r = await rasterDropFile(file, true); return r === false ? mainRoad(file, ctx) : r; },
	},
	{
		name: "cog",   // COG/GeoTIFF＝cog ガジェットへ（gint 経路の geopbf() は TIFF 非対応で null 死する）
		test: f => /\.tiff?$/i.test(f.name),
		draw: async file => {
			annoCtl?.clear(); gint.clearUserGint();
			return map.gadget.cog(file).then(c => ({ length: `${c.width}×${c.height}px` })).catch(err => { console.error("[dropFile] cog", file.name, err); return null; });
		},
	},
	{
		name: "image",   // 素の画像（PNG/JPEG/WebP…）＝落とした地点（無ければ画面中心）に画面の半分の幅・北向きで貼る（2026-09-21）。
		// 中身は「@image つき 4 頂点の面」の GeoPBF＝本道へ合流＝編集ボタンで geoedit に渡せば四隅をドラッグで合わせられる（古地図の位置合わせ）
		test: f => /\.(png|jpe?g|webp|gif|avif)$/i.test(f.name),
		convert: async (file, ctx) => {
			const { placeCorners, quadPolygon, IMAGE_KEY: K } = await import("geopbf/edit/imagequad");
			const bm = await createImageBitmap(file); const aspect = bm.height / bm.width; bm.close?.();
			const c = ctx?.at || [cam.center[0], cam.center[1]];
			const wDeg = 360 * size.w / (WORLD_PX * 2 ** cam.zoom) * 0.5, widthM = Math.max(5, Math.min(2e6, wDeg * 111320 * Math.cos(c[1] * D2R)));
			const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: file.name.replace(/\.[^.]+$/, ""), [K]: file }, geometry: quadPolygon(placeCorners(c, widthM, aspect)) }] };
			const pbf = await geopbf(fc, { gint: false, name: file.name });
			return new File([pbf.arrayBuffer], file.name.replace(/\.[^.]+$/, ".geopbf"));
		},
	},
	{
		name: "model",   // glTF/GLB＝3D 模型（PLATEAU と同じ建物メッシュ経路・gadgets/model.js・遅延chunk・2026-09-20）。落とした地点（ctx.at）に置く／CESIUM_RTC・ECEF 入りは埋め込みが勝つ
		test: f => /\.(glb|gltf)$/i.test(f.name),
		draw: async (file, ctx) => {
			annoCtl?.clear(); gint.clearUserGint();
			const c = await map.gadget.model(file, { at: ctx?.at, heading: ctx?.heading, scale: ctx?.scale });
			return { length: c.toastLength() };
		},
	},
	{
		name: "geoparquet-view",   // 閾値を超える GeoParquet＝全量変換せず視野追従（gadgets/parquet-view.js・2026-09-20 Phase B）。File は slice で Range 同等
		test: f => /\.(parquet|geoparquet)$/i.test(f.name) && f.size > PARQUET_STREAM_BYTES,
		draw: async file => parquetView(file, file.name),
	},
	{
		name: "geoparquet",
		test: f => /\.(parquet|geoparquet)$/i.test(f.name),
		// 本体は動的 import＝.parquet を受けた時だけチャンクが降りる（初期バンドルは不変・ガジェットの遅延ロードと同じ規律）。
		// 内部圧縮は none/snappy/gzip を自前で読む。zstd はブラウザに実装が無い（DecompressionStream("zstd") は未実装）＝
		// fzstd を注入して読む（2026-09-22）。それでも読めない時の素のエラーは読み手を惑わすので包み直す。
		convert: async file => {
			const [{ fromGeoParquet }, { setZstdDecoder }] = await Promise.all([import("geopbf/geoparquet"), import("geopbf/parquet")]);
			setZstdDecoder(async u8 => (await import("fzstd")).decompress(u8));   // zstd の列＝fzstd（当たった時だけ読み込む・geopbf は依存ゼロのまま＝注入）
			const r = await fromGeoParquet(new Uint8Array(await file.arrayBuffer())).catch(err => {
				if (/zstd/i.test(err?.message || "")) throw new Error(tr()("zstd-compressed GeoParquet cannot be read in a browser (re-write it with gzip or snappy)."));
				throw err;   // それ以外（CRS 不一致・幾何列なし等）は geopbf の文面が既に具体的＝そのまま上げてトーストへ
			});
			const s = r.stats;
			if (s?.skipped?.length) console.warn("[dropFile] parquet: skipped columns", s.skipped.map(k => `${k.name}(${k.reason})`).join(" "));
			console.info(`[dropFile] parquet -> GeoPBF  ${s?.features ?? "?"} features, ${s?.vertices ?? "?"} vertices, ${s?.columns?.length ?? "?"} columns, CRS ${s?.crs ?? "?"}, writer ${s?.created || "?"}`);
			return new File([r.pbf.arrayBuffer], file.name.replace(/\.[^.]+$/, ".geopbf"));
		},
	},
];

// 落とされた/URL で渡された1件を載せる。表で振り分け→（変換行なら）GeoPBF 本道。
// 本道＝geopbf(gint 焼き) → @スタイル付きなら anno（canvas2D 再生）／それ以外は gint スロット → bbox へ fit。
// fit＝読んだ図形へ寄る（ドロップ/?g=）。編集から戻した図形・起動時の復元は寄らない（今の視点のまま置き換える）。
// editDocHook＝編集ボタンを載せた頁だけ＝読んだ図形を「編集中の図形」として保存する口（単独 geoedit の頁では null）
let editDocHook = null;
const loadUserFile = async (file, { fit = true, persist, ...ctx } = {}) => {   // ctx＝形式固有の文脈（glb の at/heading/scale 等）＝draw 行へそのまま・persist＝編集中の図形の置き場の扱い（mainRoad 参照）
	for (const fmt of INTAKE) {
		if (!fmt.test(file)) continue;
		if (fmt.draw) return fmt.draw(file, { fit, ...ctx });
		file = await fmt.convert(file, ctx);   // 変換行＝本道へ合流（以降の扱いは素の .geopbf と同一）
		break;
	}
	return mainRoad(file, { fit, persist });
};
dbgHost.__loadUserFile = loadUserFile;   // 検証窓（ドロップと同じ一本道を CDP から＝自動押し出しの確認）
// 本道（gint 焼き→@検知で anno 再生 or gint スロット→bbox へ fit）＝取り込み表の draw 行からも合流できる（raster-gpkg の地物層フォールバック）
// persist＝編集中の図形の置き場（IDB）の扱い："save"＝編集の結果（× で戻した）を残す／"keep"＝起動の復元（置き場はそのまま）／
// 既定＝見ただけ（ドロップ・?g=）＝置き場を空にする（画面が別の図形に替わった＝古い編集結果を次の起動で蘇らせない・2026-09-22 本人再裁定）
const mainRoad = async (file, { fit = true, persist } = {}) => {
	const pbf = await geopbf(file, { gint: true, name: `drop/${file.name}` }).catch(err => { console.error("[dropFile] geopbf", file.name, err); return null; });
	if (!pbf?.unPackGint) return null;
	// 低ズーム描画が速くなった＝先に現在ビューへ図形を描き（カメラは動かさない）、その後 flyTo で寄る。
	// 瞬間ジャンプ(ポップイン)でなく「図形が現れて→近づく」。着地は真俯瞰(tilt/bearing=0)・北向き＝fit の north-up 前提。
	// 四隅で貼った画像（@image つき 4 頂点の面＝geoedit で置いた古地図・写真）＝画像タイル層へ。描く図形からは抜く（枠を二重に描かない）
	const drawPbf = pbf.keys?.includes(IMAGE_KEY) ? await placeImages(pbf, file.name) : (clearImages(), pbf);
	if (!drawPbf) { gint.clearUserGint(); annoCtl?.clear(); }
	else if (drawPbf.keys?.some(k => ANNO_KEYS.has(k))) {   // @スタイル付き＝注釈レイヤ（geoedit 作）＝canvas2D 再生（gint スロットは触らない→前の層は消す）
		gint.clearUserGint();
		await map.gadget.anno(drawPbf);
	} else {
		annoCtl?.clear();
		gint.applyGintData(drawPbf, file.name, false, { drape: true });   // 先に描画（gint スロットへ set・識別点火・カメラ据え置き）＋ポリゴンは地形沿い境界線を自動発火
	}
	editDocHook?.(pbf, file.name, persist);
	// 高さの列を持つ面＝自動で 3D 押し出し（geoedit の面パネル「高さ」もここ）。?extrude=0＝しない／?extrude=<列名>[,倍率]＝列を指定
	const ex = await autoExtrude(pbf);
	const bb = pbf.unPackGint.bbox;
	if (fit && bb && bb.length === 4) {
		const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
		const wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);   // 30%余白（縁ぴったりを避ける）
		// 視野幅[deg]=360*size.w/(WORLD_PX*2^z)（flight の van Wijk 尺と同一）を逆解き＝横/縦の狭い側に合わせる。
		const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
		flyTo(cx, cy, Math.max(3, Math.min(17, z)), 0);   // 描画後に寄る＝fit へ球面フライト（tilt/bearing=0）。押し出しがあっても傾けない（本人裁定 9/21＝立体は傾けた時に見えればよい）
	}
	return pbf;   // gadget が pbf.length（地物数）をトーストに使う
};
// 四隅で貼った画像＝1 枚ごとに画像タイル層 "img:<n>"（重ね・@opacity）。前の画像は外す（「最後の 1 枚が勝つ」＝図形と同じ）。
// 戻り値＝画像を抜いた残りの図形（gint/anno へ）。残りが無ければ null。imagequad（判定・四隅）は遅延 import＝画像の無い読み込みは降ろさない
const IMAGE_KEY = "@image";
let imageIds = [], imageQuads = [];   // imageQuads＝[{ id, corners, properties }]（map.queryRenderedFeatures の画像層）
// 覆う描き方（本人裁定 9/21「画像で覆いましょう」）＝画像タイル層（地面アトラス＝道路・注記が上に乗る）でなく、同一フレームのオーバーレイ
// （render worker 組み込み gadgets/imagequad-draw.js＝注記の後・geoedit と同じ drawImageQuad）。map.raster.add の { image, corners } は従来どおり地面へ貼る口
let quadOv = null;
const quadOverlay = () => quadOv ??= map.overlay({ builtin: "imagequad" }, { name: "imagequad", above: true });   // 注記の上＝注記も覆う
const clearImages = () => { quadOv?.post({ type: "clear" }); for (const id of imageIds) imageAttrs.delete(id); imageIds = []; imageQuads = []; rasterChanged(); };
const placeImages = async (pbf, name) => {
	clearImages();
	const { isImageFeature, cornersOf } = await import("geopbf/edit/imagequad");
	const gj = pbf.geojson, imgs = [], rest = [];
	for (const f of gj.features) (isImageFeature(f) && f.properties[IMAGE_KEY] instanceof Blob ? imgs : rest).push(f);
	const cap = LOW_MEM ? 2048 : 4096;   // 長辺の上限（省メモリ機＝Air3 jetsam の轍）
	await Promise.all(imgs.map(async (f, k) => {
		const id = `img:${k}`, op = +f.properties["@opacity"], corners = cornersOf(f.geometry);
		imageIds.push(id); imageQuads.push({ id, corners, properties: f.properties });
		try {
			let bm = await createImageBitmap(f.properties[IMAGE_KEY]);
			if (Math.max(bm.width, bm.height) > cap) { const s2 = cap / Math.max(bm.width, bm.height); const b2 = await createImageBitmap(bm, { resizeWidth: Math.round(bm.width * s2), resizeHeight: Math.round(bm.height * s2), resizeQuality: "high" }); bm.close(); bm = b2; }
			quadOverlay().post({ type: "set", id, bitmap: bm, corners, opacity: op > 0 && op <= 1 ? op : 1 }, [bm]);
			const credit = f.properties.attribution || f.properties.name || f.properties[IMAGE_KEY].name || name;   // 出典（HTML 可）＝消毒して出典欄の画像の項へ
			if (credit) imageAttrs.set(id, sanitizeHTML(String(credit)));
		} catch (err) { console.warn("[image] failed", id, err); }
	}));
	if (imgs.length) rasterChanged();
	if (imgs.length) console.info(`[image] ${imgs.length} image(s) placed by four corners`);
	if (!rest.length) return null;
	if (!imgs.length) return pbf;
	return geopbf({ type: "FeatureCollection", features: rest }, { gint: true, name: `drop/${name}` }).catch(err => { console.error("[image] rest", err); return null; });
};
// 自動押し出し＝本道の続き。前の押し出しは外す（「最後の 1 枚が勝つ」）。高さの鍵が無ければ遅延 chunk も降ろさない
const extrudeQ = (() => { const v = new URLSearchParams(location.search).get("extrude"); if (v == null) return null; const [k, sc] = v.split(","); return { off: k === "0" || k === "off", key: k || undefined, scale: +sc > 0 ? +sc : 1 }; })();
const BOTTOM_Q = (v => v === "drape" ? v : v != null && v !== "" && isFinite(+v) ? +v : null)(new URLSearchParams(location.search).get("bottom"));   // ?bottom=<m>＝ドロップ/?g= の自動押し出しの床の高さ（既定 2000m の平面）・?bottom=drape＝地形に沿わせる
const autoExtrude = async pbf => {
	modelCtl?.clearExtrude();
	if (extrudeQ?.off || !(extrudeQ?.key ? pbf.keys?.includes(extrudeQ.key) : hasHeightKey(pbf.keys))) return null;
	try { return await (await modelCtlGet()).extrude(pbf.geojson, { height: extrudeQ?.key, scale: extrudeQ?.scale ?? 1, bottom: BOTTOM_Q }); }
	catch (err) { console.warn("[extrude] failed", err); return null; }
};
// ── 点の集約（クラスタ）とヒートマップ（MapLibre の cluster／heatmap 相当・gadgets/aggregate.js・遅延chunk・2026-09-21）──────────────
// 描画は同一フレームのオーバーレイ（heatmap-gl.js・cluster-2d.js）＝エンジン本体は触らない。src＝GeoJSON/GeoPBF/File/URL（押し出しと同じ読み口）。
//   heatmap(src, { paint:{ "heatmap-*": 式 }, minzoom, maxzoom }) または層を丸ごと（{ type:"heatmap", source:{ type:"geojson", data }, paint }）
//   cluster(src, { clusterRadius, clusterMaxZoom, paint, unclustered:{ paint }, text }) または MapLibre の source（{ type:"geojson", data, cluster:true, … }）
//   null＝外す。ズームは ortho の z（MapLibre の z＋1 と同じ見た目の縮尺）。
let aggCtl = null;
const aggGet = async () => { const m = await import("./gadgets/aggregate.js"); return aggCtl ??= m.createAggregate(map, { signal: ac.signal }); };
const readPoints = async src => (typeof src === "string" || src instanceof Blob) ? (await geopbf(src, { gint: false }))?.geojson : (!src?.type && !Array.isArray(src) && src?.geojson) ? src.geojson : src;
map.gadget("heatmap", async function (src, layer = {}) {
	const c = await aggGet();
	if (src == null) { c.clear("heatmap", layer.slot ?? "default"); return null; }   // slot＝addLayer の層 id（#34）・既定 "default"＝ガジェット直呼びの 1 枠
	if (src?.type === "heatmap") { layer = { ...src, ...layer }; src = src.source?.data ?? src.source; }
	return c.heatmap(await readPoints(src), layer, layer.slot ?? "default");
});
map.gadget("cluster", async function (src, opts = {}) {
	const c = await aggGet();
	if (src == null) { c.clear("cluster", opts.slot ?? "default"); return null; }
	if (src?.type === "geojson" && "data" in src) { const { data, cluster, type, ...rest } = src; opts = { ...rest, ...opts }; src = data; }   // MapLibre の source（cluster:true・clusterRadius・clusterMaxZoom）
	return c.cluster(await readPoints(src), opts, opts.slot ?? "default");
});
// ── 記号帳（sprite）と記号の層（MapLibre の addImage／sprite／symbol 相当・gadgets/symbols.js・遅延chunk・2026-09-21）──────────────
let symCtl = null;
const symGet = async () => { const m = await import("./gadgets/symbols.js"); return symCtl ??= m.createSymbols(map, { signal: ac.signal }); };
map.addImage = async (name, img, o) => (await symGet()).addImage(name, img, o);           // img＝ImageBitmap/HTMLImageElement/Blob/URL/{width,height,data}・o＝{ pixelRatio, sdf }
map.removeImage = name => symCtl?.removeImage(name);
map.hasImage = name => !!symCtl?.hasImage(name);
map.listImages = () => symCtl?.listImages() ?? [];
map.loadSprite = async base => (await symGet()).loadSprite(base);                          // MapLibre の sprite（base.json＋base.png・@2x）
map.gadget("symbols", async function (src, layer = {}) {   // 記号の層（src＝点の GeoJSON/GeoPBF/File/URL か層を丸ごと）・null＋{id}＝外す
	const c = await symGet();
	if (src == null) { c.removeLayer(layer.id || "symbols"); return null; }
	if (src?.type === "symbol") { layer = { ...src, ...layer }; src = src.source?.data ?? src.source; }
	return c.addLayer(layer.id || "symbols", await readPoints(src), layer);
});

// ── MapLibre の addSource／addLayer をそのまま（2026-09-21・「形式で相乗り」の入口）────────────────────────────
// 層の type ごとに今日の部品へ振り分ける：fill/line/circle（集約なし）＝利用者の図形（gint＋map.paint）・fill-extrusion＝押し出し・
// heatmap＝ヒートマップ・circle/symbol（source が cluster:true）＝集約（丸＝paint・件数の文字＝text・filter で集約/単点を見分ける）・
// symbol＝記号の層・raster＝image source（四隅）か raster source（XYZ タイル）＝画像層。source は geojson / image / raster。
// 層はどの種類も何枚でも持てる（#34・2026-09-23）：fill/line/circle＝source ごとに gint の追加層（map.addGint＝paint/filter/feature-state/重ね順を層が持つ）・
// 押し出し／ヒートマップ＝層 id ごとのスロット・集約＝source ごと・symbol と raster は層ごと。
// 重ね順（moveLayer）は「同じ描き方の中」で効く（gint 同士・記号同士・模様同士）。描き方の違う層どうしの上下は描画の段で決まる
//（下から 基図 → 画像 → gint → 押し出し/建物 → ヒートマップ → 集約 → 記号 → 模様）。
// 層の操作は MapLibre と同名：setPaintProperty / setLayoutProperty（visibility）/ setFilter / moveLayer / getStyle / setFeatureState。
const mlSources = new Map(), mlLayers = new Map();   // mlLayers の挿入順＝重ね順（下から）
const srcOf = L => typeof L.source === "string" ? mlSources.get(L.source) : L.source;
const srcId = L => typeof L.source === "string" ? L.source : L.id;
const dataOf = sp => sp?.data ?? null;
const hasPointCount = f => JSON.stringify(f ?? null).includes("point_count");
const mlGen = new Map();   // "cluster:<sid>" / "gint:<sid>" → 世代（組み直しは非同期＝外した後に古い組み直しが着地して復活するのを捨てる）
const bumpGen = k => { const g = (mlGen.get(k) || 0) + 1; mlGen.set(k, g); return g; };
const mlVisible = v => v.layer.layout?.visibility !== "none";
const mlOrderOf = id => [...mlLayers.keys()].indexOf(id);
const kindOf = (layer, sp) => {
	if (layer.type === "raster") return "raster";
	if (layer.type === "fill-extrusion") return "extrude";
	if (layer.type === "heatmap") return "heatmap";
	if (sp.cluster && (layer.type === "circle" || (layer.type === "symbol" && hasPointCount(layer.layout?.["text-field"])))) return "cluster";
	if (layer.type === "symbol") return "symbol";
	if ((layer.type === "fill" && layer.paint?.["fill-pattern"] != null) || (layer.type === "line" && layer.paint?.["line-pattern"] != null)) return "pattern";
	if (layer.type === "fill" || layer.type === "line" || layer.type === "circle") return "gint";
	throw new Error(`addLayer: type "${layer.type}" is not supported`);
};
const rebuildCluster = async sid => {   // 同じ source の集約の層を一つの集約へ畳む（見えている層だけ）
	const gen = bumpGen("cluster:" + sid);
	const sp = mlSources.get(sid) || [...mlLayers.values()].find(v => srcId(v.layer) === sid)?.src;
	const ls = [...mlLayers.values()].filter(v => srcId(v.layer) === sid && v.kind === "cluster" && mlVisible(v)).map(v => v.layer);
	if (!ls.length) { aggCtl?.clear("cluster", sid); return null; }
	const opts = { clusterRadius: sp.clusterRadius ?? 50, clusterMaxZoom: sp.clusterMaxZoom ?? 14, slot: sid };
	for (const L of ls) {
		if (L.type === "circle" && (L.filter == null || hasPointCount(L.filter) && !/"!"/.test(JSON.stringify(L.filter)))) opts.paint = L.paint;
		else if (L.type === "circle") opts.unclustered = { paint: L.paint };
		else if (L.type === "symbol") opts.text = { color: typeof L.paint?.["text-color"] === "string" ? L.paint["text-color"] : undefined, size: typeof L.layout?.["text-size"] === "number" ? L.layout["text-size"] : undefined };
	}
	const pts = await readPoints(dataOf(sp));
	if (mlGen.get("cluster:" + sid) !== gen) return null;   // 待っている間に層が足し引きされた＝新しい方に任せる
	return map.gadget.cluster(pts, opts);
};
// fill/line/circle＝source ごとに gint の追加層 1 枚（同じ source の層の paint を一つに束ねる・filter は層ごとに and）。
// データが同じなら setPaint だけ（fid 表の書き換え＝安い）・変わったら setData。
const mlGint = new Map();   // sid → { h, data, pbf }
const rebuildGint = async (sid, { dataChanged = false } = {}) => {
	const gen = bumpGen("gint:" + sid);
	const sp = mlSources.get(sid) || [...mlLayers.values()].find(v => srcId(v.layer) === sid)?.src;
	const vs = [...mlLayers.values()].filter(v => srcId(v.layer) === sid && v.kind === "gint");
	const ls = vs.filter(mlVisible).map(v => v.layer);
	let cur = mlGint.get(sid);
	if (!ls.length) { if (cur) { cur.h.remove(); mlGint.delete(sid); } return null; }
	if (!cur || dataChanged || cur.data !== dataOf(sp)) {
		let d = dataOf(sp); const raw = d;
		if (typeof d === "string") d = (await geopbf(d, { gint: false }))?.geojson;
		const pbf = await geopbf(d, { gint: true, name: `ml/${sid}` });
		if (mlGen.get("gint:" + sid) !== gen) return null;
		cur = mlGint.get(sid);
		if (cur) { await cur.h.setData(pbf); cur.data = raw; cur.pbf = pbf; }
		else {
			const zs = ls.map(L => L.minzoom).filter(Number.isFinite), zx = ls.map(L => L.maxzoom).filter(Number.isFinite);
			const h = map.addGint(pbf, { order: mlOrderOf(vs[0].layer.id), minZoom: zs.length ? Math.min(...zs) : null, maxZoom: zx.length ? Math.max(...zx) : null });
			cur = { h, data: raw, pbf }; mlGint.set(sid, cur);
			await h.ready;
			if (mlGen.get("gint:" + sid) !== gen) return null;
		}
	}
	const paint = Object.assign({}, ...ls.map(L => L.paint || {}));
	const fs = ls.map(L => L.filter).filter(f => f != null);
	const filt = fs.length === 0 ? null : fs.length === 1 ? fs[0] : ["all", ...fs];
	if (Object.keys(paint).length || filt) await cur.h.setPaint(Object.keys(paint).length ? paint : {}, filt); else await cur.h.setPaint(null);   // paint なし＝層の既定の描き方
	cur.h.setOrder(mlOrderOf(vs[0].layer.id));
	return cur.pbf;
};
// 塗り/線の模様（MapLibre の fill-pattern／line-pattern）＝記号帳の画像を敷き詰める canvas2D のオーバーレイ（pattern-2d.js）。
// ⚠設計原則「紙の遺物を捨てる」の側＝既定では何も描かない。MapLibre の層を受ける互換の口だけ（本人 9/21「残りをお願いします」）
let patOv = null, patOrder = 0;
const patSent = new Set();
const addPattern = async (layer, data, order) => {
	const c = await symGet(); patOv ??= map.overlay(patUrl, { name: "pattern" });
	let d = data; if (typeof d === "string" || d instanceof Blob) d = (await geopbf(d, { gint: false }))?.geojson;
	const feats = d?.features || (Array.isArray(d) ? d : []), P = layer.paint || {}, fill = layer.type === "fill", items = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const ctx = { zoom: cam.zoom, props: f.properties || {}, geom: g.type.replace("Multi", ""), vars: {} };
		if (layer.filter != null && !truthy(evalExpr(layer.filter, ctx))) continue;
		const pattern = evalExpr(P[fill ? "fill-pattern" : "line-pattern"], ctx);
		if (!pattern || !c.getImage(pattern)) continue;
		const parts = fill ? (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) : (g.type === "LineString" ? [[g.coordinates]] : g.type === "MultiLineString" ? g.coordinates.map(l => [l]) : []);
		for (const rings of parts) items.push({ rings: rings.map(r => Float64Array.from(r.flat())), pattern, opacity: +evalExpr(P[fill ? "fill-opacity" : "line-opacity"] ?? 1, ctx), width: fill ? 0 : +evalExpr(P["line-width"] ?? 1, ctx) });
	}
	for (const name of new Set(items.map(i => i.pattern))) if (!patSent.has(name)) { const im = c.getImage(name); const bm = await createImageBitmap(im.bitmap); patOv.post({ type: "image", name, bitmap: bm, pixelRatio: im.pixelRatio }, [bm]); patSent.add(name); }
	patOv.post({ type: "layer", id: layer.id, kind: fill ? "fill" : "line", items, order: order ?? patOrder++ });
	return { features: items.length };
};
// ラスタの色調整（MapLibre の raster-* paint・#39）＝今のズームで数へ（式も可）。何も無ければ null
const rasterAdjust = P => {
	if (!P) return null;
	const n = (k, d) => P[k] == null ? d : +evalExpr(P[k], { zoom: cam.zoom, props: {}, geom: null, vars: {} });
	const a = { hueRotate: n("raster-hue-rotate", 0), saturation: n("raster-saturation", 0), contrast: n("raster-contrast", 0), brightnessMin: n("raster-brightness-min", 0), brightnessMax: n("raster-brightness-max", 1) };
	return a.hueRotate || a.saturation || a.contrast || a.brightnessMin || a.brightnessMax !== 1 ? a : null;
};
// 層を描き出す／取り下げる（登録簿 mlLayers はそのまま＝visibility と setPaintProperty の往復で使う）
const mountLayer = async v => {
	const { layer, kind, src: sp } = v, sid = srcId(layer), data = dataOf(sp), order = mlOrderOf(layer.id);
	if (kind === "raster") {
		const ro = { order: "over", opacity: layer.paint?.["raster-opacity"] ?? 1, hideFills: false }, adjust = rasterAdjust(layer.paint);
		if (sp.type === "image") { const b = await (await fetch(sp.url, { credentials: "omit" })).blob(); return map.raster.add(layer.id, { image: b, corners: sp.coordinates, name: layer.id }, ro); }
		return map.raster.add(layer.id, { url: sp.tiles?.[0] ?? sp.url, tileSize: sp.tileSize || 256, minZoom: sp.minzoom, maxZoom: sp.maxzoom, bbox: sp.bounds, attribution: sp.attribution, adjust }, ro);
	}
	if (kind === "extrude") return map.gadget.extrude(await readPoints(data), { ...layer, fit: false, slot: layer.id });
	if (kind === "heatmap") return map.gadget.heatmap(await readPoints(data), { ...layer, slot: layer.id });
	if (kind === "cluster") return rebuildCluster(sid);
	if (kind === "symbol") { const c = await symGet(); const r = await c.addLayer(layer.id, await readPoints(data), layer); c.setOrder(layer.id, order); return r; }
	if (kind === "pattern") return addPattern(layer, data, order);
	if (kind === "gint") return rebuildGint(sid);
};
const unmountLayer = v => {
	const { layer, kind } = v, id = layer.id, sid = srcId(layer);
	if (kind === "raster") map.raster.remove(id);
	else if (kind === "extrude") modelCtl?.clearExtrude(id);
	else if (kind === "heatmap") aggCtl?.clear("heatmap", id);
	else if (kind === "symbol") symCtl?.removeLayer(id);
	else if (kind === "cluster") return rebuildCluster(sid);   // 残りの集約の層で組み直す（無ければ外す・世代で古い組み直しを捨てる）
	else if (kind === "gint") return rebuildGint(sid);
	else if (kind === "pattern") patOv?.post({ type: "removeLayer", id });
};
const reorderLayers = () => {   // 登録順を各描き方の重ね順へ
	for (const [sid, cur] of mlGint) { const first = [...mlLayers.values()].find(v => v.kind === "gint" && srcId(v.layer) === sid); if (first) cur.h.setOrder(mlOrderOf(first.layer.id)); }
	for (const v of mlLayers.values()) if (v.kind === "symbol" && mlVisible(v)) symCtl?.setOrder(v.layer.id, mlOrderOf(v.layer.id));
	for (const v of mlLayers.values()) if (v.kind === "pattern" && mlVisible(v)) mountLayer(v);   // 模様は送り直しで順が付く
};
map.addSource = (id, spec) => { if (mlSources.has(id)) throw new Error(`addSource: source "${id}" already exists`); mlSources.set(id, spec); return map; };
map.getSource = id => {
	const sp = mlSources.get(id); if (!sp) return undefined;
	return { ...sp, setData: async data => {
		sp.data = data;
		const vs = [...mlLayers.values()].filter(v => srcId(v.layer) === id && mlVisible(v));
		if (vs.some(v => v.kind === "gint")) await rebuildGint(id, { dataChanged: true });
		for (const v of vs) if (v.kind !== "gint") await mountLayer(v);
	} };
};
map.removeSource = id => {
	if ([...mlLayers.values()].some(v => srcId(v.layer) === id)) throw new Error(`removeSource: source "${id}" is used by a layer`);   // MapLibre と同じ＝使われている source は外せない
	mlSources.delete(id); return map;
};
map.isSourceLoaded = id => mlSources.has(id);
map.getLayer = id => mlLayers.get(id)?.layer;
// beforeId＝その層の下に差し込む（MapLibre と同じ）。同じ id の層は置き換え
map.addLayer = async (layer, beforeId) => {
	const sp = srcOf(layer); if (!sp) throw new Error(`addLayer: source "${layer.source}" not found`);
	const v = { layer: { ...layer, paint: { ...(layer.paint || {}) }, layout: { ...(layer.layout || {}) } }, kind: kindOf(layer, sp), src: sp };
	if (mlLayers.has(layer.id)) { const old = mlLayers.get(layer.id); mlLayers.delete(layer.id); await unmountLayer(old); }
	if (beforeId != null && mlLayers.has(beforeId)) {
		const ents = [...mlLayers]; const i = ents.findIndex(([k]) => k === beforeId);
		ents.splice(i, 0, [layer.id, v]); mlLayers.clear(); for (const [k, x] of ents) mlLayers.set(k, x);
	} else mlLayers.set(layer.id, v);
	const r = mlVisible(v) ? await mountLayer(v) : null;
	if (beforeId != null) reorderLayers();
	return r;
};
map.removeLayer = id => {
	const v = mlLayers.get(id); if (!v) return map;
	mlLayers.delete(id);
	unmountLayer(v);
	return map;
};
map.moveLayer = (id, beforeId) => {
	const v = mlLayers.get(id); if (!v) return map;
	mlLayers.delete(id);
	if (beforeId != null && mlLayers.has(beforeId)) {
		const ents = [...mlLayers]; const i = ents.findIndex(([k]) => k === beforeId);
		ents.splice(i, 0, [id, v]); mlLayers.clear(); for (const [k, x] of ents) mlLayers.set(k, x);
	} else mlLayers.set(id, v);
	reorderLayers();
	return map;
};
// 性質の変更＝登録簿の層を書き換えて描き直す（gint は fid 表の書き換えだけ＝安い・画像の不透明度は map.raster.set）
const relayer = v => mlVisible(v) ? (v.kind === "gint" ? rebuildGint(srcId(v.layer)) : v.kind === "cluster" ? rebuildCluster(srcId(v.layer)) : mountLayer(v)) : null;
map.setPaintProperty = (id, name, value) => {
	const v = mlLayers.get(id); if (!v) throw new Error(`setPaintProperty: layer "${id}" not found`);
	if (value === undefined) delete v.layer.paint[name]; else v.layer.paint[name] = value;
	if (v.kind === "raster" && name === "raster-opacity") { map.raster.set(id, { opacity: value ?? 1 }); return map; }
	relayer(v); return map;
};
map.getPaintProperty = (id, name) => mlLayers.get(id)?.layer.paint?.[name];
map.setLayoutProperty = (id, name, value) => {
	const v = mlLayers.get(id); if (!v) throw new Error(`setLayoutProperty: layer "${id}" not found`);
	const was = mlVisible(v);
	if (value === undefined) delete v.layer.layout[name]; else v.layer.layout[name] = value;
	const now = mlVisible(v);
	if (name === "visibility") { if (was && !now) unmountLayer(v); else if (!was && now) (v.kind === "gint" ? rebuildGint(srcId(v.layer)) : mountLayer(v)); return map; }
	relayer(v); return map;
};
map.getLayoutProperty = (id, name) => mlLayers.get(id)?.layer.layout?.[name];
map.setFilter = (id, filter) => {
	const v = mlLayers.get(id); if (!v) throw new Error(`setFilter: layer "${id}" not found`);
	if (filter == null) delete v.layer.filter; else v.layer.filter = filter;
	relayer(v); return map;
};
map.getFilter = id => mlLayers.get(id)?.layer.filter;
map.setLayerZoomRange = (id, minzoom, maxzoom) => { const v = mlLayers.get(id); if (!v) return map; v.layer.minzoom = minzoom; v.layer.maxzoom = maxzoom; if (v.kind === "gint") { const cur = mlGint.get(srcId(v.layer)); if (cur) { mlGint.delete(srcId(v.layer)); cur.h.remove(); } } relayer(v); return map; };
// feature-state（MapLibre 同名）：{ source, id } の id＝その source の地物の番号（GeoJSON の並び順＝gint の fid）。
// 効くのは fill/line/circle（gint の層）の paint に ["feature-state", key] がある時。基図の地物には効かない（基図の塗りは worker で焼いた op 列）
map.setFeatureState = ({ source, id }, state) => { const cur = mlGint.get(source); if (cur && id != null) cur.h.setFeatureState(+id, state); return map; };
map.removeFeatureState = ({ source, id } = {}, key) => {
	const cur = mlGint.get(source); if (!cur) return map;
	if (key != null && id != null) cur.h.setFeatureState(+id, { [key]: undefined }); else cur.h.removeFeatureState(id == null ? null : +id);
	return map;
};
map.getLayers = () => [...mlLayers.values()].map(v => v.layer);
// getStyle＝MapLibre の style の形（version 8）。layers＝基図の層（外来 style ならその source 名・地域の基図は "basemap"＝読むだけ）の上に利用者の層（登録順）
map.getStyle = () => {
	const baseSid = EXT?.split.vectorSource ?? "basemap";
	const baseSrc = EXT ? EXT.ms.sources[baseSid] : { type: "vector" };
	return {
		version: 8, ...(EXT ? { name: EXT.ms.name, sprite: EXT.ms.sprite, glyphs: EXT.ms.glyphs } : {}),
		sources: { [baseSid]: baseSrc, ...Object.fromEntries(mlSources), ...Object.fromEntries([...mlLayers.values()].filter(v => typeof v.layer.source !== "string").map(v => [v.layer.id, v.layer.source])) },
		layers: [...(style.layers || []).map(L => L.type === "background" ? { ...L } : { ...L, source: L.source ?? baseSid }), ...[...mlLayers.values()].map(v => ({ ...v.layer, source: srcId(v.layer) }))],
	};
};
// 外来 style の基図以外の層＝画像層（raster source）と利用者の層（geojson / image source）へ振り分ける（起動後・setStyle の後）
const extExtras = { raster: [], layers: [], sources: [], offs: [] };
const mountExtExtras = async ext => {
	const ms = ext.ms, baseIdx = ms.layers.findIndex(L => L.source === ext.split.vectorSource && L.type !== "background");
	for (const L of ext.split.raster) {
		// 画像層は基図の塗りの「上」にしか合成できない（地面アトラスで塗りの後に重ねる）。style で基図の塗りより前（下）に書かれた画像
		//（例：陰影図を土地被覆の下に敷く）は描かない＝上に載せると塗りを白く洗ってしまう。数えて知らせる
		if (baseIdx >= 0 && ms.layers.findIndex(x => x.id === L.id) < baseIdx) { console.info(`[style] raster layer "${L.id}" sits under the vector fills — not drawn (imagery can only go above the basemap fills)`); continue; }
		try {
			const sp = await resolveVectorSource(ms.sources[L.source], ext.baseUrl, { fetchFn: (u, init) => requester.fetch(u, "Source", init) });   // TileJSON の解決は raster も同じ
			const op = L.paint?.["raster-opacity"] ?? 1, opNow = () => +evalExpr(op, { zoom: cam.zoom, props: {}, geom: null, vars: {} });
			await map.raster.add(L.id, { url: sp.tiles[0], tileSize: ms.sources[L.source].tileSize || 256, minZoom: sp.minzoom, maxZoom: sp.maxzoom, bbox: sp.bounds, attribution: sp.attribution, adjust: rasterAdjust(L.paint) }, { order: "over", opacity: opNow(), hideFills: false });
			if (Array.isArray(op)) { const f = () => map.raster.set(L.id, { opacity: opNow() }); map.on("settle", f); extExtras.offs.push(() => map.off("settle", f)); }   // ズームの式＝止まるたび評価し直す
			extExtras.raster.push(L.id);
		} catch (err) { console.warn("[style] raster layer", L.id, err); }
	}
	if (ext.split.geojson.some(L => L.layout?.["icon-image"] != null) && ms.sprite) {
		const sp = Array.isArray(ms.sprite) ? ms.sprite[0]?.url : ms.sprite;
		if (sp) await map.loadSprite(new URL(sp, ext.baseUrl).href).catch(err => console.warn("[style] sprite", err));
	}
	if (ms.terrain?.source && ms.sources?.[ms.terrain.source]?.type === "raster-dem") {   // style の terrain（MapLibre）＝その raster-dem を地形へ（#36）
		const sp = { ...ms.sources[ms.terrain.source] }; if (sp.url) sp.url = new URL(sp.url, ext.baseUrl).href; if (sp.tiles) sp.tiles = sp.tiles.map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, ext.baseUrl).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));
		await map.setTerrain({ source: sp, exaggeration: ms.terrain.exaggeration }).catch(err => console.warn("[style] terrain", err));
	}
	for (const L of ext.split.geojson) {
		try {
			if (!mlSources.has(L.source)) { const sp = { ...ms.sources[L.source] }; if (typeof sp.data === "string") sp.data = new URL(sp.data, ext.baseUrl).href; if (sp.url) sp.url = new URL(sp.url, ext.baseUrl).href; map.addSource(L.source, sp); extExtras.sources.push(L.source); }
			await map.addLayer(L); extExtras.layers.push(L.id);
		} catch (err) { console.warn("[style] layer", L.id, err); }
	}
};
const unmountExtExtras = () => {
	for (const id of extExtras.raster) map.raster.remove(id);
	for (const id of extExtras.layers) map.removeLayer(id);
	for (const sid of extExtras.sources) { try { map.removeSource(sid); } catch { /* 利用者が同じ source に層を足している＝残す */ } }
	for (const f of extExtras.offs) f();
	extExtras.raster = []; extExtras.layers = []; extExtras.sources = []; extExtras.offs = [];
};
if (EXT) map.on("load", () => { mountExtExtras(EXT); });
// 基図の style を生き替える（外来 style で起動した地図だけ）。spec＝URL か style の object。解決は新しい style の基図が描き始めた後
map.setStyle = async spec => {
	if (!EXT) throw new Error("setStyle: this map uses the regional basemap — boot with opts.style (or ?style=) to switch MapLibre styles");
	const nx = await loadExtStyle(spec);
	unmountExtExtras();
	EXT = nx;
	Object.assign(BASE_SOURCE, extSourceFields(nx));
	if (BASE_SOURCE.kind === "pmtiles") {
		const info = await pmtilesInfo(BASE_SOURCE.url).catch(err => { console.warn("[style] cannot read PMTiles", err); return null; });
		BASE_SOURCE.info = info; if (info?.attribution && !BASE_SOURCE.attrHTML) BASE_SOURCE.attrHTML = sanitizeHTML(String(info.attribution));
	}
	style = extBaseStyle(nx);
	bg = style.layers.find(L => L.type === "background");
	land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : land;
	renderer.set("view", { land });
	themes = mkThemes(style);
	setPipelineStyle(style);   // （sea / bldFill の門は外来 style では常に -1＝差し替え不要）
	readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = "";   // テーマの生き替え（上）と同じ＝結合の署名を捨てる。⚠これが無いと同じタイル集合では旧色のシーンが結合し直されず残る（t-request ④が 0% になった）
	attrZone = null; needsDraw = true; onMove();
	await mountExtExtras(nx);
	return map;
};
// ── 描画結果への問い合わせ（MapLibre の queryRenderedFeatures 相当・2026-09-21）──────────────────────────
// geometry＝省略（画面全体）｜[x,y]（CSS px）｜[[x0,y0],[x1,y1]]（箱）。opts＝{ layers:[id…], filter: 式, tolerance: px（既定 3） }。
// 返り値＝Promise<Feature[]>（上に描かれたものから）。基図は ortho-core の queryTiles（描いているタイルを取り直して今のスタイルで当てる）。
// その上に載せたもの＝集約（"clusters"/"unclustered-point"・点の問い合わせだけ）・画像（id "img:<n>"・raster）・押し出し（"extrude"・fill-extrusion）・利用者の図形（"user"・gint の識別＝許容は m 換算）。
// MapLibre と違う点＝非同期（タイルを取り直すため）。基図の層 id はスタイルの id（地域パックの style）。
const queryCache = new Map();   // "z/x/y" → 解読済みタイル（直近 32 枚）
map.queryRenderedFeatures = async (geometry, qo = {}) => {
	if (!Array.isArray(geometry) && geometry && typeof geometry === "object") { qo = geometry; geometry = undefined; }   // MapLibre と同じ＝第 1 引数に opts だけも可
	const W = size.w / dpr, H = size.h / dpr, tolPx = qo.tolerance ?? 3;
	let area;
	if (geometry && typeof geometry[0] === "number") { const ll = unprojectXY(geometry[0], geometry[1]); if (!ll) return []; area = { ll }; }
	else {
		const [[x0, y0], [x1, y1]] = geometry || [[0, 0], [W, H]];
		const cs = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2]].map(([x, y]) => unprojectXY(x, y)).filter(Boolean);
		if (!cs.length) return [];
		area = { bbox: [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))] };
	}
	const want = qo.layers ? new Set(qo.layers) : null, take = id => !want || want.has(id);
	const inBox = (lon, lat) => area.bbox ? lon >= area.bbox[0] && lon <= area.bbox[2] && lat >= area.bbox[1] && lat <= area.bbox[3] : false;
	const pt = area.ll || [(area.bbox[0] + area.bbox[2]) / 2, (area.bbox[1] + area.bbox[3]) / 2];
	const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
	const inPolyGeom = (g, x, y) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []).some(p => inRing(p[0], x, y) && !p.slice(1).some(h => inRing(h, x, y)));
	const touches = g => area.ll ? inPolyGeom(g, pt[0], pt[1]) : JSON.stringify(g.coordinates).match(/-?\d+\.?\d*,-?\d+\.?\d*/g)?.some(s => { const [x, y] = s.split(",").map(Number); return inBox(x, y); });
	const out = [];
	// 上から：集約の丸 → 画像（最後に貼ったものが上）→ 押し出し → 利用者の図形 → 基図
	if (geometry && typeof geometry[0] === "number" && symCtl) for (const h of symCtl.symbolsAt(geometry[0], geometry[1])) if (take(h.layer.id)) out.push(h);
	if (geometry && typeof geometry[0] === "number" && aggCtl) { const h = aggCtl.clusterAt(geometry[0], geometry[1]); if (h && take(h.layer.id)) out.push(h); }
	for (const q of [...imageQuads].reverse()) {
		if (!take(q.id)) continue;
		const g = { type: "Polygon", coordinates: [[...q.corners, q.corners[0]]] };
		if (touches(g)) { const { [IMAGE_KEY]: _img, ...props } = q.properties || {}; out.push({ type: "Feature", properties: props, geometry: g, layer: { id: q.id, type: "raster" }, source: "image" }); }
	}
	for (const { f, h, slot } of [...(modelCtl?.extrudedFeatures || [])].reverse()) {   // 押し出し＝スロットごと（addLayer の層 id・ガジェット直呼びは "extrude"）・新しい方が上
		const lid = slot === "default" ? "extrude" : slot;
		if (take(lid) && touches(f.geometry)) out.push({ type: "Feature", properties: f.properties || {}, geometry: f.geometry, layer: { id: lid, type: "fill-extrusion" }, source: slot === "default" ? "extrude" : srcId(mlLayers.get(slot)?.layer ?? { id: slot }), height: h });
	}
	// addLayer の fill/line/circle（source ごとの gint 層）＝上の層から。点は識別（gint の identifyAt）・箱は地物ごとに当てる
	for (const [sid, cur] of [...mlGint].sort((a, b) => (b[1].h.order ?? 0) - (a[1].h.order ?? 0))) {
		const ls = [...mlLayers.values()].filter(v => v.kind === "gint" && srcId(v.layer) === sid && mlVisible(v)).map(v => v.layer).filter(L => take(L.id));
		if (!ls.length) continue;
		const pick = g => { const t0 = g?.type?.replace("Multi", ""); return ls.find(L => (L.type === "fill" && t0 === "Polygon") || (L.type === "line" && t0 === "LineString") || (L.type === "circle" && t0 === "Point")) ?? ls[0]; };
		const mPerPx = 40075016.686 * Math.cos(pt[1] * D2R) / (WORLD_PX * 2 ** cam.zoom);
		const fids = area.ll ? [cur.pbf.identifyAt(pt[0], pt[1], { point: (tolPx + 6) * mPerPx, polyline: tolPx * mPerPx })].filter(v => v != null) : null;
		const feats = fids ? fids.map(i => [i, cur.pbf.getFeature(i)]) : cur.pbf.features.map((f, i) => [i, f]).filter(([, f]) => f?.geometry && touches(f.geometry));
		for (const [i, f] of feats) if (f) { const L = pick(f.geometry); out.push({ type: "Feature", id: i, properties: f.properties || {}, geometry: f.geometry, layer: { id: L.id, type: L.type }, source: sid }); }
	}
	const upbf = gint.userGint?.pbf;
	if (upbf && take("user")) {
		const mPerPx = 40075016.686 * Math.cos(pt[1] * D2R) / (WORLD_PX * 2 ** cam.zoom);
		const fids = area.ll ? [upbf.identifyAt(pt[0], pt[1], { point: (tolPx + 6) * mPerPx, polyline: tolPx * mPerPx })].filter(v => v != null) : null;
		const feats = fids ? fids.map(i => [i, upbf.getFeature(i)]) : upbf.features.map((f, i) => [i, f]).filter(([, f]) => f?.geometry && touches(f.geometry));
		for (const [i, f] of feats) if (f) out.push({ type: "Feature", id: i, properties: f.properties || {}, geometry: f.geometry, layer: { id: "user", type: "gint" }, source: "user" });
	}
	if (queryCache.size > 32) queryCache.clear();
	const baseIds = want && new Set((style.layers || []).map(L => L.id));
	if (want && ![...want].some(id => baseIds.has(id))) return qo.filter ? out.filter(f => truthy(evalExpr(qo.filter, { zoom: cam.zoom, props: f.properties, geom: f.geometry?.type?.replace("Multi", ""), vars: {} }))) : out;   // 基図の層を頼んでいない＝タイルを取り直さない（層ごとのイベントの hover を軽く）
	const base = await queryTiles({ style, hidden: themes.hiddenLi(layerState, cam.zoom), order: lastTileOrder, tileUrl: BASE_SOURCE.tileUrl, zoom: cam.zoom, area, tolPx,
		layers: qo.layers || null, filter: qo.filter || null, cache: queryCache, request: requester.forTiles() }).catch(err => { console.warn("[query] basemap", err); return []; });
	return qo.filter ? out.filter(f => truthy(evalExpr(qo.filter, { zoom: cam.zoom, props: f.properties, geom: f.geometry?.type?.replace("Multi", ""), vars: {} }))).concat(base) : out.concat(base);
};
// 層ごとのイベント（MapLibre 同名・#34）：map.on("click"|"mousemove"|"mouseenter"|"mouseleave", layerId | layerId[], cb)。
// e＝{ type, point:{x,y}, lngLat:{lng,lat}, features, originalEvent, target: map }。当たりは queryRenderedFeatures（層を絞る＝基図の層でなければタイルを取り直さない）。
// click はドラッグ（押して 5px 以上動いた）を除く。mousemove は rAF に畳み、最新の問い合わせだけを採る。
const layerEvs = [];   // { ev, ids:Set, cb, inside }
const onPlain = map.on, offPlain = map.off;
const lngLatObj = ll => ll ? { lng: ll[0], lat: ll[1] } : null;
const hitsFor = async (x, y, ids) => { const fs = await map.queryRenderedFeatures([x, y], { layers: [...ids] }); return fs; };
let downAt = null, hovSeq = 0, hovRaf = 0, hovLast = null;
canvas.addEventListener("pointerdown", e => { downAt = evXY(e); }, { signal: ac.signal });
canvas.addEventListener("click", async e => {
	const ls = layerEvs.filter(L => L.ev === "click"); if (!ls.length) return;
	const [x, y] = evXY(e);
	if (downAt && Math.hypot(x - downAt[0], y - downAt[1]) > 5) return;   // ドラッグの終わり＝クリックではない
	const ids = new Set(ls.flatMap(L => [...L.ids]));
	const fs = await hitsFor(x, y, ids);
	for (const L of ls) { const mine = fs.filter(f => L.ids.has(f.layer?.id)); if (mine.length) try { L.cb({ type: "click", point: { x, y }, lngLat: lngLatObj(unprojectXY(x, y)), features: mine, originalEvent: e, target: map }); } catch (err) { console.error("[map.on click layer]", err); } }
}, { signal: ac.signal });
const hoverLs = () => layerEvs.filter(L => L.ev === "mousemove" || L.ev === "mouseenter" || L.ev === "mouseleave");
const fireLeave = (L, x, y, e) => { if (!L.inside) return; L.inside = false; if (L.ev === "mouseleave") try { L.cb({ type: "mouseleave", point: { x, y }, lngLat: lngLatObj(unprojectXY(x, y)), features: [], originalEvent: e, target: map }); } catch (err) { console.error("[map.on mouseleave]", err); } };
canvas.addEventListener("pointermove", e => {
	if (!hoverLs().length || e.buttons) return;   // ドラッグ中は当てない（パンの邪魔をしない）
	hovLast = e;
	if (hovRaf) return;
	hovRaf = requestAnimationFrame(async () => {
		hovRaf = 0;
		const ev0 = hovLast, [x, y] = evXY(ev0), seq = ++hovSeq, ls = hoverLs();
		if (!ls.length) return;
		const fs = await hitsFor(x, y, new Set(ls.flatMap(L => [...L.ids])));
		if (seq !== hovSeq) return;   // 追い越された
		for (const L of ls) {
			const mine = fs.filter(f => L.ids.has(f.layer?.id));
			const evo = type => ({ type, point: { x, y }, lngLat: lngLatObj(unprojectXY(x, y)), features: mine, originalEvent: ev0, target: map });
			if (!mine.length) { fireLeave(L, x, y, ev0); continue; }
			try {
				if (L.ev === "mousemove") L.cb(evo("mousemove"));
				else if (L.ev === "mouseenter" && !L.inside) L.cb(evo("mouseenter"));
			} catch (err) { console.error("[map.on %s]", L.ev, err); }
			L.inside = true;
		}
	});
}, { signal: ac.signal });
canvas.addEventListener("pointerleave", e => { hovSeq++; const [x, y] = evXY(e); for (const L of hoverLs()) fireLeave(L, x, y, e); }, { signal: ac.signal });
map.on = (ev, a, b) => {
	if (typeof a === "function" || b == null) return onPlain(ev, a);
	layerEvs.push({ ev, ids: new Set(Array.isArray(a) ? a : [a]), cb: b, inside: false, key: a });
	return map;
};
map.off = (ev, a, b) => {
	if (typeof a === "function" || b == null) return offPlain(ev, a);
	const k = JSON.stringify(a), i = layerEvs.findIndex(L => L.ev === ev && L.cb === b && JSON.stringify(L.key) === k);
	if (i >= 0) layerEvs.splice(i, 1);
	return map;
};
map.once = (ev, a, b) => {
	if (typeof a === "function" || (a == null && b == null)) { if (!a) return new Promise(res => { const f = e => { map.off(ev, f); res(e); }; map.on(ev, f); }); const f = e => { map.off(ev, f); a(e); }; return map.on(ev, f); }
	if (!b) return new Promise(res => { const f = e => { map.off(ev, a, f); res(e); }; map.on(ev, a, f); });
	const f = e => { map.off(ev, a, f); b(e); }; return map.on(ev, a, f);
};
// ローカル容器（.gpkg/.mbtiles）の画像タイル＝"drop" 層として基図に（塗りは伏せる）。fallback＝タイル表が無ければ false（呼び手がベクタ本道へ）
const rasterDropFile = async (file, fallback = false) => {
	annoCtl?.clear(); cogCtl?.clear();
	try {
		const info = await map.raster.add("drop", { file }, { order: "under", hideFills: true });
		if (info?.bbox) { const bb = info.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);
			flyTo(cx, cy, Math.max(3, Math.min(17, Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg))))), 0); }
		return { length: t("raster tiles z$1–$2", info?.minZoom ?? "?", info?.maxZoom ?? "?") };
	} catch (err) {
		if (fallback && /no tile table/.test(String(err?.message))) return false;
		throw err;
	}
};
map.gadget("dropFile", function (opts) {   // GISファイルのD&D取り込み … loadUserFile（上）を束ね注入（gint単一スロット＝置き換え）
	return dropFileGadget.call(this, { loadFile: loadUserFile, unprojectAt, clearGint: () => { annoCtl?.clear(); cogCtl?.clear(); modelCtl?.clear(); modelCtl?.clearExtrude(); clearImages(); map.raster.remove("drop"); gint.clearUserGint(); parquetCtl?.destroy(); parquetCtl = null; editDocHook?.(null); }, playScene: scenes.playScene, busy: scenes.playingNow, yieldTo: () => editDropOwner, signal: ac.signal, ...opts });   // busy＝上映中はドロップ無視（デモ中はドロップ禁止）。消去は注釈レイヤも一緒に
});
map.gadget("geoedit", function (opts) {   // GeoPBF トポロジカル編集＝geoedit（npm）（packages/geoedit・MIT・2026-09-20 に分離・遅延chunk）… 公開面だけで動く＝ここは import と結線だけ。戻り値＝Promise<editor>
	// ホスト契約：言語（エディタは自前の 26 言語表）・左下ドック・クラウド保存パネル（japan の共通の器）を注入。搭載中はドロップをエディタが所有（dropFile は譲る）
	return Promise.all([import("geoedit"), import("./gadgets/cloud.js")]).then(async ([m, cloud]) => {
		await m.setLang(getLang());
		return m.initEditor(this, { setDropOwner: on => { editDropOwner = !!on; }, dock: dockStack, cloudPanel: cloud.cloudPanel, ...opts });
	});
});
map.gadget("edit", function (opts) {   // 編集ボタン（左上スタック）… 押すと map.gadget.geoedit() を部品として搭載/解除。出現域は搭載側の zoom 宣言（site.js＝[2.5,99]）
	// 編集中の図形（2026-09-19 本人裁定）：japan は図形を一つ持つ（初めは空）。ドロップ/?g= で読んだもの・編集から戻したものがそれ＝
	// 専用の置き場（editdoc＝単独 geoedit の自動保存とは別）へ保存し、次に開いた時も続きから。編集＝geoedit に渡して部品として開き、
	// 右端の「×」（かこのボタン）で結果を受け取り置き換える。?g= で開いた時は ?g= が勝つ（前回分は復元しない＝上書きされる）
	let doc = null;   // { buf: GeoPBF の ArrayBuffer, name（.geopbf） }
	const asGeopbf = name => String(name || "edit").replace(/\.[^./]+$/, "") + ".geopbf";   // 中身は GeoPBF＝拡張子で変換を誤らせない
	editDocHook = (pbf, name, persist) => {
		if (!pbf) { doc = null; editDocClear(); return; }
		doc = { buf: pbf.arrayBuffer.slice(0), name: asGeopbf(name) };   // 編集ボタンが開く「今の図形」はいつでも（見ただけでも）
		if (persist === "save") editDocSave(doc.buf, doc.name);   // 次の起動へ持ち越すのは編集の結果だけ
		else if (persist !== "keep") editDocClear();              // 見ただけ＝置き場を空に
	};
	if (!new URLSearchParams(location.search).get("g")) editDocLoad().then(rec => {
		if (!rec?.buf || doc) return;
		if (!rec.edited) { editDocClear(); return; }   // 旧い置き場（見ただけで残っていた・印なし）は復元せず捨てる
		loadUserFile(new File([rec.buf], rec.name || "edit.geopbf"), { fit: false, persist: "keep" });
	});
	return editGadget.call(this, {
		mount: ({ onClose }) => { annoCtl?.clear(); modelCtl?.clearExtrude(); clearImages(); return map.gadget.geoedit({ data: doc?.buf ?? null, persist: false, adopt: false, onClose }); },   // 注釈の再生は外す＝エディタが同じ図形を描く（二重に見せない）
		onResult: async buf => {
			if (buf) await loadUserFile(new File([buf], doc?.name || "edit.geopbf"), { fit: false, persist: "save" });
			else { annoCtl?.clear(); modelCtl?.clearExtrude(); clearImages(); gint.clearUserGint(); editDocHook(null); }   // 全部消して戻った＝編集中の図形も空へ
		},
		signal: ac.signal, ...opts,
	});
});
map.gadget("demo", function (opts) {   // デモ（発表の台本再生）… 台本の一行=共有URLハッシュ。flyView（球面フライト）・フライト中判定・PLATEAU先読み・現テーマ名（幕替わり判定）を注入
	const japanFit = () => {   // 終演の定位置＝日本列島が画面に収まる真俯瞰・北向き（fitBbox と同じ視野幅の逆解き＝縦横どちらの画面でも収まる）
		const wDeg = 17.4 * 1.15, hDeg = 15.2 * 1.15;   // 列島の大づかみ [129..146.4]×[30.6..45.8]（沖縄本島は列島の画角を殺すので外＝台本の白地図と同じ構図）
		const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
		flyTo(137, 37, Math.max(ZOOM_MIN, Math.min(7, z)), 0, 0);
	};
	scenes.demoHandle = demoGadget.call(this, { flyView, fadeView: scenes.fadeViewRun, glidePath: glidePathView, flightActive: () => flightCtl.active || scenes.fadeBusy,
		// 書き終わりの合図（自動上演の行送りゲート・裁定2026-08-12「非力機は書き終わるまで待つ」）＝可視の立ち上げ
		// (autoMesh発＝prefetchは含めない・ackはクレジット窓2で「ほぼ描き切り」)・標高タイル・基図sig（z<4は
		// mainスロット空でsigが恒久不一致＝地球儀シーンを堰き止めないよう z≥4 限定）。裏仕込み(prefetch)は幕を止めない。
		// 返り値＝進捗指紋の文字列（空=静か）：demo側は「指紋が動く間だけ」待つ＝止まった待ち（オフライン等）は打ち切れる。
		loadingActive: () => {
			const base = cam.zoom >= 4 && readySig !== mainDesired;
			// 待つのは「これから見える区」だけ＝demote（視界外の在庫化）・cancel 中の区は指紋に載せない。旧・全ロード中区の
			// 進捗を載せていたため、目の前の区が読み終わっても隣の在庫区のバッチ進捗が動き続けて上限（20s）まで幕が進まなかった
			//（本人報告 2026-09-08「途中で Plateau の読みが終わると再開しない」＝R2 焼きで本命が数秒で終わるようになり顕在化）
			const shown = meshMgr.visibleLoading();
			if (!shown.length && !elevBusy && !base) return "";
			return `A${shown.join(".")}|P${shown.map(n => { const p = meshMgr.progress.get(n); return p ? (p.done ?? p.scan ?? 0) : "-"; }).join(".")}|E${elevN}|B${base ? 1 : 0}`;
		},
		// 静穏窓フック（裁定2026-08-12）＝書き終わり直後の一拍で「残り台本に出ない」常駐区を降ろす（上の trim 参照）
		onQuiet: views => meshMgr.trimForScript(views),
		prefetchViews: meshMgr.prefetch, finale: japanFit, signal: ac.signal, zoomMin: CAM_ZOOM_MIN, ...opts });   // 手綱を掴む＝ドロップ/?scene= は playScene→demoHandle.start(落とした台本, bare) で別入り口再生（▶=組み込みは壊さない）。glidePath＝via連続ドリー／fadeView＝黒挟み遷移（fadeBusy を着地待ちに乗せる）
	return scenes.demoHandle;
});
// tip（カーソル追従の吹き出し）を既定搭載＝gint 層のホバー識別を指先へ。搭載はここ一箇所（dropFile/14条どの経路でも効く）。
// 見えない div＝gint interactive 層をホバーした時だけ内容が出る＝非gintの埋め込みでは無害。
gint.hoverTip = map.gadget.tip();
// ── 世界帯の中身（opts.worldContent・2026-09-24）＝低ズーム（z<BASEMAP_MINZOOM）に Equal Earth と同じ情報：州境・係争地・市街地・道路・鉄道・
// 湖の岸線・国名・首都/都市・空港（規則と配色は ortho-core の正本 worldcontent/worldstyle＝equal・world と共有・データも同じ bucket を同じキャッシュ名で）。
// 本人「equal に入れた追加情報は最終的に globe に同じ情報を入れるため」＝まず日本を持たない globe（z8 まで）から。japan（z6.5〜8 は基図と重なる）は後日
if (opts.worldContent && WORLD_VT) {
	worldContentH = createWorldContent({ addGint: gint.addGint, geopbf, symbols: (src, layer) => map.gadget.symbols(src, layer), addImage: map.addImage,
		getZoom: () => cam.zoom, lang: getLang(), worldStyle: () => WORLD_STYLE_THEMES[themeName] || WORLD_STYLE_THEMES.mono,
		bandZ: BASEMAP_MINZOOM, lowMem: LOW_MEM, requestDraw: () => { needsDraw = true; }, groups: opts.worldContent?.groups ?? null });
	map.on("settle", () => { if (!flying) worldContentH.update(); });   // 止まるたび＝見える帯に入った群だけ取りに行く
	map.on("load", () => worldContentH.update());                          // 初回の描画（起動時の視点が確定した後）でも判定＝動かさなくても detail が来る
	worldContentH.update();
	dbgHost.__worldContent = () => worldContentH.state();   // 検定窓（t-worldcontent）
}
// 地域パックが起動後に足す物（e-Stat 小地域＝map.estat 等・LAYERS.md 段階 2 S3）。ホストの内部でなく拡張面（hostEnv）だけを渡す
const hostEnv = { opts, renderer, cam, size, dpr, requestDraw: () => { needsDraw = true; }, overlay, spawnWorker: hostWorker, ownTip, hooks: hostHooks, t, dbg: dbgHost, onDestroy: f => hostDestroy.push(f) };
for (const r of REGIONS) if (r.install) await r.install(map, hostEnv);

return map;
}
