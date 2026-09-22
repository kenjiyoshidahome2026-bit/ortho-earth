// 読める形式・書ける形式の一覧＝このデモの正本（図・ファイル選択の accept・書き出しボタンは全部ここから作る）。
// 並びと中身は geopbf の入口（packages/geopbf/src/index.js の拡張子振り分け）と書き出し（encoder/*・convert/*）に合わせる。
// 形式名は固有名詞＝訳さない。

// 読む（落とす・選ぶ・URL）。ext＝file picker の accept。zip は中身で振り分け（Shapefile / FileGDB / 法務省 地図XML）
export const READ = [
	{ name: "GeoPBF",     ext: [".geopbf", ".pbf"] },
	{ name: "GeoJSON",    ext: [".geojson", ".json"] },
	{ name: "NDJSON",     ext: [".ndjson", ".geojsonl", ".geojsons", ".jsonl"], title: "GeoJSON Lines / GeoJSON Text Sequence" },
	{ name: "TopoJSON",   ext: [".topojson"] },
	{ name: "FlatGeobuf", ext: [".fgb"] },
	{ name: "Shapefile",  ext: [".zip"], title: "zipped .shp/.dbf/.shx/.prj (+ .cpg; Shift_JIS ok)" },
	{ name: "FileGDB",    ext: [".zip"], title: "Esri File Geodatabase (.gdb folder, zipped)" },
	{ name: "GeoPackage", ext: [".gpkg"] },
	{ name: "SpatiaLite", ext: [".sqlite", ".sqlite3", ".spatialite", ".db"] },
	{ name: "GeoParquet", ext: [".parquet", ".geoparquet"] },
	{ name: "CSV / TSV",  ext: [".csv", ".tsv"], title: "lon/lat columns or a WKT column" },
	{ name: "Excel",      ext: [".xlsx"], title: "lon/lat columns or a WKT column" },
	{ name: "KML / KMZ",  ext: [".kml", ".kmz"] },
	{ name: "GPX",        ext: [".gpx"] },
	{ name: "GML",        ext: [".gml", ".xml"] },
	{ name: "CZML",       ext: [".czml"] },
	{ name: "DXF",        ext: [".dxf"] },
	{ name: "MOJ XML",    ext: [".zip"], title: "Japan Ministry of Justice cadastral map XML (zip as distributed)" },
];
// どれでも .gz のまま読める（gunzip してから上の振り分け）
export const ACCEPT = [...new Set(READ.flatMap(f => f.ext)), ".gz"].join(",");

// 書く。gz＝gzip 版を選べる（エンコーダの opts.gz か、geopbf/gzip で後から包む）
export const WRITE = [
	{ key: "geopbf",   name: "GeoPBF",     ext: ".geopbf" },
	{ key: "geojson",  name: "GeoJSON",    ext: ".geojson",  gz: true },
	{ key: "ndjson",   name: "NDJSON",     ext: ".ndjson",   gz: true },
	{ key: "topojson", name: "TopoJSON",   ext: ".topojson", gz: true },
	{ key: "fgb",      name: "FlatGeobuf", ext: ".fgb",      gz: true },
	{ key: "shape",    name: "Shapefile",  ext: ".zip" },
	{ key: "kmz",      name: "KML / KMZ",  ext: ".kmz" },
	{ key: "gpx",      name: "GPX",        ext: ".gpx",      gz: true },
	{ key: "gml",      name: "GML",        ext: ".gml",      gz: true },
	{ key: "czml",     name: "CZML",       ext: ".czml",     gz: true },
	{ key: "parquet",  name: "GeoParquet", ext: ".parquet" },
	{ key: "pmtiles",  name: "PMTiles",    ext: ".pmtiles",  title: "vector tiles (MVT) in one file" },
	{ key: "csv",      name: "CSV",        ext: ".csv",      title: "attributes + lon/lat or WKT" },
	{ key: "xlsx",     name: "Excel",      ext: ".xlsx",     title: "attributes + lon/lat or WKT" },
];

// ── 変換の図（インライン SVG）。旧 gishub.svg（8 形式の固定図）の作り直し＝一覧から組むので形式が増えても図が追従する。
// 横長（広い画面）＝ 読む(2 列) → GeoPBF → 書く(2 列)・下に「球で見る」。縦長（狭い画面）＝ 読む(3 列)／GeoPBF／書く(3 列)。
// 線は「行（または列）ごとに 1 本」＝18 本の交差を作らない。流れの点線は prefers-reduced-motion で止まる（CSS）。
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PW = 100, PH = 24, PITCH = 30, GAP = 8;

// 座標は LTR で組み、RTL（ar/fa/ur/he）は x だけ鏡に写す（X）＝読む側が右・流れは右→左。文字は裏返さない
function pills(list, x0, y0, cols, cls, X) {
	const rows = Math.ceil(list.length / cols);
	return { rows, svg: list.map((f, i) => {
		// 列優先（上から下へ・読む向きに列を進める）＝各列が読みやすい
		const c = Math.floor(i / rows), r = i % rows;
		const x = X(x0 + c * (PW + GAP), PW), y = y0 + r * PITCH;
		const tip = [f.title, (f.ext.join ? f.ext.join(" ") : f.ext)].filter(Boolean).join(" · ");
		return `<g class="pill ${cls}" data-i="${i}" transform="translate(${x},${y})"><title>${esc(f.name)} — ${esc(tip)}</title>` +
			`<rect width="${PW}" height="${PH}" rx="12"/><text x="${PW / 2}" y="${PH / 2 + 0.5}">${esc(f.name)}</text></g>`;
	}).join("") };
}
const curve = (X, x1, y1, x2, y2, horizontal) => {
	const m = horizontal ? (x1 + x2) / 2 : (y1 + y2) / 2;
	return horizontal ? `M${X(x1)},${y1}C${X(m)},${y1} ${X(m)},${y2} ${X(x2)},${y2}` : `M${X(x1)},${y1}C${X(x1)},${m} ${X(x2)},${m} ${X(x2)},${y2}`;
};

export function conversionSVG(t, { narrow = false, rtl = false } = {}) {
	const W = narrow ? 3 * PW + 2 * GAP : 780;
	const X = (x, w = 0) => rtl ? W - x - w : x;
	const hub = (cx, cy) =>
		`<g class="hub" transform="translate(${X(cx)},${cy})"><rect x="-78" y="-34" width="156" height="68" rx="34"/>` +
		`<text class="hub-name" y="-5">GeoPBF</text><text class="hub-sub" y="16">${esc(t("in your browser"))}</text></g>`;
	const head = (x, y, s, end = false) => `<text class="head${end !== rtl ? " end" : ""}" x="${X(x)}" y="${y}">${esc(s)}</text>`;
	const globe = (x, y) => `<g class="globe" transform="translate(${X(x)},${y})"><rect x="-70" y="-14" width="140" height="28" rx="14"/>` +
		`<text y="0.5">🌐 ${esc(t("View on the globe"))}</text></g>`;
	const label = esc(t("$1 formats in, $2 formats out", READ.length, WRITE.length));
	const paths = links => `<g class="links">${links.map(d => `<path d="${d}"/>`).join("")}</g>`;

	if (!narrow) {
		const top = 34;
		const R = pills(READ, 0, top, 2, "read", X), Wr = pills(WRITE, W - 2 * PW - GAP, top, 2, "write", X);
		const H = top + Math.max(R.rows, Wr.rows) * PITCH + 70;
		const cx = W / 2, cy = top + (Math.max(R.rows, Wr.rows) * PITCH) / 2 - 10;
		const rx = 2 * PW + GAP, wx = W - 2 * PW - GAP;
		const links = [
			...Array.from({ length: R.rows }, (_, r) => curve(X, rx + 4, top + r * PITCH + PH / 2, cx - 80, cy, true)),
			...Array.from({ length: Wr.rows }, (_, r) => curve(X, cx + 80, cy, wx - 4, top + r * PITCH + PH / 2, true)),
		];
		return `<svg class="convert" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">` +
			head(0, 16, t("Read · $1 formats (+ .gz)", READ.length)) + head(W, 16, t("Write · $1 formats", WRITE.length), true) +
			paths(links) + `<path class="down" d="M${X(cx)},${cy + 36}V${H - 34}"/>` +
			R.svg + Wr.svg + hub(cx, cy) + globe(cx, H - 18) + `</svg>`;
	}
	const cols = 3;
	const R = pills(READ, 0, 26, cols, "read", X);
	const rEnd = 26 + R.rows * PITCH, cy = rEnd + 56;
	const wTop = cy + 70;
	const Wr = pills(WRITE, 0, wTop + 22, cols, "write", X);
	const H = wTop + 22 + Wr.rows * PITCH;
	// 球は GeoPBF から出る（書き出しの先ではない）＝狭い画面では GeoPBF の隣に置く
	const colX = c => c * (PW + GAP) + PW / 2, cx = 80, gx = W - 72;
	const links = [
		...Array.from({ length: cols }, (_, c) => curve(X, colX(c), rEnd - 2, cx, cy - 36, false)),
		...Array.from({ length: cols }, (_, c) => curve(X, cx, cy + 36, colX(c), wTop + 18, false)),
	];
	return `<svg class="convert narrow" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">` +
		head(0, 16, t("Read · $1 formats (+ .gz)", READ.length)) + head(0, wTop + 12, t("Write · $1 formats", WRITE.length)) +
		paths(links) + `<path class="down" d="M${X(cx + 78)},${cy}H${X(gx - 70)}"/>` +
		R.svg + Wr.svg + hub(cx, cy) + globe(gx, cy) + `</svg>`;
}
