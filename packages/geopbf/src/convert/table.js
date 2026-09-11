// convert/table.js ── 表（CSV / TSV / XLSX）→ GeoPBF。経緯度の 2 列か WKT の 1 列を持つ表を点・線・面にする（依存ゼロ）。
//
//   const { pbf, stats } = await fromTable(u8OrText, { name, precision, lon, lat, wkt, sheet, encoding, delimiter, include/exclude/excludeAll });
//   parseCSV(text, { delimiter }) → { header: string[], rows: string[][] }        RFC 4180（引用・改行入りセル）・区切りは , \t ; | を自動判別
//   readXLSX(u8, { sheet }) → { header, rows, sheet, sheets }                     xlsx の最初の（または名指しの）シート・sharedStrings / inlineStr / 数値 / 論理値
//   decodeText(u8, encoding) → string                                             BOM を剥がす・UTF-8 で読めなければ Shift_JIS（TextDecoder 組込み・依存なし）
//   parseWKT(text) → GeoJSON geometry | null                                      POINT〜GEOMETRYCOLLECTION・Z/M は落とす・EMPTY は null
//
// 列の見つけ方（opts で名指しが最優先）: 経度＝lon/lng/long/longitude/経度/x/X座標/東経、緯度＝lat/latitude/緯度/y/Y座標/北緯、
// WKT＝wkt/geometry/geom/the_geom/shape/図形（先頭行の値が WKT で始まる列も候補）。大文字小文字・前後空白・BOM は無視。
// 値の型: 数字らしい文字列だけ数値へ（"01" のような先頭ゼロは文字列のまま＝JP コードを壊さない）、true/false は論理値、空は無し。日付は推測しない。
import { GeoPBF } from "../pbf-base.js";
import { attrFilter } from "./attrs.js";
import { decodeZIP } from "../modules/decodeZIP.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const norm = s => String(s ?? "").replace(/^﻿/, "").trim().toLowerCase();
const LON = ["lon", "lng", "long", "longitude", "経度", "x", "x座標", "東経", "lon_dd", "x_coord"];
const LAT = ["lat", "latitude", "緯度", "y", "y座標", "北緯", "lat_dd", "y_coord"];
const WKT = ["wkt", "geometry", "geom", "the_geom", "shape", "図形", "wkt_geom"];

/** 表を GeoPBF に。src は Uint8Array（CSV/TSV/XLSX のバイト列）か文字列（CSV テキスト）。 */
export async function fromTable(src, opts = {}) {
	const t0 = now();
	let table, kind;
	if (typeof src === "string") { table = parseCSV(src, opts); kind = "csv"; }
	else {
		const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
		if (u8[0] === 0x50 && u8[1] === 0x4b) { table = await readXLSX(u8, opts); kind = "xlsx"; }
		else { table = parseCSV(decodeText(u8, opts.encoding), opts); kind = "csv"; }
	}
	const { header, rows } = table;
	if (!header.length) throw new Error("table: 先頭行（列名）が無い");
	const cols = header.map(norm);
	const find = (names, want) => { if (want != null) { const i = cols.indexOf(norm(want)); if (i < 0) throw new Error(`table: 列 "${want}" が無い（列: ${header.join(", ")}）`); return i; } for (const n of names) { const i = cols.indexOf(n); if (i >= 0) return i; } return -1; };
	let iw = find(WKT, opts.wkt), ilon = -1, ilat = -1;
	if (iw < 0 && opts.wkt == null) { const first = rows.find(r => r.some(v => v !== "")) || []; iw = first.findIndex(v => /^\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i.test(String(v))); }
	if (iw < 0 || opts.lon != null || opts.lat != null) { ilon = find(LON, opts.lon); ilat = find(LAT, opts.lat); if (ilon >= 0 && ilat >= 0) iw = -1; }
	if (iw < 0 && (ilon < 0 || ilat < 0)) throw new Error(`table: 経緯度の列（${LON.slice(0, 4).join("/")} と ${LAT.slice(0, 3).join("/")}）も WKT の列も見つからない（列: ${header.join(", ")}）。opts.lon/lat か opts.wkt で名指しできる`);
	const keep = attrFilter(opts);
	const geomCols = new Set(iw >= 0 ? [iw] : [ilon, ilat]);
	const props = header.map((h, i) => ({ i, name: String(h).replace(/^﻿/, "").trim() })).filter(c => !geomCols.has(c.i) && c.name && (!keep || keep(c.name)));
	const features = []; let dropped = 0, vertices = 0;
	for (const r of rows) {
		let geometry = null;
		if (iw >= 0) geometry = parseWKT(r[iw]);
		else { const x = +r[ilon], y = +r[ilat]; if (r[ilon] !== "" && r[ilat] !== "" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90) geometry = { type: "Point", coordinates: [x, y] }; }
		if (!geometry) { dropped++; continue; }
		vertices += countVertices(geometry);
		const q = {};
		for (const c of props) { const v = typed(r[c.i]); if (v !== undefined) q[c.name] = v; }
		features.push({ type: "Feature", properties: q, geometry });
	}
	const t1 = now();
	const pbf = await new GeoPBF({ name: opts.name ?? table.sheet ?? "table", precision: opts.precision ?? 6, description: opts.description, license: opts.license, attribution: opts.attribution }).set({ type: "FeatureCollection", features });
	return { pbf, stats: { kind, rows: rows.length, features: features.length, droppedGeometries: dropped, vertices, columns: props.map(c => c.name),
		geometry: iw >= 0 ? { wkt: header[iw] } : { lon: header[ilon], lat: header[ilat] }, sheet: table.sheet ?? null, sheets: table.sheets ?? null, encoding: table.encoding ?? opts.encoding ?? null, delimiter: table.delimiter ?? null,
		precision: opts.precision ?? 6, ms: { read: t1 - t0, encode: now() - t1, total: now() - t0 } } };
}
const countVertices = g => g.type === "Point" ? 1 : g.type === "GeometryCollection" ? g.geometries.reduce((n, x) => n + countVertices(x), 0) : g.coordinates.flat(Infinity).length / 2;
function typed(v) {
	if (v == null) return undefined;
	const s = typeof v === "string" ? v : v; if (typeof s !== "string") return s;   // XLSX 由来の number/boolean はそのまま
	if (s === "") return undefined;
	if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(s)) { const n = Number(s); if (Number.isFinite(n) && Number.isSafeInteger(Math.trunc(n))) return n; }
	if (s === "true" || s === "TRUE" || s === "True") return true;
	if (s === "false" || s === "FALSE" || s === "False") return false;
	return s;
}

// ───────────────────────────── CSV ─────────────────────────────
export function parseCSV(text, opts = {}) {
	if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
	const head = text.slice(0, 4096).split(/\r?\n/)[0] ?? "";
	const delimiter = opts.delimiter ?? [",", "\t", ";", "|"].map(d => [d, (head.match(new RegExp("\\" + d, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
	const rows = []; let row = [], cell = "", q = false, i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (q) {
			if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
			cell += c; i++; continue;
		}
		if (c === '"') { q = true; i++; continue; }
		if (c === delimiter) { row.push(cell); cell = ""; i++; continue; }
		if (c === "\n" || c === "\r") { row.push(cell); cell = ""; rows.push(row); row = []; i += (c === "\r" && text[i + 1] === "\n") ? 2 : 1; continue; }
		cell += c; i++;
	}
	if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
	while (rows.length && rows[rows.length - 1].every(v => v === "")) rows.pop();
	const header = (rows.shift() || []).map(h => h.trim());
	return { header, rows: rows.filter(r => r.some(v => v !== "")).map(r => { while (r.length < header.length) r.push(""); return r; }), delimiter };
}
/** バイト列 → 文字列。encoding 指定が無ければ UTF-8（fatal）→ Shift_JIS の順に試す。BOM は剥がす。 */
export function decodeText(u8, encoding) {
	if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder("utf-8").decode(u8.subarray(3));
	if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder("utf-16le").decode(u8.subarray(2));
	if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder("utf-16be").decode(u8.subarray(2));
	if (encoding && !/^utf-?8$/i.test(encoding)) return new TextDecoder(/^(sjis|shift[-_]?jis|cp932|windows-31j)$/i.test(encoding) ? "shift_jis" : encoding).decode(u8);
	try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); }
	catch { return new TextDecoder("shift_jis").decode(u8); }
}

// ───────────────────────────── XLSX ─────────────────────────────
// zip（modules/decodeZIP）→ xl/workbook.xml（シート名と rId）→ xl/_rels/workbook.xml.rels（rId→パス）→ xl/sharedStrings.xml → シート XML。
// セル: <c r="B3" t="s|b|inlineStr|str|n|e" s="…"><v>…</v>|<is><t>…</t></is></c>。日付は数値（シリアル値）のまま＝スタイルは見ない。
export async function readXLSX(u8, opts = {}) {
	const entries = await decodeZIP(new Blob([u8]));
	if (!entries) throw new Error("xlsx: zip として開けない");
	const byName = new Map(entries.map(f => [f.name.replace(/^\//, ""), f]));
	const text = async n => { const f = byName.get(n); return f ? await f.text() : null; };
	const wb = await text("xl/workbook.xml"); if (!wb) throw new Error("xlsx: xl/workbook.xml が無い（Excel ブックでない）");
	const rels = await text("xl/_rels/workbook.xml.rels") || "";
	const relMap = {}; for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) { const id = attr(m[0], "Id"), tg = attr(m[0], "Target"); if (id && tg) relMap[id] = tg.replace(/^\/?(xl\/)?/, "xl/"); }
	const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: unesc(attr(m[0], "name") || ""), rid: attr(m[0], "r:id") || attr(m[0], "id"), sheetId: attr(m[0], "sheetId") }));
	if (!sheets.length) throw new Error("xlsx: シートが無い");
	const pick = opts.sheet != null ? sheets.find(s => s.name === opts.sheet || String(s.sheetId) === String(opts.sheet)) : sheets[0];
	if (!pick) throw new Error(`xlsx: シート "${opts.sheet}" が無い（シート: ${sheets.map(s => s.name).join(", ")}）`);
	const path = relMap[pick.rid] || `xl/worksheets/sheet${pick.sheetId || 1}.xml`;
	const xml = await text(path); if (!xml) throw new Error(`xlsx: ${path} が無い`);
	const ss = []; const sst = await text("xl/sharedStrings.xml");
	if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) ss.push(unesc([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
	const grid = [];   // 行番号 → 列番号 → 値
	for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
		for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const a = cm[1], inner = cm[2] ?? "", ref = attr(a, "r"), t = attr(a, "t");
			if (!ref) continue;
			const { r, c } = cellRef(ref);
			let v;
			if (t === "inlineStr") v = unesc([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(""));
			else { const vm = inner.match(/<v>([\s\S]*?)<\/v>/); if (!vm) continue; const raw = unesc(vm[1]); v = t === "s" ? ss[+raw] ?? "" : t === "b" ? raw === "1" : t === "str" || t === "e" ? raw : Number(raw); }
			(grid[r] ??= [])[c] = v;
		}
	}
	const rowsAll = grid.filter(Boolean);
	const hi = rowsAll.findIndex(r => r.some(v => v !== undefined && v !== ""));
	if (hi < 0) return { header: [], rows: [], sheet: pick.name, sheets: sheets.map(s => s.name) };
	const header = Array.from(rowsAll[hi], v => v == null ? "" : String(v));
	const rows = rowsAll.slice(hi + 1).map(r => Array.from({ length: header.length }, (_, i) => r[i] == null ? "" : r[i])).filter(r => r.some(v => v !== ""));
	return { header, rows, sheet: pick.name, sheets: sheets.map(s => s.name) };
}
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
function cellRef(ref) { const m = ref.match(/^([A-Z]+)(\d+)$/); let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return { r: +m[2] - 1, c: c - 1 }; }

// ───────────────────────────── WKT ─────────────────────────────
export function parseWKT(text) {
	if (typeof text !== "string") return null;
	let p = 0; const s = text.trim(); if (!s) return null;
	const ws = () => { while (p < s.length && /\s/.test(s[p])) p++; };
	const word = () => { ws(); const m = s.slice(p).match(/^[A-Za-z]+/); if (!m) return null; p += m[0].length; return m[0].toUpperCase(); };
	const expect = ch => { ws(); if (s[p] !== ch) throw new Error(`WKT: "${ch}" が要る（${p} 文字目）`); p++; };
	const num = () => { ws(); const m = s.slice(p).match(/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/); if (!m) throw new Error(`WKT: 数値が要る（${p} 文字目）`); p += m[0].length; return +m[0]; };
	let dims = 2;
	const pt = () => { const c = [num(), num()]; for (let k = 2; k < dims; k++) num(); return c; };
	const seq = () => { expect("("); const out = [pt()]; ws(); while (s[p] === ",") { p++; out.push(pt()); ws(); } expect(")"); return out; };
	const list = f => { expect("("); const out = [f()]; ws(); while (s[p] === ",") { p++; out.push(f()); ws(); } expect(")"); return out; };
	const geom = () => {
		const t = word(); if (!t) throw new Error("WKT: 型名が無い");
		ws(); const zm = s.slice(p).match(/^(ZM|Z|M)\b/i); dims = 2; if (zm) { p += zm[0].length; dims = zm[0].toUpperCase() === "ZM" ? 4 : 3; }
		ws(); if (/^EMPTY\b/i.test(s.slice(p))) { p += 5; return null; }
		switch (t) {
			case "POINT": { expect("("); const c = pt(); expect(")"); return { type: "Point", coordinates: c }; }
			case "LINESTRING": return { type: "LineString", coordinates: seq() };
			case "POLYGON": return { type: "Polygon", coordinates: list(seq) };
			case "MULTIPOINT": { ws(); expect("("); const out = []; do { ws(); if (s[p] === "(") { p++; out.push(pt()); expect(")"); } else out.push(pt()); ws(); } while (s[p] === "," && ++p); expect(")"); return { type: "MultiPoint", coordinates: out }; }
			case "MULTILINESTRING": return { type: "MultiLineString", coordinates: list(seq) };
			case "MULTIPOLYGON": return { type: "MultiPolygon", coordinates: list(() => list(seq)) };
			case "GEOMETRYCOLLECTION": { const gs = list(geom).filter(Boolean); return gs.length ? { type: "GeometryCollection", geometries: gs } : null; }
			default: throw new Error(`WKT: 未対応の型 ${t}`);
		}
	};
	try { const g = geom(); return g; } catch { return null; }
}
