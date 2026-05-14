import * as d3 from "d3";
import { screenLogger } from "../uploader/src/screenLogger.js";
import { comma, download, saveTo } from "common";
import "common/d3/overlays.js";
import { geopbf } from "geopbf";
import "./main.scss";

const mapLayer = d3.select("body").append("section").attr("class", "map-layer");
mapLayer.append("div").attr("id", "ortho-map-container");
mapLayer.append("button").attr("class", "close-btn").text("Back to Log")
    .on("click", () => mapLayer.classed("active", false));

const app = d3.select("body").append("div").attr("class", "gishub");
const left = app.append("aside").attr("class", "left");
const main = app.append("main").attr("class", "main");

left.append("h1").html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`);


const logger = new screenLogger(main.append("div"));
addEventListener("FetchStart", e => logger.progress("start", e)); 
addEventListener("FetchProgress", e => logger.progress("progress", e));
addEventListener("FetchEnd", e => logger.progress("end", e));
addEventListener("ConvertStart", e => logger.event("start", e));
addEventListener("ConvertEnd", e => logger.event("end", e));

const groups = await d3.json("./catalog.json");

const section = left.append("nav").selectAll(".group-section").data(groups).join("section").attr("class", "group-section");
section.append("h2").text(d => d.group);
section.selectAll(".card")
	.data(d => d.contents).join("div").attr("class", "card")
	.html(d => `<div class="card-name">${d.name}</div><div class="card-desc">${d.description}</div><div class="license">${d.license}</div>`)
	.on("click", (e, d) => exec(d));


async function exec(info) {
    const {name, target, license, description, link} = info;
    logger.clear();
    logger.title(name, description).style("cursor","pointer").on("click", ()=>open(link,"_link_"));
    const v = await logger.prompt("encoding (default: utf8)", "utf8");
	const confirmed = await logger.confirm(`Fetch and convert ${name} with encoding "${v}"?`);
	if (!confirmed) {
		logger.log("Operation cancelled by user.");
		return;
	}
	alert(v);
    logger.log(`Requesting: ${target}`)
    try {
        const pbf = await geopbf(`${target}`, { name, license, description });
		console.log("PBF loaded:", pbf);
		logger.success(`loaded ${name} (${comma(pbf.size)} bytes)`);
        logger.log(pbf.lint);
        const p = logger.empty();
        p.append("span").text("📥 [DOWNLOAD]").classed("big",true);
        p.append("button").text("GeoPBF").on("click", async() => { saveTo(await pbf.pbfFile(true)) });
        p.append("button").text("GeoJSON").on("click", async () => { saveTo(await pbf.geojsonFile()) });
        p.append("button").text("TopoJSON").on("click", async () => { saveTo(await pbf.topojsonFile()) });
        p.append("button").text("ShapeFile").on("click", async() => { saveTo(await pbf.topojsonFile()) });
        p.append("button").text("KMZ").on("click", () => { });
        p.append("button").text("GML").on("click", () => { });
        p.append("button").text("GPX").on("click", () => { });
    } catch (err) {
		logger.error(`Failed to load ${target}: ${err.message}`);
    }
}