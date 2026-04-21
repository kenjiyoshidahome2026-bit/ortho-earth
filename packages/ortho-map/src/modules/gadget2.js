import * as d3 from 'd3';
import { max, isString, isFunction } from "common";
import { gadgetIcons, tooltips } from "../modules/icons.js"
let loadings = [];
export function setProp(div, prop) {
    const { fontSize, fontFamily, background, color, borderWidth, borderColor, radius, hoverColor } = prop;
    fontSize && div.style("font-size", fontSize); fontFamily && div.style("font-family", fontFamily);
    background && div.style("background", background); color && div.style("color", color);
    borderWidth && div.style("border-width", borderWidth); borderColor && div.style("border-color", borderColor);
    hoverColor && div.on("mouseover", () => div.style("border-color", hoverColor)).on("mouseout", () => div.style("border-color", null));
    radius && div.style("border-radius", radius);
}
////--------------------------------------------------------- ファイルの読み込み状態
export function loading(opts = {}) {
    const map = this, name = "loading";
    const div = map.overlays.append("div").attr("name", "loading").hide();
    setProp(div, opts);
    map.onLoadStart(name, LoadStart);
    map.onLoadEnd(name, LoadEnd);
    map.onDrawing(name, () => div.showIF(map.isEditable() && div.text()));
    map.onResize(name, resize); resize();
    function set() {
        div.html(loadings.map(t => `<span>Loading: ${t}</span>`).join("<br/>")).show();
        const widths = [...div.selectAll("span")].map(t => t.getBoundingClientRect().width);
        div.style("width", (max(widths) + 30) + "px");
        div.showIF(map.isEditable());
    }
    function reset() { div.empty().hide(); }
    function LoadStart(name) { loadings.push(name); set(); }
    function LoadEnd(name) { loadings = loadings.filter(t => t != name); loadings.length ? set() : reset(); }
    function resize() { div.style("bottom", (map.isNarrow ? 50 : 30) + "px"); }
}
////--------------------------------------------------------- 左上に説明を追加する
export function explain(opts = {}) {
    const map = this, name = "explain";
    const div = map.overlays.append("div").attr("name", name).hide();
    setProp(div, opts);
    const contents = div.append("div");
    div.on("mousemove touchmove", e => e.stopPropagation(), { passive: true });
    opts.width && div.style("width", opts.width + "px");
    if (!opts.permanent) {
        div.classed("active", true).on("click", e => { e.stopPropagation(); div.empty().hide() });
        div.append("button").classed("close", true).html(gadgetIcons.close)
        //.on("click", e =>{ e.stopPropagation(); div.empty().hide() });
    }
    map.onDrawing(name, () => div.showIF(map.isEditable() && div.text()));
    map.onResize(name, resize); resize();
    return html => {
        isFunction(html) ? html(contents) :
            html ? (div.showIF(map.isEditable()), contents.html(html)) : (div.hide(), contents.empty());
    };
    function resize() { div.style("top", (map.isNarrow ? 25 : 5) + "px"); }
};
////--------------------------------------------------------- 右下に凡例を表示する
export function legend(opts = {}) {
    const map = this, name = "legend"; opts.target = opts.target || "leftBottom";
    const div = map.overlays.append("div").attr("name", name).hide();
    setProp(div, opts);
    const contents = div.append("div");
    div.on("mousemove touchmove", e => e.stopPropagation(), { passive: true });
    let flag = true;
    opts.width && div.style("width", opts.width + "px");
    opts.left && div.style("left", opts.left + "px");
    if (!opts.permanent) {
        const open = () => (div.resumeShow(btn), btn.hide());
        const close = () => (btn.show().style("visibility", "hidden"), div.shrinkHide(btn, { fallback: () => btn.style("visibility", "visible") }));;;
        div.classed("active", true).on("click", e => (e.stopPropagation(), close(), flag = false));
        div.append("button").classed("close", true).html(gadgetIcons.close)
        const btn = createButton(map, name, opts).hide().onClick(() => (open(), flag = true));
    }
    map.onDrawing(name, () => div.showIF(map.isEditable() && div.text() && flag));
    map.onResize(name, resize); resize();
    return html => {
        isFunction(html) ? html(contents) :
            html ? (div.showIF(map.isEditable()), contents.html(html)) : (div.hide(), contents.empty());
    };
    function resize() { div.style("bottom", (map.isNarrow ? 50 : 30) + "px"); }
}
//---------------------------------------------------------------------------------------
export function tip(opts = {}) {
    const map = this, name = "tip";
    const toHTML = str => {
        if (Array.isArray(str)) return str.map(t => `<div>${t}</div>`).join("");
        if (typeof str === 'string' && str.includes('\n')) return toHTML(str.split(/\n/));
        return str;
    };
    const div = map.overlays.append("div").attr("name", name);
    setProp(div, opts);
    let cachedSize = { w: 0, h: 0 };
    const hide = () => div.style("display", "none");
    const show = () => div.style("display", "block");
    map.onMove(name, move).onLeave(name, hide).onDrawing(name, hide);
    return content => {
        if (!content) { div.html("").call(hide); cachedSize = { w: 0, h: 0 }; return; }
        div.html(toHTML(content));
        div.style("display", "block").style("visibility", "hidden");
        const r = div.node().getBoundingClientRect();
        cachedSize = { w: r.width, h: r.height };
        div.style("visibility", "visible").call(hide); // moveが呼ばれるまで隠しておく
    };
    function move(e) {
        if (!e || !cachedSize.w || (map.isEditable && !map.isEditable())) return hide();
        const { width, height } = map; // mapのサイズ（毎回変わらないなら外に出せるが、リサイズ考慮ならここ）
        const { x, y } = e, { w, h } = cachedSize; // キャッシュしたサイズを使用（高速化）
        const osx = map.isTouchDevice ? 40 : 15; // 指で隠れないようタッチは大きめに
        const osy = -h / 2; // 垂直方向は中央揃え
        const left = (x + osx + w > width) ? (x - w - osx) : (x + osx);
        let top = y + osy;
        if (top < 0) top = 0;
        else if (top + h > height) top = height - h;
        div.style("top", top + "px").style("left", left + "px").call(show);
    }
}
//------------------------------------------------------tip---------------------------------
export function pop(opts = {}) {
    const map = this, name = "pop";
    const toHTML = str => Array.isArray(str) ? str.map(t => `<div>${t}</div>`).join("") :
        isString(str) ? toHTML(str.split(/\n/)) : str;
    let pops = [];
    const layer = map.createLayer({ name: "PopLines", scale: 1, before: map.layers.Accessories });
    const ctx = layer.node().getContext("2d");
    map.onDrawing(name, drawing);
    const pop = (content, e) => {
        if (!content || !e) return;
        const div = map.overlays.append("div").attr("name", "pop").html(toHTML(content));
        setProp(div, opts);
        const node = div.node();
        const tip = map.select("[name=tip]");
        const close = div.append("button").classed("close", true).html(gadgetIcons.close).tip(tooltips.popClose);
        close.on("click", () => { pops = pops.filter(t => t != div); div.remove(); drawing(); });
        const pin = div.append("button").classed("pin", true).html(gadgetIcons.pin).tip(tooltips.lock);
        pin.on("click", () => { close.showIF(!(div.locked = pin.toggleClass("on"))); div.style("cursor", div.locked ? "default" : "grab"); });
        div.on("mouseenter", () => tip.style("display", "none"));
        div.on("mouseleave", () => tip.style("display", "block"));
        div.on("click", e => e.stopPropagation());//<===重要
        div.on("mousedown touchstart", e => {
            e.preventDefault(); e.stopPropagation();
            if (div.locked) return;
            const [x0, y0] = map.pointer(e);
            const { offsetLeft, offsetTop } = node;;
            div.style("cursor", "grabbing");
            const w = d3.select(window);
            w.on("mousemove.drag touchmove.drag", e => {
                e.preventDefault(); e.stopPropagation();
                const [x1, y1] = map.pointer(e);
                const [x, y] = [offsetLeft + x1 - x0, offsetTop + y1 - y0];
                div.style("left", x + "px").style("top", y + "px");
                const r = node.getBoundingClientRect();
                div.pos = [x + r.width / 2, y + r.height / 2];
                drawing();
            }, { passive: false });
            w.on("mouseup.drag touchend.drag", e => {
                if (e) e.stopPropagation();
                w.on(".drag", null); div.style("cursor", "");
            });
        }, { passive: false });
        setPosition(e);
        div.coords = [e.lng, e.lat];
        pops.push(div);
        drawing();
        function setPosition(e) {
            const { width, height } = map;
            const r = node.getBoundingClientRect();
            const { x, y } = e, h = r.height, w = r.width;
            const osx = map.isTouchDevice ? 40 : 10, osy = -h / 2;
            const left = x + osx + w > width ? x - w - osx : x + osx;
            const top = (y + osy < 0) ? 0 : (y + h + osy > height) ? height - h : y + osy;
            div.style("top", top + "px").style("left", left + "px");
            div.pos = [left + r.width / 2, top + r.height / 2];
        }
    }
    pop.clear = flag => {
        pops = pops.filter(t => (flag !== true && t.locked) ? true : (t.remove(), false));
        drawing();
    };
    return pop;
    function drawing() {
        layer.clear(); if (!map.isEditable()) return;
        pops.forEach(t => {
            let p = map.tester(t.coords); if (!p) return t.hide();
            t.show();
            ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...t.pos);
            ctx.strokeStyle = "white"; ctx.lineWidth = 3; ctx.stroke();
            ctx.strokeStyle = "black"; ctx.lineWidth = 2; ctx.stroke();
            ctx.beginPath();
            ctx.arc(p[0], p[1], 5, 0, Math.PI * 2, true);
            ctx.fillStyle = "white"; ctx.fill();
            ctx.strokeStyle = "black"; ctx.lineWidth = 1; ctx.stroke();
        });
    }
}
//---------------------------------------------------------------------------------------
export function contextmenu(opts = {}) {
    const map = this, name = "contextmenu";
    const div = map.overlays.append("div").attr("name", name).hide();
    setProp(div, opts);
    div.on("mousemove touchmove", e => e.stopPropagation(), { passive: true });
    div.on("mouseleave", () => div.hide());
    let content = null;
    //	map.on('contextmenu', func, {passive:true});
    map.onContextMenu(name, func);
    return a => content = a;
    function func(e) {
        if (!Array.isArray(content)) return div.hide();
        div.css({ top: (e.offsetY - 5) + "px", left: (e.offsetX - 5) + "px" }).empty().show();
        content.forEach(t => {
            div.append("p").html((t.icon || "") + `<span>${t.name}</span>`)
                .on("click", e => { e.stopPropagation(); t.func && t.func(map); div.hide(); }, { passive: true });
        });
    }
}
