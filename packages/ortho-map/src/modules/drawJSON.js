import * as d3 from 'd3';
import { max } from "../../../common/src/utility.js";
export function drawJSON(features, prop = {}) {
    const { ctx, proj, zoom, path, width, height } = this;
    const toFeatures = a => a ? a.features ? a.features : Array.isArray(a) ? a : [a] : [];
    if (zoom < prop.minZoom || zoom > prop.maxZoom) return;
    toFeatures(features).forEach(draw);
    function draw(feature) {
        const { type, coordinates } = (feature.geometry || feature);
        const stroke = (style, width = 1, dash = []) => style && (ctx.strokeStyle = style, ctx.lineWidth = width, ctx.setLineDash(dash), ctx.stroke());
        const fill = style => (ctx.fillStyle = style, ctx.fill());
        const fillRect = style => (ctx.fillStyle = style, ctx.fillRect(0, 0, width, height));
        const p = (typeof prop == "function") ? prop(feature, zoom) : prop;
        if (type.match(/Point/)) {
            const size = p.size || 10, coords = type.match(/Multi/) ? coordinates : [coordinates];
            switch (p.type || "point") {
                case "point": ctx.beginPath();
                    coords.forEach(([x, y]) => (ctx.moveTo(x + size / 2, y), ctx.arc(x, y, size / 2, 0, Math.PI * 2, true)));;
                    fill(p.fill || "#800"), stroke(p.stroke || "#fff", p.width || size / 4, p.lineDash || []);
                    break;
                case "square":
                    ctx.fillStyle = p.fill || "#800"; ctx.strokeStyle = p.stroke || "#fff"; ctx.strokeWidth = size / 4;
                    coords.forEach(([x, y]) => (ctx.fillRect(x - size / 2, y - size / 2, size, size), ctx.strokeRect(x - size / 2, y - size / 2, size, size)));
                    break;
                case "triangle": ctx.beginPath();
                    coords.forEach(([x, y]) => (ctx.moveTo(x, y - size / 2), ctx.lineTo(x + size / 4 * Math.sqrt(3), y + size / 4), ctx.lineTo(x - size / 4 * Math.sqrt(3), y + size / 4), ctx.closePath()));
                    fill(p.fill || "#800"), stroke(p.stroke || "#fff", size / 4);
                    break;
                case "cross": ctx.beginPath();
                    coords.forEach(([x, y]) => (ctx.moveTo(x + size / 2, y), ctx.arc(x, y, size / 2, 0, Math.PI * 2, true)));;
                    fill(p.fill || "#800"), stroke(p.stroke || "#fff", prop.width || size / 4);
                    ctx.beginPath();
                    coords.forEach(([x, y]) => (ctx.moveTo(x - size, y), ctx.lineTo(x + size, y), ctx.moveTo(x, y - size), ctx.lineTo(x, y + size)));
                    stroke(p.stroke || "#fff", prop.width || size / 4);
            }
        } else if (type.match(/Polygon/)) {
            if ("fill" in p) {
                ctx.beginPath(); path(feature);
                fill(p.fill);
                stroke(p.stroke, p.width, p.dash);
                return;
            }
            if ("mask" in p) {
                ctx.save();
                fillRect(p.mask === true ? "rgba(255,255,255,0.25)" : p.mask);
                ctx.beginPath(); path(feature);
                ctx.globalCompositeOperation = "destination-out"; fill("#000");
                ctx.restore();
                stroke(p.stroke, p.width, p.dash);
            }
            if ("hatch" in p) {
                const v = calcArea(feature); if (!v) return;
                const [x, y, w, h] = [v[0], v[1], v[2] - v[0], v[3] - v[1]], r = max([w, h]);
                const delta = p.delta || 5, color = p.hatch || "red"; //console.log(color)
                ctx.save();
                ctx.beginPath(); path(feature); ctx.clip();
                ctx.beginPath(); p.mode ?
                    d3.range(0, 2 * r, delta).forEach((n, i) => (ctx.moveTo(n + x, y), ctx.lineTo(n + x - h, y + h))) :
                    d3.range(-r, r, delta).forEach((n, i) => (ctx.moveTo(n + x, y), ctx.lineTo(n + x + h, y + h)));
                stroke(color, p.hatchWidth || 1, p.dash);
                ctx.restore();
                ctx.beginPath(); path(feature);
                stroke(p.stroke || color, p.width || 2);
                return;
            }
        } else {
            ctx.beginPath(); path(feature);
            p.emboss && stroke(p.emboss === true ? "rgba(255,255,255,0.5)" : p.emboss, p.embossWidth || (p.width || 1) + 2);
            stroke(p.stroke, p.width, p.dash);
        }
        function calcArea(feature) {
            var { type, coordinates } = (feature.geometry || feature);
            if (!type.match(/Polygon/)) return null;
            let v = [Infinity, Infinity, -Infinity, -Infinity];
            (type.match(/Multi/) ? coordinates : [coordinates]).forEach(t => t[0].forEach(calc));
            return (v[0] > width || v[1] > height || v[2] < 0 || v[3] < 0) ? null : v;
            function calc(t) {
                const [x, y] = proj(t);
                v = [Math.min(v[0], x), Math.min(v[1], y), Math.max(v[2], x), Math.max(v[3], y)];
            }
        }
    }
};
export function deawText(text, pts, opts = {}, save = true) {
    var layer = this;
    let saved = false;
    if (Object.keys(opts).length) {
        layer.prop = Object.assign(layer.prop, opts);
        const { bold, fontSize, fontFamily, textAlign, textBaseline, fillStyle, lineHeight } = layer.prop;
        if (save) {
            layer.prop = { bold, fontSize, fontFamily, textAlign, textBaseline, fillStyle, lineHeight };
            console.log(layer.prop)
        } else {
            layer.save(); saved = true;
        }
        const font = [bold ? "700" : "400", fontSize + "px", fontFamily].join(" ");
        layer.font == font || (layer.font = font);
        layer.textAlign == textAlign || (layer.textAlign = textAlign);
        layer.textBaseline == textBaseline || (layer.textBaseline = textBaseline);
        layer.fillStyle == fillStyle || (layer.fillStyle = fillStyle);
    }
    pts = Array.isArray(pts[0]) ? pts : [pts];
    Array.isArray(text) && text.length == pts.length ? pts.forEach((t, i) => layer.fillText(text[i], ...t)) :
        pts.forEach(t => layer.fillText(text, ...t));
    saved && layer.restore();
};
