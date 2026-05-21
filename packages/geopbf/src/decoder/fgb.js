import { GeoPBF } from "../pbf-base.js"; //

// FlatGeobuf 幾何型定義の逆写像
const GeometryTypes = ["Unknown", "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"];

// --- 🕵️‍♂️ FlatBuffers 読み込みヘルパー ---
class FlatBufferReader {
	constructor(arrayBuffer, baseOffset = 0) {
		this.buf = arrayBuffer;
		this.view = new DataView(arrayBuffer);
		this.u8 = new Uint8Array(arrayBuffer);
		this.base = baseOffset;
	}

	// 相対ポインタ（UOffset）の解決
	_offset(pos, fieldIdx) {
		// オブジェクトの先頭4バイトが指す位置にある vtable（目次）を特定
		const vtableOffset = pos + this.view.getInt32(pos, true);
		const vtableSize = this.view.getUint16(vtableOffset, true);
		const fieldOffsetInVtable = 4 + fieldIdx * 2;

		if (fieldOffsetInVtable >= vtableSize) return 0; // フィールドが存在しない
		const offsetInObject = this.view.getUint16(vtableOffset + fieldOffsetInVtable, true);
		return offsetInObject ? pos + offsetInObject : 0;
	}

	// プリミティブ型の読み出し
	readInt8(pos) { return this.view.getInt8(pos); }
	readInt32(pos) { return this.view.getInt32(pos, true); }
	readFloat64(pos) { return this.view.getFloat64(pos, true); }

	// 文字列のデコード
	readString(pos) {
		if (!pos) return "";
		const strOffset = pos + this.view.getInt32(pos, true);
		const len = this.view.getInt32(strOffset, true);
		return new TextDecoder().decode(this.u8.subarray(strOffset + 4, strOffset + 4 + len));
	}

	// 各種ベクター（配列）の展開ビュー
	readFloat64Vector(pos) {
		if (!pos) return null;
		const vecOffset = pos + this.view.getInt32(pos, true);
		const len = this.view.getInt32(vecOffset, true);
		return new Float64Array(this.buf, vecOffset + 4, len);
	}

	readUint32Vector(pos) {
		if (!pos) return null;
		const vecOffset = pos + this.view.getInt32(pos, true);
		const len = this.view.getInt32(vecOffset, true);
		return new Uint32Array(this.buf, vecOffset + 4, len);
	}

	readByteVector(pos) {
		if (!pos) return null;
		const vecOffset = pos + this.view.getInt32(pos, true);
		const len = this.view.getInt32(vecOffset, true);
		return this.u8.subarray(vecOffset + 4, vecOffset + 4 + len);
	}
}

// --- ⚙️ FGB用のカスタムプロパティ・ジオメトリ復元関数 ---

function parseFGBProperties(u8, keys) {
	const props = {};
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const decoder = new TextDecoder();
	let pos = 0;

	// [ushort keyIndex] + [uint length] + [string value] のカスタムKeyValueストリームを解体
	while (pos < u8.byteLength) {
		const keyIdx = view.getUint16(pos, true);
		const len = view.getUint32(pos + 2, true);
		const valStr = decoder.decode(u8.subarray(pos + 6, pos + 6 + len));
		props[keys[keyIdx]] = valStr;
		pos += 6 + len;
	}
	return props;
}

function restoreGeometry(reader, geomPos) {
	const typeIdx = reader.readInt8(reader._offset(geomPos, 4)); // type
	const geomType = GeometryTypes[typeIdx] || "Unknown";
	const xy = reader.readFloat64Vector(reader._offset(geomPos, 0)); // xy
	const ends = reader.readUint32Vector(reader._offset(geomPos, 1)); // ends

	if (!xy) return null;

	// フラットな Float64Array [X1, Y1, X2, Y2...] から多次元配列（GeoJSON形式）を再構成
	if (geomType === "Point") {
		return { type: "Point", coordinates: [xy[0], xy[1]] };
	} else if (geomType === "LineString") {
		const coords = [];
		for (let i = 0; i < xy.length; i += 2) coords.push([xy[i], xy[i + 1]]);
		return { type: "LineString", coordinates: coords };
	} else if (geomType === "Polygon") {
		const coords = [];
		let ringStart = 0;
		const endLoop = ends ? ends : [xy.length / 2];

		endLoop.forEach(endIdx => {
			const ring = [];
			for (let i = ringStart * 2; i < endIdx * 2; i += 2) {
				ring.push([xy[i], xy[i + 1]]);
			}
			coords.push(ring);
			ringStart = endIdx;
		});
		return { type: "Polygon", coordinates: coords };
	}

	// ※ 混合型や複雑な幾何型は、要件に応じて拡張可能
	return { type: "Unknown", coordinates: [] };
}

// --- 🌐 Worker メインループ ---
onmessage = async (e) => {
	const { file, precision } = e.data; //
	try {
		const arrayBuffer = await file.arrayBuffer();
		const u8 = new Uint8Array(arrayBuffer);
		const view = new DataView(arrayBuffer);

		// 1. マジックバイトの検証（"fgb\x03fgb\x00"）
		if (u8[0] !== 0x66 || u8[1] !== 0x67 || u8[2] !== 0x62 || u8[3] !== 0x03) {
			throw new Error("Not a valid FlatGeobuf v3 file.");
		}

		let pos = 8; // マジックバイト(8B)の直後から開始

		// 2. Header のパース
		const headerSize = view.getUint32(pos, true);
		const headerRoot = pos + 4;
		const reader = new FlatBufferReader(arrayBuffer);

		// カラム（属性名）の抽出
		const columnsPos = reader._offset(headerRoot, 7); // columns
		const keys = [];
		if (columnsPos) {
			const vecOffset = columnsPos + view.getInt32(columnsPos, true);
			const vecLen = view.getInt32(vecOffset, true);
			let colTablePos = vecOffset + 4;
			for (let i = 0; i < vecLen; i++) {
				const colRoot = colTablePos + i * 4;
				const namePos = reader._offset(colRoot, 0); // name
				keys.push(reader.readString(namePos));
			}
		}

		// 3. GeoPBF インスタンスの用意とヘッダー定義
		const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 }); //
		pbf.setHead(keys.sort()); //

		// 空間インデックス（仮にあれば）のサイズをスキップして Feature セクションの戦闘へ移動
		pos += 4 + headerSize;
		const indexNodeSize = reader.view.getUint16(reader._offset(headerRoot, 9), true);
		if (indexNodeSize > 0) {
			// インデックス付きファイル（サーバー型用）の場合は、Tree部分のバイトサイズをスキップする計算が入ります
			// 今回はインデックスなし（純粋なローカルデータ）を想定し、posはそのままFeatureの先頭へ
		}

		// 4. Features の連続デコード & GeoPBF への流し込み
		pbf.setBody(() => { //
			while (pos < arrayBuffer.byteLength) {
				const featureSize = view.getUint32(pos, true);
				const featRoot = pos + 4;

				const geomPos = reader._offset(featRoot, 0);  // geometry
				const propsPos = reader._offset(featRoot, 1); // properties

				// ジオメトリとプロパティを復元
				const geometry = geomPos ? restoreGeometry(reader, geomPos) : null;
				const propBytes = propsPos ? reader.readByteVector(propsPos) : null;
				const properties = propBytes ? parseFGBProperties(propBytes, keys) : {};

				if (geometry) {
					pbf.setFeature({ type: "Feature", geometry, properties }); //
				}

				pos += 4 + featureSize; // 次の Feature の先頭へジャンプ
			}
		});

		pbf.close(); //
		const res = pbf.arrayBuffer; //
		postMessage({ type: "fgbdec", data: res }, [res]);
	} catch (err) {
		console.error("FlatGeobuf decode Worker Error:", err);
		postMessage(null);
	}
};