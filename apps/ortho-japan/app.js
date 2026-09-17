// ortho-japan PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
// 意匠：quiet-mono（トークン→部品）→ app固有 の順に import＝カスケードの序列そのまま
import "quiet-mono/tokens.scss";
import "quiet-mono/components.scss";
import "./style.scss";
import {
	evalExpr, parseRGBA, cameraState, project, unproject, buildGeoJSONOverlay,
	createFlight, shortBearingOf, parseViewHash, buildViewHash, wrapLon, createInput, WORLD_PX, lonLatToTile,
	primeVerticalRadius, setEllipsoid, worldRadiusM, worldToLonLat,
} from "ortho-core";
import { createGeopbf, geopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
import { createGetHeight, setApiUrl as setAltApiUrl } from "altpbf/loader";
import { JP_REGION } from "./jp/region.js";   // 地域宣言＝その国の知識の正本（エンジンと altpbf は地域を知らない）
import { NL_REGION, nlEntry } from "./nl/region.js";
createGeopbf("https://api.ortho-earth.com", { bucket: nativeBucket });   // bucket 基盤（標高と同じ）。読み出しはキー不要・bucket=native-bucket注入（geopbf自体は依存ゼロ化 8/21）
// SDK 公開面：初期化済みの geopbf を再エクスポート（2026-09-10・npm 利用者が別途 `npm i geopbf` せず、バンドラも import map も無しで
// データを載せられる＝同梱の worker チャンクがそのまま動く）。createGeopbf は出さない＝利用者が呼び直すと上の bucket 設定ごと
// アクティブインスタンスが差し替わる（同一モジュールのグローバル）ため。型は sdk/ortho-japan.d.ts。
export { geopbf };
import { MAP_THEMES } from "./palettes.js";
import { createThemes, defaultLayerState, isFacility, isTerrain, CHOME_MINZOOM, CHOME800_MINZOOM, RAILTR_MINZOOM } from "./themes.js";
import { createOverlay } from "./overlay.js";

// planets.js / skynames.js は z<4（星空）でしか使わない＝初期バンドルから外し、下の ensureSkyMod で動的読込。
import { createPipeline, pmtilesInfo } from "ortho-core";
import { pmLayers, pmRoles } from "./style-pm.js";   // ?pm= の層名→役割→描画規則（静的import＝?pm= を使わない構成でも数百バイト）
import { sanitizeHTML } from "geopbf/sanitize";   // ?pm= のアーカイブが宣言する出典 HTML は非信頼入力＝出力境界で消毒   // tile/scene worker のスポーンごとエンジン側
import { createPlateauManager } from "./plateau/manager.js";   // 建物3D（PLATEAU）の管理＝表示判定・ロード順・常駐予算・遠景・先読み（app からは配線だけ）
import { createGintLayers } from "./gint/layers.js";   // gint（知性の層）＝単一スロット・多層・admin0・bake-ahead・ドレープ・fid 塗り（同）
import { createSkyTheater } from "./sky/theater.js";   // 星空劇場（z<4）＝星・惑星・月・星座・日時計・太陽系圏との交代（同）
import { createN02Overlay } from "./rail/n02.js";   // N02 新幹線オーバーレイ＝路線＋駅のビーズ（同）
import { mountGadgets } from "./gadgets/mount.js";
import { dockStack } from "./gadgets/stack.js";   // 左下ドック（座標計器・読込トーストの容れ物＝重なりの構造的排除）
import { search as searchGadget } from "./gadgets/searchbox.js";
import { hint as hintGadget } from "./gadgets/hint.js";
import { compass as compassGadget } from "./gadgets/compass.js";
import { solar as solarGadget } from "./gadgets/solar.js";
import { plateau as plateauGadget } from "./gadgets/plateau.js";
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
import { profile as profileGadget } from "./gadgets/profile-stub.js";   // 玄関スタブ＝ボタン常駐、本体(profile.js＝断面図：経路指定+標高サンプル+グラフ)は初回クリックで import()
import { shot as shotGadget } from "./gadgets/shot-stub.js";   // 玄関スタブ＝デスクトップのみボタン常駐、本体(shot.js＝層合成/webp/出典焼込)は初回クリック/⌘Sで import()。モバイルは stub が即return＝本体も fetch されない
import { qr as qrGadget } from "./gadgets/qr-stub.js";   // 玄関スタブ＝ボタンだけ常駐、本体(qr.js＋自作QRエンコーダ qrcode.js 14KB)は初回クリックで import()＝初期バンドルから隔離
import { japan as japanGadget } from "./gadgets/japan.js";
import { print as printGadget } from "./gadgets/print-stub.js";   // 本体(print.js)は初回起動時にimport()＝初期バンドルから隔離
import { close as closeGadget } from "./gadgets/close.js";
import { dropFile as dropFileGadget, gunzipText } from "./gadgets/dropfile.js";
import { edit as editGadget } from "./gadgets/edit.js";   // 編集ボタン（本体は gadgets/geoedit の遅延chunk＝これは入口だけ）   // dropfileは起動時常駐（ドロップ受付）＝静的一本。gunzipTextもここから（動的importと混ぜるとチャンク分割が死ぬ）
import { demo as demoGadget } from "./gadgets/demo-stub.js";   // 玄関スタブ＝同期ファサードを即返し、本体(demo.js＝再生エンジン)は搭載時に import()＝初期バンドルから隔離
import { parseScenes } from "./demo/scene-adapter.js";   // 共有シーン台本(type:"scenes")→ demo プレーヤー受け渡しの純関数（ドロップ/?scene= 再生／将来のエディタで共有）
import { buildSceneTimeline } from "./demo/scene-timeline.js";   // 台本→総タイムライン（時刻評価・純関数）＝スクラブの芯（map.sceneTimeline が env と画面適用を束ねる）
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
//   opts.plateau＝建物3D（PLATEAU）機能スイッチ（true=[既定]／false=カタログ・worker・自動ロード・ガジェットごと停止）
//   opts.maxPitch＝チルト上限rad（0=俯瞰固定。geoedit等の編集アプリ用。未記述=既定MAXPITCH＝従来どおり）
//   opts.theme＝配色テーマの固定（"dark"等の台帳名＝焼き付け・URLに書かない／台帳と同形のオブジェクト＝カスタムテーマ）。
//     未記述＝共有URLの c=<name> で選択（既定 mono＝白地図。台帳は palettes.js）
//   検索・操作説明はオプトインガジェット＝ map.gadget.search() / map.gadget.hint() で画面ごとに追加（v1 ortho-map の作法）
// ============================================================================================
export default async function orthoJapan(opts = {}) {
// この入口で有効な地域宣言（**使う所より前で決める**＝render worker の init が最初の利用者・TDZ の轍 2026-09-17）。
// オランダは**日本に足す**形＝?nl=1 のまま日本へ飛べば日本の建物も出る
// （移設 2026-09-17 でこの振る舞いは変えていない）。中身は jp/region.js と nl/region.js が持つ。
const nlMode = nlEntry();                                            // "only"=/nl/（独立）／"with-jp"=?nl=1（重ね）／null=日本
const nlOn = !!nlMode;
const REGIONS = nlMode === "only" ? [NL_REGION] : nlMode === "with-jp" ? [JP_REGION, NL_REGION] : [JP_REGION];
const REGION_DTM = REGIONS.find(r => r.dtm)?.dtm ?? null;            // 裸地標高の申告（今は日本だけが持つ）
const REGION_SETS = REGIONS.flatMap(r => r.buildings?.sets ?? []);   // その場で配る建物台帳（オランダ 3 件）
const REGION_CATALOG = REGIONS.map(r => r.buildings?.catalog).filter(Boolean);   // 取得する台帳（日本の 336 件）
const REGION_EXCLUDE = REGIONS.map(r => r.buildings?.exclude).filter(Boolean);   // 除外タイル表
const REGION_LANDMARK = REGIONS.map(r => r.buildings?.landmarks).filter(Boolean);   // ランドマークの名札
const REGION_ATTR = REGIONS.map(r => r.attribution).filter(Boolean);   // 出典（表示義務）＝入口ごとに差し替わる
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
	console.warn(`[ortho-japan] borrowing container id "${mapElPrevId}" -> "map" (furniture standard). `
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
// デバッグ手（__cam / __coast / __plateau …）の宿主。自前ページのコンソールから叩く道具を窓に生やすが、
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
const BASE_SOURCE = PM_URL ? {
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
if (typeof opts.theme !== "object" && !MAP_THEMES[themeName]) console.warn(`[theme] unknown theme "${themeName}" = starting as mono (valid: ${Object.keys(MAP_THEMES).join(", ")})`);
let theme = typeof opts.theme === "object" ? { ...MAP_THEMES.mono, ...opts.theme }   // カスタム＝mono を土台に部分上書き
	: (MAP_THEMES[themeName] || MAP_THEMES.mono);
let style = theme.style;
// 旧・世界層前置（withWorld＝world-water 湖タイル層）は撤去（2026-09-03 湖のNE化）＝style はテーマの素のまま。
// 湖の色は worldPal.sea をレンダラが直接読む（u_seaC と単一の出所＝テーマの worldHypso.sea が両方へ届く）。
mountGadgets(mapEl, { chips: opts.chips, instruments: opts.instruments, fixedLayers, attribution: REGION_ATTR });   // UI を #map に生やす＝以降の getElementById が実体を掴めるよう、全lookupの前で
// 非搭載（chips:false / instruments:false）でも配線コードは無改造＝繋ぎ先が無ければ宙のdiv（どこにも描画されない）へ。
const orDetached = el => el || document.createElement("div");
const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = orDetached(document.getElementById("log"));
// 低メモリ端末判定：deviceMemory は Chrome系のみ（≤4GB＝スマホ帯）。iOS/iPadOS Safari は非対応だが
// タブ1枚あたり ~1-1.5GB でOSが強制終了（落ちて自動リロード）するため、タッチ端末は一律低メモリ扱い。
// 誤検知側の被害は「同時2区・キャッシュ縮小」だけ＝安全側に倒す。renderWorker（R10キャッシュ縮小）と
// plateau worker（キャッシュ0・バッチ縮小）の両方に配るため、worker生成より前＝ここで定義。
const LOW_MEM = navigator.deviceMemory ? navigator.deviceMemory <= 4 : navigator.maxTouchPoints > 1;
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

// --- 初見が死なない：起動できない環境・壊れた環境を白画面でなく言葉で受け止める ---
// reload=true で「再読み込み」ボタン付き。fatal は紙色の全面＝地図の世界観のまま静かに伝える。
function fatalOverlay(title, detail, reload) {
	const d = document.createElement("div");
	d.id = "fatal";   // スタイルは style.css（#fatal）。最後に起きる事件＝最後の append＝DOM順で最上面
	d.innerHTML = `<div class="fatal-box">
		<div class="fatal-title">${title}</div>
		<div class="fatal-detail">${detail}</div>
		${reload ? `<button class="fatal-reload" onclick="location.reload()">${t("Reload")}</button>` : ""}</div>`;
	mapEl.appendChild(d);
	return d;
}
// 起動不能時の静かな退場：案内オーバーレイを出した後、呼び側（site.js / SDK 埋め込み）には「何もしない地図」を
// 返す。旧・throw は未捕捉例外＝呼び側の then 連鎖ごと死に、site の boot カバーも畳まれない（Chrome の
// ハードウェアアクセラレーション off で「エラーを吐いて落ちる」実測 2026-09-02）。Proxy＝map.gadget.search() の
// ようなどんな連鎖・呼び出しも無害に自分を返して空転する（then だけ undefined＝await が即解決する約束）。
const deadMap = () => {
	const stub = new Proxy(function () {}, {
		get: (_, k) => k === "then" ? undefined : (k === Symbol.toPrimitive || k === "toString") ? () => "" : stub,
		apply: () => stub,
		set: () => true,
	});
	return stub;
};
// 対応判定：このアプリの土台は WebGL2 ＋ OffscreenCanvas（GL を worker に置く設計）。無い環境では静かに案内して止まる。
// 「非対応」の確実な判別器は transferControlToOffscreen の欠落だけ（これを持つ世代のブラウザは全て WebGL2 対応）。
// webgl2=null 単独は非対応と断定できない：GPUプロセスのクラッシュ直後（OOM→contextlost の自動リロード直後）は
// 対応ブラウザでも一時的に null を返す＝以前はここで「ブラウザ非対応」と誤診して行き止まりになっていた（M1実機で発生）。
// → 復帰を10秒リトライ（クラッシュ直後は1〜数秒で戻る）。復帰すればそのまま起動続行、ダメなら環境向け案内＋再読み込み。
let gpuRenderer = "";   // GPU 素性の文字列（下の MID_TIER 判定用）。probe の使い捨てコンテキストから同乗で頂く
{
	const probeGL = () => {
		const g = document.createElement("canvas").getContext("webgl2");
		const dbg = g?.getExtension("WEBGL_debug_renderer_info");   // 専用コンテキストは新設しない＝この判定用の1枚に相乗り
		if (dbg) gpuRenderer = g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "";
		g?.getExtension("WEBGL_lose_context")?.loseContext();   // 判定用コンテキストは即返却（スロットを食い潰さない）
		return !!g;
	};
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
// --- 非力デスクトップ・ティア（MID_TIER）：メモリ天井の低い機体を見抜いて PLATEAU の山を半分にする ---
// 2026-08-03 実測：Windows10 / i7 / 16GB / 内蔵HD Graphics / HDD が、コールド（キャッシュ無し）の PLATEAU 表示で
// タブごと落ちた。既定値（同時4区・常駐1.2GB・worker4本・worker内cache 2区/本）は Apple の 16GB ユニファイド機で
// 調律したもので、コールド時のピークは 16GB 機で renderer 12.3GB という自前実測がある（下の bldCap のコメント）。
// なぜ deviceMemory で見抜けないか：Chrome の deviceMemory は 8 が上限＝16GB機も64GB機も 8 を返す。
// LOW_MEM（≤4GB＝スマホ帯）は素通りし、非力な 8〜16GB デスクトップだけが素の既定値を浴びる。
// 代わりの signal＝GPU の素性：内蔵GPU（Apple 以外）は VRAM がシステムRAMの取り分＝PLATEAU の常駐・過渡と
// 同じ財布を食う（Apple のユニファイドは同じ物理RAMでも OS がまとめて面倒を見る＝別枠扱いしない）。
// 不明（文字列マスク環境）は現状維持側＝回帰を出さない。?mid=1 / ?mid=0 で手動上書き（実機A/Bの戻し口）。
// もう一つの穴＝**RAM の多いスマホ**：LOW_MEM は deviceMemory ≤4 だけなので、8GB の Android（入門機でも
// 「8GB+仮想4GB」を謳う機種が普通にある）は LOW_MEM を素通りして**デスクトップ扱い**になっていた
// （4区・1.2GB・worker4本）。タブ予算はデスクトップより遥かに小さい＝最低でも非力機ティアへ落とす。
// 判定は coarse ポインタ×タッチ＝スマホ/タブレット（タッチ対応ノートPCは主ポインタが fine ＝巻き込まない）。
const MOBILE_UA = navigator.userAgentData?.mobile === true || (matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 1);
const MID_TIER = /[?&]mid=1/.test(location.search) || (!/[?&]mid=0/.test(location.search) && !LOW_MEM && (
	MOBILE_UA ||                                                            // RAM の多いスマホ/タブレット（LOW_MEM を素通りする層）
	(navigator.hardwareConcurrency || 8) <= 4 ||                            // 4コア以下＝worker4本を養えない
	(/\bintel\b/i.test(gpuRenderer) && !/\barc\b/i.test(gpuRenderer)) ||    // Intel HD/UHD/Iris/Xe＝内蔵（Arc は独立GPU＝対象外）
	/\bvega\b|radeon\(tm\) graphics/i.test(gpuRenderer) ||                  // AMD APU の内蔵GPU
	/swiftshader|llvmpipe|basic render/i.test(gpuRenderer)));               // ソフトウェアラスタ＝論外に非力
if (MID_TIER) console.log(`[boot] mid-tier device = PLATEAU to safe side (gpu="${gpuRenderer || "unknown"}" cores=${navigator.hardwareConcurrency || "?"})`);
// ハイスペック判定（初の「上へ伸ばす」側のtier）：deviceMemory は 8 が上限＝16GB機も64GB機も同じ顔（上のコメント）
// なので、コア数≥12 を物差しにする。効くのは PLATEAU のロード並行度だけ（fast枠3区・タイル並行16）＝描画系は不変。
// 過渡メモリの根拠は bldCap のコメント参照。?hi=0 が逃げ道・?hi=1 で強制（弱い機でのA/B用）。
const HI_TIER = /[?&]hi=1/.test(location.search) || (!/[?&]hi=0/.test(location.search) && !LOW_MEM && !MID_TIER && (navigator.hardwareConcurrency || 0) >= 12);
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
let memTerrain = 0, memHeap = 0, memGpu = null;   // render worker から届く terrain LRU バイト・JS ヒープ・GPU固定常駐概算（?hud=1 時のみ更新）
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
const gpuBackend = !forceGl2 && "gpu" in navigator && (/[?&]gpu=1/.test(location.search) || (!IS_ANDROID && !nogpuMark && nogpuN < 2));
// フォールバック起因の GL2（＝WebGPU が使えるはずの環境で印により落ちている）だけチップを出す。
// Android 既定 GL2・?gl2=1・navigator.gpu 無しの「設計どおり GL2」には出さない（ノイズにしない）。
const gl2Fallback = !forceGl2 && "gpu" in navigator && !IS_ANDROID && !gpuBackend;
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
renderWorker.postMessage({ type: "init", ctrlPort: ctrlChan.port2, canvas: offscreen, labelCanvas: labelOffscreen, elevBase: TERR_EXAG / EARTH_M, terrainExag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com", scenePort: sceneChan.port2, noMultiDraw, perf: perfLog, mem: hudOn, lowMem: LOW_MEM, noMixed: noMixedR01, noFarTerr, dtm: REGION_DTM, noBld: /[?&]nobld=1/.test(location.search), gpu: gpuBackend, noTQ: /[?&]notq=1/.test(location.search), noGint: /[?&]nogint=1/.test(location.search), noGintSB: /[?&]gintsb=0/.test(location.search), noFade: /[?&]nofade=1/.test(location.search), msaa1: MSAA_OFF, msaa4: MSAA_PIN, drawHud: drawHud, stay: /[?&]stay=1/.test(location.search), noTerr, ell: ELL_ON }, [ctrlChan.port2, offscreen, labelOffscreen, sceneChan.port2]);
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
// 印刷（平面図）撮影中の抑止フラグ：autoPlateau/settle保存を止める。描画は noTerrain にしない＝
// 標高アトラスは生かす（真俯瞰 pitch0 なので elevScaleEff=0＝地形サーフェス/陰影/変位は自然に消え、
// 等高線(ベクタ)だけが敷かれた厳密な正射平面図になる）。noTerrain にすると等高線もアトラスごと消えるので不可。
let printHold = false;
// gint 多層（map.addGint）の台帳＝onmessage ルーティングより先に宣言（boot 中の遅着メッセージ TDZ 回避）
let gintLayerSeq = 0;
const extGint = new Map();   // layer id → handle（identify/click/ack ルーティング先）
let extActive = null;        // カーソルを持つ追加層の id（null＝既定層＝従来ゲート）
const mapOn = { click: [], move: [], load: [], plateau: [], settle: [] };   // settle＝カメラ静止（onMove の 150ms 無音）＝ツアー/オーバレイの「止まった」合図（2026-09-11）   // map.on の登録簿（§4: click=hits 同型／move=カメラ更新／load=frame1／plateau=建物3D の読込合図）
// map.on("plateau")：{phase:"catalog",count} → {phase:"start"|"done"|"cancelled"|"failed", name(区名), base(URL)}。旧＝コンソール文字列しか合図が無く
// 埋め込み側が console.log をフックしていた（SDK ドッグフード 2026-09-10）。
const emitPlateau = e => { for (const cb of mapOn.plateau) { try { cb(e); } catch (err) { console.error("[map.on plateau]", err); } } };
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
		if (gint.estatTipOwn) return;   // 町丁目tipが所有中＝gint側のackでtipを消したり上書きしない（正着は毎moveのhovertipが再設定）
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
	if (d.type === "frame1") {
		clearTimeout(bootT); bootT = null; dbgHost.__backend = d.backend || "webgl2"; sessionStorage.removeItem("oj.ctxlost");   // 初描画成功＝自動リロード回数もリセット。__backend＝スモークテスト用（webgl2/webgpu）
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
	if (d.type === "mem") { memTerrain = d.terrain || 0; memHeap = d.heap || 0; memGpu = d.gpu || null; memFps = d.fps ?? memFps; memFrameMs = d.frameMs ?? memFrameMs; memRes = d.res ?? memRes; memBackend = d.backend || memBackend; memGpuName = d.gpuName || memGpuName; return; }   // ?hud=1：render worker からのメモリ台帳＋描画実測（HUD が合算・表示）
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
let attrZone = null, attrJPHTML = null;   // 出典（#attr）の圏＝"jp"|"world"|"sky"（render() が z 跨ぎで一枚を差し替え＝各ズーム統合 2026-09-03）
// 日本固有（GSI基図）の出番：従来5。世界下地（ハイプソ＋admin0国線）がある ?world=1 は 6.5 から
// （本人裁定 2026-08-31「下地ができたので日本固有はz>6.5でいい」）。標高はz5.5からR10（terrain.js・
// 旧6.5＝9/2裁定でハイプソ帯の海岸ギザ根治）＝GSI入場前にハイプソが精細化して受け渡す。
// 星空・星座・太陽系の門は別（STARSKY_Z＝従来の5のまま）。
const BASEMAP_MINZOOM = WORLD_VT ? 6.5 : 5;
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
// opts.plateau=false＝建物3D機能ごと停止：カタログ・workerプール・自動ロード・データ管理ガジェットの全部
//（1地区あたり数十〜百MB級の重い機能＝軽い埋め込みが丸ごと切れる口。UIのchips/instrumentsと対になる機能側スイッチ）。
const plateauOn = opts.plateau !== false && !/[?&]nopl=1/.test(location.search);   // ?nopl=1＝建物3D層別切り（iOS診断）
// 登録簿の取得＝地域宣言の合成（catalog の JSON＋地域が直書きする set）。到着後の裁き（合図・自動ロード・失敗の扱い）は plateau/manager.js（env.catalog）。
const plateauCatalog = !plateauOn ? null :
	Promise.all(REGION_CATALOG.map(name => fetch(ASSET_BASE + name).then(r => r.json()))).then(lists => {   // BASE_URL＝サブパス配信(/ortho-japan/)対応
		let sets = lists.flat();
		if (REGION_SETS.length) { sets = sets.concat(REGION_SETS); console.log(`[plateau] added ${REGION_SETS.length} set(s) declared by region ${REGIONS.map(r => r.code).join("+")}`); }
		return sets;
	});
// 空港マーク台帳：optbv の空港名注記(441)は z11 以上のタイルにしか無い＝低ズームでは
// scripts/airports-build.mjs で全国収穫した静的リスト(86空港)から「マークだけ」を注入する（本家地理院地図Vectorの見え方に合わせる）。
// z11+ はタイル注記が✈＋名称を描くので、静的分は同名をスキップ＝二重表示なし。鉄道チップのON/OFFは filterLabels(441) がそのまま効く。
const AIRPORT_MARK_MAXZ = 13;              // これ未満のズームで静的マークを注入
let airportMarks = [];
fetch(ASSET_BASE + "airports.json").then(r => r.json()).then(list => {
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
// ── POI台帳（施設の点・z14+）＝uploader で焼いた poi/14/x/y を「寄った時だけ」読み、rank で解禁（docs/poi-ledger.md §11）。
// landmark 名札と同じ経路に相乗り：施設チップの傘（9xxx 合成コード＝isFacility 真）・現テーマ色・案A で同名 dedup。
// アイコン化は後段＝まず名札で「見える」を取る。線/面/地名/交通は optbv のまま（施設の点だけ自前台帳）。
const POI_CODE = 9102;                                         // landmark(9101) の隣。9xxx 帯は空き＝施設チップ傘下に自動で入る
const POI_SRC_ANNO = 1;                                        // 出典の pos-src=注記＝権威位置（基図を上書きしてよい）＝schema.SRC.ANNO
const poiZAppear = rank => 14 + (255 - rank) * 3 / 255;        // rank 大＝早く出る（255→z14 / 中位→z15 / 小→z17）＝§11.5 の解禁段
const poiTiles = new Map();                                    // "x/y" → 地物配列 ／ "loading" ／ []（POI 無しタイル）
const POI_API = "https://api.ortho-earth.com";                     // bucket API 基底（poiedit の書込は native-bucket がこの面へ）
const POI_BASE = POI_API + "/bucket/GIS/pbf/";                     // POIタイル/マニフェストのバケツ基底（自前fetch＝geopbf名前解決を通さない）
const POI_OVR_NAME = "poi/overrides.json";                         // 手差分の器（正典名＝uploader schema.OVR_NAME と同値・境界規約で複製）
const POI_BUST = Date.now();                                   // セッション毎の一意値＝マニフェストのHTTPキャッシュ回避／未整備時のフォールバック版
let poiVer = 0;                                                // タイル到着ごとに ++＝labelGate が拾ってラベルのみ再構築（merge なし）
let poiManifest = null, poiManReq = null, poiManState = "none";   // マニフェスト {v,tiles:Set,baked:Set}＋状態(none/loading/loaded/absent)。解決前はタイル要求しない（race404防止）
const poiLog = /[?&]poilog=1/.test(location.search);           // ?poilog=1＝POI層の診断（在庫/表示/rank待ち/基図重複/上書き）
const poiAll = /[?&]poiall=1/.test(location.search);           // ?poiall=1＝rank解禁と dedup を無効化＝全POIを z14+ で出す（評価用）
// 自前fetch：404を例外でなく「空(null)」として静かに返す（geopbf(name) は PBFIO が404を毎回コンソールに吐く＝
// 空タイルの海で洪水になる）。bucketは生gzipで返す（Content-Encoding無し）＝自前gunzip。返り＝Uint8Array／null。
async function poiFetch(url) {
	const r = await fetch(url);
	if (!r.ok) return null;
	let buf = new Uint8Array(await r.arrayBuffer());
	if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
	return buf;
}
// タイル在庫マニフェストを一度だけ取得。無ければ（未焼き/旧焼き）フォールバック＝bbox全スキャン（自前fetchなので404は静か）。
function loadPoiManifest() {
	if (poiManReq) return poiManReq;
	poiManState = "loading";
	return poiManReq = poiFetch(`${POI_BASE}poi/14/index.json?_=${POI_BUST}`).then(buf => {
		if (buf) { const j = JSON.parse(new TextDecoder().decode(buf)); if (j?.tiles) { poiManifest = { v: j.v, tiles: new Set(j.tiles), baked: new Set(j.baked || []) }; poiManState = "loaded"; if (poiLog) console.log(`[poi] manifest ${j.tiles.length} tiles v${j.v}, baked-in overrides ${poiManifest.baked.size}`); } }
		if (poiManState !== "loaded") poiManState = "absent";   // 無し/壊れ＝フォールバック（bboxスキャン）
		poiVer++; needsDraw = true;                            // 解決＝loadPOI を回して在庫ゲート/スキャン開始
	}).catch(() => { poiManState = "absent"; poiVer++; needsDraw = true; });
}
// ── §12 手差分（サーバー正本 poi/overrides.json）＝ベクターファイル(タイル)と分離した bucket 管理（本人裁定2026-08-10）。
// 表示は実行時パッチ＝タイル在庫の上へ即座に被せる（焼き直し待ちにしない・編集ガジェットの setPoiOvr でも即反映）。
// 意味論の正典＝uploader/src/poi/schema.js applyOverrides（match=名前完全一致∧300m最近傍・id昇順fold・
// moveは pos-src を手管理へ）。ここはその実行時版（表示形 {anchor,n,r,s}）＝tests/t-poioverrides.mjs が同値を機械検証。
const POI_SRC_MANUAL = 3;                                      // 出典 pos-src=手管理（編集）＝権威位置（schema.SRC.MANUAL）
const poiOvrDist = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(b[1] * Math.PI / 180), (a[1] - b[1]) * 111320);
function applyPoiOvr(list, ovrRecs, tileLoaded) {
	const out = list.map(p => ({ ...p }));   // コピー＝poiTiles のキャッシュを壊さない
	for (const o of [...(ovrRecs || [])].sort((a, b) => a.id - b.id)) {
		if (o.op === "add") {   // 追加＝手管理の権威点。読み込んでいる z14 タイル圏だけ出す（全国の add を毎回積まない）
			if (!tileLoaded || tileLoaded(o.ll)) out.push({ anchor: o.ll, n: o.n, r: o.r ?? 120, s: (POI_SRC_MANUAL << 4) | POI_SRC_MANUAL });
			continue;
		}
		let bi = -1, bd = 300;
		for (let i = 0; i < out.length; i++) {
			if (out[i].n !== o.n) continue;
			const d = poiOvrDist(out[i].anchor, o.ll);
			if (d < bd) { bd = d; bi = i; }
		}
		if (bi < 0) continue;   // 対象なし（焼き込み済/未ロード地域）＝no-op＝冪等
		if (o.op === "del") out.splice(bi, 1);
		else if (o.op === "move") { out[bi].anchor = o.to; out[bi].s = (POI_SRC_MANUAL << 4) | (out[bi].s & 0x0F); }
		else if (o.op === "rename") out[bi].n = o.to;
	}
	return out;
}
let poiOvr = null, poiOvrReq = null;   // {v,seq,recs}＝サーバー手差分（編集ガジェットが setPoiOvr で差し替え）
function loadPoiOverrides() {
	if (poiOvrReq) return poiOvrReq;
	return poiOvrReq = poiFetch(`${POI_BASE}${POI_OVR_NAME}?_=${POI_BUST}`).then(buf => {   // 未作成(404)＝null＝静かに
		if (!buf) return;
		poiOvr = JSON.parse(new TextDecoder().decode(buf));
		if (poiOvr?.recs?.length) { poiVer++; needsDraw = true; if (poiLog) console.log(`[poi] overrides ${poiOvr.recs.length} recs v${poiOvr.v}`); }
	}).catch(() => {});
}
// ロード済み全タイルの地物＋手差分パッチ＝表示とガジェット（対象選択）の共通フィード。
// 焼き込み済みレコード（manifest.baked）は適用しない＝del/move が同名近傍の別施設を最近傍matchで
// 誤爆する「再発火」を封じる（schema.js の⚠・t-poioverrides.mjs が検証）。タイルとbakedは同じ
// マニフェスト便で届く（タイルURLは ?v=版）＝新旧が食い違わない。
function poiPatchedAll() {
	const feats = [];
	for (const fs of poiTiles.values()) if (Array.isArray(fs)) feats.push(...fs);
	if (!poiOvr?.recs?.length) return feats;
	const recs = poiManifest?.baked?.size ? poiOvr.recs.filter(r => !poiManifest.baked.has(r.id)) : poiOvr.recs;
	if (!recs.length) return feats;
	return applyPoiOvr(feats, recs, ll => poiTiles.has(lonLatToTile(ll[0], ll[1], 14).join("/")));
}
function loadPOI(cam) {
	loadPoiManifest();
	loadPoiOverrides();
	if (poiManState === "loading") return;                    // マニフェスト解決待ち＝未存在タイルへの空振り404を防ぐ（race根治）
	const [w, s, e, n] = approxViewBbox(cam);
	const [x0, y0] = lonLatToTile(w, n, 14), [x1, y1] = lonLatToTile(e, s, 14);   // 北西→(minx,miny) 南東→(maxx,maxy)
	const ver = poiManifest ? poiManifest.v : POI_BUST;       // 版でキャッシュ制御（再焼きで自動失効）／フォールバックはセッション値
	for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
		for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
			const key = x + "/" + y;
			if (poiTiles.has(key)) continue;                  // 既取得（空タイル [] 含む）＝二度と要求しない
			if (poiManifest && !poiManifest.tiles.has(key)) { poiTiles.set(key, []); continue; }   // 在庫外＝要求しない
			poiTiles.set(key, "loading");
			poiFetch(`${POI_BASE}poi/14/${key}?v=${ver}`).then(async buf => {
				if (!buf) { poiTiles.set(key, []); return; }   // 404＝空＝静かに（コンソールを汚さない）
				const pbf = await geopbf(buf, { gint: false });   // バッファ直デコード（名前解決/fetch/IDBを通さない）
				const feats = pbf?.geojson?.features || [];
				poiTiles.set(key, feats.map(f => ({ anchor: f.geometry.coordinates, n: f.properties.n, r: f.properties.r, s: f.properties.s ?? 0 })));
				if (feats.length) { poiVer++; needsDraw = true; if (poiLog) console.log(`[poi] tile ${key} loaded ${feats.length} features`); }
			}).catch(() => poiTiles.set(key, []));
		}
}
// --- 建物3D（PLATEAU）の管理＝plateau/manager.js（表示判定・ロード順・常駐予算・遠景・先読み・読込トースト・データ管理モーダル）。
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
let flying = false;                        // フライト中フラグ＝plateau.update のゲート（flyTo が立て、着地/中断で下ろす）
const plateau = createPlateauManager({
	plateauOn, device: { LOW_MEM, MID_TIER, HI_TIER, gpuBackend, hudOn, ELL_ON }, catalog: plateauCatalog,
	renderer, attachMeshPort: port => wPost({ type: "plateauPort", port }, [port]), mapEl, dbgHost, emit: emitPlateau,
	requestDraw: () => { needsDraw = true; },
	get cam() { return cam; }, get moving() { return moving; }, get flying() { return flying; }, get printHold() { return printHold; }, get elevBusy() { return elevBusy; },
	// 足元＝チルト時（pitch>20°）は画面下端中央の接地点（球外なら null）。真俯瞰では下端＝単に南＝優先の意味が無いので使わない
	footPoint: () => cam.pitch > 0.35 ? unprojectXY(size.w / dpr / 2, size.h / dpr * 0.98) : null,
	viewBbox: approxViewBbox, playingNow: () => playingNow(), flyTo: (...args) => flyTo(...args),
});
// 捨てる地物（精査で不要と裁定した gml_id）＝生経路も焼きと同じ。起動後に来ても manager が起きている worker と後から起きる worker の両方へ配る
if (plateauOn && REGION_EXCLUDE.length) fetch(ASSET_BASE + REGION_EXCLUDE[0]).then(r => r.ok ? r.json() : null).then(map => { if (map) plateau.setExcludeMap(map); }).catch(() => {});
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
let ugT = 0, ugBusy = false, ugLastD = Infinity;   // ugLastD＝直近サンプルの eye直下地表からの余裕[m]（静止時コミット用。Infinity=地上/不明）
const UG_FADE_TOP_M = 20, UG_FADE_FULL_M = -15;
function updateUnderground() {   // ~16Hz サンプラ（onMove から）：eye直下の地表との高低差→オーバーレイ不透明度
	if (!getHeight || ugBusy || performance.now() - ugT < 60) return;
	ugT = performance.now(); ugBusy = true;
	const done = (t, d) => { ugBusy = false; ugLastD = d; undergroundEl.style.opacity = t; };
	if ((cam.pitch || 0) < 0.06) return done(0, Infinity);   // 2D=地中判定なし
	const st = cameraState(cam, size.w, size.h);
	const len = Math.hypot(st.eye[0], st.eye[1], st.eye[2]);
	const [lon, lat] = worldToLonLat(st.eye);   // ★測地緯度で eye の地上位置を引く（地心緯度で直に asin すると楕円体で約10km飛ぶ＝地中フェード誤発動の根治 2026-08-15）
	const eyeAltM = (len - 1) * EARTH_M;   // eye の海抜[m]（軌道は sea-level 球なので len-1 がそのまま高度）
	Promise.resolve(getHeight(lon, lat, cam.zoom))
		.then(h => {
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
	for (const cb of mapOn.move) { try { cb({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing }); } catch (e) { console.error("[map.on move]", e); } }
	cam.center[0] = wrapLon(cam.center[0]);   // パン/回転/フライトの累積を毎移動で正規化＝float32原点相対の前提を守る（階段バグ根治）
	moving = true; needsDraw = true;
	idleCalm = false; clearTimeout(calmT);     // 動いた瞬間に「本当の静止」を取り下げ（詳細化は許可待ちに戻る）
	updateUnderground();                       // 地中フェード（非同期・10Hz＝eye直下の地表との高低差→#underground の opacity。時間フェードはCSS transition）
	gint.updateGintSlot();                                                                // gint 単一スロットを z=4 で調停（ユーザー層⇄世界海岸線）＋海岸線の遅延ロード
	sky.ensureStars();                                                                // 星空も同じ流儀＝初めて z<4 に出た瞬間に読む
	plateau.update();                                                                 // 寄る/離れるで PLATEAU を自動ロード/解放（ガードで実質タダ）
	renderer.draw(cam, { skipBase: false, skipMain: mainStale(), noTerrain: false, terrainGate: false });   // 入力の瞬間に最新camをworkerへ（全球z<4も標高の塗りは描く）。terrainGate:false＝入力中はアトラス再構築を起こさない（停止時に一回だけ）
	// 知性の層(gint)は render worker が frame 末尾に同フレーム同カメラで描く（1canvas統合＝泳ぎ・チルト opacity 手当てとも消滅）。
	clearTimeout(settleT);
	settleT = setTimeout(() => {
		for (const cb of mapOn.settle) { try { cb({ center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, hash: viewHash() }); } catch (e) { console.error("[map.on settle]", e); } }
		moving = false; needsDraw = true; commitUnderground(); wPost({ type: "gintDrawn" }); for (const hh of extGint.values()) hh._zoomReeval?.(cam.zoom); plateau.update(true); if (!printHold) saveView();   // 停止後に identify(picking)＋PLATEAU確定（settled＝ロード発火/レーン切替はこの瞬間だけ）＋ビュー保存＋地中フェード確定（止まったら地中=全黒）
		calmT = setTimeout(() => { idleCalm = true; needsDraw = true; }, 550);   // さらに550ms（停止から計700ms）＝ホイール刻みを跨いだ「本当の静止」でだけ手前詳細化
	}, 150);
	schedulePos();   // 座標読み取りもカメラに追随（rAF畳み込み＝タダ同然）
}

// データパイプライン（tile/scene worker）。実装は pipeline.js。
// tiles＝LOD管理（update/labels）、requestMerge＝結合要求（scene worker が結合→render worker へ直行）。
// 図郭外フォールバック水域：optimal_bvmap が 404 を返す提供圏外（韓国・台湾等の外国域）に、water 層の色で
// 「標高ゲート付き全面水域」を敷く（FS が標高h>0を discard＝海は地理院・陸は標高(GEBCO/R10) の管轄裁定。
// 敷かないと圏外は紙色＝l=terrain の等高線が乗ると「白い偽の陸」に見える）。z≥8・sea.minzoom(z9) ゲート共有。
style.emptySea = "water";
const { relayCtl: pipelineRelay, tiles, requestMerge, setStyle: setPipelineStyle, destroy: destroyPipeline } = createPipeline({
	style, tileUrl: BASE_SOURCE.tileUrl, requestDraw: () => { needsDraw = true; }, scenePort: sceneChan.port1, onTile, ell: ELL_ON,
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
const withPM = s => BASE_SOURCE.info?.layers?.length ? { ...s, layers: [...pmLayers(BASE_SOURCE.info, theme), ...s.layers] } : s;   // テーマ切替でも掛け直す（switchTheme が theme.style へ戻す・階調は新テーマの紙から作り直る）
if (BASE_SOURCE.kind === "pmtiles") pmtilesInfo(BASE_SOURCE.url).then(info => {
	BASE_SOURCE.info = info;   // maxZ（LOD 上限）にも即効く＝次フレームから分割が maxZoom で止まる
	// 出典：アーカイブが metadata で宣言したものを使う。**他人の置き場の HTML＝非信頼入力**につき
	// innerHTML の直前で消毒する（docs/geopbf §11 の作法・?pm=<攻撃者URL> を踏んでも script が走らない）。
	BASE_SOURCE.attrHTML = info.attribution ? sanitizeHTML(info.attribution) : null;
	attrZone = null;   // 圏を無効化＝既に "jp" に居ても次フレームで出典が差し替わる
	style = withPM(theme.style);
	setPipelineStyle(style);   // 生成層込みで再ビルド
	needsDraw = true;
	console.info(`[pm] ${info.name || PM_SPEC}  z${info.minZoom}-${info.maxZoom}  bbox ${info.bbox ? info.bbox.map(v => v.toFixed(2)).join(", ") : "global"}\n     layer -> role: ${pmRoles(info).join(" ") || "no metadata"} (ground/label are not drawn or decoded)`);
}).catch(err => console.warn("[pm] cannot read PMTiles", BASE_SOURCE.url, err));

dbgHost.__style = () => style;   // 現在の style＝検証フック（t-world：world-water 層が「無い」こと＝湖はエンジン lakes スロットへ移行済 2026-09-03）

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 75 * D2R;
let maxPitchCur = opts.maxPitch ?? MAXPITCH;   // 現在のチルト上限＝起動オプション（geoedit.html=0）を実行時に map.setMaxPitch で上書きできる（編集ガジェットの真上固定）   // 山岳ビュー(z<13)は地形が深度で自遮蔽・混成アトラスが地平線までカバー＝高チルトの根拠が揃ったので75°まで開放
const ZOOM_MAX = 20;         // 上限20＝15cm/px（正射z＝緯度フリー。精度は原点相対RTEが担保）。21でも動くが余裕を持って1段残す
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
const JAPAN_VIEW = [137, 37, 6.6];   // 列島ビュー（真俯瞰）＝既定起動＆「日本全体」ガジェットの着地点。z6.6＝デモ初景と同値（world既定化後、z<6.5は全球ハイプソ＝白地図で始まらない。9/2本人裁定「デモの初期値に合わせる」）
const cam = { center: [JAPAN_VIEW[0], JAPAN_VIEW[1]], zoom: JAPAN_VIEW[2], pitch: 0, bearing: 0, dpr };   // 既定＝列島ビュー（沖縄・小笠原には悪いが初手の構図優先。初訪問時のみ＝共有URL→前回ビューの順で下で復元）
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
else try {
	const saved = JSON.parse(localStorage.getItem(CAM_KEY) || "null");
	if (saved && Array.isArray(saved.center) && saved.center.every(Number.isFinite) && Number.isFinite(saved.zoom))
		applyCamView({ lon: saved.center[0], lat: saved.center[1], zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing });
} catch { /* 壊れた保存値は無視して既定の世界ビュー */ }
const saveCam = () => { try { localStorage.setItem(CAM_KEY, JSON.stringify({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing })); } catch { /* private mode 等 */ } };
// 現在ビュー→ハッシュ（codec は engine）。app 固有の後置トークン＝チップ状態 l=…
// 固定キー(opts.layers)はURLに書かない＝そのURLを本家で開いた人には既定が適用される（埋め込み構成を持ち出さない）。
const viewHash = () => {
	const on = FREE_LAYER_KEYS.filter(k => layerState[k]);
	if (sky.constelVisible) on.push(SKY_LAYER);   // 星座ON＝l= に sky を追加（既定OFF＝差分ありで l= を必ず書き出す）
	const changed = sky.constelVisible || FREE_LAYER_KEYS.some(k => layerState[k] !== defaultLayerState[k]);
	const extras = changed ? ["l=" + on.join(".")] : [];
	// 配色テーマ＝c=<name>（既定 mono は書かない＝素の視点はURLも素。固定(opts.theme)も書かない＝埋め込み構成を持ち出さない）
	if (!themeFixed && themeName !== "mono" && MAP_THEMES[themeName]) extras.push("c=" + themeName);
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
	// ★任意ノブ(等高線色/遠山/標高段彩)は「新テーマが持たなければ null」で必ず既定へ戻す＝前テーマの居座り防止。
	// 条件付きspreadだと未指定キーが setView のマージで残る＝例: sepia/dark の暖茶hypso が mono/gsi へ漏れて「山が茶色」になる。
	renderer.set("view", { clear, land, atmo, bldColor,
		contourColor: theme.contourColor || null,
		distColor: theme.distColor || null,
		hypso: theme.hypso || null,
		// 世界パレット＝オブジェクト丸ごと再送（前テーマのキー居座りなし・レンダラは参照変化で再解決）。
		// clim 再送は無害（両レンダラとも取得済みキャッシュで no-op）。boot（下方の初期 set("view")）と同形
		graticule: WORLD_VT,
		worldHypso: WORLD_VT ? { clim: CLIM_URL, ...(theme.worldHypso || {}) } : null });
	renderer.set("sea", { li: style.layers.findIndex(L => L.id === "water"), li2: style.layers.findIndex(L => L.id === "water-hi"), minzoom: 9 });
	renderer.set("bldFill", { li: style.layers.findIndex(L => L.id === "building") });   // 建物塗りの層添字も新styleへ（sea と同じ「li はテーマ依存」の流儀）
	themes = createThemes(style, { suppressAdmin: !!opts.hideAdminBoundary });   // ★層添字（LI_RAILHI 等）を新テーマの層配列で焼き直す＝hidden(点火ゲート)の添字ズレ根治。
	// 旧＝boot の style で一度だけ生成→テーマごとに層数/順が違い添字が全ズレ＝「チップOFFなのに rail-hi/road-hi/航路が点き、土台の道路網が消える」（本人報告・実機/本番でも再現・両バックエンド共通）
	mapEl.classList.add("ui-dark");   // 白抜き家具＝常時ON（本人裁定2026-08-05）＝テーマ生き替えでも外さない（旧＝land輝度で付け外し）
	gint.admin0Layer?.style(gint.admin0DrawStyle());   // admin0 独立層＝新テーマの coastLine で塗り直し（色の居座り根治）
	if (layerState.rail && n02.loaded) { n02.loaded = false; n02.load(); }   // N02新幹線の芯(land色)を新テーマで引き直す（データは温間）
	readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; needsDraw = true; onMove();   // 下地・主層を強制再結合（次のupdateで新styleビルド→順次merge）
}
// contourColor/distColor/hypso はテーマの任意ノブ（無指定＝renderer 既定：セピア等高線・遠山ブルー・単色陰影）
renderer.set("view", { clear, land, atmo, bldColor, showN02: false,
	...(theme.contourColor && { contourColor: theme.contourColor }),
	...(theme.distColor && { distColor: theme.distColor }),
	...(theme.hypso && { hypso: theme.hypso }),
	// 全球ハイプソ（?world=1）＝球/地形シェーダの標高×気候 cross-blend。clim＝気候場テクスチャ
	// （Köppen-Geiger/Beck et al. CC-BY を 720x360 に焼き縮め・public 資産）。theme.worldHypso で色ノブ上書き可。
	// null 明示＝居座り防止の流儀。showN02＝N02交通(新幹線等)の表示。鉄道チップで切替
	graticule: WORLD_VT,   // 10度レチクル（v1 geoGraticule10 の移植・本人指名 2026-09-01）＝シェーダ計算（z帯はレンダラ側）
	worldHypso: WORLD_VT ? { clim: CLIM_URL, ...(theme.worldHypso || {}) } : null });
// 海：水レイヤ(WA)をビュー一律にゲート＝cam.zoom<9 では描かない（＝紙の海・まだら無し）、z9+で一律点火。
renderer.set("sea", { li: style.layers.findIndex(L => L.id === "water"), li2: style.layers.findIndex(L => L.id === "water-hi"), minzoom: 9 });   // li2＝水系点火面も同じ海ゲート
renderer.set("bldFill", { li: style.layers.findIndex(L => L.id === "building") });   // 建物フットプリント塗り＝3D（チルト）時は伏せる（押し出しと二重表現のため）

// --- gint（知性の層）＝gint/layers.js（単一スロットのユーザー層・多層 addGint・admin0 独立層・bake-ahead・地形ドレープ・fid 塗り・queryAll）。
// ここは配線だけ：定数と道具を渡し、テーマは getter、多層の台帳（extGint / extActive / gintLayerSeq）は onmessage より先に宣言した
// 上のものを束ねて渡す。生成後に定義される関数（flyTo / loadBelowSea / loadLakes）はラップ＝呼ぶ時に解決。外が読み書きしていた
// 状態（hoverTip / estatTipOwn / suppressAdmin0 …）は gint.* のアクセサで同名の意味のまま。
const gint = createGintLayers({
	canvas, mapEl, renderer, wPost, dbgHost, ASSET_BASE, WORLD_VT, LOW_MEM, noGint, ZOOM_MIN, ZOOM_MAX, cam,
	get theme() { return theme; },
	layers: { map: extGint, get active() { return extActive; }, set active(v) { extActive = v; }, nextId: () => ++gintLayerSeq },
	smallAreaHover: !!opts.smallAreaHover,
	requestDraw: () => { needsDraw = true; }, onMove: () => onMove(), flyTo: (...args) => flyTo(...args), loadBelowSea: () => loadBelowSea(), loadLakes: () => loadLakes(),
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
const sky = createSkyTheater({ mapEl, renderer, dpr, cam, STARSKY_Z, solarOff, get printHold() { return printHold; }, saveView: () => saveView(), requestDraw: () => { needsDraw = true; } });
// --- N02 新幹線＝rail/n02.js（路線＋駅のビーズ・鉄道チップで点灯）。land＝紙色はテーマで差し替わる＝getter。
const n02 = createN02Overlay({ renderer, get land() { return land; }, BASEMAP_MINZOOM, requestDraw: () => { needsDraw = true; } });
// デバッグ用カメラジャンプ：__cam(lon, lat, zoom, pitchDeg, bearingDeg)。検証スクリプトやコンソールから任意視点へ。
dbgHost.__cam = (lon, lat, zoom = cam.zoom, pitchDeg = cam.pitch * R2D, bearingDeg = cam.bearing * R2D) => {
	cam.center = [lon, lat]; cam.zoom = zoom; cam.pitch = pitchDeg * D2R; cam.bearing = bearingDeg * D2R;
	onMove();
};

// 手打ちデモ：地区名(部分一致)かbase URLを指定して読み込み、カメラもそこへ寄せる（自動と違いカメラを動かす）。省略時は登録簿の先頭。
dbgHost.__plateau = async (nameOrBase, tiles) => {
	if (!plateauOn) { console.warn("[plateau] opts.plateau=false = 3D buildings feature disabled"); return; }
	const sets = plateau.sets;
	const set = !nameOrBase ? sets[0]
		: sets.find(s => s.base === nameOrBase || s.name === nameOrBase || s.name.includes(nameOrBase));
	if (!set) { console.error("[plateau] ward not found:", nameOrBase, `(catalog ${sets.length} entries)`); return; }
	await plateau.standUp(set, tiles);   // 立ち上げ（常駐ヒット＝vis戻し／未常駐＝ロード）。二重ロードは standUp 内の読込中ガードで防ぐ
	const [w, s, e, n] = set.bbox;
	cam.center = [(w + e) / 2, (s + n) / 2]; cam.zoom = 16; cam.pitch = 45 * D2R; cam.bearing = 0;   // 地区中心・傾けて建物を見る
	onMove();
	console.log(`[plateau] done -> ${set.name} z16 tilt45°. right-drag to adjust tilt`);
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
// 計測⇄断面図は排他（後から点けた方が勝ち＝クリックの行き先が常に一意・本人裁定2026-08-27）。
// 配線は登録側＝ここ（ガジェット同士は独立の掟＝相互を知らない）：setClick(非null)＝モードON の瞬間に相方の stop() を呼ぶ。
// 本体ハンドルは onBody で到着（スタブ経由の遅延 import 後）＝未ロードの相方は必然的にOFF＝何もしなくてよい。
let measureBody = null, profileBody = null;
let editClick = null;      // 派生アプリ編集モード（geoedit）中だけ非null＝同上（map.setEditClick で装着/解除）
// zoomMin の二重指定（前:ZOOM_MIN 後:2＝後勝ちで床2）を解消（2026-08-10）＝ホイール/ピンチも太陽系圏へ潜れる
const input = createInput({
	canvas, cam, size, dpr, maxPitch: maxPitchCur, zoomMin: zoomMinCur, zoomMax: ZOOM_MAX, onMove, signal: ac.signal,   // opts.maxPitch＝派生アプリのチルト上限（0=俯瞰固定＝geoedit）。??＝0を殺さない
	blocked: () => modalOpen(mapEl),   // モーダル表示中は矢印キーで背後の地図を動かさない（文字入力中は input.js が自前で判定）
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
		if (fudeOwn && gint.estatTipOwn) { gint.estatTipOwn = false; renderer.set("overlayHover", null); needsDraw = true; }   // 跨ぎ瞬間＝残った町丁目tip/太線を掃除（tip本文は直後の識別ackが上書き）
		if (!fudeOwn && opts.smallAreaHover && overlay.isEstatActive?.() && overlay.hoverAt(x, y)) return;
		if ((gint.interactive && gint.hover) || extActive) wPost({ type: "gintMove", x, y });
		// 世界ビュー＝admin0 国ポリゴンの国名 tip（本人裁定 2026-08-30「国の認識」）。識別は main 同期
		// （admin0Pbf.identifyAt＝findPolygon smallest-wins・エンジン往復なし）。面のみ探索＝点/線半径は0。
		const a0TipOn = gint.admin0Layer && gint.admin0Vis && cam.zoom < gint.ADMIN0_Z && !(gint.userGint && cam.zoom >= (gint.userGint.minZoom ?? 0));
		if (a0TipOn && gint.admin0Pbf && gint.hoverTip && !fudeOwn) {
			// z≥5.5＝国名 tip の圏外（本人裁定 2026-09-02）：基図接近帯は注記が主役＝国名の板は出さない
			if (cam.zoom >= gint.WORLD_TIP_MAXZ) { if (gint.worldTipOn) { gint.hoverTip(null); gint.worldTipOn = false; } return; }
			const ll = unprojectXY(x, y);
			const fid = ll ? gint.admin0Pbf.identifyAt(ll[0], ll[1], { point: 0, polyline: 0 }) : null;
			let name = null;
			if (fid != null) { try { const p = gint.admin0Pbf.getProperties(fid) || {}; name = p.NAME_JA || p.NAME || null; } catch (e) { /* 壊れfeature＝tipなし */ } }
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
const getHeightP = createGetHeight({ apiUrl: "https://api.ortho-earth.com", dtm: REGION_DTM, onend: () => { posElevAt = 0; schedulePos(); } });   // Promiseも保持＝断面図はローダ到着を待って照会（起動直後でも0mに化けない）
getHeightP.then(f => { getHeight = f; });
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
canvas.addEventListener("pointermove", e => { const [x, y] = evXY(e); posMouse = { x, y }; if (posOn()) posEl.style.display = "block"; schedulePos(); });
canvas.addEventListener("pointerleave", () => { posMouse = null; posEl.style.display = "none"; });
schedulePos();   // 起動直後からスケールを出す（真俯瞰復元時。マウス無しでも updateScale は走る）

// --- 球面フライト：実装は engine（flight.js＝三段振り付け＋van Wijk厳密解）。ここは配線だけ。
// onFlying＝autoPlateau のゲート（飛行中はPLATEAU完全停止・着地の瞬間に解禁＝立ち上がりが着陸の演出）。
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
let themes = createThemes(style, { suppressAdmin: !!opts.hideAdminBoundary });   // 分類（allowlist）は themes.js の純関数。
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
	+ (layerState.facility && cam.zoom >= 14 ? "P" + poiVer + "z" + Math.floor(cam.zoom * 2) : "");   // POI台帳＝タイル到着(poiVer)・半ズーム(rank解禁)で作り直す
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
	// POI台帳（施設チップON・z14+）：焼いた点を rank で解禁。同名は既存注記＋landmark に譲る（§11.2 案A＝d2 の実行時版）。
	// sort=4−rank/255＝rank 大ほど衝突に強い（§11.5 の二役）。
	if (poiTiles.size && layerState.facility && cam.zoom >= 14) {
		const { color, halo, haloW } = facInk();
		// §12 実行時パッチ：サーバー手差分をタイル在庫の上へ被せてから注入（add/move/rename/del・冪等）
		const patched = poiPatchedAll();
		// 権威位置（注記由来 s>>4=ANNO＝寺社など・手管理 MANUAL＝編集で人が置いた点）のPOI名を集め、
		// 基図の同名注記を先に消す＝POIが基図を上書き（§1 の三十三間堂 274mズレの解決＝基図の間違った位置を
		// 台帳の正しい位置で置換）。landmark/POI自身は消さない。学校(KSJ位置)は非権威＝基図に譲る（基図もほぼ正確・§2）。
		const poiAuth = s => { const p = s >> 4; return p === POI_SRC_ANNO || p === POI_SRC_MANUAL; };
		const authNames = new Set();
		for (const p of patched) if (poiAuth(p.s) && (poiAll || cam.zoom >= poiZAppear(p.r))) authNames.add(p.n);
		if (authNames.size) for (let i = allLabels.length - 1; i >= 0; i--) {
			const c = allLabels[i].code;
			if (c !== POI_CODE && c !== LANDMARK_CODE && authNames.has(allLabels[i].text)) allLabels.splice(i, 1);
		}
		const have = new Set(allLabels.map(L => L.text));   // タイル注記(上書き済)＋landmark に既出の名前は出さない（案A）
		let nAvail = 0, nShown = 0, nGated = 0, nDedup = 0;
		for (const p of patched) {
			nAvail++;
			if (!poiAll && cam.zoom < poiZAppear(p.r)) { nGated++; continue; }   // rank解禁（?poiall=1で無効）
			const auth = poiAuth(p.s);                  // 権威＝基図を消した側＝必ず出す。非権威は基図/landmarkに譲る
			if (!poiAll && !auth && have.has(p.n)) { nDedup++; continue; }        // 案A dedup（?poiall=1で無効）
			allLabels.push({ text: p.n, code: POI_CODE, anchor: p.anchor, size: 13, sort: 4 - p.r / 255, color, halo, haloW });
			have.add(p.n); nShown++;   // 別タイルの同名（同じ名の学校）も1つに
		}
		if (poiLog) console.log(`[poi] z${cam.zoom.toFixed(1)} -> shown ${nShown} / stock ${nAvail} (rank-gated ${nGated}, basemap-dup ${nDedup}, overriding ${authNames.size}, manual ${poiOvr?.recs?.length ?? 0})${poiAll ? " [poiall]" : ""}`);
	}
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
	if (k === "rail") { renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) n02.load(); }   // 鉄道ON＝N02新幹線も表示＋初回fetch
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
		const THEME_META = { mono: ["Blank map", "#f7f7f6"], dark: ["Dark map", "#171b23"], gsi: ["GSI", "#fdfdf9"], sepia: ["Sepia", "#efe6d4"] };   // スウォッチ＝各テーマの紙色近似
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
if (layerState.rail) { renderer.set("view", { showN02: true }); n02.load(); }
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
	renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) n02.load();
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
	if (basemap) {
		sampleGroundElev();   // 中心の地面標高を追随（非同期・~100m格子メモ）＝groundR の材料
		tu = tiles.update(cam, size.w, size.h, { tilePx: (moving || !gpuFast || !idleCalm) ? undefined : IDLE_TILE_PX, groundR: groundRNow(), keepFine: keepFineNow(), maxZ: BASE_SOURCE.info ? BASE_SOURCE.info.maxZoom : undefined });   // maxZ＝PMTiles 基図のときアーカイブの maxZoom で分割を止める（それ以上は最細段を引き伸ばす＝空タイル要求を作らない）   // tilePx＝「本当の静止」（settle+550ms）だけ主層を一段細かく（手前の詳細化・GPU格付け fast 限定・undefined=既定560）。groundR＝地形リフト球（チルト×高標高地の手前くさび欠け根治）。keepFine＝ズームアウトの子孫代打（3D限定）。calm が needsDraw を立て、細タイルの ready は requestDraw で連鎖再描画
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
		const zone = cam.zoom < STARSKY_Z ? "sky" : (WORLD_VT && cam.zoom < BASEMAP_MINZOOM) ? "world" : "jp";
		if (zone !== attrZone) {
			attrZone = zone;
			const attr = document.querySelector("#attr");
			if (attr) {
				if (attrJPHTML == null) attrJPHTML = attr.innerHTML;   // 日本版を初回に退避（復帰用）
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
				// 出典は文単位で組む（"出典：" + 名前 の足し算は言語で語順が壊れる＝i18n.js の掟）。$1 に列を差す
				const head = pmSrc ? pmSrc + "・" : "";
				attr.innerHTML = zone === "jp" ? (pmSrc ? t("Source: $1", pmSrc) + tail : attrJPHTML)
					: zone === "world" ? t("Source: $1", head + worldSrc) + tail
					: t("Source: $1", head + A("https://github.com/ofrohn/d3-celestial", "d3-celestial") + "・" + worldSrc) + tail;   // sky＝星図が先頭（星空劇場の主役）
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
	if (layerState.facility && cam.zoom >= 14) loadPOI(cam);   // z14+×施設ON＝POI台帳タイル(poi/14/x/y)を可視ぶん先読み（既取得は素通り）
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
const overlay = createOverlay({ renderer, cam, size, dpr, requestDraw: () => { needsDraw = true; },
	tip: name => {   // estat ホバー結果：町丁目ヒット＝町丁目名を tip へ／ミス(市区町村外)＝gint ホバーへフォールバック（他市区町村の tip/リンク）
		if (name) {
			gint.estatTipOwn = true;
			gint.hoverTip?.([name]);
			wPost({ type: "gintLeave" });   // 隣の市区町村に残った gint ホバー(太線)を消す（B→A復帰でBが光ったまま、の根治・本人報告2026-08-14）。leave は idempotent＝毎ヒットでも安価
			return;
		}
		gint.estatTipOwn = false;
		if (((gint.interactive && gint.hover) || extActive) && gint.lastHoverXY) wPost({ type: "gintMove", x: gint.lastHoverXY[0], y: gint.lastHoverXY[1] });
	} });
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
	const pl = plateau.memStats();   // 常駐（表示＋非表示）の実測バイト・区数・過渡・ティア
	const ts = tiles.stats();
	const gpu = memGpu ? memGpu.atlas + memGpu.mesh + memGpu.msaa : 0;   // GPU固定＝標高アトラス近/裏/遠＋地形メッシュ＋MSAA（webgpuのみ・GL2は暗黙確保で0表示）
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
		plateau: { bytes: pl.bytes, regions: pl.regions }, tiles: { bytes: ts.bytes, budget: ts.budgetBytes },
		terrain: memTerrain, heap: memHeap, gpu: memGpu, gpuBytes: gpu,
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
dbgHost.__loadEstat = overlay.loadEstat;
dbgHost.__tokyo = () => overlay.loadEstat(Array.from({ length: 23 }, (_, i) => 13101 + i));   // 東京23区の小地域
// 初期 overlay なし（全球 land は検証用。__tokyo() や __loadOverlay(name) で任意に）

function frame() {
	if (destroyed) return;   // destroy 後はループを再予約しない＝rAF が自然消滅
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
	plateau.terminate();                         // PLATEAU worker・デコーダ（main 所有）・見張りタイマー
	overlay.destroy();                           // e-Stat worker（createOverlay内で常時起動しているため忘れずに）
	// デバッグ手はこのインスタンスの閉包を掴んだまま＝GCの錨になるので窓から下ろす
	// 生やした名前は全て下ろす（従来は13名だけ＝取りこぼしが閉包を掴んだまま残っていた）。
	// 埋め込み時は dbgHost が使い捨ての器＝この delete は空振りするが、閉包の錨は器ごと GC される。
	for (const k of ["__arakawaFit", "__backend", "__budget", "__cam", "__admin0", "__a0", "__drawErr", "__drawHud", "__drawSendErr", "__drawSendN", "__farState", "__fly", "__gload", "__hiddenLi", "__lastOrder", "__loadEstat", "__loadOverlay", "__mergeFail", "__moj", "__mojFile", "__paint", "__paintFid", "__paintOverlap", "__paintParity", "__paintProps", "__plateau", "__plateauPurge", "__sapporo", "__standup", "__style", "__tileCache", "__tileStats", "__tokyo", "__vtPool"]) delete dbgHost[k];
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

// 呼び出し側の手綱（視点操作・飛行・描画設定）＋ガジェット登録簿（v1 ortho-map createGadgets の作法の継承）。
// map.gadget(name, func) で登録し map.gadget.name() で画面に追加する。func 内の this＝この map＝
// mapEl/flyTo 等の手綱がそのまま使える。検索・操作説明は標準装備から外した最初のオプトインガジェット。
// カメラ実位置（eye）＝透視カメラそのものの経緯度・海抜（updateUnderground と同式・cameraState の eye を球面へ戻す）。
// zoom は「注視点での倍率」＝カメラ高度ではない：チルト時は注視点の後方上空に立つ（scene エディタの参考表示用）。
const eyePose = () => {
	const st = cameraState(cam, size.w, size.h);
	const len = Math.hypot(st.eye[0], st.eye[1], st.eye[2]);
	const [eLon, eLat] = worldToLonLat(st.eye);   // 測地緯度（updateUnderground と同じ逆変換＝楕円体でも正しい eye 位置）
	return { lon: wrapLon(eLon), lat: eLat,
		altM: (len - 1) * EARTH_M, distM: st.camDist * EARTH_M,   // altM=海抜[m]（sea-level球）・distM=注視点までの実距離[m]
		fovy: cam.fovy || 50 * D2R };   // 垂直視野角[rad]（エンジン既定50°・水平は aspect 依存＝表示側で 2·atan(tan(fovy/2)·W/H)）
};
const map = { cam, flyTo, renderer, mapEl, destroy,
	// ★表示状態（共有される「単一の真実」）を map インスタンスから常時参照可能に＝viewHash が直列化するのと同じ状態。
	// center/zoom/pitch/bearing（cam）＋ theme(c=)＋ layers(l=・sky含む)＋ sky ＋ 現在の共有URL文字列(hash)。読み取り専用スナップショット。
	// eye＝カメラ実位置（緯度・経度・海抜m・注視点距離m＝参考値）。
	get view() { return { center: [...cam.center], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, theme: themeName, layers: FREE_LAYER_KEYS.filter(k => layerState[k]).concat(sky.constelVisible ? [SKY_LAYER] : []), sky: sky.constelVisible, hash: viewHash(), eye: eyePose() }; },
	// ★scene-player API（v2整備 2026-08-09）＝台本オブジェクトの直接上映（第三の入口・エディタの土台）。要 demo ガジェット搭載。
	//   playScenes(obj, {from, quick, onScene, onEnd})／stopScenes()＝停止（準備中でも安全）。正典＝demo/scene-format.md §7
	playScenes: (obj, opts) => playScenes(obj, opts), stopScenes: () => stopScenes(),
	//   sceneTimeline(obj)＝タイムライン（時刻評価・スクラブ）→ {dur, rows, at, seek, end}（再生せず任意秒の絵＝エディタ用）
	sceneTimeline: obj => sceneTimeline(obj),
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
// 元のカメラへ戻す。printHold が autoPlateau と settle保存を抑止（印刷カメラを自動ロードや保存に漏らさない）。
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
map.makeProjectorH = makeProjectorH;   // 高度付き投影（注釈の3Dピン＝チルトで立つ。annoガジェット用）
map.setEditClick = fn => { editClick = fn; };   // 派生アプリのクリック横取りスロット（null で解除＝measure/poi と同型）
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
map.userPbf = () => gint.userGint?.pbf ?? null;   // 表示中のユーザー gint（ドロップ/?g=）の geopbf＝編集ガジェットへの受け渡し口（同じデータを一手で編集へ）
map.onFrame = fn => { frameHooks.add(fn); return () => frameHooks.delete(fn); };
map.onGintClick = fn => { gint.clickHandler = fn; };
Object.defineProperty(map, "backend", { get: () => dbgHost.__backend ?? null, enumerable: true });   // "webgpu"|"webgl2"|null（frame1 前）
map.getHeight = (lon, lat) => getHeightP.then(f => f(lon, lat, cam.zoom, { wait: true })).then(h => +h || 0);   // ローダ着荷（数秒）を待ってから照会＝初期化中に 0 を返さない（旧＝未着 0。SDK ドッグフード 2026-09-10）。初期化失敗は reject
map.getZoom = () => cam.zoom;             // 現在ズーム（派生アプリのズーム連動 LOD＝集約⇄市区町村の層切替に）
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
	return searchGadget.call(this, { signal: ac.signal, ...opts });
});
map.gadget("hint", function (opts) {   // 操作説明カード … map.gadget.hint() → { open, close }。キー(?)用に signal を注入
	return hintGadget.call(this, { signal: ac.signal, ...opts });
});
map.gadget("compass", function (opts) {   // コンパス兼リセット … 内部の手綱（フライト中断・onMove）はここで注入
	const update = compassGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, signal: ac.signal, ...opts });
	if (update) { frameHooks.add(update); update(); }   // 針の追従を render のフックへ＝搭載した瞬間から現姿勢を指す
});
map.gadget("solar", function (opts) {   // 太陽系への口（ortho-solar）＝34px規格アイコン。表示域を絞るなら搭載側で opts.zoom
	return solarGadget.call(this, opts);
});
map.gadget("plateau", function (opts) {   // 建物3D（PLATEAU）データ管理 … モーダルを開く手綱はここで注入
	if (!plateauOn) { console.warn("[plateau] opts.plateau=false = feature disabled; gadget not mounted"); return; }
	return plateauGadget.call(this, { onOpen: plateau.openDb, ...opts });
});
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
		setClick: fn => { measureClick = fn; fn && profileBody?.stop?.(); },   // 計測ON＝断面図OFF（排他）
		requestDraw: () => { needsDraw = true; },
		onBody: m => { measureBody = m; if (m && m._update) { frameHooks.add(m._update); m._update(); } },   // 抽象アクセス：本体(measure.js)到着後に _update を毎フレ描画へ（frameHooks は core 側）
		...opts,
	});
});
map.gadget("profile", function (opts) {   // 断面図 … 投影/逆投影・クリック横取り・標高サンプラを注入。本体は初回クリックで import()
	return profileGadget.call(this, {
		makeProjector, unprojectXY, signal: ac.signal,
		setClick: fn => { profileClick = fn; fn && measureBody?.stop?.(); },   // 断面図ON＝計測OFF（排他）
		// 標高サンプラ＝zoom=99 固定で最良解像度（日本=R01 DEM10B 10m・海外=ALOS/GEBCOへ自動フォールバック）。
		// getHeightP 経由＝ローダ未着でも待って照会（map.getHeight の「未着=0m」縮退はグラフには不適）。
		sampleHeight: (lon, lat) => getHeightP.then(f => (f ? f(lon, lat, 99) : 0)).then(h => +h || 0),
		onBody: p => { profileBody = p; if (p && p._update) { frameHooks.add(p._update); p._update(); } },   // 抽象アクセス：本体到着後に _update を毎フレ描画へ（measure と同型）
		...opts,
	});
});
map.gadget("shot", function (opts) {   // 画面保存 … worker越しの3層+measure層を合成する requestSnapshot を注入
	return shotGadget.call(this, { requestSnapshot, signal: ac.signal, ...opts });
});
map.gadget("qr", function (opts) {   // 共有QR … 現在の共有URL(origin+path+search+viewHash＝今の視点)を注入＝スクリーン投影→スキャンでその視点を開く＝拡散
	// location.search を挟む＝アドレスバーの ?hud=1 等のフラグもQRに載る（スキャン先で同じ計器/条件が点く）。順は path→?query→#hash＝URLの正順。
	return qrGadget.call(this, { getUrl: () => location.origin + location.pathname + location.search + viewHash(), signal: ac.signal, ...opts });
});
map.gadget("japan", function (opts) {   // 日本全体へ（真俯瞰・北向き）… 着地点は既定の列島ビューを共有・⌘/Ctrl+J
	return japanGadget.call(this, { view: JAPAN_VIEW, signal: ac.signal, ...opts });
});
map.gadget("print", function (opts) {   // 印刷（平面図）… 撮影ハイジャック printCapture を注入。プレビュー→印刷/PDF。本体は初回起動時import()
	return printGadget.call(this, { capture: printCapture, signal: ac.signal, ...opts });
});
map.gadget("close", function (opts) {   // 閉じる×（埋め込み用）… ortho:close を飛ばすだけ＝閉じる実務は埋め込み側
	return closeGadget.call(this, { signal: ac.signal, ...opts });
});
// POI台帳の手差分編集（§12）＝?poiedit=1 のときだけ本体を import して搭載＝一般ビルドの死荷重ゼロ（作者用・
// 書込は bucket API key 保持者のみ）。注入＝抽象アクセス：台帳フィード getPOI（パッチ適用済＝表示と同じ景色から
// 対象を選ぶ）・手差分の読み書き getOvr/setOvr（保存成功→差し替え→poiVer++＝ラベルのみ再構築で即反映）・座標ブリッジ。
if (/[?&]poiedit=1/.test(location.search)) import("./gadgets/poiedit.js").then(({ poiedit }) => {
	setLayer("facility", true);   // 編集の舞台＝施設層を正規経路で自動点灯（チップ不在の埋め込みでも効く）
	map.gadget("poiedit", function (opts) {
		return poiedit.call(this, {
			// クリックは createInput の onClick 横取り（measure と同型）＝ドラッグ弁別は input.js が正本・
			// armed中の選択クリックが識別/星座へ素通りしない。座標は unprojectXY/makeProjector と同じ canvas CSS系。
			setClick: fn => { poiClick = fn; }, unprojectXY, makeProjector, distM: poiOvrDist,
			apiBase: POI_API, name: POI_OVR_NAME,
			getPOI: () => poiPatchedAll(), getOvr: () => poiOvr,
			setOvr: o => { poiOvr = o; poiVer++; needsDraw = true; },
			signal: ac.signal, ...opts,
		});
	});
	map.gadget.poiedit();
}).catch(e => console.error("[poiedit] load failed", e));
// ── 共有シーン台本(type:"scenes")の再生 ── 落とした .scenes（または ?scene=URL）を demo プレーヤーで自動上演する（demo/scene-format.md）。
// demo は起動時に1度マウント済み（index.html）＝その1インスタンスに load() で台本を差し替える（下の demo ラッパが手綱 demoHandle を掴む）。
let demoHandle = null;
let sceneBusy = false, sceneRun = 0;   // sceneBusy＝上映ライフサイクル中（準備〜走破〜終幕括弧）／sceneRun＝世代トークン：stopScenes が進めると準備中の再生は静かに降りる
const playingNow = () => sceneBusy || !!mapEl.querySelector("#demo-bar.on");   // 上映中判定＝▶デモ(バー点灯)もシーン再生も（上映中はドロップ禁止の裁定）
// ★scene-player API（プラットフォーム公開面・map.playScenes）：台本オブジェクトを直接上映する第三の入口（drop / ?scene= も同じ道）。
//   opts.from＝開始行／opts.quick=true＝軽い試写（黒幕・waitLoadingゲート・終幕括弧なし＝エディタの行プレビュー用）／
//   opts.onScene(i, scene)＝行の上映開始（フライト開始前＝行ハイライト用）／opts.onEnd(reason)＝どの終わり方でも1発（"finished"=走破・"stopped"=中断）。
//   戻り値＝受けたら true・上映中で受けなければ false（先に map.stopScenes()）。終演/中断/失敗のどの経路でも黒幕と上映ロックを残さない（手仕舞い一本化）。
function playScenes(obj, { from = 0, quick = false, onScene, onEnd, lang: langOpt } = {}) {
	if (playingNow()) { console.warn("[scene] already playing = rejected (call stopScenes() first)"); return false; }
	const lang = langOpt ?? new URLSearchParams(location.search).get("lang");   // 言語選択は視聴者の ?lang=（opts.lang＝エディタの字幕プレビュー用の上書き）。台本側に言語指定は無い＝既定は title の言語そのまま
	const { scenes, mobile, hold = 3, slideHold, preload, waitLoading } = parseScenes(obj);   // scene 再生の保持既定＝3秒（▶デモは5.5のまま＝発表の間合いは別物）
	if (!scenes.length) { console.warn("[scene] scenes empty = not playing", obj?.title); return false; }
	if (!demoHandle) { console.warn("[scene] demo not mounted = retry shortly (just after boot)"); return false; }   // demo は起動時に index.html が搭載済み（通常は在る）＝ ▶ と同じ実体の再生ルーチンを借りる
	sceneBusy = true;   // 解除＝終幕括弧の閉じ（returnToStart 完了）／endHook（中断・quick走破）／失敗 fallback＝どの経路でも必ず一箇所
	const run = ++sceneRun;
	const views = scenes.flatMap(s => s.via != null ? [s.via] : [s.view ?? s.glide ?? s.fade]).filter(Boolean);   // 全視点（via 通過点も込み）＝先読み対象
	const returnView = viewHash();   // ★上映前の画面（l=/c= 込みの共有URL）＝終幕の戻り先 兼 失敗時の fallback（括弧構造）
	// 終幕＝最終シーンの hold を終えたら、黒を挟んで上映前の画面へ帰る（映画の括弧＝始まった所で終わる）。上映ロックもここで解除。
	// 帰還 jump は黒の中で行い、350ms 置いてから溶明＝戻った画面の再構築（タイル敷き直し）を黒の下で始めさせる
	const returnToStart = async () => { await sceneCover(true, { fade: true }); flyView(returnView, { jump: true }); await new Promise(r => setTimeout(r, 350)); sceneCover(false); sceneBusy = false; };
	// 終演フック（demo の exit から必ず1発）：フル上映の走破は finale=returnToStart が括弧を閉じて解除＝ここは素通し。
	// それ以外（中断・quick の走破）はここで即解除＝ demoHandle.exit() 直叩きでもロックが残らない（旧バグの根治）
	const endHook = r => { if (r !== "finished" || quick) { sceneBusy = false; sceneCover(false); } onEnd?.(r); };
	if (!quick) sceneCover(true);   // ★開幕の黒幕＝jump も読み込みも隠し、開始の瞬間に fade-in（quick＝試写は儀式なし）
	Promise.resolve(demoHandle.ready).then(async () => {   // 遅延本体の到着を待ってから（起動直後の保険。通常は解決済み＝即）
		if (!quick && waitLoading && plateauOn) {   // ★読み込み待ちモード＝プリロード前提：重いデータを読み切り、都市をGPUへ立て切ってから開幕。
			// scene 再生＝「綺麗な動画が撮れる」側のプロファイル（PC前提）＝タイムアウトで妥協しない（▶デモ＝「絶対失敗しない」側とは別・そちらは従来どおり）。
			const first = scenes[from] ?? scenes[0], firstView = first.view ?? first.glide ?? first.fade;   // 開始行の視点（via は parseScenes が先頭から除去済み）
			if (firstView) flyView(firstView, { jump: true });   // 開始画へ即 jump（黒幕の下・demo の内部先読みを起こさず、自前の進捗つき先読みへ一本化）
			// パネルは「実際に読むものがある時」だけ出す（IDB温間・全て焼き済みなら黒幕→即開幕＝何も出さない）。
			// 実読みの兆候＝(a)建物のネットワーク進捗 plateauProg（renderPlateauProg の tap＝網経路のみ発火・区名+枚数）
			//             (b)標高タイル読込 elevBusy（jump した開始画の地形＝先読みポンプの柵でもある）。
			let ward = { done: 0, total: 0 };
			const poke = () => sceneLoading({ ...ward, show: true });       // 兆候あり＝出す（以降は更新）
			const tick = setInterval(() => { if (plateau.progress.size || elevBusy) poke(); }, 400);   // elevBusy はイベントが無い＝小さく見回る
			plateau.setProgressTap(poke);   // 建物の枚数進捗はイベント駆動で即時反映
			// 読み切るまで待つ（タイムアウト無し）：各区は成功/失敗(plateauFailed)で必ず終端＝この await も必ず終わる。待ち時間の顔はパネルが引き受ける
			const wanted = (await plateau.prefetch(views, preload, (d, total) => { ward = { done: d, total }; sceneLoading(ward); }).catch(() => [])) || [];
			clearInterval(tick); plateau.setProgressTap(null);
			// ★リビール準備＝立ち切ってから開幕：最初のフレームから本物の3D（基図の押し出し箱を見せない）。
			// PC（WebGPU×非LOW_MEM＝全保持ヒステリシスと同じゲート）＝台本の全区を停止中に GPU 常駐まで積む＝道中・後続シーンも vis 点灯だけで即立つ。
			// 「ロードは停止中に・移動中は点灯だけ」の原則は不変（今は停止中）。低級機フォールバック＝最初のリビール視点の区だけ（従来）。
			// 失敗区(plateauFailed)は諦めて進む＝黒画面で永遠に待たない。
			// 低級機フォールバックの選抜（firstRevealSets＝bbox交差）はプリロード選抜（前方点ゲート）より緩い＝
			// 未プリロード区が混ざると立ち上げ段で網ロードが始まる（実測=千代田区・リビール直前の想定外ネットワーク）。
			// →プリロード済み区との積集合に絞る＝立ち上げ段は常に IDB→GPU だけ（wanted 空の縁だけ従来通り）。
			const wantedNames = new Set(wanted.map(s => s.name));
			const targets = ((gpuBackend && !LOW_MEM && wanted.length) ? wanted
				: plateau.firstRevealSets(views).filter(s => !wanted.length || wantedNames.has(s.name))).filter(s => !plateau.isDead(s.name));
			if (targets.length) {
				const gpuHint = setTimeout(() => sceneLoading({ ...ward, show: true, phase: "gpu" }), 700);   // 一瞬で立ち切る時はパネルを出さない
				await Promise.all(targets.map(s => plateau.standUp(s)));
				// standUpWard は「既に可視ロードが走行中」の区を false 即決で素通しする＝活性化の完了を見届ける（安全弁120秒・failed も抜け口）
				for (const t0 = performance.now(); !targets.every(s => plateau.isActive(s.name) || plateau.isDead(s.name)) && performance.now() - t0 < 120000;) await new Promise(r => setTimeout(r, 250));
				clearTimeout(gpuHint);
			}
			sceneLoading(false);
			if (run !== sceneRun) { sceneCover(false); return; }   // 準備中に stopScenes された＝静かに降りる（先読み済みは貯金）
		}
		if (run !== sceneRun) { sceneCover(false); return; }
		// ★上映：組み込み demo(▶) と同じ再生ルーチンを「素モード(バー/操作なし・上映中ノーアクション)」で呼ぶだけ＝台本を渡す。
		//   ▶ は次に組み込み設定を渡されて再生する＝demoHandle を上書きも復帰もしない（壊さない）。via の畳み込みは start 側（compileVias）。
		demoHandle.start?.(from, true, { scenes, lang, mobile, hold, slideHold, preload, finale: quick ? null : returnToStart, bare: true, onScene, onEnd: endHook });   // フル＝終演で括弧を閉じる（黒→上映前の画面へ）
		if (!quick) sceneCover(false);   // ★開始と同時に黒幕を fade-out＝最初の画面へ fade-in（約1.2秒）
	}).catch(e => {   // ★fallback＝どの失敗でも「黒幕を残さず、上映前の画面へ帰る」＝終幕と同じ着地（上映ロックも解除）
		sceneLoading(false); plateau.setProgressTap(null); sceneBusy = false;
		console.warn("[scene] playback prep failed = returning to pre-show view", e);
		if (!quick) { flyView(returnView, { jump: true }); sceneCover(false); }
	});
	return true;
}
const playScene = obj => playScenes(obj);   // 旧名の薄い別名（dropfile / ?scene= 注入用＝既定の儀式フル）
// 停止（scene-player API・map.stopScenes）：上映中でも準備中（黒幕+読み込み待ち）でも安全に降ろす＝黒幕・パネル・ロックを残さない。
// 現在地に留まる（括弧は閉じない＝終幕の帰還は走破だけの儀式）。戻り値＝止める物があったか。
function stopScenes() {
	if (!playingNow()) return false;
	sceneRun++;   // 準備中の再生を降ろす（黒幕の下で待っている then 連鎖が run 不一致で静かに終わる）
	demoHandle?.exit?.();   // 上映中なら exit→onEnd("stopped")→endHook が解除（▶デモの上映中でも安全＝ただ終演するだけ）
	sceneBusy = false; sceneLoading(false); sceneCover(false); plateau.setProgressTap(null);
	return true;
}
// ★タイムライン・スクラブ（scene-player API・map.sceneTimeline）：台本→時刻評価＝再生せず任意秒の絵を出す（エディタのスクラブ用）。
// 中身は純関数（demo/scene-timeline.js＝プレーヤー規則の写し × flightCtl.plan＝飛行の時刻評価プラン）。
// seek(秒)＝l=/c= はその行までの累積（l= は絶対指定＝手前の最後に書いた行が勝つ・無ければ現状維持＝プレーヤーの離陸時点火と同じ意味論・逆走も決定的）
// ＋カメラ直書き＋fade の黒(cover)。URL は書かない＝end() で1回（スクラブ終了＝確定視点の掟・saveView）。上映中は受けない（先に stopScenes）。
function sceneTimeline(obj) {
	const tl = buildSceneTimeline(obj, { plan: flightCtl.plan, parseView: parseViewHash, portrait: mapEl.clientHeight > mapEl.clientWidth, zoomMin: CAM_ZOOM_MIN });
	if (!tl) return null;
	const rowV = tl.rows.map(r => r.hash ? parseViewHash(r.hash) : null);   // 行ごとの l=/c=（累積適用の材料）
	let lastI = -1;
	const seek = sec => {
		if (playingNow()) return false;   // 上映中はスクラブ不可（先に map.stopScenes()）
		const f = tl.at(sec);
		if (f.i !== lastI) {   // 行を跨いだ＝この行までの l=/c= を累積適用
			lastI = f.i;
			for (let j = f.i; j >= 0; j--) if (rowV[j]?.layers || rowV[j]?.contour) { applyViewLayers(rowV[j]); break; }
			for (let j = f.i; j >= 0; j--) if (rowV[j]?.theme) { if (!themeFixed && rowV[j].theme !== themeName) switchTheme(rowV[j].theme); break; }
		}
		flightCtl.cancel();   // 手綱＝走行中の飛行があれば降ろしてから直書き
		applyCamView(f);      // クランプ（ZOOM/MAXPITCH/緯度）は共有URLの掟と同じ
		scrubCover(f.cover);
		onMove();
		return true;
	};
	return { dur: tl.dur, rows: tl.rows, at: tl.at, seek, end: () => { scrubCover(0); saveView(); } };
}
// スクラブ用の黒（fade 行の途中絵）＝透明度直書きの薄い幕（sceneCover は CSS transition 前提＝別物）。0 で退場。
let scrubEl = null;
function scrubCover(a) {
	if (!(a > 0)) { scrubEl?.remove(); scrubEl = null; return; }
	if (!scrubEl) {
		scrubEl = document.createElement("div");
		scrubEl.id = "scrub-cover";
		Object.assign(scrubEl.style, { position: "absolute", inset: "0", background: "#000", zIndex: "6", pointerEvents: "none" });
		mapEl.append(scrubEl);
	}
	scrubEl.style.opacity = String(Math.min(1, a));
}
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
		const arm = tries => demoHandle ? playScene(obj) : (tries < 100 ? setTimeout(() => arm(tries + 1), 100) : console.warn("[scene] demo never mounted = gave up on ?scene="));
		arm(0);
	}).catch(err => console.warn("[scene] failed to fetch ?scene=", sceneUrl, err));
}
// ?g=<URL>＝GeoPBF の URL ロード（ドロップと同じ一本道＝取得→loadUserFile）。gh:user/repo[@ref]/path 短縮形は
// GitHub raw へ展開（ref 省略=HEAD・コミットSHA固定も可）。https 限定（開発時のみ localhost の http 可）・
// credentials 無し＝他人の置き場を読むだけの姿勢。読めたら出所（ホスト名）を出典 #attr へ常時表示＝
// 他人の作品を当ドメインで再生する時の看板（docs/geopbf §11 の作法とセット）。
{
	const gSpec = new URLSearchParams(location.search).get("g");
	const u = gSpec ? remoteUrl(gSpec, "g") : null;   // 門は ?scene= と共用（remoteUrl）
	if (u) (async () => {
		try {
			const r = await fetch(u, { credentials: "omit" });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			if (+r.headers.get("content-length") > 256e6) throw new Error("too large");   // 正気上限（敵入力の巨大確保よけ・GitHub raw は 100MB 上限）
			const name = decodeURIComponent(u.pathname.split("/").pop() || "") || "map.geopbf";
			const pbf = await loadUserFile(new File([await r.blob()], name));
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
// ★開幕の黒幕（fade-in）：ドロップ/?scene= の再生は必ず黒から立ち上がる＝jump・読み込み・基図タイルの立ち上がりを
// 隠し、開始と同時に約1.2秒で溶明。DOMオーバーレイ＝#underground（地中フェード）と同じ流儀。パネル(#scene-loading)は
// zIndex 7＝黒幕(6)より上。触れない（pointerEvents:none）＝掴んで中断する主導権は奪わない。
let coverEl = null, coverT = 0, coverSecs = 1.2;   // coverSecs＝直近の溶暗/溶明の尺（fade 行の travel が上書き・既定1.2秒）
function sceneCover(on, { fade = false, secs } = {}) {
	if (on) {
		clearTimeout(coverT);
		if (!coverEl) {
			coverEl = document.createElement("div");
			coverEl.id = "scene-cover";
			Object.assign(coverEl.style, { position: "absolute", inset: "0", background: "#000", opacity: "1", transition: "opacity 1.2s ease", zIndex: "6", pointerEvents: "none" });
		}
		coverSecs = (Number.isFinite(secs) && secs > 0) ? secs : 1.2;
		coverEl.style.transitionDuration = coverSecs + "s";
		mapEl.append(coverEl);   // 再ドロップでも常に最前へ（DOM順）
		if (!fade) { coverEl.style.opacity = "1"; return Promise.resolve(); }   // 即・黒（開幕前）
		// fade:true＝黒へ溶暗（終幕・fade 行）：透明から黒へ。reflow flush で transition を確実に発火（rAF 依存を断つ＝
		// 静止後の headless 実測で rAF 連鎖が遅れて溶暗が飛ぶ轍・demo.js のタイトル淡入と同じ作法）。解決＝ほぼ真っ黒になった頃
		coverEl.style.opacity = "0";
		void coverEl.offsetWidth;
		coverEl.style.opacity = "1";
		return new Promise(r => { coverT = setTimeout(r, coverSecs * 1000 + 150); });
	}
	if (coverEl) {
		requestAnimationFrame(() => { coverEl && (coverEl.style.opacity = "0"); });   // 次フレームで溶明開始（append 直後の transition 不発を避ける）
		coverT = setTimeout(() => { coverEl?.remove(); }, coverSecs * 1000 + 300);
	}
}
// フェード遷移（fade: 行・demo が注入で呼ぶ）＝黒への溶暗→jump→溶明（sceneCover 流用）。secs＝溶暗/溶明それぞれの尺（既定1.2）。
// fadeBusy＝demo の flightActive（着地待ち）に乗せる＝黒の間は hold の計時も字幕も走らない（フライトと同じ扱い）
let fadeBusy = false;
async function fadeViewRun(hash, secs) {
	fadeBusy = true;
	try {
		await sceneCover(true, { fade: true, secs });
		flyView(hash, { jump: true });
		await new Promise(r => setTimeout(r, 300));   // 切替後のタイル敷き直しを黒の下で始めさせる
		sceneCover(false);
	} finally { fadeBusy = false; }
}
// waitLoading の待機中に画面中央へ出す進捗パネル。**実際に読むものがある時だけ**出す（state.show が兆候の合図＝
// 温間・全焼き済みは無表示のまま黒幕→即開幕）。「何をどう読んでいるか」＝ plateauProg（区名+枚数・網経路のみ）と
// elevBusy（標高タイル）をここで直接読んで一行に組む。触れない・待ち終わりに退場。
let slEl = null, slFill = null, slSub = null, slCount = null;
function sceneLoading(state) {
	if (state === false) { if (slEl) slEl.style.display = "none"; return; }
	if (!state.show && !(slEl && slEl.style.display !== "none")) return;   // 兆候(show)が来るまで出さない＝区tickだけではパネルを開かない
	if (!slEl) {
		slEl = document.createElement("div");
		slEl.id = "scene-loading";
		Object.assign(slEl.style, { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(8,12,20,.45)", zIndex: "7", pointerEvents: "none" });
		const card = document.createElement("div");
		Object.assign(card.style, { minWidth: "min(320px, 78vw)", maxWidth: "82vw", padding: "28px 36px", borderRadius: "18px", background: "rgba(16,24,36,.92)", color: "#fff", textAlign: "center", fontFamily: "system-ui, sans-serif", boxShadow: "0 8px 40px rgba(0,0,0,.45)" });
		const title = document.createElement("div");
		title.textContent = t("Loading the scene…");
		Object.assign(title.style, { fontSize: "23px", fontWeight: "700", letterSpacing: ".01em", marginBottom: "6px" });
		slSub = document.createElement("div");
		Object.assign(slSub.style, { fontSize: "13px", opacity: ".7", marginBottom: "18px", minHeight: "1.4em" });
		const bar = document.createElement("div");
		Object.assign(bar.style, { height: "9px", borderRadius: "999px", background: "rgba(255,255,255,.16)", overflow: "hidden" });
		slFill = document.createElement("div");
		Object.assign(slFill.style, { height: "100%", width: "6%", borderRadius: "999px", background: "linear-gradient(90deg,#4b90ff,#7db4ff)", transition: "width .35s ease" });
		bar.append(slFill);
		slCount = document.createElement("div");
		Object.assign(slCount.style, { fontSize: "13.5px", opacity: ".88", marginTop: "12px", fontVariantNumeric: "tabular-nums" });
		card.append(title, slSub, bar, slCount);
		slEl.append(card);
	}
	mapEl.append(slEl);   // 毎回最後尾へ＝黒幕(#scene-cover)より必ず上（DOM順＋zIndex の二重保険）
	slEl.style.display = "flex";
	// 今まさに読んでいる物＝建物（区名 done/total枚・カタログ走査）＋標高。網経路のみ＝IDB命中は現れない（それが正しい）
	const parts = [...plateau.progress.values()].map(p =>
		p.total ? t("$1 $2/$3 tiles", p.name, p.done, p.total) : t("$1 scanning catalog $2…", p.name, p.scan ?? 0));
	if (elevBusy) parts.push(t("terrain tiles"));
	slSub.textContent = parts.join("・") || t("3D city (PLATEAU)");
	const { done = 0, total = 0 } = state;
	if (state.phase === "gpu") {   // 読み切った後の最終段＝IDB→GPU 常駐へ立ち切る待ち（開幕の直前）
		slFill.style.width = "100%";
		slCount.textContent = t("standing up the city…");
	} else if (total) {
		// バーは区の歩み＋読みかけ区のタイル進捗（なめらか担当・並行読みの分は全部加算＝残り区数でクランプ）
		const frac = Math.min(Math.max(0, total - done), [...plateau.progress.values()].reduce((a, p) => a + (p.total ? Math.min(1, p.done / p.total) : 0), 0));
		slFill.style.width = Math.max(6, Math.round(Math.min(1, (done + frac) / total) * 100)) + "%";
		slCount.textContent = t("$1 / $2 districts", done, total);
	} else {
		slFill.style.width = "6%";
		slCount.textContent = t("preparing…");
	}
}
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
		name: "cog",   // COG/GeoTIFF＝cog ガジェットへ（gint 経路の geopbf() は TIFF 非対応で null 死する）
		test: f => /\.tiff?$/i.test(f.name),
		draw: async file => {
			annoCtl?.clear(); gint.clearUserGint();
			return map.gadget.cog(file).then(c => ({ length: `${c.width}×${c.height}px` })).catch(err => { console.error("[dropFile] cog", file.name, err); return null; });
		},
	},
	{
		name: "geoparquet",
		test: f => /\.(parquet|geoparquet)$/i.test(f.name),
		// 本体は動的 import＝.parquet を受けた時だけチャンクが降りる（初期バンドルは不変・ガジェットの遅延ロードと同じ規律）。
		// 内部圧縮は none/snappy/gzip を自前で読む。zstd だけはブラウザに実装が無く（DecompressionStream("zstd") は
		// 仕様にあるが全ブラウザ未実装・Node 22.15+ の node:zlib のみ）、素のエラーは "Node" と言って読み手を惑わすので包み直す。
		convert: async file => {
			const { fromGeoParquet } = await import("geopbf/geoparquet");
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
const loadUserFile = async file => {
	for (const fmt of INTAKE) {
		if (!fmt.test(file)) continue;
		if (fmt.draw) return fmt.draw(file);
		file = await fmt.convert(file);   // 変換行＝本道へ合流（以降の扱いは素の .geopbf と同一）
		break;
	}
	const pbf = await geopbf(file, { gint: true, name: `drop/${file.name}` }).catch(err => { console.error("[dropFile] geopbf", file.name, err); return null; });
	if (!pbf?.unPackGint) return null;
	// 低ズーム描画が速くなった＝先に現在ビューへ図形を描き（カメラは動かさない）、その後 flyTo で寄る。
	// 瞬間ジャンプ(ポップイン)でなく「図形が現れて→近づく」。着地は真俯瞰(tilt/bearing=0)・北向き＝fit の north-up 前提。
	if (pbf.keys?.some(k => ANNO_KEYS.has(k))) {   // @スタイル付き＝注釈レイヤ（geoedit 作）＝canvas2D 再生（gint スロットは触らない→前の層は消す）
		gint.clearUserGint();
		await map.gadget.anno(pbf);
	} else {
		annoCtl?.clear();
		gint.applyGintData(pbf, file.name, false, { drape: true });   // 先に描画（gint スロットへ set・識別点火・カメラ据え置き）＋ポリゴンは地形沿い境界線を自動発火
	}
	const bb = pbf.unPackGint.bbox;
	if (bb && bb.length === 4) {
		const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
		const wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);   // 30%余白（縁ぴったりを避ける）
		// 視野幅[deg]=360*size.w/(WORLD_PX*2^z)（flight の van Wijk 尺と同一）を逆解き＝横/縦の狭い側に合わせる。
		const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
		flyTo(cx, cy, Math.max(3, Math.min(17, z)), 0);   // 描画後に寄る＝fit へ球面フライト（tilt/bearing=0）
	}
	return pbf;   // gadget が pbf.length（地物数）をトーストに使う
};
map.gadget("dropFile", function (opts) {   // GISファイルのD&D取り込み … loadUserFile（上）を束ね注入（gint単一スロット＝置き換え）
	return dropFileGadget.call(this, { loadFile: loadUserFile, clearGint: () => { annoCtl?.clear(); cogCtl?.clear(); gint.clearUserGint(); }, playScene, busy: playingNow, yieldTo: () => editDropOwner, signal: ac.signal, ...opts });   // busy＝上映中はドロップ無視（デモ中はドロップ禁止）。消去は注釈レイヤも一緒に
});
map.gadget("geoedit", function (opts) {   // GeoPBF トポロジカル編集（旧 apps/geoedit → gadgets/geoedit・遅延chunk）… 公開面だけで動く＝ここは import と結線だけ。戻り値＝Promise<editor>
	return import("./gadgets/geoedit/controller.js").then(m => m.initEditor(this, { setDropOwner: on => { editDropOwner = !!on; }, ...opts }));   // 搭載中はドロップをエディタが所有（dropFile は譲る）
});
map.gadget("edit", function (opts) {   // 編集ボタン（左上スタック）… 押すと map.gadget.geoedit() を搭載/解除。出現域は搭載側の zoom 宣言（site.js＝[2.5,99]）
	return editGadget.call(this, { mount: () => map.gadget.geoedit(), signal: ac.signal, ...opts });
});
map.gadget("demo", function (opts) {   // デモ（発表の台本再生）… 台本の一行=共有URLハッシュ。flyView（球面フライト）・フライト中判定・PLATEAU先読み・現テーマ名（幕替わり判定）を注入
	const japanFit = () => {   // 終演の定位置＝日本列島が画面に収まる真俯瞰・北向き（fitBbox と同じ視野幅の逆解き＝縦横どちらの画面でも収まる）
		const wDeg = 17.4 * 1.15, hDeg = 15.2 * 1.15;   // 列島の大づかみ [129..146.4]×[30.6..45.8]（沖縄本島は列島の画角を殺すので外＝台本の白地図と同じ構図）
		const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
		flyTo(137, 37, Math.max(ZOOM_MIN, Math.min(7, z)), 0, 0);
	};
	demoHandle = demoGadget.call(this, { flyView, fadeView: fadeViewRun, glidePath: glidePathView, flightActive: () => flightCtl.active || fadeBusy,
		// 書き終わりの合図（自動上演の行送りゲート・裁定2026-08-12「非力機は書き終わるまで待つ」）＝可視の立ち上げ
		// (autoPlateau発＝prefetchは含めない・ackはクレジット窓2で「ほぼ描き切り」)・標高タイル・基図sig（z<4は
		// mainスロット空でsigが恒久不一致＝地球儀シーンを堰き止めないよう z≥4 限定）。裏仕込み(prefetch)は幕を止めない。
		// 返り値＝進捗指紋の文字列（空=静か）：demo側は「指紋が動く間だけ」待つ＝止まった待ち（オフライン等）は打ち切れる。
		loadingActive: () => {
			const base = cam.zoom >= 4 && readySig !== mainDesired;
			// 待つのは「これから見える区」だけ＝demote（視界外の在庫化）・cancel 中の区は指紋に載せない。旧・全ロード中区の
			// 進捗を載せていたため、目の前の区が読み終わっても隣の在庫区のバッチ進捗が動き続けて上限（20s）まで幕が進まなかった
			//（本人報告 2026-09-08「途中で Plateau の読みが終わると再開しない」＝R2 焼きで本命が数秒で終わるようになり顕在化）
			const shown = plateau.visibleLoading();
			if (!shown.length && !elevBusy && !base) return "";
			return `A${shown.join(".")}|P${shown.map(n => { const p = plateau.progress.get(n); return p ? (p.done ?? p.scan ?? 0) : "-"; }).join(".")}|E${elevN}|B${base ? 1 : 0}`;
		},
		// 静穏窓フック（裁定2026-08-12）＝書き終わり直後の一拍で「残り台本に出ない」常駐区を降ろす（上の trim 参照）
		onQuiet: views => plateau.trimForScript(views),
		prefetchViews: plateau.prefetch, finale: japanFit, signal: ac.signal, zoomMin: CAM_ZOOM_MIN, ...opts });   // 手綱を掴む＝ドロップ/?scene= は playScene→demoHandle.start(落とした台本, bare) で別入り口再生（▶=組み込みは壊さない）。glidePath＝via連続ドリー／fadeView＝黒挟み遷移（fadeBusy を着地待ちに乗せる）
	return demoHandle;
});
// tip（カーソル追従の吹き出し）を既定搭載＝gint 層のホバー識別を指先へ。搭載はここ一箇所（dropFile/14条どの経路でも効く）。
// 見えない div＝gint interactive 層をホバーした時だけ内容が出る＝非gintの埋め込みでは無害。
gint.hoverTip = map.gadget.tip();
return map;
}
