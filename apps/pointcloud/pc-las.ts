// 読んだ点（map.readPointCloud の PointCloudDump）→ Unreal 向けの LAS 1.2（点の形式 2＝xyz・強度・分類・RGB・無圧縮・純関数＝node の検定 tests/t-pc-las.mjs）。
//   Unreal Engine 5 の LiDAR Point Cloud プラグインは PLY を読まない（LAS・LAZ・E57・XYZ）＝PLY と同じ点を LAS でも出す（docs/notes/unreal-roundtrip.md §4）。
//   位置＝錨からのメートルを LAS の素直な向き (E, N, U)（右手系・Z 上・m）。Unreal のプラグインが Y を反転し cm に直して (東, 南, 上) にする。
//   尺度 1 mm（int32 で ±2,147 km）。錨は VLR（user "orthoEarth"・record 1・JSON）に＝Unreal の Place が書き出しフォルダの錨（anchor.json）との差を足して置く。
//   重さ：1 点 26 B（PLY は 16 B）＝約 1.6 倍。LAZ（圧縮）はブラウザに符号器が無い＝出さない。
import type { PointCloudDump } from "@ortho-earth/globe";

export interface LasOptions { /** 書く点の上限（0＝全部）＝均等に間引く */ maxPoints?: number; /** VLR に残す出典 */ source?: string | null; /** 作成日（年と通日に）＝検定用 */ date?: Date }

export const LAS_ANCHOR_USER = "orthoEarth", LAS_ANCHOR_RECORD = 1;
const HEADER = 227, VLR_HEAD = 54, STRIDE = 26, SCALE = 0.001;

const ascii = (out: Uint8Array, o: number, s: string, len: number) => { for (let i = 0; i < len; i++) out[o + i] = i < s.length ? s.charCodeAt(i) & 0x7f : 0; };

/** PointCloudDump → LAS 1.2 のバイト列 */
export function dumpToLas(d: Pick<PointCloudDump, "n" | "anchor" | "pts" | "rgb" | "cls">, { maxPoints = 0, source = null, date = new Date() }: LasOptions = {}): Uint8Array {
	const step = maxPoints && d.n > maxPoints ? d.n / maxPoints : 1, n = step > 1 ? maxPoints : d.n;
	const idx = (k: number) => step > 1 ? Math.floor(k * step) : k;
	const vlr = new TextEncoder().encode(JSON.stringify({ anchor: { lon: d.anchor[0], lat: d.anchor[1], height: d.anchor[2], datum: "orthometric" }, frame: "enu", units: "m", ...(source ? { source } : {}) }));
	const offPts = HEADER + VLR_HEAD + vlr.length;
	const out = new Uint8Array(offPts + n * STRIDE), dv = new DataView(out.buffer);

	// 範囲（尺度で丸めた後の値＝読み手が検める）
	const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let k = 0; k < n; k++) { const p = idx(k) * 3; for (let a = 0; a < 3; a++) { const v = Math.round(d.pts[p + a] / SCALE) * SCALE; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; } }
	if (!n) mn.fill(0), mx.fill(0);

	ascii(out, 0, "LASF", 4);
	out[24] = 1; out[25] = 2;
	ascii(out, 26, "OTHER", 32);
	ascii(out, 58, "ortho-earth pointcloud", 32);
	const y0 = Date.UTC(date.getUTCFullYear(), 0, 1);
	dv.setUint16(90, Math.floor((date.getTime() - y0) / 864e5) + 1, true); dv.setUint16(92, date.getUTCFullYear(), true);
	dv.setUint16(94, HEADER, true); dv.setUint32(96, offPts, true); dv.setUint32(100, 1, true);
	out[104] = 2; dv.setUint16(105, STRIDE, true); dv.setUint32(107, n, true); dv.setUint32(111, n, true);   // 点ごとに 1 返り＝第 1 返りの数＝n
	for (let a = 0; a < 3; a++) { dv.setFloat64(131 + a * 8, SCALE, true); dv.setFloat64(155 + a * 8, 0, true); dv.setFloat64(179 + a * 16, mx[a], true); dv.setFloat64(187 + a * 16, mn[a], true); }

	let o = HEADER;   // VLR
	ascii(out, o + 2, LAS_ANCHOR_USER, 16); dv.setUint16(o + 18, LAS_ANCHOR_RECORD, true); dv.setUint16(o + 20, vlr.length, true); ascii(out, o + 22, "ortho-earth anchor (JSON)", 32);
	out.set(vlr, o + VLR_HEAD);

	o = offPts;
	for (let k = 0; k < n; k++) {
		const i = idx(k), p = i * 3;
		dv.setInt32(o, Math.round(d.pts[p] / SCALE), true); dv.setInt32(o + 4, Math.round(d.pts[p + 1] / SCALE), true); dv.setInt32(o + 8, Math.round(d.pts[p + 2] / SCALE), true);   // (E, N, U) のまま
		out[o + 14] = 0b00001001;   // 返り 1 / 1
		out[o + 15] = d.cls ? d.cls[i] & 31 : 0;
		const r = d.rgb ? d.rgb[p] : 255, g = d.rgb ? d.rgb[p + 1] : 255, b = d.rgb ? d.rgb[p + 2] : 255;
		dv.setUint16(o + 20, r * 257, true); dv.setUint16(o + 22, g * 257, true); dv.setUint16(o + 24, b * 257, true);
		o += STRIDE;
	}
	return out;
}
