// openCog() 本体＝DOM-free の完成形（Node/CLI/テストがそのまま使う）。ブラウザ入口 index.js は
// これに worker pool と createImageBitmap 系 imageDecoder を配線するだけ。
// 流れ: source（ヘッダ一発読み）→ tiff（IFD/GeoKey）→ モデル化（overview 表・bboxLL・levelFor）
//       → getTile(s)（sparse→null・coalesce 発注・LRU・注入キャッシュ）→ render(目標グリッドへ warp）。
import { openSource } from "./source.js";
import { parseTiff } from "./tiff.js";
import { projFor } from "./proj.js";
import { decodeTile, toRGBA8 } from "./decode.js";
import { warpRGBA, geoAtLevel, xyzTarget, lonlatTarget } from "./warp.js";
import { makeLRU, noopCache } from "./cache.js";

export { xyzTarget, lonlatTarget };

export async function openCog(src, opts = {}) {
	const t0 = now();
	const s = await openSource(src, opts);
	const cache2 = opts.cache || noopCache;
	const lru = makeLRU(opts.memBudget ?? 128 << 20);
	const metrics = { ttfhMs: 0, tilesDecoded: 0, decodeMs: 0, cacheHits: 0 };

	// ヘッダ窓に収まる読みはネットに出さない（16KB に IFD が収まるのが COG の通例）
	const getBytes = async (from, len) => {
		if (from + len <= s.head.length) return s.head.subarray(from, from + len);
		return s.read(from, len);
	};
	const t = await parseTiff(getBytes);
	metrics.ttfhMs = now() - t0;

	if (t.epsg === null) throw new Error("cog: no EPSG in GeoKeyDirectory");
	const proj = projFor(t.epsg);
	if (!proj) throw new Error(`cog: unsupported CRS EPSG:${t.epsg} (supported: 4326 / 3857 / UTM 326xx-327xx)`);

	const full = t.ifds[0];
	const overviews = t.ifds.map((lv, i) => ({
		level: i, width: lv.width, height: lv.height, tilesX: lv.tilesX, tilesY: lv.tilesY,
		resX: t.geo.scaleX * full.width / lv.width,
	}));

	// bbox → 経緯度（辺を8分割で密化＝UTM 等の曲がった辺でも外接を外さない）
	const [x0, y0, x1, y1] = t.bbox;
	let W = 180, S = 90, E = -180, N = -90;
	for (let i = 0; i <= 8; i++) {
		const f = i / 8;
		for (const [X, Y] of [[x0 + (x1 - x0) * f, y0], [x0 + (x1 - x0) * f, y1], [x0, y0 + (y1 - y0) * f], [x1, y0 + (y1 - y0) * f]]) {
			const [lon, lat] = proj.inverse([X, Y]);
			W = Math.min(W, lon); E = Math.max(E, lon); S = Math.min(S, lat); N = Math.max(N, lat);
		}
	}

	// stretch（u16/i16/f32 単バンド）: 明示 [lo,hi] か "auto"＝最粗 overview の 2–98 percentile を f32 で
	let stretchP = null;
	const needStretch = full.samples < 3 && !full.palette && full.bits[0] > 8;
	const ensureStretch = () => stretchP ??= (async () => {
		if (Array.isArray(opts.stretch)) return opts.stretch;
		const lv = t.ifds[t.ifds.length - 1];
		const raster = await getRasterTiles(t.ifds.length - 1, allTiles(lv));
		const vals = [];
		for (const r of raster.values()) {
			if (!r) continue;
			const stride = Math.max(1, (r.data.length / 20000) | 0);
			for (let i = 0; i < r.data.length; i += stride) {
				const v = r.data[i];
				if (t.nodata !== null && v === t.nodata) continue;
				if (Number.isFinite(v)) vals.push(v);
			}
		}
		if (!vals.length) return [0, 1];
		vals.sort((a, b) => a - b);
		return [vals[(vals.length * 0.02) | 0], vals[Math.min(vals.length - 1, (vals.length * 0.98) | 0)]];
	})();

	const key = (lv, tx, ty) => `${lv}/${tx}/${ty}`;
	const key2 = (lv, tx, ty) => `cog:${opts.cacheKey || s.etag || ""}:${lv}/${tx}/${ty}`;

	// 生バイト（圧縮のまま）を sparse 判定込みで取る。二層目キャッシュはここ（圧縮バイト＝IDB に優しい）。
	const rawTiles = async (level, list, signal) => {
		const lv = t.ifds[level];
		const out = new Map(), need = [];
		for (const [tx, ty] of list) {
			const i = ty * lv.tilesX + tx;
			if (tx < 0 || ty < 0 || tx >= lv.tilesX || ty >= lv.tilesY || !lv.offsets[i] || !lv.counts[i]) { out.set(key(level, tx, ty), null); continue; }
			const hit = s.wholeFile ? null : await cache2.get(key2(level, tx, ty));
			if (hit) { out.set(key(level, tx, ty), hit); metrics.cacheHits++; continue; }
			need.push({ tx, ty, from: lv.offsets[i], len: lv.counts[i] });
		}
		const bufs = await s.readMany(need.map(r => ({ from: r.from, len: r.len })), signal);
		need.forEach((r, i) => {
			out.set(key(level, r.tx, r.ty), bufs[i]);
			if (!s.wholeFile) cache2.set(key2(level, r.tx, r.ty), bufs[i]).catch(() => {});
		});
		return out;
	};

	// デコード済み raster（typed）タイル群＝stretch 算出と render が使う
	const getRasterTiles = async (level, list, signal) => {
		const lv = t.ifds[level];
		const raw = await rawTiles(level, list, signal);
		const out = new Map();
		for (const [k, buf] of raw) {
			if (!buf) { out.set(k, null); continue; }
			const d0 = now();
			const dec = decodeTile(buf, lv, t.littleEndian);
			metrics.decodeMs += now() - d0; metrics.tilesDecoded++;
			if (dec.kind === "image") {
				if (!opts.imageDecoder) throw new Error(`cog: ${dec.mime} tiles need a browser (createImageBitmap) — use geopbf/cog`);
				out.set(k, { image: await opts.imageDecoder(dec.bytes, dec.mime, lv.tileW, lv.tileH) });
			} else out.set(k, { data: dec.data });
		}
		return out;
	};

	// RGBA8 タイル（LRU 一層目）
	const getTilesRGBA = async (level, list, signal) => {
		const lv = t.ifds[level];
		const out = new Map(), miss = [];
		for (const [tx, ty] of list) {
			const c = lru.get(key(level, tx, ty));
			c !== null ? out.set(key(level, tx, ty), c === 0 ? null : c) : miss.push([tx, ty]);
		}
		if (miss.length) {
			const stretch = needStretch ? await ensureStretch() : null;
			const raster = await getRasterTiles(level, miss, signal);
			for (const [k, r] of raster) {
				const rgba = r === null ? null : r.image ? r.image : toRGBA8(r.data, lv, { stretch, nodata: t.nodata });
				lru.set(k, rgba === null ? 0 : rgba, rgba ? rgba.byteLength ?? lv.tileW * lv.tileH * 4 : 16);   // null は 0 を番人に
				out.set(k, rgba);
			}
		}
		return out;
	};

	const levelFor = (unitsPerPx) => {   // 目標解像度以上を保つ最粗段（LOD 思想の raster 版）
		let best = 0;
		for (const o of overviews) if (o.resX <= unitsPerPx * (opts.lodBias ?? 1.42)) best = o.level;   // √2 猶予
		return best;
	};

	// 目標グリッド → {level, lv, geoL, list}（必要源タイルの割り出し）。範囲外は null。
	// render が内部で使うほか、ブラウザ層（index.js）が「raw 取得は main・warp は worker」に分業する時の共通口。
	const plan = (tgt, o = {}) => {
		const [lonA, latA] = tgt.mapLL(0, tgt.h / 2), [lonB, latB] = tgt.mapLL(tgt.w - 1, tgt.h / 2);
		const [XA, YA] = proj.forward([lonA, latA]), [XB, YB] = proj.forward([lonB, latB]);
		const level = o.level ?? levelFor(Math.hypot(XB - XA, YB - YA) / (tgt.w - 1));
		const lv = t.ifds[level];
		const geoL = geoAtLevel(t.geo, full, lv);
		let px0 = 1e15, py0 = 1e15, px1 = -1e15, py1 = -1e15;   // 四隅+辺中点を源ピクセルへ
		for (const [i, j] of [[0, 0], [tgt.w - 1, 0], [0, tgt.h - 1], [tgt.w - 1, tgt.h - 1], [tgt.w >> 1, 0], [tgt.w >> 1, tgt.h - 1], [0, tgt.h >> 1], [tgt.w - 1, tgt.h >> 1]]) {
			const [X, Y] = proj.forward(tgt.mapLL(i, j));
			const px = (X - geoL.originX) / geoL.scaleX, py = (geoL.originY - Y) / geoL.scaleY;
			px0 = Math.min(px0, px); px1 = Math.max(px1, px); py0 = Math.min(py0, py); py1 = Math.max(py1, py);
		}
		const tx0 = Math.max(0, (px0 / lv.tileW) | 0), tx1 = Math.min(lv.tilesX - 1, (px1 / lv.tileW) | 0);
		const ty0 = Math.max(0, (py0 / lv.tileH) | 0), ty1 = Math.min(lv.tilesY - 1, (py1 / lv.tileH) | 0);
		if (tx1 < tx0 || ty1 < ty0) return null;
		const list = [];
		for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) list.push([tx, ty]);
		return { level, lv, geoL, list };
	};

	// 目標グリッドへ描く（DOM-free・raster 経路。JPEG/WebP は imageDecoder 注入時のみ）
	const render = async (tgt, o = {}) => {
		const pl = plan(tgt, o);
		if (!pl) return null;
		const tiles = await getTilesRGBA(pl.level, pl.list, o.signal);
		return warpRGBA({ lv: pl.lv, geoL: pl.geoL, getTileRGBA: (tx, ty) => tiles.get(key(pl.level, tx, ty)) || null, forward: proj.forward }, tgt, o);
	};

	return {
		width: full.width, height: full.height, tileW: full.tileW, tileH: full.tileH,
		samples: full.samples, dtype: dtypeOf(full), epsg: t.epsg,
		compression: full.compression, bigtiff: t.bigtiff, nodata: t.nodata, citation: t.citation,
		bbox: t.bbox, bboxLL: [W, S, E, N], overviews, etag: s.etag,
		levelFor,
		getTile: async (level, tx, ty, o = {}) => (await getTilesRGBA(level, [[tx, ty]], o.signal)).get(key(level, tx, ty)),
		getTiles: async (level, list, o = {}) => { const m = await getTilesRGBA(level, list, o.signal); return list.map(([tx, ty]) => m.get(key(level, tx, ty))); },
		plan, render,
		rawTiles: async (level, list, signal) => { const m = await rawTiles(level, list, signal); return list.map(([tx, ty]) => m.get(key(level, tx, ty))); },
		ifdOf: (level) => t.ifds[level],
		littleEndian: t.littleEndian,
		ensureStretch: () => needStretch ? ensureStretch() : Promise.resolve(null),
		metrics: () => ({ ...metrics, ...s.metrics, lruBytes: lru.bytes }),
		close: () => { lru.clear(); },
	};
}

const allTiles = (lv) => { const a = []; for (let ty = 0; ty < lv.tilesY; ty++) for (let tx = 0; tx < lv.tilesX; tx++) a.push([tx, ty]); return a; };
const dtypeOf = (ifd) => ifd.bits[0] === 8 ? (ifd.sampleFormat === 2 ? "i8" : "u8") : ifd.bits[0] === 16 ? (ifd.sampleFormat === 2 ? "i16" : "u16") : "f32";
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
