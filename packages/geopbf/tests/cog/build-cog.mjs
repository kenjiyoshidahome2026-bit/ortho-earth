// テスト専用: 合成 COG をメモリ上に組むビルダ（altpbf/tests/t-tiff.mjs の発展形）。
// classic/BigTIFF・タイル/strip・none/deflate/LZW・predictor2・GeoKey(EPSG)・ModelPixelScale/Tiepoint・
// GDAL_NODATA・palette・sparse タイル・overview 複数 IFD を LE で書く。外部データ不要＝決定的。
import { deflateSync } from "node:zlib";

// ---- テスト用 LZW エンコーダ（リテラルコードのみ＝非圧縮だが合法な TIFF LZW ストリーム）--------
// デコーダと同じ幅スケジュール（early change・12bit 上限・4093 で Clear）を踏む。
export function lzwEncode(bytes) {
	const out = [];
	let acc = 0, nbits = 0;
	const put = (code, width) => {
		acc = (acc << width) | code; nbits += width;
		while (nbits >= 8) { out.push((acc >> (nbits - 8)) & 255); nbits -= 8; }
	};
	let width = 9, next = 258, first = true;
	put(256, width);   // Clear
	for (const b of bytes) {
		put(b, width);
		if (!first) { next++; if (next === (1 << width) - 1 && width < 12) width++; }
		first = false;
		if (next >= 4093) { put(256, width); width = 9; next = 258; first = true; }
	}
	put(257, width);   // EOI
	if (nbits > 0) out.push((acc << (8 - nbits)) & 255);
	return new Uint8Array(out);
}

// ---- TIFF 書き出し -----------------------------------------------------------------------
// spec 相当の最小 writer。entries は [tag, type, values(配列)|Uint8Array(UNDEFINED)] で渡す。
const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 7: 1, 12: 8, 16: 8 };

export function buildCog(o = {}) {
	const {
		width = 64, height = 48, tileW = 16, tileH = 16,
		epsg = 32654, origin = [300000, 4000000], scale = [10, 10], transform = null,   // transform=16要素＝tag34264（回転アフィン・origin/scale の代わり）
		bands = 3, dtype = "u8", compression = "none", predictor = false,
		overviews = [], pixel = (x, y) => [x & 255, y & 255, (x + y) & 255],
		palette = null, nodata = null, strip = false, bigtiff = false, sparse = null,
	} = o;

	const bytesPer = dtype === "u8" ? 1 : dtype === "u16" ? 2 : 4;
	const comp = { none: 1, deflate: 8, lzw: 5 }[compression];

	// 1 段ぶんのタイル群データを作る
	const makeLevel = (w, h, factor) => {
		const tw = strip ? w : tileW, th = strip ? Math.min(8, h) : tileH;
		const tilesX = Math.ceil(w / tw), tilesY = Math.ceil(h / th);
		const tiles = [];
		for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
			if (sparse && factor === 1 && sparse[0] === tx && sparse[1] === ty) { tiles.push(null); continue; }
			const n = tw * th * bands;
			const arr = dtype === "u8" ? new Uint8Array(n) : dtype === "u16" ? new Uint16Array(n) : new Float32Array(n);
			for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
				const gx = (tx * tw + i) * factor, gy = (ty * th + j) * factor;   // フル解像度座標で色決め＝段間で図柄一致
				let v = pixel(gx, gy);
				if (!Array.isArray(v)) v = [v];
				for (let b = 0; b < bands; b++) arr[(j * tw + i) * bands + b] = v[b] ?? v[0];
			}
			if (predictor) {   // 水平差分（エンコード側＝右から引く）
				for (let j = 0; j < th; j++) for (let i = tw * bands - 1; i >= bands; i--) {
					const at = j * tw * bands + i;
					arr[at] = (arr[at] - arr[at - bands]) & (bytesPer === 1 ? 255 : 65535);
				}
			}
			let u8 = new Uint8Array(arr.buffer.slice(0));   // LE 前提（テストは LE 環境）
			if (comp === 8) u8 = new Uint8Array(deflateSync(u8));
			else if (comp === 5) u8 = lzwEncode(u8);
			tiles.push(u8);
		}
		return { w, h, tw, th, tilesX, tilesY, tiles };
	};

	const levels = [makeLevel(width, height, 1), ...overviews.map(f => makeLevel(Math.ceil(width / f), Math.ceil(height / f), f))];

	// ---- レイアウト: [header][IFD 群+値領域][タイルデータ] ----------------------------------
	const le = true, big = bigtiff;
	const OFF = big ? 8 : 4, ENT = big ? 20 : 12, HEAD = big ? 16 : 8;
	const chunks = [];   // {buf, at} 後で連結
	let pos = HEAD;

	// 各 IFD のエントリを組む（値領域は IFD 直後）
	const geoKeys = [1, 1, 0, 3, 1024, 0, 1, epsg >= 32600 ? 1 : 2, 3072, 0, 1, epsg >= 32600 ? epsg : 0, 2048, 0, 1, epsg < 32600 ? epsg : 4326];
	const ifdBufs = levels.map((lv, li) => {
		const entries = [
			[256, 3, [lv.w]], [257, 3, [lv.h]],
			[258, 3, Array(bands).fill(bytesPer * 8)],
			[259, 3, [comp]],
			[262, 3, [palette ? 3 : bands >= 3 ? 2 : 1]],
			[277, 3, [bands]],
			[339, 3, Array(bands).fill(dtype === "f32" ? 3 : 1)],
		];
		if (li > 0) entries.push([254, 4, [1]]);   // overview
		if (predictor) entries.push([317, 3, [2]]);
		if (strip) entries.push([278, 3, [lv.th]]);
		else entries.push([322, 3, [lv.tw]], [323, 3, [lv.th]]);
		if (li === 0) {
			if (transform) entries.push([34264, 12, transform]);
			else { entries.push([33550, 12, [scale[0], scale[1], 0]]); entries.push([33922, 12, [0, 0, 0, origin[0], origin[1], 0]]); }
			entries.push([34735, 3, geoKeys]);
			if (nodata !== null) entries.push([42113, 2, [...`${nodata}\0`].map(c => c.charCodeAt(0))]);
			if (palette) entries.push([320, 3, [...Array(256 * 3)].map((_, i) => (palette[(i % 256) * 4 + ((i / 256) | 0)] << 8) | 0)]);
		}
		const offTag = strip ? 273 : 324, cntTag = strip ? 279 : 325;
		entries.push([offTag, big ? 16 : 4, lv.tiles.map(() => 0)]);   // 後で埋める
		entries.push([cntTag, 4, lv.tiles.map(t => t ? t.length : 0)]);
		entries.sort((a, b) => a[0] - b[0]);

		// IFD 本体＋あふれ値の領域を計算
		const cnt = big ? 8 : 2;
		let valPos = pos + cnt + entries.length * ENT + OFF;   // 値領域は next オフセットの直後
		const vals = [];
		const body = new Uint8Array(valPos - pos + entries.reduce((s, e) => {
			const sz = TYPE_SIZE[e[1]] * e[2].length;
			return s + (sz > OFF ? (sz + 1) & ~1 : 0);
		}, 0));
		const bv = new DataView(body.buffer);
		big ? bv.setBigUint64(0, BigInt(entries.length), le) : bv.setUint16(0, entries.length, le);
		const writeVal = (view, at, type, v) => {
			if (type === 2 || type === 7) view.setUint8(at, v);
			else if (type === 3) view.setUint16(at, v, le);
			else if (type === 4) view.setUint32(at, v, le);
			else if (type === 12) view.setFloat64(at, v, le);
			else if (type === 16) view.setBigUint64(at, BigInt(v), le);
		};
		entries.forEach((e, i) => {
			const at = cnt + i * ENT;
			bv.setUint16(at, e[0], le); bv.setUint16(at + 2, e[1], le);
			big ? bv.setBigUint64(at + 4, BigInt(e[2].length), le) : bv.setUint32(at + 4, e[2].length, le);
			const sz = TYPE_SIZE[e[1]] * e[2].length;
			if (sz <= OFF) e[2].forEach((vv, kk) => writeVal(bv, at + (big ? 12 : 8) + kk * TYPE_SIZE[e[1]], e[1], vv));
			else {
				const vp = valPos + vals.reduce((s, q) => s + ((q.sz + 1) & ~1), 0);
				big ? bv.setBigUint64(at + (big ? 12 : 8), BigInt(vp), le) : bv.setUint32(at + (big ? 12 : 8), vp, le);
				vals.push({ e, at: vp - pos, sz });
			}
		});
		for (const q of vals) q.e[2].forEach((v, k) => writeVal(bv, q.at + k * TYPE_SIZE[q.e[1]], q.e[1], v));
		const ifd = { at: pos, body, entries, offTagAt: null };
		// タイルオフセット表の位置（後で実データ位置を書き込む）
		entries.forEach((e, i) => {
			if (e[0] === offTag) {
				const sz = TYPE_SIZE[e[1]] * e[2].length;
				ifd.offTag = { type: e[1], count: e[2].length, at: sz <= OFF ? pos + cnt + i * ENT + (big ? 12 : 8) : pos + vals.find(q => q.e === e).at };
			}
		});
		pos += body.length;
		chunks.push(ifd);
		return ifd;
	});

	// タイルデータを後ろへ詰める（連続配置＝coalesce テストが利く）
	const tilePos = levels.map((lv) => lv.tiles.map((t) => { if (!t) return 0; const p = pos; pos += (t.length + 1) & ~1; return p; }));

	// ---- 連結 ------------------------------------------------------------------------------
	const out = new Uint8Array(pos);
	const ov = new DataView(out.buffer);
	ov.setUint16(0, 0x4949, true);   // II
	ov.setUint16(2, big ? 43 : 42, le);
	if (big) { ov.setUint16(4, 8, le); ov.setUint16(6, 0, le); ov.setBigUint64(8, BigInt(ifdBufs[0].at), le); }
	else ov.setUint32(4, ifdBufs[0].at, le);
	ifdBufs.forEach((ifd, i) => {
		out.set(ifd.body, ifd.at);
		// next IFD ポインタ（body 内の count+entries 直後）
		const nextAt = ifd.at + (big ? 8 : 2) + ifd.entries.length * ENT;
		const next = ifdBufs[i + 1] ? ifdBufs[i + 1].at : 0;
		big ? ov.setBigUint64(nextAt, BigInt(next), le) : ov.setUint32(nextAt, next, le);
		// タイルオフセット表を実位置で上書き
		tilePos[i].forEach((p, k) => {
			const at = ifd.offTag.at + k * TYPE_SIZE[ifd.offTag.type];
			ifd.offTag.type === 16 ? ov.setBigUint64(at, BigInt(p), le) : ov.setUint32(at, p, le);
		});
	});
	levels.forEach((lv, i) => lv.tiles.forEach((t, k) => { if (t) out.set(t, tilePos[i][k]); }));
	return out;
}
