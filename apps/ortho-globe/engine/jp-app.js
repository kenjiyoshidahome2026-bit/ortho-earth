// 共有エンジンの入口 jp/app.js（/globe/engine/<版>/jp/app.js・2026-10-14）＝orthoJapan（packages/jp/src/app.js）。
// 2 つ以上のアプリ（japan・census2020・choju・ortho-nl・gishub-jp）が使う物は各アプリに焼かず、ここを共に読む（本人 2026-10-14）。
// CSS＝globe.js の入口と同じ手（1 つ上の階の globe.css を 1 回だけ貼る）。./globe.js を import しない＝それを共有チャンクへ追い出すと、
// あちらの new URL(css, import.meta.url) が assets/ を指してしまう。エンジン本体のモジュールは同じ build なので実体は 1 つ。
const css = "../globe.css";
if (!document.querySelector("link[data-ortho-engine]")) {
	const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL(css, import.meta.url).href });
	link.setAttribute("data-ortho-engine", "");
	document.head.appendChild(link);
}
export * from "@ortho-earth/jp/app";
export { default } from "@ortho-earth/jp/app";
