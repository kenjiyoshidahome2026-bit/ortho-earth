import * as d3 from "d3";
import { comma } from "common";
import { screenLogger } from "../uploader/src/screenLogger.js";
import { geopbf } from "geopbf";
import "./main.scss";

const mapLayer = d3.select("body").append("section").attr("class", "map-layer");
mapLayer.append("div").attr("id", "ortho-map-container");
mapLayer.append("button").attr("class", "close-btn").text("Back to Log")
    .on("click", () => mapLayer.classed("active", false));

const app = d3.select("body").append("div").attr("class", "gishub-app");
const sidebar = app.append("aside").attr("class", "sidebar");
const main = app.append("main").attr("class", "main-content");

sidebar.append("h1").html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`);
const catalogList = sidebar.append("nav");

const logStream = main.append("div").attr("id", "log-stream");
const logger = new screenLogger(logStream);

d3.json("./catalog.json").then(groups => { console.log("Catalog loaded:", groups);
    const section = catalogList.selectAll(".group-section")
        .data(groups).join("section").attr("class", "group-section");
    section.append("h2").text(d => d.group);
    section.selectAll(".card")
        .data(d => d.contents).join("div").attr("class", "card")
        .html(d => `<div class="card-name">${d.name}</div><div class="card-desc">${d.description}</div><div class="license">${d.license}</div>`)
        .on("click", (e, d) => exec(d));
});

async function exec(info) {
    logger.log(`Requesting: ${info.target}...`)
    window.addEventListener("FetchStart", e => logger.progress("start", e.detail)); 
    window.addEventListener("FetchProgress", e => logger.progress("progress", e.detail));
    window.addEventListener("FetchEnd", e => logger.progress("end", e.detail));
    try {
        const pbf = await geopbf(`${info.target}`, {
			name: info.name,
            license: info.license,
            description: info.description
        });
		console.log("PBF loaded:", pbf);
		logger.log(`✅ Successfully loaded ${info.name} (${comma(pbf.size)} bytes)`);

    } catch (err) {
		logger.error(`Failed to load ${info.target}: ${err.message}`);
    }
}