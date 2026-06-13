import { GeoPBF } from "../pbf-base.js"; //
import { getBbox } from "../extension/spatial.js";

// FlatGeobuf 識別用マジックバイト [V3]
const MAGIC = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]); //
// 公式 FlatGeobuf GeometryType enum 準拠
const GeometryType = { Unknown: 0, Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 };
const ColumnType = { Bool: 0, Int: 5, Double: 10, String: 11, Json: 12, DateTime: 14 }; //

// --- 🔥 標準 FlatBuffers ワイヤフォーマット準拠ビルダー（後方ビルド） ---
// 公式 flatbuffers.Builder のサブセット移植。すべてのオフセットは offset()=末尾からの距離で扱う。
class FlatBufferBuilder {
	constructor(initialSize = 1024) {
		this.bb_capacity = initialSize;
		this.buf = new ArrayBuffer(initialSize);
		this.view = new DataView(this.buf);
		this.u8 = new Uint8Array(this.buf);
		this.space = initialSize; // 未使用領域（先頭側）。head = space
		this.minalign = 1;
		this.vtable = null;
		this.vtable_in_use = 0;
		this.object_start = 0;
	}

	offset() { return this.bb_capacity - this.space; }

	growByteBuffer() {
		const old = this.bb_capacity;
		const newCap = old << 1;
		const nbuf = new ArrayBuffer(newCap);
		const nu8 = new Uint8Array(nbuf);
		nu8.set(this.u8, newCap - old); // 既存データは末尾側へ
		this.bb_capacity = newCap;
		this.buf = nbuf;
		this.view = new DataView(nbuf);
		this.u8 = nu8;
	}

	pad(n) { for (let i = 0; i < n; i++) this.u8[--this.space] = 0; }

	// size バイトのデータ + additional バイトを書く前に、アライメントと容量を確保
	prep(size, additional) {
		if (size > this.minalign) this.minalign = size;
		const alignSize = ((~(this.bb_capacity - this.space + additional)) + 1) & (size - 1);
		while (this.space < alignSize + size + additional) {
			const oldCap = this.bb_capacity;
			this.growByteBuffer();
			this.space += this.bb_capacity - oldCap;
		}
		this.pad(alignSize);
	}

	writeInt8(v) { this.view.setInt8(this.space -= 1, v); }
	writeInt16(v) { this.view.setInt16(this.space -= 2, v, true); }
	writeInt32(v) { this.view.setInt32(this.space -= 4, v, true); }
	writeUint64(v) {
		this.space -= 8;
		this.view.setUint32(this.space, v >>> 0, true);
		this.view.setUint32(this.space + 4, Math.floor(v / 0x100000000) >>> 0, true);
	}
	writeFloat64(v) { this.view.setFloat64(this.space -= 8, v, true); }

	addInt8(v) { this.prep(1, 0); this.writeInt8(v); }
	addInt16(v) { this.prep(2, 0); this.writeInt16(v); }
	addInt32(v) { this.prep(4, 0); this.writeInt32(v); }
	addUint64(v) { this.prep(8, 0); this.writeUint64(v); }
	addFloat64(v) { this.prep(8, 0); this.writeFloat64(v); }

	// 前方参照 uoffset を書く（to は対象の offset()）
	addOffset(to) { this.prep(4, 0); this.writeInt32(this.offset() - to + 4); }

	// --- ベクター ---
	startVector(elemSize, numElems, alignment) {
		this.prep(4, elemSize * numElems);          // length(4byte) 分
		this.prep(alignment, elemSize * numElems);  // 要素アライメント
		this._vectorNumElems = numElems;
	}
	endVector() { this.writeInt32(this._vectorNumElems); return this.offset(); }

	createDoubleVector(arr) {
		this.startVector(8, arr.length, 8);
		for (let i = arr.length - 1; i >= 0; i--) this.writeFloat64(arr[i]);
		return this.endVector();
	}
	createUIntVector(arr) {
		this.startVector(4, arr.length, 4);
		for (let i = arr.length - 1; i >= 0; i--) { this.space -= 4; this.view.setUint32(this.space, arr[i], true); }
		return this.endVector();
	}
	createByteVector(bytes) {
		this.startVector(1, bytes.length, 1);
		this.space -= bytes.length;
		this.u8.set(bytes, this.space);
		return this.endVector();
	}
	createOffsetVector(offsets) {
		this.startVector(4, offsets.length, 4);
		for (let i = offsets.length - 1; i >= 0; i--) this.addOffset(offsets[i]);
		return this.endVector();
	}
	createString(str) {
		if (str == null) return 0;
		const utf8 = new TextEncoder().encode(str);
		this.addInt8(0); // null 終端
		this.startVector(1, utf8.length, 1);
		this.space -= utf8.length;
		this.u8.set(utf8, this.space);
		return this.endVector();
	}

	// --- テーブル ---
	startObject(numFields) {
		this.vtable = new Array(numFields).fill(0);
		this.vtable_in_use = numFields;
		this.object_start = this.offset();
	}
	slot(voffset) { this.vtable[voffset] = this.offset(); }
	addFieldInt8(voffset, v) { this.addInt8(v); this.slot(voffset); }
	addFieldInt16(voffset, v) { this.addInt16(v); this.slot(voffset); }
	addFieldInt32(voffset, v) { this.addInt32(v); this.slot(voffset); }
	addFieldUint64(voffset, v) { this.addUint64(v); this.slot(voffset); }
	addFieldOffset(voffset, off) { if (off) { this.addOffset(off); this.slot(voffset); } }

	endObject() {
		this.addInt32(0); // vtable への soffset プレースホルダ
		const vtableloc = this.offset(); // = テーブル位置
		let i = this.vtable_in_use - 1;
		for (; i >= 0 && this.vtable[i] === 0; i--) {} // 末尾の空フィールドを切り詰め
		const trimmed = i + 1;
		for (; i >= 0; i--) this.addInt16(this.vtable[i] !== 0 ? vtableloc - this.vtable[i] : 0);
		this.addInt16(vtableloc - this.object_start); // object size
		this.addInt16((trimmed + 2) * 2);             // vtable size
		// soffset を確定（vtable位置 - テーブル位置）
		this.view.setInt32(this.bb_capacity - vtableloc, this.offset() - vtableloc, true);
		return vtableloc;
	}

	// サイズプレフィックス付きで確定。size(4)+root(4) 分を minalign で整列するため、
	// 先頭4バイトのサイズを除いた本体は minalign（doublesがあるので8）境界に揃う＝公式リーダ互換。
	finishSizePrefixed(rootOffset) {
		this.prep(this.minalign, 8); // size(4) + root offset(4)
		this.addOffset(rootOffset);
		this.addInt32(this.offset()); // 先頭サイズ（この int 自身を除く後続バイト数）
	}

	// [size:uint32][整列済みペイロード] のバイト列。ストリーミング書き出し用。
	asUint8Array() { return this.u8.slice(this.space); }
}

// --- 🔥 主要ロジックの肉付け ---

// 公式 FlatGeobuf Header schema: name=0, envelope=1, geometry_type=2, columns=7, features_count=8, index_node_size=9
function buildFGBHeader(pbf) {
	const keys = pbf.keys;
	getBbox(pbf);            // bbox ゲッターは pbf-base 直 import のワーカーには無いので拡張関数で計算
	const bbox = pbf._bbox;
	const builder = new FlatBufferBuilder();

	// 子要素（テーブル参照の対象）はすべて親テーブルの startObject 前に構築する
	const columnOffsets = [];
	for (let i = 0; i < keys.length; i++) {
		const nameOff = builder.createString(keys[i]);
		builder.startObject(2);                    // Column: name=0, type=1
		builder.addFieldOffset(0, nameOff);        // name
		builder.addFieldInt8(1, ColumnType.String);// type (一旦すべてString)
		columnOffsets.push(builder.endObject());
	}
	const columnsOff = builder.createOffsetVector(columnOffsets);

	// Envelope は [double] ベクター（field 1）
	let envelopeOff = 0;
	if (bbox && bbox.every(Number.isFinite)) {
		envelopeOff = builder.createDoubleVector([bbox[0], bbox[1], bbox[2], bbox[3]]);
	}

	builder.startObject(11);                        // fields 0..10
	if (envelopeOff) builder.addFieldOffset(1, envelopeOff); // envelope
	builder.addFieldInt8(2, GeometryType.Unknown);  // geometry_type (混合対応)
	builder.addFieldOffset(7, columnsOff);          // columns
	builder.addFieldUint64(8, pbf.length);          // features_count (ulong = 8byte)
	builder.addFieldInt16(9, 0);                    // index_node_size (0 = インデックスなし)
	const headerOff = builder.endObject();
	builder.finishSizePrefixed(headerOff);

	return builder.asUint8Array();
}

function encodeFGBFeature(f, keys) {
	const builder = new FlatBufferBuilder();

	// 1. properties バイナリ（FGB独自の KeyValue ストリーム: [u16 colIdx][u32 len][bytes]...）
	const propBytes = [];
	const encoder = new TextEncoder();
	keys.forEach((key, index) => {
		const val = f.properties[key]; //
		if (val !== undefined && val !== null) {
			const buf = encoder.encode(String(val));
			const header = new Uint8Array(6);
			const view = new DataView(header.buffer);
			view.setUint16(0, index, true);          // カラムのインデックス番号
			view.setUint32(2, buf.byteLength, true); // 値のバイト長
			propBytes.push(header, buf);
		}
	});
	const propsVectorOff = builder.createByteVector(concatUint8(propBytes));

	// 2. Geometry（子テーブルは feature の startObject 前に確定させる）
	const geomOff = encodeGeometry(builder, f.geometry);

	// 3. Feature: geometry=0, properties=1
	builder.startObject(3);
	builder.addFieldOffset(0, geomOff);        // geometry
	builder.addFieldOffset(1, propsVectorOff); // properties
	const featureOff = builder.endObject();
	builder.finishSizePrefixed(featureOff);

	return builder.asUint8Array();
}

// 公式 FlatGeobuf Geometry schema: ends=0, xy=1, type=6, parts=7
function encodeGeometry(builder, geom) {
	const type = GeometryType[geom.type] || 0;

	// 複合ジオメトリは parts（サブ Geometry のベクター）で表現
	if (geom.type === "MultiPolygon" || geom.type === "GeometryCollection") {
		const subGeoms = geom.type === "MultiPolygon"
			? geom.coordinates.map(poly => ({ type: "Polygon", coordinates: poly }))
			: geom.geometries;
		const partOffsets = subGeoms.map(g => encodeGeometry(builder, g));
		const partsOff = builder.createOffsetVector(partOffsets);
		builder.startObject(8);
		builder.addFieldOffset(7, partsOff); // parts
		builder.addFieldInt8(6, type);       // type
		return builder.endObject();
	}

	// 単純／フラットなジオメトリ: xy（+ 複数リング/ラインのときは ends）
	const { xy, ends } = flattenWithEnds(geom);
	const xyOff = builder.createDoubleVector(xy);
	const endsOff = (ends.length > 1) ? builder.createUIntVector(ends) : 0;

	builder.startObject(8);
	if (endsOff) builder.addFieldOffset(0, endsOff); // ends
	builder.addFieldOffset(1, xyOff);                // xy
	builder.addFieldInt8(6, type);                   // type
	return builder.endObject();
}

// --- ⚙️ ヘルパー関数 ---

// xy をフラットに展開し、Polygon/MultiLineString は各リング/ラインの累積座標数を ends に格納
function flattenWithEnds(geom) {
	const xy = [];
	const ends = [];
	const pushPt = p => { xy.push(p[0], p[1]); };
	const c = geom.coordinates;
	switch (geom.type) {
		case "Point": pushPt(c); break;
		case "MultiPoint":
		case "LineString": c.forEach(pushPt); break;
		case "MultiLineString":
		case "Polygon":
			c.forEach(ring => { ring.forEach(pushPt); ends.push(xy.length / 2); });
			break;
	}
	return { xy, ends };
}

const concatUint8 = arrays => {
	const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
	const res = new Uint8Array(total);
	let off = 0;
	arrays.forEach(a => { res.set(a, off); off += a.byteLength; });
	return res;
};

// --- 🌐 Worker メインループ ---
onmessage = async (e) => {
	const { buf, name, opts } = e.data, gz = opts && opts.gz; //
	try {
		const pbf = await new GeoPBF().name(name).set(buf); //
		const { readable, writable } = new TransformStream(); //
		const writer = writable.getWriter(); //

		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable; //
		const bPromise = new Response(out).blob(); //

		(async () => {
			// 1. マジックバイトの書き込み
			await writer.write(MAGIC); //

			// 2. Header の書き出し
			const header = buildFGBHeader(pbf);
			await writer.write(header);

			// 3. Features の書き出し (ストリーミング)
			const keys = pbf.keys;
			for (let i = 0, len = pbf.length; i < len; i++) { //
				const f = pbf.getFeature(i); //
				const featureBin = encodeFGBFeature(f, keys);
				await writer.write(featureBin);
			}

			await writer.close(); //
		})();

		const b = await bPromise; //
		postMessage(new File([b], `${name}.fgb${gz ? ".gz" : ""}`, { //
			type: gz ? "application/gzip" : "application/octet-stream" //
		})); //
	} catch (err) {
		postMessage(null); //
	}
};
