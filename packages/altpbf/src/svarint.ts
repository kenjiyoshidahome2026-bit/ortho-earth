// 標高の本体（packed SVarint の差分）→ 累積の Int16Array（format.ts の decode が呼ぶ）。高速化 段 3・2026-10-16。
// 3 通りの読みを持ち、どれも同じ値を出す（tests/svarint.mjs が fuzz で照合）：
//   simd   ＝wasm SIMD128（16 バイト続けて 1 バイトの varint なら 16 値ずつ）。Chrome 91・Firefox 89・Safari 16.4・Node 16.4 以降
//   scalar ＝wasm（SIMD なし）。SIMD の無い wasm 環境
//   js     ＝この下の svarintJS。wasm が使えない環境（CSP で wasm の compile が止められた頁など）
// wasm は wasm/src/lib.rs を wasm/build.sh で焼いて src/svarint-wasm.ts に埋めた物（1 KB 前後＝同期 compile でよい大きさ）。
// 入力は 1 MiB ずつ wasm の memory へ写す＝memory は 4 MiB 弱で止まる（R10 1 枚を丸ごと置くと 17 MB が worker に居座る）。
// 戻り＝値の数（終わりの位置は svarintPos）。32 bit を超える varint・バッファの外へ読む切れた入力は −1＝呼び手が Pbf の読みでやり直す。
import { SCALAR_WASM, SIMD_WASM } from "./svarint-wasm.ts";

export type SvarintKind = "simd" | "scalar" | "js";
export let svarintPos = 0;

const CHUNK = 1 << 20, SMALL = 4096;   // SMALL 未満の本体は JS（写しと呼びの手間の方が大きい）
interface Kernel { run(inp: number, len: number, out: number, last: number, sum: number): number; pos(): number; sum(): number; u8: () => Uint8Array; i16: (at: number, n: number) => Int16Array; IN: number; OUT: number }
const kernels: { [k in "simd" | "scalar"]?: Kernel | null } = {};

function b64(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s), u = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
	return u;
}
function kernel(kind: "simd" | "scalar"): Kernel | null {
	if (kind in kernels) return kernels[kind]!;
	let k: Kernel | null = null;
	try {
		const bytes = b64(kind === "simd" ? SIMD_WASM : SCALAR_WASM);
		if (WebAssembly.validate(bytes)) {
			const x = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as { memory: WebAssembly.Memory; __heap_base: WebAssembly.Global; sv_run: Kernel["run"]; sv_pos: () => number; sv_sum: () => number };
			const IN = (x.__heap_base.value + 15) & ~15, OUT = IN + CHUNK + 16, need = OUT + CHUNK * 2 + 16, mem = x.memory;
			if (mem.buffer.byteLength < need) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
			k = { run: x.sv_run, pos: x.sv_pos, sum: x.sv_sum, u8: () => new Uint8Array(mem.buffer), i16: (at, n) => new Int16Array(mem.buffer, at, n), IN, OUT };
		}
	} catch { k = null; }   // wasm を許さない CSP・古い engine＝JS で読む
	return (kernels[kind] = k);
}

/** この環境で使える読み（速い順） */
export function svarintKinds(): SvarintKind[] {
	return [...(["simd", "scalar"] as const).filter(k => kernel(k)), "js"];
}

/** buf[pos..end) の packed SVarint を累積して out へ（out より多い値は数えるだけ＝Int16Array の範囲外の代入と同じ） */
export function svarintRun(buf: Uint8Array, pos: number, end: number, out: Int16Array, kind?: SvarintKind): number {
	if (end > buf.length) return -1;
	const k = kind === "js" || (!kind && end - pos < SMALL) ? null : kind ? kernel(kind) : (kernel("simd") || kernel("scalar"));
	if (!k) { if (kind && kind !== "js") throw new Error(`svarint: ${kind} は使えない`); return svarintJS(buf, pos, end, out); }
	let i = 0, sum = 0;
	while (pos < end) {
		const len = Math.min(CHUNK, end - pos), last = pos + len === end ? 1 : 0;
		k.u8().set(buf.subarray(pos, pos + len), k.IN);
		const n = k.run(k.IN, len, k.OUT, last, sum);
		if (n < 0) return -1;
		const room = Math.min(n, out.length - i);
		if (room > 0) out.set(k.i16(k.OUT, room), i);
		i += n; pos += k.pos(); sum = k.sum();
	}
	svarintPos = pos;
	return i;
}

// 32 bit に収まる varint だけを 32bit 整数で解く（zigzag＝(v>>>1)^-(v&1)・累積は |0 で折り返す＝Int16 への格納は 2^16 を法に同じ値）。
// Pbf.readSVarint を値ごとに呼ぶより 2〜3 倍速い（R10 2400² で 56 → 19ms・急な地形で 94 → 41ms・scripts/bench-decode.mjs）
function svarintJS(buf: Uint8Array, pos: number, end: number, out: Int16Array): number {
	let sum = 0, i = 0;
	while (pos < end) {
		let b = buf[pos++], v = b & 0x7f;
		if (b & 0x80) { b = buf[pos++]; v |= (b & 0x7f) << 7;
			if (b & 0x80) { b = buf[pos++]; v |= (b & 0x7f) << 14;
				if (b & 0x80) { b = buf[pos++]; v |= (b & 0x7f) << 21;
					if (b & 0x80) { b = buf[pos++]; v |= (b & 0x0f) << 28; if (b & 0xf0) return -1; } } } }
		sum = (sum + ((v >>> 1) ^ -(v & 1))) | 0;
		out[i++] = sum;
	}
	if (pos > buf.length) return -1;
	svarintPos = pos;
	return i;
}
