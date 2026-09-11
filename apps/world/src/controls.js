// ── head バーの部品（旧 file I/O スニペットにあった d3 拡張の代替）──
// selectOptions(list,[label,value]) / selectButtons(list) / inputSearch(cb)
import { sel } from "common/dom";

export function selectOptions(target, list, cb, current, trans = s => s) {
	const select = target.empty().append("select");   // ローカル名は sel（common/dom の入口）と衝突させない
	select.selectAll("option").data(list).enter().append("option").attr("value", t => t[1]).attr("trans", t => t[0]).text(t => trans(t[0]));
	current != null && select.property("value", current);
	select.on("change", function () { cb(this.value); });
	return select;
}
export function selectButtons(target, list, cb, current, isText = true, trans = s => s) {
	const div = target.empty().append("div").classed("sel", true);
	const btn = div.selectAll("button").data(list).enter().append("button").attr("value", t => t[1])
		.classed("flip", t => String(t[1]) == String(current));
	isText ? btn.attr("trans", t => t[0]).text(t => trans(t[0])) : btn.html(t => t[0]);
	btn.on("click", function (e, t) {
		div.selectAll("button").classed("flip", false); sel(this).classed("flip", true);
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
