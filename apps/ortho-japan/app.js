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
import { createGetHeight, setApiUrl as setAltApiUrl } from "altpbf";
createGeopbf("https://api.ortho-earth.com");   // bucket 基盤（標高と同じ）。読み出しはキー不要
import { MAP_THEMES } from "./palettes.js";
import { createThemes, defaultLayerState, isFacility, isTerrain, CHOME_MINZOOM, CHOME800_MINZOOM, RAILTR_MINZOOM } from "./themes.js";
import { createOverlay } from "./overlay.js";
// planets.js / skynames.js は z<4（星空）でしか使わない＝初期バンドルから外し、下の ensureSkyMod で動的読込。
import { createPipeline } from "ortho-core";   // tile/scene worker のスポーンごとエンジン側
import { createPlateauDb } from "./plateaudb.js";
import { mountGadgets } from "./gadgets/mount.js";
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
import { measure as measureGadget } from "./gadgets/measure-stub.js";   // 玄関スタブ＝ボタン+Mキー常駐、本体(measure.js＝球面測地/専用canvas)は初回クリック/Mで import()
import { shot as shotGadget } from "./gadgets/shot-stub.js";   // 玄関スタブ＝デスクトップのみボタン常駐、本体(shot.js＝層合成/webp/出典焼込)は初回クリック/⌘Sで import()。モバイルは stub が即return＝本体も fetch されない
import { qr as qrGadget } from "./gadgets/qr-stub.js";   // 玄関スタブ＝ボタンだけ常駐、本体(qr.js＋自作QRエンコーダ qrcode.js 14KB)は初回クリックで import()＝初期バンドルから隔離
import { japan as japanGadget } from "./gadgets/japan.js";
import { print as printGadget } from "./gadgets/print-stub.js";   // 本体(print.js)は初回起動時にimport()＝初期バンドルから隔離
import { close as closeGadget } from "./gadgets/close.js";
import { dropFile as dropFileGadget, gunzipText } from "./gadgets/dropfile.js";   // dropfileは起動時常駐（ドロップ受付）＝静的一本。gunzipTextもここから（動的importと混ぜるとチャンク分割が死ぬ）
import { demo as demoGadget } from "./gadgets/demo-stub.js";   // 玄関スタブ＝同期ファサードを即返し、本体(demo.js＝再生エンジン)は搭載時に import()＝初期バンドルから隔離
import { parseScenes } from "./demo/scene-adapter.js";   // 共有シーン台本(type:"scenes")→ demo プレーヤー受け渡しの純関数（ドロップ/?scene= 再生／将来のエディタで共有）
import { buildSceneTimeline } from "./demo/scene-timeline.js";   // 台本→総タイムライン（時刻評価・純関数）＝スクラブの芯（map.sceneTimeline が env と画面適用を束ねる）
import { ai as aiGadget } from "./gadgets/ai-stub.js";   // 玄関スタブ＝同期ファサードを即返し、本体(ai.js＋ai/一式＋将来LLM)は搭載時に import()＝初期バンドルから完全隔離
import { modalOpen } from "./gadgets/keys.js";   // 矢印キーのモーダル抑止に使う共通判定（ショートカット群と共有）
import { setLang, getLang, tr } from "./i18n.js";   // UI二言語化（ja正典・詳細はi18n.js）。地図の中身（地名等）は対象外

// app.js 持参のUI辞書（ja文字列がキー・未訳はjaのまま出る）。ガジェット各自の辞書は各ファイル冒頭に。
const t = tr({
	"再読み込み": "Reload",
	"この地図はお使いのブラウザでは表示できません": "This map cannot be displayed in your browser",
	"3Dの地球儀を WebGL2 と OffscreenCanvas で描いています。最新の Chrome / Edge / Firefox、または Safari 17 以降でお試しください。":
		"This 3D globe is drawn with WebGL2 and OffscreenCanvas. Please try the latest Chrome / Edge / Firefox, or Safari 17 or later.",
	"GPU の応答を待っています…": "Waiting for the GPU to respond…",
	"描画プロセスの再起動直後はこの表示が出ることがあります。数秒で自動的に始まります。":
		"This can appear right after the graphics process restarts. It should start automatically in a few seconds.",
	"3D描画を開始できません": "Cannot start 3D rendering",
	"お使いのブラウザは対応していますが、GPU（WebGL2）が応答しません。ブラウザを完全に終了して開き直すか、設定で「ハードウェアアクセラレーション」が有効かご確認ください。":
		"Your browser is supported, but the GPU (WebGL2) is not responding. Quit the browser completely and reopen it, or check that hardware acceleration is enabled in the settings.",
	"地図データの取得に失敗しています（通信状態をご確認ください）": "Failed to load map data (please check your connection)",
	"端末を縦向きにしてご覧ください（タップで閉じる）": "Please rotate your device to portrait (tap to dismiss)",
	"起動に時間がかかっています": "Startup is taking longer than usual",
	"回線が遅い場合、初回は読み込みに時間がかかることがあります（読み込みは続いています）。そのまま少しお待ちください。改善しない場合は再読み込みを。それでも駄目な場合は、ブラウザの設定で「ハードウェアアクセラレーション」が有効かご確認ください。":
		"On a slow connection the first load can take a while (loading is still in progress). Please wait a moment. If it does not improve, reload the page — and if that fails, check that hardware acceleration is enabled in your browser settings.",
	"互換描画(WebGL2)モード — タップで高速モード再試行": "Compatibility rendering (WebGL2) — tap to retry fast mode",
	"互換描画(WebGL2)で起動 — 再読み込みで高速モード再試行": "Started in compatibility rendering (WebGL2) — reload to retry fast mode",
	"3D描画を開始できませんでした": "Could not start 3D rendering",
	"WebGL2 の初期化に失敗しました（{0}）。ブラウザの「ハードウェアアクセラレーション」が無効になっている可能性があります。":
		"WebGL2 initialization failed ({0}). Hardware acceleration may be disabled in your browser.",
	"GPU の描画が中断されました": "GPU rendering was interrupted",
	"描画コンテキストが失われました（GPUメモリ不足などで起こります）。他のタブやアプリを閉じてから再読み込みしてください。":
		"The rendering context was lost (this can happen when GPU memory runs low). Close other tabs or apps, then reload.",
	"⛰ 標高ローダ {0}": "⛰ Elevation loader {0}",
	"⛰ 地形読込中 {0} … ×{1}": "⛰ Loading terrain {0} … ×{1}",
	"R01（秒単位）": "R01 (takes seconds)",
	"🏙 建物3D 読込中 ": "🏙 Loading 3D buildings ",
	"{0} {1}/{2}枚": "{0} {1}/{2} tiles",
	"{0} カタログ走査 {1}…": "{0} scanning catalog {1}…",
	"シーンを読み込み中…": "Loading the scene…",
	"標高タイル": "terrain tiles",
	"3D都市（PLATEAU）": "3D city (PLATEAU)",
	"都市を立ち上げ中…": "standing up the city…",
	"{0} / {1} 区": "{0} / {1} districts",
	"準備中…": "preparing…",
	"星図: d3-celestial ／ 海岸線: Natural Earth ／ 標高: GEBCO ／ © 2026 Kenji Yoshida":
		"Star chart: d3-celestial / Coastlines: Natural Earth / Bathymetry: GEBCO / © 2026 Kenji Yoshida",
	"経度": "Lon", "緯度": "Lat", "標高": "Elev", "z値": "z", "回転": "Rot", "傾度": "Tilt",
});

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
// UI言語を最初に確定（opts.lang > ?lang= > ブラウザ言語）。以降のfatal/トースト/ガジェットが全て従う。
setLang(opts.lang);
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
// ★mapEl 自身を position:fixed で浮かせる手もあるが不可：流れから外れると AI ガジェットの画面2分割
//   （親を flex 化して mapEl.flex を効かせる）が死ぬ（同日 t-ai mapNarrow で踏んだ轍）。容れ物は流れの中に置く。
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
// 舞台のcanvas 2層（基図GL＝知性gintも同居/ラベル）も自給＝index.htmlは空のdivだけでよい
// （旧・#gint 別canvas は 1canvas統合で撤去＝gint は render worker の GL パスとして #c に描かれる）
for (const cid of ["c", "labels"]) { const cv = document.createElement("canvas"); cv.id = cid; mapEl.appendChild(cv); }
// 地中フェードの覆い（カメラが地表より下へ潜った時に暗くする＝クランプの代替。updateUnderground が opacity を駆動）。
// canvas 2層の直後・UI より前＝基図/ラベル/gint を覆い、計器・検索は上に残す（脱出できる）。スタイルは style.css の #underground。
const undergroundEl = mapEl.appendChild(document.createElement("div"));
undergroundEl.id = "underground";

// 実行時アセット（plateau-sets.json / airports.json / plateau-landmarks.json / ai/citycodes.json）の置き場。
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
const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
// optimal_bvmap の配信圏（日本域）の外接矩形 [west,south,east,north]。これと全く重ならないタイルは GSI が
// 常に 404 を返す提供圏外＝pipeline が fetch を省いて空タイル(標高ゲート付き全面水域)扱いにする（無駄な 404 を断つ）。
// 症状＝縦長のスマホ画面が北海道以北の外洋(z8 y=87/88≈50°N)まで写して 404 を量産（横長のデスクトップでは出にくい）。
// 保守的に本土＋離島（南鳥島154E/沖ノ鳥島20.4N/与那国123E/宗谷45.5N）を余裕で内包＝実在タイルは絶対に巻き込まない。
const JP_COVERAGE = [121, 19, 155, 46];
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
mountGadgets(mapEl, { chips: opts.chips, instruments: opts.instruments, fixedLayers });   // UI を #map に生やす＝以降の getElementById が実体を掴めるよう、全lookupの前で
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
		${reload ? `<button class="fatal-reload" onclick="location.reload()">${t("再読み込み")}</button>` : ""}</div>`;
	mapEl.appendChild(d);
	return d;
}
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
		fatalOverlay(t("この地図はお使いのブラウザでは表示できません"),
			t("3Dの地球儀を WebGL2 と OffscreenCanvas で描いています。最新の Chrome / Edge / Firefox、または Safari 17 以降でお試しください。"));
		throw new Error("unsupported: offscreencanvas");
	}
	if (!probeGL()) {
		const waiting = fatalOverlay(t("GPU の応答を待っています…"),
			t("描画プロセスの再起動直後はこの表示が出ることがあります。数秒で自動的に始まります。"));
		let ok = false;
		for (let i = 0; i < 10 && !ok; i++) { await new Promise(r => setTimeout(r, 1000)); ok = probeGL(); }
		waiting.remove();
		if (!ok) {
			fatalOverlay(t("3D描画を開始できません"),
				t("お使いのブラウザは対応していますが、GPU（WebGL2）が応答しません。ブラウザを完全に終了して開き直すか、設定で「ハードウェアアクセラレーション」が有効かご確認ください。"), true);
			throw new Error("unsupported: webgl2 unavailable (after 10s retry)");
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
// 通信断トースト：offline イベント＋タイル連続失敗で表示、回復（online/タイル成功）で消える。地図は粗い下地で生き続ける。
const netEl = document.createElement("div");
netEl.id = "net-toast";   // スタイルは style.css
netEl.textContent = t("地図データの取得に失敗しています（通信状態をご確認ください）");
mapEl.appendChild(netEl);
// 縦向き案内：スマホ横向き（coarseポインタ＋低い横長ビューポート）で縦向きを促す。表示制御は CSS メディアクエリのみ
// ＝JSは要素を置くだけ（回転すれば自然に消える）。タップで閉じたら inline display:none がメディアクエリに勝つ＝再表示しない。
const rotEl = document.createElement("div");
rotEl.id = "rotate-toast";   // スタイルと表示条件は components.scss（#rotate-toast）
rotEl.textContent = t("端末を縦向きにしてご覧ください（タップで閉じる）");
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
const renderWorker = new Worker(new URL("./renderworker.js", import.meta.url), { type: "module" });
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
renderWorker.postMessage({ type: "init", ctrlPort: ctrlChan.port2, canvas: offscreen, labelCanvas: labelOffscreen, elevBase: TERR_EXAG / EARTH_M, terrainExag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com", scenePort: sceneChan.port2, noMultiDraw, perf: perfLog, mem: hudOn, lowMem: LOW_MEM, noMixed: noMixedR01, noFarTerr, noBld: /[?&]nobld=1/.test(location.search), gpu: gpuBackend, noTQ: /[?&]notq=1/.test(location.search), noGint: /[?&]nogint=1/.test(location.search), noFade: /[?&]nofade=1/.test(location.search), msaa1: MSAA_OFF, msaa4: MSAA_PIN, drawHud: drawHud, stay: /[?&]stay=1/.test(location.search), noTerr, ell: ELL_ON }, [ctrlChan.port2, offscreen, labelOffscreen, sceneChan.port2]);
// 薄いプロキシ：有線(関数呼び)を無線(postMessage)に載せ替え。set/draw 統一済なので pipeline/overlay は無改造。
// draw は worker 側で「cam を記録するだけ」に受け、実描画は worker 自前 rAF が最新 cam で回す（worker-driven）。
// 標高アトラス(terrain)も worker 側に住む＝main はもう視野→セル計算・ダウンサンプルを一切やらない。読込インジケータだけ elevPending で受ける。
const renderer = {
	set: (cmd, data, prop) => wPost({ type: "set", cmd, data, prop }),
	draw: (cam, opts) => {
		try { wPost({ type: "draw", cam, opts }); dbgHost.__drawSendN = (dbgHost.__drawSendN || 0) + 1; }
		catch (e) { dbgHost.__drawSendErr = String(e && e.message); console.error("[boot] draw send failed:", e); }
	},
};
let elevBusy = false;   // 標高タイル（R01/R10/R90）読込中＝PLATEAU先読みの柵（デモの地形シーンで起伏が立たない事故の防止）
let elevN = 0;          // 読込中の枚数＝デモ行送りゲートの進捗指紋（枚数が動いている間は「進んでいる」）
const elevEl = document.createElement("div");
elevEl.id = "elev-toast";   // スタイルは style.css
mapEl.appendChild(elevEl);
// 等高線(真俯瞰の茶線)・測量点標高・地形読込表示は「地形」チップ(layerState.terrain)に統合＝独立トグル無し。
// zoom/tileのデバッグログ(#log)はユーザー向けチップから切り離し常時非表示（必要なら devtools で #log を出す）。
logEl.style.display = "none";
// 起動ウォッチドッグ：最初のフレーム(frame1)が10秒来なければ原因不明でも案内を出す（健全なら1秒未満で来る）。
// glfail=worker内のWebGL2初期化失敗、contextlost=GPUコンテキスト喪失（1回だけ自動リロード→再発なら案内）。
let bootT = setTimeout(() => {
	fatalOverlay(t("起動に時間がかかっています"), t("回線が遅い場合、初回は読み込みに時間がかかることがあります（読み込みは続いています）。そのまま少しお待ちください。改善しない場合は再読み込みを。それでも駄目な場合は、ブラウザの設定で「ハードウェアアクセラレーション」が有効かご確認ください。"), true);
}, 10000);
// gpu=1 の frame1 不達（20秒）＝WebGPU 経路が固まっている疑い＝WebGL2 で仕切り直し（遅い回線のコールドブート実測
// 16秒@400kbps を考慮した余裕。present 沈黙故障と対で、実験フラグがどう転んでも WebGL2 の絵に必ず着地させる）。
if (gpuBackend) setTimeout(() => {
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
renderWorker.onmessage = e => {
	const d = e.data;
	// --- gint（知性の層＝render worker に同居）の返信面（action=旧 gint worker と同形） ---
	if (d.action === "identify") {   // ホバー識別＝当たった feature の全 properties を指先 tip へ。外れ(featureId=null)は消す。
		if (!gintHoverTip) return;
		if (estatTipOwn) return;   // 町丁目tipが所有中＝gint側のackでtipを消したり上書きしない（正着は毎moveのhovertipが再設定）
		const p = (d.featureId != null && userGint?.pbf) ? userGint.pbf.getFeature(d.featureId)?.properties : null;
		// 層持参の tip 整形（applyGintData opts.tip・census2020 筆層のみ＝フラグゲート）。無指定＝従来の全属性そのまま（融通なし）
		const lines = p ? (userGint?.tip ? userGint.tip(p) : Object.entries(p).map(([k, v]) => `${k}: ${v}`)) : null;
		gintHoverTip(lines?.length ? lines : null);   // null/空＝tip を消す
		return;
	}
	if (d.action === "click") {
		gintClickHandler?.(d.featureId, (d.featureId != null && userGint?.pbf) ? userGint.pbf.getFeature(d.featureId)?.properties : null, [d.lng, d.lat]);
		return void console.log("[gint] fid=%s  lng=%s lat=%s", d.featureId, d.lng?.toFixed?.(6), d.lat?.toFixed?.(6));
	}
	if (d.action === "tiers") return;   // gint LOD tier 構築完了の報告（ベンチ用メタ）＝アプリでは使わない
	if (d.type === "snapshot") return snapPart(d.id, "render", d);   // shot 用：基図+ラベルの ImageBitmap
	if (d.type === "dlApplied") return onSceneApplied(d.slot, d.sig);   // multi_draw の ack＝renderer が draw list を適用した瞬間（＝画面に載った）
	if (d.type === "frame1") {
		clearTimeout(bootT); bootT = null; dbgHost.__backend = d.backend || "webgl2"; sessionStorage.removeItem("oj.ctxlost");   // 初描画成功＝自動リロード回数もリセット。__backend＝スモークテスト用（webgl2/webgpu）
		document.getElementById("fatal")?.remove();   // 遅い回線でウォッチドッグ(10s)が先に出た後の遅着 frame1＝案内を畳む（地図は生きているのに被さったまま＝「何も出ない」の正体・モバイル実測 2026-08-02）
		console.log(`[boot] frame1 received backend=${dbgHost.__backend}`);
		diagHud && diagHud("frame1", `received ✓ backend=${dbgHost.__backend}`);
		// フォールバック GL2 の画面表示（柔らか鍵の③）：黙って重いモードで走らない。タップ＝印を全消しして
		// WebGPU 再試行（CNG フリートで端末を覗いた瞬間に状態が分かる・観客の端末でも1タップで復帰を試せる）。
		if (dbgHost.__backend !== "webgpu" && gl2Fallback) {
			const chip = document.createElement("div");
			chip.id = "gl2-chip";
			chip.style.cssText = "position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:9000;background:rgba(20,24,34,.78);color:#ffd479;font:11px/1.4 system-ui,sans-serif;padding:5px 9px;border-radius:14px;cursor:pointer;user-select:none;-webkit-user-select:none";
			chip.textContent = nogpuN >= 2 ? t("互換描画(WebGL2)モード — タップで高速モード再試行") : t("互換描画(WebGL2)で起動 — 再読み込みで高速モード再試行");
			chip.onclick = () => { sessionStorage.removeItem("oj.nogpu"); sessionStorage.removeItem("oj.nogpuN"); location.reload(); };
			document.body.appendChild(chip);
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
		fatalOverlay(t("3D描画を開始できませんでした"), t("WebGL2 の初期化に失敗しました（{0}）。ブラウザの「ハードウェアアクセラレーション」が無効になっている可能性があります。", d.error), true);
		return;
	}
	if (d.type === "gpuTier") { gpuFast = d.fast; return; }   // GPU格付け（renderworker tuneRes）＝静止時の手前詳細化の可否
	if (d.type === "contextlost") {
		const n = +(sessionStorage.getItem("oj.ctxlost") || 0);
		// まず黙って1回だけ立て直す。1秒待ってから＝GPUプロセスの再起動を待つ（即リロードだと復帰前の
		// getContext が null＝旧・probe が「ブラウザ非対応」と誤診した。probe側のリトライと二段の保険）。
		if (n < 1) { sessionStorage.setItem("oj.ctxlost", String(n + 1)); setTimeout(() => location.reload(), 1000); }
		else fatalOverlay(t("GPU の描画が中断されました"), t("描画コンテキストが失われました（GPUメモリ不足などで起こります）。他のタブやアプリを閉じてから再読み込みしてください。"), true);
		return;
	}
	if (d.type === "mem") { memTerrain = d.terrain || 0; memHeap = d.heap || 0; memGpu = d.gpu || null; memFps = d.fps ?? memFps; memFrameMs = d.frameMs ?? memFrameMs; memRes = d.res ?? memRes; memBackend = d.backend || memBackend; memGpuName = d.gpuName || memGpuName; return; }   // ?hud=1：render worker からのメモリ台帳＋描画実測（HUD が合算・表示）
	if (d.type === "drawhud") { showDrawHud(d); return; }                                   // ?drawhud=1：直近フレームの描画実績を画面へ（実機計器）
	if (d.type !== "elevPending") return;
	const { count, range, stat } = d;
	elevBusy = count > 0; elevN = count;   // 標高タイル読込中＝PLATEAU先読みポンプの柵（地形シーンの起伏が先・下記 runPrefetch）
	// stat＝標高ローダの自己申告（初期化中/初期化失敗:理由）。旧・沈黙死は「山が平ら・トーストも出ない・
	// 理由は誰にも見えない」＝借り物端末（インスペクタ不可）で追跡不能だった。地形チップに関係なく出す＝診断が主目的。
	if (stat) { elevEl.style.display = "block"; elevEl.textContent = t("⛰ 標高ローダ {0}", stat); return; }
	if (count > 0 && layerState.terrain) { elevEl.style.display = "block"; elevEl.textContent = t("⛰ 地形読込中 {0} … ×{1}", range === 1 ? t("R01（秒単位）") : range === 10 ? "R10" : "R90", count); }
	else elevEl.style.display = "none";
};

let needsDraw = true, readySig = "", lastLabels = [], sceneOrigin = null;
// mainDesired＝「今この視点で載っているべき main の sig」（swapScene が毎回更新。request の dedupe とは独立）。
// base(粗い下地)の退場判定に使う：readySig がこれに追いつく＝穴なしが確定するまで下地を敷いたままにする。
let mainDesired = "";
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
const BASEMAP_MINZOOM = 5;                 // これ未満は基図の詳細を描かない（海岸線 gint で十分／main負荷を断つ）
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
let PLATEAU_SETS = [];
// カタログ到着の合図＝デモの先読み（prefetchPlateauForViews）が待つ。到着時の自動ロードは従来どおり。
// 実験：オランダ 3DBAG（?nl=1 で登録簿に追加）。TU Delft が BAG(建物登記)＋AHN(国土LiDAR)から自動生成した
// 全国1000万棟の LoD2.2・CC BY 4.0。PLATEAU と違い「国土まるごと1枚のタイルセット」（外部tileset 474本）
// なので、街ごとの矩形(clip)で走査を枝刈りして「区」相当の粒度に切る。
// base は識別キー（worker振り分け・キャッシュ・OPFSのファイル名）＝同じ tileset を街ごとに別枠で持つため
// 実URLは tilesetUrl で別に渡す。中身は 3D Tiles 1.1 の glb＝頂点が int16 量子化（plateauworker が解除）。
const NL_TILESET = "https://data.3dbag.nl/v20250903/cesium3dtiles/lod22/tileset.json";
const NL_SETS = [
	{ key: "delft", name: "デルフト（3DBAG）", bbox: [4.336, 51.978, 4.393, 52.026] },
	{ key: "rotterdam", name: "ロッテルダム（3DBAG）", bbox: [4.452, 51.905, 4.510, 51.935] },
	{ key: "amsterdam", name: "アムステルダム（3DBAG）", bbox: [4.869, 52.360, 4.925, 52.386] },
].map(s => ({ name: s.name, bbox: s.bbox, base: `nl-3dbag-${s.key}/`, tilesetUrl: NL_TILESET, clip: s.bbox }));
// 入口は /nl/（本番＝deploy-worker が japan の資産をそのまま出す独立URL）と ?nl=1（開発・japanに重ねて確認する時）。
// pathname 判定＝アドレス欄が /nl/ のまま＝共有URLとして日本と混ざらない。
const nlOn = /[?&]nl=1/.test(location.search) || /^\/nl(\/|$)/.test(location.pathname);
const plateauCatalogReady = !plateauOn ? Promise.resolve() :
	fetch(ASSET_BASE + "plateau-sets.json").then(r => r.json()).then(sets => {   // BASE_URL＝サブパス配信(/ortho-japan/)対応
		if (nlOn) { sets = sets.concat(NL_SETS); console.log("[plateau] added Netherlands 3DBAG to catalog (?nl=1)"); }
		PLATEAU_SETS = sets; console.log(`[plateau] catalog loaded -> ${sets.length} municipalities`);
		autoPlateau(true);   // 復元ビューが z15+ の街なら起動直後に自動ロード（settled扱い＝起動時の視界は確定している。IDB命中なら即座に街が立つ）
	}).catch(e => console.warn("[plateau] catalog fetch failed", e));
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
	return landmarkReq = fetch(ASSET_BASE + "plateau-landmarks.json").then(r => r.json()).then(j => {
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
const PLATEAU_AUTO_Z = qNum(/[?&]paz=(\d+(?:\.\d+)?)/, 15);   // これ以上寄ると自動ロード（遠景は対象外＝ズームアウトで全解放）。?paz=16＝タイル最細(z≈16-17)までベクタ建物で粘るA/B実験ノブ（デモのz15.5フライトは15前提＝既定は据置）
// ズームアウトの保持：既に立っている区はズームアウトでは消さない＝「一回消えて基図建物で書き直す」没入切れ
// の根治（本人裁定2026-08-03「格段良くなった」＝全保持を既定化）。手放すのは遠方離脱（FAR_DEG）と真俯瞰だけ。
// 非表示は元々メモリを返さない（解放は遠方evictのみ＝常駐保持）ので保持のコストは頂点処理時間だけ
// → WebGPU×非LOW_MEM 限定（GL2/低メモリ端末は従来どおりズームアウトで即非表示）。新規ロード発火は従来どおり AUTO_Z 以上のみ。
// ?pazh=N＝保持を浅く戻す口（AUTO_Z−N で非表示・低ズームの頂点代が問題になった時の後退線。例 pazh=2）。
const PLATEAU_HIDE_Z = (gpuBackend && !LOW_MEM) ? PLATEAU_AUTO_Z - qNum(/[?&]pazh=(\d+(?:\.\d+)?)/, Infinity) : PLATEAU_AUTO_Z;
// ── 遠景far-DB＝「いつも描くDB」（本人裁定2026-08-04・閾値15m）：z15帯の建物の崖をPLATEAU抽出の軽量箱で埋める。
// 実体は plateauworker（#far導出・プリズム生成）→ 既存plateauパイプに `${ward}#far` バッチで相乗り（マスク不参加）。
// 可用性＝一度でも完走焼きした区だけ＝訪れるほど遠景が育つ（ambient/データ重力と同思想）。WebGPU×非LOW_MEM限定。
const FAR_H = qNum(/[&?]farh=(\d+)/, 200);  // 高さ閾値(m)＝200m級＝真の超高層だけの星座（本人裁定2026-08-04夜「z14から+200m以上で少し綺麗にかつ軽く」・100m=都内~600棟から更に絞る）。
                                            // 15m案は都心区でほぼ全建物が通り数万箱＝メモリ爆上がりの轍→50m→実機比較で100に着地。?farh=Nで実験可
const FAR_Z = 14;                           // 遠景箱の点灯下限ズーム（本人裁定2026-08-04夜=13→14へ・出現を遅らせて遠すぎる箱を見せない）
const noFar = /[?&]nofar=1/.test(location.search);   // ?nofar=1＝遠景far-DB箱を完全に切る（刺さり/めり込みの切り分け用）
const farShown = new Set();                 // 要求済み/表示中の区（active化で退場→再要求可に戻す）
const farMissed = new Set();                // #far整備不能（完走焼き無し）＝farReadyが来るまで再要求しない
// far育成キュー：#far無し(farMiss)の区は、焼きがあれば worker のfarBakeで「読むだけ導出」。1区ずつ直列＝
// 視界いっぱいのfarMiss一斉発生でIDB/OPFS読みの山を作らない。育ったら farReady→autoFar が次のパスで点灯。
const farBakeQ = []; const farBakeTried = new Set(); let farBaking = null;
function farBakeNext() {
	if (farBaking || !farBakeQ.length) return;
	// 育成は暇な時だけ：v3/閾値移行の残務（区ごと全量読み直し）が復元・飛行と重なると、workerヒープの
	// 一時ゴミ高水位が段階的に積み上がる（本人実測「FlyToで+1GB→14.5GB」2026-08-04夜）。移動/飛行中は退いて再試行
	if (moving || flying) { setTimeout(farBakeNext, 3000); return; }
	farBaking = farBakeQ.shift();
	plateauWorkers[hashStr(farBaking.base) % PLATEAU_NW].postMessage({ type: "farBake", base: farBaking.base, ward: farBaking.name });
}
dbgHost.__farState = () => ({ shown: [...farShown], missed: [...farMissed], baking: farBaking?.name ?? null, q: farBakeQ.length, tried: [...farBakeTried],
	active: [...plateauActive.keys()], loading: [...plateauLoading.keys()], resident: [...plateauResident.keys()],
	failed: [...plateauFailed].map(([n, f]) => `${n}${f.perm ? "(perm)" : `(${Math.max(0, PLATEAU_RETRY_MS - performance.now() + f.ts) / 1000 | 0}s left)`}`),
	zoom: +cam.zoom.toFixed(2), pitch: +((cam.pitch || 0) * 180 / Math.PI).toFixed(1), farLit,
	// autoPlateau のゲートと選抜の「今この瞬間」：flying/moving が真のままなら本体は凍結（ロードも退場も走らない）。
	// hits＝実ロード候補の順位（autoPlateau と同じ 足元(foot)主キー・中心第2キー）。ここが期待どおりなのに
	// loading が空なら settle が来ていない＝ゲート側、が切り分けの読み方。
	flying, moving, printHold,
	hits: (() => {
		try {
			const view = approxViewBbox(cam);
			const foot = cam.pitch > 0.35 ? unprojectXY(size.w / dpr / 2, size.h / dpr * 0.98) : null;
			if (foot) { view[0] = Math.min(view[0], foot[0]); view[1] = Math.min(view[1], foot[1]); view[2] = Math.max(view[2], foot[0]); view[3] = Math.max(view[3], foot[1]); }
			const pd2 = (s, p) => { const dx = Math.max(s.bbox[0] - p[0], 0, p[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - p[1], 0, p[1] - s.bbox[3]); return dx * dx + dy * dy; };
			return PLATEAU_SETS.filter(s => !s.noMask && bboxIntersects(s.bbox, view) && !plateauDead(s.name))
				.map(s => ({ n: s.name, d: +Math.sqrt(pd2(s, foot || cam.center)).toFixed(4) }))
				.sort((a, b) => a.d - b.d).slice(0, 8).map(h => `${h.n}:${h.d}`);
		} catch (e) { return ["ERR:" + (e.message || e)]; }
	})() });   // デバッグ：遠景枠の現在地＋本物側の状態機械＋カメラ＋ゲート＋選抜（箱残留の切り分けに一式）
// LOW_MEM（低メモリ端末判定）はファイル冒頭で定義（renderWorker init にも渡すため）。
if (LOW_MEM) console.log("[plateau] low-memory device mode: 2 concurrent wards, 1 worker, no cache");
// 同時アクティブ地区数の上限＝GPUメモリを有界にする（密集地区(都心部)1件あたりGPUバッファ~100-140MB）。
// デスクトップは4区（計~0.5GB＝余裕内）＝高チルトで「手前の区＋正面の区」を同時に立てる。
// 4はシェーダの被覆マスクスロット上限（glsl u_plateauMask0..3・renderer MAX_PLATEAU_MASKS）＝これ以上は基図建物を伏せられず二重に立つ。
const PLATEAU_MAX_ACTIVE = qNum(/[?&]maxact=(\d+)/, LOW_MEM ? (gpuBackend ? 2 : 1) : (MID_TIER ? 2 : 4));   // LOW_MEM=2区（千代田⇄中央カタカタ根治）。worker切離し済＝増えるのは常駐のみ(+1区~100-140MB)・過渡はbldCap据置で不変。
                            // MID_TIER=2区＝内蔵GPU機はVRAMがシステムRAMの取り分＝4区(~0.5GB)が同じ財布から出る（Windows 16GB+HD の落ち・2026-08-03）
                            // GL2フォールバック時のLOW_MEMは1区＝WebGPUの無い旧iOS(XR級3GB)の②常駐天井を守る安全モード（XS=4GBは2でも実証済みだが端末RAMはiOSから検出不能＝低い方に合わせる。?maxact=2 が戻し口）
// マスク無しセット（橋梁等 noMask:true）の同時数＝別枠。被覆マスクのシェーダスロット(4)を使わないので
// 建物4区の構図を奪わずに載る。橋梁データは区あたり数MB〜数十MB＝建物より一桁軽い。
const PLATEAU_EXTRA_ACTIVE = LOW_MEM ? 1 : (MID_TIER ? 2 : 4);
// GPU常駐（再訪の再アップロード根絶）：視野から外れた区は「削除」でなく「非表示(plateauVis)」＝VAOをVRAMに残す。
// 再訪は vis:true を送るだけ＝100MB級の slice→transfer→bufferData が丸ごと消える（ズームアウト→戻るがタダに）。
// 本当に削除するのは ①視野中心が区bboxから PLATEAU_FAR_DEG 超離れた時（完全に離れた＝当分戻らない扱い）
// ②常駐予算超過のLRU。低メモリ端末は常駐なし＝従来どおり即削除（タブ強制終了対策を崩さない）。
// 上限は「区数」でなく「バイト」＝ackに同乗する実測メッシュバイトで数える。旧・区数8上限は橋梁も建物も同じ「1」と
// 数える上、テクスチャ付き都市は区あたり数百MB級＝区数では総量が読めない。GPUメモリOOM→context lost→自動リロード
// →GPU未復帰でwebgl2 probe null＝「表示できません」誤診の連鎖（M1 16GB実機で発生）を、総量の物差しで元から断つ。
// 実測（IDB #meta・都心notexture）：港141/新宿109/品川100/中央98MB…23区+川崎横浜の建物15セット計1.28GB。
const PLATEAU_RESIDENT_BYTES = LOW_MEM ? 0 : (MID_TIER ? 0.5e9 : 1.2e9);   // 非表示常駐まで含めた総予算。表示中(最大4+橋4)は退避対象外＝予算超過でも守る
                                                      // MID_TIER=0.5GB＝内蔵GPUは常駐がシステムRAMを直に削る（1.2GBは独立VRAM/ユニファイド前提の値）
const PLATEAU_BYTES_FALLBACK = 200e6;                 // ack未着/不明時の安全側見積り（notexture実測最大141MB・texture都市はより大の想定）。橋梁(noMask)は一桁軽い
const plateauBytes = new Map();                       // name → メッシュ実バイト（workerのackに同乗。セッション中は不変なので消さない）
const bytesOf = (name, set) => plateauBytes.get(name) ?? (set?.noMask ? 20e6 : PLATEAU_BYTES_FALLBACK);
const residentBytes = () => [...plateauResident].reduce((s, [n, st]) => s + bytesOf(n, st), 0);
const PLATEAU_FAR_DEG = 0.5;                    // 本削除の距離閾値（deg≈55km）。都心の区巡り・近郊往復では誰も落ちない
let flying = false;                        // フライト中フラグ＝autoPlateau のゲート（flyTo が立て、着地/中断で下ろす）
const plateauActive = new Map();           // 表示中の地区（renderer で vis=on）：name → set({name,base,bbox})
const plateauResident = new Map();         // GPUにVAOが乗っている地区（表示中＋非表示）：name → set。Map挿入順＝LRU
const plateauLoading = new Set();          // fetch/デコード中の地区名（二重発火防止）
const plateauAutoLoading = new Map();      // autoPlateau 発のロード中地区：name → set。視界確定時の退避対象（手動/プレロードは含めない）
const plateauCancelling = new Set();       // 遠方離脱→キャンセル送信済みの地区名。bldCap から除外＋再訪は promote で即再開（un-cancel）。部分はIDBに残る
const plateauDemoted = new Set();          // 近距離の視界外→slow lane（在庫化）中の地区名。完走して IDB＋非表示常駐へ＝さりげない仕込み。再訪は promote で fast 復帰
const plateauFastT = new Map();            // name → fast レーン入場時刻。fast枠ローテーション（下）の物差し
const PLATEAU_ROTATE_MS = 60e3;            // fast枠の占有タイムスライス：これを超えて待ち区が居れば席を譲る（巨大区×低速APIの飢餓対策）
let plateauPrefetchBusy = false;           // デモ先読みが直列デコード中＝autoPlateau の建物枠を1つ譲る（総同時2区の保証）
// ロード失敗の台帳：perm=葉0枚（廃止区＝浜松西区22133等の残骸）＝恒久に掴まない／非perm=通信失敗（APIハング等の
// 一時障害）＝60秒バックオフ後に再挑戦（旧・Set＝一時障害もセッション永久追放で、真上に立っても本物が二度と
// 来ず遠景箱だけが残った＝渋谷/新宿 z15.9 実測 2026-08-11）。毎onMoveの再挑戦スパムはバックオフが断つ。
const plateauFailed = new Map();           // 地区名 → { perm, ts }
const PLATEAU_RETRY_MS = 60000;
const plateauDead = name => { const f = plateauFailed.get(name); return !!f && (f.perm || performance.now() - f.ts < PLATEAU_RETRY_MS); };
let plateauPinned = new Set();             // 台本 plateau: リスト記載の地区名＝視界内なら選抜キャップ無視で強制表示（デモ▶で設定・カタカタ根治）
function plateauHide(name) {   // 視野外れ＝非表示（GPU常駐は維持）。常駐対象外（低メモリ端末）はそのまま削除
	if (plateauResident.has(name)) renderer.set("plateauVis", false, name);
	else renderer.set("plateauMesh", null, name);
}
function plateauEvict(name) {  // 本削除＝GPUバッファ解放（遠方離脱/常駐上限超過だけがここへ来る）
	plateauResident.delete(name);
	renderer.set("plateauMesh", null, name);   // freePlateauWard の prefix 一致で `名前#far` の遠景箱も同時に手放す
	farShown.delete(name);                     // 再訪時に autoFar が箱を再点灯できるように
}
function plateauRetain(name, set) {   // 常駐登録＋LRU touch。予算超過は最古の非表示区から追い出す（表示中/読込中は守る）
	if (!PLATEAU_RESIDENT_BYTES) return;
	plateauResident.delete(name); plateauResident.set(name, set);
	while (residentBytes() > PLATEAU_RESIDENT_BYTES) {
		// n !== name＝いま touch した本人は守る（常駐ヒット経路は plateauActive.set より先に retain が走る＝
		// activeガードだけだと「これから点灯する区」を自分で追い出し、消えたメッシュに vis:true を送る亡霊状態になる）
		const oldest = [...plateauResident.keys()].find(n => n !== name && !plateauActive.has(n) && !plateauLoading.has(n));
		if (!oldest) break;   // 退避できるのは非表示だけ＝表示中だけで予算超過なら何もしない（構図は崩さない）
		plateauEvict(oldest);
		console.log(`[plateau] resident budget -> evicted ${oldest} (left ${plateauResident.size} wards ~${(residentBytes() / 1048576) | 0}MB / budget ${(PLATEAU_RESIDENT_BYTES / 1048576) | 0}MB)`);
	}
}

// PLATEAU worker プール：tileset fetch・Draco解凍・ECEF変換・重複面dedup・RTE・被覆マスク、全部ここでやる（メインスレッドはブロックしない）。
// 密集地区(都心部)1件のデコードは実測40〜50秒かかる重い処理＝worker化しないとその間UIが完全に固まる。
// 非LOW_MEM は PLATEAU_MAX_ACTIVE と同数だけ用意＝同時アクティブな複数地区が別コアで並行デコードできる。
// メッシュ本体（密集区で~160MB の typed array）は sceneChan と同じく worker→render worker の直結ポートで渡す。
// main 経由で postMessage すると transfer 無しの構造化クローン＝メインスレッドが数百msブロックされるため、main には ok/失敗の ack しか流さない。
// ⚠ LOW_MEM は worker 1本固定＝maxact と非連動。各 worker は loaders.gl(Draco wasm/3d-tiles) を丸ごと抱える＝起動ベースラインが重く、
// maxact=2 で 2本に増やすと PLATEAU 描画前（2D段階）にタブ予算を超えて落ちた（8GB実機で実測 2026-07-30）。
// bldCap=1 で同時デコードは1区ずつ＝worker 1本で maxact=2 の「表示2区」も順次達成できる（並行デコードは不要）。
// MID_TIER は 2本上限＝各 worker が loaders.gl(Draco wasm/3d-tiles) を丸ごと抱える起動ベースラインが、
// コールドの山にそのまま人数分加算されるため（8GB実機では 1→2 本でも 2D 段階で落ちた実測＝上のコメント）。
const PLATEAU_NW = LOW_MEM ? 1 : (Math.min(MID_TIER ? 2 : PLATEAU_MAX_ACTIVE, (navigator.hardwareConcurrency || 4) - 1) || 1);
const plateauWorkers = [], plateauPending = new Map();
const plateauMemW = [];   // ?hud=1（旧mem=1）：worker index → {cache, live}＝HUD の「過渡」行（常駐台帳に乗らないRAM）
let plateauReqId = 0;
let plateauCamSent = 0;   // カメラ放送のスロットル（ロード中のみ~4Hz）
for (let i = 0; plateauOn && i < PLATEAU_NW; i++) {   // plateau OFF＝workerを1本も起こさない
	const w = new Worker(new URL("./plateauworker.js", import.meta.url), { type: "module" });
	const meshChan = new MessageChannel();   // この worker → render worker のメッシュ直結パイプ
	w.postMessage({ type: "init", meshPort: meshChan.port1, lowMem: LOW_MEM, mid: MID_TIER, mem: hudOn, noOpfs: /[?&]noopfs=1/.test(location.search), farH: FAR_H, ell: ELL_ON }, [meshChan.port1]);   // ?noopfs=1＝バッチ本体のOPFS置きを無効化（従来IDB）＝A/B・切り分け用。farH＝遠景far-DBの高さ閾値
	wPost({ type: "plateauPort", port: meshChan.port2 }, [meshChan.port2]);
	w.onmessage = e => {
		if (e.data.prog) { plateauProg.set(e.data.prog.name, e.data.prog); renderPlateauProg(); return; }   // タイル/走査進捗（ネットワーク経路のみ）
		if (e.data.farMiss) {   // #far無し：焼きがあるかもしれない＝一度だけ育成を試す（perm=完走焼き無し＝実ロード完走待ち）
			const n = e.data.farMiss.name;
			farShown.delete(n); farMissed.add(n);   // 育成中/不能の間は再要求を止める（解除は farReady）
			if (farBaking?.name === n) { farBaking = null; setTimeout(farBakeNext, 3000); }   // 育成失敗の返信＝間を置いて次の区へ（連打で churn の山を作らない）
			const s = !e.data.farMiss.perm && !farBakeTried.has(n) && PLATEAU_SETS.find(x => x.name === n);
			if (s) { farBakeTried.add(n); farBakeQ.push({ base: s.base, name: n }); farBakeNext(); }
			return;
		}
		if (e.data.farSent) {   // 箱の実送達通知：退場と競争して負けた（遅着した）箱をここで検分して即退場させる。
			// 正常系＝farShown に居て本物も来ていない→何もしない。競争系＝退場済み（farShown に無い）or
			// 本物が立つ/来る区→空メッシュで即消し（autoFar の退場と同じ所作・冪等）。
			const n = e.data.farSent.name;
			if (!farShown.has(n) || plateauActive.has(n) || plateauLoading.has(n)) {
				renderer.set("plateauMesh", { pos: new Float32Array(0), nrm: new Int8Array(0), idx: new Uint32Array(0) }, n + "#far");
				farShown.delete(n);
				needsDraw = true;
			}
			return;
		}
		if (e.data.farReady) {   // #farが育った（完走保存/育成どちらでも）＝点灯可
			farMissed.delete(e.data.farReady.name);
			if (farBaking?.name === e.data.farReady.name) { farBaking = null; setTimeout(farBakeNext, 3000); }   // 間隔つき＝残務を静かに消化
			if (!moving && !flying) autoPlateau(true);   // 静止シーンでも即点灯（onMoveが来ない＝この一突きが無いと次のカメラ操作まで立たない）
			return;
		}
		if (e.data.type === "idbList") { plateauListPending.shift()?.(e.data.items); return; }              // データ管理モーダルの一覧応答
		if (e.data.type === "idbDeleted") { plateauDeletePending.get(e.data.base)?.(e.data.n); plateauDeletePending.delete(e.data.base); return; }
		if (e.data.type === "membytes") { plateauMemW[i] = e.data; return; }   // ?hud=1：この worker の過渡（内部cache＋ロード中の保持）バイト
		const p = plateauPending.get(e.data.id); if (!p) return; plateauPending.delete(e.data.id);
		if (p.name) { plateauProg.delete(p.name); renderPlateauProg(); }   // 完了/失敗どちらでも ack で消灯＝消し忘れが無い
		if (e.data.bytes && p.name) plateauBytes.set(p.name, e.data.bytes);   // 実測メッシュバイト＝常駐バイト予算LRUの物差し
		if (e.data.error) p.reject(new Error(e.data.error));
		else p.resolve(e.data.ok);   // ok=false は0三角形など soft failure（worker側でconsole.error済み）。メッシュ本体は直結ポートで render worker へ送付済み
	};
	plateauWorkers.push(w);
}
// base URL のハッシュで固定の worker へルーティング＝同じ地区は毎回同じ worker が受ける→worker内蔵cacheが再訪で効く。
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }
// デバッグ用：PLATEAUのメモリ/IDBキャッシュ全消去（デコード形式が壊れた疑いがある時に）。通常はFMT_VERが自動無効化する。
dbgHost.__plateauPurge = () => {
	plateauWorkers.forEach(w => w.postMessage({ type: "purge" }));
	for (const n of [...plateauResident.keys()]) if (!plateauActive.has(n)) plateauEvict(n);   // GPU常駐も非表示分は解放（表示中は残す）
};
// タイル読み順の錨＝「目の前」。真俯瞰は注視点（center）だが、チルト時は画面下端の接地点（foot）＝
// 正射投影では画面下半分が数kmぶんの手前地面を占め、注視点中心のリング順だと**画面の主役（足元の街）が
// 最後に立つ**（飯山 z15.75/63t 実測 2026-08-03「手前に何もない」）。区の選抜（autoPlateau の foot 優先）と
// 同じ作法を、区内タイルのソート（plateauworker への camCenter／cam 放送）にも通す。foot が球外なら center。
function plateauSortAnchor() {
	const foot = cam.pitch > 0.35 ? unprojectXY(size.w / dpr / 2, size.h / dpr * 0.98) : null;
	return foot ? [wrapLon(foot[0]), foot[1]] : [cam.center[0], cam.center[1]];
}
function workerLoadPlateau(base, tiles, name, wardBbox, brid, ex = {}) {
	const id = ++plateauReqId, w = plateauWorkers[hashStr(base) % PLATEAU_NW];
	// wardBbox＝区単位の被覆マスク座標系。camCenter＝バッチのカメラ近傍優先ソート（目の前から立ち始める）。
	// brid＝橋梁モード：バッチ接地（桁が海面へ沈まない）＋両面描画（ケーブル等の開いた薄面が裏から消えない）。
	// clip/tilesetUrl＝登録簿の任意欄（オランダ3DBAG等の「国土1枚もの」を街の矩形で切って使うため。PLATEAUは共に undefined）
	w.postMessage({ id, base, tiles, name, wardBbox, brid: !!brid, camCenter: plateauSortAnchor(), clip: ex.clip || null, tilesetUrl: ex.tilesetUrl || null });
	return new Promise((resolve, reject) => plateauPending.set(id, { resolve, reject, name }));   // name＝進捗の消灯キー
}
// PLATEAU 読込進捗（左下）：地区別のバッチ進捗を1行に集計。ネットワーク経路（初回訪問）だけ表示され、
// メモリ/IDBキャッシュ命中時は一瞬で終わるので出ない。消灯は ack（完了/失敗）で行う。
const plateauEl = document.createElement("div");
plateauEl.id = "plateau-toast";   // スタイルは style.css
mapEl.appendChild(plateauEl);
const plateauProg = new Map();   // name → { scan } | { done, total }（scan＝カタログ走査中の枚数）
let sceneProgTap = null;   // シーン再生(waitLoading)の進捗パネルへの中継口＝待機中だけ playScene が配線（宣言は使用点 renderPlateauProg より先＝初期化中の worker 便で TDZ を踏まない）
function renderPlateauProg() {
	if (!plateauProg.size) plateauEl.style.display = "none";
	else {
		plateauEl.textContent = t("🏙 建物3D 読込中 ") + [...plateauProg.values()]
			.map(p => p.total ? t("{0} {1}/{2}枚", p.name, p.done, p.total) : t("{0} カタログ走査 {1}…", p.name, p.scan ?? 0)).join("・");
		plateauEl.style.display = "block";
	}
	plateauDb.onProg(plateauProg);   // データ管理モーダルにも同じ進捗を流す（開いていなければ即return）
	sceneProgTap?.();   // シーン再生の読み込み待ちパネルにも同じ進捗を流す（waitLoading 中だけ配線・未設定なら無音）
}
// --- 建物3D（PLATEAU）データ管理モーダル：カタログ×IDB。worker 配線だけ渡し、DOMはモジュール側が組む。
const plateauListPending = [];        // idbList 応答待ち（FIFO。IDBは全workerで共有＝worker0固定で聞く）
const plateauDeletePending = new Map();   // base → resolver（削除は base ルーティング＝メモリキャッシュの持ち主に届く）
const plateauIdbList = () => new Promise(res => { plateauListPending.push(res); plateauWorkers[0].postMessage({ type: "idbList" }); });
const plateauIdbDelete = base => new Promise(res => { plateauDeletePending.set(base, res); plateauWorkers[hashStr(base) % PLATEAU_NW].postMessage({ type: "idbDelete", base }); })
	.then(n => {   // GPU常駐コピーも道連れ（表示中は従来どおり残す）＝「削除」した区が常駐ヒットで蘇らないように
		const name = [...plateauResident.entries()].find(([, s]) => s.base === base)?.[0];
		if (name && !plateauActive.has(name)) plateauEvict(name);
		return n;
	});
// デモ台本のPLATEAU先読み：z14+で着地するシーンの足元の区を台本から自動導出し、IDBへ静かに仕込む（描画へは送らない）。
// 台本の早いシーン（球・列島・スライド）の間に裏で完走→PLATEAUシーンに着いた時はIDB直読み＝初見のPCでも一発で街が立つ。
// 直列1区ずつ＝訪問者の帯域を占有しない（飛行中の基図タイルと取り合わない）。IDB命中は即成功＝二度目からはタダ。
async function prefetchPlateauForViews(views, names, onProgress) {
	if (!plateauOn) return [];
	// 【▶の瞬間から走る】旧・LOW_MEM は boot+45秒遅延（鉄道地図z14.5タイルとデコードが重なる jetsam 対策）
	// だったが、テーマ切替（c=）の各ページは十数秒で reload されタイマーごと消える＝iPhone では実質
	// 「最後の reload+45秒後」まで先読みが始まらず、重要シーンに間に合わなかった。遅延は撤去。
	// reload で切れても plateauworker の部分再開が続きから＝reload 毎の切れ端も貯金になる。
	// names＝台本（scenes.js の plateau:）の明示リスト（優先順）。指定があれば導出は使わない＝決定的。
	await plateauCatalogReady;
	if (!PLATEAU_SETS.length) return [];
	if (names?.length) {
		const bad = [];
		const wanted = names
			.map(n => { const s = PLATEAU_SETS.find(x => x.name === n); if (!s) bad.push(n); return s; })
			.filter(s => s && !plateauDead(s.name));
		if (bad.length) console.warn("[demo] plateau names not in catalog (script typo?):", bad.join("・"));
		// ピン留め＝リスト記載の区は autoPlateau の選抜キャップを無視して強制表示（デモ終了後もセッション中は有効）
		plateauPinned = new Set(wanted.map(s => s.name));
		return runPrefetch(wanted, "scripted", onProgress);
	}
	return runPrefetch(deriveScriptSets(views), "derived from views", onProgress);
}
// 台本の視点列→PLATEAU区集合の導出（2026-08-12 関数化＝先読みと静穏窓の大掃除で共用）。
// 【順序＝一巡目に「各停止位置の中心区＋橋梁」】旧・台本順に停止位置ごと全区を流すと、序盤の停止位置の
// 隣接区で時間を使い切り後半の停止位置は素通しになる（iPhone のデモ実測＝重要シーンほど出ない）。
// 一巡目＝各停止位置の最寄り建物1区＋橋梁（サイズ一桁小さい割にシーンの主役＝レインボーブリッジ等。
// Kenji 指定 2026-07-29）→二巡目＝「視線の先に居る」隣接建物区だけ。
// 隣接区の要否は距離でなく構図＝チルト時は視界が bearing 方向へ伸びる。前方点（中心から視線方向へ
// ~900m）への近さで裁く＝東京駅シーン(東向き)の中央区(八重洲)は入り、新宿シーン(北東向き)の南隣・
// 渋谷区（大区＝読むのに時間がかかる割に構図外）は落ちる（Kenji 指摘 2026-07-29）。
// 中断は plateauworker の部分再開が貯金に変える＝テーマ切替 reload で切れても続きから。
function deriveScriptSets(views) {
	const MARGIN = 0.012;   // 区bboxへの点距離ゲート（≈1.3km）＝着地視界＋隣接区まで拾う
	const NEIGH = 0.008;    // 隣接区の前方点ゲート（≈900m）。MARGIN より狭い＝構図に実際入る近さだけ
	const perView = [];
	for (const hash of views) {
		const v = typeof hash === "string" ? parseViewHash(hash) : null;
		if (!v || v.zoom < PLATEAU_AUTO_Z) continue;
		const p = [wrapLon(v.lon), v.lat];
		// 前方点＝チルト構図（pitch>20°）だけ視線方向へ押し出す（autoPlateau の foot と対の「奥」判定）
		const fwd = v.pitch > 0.35
			? [p[0] + Math.sin(v.bearing) * NEIGH / Math.max(0.2, Math.cos(v.lat * D2R)), p[1] + Math.cos(v.bearing) * NEIGH]
			: p;
		const pd2 = (s, q) => { const dx = Math.max(s.bbox[0] - q[0], 0, q[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - q[1], 0, q[1] - s.bbox[3]); return dx * dx + dy * dy; };
		// 同点タイブレーク＝重心距離（autoPlateau の near と同じ規約）。bbox は矩形＝密集地では複数区の
		// bbox が停止点を含み pd2=0 の同点になり、旧・カタログ配列順の成り行きで
		// 東京駅→港区／スカイツリー→荒川区／新宿→渋谷区 と「主役でない区」を先読みしていた
		//（＝正しい区はシーン到着後にゼロから読む二重読み＝iPhone クラッシュ圧の正体。実カタログで再現確認済み）。
		const c2 = s => { const cx = (s.bbox[0] + s.bbox[2]) / 2, cy = (s.bbox[1] + s.bbox[3]) / 2; return (cx - p[0]) ** 2 + (cy - p[1]) ** 2; };
		const near = PLATEAU_SETS.filter(s => !plateauDead(s.name) && pd2(s, p) < MARGIN * MARGIN)
			.sort((a, b) => (pd2(a, p) - pd2(b, p)) || (c2(a) - c2(b)));
		// 建物枠＋橋梁(noMask)別枠＝autoPlateau の選抜と同じ構成＝着地時に立つ区を過不足なく仕込む
		perView.push({
			bld:  near.filter(s => !s.noMask).slice(0, PLATEAU_MAX_ACTIVE),
			brid: near.filter(s => s.noMask).slice(0, PLATEAU_EXTRA_ACTIVE),
			fwd,
		});
	}
	const wanted = [], seen = new Set();
	const take = s => { if (s && !seen.has(s.name)) { seen.add(s.name); wanted.push(s); } };
	const pd2q = (s, q) => { const dx = Math.max(s.bbox[0] - q[0], 0, q[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - q[1], 0, q[1] - s.bbox[3]); return dx * dx + dy * dy; };
	for (const v of perView) { take(v.bld[0]); v.brid.forEach(take); }          // 一巡目＝各停止位置の中心区＋橋梁（軽くて主役）
	for (const v of perView) v.bld.slice(1).filter(s => pd2q(s, v.fwd) < NEIGH * NEIGH).forEach(take);   // 二巡目＝視線の先の隣接区だけ
	return wanted;
}
// 静穏窓の大掃除（裁定2026-08-12「書き終わった後の静かな時間を活用」）＝自動上演の各行で書き終わりゲートが
// 開いた瞬間（hold開始＝飛行も読み込みも静か）に demo が呼ぶ（onQuiet 注入・行ごと1回）。
// 「残りの台本にもう出ない」非表示常駐区を GPU から降ろす＝台本知の特権（通常運転の LRU は未来を知らない）。
// 表示中・読込中・現在視界と交差する区は触らない（構図と直後の回り込みを崩さない）。LOW_MEM は常駐ゼロ＝素通り。
function plateauTrimForScript(views) {
	if (!plateauResident.size) return;
	const keep = new Set(deriveScriptSets(views).map(s => s.name));
	let freed = 0;
	for (const n of [...plateauResident.keys()]) {
		if (keep.has(n) || plateauActive.has(n) || plateauLoading.has(n)) continue;
		const s = plateauResident.get(n);
		if (s?.bbox && bboxIntersects(s.bbox, approxViewBbox(cam))) continue;
		freed += bytesOf(n, s); plateauEvict(n);
	}
	if (freed) console.log(`[plateau] quiet-window cleanup = evicted residents absent from remaining script ~${(freed / 1048576) | 0}MB (left ${plateauResident.size} wards ~${(residentBytes() / 1048576) | 0}MB)`);
}
async function runPrefetch(wanted, how, onProgress) {   // 戻り値＝対象区リスト（scene 再生のリビール準備＝全区スタンドアップが使う）
	if (!wanted.length) return wanted;
	console.log(`[demo] PLATEAU prefetch ${wanted.length} wards (${how}): ${wanted.map(s => s.name).join("・")}`);
	plateauPrefetchBusy = true;   // 先読み中＝autoPlateau の建物枠を1つ譲る（デコード同時数の総枠を保つ）
	let done = 0; onProgress?.(0, wanted.length, null);   // 進捗＝総区数を先に伝える（waitLoading の中央表示用）
	try {
		// 並行2区（Kenji 指定 2026-07-29「2つずつぐらい読まないと間に合わない」）。直列1区は帯域を
		// 使い切れず（fetch レイテンシの谷）、東京駅到着までに主役区が揃わなかった。到着済みの区は
		// autoPlateau がIDB直読みで立てる。base ハッシュの worker 固定ルーティングは並行でも維持される。
		// 【本番最優先】①可視の自動ロード（PLATEAUシーンで今まさに立てている区）②標高タイル読込
		//（elevBusy＝地形シーンの起伏。iPhone13実測：▶直後から全速の先読みが富士山〜阿蘇帯で標高タイルと
		// 帯域/IDBを取り合い「標高が表示されない」）——のどちらかが走っている間は次の先読みを始めない＝
		// 帯域・Dracoデコード・IDB書き込みを全部シーンへ明け渡す。キャンセル中/在庫slow中の区は待たない＝背景同士。
		// 既に走っている先読みは中断しない（多くは同区で inflight 合流する）。
		// flying/moving も柵に加える（2026-08-04）：飛行中は terrainGate が標高 ensure を止めるので elevBusy=false
		// ＝旧柵では「飛行中こそ先読みが全力で回る」だった。着地の瞬間は R01 近傍9枚（生Int16 26MB級×並列）＋
		// R10 窓のデコードバーストが来る＝そこへ Draco デコードが重なるのが 3GB 機（iPad Air3）の飛行中 jetsam の型。
		// 飛行は数秒＝先読みの遅れは誤差（走行中の先読みは中断しない＝止めるのは「次の区の開始」だけ）。
		const visibleBusy = () => flying || moving || elevBusy || [...plateauAutoLoading.keys()].some(n => !plateauCancelling.has(n) && !plateauDemoted.has(n));
		let wi = 0;
		const pump = async () => {
			for (;;) {
				while (visibleBusy()) await new Promise(r => setTimeout(r, 1000));
				const s = wanted[wi++];
				if (!s) return;
				await plateauPreload(s);
				onProgress?.(++done, wanted.length, s.name);   // 1区 IDB へ焼けた＝進捗を1つ進める
				autoPlateau(true);   // 先読み完了の瞬間に表示判定を一突き＝「先読み中にもう着いていた」際、静止したままでも即立つ（読込中ガードで見送られた分の敗者復活）
			}
		};
		await Promise.all([pump(), pump()]);
	} finally { plateauPrefetchBusy = false; autoPlateau(true); }   // 先読み終了＝譲っていた枠を返して再選抜
	return wanted;
}
function plateauPreload(set) {   // プレロード＝IDBに貯めるだけ（描画へ送らない）。表示中/読込中の地区はそのまま成功扱い
	if (plateauLoading.has(set.name) || plateauActive.has(set.name)) return Promise.resolve(true);
	plateauLoading.add(set.name);
	const id = ++plateauReqId, w = plateauWorkers[hashStr(set.base) % PLATEAU_NW];
	// レーンは fast のまま（lowMem も）。slow（並行1本＋250ms間隔）を一度試したが、港区級（数百タイル）が
	// デモ1周かかっても終わらない実測＝「故意に遅い」。lowMem の jetsam 余裕は BATCH_TILES=16・並行4・
	// CACHE_MAX=0・クレジット送出で既に取ってある＝先読みは普通の速度で焼き、直列1区が帯域の上限を裁く。
	w.postMessage({ id, base: set.base, name: set.name, wardBbox: set.noMask ? null : set.bbox, brid: !!set.noMask, camCenter: plateauSortAnchor(), preload: true, clip: set.clip || null, tilesetUrl: set.tilesetUrl || null });
	return new Promise((resolve, reject) => plateauPending.set(id, { resolve, reject, name: set.name }))
		.catch(() => false).finally(() => plateauLoading.delete(set.name));
}
const plateauDb = createPlateauDb({
	getSets: () => PLATEAU_SETS, idbList: plateauIdbList, idbDelete: plateauIdbDelete, preload: plateauPreload,
	// 描画＝モーダルを閉じて地区中心へ球面フライト（z15.5=PLATEAU自動ロード圏・チルト45°）→ autoPlateau がキャッシュ命中で即表示
	show: set => { plateauDb.close(); flyTo((set.bbox[0] + set.bbox[2]) / 2, (set.bbox[1] + set.bbox[3]) / 2, 15.5, 45); },
});
// モーダルを開くボタンはオプトインガジェット（gadgets/plateau.js）＝末尾の map.gadget("plateau", …) で open を注入。
// ストレージの永続化を要求＝ディスク逼迫時にブラウザ都合でオリジンごと退避されるのを防ぐ（デモ機の仕込み保護）。
// persist() は window 限定 API。Chrome はエンゲージメント次第で無言許可、拒否でも動作は変わらない。
if (plateauOn) navigator.storage?.persist?.().then(ok => console.log(`[plateau] storage persist: ${ok ? "granted" : "denied"}`)).catch(() => {});

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
const bboxIntersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// 現在地＋ズームで登録簿を引き、視野に重なる地区を全部ロード／外れた地区は解放。区境をまたぐと複数地区が同時アクティブになる（上限 PLATEAU_MAX_ACTIVE）。
// onMove から毎回呼ぶがガードで実質タダ。
// settled＝「視界が落ち着いた」（onMove の settle タイマー発火）。ロードの意思決定はこの瞬間だけ：
// - 新規ネットワークロードは settled 時のみ発火＝パンで通過しただけの区はそもそも読み始めない
// - settled 時に現地点が未ロードなら優先度MAX＝視界に居ない在庫ロードを全キャンセルし帯域/CPUを明け渡す
//   （現地点が揃っているなら在庫ロードは完走させる＝IDBが温まり無駄にならない）
// 移動中(settled=false)は表示系のみ：常駐ヒットの即表示・視野外の非表示・カメラ放送（従来の体感は不変）。
// 遠景far枠の選抜：視界に掛かる非active区の軽量箱を点灯・本物が立つ区は箱を退場（二重立ち回避）。
// 常駐（VRAM保持）区は触らない＝本物のメッシュ/マスクの状態機械（autoPlateau）と競合させない。
// z13未満/真俯瞰は消灯（本人裁定2026-08-04「流石の遠景もz13で辞めていい」）＝vis切替のみ＝GPU常駐保持・復帰はタダ。
let farLit = true;
function autoFar() {
	if (noFar || !plateauOn || !gpuBackend || LOW_MEM || !PLATEAU_SETS.length) return;   // ?nofar=1＝遠景箱を切る
	if (cam.zoom < FAR_Z || (cam.pitch || 0) < 0.02) {
		if (farLit) { for (const n of farShown) renderer.set("plateauVis", false, n + "#far"); farLit = false; }
		return;
	}
	if (!farLit) { for (const n of farShown) renderer.set("plateauVis", true, n + "#far"); farLit = true; }
	const view = approxViewBbox(cam);
	// 近接抑制の物差し：区bboxへの点距離（autoPlateau の pd2 と同式）。箱は「数km先のスカイライン」用の遠景家具＝
	// 実メッシュ帯（z≥AUTO_Z）で約2km圏の区は箱を出さない。本物の同時表示枠（PLATEAU_MAX_ACTIVE=4＝マスク
	// スロットの物理上限）から溢れた隣接区（麻布台 z17.6 で渋谷区が hits5位・実測 2026-08-11）は実メッシュに
	// 交代する日が来ない＝巨大箱が本物の隣に立ち続ける、の根治。遠景の箱は従来どおり。
	const farNearD2 = 0.025 * 0.025;   // ~2.2km
	const farPd2 = s => { const dx = Math.max(s.bbox[0] - cam.center[0], 0, cam.center[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - cam.center[1], 0, cam.center[1] - s.bbox[3]); return dx * dx + dy * dy; };
	for (const s of PLATEAU_SETS) {
		if (s.noMask) continue;   // 橋梁等は遠景箱の対象外
		if (plateauActive.has(s.name) || plateauLoading.has(s.name)) {
			// 本物が立つ/来る区＝箱は退場（空メッシュ送信＝rendererが旧バッチを削除）。擬似ward `#far` なので
			// 本物の hide/vis には一切触れない。常駐で隠れているだけの区は箱を出したまま（本物は暗いまま）
			if (farShown.has(s.name)) {
				renderer.set("plateauMesh", { pos: new Float32Array(0), nrm: new Int8Array(0), idx: new Uint32Array(0) }, s.name + "#far");
				farShown.delete(s.name);
			}
			continue;
		}
		if (plateauDead(s.name) || (cam.zoom >= PLATEAU_AUTO_Z && farPd2(s) < farNearD2)) {
			// 死亡（廃止区）/バックオフ中＝本物が来ない区、または近接（実メッシュ帯で目の前の区＝選抜4区から
			// 溢れても箱で誤魔化さない）＝箱を出さない・出ていれば退場（旧：failed も近接も知らず箱が出続けた）
			if (farShown.has(s.name)) {
				renderer.set("plateauMesh", { pos: new Float32Array(0), nrm: new Int8Array(0), idx: new Uint32Array(0) }, s.name + "#far");
				farShown.delete(s.name); needsDraw = true;
			}
			continue;
		}
		if (farShown.has(s.name) || farMissed.has(s.name)) continue;
		if (!bboxIntersects(s.bbox, view)) continue;
		farShown.add(s.name);
		renderer.set("plateauVis", true, s.name + "#far");   // 冪等unhide＝evict後の残りhideフラグ/消灯帯で届いたバッチの両方を掃除
		plateauWorkers[hashStr(s.base) % PLATEAU_NW].postMessage({ type: "far", base: s.base, ward: s.name });
	}
}
// 飛行中の「見せるだけ」：移動中は新規ロードしない（＝ロードのジッタ対策の原spec を保つ）。ただし既に GPU 常駐している区を
// 表示へ戻すのは"ロード"でない（vis フリップ＝転送ゼロ・ジッタ無し）。waitLoading が停止中に GPU まで積んだ区を、シーンの
// グライドがチルトで立ち上げる瞬間に灯すだけ＝基図の押し出し箱（LOD1）を出さず本物の PLATEAU がそのまま立ち上がる（手動チルトと同じ絵）。
function showResidentInFlight() {
	if (!gpuBackend || LOW_MEM || cam.zoom < PLATEAU_AUTO_Z || (cam.pitch || 0) < 0.02) return;
	const view = approxViewBbox(cam);
	for (const [name, s] of plateauResident) {
		if (plateauActive.has(name) || !bboxIntersects(s.bbox, view)) continue;
		plateauRetain(name, s); renderer.set("plateauVis", true, name); plateauActive.set(name, s); needsDraw = true;   // 常駐＝転送ゼロの点灯（ロードでない）
	}
}
function autoPlateau(settled = false) {
	if (!plateauOn) return;   // 機能ごと停止（opts.plateau=false）
	if (flying) { showResidentInFlight(); return; }   // フライト中は新規ロード/解放はしない（原spec＝ジッタ対策）が、既に常駐する区の点灯（=ロードでない）だけは通す＝グライドのリビールで基図の箱を出さない
	if (printHold) return;   // 印刷（平面図）撮影中＝印刷カメラで自動ロード/解放をしない（帯域と現ロード状態を乱さない）
	autoFar();   // 遠景枠は本流のゲート（zoom/pitch/視界）と独立に毎パス選抜
	// 「完全に離れた」常駐区の本削除：区bboxへの点距離が閾値超。ズームアウトだけでは落とさない＝同じ街への戻りはタダのまま。
	for (const [name, s] of plateauResident) {
		if (plateauActive.has(name) || plateauLoading.has(name)) continue;
		const dx = Math.max(s.bbox[0] - cam.center[0], 0, cam.center[0] - s.bbox[2]);
		const dy = Math.max(s.bbox[1] - cam.center[1], 0, cam.center[1] - s.bbox[3]);
		if (dx * dx + dy * dy > PLATEAU_FAR_DEG * PLATEAU_FAR_DEG) { plateauEvict(name); console.log("[plateau] far away -> evicted resident", name); }
	}
	// 視界確定時の退避＝距離で二段構え（Kenji 体感フィードバック 2026-08-01「読み込みが極端に遅い」で全キャンセルから戻した）：
	// ・近距離（PLATEAU_FAR_DEG 内＝同じ街・チルト往復・ズームバウンス）→ demote＝slow lane 在庫化。完走して
	//   IDB＋非表示常駐に落ちる＝捨てない（通過した区は「さりげない仕込み」）。一時離脱のたびに殺すと
	//   戻り毎に読み直しになり体感が壊れる。bldCap から除外済みなので新規区は塞がない（旧・全demote時代の
	//   ブロック問題は bldCap 側で解決済み）。
	// ・遠距離（55km 超＝都市を跨いだ＝当分戻らない）→ cancel＝協調キャンセル。帯域/CPU/デコードメモリを
	//   現地点へ全部返す。完成済みバッチは逐次 IDB（partial）済み＝戻れば idbLoadPartial が「続きから」。
	const parkStale = (wanted) => {
		for (const [name, s] of plateauAutoLoading) {
			if (wanted?.has(name) || plateauCancelling.has(name) || plateauDemoted.has(name)) continue;
			const dx = Math.max(s.bbox[0] - cam.center[0], 0, cam.center[0] - s.bbox[2]);
			const dy = Math.max(s.bbox[1] - cam.center[1], 0, cam.center[1] - s.bbox[3]);
			const far = dx * dx + dy * dy > PLATEAU_FAR_DEG * PLATEAU_FAR_DEG;   // 本削除（遠方→常駐解除）と同じ物差し
			plateauWorkers[hashStr(s.base) % PLATEAU_NW].postMessage({ type: far ? "cancel" : "demote", base: s.base });
			(far ? plateauCancelling : plateauDemoted).add(name);
			console.log(far ? "[plateau] left far -> load cancelled (partial IDB kept; resumes on revisit)" : "[plateau] out of view -> stocked (slow; completes into IDB)", name);
		}
	};
	// ロード中があれば最新カメラを worker 群へ放送（~4Hz）＝バッチ境界の残タイル再ソートで「今見ている側」から立つ。
	if (plateauLoading.size && performance.now() - plateauCamSent > 250) {
		plateauCamSent = performance.now();
		plateauWorkers.forEach(w => w.postMessage({ type: "cam", center: plateauSortAnchor() }));
	}
	// 真俯瞰（pitch<0.02＝show3d と同閾）は平面地図の世界＝建物3Dは描かれない＝PLATEAU を読み込まない
	//（Kenji決定 2026-07-23「平面＋3D」：真俯瞰=筆界/ユーザー層、チルト=地形/建物）。傾けた瞬間の
	// settle で従来どおり自動ロード。常駐（VRAM保持）は触らない＝チルト再開はタダのまま。
	if (cam.zoom < PLATEAU_AUTO_Z || (cam.pitch || 0) < 0.02) {
		if (settled) parkStale(null);   // ズームアウト/真俯瞰で確定＝表示に急ぎは無い。近距離は在庫slowで完走・遠方のみ中止
		if (cam.zoom >= PLATEAU_HIDE_Z && (cam.pitch || 0) >= 0.02) {   // ヒステリシス帯＝既表示は保持（消して書き直さない）・新規ロードだけ止める
			for (const [name, s] of plateauActive) {   // 保持中でも「完全に離れた」区だけは手放す（evictと同じ物差し）＝active が遠方evictを永久に塞ぐ漏れの防止
				const dx = Math.max(s.bbox[0] - cam.center[0], 0, cam.center[0] - s.bbox[2]);
				const dy = Math.max(s.bbox[1] - cam.center[1], 0, cam.center[1] - s.bbox[3]);
				if (dx * dx + dy * dy > PLATEAU_FAR_DEG * PLATEAU_FAR_DEG) { plateauActive.delete(name); plateauHide(name); needsDraw = true; console.log("[plateau] left far in hold band -> hidden", name); }
			}
			return;
		}
		for (const name of plateauActive.keys()) { plateauHide(name); console.log("[plateau] out of range -> hidden", name); }
		if (plateauActive.size) needsDraw = true;
		plateauActive.clear();
		return;
	}
	const view = approxViewBbox(cam);
	// 高チルトでは画面中心の接地点(cam.center)が手前よりずっと先＝「手前（画面下＝足元）の区」が中心距離の
	// 選抜で落ち、基図の押し出し建物のまま残る（z14.9/70°の新橋で実測）。画面下端中央の接地点(foot)も
	// 基準点に加え、視野bboxにも含める＝下にある（＝手前で大きく見える）区ほど優先で立つ。
	// 真俯瞰では下端＝単に南＝優先の意味が無いので、傾き20°超の時だけ使う。
	const foot = cam.pitch > 0.35 ? unprojectXY(size.w / dpr / 2, size.h / dpr * 0.98) : null;   // 球外(null)はfootなし扱い
	if (foot) {
		view[0] = Math.min(view[0], foot[0]); view[1] = Math.min(view[1], foot[1]);
		view[2] = Math.max(view[2], foot[0]); view[3] = Math.max(view[3], foot[1]);
	}
	const hitsAll = PLATEAU_SETS.filter(s => bboxIntersects(s.bbox, view) && !plateauDead(s.name));   // 死んだ/バックオフ中の地区は候補から除外（恒久＝廃止区・一時＝60秒後に再挑戦）
	// 近さ＝「bboxまでの点距離」（bbox内なら0）。重心距離だと南北に長い区（江東=臨海部で重心が南へ~4km）が
	// 足元に居ても落選し、チルト北向きの構図で手前だけ基図の間引き建物になる。
	// 優先順位＝チルト時は「画面下方（足元）に近い区」が主キー（手前＝一番大きく見える建物が先）、
	// 同点は中心への近さ、それも同点（bbox重複）は重心距離。ロード発火もこの順＝手前から立ち始める。
	const pd2 = (s, p) => { const dx = Math.max(s.bbox[0] - p[0], 0, p[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - p[1], 0, p[1] - s.bbox[3]); return dx * dx + dy * dy; };
	const d2 = s => pd2(s, foot || cam.center);   // 主キー：足元（真俯瞰は中心）
	const m2 = s => pd2(s, cam.center);           // 第2キー：中心
	const c2 = s => { const cx = (s.bbox[0] + s.bbox[2]) / 2, cy = (s.bbox[1] + s.bbox[3]) / 2; return (cx - cam.center[0]) ** 2 + (cy - cam.center[1]) ** 2; };
	const near = (a, b) => (d2(a) - d2(b)) || (m2(a) - m2(b)) || (c2(a) - c2(b));
	// 選抜は建物（被覆マスクのスロット4を使う）と橋梁等（noMask＝スロット不要）で別枠＝橋が建物4区の枠を奪わない。
	// 台本 plateau: リスト記載の区＝ピン留め＝視界に入っていれば選抜キャップを無視して同時表示
	//（マスクスロット上限=4区まで）。旧・LOW_MEM の同時1区キャップは、東京駅〜丸の内の滑走で最寄り区が
	// 千代田⇄中央と入れ替わるたび「片方を消して片方を読み直す」スラッシング（カタカタ）を起こしていた
	//（lowMem=常駐ゼロ＝flip 毎に再ロード）。→ LOW_MEM=2区に既定化＝両方立てて入れ替わり自体が消えた（Kenji 指定 2026-07-29／2化 2026-07-30）。
	const capMerge = (list, cap) => {
		const sel = list.slice(0, cap);
		for (const s of list.slice(cap)) if (plateauPinned.has(s.name) && sel.length < 4) sel.push(s);
		return sel;
	};
	const hits = capMerge(hitsAll.filter(s => !s.noMask).sort(near), PLATEAU_MAX_ACTIVE)
		.concat(capMerge(hitsAll.filter(s => s.noMask).sort(near), PLATEAU_EXTRA_ACTIVE));
	const hitNames = new Set(hits.map(h => h.name));
	if (settled) parkStale(hitNames);   // 視界確定＝現地点の優先度MAX。視界外は近距離=在庫slow・遠方=中止（部分IDB保持）
	for (const name of [...plateauActive.keys()]) {
		if (hitNames.has(name)) continue;
		plateauActive.delete(name); plateauHide(name); needsDraw = true;
		console.log("[plateau] out of range -> hidden", name);
	}
	// fast枠の台帳：建物(bldg)ロードで fast レーンに居るもの＝デコード過渡メモリの実占有（退避中は除外）。
	const fastBldg = () => [...plateauAutoLoading.values()].filter(s => !s.noMask && !plateauCancelling.has(s.name) && !plateauDemoted.has(s.name));
	// 建物(bldg)の同時 fast は2区まで＝4worker同時デコードの過渡メモリスパイク対策（実測：コールドIDBの
	// デモPLATEAUシーンで renderer 12.3GB・計14.9GB＝16GB機のスワップ/GPU OOMの引き金。2区制限で山を半減）。
	// 橋梁(noMask)は一桁軽いので素通し。デモ先読み中は枠を1つ譲る（先読み+auto2区=3区同時が「14G級」の残犯）。
	const bldCap = Math.max(1, (LOW_MEM || MID_TIER ? 1 : 2) - (plateauPrefetchBusy ? 1 : 0));   // MID_TIER=1区＝過渡の山（デコード中の全量保持）を非力機では重ねない
	for (const h of hits) {
		if (plateauActive.has(h.name)) continue;
		if (plateauLoading.has(h.name)) {
			if (plateauCancelling.has(h.name) || plateauDemoted.has(h.name)) {
				// 退避中の区が視界に居る：fast 枠が空いていれば即復帰。塞がっていれば「ローテーション」＝
				// PLATEAU_ROTATE_MS 以上 fast を占有した区を slow（在庫）へ回して席を譲る。巨大区×低速APIで
				// 枠が空かず「目の前の区が永遠に始まらない」飢餓の対策（杉並 z16 実測：中野+新宿(510枚)が
				// 枠を持ち切り杉並(bldg)が開始すらしなかった）。譲った区の既送出バッチは表示のまま＝消えない。
				const free = h.noMask || fastBldg().length < bldCap;
				let seat = free;
				if (!free && !LOW_MEM) {   // 低メモリ端末はローテーション無し（in-flight在庫のRAMを増やさない）
					const v = fastBldg().filter(s => performance.now() - (plateauFastT.get(s.name) || 0) >= PLATEAU_ROTATE_MS)
						.sort((a, b) => (plateauFastT.get(a.name) || 0) - (plateauFastT.get(b.name) || 0))[0];
					if (v) {
						plateauWorkers[hashStr(v.base) % PLATEAU_NW].postMessage({ type: "demote", base: v.base });
						plateauDemoted.add(v.name);
						console.log("[plateau] fast-slot rotation -> stocked (slow)", v.name);
						seat = true;
					}
				}
				if (seat) {
					plateauCancelling.delete(h.name); plateauDemoted.delete(h.name);
					plateauFastT.set(h.name, performance.now());
					plateauWorkers[hashStr(h.base) % PLATEAU_NW].postMessage({ type: "promote", base: h.base });
					console.log("[plateau] revisit -> load resumed", h.name);
				}
			}
			continue;
		}
		if (plateauResident.has(h.name)) {   // 常駐ヒット＝GPUにVAOが居る→表示フラグを戻すだけ（転送ゼロ・即表示）
			plateauRetain(h.name, h);
			renderer.set("plateauVis", true, h.name);
			plateauActive.set(h.name, h);
			needsDraw = true;
			console.log("[plateau] resident hit (no re-upload) ->", h.name);
			continue;
		}
		if (!settled) continue;   // 新規ネットワークロードは「視界が落ち着いた」時だけ発火＝パンで通過した区は読み始めない
		// fast枠が塞がっていても可視区は「slow在庫」で即開始（非LOW_MEM）＝進捗と部分IDBが貯まり始め、
		// ローテーション/枠空きの promote で即 8並行へ（枠待ちで開始すらしない飢餓を断つ）。
		// LOW_MEM は従来どおり順番待ち＝同時in-flightのRAM在庫（区あたり~100MB級）を増やさない。
		// 起動猶予（2026-08-04夜）：ブート直後の45秒は在庫slowを起こさない＝表示本命のfast枠だけ。
		// 起動時は在庫まで一斉復元→worker/転送の一時ゴミ高水位が積み上がり「立ち上がりで5GB」（本人実測）。
		// 見えている本命2区が先・在庫は落ち着いてから＝autoPlateauは移動/settleで再訪するので取り漏らさない。
		const capFull = !h.noMask && fastBldg().length >= bldCap;
		if (capFull && (LOW_MEM || performance.now() < 45000)) continue;
		plateauLoading.add(h.name);
		plateauAutoLoading.set(h.name, h);   // 視界確定時の退避対象へ
		if (!capFull) plateauFastT.set(h.name, performance.now());
		console.log(capFull ? "[plateau] auto-load (slow stock; waiting for fast slot) ->" : "[plateau] auto-load ->", h.name);
		loadPlateau(h.base, undefined, h.name, h.noMask ? null : h.bbox, h.noMask, h)   // noMask（橋梁等）＝マスク不参加＋橋梁モード（バッチ接地・両面）
			.then(ok => {
				if (ok === "cancelled") {   // 協調キャンセル＝failed 扱いにしない（戻れば再ロードできる）。部分バッチのGPU残骸を掃除
					plateauEvict(h.name);
					console.log("[plateau] cancel complete (partial batches freed)", h.name);
					return;
				}
				if (ok === "demoted") {   // slow のまま完走（GPU全量済み＝送出は完走時に必ず流し切る・IDB済み）
					plateauRetain(h.name, h);
					// 視界内で完走した在庫（fast枠ローテーション中の区など）＝そのまま点灯。従来の一律非表示だと
					// 目の前に立っていた既送出バッチごと消える。視界外だけ従来どおり非表示常駐（再訪は常駐ヒットで即）。
					if (cam.zoom >= PLATEAU_HIDE_Z && (cam.pitch || 0) >= 0.02 && bboxIntersects(h.bbox, approxViewBbox(cam))) {
						renderer.set("plateauVis", true, h.name);
						plateauActive.set(h.name, h);
						needsDraw = true;
						console.log("[plateau] stock complete -> in view = shown", h.name);
					} else {
						plateauHide(h.name);   // 低メモリ端末（常駐なし）はここでメッシュ削除＝IDBだけが残る
						console.log("[plateau] stock complete -> hidden resident", h.name);
					}
					return;
				}
				if (!ok) { plateauFailed.set(h.name, { perm: true, ts: performance.now() }); console.warn("[plateau] unreadable, skipping (abolished ward / empty data?):", h.name); return; }   // 恒久＝以後は候補から除外
				plateauActive.set(h.name, h);
				plateauRetain(h.name, h);
				// ★完了時に既に低ズーム/視野外なら stale＝即非表示（ロード中にズームアウトすると3Dが居残る件を断つ。常駐には残る＝戻ればタダ）。
				if (cam.zoom < PLATEAU_HIDE_Z || !bboxIntersects(h.bbox, approxViewBbox(cam))) {
					plateauActive.delete(h.name); plateauHide(h.name); needsDraw = true;
					console.log("[plateau] out of view at load completion -> hidden", h.name);
				}
			})
			.catch(e => { plateauFailed.set(h.name, { perm: false, ts: performance.now() }); console.warn("[plateau] load failed, skipping (retry in 60s):", h.name, e.message || e); })   // 一時＝バックオフ
			.finally(() => {
				plateauLoading.delete(h.name); plateauAutoLoading.delete(h.name); plateauCancelling.delete(h.name); plateauDemoted.delete(h.name); plateauFastT.delete(h.name);
				// 枠が空いた瞬間に再選抜（静止シーン中はonMoveが来ない＝これが無いと3区目以降が
				// 次のカメラ操作まで立たない）。failed/cancelled はそれぞれのガードが再発火を止める。
				if (!moving) autoPlateau(true);
			});
		// fast枠が塞がっていた区＝ロード要求の直後に slow へ落として開始（同一 worker の FIFO＝要求(fast初期化)→demote の順が保証される）
		if (capFull) {
			plateauDemoted.add(h.name);
			plateauWorkers[hashStr(h.base) % PLATEAU_NW].postMessage({ type: "demote", base: h.base });
		}
	}
}
// 静止中の見張り：ロード中が居る間は10秒毎に再選抜＝fast枠ローテーション・枠空き補充・退避復帰を
// カメラ操作なしでも回す（onMove/settle が来ない「静止して待つ」シーンでの飢餓/取りこぼし対策）。
setInterval(() => { if (plateauLoading.size && !moving && !flying) autoPlateau(true); }, 10e3);
setTimeout(() => { if (!moving && !flying) autoPlateau(true); }, 46e3);   // 起動猶予(45s)明けの一突き＝触らず眺めているだけでも在庫slowが静かに育ち始める（上のポーラーはロード中のみ発火のため）

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
	cam.center[0] = wrapLon(cam.center[0]);   // パン/回転/フライトの累積を毎移動で正規化＝float32原点相対の前提を守る（階段バグ根治）
	moving = true; needsDraw = true;
	idleCalm = false; clearTimeout(calmT);     // 動いた瞬間に「本当の静止」を取り下げ（詳細化は許可待ちに戻る）
	updateUnderground();                       // 地中フェード（非同期・10Hz＝eye直下の地表との高低差→#underground の opacity。時間フェードはCSS transition）
	updateGintSlot();                                                                // gint 単一スロットを z=4 で調停（ユーザー層⇄世界海岸線）＋海岸線の遅延ロード
	ensureStars();                                                                    // 星空も同じ流儀＝初めて z<4 に出た瞬間に読む
	autoPlateau();                                                                    // 寄る/離れるで PLATEAU を自動ロード/解放（ガードで実質タダ）
	renderer.draw(cam, { skipBase: false, skipMain: mainStale(), noTerrain: false, terrainGate: false });   // 入力の瞬間に最新camをworkerへ（全球z<4も標高の塗りは描く）。terrainGate:false＝入力中はアトラス再構築を起こさない（停止時に一回だけ）
	// 知性の層(gint)は render worker が frame 末尾に同フレーム同カメラで描く（1canvas統合＝泳ぎ・チルト opacity 手当てとも消滅）。
	clearTimeout(settleT);
	settleT = setTimeout(() => {
		moving = false; needsDraw = true; commitUnderground(); wPost({ type: "gintDrawn" }); autoPlateau(true); if (!printHold) saveView();   // 停止後に identify(picking)＋PLATEAU確定（settled＝ロード発火/レーン切替はこの瞬間だけ）＋ビュー保存＋地中フェード確定（止まったら地中=全黒）
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
	style, tileUrl: TILE_URL, requestDraw: () => { needsDraw = true; }, scenePort: sceneChan.port1, onTile, ell: ELL_ON,
	coverage: /[?&]nocov=1/.test(location.search) ? null : JP_COVERAGE,   // 配信圏外タイルは fetch せず空タイル(海)扱い＝外洋・国外への無駄な 404 を断つ（縦長スマホの周縁 404 の根治）。?nocov=1 で無効化＝A/B 検証ノブ

	// LOD下限＝タイルz8（sea gate と同じ閾値）：optbv は z8 から海が全面WA（沖合タイル=WA一枚50B級）、z7以下は
	// 「陸=AdmArea・海=背景」モデルでWA無し＝チルトの遠景（z5-7混在）だけ海が紙色に抜けてまだらになる。
	// 遠景もタイルz8 以上で敷けば海色がズーム段間で揃う（根治）。ビューz<9 は従来どおり紙の海＋gint海岸線。
	lodFloor: { minViewZoom: 9, z: 8 },
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
	// 全球ビュー(z<4)移行後に着地した投げっぱなしmerge：結合結果は scene worker→render worker 直行＝
	// main では止められないため、render() が空にした後から道路/鉄道が復活する（ズームアウト中の要求が遅れて届く）。
	// ack＝着地の合図なので、ここで検知して即座に空へ戻す（sig は確定させない＝z4復帰時に再結合させる）。
	if (cam.zoom < BASEMAP_MINZOOM) {
		renderer.set("scene", { origin: [cam.center[0], cam.center[1]], layers: [] }, slot);
		needsDraw = true;
		return;
	}
	if (slot === "main") {
		readySig = sig;
		const z = mergePendingZoom.get(sig);
		if (z != null) { mainSceneZoom = z; mergePendingZoom.delete(sig); }
		slog("main merge applied on screen (visible from here)");
	} else if (slot === "base") { baseSig = sig; slog("base swap applied"); }
	needsDraw = true;
}
dbgHost.__mergeFail = () => requestMerge.debugFail();   // 次の merge を故意に失敗させ ack 自己修復を実地検証
dbgHost.__vtPool = () => requestMerge.stats();          // multi_draw 常駐プールの占有を scene worker の console に出す

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 75 * D2R;   // 山岳ビュー(z<13)は地形が深度で自遮蔽・混成アトラスが地平線までカバー＝高チルトの根拠が揃ったので75°まで開放
const ZOOM_MAX = 20;         // 上限20＝15cm/px（正射z＝緯度フリー。精度は原点相対RTEが担保）。21でも動くが余裕を持って1段残す
const ZOOM_MIN = 1;          // 床1＝地球全体を余白つきで（z1=世界512px＝スマホ縦にも収まる。旧床2は縦画面で地球がはみ出し、モバイルΔ補正が床に潰される素だった 2026-08-02）
// 太陽系圏（2026-08-10）：256pxの梯子を負へ延長＝ズームアウトの続きで太陽系へ（z≈-16.4で冥王星軌道が視野に収まる）。
// 潜れるのは手動ズーム（ホイール/ピンチ/ボタン/URL）だけ＝飛行系（デモ・scene・flyTo）は従来床 ZOOM_MIN=1 のまま
// ＝既存台本の挙動を一切変えない保守的な縫い目。?nosolar=1 で圏ごと停止（?nofar 等と同じ逃げ道の作法）。
const SOLAR_ZOOM_MIN = -17;
const solarOff = new URLSearchParams(location.search).has("nosolar");
const CAM_ZOOM_MIN = solarOff ? ZOOM_MIN : SOLAR_ZOOM_MIN;   // カメラ実床（手動系はこちら）
let atmo = theme.atmo;              // 大気色 rgb + 強さ（テーマ台帳のノブ＝palettes.js）※生き替えで差し替わる
let bldColor = theme.bldColor;      // 建物色（テーマ台帳のノブ＝palettes.js）※生き替えで差し替わる
// cam＝幾何のみ（center/zoom/pitch/bearing/dpr）＝毎フレームの draw payload（将来の worker 境界）。
// 色（clear/land/atmo/bldColor）は静的なので setView で一度きりアップロード＝hot path から追い出す。
const JAPAN_VIEW = [137.628, 37.783, 5.86];   // 列島ビュー（本土四島が一枚・真俯瞰）＝既定起動＆「日本全体」ガジェットの着地点
const cam = { center: [JAPAN_VIEW[0], JAPAN_VIEW[1]], zoom: JAPAN_VIEW[2], pitch: 0, bearing: 0, dpr };   // 既定＝列島ビュー（沖縄・小笠原には悪いが初手の構図優先。初訪問時のみ＝共有URL→前回ビューの順で下で復元）
// --- 共有URL（パーマリンク）：codec は engine（viewurl.js）。ここは起動の優先度と app 固有クランプだけ ---
// 起動の優先度：URLハッシュ > localStorage(前回ビュー) > 既定の世界ビュー。settle 毎に replaceState で
// 書き戻す＝アドレスバーが常に「今この視点の共有URL」（コピーするだけで人に渡る＝発表・拡散の生命線）。
function applyCamView(v) {
	cam.center = [wrapLon(v.lon), Math.max(-90, Math.min(90, v.lat))];
	cam.zoom = Math.max(CAM_ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom));   // URL/復元は太陽系圏の深度も受ける
	cam.pitch = Math.max(0, Math.min(opts.maxPitch ?? MAXPITCH, v.pitch || 0));   // 共有hashのtiltも派生アプリの上限に従う（geoedit=0）
	cam.bearing = Number.isFinite(v.bearing) ? v.bearing : 0;
}
const bootView = parseViewHash(opts.view || location.hash || (nlOn ? "#16/52.0116/4.3571/45t" : ""));   // /nl/ を裸で開いた時はデルフト上空へ（日本アプリの既定は日本のまま）
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
	if (constelVisible) on.push(SKY_LAYER);   // 星座ON＝l= に sky を追加（既定OFF＝差分ありで l= を必ず書き出す）
	const changed = constelVisible || FREE_LAYER_KEYS.some(k => layerState[k] !== defaultLayerState[k]);
	const extras = changed ? ["l=" + on.join(".")] : [];
	// 配色テーマ＝c=<name>（既定 mono は書かない＝素の視点はURLも素。固定(opts.theme)も書かない＝埋め込み構成を持ち出さない）
	if (!themeFixed && themeName !== "mono" && MAP_THEMES[themeName]) extras.push("c=" + themeName);
	return buildViewHash(cam, extras);
};
const saveView = () => { saveCam(); try { history.replaceState(null, "", viewHash()); } catch { /* file:// 等 */ } };
// 配色テーマの生き替え（reload無し restyle）：基図タイルを新styleで組み直し、静的色・夜家具(ui-dark)・海岸線色・
// N02芯色を差し替える。★URLは書かない＝呼び出し側が「全状態が揃った後」に1回だけ書く（applyView 末尾の saveView／
// palette は switchTheme 後に saveView）＝URL⇄状態の一元化・順序取りこぼしの防止。色は dl.ops に焼き込まれるため基図は
// 再ビルド必須（setPipelineStyle が evict→新styleビルド＝GPU入れ替え＝ピーク約1倍）。一瞬の貼り直しは許容（fade不要）。
function switchTheme(name) {
	if (name === themeName || !MAP_THEMES[name]) return;
	themeName = name; theme = MAP_THEMES[name]; style = theme.style;
	bg = style.layers.find(L => L.type === "background");
	land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.96, 0.96, 0.95, 1];
	atmo = theme.atmo; bldColor = theme.bldColor;
	setPipelineStyle(style);   // 基図タイルを全捨て→新styleで再ビルド（生バイトはIDB/HTTP温間キャッシュ命中で速い）
	// ★任意ノブ(等高線色/遠山/標高段彩)は「新テーマが持たなければ null」で必ず既定へ戻す＝前テーマの居座り防止。
	// 条件付きspreadだと未指定キーが setView のマージで残る＝例: sepia/dark の暖茶hypso が mono/gsi へ漏れて「山が茶色」になる。
	renderer.set("view", { clear, land, atmo, bldColor,
		contourColor: theme.contourColor || null,
		distColor: theme.distColor || null,
		hypso: theme.hypso || null });
	renderer.set("sea", { li: style.layers.findIndex(L => L.id === "water"), li2: style.layers.findIndex(L => L.id === "water-hi"), minzoom: 9 });
	mapEl.classList.add("ui-dark");   // 白抜き家具＝常時ON（本人裁定2026-08-05）＝テーマ生き替えでも外さない（旧＝land輝度で付け外し）
	if (gintSlot === "coast") applyCoastSlot();   // 海岸線色(theme.coastLine)を新テーマで塗り直す＝gint別層＝基図タイル再ビルドでは直らない（色の居座り根治）
	if (layerState.rail && n02Loaded) { n02Loaded = false; loadN02(); }   // N02新幹線の芯(land色)を新テーマで引き直す（データは温間）
	readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; needsDraw = true; onMove();   // 下地・主層を強制再結合（次のupdateで新styleビルド→順次merge）
}
// contourColor/distColor/hypso はテーマの任意ノブ（無指定＝renderer 既定：セピア等高線・遠山ブルー・単色陰影）
renderer.set("view", { clear, land, atmo, bldColor, showN02: false,
	...(theme.contourColor && { contourColor: theme.contourColor }),
	...(theme.distColor && { distColor: theme.distColor }),
	...(theme.hypso && { hypso: theme.hypso }) });   // showN02＝N02交通(新幹線等)の表示。鉄道チップで切替
// 海：水レイヤ(WA)をビュー一律にゲート＝cam.zoom<9 では描かない（＝紙の海・まだら無し）、z9+で一律点火。
renderer.set("sea", { li: style.layers.findIndex(L => L.id === "water"), li2: style.layers.findIndex(L => L.id === "water-hi"), minzoom: 9 });   // li2＝水系点火面も同じ海ゲート
renderer.set("bldFill", { li: style.layers.findIndex(L => L.id === "building") });   // 建物フットプリント塗り＝3D（チルト）時は伏せる（押し出しと二重表現のため）

// --- gint（知性の層）：14条など突合可能なエンティティ。1canvas統合＝render worker の GL コンテキストに
// 同居し、地図フレーム末尾の1パスとして同フレーム同カメラで描かれる（旧・別worker+OffscreenCanvasは撤去）。
// MVT=描画／Gint=知性＝層分担は不変。main からは renderer.set("gint"/"gintStyle"/"gintVis") と
// gintMove/gintClick/gintLeave/gintDrawn メッセージで操る。識別の返信は renderWorker.onmessage（上方）。
// gint 描画スタイル（styleTable/lineWidth）。データ毎に差し替え（null=既定＝14条筆のオレンジ/シアン）。
let gintDrawOpts = null;
// gint 識別の有効/無効。14条筆=true（ホバー/クリックで突合）、世界海岸線=false（装飾＝ホバー不要）。
let gintInteractive = false;
let gintHover = true;   // ホバー識別のゲート（interactive と別軸＝災害面はクリックは残しホバー処理だけ切る・本人裁定 2026-08-13）
// gint 表示状態（旧 #gint canvas の display 相当）。render() が visibleGintNow() と突き合わせ変更時だけ post。
let gintVisible = true;
// 地形沿い境界線(gintBld)が出ている層か＝視覚は draped 一本に統一し、gint層の2D視覚は平面でも出さない（識別は裏で生存）。二重線の解消。
let drapedOn = false;
// gint スタイルを render worker へ預ける（frame 末尾の gint パスが使う）。データ毎に差し替え。
const sendGintStyle = () => renderer.set("gintStyle", gintDrawOpts);
let gintHoverTip = null;   // ホバー tip 内容 setter（init末尾で map.gadget.tip() を一度だけ搭載＝全gint層で有効）
let lastHoverXY = null;    // 直近ホバー座標（estat が町丁目ミス＝市区町村外の時に gint ホバーへフォールバックする用）
let estatTipOwn = false;   // 町丁目tip表示中＝gint識別ackにtipを触らせない（gintLeaveのnull-ackで消える/古いmove-ackで上書きされるレース封じ）。census経路のみ立つ＝デモ不変
let gintClickHandler = null;   // gintクリックの派生アプリ受け口（map.onGintClick）。未登録なら従来の console のみ
canvas.addEventListener("pointerleave", () => {
	wPost({ type: "gintLeave" });
	// smallAreaHover（census2020限定）＝町丁目ホバーの太線/名前tipも掃除（ポインタが地図外へ出た時の残留防止）。
	// デモ（フラグ無し）は従来どおり gintLeave のみ＝凍結挙動不変。
	if (opts.smallAreaHover) { estatTipOwn = false; renderer.set("overlayHover", null); gintHoverTip?.(null); needsDraw = true; }
});
// 14条地図（法務省 登記所備付地図）を球へ。デコード済み pbf を受けて球へ配線する共通処理。
// 「座標値種別=図上測量」は測量手法のタグに過ぎず絶対位置の信頼性とは無相関と判明済み（系変換さえ合っていれば図上測量でも正確）
// →現状はバッジ判定に使わない。任意座標系の混入検知は変換パイプライン側（外れ値bbox比較）でやるべき課題として残す。
// bbox([lonMin,latMin,lonMax,latMax] deg)全体が画面に収まる zoom。正射の中心近傍は px ≈ scale×角(rad)。
// zの定義は camera.js の radPerDevPx＝2π/(2^z·WORLD_PX·dpr)＝256px世界 → CSS px/rad = 2^z·256/(2π)。
// v1 gint の 40.74(=256/(2π)) 規約と同目盛り（2026-07-26 の256統一でズレ解消）。
// 経度側だけ cos(lat) で実角へ。15% マージン。
function fitZoomForBbox(b) {
	const latC = (b[1] + b[3]) / 2;
	const thX = Math.max(1e-9, (b[2] - b[0]) * Math.cos(latC * D2R) * D2R);
	const thY = Math.max(1e-9, (b[3] - b[1]) * D2R);
	const W = mapEl?.clientWidth || innerWidth, H = mapEl?.clientHeight || innerHeight;
	const scale = 0.85 * Math.min(W / thX, H / thY);
	return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.log2(scale / (WORLD_PX / (2 * Math.PI)))));
}
function applyGintData(pbf, label, moveCamera = true, opts = {}) {
	if (!pbf?.unPackGint) { console.error("[gint] decode failed (%s)", label, pbf); return null; }
	// gint 単一スロットのユーザー層（14条筆/ドロップGISファイル/AI層）＝世界海岸線と相互切替。pbf 保持＝ホバーで getFeature(id).properties を引く。
	// style/minZoom は層の属性としてここに預ける（スロット再適用(applyUserSlot)がズーム跨ぎの度に走るため、外に置くと切替で剥がれる）
	// opts.fillMaxEdges＝この層だけ塗り上限を上げる（フル解像度の行政界コロプレス等・既定 2M の暴走止めを個別解除）。
	if (opts.fillMaxEdges) pbf.unPackGint.fillMaxEdges = opts.fillMaxEdges;
	userGint = { g: pbf.unPackGint, label, pbf, style: opts.style ?? null, minZoom: opts.minZoom ?? GINT_SWAP_Z, interactive: opts.interactive !== false, hover: opts.hover !== false, drapeFill: !!opts.drapeFill, tip: opts.tip ?? null };   // tip＝ホバーtipの持参整形（筆層＝町丁目tipと排他の主導権も取る・census2020限定）
	// bake-ahead：メタ/tier梯子を bake worker で焼き切ってから搭載（render worker はテクスチャ搭載のみ＝
	// ロード時の同期ベイクで地図が固まらない）。焼き上がりの onDone で sent を立てて再調停＝そこで点火。
	cancelBake("user");
	bakeUser();
	// moj 等はデータ全体へ fit（初期は東京駅、moj のデータは離れた区にある）。ドロップは呼び出し側が flyTo で寄る＝moveCamera=false。
	if (moveCamera) { const b = pbf.unPackGint.bbox; if (b && b.length === 4) flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, fitZoomForBbox(b)); }
	gintSlot = null;           // 内容が変わった＝再適用を強制
	updateGintSlot();          // z≥GINT_SWAP_Z ならユーザー層を表示（z<GINT_SWAP_Z は世界海岸線のまま＝世界図の文脈）
	onMove();
	// moj筆(opts.drape)＝地形沿い境界線を自動発火（0=実標高ぴったり）。非drape層へ切替時は前の draped を消す（層と一蓮托生）。
	if (opts.drape) standupGint(DRAPE_LIFT_M, { auto: true }); else { renderer.set("gintBld", null); drapedOn = false; needsDraw = true; }
	console.log("[gint] %s loaded. shown at z>=%d; z<%d shows world coastline", label, GINT_SWAP_Z, GINT_SWAP_Z);
	return pbf;
}

// moj は geopbf の name 慣習(bucket/GIS/pbf/…)でなく bucket/moj/{code}.pbf に置かれた別棚なので、
// URL を直叩きして buffer を geopbf に食わせる（gint:true で unPackGint 生成）。
dbgHost.__moj = async (code = "13118") => {
	const url = `https://api.ortho-earth.com/bucket/moj/${code}.pbf`;
	const res = await fetch(url);
	if (!res.ok) { console.error("[moj14] fetch failed %s -> HTTP %s", url, res.status); return; }
	let buf = await res.arrayBuffer();
	const head = new Uint8Array(buf, 0, 2);   // bucket は gzip 圧縮で置かれる。name 慣習の load は自動 gunzip するが直叩きは生バイト＝手動で解凍。
	if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
	const pbf = await geopbf(buf, { gint: true, name: `moj/${code}` });
	applyGintData(pbf, code, true, { drape: true });   // 14条筆＝地形沿い境界線を自動発火
};
// 任意の File/URL（例: aigidなど第三者が公共座標系→WGS84まで変換済みのGeoJSON）を直接デコードして球へ。
// bucket 変換パイプラインを経由せず動作検証したい時用。
dbgHost.__mojFile = async (fileOrUrl, name = "moj/local") => {
	const pbf = await geopbf(fileOrUrl, { gint: true, name });
	return applyGintData(pbf, name, true, { drape: true });   // 14条筆＝地形沿い境界線を自動発火
};
// 動作確認用ショートカット：public/moj-local/ に置いた aigid変換済みGeoJSONをワンコマンドでロード。
dbgHost.__sapporo = async () => {
	const res = await fetch(ASSET_BASE + "moj-local/01101-aigid.geojson");   // moj-localはデプロイ除外＝開発専用
	const file = new File([await res.blob()], "01101_aigid.geojson");
	return dbgHost.__mojFile(file, "moj/01101_aigid");
};
// 荒川区（任意座標系のみ）を、大字/丁目名でe-Stat小地域に位置合わせしたラバーシート結果でロード。
// 回転はシェイプ推定せず地名の対応だけで平行移動+等方スケール（現地調査の代替ではなく表示用近似）。
dbgHost.__arakawaFit = async () => {
	const res = await fetch(ASSET_BASE + "moj-local/13118-rubbersheet.geojson");
	const file = new File([await res.blob()], "13118_rubbersheet.geojson");
	return dbgHost.__mojFile(file, "moj/13118_rubbersheet");
};
// コロプレス塗り（gint draw spec.md）動作確認用：現在のユーザー層(gint)へ paint/filter を適用。
// 式は main で一度だけ評価（buildFidStyle）→ fid スタイル表を worker へ＝restyle はテクスチャ更新1回。
// 例: __paint({ 'fill-color': ['interpolate', ['linear'], ['get','R2'], 0,'#ffeeee', 5000,'#990000'] })
//     __paint({ 'fill-color': ['match', ['get','市区町村名'], '青葉区', '#cc000080', '#00000010'] })
//     __paint(null)＝解除（従来の stencil 単色塗りへ）。ortho-core は動的 import＝初期バンドル不変。
// fid 整列の feature 配列（式評価の入力）。identify の tip と同じ真実源＝getProperties(fid)。
// ※ .geojson は壊れ geometry の feature をスキップして配列を「詰める」＝fid とズレる（札幌 aigid で実証）。
//    式評価に .geojson を使ってはならない。読めない props は {}＝既定値評価（§6-4）。
const gintFidFeatures = () => {
	const pbf = userGint?.pbf;
	const n = pbf?.fmap?.length ?? 0;
	if (!n) return null;
	const out = new Array(n);
	for (let i = 0; i < n; i++) {
		let p = {};
		try { p = pbf.getProperties(i) ?? {}; } catch (e) { /* 壊れ feature＝既定値へ */ }
		out[i] = { properties: p, geometry: null };
	}
	const skipped = n - (pbf.geojson?.features?.length ?? n);
	if (skipped > 0) console.info("[paint] %d of %d fids missing from .geojson (corrected via fid-aligned read)", skipped, n);
	return out;
};
// fid ズレ診断用：指定 fid だけ赤・他は薄灰でテーブル直書き（式評価を迂回＝純粋に fid 空間を見る）。
// 使い方: __paintFid(100) → 赤い筆をクリック → console の [gint] fid=… が 100 なら一致、±k ならズレ量 k。
dbgHost.__paintFid = (...fids) => {
	const feats = gintFidFeatures();
	if (!feats) { console.warn("[paintFid] user gint layer not loaded"); return; }
	const n = feats.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) { u32[i * 4] = 0x88888830; u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1; }
	for (const f of fids) if (f >= 0 && f < n) u32[f * 4] = 0xcc0000cc;
	sendGintPaint({ table: u32, count: n });
	needsDraw = true;
	for (const f of fids) console.log("[paintFid] fid=%d props=%o", f, feats[f]?.properties);
};
// fid → properties（クリックで出た fid の中身を確認する。identify と同じ getFeature 直読み）
dbgHost.__paintProps = (fid) => userGint?.pbf?.getFeature(fid)?.properties;
// gint ユーザー層（moj筆/ドロップ図形）を地形に沿わせる＝各頂点が自分の標高に乗る（buildDrapedGeometry・ポリゴン/線/点）。
// liftM=null で解除。auto=読み込み時の自動発火（moj）＝静かめ。平面↔地形は elevScaleEff で連続モーフ（renderer 側・show3dゲートなし）。
const DRAPE_MAX_EDGES = 4000000;   // 地形沿い線化の辺数上限。moj一区は数十万〜百万級＝通す。全国級(admin_all)の暴走だけ止める安全弁
// リフト＝地形からわずかに浮かせる高さ(m)。0だと「頂点間の直線の辺」が「頂点間で膨らむ地形面」の下に潜り、
// チルト時に深度で地形に負けて消える（真俯瞰は地形メッシュ無効で0でも見えていた）。数mで膨らみを越えて安定。
const DRAPE_LIFT_M = 2;
async function standupGint(liftM = 0, { auto = false } = {}) {
	if (liftM == null) { renderer.set("gintBld", null); drapedOn = false; needsDraw = true; if (!auto) console.log("[standup] cleared"); return; }
	const feats = userGint?.pbf?.geojson?.features;
	if (!feats?.length) { renderer.set("gintBld", null); drapedOn = false; needsDraw = true; if (!auto) console.warn("[standup] gint user layer not loaded = run await __sapporo() etc. first"); return; }
	let edges = 0;
	for (const f of feats) {
		const g = f?.geometry;
		if (g?.type === "Polygon") for (const r of g.coordinates) edges += r.length;
		else if (g?.type === "MultiPolygon") for (const p of g.coordinates) for (const r of p) edges += r.length;
		else if (g?.type === "LineString") edges += g.coordinates.length;
		else if (g?.type === "MultiLineString") for (const l of g.coordinates) edges += l.length;
		if (edges > DRAPE_MAX_EDGES) break;
	}
	if (edges > DRAPE_MAX_EDGES) { renderer.set("gintBld", null); drapedOn = false; needsDraw = true; console.warn("[standup] ⚠ edges %d > limit %d = skipping terrain drape (huge layer). raise DRAPE_MAX_EDGES to allow", edges, DRAPE_MAX_EDGES); return; }
	const { buildDrapedGeometry } = await import("ortho-core");
	const b = userGint.pbf.unPackGint.bbox;                       // 表示CRS(経緯度)の bbox＝RTE の origin に使う
	const origin = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
	// CRS サニティ：geojson の座標が bbox(経緯度)から大きく外れていたら局所座標系＝線だけズレる（gint表示は変換済で正しい）
	const s = feats.find(f => f?.geometry?.coordinates)?.geometry?.coordinates?.flat(Infinity);
	if (s && (s[0] < b[0] - 1 || s[0] > b[2] + 1 || s[1] < b[1] - 1 || s[1] > b[3] + 1))
		console.warn("[standup] ⚠ geojson coords (%o,%o) outside bbox [%o..%o] = possibly local CRS. convert CRS if lines misalign", s[0].toFixed?.(3), s[1].toFixed?.(3), b[0].toFixed?.(2), b[2].toFixed?.(2));
	const geo = buildDrapedGeometry(feats, origin, { liftM });   // { lines, points }（ポリゴン境界＋線＋点）
	const has = !!(geo.lines || geo.points);
	// 色は層の持参色（style1=線色 rgb）から。moj/ドロップは style 無し＝既定オレンジ（14条筆の系統色）、AI層は plan の色。
	const st = userGint?.style?.styleTable;
	const col = st && st.length >= 8 ? [st[4], st[5], st[6]] : [1.0, 0.55, 0.15];
	renderer.set("gintBld", has ? { origin, lines: geo.lines, points: geo.points, color: col } : null);
	drapedOn = has;   // draped が出た層＝gint層の2D視覚は消す（二重線解消・識別は裏で生存）
	needsDraw = true;
	console.log("[standup] %s: features %d -> lines %d, points %d (lift %dm)%s", auto ? "auto" : "manual", feats.length, geo.lines ? geo.lines.pos.length / 6 : 0, geo.points ? geo.points.pos.length / 3 : 0, liftM, has ? "" : " = zero generated");
}
dbgHost.__standup = (liftM = DRAPE_LIFT_M) => standupGint(liftM);   // 手動ノブ（実験）。既定=DRAPE_LIFT_M。null で解除・大きくすると浮く
// 重複可視化＝登記データの品質監査プローブ。通常塗りをせず winding 和の異常画素だけを色分け：
//   マゼンタ＝別筆同士の重なり（fid不定） / 橙＝同一筆の多重登記 / シアン＝向き矛盾の重なり（正味0）
// __paintOverlap() で点灯・__paintOverlap(false) か __paint(null) で解除。
dbgHost.__paintOverlap = (on = true) => {
	if (!on) { sendGintPaint(null); needsDraw = true; return; }
	const feats = gintFidFeatures();
	if (!feats) { console.warn("[paintOverlap] user gint layer not loaded"); return; }
	const n = feats.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1;   // 塗り透明・visible（ID経路の起動条件として表は必要）
	sendGintPaint({ table: u32, count: n, overlap: true });
	needsDraw = true;
	console.log("[paintOverlap] auditing %d parcels: magenta=overlap of distinct parcels / orange=duplicate registration of same parcel / cyan=winding contradiction", n);
};
// fid ズレ診断の決定版：偶数fid=赤／奇数fid=青の市松塗り（場所に依らず全面に出る＝見逃し不能）。
// どの筆でもクリック → console の [gint] fid=… の偶奇と色が一致するか：赤=偶数/青=奇数なら一致、逆なら±1ズレ。
dbgHost.__paintParity = () => {
	const n = userGint?.pbf?.fmap?.length ?? 0;
	if (!n) { console.warn("[paintParity] user gint layer not loaded = run await __sapporo() etc. first"); return; }
	const u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) {
		u32[i * 4] = (i & 1) ? 0x0044cc90 : 0xcc000090;   // 奇数=青 / 偶数=赤
		u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1;
	}
	sendGintPaint({ table: u32, count: n });
	needsDraw = true;
	console.log("[paintParity] checkerboard applied to %d parcels (even=red/odd=blue). if no color shows, check the [gint] idFill caps console line", n);
};
// 任意の bucket GeoPBF を gint ユーザー層としてロード（例: __gload('admin_all')＝行政界コロプレスの土台。
// 全国級なので minZoom=3＝ズームアウトしても海岸線に切り替わらない）。
dbgHost.__gload = async (name, opts = {}) => {
	const pbf = await geopbf(name, { gint: true }).catch(e => { console.error("[gload]", e); return null; });
	if (!pbf) return null;
	return applyGintData(pbf, name, true, { minZoom: 3, ...opts });
};
// 移動中描画予算のノブ（実測用）。__budget(Infinity)=移動中も常時描画 / __budget()=既定250kへ戻す。
// ?perf=1 の [perf] 行の gpuGint ms を見ながらズーム操作で実測 → 既定値の再裁定に使う。
dbgHost.__budget = (n) => {
	gintDrawOpts = { ...(gintDrawOpts || {}), moveBudget: n ?? undefined };
	sendGintStyle(); needsDraw = true;
	console.log("[budget] moveBudget=%s", n ?? "default(250k)");
};
async function paintGint(paint, filter = null) {
	if (!paint) { sendGintPaint(null); needsDraw = true; return; }
	const feats = gintFidFeatures();   // fid 整列（.geojson は詰めズレするため使わない）
	if (!feats) { console.warn("[paint] user gint layer not loaded (load via __moj etc. first)"); return; }
	const { buildFidStyle } = await import("ortho-core");
	const { u32, count } = buildFidStyle(paint, feats, { filter, zoom: cam.zoom });
	sendGintPaint({ table: u32, count });
	needsDraw = true;
	console.log("[paint] applied to %d features", count);
}
dbgHost.__paint = paintGint;
// 世界海岸線（Natural Earth 10m）を球へ。uploader で事前変換済みの GeoPBF を bucket 名慣習
// （GIS/pbf/ne_10m_coastline）から load＝初回も zip レンジ取得→shp デコードを払わない（gunzip 直読み→GintBUF 焼き→IDB）。
// 2回目以降は IDB 直行＝ネットワークを待たない（ETag 確認は裏で回し新版は次回反映＝激遅会場回線でも即表示）。
// bucket に無い間だけ従来の生 zip 経路（api proxy→shp デコード）へフォールバック。
// coastline は native な線＝lineStream（styleId=1＝既定 #00B4D8）。fillColor 既定透明＝縁だけ＝「線だけ」。
// maxZoom:7 で z≤7 に点火＝低ズームの世界図専用。
// VW ランクは GintBUF に焼込済＝10m を間引かず全密度で描く（弦が短く球面に吸い付く＝110m の崩壊が起きない）。
// 世界海岸線（Natural Earth 10m）を起動時に自動ロード＝__coast() を叩かず「最初から描画」。
// カメラは動かさない＝ズームアウト（z≤7）した瞬間に海岸線が居る。14条筆と gint 単一スロット共有（相互置換）。
// gint 単一スロットの調停：ユーザー層（14条筆/ドロップGISファイル）と世界海岸線を z=GINT_SWAP_Z で相互切替。
// z≥6＝ユーザー層（無ければ海岸線）／z<6＝海岸線（世界図の文脈）。両データはメモリに保持し境界跨ぎで差し替え。
// スロットは単一（worker側）＝同時表示不可なので「今どちらが載っているか(gintSlot)」を持ち、変更時だけ post。
// ※小域ユーザー層は checkZoomRange が bbox から minZoom を自動採用＝実表示はさらに絞られる（例:筆データ z≥10）。
//   海岸線は z<6 まで見せ、そこから先はユーザー層 minZoom まで基図に委ねる（豆粒の筆を全球に出さない）。
const GINT_SWAP_Z = 7;
const COAST_Z = 9;         // 世界海岸線の表示・ロード上限＝これ未満で出す（maxZoom9 と対）
let coastGint = null;      // 海岸線の gint ペイロード（初回ロードでキャッシュ＝再取得しない）
let userGint = null;       // ユーザー層 { g, label }（14条/ドロップ）
let gintSlot = null;       // 現在スロットの占有者 "coast" | "user"（null=未確定＝次の update で必ず post）
let coastLoading = false;
// 飛行中の海岸線抑制：両端が coast 表示条件外（z≥COAST_Z）なら、van Wijk の弧が中間で低ズームへ潜っても
// 世界海岸線を出さない＝通過するだけの一瞬のために重い海岸線を描いて動的解像度を落とすのを防ぐ。
// より重要なのはメモリ：長距離フライトは弧が大きく潜り loadWorldCoast（NE10m を fetch→GintBUF→GPU、
// しかも永久キャッシュ）を誘発する＝両端が高ズームの飛行では丸ごと払わせない。着地で解除→再評価。
let suppressCoast = false;
// スロット搭載の送信済み台帳：データ本体は「スロットにつき1回」だけ worker へ送り（クローン数十MB級）、
// 以後の交替は "gintSlot" の軽量コマンド＝worker 側のベイク済み束（テクスチャ/LOD梯子/台帳）を差し替えるだけ。
// 旧・毎交替 set() は z7 跨ぎのたびフルベイク＋梯子リセット＝「LOD/カリング不在の窓」（nps_all 実測で
// 定常の42倍＝451万辺/フレーム）に落ちていた。内容差し替え時は sent を折って再送させる。
let coastSent = false;

// --- gint bake worker（bake-ahead）---------------------------------------------------------
// メタ/tier梯子の全ベイクを専用 worker で焼き、完成品を transfer で render worker へ中継する。
// render worker は uploadBaked（テクスチャ搭載のみ）＝ロード時の同期ベイク（nps_all 級で数百ms、
// タブレットは秒級）が地図フレームを塞がない。ベイク中は現表示（海岸線）を描いたまま＝焼き上がりで点火。
// worker 不成立/ベイク失敗は従来の同期経路（renderer.set("gint", raw, key)）へフォールバック。
let bakeWorker = null, bakeSeq = 0;
const bakePending = new Map();   // id → { key, raw, meta, onDone, cancelled }
const legacyGintSend = p => { renderer.set("gint", p.raw, p.key); p.onDone?.(); };
function ensureBakeWorker() {
	if (bakeWorker !== null) return bakeWorker;
	try { bakeWorker = new Worker(new URL("./gintbakeworker.js", import.meta.url), { type: "module" }); }
	catch (e) { console.warn("[gint] bake worker start failed = using sync path", e); return (bakeWorker = false); }
	bakeWorker.onmessage = e => {
		const d = e.data, p = bakePending.get(d.id);
		if (!p) return;
		bakePending.delete(d.id);
		if (p.cancelled) return;   // 焼いている間に層が差し替え/撤去された＝結果を捨てる
		if (d.kind === "error") { console.warn("[gint] bake failed = using sync path:", d.message); legacyGintSend(p); return; }
		if (d.kind !== "done") return;
		// 完成品をゼロコピー中継（TypedArray の underlying buffer を transfer。共有 buffer は Set で重複除去）
		const bufs = new Set();
		const collect = o => { for (const v of Object.values(o ?? {})) if (ArrayBuffer.isView(v)) bufs.add(v.buffer); };
		collect(d.gint); collect(d.artifacts?.base); collect(d.artifacts?.boundary);
		if (d.artifacts?.pivot?.px) bufs.add(d.artifacts.pivot.px.buffer);
		for (const t of d.tiers ?? []) if (t.metaU32) bufs.add(t.metaU32.buffer);
		wPost({ type: "set", cmd: "gintBaked", prop: p.key,
			data: { gint: d.gint, artifacts: d.artifacts, tiers: d.tiers, ...p.meta } }, [...bufs]);
		p.onDone?.();
	};
	bakeWorker.onerror = err => {   // worker 自体が死んだ＝保留全件を同期経路で救済し、以後は使わない
		console.warn("[gint] bake worker error = sync path from now on", err?.message ?? err);
		for (const p of bakePending.values()) if (!p.cancelled) legacyGintSend(p);
		bakePending.clear();
		bakeWorker.terminate(); bakeWorker = false;
	};
	return bakeWorker;
}
const cancelBake = key => { for (const p of bakePending.values()) if (p.key === key) p.cancelled = true; };
// raw（unPackGint 一式）を焼いて key スロットへ搭載。onDone は「render worker に届いた」後の再調停用。
// clone は bake worker への1回だけ（main の原本は identify の properties 参照用に生存）。
function bakeAndSend(key, raw, meta, onDone) {
	const w = ensureBakeWorker();
	const p = { key, raw, meta, onDone, cancelled: false };
	if (!w) return legacyGintSend(p);
	const id = ++bakeSeq;
	bakePending.set(id, p);
	w.postMessage({ id, data: {
		arcBuffer: raw.arcBuffer, arcMeta: raw.arcMeta, polyStream: raw.polyStream, lineStream: raw.lineStream,
		pointBuffer: raw.pointBuffer, point: raw.point, polyCompBbox: raw.polyCompBbox, fillMaxEdges: raw.fillMaxEdges } });
}
// 海岸線のベイク発火（初回ロード後と、LOW_MEM で束を破棄した後の再入の両方から）。
let coastBaking = false;
function bakeCoast() {
	if (coastBaking || coastSent || !coastGint) return;
	coastBaking = true;
	bakeAndSend("coast", coastGint, { maxZoom: 9 },
		() => { coastBaking = false; coastSent = true; gintSlot = null; updateGintSlot(); needsDraw = true; });
}
// ユーザー層のベイク発火（applyGintData の初回と、LOW_MEM で束を破棄した後の再入の両方から）。
// 進行フラグは userGint オブジェクト自身に持つ＝層差し替え（新オブジェクト）で自然にリセット。
function bakeUser() {
	if (!userGint || userGint.sent || userGint.baking) return;
	userGint.baking = true;
	const g = userGint.g;
	bakeAndSend("user", g, {}, () => {
		if (userGint?.g !== g) return;   // 焼いている間に別の層へ差し替わった＝結果は捨てられている（cancelBake）
		userGint.baking = false; userGint.sent = true;
		gintSlot = null; updateGintSlot(); needsDraw = true;
		// 預かり paint の着色はここでやらない＝applyUserSlot（user 束が実際に活性になる瞬間）で flush。
		// ここで送ると z<GINT_SWAP_Z（ドリル飛行中の点灯等）は海岸線束が活性のまま＝paint が海岸線束へ
		// 迷子になり、z 跨ぎで user 束に載った時は無着色＝既定オレンジ（maff 筆の緑が出ない実測 2026-08-18）。
	});
}
// gint paint（fidスタイル表）の送達＝スロット事情の吸収。paint はエンジン側で「アクティブ束」に
// 着地するため、user 層のベイク完了前（海岸線表示中）に送ると海岸線束へ迷子になり、点火後も無着色に
// なる（AI層が paint をロード直後に適用するケース）。未 sent の間は預かり、bakeUser の onDone
//（gintSlot 適用後＝user がアクティブ）で着色する。null（解除）も同じ経路＝順序が保たれる。
function sendGintPaint(p) {
	// 未ベイクに加え「user スロットが非活性（海岸線表示中＝z<GINT_SWAP_Z 等）」も預かる＝
	// アクティブ束が user でない間に送ると海岸線束へ着地して失われる（applyUserSlot が flush）。
	if (userGint && (!userGint.sent || gintSlot !== "user")) { userGint.pendingPaint = p; return; }
	renderer.set("gintPaint", p);
}
function applyCoastSlot() {
	if (!coastGint) return;
	if (!coastSent) { bakeCoast(); return; }   // ベイク中/未ベイク＝焼き上がりの onDone が再調停する
	// LOW_MEM＝海岸線表示中は user 束（nps級で GPU 100MB超）を眠らせておかない＝破棄（iOS jetsam 対策）。
	// 再入（z≥minZoom）は bakeUser が非ブロッキング再ベイク＝海岸線を描いたまま焼き上がりで点火。
	if (LOW_MEM && userGint?.sent) { renderer.set("gint", null, "user"); userGint.sent = false; }
	renderer.set("gintSlot", "coast");
	// 海岸線＝lineStream＝styleId=1。紙＋淡青の色調に「薄い青灰グレー・細く」。
	const coastStyle = new Float32Array(256 * 4);
	coastStyle.set([1.0, 0.42, 0.208, 1.0]);   // style0 polygon（未使用）
	coastStyle.set(theme.coastLine, 4);        // style1 = 海岸線（テーマ台帳のノブ）
	gintDrawOpts = { styleTable: coastStyle, lineWidth: 0.75 };
	gintInteractive = false;   // 海岸線は装飾＝ホバー/クリック識別なし
	if (gintHoverTip) gintHoverTip(null);   // ユーザー層→海岸線＝残ったホバー tip を消す
	sendGintStyle(); gintSlot = "coast"; needsDraw = true;
}
function applyUserSlot() {
	if (!userGint) return;
	if (!userGint.sent) { bakeUser(); return; }   // 未ベイク（初回/LOW_MEM退避後）＝焼き上がりの onDone が再調停する（それまで海岸線のまま）
	renderer.set("gintSlot", "user");
	gintDrawOpts = userGint.style;           // 層の持参スタイル（AI層=styleTable、null=既定＝14条筆のオレンジ/シアン。海岸線グレーは引きずらない）
	gintInteractive = userGint.interactive;  // 筆/図形/AI層はホバー/クリックで突合
	gintHover = userGint.hover !== false;    // 災害面は hover:false＝ホバー処理オフ（クリックは interactive で生存）
	if (!gintHover) gintHoverTip?.(null);    // 前層の残り tip を消す
	if (userGint.pendingPaint !== undefined) {   // ベイク中/海岸線スロット中に預かった paint を、user 束が活性のこの瞬間に着色（迷子の根治）
		renderer.set("gintPaint", userGint.pendingPaint);
		delete userGint.pendingPaint;
	}
	sendGintStyle(); gintSlot = "user"; needsDraw = true;
}
// gint ユーザー層（14条筆/ドロップ/AI層）を丸ごと撤去＝clearGint(dropFile)/clearPlan(ai) の重複6行を一本化。
// 本体・地形沿い境界線(gintBld)・識別(gintInteractive)/tip を落とし、スロットを再調停（該当ズームなら海岸線へ戻す）。
function clearUserGint() {
	userGint = null; gintSlot = null;
	cancelBake("user");                   // 焼き途中の結果は捨てる（届いても中継しない）
	renderer.set("gint", null, "user");   // user 束を GPU 資産ごと破棄（次フレームの地図再描画が残像ごと消す）
	renderer.set("gintBld", null); drapedOn = false;   // 地形沿い境界線も一蓮托生
	gintInteractive = false;
	gintHoverTip?.(null);            // ホバー tip を消す
	needsDraw = true;
	updateGintSlot();                // z<GINT_SWAP_Z 等で海岸線が該当すれば戻す
}
// gint スロットを空化（海岸線を降ろす）＝軽量交替で「何も載せない」。束（GPU資産）は worker 側に残す＝
// 再訪で即（suppressCoast は「重いロードを避ける」が目的で、キャッシュ済み束の保持はメモリ十数MB＝許容）。
// LOW_MEM 端末だけは束ごと破棄（iOS jetsam 対策）＝再訪時は coastSent を折って再送。
function clearGintSlot() {
	if (LOW_MEM) { renderer.set("gint", null, "coast"); coastSent = false; }
	else renderer.set("gintSlot", null);
	if (gintHoverTip) gintHoverTip(null);
	gintSlot = null; needsDraw = true;
}
// ズームでスロットの中身を選ぶ。onMove から毎回呼ばれるが post は変更時だけ＝安い。海岸線は初回のみ遅延取得。
function updateGintSlot() {
	if (noGint) return;   // ?nogint=1＝海岸線ロードもスロット適用もしない（gint パスは空データ＝実質ゼロコスト）
	if (userGint && cam.zoom >= userGint.minZoom) { if (gintSlot !== "user") applyUserSlot(); return; }   // minZoom は層の属性（全国級AI層=2・筆/ドロップ=GINT_SWAP_Z）
	if (suppressCoast) { if (gintSlot === "coast") clearGintSlot(); return; }   // 飛行中の抑制：既に載っていれば降ろし、ロードもしない（loadWorldCoast へ落とさない）
	if (coastGint) { if (gintSlot !== "coast") applyCoastSlot(); return; }
	if (cam.zoom < COAST_Z && !coastLoading) loadWorldCoast();   // 海岸線 未取得＝取得後に updateGintSlot が表示
}
// 世界海岸線（Natural Earth 10m）を取得しキャッシュ（表示可否は updateGintSlot が決める）。
async function loadWorldCoast() {
	if (coastLoading || coastGint) return; coastLoading = true;
	// モバイル（LOW_MEM）は 50m 版＝頂点数が一桁小さい（10m=41万頂点→50m=数万）＝GintBUF焼き・GPU・
	// スロット束の常駐とも軽量化（Kenji指定 2026-07-29）。z≤9 の世界図用途では見た目の差は僅か。
	// 50m は bucket 未収録＝毎回 zip フォールバック（S3→shpデコード）だが geopbf が URL キーで IDB
	// キャッシュする＝初回のみ。デスクトップは従来どおり 10m 全密度。
	const RES = LOW_MEM ? "50m" : "10m";
	console.log(`[coast] loading Natural Earth ${RES} coastline (bucket GeoPBF -> GintBUF)…`);
	let pbf = await geopbf(`ne_${RES}_coastline`).catch(e => { console.warn("[coast] bucket load failed", e); return null; });
	if (!pbf?.unPackGint) {
		console.warn("[coast] no geopbf in bucket -> falling back to raw zip (S3 -> shp decode)");
		pbf = await geopbf(`https://naturalearth.s3.amazonaws.com/${RES}_physical/ne_${RES}_coastline.zip`, { name: `ne_${RES}_coastline` }).catch(e => { console.error("[coast] geopbf", e); return null; });
	}
	const g = pbf?.unPackGint;
	coastLoading = false;
	if (!g) { console.error("[coast] GintBUF decode failed", pbf); return; }
	coastGint = {   // maxZoom:9＝z≤9 で点火＝低ズームの世界図専用（worker が範囲外をカリング）
		arcBuffer: g.arcBuffer, arcMeta: g.arcMeta,
		polyStream: g.polyStream, lineStream: g.lineStream,
		pointBuffer: g.pointBuffer, point: g.point, polyCompBbox: g.polyCompBbox,
		maxZoom: 9,
	};
	// bake-ahead：メタ/tier梯子を焼き切ってから搭載（焼き上がりの onDone で再調停＝そこで表示）
	bakeCoast();
	console.log("[coast] loaded. auto-shown at z<%d (no user layer / low zoom)", GINT_SWAP_Z);
}
dbgHost.__coast = loadWorldCoast;   // 手動リロード用
// 遅延ロードの門番は updateGintSlot（z<9 で海岸線 未取得なら一度だけ取得）＝高ズーム固定の埋め込みは一生読まない
//（PLATEAUスイッチと同じ思想＝見えない機能のための通信をしない。既定の世界ビュー起動時に updateGintSlot が即発火＝体験は不変）。

// --- 星空劇場（z<4・v1 ortho-map の星空アクセサリー移植）---
// stars.6（実在星表：RA/Dec・等級・B-V色指数）を天球単位ベクトル＋色＋点径に焼いて render worker へ。
// 向きは恒星時(GMST)＝engine が毎描画で回す（実時刻の空）。クリックで星座線（constellation_lines）をトグル。
const bvColor = v => v < -0.3 ? "#b2c8ff" : v < 0.0 ? "#d9e2ff" : v < 0.3 ? "#f8faff" : v < 0.6 ? "#fff8f0" :
	v < 0.8 ? "#fff2c8" : v < 1.1 ? "#ffe0b5" : v < 1.4 ? "#ffcc99" : "#ffab91";   // v1 border.js と同表
const celVec = (raDeg, decDeg) => {
	const ra = raDeg * D2R, dec = decDeg * D2R, cd = Math.cos(dec);
	return [cd * Math.cos(ra), Math.sin(dec), cd * Math.sin(ra)];
};
// 星空モジュール（planets/skynames＝z<4専用・計~12K）は初期バンドルに載せず、初めて星空パスに入る時に一度だけ動的読込。
// 読込後に下の holder へ注入＝以降の updatePlanets/toggleConstellations は従来どおり同期的に使える（memo化＝多重読込なし）。
let planetPositions, moonPosition, sunPosition, constellationJa;
let _skyLoad = null;
const ensureSkyMod = () => (_skyLoad ??= Promise.all([import("./planets.js"), import("./skynames.js")]).then(([p, s]) => {
	({ planetPositions, moonPosition, sunPosition } = p); ({ constellationJa } = s);
}));
let starsArmed = true;
function ensureStars() { if (starsArmed && cam.zoom < BASEMAP_MINZOOM) { starsArmed = false; loadStars(); ensureSkyMod().then(startPlanets); } }
// 惑星（実位置・低精度ケプラー＝planets.js）：星と同じ点バッファ形式で常設。名前は注記トグル(skyLabels)側。
// 位置は10分毎に再計算（最速の水星でも0.03°/10分＝表示上は静止と同じだが、開きっぱなしの夜に正直でいる）。
let planetTimer = null, planetLabels = [];
let solarSky = null, solarSkyLoad = null, inSolarPrev = false;   // 太陽系圏（z<1）＝solarsky.js の状態
function updatePlanets() {
	const now = new Date();
	// 太陽系圏＝ドーム表現（天球方向のみ・距離なし）は世界表現（solarsky＝実位置3D）と矛盾する＝引っ込めて交代
	if (!solarOff && cam.zoom < 1) {
		renderer.set("planets", new Float32Array(0));
		renderer.set("skyMoon", null);
		planetLabels = [];
		if (skyLabels) { skyLabels.planets = []; if (constelVisible) renderer.set("skyLabels", skyLabels); }
		needsDraw = true;
		return;
	}
	const ps = planetPositions(now), moon = moonPosition(now), sun = sunPosition(now);
	const buf = new Float32Array(ps.length * 8);
	ps.forEach((p, i) => {
		const [x, y, z] = celVec(p.ra, p.dec);
		buf.set([x, y, z, p.color[0], p.color[1], p.color[2],
			Math.max(0, 1 - p.mag / 15), Math.max(2, (9 - p.mag) * 0.4 * dpr)], i * 8);
	});
	renderer.set("planets", buf);
	// 月＝満ち欠けの円盤（ラベルcanvas・欠け側は赤黒）。輝面比 k=(1-cosψ)/2（ψ=太陽との離角。月距離≪太陽距離の近似）
	const mCel = celVec(moon.ra, moon.dec), sCel = celVec(sun.ra, sun.dec);
	const k = (1 - (mCel[0] * sCel[0] + mCel[1] * sCel[1] + mCel[2] * sCel[2])) / 2;
	renderer.set("skyMoon", { cel: mCel, sunCel: sCel, k });
	planetLabels = [...ps, moon].map(p => ({ cel: celVec(p.ra, p.dec), name: p.name }));
	if (skyLabels) {
		skyLabels.planets = planetLabels;
		if (constelVisible) renderer.set("skyLabels", skyLabels);
	}
	needsDraw = true;
}
// 星空劇場の家具（quiet-monoの逆相家具＝#map.worldでだけ点灯）：左下=日時計（1秒針）、右下=空データの出典。
// 「実時刻の空」を名乗る劇場の証書＝今この瞬間を刻む時計と、データの出どころ。
const skyClockEl = document.createElement("div");
skyClockEl.id = "sky-clock";
mapEl.appendChild(skyClockEl);
const skyAttrEl = document.createElement("div");
skyAttrEl.id = "sky-attr";
skyAttrEl.textContent = t("星図: d3-celestial ／ 海岸線: Natural Earth ／ 標高: GEBCO ／ © 2026 Kenji Yoshida");   // z<4はR90(GEBCO)のみ＝JAXA(R01)は使わない
mapEl.appendChild(skyAttrEl);
const SKY_WD = getLang() === "ja" ? ["日", "月", "火", "水", "木", "金", "土"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const skyClockTimer = setInterval(() => {
	if (cam.zoom >= BASEMAP_MINZOOM) return;   // 見えていない間はDOMに触れない
	const d = new Date(), L2 = n => String(n).padStart(2, "0");
	skyClockEl.textContent = `${d.getFullYear()}/${L2(d.getMonth() + 1)}/${L2(d.getDate())} (${SKY_WD[d.getDay()]}) ${L2(d.getHours())}:${L2(d.getMinutes())}:${L2(d.getSeconds())}`;
}, 1000);

function startPlanets() {
	if (planetTimer) return;
	updatePlanets();
	planetTimer = setInterval(updatePlanets, 600000);   // 最速の月でも0.09°/10分＝表示上は連続
	// 黄道（黄緯0の大円・J2000）＝淡い黄：太陽・月・惑星の通り道。天の赤道（赤緯0）＝淡い青灰：
	// 地球の赤道の空への投影＝GMSTで空が回る軸の「胴回り」。二本の交点が春分点・秋分点、開き23.4°が地軸の傾き
	// ＝季節の仕組みがそのまま絵になる。どちらも注記トグル(showConst)と同時に出る。
	const es = [], qs = [], eps = 23.43928 * D2R;
	for (let l = 0; l < 360; l += 2) for (const g of [l, l + 2]) {
		const s = Math.sin(g * D2R), c = Math.cos(g * D2R);
		es.push(c, s * Math.sin(eps), s * Math.cos(eps));
		qs.push(c, 0, s);
	}
	renderer.set("ecliptic", Float32Array.from(es));
	renderer.set("celequator", Float32Array.from(qs));
}
async function loadStars() {
	const pbf = await geopbf("stars.6", { gint: false }).catch(e => { console.warn("[stars] load failed", e); return null; });
	const g = pbf && pbf.geojson;
	if (!g) { starsArmed = true; return; }   // 一過性失敗は次の機会に再試行
	const fs = g.features;
	const buf = new Float32Array(fs.length * 8);
	for (let i = 0; i < fs.length; i++) {
		const { mag, bv } = fs[i].properties, [ra, dec] = fs[i].geometry.coordinates;
		const hex = bvColor(bv);
		const [x, y, z] = celVec(ra, dec);
		buf.set([x, y, z,
			parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255,
			Math.max(0, 1 - mag / 15),                    // 等級→明るさ（v1と同式）
			Math.max(1.5, (9 - mag) * 0.4 * dpr)], i * 8);   // 等級→点径（v1の半径0.2css相当をdevice pxへ）
	}
	renderer.set("stars", buf);
	needsDraw = true;
	console.log(`[stars] ${fs.length} stars loaded (drawn at z<4; click for constellation lines)`);
}
// 星座線＋星座名＋メシエ天体：クリックでトグル（v1と同じ所作＝三点一組）。初回クリックでロード→表示、以降は表示反転のみ。
// 線は GL（render worker）、名前と記号はラベルcanvas（skyLabels）＝どちらも同じ変換・同じタイミングで出入りする。
let constelState = 0, constelVisible = false, skyLabels = null;   // 0=未読込 1=読込中 2=読込済
// 表示の実務（点灯希望×圏の裁き→engine）。トグル・URL同期・太陽系圏の出入りの三者が共用＝経路一本。
// 星座線・星座名・黄道/天の赤道＝「地球から見た空」の注記＝太陽系圏(z<1)では休演（点灯状態は保持）
function constelApply() {
	const show = constelState === 2 && constelVisible && !(!solarOff && cam.zoom < 1);
	renderer.set("view", { showConst: show });
	renderer.set("skyLabels", show ? skyLabels : null);
	needsDraw = true;
}
async function toggleConstellations() {
	if (constelState === 1) return;
	if (constelState === 2) {
		constelVisible = !constelVisible;
		constelApply();
		return;
	}
	constelState = 1;
	await ensureSkyMod();   // 星座名の日本語化(skynames)を使う前に星空モジュールの読込を保証（初回z<4で通常は既済）
	const [cl, ms] = await Promise.all([
		geopbf("constellation_lines", { gint: false }).catch(e => { console.warn("[constellation] load failed", e); return null; }),
		geopbf("messier", { gint: false }).catch(() => null),   // 任意（v1と同じ＝無ければ星座線と名前だけ）
	]);
	const g = cl && cl.geojson;
	if (!g) { constelState = 0; return; }
	const seg = [], consts = [];
	for (const f of g.features) {
		const lines = f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates];
		for (const line of lines) for (let i = 0; i < line.length - 1; i++)
			seg.push(...celVec(line[i][0], line[i][1]), ...celVec(line[i + 1][0], line[i + 1][1]));
		// 星座名の置き場＝全頂点の天球ベクトル平均を正規化（v1のra/dec単純平均はRA 0/360跨ぎの星座で狂う。ベクトル平均は跨ぎ無縁）
		// 名前は日本語化（skynames.js＝IAU略号/ラテン名の両対応。v2=japanの流儀＝惑星名と揃える）
		const name = constellationJa(f.properties?.name ?? f.properties?.id ?? f.id);
		if (name) {
			let vx = 0, vy = 0, vz = 0;
			for (const line of lines) for (const p of line) { const v = celVec(p[0], p[1]); vx += v[0]; vy += v[1]; vz += v[2]; }
			const l = Math.hypot(vx, vy, vz) || 1;
			consts.push({ cel: [vx / l, vy / l, vz / l], name });
		}
	}
	const messier = [];
	if (ms && ms.geojson) for (const f of ms.geojson.features) {
		const c = f.geometry.coordinates;
		messier.push({ cel: celVec(c[0], c[1]), name: f.properties?.name || "", type: f.properties?.type || "" });
	}
	skyLabels = { constellations: consts, messier, planets: planetLabels };   // 惑星名も注記の一員（位置は updatePlanets が更新）
	renderer.set("constellations", Float32Array.from(seg));
	constelState = 2; constelVisible = true;
	constelApply();
	console.log(`[constellation] ${consts.length} constellations + ${messier.length} Messier objects loaded (click to toggle)`);
	if (!printHold) saveView();   // 初回ロード(2秒級)中に settle の saveView が sky 抜きで先行する＝完了後に l=sky を書き戻す（レース根治・モバイル実測）
}
// URL(l=sky)⇄星座表示の冪等同期：望む状態と違う時だけ toggle を叩く（未読込なら読込→表示、読込済なら反転）。
// z によらず状態を確定させる＝共有URLの往復で消えない（z<4に降りた時に実際に描かれる。worldFade が可視ゲート）。
function applyConstellations(want) { if (!!want !== constelVisible) toggleConstellations(); }

// N02（国土数値情報 鉄道）から新幹線だけ抽出して常駐オーバーレイに（gishub-jp と同じ geopbf 経路）。
// 新幹線＝N02_002(事業者種別)=1「JRの新幹線」。全国一括・疎＝軽い。鉄道チップONで表示、初回だけ fetch。※駅/空港/道の駅は次段。
// ソースは coast と同じ事前変換 GeoPBF（bucket GIS/pbf/N02-25_RailroadSection・路線名/事業者の属性付き＝
// 将来の全線ホバー名表示にそのまま使える）。bucket に無い間だけ生 zip へフォールバック。
// 同じ棚に N02-25_Station（駅名）/ N06-24_HighwaySection（高速道路名）/ N06-24_Joint（IC/JCT名）も配置済み＝次段の弾。
const N02_ZIP = "https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip";
const N02_ORIGIN = [138, 37];   // 全国オーバーレイの原点（delta符号化用・度スケール＝精度問題なし）
let n02Loaded = false;
async function loadN02() {
	if (n02Loaded) return;
	n02Loaded = true;
	console.log("[N02] loading rail geojson (extracting shinkansen)…");
	let rail = await geopbf("N02-25_RailroadSection").catch(e => { console.warn("[N02] bucket load failed", e); return null; });
	if (!rail?.geojson?.features?.length) {
		console.warn("[N02] no geopbf in bucket -> falling back to raw zip");
		rail = await geopbf(`${N02_ZIP}#N02-25_RailroadSection.geojson`).catch(e => { console.warn("[N02] rail failed", e); return null; });
	}
	const fc = rail?.geojson;   // GeoPBF の境界は FeatureCollection。.geojson getter＝{type:"FeatureCollection",features,name}
	const feats = fc?.features;
	if (!feats?.length) { console.warn("[N02] rail load failed", rail && Object.keys(rail)); n02Loaded = false; return; }
	// フル新幹線＝N02_002(事業者種別)=1。ミニ新幹線（秋田・山形）は法規上在来線＝N02には田沢湖線・奥羽線として
	// 収録されているので、該当区間を緯度帯クリップで切り出して仲間に入れる（奥羽線は福島→青森へ緯度ほぼ単調）。
	const sn = feats.filter(f => { const p = f.properties || {}; return p.N02_002 == 1 || /新幹線/.test(String(p.N02_003)); });
	const latClip = (f, lo, hi) => {   // 緯度帯 [lo,hi] に入る線分だけ残す（区間抽出）
		const g = f.geometry; if (!g) return null;
		const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
		const out = [];
		for (const line of lines) {
			let cur = [];
			for (const pt of line) {
				if (pt[1] >= lo && pt[1] <= hi) cur.push(pt);
				else { if (cur.length > 1) out.push(cur); cur = []; }
			}
			if (cur.length > 1) out.push(cur);
		}
		return out.length ? { geometry: { type: "MultiLineString", coordinates: out } } : null;
	};
	let miniN = 0;
	for (const f of feats) {
		const n = String(f.properties?.N02_003 || "");
		if (/^田沢湖線$/.test(n)) { sn.push(f); miniN++; }                       // 秋田新幹線 盛岡—大曲（全線が共用）
		else if (/^奥羽(本)?線$/.test(n)) {
			const ya = latClip(f, 37.74, 38.77), ak = latClip(f, 39.44, 39.73);   // 山形新幹線 福島—新庄／秋田新幹線 大曲—秋田
			if (ya) { sn.push(ya); miniN++; }
			if (ak) { sn.push(ak); miniN++; }
		}
	}
	console.log("[N02] rail", feats.length, "-> shinkansen", sn.length, `(mini ${miniN})`, "| lines:", [...new Set(sn.map(f => f.properties?.N02_003 || "(mini section)"))].join("、"));
	// 濃緑の実線（鉄道点火#4b9e6aより暗く、高速の青#2f6cadと衝突しない）。半幅0.9＝計1.8px＝高速(低ズーム)と同太
	const SN_GREEN = [0.04, 0.42, 0.25, 0.95];
	const scenes = sn.length ? [buildGeoJSONOverlay(sn, N02_ORIGIN, { lineColor: SN_GREEN, lineWidth: 0.9 })] : [];
	// 路線ラインも基図と同じ z≥BASEMAP_MINZOOM でだけ描く：全球(z<4)は基図オフの「地球ぐるぐる」＝
	// 路線だけが宙に浮くバグになる（minZoom 未設定だと renderer の s.minZoom||0=0 で全ズーム描画）。
	if (scenes.length) scenes[0].minZoom = BASEMAP_MINZOOM;
	// 駅（Station.geojson＝線路沿いの短いポリライン）：新幹線駅だけをビーズ○で。濃緑の玉に紙色の芯を重ねる＝
	// 線シェーダは capsule（丸端）なので、極小セグメント×太い半幅がそのまま駅の玉になる。ミニ新幹線の停車駅は
	// 在来線駅として収録＝路線×駅名の許可リストで拾う（フル新幹線駅は N02_002=1 で正確に取れる）。
	const stn = await geopbf(`${N02_ZIP}#N02-25_Station.geojson`).catch(e => { console.warn("[N02] station failed", e); return null; });
	const stFeats = stn?.geojson?.features || [];
	const MINI_STOPS = new Set(["米沢", "高畠", "赤湯", "かみのやま温泉", "山形", "天童", "さくらんぼ東根", "村山", "大石田", "新庄",   // 山形新幹線
		"雫石", "田沢湖", "角館", "大曲", "秋田"]);                                                                                  // 秋田新幹線
	const stSn = stFeats.filter(f => {
		const p = f.properties || {};
		return p.N02_002 == 1 || (/^(田沢湖線|奥羽(本)?線)$/.test(String(p.N02_003)) && MINI_STOPS.has(String(p.N02_005)));
	});
	console.log("[N02] stations", stFeats.length, "-> shinkansen stations", stSn.length, "/ regular stations", stFeats.length - stSn.length);
	// 通常駅（新幹線駅以外の全駅）：駅名注記(422)が出るズームから点灯（minZoom）。鉄道点火と同じ緑の小ぶりビーズ。
	const snStnSet = new Set(stSn);
	const stReg = stFeats.filter(f => !snStnSet.has(f));
	if (stReg.length) {
		const rOuter = buildGeoJSONOverlay(stReg, N02_ORIGIN, { lineColor: [0.294, 0.62, 0.416, 1], lineWidth: 1.8 });      // 玉＝鉄道点火#4b9e6a
		const rCore = buildGeoJSONOverlay(stReg, N02_ORIGIN, { lineColor: [land[0], land[1], land[2], 1], lineWidth: 0.9 });      // 芯（紙色＝style由来＝夜も自動追従）
		rOuter.minZoom = rCore.minZoom = 11.5;   // 駅名の出るタイル(z11)が選ばれ始める頃から
		scenes.push(rOuter, rCore);
	}
	if (stSn.length) {   // 新幹線駅は通常駅の後＝重なったら新幹線ビーズが勝つ
		const sOuter = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: SN_GREEN, lineWidth: 2.4 });                      // 玉（外径）
		const sCore = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: [land[0], land[1], land[2], 1], lineWidth: 1.2 });       // 芯（紙色＝style由来）＝○に見える
		sOuter.minZoom = sCore.minZoom = 7.5;   // 全国ビュー(z〜6)ではビーズ不要＝広域(z7.5+)から。路線の線は z≥5（基図と同ゲート）
		scenes.push(sOuter, sCore);
	}
	renderer.set("n02", scenes);
	needsDraw = true;
	console.log("[N02] shinkansen drawn");
}
// デバッグ用カメラジャンプ：__cam(lon, lat, zoom, pitchDeg, bearingDeg)。検証スクリプトやコンソールから任意視点へ。
dbgHost.__cam = (lon, lat, zoom = cam.zoom, pitchDeg = cam.pitch * R2D, bearingDeg = cam.bearing * R2D) => {
	cam.center = [lon, lat]; cam.zoom = zoom; cam.pitch = pitchDeg * D2R; cam.bearing = bearingDeg * D2R;
	onMove();
};

// --- PLATEAU LOD2 建物スパイク（A＝loaders.gl）：b3dm を Draco 解凍→ECEF→単位球へ変換→mesh pass で球に立てる ---
// 実体（fetch/デコード/ECEF/RTE/被覆マスク）は全て plateauworker.js（メインスレッドをブロックしないためworker化）。
// 特定区を「今すぐ立てる」（カメラは動かさない）：常駐ヒット＝vis を戻すだけ（転送ゼロ）／未常駐＝IDB（温）or 網から
// ロードして常駐＋表示。ロードのジッタ対策の外＝停止中の積み込み（waitLoading のリビール準備）と手打ちデモ(__plateau)で共用。
// onMove→autoPlateau との二重ロードは plateauLoading ガードで防ぐ。返り＝立ったか(bool)の Promise。
function standUpWard(set, tiles) {
	if (plateauActive.has(set.name) || plateauLoading.has(set.name)) return Promise.resolve(false);
	if (plateauResident.has(set.name)) {   // 常駐ヒット＝表示フラグを戻すだけ（autoPlateau と同じ経路）
		plateauRetain(set.name, set); renderer.set("plateauVis", true, set.name); plateauActive.set(set.name, set); needsDraw = true;
		return Promise.resolve(true);
	}
	plateauLoading.add(set.name);
	return loadPlateau(set.base, tiles, set.name, set.noMask ? null : set.bbox, set.noMask, set)
		.then(ok => { if (ok === true) { plateauActive.set(set.name, set); plateauRetain(set.name, set); } return ok === true; })   // "cancelled"（自動ロード合流の端ケース）は活性化しない
		.finally(() => plateauLoading.delete(set.name));
}
// 手打ちデモ：地区名(部分一致)かbase URLを指定して読み込み、カメラもそこへ寄せる（自動と違いカメラを動かす）。省略時は登録簿の先頭。
dbgHost.__plateau = async (nameOrBase, tiles) => {
	if (!plateauOn) { console.warn("[plateau] opts.plateau=false = 3D buildings feature disabled"); return; }
	const set = !nameOrBase ? PLATEAU_SETS[0]
		: PLATEAU_SETS.find(s => s.base === nameOrBase || s.name === nameOrBase || s.name.includes(nameOrBase));
	if (!set) { console.error("[plateau] ward not found:", nameOrBase, `(catalog ${PLATEAU_SETS.length} entries)`); return; }
	await standUpWard(set, tiles);   // 立ち上げ（常駐ヒット＝vis戻し／未常駐＝ロード）。二重ロードは standUpWard 内の plateauLoading ガードで防ぐ
	const [w, s, e, n] = set.bbox;
	cam.center = [(w + e) / 2, (s + n) / 2]; cam.zoom = 16; cam.pitch = 45 * D2R; cam.bearing = 0;   // 地区中心・傾けて建物を見る
	onMove();
	console.log(`[plateau] done -> ${set.name} z16 tilt45°. right-drag to adjust tilt`);
};

// ロード本体（カメラは動かさない）：重い処理は plateauworker.js に丸投げ。メッシュはバッチ単位で worker→render worker
// 直結ポートを流れ逐次表示される（main を通らない。ここに返るのは全バッチ完了の ack だけ）。
// 成功可否 bool＝呼び出し側が plateauActive に加えるかの判断に使う。
async function loadPlateau(base, tiles, name, wardBbox, brid, ex = {}) {
	const ok = await workerLoadPlateau(base, tiles, name, wardBbox, brid, ex);
	if (ok === "cancelled") return ok;   // 視野離脱の協調キャンセル＝呼び出し側（autoPlateau）が残骸掃除する
	if (!ok) return false;
	needsDraw = true;
	console.log("[plateau] done", base);
	return true;
}

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
let poiClick = null;       // POI台帳編集のarmed中だけ非null＝同上（ガジェット毎に1スロット＝相互に潰さない）
let editClick = null;      // 派生アプリ編集モード（geoedit）中だけ非null＝同上（map.setEditClick で装着/解除）
// zoomMin の二重指定（前:ZOOM_MIN 後:2＝後勝ちで床2）を解消（2026-08-10）＝ホイール/ピンチも太陽系圏へ潜れる
const input = createInput({
	canvas, cam, size, dpr, maxPitch: opts.maxPitch ?? MAXPITCH, zoomMin: CAM_ZOOM_MIN, zoomMax: ZOOM_MAX, onMove, signal: ac.signal,   // opts.maxPitch＝派生アプリのチルト上限（0=俯瞰固定＝geoedit）。??＝0を殺さない
	blocked: () => modalOpen(mapEl),   // モーダル表示中は矢印キーで背後の地図を動かさない（文字入力中は input.js が自前で判定）
	onGesture: () => flightCtl.cancel(),
	onClick: (x, y) => {
		if (measureClick) return measureClick(x, y);   // 測距モード＝クリックは頂点追加へ（識別/星座は止める）
		if (poiClick) return poiClick(x, y);           // 台帳編集モード＝クリックは対象選択/置き先へ（同上）
		if (editClick) return editClick(x, y);         // 派生アプリ編集モード＝同上（geoedit の選択/作図）
		if (cam.zoom < BASEMAP_MINZOOM) {
			if (!solarOff && cam.zoom < 1) return;   // 太陽系圏＝星座注記は休演中（クリックで裏の状態だけ変えない）
			return void toggleConstellations().then(saveView);   // 全球ビュー＝クリックで星座線。表示状態は共有URL(l=sky)へ即書き戻す
		}
		overlay.identifyAt(x, y); if (gintInteractive) wPost({ type: "gintClick", x, y });
	},
	onHover: (x, y) => {
		lastHoverXY = [x, y];
		// smallAreaHover＝census2020限定＝estat中は町丁目を点in面で識別し名前tip＋境界太線（ミスは gint へフォールバック）。
		// デモ（フラグ無し）は従来どおり gint ホバーのみ＝凍結挙動を一切変えない。
		// tip 持参層（筆＝moj/maff）がホバー可で載っている間は gint が主導＝町丁目tip/太線と排他（本人裁定2026-08-18）。
		const fudeOwn = userGint?.tip && gintInteractive && gintHover;
		if (fudeOwn && estatTipOwn) { estatTipOwn = false; renderer.set("overlayHover", null); needsDraw = true; }   // 跨ぎ瞬間＝残った町丁目tip/太線を掃除（tip本文は直後の識別ackが上書き）
		if (!fudeOwn && opts.smallAreaHover && overlay.isEstatActive?.() && overlay.hoverAt(x, y)) return;
		if (gintInteractive && gintHover) wPost({ type: "gintMove", x, y });
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
	const hideUI = () => { if (overUI() || searchOpen()) { idleT = setTimeout(hideUI, IDLE_MS); return; } mapEl.classList.add("ui-idle"); };   // 操作中は消さず再武装
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
posEl.innerHTML = `<table><thead><tr><th>${t("経度")}</th><th>${t("緯度")}</th><th>${t("標高")}</th><th>${t("z値")}</th><th>${t("回転")}</th><th>${t("傾度")}</th></tr></thead><tbody><tr><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>`;
const posCells = [...posEl.querySelectorAll("td")];   // [経度, 緯度, 標高, z値, 回転, 傾度]（毎フレームはtextContent更新のみ＝DOM再構築しない）
let posMouse = null, posElev = null, posElevId = 0, posElevAt = 0, posRaf = false, getHeight = null;
setAltApiUrl("https://api.ortho-earth.com");
createGetHeight({ apiUrl: "https://api.ortho-earth.com", onend: () => { posElevAt = 0; schedulePos(); } })
	.then(f => { getHeight = f; });
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
const flightCtl = createFlight({ cam, viewW: () => size.w, maxPitch: MAXPITCH, minZoom: ZOOM_MIN, onMove, onFlying: f => {
	flying = f;
	if (!f && suppressCoast) { suppressCoast = false; updateGintSlot(); }   // 着地＝抑制解除→再評価（着地が低ズームなら海岸線が戻る）
} });
// flyTo をラップ：両端が z≥COAST_Z（coast 表示条件外）なら飛行中の海岸線を抑制＝弧の中間の低ズームで
// loadWorldCoast を誘発しない（描画も出さない）。片方でも coast 条件内なら従来どおり（端の海岸線をポップさせない）。
const flyTo = (lon, lat, zoom, tiltDeg, bearingDeg) => {
	suppressCoast = cam.zoom >= COAST_Z && zoom >= COAST_Z;
	if (suppressCoast) updateGintSlot();   // 既に coast がスロットに載っていれば離陸前に降ろす
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
if (bootView?.layers?.includes(SKY_LAYER)) applyConstellations(true);   // l=sky＝星座線ONで起動（z<4で実描画）
if (bootView?.contour && !("terrain" in fixedLayers)) layerState.terrain = true;   // 旧URLの c（等高線トグル時代）＝地形チップに読み替え（後方互換）
Object.assign(layerState, fixedLayers);   // 固定は最後＝共有URLでも破れない（埋め込み主の意図が勝つ）
let styleSig = JSON.stringify(layerState);
const themes = createThemes(style, { suppressAdmin: !!opts.hideAdminBoundary });   // 分類（allowlist）は themes.js の純関数。hideAdminBoundary＝基図の行政界(赤線)を常に隠す（派生アプリが自前境界を描く時）

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
	+ (cam.zoom < AIRPORT_MARK_MAXZ && airportMarks.length ? "A" : "")
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
	if (airportMarks.length && cam.zoom < AIRPORT_MARK_MAXZ) {   // 低ズーム＝静的台帳から空港マークのみ注入（タイル注記441と同名は二重にしない）
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
	if (k === "rail") { renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) loadN02(); }   // 鉄道ON＝N02新幹線も表示＋初回fetch
	if (k === "facility" && layerState.facility) loadLandmarks();   // 施設ON＝PLATEAUランドマーク台帳も初回fetch
	if (k === "terrain") applyTerrain();   // 地形＝等高線・測量点標高・水系も一緒に点火
	saveView();   // レイヤ状態も共有URLの一部＝即書き戻す
}
// チップ操作：状態を反転し、styleSig を更新して即再結合（再取得なし・一瞬）。
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
	const k = b.dataset.k; if (!k) return;   // data-k 無し＝UIトグル（数字など）は別ハンドラ
	setLayer(k, !layerState[k]);
}));
// 起動時の初期同期（共有URL復元＋opts.layersの固定を含む）：チップの見た目と rail/terrain 副作用を layerState に合わせる（既定どおりなら実質 no-op）
document.querySelectorAll(".chip[data-k]").forEach(syncChip);
if (layerState.rail) { renderer.set("view", { showN02: true }); loadN02(); }
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
	if (v.layers) applyConstellations(v.layers.includes(SKY_LAYER));   // 星座ON/OFFも反映
	if (v.contour && !("terrain" in fixedLayers)) layerState.terrain = true;   // 旧URLの c＝地形チップに読み替え（後方互換）
	document.querySelectorAll(".chip[data-k]").forEach(syncChip);
	styleSig = JSON.stringify(layerState); readySig = "";
	renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) loadN02();
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
	const gv = gintSlot === "user" ? (userGint?.drapeFill ? true : (drapedOn ? false : (cam.pitch || 0) < 0.02)) : cam.zoom < 9;
	if (gv !== gintVisible) { gintVisible = gv; renderer.set("gintVis", gv); }
	// パン/チルト中（ズーム不変）は詳細も再結合。ズーム中はLODポップ回避で停止まで待つ。
	const zoomStable = Math.abs(cam.zoom - zoomAtBuild) < 0.12;
	// 地形アトラスもズーム中は再構築しない：cellRes/セル数が連続変化して全再ロード＆勾配密度の跳びで
	// 陰影がチラつくため（terrainGate＝render worker 側の terrain.ensure() 呼び出しを止める合図）。
	// ズーム中は現アトラスを再投影（球面メッシュなので拡縮は追従）、停止後に再構築。
	// base の退場は「静止」だけでなく「main の鮮度確定」まで待つ：settle の瞬間は新しい merge がまだ届いて
	// いない（ズーム中は swapScene 自体を止めている＝main は古いズームの集合）。ここで即消しすると main が
	// 覆っていない領域が紙色で露出し、海(#e2e6ea)との差で白フラッシュ＝ちらつきになる（チルト75°で顕著）。
	// zoomStable も条件に含める＝settle 直後の1フレーム（swapScene が mainDesired を更新する前）を弾く。
	const mainFresh = !!readySig && readySig === mainDesired && zoomStable;
	// terrainGate: 標高アトラスの再構築（窓選定108unproject＋staging＋セルfetch）は重い＝移動中は一切行わず、
	// 停止時に一回だけ綺麗に作り直す（staging が旧アトラスを見せたまま静かに差し替える）。移動中の遅れは
	// 縁フェードと R90/旧窓の残像が受け持つ＝「無理せず、描画終了時に綺麗に描く」方針。
	renderer.draw(cam, { skipBase: !moving && mainFresh, skipMain: mainStale(), noTerrain: false, terrainGate: !moving });     // 先に最新camをworkerへ（全球でも標高の塗りは生かす）。印刷撮影中も標高アトラスは生かす＝真俯瞰(pitch0)で地形サーフェスは自然に平ら(elevScaleEff=0)なまま等高線だけ敷ける。海岸線は render worker が従属で追随
	// 全球ビュー（z<4）：基図(GSI)の詳細は不要＝タイル/結合/地形を止め、基図シーンを空に＝海岸線(gint)だけの軽い地球。
	// これで pan 中も main の毎フレーム負荷（tiles.update/merge/terrain）が消える。
	// 家具も全部フェード退場（attr含む＝quiet-mono #map.world）＝星空劇場の舞台。GSI非描画なので出典義務なし。
	mapEl.classList.toggle("world", cam.zoom < BASEMAP_MINZOOM);
	// 太陽系圏（z<1）：Canvas2D の薄いオーバーレイ（solarsky.js＝遅延ロード）が太陽・惑星・軌道線を実位置で重ねる。
	// カメラは engine と同じ cameraState を共有＝星空・地球と厳密に整合。圏の出入りでドーム惑星（方向のみ表現）と交代。
	const inSolar = !solarOff && cam.zoom < 1;
	if (inSolar && !solarSkyLoad) solarSkyLoad = import("./solarsky.js").then(m => { solarSky = m.createSolarSky({ mapEl }); needsDraw = true; }).catch(e => console.warn("[solar] zone load failed", e));
	solarSky?.frame(cam, size.w, size.h, inSolar);
	if (inSolar !== inSolarPrev) {
		inSolarPrev = inSolar;
		if (planetTimer) updatePlanets();   // ドーム惑星/月の点灯切替を即時反映
		if (constelState === 2) constelApply();   // 星座注記の休演/再点灯（裁きは constelApply に一本化）
	}
	if (cam.zoom < BASEMAP_MINZOOM) {
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
	sampleGroundElev();   // 中心の地面標高を追随（非同期・~100m格子メモ）＝groundR の材料
	const { order, coarseOrder, total } = tiles.update(cam, size.w, size.h, { tilePx: (moving || !gpuFast || !idleCalm) ? undefined : IDLE_TILE_PX, groundR: groundRNow(), keepFine: keepFineNow() });   // tilePx＝「本当の静止」（settle+550ms）だけ主層を一段細かく（手前の詳細化・GPU格付け fast 限定・undefined=既定560）。groundR＝地形リフト球（チルト×高標高地の手前くさび欠け根治）。keepFine＝ズームアウトの子孫代打（3D限定）。calm が needsDraw を立て、細タイルの ready は requestDraw で連鎖再描画
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
			estatTipOwn = true;
			gintHoverTip?.([name]);
			wPost({ type: "gintLeave" });   // 隣の市区町村に残った gint ホバー(太線)を消す（B→A復帰でBが光ったまま、の根治・本人報告2026-08-14）。leave は idempotent＝毎ヒットでも安価
			return;
		}
		estatTipOwn = false;
		if (gintInteractive && gintHover && lastHoverXY) wPost({ type: "gintMove", x: lastHoverXY[0], y: lastHoverXY[1] });
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
	const names = new Set([...plateauActive.keys(), ...plateauResident.keys()]);
	let plat = 0; for (const n of names) plat += bytesOf(n, plateauActive.get(n) || plateauResident.get(n));
	const ts = tiles.stats();
	const gpu = memGpu ? memGpu.atlas + memGpu.mesh + memGpu.msaa : 0;   // GPU固定＝標高アトラス近/裏/遠＋地形メッシュ＋MSAA（webgpuのみ・GL2は暗黙確保で0表示）
	const trC = plateauMemW.reduce((s, m) => s + (m?.cache || 0), 0);    // 過渡＝worker内cache（常駐台帳外・コールド落ちの主役）
	const trL = plateauMemW.reduce((s, m) => s + (m?.live || 0), 0);     // 過渡＝ロード中の区の全量保持
	const total = plat + ts.bytes + memTerrain + gpu + trC + trL;
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
		plateau: { bytes: plat, regions: plateauActive.size }, tiles: { bytes: ts.bytes, budget: ts.budgetBytes },
		terrain: memTerrain, heap: memHeap, gpu: memGpu, gpuBytes: gpu,
		transient: { cache: trC, live: trL, bytes: trC + trL },
		total, peak: hudPeak, budget: 900 * 1048576,   // 4GB機の推定タブ予算（8GB機の~1.4GBより小さい）＝残りが薄いほど落ちる寸前
		tier: MID_TIER ? { active: PLATEAU_MAX_ACTIVE, residentGB: PLATEAU_RESIDENT_BYTES / 1e9, workers: PLATEAU_NW } : null,
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
	clearTimeout(settleT); clearTimeout(calmT); clearTimeout(bootT); clearInterval(planetTimer); clearInterval(skyClockTimer);
	destroyPipeline();                           // tile/scene worker
	renderWorker.terminate();
	plateauWorkers.forEach(w => w.terminate());
	overlay.destroy();                           // e-Stat worker（createOverlay内で常時起動しているため忘れずに）
	// デバッグ手はこのインスタンスの閉包を掴んだまま＝GCの錨になるので窓から下ろす
	// 生やした名前は全て下ろす（従来は13名だけ＝取りこぼしが閉包を掴んだまま残っていた）。
	// 埋め込み時は dbgHost が使い捨ての器＝この delete は空振りするが、閉包の錨は器ごと GC される。
	for (const k of ["__arakawaFit", "__backend", "__budget", "__cam", "__coast", "__drawErr", "__drawHud", "__drawSendErr", "__drawSendN", "__farState", "__fly", "__gload", "__lastOrder", "__loadEstat", "__loadOverlay", "__mergeFail", "__moj", "__mojFile", "__paint", "__paintFid", "__paintOverlap", "__paintParity", "__paintProps", "__plateau", "__plateauPurge", "__sapporo", "__standup", "__tileCache", "__tileStats", "__tokyo", "__vtPool"]) delete dbgHost[k];
	mapEl.classList.remove("world");             // 全球ビューの家具フェード状態を預かったdivに残さない
	if (ownMapEl) {   // 自前ページを預かった時に入れた inline 寸法を元へ（再起動しても二重に残らない）
		document.documentElement.style.cssText = pageStyle.html ?? "";
		document.body.style.cssText = pageStyle.body ?? "";
	} else mapEl.id = mapElPrevId;   // 預かった div の id は返す（家具規格で map へ改名していた分の後始末）
	ownMapEl ? mapEl.remove() : mapEl.replaceChildren();
}
// reload/離脱の瞬間に即 destroy＝worker群（renderworker のGL含む）を同期的に畳む。iOSは遷移中
// 「旧ページ＋新ページの二重居住」があり、テーマ切替（c=の暗転reload）連発のデモで boot メモリ×2が
// タブ予算(~1.4GB)を突く＝「淡色/鉄道地図で落ちる」の主犯。旧ページを殻にしてから新ページを立てる。
// persisted=true（bfcache行き）は畳まない＝戻る操作の即復帰を壊さない。
window.addEventListener("pagehide", e => { if (!e.persisted) destroy(); }, { signal: ac.signal });

// 世界海岸線：初期視点が z<9 ならここで即発火（既定の世界ビュー＝従来どおり最初から描画）。await せず＝基図の起動を妨げない。
updateGintSlot();
ensureStars();   // 初期視点が z<5（復元/共有URL）なら星空も最初から

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
	get view() { return { center: [...cam.center], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, theme: themeName, layers: FREE_LAYER_KEYS.filter(k => layerState[k]).concat(constelVisible ? [SKY_LAYER] : []), sky: constelVisible, hash: viewHash(), eye: eyePose() }; },
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
const elevOf = (lon, lat) => {
	const k = Math.round(lon * 1000) + "," + Math.round(lat * 1000);
	const hit = elevMemo.get(k);
	if (hit !== undefined) return typeof hit === "number" ? hit : 0;
	elevMemo.set(k, null);
	if (getHeight) Promise.resolve(getHeight(lon, lat, cam.zoom)).then(h => { elevMemo.set(k, +h || 0); needsDraw = true; }).catch(() => elevMemo.set(k, 0));
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
map.applyGintData = applyGintData;
map.standupGint = standupGint;         // liftM=null で解除
map.gintFeatures = gintFidFeatures;    // fid 整列 properties（式評価・表直書きの入力）
map.paint = paintGint;                 // Mapbox式 → buildFidStyle
map.paintTable = (u32, count) => { sendGintPaint({ table: u32, count }); needsDraw = true; };   // fid→RGBA表の直書き（コロプレス切替＝これだけ）
map.fitZoomForBbox = fitZoomForBbox;
map.projectLL = projectLL;             // 経緯度→画面CSS座標[x,y,front]（DOMマーカー用・front<0=裏半球）
map.unprojectXY = unprojectXY;         // canvasローカルCSS座標→[lon,lat]|null（onClick の x,y と同座標系。球外=null）
map.makeProjector = makeProjector;     // カメラ状態を1回束ねた投影関数（多点を1フレームで投影＝編集ハンドル用）
map.setEditClick = fn => { editClick = fn; };   // 派生アプリのクリック横取りスロット（null で解除＝measure/poi と同型）
map.requestDraw = () => { needsDraw = true; };  // オーバレイ更新後の1フレーム点火（派生アプリの編集描画用）
map.onFrame = fn => { frameHooks.add(fn); return () => frameHooks.delete(fn); };
map.onGintClick = fn => { gintClickHandler = fn; };
map.getHeight = (lon, lat) => getHeight ? Promise.resolve(getHeight(lon, lat, cam.zoom)).then(h => +h || 0) : Promise.resolve(0);
map.getZoom = () => cam.zoom;             // 現在ズーム（派生アプリのズーム連動 LOD＝集約⇄市区町村の層切替に）
map.gadget = function (name, func) {
	typeof name == "function" && name.name && (func = name, name = func.name);
	map.gadget[name] = function () { return func.apply(map, arguments); };
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
map.gadget("solar", function (opts) {   // 太陽系への口（ortho-solar） … 星空圏の境界(BASEMAP_MINZOOM)はここで注入
	const update = solarGadget.call(this, { showBelow: BASEMAP_MINZOOM, ...opts });
	if (update) { frameHooks.add(update); update(); }   // 圏の出入りで現れ/引っ込む＝毎フレ判定（コンパスと同じ）
});
map.gadget("plateau", function (opts) {   // 建物3D（PLATEAU）データ管理 … モーダルを開く手綱はここで注入
	if (!plateauOn) { console.warn("[plateau] opts.plateau=false = feature disabled; gadget not mounted"); return; }
	return plateauGadget.call(this, { onOpen: plateauDb.open, ...opts });
});
map.gadget("palette", function (opts) {   // 配色テーマ・ピッカー … 現在テーマ(見本から除く)と切替(switchTheme=c=差替+reload)と撮影(見本=今の視点の実写)を注入
	if (themeFixed) { console.warn("[palette] opts.theme is baked in = c= cannot override; gadget not mounted"); return; }
	return paletteGadget.call(this, { current: themeName, onPick: name => { switchTheme(name); saveView(); }, requestSnapshot, getZoom: () => cam.zoom, getCurrent: () => themeName, signal: ac.signal, ...opts });   // pick=テーマ生き替え→URL即書込（switchThemeはURLを書かない＝ここで saveView）
});
map.gadget("zoom", function (opts) {   // ズーム＋/− … フライト中断・onMove・z範囲はここで注入
	// zoomMin はカメラ実床（太陽系圏込み）＝ズームボタンでも太陽系の底まで降りられる（旧床2の取り残し解消 2026-08-10）
	return zoomGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, zoomMin: CAM_ZOOM_MIN, zoomMax: ZOOM_MAX, signal: ac.signal, ...opts });
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
		setClick: fn => { measureClick = fn; }, requestDraw: () => { needsDraw = true; },
		onBody: m => { if (m && m._update) { frameHooks.add(m._update); m._update(); } },   // 抽象アクセス：本体(measure.js)到着後に _update を毎フレ描画へ（frameHooks は core 側）
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
// 台本の中で「建物が実際に見える最初の視点」（チルト＋寄り＝pitch≥閾 かつ zoom≥AUTO_Z）の視界に掛かる建物区を返す。
// waitLoading のリビール準備で「開幕で立つ区だけ」を停止中に GPU へ積むための最小集合＝要らない区（真俯瞰・低ズーム・視界外の隣接・後続ホップ）は含めない。
function firstRevealSets(views) {
	for (const hash of views || []) {
		const v = typeof hash === "string" ? parseViewHash(hash) : hash;
		if (!v || v.zoom < PLATEAU_AUTO_Z || (v.pitch || 0) < 0.02) continue;   // 真俯瞰/低ズーム＝建物は出ない＝積まない
		const vb = approxViewBbox({ center: [v.lon, v.lat], zoom: v.zoom });   // approxViewBbox は zoom と center だけ使う（pitch/bearing 不問）
		return PLATEAU_SETS.filter(s => !s.noMask && bboxIntersects(s.bbox, vb));
	}
	return [];
}
let sceneBusy = false, sceneRun = 0;   // sceneBusy＝上映ライフサイクル中（準備〜走破〜終幕括弧）／sceneRun＝世代トークン：stopScenes が進めると準備中の再生は静かに降りる
const playingNow = () => sceneBusy || !!mapEl.querySelector("#demo-bar.on");   // 上映中判定＝▶デモ(バー点灯)もシーン再生も（上映中はドロップ禁止の裁定）
// ★scene-player API（プラットフォーム公開面・map.playScenes）：台本オブジェクトを直接上映する第三の入口（drop / ?scene= も同じ道）。
//   opts.from＝開始行／opts.quick=true＝軽い試写（黒幕・waitLoadingゲート・終幕括弧なし＝エディタの行プレビュー用）／
//   opts.onScene(i, scene)＝行の上映開始（フライト開始前＝行ハイライト用）／opts.onEnd(reason)＝どの終わり方でも1発（"finished"=走破・"stopped"=中断）。
//   戻り値＝受けたら true・上映中で受けなければ false（先に map.stopScenes()）。終演/中断/失敗のどの経路でも黒幕と上映ロックを残さない（手仕舞い一本化）。
function playScenes(obj, { from = 0, quick = false, onScene, onEnd } = {}) {
	if (playingNow()) { console.warn("[scene] already playing = rejected (call stopScenes() first)"); return false; }
	const lang = new URLSearchParams(location.search).get("lang");   // 言語選択は視聴者の ?lang= だけ（台本側の言語指定は無い＝既定は title の言語そのまま）
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
			const tick = setInterval(() => { if (plateauProg.size || elevBusy) poke(); }, 400);   // elevBusy はイベントが無い＝小さく見回る
			sceneProgTap = poke;   // 建物の枚数進捗はイベント駆動で即時反映
			// 読み切るまで待つ（タイムアウト無し）：各区は成功/失敗(plateauFailed)で必ず終端＝この await も必ず終わる。待ち時間の顔はパネルが引き受ける
			const wanted = (await prefetchPlateauForViews(views, preload, (d, total) => { ward = { done: d, total }; sceneLoading(ward); }).catch(() => [])) || [];
			clearInterval(tick); sceneProgTap = null;
			// ★リビール準備＝立ち切ってから開幕：最初のフレームから本物の3D（基図の押し出し箱を見せない）。
			// PC（WebGPU×非LOW_MEM＝全保持ヒステリシスと同じゲート）＝台本の全区を停止中に GPU 常駐まで積む＝道中・後続シーンも vis 点灯だけで即立つ。
			// 「ロードは停止中に・移動中は点灯だけ」の原則は不変（今は停止中）。低級機フォールバック＝最初のリビール視点の区だけ（従来）。
			// 失敗区(plateauFailed)は諦めて進む＝黒画面で永遠に待たない。
			// 低級機フォールバックの選抜（firstRevealSets＝bbox交差）はプリロード選抜（前方点ゲート）より緩い＝
			// 未プリロード区が混ざると立ち上げ段で網ロードが始まる（実測=千代田区・リビール直前の想定外ネットワーク）。
			// →プリロード済み区との積集合に絞る＝立ち上げ段は常に IDB→GPU だけ（wanted 空の縁だけ従来通り）。
			const wantedNames = new Set(wanted.map(s => s.name));
			const targets = ((gpuBackend && !LOW_MEM && wanted.length) ? wanted
				: firstRevealSets(views).filter(s => !wanted.length || wantedNames.has(s.name))).filter(s => !plateauDead(s.name));
			if (targets.length) {
				const gpuHint = setTimeout(() => sceneLoading({ ...ward, show: true, phase: "gpu" }), 700);   // 一瞬で立ち切る時はパネルを出さない
				await Promise.all(targets.map(s => standUpWard(s)));
				// standUpWard は「既に可視ロードが走行中」の区を false 即決で素通しする＝活性化の完了を見届ける（安全弁120秒・failed も抜け口）
				for (const t0 = performance.now(); !targets.every(s => plateauActive.has(s.name) || plateauDead(s.name)) && performance.now() - t0 < 120000;) await new Promise(r => setTimeout(r, 250));
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
		sceneLoading(false); sceneProgTap = null; sceneBusy = false;
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
	sceneBusy = false; sceneLoading(false); sceneCover(false); sceneProgTap = null;
	return true;
}
// ★タイムライン・スクラブ（scene-player API・map.sceneTimeline）：台本→時刻評価＝再生せず任意秒の絵を出す（エディタのスクラブ用）。
// 中身は純関数（demo/scene-timeline.js＝プレーヤー規則の写し × flightCtl.plan＝飛行の時刻評価プラン）。
// seek(秒)＝l=/c= はその行までの累積（l= は絶対指定＝手前の最後に書いた行が勝つ・無ければ現状維持＝プレーヤーの離陸時点火と同じ意味論・逆走も決定的）
// ＋カメラ直書き＋fade の黒(cover)。URL は書かない＝end() で1回（スクラブ終了＝確定視点の掟・saveView）。上映中は受けない（先に stopScenes）。
function sceneTimeline(obj) {
	const tl = buildSceneTimeline(obj, { plan: flightCtl.plan, parseView: parseViewHash, portrait: mapEl.clientHeight > mapEl.clientWidth, zoomMin: ZOOM_MIN });
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
{
	const sceneUrl = new URLSearchParams(location.search).get("scene");
	if (sceneUrl) fetch(sceneUrl).then(async r => {
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const buf = new Uint8Array(await r.arrayBuffer());
		return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b) ? await gunzipText(buf) : new TextDecoder().decode(buf));
	}).then(obj => {
		if (obj?.type !== "scenes") { console.warn(`[scene] type is not "scenes" = not playing`, sceneUrl); return; }
		const arm = tries => demoHandle ? playScene(obj) : (tries < 100 ? setTimeout(() => arm(tries + 1), 100) : console.warn("[scene] demo never mounted = gave up on ?scene="));
		arm(0);
	}).catch(err => console.warn("[scene] failed to fetch ?scene=", sceneUrl, err));
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
		title.textContent = t("シーンを読み込み中…");
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
	const parts = [...plateauProg.values()].map(p =>
		p.total ? t("{0} {1}/{2}枚", p.name, p.done, p.total) : t("{0} カタログ走査 {1}…", p.name, p.scan ?? 0));
	if (elevBusy) parts.push(t("標高タイル"));
	slSub.textContent = parts.join("・") || t("3D都市（PLATEAU）");
	const { done = 0, total = 0 } = state;
	if (state.phase === "gpu") {   // 読み切った後の最終段＝IDB→GPU 常駐へ立ち切る待ち（開幕の直前）
		slFill.style.width = "100%";
		slCount.textContent = t("都市を立ち上げ中…");
	} else if (total) {
		// バーは区の歩み＋読みかけ区のタイル進捗（なめらか担当・並行読みの分は全部加算＝残り区数でクランプ）
		const frac = Math.min(Math.max(0, total - done), [...plateauProg.values()].reduce((a, p) => a + (p.total ? Math.min(1, p.done / p.total) : 0), 0));
		slFill.style.width = Math.max(6, Math.round(Math.min(1, (done + frac) / total) * 100)) + "%";
		slCount.textContent = t("{0} / {1} 区", done, total);
	} else {
		slFill.style.width = "6%";
		slCount.textContent = t("準備中…");
	}
}
map.gadget("dropFile", function (opts) {   // GISファイルのD&D取り込み … geopbf(File,{gint:true})→applyGintData を loadFile として束ね注入（gint単一スロット＝置き換え）
	const loadFile = async file => {
		const pbf = await geopbf(file, { gint: true, name: `drop/${file.name}` }).catch(err => { console.error("[dropFile] geopbf", file.name, err); return null; });
		if (!pbf?.unPackGint) return null;
		// 低ズーム描画が速くなった＝先に現在ビューへ図形を描き（カメラは動かさない）、その後 flyTo で寄る。
		// 瞬間ジャンプ(ポップイン)でなく「図形が現れて→近づく」。着地は真俯瞰(tilt/bearing=0)・北向き＝fit の north-up 前提。
		applyGintData(pbf, file.name, false, { drape: true });   // 先に描画（gint スロットへ set・識別点火・カメラ据え置き）＋ポリゴンは地形沿い境界線を自動発火
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
	return dropFileGadget.call(this, { loadFile, clearGint: clearUserGint, playScene, busy: playingNow, signal: ac.signal, ...opts });   // busy＝上映中はドロップ無視（デモ中はドロップ禁止）
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
			if (!plateauAutoLoading.size && !elevBusy && !base) return "";
			return `A${[...plateauAutoLoading.keys()].join(".")}|P${[...plateauProg.values()].map(p => p.done ?? p.scan ?? 0).join(".")}|E${elevN}|B${base ? 1 : 0}`;
		},
		// 静穏窓フック（裁定2026-08-12）＝書き終わり直後の一拍で「残り台本に出ない」常駐区を降ろす（上の trim 参照）
		onQuiet: views => plateauTrimForScript(views),
		prefetchViews: prefetchPlateauForViews, finale: japanFit, signal: ac.signal, zoomMin: ZOOM_MIN, ...opts });   // 手綱を掴む＝ドロップ/?scene= は playScene→demoHandle.start(落とした台本, bare) で別入り口再生（▶=組み込みは壊さない）。glidePath＝via連続ドリー／fadeView＝黒挟み遷移（fadeBusy を着地待ちに乗せる）
	return demoHandle;
});
map.gadget("ai", function (opts) {   // AIと会話して地図に描く（PC専用・画面2分割）… 描画受け口とbboxフィット・消去・アセット置き場を注入
	const fitBbox = bb => {   // dropFile と同じ視野幅の逆解き＝fit へ球面フライト（真俯瞰・北向き）
		const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
		const wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);
		const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
		flyTo(cx, cy, Math.max(3, Math.min(17, z)), 0);
	};
	// route ディスパッチ：overlay/estat＝overlay.loadPlan（main+estat worker）、gint＝worker デコード+GPU 常駐 LOD。
	// 大規模データ（国立公園=頂点451万）は overlay だと main 数秒凍結＝gint が受け持つ（catalog の route が正本）。
	const runPlan = async plan => {
		if (plan.route !== "gint") return overlay.loadPlan(plan);
		const label = `ai/${plan.dataset}`;
		const pbf = await geopbf(plan.target, { gint: true, name: label }).catch(err => { console.warn("[ai] gint", plan.target, err); return null; });
		if (!pbf?.unPackGint) return { ok: false, reason: "load" };
		const st = new Float32Array(256 * 4);   // styleTable: style0=polygon塗り（薄く＝基図を殺さない）・style1=線
		const [r, g, b] = plan.style.rgba;
		st.set([r, g, b, 0.28]); st.set([r, g, b, 1], 4);
		applyGintData(pbf, label, false, { style: { styleTable: st, lineWidth: plan.style.lineWidth }, minZoom: 3 });   // minZoom:3＝全国級の層は世界図の手前まで見せる
		const bb = pbf.unPackGint.bbox;
		return { ok: true, count: pbf.length, bbox: (bb && bb.length === 4) ? bb : null };
	};
	const clearPlan = () => {   // AI層の消去＝overlay と、AIが載せた gint 層だけ（ドロップ/14条層は預からない）
		overlay.clearPlan();
		if (String(userGint?.label).startsWith("ai/")) clearUserGint();
	};
	return aiGadget.call(this, { runPlan, clearPlan, fitBbox, assetBase: ASSET_BASE, signal: ac.signal, ...opts });
});
// tip（カーソル追従の吹き出し）を既定搭載＝gint 層のホバー識別を指先へ。搭載はここ一箇所（dropFile/AI/14条どの経路でも効く）。
// 見えない div＝gint interactive 層をホバーした時だけ内容が出る＝非gintの埋め込みでは無害。
gintHoverTip = map.gadget.tip();
return map;
}
