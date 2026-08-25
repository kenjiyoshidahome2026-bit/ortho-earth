// t-tiff: tiff2data の最小TIFFリーダ検定。
// 実障害（8/26）＝米国域ALOS AW3D30 は行毎ストリップ（tag273 count=3600＝値欄はオフセット配列へのポインタ）で、
// 旧実装はポインタをデータ先頭と誤読→範囲外 Int16Array で RangeError。単一/複数ストリップ両形式を合成して検定する。
import { tiff2data } from "../src/altpbf.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// 幅W×高H・値=行番号 のInt16ラスタを、指定ストリップ分割で最小TIFF（little endian）に組む
function buildTiff({ W, H, rowsPerStrip }) {
	const nStrips = Math.ceil(H / rowsPerStrip);
	const entries = [[256, 3, 1, W], [257, 3, 1, H], [278, 3, 1, rowsPerStrip]];   // 273/279は後で
	const nEntries = entries.length + 2;
	const ifdOffset = 8;
	const ifdSize = 2 + nEntries * 12 + 4;
	let arraysOffset = ifdOffset + ifdSize;                      // 273/279 の外置き配列（count>1時）
	const arrBytes = nStrips > 1 ? nStrips * 4 * 2 : 0;
	let dataOffset = arraysOffset + arrBytes;
	if (dataOffset % 2) dataOffset++;
	const stripBytes = [], stripOffs = [];
	for (let s = 0; s < nStrips; s++) {
		const rows = Math.min(rowsPerStrip, H - s * rowsPerStrip);
		stripOffs.push(dataOffset + s * rowsPerStrip * W * 2);   // 連続配置（実ALOSと同じ）
		stripBytes.push(rows * W * 2);
	}
	const total = dataOffset + W * H * 2;
	const buf = new ArrayBuffer(total), v = new DataView(buf);
	v.setUint16(0, 0x4949, true); v.setUint16(2, 42, true); v.setUint32(4, ifdOffset, true);
	v.setUint16(ifdOffset, nEntries, true);
	const writeEntry = (i, tag, type, count, val) => {
		const eo = ifdOffset + 2 + i * 12;
		v.setUint16(eo, tag, true); v.setUint16(eo + 2, type, true); v.setUint32(eo + 4, count, true); v.setUint32(eo + 8, val, true);
	};
	let i = 0;
	for (const [tag, type, count, val] of entries) writeEntry(i++, tag, type, count, val);
	if (nStrips === 1) {
		writeEntry(i++, 273, 4, 1, stripOffs[0]);
		writeEntry(i++, 279, 4, 1, stripBytes[0]);
	} else {   // count>1＝値欄は配列へのポインタ（実ALOSの形）
		writeEntry(i++, 273, 4, nStrips, arraysOffset);
		writeEntry(i++, 279, 4, nStrips, arraysOffset + nStrips * 4);
		for (let s = 0; s < nStrips; s++) { v.setUint32(arraysOffset + s * 4, stripOffs[s], true); v.setUint32(arraysOffset + nStrips * 4 + s * 4, stripBytes[s], true); }
	}
	const data = new Int16Array(buf, dataOffset, W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = y;
	return new Blob([buf]);
}

const check = async (label, opts) => {
	const r = await tiff2data(buildTiff(opts));
	if (!r) return ok(false, `${label}: null`);
	let good = r.width === opts.W && r.height === opts.H && r.data.length === opts.W * opts.H;
	for (let y = 0; y < opts.H && good; y += 7) good = r.data[y * opts.W + 3] === y;
	ok(good, `${label}: ${opts.W}x${opts.H} 値一致`);
};

await check("単一ストリップ（従来形）", { W: 64, H: 48, rowsPerStrip: 48 });
await check("行毎ストリップ（ALOS米国域の形）", { W: 64, H: 48, rowsPerStrip: 1 });
await check("複数行ストリップ", { W: 100, H: 90, rowsPerStrip: 16 });

// 切詰めファイル＝nullで返る（throwしない）
const blob = buildTiff({ W: 64, H: 48, rowsPerStrip: 1 });
const cut = new Blob([ (await blob.arrayBuffer()).slice(0, 2000) ]);
ok((await tiff2data(cut)) === null, "切詰めファイル＝null（クラッシュしない）");

process.exit(fails ? 1 : 0);
