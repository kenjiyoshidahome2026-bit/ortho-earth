// ── head バーの部品（旧 file I/O スニペットにあった d3 拡張の代替）──
// selectOptions(list,[label,value]) / selectButtons(list) / inputSearch(cb)
import { sel } from "common/dom";
import type { Sel } from "common/dom";

/** 選択肢の 1 件＝[ラベル, 値, …]（REGIONS・FILTERS・SORTS.index・LANGUAGES・表示切替） */
export type Choice = readonly (string | number)[];
type Trans = (s: string) => string;

export function selectOptions(target: Sel, list: readonly Choice[], cb: (v: string) => unknown, current?: unknown, trans: Trans = s => s) {
	const select = target.empty().append("select");   // ローカル名は sel（common/dom の入口）と衝突させない
	select.selectAll("option").data(list as Choice[]).enter().append("option").attr("value", t => (t as Choice)[1]).attr("trans", t => (t as Choice)[0]).text((t: unknown) => trans((t as Choice)[0] as string));
	current != null && select.property("value", current);
	select.on("change", function () { cb((this as HTMLSelectElement).value); });
	return select;
}
export function selectButtons(target: Sel, list: readonly Choice[], cb: (v: string | number) => unknown, current?: unknown, isText = true, trans: Trans = s => s) {
	const div = target.empty().append("div").classed("sel", true);
	const btn = div.selectAll("button").data(list as Choice[]).enter().append("button").attr("value", t => (t as Choice)[1])
		.classed("flip", (t: unknown) => String((t as Choice)[1]) == String(current));
	isText ? btn.attr("trans", t => (t as Choice)[0]).text((t: unknown) => trans((t as Choice)[0] as string)) : btn.html((t: unknown) => (t as Choice)[0]);
	btn.on("click", function (e, t) {
		div.selectAll("button").classed("flip", false); sel(this).classed("flip", true);
		cb((t as Choice)[1]);
	});
	return div;
}
export function inputSearch(target: Sel, cb: (v: string) => unknown, current = "") {
	const input = target.empty().append("input").attr("type", "search").attr("placeholder", "search").property("value", current);
	let composing = false, timer = 0;
	input.on("compositionstart", () => composing = true).on("compositionend", () => { composing = false; fire(); })
		.on("input", () => composing || fire()).on<KeyboardEvent>("keydown", e => e.key == "Enter" && fire(0));
	function fire(delay = 300) { clearTimeout(timer); timer = setTimeout(() => cb((input.property("value") as string).trim()), delay); }
	return input;
}
