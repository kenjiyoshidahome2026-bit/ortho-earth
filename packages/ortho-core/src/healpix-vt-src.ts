// HEALPix のベクタタイル（bucket の GIS/hpx/osm・面ごとの PMTiles・docs/design/healpix.md §5）の読み口（2026-11-27）。
// 置き方：<dir>/index.json { minOrder, maxOrder, extent, layers, faces: [{ face, file, tiles, bytes }] } ＋ <dir>/face{f}.pmtiles。
// PMTiles の (z, x, y) ＝ (Norder, 面の中の ix, iy)＝メルカトルではない＝範囲の門（ヘッダの bbox）を通さない fetchPMTilesAt で引く。
// ここは「番地 → タイルの中身」まで。どのタイルを描くか・頂点を地球のどこへ置くか（hpxTilePointLonLat）は使う側。
import { cellOf, hpxParent } from "./healpix.ts";
import { fetchPMTilesAt, pmtilesParallelRanges } from "./pmtiles-src.ts";
import { decodeTile, loadTileFormat } from "./decode.ts";
import type { TileData } from "./tileformat.ts";

export const HPX_OSM_DIR = "GIS/hpx/osm";
/** 目録（index.json）のうち読む分 */
export interface HpxVtIndex { minOrder: number; maxOrder: number; extent: number; layers: string[]; faces: { face: number; file: string; tiles: number; bytes: number }[]; made?: string; source?: string }
/** 引いた 1 枚。order/npix＝実際に中身を出したタイル（up > 0 なら頼んだタイルの up 段上の祖先） */
export interface HpxVtTile { order: number; npix: number; up: number; data: TileData }
export interface HpxVtSource {
	/** 目録（1 回だけ取る。失敗は覚えない＝次の呼び出しで取り直す） */
	index(): Promise<HpxVtIndex>;
	/** 生の MVT。面が無い・段が範囲の外・索引に無い＝null */
	raw(order: number, npix: number, signal?: AbortSignal | null): Promise<Uint8Array | null>;
	/** 解読したタイル。無ければ { __empty: true }（陸の物が何も無い所＝焼いていない） */
	tile(order: number, npix: number, signal?: AbortSignal | null, need?: Set<string> | null): Promise<TileData>;
	/** 頼んだ段が最大の段より細かい時は最大の段の祖先を返す（up 段上）。そこに何も無ければ null。切り出し・引き伸ばしは使う側 */
	nearest(order: number, npix: number, signal?: AbortSignal | null, need?: Set<string> | null): Promise<HpxVtTile | null>;
}

/** 目録の形を確かめる（壊れた目録で黙って空の地図にしない） */
export function checkHpxVtIndex(j: unknown): HpxVtIndex {
	const i = j as Partial<HpxVtIndex> | null;
	if (!i || !Number.isInteger(i.minOrder) || !Number.isInteger(i.maxOrder) || i.minOrder! > i.maxOrder! || !Array.isArray(i.faces)) throw new Error("hpx-vt: bad index.json");
	for (const f of i.faces) if (!Number.isInteger(f?.face) || f.face < 0 || f.face > 11 || !/^[\w.-]+\.pmtiles$/.test(f.file ?? "")) throw new Error("hpx-vt: bad face entry in index.json");
	return { minOrder: i.minOrder!, maxOrder: i.maxOrder!, extent: i.extent ?? 4096, layers: Array.isArray(i.layers) ? i.layers : [], faces: i.faces, made: i.made, source: i.source };
}

export function createHpxVtSource({ apiUrl, dir = HPX_OSM_DIR, fetchFn = (u: string, init?: RequestInit) => fetch(u, init) }: { apiUrl: string; dir?: string; fetchFn?: (url: string, init?: RequestInit) => Promise<Response> }): HpxVtSource {
	const base = `${apiUrl.replace(/\/$/, "")}/bucket/${dir}/`;
	let idx: Promise<{ index: HpxVtIndex; files: Map<number, string> }> | null = null;
	const load = () => idx ??= (async () => {
		const res = await fetchFn(base + "index.json");
		if (!res.ok) throw new Error(`hpx-vt index HTTP ${res.status}`);
		// 置き場の JSON は gzip で置かれる（Bucket.put）＝ブラウザーが Content-Encoding を解いた後も中身がまだ gzip（頭 1f 8b）で届く。Bucket.get と同じく自分で解く
		let b = new Uint8Array(await res.arrayBuffer());
		if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
		const index = checkHpxVtIndex(JSON.parse(new TextDecoder().decode(b)));
		// 版の印を URL に付ける（?v=）＝Worker が Range を区間ごとにエッジへ載せる条件（版なしは載せない＝書き換えの後に古い区間と混ざるため）。焼いた時刻＋束の大きさ
		const ver = (f: { bytes: number }) => encodeURIComponent(`${index.made ?? ""}-${f.bytes ?? 0}`);
		const files = new Map(index.faces.map(f => [f.face, `pmtiles://${base}${f.file}?v=${ver(f)}`]));
		for (const u of files.values()) pmtilesParallelRanges(u);   // Range を同時に引く（Chrome が同じ URL の Range を 1 本ずつにする件・pmtiles-src.ts）
		return { index, files };
	})().catch(e => { idx = null; throw e; });
	const cell = { face: 0, ix: 0, iy: 0 };
	const raw = async (order: number, npix: number, signal?: AbortSignal | null): Promise<Uint8Array | null> => {
		const { index, files } = await load();
		if (order < index.minOrder || order > index.maxOrder) return null;
		const c = cellOf(order, npix, cell), url = files.get(c.face);   // await の前に読み切る（cell は使い回し）
		return url ? fetchPMTilesAt(url, order, c.ix, c.iy, signal) : null;
	};
	const tile = async (order: number, npix: number, signal?: AbortSignal | null, need?: Set<string> | null): Promise<TileData> => {
		const b = await raw(order, npix, signal);
		if (!b) return { __empty: true };
		await loadTileFormat("mvt");
		return decodeTile(b, need, "mvt");
	};
	return {
		index: async () => (await load()).index, raw, tile,
		async nearest(order, npix, signal, need) {
			const { index } = await load();
			if (order < index.minOrder) return null;
			let up = 0; for (; order > index.maxOrder; order--, up++) npix = hpxParent(npix);
			const data = await tile(order, npix, signal, need);
			return (data as { __empty?: true }).__empty ? null : { order, npix, up, data };
		},
	};
}
