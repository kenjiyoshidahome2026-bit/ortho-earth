// TIFF/BigTIFF の構造解析（COG サブセット）。バイト列は getBytes(from,len) 経由＝ヘッダ窓に収まらない
// IFD チェーン・巨大なタイルオフセット表も必要分だけ追い読みできる（発注は source.js が coalesce する）。
// 対応: classic(magic 42)/BigTIFF(magic 43)・II/MM 両バイト順・タイル型＋strip 型（strip は
// 「幅=画像幅のタイル」へ正規化＝GDAL を通らないローカル .tif の救済）・overview チェーン・
// GeoKeyDirectory→EPSG・ModelPixelScale/Tiepoint（回転付き ModelTransformation は軸平行のみ許容）。
// 非対応（明示エラー）: PlanarConfig=2・predictor=3・12bit JPEG。未知タグは黙って skip（既存文化）。

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

export async function parseTiff(getBytes) {
	const head = await getBytes(0, 16);
	const hv = dv(head);
	const le = hv.getUint16(0) === 0x4949;   // "II"
	if (!le && hv.getUint16(0) !== 0x4D4D) throw new Error("cog: not a TIFF");
	const magic = hv.getUint16(2, le);
	const big = magic === 43;
	if (magic !== 42 && !big) throw new Error(`cog: bad TIFF magic ${magic}`);
	if (big && (hv.getUint16(4, le) !== 8 || hv.getUint16(6, le) !== 0)) throw new Error("cog: bad BigTIFF header");

	// オフセット/カウントの読み口を classic(4B)/BigTIFF(8B) で1本化
	const OFF = big ? 8 : 4;
	const getOff = (v, at) => big ? Number(v.getBigUint64(at, le)) : v.getUint32(at, le);
	const entrySize = big ? 20 : 12;

	const ifds = [];
	let next = big ? Number(hv.getBigUint64(8, le)) : hv.getUint32(4, le);
	while (next && ifds.length < 32) {   // 32 段あれば十分（COG の overview は高々十数段）
		const cntBuf = await getBytes(next, big ? 8 : 2);
		const nTags = big ? Number(dv(cntBuf).getBigUint64(0, le)) : dv(cntBuf).getUint16(0, le);
		const body = await getBytes(next + (big ? 8 : 2), nTags * entrySize + OFF);
		const bv = dv(body);
		const tags = new Map();
		for (let i = 0; i < nTags; i++) {
			const o = i * entrySize;
			const tag = bv.getUint16(o, le), type = bv.getUint16(o + 2, le);
			const count = big ? Number(bv.getBigUint64(o + 4, le)) : bv.getUint32(o + 4, le);
			tags.set(tag, { type, count, at: next + (big ? 8 : 2) + o + (big ? 12 : 8), inline: body.subarray(o + (big ? 12 : 8), o + entrySize) });
		}
		next = getOff(bv, nTags * entrySize);
		ifds.push(tags);
	}
	if (!ifds.length) throw new Error("cog: no IFD");

	// タグ値の取り出し（inline / pointer を吸収）。数値配列で返す。
	const values = async (tags, tag) => {
		const e = tags.get(tag);
		if (!e) return null;
		const sz = (TYPE_SIZE[e.type] || 1) * e.count;
		const raw = sz <= OFF ? e.inline.subarray(0, sz) : await getBytes(getOff(dv(e.inline), 0), sz);
		const v = dv(raw), out = new Array(e.count);
		for (let i = 0; i < e.count; i++) {
			switch (e.type) {
				case 1: case 2: case 7: out[i] = raw[i]; break;
				case 3: out[i] = v.getUint16(i * 2, le); break;
				case 4: out[i] = v.getUint32(i * 4, le); break;
				case 5: out[i] = v.getUint32(i * 8, le) / v.getUint32(i * 8 + 4, le); break;
				case 6: out[i] = v.getInt8(i); break;
				case 8: out[i] = v.getInt16(i * 2, le); break;
				case 9: out[i] = v.getInt32(i * 4, le); break;
				case 11: out[i] = v.getFloat32(i * 4, le); break;
				case 12: out[i] = v.getFloat64(i * 8, le); break;
				case 16: case 17: case 18: out[i] = Number(v.getBigUint64(i * 8, le)); break;
				default: out[i] = 0;
			}
		}
		return out;
	};
	const one = async (tags, tag, def) => { const a = await values(tags, tag); return a ? a[0] : def; };
	const ascii = async (tags, tag) => { const a = await values(tags, tag); return a ? String.fromCharCode(...a.filter(c => c)).trim() : null; };
	const bytes = async (tags, tag) => {   // UNDEFINED をそのまま（JPEGTables 用）
		const e = tags.get(tag);
		if (!e) return null;
		return e.count <= OFF ? e.inline.slice(0, e.count) : await getBytes(getOff(dv(e.inline), 0), e.count);
	};

	// ---- 各 IFD をモデル化 -------------------------------------------------------
	const out = [];
	for (const tags of ifds) {
		const sub = await one(tags, 254, 0);            // NewSubfileType: 1=縮小(overview) 4=mask
		if (sub & 4) continue;                          // transparency mask IFD は読み飛ばす
		const width = await one(tags, 256), height = await one(tags, 257);
		if (!width || !height) continue;
		const planar = await one(tags, 284, 1);
		if (planar !== 1) throw new Error("cog: PlanarConfiguration=2 (planar) not supported");
		const predictor = await one(tags, 317, 1);
		if (predictor === 3) throw new Error("cog: floating point predictor (3) not supported");
		const compression = await one(tags, 259, 1);
		const bits = (await values(tags, 258)) || [8];
		if (compression === 7 && bits.some(b => b > 8)) throw new Error("cog: >8bit JPEG not supported");

		let tileW = await one(tags, 322, 0), tileH = await one(tags, 323, 0);
		let offsets, counts;
		if (tileW) {
			offsets = await values(tags, 324); counts = await values(tags, 325);
		} else {
			// strip 型 → 「幅=画像幅のタイル」に正規化（tilesX=1）。COG は必ずタイル型だが手元 .tif を救う。
			tileW = width; tileH = await one(tags, 278, height);
			offsets = await values(tags, 273); counts = await values(tags, 279);
		}
		if (!offsets || !counts) continue;

		const colorMapRaw = await values(tags, 320);
		let palette = null;
		if (colorMapRaw) {   // 16bit×3面 → RGBA256（l03b-r-worker と同じ縮約・alpha は不透明）
			const nn = colorMapRaw.length / 3;
			palette = new Uint8Array(256 * 4);
			for (let k = 0; k < nn && k < 256; k++) {
				palette[k * 4] = colorMapRaw[k] >> 8;
				palette[k * 4 + 1] = colorMapRaw[nn + k] >> 8;
				palette[k * 4 + 2] = colorMapRaw[nn * 2 + k] >> 8;
				palette[k * 4 + 3] = 255;
			}
		}

		out.push({
			width, height, tileW, tileH,
			tilesX: Math.ceil(width / tileW), tilesY: Math.ceil(height / tileH),
			offsets, counts, compression, predictor,
			photometric: await one(tags, 262, 1),
			samples: await one(tags, 277, bits.length),
			bits,
			sampleFormat: await one(tags, 339, 1),      // 1=uint 2=int 3=float
			extraSamples: (await values(tags, 338)) || [],
			jpegTables: compression === 7 ? await bytes(tags, 347) : null,
			palette,
			isOverview: !!(sub & 1),
			tags,
		});
	}
	if (!out.length) throw new Error("cog: no image IFD");

	// ---- ジオリファレンス（フル解像度 IFD から） ------------------------------------
	const main = out.reduce((a, b) => (b.width > a.width ? b : a));
	const mt = await values(main.tags, 33550);   // ModelPixelScale
	const tp = await values(main.tags, 33922);   // ModelTiepoint
	const xf = await values(main.tags, 34264);   // ModelTransformation（回転込みフルアフィン＝SAR GEC の実勢 9/6 対応）
	// geo＝フルアフィン統一: X = ox + ax·px + ay·py / Y = oy + bx·px + by·py（軸平行は ay=bx=0 の特殊形）
	let geo = null;
	if (mt && tp) geo = { ox: tp[3] - tp[0] * mt[0], oy: tp[4] + tp[1] * mt[1], ax: mt[0], ay: 0, bx: 0, by: -mt[1] };
	else if (xf) geo = { ox: xf[3], oy: xf[7], ax: xf[0], ay: xf[1], bx: xf[4], by: xf[5] };
	if (!geo) throw new Error("cog: no georeference (ModelPixelScale/Tiepoint)");
	if (Math.abs(geo.ax * geo.by - geo.ay * geo.bx) < 1e-30) throw new Error("cog: degenerate geotransform");
	geo.rotated = !(geo.ay === 0 && geo.bx === 0);
	// bbox（源 CRS）＝画像四隅のアフィン像の外接（回転でも正しい）
	const cx = (px, py) => geo.ox + geo.ax * px + geo.ay * py, cy = (px, py) => geo.oy + geo.bx * px + geo.by * py;
	let bx0 = 1e30, by0 = 1e30, bx1 = -1e30, by1 = -1e30;
	for (const [px, py] of [[0, 0], [main.width, 0], [0, main.height], [main.width, main.height]]) {
		bx0 = Math.min(bx0, cx(px, py)); bx1 = Math.max(bx1, cx(px, py));
		by0 = Math.min(by0, cy(px, py)); by1 = Math.max(by1, cy(px, py));
	}
	const bbox = [bx0, by0, bx1, by1];

	// ---- GeoKeyDirectory → EPSG --------------------------------------------------
	const gk = await values(main.tags, 34735);
	let epsg = null;
	if (gk && gk.length >= 4) {
		const keys = {};
		for (let i = 4; i + 3 < (4 + gk[3] * 4); i += 4) if (gk[i + 1] === 0) keys[gk[i]] = gk[i + 3];   // inline SHORT のみ
		epsg = keys[3072] || (keys[1024] === 2 ? (keys[2048] || 4326) : null);   // projected 優先・geographic は 2048
	}

	const nodataStr = await ascii(main.tags, 42113);   // GDAL_NODATA（ASCII）
	const nodata = nodataStr !== null && nodataStr !== "" ? Number(nodataStr) : null;
	const citation = await ascii(main.tags, 34737);

	for (const o of out) delete o.tags;   // 解析後はタグ表を手放す（保持コストゼロに）
	// overviews はフル解像度含め width 降順＝level 0 がフル解像度
	out.sort((a, b) => b.width - a.width);
	return { ifds: out, epsg, geo, bbox, nodata, citation, bigtiff: big, littleEndian: le };
}

const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
