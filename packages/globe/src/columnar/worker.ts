// worker.js ── 列チャンク層の読み手（worker・#90）＝main（view.js）の相方。役割名 "columnar"（ホストの worker 入口＝@ortho-earth/globe の worker.js が import する）。
// main を塞がない：源を開く・視野の選抜・幾何の読み（Range／ワイヤ整数）・単位球への詰め替え・三角形分割・LOD・fid 表の評価・識別・IDB は全部ここ。
//   in : { id, type:"open", src, name?, rAx?, hint?, chunkFeatures?, chunkVertices?, lods?, cacheBase? } → { meta }
//        { id, type:"select", bbox }                                → { groups }
//        { id, type:"chunk", g, paint?, filter?, zoom? }            → { chunk, table, cached, ms }（transfer）。zoom に要る段だけ先に返し、残りの段は
//                                                                     後から { type:"levels", g, levels }（id なし＝main が overlay へ流す）
//        { id, type:"paint", paint, filter?, zoom? }                → { tables:[[g, Uint32Array], …] }（読み込み済み全チャンク・幾何はそのまま）
//        { id, type:"identify", lon, lat }                          → { g, f, row } | { hit:null }
//        { id, type:"props", g, row }                               → { props }
//        { id, type:"range", name }                                 → { range:[lo,hi]|null }
//        { id, type:"unload", g }／{ id, type:"metrics" }／{ id, type:"close" }
import "#columnar-sources";
import { findColumnarSource } from "./sources/registry.ts";
import { buildChunk, buildLevels, chunkBuffers, levelBuffers, copyChunk, LOD_ZOOMS } from "./chunk.ts";
import { tableFor, paintColumns } from "./style.ts";
import { identifyIn } from "./identify.ts";
import { cache, cacheKey, cacheRecord, buildTag } from "./cache.ts";
import type { ColumnarChunk } from "./chunk.ts";
import type { Flat } from "./flat.ts";
import type { ColumnarInput, ColumnarMeta, ColumnarReader } from "./sources/registry.ts";

/** main（view.ts）から来る 1 通（上の注の形・type ごとに使う欄だけ） */
interface InMsg {
	id: number; type: string; src: ColumnarInput; name?: string; rAx?: number; hint?: string | null; chunkFeatures?: number; chunkVertices?: number;
	lods?: number[]; cacheBase?: string | null; origin?: string; bbox: number[]; g: number; paint?: Record<string, unknown> | null; filter?: unknown;
	zoom?: number | null; lon: number; lat: number; tol?: { tolPointM?: number; tolLineM?: number }; row: number;
}
/** 読み込み済みチャンクの台帳の 1 行 */
interface Loaded { flat: Flat; fbbox: Float64Array; cols: Map<string, ArrayLike<unknown> | null>; chunk: ColumnarChunk; gen: number }

let reader: ColumnarReader | null = null, meta: (ColumnarMeta & { source: string }) | null = null, rAx = 1, lods = LOD_ZOOMS, cacheBase: string | null = null, tag = "", origin: string | undefined = undefined;
const loaded = new Map<number, Loaded>();   // g → { flat, chunk（fbbox/rows/types/n だけ参照）, cols: Map(name → 値[]) }

const headOf = async (src: ColumnarInput) => {
	try {
		if (typeof src === "string") return new Uint8Array(0);
		if (src instanceof ArrayBuffer) return new Uint8Array(src, 0, Math.min(16, src.byteLength));
		if (src instanceof Uint8Array) return src.subarray(0, 16);
		if (typeof Blob !== "undefined" && src instanceof Blob) return new Uint8Array(await src.slice(0, 16).arrayBuffer());
	} catch { /* 先頭が読めない＝名前で */ }
	return new Uint8Array(0);
};

async function open(d: InMsg) {
	const name = d.name ?? (typeof d.src === "string" ? decodeURIComponent(d.src.split("/").pop() || "") : (d.src as { name?: string })?.name) ?? "";
	const def = findColumnarSource({ name, head: await headOf(d.src), hint: d.hint ?? null });
	if (!def) throw new Error(`no columnar source for "${name}"`);
	rAx = d.rAx ?? 1; lods = d.lods ?? LOD_ZOOMS; origin = d.origin === "ml" ? "ml" : undefined;
	reader = await def.open(d.src, { name, chunkFeatures: d.chunkFeatures, chunkVertices: d.chunkVertices });
	meta = { ...reader.meta, source: def.name };
	cacheBase = d.cacheBase ?? (typeof d.src === "string" ? `${d.src}|${meta.etag || meta.size || ""}` : null);
	tag = buildTag({ rAx, lods, chunkFeatures: d.chunkFeatures, chunkVertices: d.chunkVertices });   // 球で焼いた物を楕円体で出さない（#43）
	if (cacheBase) cache.prune();
	return meta;
}
async function colsFor(g: number, names: Set<string>) {
	const L = loaded.get(g)!, miss = [...names].filter(nm => !L.cols.has(nm));
	if (miss.length) { const got = await reader!.readColumns(g, miss, L.flat.rows); for (const nm of miss) L.cols.set(nm, got[nm] ?? null); }
	const out: Record<string, ArrayLike<unknown>> = {}; for (const nm of names) { const v = L.cols.get(nm); if (v) out[nm] = v; }
	return out;
}
async function tableOf(g: number, paint: Record<string, unknown> | null, filter: unknown, zoom: number) {
	const L = loaded.get(g)!;
	const names = paintColumns(paint, filter);
	const cols = names.size ? await colsFor(g, names) : {};
	return tableFor({ paint, filter, zoom, cols, types: L.flat.types, n: L.flat.n, origin });
}
let lazyQ = Promise.resolve();
async function chunk(d: InMsg) {
	const t0 = performance.now(), key = cacheKey(cacheBase, d.g, tag);
	let hit = await cache.get(key), c: ColumnarChunk, flat: Flat, cached = false, tRead = 0, tBuild = 0;
	if (hit?.chunk && hit?.flat) { c = hit.chunk; flat = hit.flat; cached = true; }
	else {
		const t1 = performance.now();
		flat = await reader!.readGeometry(d.g);
		tRead = performance.now() - t1;
		c = buildChunk(flat, { g: d.g, rAx, lods, zoom: d.zoom ?? null });   // 今の zoom に要る段だけ＝最初の 1 枚を最短に
		tBuild = performance.now() - t1 - tRead;
	}
	const L0 = { flat, fbbox: c.fbbox, cols: new Map(), chunk: c, gen: (loaded.get(d.g)?.gen ?? 0) + 1 };
	loaded.set(d.g, L0);
	const table = await tableOf(d.g, d.paint ?? null, d.filter ?? null, d.zoom ?? 0);
	// IDB へ置く分（URL の源だけ）は transfer の前に写す＝chunkBuffers が rows/types/points/段の buffer を main へ渡すと worker 側は detach し、
	// それを指したままの put は構造化複製で DataCloneError（run が握り潰す＝一度も書けていなかった）
	const snap = key && !cached ? copyChunk(c) : null;
	if (c.pending) {   // 残りの段は返した後で（main は先に描く）。作れたら levels を流し、揃った所で IDB へ
		const gen = L0.gen;
		lazyQ = lazyQ.then(async () => {
			await new Promise(r => setTimeout(r, 0));
			const L = loaded.get(d.g); if (!L || L.gen !== gen) return;
			const added = buildLevels(flat, c, { rAx, lods });
			if (snap) await cache.set(key, cacheRecord(snap, added, flat));   // ★added の transfer より前に（put の複製は呼んだ時）
			if (added.length) self.postMessage({ type: "levels", g: d.g, levels: added }, levelBuffers(added));
		}).catch(err => console.warn("[columnar] levels", d.g, (err as Error)?.message || err));
	} else if (snap) cache.set(key, cacheRecord(snap, [], flat));   // zoom なしの呼び出し＝全段そろっている
	const out = { chunk: c, table, cached, ms: performance.now() - t0, msRead: tRead, msBuild: tBuild };
	return { out, transfer: [...chunkBuffers(c), table.buffer] };
}
async function identify(d: InMsg) {
	for (const [g, L] of loaded) {
		const f = identifyIn(L.flat, L.fbbox, d.lon, d.lat, d.tol);
		if (f >= 0) return { g, f, row: L.flat.rows[f] };
	}
	return { hit: null };
}

self.onmessage = async (e: MessageEvent) => {
	const d = e.data as InMsg;
	try {
		if (d.type === "open") self.postMessage({ id: d.id, meta: await open(d) });
		else if (d.type === "select") self.postMessage({ id: d.id, groups: reader!.select(d.bbox) });
		else if (d.type === "chunk") { const r = await chunk(d); self.postMessage({ id: d.id, ...r.out }, r.transfer); }
		else if (d.type === "paint") {
			const tables: [number, Uint32Array][] = [], tr: ArrayBuffer[] = [];
			for (const g of [...loaded.keys()]) { const t = await tableOf(g, d.paint ?? null, d.filter ?? null, d.zoom ?? 0); tables.push([g, t]); tr.push(t.buffer as ArrayBuffer); }
			self.postMessage({ id: d.id, tables }, tr);
		}
		else if (d.type === "identify") self.postMessage({ id: d.id, ...(await identify(d)) });
		else if (d.type === "props") self.postMessage({ id: d.id, props: await reader!.readProps(d.g, d.row) });
		else if (d.type === "range") self.postMessage({ id: d.id, range: reader!.range ? await reader!.range(d.name!) : (meta!.range?.[d.name!] ?? null) });
		else if (d.type === "unload") { loaded.delete(d.g); self.postMessage({ id: d.id }); }
		else if (d.type === "dump") {   // 診断＝読み込み済みチャンクのフラットな幾何の要約（検定用）
			const out: Record<number, unknown> = {};
			for (const [g, L] of loaded) { const f = L.flat, parts: string[] = []; for (let i = 0; i < f.n; i++) { const ks: string[] = []; for (let p = f.featPart[i]; p < f.featPart[i + 1]; p++) ks.push(f.partKind[p] + ":" + (f.partStart[p + 1] - f.partStart[p])); parts.push(`${f.rows[i]}[${f.types[i]}]{${ks.join(" ")}}`); } out[g] = { n: f.n, rows: Array.from(f.rows), parts, levels: L.chunk?.levels.map(l => [l.zoom, l.lines?.feat.length ?? 0, l.fills?.index.length ?? 0]) }; }
			self.postMessage({ id: d.id, dump: out });
		}
		else if (d.type === "metrics") self.postMessage({ id: d.id, metrics: reader?.metrics?.() ?? null });
		else if (d.type === "close") { reader?.close?.(); reader = null; loaded.clear(); self.postMessage({ id: d.id }); }
		else self.postMessage({ id: d.id, error: `unknown message "${d.type}"` });
	} catch (err) { self.postMessage({ id: d.id, error: String((err as Error)?.message || err) }); }
};
