// 標高（altpbf / GEBCO・ALOS）を取得・復号して高さグリッドを得る。
// バケツ格納は gzip( deflateRaw( pbf ) ) の二重圧縮。読み出しはキー不要のGET。
// DecompressionStream（ブラウザ/Node18+ 共通）で解凍。データは delta 符号化の Int16。
import Pbf from "pbf";

const BUCKET = "https://api.ortho-earth.com/bucket/GIS/alt";
const L3 = n => String(Math.abs(n)).padStart(3, "0");
const L2 = n => String(Math.abs(n)).padStart(2, "0");
// 10度タイル名（GEBCO）: R10{N|S}L3(lat0){E|W}L3(lng0)
const nameR10 = (lng0, lat0) => `R${L2(10)}${lat0 < 0 ? "S" : "N"}${L3(lat0)}${lng0 < 0 ? "W" : "E"}${L3(lng0)}`;

async function decompress(bytes, format) {
	const ds = new DecompressionStream(format);
	const stream = new Blob([bytes]).stream().pipeThrough(ds);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decode(body) {
	const pbf = new Pbf(body), o = {}, deltas = [];
	pbf.readFields(tag => {
		if (tag === 1) o.name = pbf.readString();
		else if (tag === 2) o.source = pbf.readString();
		else if (tag === 3) o.width = pbf.readVarint();
		else if (tag === 4) o.height = pbf.readVarint();
		else if (tag === 5) o.lng = pbf.readSVarint();
		else if (tag === 6) o.lat = pbf.readSVarint();
		else if (tag === 7) o.range = pbf.readSVarint();
		else if (tag === 10) pbf.readPackedSVarint(deltas);
	});
	const data = new Int16Array(deltas.length);
	let sum = 0; for (let i = 0; i < deltas.length; i++) { sum += deltas[i]; data[i] = sum; }
	o.data = data;
	return o;                                  // { name, source, width, height, lng, lat, range, data }
}

// 10度タイルを取得・復号（lng0/lat0 は 10 の倍数）。失敗時 null。
export async function fetchR10(lng0, lat0) {
	try {
		const raw = new Uint8Array(await (await fetch(`${BUCKET}/${nameR10(lng0, lat0)}`)).arrayBuffer());
		if (raw.length < 100) return null;
		const outer = (raw[0] === 0x1f && raw[1] === 0x8b) ? await decompress(raw, "gzip") : raw;
		return decode(await decompress(outer, "deflate-raw"));
	} catch (e) { console.warn("[elevation] fetchR10 failed", lng0, lat0, e.message); return null; }
}

// タイルの高さグリッドを Float32（メートル、海は0クランプ）に。GPUテクスチャ用。
export function toFloat32(tile, { clampSea = true } = {}) {
	const src = tile.data, out = new Float32Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = clampSea && src[i] < 0 ? 0 : src[i];
	return out;
}

// 双線形サンプル（y は上下反転格納）。CPU側の高さ問い合わせ用（建物の足元など）。
export function sampleHeight(tile, lng, lat) {
	if (!tile) return 0;
	const { data, width: w, height: h, lng: lo, lat: la, range: r } = tile;
	const x = (lng - lo) / r, y = (lat - la) / r;
	if (x < 0 || x > 1 || y < 0 || y > 1) return 0;
	const H = (xx, yy) => data[(h - (yy || 1)) * w + (xx === w ? w - 1 : xx)];
	const X = x * w, Y = y * h, x0 = X | 0, y0 = Y | 0, a = (v1, v2, f) => v1 + (v2 - v1) * f;
	const v = a(a(H(x0, y0), H(x0 + 1, y0), X - x0), a(H(x0, y0 + 1), H(x0 + 1, y0 + 1), X - x0), Y - y0);
	return v < 0 && clampNeg ? 0 : v;
}
const clampNeg = true;
