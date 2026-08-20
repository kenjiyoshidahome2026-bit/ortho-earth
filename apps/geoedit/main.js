// geoedit 起動指揮者：エンジン（ortho-japan SDK）と編集コントローラを結線する。
// エディタ本体は src/ の独立モジュール群＝controller(状態機械)・model(編集モデル)・overlay(ハンドル描画)・
// gint-layer(確定層)・io(入出力)。エンジンの gint 6ハンドルは gint-layer.js の中にだけ触らせる（v2移行の触り所を1点に）。
import "./editor.scss";
import { createGeopbf } from "geopbf";
// ★geoedit 自前バンドルの geopbf を必ずここで初期化する。SDK分割後、lib(/japan/lib/)の中の geopbf と
//   geoedit がバンドルする geopbf は**別モジュールインスタンス**＝エンジン(app.js)の createGeopbf は
//   lib側コピーにしか効かない（census2020 本番事故 8/20 の教訓）。devはソース直＝同一インスタンスの
//   二重呼びになるが createGeopbf は冪等（同apiBase）＝無害。
createGeopbf("https://api.ortho-earth.com");
// ★SDK二重構成（census2020 と同じ型）：dev=ソース直（編集即反映）・本番=/japan/lib/ のSDK配布物。
//   本番は japan 本体と同じURLのエンジンを食う＝ブラウザキャッシュが両アプリで共有。
//   URLは変数経由＝viteのimport解析（devでもリテラルは解決しにいく）を素通りさせる。CSSはlib抽出分をここで貼る。
let engineP;
if (import.meta.env.PROD) {
	document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/japan/lib/ortho-japan.css" }));
	const LIB = "/japan/lib/ortho-japan.js";
	engineP = import(/* @vite-ignore */ LIB);
} else {
	engineP = import("../ortho-japan/app.js");
}

const dismissBoot = () => requestAnimationFrame(() => requestAnimationFrame(() => {
	const boot = document.getElementById("boot");
	if (boot) { boot.classList.add("gone"); setTimeout(() => boot.remove(), 250); }
}));

// ?verify=1＝検定ゲート（scripts/verify-prod.mjs）専用の静穏モード：エンジン起動だけを検定する
const VERIFY = /[?&]verify=1/.test(location.search);

// hash（共有ビュー）優先、無ければ列島俯瞰。エディタはチルトなし（maxPitch:0＝本人裁定 8/20）＝
// 真上からの編集専用。地形リフト・裏半球の考慮がオーバレイから消える。
const JAPAN_VIEW = "#5.1/38.2/136.9";
engineP.then(m => m.default({
	target: "#map",
	view: location.hash || JAPAN_VIEW,
	maxPitch: 0,
	assetBase: import.meta.env.PROD ? "/japan/" : import.meta.env.BASE_URL,
})).then(async map => {
	dismissBoot();
	window.__map = map;   // console 検証用（デバッグの手すり）
	// 道具箱（編集に要る最小限・日本語のみ）
	map.gadget.search();      // 地名・住所検索＝編集場所へ飛ぶ
	map.gadget.zoom();        // ズーム＋/−
	map.gadget.compass();     // 方位リセット（チルトなしでも回転はある）
	map.gadget.full();        // ブラウザ全画面（Z）
	map.gadget.shot();        // 画面保存（旧ツールバーのカメラ相当）
	// 右クリックメニューはエディタ本体が編集アクション付きでマウント（二重搭載は無効化されるためここでは呼ばない）
	if (VERIFY) return;       // 静穏＝エディタ本体は起動しない（headless検定はエンジンだけ見る）
	const { initEditor } = await import("./src/controller.js");   // エディタ本体＝遅延chunk（起動バンドルを重くしない）
	window.__editor = initEditor(map);
}).catch(e => { console.error("[geoedit] エンジン起動失敗", e); dismissBoot(); });
