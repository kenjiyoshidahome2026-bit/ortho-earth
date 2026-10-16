// common/dom の highlight ── common/d3/highlight.ts の native 版（走査ロジックは同一）。
// import するだけで Sel.prototype に .highlight() が生える。
import { Sel } from "./index.ts";
import { isString, isArray } from "common";   // 名前で読む＝共有エンジンを読む頁ではエンジンの入口 common（束に二重に焼かない・2026-10-15）
import "./highlight.scss";

declare module "./index.ts" {
	interface Sel {
		/** strs＝語（空白区切り）／語の配列／"/正規表現/i" の文字列／RegExp。空＝印を外すだけ */
		highlight(strs: unknown, sense?: boolean): this;
	}
}

Sel.prototype.highlight = function (this: Sel, strs: unknown, sense = false): Sel {
	const KeyWords = (strs: unknown): RegExp | null => {
		if (isString(strs)) {
			const match = strs.match(/^\/(.+)\/(i?)$/);
			if (match) {
				try { return new RegExp(match[1], match[2]); } catch (e) { }
			}
		}
		let arr: unknown[] = []; if (strs) arr = isArray(strs) ? strs : isString(strs) ? strs.split(" ") : [strs];
		arr = arr.filter(t => t); if (arr.length === 0) return null;
		return new RegExp("(" + arr.map(esc).join("|") + ")", sense ? "" : "i");
		function esc(s: unknown): string { return String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
	};
	const cls = "highlight";
	const remove = function (this: Element): void {
		const parent = this.parentNode; if (!parent) return;
		this.replaceWith(...this.childNodes);
		parent.normalize();
	};
	const isText = (q: Node): q is Text => q.nodeType === 3;
	const isElem = (q: Node): q is Element => (q.nodeType === 1 && !!q.childNodes.length && !/^(script|style)$/i.test((q as Element).tagName));
	this.selectAll("." + cls).each(remove);
	if (!strs) return this;
	const rex = (strs instanceof RegExp) ? strs : KeyWords(strs);
	if (!rex) return this;
	return this.each(function () { loop(this); });
	function loop(q: Node): number {
		let r: RegExpExecArray | null;
		if (isText(q) && (r = rex!.exec(q.data))) {
			const span = document.createElement("span");
			span.classList.add(cls);
			const str = q.splitText(r.index);
			str.splitText(r[0].length);
			span.appendChild(str.cloneNode(true));
			str.replaceWith(span);
			rex!.lastIndex = 0;
			return 1;
		} else if (isElem(q) && !q.classList.contains(cls)) {
			for (let i = 0; i < q.childNodes.length; i++) {
				i += loop(q.childNodes[i]);
			}
		}
		return 0;
	}
};
