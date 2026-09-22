// convert/fgb.js ── FlatGeobuf v3（.fgb）→ GeoPBF。読み専用・依存ゼロ（FlatBuffers は自前の最小リーダ）。
// 旧 decoder/fgb.js は geopbf 自身の書き出し（geometry_type=Unknown・全列 String・index_node_size=0）しか読めなかった
// （2026-09-22：公式 test/data/countries.fgb が「Failed to load data.」）。仕様（src/fbs/header.fbs・feature.fbs）どおりに：
//   ① 幾何の型＝地物の Geometry.type、無ければヘッダの geometry_type（単一型のファイルは地物側に型を書かない）。
//      MultiPolygon の parts は型を省くことがある＝Polygon とみなす
//   ② index_node_size の既定は 16（FlatBuffers は既定値を書かない＝欄が無い＝索引あり）。0 の時だけ索引なし
//   ③ 属性は列の型どおりの 2 進（Byte〜Double は固定長・String/Json/DateTime/Binary は uint32 長＋中身）。
//      地物ごとの columns（Feature.columns）があればそちらが列定義
//   ④ CRS：無し／0／EPSG:4326／CRS84＝経緯度。EPSG:3857 と投影系（WKT か既知の EPSG）は経緯度へ戻す。それ以外は ignoreCrs が無い限り投げる
// Z/M/T/TM は落とす（GeoPBF は 2D）。曲線系（CircularString…TIN）と幾何なしの地物は落として数える（stats.droppedGeometries）。
// Long/ULong は安全整数を超えたら文字列（精度を黙って落とさない＝gpkg と同じ）。Json は解釈できれば値に・DateTime は文字列のまま。Binary 列は読まない。
//
//   const { pbf, stats } = await fromFlatGeobuf(u8, { name, precision, ignoreCrs, tky2jgd, patchjgd });
import { mercToLonLat } from "../modules/mercator.js";
import { GeoPBF } from "../pbf-base.js";
import { classifyCrs } from "./gpkg.js";
import { epsgToWKT } from "./epsg.js";
import { resolveDatum, datumStats } from "./datum.js";

const GTYPES = ["Unknown", "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"];
const CTYPES = ["Byte", "UByte", "Bool", "Short", "UShort", "Int", "UInt", "Long", "ULong", "Float", "Double", "String", "Json", "DateTime", "Binary"];
const NODE_ITEM_BYTE_LEN = 40;   // packed Hilbert R-tree の 1 節＝bbox 4×f64 ＋ offset u64
const TD = new TextDecoder();
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// 索引の大きさ（公式 packedrtree の calcTreeSize と同じ）
export function calcTreeSize(numItems, nodeSize) {
	nodeSize = Math.min(Math.max(nodeSize, 2), 65535);
	let n = numItems, numNodes = n;
	do { n = Math.ceil(n / nodeSize); numNodes += n; } while (n !== 1);
	return numNodes * NODE_ITEM_BYTE_LEN;
}

// FlatBuffers の最小リーダ（位置は全部 u8 の絶対位置・整列に依存しない DataView 読み）
class Reader {
	constructor(u8) { this.u8 = u8; this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
	indirect(pos) { return pos + this.view.getUint32(pos, true); }
	field(table, idx) {   // 欄 idx の中身の位置（無ければ 0）
		const vt = table - this.view.getInt32(table, true), vtSize = this.view.getUint16(vt, true), vo = 4 + idx * 2;
		if (vo >= vtSize) return 0;
		const off = this.view.getUint16(vt + vo, true);
		return off ? table + off : 0;
	}
	u8At(table, idx, def = 0) { const p = this.field(table, idx); return p ? this.view.getUint8(p) : def; }
	u16At(table, idx, def = 0) { const p = this.field(table, idx); return p ? this.view.getUint16(p, true) : def; }
	i32At(table, idx, def = 0) { const p = this.field(table, idx); return p ? this.view.getInt32(p, true) : def; }
	u64At(table, idx, def = 0) { const p = this.field(table, idx); return p ? this.view.getUint32(p, true) + this.view.getUint32(p + 4, true) * 0x100000000 : def; }
	str(table, idx) { const p = this.field(table, idx); if (!p) return null; const s = this.indirect(p), n = this.view.getUint32(s, true); return TD.decode(this.u8.subarray(s + 4, s + 4 + n)); }
	vec(table, idx) { const p = this.field(table, idx); if (!p) return null; const s = this.indirect(p); return { pos: s + 4, len: this.view.getUint32(s, true) }; }
	tables(table, idx) { const v = this.vec(table, idx); if (!v) return []; const out = new Array(v.len); for (let i = 0; i < v.len; i++) out[i] = this.indirect(v.pos + i * 4); return out; }
}

const readColumns = (r, tables) => tables.map(t => ({ name: r.str(t, 0) ?? "", type: r.u8At(t, 1, 0) }));

/** ヘッダだけ読む（変換はしない）。 */
export function readFlatGeobufHeader(u8) {
	if (!(u8[0] === 0x66 && u8[1] === 0x67 && u8[2] === 0x62)) throw new Error("fgb: not a FlatGeobuf file (magic 'fgb' missing)");
	if (u8[3] !== 3) throw new Error(`fgb: unsupported FlatGeobuf major version ${u8[3]} (only v3)`);
	const r = new Reader(u8);
	const headerSize = r.view.getUint32(8, true);
	const h = r.indirect(12);
	const crsT = r.field(h, 10) ? r.indirect(r.field(h, 10)) : 0;
	const crs = crsT ? { org: r.str(crsT, 0), code: r.i32At(crsT, 1, 0), name: r.str(crsT, 2), wkt: r.str(crsT, 4), codeString: r.str(crsT, 5) } : null;
	const env = r.vec(h, 1);
	return {
		reader: r,
		name: r.str(h, 0), title: r.str(h, 11), description: r.str(h, 12),
		envelope: env ? Array.from({ length: env.len }, (_, i) => r.view.getFloat64(env.pos + i * 8, true)) : null,
		geometryType: r.u8At(h, 2, 0),
		hasZ: !!r.u8At(h, 3), hasM: !!r.u8At(h, 4), hasT: !!r.u8At(h, 5), hasTM: !!r.u8At(h, 6),
		columns: readColumns(r, r.tables(h, 7)),
		featuresCount: r.u64At(h, 8, 0),
		indexNodeSize: r.u16At(h, 9, 16),   // ②既定 16
		crs,
		featuresOffset: 12 + headerSize,
	};
}

// CRS → 経緯度への変換（null＝そのまま）。kind: lonlat / mercator / projected / datum / other
function crsTransform(crs, datum) {
	if (!crs) return { kind: "lonlat", label: "none (assumed lon/lat)", xf: null };
	const org = (crs.org || "EPSG").toUpperCase(), code = crs.code;
	if (!code && !crs.wkt && /^CRS84$/i.test(crs.codeString ?? "")) return { kind: "lonlat", label: "OGC:CRS84", xf: null };
	if (!code && !crs.wkt) return { kind: "lonlat", label: "unknown (code 0; assumed lon/lat)", xf: null };
	const c = classifyCrs({ org, code, definition: crs.wkt || (org === "EPSG" ? epsgToWKT(code) : "") || "" }, datum);
	return { ...c, xf: c.kind === "mercator" ? mercToLonLat : c.toLonLat ?? null };
}

// 属性（③）：列定義 cols に従って 2 進を読む
function readProps(r, pos, end, cols, stats) {
	const v = r.view, props = {};
	while (pos + 2 <= end) {
		const col = cols[v.getUint16(pos, true)]; pos += 2;
		if (!col) break;   // 壊れた列番号＝この地物の残りは読めない
		const t = col.type;
		let val, n = 0;
		switch (t) {
			case 0: val = v.getInt8(pos); n = 1; break;
			case 1: val = v.getUint8(pos); n = 1; break;
			case 2: val = v.getUint8(pos) !== 0; n = 1; break;
			case 3: val = v.getInt16(pos, true); n = 2; break;
			case 4: val = v.getUint16(pos, true); n = 2; break;
			case 5: val = v.getInt32(pos, true); n = 4; break;
			case 6: val = v.getUint32(pos, true); n = 4; break;
			case 7: case 8: {
				const b = t === 7 ? v.getBigInt64(pos, true) : v.getBigUint64(pos, true);
				val = (b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= BigInt(Number.MIN_SAFE_INTEGER)) ? Number(b) : (stats.bigints++, b.toString());
				n = 8; break;
			}
			case 9: val = v.getFloat32(pos, true); n = 4; break;
			case 10: val = v.getFloat64(pos, true); n = 8; break;
			default: {   // 11 String / 12 Json / 13 DateTime / 14 Binary＝uint32 長＋中身
				const len = v.getUint32(pos, true); pos += 4; n = len;
				if (t === 14) { val = undefined; break; }
				const s = TD.decode(r.u8.subarray(pos, pos + len));
				if (t === 12) { try { val = JSON.parse(s); } catch { val = s; } } else val = s;
			}
		}
		pos += n;
		if (val !== undefined) props[col.name] = val;
	}
	return props;
}

// 幾何（①）：Geometry 表 → GeoJSON geometry（xf＝経緯度へ）。曲線系・空は null
function readGeometry(r, g, type, xf, part = false) {
	const own = r.u8At(g, 6, 0);
	const t = own || type;
	if (t === 6 || t === 7) {   // MultiPolygon / GeometryCollection＝parts
		const parts = r.tables(g, 7).map(p => readGeometry(r, p, t === 6 ? 3 : 0, xf, true)).filter(Boolean);
		if (!parts.length) return null;
		return t === 6 ? { type: "MultiPolygon", coordinates: parts.map(p => p.coordinates) } : { type: "GeometryCollection", geometries: parts };
	}
	if (!(t >= 1 && t <= 5)) return null;   // Unknown のまま／曲線系（8〜17）
	const xyV = r.vec(g, 1);
	if (!xyV || xyV.len < 2) return null;
	const v = r.view, np = xyV.len >> 1;
	const pt = i => { const c = [v.getFloat64(xyV.pos + i * 16, true), v.getFloat64(xyV.pos + i * 16 + 8, true)]; return xf ? xf(c) : c; };
	const run = (a, b) => { const out = new Array(b - a); for (let i = a; i < b; i++) out[i - a] = pt(i); return out; };
	const endsV = r.vec(g, 0);
	const groups = () => {
		if (!endsV || !endsV.len) return [run(0, np)];
		const out = []; let s = 0;
		for (let k = 0; k < endsV.len; k++) { const e = v.getUint32(endsV.pos + k * 4, true); out.push(run(s, e)); s = e; }
		return out;
	};
	switch (t) {
		case 1: return { type: "Point", coordinates: pt(0) };
		case 2: return { type: "LineString", coordinates: run(0, np) };
		case 3: return { type: "Polygon", coordinates: groups() };
		case 4: return { type: "MultiPoint", coordinates: run(0, np) };
		case 5: return { type: "MultiLineString", coordinates: groups() };
	}
	return null;
}

/** FlatGeobuf → GeoPBF。戻り: { pbf, stats: { features, rows, droppedGeometries, columns, skipped, crs, reprojected, z, m, geometryType, bigints, ms } } */
export async function fromFlatGeobuf(u8, opts = {}) {
	const t0 = now();
	if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
	const h = readFlatGeobufHeader(u8), r = h.reader;
	const datum = await resolveDatum(opts);
	const crs = crsTransform(h.crs, datum);
	if (crs.kind === "other" && !opts.ignoreCrs) throw new Error(`fgb: CRS is not lon/lat (${crs.label}); GeoPBF is lon/lat only, reproject first or pass ignoreCrs`);
	const xf = opts.ignoreCrs && crs.kind === "other" ? null : crs.xf;
	let pos = h.featuresOffset;
	if (h.indexNodeSize > 0 && h.featuresCount > 0) pos += calcTreeSize(h.featuresCount, h.indexNodeSize);
	const stats = { features: 0, rows: 0, droppedGeometries: 0, bigints: 0, columns: h.columns.map(c => c.name), skipped: h.columns.filter(c => c.type === 14).map(c => ({ name: c.name, reason: "Binary" })),
		crs: crs.label, reprojected: !!xf, datumApprox: !!crs.approx, datum: datumStats(datum), z: h.hasZ, m: h.hasM, geometryType: GTYPES[h.geometryType] ?? `type ${h.geometryType}`, types: {}, ms: 0 };

	// 列：ヘッダの列＋地物ごとの列（出現順に足す）＝setHead は全部の名前を先に要る＝1 周目で列名を集め、2 周目で書く
	const feats = [];
	const names = new Set(h.columns.filter(c => c.type !== 14).map(c => c.name));
	for (let p = pos; p + 4 <= u8.length;) {
		const size = r.view.getUint32(p, true);
		if (!size || p + 4 + size > u8.length) break;
		const f = r.indirect(p + 4);
		const own = r.tables(f, 2);
		const cols = own.length ? readColumns(r, own) : h.columns;
		if (own.length) for (const c of cols) if (c.type !== 14) names.add(c.name);
		feats.push({ f, cols });
		p += 4 + size;
	}
	stats.rows = feats.length;
	const pbf = new GeoPBF({ name: opts.name || h.name || "flatgeobuf", precision: opts.precision ?? 6, description: opts.description ?? h.description ?? h.title ?? "", license: opts.license, attribution: opts.attribution });
	pbf.setHead([...names].sort());
	pbf.setBody(() => {
		for (const { f, cols } of feats) {
			const gp = r.field(f, 0);
			const geometry = gp ? readGeometry(r, r.indirect(gp), h.geometryType, xf) : null;
			if (!geometry) { stats.droppedGeometries++; continue; }
			const pv = r.vec(f, 1);
			const properties = pv ? readProps(r, pv.pos, pv.pos + pv.len, cols, stats) : {};
			stats.types[geometry.type] = (stats.types[geometry.type] ?? 0) + 1;
			pbf.setFeature({ type: "Feature", geometry, properties });
			stats.features++;
		}
	});
	pbf.close();
	stats.ms = now() - t0;
	return { pbf, stats };
}
export { CTYPES as FGB_COLUMN_TYPES };
