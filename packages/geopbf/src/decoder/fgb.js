// src/decoder/fgb.js

import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";

const GeometryTypes = ["Unknown", "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"];

// --- 🌲 Packed Hilbert R-Tree インデックスのバイトサイズ計算 ---
// 公式実装 (src/ts/packedrtree.ts) の calcTreeSize と同一ロジック
// 1ノード = 4×float64(bbox) + 1×uint64(offset) = 40バイト
const NODE_ITEM_BYTE_LEN = 40;

function calcTreeSize(numItems, nodeSize) {
	// nodeSize は uint16 の範囲にクランプ（仕様準拠）
	nodeSize = Math.min(Math.max(nodeSize, 2), 65535);
	let n = numItems;
	let numNodes = n;
	do {
		n = Math.ceil(n / nodeSize);
		numNodes += n;
	} while (n !== 1);
	return numNodes * NODE_ITEM_BYTE_LEN;
}

// --- 🕵️‍♂️ FlatBuffers 読み込みヘルパー ---
class FlatBufferReader {
	constructor(arrayBuffer, baseOffset = 0) {
		this.buf = arrayBuffer;
		this.view = new DataView(arrayBuffer);
		this.u8 = new Uint8Array(arrayBuffer);
		this.base = baseOffset;
	}

	_offset(pos, fieldIdx) {
		const vtableOffset = pos + this.view.getInt32(pos, true);
		const vtableSize = this.view.getUint16(vtableOffset, true);
		const fieldOffsetInVtable = 4 + fieldIdx * 2;
		if (fieldOffsetInVtable >= vtableSize) return 0;
		const offsetInObject = this.view.getUint16(vtableOffset + fieldOffsetInVtable, true);
		return offsetInObject ? pos + offsetInObject : 0;
	}

	readInt8(pos) { return this.view.getInt8(pos); }
	readUint16(pos) { return this.view.getUint16(pos, true); }  // ← 追加
	readInt32(pos) { return this.view.getInt32(pos, true); }
	readUint32(pos) { return this.view.getUint32(pos, true); }  // ← 追加
	readFloat64(pos) { return this.view.getFloat64(pos, true); }
	readUint64(pos) {
		const lo = this.view.getUint32(pos, true);
		const hi = this.view.getUint32(pos + 4, true);
		return hi * 0x100000000 + lo;
	}
	readString(pos) {
		if (!pos) return "";
		const strOffset = pos + this.view.getInt32(pos, true);
		const len = this.view.getInt32(strOffset, true);
		return new TextDecoder().decode(this.u8.subarray(strOffset + 4, strOffset + 4 + len));
	}

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

// --- ⚙️ プロパティ・ジオメトリ復元関数（変更なし）---

function parseFGBProperties(u8, keys) {
	const props = {};
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const decoder = new TextDecoder();
	let pos = 0;
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
	const typeIdx = reader.readInt8(reader._offset(geomPos, 4));
	const geomType = GeometryTypes[typeIdx] || "Unknown";
	const xy = reader.readFloat64Vector(reader._offset(geomPos, 0));
	const ends = reader.readUint32Vector(reader._offset(geomPos, 1));

	if (!xy) return null;

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

	return { type: "Unknown", coordinates: [] };
}

// --- 🌐 Worker メインループ ---
onmessage = async (e) => {
	const { file, precision } = e.data;
	try {
		const arrayBuffer = await file.arrayBuffer();
		const u8 = new Uint8Array(arrayBuffer);
		const view = new DataView(arrayBuffer);

		// 1. マジックバイトの検証
		if (u8[0] !== 0x66 || u8[1] !== 0x67 || u8[2] !== 0x62 || u8[3] !== 0x03) {
			throw new Error("Not a valid FlatGeobuf v3 file.");
		}

		let pos = 8; // マジックバイト(8B)の直後

		// 2. Header のパース
		const headerSize = view.getUint32(pos, true);
		const headerRoot = pos + 4;
		const reader = new FlatBufferReader(arrayBuffer);

		// カラム（属性名）の抽出
		const columnsPos = reader._offset(headerRoot, 7);
		const keys = [];
		if (columnsPos) {
			const vecOffset = columnsPos + view.getInt32(columnsPos, true);
			const vecLen = view.getInt32(vecOffset, true);
			let colTablePos = vecOffset + 4;
			for (let i = 0; i < vecLen; i++) {
				const colRoot = colTablePos + i * 4;
				const namePos = reader._offset(colRoot, 0);
				keys.push(reader.readString(namePos));
			}
		}

		// Header から featuresCount と indexNodeSize を取得
		const featuresCountPos = reader._offset(headerRoot, 8); // features_count フィールド
		const indexNodeSizePos = reader._offset(headerRoot, 9); // index_node_size フィールド

		const featuresCount = featuresCountPos ? reader.readUint64(featuresCountPos) : 0;
		const indexNodeSize = indexNodeSizePos ? reader.readUint16(indexNodeSizePos) : 0;

		// 3. Feature セクション先頭位置の決定
		pos += 4 + headerSize; // ヘッダー末尾まで進む

		// 🌟 インデックスが存在する場合はバイトサイズ分をスキップ
		if (indexNodeSize > 0 && featuresCount > 0) {
			const indexByteSize = calcTreeSize(featuresCount, indexNodeSize);
			pos += indexByteSize;
		}

		// 4. GeoPBF インスタンスの用意
		const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 });
		pbf.setHead(keys.sort());

		// 5. Features の連続デコード
		pbf.setBody(() => {
			while (pos < arrayBuffer.byteLength) {
				const featureSize = view.getUint32(pos, true);
				if (featureSize === 0) break; // 終端ガード

				const featRoot = pos + 4;
				const geomPos = reader._offset(featRoot, 0);
				const propsPos = reader._offset(featRoot, 1);

				const geometry = geomPos ? restoreGeometry(reader, geomPos) : null;
				const propBytes = propsPos ? reader.readByteVector(propsPos) : null;
				const properties = propBytes ? parseFGBProperties(propBytes, keys) : {};

				if (geometry) {
					pbf.setFeature({ type: "Feature", geometry, properties });
				}

				pos += 4 + featureSize;
			}
		});

		pbf.close();
		await dissolve(pbf);
		const res = pbf.arrayBuffer;
		postMessage({ type: "fgbdec", data: res }, [res]);
	} catch (err) {
		console.error("FlatGeobuf decode Worker Error:", err);
		postMessage(null);
	}
};
