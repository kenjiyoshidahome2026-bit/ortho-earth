// 点群の保管の詰め物（純関数・node の検定 tests/t-pc-pack.mjs）＝読んだ点（map.readPointCloud の PointCloudDump）と、変換した splat の段（@ortho-earth/splat の CloudData）を
// 1 つの ArrayBuffer に詰める／戻す。器（OPFS／IndexedDB）は pc-cache.ts。
// 形＝"OEPC" 4B ＋ 見出しの長さ u32 ＋ 見出し（JSON＝型つきの配列の並びと、配列でない値）＋ 配列（8 B 揃え）。配列の型は Float32／Uint8／Uint16／Uint32。
// 鍵＝cacheKey(...)：points は（元・上限）ごと、cloud は（元・上限・色・粗さ・不透明度）ごと。版（V）を上げれば古い物は当たらない（形を変えた時）。

const MAGIC = 0x43504f45;   // "OEPC" little endian
export const PACK_VERSION = 1;
type Arr = Float32Array | Uint8Array | Uint16Array | Uint32Array;
const KIND: Record<string, (b: ArrayBuffer, o: number, n: number) => Arr> = {
	f32: (b, o, n) => new Float32Array(b, o, n), u8: (b, o, n) => new Uint8Array(b, o, n), u16: (b, o, n) => new Uint16Array(b, o, n), u32: (b, o, n) => new Uint32Array(b, o, n),
};
const kindOf = (a: Arr): string => a instanceof Float32Array ? "f32" : a instanceof Uint8Array ? "u8" : a instanceof Uint16Array ? "u16" : a instanceof Uint32Array ? "u32" : "";
const align8 = (n: number) => (n + 7) & ~7;

/** 入れ子のオブジェクト（配列は typed array だけ）→ 1 つの ArrayBuffer。配列は見出しに { $: kind, n, o } で残し、他は JSON のまま */
export function pack(obj: unknown): ArrayBuffer {
	const arrs: Arr[] = [];
	let at = 0;
	const walk = (v: unknown): unknown => {
		if (ArrayBuffer.isView(v)) {
			const a = v as Arr, k = kindOf(a); if (!k) throw new TypeError(`pack: unsupported array ${a.constructor.name}`);
			const o = at; at = align8(at + a.byteLength); arrs.push(a);
			return { $: k, n: a.length, o };
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	const head = new TextEncoder().encode(JSON.stringify(walk(obj)));
	const base = align8(8 + head.length), out = new ArrayBuffer(base + at), u8 = new Uint8Array(out), dv = new DataView(out);
	dv.setUint32(0, MAGIC, true); dv.setUint32(4, head.length, true); u8.set(head, 8);
	let o = base;
	for (const a of arrs) { u8.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o); o = align8(o + a.byteLength); }
	return out;
}
/** pack の逆（配列は buffer の上の view＝コピーしない。worker へ transfer するなら slice() を） */
export function unpack<T = unknown>(buf: ArrayBuffer): T {
	const dv = new DataView(buf);
	if (buf.byteLength < 8 || dv.getUint32(0, true) !== MAGIC) throw new TypeError("unpack: not a packed point cloud");
	const hl = dv.getUint32(4, true), base = align8(8 + hl);
	const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const r = v as { $?: string; n?: number; o?: number };
			if (typeof r.$ === "string" && KIND[r.$] && typeof r.n === "number" && typeof r.o === "number") return KIND[r.$](buf, base + r.o, r.n);
			return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
		}
		return v;
	};
	return walk(head) as T;
}

/** 保管の鍵。src＝"s3:<key>"／"atami"、points は上限まで・cloud は見せ方まで */
export function cacheKey(kind: "points", src: string, maxPoints: number | "auto"): string;
export function cacheKey(kind: "cloud", src: string, maxPoints: number | "auto", style: { color: string; detail: number; opacity: number }): string;
export function cacheKey(kind: "points" | "cloud", src: string, maxPoints: number | "auto", style?: { color: string; detail: number; opacity: number }): string {
	const base = `${kind}:v${PACK_VERSION}:${encodeURIComponent(src)}:${maxPoints}`;
	return kind === "points" ? base : `${base}:${style!.color}:${style!.detail}:${Math.round(style!.opacity * 100)}`;
}
/** 鍵から元（src）を戻す（一覧の表示用） */
export const srcOfKey = (key: string): string | null => { const m = /^(?:points|cloud):v\d+:([^:]*):/.exec(key); return m ? decodeURIComponent(m[1]) : null; };
