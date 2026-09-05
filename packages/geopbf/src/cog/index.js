// ブラウザ完成形の入口＝geopbf/cog。core（DOM-free）に worker pool と createImageBitmap を配線する。
//   const cog = await openCog(url);                 // ヘッダ一発読み
//   const bm  = await cog.renderXYZ(14, x, y);      // ImageBitmap（maplibre/leaflet アダプタの土台）
//   const px  = await cog.renderTo({bbox:[w,s,e,n], w:512, h:512});   // 経緯度グリッド RGBA
// ネット（coalesce・二層キャッシュ）は main・CPU（解凍/JPEG/warp）は pool worker。inflight は
// タイル鍵でデデュープ＝パン連打で同じ XYZ を二度作らない。opts.worker===false で全て main 実行。
import { openCog as openCore, xyzTarget, lonlatTarget } from "./core.js";
import { makePool } from "./pool.js";

const imageDecoder = async (bytes, mime, w, h) => {   // main 側の JPEG/WebP デコード（worker 無し経路用）
	const bm = await createImageBitmap(new Blob([bytes], { type: mime }));
	const cv = new OffscreenCanvas(w, h);
	const ctx = cv.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(bm, 0, 0); bm.close();
	return ctx.getImageData(0, 0, w, h).data;
};

export async function openCog(src, opts = {}) {
	const cog = await openCore(src, { imageDecoder, ...opts });
	const pool = opts.worker === false || typeof Worker === "undefined" ? null : makePool(opts);
	const cacheKey = opts.cacheKey || cog.etag || String(src);
	const inflight = new Map();
	const wstat = { tilesDecoded: 0, decodeMs: 0 };   // worker 側のデコード集計

	// lean IFD（offsets/counts の大配列を worker に送らない）
	const leanIfd = (level) => {
		const { offsets, counts, ...rest } = cog.ifdOf(level);
		return rest;
	};

	const renderCommon = async (tgtDesc, tgtObj, o = {}) => {
		const pl = cog.plan(tgtObj, o);
		if (!pl) return null;
		if (!pool) {   // worker 無し＝core の main 経路
			const rgba = await cog.render(tgtObj, o);
			return rgba && { rgba, w: tgtObj.w, h: tgtObj.h };
		}
		const stretch = await cog.ensureStretch();
		const raw = await cog.rawTiles(pl.level, pl.list, o.signal);
		// coalesce 塊の subarray を transfer すると親 buffer が死ぬ＝コピーして渡す（圧縮バイトは小さい）
		const msgRaw = pl.list.map(([tx, ty], i) => ({ tx, ty, buf: raw[i] ? raw[i].slice().buffer : null }));
		const r = await pool.submit({
			raw: msgRaw, ifd: leanIfd(pl.level), le: cog.littleEndian, geoL: pl.geoL, epsg: cog.epsg,
			stretch, nodata: cog.nodata, tgt: tgtDesc, nearest: o.nearest, cacheKey, level: pl.level,
		}, msgRaw.map(t => t.buf).filter(Boolean));
		wstat.tilesDecoded += r.decoded || 0; wstat.decodeMs += r.decodeMs || 0;
		return { rgba: new Uint8ClampedArray(r.rgba), w: r.w, h: r.h };
	};

	const toOut = async (r, format) => {
		if (!r) return null;
		if (format === "raw") return r.rgba;
		const img = new ImageData(r.rgba, r.w, r.h);
		if (format === "png") {
			const cv = new OffscreenCanvas(r.w, r.h);
			cv.getContext("2d").putImageData(img, 0, 0);
			return new Uint8Array(await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer());
		}
		return createImageBitmap(img);   // 既定 "bitmap"
	};

	return {
		...cog,
		metrics: () => { const m = cog.metrics(); return { ...m, tilesDecoded: m.tilesDecoded + wstat.tilesDecoded, decodeMs: m.decodeMs + wstat.decodeMs }; },
		// XYZ(3857) タイル。format: "bitmap"(既定) | "png" | "raw"
		renderXYZ(z, x, y, o = {}) {
			const k = `${z}/${x}/${y}/${o.size || 256}/${o.format || "bitmap"}`;
			const p = inflight.get(k) ?? (async () => {
				try {
					const size = o.size || 256;
					return await toOut(await renderCommon({ kind: "xyz", z, x, y, size }, xyzTarget(z, x, y, size), o), o.format || "bitmap");
				} finally { inflight.delete(k); }
			})();
			inflight.set(k, p);
			return p;
		},
		// 経緯度グリッド（エンジンの等経緯度アトラスセル用）。{bbox:[w,s,e,n], w, h}
		async renderTo({ bbox, w, h }, o = {}) {
			return toOut(await renderCommon({ kind: "lonlat", bbox, w, h }, lonlatTarget(bbox, w, h), o), o.format || "raw");
		},
		close() { pool?.destroy(); cog.close(); },
	};
}
