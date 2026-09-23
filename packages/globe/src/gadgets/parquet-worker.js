// GeoParquet の視野追従の読み手（worker）＝gadgets/parquet-view.js（main）の相方。
// main を塞がない：footer/列チャンクの Range 読み・WKB → 幾何だけの GeoPBF 断片の組み立て・点の列出し・属性列の読みは全部ここ。
// 読んだ row group は IDB（ortho-parquet）に置く＝再訪は通信なし（鍵＝URL|ETag|row group|mode|色分け列）。File（ドロップ）は手元なので置かない。
//   in : { id, type:"open", src(url|File) }                 → { id, type:"opened", meta }
//        { id, type:"select", bbox }                         → { id, groups, pruned }
//        { id, type:"rg", g, mode:"geom"|"points", color? }  → geom: { id, bytes(ArrayBuffer), rows:Int32Array, vals?:Float32Array, cached }
//                                                               points: { id, lon:Float64Array, lat:Float64Array, rows:Int32Array, vals?:Float32Array, cached }
//        { id, type:"attrs", g }                             → { id, attrs: { 列名: 値[] } }
//   mode geom：属性は載せない（列のまま）。color 指定時だけその 1 列を properties に載せる＝gint の paint 式（["get", col]）が引ける最小
//   mode points：bbox 覆域列（＝点の座標）を読む。MultiPoint を含む／覆域列が無い＝WKB を解いて全部の点に展開（rows は元の行）
import { openParquet, parseWkb, setZstdDecoder } from "geopbf/parquet";
// zstd の列（Node の geopbf 書き出し・Overture 等の既定）＝ブラウザには解凍器が無い＝fzstd（純 JS・MIT）を当たった時だけ読み込んで渡す（2026-09-22）
setZstdDecoder(async u8 => (await import("fzstd")).decompress(u8));
import { GeoPBF } from "geopbf/pbf-base";

let pq = null, meta = null, cacheKeyBase = null, precision = 6;

// ── IDB（失敗は全て null＝無かったことに）──
const CACHE_MAX = 256e6;
const db = (() => {
	let p = null;
	const open = () => p ??= new Promise((res, rej) => {
		if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
		const rq = indexedDB.open("ortho-parquet", 1);
		rq.onupgradeneeded = () => { const s = rq.result.createObjectStore("rg"); s.createIndex("t", "t"); };
		rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
	});
	const run = async (mode, f) => { try { const d = await open(); return await new Promise((res, rej) => { const r = f(d.transaction("rg", mode).objectStore("rg")); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); } catch (e) { console.warn("[pq] idb", mode, e?.message || e); return null; } };
	return {
		get: k => run("readonly", s => s.get(k)),
		set: (k, v) => run("readwrite", s => s.put({ ...v, t: Date.now() }, k)),
		// 古い順に落として総量を CACHE_MAX 以下へ（開いた直後に一度）
		prune: async () => {
			try {
				const d = await open();
				await new Promise(res => {
					const st = d.transaction("rg", "readwrite").objectStore("rg"), rows = [];
					st.index("t").openCursor().onsuccess = e => {
						const c = e.target.result;
						if (c) { rows.push({ key: c.primaryKey, t: c.value.t, bytes: c.value.bytesTotal || 0 }); c.continue(); return; }
						let total = rows.reduce((a, r) => a + r.bytes, 0);
						for (const r of rows) { if (total <= CACHE_MAX) break; st.delete(r.key); total -= r.bytes; }   // rows は t 昇順＝古い順
						res();
					};
				});
			} catch { /* 無ければ無いで */ }
		},
	};
})();
const sizeOf = v => (v.bytes?.byteLength ?? 0) + (v.lon?.byteLength ?? 0) + (v.lat?.byteLength ?? 0) + (v.rows?.byteLength ?? 0) + (v.vals?.byteLength ?? 0);

const numeric = c => !c.unsupported && (c.type === 1 || c.type === 2 || c.type === 4 || c.type === 5) && !(c.logical && c.logical.kind === "TIMESTAMP") && c.logical !== "DATE";

async function open(src) {
	pq = await openParquet(src);
	const g = pq.geometry;
	precision = pq.keyValue["geopbf:precision"] ? +pq.keyValue["geopbf:precision"] : 6;
	const cov = g?.covering, covNames = new Set(cov ? Object.values(cov) : []);
	const columns = pq.columns.map(c => ({ name: c.name, type: c.type, logical: c.logical, unsupported: c.unsupported, numeric: numeric(c) && c.name !== g?.name && !covNames.has(c.name) }));
	// 数値列の全体レンジ（row group 統計の min/max を束ねる）＝色分けの物差し（データを読まずに決まる）
	const range = {};
	for (const c of columns) if (c.numeric) { let lo = Infinity, hi = -Infinity; for (const rg of pq.rowGroups) { const s = rg.stats[c.name]; if (!s) continue; if (typeof s.min === "number" && s.min < lo) lo = s.min; if (typeof s.max === "number" && s.max > hi) hi = s.max; } if (lo <= hi) range[c.name] = [lo, hi]; }
	// 試し読み＝最初の row group の「描くのに要る列」を 1 本だけ（小さい・チャンク 1 個）。読めない＝圧縮が解けない（ブラウザに zstd は無い）等＝
	// ここで理由つきで断る（旧＝開けたまま全 row group が null を触って「Cannot read properties of null」＝何が悪いか分からなかった・2026-09-22）
	if (pq.rowGroups.length) {
		const probeCol = cov?.xmin || g?.name;
		if (probeCol) {
			const pm = await pq.readRowGroup(0, { columns: [probeCol] });
			if (pm.get(probeCol) == null) { const why = pq.columns.find(c => c.name === probeCol)?.unsupported || "unreadable"; throw new Error(/zstd/i.test(why) ? `zstd: ${why}` : `column "${probeCol}" ${why}`); }
		}
	}
	cacheKeyBase = typeof src === "string" ? `${src}|${pq.source.etag || pq.source.size || ""}` : null;
	if (cacheKeyBase) db.prune();
	meta = { numRows: pq.numRows, rowGroups: pq.rowGroups, geometry: g, columns, range, precision, size: pq.source.size, wholeFile: pq.source.wholeFile, keyValue: { name: pq.keyValue["geopbf:name"] ?? null } };
	return meta;
}

const ck = (g, mode, color) => cacheKeyBase ? `${cacheKeyBase}|${g}|${mode}|${color || ""}` : null;

async function readGeom(g, color) {
	const key = ck(g, "geom", color);
	const hit = key ? await db.get(key) : null;
	if (hit?.bytes) return { bytes: hit.bytes, rows: hit.rows, vals: hit.vals, cached: true };
	const gname = meta.geometry.name;
	const cols = color ? [gname, color] : [gname];
	const m = await pq.readRowGroup(g, { columns: cols }), wk = m.get(gname), cv = color ? m.get(color) : null;
	if (!wk) throw new Error(`row group ${g}: geometry column unreadable`);
	const f = new GeoPBF({ name: `pq#${g}`, precision });
	f.setHead(color ? [color] : [], []);   // 幾何だけ（色分け列があればその 1 列だけ properties に）
	const rows = [], vals = color ? [] : null, ctx = { vertices: 0 };
	await f.setBodyAsync(async () => {
		for (let i = 0; i < wk.length; i++) {
			const gm = wk[i] ? parseWkb(wk[i], ctx) : null; if (!gm) continue;
			const props = {}; if (color && cv && cv[i] != null) { props[color] = cv[i]; vals.push(+cv[i]); } else if (color) vals.push(NaN);
			f.setFeature({ type: "Feature", properties: props, geometry: gm }); rows.push(i);
		}
	});
	f.close();
	const out = { bytes: f.arrayBuffer.slice(0), rows: Int32Array.from(rows), vals: vals ? Float32Array.from(vals) : undefined, cached: false };
	if (key) await db.set(key, { bytes: out.bytes, rows: out.rows, vals: out.vals, bytesTotal: sizeOf(out) });   // ★transfer より前に（put の複製は呼んだ時＝後だと detach 済みの空を保存）
	return out;
}
async function readPoints(g, color) {
	const key = ck(g, "points", color);
	const hit = key ? await db.get(key) : null;
	if (hit?.lon) return { lon: hit.lon, lat: hit.lat, rows: hit.rows, vals: hit.vals, cached: true };
	const gmeta = meta.geometry, cov = gmeta.covering;
	const multi = gmeta.types.some(t => t !== "Point");
	const lon = [], lat = [], rows = [], vals = color ? [] : null;
	if (cov && !multi) {   // 点の bbox＝座標そのもの＝WKB を解かない
		const m = await pq.readRowGroup(g, { columns: color ? [cov.xmin, cov.ymin, color] : [cov.xmin, cov.ymin] });
		const x = m.get(cov.xmin), y = m.get(cov.ymin), cv = color ? m.get(color) : null;
		for (let i = 0; i < x.length; i++) { if (typeof x[i] !== "number" || typeof y[i] !== "number") continue; lon.push(x[i]); lat.push(y[i]); rows.push(i); if (vals) vals.push(cv && cv[i] != null ? +cv[i] : NaN); }
	} else {   // MultiPoint 込み＝WKB を解いて全部の点へ（rows は元の行＝tip は行の属性）
		const m = await pq.readRowGroup(g, { columns: color ? [gmeta.name, color] : [gmeta.name] }), wk = m.get(gmeta.name), cv = color ? m.get(color) : null;
		for (let i = 0; i < wk.length; i++) {
			const gm = wk[i] ? parseWkb(wk[i], {}) : null; if (!gm) continue;
			const pts = gm.type === "Point" ? [gm.coordinates] : gm.type === "MultiPoint" ? gm.coordinates : gm.type === "GeometryCollection" ? gm.geometries.flatMap(q => q.type === "Point" ? [q.coordinates] : q.type === "MultiPoint" ? q.coordinates : []) : [];
			for (const c of pts) { lon.push(c[0]); lat.push(c[1]); rows.push(i); if (vals) vals.push(cv && cv[i] != null ? +cv[i] : NaN); }
		}
	}
	const out = { lon: Float64Array.from(lon), lat: Float64Array.from(lat), rows: Int32Array.from(rows), vals: vals ? Float32Array.from(vals) : undefined, cached: false };
	if (key) await db.set(key, { lon: out.lon, lat: out.lat, rows: out.rows, vals: out.vals, bytesTotal: sizeOf(out) });   // ★transfer より前に
	return out;
}
async function readAttrs(g) {
	const gname = meta.geometry.name, cov = new Set(meta.geometry.covering ? Object.values(meta.geometry.covering) : []);
	const names = meta.columns.filter(c => c.name !== gname && !c.unsupported && !cov.has(c.name)).map(c => c.name);
	const m = await pq.readRowGroup(g, { columns: names });
	const attrs = {}; for (const n of names) { const v = m.get(n); if (v) attrs[n] = v; }
	return attrs;
}

self.onmessage = async e => {
	const d = e.data;
	try {
		if (d.type === "open") self.postMessage({ id: d.id, type: "opened", meta: await open(d.src) });
		else if (d.type === "select") self.postMessage({ id: d.id, ...pq.select({ bbox: d.bbox }) });
		else if (d.type === "rg") {
			if (d.mode === "geom") { const r = await readGeom(d.g, d.color); self.postMessage({ id: d.id, ...r }, [r.bytes, r.rows.buffer, ...(r.vals ? [r.vals.buffer] : [])]); }
			else { const r = await readPoints(d.g, d.color); self.postMessage({ id: d.id, ...r }, [r.lon.buffer, r.lat.buffer, r.rows.buffer, ...(r.vals ? [r.vals.buffer] : [])]); }
		}
		else if (d.type === "attrs") self.postMessage({ id: d.id, attrs: await readAttrs(d.g) });
		else if (d.type === "metrics") self.postMessage({ id: d.id, metrics: pq?.source.metrics ?? null });
	} catch (err) { self.postMessage({ id: d.id, error: String(err?.message || err) }); }
};
