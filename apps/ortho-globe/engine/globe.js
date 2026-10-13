// 共有エンジンの入口（/globe/engine/<版>/globe.js・縮小計画 項目 9・2026-09-30）。中身は @ortho-earth/globe そのもの。
// lib×ES は CSS をチャンクから抜いて 1 枚（globe.css）に出す＝アプリの束に付いて来なくなる＝入口が自分の隣の CSS を貼る。
// 名前は変数で渡す＝vite の new URL(リテラル) 解析（ビルド時に実体を探す）を通さない（globe.css はビルドの出力で、ソースには無い）。
const css = "globe.css";
if (!document.querySelector("link[data-ortho-engine]")) {
	const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL(css, import.meta.url).href });
	link.setAttribute("data-ortho-engine", "");
	document.head.appendChild(link);
}
export * from "@ortho-earth/globe";
