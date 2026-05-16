import * as d3 from 'd3';
import {isString, isArray} from "common";

d3.selection.prototype.highlight = function (strs, sense = false) {
	const KeyWords = strs => {
		if (isString(strs)) {
			const match = strs.match(/^\/(.+)\/(i?)$/);
			if (match) {
				try { return new RegExp(match[1], match[2]); } catch (e) { }
			}
		}
		let arr = []; if (strs) arr = isArray(strs) ? strs : isString(strs) ? strs.split(" ") : [strs];
		arr = arr.filter(t => t); if (arr.length === 0) return null;
		return new RegExp("(" + arr.map(escape).join("|") + ")", sense ? "" : "i");
		function escape(s) {
			const trimmed = String(s).trim();
			return trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}; 
	const cls = "highlight";
	const remove = function () {
		const parent = this.parentNode; if (!parent) return;
		this.replaceWith(...this.childNodes);
		parent.normalize();
	};
	const isText = q => q.nodeType === 3;
	const isElem = q => (q.nodeType === 1 && q.childNodes.length && !/^(script|style)$/i.test(q.tagName));
	this.selectAll("." + cls).each(remove);
	if (!strs) return this;
	const rex = (strs instanceof RegExp) ? strs : KeyWords(strs);
	return this.each(function () { loop(this); });
	function loop(q) { let r;
		if (isText(q) && (r = rex.exec(q.data))) {
			const span = document.createElement("span");
			span.classList.add(cls);
			const str = q.splitText(r.index);
			str.splitText(r[0].length);
			span.appendChild(str.cloneNode(true));
			str.replaceWith(span);
			rex.lastIndex = 0;
			return 1;
		} else if (isElem(q) && !q.classList.contains(cls)) {
			for (let i = 0; i < q.childNodes.length; i++) {
				i += loop(q.childNodes[i]);
			}
		}
		return 0;
	}
};