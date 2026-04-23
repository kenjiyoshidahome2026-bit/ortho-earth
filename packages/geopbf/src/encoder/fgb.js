import { GeoPBF } from "../pbf-base.js";

// FlatGeobuf 識別用マジックバイト [V3]
const MAGIC = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);
const GeometryType = { Unknown: 0, Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6 };
const ColumnType = {
	Bool: 0,     // 修正：スペックでは 0 です
	Int: 5,      // OK
	Double: 10,  // OK
	String: 11,  // OK
	Json: 12,    // 補強：geopbf のリッチな属性を活かすならこれ！
	DateTime: 14 // 補強：GPX の time タグを活かすならこれ！
};
self.onmessage = async (e) => {
	const { buf, name, gz } = e.data;
	try {
		// 解析済みの GeoPBF インスタンスを再現
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const bPromise = new Response(out).blob();

		(async () => {
			// 1. マジックバイトの書き込み
			await writer.write(MAGIC);

			// 2. Header の書き出し
			// Topology解析済みなので、pbf.bbox や pbf.length が正確に取得できる
			const header = buildFGBHeader(pbf);
			await writer.write(header);

			// 3. Features の書き出し (ストリーミング)
			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				// 浄化済みの座標データを FGB Feature バイナリへ変換
				const featureBin = encodeFGBFeature(f, pbf._precision);
				await writer.write(featureBin);
			}

			await writer.close();
		})();

		const b = await bPromise;
		self.postMessage(new File([b], `${name}.fgb${gz ? ".gz" : ""}`, {
			type: gz ? "application/gzip" : "application/octet-stream"
		}));
	} catch (err) {
		self.postMessage(null);
	}
};

function buildFGBHeader(pbf) {
	const keys = pbf._head; // プロパティのキー配列
	const bbox = pbf.bbox; // [minX, minY, maxX, maxY]

	// 簡略化したFlatBuffer構築ロジック
	// 本来はFlatBufferの公式ライブラリを使うが、構造が固定的なので手動で組める
	const builder = new FlatBufferBuilder();

	// Columnsの定義
	const columnOffsets = keys.map(key => {
		const nameOff = builder.createString(key);
		builder.startObject(2);
		builder.addFieldOffset(0, nameOff);
		builder.addFieldInt8(1, ColumnType.String); // 全てStringとして扱う例
		return builder.endObject();
	});
	const columnsOff = builder.createVector(columnOffsets);

	// Headerの構築
	builder.startObject(11);
	builder.addFieldStruct(2, bbox); // Envelope
	builder.addFieldInt8(3, GeometryType.Unknown); // 混合型を許容
	builder.addFieldNumber(8, pbf.length); // features_count
	builder.addFieldOffset(7, columnsOff);
	builder.addFieldInt16(9, 0); // index_node_size (0 = インデックスなし)

	const headerOff = builder.endObject();
	builder.finish(headerOff);

	return builder.asUint8Array();
}
function encodeFGBFeature(f, keys) {
	const builder = new FlatBufferBuilder();

	// 1. プロパティのエンコード
	const propBytes = [];
	keys.forEach((key, index) => {
		const val = f.properties[key];
		if (val !== undefined && val !== null) {
			// [ushort keyIndex] + [string value] の形式
			const buf = new TextEncoder().encode(String(val));
			const view = new DataView(new ArrayBuffer(2 + 4 + buf.byteLength));
			view.setUint16(0, index, true);
			view.setUint32(2, buf.byteLength, true);
			propBytes.push(new Uint8Array(view.buffer));
			propBytes.push(buf);
		}
	});
	const propsOff = builder.createByteVector(concatUint8(propBytes));

	// 2. ジオメトリのエンコード
	const coords = flattenCoordinates(f.geometry);
	const coordsOff = builder.createDoubleVector(coords);

	// Geometryオブジェクト
	builder.startObject(4);
	builder.addFieldOffset(0, coordsOff);
	if (f.geometry.type === "Polygon") {
		const ends = [f.geometry.coordinates[0].length * 2]; // 簡易的なリング終端処理
		builder.addFieldOffset(1, builder.createUIntVector(ends));
	}
	const geomOff = builder.endObject();

	// Featureオブジェクト
	builder.startObject(3);
	builder.addFieldOffset(0, geomOff);
	builder.addFieldOffset(1, propsOff);

	const featureOff = builder.endObject();
	builder.finish(featureOff);

	return builder.asUint8ArrayWithLengthPrefix(); // 先頭4バイトにサイズを付与
}

function flattenCoordinates(geometry) {
	const pts = [];
	const walk = coords => {
		if (typeof coords[0] === 'number') pts.push(...coords);
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

// 簡易版 FlatBuffer ビルダー（スペックに準拠したバイナリ生成用）
class FlatBufferBuilder {
	// ...ここにバイナリ構築ロジックが必要...
}