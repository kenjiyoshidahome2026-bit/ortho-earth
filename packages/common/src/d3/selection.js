import * as d3 from 'd3'; 
import { isString } from '../utility.js';
import './selection.scss';
d3.selection.prototype.show = function() { return this.classed("hidden", false); };
d3.selection.prototype.hide = function() { return this.classed("hidden", true); };
d3.selection.prototype.toggle = function() { return this.classed("hidden", !this.classed("hidden")); };
d3.selection.prototype.showIF = function(flag) { return this.classed("hidden", !flag); };
d3.selection.prototype.isVisible = function() { return !this.classed("hidden"); };
d3.selection.prototype.shrinkHide = function(target, opts) { return shrinkHide(this, target, opts); };
d3.selection.prototype.resumeShow = function(target, opts) { return resumeShow(this, target, opts); };

d3.selection.prototype.parent = function() { return d3.select(this.node().parentNode); };
d3.selection.prototype.prepend = function(elem) { return this.insert(elem,":first-child"); };
d3.selection.prototype.getSize = function() { let rect = this.node().getBoundingClientRect(); return [rect.width, rect.height]; };
d3.selection.prototype.getOffset = function() { let rect = this.node().getBoundingClientRect(); return [rect.left, rect.top]; };
d3.selection.prototype.getOuterSize = function() { let rect = this.node().getBoundingClientRect();
	const num = s => +s.replace(/px$/,"");
	const {marginTop, marginRight, marginBottom, marginLeft} = window.getComputedStyle(this.node());
	return [rect.width + num(marginRight)+num(marginLeft), rect.height + num(marginTop)+num(marginBottom)]; };
d3.selection.prototype.toggleClass = function(name) { let flag = !this.classed(name); this.classed(name, flag); return flag; };
d3.selection.prototype.empty = function() { return this.html(""); };
d3.selection.prototype.prependNode = function(el) { this.node().insertBefore(el, this.node().childNodes[0]); return this; }
d3.selection.prototype.appendNode = function(el) { this.node().appendChild(el); return this; }
d3.selection.prototype.editable = function(def, exec) {
	let emode = false;
	return this.attr("contenteditable",true).text(def).on("change",e=>exec(this.text()))
	.on("keydown",e=>emode = (e.which==13))
	.on("keyup", e=>emode && (e.which==13) && exec(this.text()));
}
////====================================================
//// jQuery: css
////====================================================
d3.selection.prototype.css = function(q) {
	const isNumber = _ => _ != null && _.constructor == Number;
	const unCamel = _ => _.replace(/[A-Z]/g,t=>"-"+t.toLowerCase());
	const PX = ["top","buttom","left","right","margin","padding"]
	Object.entries(q).forEach(([key,val])=>this.style(unCamel(key),(val && isNumber(val) && PX.includes(key))?val+"px":val));
	return this;
};
////====================================================
//// 横方向にスライドするdiv
////====================================================
d3.selection.prototype.slideX = function(flag) { const node = this.node();
	this.on("wheel",e=>{ node.scrollBy(e.deltaX+e.deltaY, 0); e.preventDefault(); e.stopPropagation(); });
	flag || this.on("mouseleave",e=>node.scrollLeft = 0);
	return this;
};
////====================================================
//// インベントのトリガー
////====================================================
d3.selection.prototype.trigger = function(event, props = {}) {
	const evt = isString(event)? new CustomEvent(event, {detail:props}): event;
	this.node() && this.node().dispatchEvent(evt);
	return this;
};
////====================================================
//// 直下にcanvasを作ってcontextを返す。resize対応
////====================================================
d3.selection.prototype.context2D = function(opts = {}) { const target = opts.target = this;
	const mag = opts.mag || 1;
	const [w,h] = target.getSize();//.map(t=>t*mag);
	let width = opts.width || w;
	let height = opts.height || h;
	const ctx = d3.context2D(width*mag, height*mag, opts); ctx.scale(mag,mag);
	window.addEventListener("resize", resize);
	ctx.clear = () => (ctx.clearRect(0,0,width,height),ctx);
	return ctx;
	function resize() {	[width,height] = target.getSize(); ctx.size([width*mag,height*mag]); }
};
function clone(dom, target) {
    if (target && target.node) target = target.node();
    const div = document.createElement("div");
    div.appendChild(dom.cloneNode(true));
    dom.parentNode.appendChild(div);

    const setOrigin = () => {
        if (!target) return "50% 50%";
        const tr = target.getBoundingClientRect();
        const dr = div.getBoundingClientRect();
        const ox = (tr.left + tr.width / 2) - dr.left;
        const oy = (tr.top + tr.height / 2) - dr.top;
        return `${ox}px ${oy}px`;
    };

    return d3.select(div)
        .classed("overlay-fullbody", true)
        .style("transform-origin", setOrigin());
}
function shrinkHide(selection, target, opts = {}) {
    const cover = clone(selection.node(), target);
    selection.hide();
    return new Promise(resolve => {
        cover.transition()
            .ease(opts.ease || d3.easeCubic)
            .duration(opts.trans || 500)
            .style("transform", "scale(0)")
            .on("end", () => {
                cover.remove();
                if (opts.fallback) opts.fallback(selection);
                resolve(selection);
            });
    });
}
function resumeShow(selection, target, opts = {}) {
    selection.show();
    const cover = clone(selection.node(), target).style("transform", "scale(0)");
    selection.hide();
    return new Promise(resolve => {
        cover.transition()
            .ease(opts.ease || d3.easeCubic)
            .duration(opts.trans || 500)
            .style("transform", "scale(1)")
            .on("end", () => {
                selection.show();
                cover.remove();
                if (opts.fallback) opts.fallback(selection);
                resolve(selection);
            });
    });
}

