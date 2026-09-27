// sources/geoparquet.js ── GeoParquet → 列チャンク（#90・作り方その 1）。row group＝チャンク。
// 読みは geopbf/parquet（自前の Parquet 読み・footer → 統計での絞り込み → 列チャンクだけ Range）。旧 gadgets/parquet-worker.js の
// 「WKB → GeoPBF 断片の組み立て → main で gint」を「WKB → フラットな幾何」に替えた＝GeoPBF の組み立ても gint の符号化も消えた。
// 点だけのファイルは bbox 覆域列（＝点の座標）から直に（WKB を解かない）。zstd の列は fzstd を当たった時だけ注入。
import { openParquet, setZstdDecoder } from "geopbf/parquet";
import { flatBuilder, addWkb } from "../flat.js";
import { shareStats } from "../share.js";

setZstdDecoder(async u8 => (await import("fzstd")).decompress(u8));

const numeric = c => !c.unsupported && (c.type === 1 || c.type === 2 || c.type === 4 || c.type === 5) && !(c.logical && c.logical.kind === "TIMESTAMP") && c.logical !== "DATE";
const PAR1 = h => h.length >= 4 && h[0] === 0x50 && h[1] === 0x41 && h[2] === 0x52 && h[3] === 0x31;

export const GEOPARQUET_SOURCE = {
	name: "geoparquet",
	test: ({ name, head }) => /\.(geo)?parquet$/i.test(name || "") || PAR1(head),
	async open(src, { name = "" } = {}) {
		const pq = await openParquet(src);
		const g = pq.geometry;
		if (!g) throw new Error("Not a GeoParquet file (no geo metadata)");
		if (g.encoding !== "WKB") throw new Error(`Only WKB geometry is supported (${g.encoding})`);
		const crs = g.crs === undefined ? "CRS84(default)" : g.crs === null ? "CRS84" : (g.crs.id ? `${g.crs.id.authority}:${g.crs.id.code}` : g.crs.name || "?");
		if (!/CRS84|4326/.test(crs)) throw new Error(`GeoParquet: CRS is not lon/lat (${crs})`);
		const cov = g.covering, covNames = new Set(cov ? Object.values(cov) : []);
		const columns = pq.columns.map(c => ({ name: c.name, type: c.type, logical: c.logical, unsupported: c.unsupported, numeric: numeric(c) && c.name !== g.name && !covNames.has(c.name) }));
		const range = {};
		for (const c of columns) if (c.numeric) { let lo = Infinity, hi = -Infinity; for (const rg of pq.rowGroups) { const s = rg.stats[c.name]; if (!s) continue; if (typeof s.min === "number" && s.min < lo) lo = s.min; if (typeof s.max === "number" && s.max > hi) hi = s.max; } if (lo <= hi) range[c.name] = [lo, hi]; }
		// 試し読み＝最初の row group の描くのに要る列 1 本（読めない＝圧縮が解けない等を理由つきで断る・旧 parquet-worker と同じ）
		if (pq.rowGroups.length) {
			const probeCol = cov?.xmin || g.name;
			const pm = await pq.readRowGroup(0, { columns: [probeCol] });
			if (pm.get(probeCol) == null) { const why = pq.columns.find(c => c.name === probeCol)?.unsupported || "unreadable"; throw new Error(/zstd/i.test(why) ? `zstd: ${why}` : `column "${probeCol}" ${why}`); }
		}
		const chunks = pq.rowGroups.map(rg => {
			const s = rg.stats, ok = cov && s[cov.xmin] && s[cov.ymin] && s[cov.xmax] && s[cov.ymax] && [s[cov.xmin].min, s[cov.ymin].min, s[cov.xmax].max, s[cov.ymax].max].every(v => typeof v === "number");
			return { bbox: ok ? [s[cov.xmin].min, s[cov.ymin].min, s[cov.xmax].max, s[cov.ymax].max] : null, rows: rg.numRows, bytes: rg.bytes };
		});
		const pointOnly = g.types.length > 0 && g.types.every(x => x === "Point"), multiPt = g.types.some(x => x !== "Point");
		const meta = { name: pq.keyValue["geopbf:name"] ?? name, rows: pq.numRows, chunks, columns: columns.map(c => ({ name: c.name, numeric: c.numeric })), range, bbox: g.bbox && g.bbox.length === 4 ? g.bbox : null, types: g.types, crs, precision: pq.keyValue["geopbf:precision"] ? +pq.keyValue["geopbf:precision"] : null, size: pq.source.size, etag: pq.source.etag, wholeFile: pq.source.wholeFile, kind: "geoparquet", share: null };
		const attrsCache = new Map();
		let flat0 = null;
		const reader = {
			meta,
			select(bbox) { return pq.select({ bbox }).groups; },
			async readGeometry(gi) {
				if (gi === 0 && flat0) { const f = flat0; flat0 = null; return f; }
				const fb = flatBuilder(4096);
				if (pointOnly && cov && !multiPt) {   // 点の bbox＝座標そのもの＝WKB を解かない
					const m = await pq.readRowGroup(gi, { columns: [cov.xmin, cov.ymin] }), x = m.get(cov.xmin), y = m.get(cov.ymin);
					if (!x || !y) throw new Error(`row group ${gi}: bbox columns unreadable`);
					for (let i = 0; i < x.length; i++) { if (typeof x[i] !== "number" || typeof y[i] !== "number") continue; fb.beginFeature(i, 0); fb.point(x[i], y[i]); fb.endFeature(); }
					return fb.finish();
				}
				const m = await pq.readRowGroup(gi, { columns: [g.name] }), wk = m.get(g.name);
				if (!wk) throw new Error(`row group ${gi}: geometry column unreadable`);
				for (let i = 0; i < wk.length; i++) if (wk[i]) addWkb(fb, i, wk[i]);
				return fb.finish();
			},
			async readColumns(gi, names, rows) {   // rows＝チャンク順 → row group 内の行（幾何なしの行は飛んでいる）＝戻りはチャンク順に揃える
				const want = names.filter(nm => columns.some(c => c.name === nm && !c.unsupported));
				const out = {};
				if (!want.length) return out;
				const m = await pq.readRowGroup(gi, { columns: want });
				for (const nm of want) { const v = m.get(nm); if (!v) continue; if (!rows) { out[nm] = v; continue; } const a = new Array(rows.length); for (let j = 0; j < rows.length; j++) a[j] = v[rows[j]]; out[nm] = a; }
				return out;
			},
			async readProps(gi, row) {   // row＝row group 内の行（flat.rows[f]）
				let a = attrsCache.get(gi);
				if (!a) {
					const names = columns.filter(c => c.name !== g.name && !c.unsupported && !covNames.has(c.name)).map(c => c.name);
					const m = await pq.readRowGroup(gi, { columns: names });
					a = {}; for (const nm of names) { const v = m.get(nm); if (v) a[nm] = v; }
					attrsCache.set(gi, a);
				}
				const o = {}; for (const k of Object.keys(a)) { const v = a[k][row]; if (v !== null && v !== undefined) o[k] = v; }
				return o;
			},
			range: nm => range[nm] ?? null,
			metrics: () => pq.source.metrics ?? null,
			close() { attrsCache.clear(); },
		};
		if (chunks.length && !pointOnly) { flat0 = await reader.readGeometry(0); meta.share = shareStats(flat0); }   // 共有の物差し（振り分けの規則が見る）＝row group 0 を標本に（読んだ分は最初の readGeometry(0) で使う）
		return reader;
	},
};
