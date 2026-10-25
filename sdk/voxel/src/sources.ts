// 格子のファイルの読み手（@ortho-earth/voxel 第 5 段 ④・2026-10-25）＝NetCDF（classic＝CDF-1／2／5）と Zarr（v2・v3）→ VoxelData（region＋times）。純関数＋fetch（worker でも main でも）。
//   変数＝opts.variable（省略＝座標でない一番次元の多い数値の変数）。次元の並び＝(time?, z?, y, x)＝C 順の最後が x（経度）＝values の x が最も速い（そのまま）。
//   座標＝CF の約束（units が degrees_east／degrees_north・axis X／Y／Z／T・名前 lon／lat／level…）。経緯度・高さはセルの中心＝範囲は端のセルの半分だけ外へ。
//   緯度・高さが降順なら裏返す。高さ＝units m／km はそのまま（positive="down"・depth は負へ）、Pa／hPa は標準大気で m に（間隔は一様と見なす＝近似）。opts.heights で上書き。
//   時刻＝units "<単位> since <日時>" → ms。opts.frames＝[始め, 終わり)（こまの番号）で読むこまを絞る（Zarr は要るチャンクだけ取る）。
//   値＝scale_factor／add_offset を掛け、_FillValue／missing_value・範囲の外（valid_min／max）は NaN（＝空）。
//   読めない物＝NetCDF-4（HDF5）・Zarr の blosc／zstd／sharding などの codec は理由を添えて投げる（変換の道を案内）。
import type { VoxelData } from "@ortho-earth/globe";

export interface SourceOptions {
	/** 描く変数の名前（省略＝座標でない、次元の一番多い数値の変数） */
	variable?: string;
	/** 時間の次元のこまの範囲 [始め, 終わり)（番号・省略＝全部） */
	frames?: [number, number] | null;
	/** 高さの範囲 [h0, h1]（m）を上書き（高さの座標が無い・気圧面の近似を避けたい時） */
	heights?: [number, number] | null;
	/** fetch の代わり（検定・認証つきの取り方） */
	fetch?: (url: string) => Promise<Response>;
}
/** 読んだ変数の説明（手綱の source に載る） */
export interface SourceMeta { format: "netcdf" | "zarr"; variable: string; units: string | null; longName: string | null; dims: string[]; attrs: Record<string, unknown> }
export type SourceData = VoxelData & { shape: "region"; region: [number, number, number, number, number, number]; values: Float32Array; meta: SourceMeta };

// ---- 共通：変数 → 格子 ----
type Attrs = Record<string, unknown>;
interface VarInfo { name: string; dims: string[]; shape: number[]; attrs: Attrs; numeric: boolean }
interface Reader {
	format: "netcdf" | "zarr";
	vars: VarInfo[];
	/** 変数の値（全体か、先頭の軸を [t0, t1) に絞った物）→ Float64 ではなく Float32（scale／offset・fill 済み） */
	read(name: string, first?: [number, number] | null): Promise<Float32Array>;
	/** 座標の 1 次元の値（そのまま） */
	coord(name: string): Promise<Float64Array>;
}
const lc = (v: unknown): string => typeof v === "string" ? v.trim().toLowerCase() : "";
const num1 = (v: unknown): number | null => { const x = Array.isArray(v) || ArrayBuffer.isView(v) ? (v as ArrayLike<number>)[0] : v; return typeof x === "number" && Number.isFinite(x) ? x : typeof x === "bigint" ? Number(x) : null; };
const strAttr = (a: Attrs, k: string): string | null => typeof a[k] === "string" ? (a[k] as string) : null;
type Axis = "x" | "y" | "z" | "t";
/** 座標の変数が何の軸か（CF：axis・units・standard_name・名前） */
export function axisOf(name: string, attrs: Attrs): Axis | null {
	const ax = lc(attrs.axis), u = lc(attrs.units), sn = lc(attrs.standard_name), n = name.toLowerCase();
	if (ax === "x" || sn === "longitude" || /^degrees?_?e(ast)?$/.test(u) || /^(lon|long|longitude|x_lon|nav_lon)$/.test(n)) return "x";
	if (ax === "y" || sn === "latitude" || /^degrees?_?n(orth)?$/.test(u) || /^(lat|latitude|y_lat|nav_lat)$/.test(n)) return "y";
	if (ax === "t" || sn === "time" || /\bsince\b/.test(u) || /^(time|t)$/.test(n)) return "t";
	if (ax === "z" || /^(height|altitude|depth|air_pressure|model_level_number)$/.test(sn) || /^(level|lev|plev|isobaric|pressure|height|alt|altitude|depth|z|bottom_top|pressure_level)$/.test(n) || lc(attrs.positive) === "up" || lc(attrs.positive) === "down") return "z";
	return null;
}
// 表は Map（ファイルの字を鍵にする＝__proto__ などで Object の性質を引かない）
const UNIT_MS = new Map<string, number>(Object.entries({ ms: 1, millisecond: 1, milliseconds: 1, s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4, h: 3.6e6, hr: 3.6e6, hrs: 3.6e6, hour: 3.6e6, hours: 3.6e6, d: 8.64e7, day: 8.64e7, days: 8.64e7 }));
/** CF の時刻（"hours since 1900-01-01 00:00:0.0" など）→ ms。読めなければ null */
export function cfTimes(values: ArrayLike<number>, units: string | null): number[] | null {
	const m = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units || ""); if (!m) return null;
	const k = UNIT_MS.get(m[1].toLowerCase()); if (!k) return null;
	const s = m[2].trim().replace(/\s+UTC$/i, "").replace(/\s*Z$/i, "");
	const d = /^(-?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?)?\s*([+-]\d{1,2}(?::?\d{2})?)?$/.exec(s);
	if (!d) return null;
	let base = Date.UTC(+d[1], +d[2] - 1, +d[3], +(d[4] || 0), +(d[5] || 0), 0) + Math.round(parseFloat(d[6] || "0") * 1000);
	if (+d[1] < 100) { const t = new Date(base); t.setUTCFullYear(+d[1]); base = t.getTime(); }
	if (d[7]) { const z = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(d[7])!; base -= (z[1] === "-" ? -1 : 1) * (+z[2] * 60 + +(z[3] || 0)) * 6e4; }
	return Array.from(values, v => base + v * k);
}
/** 気圧（Pa）→ 高さ（m・標準大気の対流圏の式） */
export const pressureToHeight = (pa: number): number => 44330.8 * (1 - Math.pow(Math.max(1, pa) / 101325, 0.190263));
/** 高さの座標 → m（units と positive で） */
export function heightsOf(values: ArrayLike<number>, attrs: Attrs, name = ""): number[] {
	const u = lc(attrs.units), down = lc(attrs.positive) === "down" || /depth/i.test(name) || lc(attrs.standard_name) === "depth";
	let f = (v: number): number => v;
	if (/^(pa|pascal|pascals)$/.test(u)) f = pressureToHeight;
	else if (/^(hpa|mbar|millibar|millibars|mb)$/.test(u)) f = v => pressureToHeight(v * 100);
	else if (/^(km|kilometer|kilometers|kilometre|kilometres)$/.test(u)) f = v => v * 1000;
	return Array.from(values, v => (down ? -1 : 1) * f(v));
}
/** セルの中心の並び → 範囲（端のセルの半分だけ外へ）と昇順か。一つだけなら step で幅 */
export function edges(c: ArrayLike<number>, step1 = 1): { lo: number; hi: number; asc: boolean } {
	const n = c.length, a = c[0], b = c[n - 1], asc = !(n > 1 && b < a), d = n > 1 ? Math.abs(b - a) / (n - 1) : step1;
	const lo = Math.min(a, b) - d / 2, hi = Math.max(a, b) + d / 2;
	return { lo, hi, asc };
}
/** 選んだ変数（座標でない・数値・次元 2〜4・x と y がある）を探す */
export function pickVariable(r: Pick<Reader, "vars">, want?: string): VarInfo {
	const coordNames = new Set(r.vars.filter(v => v.dims.length === 1 && v.dims[0] === v.name).map(v => v.name));
	if (want != null) { const v = r.vars.find(x => x.name === want); if (!v) throw new Error(`voxel: variable "${want}" not found (${r.vars.map(x => x.name).join(", ")})`); return v; }
	const cands = r.vars.filter(v => v.numeric && !coordNames.has(v.name) && v.dims.length >= 2 && v.dims.length <= 4).sort((a, b) => b.dims.length - a.dims.length || b.shape.reduce((x, y) => x * y, 1) - a.shape.reduce((x, y) => x * y, 1));
	if (!cands.length) throw new Error(`voxel: no 2D–4D numeric variable to draw (${r.vars.map(x => x.name).join(", ")})`);
	return cands[0];
}
/** 読み手 → VoxelData（region・times） */
export async function toVoxelData(r: Reader, o: SourceOptions = {}): Promise<SourceData> {
	const v = pickVariable(r, o.variable);
	if (v.dims.length < 2 || v.dims.length > 4) throw new Error(`voxel: variable "${v.name}" has ${v.dims.length} dimensions (2–4: [time,] [z,] y, x)`);
	const info = (d: string): VarInfo | undefined => r.vars.find(x => x.name === d && x.dims.length === 1);
	const kinds = v.dims.map(d => { const c = info(d); return c ? axisOf(d, c.attrs) : axisOf(d, {}); });
	const nd = v.dims.length, ix = nd - 1, iy = nd - 2;
	let it = -1, iz = -1;
	if (nd === 4) { it = 0; iz = 1; }
	else if (nd === 3) { if (kinds[0] === "t") it = 0; else iz = 0; }
	if (kinds[ix] === "y" && kinds[iy] === "x") throw new Error(`voxel: "${v.name}" is ordered (…, x, y); only (…, y, x) is read`);
	const nx = v.shape[ix], ny = v.shape[iy], nz = iz >= 0 ? v.shape[iz] : 1, ntAll = it >= 0 ? v.shape[it] : 1;
	const [f0, f1] = it >= 0 && o.frames ? [Math.max(0, Math.floor(o.frames[0])), Math.min(ntAll, Math.floor(o.frames[1]))] : [0, ntAll];
	if (!(f1 > f0)) throw new RangeError(`voxel: frames [${o.frames}] select no frame of ${ntAll}`);
	const crd = async (i: number): Promise<{ vals: Float64Array; attrs: Attrs } | null> => { const c = info(v.dims[i]); return c ? { vals: await r.coord(c.name), attrs: c.attrs } : null; };
	const [cx, cy, cz, ct] = await Promise.all([crd(ix), crd(iy), iz >= 0 ? crd(iz) : null, it >= 0 ? crd(it) : null]);
	if (!cx || !cy) throw new Error(`voxel: "${v.name}" needs longitude / latitude coordinates (${v.dims[ix]}, ${v.dims[iy]})`);
	const ex = edges(cx.vals), ey = edges(cy.vals);
	let h0 = 0, h1 = 1000, zAsc = true;
	if (o.heights) [h0, h1] = o.heights;
	else if (cz) { const hz = heightsOf(cz.vals, cz.attrs, v.dims[iz]), e = edges(hz, 1000); h0 = e.lo; h1 = e.hi; zAsc = e.asc; }
	if (o.heights && cz) zAsc = edges(heightsOf(cz.vals, cz.attrs, v.dims[iz])).asc;
	if (!(h1 > h0)) throw new RangeError(`voxel: heights must be [h0, h1] with h0 < h1 (got ${h0}, ${h1})`);
	let times: number[] | undefined;
	if (it >= 0 && f1 - f0 > 1) {
		const t = ct ? cfTimes(ct.vals.subarray(f0, f1), strAttr(ct.attrs, "units")) : null;
		times = t && t.every((x, i) => i === 0 || x > t[i - 1]) ? t : Array.from({ length: f1 - f0 }, (_, i) => i * 3.6e6);   // 読めない時刻＝1 時間おき（時計で進む）
	}
	const raw = await r.read(v.name, it >= 0 ? [f0, f1] : null);
	const T = f1 - f0, n = nx * ny * nz;
	if (raw.length !== n * T) throw new Error(`voxel: "${v.name}" read ${raw.length} values, expected ${n * T}`);
	// 裏返す（緯度・高さ・経度が降順）＝x が東・y が北・z が上へ増える
	const flipX = !ex.asc, flipY = !ey.asc, flipZ = !zAsc;
	let values = raw;
	if (flipX || flipY || flipZ) {
		values = new Float32Array(raw.length);
		for (let t = 0; t < T; t++) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
			const src = t * n + nx * ((flipY ? ny - 1 - j : j) + ny * (flipZ ? nz - 1 - k : k)), dst = t * n + nx * (j + ny * k);
			if (!flipX) values.set(raw.subarray(src, src + nx), dst); else for (let i = 0; i < nx; i++) values[dst + i] = raw[src + nx - 1 - i];
		}
	}
	let w = ex.lo, e = ex.hi;
	if (e - w >= 360) { w = -180 + ((w + 180) % 360 + 360) % 360; e = w + 360 - 1e-9; }   // 全球＝360° ちょうどは region が幅 0 と読むので僅かに縮める
	const s = Math.max(-90, ey.lo), nn = Math.min(90, ey.hi);
	const units = strAttr(v.attrs, "units"), longName = strAttr(v.attrs, "long_name") ?? strAttr(v.attrs, "standard_name");
	const out: SourceData = { shape: "region", dims: [nx, ny, nz], region: [w, s, e, nn, h0, h1], values, meta: { format: r.format, variable: v.name, units, longName, dims: v.dims.slice(), attrs: v.attrs } };
	if (times) out.times = times;
	return out;
}
/** 値の整え（scale_factor／add_offset・fill・valid range → NaN） */
export function unpack(src: ArrayLike<number> & { length: number }, attrs: Attrs, fill: number | null = null): Float32Array {
	const sc = num1(attrs.scale_factor) ?? 1, of = num1(attrs.add_offset) ?? 0;
	const fv = num1(attrs._FillValue) ?? fill, mv = num1(attrs.missing_value);
	const vr = Array.isArray(attrs.valid_range) || ArrayBuffer.isView(attrs.valid_range) ? (attrs.valid_range as ArrayLike<number>) : null;
	const vmin = vr ? Number(vr[0]) : num1(attrs.valid_min), vmax = vr ? Number(vr[1]) : num1(attrs.valid_max);
	const out = new Float32Array(src.length);
	for (let i = 0; i < src.length; i++) {
		const x = Number(src[i]);
		if (x !== x || x === fv || x === mv || (vmin != null && x < vmin) || (vmax != null && x > vmax) || Math.abs(x) >= 9.96e36) { out[i] = NaN; continue; }   // 9.97e36＝NetCDF の既定の fill（float）
		out[i] = x * sc + of;
	}
	return out;
}

// ---- NetCDF classic（CDF-1／2／5・big endian）----
const NC_DIM = 10, NC_VAR = 11, NC_ATT = 12;
const NC_SIZE = new Map<number, number>([[1, 1], [2, 1], [3, 2], [4, 4], [5, 4], [6, 8], [7, 1], [8, 2], [9, 4], [10, 8], [11, 8]]);
const NC_FILL = new Map<number, number>([[1, -127], [3, -32767], [4, -2147483647], [5, 9.969209968386869e36], [6, 9.969209968386869e36], [7, 255], [8, 65535], [9, 4294967295]]);
interface NcVar extends VarInfo { type: number; begin: number; vsize: number; rec: boolean; dimIds: number[] }
/** NetCDF の形式（"classic"＝読める・"hdf5"＝NetCDF-4・null＝NetCDF でない） */
export function sniffNetCDF(b: Uint8Array): "classic" | "hdf5" | null {
	if (b.length >= 4 && b[0] === 0x43 && b[1] === 0x44 && b[2] === 0x46 && (b[3] === 1 || b[3] === 2 || b[3] === 5)) return "classic";
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x48 && b[2] === 0x44 && b[3] === 0x46) return "hdf5";
	return null;
}
export function parseNetCDF(buf: ArrayBuffer | Uint8Array): Reader {
	const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const kind = sniffNetCDF(u8);
	if (kind === "hdf5") throw new Error("voxel: NetCDF-4 (HDF5) is not read yet; save as NetCDF classic (e.g. `nccopy -k classic in.nc out.nc`) or as Zarr");
	if (kind !== "classic") throw new Error("voxel: not a NetCDF file (no CDF magic)");
	const ver = u8[3], big = ver === 5;
	let p = 4;
	const u32 = (): number => { const v = dv.getUint32(p); p += 4; return v; };
	const size = (): number => { if (big) { const v = Number(dv.getBigUint64(p)); p += 8; return v; } return u32(); };
	const off = (): number => { if (ver === 1) return u32(); const v = Number(dv.getBigUint64(p)); p += 8; return v; };
	const name = (): string => { const n = size(), s = new TextDecoder().decode(u8.subarray(p, p + n)); p += (n + 3) & ~3; return s; };
	const vals = (type: number, n: number): string | number[] => {
		const sz = NC_SIZE.get(type); if (!sz) throw new Error(`voxel: NetCDF type ${type} unknown`);
		const start = p; p += (n * sz + 3) & ~3;
		if (type === 2) return new TextDecoder().decode(u8.subarray(start, start + n)).replace(/\0+$/, "");
		return Array.from({ length: n }, (_, i) => readNc(dv, type, start + i * sz));
	};
	const atts = (): Attrs => {
		const tag = u32(), n = size(), out: Attrs = {};
		if (tag !== NC_ATT && !(tag === 0 && n === 0)) throw new Error("voxel: NetCDF header broken (attributes)");
		for (let i = 0; i < n; i++) { const k = name(), type = u32(), m = size(); const v = vals(type, m); out[k] = typeof v === "string" ? v : v.length === 1 ? v[0] : v; }
		return out;
	};
	const numrecs = size();
	let tag = u32(), nd = size();
	if (tag !== NC_DIM && !(tag === 0 && nd === 0)) throw new Error("voxel: NetCDF header broken (dimensions)");
	const dims: { name: string; len: number }[] = [];
	for (let i = 0; i < nd; i++) { const n = name(); dims.push({ name: n, len: size() }); }
	const recDim = dims.findIndex(d => d.len === 0);
	const gatts = atts();
	tag = u32(); const nv = size();
	if (tag !== NC_VAR && !(tag === 0 && nv === 0)) throw new Error("voxel: NetCDF header broken (variables)");
	const vars: NcVar[] = [];
	for (let i = 0; i < nv; i++) {
		const nm = name(), ndi = size(), dimIds = Array.from({ length: ndi }, () => size()), attrs = atts(), type = u32(), vsize = size(), begin = off();
		const rec = ndi > 0 && dimIds[0] === recDim;
		vars.push({ name: nm, dims: dimIds.map(d => dims[d].name), shape: dimIds.map(d => d === recDim ? numrecs : dims[d].len), attrs, numeric: type !== 2, type, begin, vsize, rec, dimIds });
	}
	const recSize = vars.filter(v => v.rec).reduce((a, v) => a + v.vsize, 0);
	const recVars = vars.filter(v => v.rec).length;
	const raw = (v: NcVar, first?: [number, number] | null): Float64Array => {
		const sz = NC_SIZE.get(v.type) ?? 1, inner = v.shape.slice(v.rec ? 1 : 0).reduce((a, b) => a * b, 1);
		if (!v.rec) { const out = new Float64Array(inner); for (let i = 0; i < inner; i++) out[i] = readNc(dv, v.type, v.begin + i * sz); return out; }
		const [r0, r1] = first ?? [0, numrecs], out = new Float64Array(inner * (r1 - r0));
		// 一つだけの記録変数は詰めて並ぶ（vsize は 4 の倍数に揃えない＝NetCDF の決まり）
		const stride = recVars === 1 ? inner * sz : recSize;
		for (let r = r0; r < r1; r++) for (let i = 0; i < inner; i++) out[(r - r0) * inner + i] = readNc(dv, v.type, v.begin + r * stride + i * sz);
		return out;
	};
	void gatts;
	return {
		format: "netcdf", vars,
		async read(n: string, first?: [number, number] | null) {
			const v = vars.find(x => x.name === n)!;
			if (first && !v.rec) {   // 時間が記録の次元でない＝全体を読んで先頭の軸を切る
				const all = raw(v, null), inner = v.shape.slice(1).reduce((a, b) => a * b, 1);
				return unpack(all.subarray(first[0] * inner, first[1] * inner), v.attrs, NC_FILL.get(v.type) ?? null);
			}
			return unpack(raw(v, first), v.attrs, NC_FILL.get(v.type) ?? null);
		},
		async coord(n: string) { const v = vars.find(x => x.name === n)!; return Float64Array.from(raw(v, null)); },
	};
}
function readNc(dv: DataView, type: number, o: number): number {
	switch (type) {
		case 1: return dv.getInt8(o);
		case 2: return dv.getUint8(o);
		case 3: return dv.getInt16(o);
		case 4: return dv.getInt32(o);
		case 5: return dv.getFloat32(o);
		case 6: return dv.getFloat64(o);
		case 7: return dv.getUint8(o);
		case 8: return dv.getUint16(o);
		case 9: return dv.getUint32(o);
		case 10: return Number(dv.getBigInt64(o));
		case 11: return Number(dv.getBigUint64(o));
		default: throw new Error(`voxel: NetCDF type ${type} unknown`);
	}
}

// ---- Zarr（v2・v3）----
interface ZArray { shape: number[]; chunks: number[]; dtype: string; fill: number | null; codec: "none" | "gzip" | "zlib"; sep: string; v3: boolean; key: (c: number[]) => string; attrs: Attrs; dims: string[] }
const ZDT = new Map<string, [number, string]>(Object.entries({ b1: [1, "u1"], i1: [1, "i1"], u1: [1, "u1"], i2: [2, "i2"], u2: [2, "u2"], i4: [4, "i4"], u4: [4, "u4"], i8: [8, "i8"], u8: [8, "u8"], f4: [4, "f4"], f8: [8, "f8"] }));
const V3DT = new Map<string, string>(Object.entries({ bool: "|b1", int8: "|i1", uint8: "|u1", int16: "<i2", uint16: "<u2", int32: "<i4", uint32: "<u4", int64: "<i8", uint64: "<u8", float32: "<f4", float64: "<f8" }));
const fillNum = (f: unknown): number | null => typeof f === "number" ? f : f === "NaN" ? NaN : typeof f === "string" && /^-?Infinity$/.test(f) ? (f.startsWith("-") ? -Infinity : Infinity) : null;
/** Zarr のメタ（v2 の .zarray＋.zattrs、v3 の zarr.json）→ 読み方 */
export function zarrArray(meta: Attrs, attrs: Attrs = {}, v3 = false): ZArray {
	if (!v3) {
		if (meta.order && meta.order !== "C") throw new Error("voxel: Zarr arrays in Fortran order are not read");
		if (Array.isArray(meta.filters) && meta.filters.length) throw new Error(`voxel: Zarr filters (${(meta.filters as Attrs[]).map(f => f.id).join(", ")}) are not read`);
		const c = meta.compressor as Attrs | null;
		const codec = !c ? "none" : c.id === "gzip" ? "gzip" : c.id === "zlib" ? "zlib" : null;
		if (!codec) throw new Error(`voxel: Zarr compressor "${String(c?.id)}" is not read yet (use gzip / zlib or none; e.g. xarray encoding={"var": {"compressor": numcodecs.GZip()}})`);
		const sep = (meta.dimension_separator as string) || ".";
		return { shape: meta.shape as number[], chunks: meta.chunks as number[], dtype: String(meta.dtype), fill: fillNum(meta.fill_value), codec, sep, v3, key: cc => cc.join(sep), attrs, dims: (attrs._ARRAY_DIMENSIONS as string[]) ?? [] };
	}
	const grid = meta.chunk_grid as { name?: string; configuration?: { chunk_shape?: number[] } } | undefined;
	if (grid?.name !== "regular") throw new Error("voxel: Zarr v3 needs a regular chunk grid");
	const dt = V3DT.get(String(meta.data_type)); if (!dt) throw new Error(`voxel: Zarr data type "${String(meta.data_type)}" is not read`);
	let endian = "<", codec: ZArray["codec"] = "none";
	for (const c of (meta.codecs as Attrs[]) ?? []) {
		const nm = c.name, cf = (c.configuration as Attrs) ?? {};
		if (nm === "bytes") endian = cf.endian === "big" ? ">" : "<";
		else if (nm === "gzip") codec = "gzip";
		else if (nm === "crc32c") continue;
		else throw new Error(`voxel: Zarr codec "${String(nm)}" is not read yet (use bytes + gzip; sharding, zstd and blosc follow)`);
	}
	const ke = meta.chunk_key_encoding as { name?: string; configuration?: { separator?: string } } | undefined;
	const sep = ke?.configuration?.separator ?? (ke?.name === "v2" ? "." : "/");
	const key = ke?.name === "v2" ? (cc: number[]): string => cc.join(sep) : (cc: number[]): string => ["c", ...cc].join(sep);
	return { shape: meta.shape as number[], chunks: grid.configuration!.chunk_shape!, dtype: endian + dt.slice(1), fill: fillNum(meta.fill_value), codec, sep, v3, key, attrs: (meta.attributes as Attrs) ?? {}, dims: (meta.dimension_names as string[]) ?? ((meta.attributes as Attrs)?._ARRAY_DIMENSIONS as string[]) ?? [] };
}
async function inflate(b: Uint8Array, codec: ZArray["codec"]): Promise<Uint8Array> {
	if (codec === "none") return b;
	const CS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
	if (!CS) throw new Error("voxel: DecompressionStream is not available (gzip / zlib Zarr chunks)");
	const s = new Blob([b as BlobPart]).stream().pipeThrough(new CS(codec === "gzip" ? "gzip" : "deflate"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}
function decodeChunk(b: Uint8Array, dtype: string): Float64Array | Float32Array {
	const le = dtype[0] !== ">", t = ZDT.get(dtype.slice(1)); if (!t) throw new Error(`voxel: Zarr dtype "${dtype}" is not read`);
	const [sz, k] = t, n = Math.floor(b.length / sz), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (k === "f4" && le && b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, n);
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const o = i * sz;
		out[i] = k === "f4" ? dv.getFloat32(o, le) : k === "f8" ? dv.getFloat64(o, le) : k === "i1" ? dv.getInt8(o) : k === "u1" ? dv.getUint8(o) : k === "i2" ? dv.getInt16(o, le) : k === "u2" ? dv.getUint16(o, le)
			: k === "i4" ? dv.getInt32(o, le) : k === "u4" ? dv.getUint32(o, le) : k === "i8" ? Number(dv.getBigInt64(o, le)) : Number(dv.getBigUint64(o, le));
	}
	return out;
}
/** Zarr の配列を読む（先頭の軸を [a, b) に絞れる・無いチャンクは fill） */
export async function readZarr(get: (path: string) => Promise<Uint8Array | null>, path: string, z: ZArray, first?: [number, number] | null): Promise<Float64Array> {
	const nd = z.shape.length, lo = z.shape.map(() => 0), hi = z.shape.slice();
	if (first && nd) { lo[0] = first[0]; hi[0] = first[1]; }
	const outShape = hi.map((h, i) => h - lo[i]), total = outShape.reduce((a, b) => a * b, 1), out = new Float64Array(total).fill(z.fill ?? NaN);
	const c0 = lo.map((l, i) => Math.floor(l / z.chunks[i])), c1 = hi.map((h, i) => Math.ceil(h / z.chunks[i]));
	const ids: number[][] = [];
	const walk = (d: number, acc: number[]): void => { if (d === nd) { ids.push(acc.slice()); return; } for (let c = c0[d]; c < c1[d]; c++) { acc[d] = c; walk(d + 1, acc); } };
	walk(0, new Array(nd));
	const oStride = outShape.map((_, i) => outShape.slice(i + 1).reduce((a, b) => a * b, 1)), cStride = z.chunks.map((_, i) => z.chunks.slice(i + 1).reduce((a, b) => a * b, 1));
	const pre = path ? `${path.replace(/\/$/, "")}/` : "";
	await Promise.all(ids.map(async cc => {
		const raw = await get(pre + z.key(cc)); if (!raw) return;
		const vals = decodeChunk(await inflate(raw, z.codec), z.dtype);
		// チャンクの中の範囲（格子の中・絞った範囲の中）を最後の軸で行ごとに写す
		const s = cc.map((c, i) => Math.max(lo[i], c * z.chunks[i])), e = cc.map((c, i) => Math.min(hi[i], (c + 1) * z.chunks[i]));
		const idx = s.slice();
		const last = nd - 1, run = e[last] - s[last];
		for (;;) {
			let co = 0, oo = 0;
			for (let i = 0; i < nd; i++) { co += (idx[i] - cc[i] * z.chunks[i]) * cStride[i]; oo += (idx[i] - lo[i]) * oStride[i]; }
			for (let r = 0; r < run; r++) out[oo + r] = vals[co + r];
			let d = last - 1;
			while (d >= 0) { idx[d]++; if (idx[d] < e[d]) break; idx[d] = s[d]; d--; }
			if (d < 0) break;
		}
	}));
	return out;
}
/** Zarr の店（URL の根）→ 読み手。consolidated（.zmetadata／zarr.json の consolidated_metadata）があれば一覧、無ければ variable と座標を名前で取る */
export async function openZarr(root: string, o: SourceOptions = {}): Promise<Reader> {
	const f = o.fetch ?? ((u: string) => fetch(u));
	const base = root.replace(/\/+$/, "");
	const get = async (p: string): Promise<Uint8Array | null> => { const r = await f(`${base}/${p}`); if (r.status === 404 || r.status === 403) return null; if (!r.ok) throw new Error(`voxel: Zarr ${p}: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
	const json = async (p: string): Promise<Attrs | null> => { const b = await get(p); return b ? JSON.parse(new TextDecoder().decode(b)) as Attrs : null; };
	const arrays = new Map<string, ZArray>();
	const v3root = await json("zarr.json");
	let v3 = false;
	if (v3root && v3root.zarr_format === 3) {
		v3 = true;
		const cm = (v3root.consolidated_metadata as { metadata?: Record<string, Attrs> } | undefined)?.metadata;
		if (cm) for (const [k, m] of Object.entries(cm)) if (m.node_type === "array") arrays.set(k, zarrArray(m, {}, true));
		if (v3root.node_type === "array") arrays.set("", zarrArray(v3root, {}, true));
	} else {
		const zm = await json(".zmetadata");
		const md = zm?.metadata as Record<string, Attrs> | undefined;
		if (md) for (const [k, m] of Object.entries(md)) if (k.endsWith("/.zarray")) { const n = k.slice(0, -8); arrays.set(n, zarrArray(m, md[`${n}/.zattrs`] ?? {})); }
		else if (k === ".zarray") arrays.set("", zarrArray(m, md[".zattrs"] ?? {}));
	}
	const load = async (n: string): Promise<ZArray | null> => {
		if (arrays.has(n)) return arrays.get(n)!;
		const p = n ? `${n}/` : "";
		let z: ZArray | null = null;
		if (v3) { const m = await json(`${p}zarr.json`); if (m?.node_type === "array") z = zarrArray(m, {}, true); }
		else { const m = await json(`${p}.zarray`); if (m) z = zarrArray(m, (await json(`${p}.zattrs`)) ?? {}); }
		if (z) arrays.set(n, z);
		return z;
	};
	if (!arrays.size) {   // 一覧が無い＝variable を名前で（無ければ根が配列か）
		const z = await load(o.variable ?? "");
		if (!z) throw new Error(`voxel: Zarr store ${root} has no consolidated metadata; pass { variable } (or consolidate it: zarr.consolidate_metadata)`);
	}
	if (o.variable != null) await load(o.variable);
	const named = (): VarInfo[] => [...arrays].map(([k, z]) => ({ name: k || o.variable || "data", dims: z.dims.length ? z.dims : z.shape.map((_, i) => `dim${i}`), shape: z.shape, attrs: z.attrs, numeric: true }));
	// 座標の配列（次元の名前と同じ名前）＝一覧に無ければ取りに行く
	for (const v of named()) for (const d of v.dims) if (!arrays.has(d)) await load(d).catch(() => null);
	const vars = named();
	const pathOf = (n: string): string => arrays.has(n) ? n : "";
	return {
		format: "zarr", vars,
		async read(n: string, first?: [number, number] | null) { const z = arrays.get(pathOf(n))!; return unpack(await readZarr(get, pathOf(n), z, first), z.attrs, z.fill); },
		async coord(n: string) { const z = arrays.get(n)!; return Float64Array.from(await readZarr(get, n, z)); },
	};
}

// ---- 入口 ----
/** URL の種類（.zarr＝Zarr の店・それ以外の .nc 等＝一つのファイル） */
export const isZarrUrl = (u: string): boolean => /\.zarr(\/|\?|#|$)/i.test(u) || /\/zarr\.json$|\/\.zmetadata$/i.test(u);
/** VoxelSource（URL／bytes）→ VoxelData（region・times・meta） */
export async function readSource(src: string | URL | ArrayBuffer | Uint8Array, o: SourceOptions = {}): Promise<SourceData> {
	if (src instanceof ArrayBuffer || src instanceof Uint8Array) {
		const b = src instanceof Uint8Array ? src : new Uint8Array(src);
		if (!sniffNetCDF(b)) throw new Error("voxel: bytes are not NetCDF (pass a .zarr URL for Zarr)");
		return toVoxelData(parseNetCDF(b), o);
	}
	const url = String(src);
	if (isZarrUrl(url)) return toVoxelData(await openZarr(url.replace(/\/(zarr\.json|\.zmetadata)$/i, "").split(/[?#]/)[0], o), o);
	if (/\.(vox|npy)(\?|#|$)/i.test(url)) throw new Error("voxel: .vox / .npy sources are not read yet; pass VoxelData, NetCDF or Zarr");
	const f = o.fetch ?? ((u: string) => fetch(u));
	const r = await f(url); if (!r.ok) throw new Error(`voxel: ${url}: HTTP ${r.status}`);
	return toVoxelData(parseNetCDF(new Uint8Array(await r.arrayBuffer())), o);
}
