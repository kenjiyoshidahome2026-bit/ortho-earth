// innerHTML へ入る文字列の関門（2026-10-16・tip/pop の XSS）。2 つの道具：
//   escHtml(v)          ＝データの値（地物の属性・遠くの台帳の名前…）を「文字」として HTML に埋める（& < > " ' を実体参照へ）。
//   setSafeHTML(el, h)  ＝呼び手が**わざと** HTML で渡す吹き出しの中身（<b>・<br>・class・style つきの表…）を、動く物だけ抜いて el に入れる。
// setSafeHTML は禁止表（blocklist）式：script/style/iframe/object/embed 等の要素は中身ごと捨て、on* 属性と javascript:/vbscript:/data:（画像の src 以外）の URL を落とす。
// class・style・表・SVG のアイコンはそのまま通す＝アプリが組む吹き出し（jishin の style つきの行・geopbf-demo の identify-table）の見た目は変わらない。
// 非信頼の HTML を「整形だけ許す」許可表で消毒したい時は geopbf/sanitize の sanitizeHTML（@tip/@pop の値・anno）＝こちらはその後段の安全網。
// 解析は <template>（不活性＝script は走らず画像も取りに行かない）。解析した木をそのまま el へ移す＝文字列へ戻して再解析しない（mXSS の余地を作らない）。
// 依存ゼロ・トップレベルに DOM なし（node の検定と worker から import 可）＝DOM を使うのは setSafeHTML を呼んだ時だけ。

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** 値を HTML の文字として埋める（要素の中身にも属性値にも使える）。null/undefined は文字列化（"null"／"undefined"＝`${v}` と同じ） */
export const escHtml = (v: unknown): string => String(v).replace(/[&<>"']/g, c => ESC[c]);

/** 属性の既定の 1 行（`キー: 値`）を並べる＝tip の既定整形（gint 層の opts.tip === true・既定層のホバー）。キーも値も逃がす */
export const propLines = (p: Record<string, unknown>): string[] => Object.entries(p).map(([k, v]) => `${escHtml(k)}: ${escHtml(v)}`);

// 中身ごと捨てる要素（localName を小文字で）。SVG の animate/set は href を javascript: へ書き換えられる＝捨てる
const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "noscript", "template", "animate", "animatemotion", "animatetransform", "set"]);
// URL を取る属性（scheme を見る）
const URL_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction", "data", "poster", "background", "lowsrc", "dynsrc"]);
// URL の scheme が危ないか。ブラウザは scheme の前後の空白・制御文字と途中の改行/タブを無視する＝0x20 以下を全部抜いてから見る（線形の走査）
export function unsafeURL(value: string, attr: string): boolean {
	let s = "";
	for (let i = 0; i < value.length && s.length < 16; i++) { const c = value.charCodeAt(i); if (c > 0x20) s += value[i].toLowerCase(); }
	if (s.startsWith("javascript:") || s.startsWith("vbscript:")) return true;
	if (s.startsWith("data:")) return !(attr === "src" && s.startsWith("data:image/"));   // data: は画像の src だけ可（img の SVG は script を走らせない）
	return false;
}

/** 消毒の対象になる最小の形（DOM の Element／DocumentFragment・検定は手組みの木で） */
export interface ScrubNode { readonly children: ArrayLike<ScrubEl> }
export interface ScrubEl extends ScrubNode { readonly localName: string; readonly attributes: ArrayLike<{ name: string; value: string }>; removeAttribute(name: string): void; remove(): void }
/** 木を辿って動く物を抜く（DROP の要素は中身ごと・on* 属性・危ない URL・srcdoc）。root そのものは残す */
export function scrubTree(root: ScrubNode): void {
	for (const el of Array.from(root.children)) {
		if (DROP.has(el.localName.toLowerCase())) { el.remove(); continue; }
		for (const { name, value } of Array.from(el.attributes)) {
			const n = name.toLowerCase();
			if (n.startsWith("on") || n === "srcdoc" || (URL_ATTRS.has(n) && unsafeURL(value, n))) el.removeAttribute(name);
		}
		scrubTree(el);
	}
}

/** 呼び手がわざと HTML で渡す中身を el に入れる（innerHTML の代わり）。動く物（script・on*・javascript: 等）は抜いて、整形・class・style はそのまま */
export function setSafeHTML(el: Element, html: unknown): void {
	const tpl = document.createElement("template");
	tpl.innerHTML = html == null ? "" : String(html);
	scrubTree(tpl.content as unknown as ScrubNode);
	el.replaceChildren(tpl.content);
}
