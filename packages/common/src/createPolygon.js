import * as d3 from 'd3';
import {comma} from "./utility";
import {antimeridianCut} from "../../geopbf/src/modules/antimeridianCut";

export function createPolygon(layer, opts = {}) {
    const map = layer.base, { dispatcher, proj, layers, cursor, isTouchDevice, isEditable } = map;
    const ctx = layer.context;
    let points = [], cpos, isGenerating = true;
    const { color, width, dash, radius, measure } = Object.assign({ color: "#880000", width: 2, dash: [], radius: [4, 2], measure: false }, opts);
    const fill = `rgba(${[1, 3, 5].map(i => parseInt("0x" + color.substring(i, i + 2))).concat([0.1]).join(",")})`;
    cursor("crosshair");
    dispatcher.on("Drawing.polygon", render);
    isTouchDevice || dispatcher.on("Move.polygon", render);
    const reciever = map.overlays.style("pointer-events", "auto");
    const nearDef = ([px, py], err) => { const err2 = err * err; return ([x, y]) => ((px - x) * (px - x) + (py - y) * (py - y) < err2); }
    reciever.on((isTouchDevice ? "touchstart" : "mousedown") + ".generate", generate);
    layer.get = () => isGenerating ? null : turf.multiPolygon(antimeridianCut(points)).geometry.coordinates;
    layer.exit = () => {
        layer.clear();
        dispatcher.on(".polygon", null);
        reciever.on(".generate .editcoords", null).style("pointer-events", "none");
        return points;
    };
    return layer;
    ////------------------------------------------------------------------------------------------------
    function generate(e) {
        if (!e) return;
        const xy = map.pointer(e), pt = proj.invert(xy), near = nearDef(xy, 4);
        if (isTouchDevice && points.length == 2) {
            points.push(pt);
            return edit();
        }
        if (points.length > 2) {
            if (near(proj(points[points.length - 1])) || near(proj(points[0]))) return edit();
        }
        points.push(pt);
        render();
    }
    function edit() {
        isGenerating = false; cursor("grab");
        points.push(points[0]);
        reciever.on(".generate", null).on((isTouchDevice ? "touchstart" : "mousedown") + ".editcoords", move);
        function move(e) {
            if (!e) return;
            isTouchDevice || e.stopPropagation();
            const num = search(); if (num < 0) return;
            const doc = d3.select(document)
                .on("mouseup.point mouseleave.point touchend.point", () => { cursor("grab"); doc.on(".point", null); })
                .on("mousemove.point touchmove.point", e => {
                    cursor("grabbing"); //e.preventDefault(); e.stopPropagation();
                    points[num] = proj.invert(map.pointer(e));
                    num == 0 && (points[points.length - 1] = points[0]);
                    render();
                });
            function search() {
                const near = nearDef(map.pointer(e), isTouchDevice ? 12 : 6);
                for (let i = 0; i < points.length - 1; i++) if (near(proj(points[i]))) return i;
                for (let i = 0; i < points.length - 1; i++) {
                    var p = proj(turf.midpoint(points[i], points[i + 1]).geometry.coordinates);
                    if (near(p)) { points.splice(i + 1, 0, p);; return i + 1; }
                }
                return -1;
            }
        }
    }
    function render(e) {
        layer.clear();
        if (!points.length || !isEditable()) return;
        var p = [].concat(points);
        isGenerating && onGenerating();
        isGenerating && isTouchDevice && points.length == 1 && mark(p[0], radius[0]);
        var f = pts2feature(); if (!f) return null;
        draw();
        p.forEach(t => mark(t, radius[0]));
        p.map((t, i) => i ? turf.midpoint(p[i - 1], t).geometry.coordinates : null).slice(1).forEach(t => mark(t, radius[1]));
        measure && distance();
        function onGenerating() {
            cpos = (e && e.lng && e.lat) ? [e.lng, e.lat] : cpos;
            cpos && p.length >= 1 && (p = p.concat([cpos]));
            cpos && p.length >= 3 && (p = p.concat([p[0]]));
        }
        function draw() {
            const path = d3.geoPath(proj, ctx);
            ctx.beginPath(); path(f);
            ctx.fillStyle = fill; p.length > 3 && ctx.fill();
            ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash.map(t => t * width / 2)); ctx.stroke();
        }
        function mark(pos, r) {
            const [x, y] = proj(pos);
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
            ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
        }
        function pts2feature() {
            return p.length > 3 && p[0] == p[p.length - 1] ? turf.multiPolygon(antimeridianCut(p)) :
                p.length > 1 ? turf.lineString(p) : null;
        }
        function distance() {
            const radius = 6471; let sum = 0;
            const fix = (m, n = 0) => comma(m.toFixed(n));
            const FIX = d => d < 0.1 ? fix(d * 1000, 1) + " m" : d < 1 ? fix(d * 1000, 0) + " m" : d < 10 ? fix(d, 2) + " km" : d < 100 ? fix(d, 1) + " km" : fix(d, 0) + " km";
            const FIXA = d => d < 1e6 ? fix(d) + " m2" : d < 1e9 ? fix(d / 1e6, 3) + " km2" : fix(d / 1e6) + " km2";
            ctx.save();
            ctx.fillStyle = "#fff"; ctx.font = "12px Arial", ctx.shadowColor = "#000", ctx.shadowBlur = 5;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            for (let i = 0; i < p.length - 1; i++) {
                var d = d3.geoDistance(p[i], p[i + 1]) * radius; sum += d;
                ctx.fillText(FIX(d), ...proj(d3.geoInterpolate(p[i], p[i + 1])(0.5)));
            }
            if (p.length > 3) {
                const [x, y] = proj(d3.geoCentroid(f));
                ctx.fillText("L= " + FIX(sum), x, y - 8);
                ctx.fillText("S= " + FIXA(turf.area(f)), x, y + 8);
            }
            ctx.restore();
        }
    }
}