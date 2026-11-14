// 大きな PMTiles（OSM planet・GEL）から z8 タイルの矩形だけを Range で切り出して、小さな PMTiles v3 を書く（UNMAP オフライン版 M3・2026-11-14）。
//   planExtract(src, rect, minZoom, maxZoom) … ヘッダと索引（根＋要る葉だけ）を Range で読み、要るタイルの索引項目を集める＝正確な大きさの見積もりにもなる
//   writeExtract(src, plan, sink, opts)        … タイルの中身を近い物どうし大きな Range にまとめて読み、sink に書く。最後に索引・metadata・ヘッダ
// 範囲の考え方：PMTiles のタイル ID はヒルベルト順＝z8 の 1 枚の子孫は各ズームで連続した ID の区間になる（区間の数＝矩形の枚数×ズーム数）。
// z8 より粗いズームは祖先の 1 枚ずつ。矩形は日付変更線を跨がない（跨ぐ時は呼び手が 2 つに割る＝splitZ8Rect）。
// 書き出しの並び：ヘッダ(127) | 根の索引（先頭 16384 バイトに収める＝pmtiles.js は最初の読みで根まで取る）| タイル | metadata | 葉の索引。
// 中断と再開：チャンクの区切りは計画から決まる（同じアーカイブなら同じ）＝何チャンク書いたかだけ覚えれば続きから書ける。
// DOM 不使用（worker の SyncAccessHandle で書く・node の検定ではメモリに書く）。

/** PMTiles v3 のヘッダ（全項目） */
export interface PMHeader {
	rootOffset: number; rootLength: number; metadataOffset: number; metadataLength: number;
	leafOffset: number; leafLength: number; dataOffset: number; dataLength: number;
	addressedTiles: number; tileEntries: number; tileContents: number;
	clustered: boolean; internalCompression: number; tileCompression: number; tileType: number;
	minZoom: number; maxZoom: number; minLon: number; minLat: number; maxLon: number; maxLat: number;
	centerZoom: number; centerLon: number; centerLat: number;
}
/** 索引の 1 項目（runLength 0＝葉への指し） */
export interface PMEntry { tileId: number; offset: number; length: number; runLength: number }
/** Range の読み手：(offset, length) → その範囲のバイト列 */
export type RangeRead = (offset: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>;
/** 書き手：at に書く（worker の SyncAccessHandle・node の検定はメモリ）。read は検証に使う */
export interface ExtractSink { write(data: Uint8Array, at: number): void | Promise<void>; read(at: number, length: number): Uint8Array | Promise<Uint8Array>; truncate?(size: number): void | Promise<void>; flush?(): void | Promise<void> }
/** z8 のタイルの矩形（両端を含む・x0 ≤ x1＝日付変更線を跨がない） */
export interface Z8Rect { x0: number; x1: number; y0: number; y1: number }

export const RECT_ZOOM = 8;
const ROOT_SPACE = 16384;   // 根の索引はここまでに収める（pmtiles.js の最初の読み）
const HEADER = 127;

// ── ヘッダ ──
export function parseHeader(b: Uint8Array): PMHeader {
	if (b.byteLength < HEADER || String.fromCharCode(...b.subarray(0, 7)) !== "PMTiles" || b[7] !== 3) throw new Error("not a PMTiles v3 archive");
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const u = (o: number) => Number(v.getBigUint64(o, true)), e7 = (o: number) => v.getInt32(o, true) / 1e7;
	return {
		rootOffset: u(8), rootLength: u(16), metadataOffset: u(24), metadataLength: u(32), leafOffset: u(40), leafLength: u(48), dataOffset: u(56), dataLength: u(64),
		addressedTiles: u(72), tileEntries: u(80), tileContents: u(88), clustered: b[96] === 1, internalCompression: b[97], tileCompression: b[98], tileType: b[99],
		minZoom: b[100], maxZoom: b[101], minLon: e7(102), minLat: e7(106), maxLon: e7(110), maxLat: e7(114), centerZoom: b[118], centerLon: e7(119), centerLat: e7(123),
	};
}
export function serializeHeader(h: PMHeader): Uint8Array {
	const b = new Uint8Array(HEADER), v = new DataView(b.buffer);
	b.set([80, 77, 84, 105, 108, 101, 115, 3]);   // "PMTiles" v3
	const u = (o: number, n: number) => v.setBigUint64(o, BigInt(n), true), e7 = (o: number, d: number) => v.setInt32(o, Math.round(d * 1e7), true);
	u(8, h.rootOffset); u(16, h.rootLength); u(24, h.metadataOffset); u(32, h.metadataLength); u(40, h.leafOffset); u(48, h.leafLength); u(56, h.dataOffset); u(64, h.dataLength);
	u(72, h.addressedTiles); u(80, h.tileEntries); u(88, h.tileContents);
	b[96] = h.clustered ? 1 : 0; b[97] = h.internalCompression; b[98] = h.tileCompression; b[99] = h.tileType; b[100] = h.minZoom; b[101] = h.maxZoom;
	e7(102, h.minLon); e7(106, h.minLat); e7(110, h.maxLon); e7(114, h.maxLat); b[118] = h.centerZoom; e7(119, h.centerLon); e7(123, h.centerLat);
	return b;
}

// ── 索引（varint の列：数・ID の差・runLength・length・offset（0＝直前の続き・他は +1）） ──
export function deserializeDir(b: Uint8Array): PMEntry[] {
	let p = 0;
	const rd = (): number => { let n = 0, m = 1, c: number; do { if (p >= b.length) throw new Error("pmtiles directory truncated"); c = b[p++]; n += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return n; };
	const n = rd(), out: PMEntry[] = new Array(n);
	let id = 0;
	for (let i = 0; i < n; i++) { id += rd(); out[i] = { tileId: id, offset: 0, length: 0, runLength: 1 }; }
	for (let i = 0; i < n; i++) out[i].runLength = rd();
	for (let i = 0; i < n; i++) out[i].length = rd();
	for (let i = 0; i < n; i++) { const o = rd(); out[i].offset = o === 0 && i > 0 ? out[i - 1].offset + out[i - 1].length : o - 1; }
	return out;
}
export function serializeDir(es: PMEntry[]): Uint8Array {
	const v: number[] = [];
	const w = (n: number) => { while (n >= 128) { v.push((n % 128) | 128); n = Math.floor(n / 128); } v.push(n); };
	w(es.length);
	let last = 0; for (const e of es) { w(e.tileId - last); last = e.tileId; }
	for (const e of es) w(e.runLength);
	for (const e of es) w(e.length);
	es.forEach((e, i) => w(i > 0 && e.offset === es[i - 1].offset + es[i - 1].length ? 0 : e.offset + 1));
	return new Uint8Array(v);
}

async function inflate(b: Uint8Array, compression: number): Promise<Uint8Array> {
	if (compression === 0 || compression === 1) return b;
	if (compression !== 2) throw new Error(`pmtiles: unsupported internal compression ${compression}`);
	const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}

// ── タイル ID（ヒルベルト）＝pmtiles.js の zxyToTileId と同じ ──
const ZBASE: number[] = []; { let a = 0; for (let z = 0; z <= 26; z++) { ZBASE.push(a); a += 4 ** z; } }
export function tileId(z: number, x: number, y: number): number {
	const n = 2 ** z; let d = 0, rx: number, ry: number;
	for (let s = n / 2; s >= 1; s /= 2) {
		rx = (x & s) > 0 ? 1 : 0; ry = (y & s) > 0 ? 1 : 0;
		d += s * s * ((3 * rx) ^ ry);
		if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } const t = x; x = y; y = t; }
	}
	return ZBASE[z] + d;
}

/** タイル ID → [z, x, y]（tileId の逆） */
export function tileZxy(id: number): [number, number, number] {
	const z = zoomOfId(id), n = 2 ** z; let d = id - ZBASE[z], x = 0, y = 0;
	for (let s = 1; s < n; s *= 2) {
		const rx = 1 & (d / 2), ry = 1 & (d ^ rx);
		if (ry === 0) { if (rx === 1) { x = s - 1 - x; y = s - 1 - y; } const t = x; x = y; y = t; }
		x += s * rx; y += s * ry; d = Math.floor(d / 4);
	}
	return [z, x, y];
}
/** アーカイブの全部の索引項目（根と葉を全部たどる・ID 昇順）。手元のファイルの索引作り（地名の索引など）に */
export async function listEntries(src: ExtractSource, signal?: AbortSignal): Promise<PMEntry[]> {
	const h = src.header, out: PMEntry[] = [];
	const walk = async (offset: number, length: number): Promise<void> => {
		signal?.throwIfAborted();
		for (const e of deserializeDir(await inflate(await src.read(offset, length, signal), h.internalCompression))) {
			if (e.runLength === 0) await walk(h.leafOffset + e.offset, e.length); else out.push(e);
		}
	};
	await walk(h.rootOffset, h.rootLength);
	return out;
}
/** 1 枚のタイルの中身（タイル圧縮は解かない＝呼び手が header.tileCompression を見る）。無ければ null */
export async function readTileAt(src: ExtractSource, e: PMEntry, signal?: AbortSignal): Promise<Uint8Array> {
	return src.read(src.header.dataOffset + e.offset, e.length, signal);
}
/** タイル圧縮（gzip=2）を解く */
export const decompressTile = (b: Uint8Array, compression: number): Promise<Uint8Array> => inflate(b, compression);

// ── 矩形 ──
const lon2x = (lon: number, z: number) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat: number, z: number) => { const r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const x2lon = (x: number, z: number) => x / 2 ** z * 360 - 180;
const y2lat = (y: number, z: number) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return Math.atan(Math.sinh(n)) * 180 / Math.PI; };
const N8 = 2 ** RECT_ZOOM;
const clampY = (y: number) => Math.max(0, Math.min(N8 - 1, y));

/** 経緯度の 1 点の z8 タイル */
export function z8Of(lon: number, lat: number): [number, number] { return [((lon2x(lon, RECT_ZOOM) % N8) + N8) % N8, clampY(lat2y(lat, RECT_ZOOM))]; }
/** 点を中心に n×n 枚（n は奇数）。x は折り返す＝日付変更線を跨ぐと x0 > x1 になる（splitZ8Rect で割る） */
export function z8Around(lon: number, lat: number, n = 3): Z8Rect {
	const [x, y] = z8Of(lon, lat), h = Math.floor(n / 2);
	let y0 = y - h, y1 = y + h;
	if (y0 < 0) { y1 -= y0; y0 = 0; } if (y1 > N8 - 1) { y0 -= y1 - (N8 - 1); y1 = N8 - 1; }
	const wx = (v: number) => ((v % N8) + N8) % N8;
	return { x0: wx(x - h), x1: wx(x + h), y0: clampY(y0), y1: clampY(y1) };
}
/** 経緯度の箱（w > e＝日付変更線を跨ぐ）を z8 の矩形へ（外へ丸める） */
export function z8OfBbox(w: number, s: number, e: number, n: number): Z8Rect {
	const wx = (v: number) => ((v % N8) + N8) % N8, eps = 1e-9;
	return { x0: wx(lon2x(w, RECT_ZOOM)), x1: e >= 180 ? N8 - 1 : wx(lon2x(e - eps, RECT_ZOOM)), y0: clampY(lat2y(n, RECT_ZOOM)), y1: clampY(lat2y(s + eps, RECT_ZOOM)) };
}
/** 日付変更線を跨ぐ矩形（x0 > x1）を 2 つに割る */
export function splitZ8Rect(r: Z8Rect): Z8Rect[] {
	return r.x0 <= r.x1 ? [r] : [{ ...r, x1: N8 - 1 }, { ...r, x0: 0 }];
}
/** z8 矩形の枚数 */
export const z8Count = (r: Z8Rect): number => (r.x0 <= r.x1 ? r.x1 - r.x0 + 1 : N8 - r.x0 + r.x1 + 1) * (r.y1 - r.y0 + 1);
/** z8 矩形の経緯度の箱 [w, s, e, n]（跨ぐ時は w > e） */
export const z8Bbox = (r: Z8Rect): [number, number, number, number] => [x2lon(r.x0, RECT_ZOOM), y2lat(r.y1 + 1, RECT_ZOOM), x2lon(r.x1 + 1, RECT_ZOOM), y2lat(r.y0, RECT_ZOOM)];

/** 矩形の要る ID の区間（[start, end)・昇順・重なりと隣り合いは繋ぐ）。z < 8＝祖先の 1 枚ずつ・z ≥ 8＝子孫の連続区間 */
export function idRanges(r: Z8Rect, minZoom: number, maxZoom: number): [number, number][] {
	if (r.x0 > r.x1) throw new Error("idRanges: split the rectangle at the antimeridian first");
	const rs: [number, number][] = [];
	for (let z = minZoom; z <= maxZoom; z++) {
		if (z < RECT_ZOOM) {
			const k = RECT_ZOOM - z, seen = new Set<number>();
			for (let x = r.x0 >> k; x <= r.x1 >> k; x++) for (let y = r.y0 >> k; y <= r.y1 >> k; y++) { const id = tileId(z, x, y); if (!seen.has(id)) { seen.add(id); rs.push([id, id + 1]); } }
		} else {
			const span = 4 ** (z - RECT_ZOOM);
			for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) { const a = ZBASE[z] + (tileId(RECT_ZOOM, x, y) - ZBASE[RECT_ZOOM]) * span; rs.push([a, a + span]); }
		}
	}
	return mergeRanges(rs);
}
/** 全球の z0–maxZoom（世界の土台） */
export const worldRanges = (minZoom: number, maxZoom: number): [number, number][] => [[ZBASE[minZoom], ZBASE[maxZoom + 1]]];
function mergeRanges(rs: [number, number][]): [number, number][] {
	rs.sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const r of rs) { const l = out[out.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); }
	return out;
}
/** ID の属するズーム */
export function zoomOfId(id: number): number { let z = 0; while (z < 26 && ZBASE[z + 1] <= id) z++; return z; }

// ── 計画 ──
export interface ExtractSource { read: RangeRead; header: PMHeader; metadata: Record<string, unknown>; etag: string | null; size: number | null }
/** HTTP の Range の読み手。206 以外（全量が返る＝Range 非対応）は失敗にする（planet を丸ごと落とさない） */
export function httpRange(url: string, info?: { etag?: string | null; size?: number | null }): RangeRead {
	return async (offset, length, signal) => {
		const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal, cache: "no-store" });
		if (r.status !== 206) { await r.body?.cancel().catch(() => {}); throw new Error(r.ok ? "server ignored the Range header" : `HTTP ${r.status}`); }
		if (info) {
			info.etag ??= r.headers.get("etag");
			const cr = r.headers.get("content-range"); const tot = cr && /\/(\d+)$/.exec(cr); if (tot) info.size ??= +tot[1];
		}
		const b = new Uint8Array(await r.arrayBuffer());
		if (b.byteLength !== length) throw new Error(`short read ${b.byteLength}/${length}`);
		return b;
	};
}
/** ヘッダと metadata を読んで切り出しの元にする（url＝https の PMTiles か、読み手そのもの） */
export async function openExtractSource(src: string | RangeRead): Promise<ExtractSource> {
	const info: { etag?: string | null; size?: number | null } = {};
	const read = typeof src === "string" ? httpRange(src, info) : src;
	const header = parseHeader(await read(0, HEADER));
	let metadata: Record<string, unknown> = {};
	if (header.metadataLength) try { metadata = JSON.parse(new TextDecoder().decode(await inflate(await read(header.metadataOffset, header.metadataLength), header.internalCompression))); } catch {}
	return { read, header, metadata, etag: info.etag ?? null, size: info.size ?? null };
}

/** 切り出しの計画：要るタイルの索引項目（元の offset のまま・ID 昇順）と大きさ */
export interface ExtractPlan {
	minZoom: number; maxZoom: number; bbox: [number, number, number, number];
	entries: PMEntry[];
	/** タイルの中身の重複を除いたバイト数（＝書くタイルの量） */
	bytes: number;
	/** ズームごとのバイト数（重複を除く前の概算・上限ズームの選び直しに使う） */
	bytesByZoom: Record<number, number>;
	tiles: number;
}
type DirCache = Map<number, PMEntry[]>;
/** 区間の集合に [a, b) が触れるか（rs は昇順） */
function touches(rs: [number, number][], a: number, b: number): boolean {
	let lo = 0, hi = rs.length;
	while (lo < hi) { const m = (lo + hi) >> 1; if (rs[m][1] <= a) lo = m + 1; else hi = m; }
	return lo < rs.length && rs[lo][0] < b;
}
/** 計画を立てる。ranges＝idRanges か worldRanges。cache＝葉の索引の覚え（同じ元で何度も見積もる UI 用） */
export async function planExtract(src: ExtractSource, ranges: [number, number][], { minZoom, maxZoom, bbox, cache = new Map(), signal, concurrency = 6 }: { minZoom: number; maxZoom: number; bbox: [number, number, number, number]; cache?: DirCache; signal?: AbortSignal; concurrency?: number }): Promise<ExtractPlan> {
	const h = src.header, out: PMEntry[] = [];
	const dirAt = async (offset: number, length: number): Promise<PMEntry[]> => {
		const hit = cache.get(offset); if (hit) return hit;
		const d = deserializeDir(await inflate(await src.read(offset, length, signal), h.internalCompression));
		cache.set(offset, d); return d;
	};
	// 根から：葉の指しは次の項目の ID まで＝その区間に要る ID があれば降りる
	let level: { entries: PMEntry[] }[] = [{ entries: await dirAt(h.rootOffset, h.rootLength) }];
	while (level.length) {
		const leaves: PMEntry[] = [];
		for (const { entries } of level) {
			for (let i = 0; i < entries.length; i++) {
				const e = entries[i];
				if (e.runLength === 0) { const end = i + 1 < entries.length ? entries[i + 1].tileId : Infinity; if (touches(ranges, e.tileId, end)) leaves.push(e); }
				else clip(e, ranges, out);
			}
		}
		const next: { entries: PMEntry[] }[] = [];
		for (let i = 0; i < leaves.length; i += concurrency) {
			signal?.throwIfAborted();
			const got = await Promise.all(leaves.slice(i, i + concurrency).map(e => dirAt(h.leafOffset + e.offset, e.length)));
			for (const entries of got) next.push({ entries });
		}
		level = next;
	}
	out.sort((a, b) => a.tileId - b.tileId);
	const seen = new Set<number>(), byZ: Record<number, number> = {};
	let bytes = 0, tiles = 0;
	for (const e of out) {
		const z = zoomOfId(e.tileId); byZ[z] = (byZ[z] || 0) + e.length; tiles += e.runLength;
		if (!seen.has(e.offset)) { seen.add(e.offset); bytes += e.length; }
	}
	return { minZoom, maxZoom, bbox, entries: out, bytes, bytesByZoom: byZ, tiles };
}
// 項目 e（[id, id+run)）を区間で切って out へ
function clip(e: PMEntry, rs: [number, number][], out: PMEntry[]): void {
	const a = e.tileId, b = e.tileId + e.runLength;
	let lo = 0, hi = rs.length;
	while (lo < hi) { const m = (lo + hi) >> 1; if (rs[m][1] <= a) lo = m + 1; else hi = m; }
	for (let i = lo; i < rs.length && rs[i][0] < b; i++) {
		const s = Math.max(a, rs[i][0]), t = Math.min(b, rs[i][1]);
		if (t > s) out.push({ tileId: s, offset: e.offset, length: e.length, runLength: t - s });
	}
}
/** 計画を上限ズームで絞る（容量の上限に合わせて選び直す時・索引を読み直さない） */
export function trimPlan(p: ExtractPlan, maxZoom: number): ExtractPlan {
	const lim = ZBASE[maxZoom + 1];
	const entries = p.entries.filter(e => e.tileId < lim).map(e => e.tileId + e.runLength > lim ? { ...e, runLength: lim - e.tileId } : e);
	const seen = new Set<number>(), byZ: Record<number, number> = {};
	let bytes = 0, tiles = 0;
	for (const e of entries) { const z = zoomOfId(e.tileId); byZ[z] = (byZ[z] || 0) + e.length; tiles += e.runLength; if (!seen.has(e.offset)) { seen.add(e.offset); bytes += e.length; } }
	return { ...p, maxZoom, entries, bytes, bytesByZoom: byZ, tiles };
}
/** 容量 cap に収まる一番細かい上限ズーム（収まらなければ minZoom） */
export function maxZoomWithin(p: ExtractPlan, cap: number): number {
	for (let z = p.maxZoom; z > p.minZoom; z--) if (trimPlan(p, z).bytes <= cap) return z;
	return p.minZoom;
}

// ── 書き出し ──
/** 読むチャンク：元の [start, end) と、その中の中身（重複なし・元の offset 昇順）。書き先は連続 */
export interface Chunk { start: number; end: number; dst: number; blobs: { offset: number; length: number }[] }
/** 元の中身を近い物どうしまとめる（隙間 < gap・1 チャンク ≤ max）。書き先 offset は元の順に詰める */
export function chunkPlan(entries: PMEntry[], { gap = 256 << 10, max = 16 << 20 } = {}): { chunks: Chunk[]; dstOf: Map<number, number>; dataLength: number } {
	const uniq = new Map<number, number>();
	for (const e of entries) if (!uniq.has(e.offset)) uniq.set(e.offset, e.length);
	const blobs = [...uniq].map(([offset, length]) => ({ offset, length })).sort((a, b) => a.offset - b.offset);
	const chunks: Chunk[] = [], dstOf = new Map<number, number>();
	let dst = 0, cur: Chunk | null = null;
	for (const b of blobs) {
		if (b.offset < (cur?.end ?? 0)) {   // 重なる中身（普通は無い）＝前のチャンクの中を指す
			dstOf.set(b.offset, dstInside(cur!, b.offset)); continue;
		}
		if (!cur || b.offset - cur.end > gap || b.offset + b.length - cur.start > max) { cur = { start: b.offset, end: b.offset, dst, blobs: [] }; chunks.push(cur); }
		cur.blobs.push(b); cur.end = b.offset + b.length; dstOf.set(b.offset, dst); dst += b.length;
	}
	return { chunks, dstOf, dataLength: dst };
}
// チャンクの中の元 offset の書き先（先の中身の途中を指す時）
const dstInside = (c: Chunk, off: number): number => { let d = c.dst; for (const b of c.blobs) { if (off < b.offset + b.length) return d + Math.max(0, off - b.offset); d += b.length; } return d; };

/** 書き出しの進み（再開の覚え） */
export interface ExtractProgress { chunk: number; chunks: number; bytes: number; total: number }
/**
 * 計画どおりに書く。startChunk＝前回書き終えたチャンクの数（再開）。onProgress は各チャンクの後（覚えを保存する機会）。
 * 戻り＝書いた PMTiles の大きさ。最後に自分で書いた索引を読み直して数を確かめる（合わなければ投げる）。
 */
export async function writeExtract(src: ExtractSource, plan: ExtractPlan, sink: ExtractSink, { startChunk = 0, onProgress, signal, parallel = 3, metadata, chunking }: { startChunk?: number; chunking?: { gap?: number; max?: number }; onProgress?: (p: ExtractProgress) => void | Promise<void>; signal?: AbortSignal; parallel?: number; metadata?: Record<string, unknown> } = {}): Promise<number> {
	const h = src.header;
	const { chunks, dstOf, dataLength } = chunkPlan(plan.entries, chunking);
	const DATA = ROOT_SPACE;
	// タイル：先読み parallel 本・書くのは順に
	const fetchChunk = (c: Chunk) => src.read(h.dataOffset + c.start, c.end - c.start, signal);   // 索引の offset はタイル域の先頭から
	const inflight = new Map<number, Promise<Uint8Array>>();
	const want = (i: number) => { if (i < chunks.length && !inflight.has(i)) inflight.set(i, fetchChunk(chunks[i])); };
	let done = chunks.slice(0, startChunk).reduce((s, c) => s + c.blobs.reduce((t, b) => t + b.length, 0), 0);
	for (let i = startChunk; i < chunks.length; i++) {
		signal?.throwIfAborted();
		for (let k = i; k < i + parallel; k++) want(k);
		const buf = await inflight.get(i)!; inflight.delete(i);
		const c = chunks[i], len = c.blobs.reduce((t, b) => t + b.length, 0), outb = new Uint8Array(len);
		let at = 0; for (const b of c.blobs) { outb.set(buf.subarray(b.offset - c.start, b.offset - c.start + b.length), at); at += b.length; }
		await sink.write(outb, DATA + c.dst);
		done += len;
		await onProgress?.({ chunk: i + 1, chunks: chunks.length, bytes: done, total: dataLength });
	}
	for (const p of inflight.values()) p.catch(() => {});
	// 索引：書き先 offset に付け替え（隣どうしで同じ中身・ID が続く項目は runLength で繋ぐ）
	const ents: PMEntry[] = [];
	for (const e of plan.entries) {
		const offset = dstOf.get(e.offset)!, l = ents[ents.length - 1];
		if (l && l.offset === offset && l.tileId + l.runLength === e.tileId) l.runLength += e.runLength;
		else ents.push({ tileId: e.tileId, offset, length: e.length, runLength: e.runLength });
	}
	const { root, leaves } = buildDirs(ents);
	const md = new TextEncoder().encode(JSON.stringify(metadata ?? src.metadata));
	const mdOff = DATA + dataLength, leafOff = mdOff + md.length;
	await sink.write(md, mdOff);
	if (leaves.length) await sink.write(leaves, leafOff);
	await sink.write(root, HEADER);
	const [w, s, e, n] = plan.bbox;
	const head: PMHeader = {
		rootOffset: HEADER, rootLength: root.length, metadataOffset: mdOff, metadataLength: md.length, leafOffset: leafOff, leafLength: leaves.length,
		dataOffset: DATA, dataLength, addressedTiles: plan.tiles, tileEntries: ents.length, tileContents: dstOf.size,
		clustered: false, internalCompression: 1, tileCompression: h.tileCompression, tileType: h.tileType,
		minZoom: plan.minZoom, maxZoom: plan.maxZoom, minLon: w, minLat: s, maxLon: e, maxLat: n,
		centerZoom: Math.min(plan.maxZoom, Math.max(plan.minZoom, 10)), centerLon: (w + e) / 2, centerLat: (s + n) / 2,
	};
	await sink.write(serializeHeader(head), 0);
	const size = leafOff + leaves.length;
	await sink.truncate?.(size);
	await sink.flush?.();
	await verifyExtract(sink, ents.length, plan.tiles);
	return size;
}
// 根を先頭 16384 に収める：収まらなければ葉に分ける（葉の大きさは根が収まるまで倍に）
function buildDirs(ents: PMEntry[]): { root: Uint8Array; leaves: Uint8Array } {
	const whole = serializeDir(ents);
	if (HEADER + whole.length <= ROOT_SPACE) return { root: whole, leaves: new Uint8Array(0) };
	for (let per = 4096; ; per *= 2) {
		const parts: Uint8Array[] = [], rootEs: PMEntry[] = [];
		let off = 0;
		for (let i = 0; i < ents.length; i += per) { const d = serializeDir(ents.slice(i, i + per)); parts.push(d); rootEs.push({ tileId: ents[i].tileId, offset: off, length: d.length, runLength: 0 }); off += d.length; }
		const root = serializeDir(rootEs);
		if (HEADER + root.length <= ROOT_SPACE) { const leaves = new Uint8Array(off); let at = 0; for (const p of parts) { leaves.set(p, at); at += p.length; } return { root, leaves }; }
	}
}
/** 書いた物を読み直す：ヘッダ・根・葉を解いて項目数とタイル数が計画どおりか */
export async function verifyExtract(sink: ExtractSink, entries: number, tiles: number): Promise<void> {
	const h = parseHeader(await sink.read(0, HEADER));
	const root = deserializeDir(await sink.read(h.rootOffset, h.rootLength));
	let n = 0, t = 0;
	const walk = async (es: PMEntry[]): Promise<void> => { for (const e of es) { if (e.runLength === 0) await walk(deserializeDir(await sink.read(h.leafOffset + e.offset, e.length))); else { n++; t += e.runLength; if (e.offset + e.length > h.dataLength) throw new Error("extract verify: tile outside data"); } } };
	await walk(root);
	if (n !== entries || t !== tiles || h.tileEntries !== entries) throw new Error(`extract verify: ${n}/${entries} entries, ${t}/${tiles} tiles`);
}
