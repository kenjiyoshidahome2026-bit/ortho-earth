import { GeoPBF } from "../pbf-base.js"; //

// FlatGeobuf 識別用マジックバイト [V3]
const MAGIC = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]); //
const GeometryType = { Unknown: 0, Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6 }; //
const ColumnType = { Bool: 0, Int: 5, Double: 10, String: 11, Json: 12, DateTime: 14 }; //

// --- 🔥 自前実装版 FlatBuffer ビルダー ---
class FlatBufferBuilder {
	constructor(initialSize = 1024) {
		this.buf = new ArrayBuffer(initialSize);
		this.view = new DataView(this.buf);
		this.u8 = new Uint8Array(this.buf);
		this.offset = initialSize; // 後ろから詰めるので、初期ポインタは末尾
		this.vtable = [];
	}

	// 必要に応じてバッファを拡張（左側＝手前方向に拡張）
	_grow() {
		const oldSize = this.buf.byteLength;
		const newSize = oldSize * 2;
		const newBuf = new ArrayBuffer(newSize);
		const newU8 = new Uint8Array(newBuf);
		// 古いデータを新しいバッファの「右側（末尾）」にコピー
		newU8.set(this.u8, newSize - oldSize);

		this.offset = newSize - (oldSize - this.offset);
		this.buf = newBuf;
		this.view = new DataView(this.buf);
		this.u8 = newU8;
	}

	// 現在の書き込み位置から指定バイト数分、手前に戻る
	_prepare(size, align) {
		if (size > this.offset) this._grow();
		// アライメントの調整
		let offset = this.offset - size;
		const mask = align - 1;
		offset -= (offset & mask);
		this.offset = offset;
		if (this.offset < 0) { this._grow(); return this._prepare(size, align); }
		return this.offset;
	}

	// 各種プリミティブデータの書き込み（後ろから前へ）
	addInt8(val) { this._prepare(1, 1); this.view.setInt8(this.offset, val); }
	addInt32(val) { this._prepare(4, 4); this.view.setInt32(this.offset, val, true); }
	addFloat64(val) { this._prepare(8, 8); this.view.setFloat64(this.offset, val, true); }

	// UOffset（相対ポインタ）の書き込み
	addOffset(offset) {
		this.addInt32(0); // 領域確保
		const relOffset = this.offset - offset + 4;
		this.view.setInt32(this.offset, relOffset, true);
	}

	// 文字列のエンコード（FlatBuffersのString構造: [長さ4byte] + [文字列データ] + [終端の\0]）
	createString(str) {
		if (!str) return 0;
		const utf8 = new TextEncoder().encode(str);
		this._prepare(utf8.length + 1, 1); // 終端の \0 分を確保
		this.u8.set(utf8, this.offset);
		this.u8[this.offset + utf8.length] = 0;
		this.addInt32(utf8.length);
		return this.offset;
	}

	// ベクター（配列）の生成
	createVector(offsets, step = 4) {
		const len = offsets.length;
		this._prepare(len * step, 4);
		for (let i = len - 1; i >= 0; i--) {
			if (step === 4) {
				const relOffset = this.offset - offsets[i] + 4;
				this.view.setInt32(this.offset + i * 4, relOffset, true);
			}
		}
		this.addInt32(len);
		return this.offset;
	}

	createDoubleVector(arr) {
		this._prepare(arr.length * 8, 8);
		for (let i = arr.length - 1; i >= 0; i--) {
			this.view.setFloat64(this.offset + i * 8, arr[i], true);
		}
		this.addInt32(arr.length);
		return this.offset;
	}

	createUIntVector(arr) {
		this._prepare(arr.length * 4, 4);
		for (let i = arr.length - 1; i >= 0; i--) {
			this.view.setUint32(this.offset + i * 4, arr[i], true);
		}
		this.addInt32(arr.length);
		return this.offset;
	}

	createByteVector(uint8) {
		this._prepare(uint8.length, 1);
		this.u8.set(uint8, this.offset);
		this.addInt32(uint8.length);
		return this.offset;
	}

	// オブジェクトの構築開始・フィールド登録
	startObject(numFields) {
		this.vtable = new Array(numFields).fill(0);
		this.objectStart = this.offset;
	}

	slot(fieldIdx, offset) {
		if (offset) this.vtable[fieldIdx] = this.objectStart - offset;
	}

	slotInt8(fieldIdx, val) { this.addInt8(val); this.vtable[fieldIdx] = this.objectStart - this.offset; }
	slotInt32(fieldIdx, val) { this.addInt32(val); this.vtable[fieldIdx] = this.objectStart - this.offset; }

	endObject() {
		// vtable（バーチャルテーブル）の書き出し
		// FlatBuffersはオブジェクトの手前に「どのフィールドがどこにあるか」の目次（vtable）を置きます
		const vtableSize = 4 + this.vtable.length * 2;
		this._prepare(vtableSize, 2);

		const objectSize = this.objectStart - this.offset + vtableSize;
		this.view.setUint16(this.offset, vtableSize, true);
		this.view.setUint16(this.offset + 2, objectSize, true);

		for (let i = 0; i < this.vtable.length; i++) {
			this.view.setUint16(this.offset + 4 + i * 2, this.vtable[i], true);
		}

		// オブジェクトの先頭に、この vtable へのマイナスオフセットを書き込む
		const vtableRelOffset = this.offset - this.objectStart;
		this.view.setInt32(this.objectStart, vtableRelOffset, true);

		return this.objectStart;
	}

	finish(rootOffset) {
		this.addOffset(rootOffset);
	}

	asUint8Array() {
		return this.u8.subarray(this.offset);
	}

	asUint8ArrayWithLengthPrefix() {
		const size = this.u8.length - this.offset;
		this._prepare(4, 4);
		this.view.setUint32(this.offset, size, true);
		return this.u8.subarray(this.offset);
	}
}

// --- 🔥 主要ロジックの肉付け ---

function buildFGBHeader(pbf) {
	const keys = pbf._head; //
	const bbox = pbf.bbox; //
	const builder = new FlatBufferBuilder();

	// 1. Columns（属性の定義）を後ろから順にビルド
	const columnOffsets = [];
	for (let i = keys.length - 1; i >= 0; i--) {
		const nameOff = builder.createString(keys[i]);
		builder.startObject(3);
		builder.slot(0, nameOff);                  // name
		builder.slotInt8(1, ColumnType.String);    // type (一旦すべてString)
		columnOffsets.unshift(builder.endObject());
	}
	const columnsOff = builder.createVector(columnOffsets);

	// 2. Header オブジェクトの構築
	builder.startObject(11);

	// Envelope (BBOX struct: [minX, minY, maxX, maxY])
	if (bbox) {
		builder._prepare(32, 8);
		builder.view.setFloat64(builder.offset, bbox[0], true);
		builder.view.setFloat64(builder.offset + 8, bbox[1], true);
		builder.view.setFloat64(builder.offset + 16, bbox[2], true);
		builder.view.setFloat64(builder.offset + 24, bbox[3], true);
		builder.slot(2, builder.offset);
	}

	builder.slotInt8(3, GeometryType.Unknown); // geometry_type (混合データ対応)
	builder.slot(7, columnsOff);               // columns
	builder.slotInt32(8, pbf.length);          // features_count
	builder.slotInt16(9, 0);                   // index_node_size (0 = インデックスなし)

	const headerOff = builder.endObject();
	builder.finish(headerOff);

	return builder.asUint8ArrayWithLengthPrefix(); // 先頭4バイトにサイズプレフィックスを乗せる
}

function encodeFGBFeature(f, keys, precision) {
	const builder = new FlatBufferBuilder();

	// 1. properties バイナリの構築（FGB独自のカスタムKeyValueストリーム）
	const propBytes = [];
	const encoder = new TextEncoder();
	keys.forEach((key, index) => {
		const val = f.properties[key]; //
		if (val !== undefined && val !== null) {
			const buf = encoder.encode(String(val));
			const header = new Uint8Array(6);
			const view = new DataView(header.buffer);
			view.setUint16(0, index, true);       // カラムのインデックス番号
			view.setUint32(2, buf.byteLength, true); // 値のバイト長
			propBytes.push(header, buf);
		}
	});
	const propsVectorOff = builder.createByteVector(concatUint8(propBytes));

	// 2. Geometry の構築
	const coords = flattenCoordinates(f.geometry); //
	const coordsOff = builder.createDoubleVector(coords);

	// Geometry オブジェクト
	builder.startObject(5);
	builder.slot(0, coordsOff); // xy
	if (f.geometry.type === "Polygon") {
		const ends = [f.geometry.coordinates[0].length];
		const endsOff = builder.createUIntVector(ends);
		builder.slot(1, endsOff); // ends
	}
	builder.slotInt8(4, GeometryType[f.geometry.type] || 0); // type
	const geomOff = builder.endObject();

	// 3. Feature オブジェクトの構築
	builder.startObject(3);
	builder.slot(0, geomOff);        // geometry
	builder.slot(1, propsVectorOff); // properties

	const featureOff = builder.endObject();
	builder.finish(featureOff);

	return builder.asUint8ArrayWithLengthPrefix(); // 各Featureの先頭4バイトにサイズを載せてストリーミング可能に
}

// --- ⚙️ ヘルパー関数 ---

function flattenCoordinates(geometry) {
	const pts = [];
	const walk = coords => {
		if (typeof coords[0] === 'number') pts.push(coords[0], coords[1]);
		else coords.forEach(walk);
	};
	walk(geometry.coordinates);
	return new Float64Array(pts);
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
			const keys = pbf._head;
			for (let i = 0, len = pbf.length; i < len; i++) { //
				const f = pbf.getFeature(i); //
				const featureBin = encodeFGBFeature(f, keys, pbf._precision);
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