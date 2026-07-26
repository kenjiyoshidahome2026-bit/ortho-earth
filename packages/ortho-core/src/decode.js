// MVT（Mapbox Vector Tile）自前デコード（pbf 直読み）。
// 返り値は source-layer 名 → { extent, features:[{type, props, geom, id}] }。
// geom はフラット表現 { coords: Int32Array([x,y,x,y,…]), ends: [各リング/線の終端coord添字…] }。
// 旧 @mapbox/vector-tile の loadGeometry() は毎頂点 {x,y} Point オブジェクトを生成し、消費側(build/buildings)が
// また flat 配列へ詰め直していた＝二度手間+GC圧。フラット直行でこの中間表現ごと消す。
// ClosePath はリング先頭点の複製を追記（loadGeometry 互換＝リングは閉じて返る）。
import Pbf from "pbf";

const GEOM_TYPE = { 1: "Point", 2: "LineString", 3: "Polygon" };

// style が実際に参照する source-layer 集合（fill/line/symbol の source-layer ∪ 建物の BldA）。
// これ以外の層（等高線 Cntr・未使用注記など optimal_bvmap は層が多い）は features どころか
// keys/values の文字列デコードごと素通りできる（旧実装は未使用層でも keys/values を全デコードしていた）。
export function neededSourceLayers(style) {
	const set = new Set(["BldA"]);   // buildings.js は layers.BldA を直接参照
	for (const L of style.layers) {
		if ((L.type === "fill" || L.type === "line" || L.type === "symbol") && L["source-layer"]) set.add(L["source-layer"]);
	}
	return set;
}

// need（Set）を渡すと未参照層をスキップ。未指定なら全層デコード（後方互換）。
export function decodeMVT(buf, need) {
	const pbf = new Pbf(buf);
	const out = {};
	while (pbf.pos < pbf.length) {
		const tag = pbf.readVarint();
		if (tag === 26) readLayer(pbf, pbf.readVarint() + pbf.pos, out, need);   // tile.layers (field 3)
		else pbf.skip(tag);
	}
	return out;
}

function readLayer(pbf, end, out, need) {
	// 1パス目：位置だけ拾う（フィールド順は仕様上不定なので name 確定後に本デコード）。
	// need 外の層はここで捨てる＝keys/values/features は生バイトのまま触らない。
	let name = "", extent = 4096;
	const featPos = [], keyPos = [], valPos = [];
	while (pbf.pos < end) {
		const tag = pbf.readVarint();
		if (tag === 10) name = pbf.readString();                    // name (field 1)
		else if (tag === 18) { featPos.push(pbf.pos); pbf.skip(tag); }   // features (field 2)
		else if (tag === 26) { keyPos.push(pbf.pos); pbf.skip(tag); }    // keys (field 3)
		else if (tag === 34) { valPos.push(pbf.pos); pbf.skip(tag); }    // values (field 4)
		else if (tag === 40) extent = pbf.readVarint();             // extent (field 5)
		else pbf.skip(tag);
	}
	if (!featPos.length || (need && !need.has(name))) return;
	const keys = new Array(keyPos.length), values = new Array(valPos.length);
	for (let i = 0; i < keyPos.length; i++) { pbf.pos = keyPos[i]; keys[i] = pbf.readString(); }
	for (let i = 0; i < valPos.length; i++) { pbf.pos = valPos[i]; values[i] = readValue(pbf); }
	const features = new Array(featPos.length);
	for (let i = 0; i < featPos.length; i++) { pbf.pos = featPos[i]; features[i] = readFeature(pbf, keys, values); }
	pbf.pos = end;
	out[name] = { extent, features };
}

// layer.values の1要素（oneof: string/float/double/int/uint/sint/bool）
function readValue(pbf) {
	const end = pbf.readVarint() + pbf.pos;
	let v = null;
	while (pbf.pos < end) {
		const tag = pbf.readVarint();
		v = tag === 10 ? pbf.readString()
			: tag === 21 ? pbf.readFloat()
			: tag === 25 ? pbf.readDouble()
			: tag === 32 ? pbf.readVarint64()
			: tag === 40 ? pbf.readVarint()
			: tag === 48 ? pbf.readSVarint()
			: tag === 56 ? pbf.readBoolean()
			: (pbf.skip(tag), null);
	}
	return v;
}

function readFeature(pbf, keys, values) {
	const end = pbf.readVarint() + pbf.pos;
	const props = Object.create(null);
	let id, type = 0, geom = null;
	while (pbf.pos < end) {
		const tag = pbf.readVarint();
		if (tag === 8) id = pbf.readVarint();                        // id
		else if (tag === 18) {                                        // tags＝(keyIdx,valIdx) のペア列
			const tEnd = pbf.readVarint() + pbf.pos;
			while (pbf.pos < tEnd) props[keys[pbf.readVarint()]] = values[pbf.readVarint()];
		} else if (tag === 24) type = pbf.readVarint();              // geometry type
		else if (tag === 34) geom = readGeometry(pbf);               // geometry commands
		else pbf.skip(tag);
	}
	return { type: GEOM_TYPE[type], props, geom, id };
}

// geometry commands → フラット coords + ends。共有スクラッチに展開し feature 毎に1回の slice で確定。
let scratch = new Int32Array(1 << 12);
function grow(min) { const b = new Int32Array(Math.max(scratch.length * 2, min)); b.set(scratch); scratch = b; }
function readGeometry(pbf) {
	const end = pbf.readVarint() + pbf.pos;
	const ends = [];
	let n = 0, lineStart = -1;   // lineStart＝現在の線/リング先頭の coords 添字（-1=未開始）
	let cmd = 1, length = 0, x = 0, y = 0;
	while (pbf.pos < end) {
		if (length <= 0) {
			const cmdLen = pbf.readVarint();
			cmd = cmdLen & 7; length = cmdLen >> 3;
			if (length === 0) continue;
		}
		length--;
		if (cmd === 1) {          // MoveTo＝新しい線/リング開始
			x += pbf.readSVarint(); y += pbf.readSVarint();
			if (lineStart >= 0) ends.push(n);
			lineStart = n;
			if (n + 2 > scratch.length) grow(n + 2);
			scratch[n++] = x; scratch[n++] = y;
		} else if (cmd === 2) {   // LineTo
			x += pbf.readSVarint(); y += pbf.readSVarint();
			if (lineStart >= 0) {
				if (n + 2 > scratch.length) grow(n + 2);
				scratch[n++] = x; scratch[n++] = y;
			}
		} else if (cmd === 7) {   // ClosePath＝先頭点を複製（loadGeometry 互換）
			if (lineStart >= 0) {
				if (n + 2 > scratch.length) grow(n + 2);
				scratch[n] = scratch[lineStart]; scratch[n + 1] = scratch[lineStart + 1]; n += 2;
			}
		} else throw new Error(`unknown command ${cmd}`);
	}
	if (lineStart >= 0) ends.push(n);
	return { coords: scratch.slice(0, n), ends };
}

// フラット geom のリング群を [flatCoords, holeIndices] のポリゴン単位に分割（build/buildings 共用）。
// 外周リング(正の面積)が新しいポリゴンを開始し、続く負の面積リングは穴。
// ポリゴンを成すリングは coords 内で連続＝subarray のゼロコピー（earcut は穴を頂点添字 holes で受ける）。
export function polygons(geom) {
	const { coords, ends } = geom;
	const out = [];
	let ps = -1, holes = null, prev = 0;
	for (let r = 0; r < ends.length; r++) {
		const s = prev, e = ends[r]; prev = e;
		if (signedArea(coords, s, e) >= 0 || ps < 0) {   // 外周（または最初）
			if (ps >= 0) out.push([coords.subarray(ps, s), holes]);
			ps = s; holes = [];
		} else holes.push((s - ps) >> 1);                 // 穴＝ポリゴン先頭からの頂点添字
	}
	if (ps >= 0) out.push([coords.subarray(ps, prev), holes]);
	return out;
}

export function signedArea(c, s, e) {
	let sum = 0;
	for (let i = s; i < e; i += 2) {
		const j = i + 2 < e ? i + 2 : s;
		sum += c[i] * c[j + 1] - c[j] * c[i + 1];
	}
	return sum / 2;
}

export async function fetchMVT(url, signal, need) {
	const r = await fetch(url, { signal });
	// 404/204＝「そこにタイルが無い」という正当なデータ（optimal_bvmap は日本域のみ＝広域ビューでは
	// 国外・外洋のタイルが常に404）。エラーでなく空タイルとして ready 扱い＝リトライも失敗計上もしない。
	// __empty＝図郭外の印（build 側が「標高ゲート付き全面水域」を敷く判定に使う。source-layer 名とは衝突しない）
	if (r.status === 404 || r.status === 204) return { __empty: true };
	if (!r.ok) throw new Error(`MVT HTTP ${r.status} ${url}`);
	return decodeMVT(new Uint8Array(await r.arrayBuffer()), need);
}
