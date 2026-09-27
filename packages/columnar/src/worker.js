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
import { findColumnarSource } from "./sources/registry.js";
import { buildChunk, buildLevels, chunkBuffers, levelBuffers, chunkBytes, LOD_ZOOMS } from "./chunk.js";
import { tableFor, paintColumns } from "./style.js";
import { identifyIn } from "./identify.js";
import { cache, cacheKey } from "./cache.js";

let reader = null, meta = null, rAx = 1, lods = LOD_ZOOMS, cacheBase = null, origin = undefined;
const loaded = new Map();   // g → { flat, chunk（fbbox/rows/types/n だけ参照）, cols: Map(name → 値[]) }

const headOf = async src => {
	try {
		if (typeof src === "string") return new Uint8Array(0);
		if (src instanceof ArrayBuffer) return new Uint8Array(src, 0, Math.min(16, src.byteLength));
		if (src instanceof Uint8Array) return src.subarray(0, 16);
		if (typeof Blob !== "undefined" && src instanceof Blob) return new Uint8Array(await src.slice(0, 16).arrayBuffer());
	} catch { /* 先頭が読めない＝名前で */ }
	return new Uint8Array(0);
};

async function open(d) {
	const name = d.name ?? (typeof d.src === "string" ? decodeURIComponent(d.src.split("/").pop() || "") : d.src?.name) ?? "";
	const def = findColumnarSource({ name, head: await headOf(d.src), hint: d.hint ?? null });
	if (!def) throw new Error(`no columnar source for "${name}"`);
	rAx = d.rAx ?? 1; lods = d.lods ?? LOD_ZOOMS; origin = d.origin === "ml" ? "ml" : undefined;
	reader = await def.open(d.src, { name, chunkFeatures: d.chunkFeatures, chunkVertices: d.chunkVertices });
	meta = { ...reader.meta, source: def.name };
	cacheBase = d.cacheBase ?? (typeof d.src === "string" ? `${d.src}|${meta.etag || meta.size || ""}` : null);
	if (cacheBase) cache.prune();
	return meta;
}
async function colsFor(g, names) {
	const L = loaded.get(g), miss = [...names].filter(nm => !L.cols.has(nm));
	if (miss.length) { const got = await reader.readColumns(g, miss, L.flat.rows); for (const nm of miss) L.cols.set(nm, got[nm] ?? null); }
	const out = {}; for (const nm of names) { const v = L.cols.get(nm); if (v) out[nm] = v; }
	return out;
}
async function tableOf(g, paint, filter, zoom) {
	const L = loaded.get(g);
	const names = paintColumns(paint, filter);
	const cols = names.size ? await colsFor(g, names) : {};
	return tableFor({ paint, filter, zoom, cols, types: L.flat.types, n: L.flat.n, origin });
}
let lazyQ = Promise.resolve();
const copyLevel = L => ({ zoom: L.zoom, verts: L.verts, lines: L.lines ? { pos: L.lines.pos.slice(), feat: L.lines.feat.slice() } : null, fills: L.fills ? { pos: L.fills.pos.slice(), index: L.fills.index.slice(), feat: L.fills.feat.slice() } : null });
async function chunk(d) {
	const t0 = performance.now(), key = cacheKey(cacheBase, d.g);
	let hit = await cache.get(key), c, flat, cached = false, tRead = 0, tBuild = 0;
	if (hit?.chunk && hit?.flat) { c = hit.chunk; flat = hit.flat; cached = true; }
	else {
		const t1 = performance.now();
		flat = await reader.readGeometry(d.g);
		tRead = performance.now() - t1;
		c = buildChunk(flat, { g: d.g, rAx, lods, zoom: d.zoom ?? null });   // 今の zoom に要る段だけ＝最初の 1 枚を最短に
		tBuild = performance.now() - t1 - tRead;
	}
	const L0 = { flat, fbbox: c.fbbox, cols: new Map(), chunk: c, gen: (loaded.get(d.g)?.gen ?? 0) + 1 };
	loaded.set(d.g, L0);
	const table = await tableOf(d.g, d.paint ?? null, d.filter ?? null, d.zoom ?? 0);
	if (c.pending) {   // 残りの段は返した後で（main は先に描く）。作れたら levels を流し、揃った所で IDB へ（URL の源だけ＝先に返す段は写しを取っておく）
		const first = key ? c.levels.map(copyLevel) : null, gen = L0.gen;
		lazyQ = lazyQ.then(async () => {
			await new Promise(r => setTimeout(r, 0));
			const L = loaded.get(d.g); if (!L || L.gen !== gen) return;
			const added = buildLevels(flat, c, { rAx, lods });
			if (key) await cache.set(key, { chunk: { ...c, levels: [...first, ...added].sort((a, b) => b.zoom - a.zoom), pending: false }, flat, bytesTotal: chunkBytes(c) + flat.xy.byteLength });   // ★transfer より前に（put の複製は呼んだ時）
			if (added.length) self.postMessage({ type: "levels", g: d.g, levels: added }, levelBuffers(added));
		}).catch(err => console.warn("[columnar] levels", d.g, err?.message || err));
	}
	const out = { chunk: c, table, cached, ms: performance.now() - t0, msRead: tRead, msBuild: tBuild };
	return { out, transfer: [...chunkBuffers(c), table.buffer] };
}
async function identify(d) {
	for (const [g, L] of loaded) {
		const f = identifyIn(L.flat, L.fbbox, d.lon, d.lat, d.tol);
		if (f >= 0) return { g, f, row: L.flat.rows[f] };
	}
	return { hit: null };
}

self.onmessage = async e => {
	const d = e.data;
	try {
		if (d.type === "open") self.postMessage({ id: d.id, meta: await open(d) });
		else if (d.type === "select") self.postMessage({ id: d.id, groups: reader.select(d.bbox) });
		else if (d.type === "chunk") { const r = await chunk(d); self.postMessage({ id: d.id, ...r.out }, r.transfer); }
		else if (d.type === "paint") {
			const tables = [], tr = [];
			for (const g of [...loaded.keys()]) { const t = await tableOf(g, d.paint ?? null, d.filter ?? null, d.zoom ?? 0); tables.push([g, t]); tr.push(t.buffer); }
			self.postMessage({ id: d.id, tables }, tr);
		}
		else if (d.type === "identify") self.postMessage({ id: d.id, ...(await identify(d)) });
		else if (d.type === "props") self.postMessage({ id: d.id, props: await reader.readProps(d.g, d.row) });
		else if (d.type === "range") self.postMessage({ id: d.id, range: reader.range ? await reader.range(d.name) : (meta.range?.[d.name] ?? null) });
		else if (d.type === "unload") { loaded.delete(d.g); self.postMessage({ id: d.id }); }
		else if (d.type === "dump") {   // 診断＝読み込み済みチャンクのフラットな幾何の要約（検定用）
			const out = {};
			for (const [g, L] of loaded) { const f = L.flat, parts = []; for (let i = 0; i < f.n; i++) { const ks = []; for (let p = f.featPart[i]; p < f.featPart[i + 1]; p++) ks.push(f.partKind[p] + ":" + (f.partStart[p + 1] - f.partStart[p])); parts.push(`${f.rows[i]}[${f.types[i]}]{${ks.join(" ")}}`); } out[g] = { n: f.n, rows: Array.from(f.rows), parts, levels: L.chunk?.levels.map(l => [l.zoom, l.lines?.feat.length ?? 0, l.fills?.index.length ?? 0]) }; }
			self.postMessage({ id: d.id, dump: out });
		}
		else if (d.type === "metrics") self.postMessage({ id: d.id, metrics: reader?.metrics?.() ?? null });
		else if (d.type === "close") { reader?.close?.(); reader = null; loaded.clear(); self.postMessage({ id: d.id }); }
		else self.postMessage({ id: d.id, error: `unknown message "${d.type}"` });
	} catch (err) { self.postMessage({ id: d.id, error: String(err?.message || err) }); }
};
