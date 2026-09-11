// common/dom の tip / pop ── common/d3/tip-pop.js の native 版（挙動は同じ）。
// import するだけで Sel.prototype に .tip() / .pop() が生える（v1 の tip-pop.js と同じ流儀）。
import { Sel, sel } from "./index.js";
import { isFunction } from "../utility.js";
import "./tip.scss";

const tostr = s => s ? s instanceof Element ? s.outerHTML :
	isFunction(s) ? s() :
	Array.isArray(s) ? s.map(t => t && String(t).trim()).filter(t => t).join("<br/>") : s : null;

// tip/pop の置き場。既定は body（ページ全体で使う素の用法）。モジュールとして箱に閉じたい時は
// setTipRoot(コンテナ) を呼ぶ＝ツールチップがその div の中に生まれ、dir/意匠もその箱のものが効く。
// 位置は置き場に合わせて変換する（body 直下＝ページ座標／positioned な箱＝その箱の左上基準）。
let ROOT = null;
export const setTipRoot = el => { ROOT = el && el.node ? el.node() : el; };
const host = () => ROOT || document.body;
const hostOrigin = () => {
	const h = host();
	if (h === document.body && getComputedStyle(h).position === "static") return [-scrollX, -scrollY];   // ページ座標へ
	const b = h.getBoundingClientRect();
	return [b.left, b.top];                                                                              // 箱の左上基準へ
};

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
	const body = sel(host());
	let tooltip = body.select(".overlap-tooltip");
	tooltip.node() || (tooltip = body.append("div").classed("overlap-tooltip", true).classed("hidden", true));
	const leave = () => tooltip.hide();
	const enter = async () => { const ss = await tostr(s); ss ? tooltip.html(ss) : leave(); };
	const move = e => {
		e.stopPropagation();
		const v = tooltip.node().getBoundingClientRect();
		const [w, h] = [v.width, v.height];
		const [W, H] = [window.innerWidth, window.innerHeight];
		// 画面端での折り返しは viewport 基準で決め、最後に置き場の基準へ移す
		const [x, y] = e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];
		const osx = e.touches ? 40 : 15, osy = -h / 2;
		const [ox, oy] = hostOrigin();
		s && tooltip.show()
			.style("left", ((x + osx + w > W ? x - w - osx : x + osx) - ox) + "px")
			.style("top", (((y + osy < 0) ? 0 : (y + h + osy > H) ? H - h : y + osy) - oy) + "px");
	};
	body.on("touchend.tip", leave);
	return target.on("mouseenter.tip", enter).on("mousemove.tip", move).on("mouseleave.tip", leave).on("click.tip", leave)
		.on("mousedown.tip", leave).on("mouseup.tip", leave).on("dragstart.tip", leave)
		.on("touchstart.tip", enter, { passive: true }).on("touchmove.tip", move, { passive: true }).on("touchend.tip", leave, { passive: true });
}

async function pop(e, s) {
	const body = sel(host());
	const rx = 8, ry = 8;
	const [x, y] = e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];
	const [ox, oy] = hostOrigin();
	const content = body.append("div").classed("popup-content", true);
	content.node().appendChild(await tostr(s));
	const [W] = [window.innerWidth];
	const [w, h] = [+content.style("width").replace(/px$/, "") + 40, +content.style("height").replace(/px$/, "") + 50];
	const frame = body.append("div").classed("popup-frame", true);
	frame.style("width", w + "px").style("height", h + "px");
	frame.style("top", (y + (y < h ? 0 : -h) - oy) + "px").style("left", (((x < w / 2) ? 0 : (x + w / 2 > W) ? W - w : x - w / 2) - ox) + "px");
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
