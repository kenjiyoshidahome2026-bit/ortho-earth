// COG デコード＋warp worker。ネット（Range 発注・coalesce・キャッシュ）は main の core が持ち、
// CPU の山（inflate/LZW/predictor/JPEG デコード/再標本化）だけをここへ運ぶ＝生の圧縮バイトが入り、
// 完成 RGBA が transfer で出る。デコード済みタイルはモジュール LRU（32MB）に持ち、
// パン中の重なり要求で同じタイルを二度解凍しない。
import { decodeTile, toRGBA8 } from "./decode.ts";
import { warpRGBA, xyzTarget, lonlatTarget } from "./warp.ts";
import { projFor } from "./proj.ts";
import { makeLRU } from "./cache.ts";
import type { LeanIfd, Stretch, Lut, Composite } from "./types.ts";
import type { CogWorkerRequest, CogWorkerResponse } from "./worker-types.ts";

const lru = makeLRU<Uint8ClampedArray>(32 << 20);

const decodeOne = async (buf: Uint8Array, ifd: LeanIfd, le: boolean, stretch: Stretch | null, nodata: number | null, composite: Composite, lut: Lut | null): Promise<Uint8ClampedArray> => {
	const dec = await decodeTile(buf, ifd, le);
	if (dec.kind === "raster") return toRGBA8(dec.data, ifd, { stretch, nodata, composite, lut });
	// JPEG/WebP → ブラウザネイティブ（worker 内 createImageBitmap＝ハードウェアデコード）
	const bm = await createImageBitmap(new Blob([dec.bytes as BlobPart], { type: dec.mime }));
	const cv = new OffscreenCanvas(ifd.tileW, ifd.tileH);
	const ctx = cv.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
	ctx.drawImage(bm, 0, 0);
	bm.close();
	return ctx.getImageData(0, 0, ifd.tileW, ifd.tileH).data;
};

const post = (msg: CogWorkerResponse, transfer?: Transferable[]): void => { transfer ? postMessage(msg, transfer) : postMessage(msg); };

onmessage = async ({ data: m }: MessageEvent<CogWorkerRequest>) => {
	try {
		const { id, raw, ifd, le, geoL, epsg, stretch, nodata, composite, lut, tgt, nearest, cacheKey, level } = m;
		const proj = projFor(epsg);
		if (!proj) throw new Error(`cog: unsupported CRS EPSG:${epsg}`);   // main（core）が先に弾いているので通常は来ない
		const tiles = new Map<string, Uint8ClampedArray | null>();
		let decoded = 0, decodeMs = 0;   // main の metrics へ返す（worker 分も「数字で語る」）
		for (const r of raw) {
			const k = `${cacheKey}:${level}/${r.tx}/${r.ty}`;
			if (r.buf === null) { tiles.set(`${r.tx}/${r.ty}`, null); continue; }
			let rgba = lru.get(k);
			if (!rgba) {
				const d0 = performance.now();
				rgba = await decodeOne(new Uint8Array(r.buf), ifd, le, stretch, nodata, composite, lut);
				decodeMs += performance.now() - d0; decoded++;
				lru.set(k, rgba, rgba.byteLength);
			}
			tiles.set(`${r.tx}/${r.ty}`, rgba);
		}
		const target = tgt.kind === "xyz" ? xyzTarget(tgt.z, tgt.x, tgt.y, tgt.size) : lonlatTarget(tgt.bbox, tgt.w, tgt.h);
		const out = warpRGBA({ lv: ifd, geoL, getTileRGBA: (tx, ty) => tiles.get(`${tx}/${ty}`) || null, forward: proj.forward }, target, { nearest });
		post({ id: id as number, rgba: out.buffer as ArrayBuffer, w: target.w, h: target.h, decoded, decodeMs }, [out.buffer]);
	} catch (e) {
		post({ id: m.id, error: (e as Error).message });
	}
};
