// common/dom の tip / pop ── common/d3/tip-pop.js の native 版（挙動は同じ）。
// import するだけで Sel.prototype に .tip() / .pop() が生える（v1 の tip-pop.js と同じ流儀）。
import { Sel, sel } from "./index.js";
import { isFunction } from "../utility.js";
import "./tip.scss";

const tostr = s => s ? s instanceof Element ? s.outerHTML :
	isFunction(s) ? s() :
	Array.isArray(s) ? s.map(t => t && String(t).trim()).filter(t => t).join("<br/>") : s : null;

Sel.prototype.tip = function (s) { return tip(this, s); };
Sel.prototype.pop = function (s) {
	return this.each(function (t, i) { sel(this).on("click", e => pop(e, isFunction(s) ? (() => s(t, i)) : s)); });
};

export const cleanup = () => {
	sel(".overlap-tooltip").hide();
	for (const n of document.querySelectorAll(".popup-frame")) n.remove();
	for (const n of document.querySelectorAll(".popup-content")) n.classList.add("hidden");
};

function tip(target, s) {
	const body = sel("body");
	let tooltip = body.select(".overlap-tooltip");
	tooltip.node() || (tooltip = body.append("div").classed("overlap-tooltip", true).classed("hidden", true));
	const leave = () => tooltip.hide();
	const enter = async () => { const ss = await tostr(s); ss ? tooltip.html(ss) : leave(); };
	const move = e => {
		e.stopPropagation();
		const v = tooltip.node().getBoundingClientRect();
		const [w, h] = [v.width, v.height];
		const [W, H] = [window.innerWidth, window.innerHeight];
		const [x, y] = e.touches ? [e.touches[0].pageX, e.touches[0].pageY] : [e.pageX, e.pageY];
		const osx = e.touches ? 40 : 15, osy = -h / 2;
		s && tooltip.show()
			.style("left", (x + osx + w > W ? x - w - osx : x + osx) + "px")
			.style("top", ((y + osy < 0) ? 0 : (y + h + osy > H) ? H - h : y + osy) + "px");
	};
	body.on("touchend.tip", leave);
	return target.on("mouseenter.tip", enter).on("mousemove.tip", move).on("mouseleave.tip", leave).on("click.tip", leave)
		.on("mousedown.tip", leave).on("mouseup.tip", leave).on("dragstart.tip", leave)
		.on("touchstart.tip", enter, { passive: true }).on("touchmove.tip", move, { passive: true }).on("touchend.tip", leave, { passive: true });
}

async function pop(e, s) {
	const body = sel("body");
	const rx = 8, ry = 8;
	const [x, y] = e.touches ? [e.touches[0].pageX, e.touches[0].pageY] : [e.pageX, e.pageY];
	const content = body.append("div").classed("popup-content", true);
	content.node().appendChild(await tostr(s));
	const [W] = [window.innerWidth];
	const [w, h] = [+content.style("width").replace(/px$/, "") + 40, +content.style("height").replace(/px$/, "") + 50];
	const frame = body.append("div").classed("popup-frame", true);
	frame.style("width", w + "px").style("height", h + "px");
	frame.style("top", (y + (y < h ? 0 : -h)) + "px").style("left", ((x < w / 2) ? 0 : (x + w / 2 > W) ? W - w : x - w / 2) + "px");
	frame.on("click", ev => { ev.stopPropagation(); frame.hide(); });
	const svg = frame.append("svg");
	frame.node().appendChild(content.node());
	content.style("top", (y < h ? 30 : 20) + "px").style("left", 20 + "px");
	const x1 = (x < w / 2) ? x : (x + w / 2 > W) ? (w - W + x) : w / 2;
	const x2 = (x < w / 2) ? Math.max(30 - x, -10) : (x + w / 2 > W) ? Math.min(W - x - 50, -10) : -10;
	const d = "M" + x1 + " " + (y < h ? 0 : h) + "l" + x2 + " " + (y < h ? 20 : -20) + "h20z";
	svg.append("rect").attr("x", 10).attr("y", y < h ? 20 : 10).attr("rx", rx).attr("ry", ry).attr("width", w - 20).attr("height", h - 30);
	svg.append("path").attr("d", d);
}
