// convert/mbtiles.js ── MBTiles（.mbtiles）をタイル貯蔵庫として開く（読み専用・依存ゼロ＝convert/sqlite.js）。
// MBTiles＝SQLite の tiles(zoom_level, tile_column, tile_row, tile_data) ＋ metadata(name, value)。tile_row は **TMS（下から数える）**＝
// XYZ の y は 2^z − 1 − tile_row。tippecanoe 等は tiles を実表で書き、TileMill/mb-util 系は map(z,x,y,tile_id)＋images(tile_data,tile_id) の
// 上に tiles ビューを張る＝両方読む（ビューは SQL を解釈しないので map/images を直接引く）。
// 戻りは openGpkgTiles と同じ形（xyz は常に true）: { name, format, metadata, zooms, xyz, count, bboxLonLat, has(z,x,y), get(z,x,y), mimeOf }
// タイルのバイト列はそのまま返す（MVT は gzip 包みのことが多い＝mimeOf が "application/gzip" を返す・展開は呼び手）。
import { openSqlite } from "./sqlite.js";
import { mimeOf } from "./gpkg.js";

export function openMBTiles(u8) {
	const db = openSqlite(u8);
	const metadata = {};
	if (db.tables.has("metadata")) for (const r of db.rows("metadata")) metadata[r.name] = r.value;
	const key = (z, x, y) => `${z}/${x}/${y}`;
	const flip = (z, row) => (2 ** z) - 1 - row;
	const index = new Map();   // z/x/y → rowid（tiles 実表）または tile_id（map/images）
	let get;
	if (db.tables.has("tiles")) {
		const t = db.table("tiles"), ci = Object.fromEntries(t.columns.map((c, i) => [c.name, i]));
		for (const k of ["zoom_level", "tile_column", "tile_row", "tile_data"]) if (ci[k] === undefined) throw new Error(`mbtiles: tiles 表に列 ${k} が無い`);
		for (const { rowid, values: v } of db.rowsProjected("tiles", [ci.zoom_level, ci.tile_column, ci.tile_row])) index.set(key(v[ci.zoom_level], v[ci.tile_column], flip(v[ci.zoom_level], v[ci.tile_row])), rowid);
		get = (z, x, y) => { const id = index.get(key(z, x, y)); if (id === undefined) return null; return db.get("tiles", id)?.tile_data ?? null; };
	} else if (db.tables.has("map") && db.tables.has("images")) {
		const m = db.table("map"), mi = Object.fromEntries(m.columns.map((c, i) => [c.name, i]));
		const im = db.table("images"), ii = Object.fromEntries(im.columns.map((c, i) => [c.name, i]));
		for (const k of ["zoom_level", "tile_column", "tile_row", "tile_id"]) if (mi[k] === undefined) throw new Error(`mbtiles: map 表に列 ${k} が無い`);
		if (ii.tile_id === undefined || ii.tile_data === undefined) throw new Error("mbtiles: images 表に tile_id / tile_data が無い");
		const byId = new Map();   // tile_id → images の rowid（tile_data は読み飛ばす）
		for (const { rowid, values: v } of db.rowsProjected("images", [ii.tile_id])) byId.set(v[ii.tile_id], rowid);
		for (const { values: v } of db.rowsProjected("map", [mi.zoom_level, mi.tile_column, mi.tile_row, mi.tile_id])) { const id = v[mi.tile_id]; if (id != null && byId.has(id)) index.set(key(v[mi.zoom_level], v[mi.tile_column], flip(v[mi.zoom_level], v[mi.tile_row])), byId.get(id)); }
		get = (z, x, y) => { const id = index.get(key(z, x, y)); if (id === undefined) return null; return db.get("images", id)?.tile_data ?? null; };
	} else throw new Error(`mbtiles: tiles 表も map/images 表も無い（表: ${[...db.tables.keys()].join(", ")}）`);
	const zs = new Set(); for (const k of index.keys()) zs.add(+k.slice(0, k.indexOf("/")));
	const zooms = [...zs].sort((a, b) => a - b);
	const bounds = metadata.bounds ? metadata.bounds.split(",").map(Number) : null;
	return {
		kind: "mbtiles", name: metadata.name ?? null, format: metadata.format ?? null, metadata, zooms, xyz: true, count: index.size,
		bboxLonLat: bounds && bounds.length === 4 && bounds.every(Number.isFinite) ? bounds : null,
		minZoom: metadata.minzoom != null ? +metadata.minzoom : zooms[0], maxZoom: metadata.maxzoom != null ? +metadata.maxzoom : zooms[zooms.length - 1],
		has: (z, x, y) => index.has(key(z, x, y)), get, mimeOf, warnings: db.warnings,
	};
}
