import * as d3 from "d3";
import { comma, download, saveTo } from "common";
import  "common/d3/highlight.js";
import { screenLogger } from "../uploader/src/screenLogger.js";
import { geopbf } from "geopbf";
import "./main.scss";

const mapLayer = d3.select("body").append("section").attr("class", "map-layer");
mapLayer.append("div").attr("id", "ortho-map-container");
mapLayer.append("button").attr("class", "close-btn").text("Back to Log")
    .on("click", () => gishub.classed("active", true));

const gishub = d3.select("body").append("div").attr("class", "gishub");
const left = gishub.append("aside").attr("class", "left");
const main = gishub.append("main").attr("class", "main");
main.append("h1").html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`);


const logger = new screenLogger(main.append("div"));
addEventListener("FetchStart", e => logger.progress("start", e)); 
addEventListener("FetchProgress", e => logger.progress("progress", e));
addEventListener("FetchEnd", e => logger.progress("end", e));
addEventListener("ConvertStart", e => logger.event("start", e));
addEventListener("ConvertEnd", e => logger.event("end", e));

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
	.on("click", (e, d) => exec(d));

async function exec(info) {
    const {name, target, license, description, link} = info;
    logger.clear();
    logger.title(name, description).style("cursor","pointer").on("click", ()=>open(link,"_link_"));
    logger.log(`Requesting: ${target}`)
    try { let p;
        const pbf = await geopbf(target, { name, license, description });
		console.log("PBF loaded:", pbf);
		logger.success(`${name} (${comma(await pbf.filesize())} bytes)`);
        logger.log(pbf.lint);
        p =logger.empty();
        p.append("span").text("🔔 [ACTIONs]").classed("big",true);
        p.append("button").classed("accent", true).text("View in Ortho-Map").on("click", async() => {
 
        });
        p.append("button").text("Done").on("click", async() => {
            pbf.destroy();
            logger.clear();
        });
        p.append("button").text("Reload").on("click", async() => {
 
        });
        const save = async s => { const v = await saveTo(s); if (v) logger.log(`📥 Saved: ${s.name} (${comma(s.size)} bytes)`); }
        const funcs = [
            async function GeoPBF() { save(await pbf.geopbfFile(true)) },
            async function GeoJSON() { const v = await logger.confirm("GeoJSON Gzipped", false); save(await pbf.geojsonFile(v)) },
            async function TopoJSON() { const v = await logger.confirm("TopoJSON Gzipped", false); save(await pbf.topojsonFile(v)) },
            async function FGB() { save(await pbf.fgbFile()) },
            async function KMZ() { },
            async function ShapeFile() { const v = await logger.prompt(`encoding (default: utf8)`,"utf8"); save(await pbf.shapeFile(v)) },
            async function GML() { },
            async function GPX() { },
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