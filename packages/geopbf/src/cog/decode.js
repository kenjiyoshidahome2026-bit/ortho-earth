// タイルのバイト列 → RGBA8 への道。DOM-free 部分（deflate/LZW/predictor/型変換/stretch）はここで完結し、
// JPEG/WebP は「ブラウザのネイティブデコーダに渡せる完成バイト列」を返すだけ（createImageBitmap は
// worker/index 側＝Node では明示スキップ）。deflate は modules/inflate.js＝Node は zlib・ブラウザは
// DecompressionStream（writer/reader 直叩き）＝pako 不使用。そのため decodeTile は非同期。
import { inflate } from "../modules/inflate.js";

// ---- TIFF LZW（compression=5・MSB-first・ClearCode=256・early change）約60行 ----------------
export function lzwDecode(src, sizeHint = 4096) {
	let out = new Uint8Array(sizeHint), pos = 0;
	const grow = (n) => { if (pos + n > out.length) { const g = new Uint8Array(Math.max(out.length * 2, pos + n)); g.set(out.subarray(0, pos)); out = g; } };
	// 辞書は prefix/suffix の連鎖表（旧＝エントリごとに JS 配列を複製＝辞書 1 周で数千本の配列生成）
	const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), lens = new Uint16Array(4096), first = new Uint8Array(4096);
	for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; lens[i] = 1; first[i] = i; }
	let width = 9, next = 258, prev = -1;
	const emit = (c) => {   // エントリ c のバイト列を out へ（末尾から前へ辿る）
		const n = lens[c]; grow(n);
		for (let k = pos + n - 1; c >= 0; c = prefix[c]) out[k--] = suffix[c];
		pos += n;
	};
	let bit = 0;
	const total = src.length * 8;
	while (bit + width <= total) {
		const byteI = bit >> 3, shift = bit & 7;
		// 最大 17bit を跨ぐので 3 byte 読み
		const w24 = (src[byteI] << 16) | ((src[byteI + 1] || 0) << 8) | (src[byteI + 2] || 0);
		const code = (w24 >> (24 - shift - width)) & ((1 << width) - 1);
		bit += width;
		if (code === 257) break;                                   // EOI
		if (code === 256) { width = 9; next = 258; prev = -1; continue; }   // Clear
		let entryFirst;
		if (code < next && code !== 256 && code !== 257) { emit(code); entryFirst = first[code]; }
		else if (code === next && prev >= 0) { emit(prev); grow(1); out[pos++] = first[prev]; entryFirst = first[prev]; }   // KwKwK
		else throw new Error("cog: corrupt LZW stream");
		if (prev >= 0 && next < 4096) {   // table[next] = prev + entry[0]
			prefix[next] = prev; suffix[next] = entryFirst; lens[next] = lens[prev] + 1; first[next] = first[prev];
			next++;
			if (next === (1 << width) - 1 && width < 12) width++;   // early change
		}
		prev = code;   // KwKwK の時も今追加したエントリ（next-1 === code）＝旧 prev=entry と同値
	}
	return out.subarray(0, pos);
}

// ---- predictor=2（水平差分の累積・バンド数 stride・8/16bit）---------------------------------
export function undoPredictor2(data, w, h, samples, bytesPer) {
	if (bytesPer === 1) {
		for (let r = 0; r < h; r++) {
			const row = r * w * samples;
			for (let i = samples; i < w * samples; i++) data[row + i] = (data[row + i] + data[row + i - samples]) & 255;
		}
	} else {   // 16bit: 要素単位の加算（data は既にプラットフォーム endian の Uint16/Int16 view）
		for (let r = 0; r < h; r++) {
			const row = r * w * samples;
			for (let i = samples; i < w * samples; i++) data[row + i] = (data[row + i] + data[row + i - samples]) & 65535;
		}
	}
	return data;
}

// ---- バイト列 → 型付き配列（ファイル byte order → プラットフォーム）---------------------------
const PLATFORM_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
export function typedOf(u8, ifd, le) {
	const { bits, sampleFormat } = ifd;
	const b = bits[0];
	if (b === 8) return sampleFormat === 2 ? new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength) : u8;
	const n = u8.byteLength >> (b === 16 ? 1 : 2);
	if (b === 16) {
		if (le === PLATFORM_LE) { const c = u8.slice(0, n * 2); return sampleFormat === 2 ? new Int16Array(c.buffer) : new Uint16Array(c.buffer); }   // 同 endian＝memcpy 1 回（旧＝標本ごとに DataView）
		const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
		const out = sampleFormat === 2 ? new Int16Array(n) : new Uint16Array(n);
		for (let i = 0; i < n; i++) out[i] = sampleFormat === 2 ? view.getInt16(i * 2, le) : view.getUint16(i * 2, le);
		return out;
	}
	if (b === 32 && sampleFormat === 3) {
		if (le === PLATFORM_LE) return new Float32Array(u8.slice(0, n * 4).buffer);
		const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, le);
		return out;
	}
	throw new Error(`cog: unsupported sample ${b}bit format=${sampleFormat}`);
}

// ---- JPEG-in-TIFF: JPEGTables(347) とタイルデータの連結（テーブルの EOI とタイルの SOI を落とす）----
export function mergeJPEGTables(tables, tile) {
	if (!tables || tables.length < 4) return tile;
	let tEnd = tables.length;
	if (tables[tEnd - 2] === 0xFF && tables[tEnd - 1] === 0xD9) tEnd -= 2;   // EOI
	let tStart = 0;
	if (tile[0] === 0xFF && tile[1] === 0xD8) tStart = 2;                    // SOI
	const out = new Uint8Array(tEnd + (tile.length - tStart));
	out.set(tables.subarray(0, tEnd), 0);
	out.set(tile.subarray(tStart), tEnd);
	return out;
}

// ---- タイル1枚のデコード（DOM-free 経路）-----------------------------------------------------
// 戻り: {kind:"raster", data:TypedArray} ＝ none/deflate/LZW（predictor 適用済み・プラットフォーム endian）
//       {kind:"image", bytes, mime}      ＝ JPEG/WebP（呼び出し側が createImageBitmap）
export async function decodeTile(raw, ifd, le) {
	const { compression, tileW, tileH, samples, bits } = ifd;
	const bytesPer = bits[0] >> 3;
	if (compression === 7) return { kind: "image", bytes: mergeJPEGTables(ifd.jpegTables, raw), mime: "image/jpeg" };
	if (compression === 50001) return { kind: "image", bytes: raw, mime: "image/webp" };
	let u8;
	if (compression === 1) u8 = ifd.predictor === 2 ? raw.slice() : raw;   // 無圧縮＋predictor は in-place 累積＝二層目キャッシュの生バイトを壊さないよう複製
	else if (compression === 8 || compression === 32946) u8 = await inflate(raw, "deflate");   // zlib（TIFF deflate は zlib 包み）
	else if (compression === 5) u8 = lzwDecode(raw, tileW * tileH * samples * bytesPer);
	else throw new Error(`cog: unsupported compression ${compression}`);
	let data = typedOf(u8, ifd, le);
	if (ifd.predictor === 2) data = undoPredictor2(data, tileW, tileH, samples, bytesPer);
	return { kind: "raster", data };
}

// ---- RGBA8 化（gray/RGB(A)/palette・stretch・nodata→alpha0）--------------------------------
// stretch=[lo,hi] は u16/i16/f32 単バンド用。u8 は恒等。edge タイルも tileW×tileH のまま返す
// （TIFF はタイルを常にフル寸で持つ＝切り詰めは warp 側が画像境界で行う）。
export function toRGBA8(data, ifd, { stretch = null, nodata = null } = {}) {
	const { tileW, tileH, samples, photometric, palette, extraSamples } = ifd;
	const n = tileW * tileH;
	const out = new Uint8ClampedArray(n * 4);
	if (photometric === 3 && palette) {          // palette
		for (let i = 0; i < n; i++) {
			const b = data[i] * 4;
			out[i * 4] = palette[b]; out[i * 4 + 1] = palette[b + 1]; out[i * 4 + 2] = palette[b + 2];
			out[i * 4 + 3] = (nodata !== null && data[i] === nodata) ? 0 : palette[b + 3];
		}
		return out;
	}
	if (samples >= 3) {                          // RGB / RGBA（u8 前提＝Sentinel TCI 等）
		const hasA = samples >= 4 && extraSamples.length;
		for (let i = 0; i < n; i++) {
			const s = i * samples;
			out[i * 4] = data[s]; out[i * 4 + 1] = data[s + 1]; out[i * 4 + 2] = data[s + 2];
			out[i * 4 + 3] = hasA ? data[s + 3] :
				(nodata !== null && data[s] === nodata && data[s + 1] === nodata && data[s + 2] === nodata) ? 0 : 255;
		}
		return out;
	}
	// 単バンド → グレー（stretch は f32 のまま計算＝バンディング回避）
	const [lo, hi] = stretch || [0, 255];
	const k = 255 / Math.max(hi - lo, 1e-9);
	for (let i = 0; i < n; i++) {
		const v = data[i];
		if (nodata !== null && v === nodata) { out[i * 4 + 3] = 0; continue; }
		const g = (v - lo) * k;
		out[i * 4] = g; out[i * 4 + 1] = g; out[i * 4 + 2] = g; out[i * 4 + 3] = 255;
	}
	return out;
}
