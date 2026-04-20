import * as d3 from 'd3';
import { geopbf } from "geopbf";
import { comma } from "../../common/src/utility.js";
//import { borderJSONs } from "./modules/borderJSONs.js"

export function createAccessories(map, opts) {
    const layer = map.createLayer({ name: "Accessories", append: map.mapFrame });
    const context = layer.context;
 
    Object.entries({ latlng, scale, credit, globe, night })
        .forEach(([name, func]) => map[name] = function () { return func.apply(map, arguments) });
    opts.latlng === false || map.latlng();//左下の緯度経度標高表示
    opts.scale === false || map.scale();//中央下のスケール表示
    opts.credit === false || map.credit();//右下のクレジット
    opts.globe === false || map.globe();//右下の地球の表示
    opts.night === false || map.night();//zoom2以下で時計を表示
    ////--------------------------------------------------------- 左下の緯度・経度・標高
    function latlng() {
        const map = this, name = "latlng";
        const {lang} = map.resources
        const _lat = { ja: "緯度", en: "LAT", zh: "纬度", ko: "위도" }[lang];
        const _lng = { ja: "経度", en: "LNG", zh: "经度", ko: "경도" }[lang];
        const _alt = { ja: "標高", en: "ALT", zh: "海拔", ko: "고도" }[lang];
        let str = "";
        map.onMove(name, move).onLeave(name, clear).onDrawing(name, draw);
        async function move(q) {
            if (!q || !map.isEditable()) return clear();
            const h = await map.getHeight(q.lng, q.lat, q.zoom);
            str = `${_lat}: ${q.lat.toFixed(6)} ${_lng}: ${q.lng.toFixed(6)}${h ? ` ${_alt}: ${h.toFixed(1)}[m]` : ""}`;
            draw();
        }
        async function draw() {
            clear();
            context.save();
            context.font = "12px Verdana"; context.textBaseline = "middle"; context.fillStyle = "white";
            context.textAlign = map.isNarrow ? "center" : "left";
            context.fillText(str, map.isNarrow ? map.width / 2 : 10, map.isNarrow ? 10 : map.height - 10);
            context.restore();
        }
        function clear() {
            const w = 350, h = 25;
            map.isNarrow ? context.clearRect((map.width - w) / 2, 0, w, h) : context.clearRect(0, map.height - h, w, h);
        }
    }
    ////--------------------------------------------------------- 中央下のスケール・ズーム
    function scale() {
        const map = this, name = "scale";
        const dpr = window.devicePixelRatio || 1;
        const W0 = 300, H0 = 30, W = W0 * dpr, H = H0 * dpr, M = W0 / 2, R = 6372000 * 2; // 地球の直径
        const { PI, floor, log10 } = Math;
        const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr)
        map.onDrawing(name, draw); draw();
        function draw() {
            const [w, h] = [map.width, map.height];
            const [n, v] = (function () {
                const n = (R * PI) / 2 ** map.zoom; // 256ピクセルでの距離
                const r = 10 ** floor(log10(n));
                const m = n / r;
                const v = m > 5 ? 5 : m > 2 ? 2 : 1;
                return [256 * v / m, v * r];
            })();
            ctx.clearRect(0, 0, W, H);
            let str = (v < 1000 ? (v).toFixed(0) + "m" : comma((v / 1000).toFixed(0)) + "km") + " (z=" + map.zoom.toFixed(2) + ")";
            ctx.save();
            ctx.font = "12px Verdana"; ctx.textBaseline = "bottom"; ctx.textAlign = "center";
            ctx.strokeStyle = ctx.fillStyle = "white";
            ctx.beginPath();
            ctx.moveTo(M - n / 2, 20); ctx.lineTo(M + n / 2, 20);
            ctx.lineWidth = 3; ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(M - n / 2, 10); ctx.lineTo(M - n / 2, 25);
            ctx.moveTo(M + n / 2, 10); ctx.lineTo(M + n / 2, 25);
            ctx.lineWidth = 1; ctx.stroke();
            ctx.fillText(str, M, 15);
            ctx.restore();
            context.drawImage(canvas, 0, 0, W, H, (w - W0) / 2, h - H0 - (map.isNarrow ? 20 : 0), W0, H0);
        }
    }
    ////--------------------------------------------------------- 右下のクレジットを挿入する関数の生成
    function credit() {
        const map = this, name = "credit";
        map.onDrawing(name, draw); draw();
        function draw() {
            context.save();
            context.font = "12px Verdana"; context.textBaseline = "middle"; context.fillStyle = "white";
            context.textAlign = map.isNarrow ? "center" : "right";
            context.fillText(map.attribution, map.isNarrow ? map.width / 2 : map.width - 10, map.height - 10);
            context.restore();
        }
    }
    ////--------------------------------------------------------- サブマップ地球(globe)
    async function globe(opts = {}) {
        const map = this, name = "globe";
        const { sphere, graticule, land110 } = map.resources.borders;
        const bottom = map.isNarrow ? 55 : 30, right = 20;
        const size0 = opts.size || 125, size = size0 * window.devicePixelRatio;
        const maxZoom = opts.maxZoom || 9;
        const canvas = new OffscreenCanvas(size, size), ctx = canvas.getContext("2d");
        const project = d3.geoOrthographic().fitExtent([[1, 1], [size - 1, size - 1]], sphere).precision(0.1);
        const path = d3.geoPath(project, ctx);
        map.onDrawing(name, draw); draw();
        function draw() {
            if (map.zoom > maxZoom || map.zoom < map.noCircle) return;
            const [w, h] = [map.width, map.height];
            const [x, y] = [w - size0 - right, h - size0 - bottom];
            const bounds = [[0, 0], [w, 0], [w, h], [0, h]].map(map.proj.invert);
            const r = map.proj.rotate(); project.rotate([r[0], r[1], 0]);
            ctx.clearRect(0, 0, ctx.canvas.clientWidth, ctx.canvas.clientHeight);
            ctx.beginPath(); path(sphere); ctx.fillStyle = "rgb(200,240,255)"; ctx.fill();
            ctx.beginPath(); path(land110); ctx.fillStyle = "rgb(160,200,160)"; ctx.fill();
            ctx.beginPath(); path(graticule); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1; ctx.stroke();
            ctx.beginPath(); path(sphere); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2; ctx.stroke();
            ctx.beginPath(); bounds.map(project).forEach((t, i) => ctx[i ? "lineTo" : "moveTo"](t[0], t[1])); ctx.closePath();
            ctx.strokeStyle = "rgb(100,0,0)"; ctx.lineWidth = 2; ctx.stroke();
            context.drawImage(canvas, 0, 0, size, size, x, y, size0, size0);
        }
    }
    ////--------------------------------------------------------- 昼夜：時間表示
    async function night() {
        const { sin, cos, asin, hypot, atan2, PI } = Math, rad = PI / 180;
        const map = this, name = "night";
        const strrsJSON = (await geopbf("stars.8")).geojson;
        const stars = strrsJSON.features.map(f => {
            const c = f.geometry.coordinates, p = f.properties;
            const bv = (v => v < -0.3 ? "#b2c8ff" : v < 0.0 ? "#d9e2ff" : v < 0.3 ? "#f8faff" : v < 0.6 ? "#fff8f0" :
                v < 0.8 ? "#fff2c8" : v < 1.1 ? "#ffe0b5" : v < 1.4 ? "#ffcc99" : "#ffab91")(p.bv);
            return { x: c[0] * rad, y: c[1] * rad, bv, a: 1 - p.mag / 8, mag: p.mag, r: (9 - p.mag) * 0.25 };
        });
        const getSidereal = d => ((18.697374 + 24.0657098 * ((d.getTime() + d.getTimezoneOffset() * 60000) / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360;
        function draw() {
            if (map.isEditable()) return;
            const dt = new Date();
            const cx = map.width / 2, cy = map.height / 2, z = map.zoom || 0;
            const er = map.proj.scale(), er2 = er * er;
            const sr = hypot(map.width, map.height) * (0.4 + z * 0.3);
            const r = map.proj?.rotate() || [0, 0, 0];
            const skyRot = (getSidereal(dt) - r[0]) * rad;
            const sφ = sin(r[1] * rad), cφ = cos(r[1] * rad), sγ = sin(r[2] * rad), cγ = cos(r[2] * rad);
            layer.clear(); context.save();
            for (let s of stars) {
                const l = s.x - skyRot, cl = cos(l), sl = -sin(l);
                const cp = cos(s.y), sp = sin(s.y);
                const x = cp * sl, y = cφ * sp - sφ * cp * cl, z = sφ * sp + cφ * cp * cl; if (z < 0) continue;
                const px = cx + sr * (x * cγ - y * sγ), py = cy - sr * (x * sγ + y * cγ);
                const dx = px - cx, dy = py - cy;
                if (dx * dx + dy * dy < er2 || px < 0 || px > map.width || py < 0 || py > map.height) continue;
                context.fillStyle = s.bv; context.globalAlpha = s.a;
                context.beginPath(); context.arc(px, py, s.r || 0.5, 0, PI * 2); context.fill();
            }
            context.restore(); context.save();
            const halo = context.createRadialGradient(cx, cy, er, cx, cy, er + 15);
            halo.addColorStop(0, "rgba(100, 150, 255, 0.05)"); halo.addColorStop(1, "rgba(100, 150, 255, 0)");
            context.fillStyle = halo;
            context.beginPath(); context.arc(cx, cy, er + 15, 0, PI * 2); context.fill();
            context.beginPath(); context.arc(cx, cy, er, 0, PI * 2); context.clip();
            layer.drawJSON(nightJSON(dt, 0), { fill: "rgba(0, 5, 20, 0.2)" });
            layer.drawJSON(nightJSON(dt, 3), { fill: "rgba(0, 5, 20, 0.2)" });
            layer.drawJSON(nightJSON(dt, -3), { fill: "rgba(0, 5, 20, 0.2)" });
            context.restore();
            const L2 = n => n.toString().padStart(2, '0');
            context.textAlign = "center"; context.textBaseline = "middle"; context.fillStyle = "#fff";
            context.font = `${32 * (2 - z) + 16}px Verdana`;
            context.fillText(`${L2(dt.getHours())}:${L2(dt.getMinutes())}:${L2(dt.getSeconds())}`, cx, map.height / 5);
            context.font = `${12 * (2 - z) + 8}px Verdana`;
            context.fillText(`${dt.getFullYear()}/${L2(dt.getMonth() + 1)}/${L2(dt.getDate())} (${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()]})`, cx, map.height * 0.85);
        }
        function nightJSON(date, offset = 0) {
            if (!date) return;
            const fix = n => (n + 180) % 360 - (n < -180 ? -180 : 180);
            const d = date.getTime() / 864e5, y = (d / 365.24 % 1 - 0.225) * PI * 2;
            const lon = fix(d % 1 * -360 + 180 + offset), lat = 23.4 * sin(y);
            const ra = 90 * rad, phi = lat * rad, lam = lon * rad;
            const coords = Array.from({ length: 31 }, (_, i) => {
                const a = (360 - i * 360 / 30) * rad;
                const lt2 = asin(sin(phi) * cos(ra) + cos(phi) * sin(ra) * cos(a));
                const ln2 = lam + atan2(sin(a) * sin(ra) * cos(phi), cos(ra) - sin(phi) * sin(lt2));
                return [fix(ln2 * 180 / PI), lt2 * 180 / PI];
            });
            return { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] } };
        }
        setInterval(draw, 1000);
        map.onDrawing(name, draw);
        draw();
    }
}