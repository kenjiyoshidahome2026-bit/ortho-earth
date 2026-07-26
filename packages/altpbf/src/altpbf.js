import Pbf from 'pbf';
import { L2, L3 } from "../../common/src/utility.js";
import { nativeBucket, deflateRaw, inflateRaw } from "native-bucket";

let _nb = null;
export function setApiUrl(url) { _nb = nativeBucket(url); }
export const getNB = () => { if (!_nb) throw new Error("altpbf: call setApiUrl(url) before use"); return _nb; };

const dire = `GIS/alt`;
let _bucket = null;
const getBucket = async () => _bucket || (_bucket = await getNB().Bucket(dire, { silent: true }));

const baseUrl = "https://www.eorc.jaxa.jp/ALOS";

export async function index_alos() {
	const tub = {};
	const txt = (await getNB().Fetch(`${baseUrl}/jp/dataset/aw3d30/data/List_of_all_tiles_in_AW3D30.txt`, "text")).split("\n");
	txt.forEach(t => {
		const [fname, ver] = t.split(/\s+/);
		fname.match(/[NS]\d+[WE]\d+/) && (tub[fname] = ver);
	});
	return tub;
}
// 日本域の R01 は DTM（GSI DEM10B・bake-dem10b.mjs で焼いて bucket 常備）。bbox は焼き対象と同じ。
// DSM(AW3D30)はビル天端・水面ノイズを含み「都市のテント」「湖の偽の島」の根源＝日本は裸地へ移行。
export const bakedJapan = (lng, lat) => lng >= 122 && lng < 154 && lat >= 20 && lat < 46;

export async function load(name) {
	const [lng, lat, range] = decodeName(name);
	if (range !== 1) return load_gepco(name);
	// R01: bucket（日本域＝GSI DEM10B 焼き済み）優先 → 無ければ JAXA（AW3D30 DSM・海外）
	const baked = await load_gepco(name).catch(() => null);
	if (baked) return baked;
	const alos = await load_alos(lng, lat);
	// bucket 未収録の印＝bbox 内でも外国陸地（韓国・台湾等）は DEM10B 範囲外で JAXA が正
	// → staleDSM の失効対象から外す（これが無いと毎セッション再取得ループ）
	if (alos) alos.noBake = 1;
	return alos;
}

async function load_alos(lng, lat) {
	const source = "ALOS AW3D30", range = 1;
	const f3 = n => (n < 0 ? Math.ceil : Math.floor)(Math.abs(n) / 5) * 5 * (n < 0 ? -1 : 1);
	const LNG = n => (n < 0 ? "W" : "E") + L3(Math.abs(n)), LAT = n => (n < 0 ? "S" : "N") + L3(Math.abs(n));
	const dname = LAT(f3(lat)) + LNG(f3(lng)) + "_" + LAT(f3(lat + 5)) + LNG(f3(lng + 5));
	const fname = LAT(Math.floor(lat)) + LNG(Math.floor(lng));   // 5°zip 内の 1°DSMタイル名（例 N035E139）
	const url = `${baseUrl}/aw3d30/data/release_v2404/${dname}.zip`;
	const target = `${dname}/ALPSMLC30_${fname}_DSM.tif`;
	const file = await getNB().Fetch(url, { target, cors: true });
	const raster = await tiff2data(file); if (!raster) { console.error("geotiff raster error", raster); return null; }
	const { width, height, data } = raster;
	return { name: encodeName(lng, lat, range), source, lng, lat, range, width, height, data };
}
let _cache = null;
const getCache = async () => _cache || (_cache = await getNB().Cache(dire));
async function load_gepco(name) {
	// R90/R10 は IDB へ永続（全球R90=8枚55MBで「地球ぐるぐる」の再訪が通信ゼロに＝IDB直読みの流儀）。
	// bucket.get は gunzip 済み Blob＝そのまま格納し、命中時は decode だけ。IDB不調でも素通りで従来動作。
	const cache = await getCache().catch(() => null);
	const hit = cache && await cache(name).catch(() => null);
	// 命中は decode 成功時のみ信用。同じ IDB ストア・同じキーに外側ローダ（createGetHeight）が
	// 「デコード済み obj」を保存する運用があり、それを Blob と誤って decode すると例外＝catch で
	// 「bucket 未収録」と誤判定 → JAXA(DSM) 再取得＋noBake 毒入り、という事故が起きた（東新橋の
	// 屋上斜面の第二原因）。壊れ形式は捨てて bucket 本体へ進む＝自己修復。
	if (hit) { try { return await decode(hit); } catch (e) { /* 旧/別形式＝素通りして bucket へ（await 必須＝decode は async・reject は同期 catch に掛からない） */ } }
	const blob = await (await getBucket()).get(name);
	if (!blob) return null;
	if (cache) cache(name, blob).catch(() => {});
	return decode(blob);
}
const TAGS = {
	NAME: 1,    // tile name
	SOURCE: 2,  // data source name (GEBCO, ALOS, etc.)
	WIDTH: 3,   // grid width
	HEIGHT: 4,  // grid height
	LNG: 5,     // tile origin longitude (bottom-left)
	LAT: 6,     // tile origin latitude (bottom-left)
	RANGE:7,    // tile lng/lat span
	DATA: 10    // elevation data body (packed SVarint delta-coded)
};

export async function encode(obj) {
	const pbf = new Pbf();
	const { name, source, lng, lat, range, width, height, data } = obj;
	pbf.writeStringField(TAGS.NAME, name);
	pbf.writeStringField(TAGS.SOURCE, source);
	pbf.writeSVarintField(TAGS.LNG, lng);
	pbf.writeSVarintField(TAGS.LAT, lat);
	pbf.writeSVarintField(TAGS.RANGE, range);
	pbf.writeVarintField(TAGS.WIDTH, width);
	pbf.writeVarintField(TAGS.HEIGHT, height);
	let sum = 0;
	const deltas = data.map(t => { const v = t - sum; sum = t; return v; });
	pbf.writePackedSVarint(TAGS.DATA, deltas);
	pbf.finish();
	return deflateRaw(pbf.buf);
}

export async function decode(v) {
	const pbf = new Pbf(await inflateRaw(await v.arrayBuffer())), obj = {};
	const deltas = [];
	pbf.readFields(tag => {
		if (tag === TAGS.NAME) obj.name = pbf.readString();
		else if (tag === TAGS.SOURCE) obj.source = pbf.readString();
		else if (tag === TAGS.WIDTH) obj.width = pbf.readVarint();
		else if (tag === TAGS.HEIGHT) obj.height = pbf.readVarint();
		else if (tag === TAGS.LNG) obj.lng = pbf.readSVarint();
		else if (tag === TAGS.LAT) obj.lat = pbf.readSVarint();
		else if (tag === TAGS.RANGE) obj.range = pbf.readSVarint();
		else if (tag === TAGS.DATA) pbf.readPackedSVarint(deltas);
	});
	let sum = 0; obj.data = new Int16Array(deltas.map(d => sum += d));
	return obj;
}

export function encodeName(lng, lat, range) {
	const latlng = `${(lat < 0 ? "S" : "N")}${L3(Math.abs(lat))}${(lng < 0 ? "W" : "E")}${L3(Math.abs(lng))}`;
	return (range? `R${L2(range)}`: "") + latlng;
}
export function decodeName(s) {
	const range = +s.substring(1,3);
	const lat = +s.substring(4, 7)*(s.substring(3, 4)=="S"?-1:1);
	const lng = +s.substring(8, 11)*(s.substring(7, 8)=="W"?-1:1);
	return [lng,lat,range];
}

async function tiff2data(file) {
	try {
		const buffer = await file.arrayBuffer();
		const view = new DataView(buffer);
		const isLittle = view.getUint16(0) === 0x4949;
		let ifdOffset = view.getUint32(4, isLittle);
		const numEntries = view.getUint16(ifdOffset, isLittle);
		let width, height, dataOffset;
		for (let i = 0; i < numEntries; i++) {
			const entryOffset = ifdOffset + 2 + (i * 12);
			const tag = view.getUint16(entryOffset, isLittle);
			const type = view.getUint16(entryOffset + 2, isLittle);
			const getVal = () => (type === 3)
				? view.getUint16(entryOffset + 8, isLittle)
				: view.getUint32(entryOffset + 8, isLittle);

			if (tag === 256) width = getVal();      // ImageWidth
			if (tag === 257) height = getVal();     // ImageLength (Height)
			if (tag === 273) dataOffset = getVal(); // StripOffsets
		}
		if (!width || !height || !dataOffset) return null;
		const data = new Int16Array(buffer, dataOffset, width * height);
		return { width, height, data }
	} catch (e) {
		console.error("TIFF parse error:", e);
		return null;
	}
}
export async function altpbf2png(pbf, opts = {}) {
	const { size, colorMap } = Object.assign({size:256, colorMap}, opts);
	const { width, height, data } = await decode(pbf);
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext('2d');
	const imageData = ctx.createImageData(size, size);
	const pixels = imageData.data;
	const xRatio = width / size, yRatio = height / size;
	for (let y = 0; y < size; y++) {
		const srcY = Math.floor(y * yRatio);
		const rowOffset = srcY * width;
		const targetRowOffset = y * size;
		for (let x = 0; x < size; x++) {
			const srcX = Math.floor(x * xRatio);
			const h = data[rowOffset + srcX];
			const [r, g, b] = colorMap(h);
			const i = (targetRowOffset + x) * 4;
			pixels[i]     = r;
			pixels[i + 1] = g;
			pixels[i + 2] = b;
			pixels[i + 3] = 255;
		}
	}
	ctx.putImageData(imageData, 0, 0);
	return canvas.convertToBlob({ type: 'image/png' });
}
function colorMap(n, flag = false) {
	const Altitude = n =>
		n < 200 ? [85, 107, 47, 255] :
		n < 500 ? [124, 150, 90, 255] :
		n < 1000 ? [189, 183, 107, 255] :
		n < 2000 ? [180, 130, 70, 255] :
		n < 4000 ? [130, 80, 60, 255] :
		n < 6000 ? [100, 60, 40, 255] : [200, 200, 200, 255];
	const Depth = n =>
		n < 200 ? [170, 220, 240, 255] :
		n < 2000 ? [100, 180, 210, 255] :
		n < 6000 ? [40, 100, 150, 255] : [20, 50, 100, 255];
	return n > 0 ? Altitude(n) : flag ? [0, 0, 0, 0] : Depth(n);
}