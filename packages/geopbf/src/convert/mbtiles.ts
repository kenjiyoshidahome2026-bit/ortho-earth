// convert/mbtiles.js ── MBTiles（.mbtiles）をタイル貯蔵庫として開く（読み専用・依存ゼロ＝convert/sqlite.js）。
// MBTiles＝SQLite の tiles(zoom_level, tile_column, tile_row, tile_data) ＋ metadata(name, value)。tile_row は **TMS（下から数える）**＝
// XYZ の y は 2^z − 1 − tile_row。tippecanoe 等は tiles を実表で書き、TileMill/mb-util 系は map(z,x,y,tile_id)＋images(tile_data,tile_id) の
// 上に tiles ビューを張る＝両方読む（ビューは SQL を解釈しないので map/images を直接引く）。
// 戻りは openGpkgTiles と同じ形（xyz は常に true）: { name, format, metadata, zooms, xyz, count, bboxLonLat, has(z,x,y), get(z,x,y), mimeOf }
// タイルのバイト列はそのまま返す（MVT は gzip 包みのことが多い＝mimeOf が "application/gzip" を返す・展開は呼び手）。
import { openSqlite } from "./sqlite.ts";
import type { SqlValue } from "./sqlite.ts";
import { mimeOf } from "./gpkg.ts";

export interface MBTiles {
	kind: "mbtiles";
	name: string | null;
	format: string | null;
	metadata: Record<string, SqlValue>;
	zooms: number[];
	xyz: true;
	count: number;
	bboxLonLat: number[] | null;
	minZoom: number;
	maxZoom: number;
	has(z: number, x: number, y: number): boolean;
	get(z: number, x: number, y: number): Uint8Array | null;
	mimeOf(b: Uint8Array | null | undefined): string;
	warnings: string[];
}

export function openMBTiles(u8: Uint8Array | ArrayBuffer | ArrayBufferView): MBTiles {
	const db = openSqlite(u8);
	const metadata: Record<string, SqlValue> = {};
	if (db.tables.has("metadata")) for (const r of db.rows("metadata")) metadata[r.name as string] = r.value;
	const key = (z: SqlValue, x: SqlValue, y: SqlValue): string => `${z}/${x}/${y}`;
	const flip = (z: number, row: number): number => (2 ** z) - 1 - row;
	const index = new Map<string, number>();   // z/x/y → rowid（tiles 実表）または tile_id（map/images）
	let get: (z: number, x: number, y: number) => Uint8Array | null;
	if (db.tables.has("tiles")) {
		const t = db.table("tiles"), ci: Record<string, number | undefined> = Object.fromEntries(t.columns.map((c, i) => [c.name, i]));
		for (const k of ["zoom_level", "tile_column", "tile_row", "tile_data"]) if (ci[k] === undefined) throw new Error(`mbtiles: tiles table has no column ${k}`);
		const iz = ci.zoom_level as number, ix = ci.tile_column as number, iy = ci.tile_row as number;
		for (const { rowid, values: v } of db.rowsProjected("tiles", [iz, ix, iy])) index.set(key(v[iz], v[ix], flip(v[iz] as number, v[iy] as number)), rowid);
		get = (z, x, y) => { const id = index.get(key(z, x, y)); if (id === undefined) return null; return (db.get("tiles", id)?.tile_data as Uint8Array | null | undefined) ?? null; };
	} else if (db.tables.has("map") && db.tables.has("images")) {
		const m = db.table("map"), mi: Record<string, number | undefined> = Object.fromEntries(m.columns.map((c, i) => [c.name, i]));
		const im = db.table("images"), ii: Record<string, number | undefined> = Object.fromEntries(im.columns.map((c, i) => [c.name, i]));
		for (const k of ["zoom_level", "tile_column", "tile_row", "tile_id"]) if (mi[k] === undefined) throw new Error(`mbtiles: map table has no column ${k}`);
		if (ii.tile_id === undefined || ii.tile_data === undefined) throw new Error("mbtiles: images table has no tile_id / tile_data");
		const mz = mi.zoom_level as number, mx = mi.tile_column as number, my = mi.tile_row as number, mid = mi.tile_id as number, iid = ii.tile_id;
		const byId = new Map<SqlValue, number>();   // tile_id → images の rowid（tile_data は読み飛ばす）
		for (const { rowid, values: v } of db.rowsProjected("images", [iid])) byId.set(v[iid], rowid);
		for (const { values: v } of db.rowsProjected("map", [mz, mx, my, mid])) { const id = v[mid]; if (id != null && byId.has(id)) index.set(key(v[mz], v[mx], flip(v[mz] as number, v[my] as number)), byId.get(id) as number); }
		get = (z, x, y) => { const id = index.get(key(z, x, y)); if (id === undefined) return null; return (db.get("images", id)?.tile_data as Uint8Array | null | undefined) ?? null; };
	} else throw new Error(`mbtiles: neither tiles nor map/images tables found (tables: ${[...db.tables.keys()].join(", ")})`);
	const zs = new Set<number>(); for (const k of index.keys()) zs.add(+k.slice(0, k.indexOf("/")));
	const zooms = [...zs].sort((a, b) => a - b);
	const bounds = metadata.bounds ? String(metadata.bounds).split(",").map(Number) : null;
	return {
		kind: "mbtiles", name: (metadata.name as string | undefined) ?? null, format: (metadata.format as string | undefined) ?? null, metadata, zooms, xyz: true, count: index.size,
		bboxLonLat: bounds && bounds.length === 4 && bounds.every(Number.isFinite) ? bounds : null,
		minZoom: metadata.minzoom != null ? +(metadata.minzoom as string | number) : zooms[0], maxZoom: metadata.maxzoom != null ? +(metadata.maxzoom as string | number) : zooms[zooms.length - 1],
		has: (z, x, y) => index.has(key(z, x, y)), get, mimeOf, warnings: db.warnings,
	};
}
