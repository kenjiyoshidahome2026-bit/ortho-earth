// convert/spatialite.js ── SpatiaLite（.sqlite / .spatialite）→ GeoPBF。自前 SQLite リーダ（sqlite.js）＋自前の幾何 BLOB 復号＝GDAL 不要・読み専用。
//   const { layers } = readSpatiaLite(u8);                 // 層（geometry_columns の行）一覧
//   const { pbf, stats } = await fromSpatiaLite(u8, { layer }); // 1 層 → GeoPBF（layer 省略＝最初の層）
// 幾何 BLOB（gaiaGeomBlob）: 0x00 | endian(1=LE) | SRID i32 | MBR 4 doubles | 0x7C | class u32 | 本体 | 0xFE。
//   class = 1..7（XY）・+1000（XYZ）・+2000（XYM）・+3000（XYZM）・+1000000（圧縮＝先頭/末尾は double・中間は直前点からの float 差分。
//   Z も float 差分・M は double のまま）。Multi*/Collection の各要素は 0x69（ENTITY 印）＋ class u32 で始まる。
//   TinyPoint（SpatiaLite 5）: 0x00 | 0x81(LE)/0x80(BE) | SRID | kind(1 XY 2 XYZ 3 XYM 4 XYZM) | doubles | 0xFE。
// CRS は spatial_ref_sys（auth_name/auth_srid/srtext）→ gpkg.js の classifyCrs（4326 素通し・3857 逆変換・投影 WKT は proj.js）。
import { GeoPBF } from "../pbf-base.js";
import { openSqlite } from "./sqlite.js";
import { attrFilter } from "./attrs.js";
import { mercToLonLat } from "../modules/mercator.js";
import { classifyCrs, valueConverter } from "./gpkg.js";
import { resolveDatum, datumStats } from "./datum.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const TYPES = { 1: "Point", 2: "LineString", 3: "Polygon", 4: "MultiPoint", 5: "MultiLineString", 6: "MultiPolygon", 7: "GeometryCollection" };

/** 幾何 BLOB → GeoJSON geometry（2D・Z/M は読み飛ばす）。ctx.vertices に頂点数を積む。null（NULL 幾何）はそのまま null */
export function parseSpatiaLiteBlob(u8, ctx) {
	if (!u8 || u8.length < 8) return null;
	if (u8[0] !== 0x00) throw new Error("spatialite: 幾何 BLOB の先頭が 0x00 でない");
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const marker = u8[1];
	if (marker & 0x80) {   // TinyPoint
		const le = (marker & 1) === 1;
		ctx.vertices++;
		return { type: "Point", coordinates: [dv.getFloat64(7, le), dv.getFloat64(15, le)] };
	}
	const le = marker === 1;
	if (u8[38] !== 0x7c) throw new Error("spatialite: MBR 終端 0x7C が無い");
	let p = 39;
	const entity = () => {
		let t = dv.getUint32(p, le); p += 4;
		let compressed = false, hasZ = false, hasM = false;
		if (t >= 1000000) { compressed = true; t -= 1000000; }
		if (t >= 3000) { t -= 3000; hasZ = hasM = true; } else if (t >= 2000) { t -= 2000; hasM = true; } else if (t >= 1000) { t -= 1000; hasZ = true; }
		const type = TYPES[t]; if (!type) throw new Error("spatialite: geometry class " + t);
		const extra = (hasZ ? 8 : 0) + (hasM ? 8 : 0);
		const pt = () => { const c = [dv.getFloat64(p, le), dv.getFloat64(p + 8, le)]; p += 16 + extra; ctx.vertices++; return c; };
		const seq = () => {
			const n = dv.getUint32(p, le); p += 4;
			const out = new Array(n);
			if (!compressed) { for (let i = 0; i < n; i++) out[i] = pt(); return out; }
			let x = 0, y = 0;
			for (let i = 0; i < n; i++) {
				if (i === 0 || i === n - 1) { x = dv.getFloat64(p, le); y = dv.getFloat64(p + 8, le); p += 16 + extra; }
				else { x += dv.getFloat32(p, le); y += dv.getFloat32(p + 4, le); p += 8 + (hasZ ? 4 : 0) + (hasM ? 8 : 0); }
				out[i] = [x, y]; ctx.vertices++;
			}
			return out;
		};
		if (t === 1) return { type, coordinates: pt() };   // Point は圧縮でも double
		if (t === 2) return { type, coordinates: seq() };
		if (t === 3) { const n = dv.getUint32(p, le); p += 4; const rings = new Array(n); for (let i = 0; i < n; i++) rings[i] = seq(); return { type, coordinates: rings }; }
		const n = dv.getUint32(p, le); p += 4;
		const parts = new Array(n);
		for (let i = 0; i < n; i++) { if (u8[p] !== 0x69) throw new Error("spatialite: ENTITY 印 0x69 が無い"); p++; parts[i] = entity(); }
		if (t === 7) return { type, geometries: parts };
		return { type, coordinates: parts.map(g => g.coordinates) };
	};
	return entity();
}

const isEmpty = g => !g ? true : g.type === "Point" ? !Number.isFinite(g.coordinates[0]) : g.type === "GeometryCollection" ? !g.geometries.length : !g.coordinates.length;

/** SpatiaLite を開いて層の一覧を返す（変換はしない）。 */
export function readSpatiaLite(u8, opts = {}) {
	const db = openSqlite(u8);
	if (!db.tables.has("geometry_columns")) throw new Error("spatialite: SpatiaLite でない（geometry_columns が無い・ただの SQLite か GeoPackage）");
	const srsById = new Map();
	if (db.tables.has("spatial_ref_sys")) for (const r of db.rows("spatial_ref_sys")) srsById.set(r.srid, { id: r.srid, name: r.ref_sys_name, org: r.auth_name, code: r.auth_srid, definition: r.srtext && r.srtext !== "Undefined" ? r.srtext : "" });
	const byLower = new Map([...db.tables.values()].map(t => [t.name.toLowerCase(), t]));
	const layers = [], missing = [];
	for (const g of db.rows("geometry_columns")) {
		const t = db.tables.get(g.f_table_name) ?? byLower.get(String(g.f_table_name).toLowerCase());
		if (!t) { missing.push(g.f_table_name); continue; }
		// v4: geometry_type INTEGER（1..7・+1000 Z・+2000 M・+3000 ZM・0＝GEOMETRY）／v2-3: type TEXT（"POINT" 等）＋ coord_dimension "XYZ"
		const gt = g.geometry_type;
		const info = typeof gt === "number"
			? { name: gt === 0 ? "GEOMETRY" : (TYPES[gt % 1000] ?? String(gt)).toUpperCase(), z: (gt >= 1000 && gt < 2000) || gt >= 3000, m: gt >= 2000 }
			: { name: String(g.type ?? "GEOMETRY").toUpperCase(), z: /Z/i.test(String(g.coord_dimension ?? "")), m: /M/i.test(String(g.coord_dimension ?? "")) };
		const srs = srsById.get(g.srid) ?? { id: g.srid, org: "?", code: g.srid, definition: "" };
		const gcol = t.columns.find(k => k.name.toLowerCase() === String(g.f_geometry_column).toLowerCase())?.name ?? g.f_geometry_column;
		layers.push({ table: t.name, geometryColumn: gcol, geometryType: info.name, z: info.z, m: info.m, srid: g.srid, srs, crs: classifyCrs(srs, opts.datum),
			columns: t.columns.map(k => ({ name: k.name, type: k.type })), count: db.count(t.name) });
	}
	return { db, layers, missing, encoding: db.encoding, pageSize: db.pageSize, warnings: db.warnings };
}

/** 1 層を GeoPBF へ。opts: { layer, precision(既定 6), name, ignoreCrs, include/exclude/excludeAll, tky2jgd, patchjgd } */
export async function fromSpatiaLite(u8, opts = {}) {
	const t0 = now();
	const datum = await resolveDatum(opts);
	const g = readSpatiaLite(u8, { datum });
	if (!g.layers.length) throw new Error(`spatialite: 幾何列を持つ表が無い（geometry_columns が空${g.missing.length ? `・表が無い: ${g.missing.join(", ")}` : ""}）`);
	const layer = opts.layer ? g.layers.find(l => l.table === opts.layer || l.table.toLowerCase() === String(opts.layer).toLowerCase()) : g.layers[0];
	if (!layer) throw new Error(`spatialite: 層 "${opts.layer}" が無い（層: ${g.layers.map(l => l.table).join(", ")}）`);
	const kind = layer.crs.kind;
	if (kind === "other" && !opts.ignoreCrs) throw new Error(`spatialite: 層 "${layer.table}" の CRS が経緯度でない（${layer.crs.label}）。GeoPBF は経緯度のみ＝再投影してから、または ignoreCrs`);
	const xf = kind === "mercator" ? mercToLonLat : layer.crs.toLonLat ?? null;
	const keep = attrFilter(opts);
	const gcol = layer.geometryColumn;
	const props = layer.columns.filter(c => c.name !== gcol && !/^BLOB$/i.test(c.type) && (!keep || keep(c.name)));
	const skipped = layer.columns.filter(c => c.name !== gcol && /^BLOB$/i.test(c.type)).map(c => ({ name: c.name, reason: "BLOB" }));
	const conv = props.map(c => ({ name: c.name, fn: valueConverter(c.type) }));
	const ctx = { vertices: 0, empty: 0, bigint: 0, nulls: 0, bad: 0 };
	const mapDeep = (c, f) => typeof c[0] === "number" ? f(c) : c.map(x => mapDeep(x, f));
	const project = geom => {
		if (!xf) return geom;
		if (geom.type === "GeometryCollection") { geom.geometries = geom.geometries.map(project); return geom; }
		geom.coordinates = mapDeep(geom.coordinates, xf); return geom;
	};
	const keys = props.map(c => c.name).sort();   // スキーマの属性列（gpkg/gdb/parquet と同じ規則）
	const pbf = new GeoPBF({ name: opts.name ?? layer.table, precision: opts.precision ?? 6, description: opts.description, license: opts.license, attribution: opts.attribution });
	pbf.setHead(keys, []);
	let count = 0;
	pbf.setBody(() => {
		for (const row of g.db.rows(layer.table)) {
			const b = row[gcol];
			let geometry = null;
			if (b instanceof Uint8Array) { try { geometry = parseSpatiaLiteBlob(b, ctx); } catch (e) { ctx.bad++; geometry = null; } }
			if (geometry && isEmpty(geometry)) { ctx.empty++; geometry = null; }
			if (!geometry) { ctx.nulls++; continue; }   // 幾何なしは落として数える（gpkg と同じ）
			const q = {};
			for (const { name, fn } of conv) { const v = row[name]; if (v !== null && v !== undefined) { const c = fn(v, ctx); if (c !== undefined) q[name] = c; } }
			pbf.setFeature({ type: "Feature", properties: q, geometry: project(geometry) }); count++;
		}
	});
	const t1 = now();
	pbf.close();
	await pbf.getPosition();
	const stats = { layer: layer.table, layers: g.layers.map(l => l.table), features: count, vertices: ctx.vertices, columns: props.map(c => c.name), skipped, crs: layer.crs.label,
		reprojected: !!xf, datumApprox: !!layer.crs.approx, datum: datumStats(datum), precision: opts.precision ?? 6, droppedGeometries: ctx.nulls, emptyGeometries: ctx.empty, badGeometries: ctx.bad, bigints: ctx.bigint,
		z: !!layer.z, m: !!layer.m, encoding: g.encoding, warnings: g.warnings, ms: { read: t1 - t0, encode: now() - t1, total: now() - t0 } };
	return { pbf, stats };
}
