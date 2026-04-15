import * as d3 from 'd3';
import * as d3Overlay from 'd3-overlay';
import {createAutocomplete} from 'd3-autocomplete';
import * as d3Loader from 'd3-loader';

////-----------------------------------------------------------------------------------------------
async function urlBOX(url) {
	if (!await check(url)) return window.open(url,"_web_");
    let plane = d3.select("body").append("div").classed("overlay-urlbox", true);
    let div = plane.append("div").classed("body", true);
    plane.append("div").classed("head", true).html(`閉じる [ <i>${url}</i> ]`)
    .on("click", e=>{ e.stopPropagation();
        div.empty().transition().ease(d3.easeCubic).duration(800).style("top","100%").on("end",()=>plane.remove());
    });
    let iframe = div.append("iframe").attr("scrolling","auto").attr("sandbox","allow-same-origin allow-forms allow-scripts").hide();
    iframe.attr("src", url);// } catch(e) { console.error(e); plane.remove(); }
    div.transition().ease(d3.easeCubic).duration(800).style("transform","translate(0,0)").on("end",()=>iframe.show());//.end();
    function check(url) { return new Promise(function(resolve) {
        var req = new XMLHttpRequest();
        req.open('HEAD', url, true);
        req.onabort = req.onerror = req.ontimeout = function(evt) { resolve(false); };
        req.onreadystatechange = 
            e => { req.readyState === XMLHttpRequest.DONE && (console.log(req), resolve(req.state == 200)); };
        req.send();
    
    }); }
}
////-----------------------------------------------------------------------------------------------

d3.context2D = (w = 300, h = 150, opts = {}) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = w, canvas.height = h;
    opts.id && canvas.setAttribute("id", opts.id);
    opts.name && canvas.setAttribute("name", opts.name);
    opts.class && canvas.setAttribute("class", opts.class);
    opts.style && (canvas.style = opts.style);
    opts.target && (opts.target.node? opts.target.node(): opts.target).appendChild(canvas);
    opts.fill && (ctx.fillStyle = opts.fill, ctx.fillRect(0, 0, w, h));
    ctx.toBlob = () => new Promise(resolve => canvas.toBlob(resolve))
    ctx.size = v => v? (canvas.width = v[0], canvas.height = v[1]):[canvas.width, canvas.height];
    ctx.clear = () => (ctx.clearRect(0,0,canvas.width,canvas.height),ctx);
    ctx.show = () => (d3.select(canvas).show(),ctx);
    ctx.hide = () => (d3.select(canvas).hide(),ctx);
    return ctx;
};
////-----------------------------------------------------------------------------------------------
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
////-----------------------------------------------------------------------------------------------
////-----------------------------------------------------------------------------------------------
d3.history = async(opts) => {
    opts = Object.assign({db:"s3_history.system", key:"undo", max: 100, initial:[[]], bindKey:false}, opts)
    const {db, key, max, exec, initial, bindKey, trigger} = opts;
    const cache = await d3.cache(db, trigger);
    
    let redo = [], undo = (await cache(key))||initial;
    const history = async value => { //if (!value) return console.error(`history hash error`);
        value = Array.isArray(value)? value: [value];
        JSON.stringify(undo[0]) == JSON.stringify(value) || undo.unshift(value);
        await cache(key, undo.slice(0,max));
    };
    history.val = history.value = () => undo[0];
    history.exec = async() => exec && (await exec(...undo[0]));
    history.forward = async() => {
        redo.length && undo.unshift(redo.shift());
        await history.exec();
        return undo[0];
    }
    history.backward = async() => {
        undo.length > 1 && redo.unshift(undo.shift());
        await history.exec();
        return undo[0];
    }
    history.get = ()=> undo;
    bindKey && exec && d3.select(window).on("keydown", async e => { // ctrl-z / ctrl-shift-z で undo / redo
        if ((e.metaKey || e.ctrlKey) &&(e.which == 90)) { e.preventDefault();
            e.shiftKey? (await history.forward()): (await history.backward());
        }
    });
    return history;

}
////-----------------------------------------------------------------------------------------------
d3.laptime = (() => {
    var start = + new Date(), time = + new Date(), func = console.log;
    return (evnt) => {
        if (!evnt || d3.isFunction(evnt)) { start = + new Date(), func = evnt || func; }
        var now = + new Date();
        var lap = (now - time)/1000, total = (now - start)/1000; 
        evnt && func(`${evnt}: ${lap.toFixed(3)} ${total.toFixed(3)}[sec]`);
        time = now;
    }
})();
////-----------------------------------------------------------------------------------------------
d3.highlightKeyword = function(strs, sense = false) {
    if (d3.isString(strs) && strs.match(/^\/.+\/i?$/)) {
        try { var v = eval(strs); if (v.constructor === RegExp) return v; } catch(e) { };
    }
    strs = (strs? d3.isArray(strs)?strs:d3.isString(strs)?strs.split(" "):[strs]:[]).filter(t=>t);
    return new RegExp("(" + strs.map(escape).join("|") + ")", sense ? "":"i");
    function escape(s) {
        var str = "", esc = "(){}[]<>!\"\\\'*#$%&=/+-^,.?";
        s.forEach(function(c) { str += (esc.indexOf(c) + 1)?("\\"+c):c; });
        return str.replace(/^\s*/,"").replace(/\s*$/,"");
    }
};
////-----------------------------------------------------------------------------------------------
d3.selection.prototype.highlight = function(strs, sense = false) { const cls = "highlight";
    const remove = function() { var p = this.parentNode; p.replaceChild(this.firstChild, this); p.normalize(); };
    const isText = q => q.nodeType === 3;
    const isElem = q => (q.nodeType === 1 && q.childNodes.length && !/(script|style)/i.test(q.tagName));
    const isIframe = q => (q.nodeType === 1 && /iframe/i.test(q.tagName));
    this.selectAll("." + cls).each(remove);
    this.selectAll("iframe").each(function(){ d3.select(this.contentDocument.body).selectAll("." + cls).each(remove) });
    if (!strs) return this;
    const rex = (strs.constructor === RegExp)? strs: d3.highlightKeyword(strs, sense);
    return this.each(function() {loop(this)});
    function loop(q) { let r;
        if (isText(q) && (r = q.data.match(rex))) {
            var span = document.createElement("span"); span.classList.add(cls);
            var str = q.splitText(r.index); str.splitText(r[0].length);
            span.appendChild(str.cloneNode(true));
            str.parentNode.replaceChild(span, str);
            return 1
        } else if (isIframe(q)) { loop(q.contentDocument.body);
        } else if (isElem(q) && !(q.className === cls)) {
            for (var i = 0; i < q.childNodes.length; i++) i += loop(q.childNodes[i]);
        }
        return 0;
    }
};