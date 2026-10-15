import * as d3 from 'd3';
import {isString, isArray} from "common";

// 拡張の this＝HTML 要素のセレクション（d3 の selection.prototype は型が無い（any）＝ここで決める）
type Proto = d3.Selection<HTMLElement, unknown, d3.BaseType, unknown>;

declare module 'd3-selection' {
	interface Selection<GElement extends BaseType, Datum, PElement extends BaseType, PDatum> {
		/** strs＝語（空白区切り）／語の配列／"/正規表現/i" の文字列／RegExp。空＝印を外すだけ */
		highlight(strs: unknown, sense?: boolean): this;
	}
}

d3.selection.prototype.highlight = function (this: Proto, strs: unknown, sense = false): Proto {
	const KeyWords = (strs: unknown): RegExp | null => {
		if (isString(strs)) {
			const match = strs.match(/^\/(.+)\/(i?)$/);
			if (match) {
				try { return new RegExp(match[1], match[2]); } catch (e) { }
			}
		}
		let arr: unknown[] = []; if (strs) arr = isArray(strs) ? strs : isString(strs) ? strs.split(" ") : [strs];
		arr = arr.filter(t => t); if (arr.length === 0) return null;
		return new RegExp("(" + arr.map(escape).join("|") + ")", sense ? "" : "i");
		function escape(s: unknown): string {
			const trimmed = String(s).trim();
			return trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	};
	const cls = "highlight";
	const remove = function (this: Element): void {
		const parent = this.parentNode; if (!parent) return;
		this.replaceWith(...this.childNodes);
		parent.normalize();
	};
	const isText = (q: Node): q is Text => q.nodeType === 3;
	const isElem = (q: Node): q is Element => (q.nodeType === 1 && !!q.childNodes.length && !/^(script|style)$/i.test((q as Element).tagName));
	this.selectAll<Element, unknown>("." + cls).each(remove);
	if (!strs) return this;
	const rex = (strs instanceof RegExp) ? strs : KeyWords(strs);   // TODO(ts): 語が空（KeyWords が null）だと loop で rex.exec が TypeError（dom/highlight.ts は null で抜ける）。動作は据え置き
	return this.each(function (this: Element) { loop(this); });
	function loop(q: Node): number { let r: RegExpExecArray | null;
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
