import { writeUvarint, zigzagEncode } from "../modules/varint.ts";
// convert/mvt.js ── Mapbox Vector Tile 2.1 の最小エンコーダ。protobuf ライタも自前（依存ゼロ＝worker がバンドラ無しで
// 読める）。1 タイル = 1 レイヤ。feature.id = fid。幾何はタイルローカル整数。環の向きは MVT 規則（外環＝測量公式の面積が
// 正・穴＝負）にここで揃える。復号（検定用）は mvt-decode.js。
//
// 速さの要点（NE 国境 57 万タイルのプロファイルより）：
//  ・文字列の UTF-8 化が最大の山（タイル毎に 130 キー＋値を TextEncoder に通していた）→ 文字列→バイト列をキャッシュ
//  ・タイルの大半は 1 feature ＝ キー表/値表/tags が feature 毎に固定 → 属性節を fid 毎に 1 回だけ符号化して再利用
//  ・finish() の複製は呼び出し側が内容ハッシュで重複を弾いてから（view を返し、複製は新規内容の時だけ）

/** 座標列（x0,y0,x1,y1,…）＝number[] か Int32Array/Float64Array */
export type Coords = ArrayLike<number>;
/** 属性値（Uint8Array は UTF-8 済みの文字列＝そのまま書く） */
export type TagValue = string | number | boolean | Uint8Array | null | undefined;
export type Tags = [string, TagValue][];
/** 幾何（type 1 → 点列 / 2 → 線の配列 / 3 → ポリゴン（環配列）の配列） */
export type MvtGeometry = Coords | Coords[] | Coords[][];
export interface MvtFeatureIn { id?: number; type: 1 | 2 | 3 | number; tags: Tags; geometry: MvtGeometry }
export interface MvtLayerIn { name: string; extent: number; features: MvtFeatureIn[] }
/** encodeAttrs の戻り＝fid 毎に 1 回だけ符号化した属性節 */
export interface EncodedAttrs { kv: Uint8Array; tags: number[] }

// ── 最小 protobuf ライタ ──
class W {
	buf: Uint8Array;
	pos: number;
	constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.pos = 0; }
	reset(): this { this.pos = 0; return this; }
	need(n: number): void { if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n)); b.set(this.buf.subarray(0, this.pos)); this.buf = b; } }
	varint(v: number): void { this.need(10); this.pos = writeUvarint(this.buf, this.pos, v); }
	tag(field: number, wt: number): void { this.varint((field << 3) | wt); }
	uint(field: number, v: number): void { this.tag(field, 0); this.varint(v); }
	sint(field: number, v: number): void { this.tag(field, 0); this.varint(zigzagEncode(v)); }
	double(field: number, v: number): void { this.tag(field, 1); this.need(8); new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.pos, v, true); this.pos += 8; }
	bytes(field: number, u8: Uint8Array): void { this.tag(field, 2); this.varint(u8.length); this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
	raw(u8: Uint8Array): void { this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }   // 符号化済みフィールド列をそのまま
	string(field: number, s: string): void { this.bytes(field, utf8(s)); }
	packed(field: number, arr: number[]): void {   // 非負 varint の packed
		let n = 0; for (let i = 0; i < arr.length; i++) { let v = arr[i]; do { n++; v = Math.floor(v / 128); } while (v > 0); }
		this.tag(field, 2); this.varint(n); this.need(n);
		for (let i = 0; i < arr.length; i++) { let v = arr[i]; while (v >= 0x80) { this.buf[this.pos++] = (v % 128) | 0x80; v = Math.floor(v / 128); } this.buf[this.pos++] = v; }
	}
	sub(): Uint8Array { return this.buf.subarray(0, this.pos); }
}
const wTile = new W(), wLayer = new W(), wFeat = new W(), wAttr = new W();

// 文字列 → UTF-8（キャッシュ。属性のキー/値は少数の文字列が何十万回も出る）
const enc = new TextEncoder();
let utf8Cache = new Map<string, Uint8Array>();
function utf8(s: string): Uint8Array {
	let b = utf8Cache.get(s);
	if (b === undefined) { if (utf8Cache.size > 200000) utf8Cache = new Map(); b = enc.encode(s); utf8Cache.set(s, b); }
	return b;
}

const zz = (v: number): number => (v << 1) ^ (v >> 31);
const cmd = (id: number, n: number): number => (id & 7) | (n << 3);

// 連続重複除去（環は閉じ点も落とす）。coords: 配列風（number[] / Int32Array）
function dedupe(a: Coords, ring: boolean): number[] {
	const out: number[] = [];
	for (let i = 0; i < a.length; i += 2) { const n = out.length; if (n && out[n - 2] === a[i] && out[n - 1] === a[i + 1]) continue; out.push(a[i], a[i + 1]); }
	if (ring) { const n = out.length; if (n >= 4 && out[0] === out[n - 2] && out[1] === out[n - 1]) out.length = n - 2; }
	return out;
}
export function signedArea2(r: Coords): number {   // 測量公式 ×2（y 下向きの座標系のまま）
	let s = 0; const n = r.length >> 1;
	for (let i = 0, j = n - 1; i < n; j = i++) s += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
	return s;
}
const reverse = (r: number[]): number[] => { const out: number[] = []; for (let i = r.length - 2; i >= 0; i -= 2) out.push(r[i], r[i + 1]); return out; };

// 幾何コマンド列を g に積む。空なら false
function geometryCommands(type: number, parts: MvtGeometry, g: number[]): boolean {
	let cx = 0, cy = 0;
	const push = (x: number, y: number): void => { g.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; };
	if (type === 1) {
		const p = dedupe(parts as Coords, false);
		if (!p.length) return false;
		g.push(cmd(1, p.length >> 1));
		for (let i = 0; i < p.length; i += 2) push(p[i], p[i + 1]);
		return true;
	}
	if (type === 2) {
		let any = false;
		for (const l0 of parts as Coords[]) {
			const l = dedupe(l0, false), n = l.length >> 1;
			if (n < 2) continue;
			any = true;
			g.push(cmd(1, 1)); push(l[0], l[1]);
			g.push(cmd(2, n - 1)); for (let i = 1; i < n; i++) push(l[i * 2], l[i * 2 + 1]);
		}
		return any;
	}
	let any = false;
	for (const rings of parts as Coords[][]) {   // parts = ポリゴンの配列・各ポリゴン = 環の配列（[0] 外環）
		let outerOk = false;
		for (let r = 0; r < rings.length; r++) {
			let ring = dedupe(rings[r], true);
			const n = ring.length >> 1;
			if (n < 3) { if (r === 0) break; continue; }
			const a2 = signedArea2(ring);
			if (a2 === 0) { if (r === 0) break; continue; }
			if ((r === 0) !== (a2 > 0)) ring = reverse(ring);
			if (r === 0) outerOk = true;
			g.push(cmd(1, 1)); push(ring[0], ring[1]);
			g.push(cmd(2, n - 1)); for (let i = 1; i < n; i++) push(ring[i * 2], ring[i * 2 + 1]);
			g.push(cmd(7, 1));
		}
		if (outerOk) any = true;
	}
	return any;
}

// 値 1 個の Value メッセージ（Uint8Array は UTF-8 済みの文字列＝そのまま書く）
function writeValue(V: W, v: TagValue): void {
	if (typeof v === "string") V.string(1, v);
	else if (v instanceof Uint8Array) V.bytes(1, v);
	else if (typeof v === "boolean") V.uint(7, v ? 1 : 0);
	else if (Number.isInteger(v) && Math.abs(v as number) < 2 ** 53) { if ((v as number) >= 0) V.uint(5, v as number); else V.sint(6, v as number); }
	else V.double(3, v as number);
}

// 1 feature 分の属性節を前計算：{ kv: レイヤの keys(3)/values(4) フィールド列, tags: 添字列 }（fid 毎に 1 回）
export function encodeAttrs(tags: Tags): EncodedAttrs {
	const A = wAttr.reset(), keyList: string[] = [], valList: TagValue[] = [], strs = new Map<TagValue, number>(), nums = new Map<TagValue, number>(), idx: number[] = [];
	let tIdx = -1, fIdx = -1;
	for (const [k, v] of tags) {
		if (v === null || v === undefined) continue;
		idx.push(keyList.length); keyList.push(k);
		let i: number;
		if (typeof v === "boolean") { if (v) { if (tIdx < 0) { tIdx = valList.length; valList.push(true); } i = tIdx; } else { if (fIdx < 0) { fIdx = valList.length; valList.push(false); } i = fIdx; } }
		else { const m = typeof v === "string" ? strs : nums; let j = m.get(v); if (j === undefined) { j = valList.length; m.set(v, j); valList.push(v); } i = j; }
		idx.push(i);
	}
	for (const k of keyList) A.string(3, k);
	for (const v of valList) { const V = wFeat.reset(); writeValue(V, v); A.bytes(4, V.sub()); }
	return { kv: A.sub().slice(), tags: idx };
}

const layerHead = (name: string, extent: number): W => { const L = wLayer.reset(); L.uint(15, 2); L.string(1, name); void extent; return L; };
const g: number[] = [];

// 1 feature だけのタイル（大半）＝属性節は fid 毎のキャッシュ（encodeAttrs）を貼るだけ。戻りは作業バッファの view（次の呼び出しまで有効）。
// feature が退化していれば null。
export function encodeSingle(name: string, extent: number, id: number, type: number, geometry: MvtGeometry, attr: EncodedAttrs): Uint8Array | null {
	g.length = 0;
	if (!geometryCommands(type, geometry, g)) return null;
	const L = layerHead(name, extent);
	const F = wFeat.reset();
	F.uint(1, id); F.packed(2, attr.tags); F.uint(3, type); F.packed(4, g);
	L.bytes(2, F.sub());
	L.raw(attr.kv);
	L.uint(5, extent);
	const T = wTile.reset(); T.bytes(3, L.sub());
	return T.sub();
}

// 汎用（複数 feature）。layer: { name, extent, features: [{ id, type: 1|2|3, tags: [[key, value], …], geometry }] }
//   geometry: type1 → 点列 / type2 → 線の配列 / type3 → ポリゴン（環配列）の配列。戻りは作業バッファの view か null（feature 無し）。
export function encodeTile(layer: MvtLayerIn): Uint8Array | null {
	const L = layerHead(layer.name, layer.extent);
	const keys = new Map<string, number>(), strs = new Map<TagValue, number>(), nums = new Map<TagValue, number>(), keyList: string[] = [], valList: TagValue[] = [];
	let tIdx = -1, fIdx = -1, written = 0;
	const keyIdx = (k: string): number => { let i = keys.get(k); if (i === undefined) { i = keyList.length; keys.set(k, i); keyList.push(k); } return i; };
	const valIdx = (v: TagValue): number => {
		if (typeof v === "boolean") { if (v) { if (tIdx < 0) { tIdx = valList.length; valList.push(true); } return tIdx; } if (fIdx < 0) { fIdx = valList.length; valList.push(false); } return fIdx; }
		const m = typeof v === "string" ? strs : nums;
		let i = m.get(v); if (i === undefined) { i = valList.length; m.set(v, i); valList.push(v); } return i;
	};
	for (const f of layer.features) {
		g.length = 0;
		if (!geometryCommands(f.type, f.geometry, g)) continue;   // 退化して空なら feature ごと書かない
		written++;
		const tags: number[] = [];
		for (const [k, v] of f.tags) { if (v === null || v === undefined) continue; tags.push(keyIdx(k), valIdx(v)); }
		const F = wFeat.reset();
		if (f.id !== undefined) F.uint(1, f.id);
		F.packed(2, tags);
		F.uint(3, f.type);
		F.packed(4, g);
		L.bytes(2, F.sub());
	}
	if (!written) return null;
	for (const k of keyList) L.string(3, k);
	for (const v of valList) { const V = wFeat.reset(); writeValue(V, v); L.bytes(4, V.sub()); }
	L.uint(5, layer.extent);
	const T = wTile.reset();
	T.bytes(3, L.sub());
	return T.sub();
}
