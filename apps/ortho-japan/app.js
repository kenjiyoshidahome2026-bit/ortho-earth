// ortho-japan PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
// 意匠：quiet-mono（トークン→部品）→ app固有 の順に import＝カスケードの序列そのまま
import "quiet-mono/tokens.scss";
import "quiet-mono/components.scss";
import "./style.scss";
import {
	evalExpr, parseRGBA, cameraState, unproject, buildGeoJSONOverlay,
	createFlight, shortBearingOf, parseViewHash, buildViewHash, wrapLon, createInput,
} from "ortho-core";
import { createGeopbf, geopbf } from "geopbf";
import { createGetHeight, setApiUrl as setAltApiUrl } from "altpbf";
createGeopbf("https://api.ortho-earth.com");   // bucket 基盤（標高と同じ）。読み出しはキー不要
import style from "./style-mono.js";
import { createThemes, defaultLayerState, isFacility, isTerrain, CHOME_MINZOOM, RAILTR_MINZOOM } from "./themes.js";
import { createOverlay } from "./overlay.js";
import { createPipeline } from "ortho-core";   // tile/scene worker のスポーンごとエンジン側
import { createPlateauDb } from "./plateaudb.js";
import { mountGadgets } from "./gadgets/mount.js";
import { search as searchGadget } from "./gadgets/searchbox.js";
import { hint as hintGadget } from "./gadgets/hint.js";
import { compass as compassGadget } from "./gadgets/compass.js";
import { plateau as plateauGadget } from "./gadgets/plateau.js";

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
//   検索・操作説明はオプトインガジェット＝ map.gadget.search() / map.gadget.hint() で画面ごとに追加（v1 ortho-map の作法）
// ============================================================================================
export default async function orthoJapan(opts = {}) {
// 起動の容れ物：target指定（selector/要素）→ 無ければ既存#map → それも無ければbody直下に自作。
// 意匠（quiet-mono）とガジェットは id="map" の家具規格で当たるため、容れ物のidはmapへ正規化する。
let mapEl = (typeof opts.target === "string" ? document.querySelector(opts.target) : opts.target)
	|| document.getElementById("map");
const ownMapEl = !mapEl;   // 容れ物を自作した＝destroy で丸ごと消してよい（預かった div は中身だけ空にして返す）
if (ownMapEl) mapEl = document.body.appendChild(document.createElement("div"));
mapEl.id = "map";
// 舞台のcanvas 3層（基図GL/知性gint/ラベル）も自給＝index.htmlは空のdivだけでよい
for (const cid of ["c", "gint", "labels"]) { const cv = document.createElement("canvas"); cv.id = cid; mapEl.appendChild(cv); }

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
const gintSyncChan = new MessageChannel();   // render worker → gint worker：海岸線を地図フレームに従属（スライド消滅）
renderWorker.postMessage({ type: "init", canvas: offscreen, labelCanvas: labelOffscreen, elevBase: TERR_EXAG / EARTH_M, terrainExag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com", scenePort: sceneChan.port2, gintSyncPort: gintSyncChan.port1 }, [offscreen, labelOffscreen, sceneChan.port2, gintSyncChan.port1]);
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
renderWorker.onmessage = e => {
	const d = e.data;
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
	if (count > 0 && layerState.terrain) { elevEl.style.display = "block"; elevEl.textContent = `⛰ 地形読込中 ${range === 1 ? "R01（秒単位・JAXA）" : range === 10 ? "R10" : "R90"} … ×${count}`; }
	else elevEl.style.display = "none";
};

let needsDraw = true, readySig = "", lastLabels = [], sceneOrigin = null;
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
if (plateauOn) fetch(import.meta.env.BASE_URL + "plateau-sets.json").then(r => r.json()).then(sets => {   // BASE_URL＝サブパス配信(/ortho-japan/)対応
	PLATEAU_SETS = sets; console.log(`[plateau] カタログ読込 → ${sets.length} 市区町村`);
	autoPlateau();   // 復元ビューが z14+ の街なら起動直後に自動ロード（IDBキャッシュ命中なら即座に街が立つ）
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
// 同時アクティブ地区数の上限。区境をまたいだ隣接分だけを想定＝GPUメモリを有界にする（密集地区(都心部)1件あたりGPUバッファ~100-140MB）。
const PLATEAU_MAX_ACTIVE = 2;
let flying = false;                        // フライト中フラグ＝autoPlateau のゲート（flyTo が立て、着地/中断で下ろす）
const plateauActive = new Map();           // 現在レンダラーに乗っている地区：name → set({name,base,bbox})
const plateauLoading = new Set();          // fetch/デコード中の地区名（二重発火防止）
const plateauFailed = new Set();           // 葉0枚/デコード失敗の地区名＝廃止区(浜松西区22133等)の残骸。二度と掴まない（毎onMoveの再挑戦スパムを断つ）

// PLATEAU worker プール：tileset fetch・Draco解凍・ECEF変換・重複面dedup・RTE・被覆マスク、全部ここでやる（メインスレッドはブロックしない）。
// 密集地区(都心部)1件のデコードは実測40〜50秒かかる重い処理＝worker化しないとその間UIが完全に固まる。
// PLATEAU_MAX_ACTIVE と同数だけ用意＝同時アクティブな2地区が別コアで並行デコードできる。
// メッシュ本体（密集区で~160MB の typed array）は sceneChan と同じく worker→render worker の直結ポートで渡す。
// main 経由で postMessage すると transfer 無しの構造化クローン＝メインスレッドが数百msブロックされるため、main には ok/失敗の ack しか流さない。
const PLATEAU_NW = Math.min(PLATEAU_MAX_ACTIVE, (navigator.hardwareConcurrency || 4) - 1) || 1;
const plateauWorkers = [], plateauPending = new Map();
let plateauReqId = 0;
for (let i = 0; plateauOn && i < PLATEAU_NW; i++) {   // plateau OFF＝workerを1本も起こさない
	const w = new Worker(new URL("./plateauworker.js", import.meta.url), { type: "module" });
	const meshChan = new MessageChannel();   // この worker → render worker のメッシュ直結パイプ
	w.postMessage({ type: "init", meshPort: meshChan.port1 }, [meshChan.port1]);
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
window.__plateauPurge = () => plateauWorkers.forEach(w => w.postMessage({ type: "purge" }));
function workerLoadPlateau(base, tiles, name, wardBbox) {
	const id = ++plateauReqId, w = plateauWorkers[hashStr(base) % PLATEAU_NW];
	// wardBbox＝区単位の被覆マスク座標系。camCenter＝バッチのカメラ近傍優先ソート（目の前から立ち始める）。
	w.postMessage({ id, base, tiles, name, wardBbox, camCenter: [cam.center[0], cam.center[1]] });
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
const plateauIdbDelete = base => new Promise(res => { plateauDeletePending.set(base, res); plateauWorkers[hashStr(base) % PLATEAU_NW].postMessage({ type: "idbDelete", base }); });
function plateauPreload(set) {   // プレロード＝IDBに貯めるだけ（描画へ送らない）。表示中/読込中の地区はそのまま成功扱い
	if (plateauLoading.has(set.name) || plateauActive.has(set.name)) return Promise.resolve(true);
	plateauLoading.add(set.name);
	const id = ++plateauReqId, w = plateauWorkers[hashStr(set.base) % PLATEAU_NW];
	w.postMessage({ id, base: set.base, name: set.name, wardBbox: set.bbox, camCenter: [cam.center[0], cam.center[1]], preload: true });
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
function autoPlateau() {
	if (!plateauOn) return;   // 機能ごと停止（opts.plateau=false）
	if (flying) return;   // フライト中は読み込みも解放もしない＝デコード/GPU転送が飛行アニメと帯域を取り合わない。着地の onMove で解禁
	if (cam.zoom < PLATEAU_AUTO_Z) {
		for (const name of plateauActive.keys()) { renderer.set("plateauMesh", null, name); console.log("[plateau] 範囲外→解放", name); }
		if (plateauActive.size) needsDraw = true;
		plateauActive.clear();
		return;
	}
	const view = approxViewBbox(cam);
	let hits = PLATEAU_SETS.filter(s => bboxIntersects(s.bbox, view) && !plateauFailed.has(s.name));   // 死んだ地区は候補から除外＝再挑戦しない
	if (hits.length > PLATEAU_MAX_ACTIVE) {
		const [lon, lat] = cam.center;
		// 近さ＝「bboxまでの点距離」（bbox内なら0）。重心距離だと南北に長い区（江東=臨海部で重心が南へ~4km）が
		// 足元に居ても落選し、チルト北向きの構図で手前だけ基図の間引き建物になる。同点（bbox重複）は重心距離で順序付け。
		const d2 = s => { const dx = Math.max(s.bbox[0] - lon, 0, lon - s.bbox[2]), dy = Math.max(s.bbox[1] - lat, 0, lat - s.bbox[3]); return dx * dx + dy * dy; };
		const c2 = s => { const cx = (s.bbox[0] + s.bbox[2]) / 2, cy = (s.bbox[1] + s.bbox[3]) / 2; return (cx - lon) ** 2 + (cy - lat) ** 2; };
		hits = hits.sort((a, b) => (d2(a) - d2(b)) || (c2(a) - c2(b))).slice(0, PLATEAU_MAX_ACTIVE);   // 近い順に上限件数だけ採用
	}
	const hitNames = new Set(hits.map(h => h.name));
	for (const name of [...plateauActive.keys()]) {
		if (hitNames.has(name)) continue;
		plateauActive.delete(name); renderer.set("plateauMesh", null, name); needsDraw = true;
		console.log("[plateau] 範囲外→解放", name);
	}
	for (const h of hits) {
		if (plateauActive.has(h.name) || plateauLoading.has(h.name)) continue;
		plateauLoading.add(h.name);
		console.log("[plateau] 自動ロード →", h.name);
		loadPlateau(h.base, undefined, h.name, h.bbox)
			.then(ok => {
				if (!ok) { plateauFailed.add(h.name); console.warn("[plateau] 読み込めないためスキップ（廃止区/空データ？）:", h.name); return; }   // 一回だけ警告→以後は候補から除外
				plateauActive.set(h.name, h);
				// ★完了時に既に低ズーム/視野外なら stale＝即解放（ロード中にズームアウトすると3Dが居残る件を断つ）。
				if (cam.zoom < PLATEAU_AUTO_Z || !bboxIntersects(h.bbox, approxViewBbox(cam))) {
					plateauActive.delete(h.name); renderer.set("plateauMesh", null, h.name); needsDraw = true;
					console.log("[plateau] ロード完了時に視野外→即解放", h.name);
				}
			})
			.catch(e => { plateauFailed.add(h.name); console.warn("[plateau] 読み込み失敗のためスキップ:", h.name, e.message || e); })   // 一回だけ
			.finally(() => plateauLoading.delete(h.name));
	}
}

function onMove() {
	cam.center[0] = wrapLon(cam.center[0]);   // パン/回転/フライトの累積を毎移動で正規化＝float32原点相対の前提を守る（階段バグ根治）
	moving = true; needsDraw = true;
	ensureCoast();                                                                    // 世界海岸線は初めて z<8 に出た瞬間に読む（遅延ロード）
	autoPlateau();                                                                    // 寄る/離れるで PLATEAU を自動ロード/解放（ガードで実質タダ）
	renderer.draw(cam, { skipBase: false, skipMain: mainStale(), noTerrain: cam.zoom < BASEMAP_MINZOOM });   // 入力の瞬間に最新camをworkerへ（全球=z<4は地形オフ＝白い地球＋海岸線のみ）
	// 海岸線(gint)は render worker が draw 後に従属で駆動＝ここから直接送らない（地図と同cam/同フレーム＝スライド消滅）。
	clearTimeout(settleT);
	settleT = setTimeout(() => { moving = false; needsDraw = true; gintWorker.postMessage({ type: "drawn" }); saveView(); }, 150);   // 停止後に identify(picking)＋ビュー保存（localStorage＋共有URL）
	schedulePos();   // 座標読み取りもカメラに追随（rAF畳み込み＝タダ同然）
}

// データパイプライン（tile/scene worker）。実装は pipeline.js。
// tiles＝LOD管理（update/labels）、requestMerge＝結合要求（scene worker が結合→render worker へ直行）。
const { tiles, requestMerge, destroy: destroyPipeline } = createPipeline({
	style, tileUrl: TILE_URL, requestDraw: () => { needsDraw = true; }, scenePort: sceneChan.port1, onTile,
	// merge の ack：sig はここで初めて確定する（要求時の楽観確定をやめた＝失敗が永続穴にならない）
	onMerged: (slot, sig) => {
		if (slot === "main") {
			readySig = sig;
			const z = mergePendingZoom.get(sig);
			if (z != null) { mainSceneZoom = z; mergePendingZoom.delete(sig); }
		} else if (slot === "base") baseSig = sig;
		needsDraw = true;
	},
});

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 75 * D2R;   // 山岳ビュー(z<13)は地形が深度で自遮蔽・混成アトラスが地平線までカバー＝高チルトの根拠が揃ったので75°まで開放
const atmo = [0.5, 0.66, 0.96, 0.3];   // 大気色 rgb + 強さ（さりげなく）
const bldColor = [0.83, 0.83, 0.82];    // 建物色（静かなグレー）
// cam＝幾何のみ（center/zoom/pitch/bearing/dpr）＝毎フレームの draw payload（将来の worker 境界）。
// 色（clear/land/atmo/bldColor）は静的なので setView で一度きりアップロード＝hot path から追い出す。
const cam = { center: [137.628, 37.783], zoom: 4.86, pitch: 0, bearing: 0, dpr };   // 既定＝列島ビュー（本土四島が一枚。沖縄・小笠原には悪いが初手の構図優先。初訪問時のみ＝共有URL→前回ビューの順で下で復元）
// --- 共有URL（パーマリンク）：codec は engine（viewurl.js）。ここは起動の優先度と app 固有クランプだけ ---
// 起動の優先度：URLハッシュ > localStorage(前回ビュー) > 既定の世界ビュー。settle 毎に replaceState で
// 書き戻す＝アドレスバーが常に「今この視点の共有URL」（コピーするだけで人に渡る＝発表・拡散の生命線）。
function applyCamView(v) {
	cam.center = [wrapLon(v.lon), Math.max(-85, Math.min(85, v.lat))];
	cam.zoom = Math.max(1, Math.min(19, v.zoom));
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
const viewHash = () => buildViewHash(cam,
	FREE_LAYER_KEYS.some(k => layerState[k] !== defaultLayerState[k])
		? ["l=" + FREE_LAYER_KEYS.filter(k => layerState[k]).join(".")] : []);
const saveView = () => { saveCam(); try { history.replaceState(null, "", viewHash()); } catch { /* file:// 等 */ } };
renderer.set("view", { clear, land, atmo, bldColor, showN02: false });   // showN02＝N02交通(新幹線等)の表示。鉄道チップで切替
// 海：水レイヤ(WA)をビュー一律にゲート＝cam.zoom<13 では描かない（＝紙の海・まだら無し）、z13+で一律点火。
renderer.set("sea", { li: style.layers.findIndex(L => L.id === "water"), li2: style.layers.findIndex(L => L.id === "water-hi"), minzoom: 8 });   // li2＝水系点火面も同じ海ゲート

// --- gint worker（知性の層）：14条など突合可能なエンティティを OffscreenCanvas で別workerに描く。
// MVT=描画(render worker)／Gint=知性(この worker)＝層分担。基図の上に重ね、pointer は透過して #c が受ける。
const gintCanvas = document.getElementById("gint");
gintCanvas.width = size.w; gintCanvas.height = size.h;
const gintOffscreen = gintCanvas.transferControlToOffscreen();
const gintWorker = new Worker(new URL("./gintworker.js", import.meta.url), { type: "module" });
gintWorker.postMessage({ type: "init", offscreen: gintOffscreen, dpr, syncPort: gintSyncChan.port2 }, [gintOffscreen, gintSyncChan.port2]);
// gint 描画スタイル（styleTable/lineWidth）。データ毎に差し替え（null=既定＝14条筆のオレンジ/シアン）。
let gintDrawOpts = null;
// gint 識別の有効/無効。14条筆=true（ホバー/クリックで突合）、世界海岸線=false（装飾＝ホバー不要）。
let gintInteractive = false;
// gint スタイルを worker へ保持させる（従属描画で使う）。データ毎に差し替え。
const sendGintStyle = () => gintWorker.postMessage({ type: "style", data: gintDrawOpts });
gintWorker.onmessage = e => {
	const d = e.data;
	if (d.action === "click")       console.log("[14条] 筆 fid=%s  lng=%s lat=%s", d.featureId, d.lng?.toFixed?.(6), d.lat?.toFixed?.(6));
	else if (d.action === "redraw") { needsDraw = true; gintWorker.postMessage({ type: "drawn" }); }   // context復帰等→地図を1枚描かせ従属で追随
};
canvas.addEventListener("pointerleave", () => gintWorker.postMessage({ type: "leave" }));
// 14条地図（法務省 登記所備付地図）を球へ。デコード済み pbf を受けて球へ配線する共通処理。
// 「座標値種別=図上測量」は測量手法のタグに過ぎず絶対位置の信頼性とは無相関と判明済み（系変換さえ合っていれば図上測量でも正確）
// →現状はバッジ判定に使わない。任意座標系の混入検知は変換パイプライン側（外れ値bbox比較）でやるべき課題として残す。
function applyGintData(pbf, label) {
	if (!pbf?.unPackGint) { console.error("[14条] gint デコード失敗 (%s)", label, pbf); return null; }
	coastArmed = false;       // gint 単一スロットにユーザーデータが載った＝以後の海岸線自動ロードは放棄（clobber防止）
	gintDrawOpts = null;      // 14条筆は既定スタイルへ（海岸線グレーを引きずらない）
	gintInteractive = true;   // 筆はホバー/クリックで突合
	sendGintStyle();          // worker にスタイル(null=既定)を保持させる
	const g = pbf.unPackGint;
	console.log("[14条] %s unPackGint keys:", label, Object.keys(g), "| bbox:", g.bbox, "| polyStream:", g.polyStream?.length, "arcMeta:", g.arcMeta?.length);
	gintWorker.postMessage({ type: "set", cmd: "gint", data: g });
	// 視野をデータへ寄せる＝筆を確実に画面へ（初期は東京駅、moj のデータは離れた区にある）。onMove で基図＋gint 両方が追従。
	if (g.bbox && g.bbox.length === 4) cam.center = [(g.bbox[0] + g.bbox[2]) / 2, (g.bbox[1] + g.bbox[3]) / 2];
	onMove();
	console.log("[14条] %s ロード完了 → 中心 %o へ移動。筆をホバー/クリック", label, cam.center);
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
// 世界海岸線（Natural Earth 10m）を球へ。uploader で事前変換済みの GeoPBF を bucket 名慣習
// （GIS/pbf/ne_10m_coastline）から load＝初回も zip レンジ取得→shp デコードを払わない（gunzip 直読み→GintBUF 焼き→IDB）。
// 2回目以降は ETag 一致で IDB 直行。bucket に無い間だけ従来の生 zip 経路（api proxy→shp デコード）へフォールバック。
// coastline は native な線＝lineStream（styleId=1＝既定 #00B4D8）。fillColor 既定透明＝縁だけ＝「線だけ」。
// maxZoom:7 で z≤7 に点火＝低ズームの世界図専用。
// VW ランクは GintBUF に焼込済＝10m を間引かず全密度で描く（弦が短く球面に吸い付く＝110m の崩壊が起きない）。
// 世界海岸線（Natural Earth 10m）を起動時に自動ロード＝__coast() を叩かず「最初から描画」。
// カメラは動かさない＝ズームアウト（z≤7）した瞬間に海岸線が居る。14条筆と gint 単一スロット共有（相互置換）。
async function loadWorldCoast() {
	console.log("[coast] Natural Earth 10m coastline を読込中（bucket GeoPBF→GintBUF）…");
	let pbf = await geopbf("ne_10m_coastline").catch(e => { console.warn("[coast] bucket load 失敗", e); return null; });
	if (!pbf?.unPackGint) {
		console.warn("[coast] bucket に geopbf 無し → 生 zip へフォールバック（S3→shp デコード）");
		pbf = await geopbf("https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_coastline.zip", { name: "ne_10m_coastline" }).catch(e => { console.error("[coast] geopbf", e); return null; });
	}
	const g = pbf?.unPackGint;
	if (!g) { console.error("[coast] GintBUF デコード失敗", pbf); return; }
	console.log("[coast] unPackGint keys:", Object.keys(g), "| lineStream:", g.lineStream?.length, "| bbox:", g.bbox);
	gintWorker.postMessage({ type: "set", cmd: "gint", data: {
		arcBuffer: g.arcBuffer, arcMeta: g.arcMeta,
		polyStream: g.polyStream, lineStream: g.lineStream,
		pointBuffer: g.pointBuffer, point: g.point, polyCompBbox: g.polyCompBbox,
		maxZoom: 8,
	} });
	// 海岸線＝lineStream＝styleId=1。紙＋淡青の色調に合わせ「薄い青灰グレー・細く」。
	const coastStyle = new Float32Array(256 * 4);
	coastStyle.set([1.0, 0.42, 0.208, 1.0]);          // style0 polygon（未使用）
	coastStyle.set([0.74, 0.77, 0.80, 1.0], 4);       // style1 = 海岸線 = 薄い青灰グレー #bcc4cc（alpha=1.0 のまま色だけ白寄せ）
	gintDrawOpts = { styleTable: coastStyle, lineWidth: 0.75 };
	gintInteractive = false;   // 海岸線は装飾＝ホバー/クリック識別なし
	sendGintStyle();   // worker にスタイルを保持させる（従属描画で使う）
	needsDraw = true;  // 地図を1枚描かせ→render worker が gint へ従属信号→海岸線が出る
	console.log("[coast] ロード完了。z≤7 で自動描画");
}
window.__coast = loadWorldCoast;   // 手動リロード用
// 遅延ロードの門番：初めて z<8（海岸線の見えるズーム）に出た瞬間に一度だけ読む＝z14固定の埋め込みは一生読まない
//（PLATEAUスイッチと同じ思想＝見えない機能のための通信をしない。既定の世界ビュー起動は直下の ensureCoast が即発火＝体験は不変）。
let coastArmed = true;
function ensureCoast() { if (coastArmed && cam.zoom < 8) { coastArmed = false; loadWorldCoast(); } }

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
	console.log("[N02] geopbf 返り:", rail && (rail.constructor?.name), "| keys:", rail && Object.keys(rail).slice(0, 12));
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
		const rCore = buildGeoJSONOverlay(stReg, N02_ORIGIN, { lineColor: [0.965, 0.965, 0.957, 1], lineWidth: 0.9 });      // 芯（紙色）
		rOuter.minZoom = rCore.minZoom = 10.5;   // 駅名の出るタイル(z11)が選ばれ始める頃から
		scenes.push(rOuter, rCore);
	}
	if (stSn.length) {   // 新幹線駅は通常駅の後＝重なったら新幹線ビーズが勝つ
		const sOuter = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: SN_GREEN, lineWidth: 2.4 });                      // 玉（外径）
		const sCore = buildGeoJSONOverlay(stSn, N02_ORIGIN, { lineColor: [0.965, 0.965, 0.957, 1], lineWidth: 1.2 });       // 芯（紙色）＝○に見える
		sOuter.minZoom = sCore.minZoom = 6.5;   // 全国ビュー(z〜5)ではビーズ不要＝広域(z6.5+)から。路線の線は全ズームのまま
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
		plateauLoading.add(set.name);
		try {
			const ok = await loadPlateau(set.base, tiles, set.name, set.bbox);
			if (ok) plateauActive.set(set.name, set);
		} finally { plateauLoading.delete(set.name); }
	}
	const [w, s, e, n] = set.bbox;
	cam.center = [(w + e) / 2, (s + n) / 2]; cam.zoom = 15; cam.pitch = 45 * D2R; cam.bearing = 0;   // 地区中心・傾けて建物を見る
	onMove();
	console.log(`[plateau] 完了 → ${set.name} z15 tilt45°。右ドラッグで傾け調整`);
};

// ロード本体（カメラは動かさない）：重い処理は plateauworker.js に丸投げ。メッシュはバッチ単位で worker→render worker
// 直結ポートを流れ逐次表示される（main を通らない。ここに返るのは全バッチ完了の ack だけ）。
// 成功可否 bool＝呼び出し側が plateauActive に加えるかの判断に使う。
async function loadPlateau(base, tiles, name, wardBbox) {
	const ok = await workerLoadPlateau(base, tiles, name, wardBbox);
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
	gintCanvas.style.width = w + "px"; gintCanvas.style.height = h + "px";
	gintWorker.postMessage({ type: "resize", width: size.w, height: size.h });
	needsDraw = true;
}
const ro = new ResizeObserver(resize);   // destroy で disconnect するため手綱を持つ
ro.observe(mapEl);   // #map のサイズ変化に追随（ウィンドウでも埋め込み先のレイアウトでも同じ経路）

resize();

// --- 操作：左ドラッグ=パン / 右(or Shift/Ctrl)ドラッグ=チルト+方位 / ホイール=ズーム ---
// --- 入力（パン/チルト/ホイール/アンカー）：実装は engine（input.js＝grab+レート併走・縁縮退対策の結晶）。
// ここは日本アプリ固有の反応だけ注入：クリック→identify（基図overlay＋知性gint）、ホバー→gintの筆識別、
// ジェスチャ開始→フライト中断（主導権は常に人）。z範囲＝1(宇宙の余白)〜19(z20はタイルの切れ目が目立つ)。
const input = createInput({
	canvas, cam, size, dpr, maxPitch: MAXPITCH, zoomMin: 1, zoomMax: 19, onMove,
	onGesture: () => flightCtl.cancel(),
	onClick: (x, y) => { overlay.identifyAt(x, y); if (gintInteractive) gintWorker.postMessage({ type: "click", x, y }); },
	onHover: (x, y) => { if (gintInteractive) gintWorker.postMessage({ type: "move", x, y }); },
});
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
function swapScene(order) {
	const sig = order.map(o => o.key).join("|") + "#" + styleSig + "#z" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0) + (cam.zoom < AIRPORT_MARK_MAXZ && airportMarks.length ? "A" : "");
	if (sig === readySig || !order.length) return;
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
		// 施設は濃い紫＝チップと同色（--qm-accent-facility #6a3d9a。点火の掟：チップ色＝地図上の色）。名前は一回り小さく＝地名の脇役
		if (layerState.facility && isFacility(L)) return { ...L, size: L.size * 0.9, color: [0.416, 0.239, 0.604, L.color[3]] };
		// 地形名（3xx帯）は濃い茶＝チップと同色（--qm-accent-terrain #754c24＝等高線の茶の同族）
		if (layerState.terrain && isTerrain(L.code)) return { ...L, color: [0.459, 0.298, 0.141, L.color[3]] };
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
	renderer.draw(cam, { skipBase: false, noTerrain: cam.zoom < BASEMAP_MINZOOM, terrainGate: true });
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
	applyCamView(v);
	if (v.layers || v.contour) {
		// 固定キー(opts.layers)はハッシュ手編集でも破れない＝客が触れるキーだけ反映（旧romajiトークンは読み替え）
		if (v.layers) { const urlSet = new Set(v.layers.map(normLayerKey)); for (const k of FREE_LAYER_KEYS) layerState[k] = urlSet.has(k); }
		if (v.contour && !("terrain" in fixedLayers)) layerState.terrain = true;   // 旧URLの c＝地形チップに読み替え（後方互換）
		document.querySelectorAll(".chip[data-k]").forEach(syncChip);
		styleSig = JSON.stringify(layerState); readySig = "";
		renderer.set("view", { showN02: layerState.rail }); if (layerState.rail) loadN02();
		applyTerrain();
	}
	onMove();
}, { signal: ac.signal });

// コンパス兼リセット（#reset）はオプトインガジェットへ移設＝gadgets/compass.js（針の追従・リセットアニメごと）。
// 針の毎フレーム追従は render が呼ぶフック＝搭載時に差し替わる（未搭載なら no-op）。
let updateCompass = () => {};
const shortBearing = () => shortBearingOf(cam.bearing);   // 最短回転へ正規化（実装はengine）＝計器盤の回転列と共用

function render() {
	// パン/チルト中（ズーム不変）は詳細も再結合。ズーム中はLODポップ回避で停止まで待つ。
	const zoomStable = Math.abs(cam.zoom - zoomAtBuild) < 0.12;
	// 地形アトラスもズーム中は再構築しない：cellRes/セル数が連続変化して全再ロード＆勾配密度の跳びで
	// 陰影がチラつくため（terrainGate＝render worker 側の terrain.ensure() 呼び出しを止める合図）。
	// ズーム中は現アトラスを再投影（球面メッシュなので拡縮は追従）、停止後に再構築。
	renderer.draw(cam, { skipBase: !moving, skipMain: mainStale(), noTerrain: cam.zoom < BASEMAP_MINZOOM, terrainGate: !moving || zoomStable });     // 先に最新camをworkerへ（全球=z<4は地形オフ）。海岸線は render worker が従属で追随
	// 全球ビュー（z<4）：基図(GSI)の詳細は不要＝タイル/結合/地形を止め、基図シーンを空に＝海岸線(gint)だけの軽い地球。
	// これで pan 中も main の毎フレーム負荷（tiles.update/merge/terrain）が消える。
	if (cam.zoom < BASEMAP_MINZOOM) {
		if (!basemapHidden) {
			const o = [cam.center[0], cam.center[1]];
			renderer.set("scene", { origin: o, layers: [] }, "main");
			renderer.set("scene", { origin: o, layers: [] }, "base");
			renderer.set("labels", []);
			readySig = ""; baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; lastLabels = []; mainSceneZoom = -1; basemapHidden = true;   // 復帰時に再結合させる
		}
		updateCompass();
		logEl.textContent = `world  zoom=${cam.zoom.toFixed(1)}  基図・地形オフ・海岸線のみ`;
		return;
	}
	basemapHidden = false;
	const { order, coarseOrder, total } = tiles.update(cam, size.w, size.h);
	window.__lastOrder = order;   // デバッグ：現在の選択タイル（コンソール/検証スクリプトから確認）
	swapBase(coarseOrder);                          // 粗い下地は常に敷く（移動中も）＝先端の空白を無くす
	if (!moving || zoomStable) swapScene(order);
	updateCompass();                               // 3D時のみコンパス表示・針を方位に追従
	// 世界海岸線(gint)は z8+ では非表示：海岸は WA 塗りが担う上、gint の2D線は球の自遮蔽を持たず
	// 地平線の先の海岸線（富山湾等）がリムに白線の残影として浮く。14条（interactive）時は表示のまま。
	gintCanvas.style.display = (!gintInteractive && cam.zoom >= 8) ? "none" : "";
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
	clearTimeout(settleT); clearTimeout(bootT);
	destroyPipeline();                           // tile/scene worker
	renderWorker.terminate(); gintWorker.terminate();
	plateauWorkers.forEach(w => w.terminate());
	overlay.destroy();                           // e-Stat worker（createOverlay内で常時起動しているため忘れずに）
	// デバッグ手はこのインスタンスの閉包を掴んだまま＝GCの錨になるので窓から下ろす
	for (const k of ["__plateauPurge", "__moj", "__mojFile", "__sapporo", "__arakawaFit", "__coast", "__cam", "__plateau", "__fly", "__loadOverlay", "__loadEstat", "__tokyo", "__lastOrder"]) delete window[k];
	ownMapEl ? mapEl.remove() : mapEl.replaceChildren();
}

// 世界海岸線：初期視点が z<8 ならここで即発火（既定の世界ビュー＝従来どおり最初から描画）。await せず＝基図の起動を妨げない。
ensureCoast();

// 呼び出し側の手綱（視点操作・飛行・描画設定）＋ガジェット登録簿（v1 ortho-map createGadgets の作法の継承）。
// map.gadget(name, func) で登録し map.gadget.name() で画面に追加する。func 内の this＝この map＝
// mapEl/flyTo 等の手綱がそのまま使える。検索・操作説明は標準装備から外した最初のオプトインガジェット。
const map = { cam, flyTo, renderer, mapEl, destroy };
map.gadget = function (name, func) {
	typeof name == "function" && name.name && (func = name, name = func.name);
	map.gadget[name] = function () { return func.apply(map, arguments); };
};
map.gadget("search", function (opts) {   // 地名・住所検索 … map.gadget.search({ onGo? })。destroy用のsignalはここで注入
	return searchGadget.call(this, { signal: ac.signal, ...opts });
});
map.gadget("hint", hintGadget);       // 操作説明カード … map.gadget.hint() → { open, close }
map.gadget("compass", function (opts) {   // コンパス兼リセット … 内部の手綱（フライト中断・onMove）はここで注入
	const update = compassGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, ...opts });
	if (update) { updateCompass = update; update(); }   // 針の追従を render のフックへ＝搭載した瞬間から現姿勢を指す
});
map.gadget("plateau", function (opts) {   // 建物3D（PLATEAU）データ管理 … モーダルを開く手綱はここで注入
	if (!plateauOn) { console.warn("[plateau] opts.plateau=false＝機能ごと停止中。ガジェットは搭載しない"); return; }
	return plateauGadget.call(this, { onOpen: plateauDb.open, ...opts });
});
return map;
}
