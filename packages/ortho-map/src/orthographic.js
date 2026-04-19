import * as d3 from 'd3';
import "common/src/d3/selection.js";
import "common/src/d3/fileio.js";
import { isString, isFunction } from "common/src/utility.js"; 
import { cleanup } from "common/src/d3/tip-pop.js";
import { Cache } from "native-bucket/src/Cache.js";
import versor from "versor";

export async function orthographic(map, opts = {}) {
    map.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    map.projectionName = "orthographic"; // プロジェクション名
    map.minZoom = 1; // 地図の最小ズーム値
    map.minEdit = 2; // 地図の編集が可能なズーム値
    map.threshold = 5.5; // baseとtileの切り替えズーム値
    map.maxBorder = 6; // ボーダー・レチクルを表示するズーム値
    map.maxZoom = 22; // 地図の最大ズーム値
    map.refreshRate = 4; // リフレッシュの間引き
    map.simultaneousTileLoading = 4; // タイルを読み込み・加工させるワーカーの数
    map.zoomSensitivity = 0.5; // ズームの感度(0.5~2.0)
    map.stat = await Cache("GIS/stat").catch(console.error); // 
    map.baseName = await map.stat("base") || "osm.street";// ベースの地図
    map.view = await map.stat("view") || [[135, 35, 0], 2]; // [[経度,緯度,回転],ズーム値]
    ////-------------------------------------------------------------------------------------------
    //// オプションによる初期値の変更
    ////-------------------------------------------------------------------------------------------
    ("baseName" in opts) && (map.baseName = opts.baseName);
    ("center" in opts) && Array.isArray(opts.center) && (map.view[0][0] = -opts.center[0], map.view[0][1] = -opts.center[1]);
    ("zoom" in opts) && (map.view[1] = opts.zoom);
    ("minEdit" in opts) && (map.minEdit = opts.minEdit);
    ("threshold" in opts) && (map.threshold = opts.threshold);
    ("range" in opts) && Array.isArray(opts.range) && ([map.minZoom, map.maxZoom] = opts.range);
    ("minZoom" in opts) && (map.minZoom = opts.minZoom);
    ("maxZoom" in opts) && (map.maxZoom = opts.maxZoom);
    ("maxBorder" in opts) && (map.maxBorder = opts.maxBorder);
    ("zoomSensitivity" in opts) && (map.zoomSensitivity = opts.zoomSensitivity);
    ("refreshRate" in opts) && (map.refreshRate = opts.refreshRate);
    ("simultaneousTileLoading" in opts) && (map.simultaneousTileLoading = opts.simultaneousTileLoading);
    ////-------------------------------------------------------------------------------------------
    const tileSize = 256, tau = Math.PI * 2, tileSizeOrtho = tileSize / tau;
    const zval2scale = v => Math.pow(2, v) * tileSizeOrtho;
    const scale2zval = v => Math.log2(v / tileSizeOrtho);
    ////------------------------------------------------------------------------------------------------
    const proj = map.proj = d3.geoOrthographic().rotate(map.view[0]).scale(zval2scale(map.view[1]));
    const Events = ["Enter", "Move", "Leave", "Drop", "Click", "Drawing", "Drawn", "ContextMenu", "Resize", "Change", "LoadStart", "LoadEnd"];
    const dispatcher = map.dispatcher = d3.dispatch(...Events);
    const trigger = (name, param) => dispatcher.call(name, map, param, { passive: true })
    const cursor = t => map.style("cursor", t || "default");
    const initZoom = () => map.property("__zoom", d3.zoomIdentity.scale(proj.scale()));
    const pointer = e => d3.pointer(e, map.node());
    const pointers = e => d3.pointers(e, map.node());
    const isEditable = () => map.zoom >= map.minEdit;
    const xy2pos = ([x, y]) => (Math.hypot(x - map.width / 2, y - map.height / 2) < proj.scale()) ? proj.invert([x, y]) : null;
    ///------------------------------------------------------------------------------------------------
    /// PAN & ZOOM (ctrl/metaKeyの場合は回転)
    ///------------------------------------------------------------------------------------------------
    let refreshCounting = 0;
    function tween() { (++refreshCounting % (map.refreshRate || 1)) || draw(); }
    function draw() { getView(); requestAnimationFrame(() => trigger("Drawing", { proj, zoom: map.zoom })); }
    function drawn() {
        cursor(); initZoom();
        map.stat("view", getView());
        trigger("Drawn", { proj, zoom: map.zoom });
    }
    ////-------------------------------------------------------------------------------------------
    {
        const isCtrl = e => e.metaKey || e.ctrlKey, isShift = e => e.shiftKey;
        const getInfo = e => {
            e = e.sourceEvent || e;
            const zoom = map.zoom, metaKey = isCtrl(e), shiftKey = isShift(e);
            const [x, y] = pointer(e);
            const pos = xy2pos([x, y]); if (!pos) return null;
            const [lng, lat] = pos;
            return { lng, lat, x, y, shiftKey, metaKey, proj, zoom };
        };
    //    const versor = await Resources.versor();
        const { cartesian, delta, multiply, rotation } = versor;
        ////-------------------------------------------------------------------------------------------
        panZoom(map).on("start.ortho", onstart).on("zoom.ortho", tween).on("end.ortho", drawn);
        function onstart() { cleanup(); }
        ////-------------------------------------------------------------------------------------------
        function panZoom(map) { //const proj = map.proj;
            const { sin, cos, sign, sqrt, atan2, PI } = Math;
            const angle = t => atan2(t[1][1] - t[0][1], t[1][0] - t[0][0]);
            let v0, q0, r0, a0, tl = 0, pt0;
            const zoom = d3.zoom().wheelDelta(e => -e.deltaY * (0.002 * map.zoomSensitivity))
                .filter(e => e.type === "wheel" ? !isCtrl(e) : e.type.match(/touch/) ? e.touches.length > 1 : true)
                .on("start", started, { passive: true }).on("zoom", zoomed, { passive: true });
            map.scaleExtent = range => zoom.scaleExtent(range);
            initZoom();
            return map.call(zoom), { on(type, ...options) { zoom.on(type, ...options); return this; } };
            function point(e) { // returns [x, y, 角度(atan2)]
                const t = pointers(e);
                if (t.length !== tl) { tl = t.length; started(e); }
                return tl == 1 ? t[0] : [d3.mean(t, p => p[0]), d3.mean(t, p => p[1]), angle(t)];
            }
            function started(e) {
                cursor("crosshair");
                pt0 = point(e);
                a0 = pt0[2];
                v0 = cartesian(proj.invert(pt0));
                q0 = versor((r0 = proj.rotate()));
            }
            function zoomed(e) {
                proj.scale(e.transform.k);
                const pt = (e.sourceEvent && e.sourceEvent.type == "wheel") ? pt0 : point(e);
                const v1 = cartesian(proj.rotate(r0).invert(pt));
                const d = delta(v0, v1);
                let q1 = multiply(q0, d);
                if (a0 && pt[2]) {
                    var a = (pt[2] - a0); a += a > PI ? -PI * 2 : a < -PI ? PI * 2 : 0; a /= 2;
                    const s = -sin(a), c = sign(cos(a));
                    q1 = multiply([sqrt(1 - s * s), 0, 0, c * s], q1);
                }
                proj.rotate(rotation(q1));
            }
        }
        ////-------------------------------------------------------------------------------------------
        {
            let timer = null;
            map.on("wheel", rotate, { passive: true }); // カーソルを中心に回転
            function rotate(e) {
                if (!isCtrl(e)) return false;
                cursor("crosshair");
                const { sin, cos, sqrt } = Math;
                const p = pointer(e);
                const r = proj.scale();
                const c = proj.translate();
                const [x, y] = [p[0] - c[0], p[1] - c[1]];
                const sumSq = x * x + y * y; if (sumSq > r * r) return;
                const z = sqrt(r * r - sumSq);
                const angle = e.deltaY * 0.002 * map.zoomSensitivity;
                const k = sin(angle / 2) / r; // 係数
                const rot = [cos(angle / 2), -y * k, -x * k, z * k];
                const cur = versor(proj.rotate());
                const v = versor.multiply(rot, cur);
                const d = sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2 + v[3] ** 2);
                proj.rotate(versor.rotation(v.map(t => t / d)));
                tween();
                clearTimeout(timer); timer = setTimeout(drawn, 250);
            }
        }
        ////-------------------------------------------------------------------------------------------
        map.on("contextmenu", e => trigger("ContextMenu", e));
        map.on("dblclick.zoom", null);//ダブルクリックで拡大しない!!!
        ////------------------------------------------------------------------------------------------------	
        map.on("click", e => trigger("Click", getInfo(e)), { passive: true });
        map.on("mousemove touchmove", e => trigger("Move", getInfo(e)), { passive: true });
        map.on("mouseenter touchstart", e => trigger("Enter", getInfo(e)), { passive: true });
        map.on("mouseleave mouseout touchend", e => trigger("Leave", {}));
        map.dropFile(file => trigger("Drop", file));
    } {////------------------------------------------------------------------------------------------------	
        const funcs = {
            draw, trigger, resize, isEditable, cursor, bbox, setRange, setView, setZoom,
            setFeature, flyToFeature, mag, north, /*projectTester,*/ tester, xy2pos, zval2scale, scale2zval, pointer, pointers
        };
        Object.entries(funcs).forEach(([name, func]) => map[name] = func);
    } {////------------------------------------------------------------------------------------------------	
        const eventNumber = {}, eventTub = {};
        function makeEvent(event) {
            const D4 = n => ("0000" + n).slice(-4);
            return (header, func) => {
                if (isFunction(header) && func === undefined) {
                    func = header; // User Events
                    const num = (eventNumber[event] = (eventNumber[event] || 0));
                    header = D4(eventNumber[event] = num + 1);
                    const name = `${event}.${header}`;
                    console.log(`New user event ("${name}") is settled.`);
                    dispatcher.on(name, func);
                    const ev = eventTub[event] = eventTub[event] || {};
                    func == null ? (delete ev[header]) : ev[header] = func;
                    func.destroy = () => { dispatcher.on(name, null), func = null };
                    return func;
                } else if (isString(header) && isFunction(func)) { // System Events
                    dispatcher.on(`${event}.${header}`, func);
                    const ev = eventTub[event] = eventTub[event] || {};
                    func == null ? (delete ev[header]) : ev[header] = func;
                    return map;
                } else console.warn("illegal event:", header, func)
            };
        }
        Events.forEach(t => map["on" + t] = makeEvent(t));
        let calceledEventList = [];
        map.cancelEvent = name => { //debugger
            Object.entries(eventTub[name] || {})
                .forEach(([header, func]) => { calceledEventList.push([name, header, func]); dispatcher.on(`${name}.${header}`, null) })
        };
        map.restoreEvent = name => {
            calceledEventList = calceledEventList.filter(([event, header, func]) => {
                dispatcher.on(`${event}.${header}`, func);
                return name != event;
            });
        };
        map.eventList = () => {
            Object.entries(eventTub).forEach(([name, events]) => console.log(`Event ${name}: ${Object.keys(events).join(" ")}`))
        };
    } {////------------------------------------------------------------------------------------------------	
        let timer = null;
        window.addEventListener("orientationchange", resize);
        window.addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(resize, 50); });
        resize();
    }
    ////===================================================================================================================
    function getView() {
        map.view = [proj.rotate(), map.zoom = scale2zval(proj.scale())];
        map.center = [-map.view[0][0], -map.view[0][1]];
        map.angle = map.view[0][2];
        return map.view;
    }
    ////-------------------------------------------------------------------------------------------
    function resize() {
        const [width, height] = [map.width, map.height] = map.getSize();
        const rotate = proj.rotate(), scale = proj.scale();
        proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
        proj.rotate(rotate).scale(scale);
        map.isNarrow = width < 1000;
        map.noCircle = scale2zval(Math.hypot(width, height) / 2);
        map.radius =
            trigger("Resize", { width, height });
        getView();
        draw();
    }
    ////-------------------------------------------------------------------------------------------
    function tester(q) {
        if (d3.geoDistance(map.center, q) > Math.PI / 2) return null;
        const [x, y] = proj(q);
        return (x < 0 || x > map.width || y < 0 || y > map.height) ? null : [x, y];
    }
    ////-------------------------------------------------------------------------------------------
    function bbox(q, maxZoom = map.maxZoom) {
        return q ? setBBOX(q) : getBBOX();
        function getBBOX() {
            const [w, h] = [map.width, map.height];
            const bbox = c => {
                let v = [Infinity, Infinity, -Infinity, -Infinity];
                c.forEach(([x, y]) => v = [Math.min(x, v[0]), Math.min(y, v[1]), Math.max(x, v[2]), Math.max(y, v[3])]);
                return v;
            };
            let [x0, y0, x1, y1] = bbox([[0, 0], [w / 2, 0], [w, 0], [0, h / 2], [w / 2, h / 2], [w, h / 2],
            [0, h], [w / 2, h], [w, h]].map(proj.invert));
            if (tester([0, 90])) x0 = -180, x1 = 180, y1 = 90;
            if (tester([0, -90])) x0 = -180, x1 = 180, y0 = -90;
            return [x0, y0, x1, y1];
        };
        function setBBOX(q) {
            const [x0, y0, x1, y1] = q;
            const feature = {
                type: "Polygon",
                coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]
            };
            setFeature(feature, maxZoom);
        }
    };
    ////-------------------------------------------------------------------------------------------
    function setZoom(zoom) {
        proj.scale(zval2scale(zoom));
        map.stat("view", getView());
        initZoom();
        draw();
    }
    function setView(center, zoom, angle = 0) {
        proj.rotate([-center[0], -center[1], angle]);
        setZoom(zoom)
    }
    function setRange(min, max) {
        map.scaleExtent([zval2scale(min), zval2scale(max)]);
    }
    ////-------------------------------------------------------------------------------------------
    function setFeature(feature, maxZoom = map.maxZoom) {
        const { width, height } = map;
        const c = d3.geoCentroid(feature);
        const p = d3.geoOrthographic().rotate([-c[0], -c[1], 0])
            .fitExtent([[width * 0.05, height * 0.05], [width * 0.95, height * 0.95]], feature);
        const zval = Math.min(scale2zval(p.scale()), maxZoom)
        setView([c[0], c[1]], zval);
    }
    ////-------------------------------------------------------------------------------------------
    async function flyToFeature(feature, opts = {}) {
        const { width, height, maxZoom } = map;
        const size = Math.min(width, height);
        const r0 = proj.rotate(), s0 = proj.scale();
        const dst = d3.geoCentroid(feature);// 目的地
        const r1 = [-dst[0], -dst[1], 0]; // 最終的な回転 [λ, φ, 0] ←ここを0に固定
        const p = d3.geoOrthographic().rotate(r1)　// 目的地でのスケール計算
            .fitExtent([[width * 0.05, height * 0.05], [width * 0.95, height * 0.95]], feature);
        const s1 = opts.keep ? s0 : opts.zoom ? zval2scale(opts.zoom) : Math.min(p.scale(), zval2scale(maxZoom));
        const dist = d3.geoDistance([-r0[0], -r0[1]], dst);// ズーム補間用のパラメータ
        const zooming = d3.interpolateZoom([0, 0, size / s0], [dist, 0, size / s1]);
        const interpolateRotation = d3.interpolateArray(r0, r1);// 回転の補間（3軸すべてを考慮）
        return d3.transition().duration(zooming.duration).ease(d3.easeLinear)
            .tween("render", () => {
                return t => {
                    const z = zooming(t);
                    proj.rotate(interpolateRotation(t)); // 全ての軸を0に向かって補間
                    proj.scale(size / z[2]);
                    tween();
                };
            })
            .end().then(drawn);
    }
    ////-------------------------------------------------------------------------------------------
    function mag(n, duration = 1000) {
        const scale = proj.scale();
        const maxScale = zval2scale(map.maxZoom);
        const minScale = zval2scale(map.minZoom);
        return d3.transition().ease(d3.easeCubic).duration(duration)
            .tween("render", () => t => { proj.scale(Math.max(Math.min((1 + (n - 1) * t) * scale, maxScale), minScale)); tween(); })
            .on("end", drawn).end();
    }
    ////-------------------------------------------------------------------------------------------
    function north(duration = 1000) {
        const zaxis = proj.rotate()[2];
        return d3.transition().ease(d3.easeCubic).duration(duration)
            .tween("render", () => t => { let r = proj.rotate(); r[2] = (1 - t) * zaxis; proj.rotate(r); tween(); })
            .on("end", drawn).end();
    }
}