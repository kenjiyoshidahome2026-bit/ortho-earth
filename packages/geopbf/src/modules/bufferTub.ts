import { thenMap } from "./utility.ts";

const pipe = async(q: ArrayBuffer, filter: ReadableWritablePair<Uint8Array, BufferSource>): Promise<ArrayBuffer> => new Response(new Blob([q]).stream().pipeThrough(filter)).arrayBuffer();
const enc = (q: ArrayBuffer): Promise<ArrayBuffer> => pipe(q, new CompressionStream("deflate-raw"));
const dec = (q: ArrayBuffer): Promise<ArrayBuffer> => pipe(q, new DecompressionStream("deflate-raw"));

/** 同じ中身の ArrayBuffer を 1 つにまとめる台帳＝[buffer, 登録順の id] をバイト列の辞書順で持つ */
type TubEntry = [ArrayBuffer, number];

// bufferTub: collect and compress ArrayBuffers, deduplicated and indexed.
export class bufferTub {
	tub: TubEntry[];
	constructor() { this.tub = []; }
	set(q: unknown): number | undefined { if (q instanceof ArrayBuffer) return abset(this.tub, q); return undefined; }
	async close(): Promise<(ArrayBuffer | void)[]> { const a = this.tub.sort((p, q) => p[1] - q[1]).map(t => t[0]); this.tub = [];
		return thenMap(a, enc);
	}
}
export class readBufs {
	tub: ArrayBufferView[];
	constructor() { this.tub = []; }
	set(q: ArrayBufferView): void { this.tub.push(q); }
	async close(): Promise<(ArrayBuffer | void)[]> { const tobuf = (v: ArrayBufferView | ArrayBuffer): ArrayBuffer => ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer : v;
		const a = this.tub.map(tobuf); this.tub = [];
		return thenMap(a, dec);
	}
}
function abcomp(buf1: ArrayBuffer, buf2: ArrayBuffer): number {
	if (buf1 === buf2) return 0;
	let d = buf2.byteLength - buf1.byteLength; if (d) return d;
	const v1 = new Uint8Array(buf1), v2 = new Uint8Array(buf2);
	for (let i = 0; i < v1.length; i++) {  d = v2[i] - v1[i]; if (d) return d;  }
	return 0;
}
function abset(a: TubEntry[], buf: ArrayBuffer): number { const len = a.length;
	if (len === 0) { a[0] = [buf, 0]; return 0; }
	return (function cmp(m0: number, m1: number): number {
		const mid = (m0 + m1) >>> 1;
		const v = abcomp(a[mid][0], buf);
		if (!v) return a[mid][1];
		if (m0 >= m1) {
			const idx = v > 0 ? mid + 1 : mid;
			a.splice(idx, 0, [buf, len]);
			return len;
		}
		return v > 0 ? cmp(mid + 1, m1) : cmp(m0, mid - 1);
	})(0, len - 1);
}
