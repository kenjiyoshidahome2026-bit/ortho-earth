// common/dom の tip / pop ── 旧 common/d3/tip-pop.js（d3 版・2026-09-25 に削除）の native 版。
// import するだけで Sel.prototype に .tip() / .pop() が生える（v1 の tip-pop.js と同じ流儀）。
import { Sel, sel } from "./index.ts";
import { isFunction } from "common";   // 名前で読む＝共有エンジンを読む頁ではエンジンの入口 common（束に二重に焼かない・2026-10-15）
import "./tip.scss";

/** tip/pop の中身＝要素／文字列／それらの配列／それを返す関数（async 可）。falsy＝出さない */
export type TipContent = unknown;

declare module "./index.ts" {
	interface Sel {
		/** カーソル追従のツールチップ（mouseenter/mousemove/mouseleave と touch を張る） */
		tip(s: TipContent): this;
		/** クリックで地点に錨を打つ吹き出し。関数なら (データ, 添字) で中身を作る */
		pop(s: TipContent | ((d: unknown, i: number) => TipContent)): this;
	}
}

const tostr = (s: TipContent): unknown => s ? s instanceof Element ? s.outerHTML :
	isFunction(s) ? s() :
	Array.isArray(s) ? s.map(t => t && String(t).trim()).filter(t => t).join("<br/>") : s : null;

// tip/pop の置き場。既定は body（ページ全体で使う素の用法）。モジュールとして箱に閉じたい時は
// setTipRoot(コンテナ) を呼ぶ＝ツールチップがその div の中に生まれ、dir/意匠もその箱のものが効く。
// 位置は置き場に合わせて変換する（body 直下＝ページ座標／positioned な箱＝その箱の左上基準）。
let ROOT: Element | null = null;
export const setTipRoot = (el: Element | { node(): Element | null } | null | undefined): void => { ROOT = el && "node" in el ? el.node() : el ?? null; };
const host = (): Element => ROOT || document.body;
const hostOrigin = (): [number, number] => {
	const h = host();
	if (h === document.body && getComputedStyle(h).position === "static") return [-scrollX, -scrollY];   // ページ座標へ
	const b = h.getBoundingClientRect();
	return [b.left, b.top];                                                                              // 箱の左上基準へ
};

Sel.prototype.tip = function (this: Sel, s: TipContent): Sel { return tip(this, s); };
Sel.prototype.pop = function (this: Sel, s: TipContent | ((d: unknown, i: number) => TipContent)): Sel {
	return this.each(function (t, i) { sel(this).on("click", (e: MouseEvent | TouchEvent) => pop(e, isFunction(s) ? (() => (s as (d: unknown, i: number) => TipContent)(t, i)) : s)); });
};

export const cleanup = (): void => {
	sel(".overlap-tooltip").hide();
	for (const n of document.querySelectorAll(".popup-frame")) n.remove();
	for (const n of document.querySelectorAll(".popup-content")) n.classList.add("hidden");
};

function tip(target: Sel, s: TipContent): Sel {
	const body = sel(host());
	let tooltip = body.select(".overlap-tooltip");
	tooltip.node() || (tooltip = body.append("div").classed("overlap-tooltip", true).classed("hidden", true));
	const leave = (): Sel => tooltip.hide();
	const enter = async (): Promise<void> => { const ss = await tostr(s); ss ? tooltip.html(ss as string) : leave(); };
	const move = (e: MouseEvent | TouchEvent): void => {
		e.stopPropagation();
		const v = tooltip.node()!.getBoundingClientRect();
		const [w, h] = [v.width, v.height];
		const [W, H] = [window.innerWidth, window.innerHeight];
		// 画面端での折り返しは viewport 基準で決め、最後に置き場の基準へ移す
		const touches = (e as TouchEvent).touches;
		const [x, y] = touches ? [touches[0].clientX, touches[0].clientY] : [(e as MouseEvent).clientX, (e as MouseEvent).clientY];
		const osx = touches ? 40 : 15, osy = -h / 2;
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

async function pop(e: MouseEvent | TouchEvent, s: TipContent): Promise<void> {
	const body = sel(host());
	const rx = 8, ry = 8;
	const touches = (e as TouchEvent).touches;
	const [x, y] = touches ? [touches[0].clientX, touches[0].clientY] : [(e as MouseEvent).clientX, (e as MouseEvent).clientY];
	const [ox, oy] = hostOrigin();
	const content = body.append("div").classed("popup-content", true);
	content.node()!.appendChild(await tostr(s) as Node);
	const [W] = [window.innerWidth];
	const [w, h] = [+content.style("width").replace(/px$/, "") + 40, +content.style("height").replace(/px$/, "") + 50];
	const frame = body.append("div").classed("popup-frame", true);
	frame.style("width", w + "px").style("height", h + "px");
	frame.style("top", (y + (y < h ? 0 : -h) - oy) + "px").style("left", (((x < w / 2) ? 0 : (x + w / 2 > W) ? W - w : x - w / 2) - ox) + "px");
	frame.on("click", ev => { ev.stopPropagation(); frame.hide(); });
	const svg = frame.append("svg");
	frame.node()!.appendChild(content.node()!);
	content.style("top", (y < h ? 30 : 20) + "px").style("left", 20 + "px");
	const x1 = (x < w / 2) ? x : (x + w / 2 > W) ? (w - W + x) : w / 2;
	const x2 = (x < w / 2) ? Math.max(30 - x, -10) : (x + w / 2 > W) ? Math.min(W - x - 50, -10) : -10;
	const d = "M" + x1 + " " + (y < h ? 0 : h) + "l" + x2 + " " + (y < h ? 20 : -20) + "h20z";
	svg.append("rect").attr("x", 10).attr("y", y < h ? 20 : 10).attr("rx", rx).attr("ry", ry).attr("width", w - 20).attr("height", h - 30);
	svg.append("path").attr("d", d);
}
