// COG デコード＋warp worker。ネット（Range 発注・coalesce・キャッシュ）は main の core が持ち、
// CPU の山（inflate/LZW/predictor/JPEG デコード/再標本化）だけをここへ運ぶ＝生の圧縮バイトが入り、
// 完成 RGBA が transfer で出る。デコード済みタイルはモジュール LRU（32MB）に持ち、
// パン中の重なり要求で同じタイルを二度解凍しない。
import { decodeTile, toRGBA8 } from "./decode.js";
import { warpRGBA, xyzTarget, lonlatTarget } from "./warp.js";
import { projFor } from "./proj.js";
import { makeLRU } from "./cache.js";

const lru = makeLRU(32 << 20);

const decodeOne = async (buf, ifd, le, stretch, nodata) => {
	const dec = decodeTile(buf, ifd, le);
	if (dec.kind === "raster") return toRGBA8(dec.data, ifd, { stretch, nodata });
	// JPEG/WebP → ブラウザネイティブ（worker 内 createImageBitmap＝ハードウェアデコード）
	const bm = await createImageBitmap(new Blob([dec.bytes], { type: dec.mime }));
	const cv = new OffscreenCanvas(ifd.tileW, ifd.tileH);
	const ctx = cv.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(bm, 0, 0);
	bm.close();
	return ctx.getImageData(0, 0, ifd.tileW, ifd.tileH).data;
};

onmessage = async ({ data: m }) => {
	try {
		const { id, raw, ifd, le, geoL, epsg, stretch, nodata, tgt, nearest, cacheKey, level } = m;
		const proj = projFor(epsg);
		const tiles = new Map();
		let decoded = 0, decodeMs = 0;   // main の metrics へ返す（worker 分も「数字で語る」）
		for (const r of raw) {
			const k = `${cacheKey}:${level}/${r.tx}/${r.ty}`;
			if (r.buf === null) { tiles.set(`${r.tx}/${r.ty}`, null); continue; }
			let rgba = lru.get(k);
			if (!rgba) {
				const d0 = performance.now();
				rgba = await decodeOne(new Uint8Array(r.buf), ifd, le, stretch, nodata);
				decodeMs += performance.now() - d0; decoded++;
				lru.set(k, rgba, rgba.byteLength);
			}
			tiles.set(`${r.tx}/${r.ty}`, rgba);
		}
		const target = tgt.kind === "xyz" ? xyzTarget(tgt.z, tgt.x, tgt.y, tgt.size) : lonlatTarget(tgt.bbox, tgt.w, tgt.h);
		const out = warpRGBA({ lv: ifd, geoL, getTileRGBA: (tx, ty) => tiles.get(`${tx}/${ty}`) || null, forward: proj.forward }, target, { nearest });
		postMessage({ id, rgba: out.buffer, w: target.w, h: target.h, decoded, decodeMs }, [out.buffer]);
	} catch (e) {
		postMessage({ id: m.id, error: e.message });
	}
};
