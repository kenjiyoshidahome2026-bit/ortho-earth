import * as d3 from "d3";
import orthoMap from 'ortho-map';
import { geopbf } from "geopbf";
import { screenLogger } from "../uploader/src/screenLogger.js";
import { comma, download, openDirectory, saveTo } from "common";
import "common/d3/highlight.js";
import "common/d3/fileio.js";
import "./main.scss";

const initialZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight)/2*0.5 / 256 * Math.PI * 2);
const mapInst = (await orthoMap({target:d3.select('body'), center:[0,0], zoom: initialZoom})).autoRotate(true);
const exitButton = mapInst.append("button").attr("class", "close").html(`<img src="close.svg"/>`)
    .on("click", exitView).hide();

const gishub = d3.select("body").append("div").attr("class", "gishub");
////------------------------------------------------------
const left = gishub.append("aside").attr("class", "left");
const groups = await d3.json("./catalog.json");
left.append("img").attr("src", "menu.svg").attr("alt", "MENU").on("click", () => gishub.classed("close", !gishub.classed("close")))	;
left.append("input").attr("type", "text").attr("name", "search").attr("placeholder", "Search...")
.on("input", function() {
	const keyword = this.value.trim().toLowerCase(), exist = s => s.toLowerCase().includes(keyword);
	const hasKeyword = d => exist(d.name) || exist(d.description) || exist(d.license);
	left.selectAll(".group-section").style("display", d => (d.contents.some(c => hasKeyword(c))|| exist(d.group))? null : "none").highlight(keyword);
	left.selectAll(".card").style("display", d => hasKeyword(d) ? null : "none").highlight(keyword);
});
const section = left.append("nav").selectAll(".group-section").data(groups).join("section").attr("class", "group-section");
section.append("h2").text(d => d.group);
section.selectAll(".card").data(d => d.contents).join("div").attr("class", "card")
	.html(d => `<div class="card-name">${d.name}</div><div class="card-desc">${d.description}</div><div class="license">${d.license}</div>`)
	.on("click", (e, d) => execCatalog(d));
////------------------------------------------------------
const main = gishub.append("main").attr("class", "main");
main.append("h1").html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`);
////------------------------------------------------------
const logger = new screenLogger(main.append("div"));
addEventListener("FetchStart", e => logger.progress("start", e)); 
addEventListener("FetchProgress", e => logger.progress("progress", e));
addEventListener("FetchEnd", e => logger.progress("end", e));
addEventListener("ConvertStart", e => logger.event("start", e));
addEventListener("ConvertEnd", e => logger.event("end", e));
////------------------------------------------------------
const uploads = main.append("div").attr("class", "uploads").dropFile(execFile);
const infoIntro = uploads.append("div").attr("class", "info-intro");
infoIntro.append("p").text(`GIS-HUB is a next-generation, high-performance web GIS station powered by an in-memory binary engine (GeoPBF) and WebGL2 rendering (ortho-map).
 It effortlessly unifies heavy open data into a fluid, zero-latency 3D map inside your browser.`);
const infoGuide = uploads.append("div").attr("class", "info-guide");
infoGuide.append("h2").text("🔬 Quick Start Guide");
infoGuide.append("ul").html(`
    <li><b>Explore Catalog:</b> Click sidebar cards to fetch open data on the fly.</li>
    <li><b>Bring Data:</b> Drag & drop a file, double-click to browse, or enter a URL.</li>
    <li><b>Visualize:</b> Click "View in Ortho-Map" for a buttery-smooth WebGL2 experience.</li>
    <li><b>Convert:</b> Export seamlessly to FlatGeobuf, GeoPBF, or traditional GIS formats.</li>
`);
uploads.append("img").attr("src", "gishub.svg");
uploads.append("input").attr("type","text").attr("placeholder", `"Enter URL" or "Drag & drop a file" or "Double-click to select file."`)
.on("keypress", function(e) { if (e.key === "Enter") execURL(this.value); })
.on("dblclick", function () {
    const input = d3.select("body").append("input").attr("type", "file").style("display", "none")
    .on("change", e => { execFile(e.target.files[0], true); input.remove(); });
    input.node().click();
});

////------------------------------------------------------
async function execFile(file, flag) { uploads.hide(); logger.clear();
    const name = file.name;
    logger.title(`${name} :${flag === true ? "selected" : "dropped"}`);
    try {
        const pbf = await geopbf(file);
		logger.success(`${pbf.name()} (length: ${comma(pbf.size)})`);
        await execPBF(pbf);
    } catch (err) { logger.error(`Failed to load ${name}: ${err.message}`); uploads.show(); }
}
async function execURL(target) { uploads.hide(); logger.clear();
    const name = target.split('/').pop().split('?')[0].replace(/\..+$/i, '');
    await execCatalog({ target, name, license:"", description:"", link:"" });
}

async function execCatalog(info) { uploads.hide(); logger.clear();
    const { target, name, license, description, attribution, link } = info;
    logger.title(name, description).style("cursor", "pointer").on("click", () => link && open(link, "_link_"));
    logger.log(`Requesting: ${target}`);
    try {
        const pbf = await geopbf(target, { name, license, description, attribution });
        logger.success(`${name} (length: ${comma(pbf.size)})`);
        await execPBF(pbf, info);
    } catch (err) { logger.error(`Failed to load ${name}: ${err.message}`); uploads.show(); logger.clear(); }
}
async function execPBF(pbf, info) { uploads.hide();
    try {
        logger.log(await pbf.profile({nohead:true}));
        let p =logger.empty();
        p.append("span").text("🔔 [ACTIONs]").classed("big",true);
        p.append("button").classed("accent", true).text("View in Ortho-Map").on("click", async() => {
            execView();
        });
        p.append("button").text("Done").on("click", async () => { pbf.destroy(); logger.clear(); uploads.show(); });
        info && pbf.originalURL && p.append("button").text("Reload from original url").on("click", async() => { await pbf.clean(); pbf.destroy(); execCatalog(info);});
        const save = async s => { const v = await saveTo(s); if (v) logger.log(`📥 Saved: ${s.name} (${comma(s.size)} bytes)`); }
        const funcs = [
            async function GeoPBF() { save(await pbf.geopbfFile(true)) },
            async function GeoJSON() { await openDirectory(); const v = await logger.confirm("GeoJSON Gzipped", false); save(await pbf.geojsonFile(v)); },
            async function TopoJSON() { const v = await logger.confirm("TopoJSON Gzipped", false); save(await pbf.topojsonFile(v)); },
            async function FGB() { save(await pbf.fgbFile()) },
            async function KMZ() { const v = await logger.select("KMZ or KML", {KMZ:true, KML:false}); save(await pbf.kmzFile(v)); },
            async function ShapeFile() { const v = await logger.prompt(`encoding (default: utf8)`,"utf8"); save(await pbf.shapeFile(v)) },
            async function GML() { const v = await logger.confirm("GML Gzipped", false); save(await pbf.gmlFile(v)); },
            async function GPX() { const v = await logger.confirm("GPX Gzipped", false); save(await pbf.gpxFile(v)); },
        ];
        p = logger.empty();
        const active = v => logger.target.selectAll("button").attr("disabled", v ? null : true);
        p.append("span").text("📥 [DOWNLOAD]").classed("big",true);
        funcs.forEach(f => p.append("button").classed("accent", f.name === "GeoPBF").text(f.name)
        .on("click", async () => { active(false); await f(); active(true); }));
    } catch (err) {
        logger.error(`Failed to load ${target}: ${err.message}`);
    }
}
function execView() {
    mapInst.autoRotate(false);
    exitButton.show();
    gishub.style("opacity",0).style("pointer-events",'none');
}
function exitView() {
    mapInst.setView([0,0], initialZoom);
    setTimeout(()=>mapInst.autoRotate(true), 250);
    exitButton.hide();
    gishub.style("opacity",0.8).style("pointer-events",'auto');
}
