// ortho-japan PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
// 意匠：quiet-mono（トークン→部品）→ app固有 の順に import＝カスケードの序列そのまま
import "quiet-mono/tokens.scss";
import "quiet-mono/components.scss";
import "./style.scss";
import {
	evalExpr, parseRGBA, cameraState, project, unproject, buildGeoJSONOverlay,
	createFlight, shortBearingOf, parseViewHash, buildViewHash, wrapLon, createInput,
} from "ortho-core";
import { createGeopbf, geopbf } from "geopbf";
import { createGetHeight, setApiUrl as setAltApiUrl } from "altpbf";
createGeopbf("https://api.ortho-earth.com");   // bucket 基盤（標高と同じ）。読み出しはキー不要
import { MAP_THEMES } from "./palettes.js";
import { createThemes, defaultLayerState, isFacility, isTerrain, CHOME_MINZOOM, RAILTR_MINZOOM } from "./themes.js";
import { createOverlay } from "./overlay.js";
// planets.js / skynames.js は z<4（星空）でしか使わない＝初期バンドルから外し、下の ensureSkyMod で動的読込。
import { createPipeline } from "ortho-core";   // tile/scene worker のスポーンごとエンジン側
import { createPlateauDb } from "./plateaudb.js";
import { mountGadgets } from "./gadgets/mount.js";
import { search as searchGadget } from "./gadgets/searchbox.js";
import { hint as hintGadget } from "./gadgets/hint.js";
import { compass as compassGadget } from "./gadgets/compass.js";
import { plateau as plateauGadget } from "./gadgets/plateau.js";
import { palette as paletteGadget } from "./gadgets/palette.js";
import { zoom as zoomGadget } from "./gadgets/zoom.js";
import { full as fullGadget } from "./gadgets/full.js";
import { cpos as cposGadget } from "./gadgets/cpos.js";
import { contextmenu as contextmenuGadget } from "./gadgets/contextmenu.js";
import { tip as tipGadget } from "./gadgets/tip.js";
import { pop as popGadget } from "./gadgets/pop.js";
import { explain as explainGadget } from "./gadgets/explain.js";
import { legend as legendGadget } from "./gadgets/legend.js";
import { measure as measureGadget } from "./gadgets/measure.js";
import { shot as shotGadget } from "./gadgets/shot.js";
import { japan as japanGadget } from "./gadgets/japan.js";
import { print as printGadget } from "./gadgets/print-stub.js";   // 本体(print.js)は初回起動時にimport()＝初期バンドルから隔離
import { close as closeGadget } from "./gadgets/close.js";
import { dropFile as dropFileGadget } from "./gadgets/dropfile.js";
import { demo as demoGadget } from "./gadgets/demo.js";
import { ai as aiGadget } from "./gadgets/ai.js";
import { modalOpen } from "./gadgets/keys.js";   // 矢印キーのモーダル抑止に使う共通判定（ショートカット群と共有）

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
//   opts.theme＝配色テーマの固定（"dark"等の台帳名＝焼き付け・URLに書かない／台帳と同形のオブジェクト＝カスタムテーマ）。
//     未記述＝共有URLの c=<name> で選択（既定 mono＝白地図。台帳は palettes.js）
//   検索・操作説明はオプトインガジェット＝ map.gadget.search() / map.gadget.hint() で画面ごとに追加（v1 ortho-map の作法）
// ============================================================================================
export default async function orthoJapan(opts = {}) {
// 起動の容れ物：target指定（selector/要素）→ 無ければ既存#map → それも無ければbody直下に自作。
// 意匠（quiet-mono）とガジェットは id="map" の家具規格で当たるため、容れ物のidはmapへ正規化する。
// ※ id→クラス化（多重化/二本建）は quiet-mono の #map スコープ移設(→中立クラス)とセットでないと
//   容れ物が無スタイル＝0サイズ化して射影が退化する。単独で変えないこと（回帰の轍）。
let mapEl = (typeof opts.target === "string" ? document.querySelector(opts.target) : opts.target)
	|| document.getElementById("map");
const ownMapEl = !mapEl;   // 容れ物を自作した＝destroy で丸ごと消してよい（預かった div は中身だけ空にして返す）
if (ownMapEl) mapEl = document.body.appendChild(document.createElement("div"));
mapEl.id = "map";
// 舞台のcanvas 2層（基図GL＝知性gintも同居/ラベル）も自給＝index.htmlは空のdivだけでよい
// （旧・#gint 別canvas は 1canvas統合で撤去＝gint は render worker の GL パスとして #c に描かれる）
for (const cid of ["c", "labels"]) { const cv = document.createElement("canvas"); cv.id = cid; mapEl.appendChild(cv); }

const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

// 表示項目の固定（opts.layers）：true/false は状態を焼き付けてチップも出さない。未記述だけが客のトグル。
// 旧romajiキー（chimei/chikei/shisetsu）は公開済み共有URL・埋め込みの互換のため読みだけ受ける。
const LEGACY_LAYER_KEYS = { chimei: "place", chikei: "terrain", shisetsu: "facility" };
const normLayerKey = k => LEGACY_LAYER_KEYS[k] || k;
const fixedLayers = {};
if (opts.layers) for (const [k0, v] of Object.entries(opts.layers)) {
	const k = normLayerKey(k0);
	if (!(k in defaultLayerState)) { console.warn(`[layers] 未知のキー "${k0}"（有効: ${Object.keys(defaultLayerState).join(", ")}）`); continue; }
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
const themeName = typeof opts.theme === "string" ? opts.theme
	: themeBootV?.theme || (themeBootV?.layers?.includes("dark") ? "dark" : "mono");   // l=dark＝c=移行前の互換読み
if (typeof opts.theme !== "object" && !MAP_THEMES[themeName]) console.warn(`[theme] 未知のテーマ "${themeName}"＝mono で起動（有効: ${Object.keys(MAP_THEMES).join(", ")}）`);
const theme = typeof opts.theme === "object" ? { ...MAP_THEMES.mono, ...opts.theme }   // カスタム＝mono を土台に部分上書き
	: (MAP_THEMES[themeName] || MAP_THEMES.mono);
const style = theme.style;
mountGadgets(mapEl, { chips: opts.chips, instruments: opts.instruments, fixedLayers });   // UI を #map に生やす＝以降の getElementById が実体を掴めるよう、全lookupの前で
// 非搭載（chips:false / instruments:false）でも配線コードは無改造＝繋ぎ先が無ければ宙のdiv（どこにも描画されない）へ。
const orDetached = el => el || document.createElement("div");
const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = orDetached(document.getElementById("log"));
const EARTH_M = 6371000, TERR_EXAG = 1.0;   // 標高は実スケール（誇張しない＝地形を歪めない）。ラベル・地形・建物で共有

// --- 初見が死なない：起動できない環境・壊れた環境を白画面でなく言葉で受け止める ---
// reload=true で「再読み込み」ボタン付き。fatal は紙色の全面＝地図の世界観のまま静かに伝える。
function fatalOverlay(title, detail, reload) {
	const d = document.createElement("div");
	d.id = "fatal";   // スタイルは style.css（#fatal）。最後に起きる事件＝最後の append＝DOM順で最上面
	d.innerHTML = `<div class="fatal-box">
		<div class="fatal-title">${title}</div>
		<div class="fatal-detail">${detail}</div>
		${reload ? '<button class="fatal-reload" onclick="location.reload()">再読み込み</button>' : ""}</div>`;
	mapEl.appendChild(d);
	return d;
}
// 対応判定：このアプリの土台は WebGL2 ＋ OffscreenCanvas（GL を worker に置く設計）。無い環境では静かに案内して止まる。
{
	const probe = document.createElement("canvas").getContext("webgl2");
	if (!probe || !HTMLCanvasElement.prototype.transferControlToOffscreen) {
		fatalOverlay("この地図はお使いのブラウザでは表示できません",
			"3Dの地球儀を WebGL2 と OffscreenCanvas で描いています。最新の Chrome / Edge / Firefox、または Safari 17 以降でお試しください。");
		throw new Error("unsupported: webgl2 / offscreencanvas");
	}
	probe.getExtension("WEBGL_lose_context")?.loseContext();   // 判定用コンテキストは即返却（スロットを食い潰さない）
}
// 通信断トースト：offline イベント＋タイル連続失敗で表示、回復（online/タイル成功）で消える。地図は粗い下地で生き続ける。
const netEl = document.createElement("div");
netEl.id = "net-toast";   // スタイルは style.css
netEl.textContent = "地図データの取得に失敗しています（通信状態をご確認ください）";
mapEl.appendChild(netEl);
// 縦向き案内：スマホ横向き（coarseポインタ＋低い横長ビューポート）で縦向きを促す。表示制御は CSS メディアクエリのみ
// ＝JSは要素を置くだけ（回転すれば自然に消える）。タップで閉じたら inline display:none がメディアクエリに勝つ＝再表示しない。
const rotEl = document.createElement("div");
rotEl.id = "rotate-toast";   // スタイルと表示条件は components.scss（#rotate-toast）
rotEl.textContent = "端末を縦向きにしてご覧ください（タップで閉じる）";
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

const bg = style.layers.find(L => L.type === "background");
const land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.96, 0.96, 0.95, 1];
// 夜家具：紙(land)が暗ければ下辺の計器・出典を黒硝子へ（quiet-mono #map.ui-dark）。テーマ名でなく輝度で
// 判定＝カスタムテーマ(opts.theme={…})でも正しく転ぶ（style だけ差し替えた黒紙カスタムを取りこぼさない）
if (0.299 * land[0] + 0.587 * land[1] + 0.114 * land[2] < 0.45) mapEl.classList.add("ui-dark");
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
// ?nomd=1 ＝multi_draw（タイルGPU常駐）を切って従来の CPU merge へ強制フォールバック。同一ビルドで A/B 比較する検証ノブ。
const noMultiDraw = /[?&]nomd=1/.test(location.search);
// ?nogint=1 ＝gint（海岸線/知性層）を丸ごと停止＝1canvas統合の負荷・メモリを A/B 比較する検証ノブ（?nomd=1 と同格）。
const noGint = /[?&]nogint=1/.test(location.search);
// ?perf=1 ＝render worker がフレーム内訳（map/gint の CPU ms・フレームEMA・JSヒープ）を2秒毎に console へ出す。
const perfLog = /[?&]perf=1/.test(location.search);
renderWorker.postMessage({ type: "init", canvas: offscreen, labelCanvas: labelOffscreen, elevBase: TERR_EXAG / EARTH_M, terrainExag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com", scenePort: sceneChan.port2, noMultiDraw, perf: perfLog }, [offscreen, labelOffscreen, sceneChan.port2]);
// 薄いプロキシ：有線(関数呼び)を無線(postMessage)に載せ替え。set/draw 統一済なので pipeline/overlay は無改造。
// draw は worker 側で「cam を記録するだけ」に受け、実描画は worker 自前 rAF が最新 cam で回す（worker-driven）。
// 標高アトラス(terrain)も worker 側に住む＝main はもう視野→セル計算・ダウンサンプルを一切やらない。読込インジケータだけ elevPending で受ける。
const renderer = {
	set: (cmd, data, prop) => renderWorker.postMessage({ type: "set", cmd, data, prop }),
	draw: (cam, opts) => renderWorker.postMessage({ type: "draw", cam, opts }),
};
const elevEl = document.createElement("div");
elevEl.id = "elev-toast";   // スタイルは style.css
mapEl.appendChild(elevEl);
// 等高線(真俯瞰の茶線)・測量点標高・地形読込表示は「地形」チップ(layerState.terrain)に統合＝独立トグル無し。
// zoom/tileのデバッグログ(#log)はユーザー向けチップから切り離し常時非表示（必要なら devtools で #log を出す）。
logEl.style.display = "none";
// 起動ウォッチドッグ：最初のフレーム(frame1)が10秒来なければ原因不明でも案内を出す（健全なら1秒未満で来る）。
// glfail=worker内のWebGL2初期化失敗、contextlost=GPUコンテキスト喪失（1回だけ自動リロード→再発なら案内）。
let bootT = setTimeout(() => {
	fatalOverlay("起動に時間がかかっています", "描画が始まりません。再読み込みで直ることがあります。改善しない場合は、ブラウザの設定で「ハードウェアアクセラレーション」が有効かご確認ください。", true);
}, 10000);
// 印刷（平面図）撮影中の抑止フラグ：autoPlateau/settle保存を止める。描画は noTerrain にしない＝
// 標高アトラスは生かす（真俯瞰 pitch0 なので elevScaleEff=0＝地形サーフェス/陰影/変位は自然に消え、
// 等高線(ベクタ)だけが敷かれた厳密な正射平面図になる）。noTerrain にすると等高線もアトラスごと消えるので不可。
let printHold = false;
renderWorker.onmessage = e => {
	const d = e.data;
	// --- gint（知性の層＝render worker に同居）の返信面（action=旧 gint worker と同形） ---
	if (d.action === "identify") {   // ホバー識別＝当たった feature の全 properties を指先 tip へ。外れ(featureId=null)は消す。
		if (!gintHoverTip) return;
		const p = (d.featureId != null && userGint?.pbf) ? userGint.pbf.getFeature(d.featureId)?.properties : null;
		gintHoverTip(p ? Object.entries(p).map(([k, v]) => `${k}: ${v}`) : null);   // 全属性そのまま（融通なし）／null で tip を消す
		return;
	}
	if (d.action === "click") return void console.log("[gint] fid=%s  lng=%s lat=%s", d.featureId, d.lng?.toFixed?.(6), d.lat?.toFixed?.(6));
	if (d.action === "tiers") return;   // gint LOD tier 構築完了の報告（ベンチ用メタ）＝アプリでは使わない
	if (d.type === "snapshot") return snapPart(d.id, "render", d);   // shot 用：基図+ラベルの ImageBitmap
	if (d.type === "dlApplied") return onSceneApplied(d.slot, d.sig);   // multi_draw の ack＝renderer が draw list を適用した瞬間（＝画面に載った）
	if (d.type === "frame1") { clearTimeout(bootT); bootT = null; sessionStorage.removeItem("oj.ctxlost"); return; }   // 初描画成功＝自動リロード回数もリセット
	if (d.type === "glfail") {
		clearTimeout(bootT);
		fatalOverlay("3D描画を開始できませんでした", `WebGL2 の初期化に失敗しました（${d.error}）。ブラウザの「ハードウェアアクセラレーション」が無効になっている可能性があります。`, true);
		return;
	}
	if (d.type === "contextlost") {
		const n = +(sessionStorage.getItem("oj.ctxlost") || 0);
		if (n < 1) { sessionStorage.setItem("oj.ctxlost", String(n + 1)); location.reload(); }   // まず黙って1回だけ立て直す
		else fatalOverlay("GPU の描画が中断されました", "描画コンテキストが失われました（GPUメモリ不足などで起こります）。他のタブやアプリを閉じてから再読み込みしてください。", true);
		return;
	}
	if (d.type !== "elevPending") return;
	const { count, range } = d;
	if (count > 0 && layerState.terrain) { elevEl.style.display = "block"; elevEl.textContent = `⛰ 地形読込中 ${range === 1 ? "R01（秒単位）" : range === 10 ? "R10" : "R90"} … ×${count}`; }
	else elevEl.style.display = "none";
};

let needsDraw = true, readySig = "", lastLabels = [], sceneOrigin = null;
// mainDesired＝「今この視点で載っているべき main の sig」（swapScene が毎回更新。request の dedupe とは独立）。
// base(粗い下地)の退場判定に使う：readySig がこれに追いつく＝穴なしが確定するまで下地を敷いたままにする。
let mainDesired = "";
// ズームアウト時は「古い詳細シーンを縮めて見せ続ける」をしない＝写真タイルなら拡縮で誤魔化せるが、
// ベクタはズーム専用の線幅・密度を焼いているので縮めると質感が浮く。下地(base)に揃えて退場させる。
// mainSceneZoom＝render workerに現在乗っているmainシーンのzoom（mergeのackで確定）。
let mainSceneZoom = -1;
const mergePendingZoom = new Map();   // merge要求sig → 要求時のzoom
const STALE_ZOOMOUT = 0.5;            // これ以上ズームアウトしたら古い詳細を隠す（微小ズームでは点滅させない）
const mainStale = () => mainSceneZoom > cam.zoom + STALE_ZOOMOUT;
let basemapHidden = false;                 // z<BASEMAP_MINZOOM で基図(GSI)を止めてるか（全球ビュー＝海岸線のみ）
const BASEMAP_MINZOOM = 4;                 // これ未満は基図の詳細を描かない（海岸線 gint で十分／main負荷を断つ）
let moving = false, settleT = null;
// 移動中は幾何を再結合しない（タイルのポップ＝チラチラ防止）。停止後に再結合。
// PLATEAU LOD2 データ登録簿：寄ると自動で出す。bbox は自動トリガ用の緩い矩形（実描画は被覆マスクが実フットプリントに沿わせる）。
// 全国 300 市区町村分は scripts/plateau-catalog-build.mjs で datacatalog API から生成＝public/plateau-sets.json を起動時に fetch。
// opts.plateau=false＝建物3D機能ごと停止：カタログ・workerプール・自動ロード・データ管理ガジェットの全部
//（1地区あたり数十〜百MB級の重い機能＝軽い埋め込みが丸ごと切れる口。UIのchips/instrumentsと対になる機能側スイッチ）。
const plateauOn = opts.plateau !== false;
let PLATEAU_SETS = [];
// カタログ到着の合図＝デモの先読み（prefetchPlateauForViews）が待つ。到着時の自動ロードは従来どおり。
const plateauCatalogReady = !plateauOn ? Promise.resolve() :
	fetch(import.meta.env.BASE_URL + "plateau-sets.json").then(r => r.json()).then(sets => {   // BASE_URL＝サブパス配信(/ortho-japan/)対応
		PLATEAU_SETS = sets; console.log(`[plateau] カタログ読込 → ${sets.length} 市区町村`);
		autoPlateau(true);   // 復元ビューが z14+ の街なら起動直後に自動ロード（settled扱い＝起動時の視界は確定している。IDB命中なら即座に街が立つ）
	}).catch(e => console.warn("[plateau] カタログ取得失敗", e));
// 空港マーク台帳：optbv の空港名注記(441)は z11 以上のタイルにしか無い＝低ズームでは
// scripts/airports-build.mjs で全国収穫した静的リスト(86空港)から「マークだけ」を注入する（本家地理院地図Vectorの見え方に合わせる）。
// z11+ はタイル注記が✈＋名称を描くので、静的分は同名をスキップ＝二重表示なし。鉄道チップのON/OFFは filterLabels(441) がそのまま効く。
const AIRPORT_MARK_MAXZ = 12;              // これ未満のズームで静的マークを注入
let airportMarks = [];
fetch(import.meta.env.BASE_URL + "airports.json").then(r => r.json()).then(list => {
	airportMarks = list.map(a => ({ text: a.name, code: 441, anchor: [a.lon, a.lat], size: 10, sort: 2, color: [0.53, 0.53, 0.5, 1], halo: [0.965, 0.965, 0.957, 1], haloW: 1.1, markOnly: true }));
	readySig = ""; mergeReq.main.sig = "";   // 読み込めた時点でラベル再結合（要求記憶も消す＝即出し直し）
}).catch(() => {});
const PLATEAU_AUTO_Z = 14;                 // これ以上寄ると自動ロード（遠景は対象外＝ズームアウトで全解放）
// 低メモリ端末判定：deviceMemory は Chrome系のみ（≤4GB＝スマホ帯）。iOS/iPadOS Safari は非対応だが
// タブ1枚あたり ~1-1.5GB でOSが強制終了（落ちて自動リロード）するため、タッチ端末は一律低メモリ扱い。
// 誤検知側の被害は「同時1区・キャッシュ縮小」だけ＝安全側に倒す。
const LOW_MEM = navigator.deviceMemory ? navigator.deviceMemory <= 4 : navigator.maxTouchPoints > 1;
if (LOW_MEM) console.log("[plateau] 低メモリ端末モード：同時1区・workerキャッシュ1区");
// 同時アクティブ地区数の上限＝GPUメモリを有界にする（密集地区(都心部)1件あたりGPUバッファ~100-140MB）。
// デスクトップは4区（計~0.5GB＝余裕内）＝高チルトで「手前の区＋正面の区」を同時に立てる。
// 4はシェーダの被覆マスクスロット上限（glsl u_plateauMask0..3・renderer MAX_PLATEAU_MASKS）＝これ以上は基図建物を伏せられず二重に立つ。
const PLATEAU_MAX_ACTIVE = LOW_MEM ? 1 : 4;
// マスク無しセット（橋梁等 noMask:true）の同時数＝別枠。被覆マスクのシェーダスロット(4)を使わないので
// 建物4区の構図を奪わずに載る。橋梁データは区あたり数MB〜数十MB＝建物より一桁軽い。
const PLATEAU_EXTRA_ACTIVE = LOW_MEM ? 1 : 4;
// GPU常駐（再訪の再アップロード根絶）：視野から外れた区は「削除」でなく「非表示(plateauVis)」＝VAOをVRAMに残す。
// 再訪は vis:true を送るだけ＝100MB級の slice→transfer→bufferData が丸ごと消える（ズームアウト→戻るがタダに）。
// 本当に削除するのは ①視野中心が区bboxから PLATEAU_FAR_DEG 超離れた時（完全に離れた＝当分戻らない扱い）
// ②常駐上限超過のLRU。低メモリ端末は常駐なし＝従来どおり即削除（タブ強制終了対策を崩さない）。
const PLATEAU_RESIDENT_MAX = LOW_MEM ? 0 : 8;   // 密集区~100-160MB/区 → 8区で~1GB＝普通のPCの余裕内
const PLATEAU_FAR_DEG = 0.5;                    // 本削除の距離閾値（deg≈55km）。都心の区巡り・近郊往復では誰も落ちない
let flying = false;                        // フライト中フラグ＝autoPlateau のゲート（flyTo が立て、着地/中断で下ろす）
const plateauActive = new Map();           // 表示中の地区（renderer で vis=on）：name → set({name,base,bbox})
const plateauResident = new Map();         // GPUにVAOが乗っている地区（表示中＋非表示）：name → set。Map挿入順＝LRU
const plateauLoading = new Set();          // fetch/デコード中の地区名（二重発火防止）
const plateauAutoLoading = new Map();      // autoPlateau 発のロード中地区：name → set。視界確定時の fast/slow レーン切替対象（手動/プレロードは含めない）
const plateauDemoted = new Set();          // slow lane（在庫化）中の地区名。再訪で promote＝fast 復帰
const plateauFailed = new Set();           // 葉0枚/デコード失敗の地区名＝廃止区(浜松西区22133等)の残骸。二度と掴まない（毎onMoveの再挑戦スパムを断つ）
function plateauHide(name) {   // 視野外れ＝非表示（GPU常駐は維持）。常駐対象外（低メモリ端末）はそのまま削除
	if (plateauResident.has(name)) renderer.set("plateauVis", false, name);
	else renderer.set("plateauMesh", null, name);
}
function plateauEvict(name) {  // 本削除＝GPUバッファ解放（遠方離脱/常駐上限超過だけがここへ来る）
	plateauResident.delete(name);
	renderer.set("plateauMesh", null, name);
}
function plateauRetain(name, set) {   // 常駐登録＋LRU touch。上限超過は最古の非表示区から追い出す（表示中/読込中は守る）
	if (!PLATEAU_RESIDENT_MAX) return;
	plateauResident.delete(name); plateauResident.set(name, set);
	while (plateauResident.size > PLATEAU_RESIDENT_MAX) {
		const oldest = [...plateauResident.keys()].find(n => !plateauActive.has(n) && !plateauLoading.has(n));
		if (!oldest) break;
		plateauEvict(oldest);
		console.log("[plateau] 常駐上限→解放", oldest);
	}
}

// PLATEAU worker プール：tileset fetch・Draco解凍・ECEF変換・重複面dedup・RTE・被覆マスク、全部ここでやる（メインスレッドはブロックしない）。
// 密集地区(都心部)1件のデコードは実測40〜50秒かかる重い処理＝worker化しないとその間UIが完全に固まる。
// PLATEAU_MAX_ACTIVE と同数だけ用意＝同時アクティブな2地区が別コアで並行デコードできる。
// メッシュ本体（密集区で~160MB の typed array）は sceneChan と同じく worker→render worker の直結ポートで渡す。
// main 経由で postMessage すると transfer 無しの構造化クローン＝メインスレッドが数百msブロックされるため、main には ok/失敗の ack しか流さない。
const PLATEAU_NW = Math.min(PLATEAU_MAX_ACTIVE, (navigator.hardwareConcurrency || 4) - 1) || 1;
const plateauWorkers = [], plateauPending = new Map();
let plateauReqId = 0;
let plateauCamSent = 0;   // カメラ放送のスロットル（ロード中のみ~4Hz）
for (let i = 0; plateauOn && i < PLATEAU_NW; i++) {   // plateau OFF＝workerを1本も起こさない
	const w = new Worker(new URL("./plateauworker.js", import.meta.url), { type: "module" });
	const meshChan = new MessageChannel();   // この worker → render worker のメッシュ直結パイプ
	w.postMessage({ type: "init", meshPort: meshChan.port1, lowMem: LOW_MEM }, [meshChan.port1]);
	renderWorker.postMessage({ type: "plateauPort", port: meshChan.port2 }, [meshChan.port2]);
	w.onmessage = e => {
		if (e.data.prog) { plateauProg.set(e.data.prog.name, e.data.prog); renderPlateauProg(); return; }   // タイル/走査進捗（ネットワーク経路のみ）
		if (e.data.type === "idbList") { plateauListPending.shift()?.(e.data.items); return; }              // データ管理モーダルの一覧応答
		if (e.data.type === "idbDeleted") { plateauDeletePending.get(e.data.base)?.(e.data.n); plateauDeletePending.delete(e.data.base); return; }
		const p = plateauPending.get(e.data.id); if (!p) return; plateauPending.delete(e.data.id);
		if (p.name) { plateauProg.delete(p.name); renderPlateauProg(); }   // 完了/失敗どちらでも ack で消灯＝消し忘れが無い
		if (e.data.error) p.reject(new Error(e.data.error));
		else p.resolve(e.data.ok);   // ok=false は0三角形など soft failure（worker側でconsole.error済み）。メッシュ本体は直結ポートで render worker へ送付済み
	};
	plateauWorkers.push(w);
}
// base URL のハッシュで固定の worker へルーティング＝同じ地区は毎回同じ worker が受ける→worker内蔵cacheが再訪で効く。
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; }
// デバッグ用：PLATEAUのメモリ/IDBキャッシュ全消去（デコード形式が壊れた疑いがある時に）。通常はFMT_VERが自動無効化する。
window.__plateauPurge = () => {
	plateauWorkers.forEach(w => w.postMessage({ type: "purge" }));
	for (const n of [...plateauResident.keys()]) if (!plateauActive.has(n)) plateauEvict(n);   // GPU常駐も非表示分は解放（表示中は残す）
};
function workerLoadPlateau(base, tiles, name, wardBbox, brid) {
	const id = ++plateauReqId, w = plateauWorkers[hashStr(base) % PLATEAU_NW];
	// wardBbox＝区単位の被覆マスク座標系。camCenter＝バッチのカメラ近傍優先ソート（目の前から立ち始める）。
	// brid＝橋梁モード：バッチ接地（桁が海面へ沈まない）＋両面描画（ケーブル等の開いた薄面が裏から消えない）。
	w.postMessage({ id, base, tiles, name, wardBbox, brid: !!brid, camCenter: [cam.center[0], cam.center[1]] });
	return new Promise((resolve, reject) => plateauPending.set(id, { resolve, reject, name }));   // name＝進捗の消灯キー
}
// PLATEAU 読込進捗（左下）：地区別のバッチ進捗を1行に集計。ネットワーク経路（初回訪問）だけ表示され、
// メモリ/IDBキャッシュ命中時は一瞬で終わるので出ない。消灯は ack（完了/失敗）で行う。
const plateauEl = document.createElement("div");
plateauEl.id = "plateau-toast";   // スタイルは style.css
mapEl.appendChild(plateauEl);
const plateauProg = new Map();   // name → { scan } | { done, total }（scan＝カタログ走査中の枚数）
function renderPlateauProg() {
	if (!plateauProg.size) plateauEl.style.display = "none";
	else {
		plateauEl.textContent = "🏙 建物3D 読込中 " + [...plateauProg.values()]
			.map(p => p.total ? `${p.name} ${p.done}/${p.total}枚` : `${p.name} カタログ走査 ${p.scan ?? 0}…`).join("・");
		plateauEl.style.display = "block";
	}
	plateauDb.onProg(plateauProg);   // データ管理モーダルにも同じ進捗を流す（開いていなければ即return）
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
async function prefetchPlateauForViews(views) {
	if (!plateauOn) return;
	await plateauCatalogReady;
	if (!PLATEAU_SETS.length) return;
	const MARGIN = 0.012;   // 区bboxへの点距離ゲート（≈1.3km）＝着地視界＋隣接区まで拾う
	const wanted = [], seen = new Set();
	for (const hash of views) {
		const v = typeof hash === "string" ? parseViewHash(hash) : null;
		if (!v || v.zoom < PLATEAU_AUTO_Z) continue;
		const p = [wrapLon(v.lon), v.lat];
		const pd2 = s => { const dx = Math.max(s.bbox[0] - p[0], 0, p[0] - s.bbox[2]), dy = Math.max(s.bbox[1] - p[1], 0, p[1] - s.bbox[3]); return dx * dx + dy * dy; };
		const near = PLATEAU_SETS.filter(s => !plateauFailed.has(s.name) && pd2(s) < MARGIN * MARGIN).sort((a, b) => pd2(a) - pd2(b));
		// 建物枠＋橋梁(noMask)別枠＝autoPlateau の選抜と同じ構成＝着地時に立つ区を過不足なく仕込む
		near.filter(s => !s.noMask).slice(0, PLATEAU_MAX_ACTIVE).concat(near.filter(s => s.noMask).slice(0, PLATEAU_EXTRA_ACTIVE))
			.forEach(s => { if (!seen.has(s.name)) { seen.add(s.name); wanted.push(s); } });
	}
	if (!wanted.length) return;
	console.log(`[demo] PLATEAU先読み ${wanted.length}区（台本から導出）: ${wanted.map(s => s.name).join("・")}`);
	for (const s of wanted) {
		await plateauPreload(s);   // 直列＝静かに。到着済みの区は autoPlateau がIDB直読みで立てる
		autoPlateau(true);   // 先読み完了の瞬間に表示判定を一突き＝「先読み中にもう着いていた」際、静止したままでも即立つ（読込中ガードで見送られた分の敗者復活）
	}
}
function plateauPreload(set) {   // プレロード＝IDBに貯めるだけ（描画へ送らない）。表示中/読込中の地区はそのまま成功扱い
	if (plateauLoading.has(set.name) || plateauActive.has(set.name)) return Promise.resolve(true);
	plateauLoading.add(set.name);
	const id = ++plateauReqId, w = plateauWorkers[hashStr(set.base) % PLATEAU_NW];
	w.postMessage({ id, base: set.base, name: set.name, wardBbox: set.noMask ? null : set.bbox, brid: !!set.noMask, camCenter: [cam.center[0], cam.center[1]], preload: true });
	return new Promise((resolve, reject) => plateauPending.set(id, { resolve, reject, name: set.name }))
		.catch(() => false).finally(() => plateauLoading.delete(set.name));
}
const plateauDb = createPlateauDb({
	getSets: () => PLATEAU_SETS, idbList: plateauIdbList, idbDelete: plateauIdbDelete, preload: plateauPreload,
	// 描画＝モーダルを閉じて地区中心へ球面フライト（z14.5=PLATEAU自動ロード圏・チルト45°）→ autoPlateau がキャッシュ命中で即表示
	show: set => { plateauDb.close(); flyTo((set.bbox[0] + set.bbox[2]) / 2, (set.bbox[1] + set.bbox[3]) / 2, 14.5, 45); },
});
// モーダルを開くボタンはオプトインガジェット（gadgets/plateau.js）＝末尾の map.gadget("plateau", …) で open を注入。
// ストレージの永続化を要求＝ディスク逼迫時にブラウザ都合でオリジンごと退避されるのを防ぐ（デモ機の仕込み保護）。
// persist() は window 限定 API。Chrome はエンゲージメント次第で無言許可、拒否でも動作は変わらない。
if (plateauOn) navigator.storage?.persist?.().then(ok => console.log(`[plateau] storage persist: ${ok ? "許可" : "不許可"}`)).catch(() => {});

// 現在の画面に映る範囲をラフに見積もる（フラスタム厳密解ではなく自動ロードのゲート用）。z14+の寄った状態でしか呼ばれない＝視野は元々狭く、この近似で十分。
function approxViewBbox(cam) {
	// z＝正射スケール（緯度フリー）に伴い cos(lat) を撤去。係数は従来の東京相当(cos35°≈0.819)を固定＝
	// PLATEAU区選抜のゲート挙動を全国で従来の東京と同じに（緩めのbboxで拾い、最終判定は点距離が裁く）。
	const metersPerPx = 156543.03392 * 0.819 / Math.pow(2, cam.zoom);
	const halfM = Math.max(size.w, size.h) / dpr * 0.75 * metersPerPx;   // 対角余裕込みの半幅
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
function autoPlateau(settled = false) {
	if (!plateauOn) return;   // 機能ごと停止（opts.plateau=false）
	if (flying) return;   // フライト中は読み込みも解放もしない＝デコード/GPU転送が飛行アニメと帯域を取り合わない。着地の onMove で解禁
	if (printHold) return;   // 印刷（平面図）撮影中＝印刷カメラで自動ロード/解放をしない（帯域と現ロード状態を乱さない）
	// 「完全に離れた」常駐区の本削除：区bboxへの点距離が閾値超。ズームアウトだけでは落とさない＝同じ街への戻りはタダのまま。
	for (const [name, s] of plateauResident) {
		if (plateauActive.has(name) || plateauLoading.has(name)) continue;
		const dx = Math.max(s.bbox[0] - cam.center[0], 0, cam.center[0] - s.bbox[2]);
		const dy = Math.max(s.bbox[1] - cam.center[1], 0, cam.center[1] - s.bbox[3]);
		if (dx * dx + dy * dy > PLATEAU_FAR_DEG * PLATEAU_FAR_DEG) { plateauEvict(name); console.log("[plateau] 遠方→常駐解除", name); }
	}
	// 視界確定時のレーン切替：欲しい集合(wanted)に居ない自動ロードを slow lane（在庫化）へ降格。
	// worker は並行1本＋間隔空けへ縮退し送信も保留＝帯域/CPU/クレジットが現地点の fast ロードへ返る。
	// 在庫はそのまま完走して IDB＋非表示常駐に落ちる＝捨てない（通過した区は「さりげない仕込み」になる）。
	const demoteStale = (wanted) => {
		for (const [name, s] of plateauAutoLoading) {
			if (wanted?.has(name) || plateauDemoted.has(name)) continue;
			plateauWorkers[hashStr(s.base) % PLATEAU_NW].postMessage({ type: "demote", base: s.base });
			plateauDemoted.add(name);
			console.log("[plateau] 視界確定・現地点優先→在庫化(slow)", name);
		}
	};
	// ロード中があれば最新カメラを worker 群へ放送（~4Hz）＝バッチ境界の残タイル再ソートで「今見ている側」から立つ。
	if (plateauLoading.size && performance.now() - plateauCamSent > 250) {
		plateauCamSent = performance.now();
		const c = [cam.center[0], cam.center[1]];
		plateauWorkers.forEach(w => w.postMessage({ type: "cam", center: c }));
	}
	// 真俯瞰（pitch<0.02＝show3d と同閾）は平面地図の世界＝建物3Dは描かれない＝PLATEAU を読み込まない
	//（Kenji決定 2026-07-23「平面＋3D」：真俯瞰=筆界/ユーザー層、チルト=地形/建物）。傾けた瞬間の
	// settle で従来どおり自動ロード。常駐（VRAM保持）は触らない＝チルト再開はタダのまま。
	if (cam.zoom < PLATEAU_AUTO_Z || (cam.pitch || 0) < 0.02) {
		if (settled) demoteStale(null);   // ズームアウト/真俯瞰で確定＝表示に急ぎは無い。全ロードを slow で完走させ IDB へ
		for (const name of plateauActive.keys()) { plateauHide(name); console.log("[plateau] 範囲外→非表示", name); }
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
	const hitsAll = PLATEAU_SETS.filter(s => bboxIntersects(s.bbox, view) && !plateauFailed.has(s.name));   // 死んだ地区は候補から除外＝再挑戦しない
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
	const hits = hitsAll.filter(s => !s.noMask).sort(near).slice(0, PLATEAU_MAX_ACTIVE)
		.concat(hitsAll.filter(s => s.noMask).sort(near).slice(0, PLATEAU_EXTRA_ACTIVE));
	const hitNames = new Set(hits.map(h => h.name));
	if (settled) demoteStale(hitNames);   // 視界確定＝現地点の優先度MAX。視界外の在庫ロードは slow へ
	for (const name of [...plateauActive.keys()]) {
		if (hitNames.has(name)) continue;
		plateauActive.delete(name); plateauHide(name); needsDraw = true;
		console.log("[plateau] 範囲外→非表示", name);
	}
	for (const h of hits) {
		if (plateauActive.has(h.name)) continue;
		if (plateauLoading.has(h.name)) {
			if (plateauDemoted.has(h.name)) {   // 在庫化中の区へ戻ってきた→fast 復帰（送信バックログもバッチ境界で追いつく）
				plateauDemoted.delete(h.name);
				plateauWorkers[hashStr(h.base) % PLATEAU_NW].postMessage({ type: "promote", base: h.base });
				console.log("[plateau] 再訪→fast復帰", h.name);
			}
			continue;
		}
		if (plateauResident.has(h.name)) {   // 常駐ヒット＝GPUにVAOが居る→表示フラグを戻すだけ（転送ゼロ・即表示）
			plateauRetain(h.name, h);
			renderer.set("plateauVis", true, h.name);
			plateauActive.set(h.name, h);
			needsDraw = true;
			console.log("[plateau] 常駐ヒット（再アップロードなし）→", h.name);
			continue;
		}
		if (!settled) continue;   // 新規ネットワークロードは「視界が落ち着いた」時だけ発火＝パンで通過した区は読み始めない
		plateauLoading.add(h.name);
		plateauAutoLoading.set(h.name, h);   // 視界確定時のレーン切替対象へ
		console.log("[plateau] 自動ロード →", h.name);
		loadPlateau(h.base, undefined, h.name, h.noMask ? null : h.bbox, h.noMask)   // noMask（橋梁等）＝マスク不参加＋橋梁モード（バッチ接地・両面）
			.then(ok => {
				if (ok === "cancelled") {   // 協調キャンセル＝failed 扱いにしない（戻れば再ロードできる）。部分バッチのGPU残骸を掃除
					plateauEvict(h.name);
					console.log("[plateau] キャンセル完了（部分バッチ解放）", h.name);
					return;
				}
				if (ok === "demoted") {   // slow のまま完走した在庫＝表示せず非表示常駐へ（GPU全量済み・IDB済み）。再訪は常駐ヒットで即
					plateauRetain(h.name, h);
					plateauHide(h.name);   // 低メモリ端末（常駐なし）はここでメッシュ削除＝IDBだけが残る
					console.log("[plateau] 在庫完了→非表示常駐", h.name);
					return;
				}
				if (!ok) { plateauFailed.add(h.name); console.warn("[plateau] 読み込めないためスキップ（廃止区/空データ？）:", h.name); return; }   // 一回だけ警告→以後は候補から除外
				plateauActive.set(h.name, h);
				plateauRetain(h.name, h);
				// ★完了時に既に低ズーム/視野外なら stale＝即非表示（ロード中にズームアウトすると3Dが居残る件を断つ。常駐には残る＝戻ればタダ）。
				if (cam.zoom < PLATEAU_AUTO_Z || !bboxIntersects(h.bbox, approxViewBbox(cam))) {
					plateauActive.delete(h.name); plateauHide(h.name); needsDraw = true;
					console.log("[plateau] ロード完了時に視野外→即非表示", h.name);
				}
			})
			.catch(e => { plateauFailed.add(h.name); console.warn("[plateau] 読み込み失敗のためスキップ:", h.name, e.message || e); })   // 一回だけ
			.finally(() => { plateauLoading.delete(h.name); plateauAutoLoading.delete(h.name); plateauDemoted.delete(h.name); });
	}
}

// --- カメラ地形クランプ（地形とだけ衝突・建物は素通し＝地図系の業界標準。Cesium流の押し上げ） ---
// eye 直下の地表標高+マージンを cam.minEyeAlt（単位球高度）へ供給し、cameraState が eye を放射方向に
// 押し上げる（注視点保持＝実質ピッチが滑らかに浅くなる）。DTM開通(746b48a)で「山に潜れる」条件が
// 生まれたことへの対。サンプラ（getHeight＝座標計器と共用）は非同期＝1フレーム遅れはマージンが吸収。
// 上げ即時・下げローパス＝動的な急変を見せない（fovyスライダー撤回「暴れる」の教訓）。
// 真俯瞰(pitch≈0)は 2D＝地形表示も無い＝クランプ無効（山頂への 2D オーバーズームを妨げない）。
let clampT = 0, clampCur = 0, clampBusy = false;
const CLAMP_MARGIN_M = 40;
function updateCamClamp() {
	if (!getHeight || clampBusy || performance.now() - clampT < 100) return;   // 10Hz で十分（マージンが吸収）
	clampT = performance.now(); clampBusy = true;
	const done = tgt => {
		clampBusy = false;
		clampCur = tgt > clampCur ? tgt : clampCur + (tgt - clampCur) * 0.25;   // 上げ即時／下げ緩やか
		if (clampCur < 1e-9) clampCur = 0;
		const v = clampCur || undefined;
		if (v !== cam.minEyeAlt) {
			cam.minEyeAlt = v; needsDraw = true;
			renderer.draw(cam, { skipBase: false, skipMain: mainStale(), noTerrain: false, terrainGate: !moving });
		}
		if (Math.abs(tgt - clampCur) > 1e-8) requestAnimationFrame(updateCamClamp);   // 収束まで自走（10Hzスロットルが上限）
	};
	if ((cam.pitch || 0) < 0.06) return done(0);
	const st = cameraState(cam, size.w, size.h);
	const len = Math.hypot(st.eye[0], st.eye[1], st.eye[2]);
	const lon = Math.atan2(st.eye[2], st.eye[0]) * 180 / Math.PI;
	const lat = Math.asin(Math.max(-1, Math.min(1, st.eye[1] / len))) * 180 / Math.PI;
	Promise.resolve(getHeight(lon, lat, cam.zoom))
		.then(h => done(Math.max(0, (+h || 0) + CLAMP_MARGIN_M) / EARTH_M))
		.catch(() => done(0));
}

function onMove() {
	cam.center[0] = wrapLon(cam.center[0]);   // パン/回転/フライトの累積を毎移動で正規化＝float32原点相対の前提を守る（階段バグ根治）
	moving = true; needsDraw = true;
	updateCamClamp();                          // カメラ地形クランプ（非同期＝次フレームから効く。マージン40mが遅れを吸収）
	updateGintSlot();                                                                // gint 単一スロットを z=4 で調停（ユーザー層⇄世界海岸線）＋海岸線の遅延ロード
	ensureStars();                                                                    // 星空も同じ流儀＝初めて z<4 に出た瞬間に読む
	autoPlateau();                                                                    // 寄る/離れるで PLATEAU を自動ロード/解放（ガードで実質タダ）
	renderer.draw(cam, { skipBase: false, skipMain: mainStale(), noTerrain: false, terrainGate: false });   // 入力の瞬間に最新camをworkerへ（全球z<4も標高の塗りは描く）。terrainGate:false＝入力中はアトラス再構築を起こさない（停止時に一回だけ）
	// 知性の層(gint)は render worker が frame 末尾に同フレーム同カメラで描く（1canvas統合＝泳ぎ・チルト opacity 手当てとも消滅）。
	clearTimeout(settleT);
	settleT = setTimeout(() => { moving = false; needsDraw = true; renderWorker.postMessage({ type: "gintDrawn" }); autoPlateau(true); if (!printHold) saveView(); }, 150);   // 停止後に identify(picking)＋PLATEAU確定（settled＝ロード発火/レーン切替はこの瞬間だけ）＋ビュー保存（印刷カメラは保存しない）
	schedulePos();   // 座標読み取りもカメラに追随（rAF畳み込み＝タダ同然）
}

// データパイプライン（tile/scene worker）。実装は pipeline.js。
// tiles＝LOD管理（update/labels）、requestMerge＝結合要求（scene worker が結合→render worker へ直行）。
const { tiles, requestMerge, destroy: destroyPipeline } = createPipeline({
	style, tileUrl: TILE_URL, requestDraw: () => { needsDraw = true; }, scenePort: sceneChan.port1, onTile,
	// LOD下限＝z8（sea gate と同じ閾値）：optbv は z8 から海が全面WA（沖合タイル=WA一枚50B級）、z7以下は
	// 「陸=AdmArea・海=背景」モデルでWA無し＝チルトの遠景（z5-7混在）だけ海が紙色に抜けてまだらになる。
	// 遠景も z8 以上で敷けば海色がズーム段間で揃う（根治）。z<8 のビューは従来どおり紙の海＋gint海岸線。
	lodFloor: { minViewZoom: 8, z: 8 },
	// 低メモリ端末はタイル予算を絞る：multi_draw の常駐プールは tess 予算の約2倍（idx u32化・線分32B化）を
	// GPU に占める＝既定の自動予算(48MB)だと従来比で実質メモリが膨らみ、PLATEAU の百MB級が乗った時に
	// タブごと落ちる（スマホ実機で発生）。24MB でも可視タイル(keep)は余裕で収まり、削るのはパン戻り履歴だけ。
	memBudgetMB: LOW_MEM ? 24 : undefined,
	// merge の ack（fallback＝CPU merge 経路のみ。multi_draw では renderer 適用時の dlApplied が同じ関数を呼ぶ）
	onMerged: (slot, sig) => onSceneApplied(slot, sig),
});
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
	} else if (slot === "base") baseSig = sig;
	needsDraw = true;
}
window.__mergeFail = () => requestMerge.debugFail();   // 次の merge を故意に失敗させ ack 自己修復を実地検証
window.__vtPool = () => requestMerge.stats();          // multi_draw 常駐プールの占有を scene worker の console に出す

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 75 * D2R;   // 山岳ビュー(z<13)は地形が深度で自遮蔽・混成アトラスが地平線までカバー＝高チルトの根拠が揃ったので75°まで開放
const atmo = theme.atmo;            // 大気色 rgb + 強さ（テーマ台帳のノブ＝palettes.js）
const bldColor = theme.bldColor;    // 建物色（テーマ台帳のノブ＝palettes.js）
// cam＝幾何のみ（center/zoom/pitch/bearing/dpr）＝毎フレームの draw payload（将来の worker 境界）。
// 色（clear/land/atmo/bldColor）は静的なので setView で一度きりアップロード＝hot path から追い出す。
const JAPAN_VIEW = [137.628, 37.783, 4.86];   // 列島ビュー（本土四島が一枚・真俯瞰）＝既定起動＆「日本全体」ガジェットの着地点
const cam = { center: [JAPAN_VIEW[0], JAPAN_VIEW[1]], zoom: JAPAN_VIEW[2], pitch: 0, bearing: 0, dpr };   // 既定＝列島ビュー（沖縄・小笠原には悪いが初手の構図優先。初訪問時のみ＝共有URL→前回ビューの順で下で復元）
// --- 共有URL（パーマリンク）：codec は engine（viewurl.js）。ここは起動の優先度と app 固有クランプだけ ---
// 起動の優先度：URLハッシュ > localStorage(前回ビュー) > 既定の世界ビュー。settle 毎に replaceState で
// 書き戻す＝アドレスバーが常に「今この視点の共有URL」（コピーするだけで人に渡る＝発表・拡散の生命線）。
function applyCamView(v) {
	cam.center = [wrapLon(v.lon), Math.max(-90, Math.min(90, v.lat))];
	cam.zoom = Math.max(1, Math.min(20, v.zoom));   // 上限20＝7.5cm/px（正射z＝緯度フリー。精度は原点相対RTEが担保）
	cam.pitch = Math.max(0, Math.min(MAXPITCH, v.pitch || 0));
	cam.bearing = Number.isFinite(v.bearing) ? v.bearing : 0;
}
const bootView = parseViewHash(opts.view || location.hash);
// 前回ビューの復元（ortho-earth 本体と同じ流儀）：settle 毎に localStorage へ保存し、起動時にそこから立ち上がる。
// IDBのPLATEAUキャッシュと合わさると「開いた瞬間に前回の街が数秒で立ち上がる」起動になる。
const CAM_KEY = "ortho-japan.cam";   // 初デプロイ時に -poc を卒業（旧キーの移行対象ユーザーは未だ居ない）
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
// 配色テーマの切替＝現在の視点・チップ（l=）を保ったまま c= を差し替えて reload（style は起動時に worker へ焼き付くため）。
function switchTheme(name) {
	if (name === themeName || !MAP_THEMES[name]) return;
	const on = FREE_LAYER_KEYS.filter(k => layerState[k]);
	if (constelVisible) on.push(SKY_LAYER);
	const changed = constelVisible || FREE_LAYER_KEYS.some(k => layerState[k] !== defaultLayerState[k]);
	const extras = changed ? ["l=" + on.join(".")] : [];
	if (name !== "mono") extras.push("c=" + name);   // mono は既定＝c= を書かない
	location.hash = buildViewHash(cam, extras);
	location.reload();
}
// contourColor/distColor/hypso はテーマの任意ノブ（無指定＝renderer 既定：セピア等高線・遠山ブルー・単色陰影）
renderer.set("view", { clear, land, atmo, bldColor, showN02: false,
	...(theme.contourColor && { contourColor: theme.contourColor }),
	...(theme.distColor && { distColor: theme.distColor }),
	...(theme.hypso && { hypso: theme.hypso }) });   // showN02＝N02交通(新幹線等)の表示。鉄道チップで切替
// 海：水レイヤ(WA)をビュー一律にゲート＝cam.zoom<13 では描かない（＝紙の海・まだら無し）、z13+で一律点火。
renderer.set("sea", { li: style.layers.findIndex(L => L.id === "water"), li2: style.layers.findIndex(L => L.id === "water-hi"), minzoom: 8 });   // li2＝水系点火面も同じ海ゲート
renderer.set("bldFill", { li: style.layers.findIndex(L => L.id === "building") });   // 建物フットプリント塗り＝3D（チルト）時は伏せる（押し出しと二重表現のため）

// --- gint（知性の層）：14条など突合可能なエンティティ。1canvas統合＝render worker の GL コンテキストに
// 同居し、地図フレーム末尾の1パスとして同フレーム同カメラで描かれる（旧・別worker+OffscreenCanvasは撤去）。
// MVT=描画／Gint=知性＝層分担は不変。main からは renderer.set("gint"/"gintStyle"/"gintVis") と
// gintMove/gintClick/gintLeave/gintDrawn メッセージで操る。識別の返信は renderWorker.onmessage（上方）。
// gint 描画スタイル（styleTable/lineWidth）。データ毎に差し替え（null=既定＝14条筆のオレンジ/シアン）。
let gintDrawOpts = null;
// gint 識別の有効/無効。14条筆=true（ホバー/クリックで突合）、世界海岸線=false（装飾＝ホバー不要）。
let gintInteractive = false;
// gint 表示状態（旧 #gint canvas の display 相当）。render() が visibleGintNow() と突き合わせ変更時だけ post。
let gintVisible = true;
// gint スタイルを render worker へ預ける（frame 末尾の gint パスが使う）。データ毎に差し替え。
const sendGintStyle = () => renderer.set("gintStyle", gintDrawOpts);
let gintHoverTip = null;   // ドロップ/14条データのホバー tip 内容 setter（dropFile 搭載時に注入＝未搭載なら tip 無し）
canvas.addEventListener("pointerleave", () => renderWorker.postMessage({ type: "gintLeave" }));
// 14条地図（法務省 登記所備付地図）を球へ。デコード済み pbf を受けて球へ配線する共通処理。
// 「座標値種別=図上測量」は測量手法のタグに過ぎず絶対位置の信頼性とは無相関と判明済み（系変換さえ合っていれば図上測量でも正確）
// →現状はバッジ判定に使わない。任意座標系の混入検知は変換パイプライン側（外れ値bbox比較）でやるべき課題として残す。
// bbox([lonMin,latMin,lonMax,latMax] deg)全体が画面に収まる zoom。正射の中心近傍は px ≈ scale×角(rad)。
// zの定義は camera.js の radPerDevPx＝2π/(2^z·512·dpr)＝512pxタイル規約 → CSS px/rad = 2^z·512/(2π)。
// ※v1 gint の 40.74(=256/(2π)) 規約とは1段ズレる＝ここは必ず camera.js 側の定義に従う。
// 経度側だけ cos(lat) で実角へ。15% マージン。
function fitZoomForBbox(b) {
	const latC = (b[1] + b[3]) / 2;
	const thX = Math.max(1e-9, (b[2] - b[0]) * Math.cos(latC * D2R) * D2R);
	const thY = Math.max(1e-9, (b[3] - b[1]) * D2R);
	const W = mapEl?.clientWidth || innerWidth, H = mapEl?.clientHeight || innerHeight;
	const scale = 0.85 * Math.min(W / thX, H / thY);
	return Math.max(1, Math.min(20, Math.log2(scale / (512 / (2 * Math.PI)))));
}
function applyGintData(pbf, label, moveCamera = true, opts = {}) {
	if (!pbf?.unPackGint) { console.error("[gint] デコード失敗 (%s)", label, pbf); return null; }
	// gint 単一スロットのユーザー層（14条筆/ドロップGISファイル/AI層）＝世界海岸線と相互切替。pbf 保持＝ホバーで getFeature(id).properties を引く。
	// style/minZoom は層の属性としてここに預ける（スロット再適用(applyUserSlot)がズーム跨ぎの度に走るため、外に置くと切替で剥がれる）
	userGint = { g: pbf.unPackGint, label, pbf, style: opts.style ?? null, minZoom: opts.minZoom ?? GINT_SWAP_Z, interactive: opts.interactive !== false };
	// moj 等はデータ全体へ fit（初期は東京駅、moj のデータは離れた区にある）。ドロップは呼び出し側が flyTo で寄る＝moveCamera=false。
	if (moveCamera) { const b = pbf.unPackGint.bbox; if (b && b.length === 4) flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, fitZoomForBbox(b)); }
	gintSlot = null;           // 内容が変わった＝再適用を強制
	updateGintSlot();          // z≥GINT_SWAP_Z ならユーザー層を表示（z<GINT_SWAP_Z は世界海岸線のまま＝世界図の文脈）
	onMove();
	console.log("[gint] %s ロード完了。z≥%d で表示・z<%d は世界海岸線", label, GINT_SWAP_Z, GINT_SWAP_Z);
	return pbf;
}

// moj は geopbf の name 慣習(bucket/GIS/pbf/…)でなく bucket/moj/{code}.pbf に置かれた別棚なので、
// URL を直叩きして buffer を geopbf に食わせる（gint:true で unPackGint 生成）。
window.__moj = async (code = "13118") => {
	const url = `https://api.ortho-earth.com/bucket/moj/${code}.pbf`;
	const res = await fetch(url);
	if (!res.ok) { console.error("[14条] fetch 失敗 %s → HTTP %s", url, res.status); return; }
	let buf = await res.arrayBuffer();
	const head = new Uint8Array(buf, 0, 2);   // bucket は gzip 圧縮で置かれる。name 慣習の load は自動 gunzip するが直叩きは生バイト＝手動で解凍。
	if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
	const pbf = await geopbf(buf, { gint: true, name: `moj/${code}` });
	applyGintData(pbf, code);
};
// 任意の File/URL（例: aigidなど第三者が公共座標系→WGS84まで変換済みのGeoJSON）を直接デコードして球へ。
// bucket 変換パイプラインを経由せず動作検証したい時用。
window.__mojFile = async (fileOrUrl, name = "moj/local") => {
	const pbf = await geopbf(fileOrUrl, { gint: true, name });
	return applyGintData(pbf, name);
};
// 動作確認用ショートカット：public/moj-local/ に置いた aigid変換済みGeoJSONをワンコマンドでロード。
window.__sapporo = async () => {
	const res = await fetch(import.meta.env.BASE_URL + "moj-local/01101-aigid.geojson");   // moj-localはデプロイ除外＝開発専用
	const file = new File([await res.blob()], "01101_aigid.geojson");
	return window.__mojFile(file, "moj/01101_aigid");
};
// 荒川区（任意座標系のみ）を、大字/丁目名でe-Stat小地域に位置合わせしたラバーシート結果でロード。
// 回転はシェイプ推定せず地名の対応だけで平行移動+等方スケール（現地調査の代替ではなく表示用近似）。
window.__arakawaFit = async () => {
	const res = await fetch(import.meta.env.BASE_URL + "moj-local/13118-rubbersheet.geojson");
	const file = new File([await res.blob()], "13118_rubbersheet.geojson");
	return window.__mojFile(file, "moj/13118_rubbersheet");
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
	if (skipped > 0) console.info("[paint] fid=%d件中 %d件は .geojson から欠落（fid整列読みで補正済み）", n, skipped);
	return out;
};
// fid ズレ診断用：指定 fid だけ赤・他は薄灰でテーブル直書き（式評価を迂回＝純粋に fid 空間を見る）。
// 使い方: __paintFid(100) → 赤い筆をクリック → console の [gint] fid=… が 100 なら一致、±k ならズレ量 k。
window.__paintFid = (...fids) => {
	const feats = gintFidFeatures();
	if (!feats) { console.warn("[paintFid] ユーザー層(gint)が未ロード"); return; }
	const n = feats.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) { u32[i * 4] = 0x88888830; u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1; }
	for (const f of fids) if (f >= 0 && f < n) u32[f * 4] = 0xcc0000cc;
	renderer.set("gintPaint", { table: u32, count: n });
	needsDraw = true;
	for (const f of fids) console.log("[paintFid] fid=%d props=%o", f, feats[f]?.properties);
};
// fid → properties（クリックで出た fid の中身を確認する。identify と同じ getFeature 直読み）
window.__paintProps = (fid) => userGint?.pbf?.getFeature(fid)?.properties;
// 重複可視化＝登記データの品質監査プローブ。通常塗りをせず winding 和の異常画素だけを色分け：
//   マゼンタ＝別筆同士の重なり（fid不定） / 橙＝同一筆の多重登記 / シアン＝向き矛盾の重なり（正味0）
// __paintOverlap() で点灯・__paintOverlap(false) か __paint(null) で解除。
window.__paintOverlap = (on = true) => {
	if (!on) { renderer.set("gintPaint", null); needsDraw = true; return; }
	const feats = gintFidFeatures();
	if (!feats) { console.warn("[paintOverlap] ユーザー層(gint)が未ロード"); return; }
	const n = feats.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1;   // 塗り透明・visible（ID経路の起動条件として表は必要）
	renderer.set("gintPaint", { table: u32, count: n, overlap: true });
	needsDraw = true;
	console.log("[paintOverlap] %d筆を監査: マゼンタ=別筆の重なり / 橙=同一筆の多重登記 / シアン=向き矛盾", n);
};
// fid ズレ診断の決定版：偶数fid=赤／奇数fid=青の市松塗り（場所に依らず全面に出る＝見逃し不能）。
// どの筆でもクリック → console の [gint] fid=… の偶奇と色が一致するか：赤=偶数/青=奇数なら一致、逆なら±1ズレ。
window.__paintParity = () => {
	const n = userGint?.pbf?.fmap?.length ?? 0;
	if (!n) { console.warn("[paintParity] ユーザー層(gint)が未ロード＝先に await __sapporo() 等"); return; }
	const u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) {
		u32[i * 4] = (i & 1) ? 0x0044cc90 : 0xcc000090;   // 奇数=青 / 偶数=赤
		u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1;
	}
	renderer.set("gintPaint", { table: u32, count: n });
	needsDraw = true;
	console.log("[paintParity] %d筆へ市松（偶数=赤/奇数=青）を適用。何も色が出ない場合は console の [gint] idFill caps 行を確認", n);
};
// 任意の bucket GeoPBF を gint ユーザー層としてロード（例: __gload('admin_all')＝行政界コロプレスの土台。
// 全国級なので minZoom=2＝ズームアウトしても海岸線に切り替わらない）。
window.__gload = async (name, opts = {}) => {
	const pbf = await geopbf(name, { gint: true }).catch(e => { console.error("[gload]", e); return null; });
	if (!pbf) return null;
	return applyGintData(pbf, name, true, { minZoom: 2, ...opts });
};
// 移動中描画予算のノブ（実測用）。__budget(Infinity)=移動中も常時描画 / __budget()=既定250kへ戻す。
// ?perf=1 の [perf] 行の gpuGint ms を見ながらズーム操作で実測 → 既定値の再裁定に使う。
window.__budget = (n) => {
	gintDrawOpts = { ...(gintDrawOpts || {}), moveBudget: n ?? undefined };
	sendGintStyle(); needsDraw = true;
	console.log("[budget] moveBudget=%s", n ?? "既定(250k)");
};
window.__paint = async (paint, filter = null) => {
	if (!paint) { renderer.set("gintPaint", null); needsDraw = true; return; }
	const feats = gintFidFeatures();   // fid 整列（.geojson は詰めズレするため使わない）
	if (!feats) { console.warn("[paint] ユーザー層(gint)が未ロード（__moj 等で先にロード）"); return; }
	const { buildFidStyle } = await import("ortho-core");
	const { u32, count } = buildFidStyle(paint, feats, { filter, zoom: cam.zoom });
	renderer.set("gintPaint", { table: u32, count });
	needsDraw = true;
	console.log("[paint] %d features へ適用", count);
};
// 世界海岸線（Natural Earth 10m）を球へ。uploader で事前変換済みの GeoPBF を bucket 名慣習
// （GIS/pbf/ne_10m_coastline）から load＝初回も zip レンジ取得→shp デコードを払わない（gunzip 直読み→GintBUF 焼き→IDB）。
// 2回目以降は ETag 一致で IDB 直行。bucket に無い間だけ従来の生 zip 経路（api proxy→shp デコード）へフォールバック。
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
const GINT_SWAP_Z = 6;
let coastGint = null;      // 海岸線の gint ペイロード（初回ロードでキャッシュ＝再取得しない）
let userGint = null;       // ユーザー層 { g, label }（14条/ドロップ）
let gintSlot = null;       // 現在スロットの占有者 "coast" | "user"（null=未確定＝次の update で必ず post）
let coastLoading = false;
function applyCoastSlot() {
	if (!coastGint) return;
	renderer.set("gint", coastGint);
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
	renderer.set("gint", userGint.g);
	gintDrawOpts = userGint.style;           // 層の持参スタイル（AI層=styleTable、null=既定＝14条筆のオレンジ/シアン。海岸線グレーは引きずらない）
	gintInteractive = userGint.interactive;  // 筆/図形/AI層はホバー/クリックで突合
	sendGintStyle(); gintSlot = "user"; needsDraw = true;
}
// ズームでスロットの中身を選ぶ。onMove から毎回呼ばれるが post は変更時だけ＝安い。海岸線は初回のみ遅延取得。
function updateGintSlot() {
	if (noGint) return;   // ?nogint=1＝海岸線ロードもスロット適用もしない（gint パスは空データ＝実質ゼロコスト）
	if (userGint && cam.zoom >= userGint.minZoom) { if (gintSlot !== "user") applyUserSlot(); return; }   // minZoom は層の属性（全国級AI層=2・筆/ドロップ=GINT_SWAP_Z）
	if (coastGint) { if (gintSlot !== "coast") applyCoastSlot(); return; }
	if (cam.zoom < 8 && !coastLoading) loadWorldCoast();   // 海岸線 未取得＝取得後に updateGintSlot が表示
}
// 世界海岸線（Natural Earth 10m）を取得しキャッシュ（表示可否は updateGintSlot が決める）。
async function loadWorldCoast() {
	if (coastLoading || coastGint) return; coastLoading = true;
	console.log("[coast] Natural Earth 10m coastline を読込中（bucket GeoPBF→GintBUF）…");
	let pbf = await geopbf("ne_10m_coastline").catch(e => { console.warn("[coast] bucket load 失敗", e); return null; });
	if (!pbf?.unPackGint) {
		console.warn("[coast] bucket に geopbf 無し → 生 zip へフォールバック（S3→shp デコード）");
		pbf = await geopbf("https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_coastline.zip", { name: "ne_10m_coastline" }).catch(e => { console.error("[coast] geopbf", e); return null; });
	}
	const g = pbf?.unPackGint;
	coastLoading = false;
	if (!g) { console.error("[coast] GintBUF デコード失敗", pbf); return; }
	coastGint = {   // maxZoom:8＝z≤8 で点火＝低ズームの世界図専用（worker が範囲外をカリング）
		arcBuffer: g.arcBuffer, arcMeta: g.arcMeta,
		polyStream: g.polyStream, lineStream: g.lineStream,
		pointBuffer: g.pointBuffer, point: g.point, polyCompBbox: g.polyCompBbox,
		maxZoom: 8,
	};
	updateGintSlot();   // z<4（またはユーザー層なし）なら海岸線を表示
	console.log("[coast] ロード完了。z<%d で自動表示（ユーザー層が無い/低ズーム時）", GINT_SWAP_Z);
}
window.__coast = loadWorldCoast;   // 手動リロード用
// 遅延ロードの門番は updateGintSlot（z<8 で海岸線 未取得なら一度だけ取得）＝z14固定の埋め込みは一生読まない
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
function updatePlanets() {
	const now = new Date();
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
skyAttrEl.textContent = "星図: d3-celestial ／ 海岸線: Natural Earth ／ 標高: GEBCO ／ © 2026 Kenji Yoshida";   // z<4はR90(GEBCO)のみ＝JAXA(R01)は使わない
mapEl.appendChild(skyAttrEl);
const SKY_WD = ["日", "月", "火", "水", "木", "金", "土"];
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
	const pbf = await geopbf("stars.6", { gint: false }).catch(e => { console.warn("[stars] 読込失敗", e); return null; });
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
	console.log(`[stars] ${fs.length}星 ロード完了（z<4で描画・クリックで星座線）`);
}
// 星座線＋星座名＋メシエ天体：クリックでトグル（v1と同じ所作＝三点一組）。初回クリックでロード→表示、以降は表示反転のみ。
// 線は GL（render worker）、名前と記号はラベルcanvas（skyLabels）＝どちらも同じ変換・同じタイミングで出入りする。
let constelState = 0, constelVisible = false, skyLabels = null;   // 0=未読込 1=読込中 2=読込済
async function toggleConstellations() {
	if (constelState === 1) return;
	if (constelState === 2) {
		constelVisible = !constelVisible;
		renderer.set("view", { showConst: constelVisible });
		renderer.set("skyLabels", constelVisible ? skyLabels : null);
		needsDraw = true;
		return;
	}
	constelState = 1;
	await ensureSkyMod();   // 星座名の日本語化(skynames)を使う前に星空モジュールの読込を保証（初回z<4で通常は既済）
	const [cl, ms] = await Promise.all([
		geopbf("constellation_lines", { gint: false }).catch(e => { console.warn("[星座線] 読込失敗", e); return null; }),
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
	renderer.set("view", { showConst: true });
	renderer.set("skyLabels", skyLabels);
	needsDraw = true;
	console.log(`[星座線] ${consts.length}星座＋メシエ${messier.length}天体 ロード完了（クリックでON/OFF）`);
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
	console.log("[N02] 鉄道 geojson 読込中（新幹線抽出）…");
	let rail = await geopbf("N02-25_RailroadSection").catch(e => { console.warn("[N02] bucket load 失敗", e); return null; });
	if (!rail?.geojson?.features?.length) {
		console.warn("[N02] bucket に geopbf 無し → 生 zip へフォールバック");
		rail = await geopbf(`${N02_ZIP}#N02-25_RailroadSection.geojson`).catch(e => { console.warn("[N02] rail 失敗", e); return null; });
	}
	const fc = rail?.geojson;   // GeoPBF の境界は FeatureCollection。.geojson getter＝{type:"FeatureCollection",features,name}
	const feats = fc?.features;
	if (!feats?.length) { console.warn("[N02] 鉄道読込失敗", rail && Object.keys(rail)); n02Loaded = false; return; }
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
	console.log("[N02] 鉄道", feats.length, "→ 新幹線", sn.length, `(ミニ${miniN})`, "| 路線:", [...new Set(sn.map(f => f.properties?.N02_003 || "(ミニ区間)"))].join("、"));
	// 濃緑の実線（鉄道点火#4b9e6aより暗く、高速の青#2f6cadと衝突しない）。半幅0.9＝計1.8px＝高速(低ズーム)と同太
	const SN_GREEN = [0.04, 0.42, 0.25, 0.95];
	const scenes = sn.length ? [buildGeoJSONOverlay(sn, N02_ORIGIN, { lineColor: SN_GREEN, lineWidth: 0.9 })] : [];
	// 路線ラインも基図と同じ z≥BASEMAP_MINZOOM でだけ描く：全球(z<4)は基図オフの「地球ぐるぐる」＝
	// 路線だけが宙に浮くバグになる（minZoom 未設定だと renderer の s.minZoom||0=0 で全ズーム描画）。
	if (scenes.length) scenes[0].minZoom = BASEMAP_MINZOOM;
	// 駅（Station.geojson＝線路沿いの短いポリライン）：新幹線駅だけをビーズ○で。濃緑の玉に紙色の芯を重ねる＝
	// 線シェーダは capsule（丸端）なので、極小セグメント×太い半幅がそのまま駅の玉になる。ミニ新幹線の停車駅は
	// 在来線駅として収録＝路線×駅名の許可リストで拾う（フル新幹線駅は N02_002=1 で正確に取れる）。
	const stn = await geopbf(`${N02_ZIP}#N02-25_Station.geojson`).catch(e => { console.warn("[N02] station 失敗", e); return null; });
	const stFeats = stn?.geojson?.features || [];
	const MINI_STOPS = new Set(["米沢", "高畠", "赤湯", "かみのやま温泉", "山形", "天童", "さくらんぼ東根", "村山", "大石田", "新庄",   // 山形新幹線
		"雫石", "田沢湖", "角館", "大曲", "秋田"]);                                                                                  // 秋田新幹線
	const stSn = stFeats.filter(f => {
		const p = f.properties || {};
		return p.N02_002 == 1 || (/^(田沢湖線|奥羽(本)?線)$/.test(String(p.N02_003)) && MINI_STOPS.has(String(p.N02_005)));
	});
	console.log("[N02] 駅", stFeats.length, "→ 新幹線駅", stSn.length, "／通常駅", stFeats.length - stSn.length);
	// 通常駅（新幹線駅以外の全駅）：駅名注記(422)が出るズームから点灯（minZoom）。鉄道点火と同じ緑の小ぶりビーズ。
	const snStnSet = new Set(stSn);
	const stReg = stFeats.filter(f => !snStnSet.has(f));
	if (stReg.length) {
		const rOuter = buildGeoJSONOverlay(stReg, N02_ORIGIN, { lineColor: [0.294, 0.62, 0.416, 1], lineWidth: 1.8 });      // 玉＝鉄道点火#4b9e6a
		const rCore = buildGeoJSONOverlay(stReg, N02_ORIGIN, { lineColor: [land[0], land[1], land[2], 1], lineWidth: 0.9 });      // 芯（紙色＝style由来＝夜も自動追従）
		rOuter.minZoom = rCore.minZoom = 10.5;   // 駅名の出るタイル(z11)が選ばれ始める頃から
		scenes.push(rOuter, rCore);
	}
	if (stSn.length) {   // 新幹線駅は通常駅の後＝重なったら新幹線ビーズが勝つ
		const sOuter = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: SN_GREEN, lineWidth: 2.4 });                      // 玉（外径）
		const sCore = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: [land[0], land[1], land[2], 1], lineWidth: 1.2 });       // 芯（紙色＝style由来）＝○に見える
		sOuter.minZoom = sCore.minZoom = 6.5;   // 全国ビュー(z〜5)ではビーズ不要＝広域(z6.5+)から。路線の線は z≥4（基図と同ゲート）
		scenes.push(sOuter, sCore);
	}
	renderer.set("n02", scenes);
	needsDraw = true;
	console.log("[N02] 新幹線 描画完了");
}
// デバッグ用カメラジャンプ：__cam(lon, lat, zoom, pitchDeg, bearingDeg)。検証スクリプトやコンソールから任意視点へ。
window.__cam = (lon, lat, zoom = cam.zoom, pitchDeg = cam.pitch * R2D, bearingDeg = cam.bearing * R2D) => {
	cam.center = [lon, lat]; cam.zoom = zoom; cam.pitch = pitchDeg * D2R; cam.bearing = bearingDeg * D2R;
	onMove();
};

// --- PLATEAU LOD2 建物スパイク（A＝loaders.gl）：b3dm を Draco 解凍→ECEF→単位球へ変換→mesh pass で球に立てる ---
// 実体（fetch/デコード/ECEF/RTE/被覆マスク）は全て plateauworker.js（メインスレッドをブロックしないためworker化）。
// 手打ちデモ：地区名(部分一致)かbase URLを指定して読み込み、カメラもそこへ寄せる（自動と違いカメラを動かす）。省略時は登録簿の先頭。
window.__plateau = async (nameOrBase, tiles) => {
	if (!plateauOn) { console.warn("[plateau] opts.plateau=false＝建物3Dは機能ごと停止中"); return; }
	const set = !nameOrBase ? PLATEAU_SETS[0]
		: PLATEAU_SETS.find(s => s.base === nameOrBase || s.name === nameOrBase || s.name.includes(nameOrBase));
	if (!set) { console.error("[plateau] 地区が見つかりません:", nameOrBase, `（登録簿 ${PLATEAU_SETS.length} 件）`); return; }
	// カメラ移動→onMove→autoPlateau が同じ地区を並行ロードしないよう、手動ロードも plateauLoading に登録して同一ガードを通す。
	if (!plateauActive.has(set.name) && !plateauLoading.has(set.name)) {
		if (plateauResident.has(set.name)) {   // 常駐ヒット＝表示フラグを戻すだけ（autoPlateau と同じ経路）
			plateauRetain(set.name, set);
			renderer.set("plateauVis", true, set.name);
			plateauActive.set(set.name, set);
			needsDraw = true;
		} else {
			plateauLoading.add(set.name);
			try {
				const ok = await loadPlateau(set.base, tiles, set.name, set.noMask ? null : set.bbox, set.noMask);
				if (ok === true) { plateauActive.set(set.name, set); plateauRetain(set.name, set); }   // "cancelled"（自動ロード合流の端ケース）を誤って活性化しない
			} finally { plateauLoading.delete(set.name); }
		}
	}
	const [w, s, e, n] = set.bbox;
	cam.center = [(w + e) / 2, (s + n) / 2]; cam.zoom = 15; cam.pitch = 45 * D2R; cam.bearing = 0;   // 地区中心・傾けて建物を見る
	onMove();
	console.log(`[plateau] 完了 → ${set.name} z15 tilt45°。右ドラッグで傾け調整`);
};

// ロード本体（カメラは動かさない）：重い処理は plateauworker.js に丸投げ。メッシュはバッチ単位で worker→render worker
// 直結ポートを流れ逐次表示される（main を通らない。ここに返るのは全バッチ完了の ack だけ）。
// 成功可否 bool＝呼び出し側が plateauActive に加えるかの判断に使う。
async function loadPlateau(base, tiles, name, wardBbox, brid) {
	const ok = await workerLoadPlateau(base, tiles, name, wardBbox, brid);
	if (ok === "cancelled") return ok;   // 視野離脱の協調キャンセル＝呼び出し側（autoPlateau）が残骸掃除する
	if (!ok) return false;
	needsDraw = true;
	console.log("[plateau] 完了", base);
	return true;
}

function resize() {
	const w = mapEl.clientWidth, h = mapEl.clientHeight;
	size.w = Math.round(w * dpr); size.h = Math.round(h * dpr);
	// GL canvas：バッファサイズは worker が持つ（transfer 済）。main は CSS と論理サイズ(size)だけ。
	canvas.style.width = w + "px"; canvas.style.height = h + "px";
	renderWorker.postMessage({ type: "resize", width: size.w, height: size.h });
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
const input = createInput({
	canvas, cam, size, dpr, maxPitch: MAXPITCH, zoomMin: 1, zoomMax: 20, onMove, signal: ac.signal,
	blocked: () => modalOpen(mapEl),   // モーダル表示中は矢印キーで背後の地図を動かさない（文字入力中は input.js が自前で判定）
	onGesture: () => flightCtl.cancel(),
	onClick: (x, y) => {
		if (measureClick) return measureClick(x, y);   // 測距モード＝クリックは頂点追加へ（識別/星座は止める）
		if (cam.zoom < BASEMAP_MINZOOM) return void toggleConstellations().then(saveView);   // 全球ビュー＝クリックで星座線。表示状態は共有URL(l=sky)へ即書き戻す
		overlay.identifyAt(x, y); if (gintInteractive) renderWorker.postMessage({ type: "gintClick", x, y });
	},
	onHover: (x, y) => { if (gintInteractive) renderWorker.postMessage({ type: "gintMove", x, y }); },
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
posEl.innerHTML = "<table><thead><tr><th>経度</th><th>緯度</th><th>標高</th><th>z値</th><th>回転</th><th>傾度</th></tr></thead><tbody><tr><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody></table>";
const posCells = [...posEl.querySelectorAll("td")];   // [経度, 緯度, 標高, z値, 回転, 傾度]（毎フレームはtextContent更新のみ＝DOM再構築しない）
let posMouse = null, posElev = null, posElevId = 0, posElevAt = 0, posRaf = false, getHeight = null;
setAltApiUrl("https://api.ortho-earth.com");
createGetHeight({ apiUrl: "https://api.ortho-earth.com", onend: () => { posElevAt = 0; schedulePos(); } })
	.then(f => { getHeight = f; });
// 距離スケール（真俯瞰=2Dのみ）：ortho-map Accessories draw_scale() と同じ数式・同じ1-2-5系列。
// d256m＝256px当たりの実距離[m]。本家は256px世界の zoom、当アプリは512px世界なので +1 で読み替える。
// 正射図法は画面中心のスケールが緯度に依らない＝cos(lat) 補正無しで本家と同じ（チルト時は不均一になるので消す）。
const scaleEl = orDetached(document.getElementById("scale")), scaleTxt = orDetached(document.getElementById("scale-txt")), scaleBar = orDetached(document.getElementById("scale-bar"));
const comma = s => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function updateScale() {
	if ((cam.pitch || 0) > 0.005) { scaleEl.style.display = "none"; return; }
	const d256m = 2 * 6372000 * Math.PI / Math.pow(2, cam.zoom + 1);
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
const flightCtl = createFlight({ cam, viewW: () => size.w, maxPitch: MAXPITCH, onMove, onFlying: f => { flying = f; } });
const flyTo = flightCtl.flyTo;
window.__fly = flyTo;   // デバッグ/検証用（__cam の飛行版）

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
const themes = createThemes(style);            // 分類（allowlist）は themes.js の純関数（layerState と zoom を引数で受ける）

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
let zoomAtBuild = -1;
// 移動中の詳細再結合の最小間隔（≈8Hz）：パン中は選定が毎フレーム揺れて sig が変わり、フルシーン結合＋
// GPU全アップロードを毎秒~25回やり直していた（チルト75°・z8.46実測）。8Hzでも下地(base)が隙間を敷くので
// 見た目の追従は落ちない。静止時は無条件（settle の鮮度確定を遅らせない）＝間引くのは移動中だけ。
let lastMoveSwapT = 0;
const MOVE_SWAP_MS = 125;
function swapScene(order) {
	const sig = order.map(o => o.key).join("|") + "#" + styleSig + "#z" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0) + (cam.zoom < AIRPORT_MARK_MAXZ && airportMarks.length ? "A" : "");
	mainDesired = sig;
	// 望みのシーンが既に載っている＝この zoom の現行として扱う（zoomAtBuild を追認しないと、微ズーム往復で
	// sig 不変のまま zoomStable が偽に固定され、base が静止中も退場できなくなる）。
	if (sig === readySig) { zoomAtBuild = cam.zoom; return; }
	if (!order.length) return;
	if (!sceneOrigin || Math.abs(sceneOrigin[0] - cam.center[0]) > 0.4 || Math.abs(sceneOrigin[1] - cam.center[1]) > 0.4)
		sceneOrigin = [cam.center[0], cam.center[1]];
	if (!requestWithAck("main", sig, () => {
		mergePendingZoom.set(sig, cam.zoom);   // ackが来たらこのzoomのシーンが乗る（ズームアウト退場判定の基準）
		if (mergePendingZoom.size > 32) mergePendingZoom.clear();   // ack喪失の残骸が溜まらないよう頭打ち
		requestMerge("main", order, sceneOrigin, themes.hiddenLi(layerState, cam.zoom), sig);
	})) return;   // 結合は scene worker（非同期）→ render worker へ直行
	const allLabels = tiles.labels(order);
	if (airportMarks.length && cam.zoom < AIRPORT_MARK_MAXZ) {   // 低ズーム＝静的台帳から空港マークのみ注入（タイル注記441と同名は二重にしない）
		const have = new Set(allLabels.filter(L => L.code === 441).map(L => L.text));
		for (const a of airportMarks) if (!have.has(a.text)) allLabels.push(a);
	}
	const filtered = themes.filterLabels(allLabels, layerState, cam.zoom, layerState.terrain);   // 地形ON＝測量点の標高数値も通す
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
		if (layerState.facility && isFacility(L)) return { ...L, size: L.size * 0.9, color: [...theme.facilityRGB, L.color[3]] };
		// 地形名（3xx帯）は濃い茶＝チップと同色（--qm-accent-terrain #754c24＝等高線の茶の同族）
		if (layerState.terrain && isTerrain(L.code)) return { ...L, color: [...theme.terrainRGB, L.color[3]] };
		return L;
	});
	renderer.set("labels", lastLabels);   // ラベル集合を render worker へ。標高付与(sampleElev)も terrain と一緒に worker 側で行う（同期して描く）
	zoomAtBuild = cam.zoom;   // readySig は ack（onMerged）で確定
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
// チップ操作：状態を反転し、styleSig を更新して即再結合（再取得なし・一瞬）。
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
	const k = b.dataset.k; if (!k) return;   // data-k 無し＝UIトグル（数字など）は別ハンドラ
	layerState[k] = !layerState[k];
	syncChip(b);
	styleSig = JSON.stringify(layerState); readySig = ""; needsDraw = true;
	if (k === "rail") { renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) loadN02(); }   // 鉄道ON＝N02新幹線も表示＋初回fetch
	if (k === "terrain") applyTerrain();   // 地形＝等高線・測量点標高・水系も一緒に点火
	saveView();   // レイヤ状態も共有URLの一部＝即書き戻す
}));
// 起動時の初期同期（共有URL復元＋opts.layersの固定を含む）：チップの見た目と rail/terrain 副作用を layerState に合わせる（既定どおりなら実質 no-op）
document.querySelectorAll(".chip[data-k]").forEach(syncChip);
if (layerState.rail) { renderer.set("view", { showN02: true }); loadN02(); }
renderer.set("view", { showContour: layerState.terrain });

// 操作方法カード（#hint）はオプトインガジェットへ移設＝gadgets/hint.js（6秒の自動表示・×の記憶ごと）。

// ハッシュの手編集・ペーストで視点ジャンプ（replaceState は hashchange を発火しない＝自分の書き戻しとは無干渉）
window.addEventListener("hashchange", () => {
	const v = parseViewHash(location.hash);
	if (!v) return;
	// 配色テーマの切替（c= の出入り）：style は起動時に pipeline/worker へ焼き付いている＝reload で選び直すのが正直
	//（ハッシュは残る＝reload 後に同じ視点・同じチップで配色だけ替わって立ち上がる）。固定(opts.theme)は破れない。
	if (!themeFixed && (v.theme || (v.layers?.includes("dark") ? "dark" : "mono")) !== themeName) { location.reload(); return; }
	applyCamView(v);
	applyViewLayers(v);
	onMove();
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
	applyTerrain();
}
// デモ台本の一行＝共有URLハッシュへ「飛ぶ」（hashchangeのジャンプと違い球面フライトで向かう）。
// ・l= があるシーンだけがチップに触る。無ければ現状維持＝hashchange と同じ意味論
//   （当初「無し＝既定へリセット」にしたら、手動で消した地名が l= 無しシーンのたびに復活する「時たま出現」を生んだ。
//    発表者の手が台本に勝つ＝デモ中も地図は生きたままの哲学。シーンの見た目を固定したい時は明示的に l= を書く）
// ・c= は flyView では無視（style は起動時焼き付け）。デモの配色幕替わりは gadget 側が reload+自動再開で実現（demo.js）
// ・点火は離陸時＝データは飛行中に読まれ、着地には灯って待つ（PLATEAUだけは着地後＝flight ③の流儀）
// ・opts.glide＝近距離滑走（シーン内の動き）：三段振り付けでなく 位置→方位→チルト の時分割で滑る（引き・回り込み・立ち上がり）
// ・opts.jump＝遷移なしの即時反映（カメラ直書き＋l=反映）。デモの pre→view（同座標で l= だけ点ける見せ玉）用
function flyView(hash, { glide = false, jump = false } = {}) {
	const v = typeof hash === "string" ? parseViewHash(hash) : hash;
	if (!v) { console.warn(`[flyView] 解釈できないビュー "${hash}"`); return false; }
	if (v.theme && v.theme !== themeName) console.warn(`[flyView] c=${v.theme} は無視＝配色は起動時焼き付け（デモは現テーマのまま進む）`);
	applyViewLayers(v);
	if (jump) {   // 飛行中なら打ち切ってカメラ直書き＝アニメ無し（pre と view は同座標が前提＝実際に動くのは l= だけ）
		flightCtl.cancel();
		cam.center = [wrapLon(v.lon), v.lat]; cam.zoom = v.zoom;
		cam.pitch = Math.min(MAXPITCH, v.pitch); cam.bearing = shortBearingOf(v.bearing);
		onMove();
		return true;
	}
	(glide ? flightCtl.glideTo : flyTo)(wrapLon(v.lon), v.lat, v.zoom, v.pitch * 180 / Math.PI, v.bearing * 180 / Math.PI);
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
	const gv = gintSlot === "user" ? (cam.pitch || 0) < 0.02 : cam.zoom < 8;
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
	if (cam.zoom < BASEMAP_MINZOOM) {
		if (!basemapHidden) {
			const o = [cam.center[0], cam.center[1]];
			renderer.set("scene", { origin: o, layers: [] }, "main");
			renderer.set("scene", { origin: o, layers: [] }, "base");
			renderer.set("labels", []);
			readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; lastLabels = []; mainSceneZoom = -1; basemapHidden = true;   // 復帰時に再結合させる
		}
		runFrameHooks();
		logEl.textContent = `world  zoom=${cam.zoom.toFixed(1)}  基図オフ・海岸線＋標高の塗り`;
		return;
	}
	basemapHidden = false;
	const { order, coarseOrder, total } = tiles.update(cam, size.w, size.h);
	window.__lastOrder = order;   // デバッグ：現在の選択タイル（コンソール/検証スクリプトから確認）
	window.__tileStats = () => { const s = tiles.stats(); console.log(`[tiles] 常駐 ${s.tiles}枚 / ${(s.bytes/1048576).toFixed(1)}MB（予算 ${(s.budgetBytes/1048576).toFixed(0)}MB, deviceMemory≈${s.deviceMemoryGB}GB, cacheEntries ${s.cacheEntries}）`); return s; };   // コンソールから常駐メモリ確認
	swapBase(coarseOrder);                          // 粗い下地は常に敷く（移動中も）＝先端の空白を無くす
	if (!moving) swapScene(order);   // 静止フレームは毎回＝mainDesired 更新と settle 後の穴埋め merge を最速で
	else if (zoomStable && performance.now() - lastMoveSwapT >= MOVE_SWAP_MS) { lastMoveSwapT = performance.now(); swapScene(order); }
	runFrameHooks();                               // 3D時のみコンパス表示・針を方位／現在地マーカーの追随 等
	logEl.textContent = `tiles=${order.length}/${total}  labels=${lastLabels.length}  zoom=${cam.zoom.toFixed(1)} pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°`;
}

// --- 統合スパイク：geopbf/e-Stat を overlay に描き、クリックで identify（実装は overlay.js）---
const overlay = createOverlay({ renderer, cam, size, dpr, requestDraw: () => { needsDraw = true; } });
window.__loadOverlay = overlay.loadOverlay;   // geopbf 名から（全球等）
window.__loadEstat = overlay.loadEstat;
window.__tokyo = () => overlay.loadEstat(Array.from({ length: 23 }, (_, i) => 13101 + i));   // 東京23区の小地域
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
	clearTimeout(settleT); clearTimeout(bootT); clearInterval(planetTimer); clearInterval(skyClockTimer);
	destroyPipeline();                           // tile/scene worker
	renderWorker.terminate();
	plateauWorkers.forEach(w => w.terminate());
	overlay.destroy();                           // e-Stat worker（createOverlay内で常時起動しているため忘れずに）
	// デバッグ手はこのインスタンスの閉包を掴んだまま＝GCの錨になるので窓から下ろす
	for (const k of ["__plateauPurge", "__moj", "__mojFile", "__sapporo", "__arakawaFit", "__coast", "__cam", "__plateau", "__fly", "__loadOverlay", "__loadEstat", "__tokyo", "__lastOrder"]) delete window[k];
	mapEl.classList.remove("world");             // 全球ビューの家具フェード状態を預かったdivに残さない
	ownMapEl ? mapEl.remove() : mapEl.replaceChildren();
}

// 世界海岸線：初期視点が z<8 ならここで即発火（既定の世界ビュー＝従来どおり最初から描画）。await せず＝基図の起動を妨げない。
updateGintSlot();
ensureStars();   // 初期視点が z<4（復元/共有URL）なら星空も最初から

// 呼び出し側の手綱（視点操作・飛行・描画設定）＋ガジェット登録簿（v1 ortho-map createGadgets の作法の継承）。
// map.gadget(name, func) で登録し map.gadget.name() で画面に追加する。func 内の this＝この map＝
// mapEl/flyTo 等の手綱がそのまま使える。検索・操作説明は標準装備から外した最初のオプトインガジェット。
const map = { cam, flyTo, renderer, mapEl, destroy };
// ガジェット注入用の座標ブリッジ（engine の project/unproject を今の cam/サイズで束ねた手綱）。
// projectLL＝経緯度→画面CSS座標[x,y,front]（front<0＝裏半球・視界外）。unprojectAt＝画面座標→[lon,lat]（球外は null）。
const projectLL = (lon, lat) => { const st = cameraState(cam, size.w, size.h); const [sx, sy, f] = project(st, lon, lat); return [sx / dpr, sy / dpr, f]; };
const unprojectAt = (clientX, clientY) => { const r = canvas.getBoundingClientRect(); const st = cameraState(cam, size.w, size.h); return unproject(st, (clientX - r.left) * dpr, (clientY - r.top) * dpr); };
// makeProjector＝カメラ状態を1回だけ束ねた投影関数を返す（多点を1描画で投影＝測距の大圏分割で状態計算を積まない）。
// unprojectXY＝canvasローカルCSS座標→経緯度（input.onClick が渡す x,y と同座標系）。
const makeProjector = () => { const st = cameraState(cam, size.w, size.h); return (lon, lat) => { const [sx, sy, f] = project(st, lon, lat); return [sx / dpr, sy / dpr, f]; }; };
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
	renderWorker.postMessage({ type: "snapshot", id });
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
map.gadget("plateau", function (opts) {   // 建物3D（PLATEAU）データ管理 … モーダルを開く手綱はここで注入
	if (!plateauOn) { console.warn("[plateau] opts.plateau=false＝機能ごと停止中。ガジェットは搭載しない"); return; }
	return plateauGadget.call(this, { onOpen: plateauDb.open, ...opts });
});
map.gadget("palette", function (opts) {   // 配色テーマ・ピッカー … 現在テーマ(見本から除く)と切替(switchTheme=c=差替+reload)と撮影(見本=今の視点の実写)を注入
	if (themeFixed) { console.warn("[palette] opts.theme 焼き付け中＝c= は破れない。ガジェットは搭載しない"); return; }
	return paletteGadget.call(this, { current: themeName, onPick: switchTheme, requestSnapshot, signal: ac.signal, ...opts });
});
map.gadget("zoom", function (opts) {   // ズーム＋/− … フライト中断・onMove・z範囲はここで注入
	return zoomGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, zoomMin: 1, zoomMax: 20, signal: ac.signal, ...opts });
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
map.gadget("measure", function (opts) {   // 距離・面積の計測 … 投影/逆投影とクリック横取りの手綱を注入し _update を frameHooks へ
	const m = measureGadget.call(this, {
		makeProjector, unprojectXY, signal: ac.signal,
		setClick: fn => { measureClick = fn; }, requestDraw: () => { needsDraw = true; },
		...opts,
	});
	if (m && m._update) { frameHooks.add(m._update); m._update(); }
	return m;
});
map.gadget("shot", function (opts) {   // 画面保存 … worker越しの3層+measure層を合成する requestSnapshot を注入
	return shotGadget.call(this, { requestSnapshot, signal: ac.signal, ...opts });
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
map.gadget("dropFile", function (opts) {   // GISファイルのD&D取り込み … geopbf(File,{gint:true})→applyGintData を loadFile として束ね注入（gint単一スロット＝置き換え）
	gintHoverTip = this.gadget.tip();   // カーソル追従 tip を搭載＝ホバーで当たった feature の properties を指先へ（gint 識別結果を onmessage が流す）
	const loadFile = async file => {
		const pbf = await geopbf(file, { gint: true, name: `drop/${file.name}` }).catch(err => { console.error("[dropFile] geopbf", file.name, err); return null; });
		if (!pbf?.unPackGint) return null;
		// 低ズーム描画が速くなった＝先に現在ビューへ図形を描き（カメラは動かさない）、その後 flyTo で寄る。
		// 瞬間ジャンプ(ポップイン)でなく「図形が現れて→近づく」。着地は真俯瞰(tilt/bearing=0)・北向き＝fit の north-up 前提。
		applyGintData(pbf, file.name, false);   // 先に描画（gint スロットへ set・識別点火・カメラ据え置き）
		const bb = pbf.unPackGint.bbox;
		if (bb && bb.length === 4) {
			const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
			const wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);   // 30%余白（縁ぴったりを避ける）
			// 視野幅[deg]=360*size.w/(512*2^z)（flight の van Wijk 尺と同一）を逆解き＝横/縦の狭い側に合わせる。
			const z = Math.min(Math.log2(360 * size.w / (512 * wDeg)), Math.log2(360 * size.h / (512 * hDeg)));
			flyTo(cx, cy, Math.max(2, Math.min(16, z)), 0);   // 描画後に寄る＝fit へ球面フライト（tilt/bearing=0）
		}
		return pbf;   // gadget が pbf.length（地物数）をトーストに使う
	};
	const clearGint = () => {   // ドロップ図形を消す＝ユーザー層を外し、該当ズームなら世界海岸線へ戻す
		userGint = null; gintSlot = null;
		renderer.set("gint", null);   // 空化（次フレームの地図再描画が残像ごと消す）
		gintInteractive = false; needsDraw = true;
		if (gintHoverTip) gintHoverTip(null);   // 消去＝ホバー tip も消す
		updateGintSlot();                                       // z<4 等で海岸線が該当すれば即戻す
	};
	return dropFileGadget.call(this, { loadFile, clearGint, signal: ac.signal, ...opts });
});
map.gadget("demo", function (opts) {   // デモ（発表の台本再生）… 台本の一行=共有URLハッシュ。flyView（球面フライト）・フライト中判定・PLATEAU先読み・現テーマ名（幕替わり判定）を注入
	return demoGadget.call(this, { flyView, flightActive: () => flightCtl.active, prefetchViews: prefetchPlateauForViews, theme: themeName, signal: ac.signal, ...opts });
});
map.gadget("ai", function (opts) {   // AIと会話して地図に描く（PC専用・画面2分割）… 描画受け口とbboxフィット・消去を注入
	const fitBbox = bb => {   // dropFile と同じ視野幅の逆解き＝fit へ球面フライト（真俯瞰・北向き）
		const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
		const wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);
		const z = Math.min(Math.log2(360 * size.w / (512 * wDeg)), Math.log2(360 * size.h / (512 * hDeg)));
		flyTo(cx, cy, Math.max(2, Math.min(16, z)), 0);
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
		applyGintData(pbf, label, false, { style: { styleTable: st, lineWidth: plan.style.lineWidth }, minZoom: 2 });   // minZoom:2＝全国級の層は世界図の手前まで見せる
		const bb = pbf.unPackGint.bbox;
		return { ok: true, count: pbf.length, bbox: (bb && bb.length === 4) ? bb : null };
	};
	const clearPlan = () => {   // AI層の消去＝overlay と、AIが載せた gint 層だけ（ドロップ/14条層は預からない）
		overlay.clearPlan();
		if (String(userGint?.label).startsWith("ai/")) {
			userGint = null; gintSlot = null;
			renderer.set("gint", null);   // 空化
			gintInteractive = false; needsDraw = true;
			if (gintHoverTip) gintHoverTip(null);
			updateGintSlot();
		}
	};
	return aiGadget.call(this, { runPlan, clearPlan, fitBbox, signal: ac.signal, ...opts });
});
return map;
}
