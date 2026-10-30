// 3D Tiles のタイルの中身を解く（#41・2026-09-23）＝model-worker（kind:"tile3d"）の中で走る。
// 形式：b3dm（glTF＋RTC_CENTER）・i3dm（glTF をインスタンスで並べる）・pnts（点群）・cmpt（束ね）・glb / glTF（3D Tiles 1.1）。
// 置き方は仕様どおり：頂点 ECEF = タイル変換 · (RTC + Y-up→Z-up · glTF のノード変換 · p)。
// 三角形は meshdecode の decodeModel（PLATEAU・模型と同じ後段＝テクスチャ/マテリアル/両面）へ、点は経緯度に直して
// 点のオーバーレイ（gadgets/points-gl.js・原点相対）の形で返す。高さは接地しない＝絶対高さ（楕円体高）−baseH をそのまま持つ。
import { decodeModel, ecef2geo, geoWorld, earthW, fetchFor } from "./meshdecode.ts";
import { batchTableOf } from "./mesh-features.ts";
import type { PropertyTable } from "./mesh-features.ts";
import { decodeGeom, type GeomOut } from "./geom-tile.ts";
import type { ModelBatchOut, ModelOut, ModelPoints, SplatPrimOut, VoxelPrimOut, VoxelTileOpts, FetchOpts } from "./meshdecode.ts";

/** 点（points-gl の層に渡す形）＝原点相対の float32・RGBA8 */
export interface PointsOut { pos: Float32Array; origin: number[]; rgba: Uint8Array; n: number; feat?: PointsFeat | null }
/** 点群（pnts）の点ごとの地物（スタイルの ${名}・${POSITION}・${COLOR} が引く）：ids＝点ごとの batch の番号（BATCH_ID・無ければ点の番号そのもの＝null）・
 *  table＝batch table（行＝地物）・local＝局所の位置（RTC 相対・量子化を戻した物）・rgba＝元の色（スタイルで塗り直す元） */
export interface PointsFeat { ids: ArrayLike<number> | null; table: PropertyTable | null; local: Float32Array; rgba: Uint8Array }
/** decodeTile3D の戻り（null＝描く物なし） */
export interface Tile3DOut { batches: ModelBatchOut[]; points: PointsOut[]; splats: SplatPrimOut[]; voxels: VoxelPrimOut[]; /** Geometry タイル（.geom）の分類の立体 */ volumes?: GeomOut[]; stats: { triangles: number; points: number; splats: number; splatPoints: number; voxels: number; voxelsSkipped: number; copyright?: string[]; bytes?: number; /** 最初の glTF の根の拡張（gltfMeta の extensions） */ extensions?: Record<string, unknown> } }   // bytes＝model-worker が足す（タイルの本体の大きさ）・splats＝Gaussian splat（KHR_gaussian_splatting・局所＋transform）・splatPoints＝splat を点として描いた個数（plugin が無い時）
/** decodeTile3D の opts（transform＝列優先 4x4・baseH＝高さの基準（m）・ground＝"terrain"｜"absolute"・splats＝KHR_gaussian_splatting を splat として返す（false＝点として描く）） */
export interface Tile3DOpts { transform?: ArrayLike<number> | null; baseUri?: string; baseH?: number; textures?: boolean; maxInstances?: number; ground?: string; featureIdSet?: number; /** 利用者のシェーダの positionMC と J（meshdecode の mc） */ mc?: boolean; splats?: boolean; /** EXT_primitive_voxels を voxel として返す（false＝飛ばす・VoxelTileOpts＝属性名・tileset の宣言・タイルの境界体積） */ voxels?: boolean | VoxelTileOpts; /** タイル本体を取った headers／credentials＝同じ origin の外部画像・glTF にも（ion の Bearer） */ fetchOpts?: FetchOpts | null }
/** 3D Tiles の変換（L＝列優先 3x3・t＝平行移動） */
interface Xf3 { L: Float64Array; t: number[] }
interface TypedCtor { new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): ArrayLike<number>; readonly BYTES_PER_ELEMENT: number }
/** 特徴表の JSON（読む欄だけ・値は直値か { byteOffset, componentType }） */
type FeatureTableJson = Record<string, unknown> & { POINTS_LENGTH?: number; INSTANCES_LENGTH?: number; BATCH_LENGTH?: number; RTC_CENTER?: number[]; QUANTIZED_VOLUME_OFFSET?: number[]; QUANTIZED_VOLUME_SCALE?: number[]; CONSTANT_RGBA?: number[]; EAST_NORTH_UP?: boolean }

const td = new TextDecoder();
const magicOf = (ab: ArrayBuffer, off = 0) => td.decode(new Uint8Array(ab, off, 4));
// 末尾の NUL（JSON・URI の 8 バイト詰め）を落とす＝旧 .replace(/\0+$/, "") と同じ結果を添字の走査で（正規表現は NUL が続く入力で二乗＝CodeQL・2026-10-16）
const stripNul = (s: string): string => { let e = s.length; while (e > 0 && s.charCodeAt(e - 1) === 0) e--; return s.slice(0, e); };
const jsonAt = (ab: ArrayBuffer, off: number, len: number): FeatureTableJson => len ? JSON.parse(stripNul(td.decode(new Uint8Array(ab, off, len))).trim() || "{}") : {};

// 列優先 4x4（3D Tiles の transform）→ { L:列優先 3x3, t }
const splitM4 = (m: ArrayLike<number>): Xf3 => ({ L: Float64Array.of(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]), t: [m[12], m[13], m[14]] });
const mulL = (L: ArrayLike<number>, v: ArrayLike<number>) => [L[0] * v[0] + L[3] * v[1] + L[6] * v[2], L[1] * v[0] + L[4] * v[1] + L[7] * v[2], L[2] * v[0] + L[5] * v[1] + L[8] * v[2]];
const m3mul = (a: ArrayLike<number>, b: ArrayLike<number>) => { const o = new Float64Array(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c*3+r] = a[r]*b[c*3] + a[3+r]*b[c*3+1] + a[6+r]*b[c*3+2]; return o; };
const apply = (M: Xf3, v: ArrayLike<number>) => { const p = mulL(M.L, v); return [p[0] + M.t[0], p[1] + M.t[1], p[2] + M.t[2]]; };

// 特徴表（feature table）の値＝JSON の直値か、バイナリへの { byteOffset }（componentType は仕様の既定）
// componentType はタイルの JSON の文字列＝switch で決める（表を引くと "constructor" 等の継承キーが Object を返す。CodeQL・2026-10-16）
const componentCtor = (ct: string, dflt: TypedCtor): TypedCtor => {
	switch (ct) {
		case "BYTE": return Int8Array;
		case "UNSIGNED_BYTE": return Uint8Array;
		case "SHORT": return Int16Array;
		case "UNSIGNED_SHORT": return Uint16Array;
		case "INT": return Int32Array;
		case "UNSIGNED_INT": return Uint32Array;
		case "FLOAT": return Float32Array;
		case "DOUBLE": return Float64Array;
		default: return dflt;
	}
};
const ftValue = (ftJ: FeatureTableJson, ftBin: Uint8Array, key: string, n: number, Type: TypedCtor = Float32Array, comps = 3): ArrayLike<number> | null => {
	const v = ftJ[key] as { componentType?: string; byteOffset?: number } | number[] | null | undefined;
	if (v == null) return null;
	if (Array.isArray(v) || typeof v !== "object") return v as ArrayLike<number>;
	const T = v.componentType ? componentCtor(v.componentType, Type) : Type;
	const off = ftBin.byteOffset + (v.byteOffset || 0);
	if (off % T.BYTES_PER_ELEMENT) return new T(ftBin.buffer.slice(off, off + n * comps * T.BYTES_PER_ELEMENT));   // 整列していない＝写して読む
	return new T(ftBin.buffer, off, n * comps);
};

// Draco で圧した点群（3DTILES_draco_point_compression）：特徴表の POSITION／RGB(A) は Draco の塊の中＝解いて差し替える。
// 位置は量子化を戻した値（POSITION_QUANTIZED でも QUANTIZED_VOLUME_* を掛けた後と同じ空間＝RTC_CENTER 相対）・色は 8bit
type DracoExt = { properties?: Record<string, number>; byteOffset?: number; byteLength?: number };
const dracoExtOf = (J: Record<string, unknown> | null) => (J as { extensions?: Record<string, DracoExt> } | null)?.extensions?.["3DTILES_draco_point_compression"];
// batch table の列も Draco の塊の中に有り得る（BT.extensions の同名拡張の properties＝列名 → Draco の属性の番号）＝名を付けて一緒に解く
async function dracoPnts(J: FeatureTableJson, bin: Uint8Array, BT: Record<string, unknown> | null): Promise<{ P: ArrayLike<number>; RGB: ArrayLike<number> | null; RGBA: ArrayLike<number> | null; cols: Record<string, { value: ArrayLike<number>; size: number }> } | null> {
	const ext = dracoExtOf(J);
	if (!ext) return null;
	const extra = { ...(ext.properties || {}), ...(dracoExtOf(BT)?.properties || {}) };
	const { loadParse, DracoLoader } = await import("./mesh-loaders.ts");   // loaders.gl の Draco worker で解く（この model worker は module worker＝importScripts で復号器を読めない）
	const at = bin.byteOffset + (ext.byteOffset || 0), buf = bin.buffer.slice(at, at + (ext.byteLength || 0)) as ArrayBuffer;
	const mesh = await loadParse(buf, DracoLoader, { draco: { extraAttributes: extra } }) as { attributes: Record<string, { value: ArrayLike<number>; size: number }> };
	const A = mesh.attributes, P = (A.POSITION ?? A.POSITION_QUANTIZED)?.value, C = A.RGBA ?? A.RGB ?? A.COLOR_0;
	if (!P) return null;
	const cols: Record<string, { value: ArrayLike<number>; size: number }> = {};
	for (const k of Object.keys(dracoExtOf(BT)?.properties || {})) if (A[k]) cols[k] = A[k];
	return { P, RGB: C && C.size === 3 ? C.value : null, RGBA: C && C.size === 4 ? C.value : null, cols };
}

// 点群（pnts）
async function decodePnts(ab: ArrayBuffer, M: Xf3, baseH: number): Promise<PointsOut | null> {
	const dv = new DataView(ab), ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
	const J = jsonAt(ab, 28, ftJ), bin = new Uint8Array(ab, 28 + ftJ, ftB);
	const n = J.POINTS_LENGTH! | 0;
	if (!n) return null;
	const rtc = J.RTC_CENTER || [0, 0, 0];
	const BT = btJ ? jsonAt(ab, 28 + ftJ + ftB, btJ) as Record<string, unknown> : null, btBin = btB ? new Uint8Array(ab, 28 + ftJ + ftB + btJ, btB) : null;
	const D = await dracoPnts(J, bin, BT);
	let P = D ? D.P : ftValue(J, bin, "POSITION", n), qo: number[] | null | undefined = null, qs: number[] | null | undefined = null;
	if (!P) { P = ftValue(J, bin, "POSITION_QUANTIZED", n, Uint16Array); qo = J.QUANTIZED_VOLUME_OFFSET; qs = J.QUANTIZED_VOLUME_SCALE; }
	if (!P) return null;
	const RGBA = D ? D.RGBA : ftValue(J, bin, "RGBA", n, Uint8Array, 4), RGB = RGBA ? null : D ? D.RGB : ftValue(J, bin, "RGB", n, Uint8Array, 3), R565 = RGBA || RGB ? null : ftValue(J, bin, "RGB565", n, Uint16Array, 1);
	const K = J.CONSTANT_RGBA || [169, 169, 169, 255];   // 色の無い点＝Cesium の既定（Color.DARKGRAY）
	const geo = new Float64Array(n * 3), rgba = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		let x = P[i*3], y = P[i*3+1], z = P[i*3+2];
		if (qo) { x = qo[0] + x / 65535 * qs![0]; y = qo[1] + y / 65535 * qs![1]; z = qo[2] + z / 65535 * qs![2]; }
		const e = apply(M, [x + rtc[0], y + rtc[1], z + rtc[2]]), g = ecef2geo(e[0], e[1], e[2]);
		geo[i*3] = g[0]; geo[i*3+1] = g[1]; geo[i*3+2] = g[2];
		if (RGBA) { rgba[i*4] = RGBA[i*4]; rgba[i*4+1] = RGBA[i*4+1]; rgba[i*4+2] = RGBA[i*4+2]; rgba[i*4+3] = RGBA[i*4+3]; }
		else if (RGB) { rgba[i*4] = RGB[i*3]; rgba[i*4+1] = RGB[i*3+1]; rgba[i*4+2] = RGB[i*3+2]; rgba[i*4+3] = 255; }
		else if (R565) { const c = R565[i]; rgba[i*4] = ((c >> 11) & 31) * 255 / 31; rgba[i*4+1] = ((c >> 5) & 63) * 255 / 63; rgba[i*4+2] = (c & 31) * 255 / 31; rgba[i*4+3] = 255; }
		else { rgba[i*4] = K[0]; rgba[i*4+1] = K[1]; rgba[i*4+2] = K[2]; rgba[i*4+3] = K[3] ?? 255; }
	}
	const out = pointsOut({ geo, rgba }, baseH);
	if (out) out.feat = pntsFeat(J, bin, BT, btBin, D?.cols ?? {}, n, P, qo, qs, rgba);
	return out;
}
// 点の地物（スタイル用）：batch table＝BATCH_LENGTH 行（BATCH_ID で点 → 行）か、無ければ点ごと（POINTS_LENGTH 行）
function pntsFeat(J: FeatureTableJson, bin: Uint8Array, BT: Record<string, unknown> | null, btBin: Uint8Array | null, dcols: Record<string, { value: ArrayLike<number>; size: number }>, n: number,
	P: ArrayLike<number>, qo: number[] | null | undefined, qs: number[] | null | undefined, rgba: Uint8Array): PointsFeat {
	const nB = J.BATCH_LENGTH! | 0, ids = nB ? ftValue(J, bin, "BATCH_ID", n, Uint16Array, 1) : null, rows = ids ? nB : n;
	let table: PropertyTable | null = null;
	if (BT) {
		const plain: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(BT)) if (k !== "extensions" && !(k in dcols)) plain[k] = v;
		table = batchTableOf(plain, btBin, rows) ?? { name: "batchTable", class: null, count: rows, columns: {} };
		for (const [k, c] of Object.entries(dcols)) table.columns[k] = Array.from({ length: rows }, (_, r) => c.size === 1 ? c.value[r] : Array.from({ length: c.size }, (_, i) => c.value[r * c.size + i]));
	}
	const local = new Float32Array(n * 3);
	for (let i = 0; i < n * 3; i++) { const k = i % 3; local[i] = qo ? qo[k] + P[i] / 65535 * qs![k] : P[i]; }
	return { ids, table, local, rgba: new Uint8Array(rgba) };
}

// 点（経緯度 rad・楕円体高）→ 世界座標の原点相対 float32（points-gl の layer に渡す形）。置き方は建物メッシュと同じ式（geoWorld＝楕円体なら β 単位球・#43）
function pointsOut(p: { geo: ArrayLike<number>; rgba: ArrayLike<number> }, baseH: number): PointsOut | null {
	const geo = p.geo instanceof Float64Array ? p.geo : Float64Array.from(p.geo), n = geo.length / 3;
	if (!n) return null;
	const w = new Float64Array(n * 3);
	let ox = 0, oy = 0, oz = 0;
	const EW = earthW(), q = [0, 0, 0];
	for (let i = 0; i < n; i++) {
		geoWorld(geo[i*3], geo[i*3+1], (geo[i*3+2] - baseH) / EW, q);
		w[i*3] = q[0]; w[i*3+1] = q[1]; w[i*3+2] = q[2];
		ox += w[i*3]; oy += w[i*3+1]; oz += w[i*3+2];
	}
	const origin = [ox / n, oy / n, oz / n], pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) { pos[i*3] = w[i*3] - origin[0]; pos[i*3+1] = w[i*3+1] - origin[1]; pos[i*3+2] = w[i*3+2] - origin[2]; }
	return { pos, origin, rgba: p.rgba instanceof Uint8Array ? p.rgba : Uint8Array.from(p.rgba), n };
}

// ECEF の点の東・北・上（列優先 3x3）
const enuAt = (e: ArrayLike<number>) => {
	const g = ecef2geo(e[0], e[1], e[2]), sl = Math.sin(g[0]), cl = Math.cos(g[0]), sp = Math.sin(g[1]), cp = Math.cos(g[1]);
	return Float64Array.of(-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp);
};

// インスタンス（i3dm）＝glTF をインスタンスの数だけ置く（置き方の列を decodeModel へ）
async function decodeI3dm(ab: ArrayBuffer, M: Xf3, opts: { baseUri?: string; textures?: boolean; baseH?: number | null; gOpt?: { ground?: string; mc?: boolean }; fetchOpts?: FetchOpts | null }, maxInstances: number): Promise<ModelOut | null> {
	const dv = new DataView(ab), ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true), fmt = dv.getUint32(28, true);
	const J = jsonAt(ab, 32, ftJ), bin = new Uint8Array(ab, 32 + ftJ, ftB);
	const n = Math.min(J.INSTANCES_LENGTH! | 0, maxInstances);
	if (!n) return null;
	const rtc = J.RTC_CENTER || [0, 0, 0];
	let P = ftValue(J, bin, "POSITION", n), qo: number[] | null | undefined = null, qs: number[] | null | undefined = null;
	if (!P) { P = ftValue(J, bin, "POSITION_QUANTIZED", n, Uint16Array); qo = J.QUANTIZED_VOLUME_OFFSET; qs = J.QUANTIZED_VOLUME_SCALE; }
	if (!P) return null;
	const UP = ftValue(J, bin, "NORMAL_UP", n), RIGHT = ftValue(J, bin, "NORMAL_RIGHT", n), S = ftValue(J, bin, "SCALE", n, Float32Array, 1), SN = ftValue(J, bin, "SCALE_NON_UNIFORM", n);
	const places: Array<{ L: Float64Array; t: number[] }> = [];
	for (let i = 0; i < n; i++) {
		let x = P[i*3], y = P[i*3+1], z = P[i*3+2];
		if (qo) { x = qo[0] + x / 65535 * qs![0]; y = qo[1] + y / 65535 * qs![1]; z = qo[2] + z / 65535 * qs![2]; }
		const e = apply(M, [x + rtc[0], y + rtc[1], z + rtc[2]]);
		let R: Float64Array;   // インスタンスの向き（列＝右・上・前）
		if (UP && RIGHT) { const u = [UP[i*3], UP[i*3+1], UP[i*3+2]], r = [RIGHT[i*3], RIGHT[i*3+1], RIGHT[i*3+2]], f = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]]; R = m3mul(M.L, Float64Array.of(...r, ...u, ...f)); }
		else if (J.EAST_NORTH_UP) R = enuAt(e);
		else R = Float64Array.from(M.L);
		const sx = SN ? SN[i*3] : S ? S[i] : 1, sy = SN ? SN[i*3+1] : S ? S[i] : 1, sz = SN ? SN[i*3+2] : S ? S[i] : 1;
		places.push({ L: m3mul(R, Float64Array.of(sx, 0, 0, 0, sy, 0, 0, 0, sz)), t: e });
	}
	let glb: ArrayBuffer;
	if (fmt === 1) glb = ab.slice(32 + ftJ + ftB + btJ + btB);
	else { const uri = stripNul(td.decode(new Uint8Array(ab, 32 + ftJ + ftB + btJ + btB))).trim(); const r = await fetchFor(opts.baseUri, opts.fetchOpts)(new URL(uri, opts.baseUri).href, { credentials: "omit" }); if (!r.ok) throw new Error(`i3dm glTF HTTP ${r.status}`); glb = await r.arrayBuffer(); }
	return decodeModel(glb, { baseUri: opts.baseUri, textures: opts.textures, fetchOpts: opts.fetchOpts, ...opts.gOpt, tile: { places, rtc: [0, 0, 0], baseH: opts.baseH, points: true } });
}

// 中身一つ → { batches, points, stats }（null＝描く物なし）
// ground＝"terrain"：三角形は PLATEAU と同じ「連結成分ごとに最低点で接地」（呼び手は地形へ持ち上げて置く）＝建物の tileset 向け。既定＝絶対高さ（写真測量の街並み・点群）
export async function decodeTile3D(ab: ArrayBuffer, { transform, baseUri, baseH = 0, textures = true, maxInstances = 5000, ground = "absolute", featureIdSet = 0, mc = false, splats = false, voxels = false, fetchOpts = null }: Tile3DOpts = {}): Promise<Tile3DOut| null> {
	const M = splitM4(transform || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	const out: Tile3DOut = { batches: [], points: [], splats: [], voxels: [], stats: { triangles: 0, points: 0, splats: 0, splatPoints: 0, voxels: 0, voxelsSkipped: 0 } };
	const gOpt = ground === "terrain" ? { ground: "each", mc } : { mc }, bH = ground === "terrain" ? null : baseH;   // 接地＝baseH を渡さない（decodeModel が成分ごとの最低点を使う）
	const merge = (r: ((Omit<Partial<ModelOut>, "points"> & { points?: ModelPoints | PointsOut | null }) | (PointsOut & { batches?: undefined; stats?: undefined; points?: undefined; splats?: undefined; voxels?: undefined })) | null) => {
		if (!r) return;
		if (r.batches?.length) { out.batches.push(...r.batches); out.stats.triangles += r.stats?.triangles || 0; }
		if (r.stats?.gltf?.extensions && !out.stats.extensions) out.stats.extensions = r.stats.gltf.extensions;   // 根の拡張（NGA_gpm_local 等）＝Cesium の content.getExtension
		if (r.stats?.gltf?.copyright) (out.stats.copyright ??= []).includes(r.stats.gltf.copyright) || out.stats.copyright!.push(r.stats.gltf.copyright);   // glTF の asset.copyright（W8）＝tileset の出典を集める
		if (r.splats?.length) { out.splats.push(...r.splats); out.stats.splats += r.stats?.splats || 0; }
		out.stats.splatPoints += r.stats?.splatPoints || 0;
		if (r.voxels?.length) { out.voxels.push(...r.voxels); out.stats.voxels += r.voxels.length; }
		out.stats.voxelsSkipped += r.stats?.voxelsSkipped || 0;
		const p = r.points && !(r.points as PointsOut).pos ? pointsOut(r.points as ModelPoints, baseH) : r.points as PointsOut | null | undefined;   // decodeModel の点（経緯度）は形を揃える
		if (p) { out.points.push(p); out.stats.points += p.n; }
		if ((r as PointsOut).pos && (r as PointsOut).n) { out.points.push(r as PointsOut); out.stats.points += (r as PointsOut).n; }
	};
	const one = async (buf: ArrayBuffer): Promise<void> => {
		const magic = magicOf(buf);
		if (magic === "b3dm") {
			const dv = new DataView(buf), ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
			const J = jsonAt(buf, 28, ftJ);
			const glb = buf.slice(28 + ftJ + ftB + btJ + btB);
			const nB = J.BATCH_LENGTH! | 0, BT = nB && btJ ? jsonAt(buf, 28 + ftJ + ftB, btJ) : null;   // batch table（W7）＝_BATCHID の地物の属性（JSON の配列＋binary 参照）
			const batchTable = BT ? { json: BT, bin: btB ? new Uint8Array(buf, 28 + ftJ + ftB + btJ, btB) : null, count: nB } : null;
			merge(await decodeModel(glb, { baseUri, textures, fetchOpts, ...gOpt, featureIdSet, tile: { places: [M], rtc: J.RTC_CENTER || null, baseH: bH, points: true, splats, voxels, batchTable } }));
		} else if (magic === "i3dm") merge(await decodeI3dm(buf, M, { baseUri, textures, baseH: bH, gOpt, fetchOpts }, maxInstances));   // ground も b3dm と同じく（旧＝渡さず terrain でも絶対高さ＝地形の上に浮いた）
		else if (magic === "pnts") merge(await decodePnts(buf, M, baseH));
		else if (magic === "cmpt") {
			const dv = new DataView(buf), nT = dv.getUint32(12, true);
			let off = 16;
			for (let k = 0; k < nT && off + 12 <= buf.byteLength; k++) { const len = new DataView(buf, off).getUint32(8, true); await one(buf.slice(off, off + len)); off += len; }
		} else if (magic === "glTF" || new Uint8Array(buf, 0, 1)[0] === 0x7b) merge(await decodeModel(buf, { baseUri, textures, fetchOpts, ...gOpt, featureIdSet, tile: { places: [M], rtc: null, baseH: bH, points: true, splats, voxels } }));   // glb / glTF(JSON)＝3D Tiles 1.1
		else if (magic === "geom") { const g = decodeGeom(buf, transform); if (g) (out.volumes ??= []).push(g); }   // 分類用の立体（箱・円柱・楕円体・球）＝描くのは main（分類の柱）
		else throw new Error(`unknown tile content "${magic}"`);
	};
	await one(ab);
	return out.batches.length || out.points.length || out.splats.length || out.voxels.length || out.volumes?.length || out.stats.voxelsSkipped ? out : null;   // voxelsSkipped＝飛ばした格子だけのタイルも「描く物なし」で返す＝main が一度 warn する
}
