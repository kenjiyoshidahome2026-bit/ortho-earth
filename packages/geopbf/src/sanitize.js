// HTML消毒 — 表示用プロパティ（@tip/@pop 等）の非信頼HTMLを許可リスト式で無害化する。
// GeoPBF は開いたフォーマット＝ファイルは誰でも作れる。プロパティを innerHTML で描画する
// ビューアは、文字列が DOM に入る**出力側の境界で必ず**この関門を通すこと（保存側で
// 消毒済みという前提は信用しない＝定石）。modules/geojson-load.js の sanitizeProperties は
// 「型の消毒」（JSON安全化）、こちらは「表示の消毒」＝役割が別で、両方使う。
//
//   import { sanitizeHTML } from "geopbf/sanitize";
//   el.innerHTML = sanitizeHTML(feature.properties["@pop"]);
//
// 方式: 整形・リスト・表・画像・リンクだけ通す。script/iframe/svg 等は中身ごと廃棄、
// 未知タグは殻だけ剥いで中身を残す。イベント属性/style は全て落ちる。href は http(s)/mailto、
// img src は http(s)/data:image のみ。a には target="_blank" rel="noopener noreferrer" を強制。
// 依存ゼロ・トップレベルに DOM なし（worker から import 可）＝DOM 使用は呼び出し時のみ。
const DROP_TAGS = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "form", "link", "meta", "base", "title", "head"]);   // 中身ごと捨てる（殻剥ぎだと script 本文がテキストとして漏れる）
const OK_TAGS = new Set(["a", "abbr", "b", "blockquote", "br", "caption", "code", "dd", "del", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "wbr"]);
const OK_ATTRS = { "*": ["title", "alt"], a: ["href"], img: ["src", "width", "height"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] };
const okURL = (v, isImg) => /^(?:https?:|mailto:)/i.test(v = v.trim()) || (isImg && /^data:image\//i.test(v));   // 画像だけ data:image/ も可（img src の SVG は script 不実行）
export function sanitizeHTML(html) {
	const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");   // 不活性文書＝script は走らず画像も取得されない
	const out = document.createElement("div");
	(function walk(src, dst) {
		for (const n of src.childNodes) {
			if (n.nodeType === 3) { dst.append(n.textContent); continue; }   // テキストはそのまま（コメント等は捨てる）
			if (n.nodeType !== 1 || DROP_TAGS.has(n.localName)) continue;
			if (!OK_TAGS.has(n.localName)) { walk(n, dst); continue; }       // 不許可タグ＝殻だけ剥いで中身を辿る
			const el = document.createElement(n.localName);
			for (const { name, value } of n.attributes) {
				if (!(OK_ATTRS["*"].includes(name) || OK_ATTRS[n.localName]?.includes(name))) continue;
				if ((name === "href" || name === "src") && !okURL(value, n.localName === "img")) continue;
				el.setAttribute(name, value);
			}
			if (n.localName === "a" && el.hasAttribute("href")) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }   // 別タブ＋オープナー遮断
			walk(n, el); dst.append(el);
		}
	})(doc.body, out);
	return out.innerHTML;
}
