// convert/filegdb.js ── Esri File Geodatabase（.gdb ディレクトリ）を読む（読み専用・依存ゼロ）。ArcGIS 10.x 形式（.gdbtable / .gdbtablx）。
// 仕様は非公開＝GDAL OpenFileGDB（Even Rouault の解析 https://github.com/rouault/dump_gdbtable/wiki/FGDB-Spec）に倣い、GDAL の検定資料で裏取りした。
//
//   const gdb = await openFileGDB(source);            // source: { names: string[], read(name, offset?, length?) → Promise<Uint8Array> }
//   gdb.tables                                        // [{ id, name, file, geometryType, hasZ, hasM, crs, fields, rows }]（GDB_* の系統表は除く）
//   const { pbf, stats } = await fromFileGDB(source, { layer });   // 1 フィーチャクラス → GeoPBF（layer 省略＝最初のフィーチャクラス）
//   gdbSourceFromFiles(files)                          // File/Blob の配列（zip を decodeZIP で開いた entries）→ source
//
// 読むもの: a00000001（GDB_SystemCatalog＝表名→ファイル番号）と各表の .gdbtable（ヘッダ・フィールド定義・行）・.gdbtablx（行→オフセット・1024 ブロックのビットマップ）。
// フィールド型: int16/int32/float32/float64/datetime(OLE 日数→Date)/objectid(行番号)/string(UTF-8)/geometry/binary(読み飛ばし)/UUID・GlobalID(文字列)/XML/int64/date/time。
// 幾何: point / multipoint / polyline / polygon（Z・M は落とす・曲線は頂点を直線で結ぶ＝stats.curves）。多パッチと空は落として数える。
// 多面の環は Esri 流（外環=時計回り・穴=反時計回りが平坦に並ぶ）→ 面積符号で外環/穴を分け、穴は最初の頂点を含む外環へ入れて Multi/Polygon に組む。
// CRS: フィールド定義の WKT を convert/proj.js で判定（経緯度はそのまま・平面直角座標系/UTM/Web メルカトルは逆変換・日本測地系や JGD2000 は convert/datum.js で測地系変換・他は ignoreCrs 無しで拒否）。
import { GeoPBF } from "../pbf-base.js";
import { attrFilter } from "./attrs.js";
import { crsFromWKT } from "./proj.js";
import { resolveDatum, datumStats } from "./datum.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const utf16 = new TextDecoder("utf-16le"), utf8 = new TextDecoder("utf-8");
const TYPE = ["int16", "int32", "float32", "float64", "string", "datetime", "objectid", "geometry", "binary", "raster", "uuid", "globalid", "xml", "int64", "date", "time", "datetimeoffset"];
const GEOM = { 0: null, 1: "point", 2: "multipoint", 3: "polyline", 4: "polygon", 9: "multipatch" };

/** File/Blob の配列（zip の entries）→ source。名前はパスの末尾だけ見る（x.gdb/a00000001.gdbtable → a00000001.gdbtable）。 */
export function gdbSourceFromFiles(files) {
	const map = new Map();
	for (const f of files) { const n = (f.name || "").split("/").pop().toLowerCase(); if (n) map.set(n, f); }
	return { names: [...map.keys()], read: async (name, offset = 0, length) => { const f = map.get(name.toLowerCase()); if (!f) throw new Error(`gdb: ${name} が無い`); const b = length === undefined ? f.slice(offset) : f.slice(offset, offset + length); return new Uint8Array(await b.arrayBuffer()); } };
}
/** { name: Uint8Array } の辞書 → source（Node・検定用）。 */
export function gdbSourceFromMap(map) {
	const m = new Map(); for (const [k, v] of (map instanceof Map ? map : Object.entries(map))) m.set(k.split("/").pop().toLowerCase(), v);
	return { names: [...m.keys()], read: async (name, offset = 0, length) => { const u = m.get(name.toLowerCase()); if (!u) throw new Error(`gdb: ${name} が無い`); return length === undefined ? u.subarray(offset) : u.subarray(offset, offset + length); } };
}

// ───────────────────────────── 低レベル: varint ─────────────────────────────
function vu(b, s) { let v = 0, m = 1, c; do { c = b[s.p++]; v += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return v; }          // unsigned（Number・53bit まで）
function vs(b, s) { let c = b[s.p++]; const neg = c & 0x40; let v = c & 0x3f, m = 64; while (c & 0x80) { c = b[s.p++]; v += (c & 0x7f) * m; m *= 128; } return neg ? -v : v; }   // signed（先頭 6bit＋符号）

// ───────────────────────────── .gdbtable ─────────────────────────────
/** ヘッダとフィールド定義。 */
export function parseTableHeader(head, fdesc) {
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const version = dv.getInt32(0, true), validRows = dv.getInt32(4, true), fdescOffset = Number(dv.getBigInt64(32, true));
	if (version !== 3 && version !== 4) throw new Error(`gdb: .gdbtable の版 ${version} は未対応（3/4＝ArcGIS 9.x/10.x のみ）`);
	const fd = new DataView(fdesc.buffer, fdesc.byteOffset, fdesc.byteLength);
	let p = 0;
	const sectionLen = fd.getInt32(p, true); p += 4; /* version */ p += 4;
	const geomCode = fdesc[p] & 0x0f, flags = fdesc[p + 1], zmFlags = fdesc[p + 3]; p += 4;
	const nFields = fd.getInt16(p, true); p += 2;
	const fields = [];
	const str16 = () => { const n = fdesc[p++]; const s = utf16.decode(fdesc.subarray(p, p + n * 2)); p += n * 2; return s; };
	for (let i = 0; i < nFields; i++) {
		const name = str16(), alias = str16(), t = fdesc[p++];
		const f = { name, alias, type: TYPE[t] || `type${t}`, code: t, nullable: false };
		const flagsAndDefault = (fixedDefault) => { const fl = fdesc[p + 1]; p += 2; f.nullable = !!(fl & 1); if (fl & 4) { const n = fdesc[p++]; p += n; } };
		switch (t) {
			case 0: case 1: case 2: case 3: case 5: case 13: case 14: case 15: case 16: f.width = fdesc[p]; flagsAndDefault(); break;
			case 4: f.maxLength = fd.getInt32(p, true); { const fl = fdesc[p + 4]; p += 5; f.nullable = !!(fl & 1); if (fl & 4) { const s = { p }; const n = vu(fdesc, s); p = s.p + n; } } break;
			case 6: p += 2; break;
			case 7: {
				const fl = fdesc[p + 1]; p += 2; f.nullable = !!(fl & 1);
				const wl = fd.getUint16(p, true); p += 2; f.wkt = utf16.decode(fdesc.subarray(p, p + wl)); p += wl;
				const g = fdesc[p++]; f.hasM = !!(g & 2); f.hasZ = !!(g & 4);
				f.xOrigin = fd.getFloat64(p, true); f.yOrigin = fd.getFloat64(p + 8, true); f.xyScale = fd.getFloat64(p + 16, true); p += 24;
				if (f.hasM) { f.mOrigin = fd.getFloat64(p, true); f.mScale = fd.getFloat64(p + 8, true); p += 16; }
				if (f.hasZ) { f.zOrigin = fd.getFloat64(p, true); f.zScale = fd.getFloat64(p + 8, true); p += 16; }
				p += 8 * (1 + f.hasM + f.hasZ);   // tolerances
				f.bbox = [fd.getFloat64(p, true), fd.getFloat64(p + 8, true), fd.getFloat64(p + 16, true), fd.getFloat64(p + 24, true)]; p += 32;
				// 経験則（GDAL と同じ）: この後に zmin/zmax・mmin/mmax が 0〜2 組あるかは版で揺れる＝「0x00 + int32 格子数(1..3)」が現れる位置を探す
				let found = false;
				for (const skip of [0, 16, 32]) { const q = p + skip; if (q + 5 <= fdesc.length && fdesc[q] === 0) { const ng = fd.getInt32(q + 1, true); if (ng >= 1 && ng <= 3) { p = q + 5 + 8 * ng; found = true; break; } } }
				if (!found) throw new Error(`gdb: 幾何フィールド ${name} の定義を読み切れない`);
				break;
			}
			case 8: case 10: case 11: case 12: { const fl = fdesc[p + 1]; p += 2; f.nullable = !!(fl & 1); break; }
			case 9: throw new Error(`gdb: ラスタ列 ${name} を持つ表は未対応`);
			default: throw new Error(`gdb: 未知のフィールド型 ${t}（${name}）`);
		}
		fields.push(f);
	}
	return { version, validRows, fdescOffset, sectionLen, geometryType: GEOM[geomCode] ?? `geom${geomCode}`, hasZ: !!(zmFlags & 0x80), hasM: !!(zmFlags & 0x40), utf8: !!(flags & 1), fields };
}

/** .gdbtablx → 行番号（1 始まり）→ .gdbtable 内オフセット（0＝削除/欠番）。1024 ブロックの欠落ビットマップ対応。 */
export function parseTablx(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const nBlocks = dv.getInt32(4, true), nRows = dv.getInt32(8, true), size = dv.getInt32(12, true);
	if (size < 4 || size > 6) throw new Error(`gdb: .gdbtablx のオフセット幅 ${size} が不正`);
	const trailer = 16 + nBlocks * 1024 * size;
	let present = null;   // ブロック i が存在するか（ビットマップが無ければ全部）
	if (trailer + 16 <= u8.length) {
		const nBitmapWords = dv.getInt32(trailer, true);
		if (nBitmapWords > 0) { present = new Uint8Array(u8.subarray(trailer + 16, trailer + 16 + nBitmapWords * 4)); }
	}
	// 存在ブロックの累積（ブロック番号 → 配列内の順位）
	let rank = null;
	if (present) { const total = Math.ceil(nRows / 1024); rank = new Int32Array(total + 1); let r = 0; for (let i = 0; i < total; i++) { rank[i] = r; if (present[i >> 3] & (1 << (i & 7))) r++; } rank[total] = r; }
	const offsetOf = (row) => {   // row: 1 始まり
		const i = row - 1, blk = i >> 10;
		let slot;
		if (rank) { if (!(present[blk >> 3] & (1 << (blk & 7)))) return 0; slot = rank[blk] * 1024 + (i & 1023); } else slot = i;
		const q = 16 + slot * size; if (q + size > u8.length) return 0;
		let v = 0; for (let k = size - 1; k >= 0; k--) v = v * 256 + u8[q + k];
		return v;
	};
	return { nRows, size, offsetOf };
}

const OLE_EPOCH = Date.UTC(1899, 11, 30);
/** 1 行の record（長さプレフィックスを除いた本体）→ 値の配列（objectid は null・geometry は生 Uint8Array）。 */
function readRecord(b, fields, nNullable) {
	const s = { p: (nNullable + 7) >> 3 }, dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Array(fields.length);
	let bit = 0;
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		if (f.nullable) { const isNull = b[bit >> 3] & (1 << (bit & 7)); bit++; if (isNull) { out[i] = null; continue; } }
		switch (f.code) {
			case 0: out[i] = dv.getInt16(s.p, true); s.p += 2; break;
			case 1: out[i] = dv.getInt32(s.p, true); s.p += 4; break;
			case 2: out[i] = dv.getFloat32(s.p, true); s.p += 4; break;
			case 3: out[i] = dv.getFloat64(s.p, true); s.p += 8; break;
			case 5: out[i] = new Date(OLE_EPOCH + Math.round(dv.getFloat64(s.p, true) * 86400000)); s.p += 8; break;
			case 6: out[i] = null; break;
			case 4: case 12: { const n = vu(b, s); out[i] = utf8.decode(b.subarray(s.p, s.p + n)); s.p += n; break; }
			case 7: case 8: { const n = vu(b, s); out[i] = b.subarray(s.p, s.p + n); s.p += n; break; }
			case 10: case 11: { out[i] = guid(b, s.p); s.p += 16; break; }
			case 13: { const v = dv.getBigInt64(s.p, true); out[i] = v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : v.toString(); s.p += 8; break; }
			case 14: case 15: out[i] = dv.getFloat64(s.p, true); s.p += 8; break;   // date / time（数値のまま）
			case 16: out[i] = dv.getFloat64(s.p, true); s.p += 10; break;
			default: throw new Error(`gdb: 行の型 ${f.type} を読めない`);
		}
	}
	return out;
}
function guid(b, p) {
	const h = (i) => b[p + i].toString(16).padStart(2, "0").toUpperCase();
	return `{${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}}`;
}

// ───────────────────────────── 幾何（Esri shape buffer・FGDB 圧縮形） ─────────────────────────────
const Z_TYPES = new Set([9, 10, 11, 13, 15, 18, 19, 20]), M_TYPES = new Set([11, 13, 15, 18, 21, 23, 25, 28, 31]);
/** 幾何 BLOB → GeoJSON geometry（null＝空/多パッチ/未対応）。ctx に vertices/curves/multipatch を積む。 */
export function parseShape(b, gf, ctx, xf) {
	const s = { p: 0 };
	const code = vu(b, s), base = code & 0xff;
	const hasZ = !!(code & 0x80000000) || Z_TYPES.has(base), hasM = !!(code & 0x40000000) || M_TYPES.has(base), hasCurves = !!(code & 0x20000000);
	const { xOrigin: xo, yOrigin: yo, xyScale: sc } = gf;
	const pt = (x, y) => { const c = [x / sc + xo, y / sc + yo]; return xf ? xf(c) : c; };
	if (base === 1 || base === 9 || base === 11 || base === 21 || base === 52) {   // point
		const vx = vu(b, s), vy = vu(b, s);
		if (vx === 0) { ctx.empty++; return null; }
		ctx.vertices++;
		return { type: "Point", coordinates: pt(vx - 1, vy - 1) };
	}
	if (base === 31 || base === 32 || base === 54) { ctx.multipatch++; return null; }
	const isMulti = base === 8 || base === 18 || base === 20 || base === 28 || base === 53;
	const isLine = base === 3 || base === 10 || base === 13 || base === 23 || base === 50;
	const isPoly = base === 5 || base === 15 || base === 19 || base === 25 || base === 51;
	if (!isMulti && !isLine && !isPoly) throw new Error(`gdb: 幾何型 ${base} は未対応`);
	const n = vu(b, s);
	if (n === 0) { ctx.empty++; return null; }
	const nParts = isMulti ? 1 : vu(b, s);
	if (hasCurves) { vu(b, s); ctx.curves++; }   // 曲線の数（曲線は頂点を直線で結ぶ）
	vu(b, s); vu(b, s); vu(b, s); vu(b, s);       // bbox（xmin, ymin, dx, dy）
	const counts = new Array(nParts); let rest = n;
	for (let i = 0; i < nParts - 1; i++) { counts[i] = vu(b, s); rest -= counts[i]; }
	counts[nParts - 1] = rest;
	let x = 0, y = 0; const parts = [];
	for (let i = 0; i < nParts; i++) { const arr = new Array(counts[i]); for (let k = 0; k < counts[i]; k++) { x += vs(b, s); y += vs(b, s); arr[k] = pt(x, y); } parts.push(arr); }
	ctx.vertices += n;   // Z / M / 曲線の詳細はここで打ち切り（落とす）
	if (isMulti) return { type: "MultiPoint", coordinates: parts[0] };
	if (isLine) { const ls = parts.filter(a => a.length >= 2); return ls.length === 0 ? (ctx.empty++, null) : ls.length === 1 ? { type: "LineString", coordinates: ls[0] } : { type: "MultiLineString", coordinates: ls }; }
	return assemblePolygons(parts.filter(a => a.length >= 4), ctx);
}
/** Esri の平坦な環の列 → Polygon / MultiPolygon（外環=時計回り・穴=反時計回り。GeoJSON 流に外環を反時計回りへ揃える）。 */
function assemblePolygons(rings, ctx) {
	if (!rings.length) { ctx.empty++; return null; }
	const area = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };   // <0 = 時計回り（y 上向き）
	const outers = [], holes = [];
	for (const r of rings) { const a = area(r); if (a === 0) continue; if (a < 0) outers.push([r.slice().reverse()]); else holes.push(r.slice().reverse()); }
	if (!outers.length) { if (!holes.length) { ctx.empty++; return null; } outers.push([holes.shift().reverse()]); }   // 向きが逆に書かれた単独環
	for (const h of holes) {
		let host = outers.length === 1 ? outers[0] : outers.find(o => inside(h[0], o[0])) ?? outers.find(o => h.some(p => inside(p, o[0])));
		if (!host) host = outers[0];
		host.push(h);
	}
	return outers.length === 1 ? { type: "Polygon", coordinates: outers[0] } : { type: "MultiPolygon", coordinates: outers };
}
function inside(p, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }

// ───────────────────────────── ジオデータベース ─────────────────────────────
const fileOf = id => `a${id.toString(16).padStart(8, "0")}`;
async function openTable(source, base) {
	const names = new Set(source.names.map(n => n.toLowerCase()));
	if (!names.has(`${base}.gdbtable`)) return null;
	const head = await source.read(`${base}.gdbtable`, 0, 40);
	const fdOff = Number(new DataView(head.buffer, head.byteOffset, head.byteLength).getBigInt64(32, true));
	const lenBuf = await source.read(`${base}.gdbtable`, fdOff, 4);
	const secLen = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getInt32(0, true);
	const fdesc = await source.read(`${base}.gdbtable`, fdOff, 4 + secLen + 4);
	return { base, ...parseTableHeader(head, fdesc) };
}
/** カタログを読み、ユーザー表の一覧（ヘッダのみ・行は読まない）を返す。 */
export async function openFileGDB(source, opts = {}) {
	if (!source || !Array.isArray(source.names)) throw new Error("gdb: source は { names, read } が要る");
	const cat = await openTable(source, "a00000001");
	if (!cat) throw new Error("gdb: a00000001.gdbtable（GDB_SystemCatalog）が無い＝File Geodatabase でない");
	const catRows = await readRows(source, cat);
	const iName = cat.fields.findIndex(f => f.name.toLowerCase() === "name");
	const tables = [];
	for (const { id, values } of catRows) {
		const name = values[iName]; if (typeof name !== "string" || /^GDB_/i.test(name)) continue;
		let t; try { t = await openTable(source, fileOf(id)); } catch (e) { tables.push({ id, name, file: fileOf(id), error: e.message }); continue; }
		if (!t) continue;
		const gf = t.fields.find(f => f.code === 7);
		tables.push({ id, name, file: fileOf(id), rows: t.validRows, geometryType: gf ? t.geometryType : null, hasZ: t.hasZ, hasM: t.hasM, crs: gf ? classify(gf, opts.datum) : null, srsWKT: gf?.wkt ?? null, fields: t.fields.map(f => ({ name: f.name, type: f.type, alias: f.alias })), _t: t });
	}
	return { tables, layers: tables.filter(t => t.geometryType && t.geometryType !== "multipatch" && !t.error) };
}
/** 幾何フィールドの WKT → CRS。Esri の「不明な座標系」（GUID だけ・空）は、定義の bbox が経緯度の範囲に収まるなら経緯度として素通し（unknown: true）。 */
function classify(gf, datum) {
	const wkt = gf.wkt || "";
	if (!wkt || /^\{[0-9A-Fa-f-]+\}$/.test(wkt.trim())) {
		const [x0, y0, x1, y1] = gf.bbox, vals = [x0, y0, x1, y1];
		const informative = vals.every(v => Number.isFinite(v) && Math.abs(v) < 1e8) && x0 <= x1 && y0 <= y1;   // 空の層は ±2^31 級の既定値＝判断材料にならない
		const fits = [x0, x1].every(v => Math.abs(v) <= 180) && [y0, y1].every(v => Math.abs(v) <= 90);
		if (!informative || fits) return { kind: "lonlat", label: "unknown SRS (passed through as lon/lat)", name: null, unknown: true };
		return { kind: "other", label: `unknown SRS (extent ${x0.toFixed(1)}..${x1.toFixed(1)}, ${y0.toFixed(1)}..${y1.toFixed(1)} is not lon/lat)`, name: null, unknown: true };
	}
	return crsFromWKT(wkt, { datum });
}
async function* iterRows(source, t) {
	const tx = parseTablx(await source.read(`${t.base}.gdbtablx`));
	const body = await source.read(`${t.base}.gdbtable`);
	const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
	const nNullable = t.fields.reduce((n, f) => n + (f.nullable ? 1 : 0), 0);
	for (let row = 1; row <= tx.nRows; row++) {
		const off = tx.offsetOf(row); if (!off) continue;
		if (off + 4 > body.length) throw new Error(`gdb: 行 ${row} のオフセット ${off} がファイルの外`);
		const len = dv.getInt32(off, true);
		yield { id: row, values: readRecord(body.subarray(off + 4, off + 4 + len), t.fields, nNullable) };
	}
}
async function readRows(source, t) { const out = []; for await (const r of iterRows(source, t)) out.push(r); return out; }

/** 1 フィーチャクラス → GeoPBF。opts: { layer, precision, name, ignoreCrs, include/exclude/excludeAll } */
export async function fromFileGDB(source, opts = {}) {
	const t0 = now();
	const datum = await resolveDatum(opts);
	const gdb = await openFileGDB(source, { datum });
	if (!gdb.layers.length) throw new Error(`gdb: フィーチャクラスが無い（表: ${gdb.tables.map(t => `${t.name}${t.geometryType ? `(${t.geometryType})` : ""}`).join(", ") || "なし"}）`);
	const layer = opts.layer ? gdb.tables.find(t => t.name === opts.layer || t.name.toLowerCase() === String(opts.layer).toLowerCase()) : gdb.layers[0];
	if (!layer) throw new Error(`gdb: 層 "${opts.layer}" が無い（層: ${gdb.layers.map(l => l.name).join(", ")}）`);
	if (layer.error) throw new Error(`gdb: 層 "${layer.name}" を読めない: ${layer.error}`);
	if (!layer.geometryType) throw new Error(`gdb: "${layer.name}" は幾何の無い表`);
	const crs = layer.crs;
	if (crs.kind === "other" && !opts.ignoreCrs) throw new Error(`gdb: 層 "${layer.name}" の CRS を経緯度へ戻せない（${crs.label}）。再投影してから、または ignoreCrs`);
	const xf = crs.toLonLat ?? null;
	const t = layer._t, gf = t.fields.find(f => f.code === 7);
	const keep = attrFilter(opts);
	const props = t.fields.map((f, i) => ({ i, f })).filter(({ f }) => f.code !== 7 && f.code !== 8 && f.code !== 9 && (!keep || keep(f.name)));
	const skipped = t.fields.filter(f => f.code === 8).map(f => ({ name: f.name, reason: "binary" }));
	const ctx = { vertices: 0, empty: 0, multipatch: 0, curves: 0, nulls: 0 };
	const features = [];
	for await (const { id, values } of iterRows(source, t)) {
		const raw = values[t.fields.indexOf(gf)];
		const geometry = raw ? parseShape(raw, gf, ctx, xf) : null;
		if (!geometry) { ctx.nulls++; continue; }
		const q = {};
		for (const { i, f } of props) { const v = f.code === 6 ? id : values[i]; if (v !== null && v !== undefined) q[f.name] = v; }
		features.push({ type: "Feature", properties: q, geometry });
	}
	const t1 = now();
	const pbf = await new GeoPBF({ name: opts.name ?? layer.name, precision: opts.precision ?? 6, description: opts.description, license: opts.license, attribution: opts.attribution }).set({ type: "FeatureCollection", features });
	return { pbf, stats: { layer: layer.name, layers: gdb.layers.map(l => l.name), tables: gdb.tables.filter(t => !t.geometryType).map(t => t.name), features: features.length, rows: layer.rows, vertices: ctx.vertices, droppedGeometries: ctx.nulls, emptyGeometries: ctx.empty, multipatch: ctx.multipatch, curves: ctx.curves,
		columns: props.map(p => p.f.name), skipped, crs: crs.label, crsUnknown: !!crs.unknown, reprojected: !!xf, datumApprox: !!crs.approx, datum: datumStats(datum), geometryType: layer.geometryType, z: layer.hasZ, m: layer.hasM, precision: opts.precision ?? 6, ms: { read: t1 - t0, encode: now() - t1, total: now() - t0 } } };
}
