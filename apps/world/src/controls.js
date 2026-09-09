// ── head バーの部品（旧 file I/O スニペットにあった d3 拡張の代替）──
// selectOptions(list,[label,value]) / selectButtons(list) / inputSearch(cb)
import * as d3 from 'd3';

export function selectOptions(target, list, cb, current, trans = s => s) {
	const sel = target.empty().append("select");
	sel.selectAll("option").data(list).enter().append("option").attr("value", t => t[1]).attr("trans", t => t[0]).text(t => trans(t[0]));
	current != null && sel.property("value", current);
	sel.on("change", function () { cb(this.value); });
	return sel;
}
export function selectButtons(target, list, cb, current, isText = true, trans = s => s) {
	const div = target.empty().append("div").classed("sel", true);
	const btn = div.selectAll("button").data(list).enter().append("button").attr("value", t => t[1])
		.classed("flip", t => String(t[1]) == String(current));
	isText ? btn.attr("trans", t => t[0]).text(t => trans(t[0])) : btn.html(t => t[0]);
	btn.on("click", function (e, t) {
		div.selectAll("button").classed("flip", false); d3.select(this).classed("flip", true);
		cb(t[1]);
	});
	return div;
}
export function inputSearch(target, cb, current = "") {
	const input = target.empty().append("input").attr("type", "search").attr("placeholder", "search").property("value", current);
	let composing = false, timer = 0;
	input.on("compositionstart", () => composing = true).on("compositionend", () => { composing = false; fire(); })
		.on("input", () => composing || fire()).on("keydown", e => e.key == "Enter" && fire(0));
	function fire(delay = 300) { clearTimeout(timer); timer = setTimeout(() => cb(input.property("value").trim()), delay); }
	return input;
}
