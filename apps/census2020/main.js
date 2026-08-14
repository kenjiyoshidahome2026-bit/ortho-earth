// census2020 起動指揮者：エンジン（ortho-japan/app.js）と census ドリルパネルを結線する。
// パネルは地図を待たない（即描画・初回は9MB自動取得）／地図は hash 共有ビュー優先で立ち上がる。
// 各機能は独立モジュール＝bind(双方向)・choropleth(コロプレス)・bousai(防災)・moj(筆)・wiki(Wikipedia)。
import "./panel.scss";
import orthoJapan from "../ortho-japan/app.js";
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
const area0 = new URLSearchParams(location.search).get("area");
if (!area0) renderCensusSmall2020();   // 全国CSV→IDB の自動プリフェッチもここから始まる
else if (area0.length <= 5) drillTo(area0);
else prefetchSmallAreaIdb().then(() => drillToArea(area0)).catch(() => drillTo(area0.slice(0, 5)));
initWiki();                // onDrill 購読＝都道府県/市区町村ビューに Wikipedia カードを後追い差し込み

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
orthoJapan({ target: "#map", view: location.hash || JAPAN_VIEW }).then(map => {
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
