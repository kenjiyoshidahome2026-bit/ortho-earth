// convert/tilesource.js ── GeoPBF（＋gint）を「要求されたタイルだけ」MVT に組む（2026-10-12・geopbf 改良点 ⑥）。
// toPMTiles（tiler.js）と同じ本体（prepareTiling＝unpack→project→較正→lodCount→属性表、columnJob＝1 ズーム×列の job、assembleZoom）を
// 使い、ズームの圧縮座標（lodWrite）はズーム単位、組み立ては列（tx）単位で遅延して持つ＝MapLibre の addProtocol から z/x/y で引ける。
// 同じ入力・同じ options なら toPMTiles のタイルと MVT のバイト列が一致する（clip.js の二分は列の分担で結果が変わらない。
// tinyPolygon の積算も main 側の決定表（tiler.js tinyDecisions・改良点 13）＝列の分担に依らない）。
// worker プールは使わない（1 列ぶんの組み立ては小さく、呼び手は 1 タイルずつ待つ）。gzip もしない（MapLibre は生の MVT を受ける）。
//
// const src = await createTileSource(pbf, { gint, minZoom, maxZoom, extent, buffer, layer, simplification, lodBias, dropRate, tinyPolygon, tinyLine,
//                                           include, exclude, excludeAll, gpu, zoomCache = 4, columnCache = 256 });
// src.tile(z, x, y) → Promise<Uint8Array | null>（null＝そのタイルに feature が無い／範囲外）
// src.metadata（toPMTiles と同じ・vector_layers.fields 入り）・src.minZoom/maxZoom/bounds/layerName・src.stats・src.destroy()
import { prepareTiling, columnJob } from "./tiler.ts";
import type { TilerSource, TilingOptions, TilingStats, ZoomOut } from "./tiler.ts";
import { assembleZoom } from "./assemble.ts";
import { zxyToTileId } from "./pmtiles.ts";
import type { PMTilesMetadata } from "./pmtiles.ts";

export interface TileSourceOptions extends TilingOptions { zoomCache?: number; columnCache?: number }
export interface TileSource {
	readonly metadata: PMTilesMetadata;
	readonly stats: TilingStats;
	minZoom: number;
	maxZoom: number;
	bounds: number[];
	layerName: string;
	extent: number;
	tile(z: number, x: number, y: number): Promise<Uint8Array | null>;
	destroy(): void;
}

export async function createTileSource(pbf: TilerSource, opts: TileSourceOptions = {}): Promise<TileSource> {
	const P = await prepareTiling(pbf, opts);
	const { A, counts, bbox, S, minZoom, maxZoom, stats } = P;
	const zoomMax = Math.max(1, opts.zoomCache ?? 4), colMax = Math.max(1, opts.columnCache ?? 256);
	const zooms = new Map<number, Promise<ZoomOut>>();   // k → Promise<{ out, zo, sum }>（LRU・Map の挿入順＝古い順）
	const cols = new Map<string, Promise<Map<number, Uint8Array>>>();    // "z/x" → Promise<Map<ty, Uint8Array>>
	const touch = <K, V>(m: Map<K, V>, key: K, v: V): V => { m.delete(key); m.set(key, v); return v; };
	const zoomOf = (k: number): Promise<ZoomOut> => {
		const hit = zooms.get(k);
		if (hit) return touch(zooms, k, hit);
		const p = P.zoomOut(k);
		touch(zooms, k, p);
		if (zooms.size > zoomMax) zooms.delete(zooms.keys().next().value as number);
		return p;
	};
	const columnOf = (z: number, x: number): Promise<Map<number, Uint8Array>> => {
		const key = z + "/" + x, hit = cols.get(key);
		if (hit) return touch(cols, key, hit);
		const k = z - minZoom;
		const p = zoomOf(k).then(({ out, zo }) => {
			const zc = counts.subarray(k * A, (k + 1) * A), zb = bbox.subarray(k * A * 4, (k + 1) * A * 4);
			const J = columnJob(P, { z, out, zo, zc, zb, txFrom: x, txTo: x });
			const r = assembleZoom(S, J), byKey = new Map(r.contents), m = new Map<number, Uint8Array>();
			for (const t of r.tiles) m.set(t.id, byKey.get(t.key) as Uint8Array);
			stats.tiles += r.tiles.length;
			return m;
		});
		touch(cols, key, p);
		if (cols.size > colMax) cols.delete(cols.keys().next().value as string);
		return p;
	};
	let alive = true;
	return {
		get metadata() { return P.metadata; }, get stats() { return stats; },
		minZoom, maxZoom, bounds: P.bounds, layerName: P.layerName, extent: P.extent,
		async tile(z: number, x: number, y: number): Promise<Uint8Array | null> {
			if (!alive) throw new Error("tile source destroyed");
			if (!(Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y)) || z < minZoom || z > maxZoom) return null;
			const n = 2 ** z;
			if (x < 0 || x >= n || y < 0 || y >= n) return null;
			const m = await columnOf(z, x);
			return m.get(zxyToTileId(z, x, y)) ?? null;
		},
		destroy() { if (!alive) return; alive = false; zooms.clear(); cols.clear(); P.destroy(); },
	};
}
