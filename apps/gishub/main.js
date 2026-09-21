import * as d3 from "d3";
import { geopbf, createGeopbf } from "geopbf";
import { screenLogger } from "common/screenLogger";
import { geoExec } from "common/geoExec";
import { comma, download, openDirectory, saveTo, inputFile, isString } from "common";
import { Cache, nativeBucket } from "native-bucket";
import "common/d3/highlight.js";
import "common/d3/fileio.js";
import "./main.scss";
import { mapP, viewP, mountTools } from "./globe.js";

const API_BASE = "https://api.ortho-earth.com";
createGeopbf(API_BASE, { bucket: nativeBucket });
const hubCache = await Cache("GISHUB").catch(() => null);
// 地球儀（gint v2 エンジン）は裏で立ち上げる＝パネルは地図を待たない（旧 v1 は TLA で地図の起動まで UI ごと待っていた）
mapP.then(map => {
	map.mapEl.addEventListener("ortho:close", exitView);
	map.on("settle", e => { if (gishub.classed("viewing")) history.replaceState(null, "", e.hash); });   // 地図の視点 ⇄ URL hash（共有リンク）
});
viewP.then(view => { if (!gishub.classed("viewing")) view.spin(true); });
const gishub = d3.select("body").append("div").attr("class", "gishub");
////------------------------------------------------------
const left = gishub.append("aside").attr("class", "left");
const groups = (a => { const tub = new Map();
	a.forEach(d => {
		const group = tub[d.attribution] = tub[d.attribution] || { group: d.attribution, contents: [] };
		group.contents.push(d);
	});
	return Object.values(tub);
})(await d3.json("./catalog.json").catch(e => { console.error("[gishub] catalog load failed:", e); return []; }));
left.append("img").attr("src", "menu.svg").attr("alt", "MENU").on("click", () => gishub.classed("close", !gishub.classed("close")))	;
left.append("input").attr("type", "text").attr("name", "search").attr("placeholder", "Search...")
.on("input", function() {
	const keyword = this.value.trim().toLowerCase(), exist = s => s.toLowerCase().includes(keyword);
	const hasKeyword = d => exist(d.name) || exist(d.description) || exist(d.license);
	left.selectAll(".group").style("display", d => (d.contents.some(c => hasKeyword(c))|| exist(d.group))? null : "none").highlight(keyword);
	left.selectAll(".card").style("display", d => hasKeyword(d) ? null : "none").highlight(keyword);
});
const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const section = left.append("nav").selectAll(".group").data(groups).join("section").attr("class", "group");
section.append("h2").text(d => d.group);
section.selectAll(".card").data(d => d.contents).join("button").attr("class", "card")
	.html(d => `<div class="name">${escHtml(d.name)}</div><div class="desc">${escHtml(d.description)}</div><div class="license">${escHtml(d.license)}</div>`)
	.on("click", (e, d) => exec(d));
////------------------------------------------------------
const reset = () => { logger.clear(); tables.empty().hide(); uploads.show(); left.selectAll(".card").attr("disabled", null); };
const main = gishub.append("main").attr("class", "main");
const hdr = main.append("h1");
hdr.html(`<img src="favicon.svg" alt="GIS-HUB"/><span>GIS-HUB</span>`).on("click", reset);
hdr.append("button").attr("class", "globe-btn").attr("title", "Draw the bare Earth — no data").html("🌐 Globe")
	.on("click", e => { e.stopPropagation(); globeView(); });
////------------------------------------------------------
const logger = new screenLogger(main.append("div"));
const tables = main.append("div").attr("class","tables").hide();
////------------------------------------------------------
//console.log(await fetch("https://www.geospatial.jp/ckan/dataset/aigid-moj-04101/resource/e8936e86-0d81-44e0-a51b-4eb04fb511d0/download/04101__10_r_2025.geojson"));

const fname = s => s.split('/').pop().split('?')[0].replace(/\..+$/i, '');
const uploads = main.append("div").attr("class", "uploads").dropFile(f=>exec({name:fname(f.name), target:f, description:"dropped file"}));
uploads.append("p").html(
	`GIS-HUB is a universal GIS workstation that runs entirely in your browser — no server, no install, no LOD pyramid. ` +
	`One file at full resolution is all it needs. ` +
	`The in-memory engine (<b>GeoPBF</b>) builds a spatial index on load; ` +
	`the WebGPU / WebGL2 globe engine (<b>ortho-japan</b>, gint v2) applies GPU dynamic LOD at draw time, ` +
	`delivering fluid 3D navigation from global to street scale. ` +
	`Once loaded, data is cached to IndexedDB — every subsequent visit is instant.`
);
uploads.append("h2").text("Quick Start");
uploads.append("ul").html(`
	<li><b>Catalog: </b>Click a sidebar card — data is fetched, decoded, and rendered on the fly. Any format, any source.</li>
	<li><b>Drop a file: </b>SHP (ZIP), GeoJSON, FlatGeobuf, GML, KMZ, GPX, or GeoPBF — drag, drop, done.</li>
	<li><b>Paste a URL: </b>Direct links and <code>zip-url#inner-file</code> syntax both work.</li>
	<li><b>View in Ortho-Map: </b>One click for WebGPU / WebGL2 3D — pan, zoom, tilt, rotate at 60 fps.</li>
	<li><b>Export: </b>GeoPBF · FlatGeobuf · GeoJSON · TopoJSON · Shapefile · GML · KMZ · GPX.</li>
`);
uploads.append("img").attr("src", "gishub.svg");
uploads.append("input").attr("type","text").attr("placeholder", `"Enter URL" or "Drag & drop a file" or "Double-click to select file."`)
.on("keypress", function (e) { if (e.key === "Enter" && /^https?:\/\//.test(this.value)) exec({ name: fname(this.value), target: this.value, description: "input url" }); })
.on("dblclick", function () { inputFile().then(f => f && exec({ name: fname(f.name), target: f, description: "selected file" }));});
////------------------------------------------------------
async function exec(info) {
	uploads.hide(); tables.empty().hide();
	left.selectAll(".card").attr("disabled", true);

	// sticky title は geoExec の logger.title() が生成するが、gishub では sticky にしたい
	await geoExec(info, {
		geopbf,
		logger,
		cache: hubCache,
		async onSuccess(pbf) {
			left.selectAll(".card").attr("disabled", null);
			if (!pbf?.length) return;

			const save = async s => {
				if (!s) return;
				const v = await saveTo(s);
				if (v) logger.log(`📥 Saved: ${s.name} (${comma(s.size)} bytes)`);
			};

			const p = logger.empty();
			p.append("span").text("🔔 [ACTIONs]").classed("big", true);
			p.append("button").classed("accent", true).text("View in Ortho-Map").on("click", () => execView(pbf));
			p.append("button").text("Show Property Table").on("click", () => showProp(pbf));
			info.attribution && pbf.originalURL &&
				p.append("button").text("Reload from original url")
					.on("click", () => { pbf.destroy(); exec(Object.assign({}, info, { nocache:true })); });
			p.append("button").text("Done").on("click", () => { exitView(); pbf.destroy(); reset(); });

			const funcs = [
				{ name: "GeoPBF",  fn: async () => { save(await pbf.geopbfFile()); } },
				{ name: "GeoJSON", fn: async () => { save(await pbf.geojsonFile({ gz: await logger.confirm("GeoJSON Gzipped", false) })); } },
				{ name: "TopoJSON",fn: async () => { save(await pbf.topojsonFile({ gz: await logger.confirm("TopoJSON Gzipped", false) })); } },
				{ name: "FGB",     fn: async () => { save(await pbf.fgbFile({ gz: await logger.confirm("FGB Gzipped", false) })); } },
				{ name: "KMZ",     fn: async () => { save(await pbf.kmzFile({ kmz: await logger.select("KMZ or KML", { KMZ: true, KML: false }) })); } },
				{ name: "Shape",   fn: async () => { save(await pbf.shapeFile({ encoding: await logger.prompt("encoding (default: utf8)", "utf8") })); } },
				{ name: "GML",     fn: async () => { save(await pbf.gmlFile({ gz: await logger.confirm("GML Gzipped", false) })); } },
				{ name: "GPX",     fn: async () => { save(await pbf.gpxFile({ gz: await logger.confirm("GPX Gzipped", false) })); } },
			];
			const q = logger.empty();
			const active = v => logger.target.selectAll("button").attr("disabled", v ? null : true);
			q.append("span").text("📥 [DOWNLOAD]").classed("big", true);
			funcs.forEach(f => q.append("button").classed("accent", f.name === "GeoPBF").text(f.name)
				.on("click", async () => { active(false); (await openDirectory()) && await f.fn(); active(true); }));
		},
		onError() {
			left.selectAll(".card").attr("disabled", null);
		},
	});
}

function showProp(pbf) {
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
		`<h2>${esc(pbf.name())}<span>${esc(pbf.description() ?? "")}</span></h2>` +
		`<div class="prop-table"><table><thead><tr>${headers.map(t => `<th>${esc(String(t))}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`
	);
	const tbody = tables.select("tbody");
	const h2 = tables.select("h2");

	const renderPage = () => {
		const slice = rows.slice(page * PAGE, (page + 1) * PAGE);
		tbody.html(slice.map(row => `<tr>${row.map(t => `<td>${cut(t)}</td>`).join("")}</tr>`).join(""));
		tables.select(".prop-table").node().scrollTop = 0;
	};
	renderPage();

	if (pages > 1) {
		h2.append("button").text("◀").on("click", () => { if (page > 0) { page--; pageInfo.text(`${page+1} / ${pages}`); renderPage(); } });
		const pageInfo = h2.append("span").attr("class","page").text(`1 / ${pages}`);
		h2.append("button").text("▶").on("click", () => { if (page < pages-1) { page++; pageInfo.text(`${page+1} / ${pages}`); renderPage(); } });
	}
	const save = async s => { if (!s) return; const v = await saveTo(s); if (v) logger.log(`📥 Saved: ${s.name} (${comma(s.size)} bytes)`); };
	h2.append("button").text("📥 CSV").on("click", () => save(new File([pbf.getCSV()], pbf.name()+".csv", {type:"application/csv"})));
	h2.append("button").text("📥 Excel").on("click", async () => {
		// 依存ゼロの遅延チャンク（旧: xlsx@0.18.5＝225KB gz の読み書き一式・修正版が npm に無いCVE 2件を出荷。
		// ここは CSV→xlsx の一方向変換だけなので、encodeZIP と同じ CompressionStream 流儀で自前書き出し）
		try {
			const { encodeXLSX } = await import('geopbf/encodeXLSX');
			save(await encodeXLSX(pbf.getCSV(), pbf.name()+".xlsx", { sheetName: pbf.name() }));
		} catch (e) { console.error("[excel]", e); logger.error?.("Excel conversion failed."); }
	});
	h2.append("button").text("Done").on("click", () => { logger.show(); tables.empty().hide(); });
}
// ── 地図に入る／出る（gint v2：map.addGint＝common/gintView の薄い1枚）──
function enterView(map) {
	mountTools(map);
	gishub.classed("viewing", true);
}
async function execView(pbf) {
	if (!pbf?.length) return;
	const [map, view] = await Promise.all([mapP, viewP]);
	enterView(map);
	const propTable = (fid, props) => {
		const entries = Object.entries(props ?? pbf.getProperties(fid) ?? {});
		if (!entries.length) return null;
		const rows = entries.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join("");
		return `<table class="identify-table">${rows}</table>`;
	};
	await view.show(pbf, { tipHtml: propTable, popHtml: propTable });
}

// Bare-Earth route: enter the interactive globe with NO GeoPBF loaded — just spin the real planet.
async function globeView() {
	uploads.hide(); tables.empty().hide(); logger.hide();
	const [map, view] = await Promise.all([mapP, viewP]);
	view.spin(false);
	enterView(map);
}
async function exitView() {
	if (!gishub.classed("viewing")) return;   // Esc（close ガジェット）は待ち受け中にも飛ぶ
	gishub.classed("viewing", false);
	history.replaceState(null, "", location.pathname + location.search);   // clear the permalink hash on exit
	const view = await viewP;
	view.clear();
	view.home();
}

// ── Permalink：地図の視点 ⇄ URL hash（書き戻しは上の settle 購読。起動時の hash は globe.js が view に渡す）──
if (/^#-?\d/.test(location.hash)) globeView();
