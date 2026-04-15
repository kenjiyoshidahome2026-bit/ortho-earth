import * as d3 from 'd3'; 
d3.body = () => d3.select("body");
d3.selection.prototype.parent = function() { return d3.select(this.node().parentNode); };
d3.selection.prototype.prepend = function(elem) { return this.insert(elem,":first-child"); };
d3.selection.prototype.getSize = function() { let rect = this.node().getBoundingClientRect(); return [rect.width, rect.height]; };
d3.selection.prototype.getOffset = function() { let rect = this.node().getBoundingClientRect(); return [rect.left, rect.top]; };
d3.selection.prototype.getOuterSize = function() { let rect = this.node().getBoundingClientRect();
	const num = s => +s.replace(/px$/,"");
	const {marginTop, marginRight, marginBottom, marginLeft} = window.getComputedStyle(this.node());
	return [rect.width + num(marginRight)+num(marginLeft), rect.height + num(marginTop)+num(marginBottom)]; };
d3.selection.prototype.toggleClass = function(name) { let flag = !this.classed(name); this.classed(name, flag); return flag; };
d3.selection.prototype.empty = function(flag) { return this.html(""); };
d3.selection.prototype.prependNode = function(el) { this.node().insertBefore(el, this.node().childNodes[0]); return this; }
d3.selection.prototype.appendNode = function(el) { this.node().appendChild(el); return this; }
d3.selection.prototype.absolute = function(t=0,r=0,b=0,l=0,opts={}) {
	Array.isArray(t) && (opts = r, [t,r,b,l] = t);
	var v = Object.assign({position:"absolute"}, opts||{});
	(t < 0)? (v.height = `${-t}px`):(v.top = `${t}px`);
	(r < 0)? (v.width = `${-r}px`):(v.right = `${r}px`);
	(b < 0)? (v.height = `${-b}px`):(v.bottom = `${b}px`);
	(l < 0)? (v.width = `${-l}px`):(v.left = `${l}px`);
//		console.log(v);
	return this.css(v);
};
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