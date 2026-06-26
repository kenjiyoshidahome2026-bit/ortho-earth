import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";

// Conforms to the official FlatGeobuf GeometryType enum (must match encoder).
const GeometryTypes = ["Unknown", "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"];

// Packed Hilbert R-Tree index byte-size calculation.
// Same logic as calcTreeSize in the official implementation (src/ts/packedrtree.ts).
// 1 node = 4×float64 (bbox) + 1×uint64 (offset) = 40 bytes.
const NODE_ITEM_BYTE_LEN = 40;

function calcTreeSize(numItems, nodeSize) {
	// nodeSize is clamped to uint16 range per spec.
	nodeSize = Math.min(Math.max(nodeSize, 2), 65535);
	let n = numItems;
	let numNodes = n;
	do {
		n = Math.ceil(n / nodeSize);
		numNodes += n;
	} while (n !== 1);
	return numNodes * NODE_ITEM_BYTE_LEN;
}

// FlatBuffers reader helpers (standard wire format, alignment-independent).
class FlatBufferReader {
	constructor(arrayBuffer) {
		this.view = new DataView(arrayBuffer);
		this.u8 = new Uint8Array(arrayBuffer);
		this.len = arrayBuffer.byteLength;
	}

	// Follow a uoffset to reach the actual table/vector/string position.
	indirect(pos) { return pos + this.view.getInt32(pos, true); }

	// Return the data position of field fieldIdx in table at tablePos (0 if absent).
	_offset(tablePos, fieldIdx) {
		const vtable = tablePos - this.view.getInt32(tablePos, true); // standard: subtract soffset
		const vtableSize = this.view.getUint16(vtable, true);
		const vo = 4 + fieldIdx * 2;
		if (vo >= vtableSize) return 0;
		const off = this.view.getUint16(vtable + vo, true);
		return off ? tablePos + off : 0;
	}

	readInt8(pos) { return this.view.getInt8(pos); }
	readUint16(pos) { return this.view.getUint16(pos, true); }
	readUint64(pos) {
		const lo = this.view.getUint32(pos, true);
		const hi = this.view.getUint32(pos + 4, true);
		return hi * 0x100000000 + lo;
	}
	readString(fieldPos) {
		if (!fieldPos) return "";
		const p = this.indirect(fieldPos);
		const len = this.view.getInt32(p, true);
		return new TextDecoder().decode(this.u8.subarray(p + 4, p + 4 + len));
	}

	// Read element-by-element via DataView so alignment is irrelevant.
	readFloat64Vector(fieldPos) {
		if (!fieldPos) return null;
		const p = this.indirect(fieldPos);
		const len = this.view.getInt32(p, true);
		const a = new Float64Array(len);
		for (let i = 0; i < len; i++) a[i] = this.view.getFloat64(p + 4 + i * 8, true);
		return a;
	}
	readUint32Vector(fieldPos) {
		if (!fieldPos) return null;
		const p = this.indirect(fieldPos);
		const len = this.view.getInt32(p, true);
		const a = new Uint32Array(len);
		for (let i = 0; i < len; i++) a[i] = this.view.getUint32(p + 4 + i * 4, true);
		return a;
	}
	readByteVector(fieldPos) {
		if (!fieldPos) return null;
		const p = this.indirect(fieldPos);
		const len = this.view.getInt32(p, true);
		return this.u8.subarray(p + 4, p + 4 + len);
	}
	// uoffset vector: returns the actual (table) positions of each element.
	offsetVector(fieldPos) {
		if (!fieldPos) return [];
		const p = this.indirect(fieldPos);
		const len = this.view.getInt32(p, true);
		const out = [];
		for (let i = 0; i < len; i++) out.push(this.indirect(p + 4 + i * 4));
		return out;
	}
}

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

// Official FlatGeobuf Geometry schema: ends=0, xy=1, type=6, parts=7.
function restoreGeometry(reader, geomPos) {
	const typePos = reader._offset(geomPos, 6);
	const typeIdx = typePos ? reader.readInt8(typePos) : 0;
	const geomType = GeometryTypes[typeIdx] || "Unknown";

	// Composite geometries are reconstructed from parts (a vector of sub-Geometry tables).
	if (geomType === "MultiPolygon" || geomType === "GeometryCollection") {
		const parts = reader.offsetVector(reader._offset(geomPos, 7))
			.map(pos => restoreGeometry(reader, pos)).filter(Boolean);
		return geomType === "MultiPolygon"
			? { type: "MultiPolygon", coordinates: parts.map(p => p.coordinates) }
			: { type: "GeometryCollection", geometries: parts };
	}

	const xy = reader.readFloat64Vector(reader._offset(geomPos, 1));
	const ends = reader.readUint32Vector(reader._offset(geomPos, 0));
	if (!xy) return null;

	const pt = i => [xy[i * 2], xy[i * 2 + 1]];
	const allPoints = () => { const c = []; for (let i = 0; i < xy.length / 2; i++) c.push(pt(i)); return c; };
	const splitByEnds = () => {
		const groups = [];
		let start = 0;
		(ends ? ends : [xy.length / 2]).forEach(end => {
			const g = [];
			for (let i = start; i < end; i++) g.push(pt(i));
			groups.push(g);
			start = end;
		});
		return groups;
	};

	switch (geomType) {
		case "Point": return { type: "Point", coordinates: pt(0) };
		case "MultiPoint": return { type: "MultiPoint", coordinates: allPoints() };
		case "LineString": return { type: "LineString", coordinates: allPoints() };
		case "MultiLineString": return { type: "MultiLineString", coordinates: splitByEnds() };
		case "Polygon": return { type: "Polygon", coordinates: splitByEnds() };
	}
	return { type: "Unknown", coordinates: [] };
}

onmessage = async (e) => {
	const { file, precision } = e.data;
	try {
		const arrayBuffer = await file.arrayBuffer();
		const u8 = new Uint8Array(arrayBuffer);
		const view = new DataView(arrayBuffer);

		if (u8[0] !== 0x66 || u8[1] !== 0x67 || u8[2] !== 0x62 || u8[3] !== 0x03) {
			throw new Error("Not a valid FlatGeobuf v3 file.");
		}

		let pos = 8; // immediately after the 8-byte magic

		const headerSize = view.getUint32(pos, true);
		const reader = new FlatBufferReader(arrayBuffer);
		const headerTable = reader.indirect(pos + 4); // follow root uoffset to table

		const keys = reader.offsetVector(reader._offset(headerTable, 7))
			.map(colTable => reader.readString(reader._offset(colTable, 0)));

		const featuresCountPos = reader._offset(headerTable, 8); // features_count
		const indexNodeSizePos = reader._offset(headerTable, 9); // index_node_size
		const featuresCount = featuresCountPos ? reader.readUint64(featuresCountPos) : 0;
		const indexNodeSize = indexNodeSizePos ? reader.readUint16(indexNodeSizePos) : 0;

		pos += 4 + headerSize;

		if (indexNodeSize > 0 && featuresCount > 0) {
			const indexByteSize = calcTreeSize(featuresCount, indexNodeSize);
			pos += indexByteSize;
		}

		// keys preserves FGB column order; setHead receives a sorted copy.
		const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 });
		pbf.setHead([...keys].sort());

		pbf.setBody(() => {
			while (pos < arrayBuffer.byteLength) {
				const featureSize = view.getUint32(pos, true);
				if (featureSize === 0) break;

				const featTable = reader.indirect(pos + 4); // root uoffset → Feature table
				const geomField = reader._offset(featTable, 0);
				const propsField = reader._offset(featTable, 1);

				const geometry = geomField ? restoreGeometry(reader, reader.indirect(geomField)) : null;
				const propBytes = propsField ? reader.readByteVector(propsField) : null;
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
