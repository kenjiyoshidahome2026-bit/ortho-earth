// Shapefile（.shp ＋ .dbf ＋ .cpg ＋ .prj）の読み手＝worker（decoder/shape.ts）と Node の手元バッチ（gishub-jp の estat-batch 等）が共有する芯。
// 2026-10-17：外部の shapefile@0.6.6（Node 版が保守終了の text-encoding を引く）をやめ、ここを `geopbf/shapefile` として出す。
// 読むのは平面（XY）だけ・座標系は .prj（無ければ opts.crs）で経緯度へ・DBF の文字コードは .cpg ＞ 言語ドライバ ＞ 指定 ＞ UTF-8 で読めるか。
import { mercToLonLat as fromMercator } from "../modules/mercator.ts";   // 旧＝atan(sinh(y·π/R)) の自前式（数学的に同値・末位 ulp 差は precision 丸めで消える）
import { pointInRing } from "../modules/geom.ts";
import { crsFromWKT } from "../convert/proj.ts";   // 平面直角座標系 I〜XIX・UTM・日本測地系を経緯度へ（FileGDB / DXF と同じ判定）
import { epsgToWKT } from "../convert/epsg.ts";
import type { Geometry, Feature } from "../../types/geopbf.js";

type XY = number[];
export type Transform = (p: number[]) => number[];
/** shape レコードの幾何（GeometryCollection は出ない） */
export type ShpGeometry = Exclude<Geometry, { type: "GeometryCollection" }>;

const view = (a: Uint8Array): DataView => new DataView(a.buffer, a.byteOffset, a.byteLength);
function detectCRS(wkt: string | null): string | null {
    if (!wkt) return null;
    const s = wkt.trim();
    if (/AUTHORITY\["EPSG","(3857|3785|900913)"\]/.test(s) ||
        /Pseudo.Mercator|Web.Mercator|Auxiliary.Sphere/i.test(s)) return "3857";
    if (!s.startsWith("PROJCS") && (/WGS.?84|WGS.?1984/i.test(s) || /AUTHORITY\["EPSG","4326"\]/.test(s))) return null;
    if (s.startsWith("PROJCS")) {
        const m = s.match(/^PROJCS\["([^"]+)"/);
        return m?.[1] || "Unknown CRS";
    }
    return null;
}
function applyTransform(geom: ShpGeometry | null, fn: Transform): ShpGeometry | null {
    if (!geom) return geom;
    const pt = (p: XY): XY => fn(p), ring = (r: XY[]): XY[] => r.map(pt);
    const { type, coordinates: c } = geom as { type: string; coordinates: unknown };
    const coords =
        type === "Point" ? pt(c as XY) :
        type === "MultiPoint" || type === "LineString" ? (c as XY[]).map(pt) :
        type === "MultiLineString" ? (c as XY[][]).map(r => r.map(pt)) :
        type === "Polygon" ? (c as XY[][]).map(ring) :
        type === "MultiPolygon" ? (c as XY[][][]).map(poly => poly.map(ring)) : c;
    return { type, coordinates: coords } as ShpGeometry;
}
const getbbox = (r: XY[]): number[] => {
	let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
	r.forEach(p => {
		if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
		if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
	});
	return [xmin, ymin, xmax, ymax];
};
const includes = (b: number[], pt: XY): boolean => !(b[0] > pt[0] || b[2] < pt[0] || b[1] > pt[1] || b[3] < pt[1]);
const contains = (ring: XY[], pt: XY): boolean => pointInRing(pt[0], pt[1], ring);
// 空欄は null（2026-09-25・B8）：旧は空白の N 欄が 0、空白の D 欄と "00000000" が 1970-01-01（Invalid Date→NaN→0）、未設定の L（? や空白）が false になった。
// 数の欄の "*"（桁あふれの印）・読めない値も null。L は Y/T/N/F だけを真偽に
export type DbfValue = number | boolean | string | Date | null;
const dbfNum = (v: string): number | null => { v = v.replace(/\x00/g, "").trim(); if (!v || /^\*+$/.test(v)) return null; const n = +v; return Number.isFinite(n) ? n : null; };
const dbfDate = (v: string): Date | null => { const m = v.replace(/\x00/g, "").trim().match(/^(\d{4})(\d{2})(\d{2})$/); if (!m || +m[1] === 0 || +m[2] === 0 || +m[3] === 0) return null;
	const d = new Date(`${m[1]}-${m[2]}-${m[3]}`); return isNaN(+d) ? null : d; };
const DBF_PARSE: Record<string, (v: string) => DbfValue> = {
	B: dbfNum, F: dbfNum, N: dbfNum,
	L: v => /^[yt]$/i.test(v) ? true : /^[nf]$/i.test(v) ? false : null, D: dbfDate,
	C: v => { v = v.trim().replace(/\x00/g, ""); return v.length ? v : null; }
};
interface DbfField { name: string; type: string; length: number }
export class DBF {
	source: Uint8Array;
	len: number;
	dec: TextDecoder;
	fields: DbfField[];
	constructor(s: Uint8Array, enc: string) {
		const h = view(s.subarray(0, 32)), l = h.getUint16(8, true);
		const b = view(s.subarray(32, l));
		this.source = s.subarray(l); this.len = h.getUint16(10, true);
		this.dec = new TextDecoder(enc); this.fields = [];
		for (let n = 0; b.getUint8(n) !== 0x0d; n += 32) {
			let j = 0; while (j < 11 && b.getUint8(n + j) !== 0) j++;
			this.fields.push({
				name: this.dec.decode(new Uint8Array(b.buffer, b.byteOffset + n, j)).trim(),
				type: String.fromCharCode(b.getUint8(n + 11)),
				length: b.getUint8(n + 16)
			});
		}
	}
	read(): Record<string, DbfValue> | null {
		const value = this.source.subarray(0, this.len); this.source = this.source.subarray(this.len);
		if (!value || value[0] === 0x1a) return null;
		const q: Record<string, DbfValue> = {}, fields = this.fields;
		for (let k = 0, i = 1; k < fields.length; k++) {   // レコードごとに parse 表（6 クロージャ）を作らない
			const f = fields[k], raw = this.dec.decode(value.subarray(i, i += f.length));
			const v = (DBF_PARSE[f.type] || DBF_PARSE.C)(raw);
			if (v !== null) q[f.name] = v;
		}
		return q;
	}
}
// 各 parser は (DataView, o)＝o はレコード内容（shape type 欄）の絶対オフセット。レコードごとに DataView/subarray を作らない。
type ShpParser = (q: DataView, o: number) => ShpGeometry | null;
const Point: ShpParser = (q, o) => ({ type: "Point", coordinates: [q.getFloat64(o + 4, true), q.getFloat64(o + 12, true)] });
const MultiPoint: ShpParser = (q, o) => {
	const n = q.getInt32(o + 36, true), pts: XY[] = [];
	for (let i = 0, p = o + 40; i < n; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	return { type: "MultiPoint", coordinates: pts };
};
const PolyLine: ShpParser = (q, o) => {
	let p = o + 44;
	const n = q.getInt32(o + 36, true), m = q.getInt32(o + 40, true);
	const parts: number[] = [], pts: XY[] = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	const lines = parts.map((st, i) => pts.slice(st, parts[i + 1]));
	return n === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
};
const Polygon: ShpParser = (q, o) => {
	let p = o + 44;
	const n = q.getInt32(o + 36, true), m = q.getInt32(o + 40, true);
	const parts: number[] = [], pts: XY[] = [], polys: XY[][][] = [], holes: XY[][] = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	parts.forEach((st, i) => {
		const ring = pts.slice(st, parts[i + 1]);
		let s = 0;
		for (let j = 0, l = ring.length; j < l; j++) {
			const a = ring[j], b = ring[(j + 1) % l];
			s += (b[0] - a[0]) * (b[1] + a[1]);
		}
		s >= 0 ? polys.push([ring]) : holes.push(ring);
	});

	const bboxes = polys.map(t => getbbox(t[0]));
	const orphans: XY[][] = [];
	holes.forEach(hole => {
		const pt = hole[0];
		const idx = polys.findIndex((_, i) => includes(bboxes[i], pt) && contains(polys[i][0], pt));
		if (idx !== -1) polys[idx].push(hole); else orphans.push(hole);
	});
	// どの外周にも入らない「穴」＝向きが仕様（外周＝時計回り）と逆に書かれた外周。独立した面として拾う
	// （旧は捨てていた＝反時計回りだけのデータ＝我孫子市の地番図 ABIKO_POL は外周ゼロ→coordinates:undefined で zip ごと落ちた）
	orphans.forEach(r => polys.push([r]));
	if (!polys.length) return null;
	return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
};
const SHP_PARSERS: Record<number, ShpParser> = { 1: Point, 3: PolyLine, 5: Polygon, 8: MultiPoint, 11: Point, 13: PolyLine, 15: Polygon, 18: MultiPoint, 21: Point, 23: PolyLine, 25: Polygon, 28: MultiPoint };
export class SHP {
	view: DataView;
	pos: number;
	end: number;
	type: number;
	xform: Transform | null;
	parse: ShpParser | undefined;
	constructor(s: Uint8Array, transform: Transform | null = null) {
		this.view = view(s); this.pos = 100; this.end = s.byteLength;   // 1 本の DataView をオフセットで歩く
		this.type = this.view.getInt32(32, true);
		this.xform = transform;
		// Z 付き（11/13/15/18）・M 付き（21/23/25/28）も先頭の XY 部分は同じ並び＝同じ parser で平面だけ読む
		// （旧は M 付きが無く this.parse=undefined で落ちた＝我孫子市の地番図 ABIKO_POL.SHP は PolygonM）
		this.parse = SHP_PARSERS[this.type];
		if (!this.parse) this.end = 0;   // 未知の形（MultiPatch 31 等）＝読まない（例外で zip 全体を落とさない）
	}
	/** null＝形の無いレコード（DBF は 1 行進める）・undefined＝終わり */
	read(): ShpGeometry | null | undefined {
		const v = this.view;
		while (this.pos + 12 <= this.end) {
			const p = this.pos, len = v.getInt32(p + 4, false) * 2, type = v.getInt32(p + 8, true);
			this.pos = p + 8 + len;
			// null shape（type 0）等も 1 レコード＝DBF も 1 行進める必要がある＝null を返す
			// （旧は continue で読み飛ばし＝DBF とずれて、以後の属性が 1 件ずつ隣の筆のものになっていた）
			if (type !== this.type) return null;
			const geom = this.parse!(v, p + 8);
			return (this.xform && geom) ? applyTransform(geom, this.xform) : geom;
		}
		return undefined;   // 終わり（null＝形の無いレコードと区別する）
	}
}

/** DBF の文字コード：.cpg ＞ 言語ドライババイト（0x13＝Shift_JIS）＞ 指定（"utf8" 以外）＞ UTF-8 で読めるか（読めなければ Shift_JIS） */
export function dbfEncoding(dbf: Uint8Array, cpg: string | null | undefined, encoding?: string): string {
	if (cpg) return cpg.trim();
	if (dbf[29] === 0x13) return "sjis";
	if (encoding !== "utf8") return encoding as string;   // TODO(ts): encoding 未指定（undefined）だと旧来どおり TextDecoder(undefined)＝utf-8
	try { new TextDecoder("utf-8", { fatal: true }).decode(dbf); return "utf-8"; }
	catch { return "sjis"; }
}
/** 座標系：.prj（無ければ crs＝EPSG 番号か WKT）→ 経緯度への変換。経緯度なら transform は null。読めない投影は warning */
export function shpTransform(prj: string | null | undefined, crs?: number | string): { transform: Transform | null; warning: string | null } {
	const wkt: string | null = prj ?? (typeof crs === "number" || /^\d+$/.test(String(crs ?? "")) ? epsgToWKT(+(crs as number | string)) : crs as string | undefined) ?? null;
	if (!wkt) return { transform: null, warning: null };
	const c = crsFromWKT(wkt);
	if (c.toLonLat) return { transform: c.toLonLat, warning: null };
	if (c.kind === "lonlat") return { transform: null, warning: null };
	const legacy = detectCRS(wkt);   // proj.js が読めない書き方の Web メルカトル（旧判定）の保険
	if (legacy === "3857") return { transform: fromMercator, warning: null };
	return { transform: null, warning: legacy ? `Unsupported CRS detected: "${c.label || legacy}". Data may not display correctly. Convert to WGS84 (EPSG:4326) before use.` : null };
}

export interface ShapefileInput {
	shp: ArrayBuffer | Uint8Array;
	dbf: ArrayBuffer | Uint8Array;
	/** .cpg の中身（文字コード名） */
	cpg?: string | null;
	/** .prj の中身（WKT） */
	prj?: string | null;
	/** .cpg も言語ドライバも無い時の文字コード（例 "shift_jis"）。"utf8" か未指定＝UTF-8 で読めるかを見て、読めなければ Shift_JIS */
	encoding?: string;
	/** .prj が無い時の座標系（EPSG 番号か WKT） */
	crs?: number | string;
}
/** Shapefile 1 本を GeoJSON の Feature として順に返す。形の無いレコード（null shape）は飛ばす（DBF は 1 行進める）。空欄の属性は持たない */
export function* readShapefile({ shp, dbf, cpg, prj, encoding, crs }: ShapefileInput): Generator<Feature<ShpGeometry>> {
	const u8 = (b: ArrayBuffer | Uint8Array): Uint8Array => b instanceof Uint8Array ? b : new Uint8Array(b);
	const dbfBuf = u8(dbf), { transform } = shpTransform(prj, crs);
	const s = new SHP(u8(shp), transform), d = new DBF(dbfBuf, dbfEncoding(dbfBuf, cpg, encoding));
	while (1) {
		const g = s.read();
		if (g === undefined) return;
		const p = d.read();
		if (!p) return;
		if (g) yield { type: "Feature", geometry: g, properties: p };
	}
}
