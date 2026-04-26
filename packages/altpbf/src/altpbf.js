import Pbf from 'pbf';
import { L2, L3 } from "common";
import { deflateRaw, inflateRaw } from "native-bucket";
import { fromBlob } from 'geotiff'; 

const TAGS = {
    NAME: 1,    // タイル名
    SOURCE: 2,  // データソース名 (GEBCO, ALOS等)
    WIDTH: 3,   // グリッド幅
    HEIGHT: 4,  // グリッド高
    LNG: 5,     // タイルの基準経度(左下)
    LAT: 6,     // タイルの基準緯度(左下)
    RANGE:7,    // タイルの経度緯度範囲
    DATA: 10    // 標高データ本体 (Packed SVarint)
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

export async function tiff2raster(file) {
	try { return (await (await fromBlob(file)).getImage()).readRasters();
	} catch(e) { return null; }
}

export function AltitudeColor(n, flag = false) {
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