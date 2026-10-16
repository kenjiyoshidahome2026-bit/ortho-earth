// 3D Tiles 1.1 の implicit tiling（subtree）を読む純関数（2026-10-16・DOM なし＝node の検定 tests/tiles3d-implicit.mjs が読む）。
//   tileset.json の implicitTiling（と 1.0 の 3DTILES_implicit_tiling 拡張）を揃え、subtree（バイナリ "subt"／JSON）を解いて
//   availability（タイル・content・子 subtree）を引けるようにする。木の歩きと読み込みは gadgets/tiles3d.ts（選びは今の walk に乗る）。
// 並び＝段ごとに Morton 順（子の番号の bit0＝x・bit1＝y・bit2＝z）・段 L の始まり＝(N^L − 1)/(N − 1)・バイトの中は下位ビットから。
// 境界体積＝根の box／region を 2^level で割る（四分木は box の第 3 軸・region の高さを割らない）。sphere は仕様で不可。

/** tileset.json の境界体積（box＝中心＋半軸 3 本・region＝[w,s,e,n（rad）, h0, h1]・sphere＝[x,y,z,r]） */
export interface BoundingVolume { box?: number[]; region?: number[]; sphere?: number[] }
/** implicitTiling を読む欄（1.1）。1.0 拡張は maximumLevel（＝availableLevels − 1） */
export interface ImplicitTilingJson { subdivisionScheme?: string; subtreeLevels?: number; availableLevels?: number; maximumLevel?: number; subtrees?: { uri?: string } }
/** 揃えた implicit tiling（n＝子の数 4｜8） */
export interface ImplicitTiling { n: 4 | 8; subtreeLevels: number; availableLevels: number; subtreeUri: string }
/** タイルの座標（z は八分木だけ） */
export interface TileCoord { level: number; x: number; y: number; z?: number }
/** availability＝constant（全部 0／全部 1）か bits（ビット列）。count＝available の数（無ければ null） */
export interface Availability { constant: 0 | 1 | null; bits: Uint8Array | null; count: number | null; rank?: Uint32Array }
/** subtree の JSON（読む欄） */
interface AvailabilityJson { bitstream?: number; bufferView?: number; constant?: number; availableCount?: number }
export interface SubtreeJson {
	buffers?: Array<{ uri?: string; byteLength: number }>; bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number }>;
	tileAvailability?: AvailabilityJson; contentAvailability?: AvailabilityJson[] | AvailabilityJson; childSubtreeAvailability?: AvailabilityJson;
	propertyTables?: unknown[]; tileMetadata?: number; contentMetadata?: number[]; subtreeMetadata?: Record<string, unknown>;
}
/** 解いた subtree。bytesOf＝bufferView の中身（metadata の property table を解く時に） */
export interface Subtree { tile: Availability; content: Availability[]; child: Availability; json: SubtreeJson; bytesOf(view: number): Uint8Array }

const EXT = "3DTILES_implicit_tiling";
/** タイルの JSON → implicit tiling（無ければ null・形が崩れていれば例外） */
export function implicitOf(tile: { implicitTiling?: ImplicitTilingJson; extensions?: Record<string, unknown> } | null | undefined): ImplicitTiling | null {
	const ext = tile?.extensions?.[EXT] as ImplicitTilingJson | undefined, j = tile?.implicitTiling ?? ext;
	if (!j) return null;
	const n = j.subdivisionScheme === "QUADTREE" ? 4 : j.subdivisionScheme === "OCTREE" ? 8 : 0;
	if (!n) throw new Error(`implicitTiling: subdivisionScheme ${j.subdivisionScheme}`);
	const availableLevels = j.availableLevels ?? (j.maximumLevel != null ? j.maximumLevel + 1 : NaN), subtreeLevels = j.subtreeLevels!;
	if (!(Number.isInteger(subtreeLevels) && subtreeLevels >= 1)) throw new Error(`implicitTiling: subtreeLevels ${subtreeLevels}`);
	if (!(Number.isInteger(availableLevels) && availableLevels >= 1)) throw new Error(`implicitTiling: availableLevels ${availableLevels}`);
	if (typeof j.subtrees?.uri !== "string") throw new Error("implicitTiling: subtrees.uri");
	return { n, subtreeLevels, availableLevels, subtreeUri: j.subtrees.uri };
}

/** 段 L の始まり（subtree の中の通し番号）＝(N^L − 1)/(N − 1) */
export const levelOffset = (n: 4 | 8, level: number) => (n ** level - 1) / (n - 1);
/** subtree の段数 s の中のタイルの数 */
export const tilesIn = (n: 4 | 8, s: number) => levelOffset(n, s);
/** Morton 順（ビットを x・y（・z）の順に交互に）。座標は 2^31 未満・結果は 2^53 未満 */
export function morton(x: number, y: number, z?: number): number {
	let m = 0, b = 1;
	while (x || y || z) {
		m += (x & 1) * b; b *= 2; m += (y & 1) * b; b *= 2;
		if (z !== undefined) { m += (z & 1) * b; b *= 2; z >>>= 1; }
		x >>>= 1; y >>>= 1;
	}
	return m;
}
/** k 番目の子（Morton の子の番号 0..n−1）の座標 */
export const childCoord = (c: TileCoord, k: number): TileCoord => {
	const o: TileCoord = { level: c.level + 1, x: c.x * 2 + (k & 1), y: c.y * 2 + ((k >> 1) & 1) };
	if (c.z !== undefined) o.z = c.z * 2 + ((k >> 2) & 1);
	return o;
};
/** 根が r の subtree の中で、c（r の子孫・段の差 < subtreeLevels）の通し番号 */
export function indexIn(r: TileCoord, c: TileCoord, n: 4 | 8): number {
	const l = c.level - r.level, f = 2 ** l;
	return levelOffset(n, l) + morton(c.x - r.x * f, c.y - r.y * f, n === 8 ? c.z! - r.z! * f : undefined);
}
/** 根が r の subtree の最下段の下（段の差＝subtreeLevels）にある c の、子 subtree のビットの番号 */
export function childSubtreeIndex(r: TileCoord, c: TileCoord, n: 4 | 8): number {
	const f = 2 ** (c.level - r.level);
	return morton(c.x - r.x * f, c.y - r.y * f, n === 8 ? c.z! - r.z! * f : undefined);
}

/** ビット i が立っているか */
export const isAvailable = (a: Availability, i: number) => a.bits ? !!(a.bits[i >> 3] & (1 << (i & 7))) : a.constant === 1;
/** i より前の available の数（metadata の行番号）。constant 1 なら i・bits はバイトごとの累積を初回に作る */
export function rankOf(a: Availability, i: number): number {
	if (!a.bits) return a.constant === 1 ? i : 0;
	if (!a.rank) { const r = new Uint32Array(a.bits.length + 1); for (let k = 0; k < a.bits.length; k++) r[k + 1] = r[k] + popcnt8(a.bits[k]); a.rank = r; }
	return a.rank[i >> 3] + popcnt8(a.bits[i >> 3] & ((1 << (i & 7)) - 1));
}
const popcnt8 = (v: number) => { v = v - ((v >> 1) & 0x55); v = (v & 0x33) + ((v >> 2) & 0x33); return (v + (v >> 4)) & 0x0f; };

/** テンプレート URI の {level}・{x}・{y}・{z} を置き換える（未知の {…} はそのまま） */
export const expandUri = (tpl: string, c: TileCoord) => tpl.replace(/\{(level|x|y|z)\}/g, (_, k: "level" | "x" | "y" | "z") => String(c[k] ?? 0));

/** タイルの幾何誤差＝根の値 / 2^level */
export const geometricErrorAt = (rootGe: number, level: number) => rootGe / 2 ** level;
/** 根の境界体積 → c のタイルの境界体積（box／region。sphere は仕様で不可＝null） */
export function volumeAt(root: BoundingVolume, c: TileCoord, n: 4 | 8): BoundingVolume | null {
	const f = 2 ** c.level, oct = n === 8;
	if (root.box) {
		const b = root.box, s = [(2 * c.x + 1) / f - 1, (2 * c.y + 1) / f - 1, oct ? (2 * c.z! + 1) / f - 1 : 0], k = [1 / f, 1 / f, oct ? 1 / f : 1];
		const box = [b[0], b[1], b[2]];
		for (let a = 0; a < 3; a++) for (let i = 0; i < 3; i++) box[i] += b[3 + a * 3 + i] * s[a];
		for (let a = 0; a < 3; a++) for (let i = 0; i < 3; i++) box.push(b[3 + a * 3 + i] * k[a]);
		return { box };
	}
	if (root.region) {
		const [w, s, e, nn, h0, h1] = root.region, dw = e >= w ? e - w : e - w + 2 * Math.PI, dn = nn - s, dh = h1 - h0;   // 日付変更線を跨ぐ region（w > e）
		const wrap = (v: number) => v > Math.PI ? v - 2 * Math.PI : v;
		const z = oct ? c.z! : 0, hf = oct ? f : 1;
		return { region: [wrap(w + dw * c.x / f), s + dn * c.y / f, wrap(w + dw * (c.x + 1) / f), s + dn * (c.y + 1) / f, h0 + dh * z / hf, h0 + dh * (z + 1) / hf] };
	}
	return null;
}

// ── subtree の読み込み
const td = new TextDecoder();
/** subtree を解く。src＝ファイルの中身（"subt" のバイナリか JSON の文字列／ArrayBuffer）か JSON の物。
 *  loadBuffer＝外部 buffer（uri つき）を取りに行く（uri は subtree の URL から相対・解決は呼び手） */
export async function parseSubtree(src: ArrayBuffer | SubtreeJson, tiling: ImplicitTiling, loadBuffer: ((uri: string) => Promise<ArrayBuffer>) | null = null): Promise<Subtree> {
	let json: SubtreeJson, bin: Uint8Array | null = null;
	if (src instanceof ArrayBuffer) {
		const u8 = new Uint8Array(src);
		if (u8.length >= 24 && td.decode(u8.subarray(0, 4)) === "subt") {
			const dv = new DataView(src), ver = dv.getUint32(4, true), jl = Number(dv.getBigUint64(8, true)), bl = Number(dv.getBigUint64(16, true));
			if (ver !== 1) throw new Error(`subtree: version ${ver}`);
			if (24 + jl + bl > u8.length) throw new Error("subtree: truncated");
			json = JSON.parse(td.decode(u8.subarray(24, 24 + jl)));
			if (bl) bin = u8.subarray(24 + jl, 24 + jl + bl);
		} else json = JSON.parse(td.decode(u8));
	} else json = src;
	const bufs = await Promise.all((json.buffers || []).map(async (b, i) => {
		let u8: Uint8Array;
		if (b.uri != null) { if (!loadBuffer) throw new Error(`subtree: buffer ${i} needs ${b.uri}`); u8 = new Uint8Array(await loadBuffer(b.uri)); }
		else { if (!bin) throw new Error(`subtree: buffer ${i} has no binary chunk`); u8 = bin; }
		if (u8.length < b.byteLength) throw new Error(`subtree: buffer ${i} too short`);
		return u8;
	}));
	const views = (json.bufferViews || []).map((v, i) => {
		const b = bufs[v.buffer], o = v.byteOffset ?? 0;
		if (!b || o + v.byteLength > b.length) throw new Error(`subtree: bufferView ${i} out of range`);
		return b.subarray(o, o + v.byteLength);
	});
	const bytesOf = (view: number) => { const v = views[view]; if (!v) throw new Error(`subtree: bufferView ${view}`); return v; };
	const avail = (a: AvailabilityJson | undefined, nBits: number, what: string): Availability => {
		if (!a) throw new Error(`subtree: ${what} missing`);
		const view = a.bitstream ?? a.bufferView;   // 1.0 拡張は bufferView
		if (view != null) {
			const bits = bytesOf(view);
			if (bits.length * 8 < nBits) throw new Error(`subtree: ${what} bitstream too short`);
			return { constant: null, bits, count: a.availableCount ?? null };
		}
		if (a.constant === 0 || a.constant === 1) return { constant: a.constant, bits: null, count: a.availableCount ?? (a.constant ? nBits : 0) };
		throw new Error(`subtree: ${what} has neither bitstream nor constant`);
	};
	const nTiles = tilesIn(tiling.n, tiling.subtreeLevels), nKids = tiling.n ** tiling.subtreeLevels;
	const ca = json.contentAvailability, cas = ca == null ? [] : Array.isArray(ca) ? ca : [ca];
	return {
		tile: avail(json.tileAvailability, nTiles, "tileAvailability"),
		content: cas.map((a, i) => avail(a, nTiles, `contentAvailability ${i}`)),
		child: avail(json.childSubtreeAvailability, nKids, "childSubtreeAvailability"),
		json, bytesOf,
	};
}
