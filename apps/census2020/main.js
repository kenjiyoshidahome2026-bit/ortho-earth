// census2020 起動指揮者：エンジン（ortho-japan/app.js）と census ドリルパネルを結線する。
// パネルは地図を待たない（即描画・初回は9MB自動取得）／地図は hash 共有ビュー優先で立ち上がる。
// 各機能は独立モジュール＝bind(双方向)・choropleth(コロプレス)・bousai(防災)・moj(筆)・wiki(Wikipedia)。
import "./panel.scss";
// ★SDK二重構成（ortho-japan/site.js と同じ型・8/20）：dev=ソース直（編集即反映）・本番=/japan/lib/ のSDK配布物。
//   本番は japan 本体と**同じURLのエンジン**を食う＝ブラウザキャッシュが両アプリで共有（エンジン1回DLで両方立つ）。
//   URLは変数経由＝viteのimport解析（devでもリテラルは解決しにいく）を素通りさせる。CSSはlib抽出分をここで貼る。
let engineP;
if (import.meta.env.PROD) {
	document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/japan/lib/ortho-japan.css" }));
	const LIB = "/japan/lib/ortho-japan.js";
	engineP = import(/* @vite-ignore */ LIB);
} else {
	engineP = import("../ortho-japan/app.js");
}
import { setup } from "./ui/ctx.js";
import { renderCensusSmall2020, drillTo, drillToArea } from "./census/ui.js";
import { prefetchSmallAreaIdb } from "./census/small-area.js";
import { initWiki } from "./wiki.js";
import { initBind } from "./bind.js";
import { initChoropleth } from "./choropleth.js";

// パネル注入口（ドリルUIの唯一の外部継ぎ目＝gishub-jp と同じ setDetailHtml 契約）
const panelBody = document.getElementById("panel-body");
setup({ setDetailHtml: html => { panelBody.innerHTML = html; panelBody.scrollTop = 0; } });

// パネル初期描画（地図と並走）。?area= 共有URLは最初からその場所を描く＝全国ビューを経由しない
// （renderCensusSmall2020 の非同期 national 描画が復元ドリルへ後勝ちする事故を構造的に断つ）。
// 地図側の追随（flyTo/境界）は initBind が購読後に ?area= を再ドリルして受け持つ（再描画は冪等）。
// ?verify=1＝検定ゲート（scripts/verify-prod.mjs）専用の静穏モード：自動プリフェッチ/wiki購読を止める。
// headless+SwiftShaderではCSV→IDBの初回仕込みがmainスレッドを長時間食い、CDPのevaluateすら返らないため
// （本番の実利用には無関係＝フラグ無しの挙動は従来どおり一字も変えない）。
const VERIFY = /[?&]verify=1/.test(location.search);
const area0 = new URLSearchParams(location.search).get("area");
if (VERIFY) { /* 静穏＝パネルは殻のまま・エンジン起動だけを検定する */ }
else if (!area0) renderCensusSmall2020();   // 全国CSV→IDB の自動プリフェッチもここから始まる
else if (area0.length <= 5) drillTo(area0);
else prefetchSmallAreaIdb().then(() => drillToArea(area0)).catch(() => drillTo(area0.slice(0, 5)));
if (!VERIFY) initWiki();   // onDrill 購読＝都道府県/市区町村ビューに Wikipedia カードを後追い差し込み

// パネル出し入れ（6:4 ⇄ 地図全幅）。canvas はエンジンの ResizeObserver(#map) が自動追随
const shell = document.getElementById("shell");
const toggleBtn = document.getElementById("panel-toggle");
const syncToggle = () => { toggleBtn.textContent = shell.classList.contains("map-full") ? "◀" : "▶"; };
toggleBtn.addEventListener("click", () => { shell.classList.toggle("map-full"); syncToggle(); });
syncToggle();

const dismissBoot = () => requestAnimationFrame(() => requestAnimationFrame(() => {
	const boot = document.getElementById("boot");
	if (boot) { boot.classList.add("gone"); setTimeout(() => boot.remove(), 250); }
}));

// hash（共有ビュー）があればそれを優先、無ければ列島俯瞰＝コロプレスの見せ場から始める
const JAPAN_VIEW = "#5.1/38.2/136.9";
// assetBase: 本番=/japan/（ortho-japan Workerの共有棚＝実行時アセットもキャッシュ共有）・dev=自分のbase（publicDir共有＝従来どおり）
engineP.then(m => m.default({ target: "#map", view: location.hash || JAPAN_VIEW, hideAdminBoundary: true, smallAreaHover: true, assetBase: import.meta.env.PROD ? "/japan/" : import.meta.env.BASE_URL })).then(map => {   // hideAdminBoundary=基図の行政界(赤線)抑止／smallAreaHover=町丁目ホバー(名前tip+境界太線)。共に census2020 限定（デモは無効）
	dismissBoot();
	window.__map = map;   // console 検証用（デバッグの手すり）
	// 道具箱（census2020 に要る道具だけ・日本語のみ）
	map.gadget.search();      // 地名・住所検索
	map.gadget.palette();     // 配色テーマ切替
	map.gadget.zoom();        // ズーム＋/−
	map.gadget.full();        // ブラウザ全画面（パネル出し入れとは別物）
	map.gadget.compass();     // コンパス兼リセット
	map.gadget.cpos();        // 現在地
	map.gadget.measure();     // 距離・面積の計測
	map.gadget.shot();        // 画面保存
	map.gadget.qr();          // この視点をQRで共有
	map.gadget.plateau();     // 建物3D（PLATEAU）＝市区町村ズームで autoPlateau が自動点灯
	map.gadget.contextmenu(); // 右クリックメニュー
	map.gadget.hint();        // 操作説明カード
	const legend = map.gadget.legend();   // 左下の凡例＝コロプレス/防災の色の読み物
	const choro = initChoropleth(map, { legend });
	initBind(map, { choro, legend });
}).catch(e => { console.error("[census2020] エンジン起動失敗", e); dismissBoot(); });

if (location.protocol === "https:" && "serviceWorker" in navigator)
	addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(e => console.warn("[sw] 登録失敗", e)));
