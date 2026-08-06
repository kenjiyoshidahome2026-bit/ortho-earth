import * as d3 from "d3";
import orthoMap from 'ortho-map';
import { geopbf, createGeopbf } from "geopbf";
import { screenLogger } from "common/screenLogger";
import { geoExec } from "common/geoExec";
import { comma, download, openDirectory, saveTo, inputFile, isString } from "common";
import { Cache } from "native-bucket";
import "common/d3/highlight.js";
import "common/d3/fileio.js";
import "./main.scss";

const API_BASE = "https://api.ortho-earth.com";
const TILER_BASE = "https://tiler.ortho-earth.com";
createGeopbf(API_BASE);
const hubCache = await Cache("GISHUB").catch(() => null);
const initialZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight)/2*0.5 / 256 * Math.PI * 2);
const mapInst = (await orthoMap({target:d3.select('body'), center:[0,0], zoom: initialZoom, tilerBase: TILER_BASE, apiUrl: API_BASE})).autoRotate(true);
const closeBtn = mapInst.gadget.close();
mapInst.on("ortho:close", exitView);
const gintTip = mapInst.gadget.tip();
const gintPop = mapInst.gadget.pop();
// map gadgets (navigation / utility) — the ones the original www demo carried. Visible in the interactive globe view.
mapInst.gadget.north(); mapInst.gadget.zoom(); mapInst.gadget.full(); mapInst.gadget.cpos(); mapInst.gadget.measure(); mapInst.gadget.shot();
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
	`the WebGL2 renderer (<b>ortho-map</b>) applies dynamic LOD and stencil-tessellation at draw time, ` +
	`delivering fluid 3D navigation from global to street scale. ` +
	`Once loaded, data is cached to IndexedDB — every subsequent visit is instant.`
);
uploads.append("h2").text("Quick Start");
uploads.append("ul").html(`
	<li><b>Catalog: </b>Click a sidebar card — data is fetched, decoded, and rendered on the fly. Any format, any source.</li>
	<li><b>Drop a file: </b>SHP (ZIP), GeoJSON, FlatGeobuf, GML, KMZ, GPX, or GeoPBF — drag, drop, done.</li>
	<li><b>Paste a URL: </b>Direct links and <code>zip-url#inner-file</code> syntax both work.</li>
	<li><b>View in Ortho-Map: </b>One click for WebGL2 3D — pan, zoom, rotate at 60 fps.</li>
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
		// ローカル依存の遅延チャンク（旧: 実行時CDN import＝オフライン死・SRI不能・0.18.5系CVEの供給網リスク）
		try {
			const XLSX = await import('xlsx');
			const workbook = XLSX.read(pbf.getCSV(), { type:'string', raw:true });
			const buff = XLSX.write(workbook, { bookType:'xlsx', type:'array' });
			save(new File([buff], pbf.name()+".xlsx", { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
		} catch (e) { console.error("[excel]", e); logger.error?.("Excel conversion failed."); }
	});
	h2.append("button").text("Done").on("click", () => { logger.show(); tables.empty().hide(); });
}
let _viewLayer = null;
let _autoRotateTimeout = null;

async function execView(pbf) {
	if (_autoRotateTimeout !== null) { clearTimeout(_autoRotateTimeout); _autoRotateTimeout = null; }
	mapInst.autoRotate(false);
	closeBtn.show();
	gishub.classed("viewing", true);
	if (!pbf?.length) return;

	if (_viewLayer) { _viewLayer.destroy(); _viewLayer = null; }

	// 先にレイヤーを描画してからトラベル開始
	const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point } = pbf.unPackGint || {};
	const hasArcs = !!(arcBuffer && arcMeta && (polyStream?.length > 0 || lineStream?.length > 0));
	const hasPoints = !!(pointBuffer?.length > 0);
	const propTable = id => {
		const entries = Object.entries(pbf.getProperties(id) ?? {});
		if (!entries.length) return;
		const rows = entries.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join("");
		return `<table class="identify-table">${rows}</table>`;
	}
	if (hasArcs || hasPoints) {
		_viewLayer = await mapInst.createRemoteLayer({ name: "GISHUB", type: "gint" });
		const { polyCompBbox } = pbf.unPackGint ?? {};
		_viewLayer.set("gint", { arcBuffer, arcMeta, polyStream: polyStream ?? new Int32Array(0), lineStream: lineStream ?? new Int32Array(0), pointBuffer: pointBuffer ?? null, point: point ?? null, polyCompBbox, minZoom: 2 });
		_viewLayer.onIdentify = featureId => {
			gintTip(featureId == null ? null: propTable(featureId));
		};
		_viewLayer.onClick = (featureId, geomType, x, y, lng, lat) => {
			featureId == null || gintPop(propTable(featureId), { x, y, lng, lat });
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
	let zoomFeature, zoomOpts = {};
	if (e - w > 300) {
		// bbox がほぼ全球 (±180 付近) → bbox 中心は 0° 付近になる誤り。
		// 各 feature bbox の中心を 3D 平均して真の重心を計算する。
		const d2r = Math.PI / 180, r2d = 180 / Math.PI;
		let sx = 0, sy = 0, sz = 0;
		const pts = [];
		pbf.forEach(i => {
			const b = pbf.getBbox(i);
			if (!b || !isFinite(b[0])) return;
			const lng = (b[0] + b[2]) / 2, lat = (b[1] + b[3]) / 2;
			pts.push([lng, lat]);
			sx += Math.cos(lat * d2r) * Math.cos(lng * d2r);
			sy += Math.cos(lat * d2r) * Math.sin(lng * d2r);
			sz += Math.sin(lat * d2r);
		});
		const norm = Math.sqrt(sx * sx + sy * sy + sz * sz);
		if (norm > 0) {
			zoomOpts = { center: [Math.atan2(sy, sx) * r2d, Math.asin(sz / norm) * r2d] };
			// 全球を覆う単一フィーチャ（ne_10m_ocean 等）は点が1つ＝extent 0 で fitExtent が
			// 発散し maxZoom(z=22)へ張り付く。地球全体を見せる概観ズームに固定する。
			if (pts.length < 2) zoomOpts.zoom = initialZoom;
			zoomFeature = { type: "Feature", geometry: { type: "MultiPoint", coordinates: pts }, properties: {} };
		}
	}
	if (!zoomFeature) {
		zoomFeature = { type: "Feature", geometry: {
			type: "Polygon", coordinates: [[[w,s],[w,n],[e,n],[e,s],[w,s]]]
		}, properties: {} };
	}
	await mapInst.zoomToFeature(zoomFeature, zoomOpts);
}

// Bare-Earth route: enter the interactive globe with NO GeoPBF loaded — just spin the real planet.
function globeView() {
	uploads.hide(); tables.empty().hide(); logger.hide();
	if (_autoRotateTimeout !== null) { clearTimeout(_autoRotateTimeout); _autoRotateTimeout = null; }
	mapInst.autoRotate(false);
	closeBtn.show();
	gishub.classed("viewing", true);
}
function exitView() {
	gintTip(null);
	gintPop.clear(true);
	if (_viewLayer) { _viewLayer.destroy(); _viewLayer = null; }
	mapInst.setView([0,0], initialZoom);
	_autoRotateTimeout = setTimeout(() => { _autoRotateTimeout = null; mapInst.autoRotate(true); }, 250);
	closeBtn.hide();
	gishub.classed("viewing", false);
}
