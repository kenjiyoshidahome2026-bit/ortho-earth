// ALTPBF フォーマット層（npm 公開面＝この1ファイルで自己完結）。
// 標高グリッドを「delta 符号化 SVarint の packed 列＋deflate-raw」で持つ軽量タイル形式。
// タイル名の規約＝ R{範囲2桁}{N|S}{緯度3桁}{E|W}{経度3桁}（例: R01N035E139 ＝ 1°タイル・北緯35・東経139）。
// ローダ層（bucket/JAXA/IDB＝私有インフラ結線）は ./altpbf.js（npm 非同梱・workspace専用 "altpbf/loader"）。
import Pbf from 'pbf';
import { deflateRaw, inflateRaw } from "geopbf/gzip";

const pad = (n, len) => String(n).padStart(len, '0');
const L2 = n => pad(n, 2), L3 = n => pad(n, 3);

const TAGS = {
	NAME: 1,    // tile name
	SOURCE: 2,  // data source name (GEBCO, ALOS, etc.)
	WIDTH: 3,   // grid width
	HEIGHT: 4,  // grid height
	LNG: 5,     // tile origin longitude (bottom-left)
	LAT: 6,     // tile origin latitude (bottom-left)
	RANGE: 7,   // tile lng/lat span
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

// 標高本体は「varint を読みながら Int16Array へ直書き」＝中間の JS 配列を作らない。
// 旧実装は readPackedSVarint(deltas)（要素数ぶんの JS 配列＝push で倍々成長）＋ deltas.map()（もう1本）で、
// R10(2400²=576万点)1枚あたり heap を ~230MB 食い、しかも altpbf worker の V8 ヒープは縮まない
//（実測: Node 単発 decode で RSS +232MB・heapTotal 299MB・99ms）。標高 worker は3本＝広域×高チルトで
// セルを取り続けるパン中に数百MBが居座る＝「メモリが解放されない」の正体だった。直書きは 21ms / +12MB。
// 語順は encode() が WIDTH/HEIGHT を DATA より先に書く＝DATA 到達時に寸法は既知。念のため未知の場合は
// 「1値≥1バイト」の上界で確保して最後に正寸へ詰める（旧キャッシュ・別実装の産物への保険）。
export async function decode(v) {
	const pbf = new Pbf(await inflateRaw(await v.arrayBuffer())), obj = {};
	pbf.readFields(tag => {
		if (tag === TAGS.NAME) obj.name = pbf.readString();
		else if (tag === TAGS.SOURCE) obj.source = pbf.readString();
		else if (tag === TAGS.WIDTH) obj.width = pbf.readVarint();
		else if (tag === TAGS.HEIGHT) obj.height = pbf.readVarint();
		else if (tag === TAGS.LNG) obj.lng = pbf.readSVarint();
		else if (tag === TAGS.LAT) obj.lat = pbf.readSVarint();
		else if (tag === TAGS.RANGE) obj.range = pbf.readSVarint();
		else if (tag === TAGS.DATA) {
			const end = pbf.readPackedEnd();
			const known = (obj.width | 0) * (obj.height | 0);
			const out = new Int16Array(known || (end - pbf.pos));
			let sum = 0, i = 0;
			while (pbf.pos < end) { sum += pbf.readSVarint(); out[i++] = sum; }
			obj.data = (known || i === out.length) ? out : out.slice(0, i);
		}
	});
	return obj;
}

export function encodeName(lng, lat, range) {
	const latlng = `${(lat < 0 ? "S" : "N")}${L3(Math.abs(lat))}${(lng < 0 ? "W" : "E")}${L3(Math.abs(lng))}`;
	return (range ? `R${L2(range)}` : "") + latlng;
}
export function decodeName(s) {
	const range = +s.substring(1, 3);
	const lat = +s.substring(4, 7) * (s.substring(3, 4) == "S" ? -1 : 1);
	const lng = +s.substring(8, 11) * (s.substring(7, 8) == "W" ? -1 : 1);
	return [lng, lat, range];
}

export async function altpbf2png(pbf, opts = {}) {
	const { size, colorMap: cm } = Object.assign({ size: 256, colorMap: defaultColorMap }, opts);
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
			const [r, g, b] = cm(h);
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
function defaultColorMap(n, flag = false) {
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
