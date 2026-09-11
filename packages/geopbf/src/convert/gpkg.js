// convert/gpkg.js ── GeoPackage（.gpkg）→ GeoPBF。読み専用・依存ゼロ（SQLite は convert/sqlite.js の自前リーダ）。
// 「配布されている .gpkg をそのままブラウザに落とす／npx geopbf gpkg2pbf」のための入口。書き出し（GeoPBF → GPKG）は持たない＝GDAL に任せる。
//
//   const { layers, tiles } = readGeoPackage(u8);             // 層の一覧（地物表・幾何列・SRS・件数／タイル表・ズーム域）
//   const { pbf, stats } = await fromGeoPackage(u8, { layer }); // 1 層 → GeoPBF（layer 省略＝最初の地物層）
//   const t = openGpkgTiles(u8, "std"); t.get(14, 14552, 6451) // ラスタ（タイル表）を z/x/y で直引き（PNG/JPEG/WebP のバイト列）
//
// 読むもの: gpkg_contents（data_type='features'）・gpkg_geometry_columns・gpkg_spatial_ref_sys・地物表の全行。
// 幾何 BLOB は GeoPackageBinary（"GP" ヘッダ＋envelope＋WKB）。空フラグ／NULL／拡張型の地物は落として数える（stats.droppedGeometries＝GeoPBF は幾何なしを持てない）。Z/M は落とす（GeoPBF は 2D）。
// CRS: 経緯度（EPSG:4326・OGC:CRS84・srs_id 0＝未定義の地理系）はそのまま、EPSG:3857（900913/102100）は経緯度へ戻す、
//      それ以外は ignoreCrs が無い限り投げる（GeoPBF は経緯度のみ＝再投影は GDAL 等で先に）。
// 属性: SQLite の型そのまま（INTEGER/REAL/TEXT）。宣言型 BOOLEAN → bool、DATE/DATETIME/TIMESTAMP → Date、BLOB 列は読まない（stats.skipped）。
//       安全整数を超える INTEGER は文字列にする（精度を黙って落とさない）。rowid 別名（fid）は属性として残す。
import { GeoPBF } from "../pbf-base.js";
import { openSqlite } from "./sqlite.js";
import { parseWkb } from "./wkb.js";
import { attrFilter } from "./attrs.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const R = 6378137, D = 180 / Math.PI;

/** GeoPackage を開いて層の一覧を返す（変換はしない）。 */
export function readGeoPackage(u8) {
	const db = openSqlite(u8);
	if (!db.tables.has("gpkg_contents")) throw new Error("gpkg: GeoPackage でない（gpkg_contents が無い・ただの SQLite）");
	const srsById = new Map();
	if (db.tables.has("gpkg_spatial_ref_sys")) for (const r of db.rows("gpkg_spatial_ref_sys")) srsById.set(r.srs_id, { id: r.srs_id, name: r.srs_name, org: r.organization, code: r.organization_coordsys_id, definition: r.definition });
	const geomCols = new Map();
	if (db.tables.has("gpkg_geometry_columns")) for (const r of db.rows("gpkg_geometry_columns")) geomCols.set(r.table_name, r);
	const layers = [], tiles = [], others = [];
	for (const c of db.rows("gpkg_contents")) {
		const base = { table: c.table_name, dataType: c.data_type, identifier: c.identifier, description: c.description || "", lastChange: c.last_change, bbox: c.min_x == null ? null : [c.min_x, c.min_y, c.max_x, c.max_y] };
		if (c.data_type === "tiles" && db.tables.has(c.table_name)) {
			const srs = srsById.get(c.srs_id) ?? { id: c.srs_id, org: "?", code: c.srs_id, definition: "" };
			const zooms = db.tables.has("gpkg_tile_matrix") ? [...db.rows("gpkg_tile_matrix")].filter(m => m.table_name === c.table_name).map(m => m.zoom_level).sort((a, b) => a - b) : [];
			tiles.push({ ...base, srs, crs: classifyCrs(srs), zooms, count: db.count(c.table_name) });
			continue;
		}
		if (c.data_type !== "features") { others.push(base); continue; }
		const g = geomCols.get(c.table_name);
		const t = db.tables.get(c.table_name);
		if (!t) { others.push({ ...base, missing: true }); continue; }
		const srs = srsById.get(g?.srs_id ?? c.srs_id) ?? { id: g?.srs_id ?? c.srs_id, org: "?", code: g?.srs_id ?? c.srs_id, definition: "" };
		layers.push({ ...base, geometryColumn: g?.column_name ?? t.columns.find(k => /GEOMETRY|POINT|LINESTRING|POLYGON|CURVE|SURFACE/i.test(k.type))?.name ?? null,
			geometryType: g?.geometry_type_name ?? "GEOMETRY", z: g?.z ?? 0, m: g?.m ?? 0, srs, crs: classifyCrs(srs), columns: t.columns.map(k => ({ name: k.name, type: k.type })), count: db.count(c.table_name) });
	}
	return { db, layers, tiles, others, encoding: db.encoding, pageSize: db.pageSize, warnings: db.warnings };
}

/** 1 層を GeoPBF へ。opts: { layer, precision(既定 6), name, ignoreCrs, include/exclude/excludeAll } */
export async function fromGeoPackage(u8, opts = {}) {
	const t0 = now();
	const g = readGeoPackage(u8);
	if (!g.layers.length) throw new Error(`gpkg: 地物層（data_type='features'）が無い（他: ${g.others.map(o => `${o.table}(${o.dataType})`).join(", ") || "なし"}）`);
	const layer = opts.layer ? g.layers.find(l => l.table === opts.layer || l.identifier === opts.layer) : g.layers[0];
	if (!layer) throw new Error(`gpkg: 層 "${opts.layer}" が無い（層: ${g.layers.map(l => l.table).join(", ")}）`);
	const kind = layer.crs.kind;
	if (kind === "other" && !opts.ignoreCrs) throw new Error(`gpkg: 層 "${layer.table}" の CRS が経緯度でない（${layer.crs.label}）。GeoPBF は経緯度のみ＝再投影してから、または ignoreCrs`);
	const xf = kind === "mercator" ? mercToLonLat : null;
	const keep = attrFilter(opts);
	const gcol = layer.geometryColumn;
	const props = layer.columns.filter(c => c.name !== gcol && !/^BLOB$/i.test(c.type) && (!keep || keep(c.name)));
	const skipped = layer.columns.filter(c => c.name !== gcol && /^BLOB$/i.test(c.type)).map(c => ({ name: c.name, reason: "BLOB" }));
	const conv = props.map(c => ({ name: c.name, fn: valueConverter(c.type) }));
	const ctx = { vertices: 0, empty: 0, extended: 0, bigint: 0, nulls: 0 };
	const features = [];
	for (const row of g.db.rows(layer.table)) {
		const b = gcol ? row[gcol] : null;
		const geometry = b ? parseGpkgGeometry(b, ctx, xf) : null;
		if (!geometry) { ctx.nulls++; continue; }   // GeoPBF のワイヤは幾何なしの地物を持てない（fgb/kmz デコーダと同じく落として数える）
		const q = {};
		for (const { name, fn } of conv) { const v = row[name]; if (v !== null && v !== undefined) { const c = fn(v, ctx); if (c !== undefined) q[name] = c; } }
		features.push({ type: "Feature", properties: q, geometry });
	}
	const t1 = now();
	const pbf = await new GeoPBF({ name: opts.name ?? layer.identifier ?? layer.table, precision: opts.precision ?? 6, description: opts.description ?? (layer.description || undefined), license: opts.license, attribution: opts.attribution }).set({ type: "FeatureCollection", features });
	const stats = { layer: layer.table, layers: g.layers.map(l => l.table), features: features.length, vertices: ctx.vertices, columns: props.map(c => c.name), skipped, crs: layer.crs.label,
		reprojected: kind === "mercator", precision: opts.precision ?? 6, droppedGeometries: ctx.nulls, emptyGeometries: ctx.empty, extendedGeometries: ctx.extended, bigints: ctx.bigint, z: !!layer.z, m: !!layer.m, encoding: g.encoding, warnings: g.warnings,
		ms: { read: t1 - t0, encode: now() - t1, total: now() - t0 } };
	return { pbf, stats };
}

/** GeoPackageBinary → GeoJSON geometry（null＝空/NULL/拡張型）。 */
export function parseGpkgGeometry(b, ctx, xf) {
	if (!(b instanceof Uint8Array)) b = new Uint8Array(b);
	if (b.length < 8 || b[0] !== 0x47 || b[1] !== 0x50) throw new Error("gpkg: 幾何 BLOB が GeoPackageBinary でない（先頭 GP が無い）");
	const flags = b[3];
	if (flags & 0x10) { ctx.empty++; return null; }          // 空フラグ
	if (flags & 0x20) { ctx.extended++; return null; }       // 拡張型（GPKG 拡張の独自幾何）＝読めない
	const envLen = [0, 32, 48, 48, 64, 0, 0, 0][(flags >> 1) & 7];
	if (envLen === 0 && ((flags >> 1) & 7) > 4) throw new Error("gpkg: envelope indicator が不正 " + ((flags >> 1) & 7));
	const geom = parseWkb(b, ctx, { offset: 8 + envLen });
	return finish(geom, xf);
}
function finish(g, xf) {
	if (!g) return null;
	if (g.type === "GeometryCollection") { g.geometries = g.geometries.map(x => finish(x, xf)).filter(Boolean); return g.geometries.length ? g : null; }
	if (g.type === "Point") { if (!Number.isFinite(g.coordinates[0])) return null; if (xf) g.coordinates = xf(g.coordinates); return g; }
	if (!g.coordinates.length) return null;
	if (xf) g.coordinates = mapDeep(g.coordinates, xf);
	return g;
}
const mapDeep = (c, f) => typeof c[0] === "number" ? f(c) : c.map(x => mapDeep(x, f));
function mercToLonLat([x, y]) { return [x / R * D, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * D]; }

/** srs → { kind: "lonlat" | "mercator" | "other", label } */
export function classifyCrs(srs) {
	const id = srs?.id, org = String(srs?.org ?? "").toUpperCase(), code = Number(srs?.code);
	const label = org && org !== "?" ? `${org}:${code}` : `srs_id ${id}`;
	if (id === 4326 || (org === "EPSG" && code === 4326) || (org === "OGC" && String(srs?.code).toUpperCase() === "CRS84")) return { kind: "lonlat", label };
	if (id === 0 || (org === "NONE" && code === 0)) return { kind: "lonlat", label: "undefined geographic (srs_id 0)" };
	if (id === 3857 || (org === "EPSG" && (code === 3857 || code === 900913 || code === 102100 || code === 3785))) return { kind: "mercator", label };
	if (/GEOGCS\["WGS ?84"|GEOGCRS\["WGS 84"/i.test(srs?.definition || "") && !/PROJCS|PROJCRS/i.test(srs?.definition || "")) return { kind: "lonlat", label: label + " (WGS 84 by definition)" };
	return { kind: "other", label };
}

const SAFE = Number.MAX_SAFE_INTEGER;
function valueConverter(type) {
	const t = (type || "").toUpperCase();
	if (/^BOOL/.test(t)) return v => typeof v === "number" ? v !== 0 : v;
	if (/^(DATE|DATETIME|TIMESTAMP)\b/.test(t)) return v => { if (typeof v !== "string") return v; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00Z" : v); return isNaN(+d) ? v : d; };
	return (v, ctx) => {
		if (typeof v === "bigint") { ctx.bigint++; return v.toString(); }
		if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) > SAFE) { ctx.bigint++; return v.toString(); }   // 整数値の巨大 REAL（1e300 等）は GeoPBF が整数扱いで書けない＝文字列で保つ
		if (v instanceof Uint8Array) return undefined;   // 宣言型が BLOB でないのに BLOB が入っている＝落とす
		return v;
	};
}

// ───────────────────────────── ラスタ（タイル表） ─────────────────────────────
// GeoPackage のラスタは XYZ ピラミッドそのもの（gpkg_tile_matrix_set＝格子の外枠・gpkg_tile_matrix＝ズーム毎の行列・
// タイル表＝zoom_level/tile_column/tile_row/tile_data）。ここでは COG 等へ変換せず、タイルをそのまま引く口だけを持つ
// （裁定 2026-09-12: 表示はタイル直読み・変換なし）。tile_row は上から数える＝EPSG:3857 の全世界格子なら XYZ の y と一致。
//   open → { table, srs, crs, matrixSet, matrices: Map z→{width,height,tileWidth,tileHeight,pxX,pxY}, zooms, xyz, count,
//            bboxLonLat（3857/4326 の時だけ・[w,s,e,n]）, has(z,x,y), get(z,x,y) → Uint8Array|null, mimeOf(u8) }
// 索引は初回に「先頭 3 列だけ復号する走査」で z/x/y → rowid を作り（BLOB は触らない）、get は rowid 直引き＝タイル 1 枚分のコピーだけ。
const WORLD = 20037508.342789244;
export function openGpkgTiles(u8, table) {
	const g = readGeoPackage(u8);
	const info = table ? g.tiles.find(t => t.table === table || t.identifier === table) : g.tiles[0];
	if (!info) throw new Error(table ? `gpkg: タイル表 "${table}" が無い（タイル表: ${g.tiles.map(t => t.table).join(", ") || "なし"}）` : "gpkg: タイル表（data_type='tiles'）が無い");
	const db = g.db, name = info.table;
	const ms = db.tables.has("gpkg_tile_matrix_set") ? [...db.rows("gpkg_tile_matrix_set")].find(r => r.table_name === name) : null;
	const matrixSet = ms ? { minX: ms.min_x, minY: ms.min_y, maxX: ms.max_x, maxY: ms.max_y } : null;
	const matrices = new Map();
	if (db.tables.has("gpkg_tile_matrix")) for (const m of db.rows("gpkg_tile_matrix")) if (m.table_name === name) matrices.set(m.zoom_level, { width: m.matrix_width, height: m.matrix_height, tileWidth: m.tile_width, tileHeight: m.tile_height, pxX: m.pixel_x_size, pxY: m.pixel_y_size });
	const zooms = [...matrices.keys()].sort((a, b) => a - b);
	// XYZ 同型か＝3857・外枠が全世界・各ズームが 2^z × 2^z・256px
	const near = (a, b) => Math.abs(a - b) < 1;
	const xyz = info.crs.kind === "mercator" && !!matrixSet && near(matrixSet.minX, -WORLD) && near(matrixSet.maxX, WORLD) && near(matrixSet.minY, -WORLD) && near(matrixSet.maxY, WORLD)
		&& zooms.every(z => { const m = matrices.get(z); return m.width === 2 ** z && m.height === 2 ** z && m.tileWidth === 256 && m.tileHeight === 256; });
	// 索引: z/x/y → rowid
	const t = db.table(name), ci = Object.fromEntries(t.columns.map((c, i) => [c.name, i]));
	for (const k of ["zoom_level", "tile_column", "tile_row", "tile_data"]) if (ci[k] === undefined) throw new Error(`gpkg: タイル表 "${name}" に列 ${k} が無い`);
	const limit = Math.max(ci.zoom_level, ci.tile_column, ci.tile_row) + 1;
	const index = new Map();
	for (const { rowid, values } of db.rowsProjected(name, limit)) index.set(key(values[ci.zoom_level], values[ci.tile_column], values[ci.tile_row]), rowid);
	const bboxLonLat = info.bbox ? (info.crs.kind === "mercator" ? [...mercToLonLat([info.bbox[0], info.bbox[1]]), ...mercToLonLat([info.bbox[2], info.bbox[3]])] : info.crs.kind === "lonlat" ? info.bbox : null) : null;
	return {
		table: name, identifier: info.identifier, description: info.description, srs: info.srs, crs: info.crs, matrixSet, matrices, zooms, xyz, count: index.size, bboxLonLat,
		has: (z, x, y) => index.has(key(z, x, y)),
		get: (z, x, y) => { const id = index.get(key(z, x, y)); if (id === undefined) return null; const row = db.get(name, id); return row ? row.tile_data : null; },
		mimeOf,
	};
}
const key = (z, x, y) => `${z}/${x}/${y}`;
/** タイルのバイト列から MIME（署名判定）。 */
export function mimeOf(b) {
	if (!b || b.length < 12) return "application/octet-stream";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
	if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return "image/tiff";
	return "application/octet-stream";
}
