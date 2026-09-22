// GeoPBF のデモ＝ブラウザの中で GIS ファイルを変換する頁（旧 GIS-HUB。9/22 本人裁定で「GeoPBF のデモ」へ改名・URL /gishub/ → /geopbf/）。
// 見せ方＝落とす → 球で確かめる → 別の形式で書き出す。ファイルは手元から出ない（変換は全部このタブの中）。
import * as d3 from "d3";
import { geopbf, createGeopbf } from "geopbf";
import { screenLogger } from "common/screenLogger";
import { geoExec } from "common/geoExec";
import { comma, download, openDirectory, saveTo, inputFile } from "common";
import { Cache, nativeBucket } from "native-bucket";
import "common/d3/highlight.js";
import "common/d3/fileio.js";
import "./main.scss";
import { t, setLang, norm, LANGUAGES, getLang, isRTL } from "./i18n.js";
import { READ, WRITE, ACCEPT, conversionSVG } from "./formats.js";
import { mapP, viewP, mountTools } from "./globe.js";

const API_BASE = "https://api.ortho-earth.com";
const params = new URLSearchParams(location.search);
await setLang(norm(params.get("lang")) || norm(navigator.language) || "en");
createGeopbf(API_BASE, { bucket: nativeBucket });
// IDB の器の名前は旧名のまま（改名で既存の変換キャッシュを捨てさせない・利用者には見えない）
const hubCache = await Cache("GISHUB").catch(() => null);
// 地球儀（gint v2 エンジン）は裏で立ち上げる＝パネルは地図を待たない
mapP.then(map => {
	map.mapEl.addEventListener("ortho:close", exitView);
	map.on("settle", e => { if (app.classed("viewing")) history.replaceState(null, "", location.search + e.hash); });   // 地図の視点 ⇄ URL hash（共有リンク）
});
viewP.then(view => { if (!app.classed("viewing")) view.spin(true); });
const app = d3.select("body").append("div").attr("class", "demo").classed("close", innerWidth < 700);

// ── 文言の貼り方：data-t（キー）と data-a（$1… の引数）を要素に残す＝言語切替は relabel() で貼り替えるだけ（作り直さない）
const ATTRS = ["placeholder", "title", "aria-label"];
function L(sel, key, ...args) { return sel.attr("data-t", key).attr("data-a", args.length ? JSON.stringify(args) : null).text(t(key, ...args)); }
function LA(sel, attr, key) { return sel.attr(`data-t-${attr}`, key).attr(attr, t(key)); }
function relabel() {
	document.querySelectorAll("[data-t]").forEach(el => el.textContent = t(el.dataset.t, ...(el.dataset.a ? JSON.parse(el.dataset.a) : [])));
	for (const a of ATTRS) document.querySelectorAll(`[data-t-${a}]`).forEach(el => el.setAttribute(a, t(el.getAttribute(`data-t-${a}`))));
	document.title = `GeoPBF — ${t("Convert GIS files in your browser")}`;
	drawDiagram();
}

////------------------------------------------------------ 左：見本データ（カタログ）
const left = app.append("aside").attr("class", "left");
const groups = (a => { const tub = new Map();
	a.forEach(d => {
		if (!tub.has(d.attribution)) tub.set(d.attribution, { group: d.attribution, contents: [] });
		tub.get(d.attribution).contents.push(d);
	});
	return [...tub.values()];
})(await d3.json("./catalog.json").catch(e => { console.error("[geopbf-demo] catalog load failed:", e); return []; }));
LA(left.append("img").attr("src", "menu.svg"), "alt", "Menu").on("click", () => { app.classed("close", !app.classed("close")); setTimeout(drawDiagram, 300); });   // 幅が変わる＝横長／縦長を選び直す
LA(left.append("input").attr("type", "text").attr("name", "search"), "placeholder", "Search sample data…")
.on("input", function() {
	const keyword = this.value.trim().toLowerCase(), exist = s => String(s ?? "").toLowerCase().includes(keyword);
	const hasKeyword = d => exist(d.name) || exist(d.description) || exist(d.license);
	left.selectAll(".group").style("display", d => (d.contents.some(c => hasKeyword(c)) || exist(d.group)) ? null : "none").highlight(keyword);
	left.selectAll(".card").style("display", d => hasKeyword(d) ? null : "none").highlight(keyword);
});
const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nav = left.append("nav");
L(nav.append("h3").attr("class", "nav-title"), "Sample data");
const section = nav.selectAll(".group").data(groups).join("section").attr("class", "group");
section.append("h2").text(d => d.group);
// データ名・説明・ライセンスは地図の中身＝英語のまま（translate="no"）
section.selectAll(".card").data(d => d.contents).join("button").attr("class", "card").attr("translate", "no")
	.html(d => `<div class="name">${escHtml(d.name)}</div><div class="desc">${escHtml(d.description)}</div><div class="license">${escHtml(d.license)}</div>`)
	.on("click", (e, d) => exec(d));

////------------------------------------------------------ 右：本体
const reset = () => { logger.clear().hide(); tables.empty().hide(); uploads.show(); drawDiagram(); left.selectAll(".card").attr("disabled", null); };
const main = app.append("main").attr("class", "main");
const hdr = main.append("header");
hdr.append("h1").attr("translate", "no").html(`<img src="favicon.svg" alt=""/><span>GeoPBF</span>`).on("click", reset);
L(hdr.append("span").attr("class", "tag"), "demo");
const tools = hdr.append("div").attr("class", "tools");
const langSel = tools.append("select").attr("class", "lang").attr("translate", "no");
LA(langSel, "aria-label", "Language");
langSel.selectAll("option").data(LANGUAGES).join("option").attr("value", d => d.code).text(d => d.name);
langSel.property("value", getLang()).on("change", async function() {
	const c = await setLang(this.value);
	const q = new URLSearchParams(location.search); c === "en" ? q.delete("lang") : q.set("lang", c);
	history.replaceState(null, "", (q.size ? "?" + q : location.pathname) + location.hash);
	relabel();
});
LA(tools.append("button").attr("class", "globe-btn"), "title", "Show the bare Earth — no data")
	.html(`🌐 <span></span>`).on("click", e => { e.stopPropagation(); globeView(); })
	.select("span").call(L, "Globe");

////------------------------------------------------------
const logger = new screenLogger(main.append("div").attr("dir", "ltr"));   // ログは英語の register（console/HUD と同じ）＝左→右で固定
// ⚠ログは window の FetchStart/ConvertStart を拾う＝背景の地球儀エンジンの読み込み（ne_50m_admin_0_countries 等）も拾う。
// 待ち受け中は隠す（透明な入口の裏に透けて出ていた）。読み込み開始で geoExec が clear().show() する＝溜まった行も消える
logger.hide();
const tables = main.append("div").attr("class", "tables").hide();

const fname = s => s.split('/').pop().split('?')[0].replace(/\..+$/i, '');
const uploads = main.append("div").attr("class", "uploads").dropFile(f => f && exec({ name: fname(f.name), target: f, description: "dropped file" }));
L(uploads.append("p").attr("class", "lead"), "Convert GIS files in your browser");
L(uploads.append("p"), "Drop a file, check it on the globe, then write it out in another format. Everything runs on your own machine — the file never leaves it. No server, no account, no install.");
L(uploads.append("p"), "Japanese data works as it is: plane rectangular coordinates, Tokyo Datum, Shift_JIS and MOJ map XML — without GDAL.");
const diagram = uploads.append("div").attr("class", "diagram");
const input = uploads.append("input").attr("type", "text").attr("class", "url")
	.on("keydown", function (e) { if (e.key === "Enter" && /^https?:\/\//.test(this.value.trim())) { const u = this.value.trim(); exec({ name: fname(u), target: u, description: "input url" }); } })
	.on("dblclick", () => pick());
LA(input, "placeholder", "Drop a file · double-click to choose · or paste a URL and press Enter");
const how = uploads.append("ul");
L(how.append("li"), "Drop a file anywhere in this panel, or double-click the box above to choose one.");
L(how.append("li"), "Paste a URL. For a file inside a zip, write zip-url#inner-file.");
L(how.append("li"), "Or pick sample data from the side panel.");
L(how.append("li"), "Limit: the whole file is read into memory, so very large files depend on your machine.");
const links = uploads.append("p").attr("class", "links");
links.append("code").attr("translate", "no").text("npm install geopbf");
L(links.append("a").attr("href", "/docs/geopbf.html"), "Docs");
links.append("a").attr("href", "https://github.com/kenjiyoshidahome2026-bit/geopbf").attr("translate", "no").text("GitHub");
L(links.append("span").attr("class", "mit"), "MIT license");

function pick(accept = ACCEPT) { inputFile(accept).then(f => f && exec({ name: fname(f.name), target: f, description: "selected file" })); }

// 図：読む形式を押す＝その形式だけのファイル選択。幅で横長／縦長を選び直す（言語切替でも描き直す＝見出しが訳される）
let narrow = null;
function drawDiagram() {
	const w = uploads.node().clientWidth || innerWidth;
	narrow = w < 620;
	diagram.html(conversionSVG(t, { narrow, rtl: isRTL() }));
	fitText(diagram.select("svg").node());
	diagram.selectAll(".pill.read").on("click", function() { pick(READ[+this.dataset.i].ext.join(",")); });
	diagram.select(".globe").on("click", globeView);
}
// 訳で長くなった見出し・札は枠に収める（はみ出す時だけ字間を詰める）
function fitText(svg) {
	if (!svg) return;
	const W = svg.viewBox.baseVal.width;
	const fit = (el, max) => { el.removeAttribute("textLength"); if (el.getComputedTextLength() > max) { el.setAttribute("textLength", max); el.setAttribute("lengthAdjust", "spacingAndGlyphs"); } };
	svg.querySelectorAll(".head").forEach(el => fit(el, svg.classList.contains("narrow") ? W : W / 2 - 12));
	svg.querySelectorAll(".hub-sub").forEach(el => fit(el, 136));
	svg.querySelectorAll(".globe text").forEach(el => fit(el, 126));
}
let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { const w = uploads.node().clientWidth; if (w && (w < 620) !== narrow) drawDiagram(); }, 150); });
relabel();

////------------------------------------------------------ 読み込み → 見る／書き出す
// 保存：フォルダを選べるブラウザ（File System Access API）はフォルダへ、無ければ普通のダウンロード（Safari / Firefox でも書き出せる）。
// ⚠フォルダの選択は押した瞬間（ユーザ操作の有効期間内）に済ませる＝変換の後だと SecurityError（旧 GIS-HUB も先に openDirectory していた）
const hasPicker = () => typeof window.showDirectoryPicker === "function";
const save = async make => {
	if (hasPicker() && !(await openDirectory())) return;
	const f = await make();
	if (!f) return;
	const ok = hasPicker() ? await saveTo(f) : (download(f), true);
	if (ok) logger.log(`📥 Saved: ${f.name} (${comma(f.size)} bytes)`);
};
// zip は中身で振り分ける：中に zip が並ぶ＝法務省 地図XML（配布そのまま）。*.gdbtable＝FileGDB は geopbf が自分で見分ける
async function zipFormat(file) {
	if (!(file instanceof File) || !/\.zip$/i.test(file.name)) return "";
	try {
		const { decodeZIP } = await import("geopbf/decodeZIP");
		const list = await decodeZIP(file, false);
		const names = (list || []).map(e => e.name.toLowerCase());
		return names.length && !names.some(n => n.endsWith(".shp") || n.endsWith(".gdbtable")) && names.some(n => n.endsWith(".zip")) ? "moj" : "";
	} catch { return ""; }
}

async function exec(info) {
	uploads.hide(); tables.empty().hide();
	left.selectAll(".card").attr("disabled", true);
	if (!info.format) { const f = await zipFormat(info.target); if (f) info = { ...info, format: f }; }

	await geoExec(info, {
		geopbf,
		logger,
		cache: hubCache,
		async onSuccess(pbf) {
			left.selectAll(".card").attr("disabled", null);
			if (!pbf?.length) return;

			const p = logger.empty().attr("class", "actions");
			L(p.append("span").classed("big", true), "Next step");
			L(p.append("button").classed("accent", true), "View on the globe").on("click", () => execView(pbf));
			L(p.append("button"), "Property table").on("click", () => showProp(pbf));
			info.attribution && pbf.originalURL &&
				L(p.append("button"), "Reload from the source").on("click", () => { pbf.destroy(); exec(Object.assign({}, info, { nocache: true })); });
			L(p.append("button"), "Done").on("click", () => { exitView(); pbf.destroy(); reset(); });

			const q = logger.empty().attr("class", "downloads");
			L(q.append("span").classed("big", true), "Download as");
			const row = q.append("div").attr("class", "formats");
			const opt = q.append("div").attr("class", "options");
			const check = (key, on = false) => { const l = opt.append("label"); const c = l.append("input").attr("type", "checkbox").property("checked", on); L(l.append("span"), key); return c; };
			const gz = check("gzip");
			const kml = check("KML instead of KMZ");
			const encL = opt.append("label"); L(encL.append("span"), "Shapefile text encoding");
			const enc = encL.append("select").attr("translate", "no"); enc.selectAll("option").data(["utf8", "shift_jis"]).join("option").text(d => d);
			const zL = opt.append("label"); L(zL.append("span"), "PMTiles max zoom");
			const maxZoom = zL.append("input").attr("type", "number").attr("min", 0).attr("max", 18).property("value", 14);
			const busy = v => q.selectAll("button").attr("disabled", v ? true : null);
			row.selectAll("button").data(WRITE).join("button").attr("translate", "no").classed("accent", d => d.key === "geopbf")
				.attr("title", d => `${d.ext}${d.title ? " · " + d.title : ""}`).text(d => d.name)
				.on("click", async (e, d) => {
					busy(true);
					try { await save(() => write(pbf, d, { gz: d.gz && gz.property("checked"), kmz: !kml.property("checked"), encoding: enc.property("value"), maxZoom: Math.max(0, Math.min(18, +maxZoom.property("value") || 14)) })); }
					catch (err) { console.error(`[geopbf-demo] ${d.name}`, err); logger.error(`${d.name}: ${err.message || err}`); }
					busy(false);
				});
		},
		onError() {
			left.selectAll(".card").attr("disabled", null);
		},
	});
}

// 書き出し：worker のエンコーダ（pbf.*File）＋ convert（GeoParquet / PMTiles）＋ 表（CSV / Excel）＋ NDJSON（1 行 1 地物）
async function write(pbf, d, o) {
	const name = pbf.name();
	switch (d.key) {
		case "geopbf":   return pbf.geopbfFile();
		case "geojson":  return pbf.geojsonFile({ gz: o.gz });
		case "topojson": return pbf.topojsonFile({ gz: o.gz });
		case "fgb":      return pbf.fgbFile({ gz: o.gz });
		case "kmz":      return pbf.kmzFile({ kmz: o.kmz });
		case "shape":    return pbf.shapeFile({ encoding: o.encoding });
		case "gml":      return pbf.gmlFile({ gz: o.gz });
		case "gpx":      return pbf.gpxFile({ gz: o.gz });
		case "czml":     return pbf.czmlFile({ gz: o.gz });
		case "ndjson": {
			const parts = [];
			for (let i = 0; i < pbf.length; i++) {
				let f; try { f = pbf.getFeature(i); } catch { continue; }
				parts.push(JSON.stringify({ type: "Feature", geometry: f.geometry ?? null, properties: f.properties ?? {} }), "\n");
			}
			const file = new File(parts, `${name}.ndjson`, { type: "application/geo+json-seq" });
			return o.gz ? (await import("geopbf/gzip")).gzip(file) : file;
		}
		case "parquet": {
			logger.log(`🔄 ${name}: conversion from GeoPBF to GeoParquet …`);
			pbf.propertiesTable;   // 遅延復号の属性を全部起こしてから（toGeoParquet は pbf.props を直に読む）
			const { toGeoParquet } = await import("geopbf/geoparquet");
			const { buffer } = await toGeoParquet(pbf);
			return new File([buffer], `${name}.parquet`, { type: "application/vnd.apache.parquet" });
		}
		case "pmtiles": {
			logger.log(`🔄 ${name}: conversion from GeoPBF to PMTiles (z0–${o.maxZoom}) …`);
			pbf.propertiesTable;
			const { toPMTiles } = await import("geopbf/pmtiles");
			const { buffer } = await toPMTiles(pbf, { maxZoom: o.maxZoom });
			return new File([buffer], `${name}.pmtiles`, { type: "application/vnd.pmtiles" });
		}
		case "csv":  return new File([toCSV(geoRows(pbf))], `${name}.csv`, { type: "text/csv" });
		case "xlsx": { const { encodeXLSX } = await import("geopbf/encodeXLSX"); return encodeXLSX(geoRows(pbf, { excel: true }), `${name}.xlsx`, { sheetName: name }); }
		case "attrs-xlsx": { const { encodeXLSX } = await import("geopbf/encodeXLSX"); return encodeXLSX(pbf.getCSV(), `${name}.xlsx`, { sheetName: name }); }
	}
}

// 表の書き出し＝属性＋形（読み戻せる形）：点だけなら lon / lat 列、それ以外は wkt 列（geopbf の表リーダが列名で見つける）
const wktOf = g => {
	if (!g) return "";
	const xy = c => `${c[0]} ${c[1]}`, ring = r => `(${r.map(xy).join(",")})`, poly = p => `(${p.map(ring).join(",")})`;
	switch (g.type) {
		case "Point": return `POINT (${xy(g.coordinates)})`;
		case "MultiPoint": return `MULTIPOINT (${g.coordinates.map(c => `(${xy(c)})`).join(",")})`;
		case "LineString": return `LINESTRING ${ring(g.coordinates)}`;
		case "MultiLineString": return `MULTILINESTRING (${g.coordinates.map(ring).join(",")})`;
		case "Polygon": return `POLYGON ${poly(g.coordinates)}`;
		case "MultiPolygon": return `MULTIPOLYGON (${g.coordinates.map(poly).join(",")})`;
		case "GeometryCollection": return `GEOMETRYCOLLECTION (${(g.geometries ?? []).map(wktOf).join(",")})`;
	}
	return "";
};
const cell = v => v == null ? "" : (typeof v === "object" && !(v instanceof Date)) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : v;
const EXCEL_CELL = 32767;   // Excel の 1 セルの上限（字）
function geoRows(pbf, { excel = false } = {}) {
	const [keys, ...props] = pbf.propertiesTable;
	const points = pbf.getType().every(t => t === "Point");
	let skipped = 0;
	const rows = [keys.concat(points ? ["lon", "lat"] : ["wkt"])];
	for (let i = 0; i < pbf.length; i++) {
		const row = keys.map((_, k) => cell(props[i]?.[k]));
		let g = null; try { g = pbf.getGeometry(i); } catch {}
		if (points) row.push(g?.coordinates?.[0] ?? "", g?.coordinates?.[1] ?? "");
		else { const w = wktOf(g); if (excel && w.length > EXCEL_CELL) { skipped++; row.push(""); } else row.push(w); }
		rows.push(row);
	}
	if (skipped) logger.warn(`${skipped} geometries are longer than Excel's ${comma(EXCEL_CELL)}-character cell limit and were left empty (use CSV for them).`);
	return rows;
}
const toCSV = rows => rows.map(r => r.map(v => { const s = String(v); return /[",\r\n]|^0\d/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n");

function showProp(pbf) {
	const PAGE = 100;
	const data = pbf.getPropertyTable();
	const headers = data[0];
	const rows = data.slice(1);
	const pages = Math.ceil(rows.length / PAGE) || 1;
	let page = 0;
	const cut = s => { const t = String(s ?? ""); return escHtml(t.length > 16 ? t.substring(0, 15) + " …" : t); };

	logger.hide();
	tables.show().attr("translate", "no").html(
		`<h2><span class="name">${escHtml(pbf.name())}</span><span>${escHtml(pbf.description() ?? "")}</span></h2>` +
		`<div class="prop-table"><table><thead><tr>${headers.map(h => `<th>${escHtml(String(h))}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`
	);
	const tbody = tables.select("tbody");
	const h2 = tables.select("h2");

	const renderPage = () => {
		const slice = rows.slice(page * PAGE, (page + 1) * PAGE);
		tbody.html(slice.map(row => `<tr>${row.map(c => `<td>${cut(c)}</td>`).join("")}</tr>`).join(""));
		tables.select(".prop-table").node().scrollTop = 0;
	};
	renderPage();

	if (pages > 1) {
		const go = n => { page = n; pageInfo.text(`${page + 1} / ${pages}`); renderPage(); };
		LA(h2.append("button").text("◀"), "aria-label", "Previous page").on("click", () => page > 0 && go(page - 1));
		const pageInfo = h2.append("span").attr("class", "page").text(`1 / ${pages}`);
		LA(h2.append("button").text("▶"), "aria-label", "Next page").on("click", () => page < pages - 1 && go(page + 1));
	}
	h2.append("button").text("📥 CSV").on("click", () => save(() => new File([pbf.getCSV()], pbf.name() + ".csv", { type: "text/csv" })));
	h2.append("button").text("📥 Excel").on("click", async () => {
		try { await save(() => write(pbf, { key: "attrs-xlsx" })); }
		catch (e) { console.error("[excel]", e); logger.error?.("Excel conversion failed."); }
	});
	L(h2.append("button"), "Close").on("click", () => { logger.show(); tables.empty().hide(); });
}
// ── 地図に入る／出る（gint v2：map.addGint＝common/gintView の薄い1枚）──
function enterView(map) {
	mountTools(map);
	app.classed("viewing", true);
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
	await view.show(pbf, { tipHtml: propTable, popHtml: propTable, fill: false });   // 面は塗らず輪郭だけ（本人 9/22「描く時の塗りはいらない」）
}

// データなしで球だけ回す入口
async function globeView() {
	uploads.hide(); tables.empty().hide(); logger.hide();
	const [map, view] = await Promise.all([mapP, viewP]);
	view.spin(false);
	enterView(map);
}
async function exitView() {
	if (!app.classed("viewing")) return;   // Esc（close ガジェット）は待ち受け中にも飛ぶ
	app.classed("viewing", false);
	history.replaceState(null, "", location.pathname + location.search);   // clear the permalink hash on exit
	if (uploads.style("display") === "none" && !logger.target.select("p.actions").size()) { logger.clear().hide(); uploads.show(); drawDiagram(); }   // 球だけ見て戻った＝入口へ
	else logger.show();
	const view = await viewP;
	view.clear();
	view.home();
}

// ── Permalink：地図の視点 ⇄ URL hash（書き戻しは上の settle 購読。起動時の hash は globe.js が view に渡す）──
if (/^#-?\d/.test(location.hash)) globeView();
