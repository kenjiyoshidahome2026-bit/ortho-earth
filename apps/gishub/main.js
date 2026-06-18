import * as d3 from "d3";
import orthoMap from 'ortho-map';
import { geopbf, setApiUrl } from "geopbf";

const API_BASE = "https://api.ortho-earth.com";
const TILER_BASE = "https://tiler.ortho-earth.com";
setApiUrl(API_BASE);
const hubCache = await Cache("GISHUB").catch(() => null);
import { screenLogger } from "./screenLogger.js";
import { comma, download, openDirectory, saveTo, inputFile, isString } from "common";
import { Cache } from "native-bucket";
import "common/d3/highlight.js";
import "common/d3/fileio.js";
import "./main.scss";
const initialZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight)/2*0.5 / 256 * Math.PI * 2);
const mapInst = (await orthoMap({target:d3.select('body'), center:[0,0], zoom: initialZoom, accessories:{clock:false}, tilerBase: TILER_BASE, apiUrl: API_BASE})).autoRotate(true);
const exitButton = mapInst.append("button").attr("class", "close").html(`<img src="close.svg"/>`)
    .on("click", exitView).hide();
const identifyTip = mapInst.append("div").attr("class", "identify-tip").hide();
const gishub = d3.select("body").append("div").attr("class", "gishub");
////------------------------------------------------------
const left = gishub.append("aside").attr("class", "left");
const groups = (a => { const tub = new Map();
    a.forEach(d => {
        const group = tub[d.attribution] = tub[d.attribution] || { group: d.attribution, contents: [] };
        group.contents.push(d);
    });
    return Object.values(tub);
})(await d3.json("./catalog.json"));
left.append("img").attr("src", "menu.svg").attr("alt", "MENU").on("click", () => gishub.classed("close", !gishub.classed("close")))	;
left.append("input").attr("type", "text").attr("name", "search").attr("placeholder", "Search...")
.on("input", function() {
	const keyword = this.value.trim().toLowerCase(), exist = s => s.toLowerCase().includes(keyword);
	const hasKeyword = d => exist(d.name) || exist(d.description) || exist(d.license);
	left.selectAll(".group").style("display", d => (d.contents.some(c => hasKeyword(c))|| exist(d.group))? null : "none").highlight(keyword);
	left.selectAll(".card").style("display", d => hasKeyword(d) ? null : "none").highlight(keyword);
});
const section = left.append("nav").selectAll(".group").data(groups).join("section").attr("class", "group");
section.append("h2").text(d => d.group);
section.selectAll(".card").data(d => d.contents).join("button").attr("class", "card")
	.html(d => `<div class="name">${d.name}</div><div class="desc">${d.description}</div><div class="license">${d.license}</div>`)
	.on("click", (e, d) => exec(d));
////------------------------------------------------------
const reset = () => { logger.clear(); tables.empty().hide(); uploads.show(); left.selectAll(".card").attr("disabled", null); };
const main = gishub.append("main").attr("class", "main");
main.append("h1").html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`).on("click", reset);
////------------------------------------------------------
const logger = new screenLogger(main.append("div"));
const tables = main.append("div").attr("class","tables").hide();
////------------------------------------------------------
//console.log(await fetch("https://www.geospatial.jp/ckan/dataset/aigid-moj-04101/resource/e8936e86-0d81-44e0-a51b-4eb04fb511d0/download/04101__10_r_2025.geojson"));

const fname = s => s.split('/').pop().split('?')[0].replace(/\..+$/i, '');
const uploads = main.append("div").attr("class", "uploads").dropFile(f=>exec({name:fname(f.name), target:f, description:"dropped file"}));
uploads.append("p").text(`GIS-HUB is a next-generation, high-performance web GIS station powered by an in-memory binary engine (GeoPBF) and WebGL2 rendering (ortho-map).
 It effortlessly unifies heavy open data into a fluid, zero-latency 3D map inside your browser.`);
uploads.append("h2").text("🔬 Quick Start Guide");
uploads.append("ul").html(`
    <li><b>Explore Catalog: </b>Click sidebar cards to fetch open data on the fly.</li>
    <li><b>Bring Data: </b>Drag & drop a file, double-click to browse, or enter a URL.</li>
    <li><b>On-the-fly zip extraction: </b>zip-url#file-name is available.</li>
    <li><b>Visualize: </b>Click "View in Ortho-Map" for a buttery-smooth WebGL2 experience.</li>
    <li><b>Convert: </b>Export seamlessly to FlatGeobuf, GeoPBF, or traditional GIS formats.</li>
`);
uploads.append("img").attr("src", "gishub.svg");
uploads.append("input").attr("type","text").attr("placeholder", `"Enter URL" or "Drag & drop a file" or "Double-click to select file."`)
.on("keypress", function (e) { if (e.key === "Enter" && /^https?:\/\//.test(this.value)) exec({ name: fname(this.value), target: this.value, description: "input url" }); })
.on("dblclick", function () { inputFile().then(f => f && exec({ name: fname(f.name), target: f, description: "selected file" }));});
////------------------------------------------------------
async function exec(info) {
    const def = {target:"", name: "", precision:6, license:"", description:"", attribution:"", link:"", nocache:false};
    const { target, name, precision, license, description, attribution, link, nocache } = Object.assign(def, info);
    try { uploads.hide(); tables.empty().hide(); logger.clear().show();
        let inExec = true, success = false; left.selectAll(".card").attr("disabled", true);
        let p = logger.title(name, description); p.style("position","sticky").style("top","10px").style("zindex",1)
        link && p.style("cursor", "pointer").on("click", () => open(link, "_link_"));
        p = logger.log(`Requesting: ${target.name || target} <span class="cancel">cancel</span>`)
        const cancel = p.select("span").hide().on("click", () => location.reload());
        setTimeout(() => inExec && cancel.show(),1000);
        let pbf = await geopbf(target, { name, precision, license, description, attribution, nocache });
        if (pbf && pbf.length) { success = true;
            logger.success(`${name} (length: ${comma(pbf.size)})`);
            p = logger.empty();
            const cacheKey = typeof target === 'string' ? target : null;
            const cached = cacheKey && !nocache && hubCache && await hubCache(cacheKey).catch(() => null);
            if (cached?.PREVIEW && cached?.PROFILE) {
                const bitmap = await createImageBitmap(cached.PREVIEW);
                const cv = p.append("canvas").node();
                cv.width = bitmap.width, cv.height = bitmap.height;
                cv.style.width  = (bitmap.width  / 2) + "px";
                cv.style.height = (bitmap.height / 2) + "px";
                cv.getContext("2d").drawImage(bitmap, 0, 0);
                trimCanvas(cv);
                logger.log(cached.PROFILE);
            } else {
                const canvas = p.append("canvas").style("display", "none");
                const [bitmap, profileHtml] = await Promise.all([
                    pbf.preview(canvas.node(), {size:256, stroke:"#fff", fill:"#222", minDist:0.5, dpr:2})
                        .then(bm => { canvas.style("display", null); trimCanvas(canvas.node()); return bm; }),
                    pbf.profile({ nohead: true }),
                ]);
                logger.log(profileHtml);
                if (cacheKey && hubCache && bitmap instanceof ImageBitmap) {
                    const cv = canvas.node();
                    const oc = new OffscreenCanvas(cv.width, cv.height);
                    oc.getContext("2d").drawImage(cv, 0, 0);
                    oc.convertToBlob({ type: 'image/png', quality: 0.9 }).then(blob =>
                        hubCache(cacheKey, { PREVIEW: blob, PROFILE: profileHtml }).catch(console.error)
                    );
                }
            }
        } else logger.error("Failed to load data.");
        inExec = false; left.selectAll(".card").attr("disabled", null); cancel.hide();
        p = logger.empty(); p.append("span").text("🔔 [ACTIONs]").classed("big",true);
        success && p.append("button").classed("accent", true).text("View in Ortho-Map").on("click", () => execView(pbf));
        success && p.append("button").text("Show Property Table").on("click", showProp);
        attribution && pbf.originalURL && p.append("button").text("Reload from original url")
        .on("click", async() => { pbf && (pbf.destroy()); exec(Object.assign({}, info, {nocache:true}));});
        p.append("button").text("Done").on("click", async () => { exitView(); pbf && pbf.destroy(); reset(); });
         if (!success) return;
        const save = async s => { if (!s) return; const v = await saveTo(s); if (v) logger.log(`📥 Saved: ${s.name} (${comma(s.size)} bytes)`); }
        const funcs = [
            async function GeoPBF() { save(await pbf.geopbfFile()) },
            async function GeoJSON() { save(await pbf.geojsonFile({gz: await logger.confirm("GeoJSON Gzipped", false)})); },
            async function TopoJSON() { save(await pbf.topojsonFile({gz: await logger.confirm("TopoJSON Gzipped", false)})); },
            async function FGB() { save(await pbf.fgbFile({ gz: await logger.confirm("FGB Gzipped", false)})) },
            async function KMZ() { save(await pbf.kmzFile({ kmz: await logger.select("KMZ or KML", { KMZ: true, KML: false })})); },
            async function Shape() { save(await pbf.shapeFile({encoding: await logger.prompt(`encoding (default: utf8)`, "utf8")}))},
            async function GML() { save(await pbf.gmlFile({ gz: await logger.confirm("GML Gzipped", false)})); },
            async function GPX() { save(await pbf.gpxFile({ gz: await logger.confirm("GPX Gzipped", false)})); },
        ];
        p = logger.empty();
        const active = v => logger.target.selectAll("button").attr("disabled", v ? null : true);
        p.append("span").text("📥 [DOWNLOAD]").classed("big",true);
        funcs.forEach(f => p.append("button").classed("accent", f.name === "GeoPBF").text(f.name)
            .on("click", async () => { active(false); (await openDirectory()) && await f(); active(true); }));
        function showProp() {
            const PAGE = 100;
            const data = pbf.getPropertyTable();
            const headers = data[0];
            const rows = data.slice(1);
            const pages = Math.ceil(rows.length / PAGE) || 1;
            let page = 0;
            const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const cut = s => { const t = String(s); return esc(t.length > 16 ? t.substring(0, 15) + " …" : t); };

            logger.hide();
            tables.show().html(
                `<h2>${pbf.name()}<span>${pbf.description()}</span></h2>` +
                `<div class="prop-table"><table><thead><tr>${headers.map(t => `<th>${esc(String(t))}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`
            );

            const tbody = tables.select("tbody");
            const h2 = tables.select("h2");

            function renderPage() {
                const slice = rows.slice(page * PAGE, (page + 1) * PAGE);
                tbody.html(slice.map(row => `<tr>${row.map(t => `<td>${cut(t)}</td>`).join("")}</tr>`).join(""));
                tables.select(".prop-table").node().scrollTop = 0;
            }
            renderPage();

            if (pages > 1) {
                h2.append("button").text("◀").on("click", () => { if (page > 0) { page--; pageInfo.text(`${page + 1} / ${pages}`); renderPage(); } });
                const pageInfo = h2.append("span").attr("class","page").text(`1 / ${pages}`);
                h2.append("button").text("▶").on("click", () => { if (page < pages - 1) { page++; pageInfo.text(`${page + 1} / ${pages}`); renderPage(); } });
            }
            h2.append("button").text("📥 CSV").on("click", csv);
            h2.append("button").text("📥 Excel").on("click", xls);
            h2.append("button").text("Done").on("click", () => { logger.show(); tables.empty().hide(); });
        }
        async function csv() {
            save(new File([pbf.getCSV()], pbf.name()+".csv", {type:"application/csv"}));
        }
        async function xls() {
            window.XLSX || await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
            const XLSX = window.XLSX;
            const workbook = XLSX.read(pbf.getCSV(), { type: 'string', raw: true });
            const buff = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
            save(new File([buff], pbf.name()+".xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
        }
    } catch (err) {
        logger.error(`Failed to load ${target.name || target}: ${err.message}`);
    }
}
function trimCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const px = ctx.getImageData(0, 0, w, h).data;
    const row = y => { for (let x = 0; x < w; x++) if (px[(y*w+x)*4+3]) return true; };
    let t = 0, b = h - 1;
    while (t < h && !row(t)) t++;
    if (t >= h) return;
    while (b > t && !row(b)) b--;
    if (t === 0 && b === h - 1) return;
    const dpr = w / parseFloat(canvas.style.width);
    const trimH = b - t + 1;
    const img = ctx.getImageData(0, t, w, trimH);
    canvas.height = trimH;
    ctx.putImageData(img, 0, 0);
    canvas.style.height = (trimH / dpr) + "px";
}
let _viewLayer = null;

async function execView(pbf) {
    mapInst.autoRotate(false);
    exitButton.show();
    gishub.classed("viewing", true);
    if (!pbf?.length) return;

    if (_viewLayer) { _viewLayer.destroy(); _viewLayer = null; }

    // 先にレイヤーを描画してからトラベル開始
    const { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point } = pbf.unPackGint || {};
    const hasArcs = !!(arcBuffer && arcMeta && (polygon?.length > 0 || polyline?.length > 0));
    const hasPoints = !!(pointBuffer?.length > 0);
    if (hasArcs || hasPoints) {
        _viewLayer = await mapInst.createRemoteLayer({ name: "GISHUB", type: "gint" });
        _viewLayer.set("gint", { arcBuffer, arcMeta, polygon: polygon ?? [], polyline: polyline ?? [], pointBuffer: pointBuffer ?? null, point: point ?? null });
        _viewLayer.onIdentify = (featureId, geomType, x, y) => {
            if (featureId == null) { identifyTip.hide(); return; }
            const f = pbf.getFeature(featureId);
            const props = f?.properties ?? {};
            const label = Object.values(props).find(v => typeof v === 'string') ?? `#${featureId}`;
            identifyTip.style("left", (x + 14) + "px").style("top", (y + 14) + "px")
                       .text(label).show();
        };
        _viewLayer.onClick = (featureId) => {
            const f = pbf.getFeature(featureId);
            if (!f) return;
            const entries = Object.entries(f.properties ?? {});
            if (!entries.length) return;
            const rows = entries.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
            logger.log(`<table class="identify-table">${rows}</table>`);
        };
    } else {
        const geomType = pbf.fmap[0]?.[2] ?? 4;
        const style = geomType < 2
            ? { fill: "#FF6B35", stroke: "#fff", size: 5 }
            : geomType < 4
            ? { stroke: "#00B4D8", width: 1.5 }
            : { fill: "rgba(255,107,53,0.25)", stroke: "#FF6B35", width: 0.8 };
        const features = [];
        pbf.forEach(n => features.push(pbf.getFeature(n)));
        _viewLayer = mapInst.createLayer({ name: "GISHUB" });
        _viewLayer.set("geojson", { type: "FeatureCollection", features }, style);
    }
    mapInst.draw();

    const [w, s, e, n] = pbf.bbox;
    await mapInst.zoomToFeature({ type: "Feature", geometry: {
        type: "Polygon", coordinates: [[[w,s],[w,n],[e,n],[e,s],[w,s]]]
    }, properties: {} });
}

function exitView() {
    identifyTip.hide();
    if (_viewLayer) { _viewLayer.destroy(); _viewLayer = null; }
    mapInst.setView([0,0], initialZoom);
    setTimeout(() => mapInst.autoRotate(true), 250);
    exitButton.hide();
    gishub.classed("viewing", false);
}
