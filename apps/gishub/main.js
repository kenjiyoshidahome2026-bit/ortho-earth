import * as d3 from "d3";
import { screenLogger } from "../uploader/src/screenLogger.js";
import { geopbf } from "geopbf";
import "./main.scss";

const mapLayer = d3.select("body").append("section").attr("class", "map-layer");
mapLayer.append("div").attr("id", "ortho-map-container");
mapLayer.append("button").attr("class", "close-btn").text("Back to Log")
    .on("click", () => mapLayer.classed("active", false));

const app = d3.select("body").append("div").attr("class", "gishub-app");
const sidebar = app.append("aside").attr("class", "sidebar");
sidebar.append("h1").html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`);
const catalogList = sidebar.append("nav");

const main = app.append("main").attr("class", "main-content");
const logStream = main.append("div").attr("id", "log-stream");
const logger = new screenLogger(logStream);

// --- カタログロード ---
d3.json("./catalog.json").then(groups => { console.log("Catalog loaded:", groups);
    const section = catalogList.selectAll(".group-section")
        .data(groups).join("section").attr("class", "group-section");
    section.append("h2").text(d => d.group);
    section.selectAll(".card")
        .data(d => d.contents).join("div").attr("class", "card")
        .html(d => `<div class="card-name">${d.name}</div><div class="card-meta">${d.license}</div>`)
        .on("click", (e, d) => execSurgicalOperation(d));
});

// --- 執刀開始 ---
async function execSurgicalOperation(info) {
    const bus = new EventTarget();
    const entry = logStream.append("div").attr("class", "log-entry");
    const msg = entry.append("div").text(`Requesting: ${info.name}...`);
    
    // 進捗イベントの購読
    bus.addEventListener("FetchProgress", e => {
        const { loaded, total } = e.detail;
        const pct = Math.round((loaded / total) * 100);
        msg.text(`Surgical extracting: ${pct}%`);
    });

    try {
        // 完成した geopbf 関数を叩く
        const pbf = await geopbf(`${info.src}#${info.target}`, {
            eventTarget: bus,
            license: info.license,
            attribution: info.description
        });

        bus.addEventListener("FetchEnd", e => {
            const { size, time } = e.detail;
            msg.html(`✓ <b>${info.target}</b> extracted.`);
            entry.append("span").attr("class", "stats")
                .text(`${(size/1024/1024).toFixed(2)}MB / ${(time/1000).toFixed(2)}s`);
            entry.classed("done", true);

            // 500msのフェード・ズームで着地
            mapLayer.classed("active", true);
            // renderWebGL2(pbf); // 次回の楽しみ！
        });
    } catch (err) {
        msg.text(`! Error: ${err.message}`);
    }
}