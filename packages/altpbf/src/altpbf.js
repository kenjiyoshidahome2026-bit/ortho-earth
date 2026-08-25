// ALTPBF ローダ層（workspace 専用＝npm 非同梱・入口は "altpbf/loader"）。
// フォーマット本体（encode/decode/名前規約/altpbf2png）は ./format.js＝npm 公開面。
// ここは私有インフラ結線＝native-bucket（R2バケツ・IDBキャッシュ・JAXA CORS proxy）と焼き済み日本域の知識。
// 兄弟モジュール（worker/createGetHeight/gebco）の輸入面を保つため、フォーマット関数はここから再輸出する。
import { L3 } from "common";
import { nativeBucket } from "native-bucket";
import { encode, decode, encodeName, decodeName } from "./format.js";
export { encode, decode, encodeName, decodeName, altpbf2png } from "./format.js";

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

export async function tiff2data(file) {   // export＝実タイル検定用（tests/t-tiff.mjs・workspace専用モジュールにつき公開面への影響なし）
	try {
		const buffer = await file.arrayBuffer();
		const view = new DataView(buffer);
		const isLittle = view.getUint16(0) === 0x4949;
		let ifdOffset = view.getUint32(4, isLittle);
		const numEntries = view.getUint16(ifdOffset, isLittle);
		let width, height, strips = null, counts = null;
		// タグ値の配列読み：count×サイズが4バイト以内＝値そのものがインライン、超えたら値欄は「配列へのポインタ」。
		// 旧実装は tag273 を常にインライン単値として読んでいた＝複数ストリップTIFF（米国域ALOSは行毎分割）で
		// ポインタをデータ先頭と誤読→範囲外 Int16Array で RangeError（12,960,000＝3600×3600 の実障害 8/26）。
		const readArr = (entryOffset, type, count) => {
			const size = type === 3 ? 2 : 4;
			const at = off => (type === 3) ? view.getUint16(off, isLittle) : view.getUint32(off, isLittle);
			const base = (count * size <= 4) ? entryOffset + 8 : view.getUint32(entryOffset + 8, isLittle);
			const out = new Array(count);
			for (let k = 0; k < count; k++) out[k] = at(base + k * size);
			return out;
		};
		for (let i = 0; i < numEntries; i++) {
			const entryOffset = ifdOffset + 2 + (i * 12);
			const tag = view.getUint16(entryOffset, isLittle);
			const type = view.getUint16(entryOffset + 2, isLittle);
			const count = view.getUint32(entryOffset + 4, isLittle);
			if (tag === 256) width = readArr(entryOffset, type, 1)[0];        // ImageWidth
			if (tag === 257) height = readArr(entryOffset, type, 1)[0];       // ImageLength (Height)
			if (tag === 273) strips = readArr(entryOffset, type, count);      // StripOffsets（複数可）
			if (tag === 279) counts = readArr(entryOffset, type, count);      // StripByteCounts
			if (tag === 322) return null;                                     // TileWidth＝タイル型TIFFは非対応（呼び元が null 処理）
		}
		if (!width || !height || !strips?.length) return null;
		const need = width * height;
		// 単一ストリップ＋偶数オフセット＋範囲内＝従来どおりゼロコピー
		if (strips.length === 1 && strips[0] % 2 === 0 && strips[0] + need * 2 <= buffer.byteLength)
			return { width, height, data: new Int16Array(buffer, strips[0], need) };
		// 複数ストリップ（or 奇数オフセット）＝コピー1回で集約。各ストリップ長は StripByteCounts、無ければ残量で推定
		const data = new Int16Array(need);
		let pos = 0;
		for (let si = 0; si < strips.length && pos < need; si++) {
			const off = strips[si];
			if (off == null || off >= buffer.byteLength) return null;
			const bytes = Math.min(counts?.[si] ?? (need - pos) * 2, buffer.byteLength - off, (need - pos) * 2);
			const n = bytes >> 1;
			if (n <= 0) return null;
			data.set(off % 2 === 0 ? new Int16Array(buffer, off, n) : new Int16Array(buffer.slice(off, off + n * 2)), pos);
			pos += n;
		}
		if (pos < need) return null;   // 足りない＝切詰め/壊れ＝呼び元が「無し」として平地継続
		return { width, height, data }
	} catch (e) {
		console.error("TIFF parse error:", e);
		return null;
	}
}
