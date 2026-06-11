import * as d3 from "d3";
import orthoMap from 'ortho-map';
import { geopbf } from "geopbf";
import { screenLogger } from "./screenLogger.js";
import { comma, download, openDirectory, saveTo, inputFile, isString } from "common";
import "common/d3/highlight.js";
import "common/d3/fileio.js";
import "./main.scss";

const initialZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight)/2*0.5 / 256 * Math.PI * 2);
const mapInst = (await orthoMap({target:d3.select('body'), center:[0,0], zoom: initialZoom, accessories:{clock:false}})).autoRotate(true);
const exitButton = mapInst.append("button").attr("class", "close").html(`<img src="close.svg"/>`)
    .on("click", exitView).hide();
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
const reset = () => { logger.clear(); uploads.show(); left.selectAll(".card").attr("disabled", null); };
const main = gishub.append("main").attr("class", "main");
main.append("h1").html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`).on("click", reset);
////------------------------------------------------------
const logger = new screenLogger(main.append("div"));
const tables = main.append("div").attr("class","tables").hide();
////------------------------------------------------------
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
        const pbf = await geopbf(target, { name, precision, license, description, attribution, nocache });
        if (pbf && pbf.length) { success = true;
            logger.success(`${name} (length: ${comma(pbf.size)})`);
        } else logger.error("Failed to load data.");
        success && logger.log(await pbf.profile({ nohead: true }));
        inExec = false; left.selectAll(".card").attr("disabled", null); cancel.hide();
        p = logger.empty(); p.append("span").text("🔔 [ACTIONs]").classed("big",true);
        success && p.append("button").classed("accent", true).text("View in Ortho-Map").on("click", execView);
        success && p.append("button").text("Show Property Table").on("click", showProp);
        attribution && pbf.originalURL && p.append("button").text("Reload from original url")
        .on("click", async() => { pbf && (pbf.destroy()); exec(Object.assign({}, info, {nocache:true}));});
        p.append("button").text("Done").on("click", async () => { pbf && pbf.destroy(); reset(); });
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
            function propertyTable(a) {
                const cut = s => s.length > 16? s.substring(0,15)+" …":s;
                const head = `<thead><tr>${a[0].map(t => `<th>${t}</th>`).join("")}</tr></thead>`;
                const body = `<tbody>${ a.slice(1).map(row =>`<tr>${row.map(t =>`<td>${cut(t)}</td>`).join("")}</tr>`).join("")}</tbody>`;
                return `<h2>${pbf.name()}<span>${pbf.description()}<span>
                <button name="csv">📥 CSV</button>
                <button name="excel">📥 Excel</button>
                <button name="done">Done</button></h2>
                <div class="prop-table"><table>${head}${body}</table></div>`;
            }
            logger.hide();
            tables.show();
            tables.html(propertyTable(pbf.getPropertyTable()));
            tables.select("[name=csv]").on("click", csv)
            tables.select("[name=excel]").on("click", xls)
            tables.select("[name=done]").on("click", function done() { logger.show(); tables.empty().hide(); })
        }
        async function csv() {
            save(new File([pbf.getCSV()], pbf.name()+".csv", {type:"application/csv"}));
        }
        async function xls() {
            await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
            const XLSX = window.XLSX;
            const workbook = XLSX.read(pbf.getCSV(), { type: 'string', raw: true });
            const buff = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
            save(new File([buff], pbf.name()+".xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
        }
    } catch (err) {
        logger.error(`Failed to load ${target.name || target}: ${err.message}`);
    }
}
function execView() {
    mapInst.autoRotate(false);
    exitButton.show();
    gishub.classed("viewing", true);
}
function exitView() {
    mapInst.setView([0,0], initialZoom); setTimeout(()=>mapInst.autoRotate(true), 250);
    exitButton.hide();
    gishub.classed("viewing",false);
}
