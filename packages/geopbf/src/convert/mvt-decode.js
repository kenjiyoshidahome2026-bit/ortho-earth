// convert/mvt-decode.js ── 検定用の MVT デコーダ（pbf リーダを使う＝bare import があるので worker には持ち込まない）
import Pbf from "pbf";

// → [{ name, extent, version, features: [{ id, type, props, geometry: [[x,y,…]…] }] }]
export function decodeTile(buf) {
	const pbf = new Pbf(buf), layers = [];
	pbf.readFields((tag) => { if (tag === 3) layers.push(pbf.readMessage(readLayer, { name: "", extent: 4096, features: [], keys: [], values: [], raw: [] })); });
	for (const l of layers) {
		for (const f of l.raw) {
			const props = {};
			for (let i = 0; i < f.tags.length; i += 2) props[l.keys[f.tags[i]]] = l.values[f.tags[i + 1]];
			l.features.push({ id: f.id, type: f.type, props, geometry: decodeGeom(f.geom) });
		}
		delete l.raw; delete l.keys; delete l.values;
	}
	return layers;
}
function readLayer(tag, l, pbf) {
	if (tag === 15) l.version = pbf.readVarint();
	else if (tag === 1) l.name = pbf.readString();
	else if (tag === 2) l.raw.push(pbf.readMessage(readFeature, { id: undefined, tags: [], type: 0, geom: [] }));
	else if (tag === 3) l.keys.push(pbf.readString());
	else if (tag === 4) l.values.push(pbf.readMessage(readValue, {}).v);
	else if (tag === 5) l.extent = pbf.readVarint();
}
function readFeature(tag, f, pbf) {
	if (tag === 1) f.id = pbf.readVarint();
	else if (tag === 2) pbf.readPackedVarint(f.tags);
	else if (tag === 3) f.type = pbf.readVarint();
	else if (tag === 4) pbf.readPackedVarint(f.geom);
}
function readValue(tag, o, pbf) {
	if (tag === 1) o.v = pbf.readString(); else if (tag === 2) o.v = pbf.readFloat(); else if (tag === 3) o.v = pbf.readDouble();
	else if (tag === 4) o.v = pbf.readVarint(true); else if (tag === 5) o.v = pbf.readVarint(); else if (tag === 6) o.v = pbf.readSVarint(); else if (tag === 7) o.v = pbf.readBoolean();
}
function decodeGeom(g) {   // → リング/線/点列の配列（number[]・ClosePath は閉じ点を付けない）
	const parts = []; let cur = null, x = 0, y = 0;
	for (let i = 0; i < g.length;) {
		const c = g[i] & 7, n = g[i] >> 3; i++;
		if (c === 1) { for (let k = 0; k < n; k++) { x += (g[i] >> 1) ^ -(g[i] & 1); y += (g[i + 1] >> 1) ^ -(g[i + 1] & 1); i += 2; cur = [x, y]; parts.push(cur); } }
		else if (c === 2) { for (let k = 0; k < n; k++) { x += (g[i] >> 1) ^ -(g[i] & 1); y += (g[i + 1] >> 1) ^ -(g[i + 1] & 1); i += 2; cur.push(x, y); } }
	}
	return parts;
}
