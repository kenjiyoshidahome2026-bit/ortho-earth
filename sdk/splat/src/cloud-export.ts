// 点群から作った splat の段（CloudData＝handle.read() の戻り・保管した物）の書き出し（2026-11-06・本人「SPZ / 3D Tiles の書き出しはぜひ」）。純関数＋gzip（CompressionStream＝ブラウザも node 18+ も）。
//   cloudToSpz(c, level)         → .spz（gzip 済み）＝1 つの段。SPZ に測地の置き場は無い＝錨（anchor）と ENU→ECEF の行列は spzPlacement(c) で別に持つ（@ortho-earth/splat の addData は origin / transform で受ける）
//   cloudTo3DTiles(c, opts)      → tileset.json ＋ level<L>.glb（KHR_gaussian_splatting ＋ _compression_spz_2・段ごとの tile・REPLACE・root の transform が ENU→ECEF）
//   zipStore(files)              → 無圧縮の .zip（ブラウザで 1 つのファイルとして落とす用・依存ゼロ）
import type { CloudData } from "./index.ts";
import { cloudLevelToSplatData, cloudTileset, cloudLevelGlb, enuToGltfAxes, enuToEcefTransform, type CloudLevel } from "./cloud.ts";
import { encodeSpzRaw } from "./formats.ts";

/** gzip（CompressionStream） */
export async function gzip(u8: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	if (typeof CompressionStream === "undefined") throw new Error("splat: gzip needs CompressionStream");
	const s = new Blob([u8 as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}
const levelOf = (c: CloudData, level: number): CloudLevel => { const L = c.levels[level]; if (!L) throw new RangeError(`splat: no level ${level} (the cloud has ${c.levels.length})`); return L; };

/** 1 つの段を .spz（gzip 済み・SH なし）に。level 0＝最も細かい。位置は錨からの東北上 m（spzPlacement で置く） */
export async function cloudToSpz(c: CloudData, level = 0, { frac = 12 }: { frac?: number } = {}): Promise<Uint8Array<ArrayBuffer>> {
	return gzip(encodeSpzRaw(cloudLevelToSplatData(levelOf(c, level)), { frac }));
}
/** .spz の置き場＝錨（[lon, lat, alt]）・addData の opts（upAxis "z"＝東北上のまま・origin＝錨）・ENU→ECEF の列優先 4×4 */
export function spzPlacement(c: CloudData): { anchor: [number, number, number]; addData: { kind: "splat"; origin: [number, number, number]; upAxis: "z"; altitude: "absolute" }; transform: number[] } {
	const a = c.anchor;
	return { anchor: [a[0], a[1], a[2]], addData: { kind: "splat", origin: [a[0], a[1], a[2]], upAxis: "z", altitude: "absolute" }, transform: enuToEcefTransform(a[0], a[1], a[2]) };
}

/** 書き出した 1 本 */
export interface ExportFile { name: string; bytes: Uint8Array }
/** 3D Tiles（1.1・glTF の KHR_gaussian_splatting ＋ KHR_gaussian_splatting_compression_spz_2）＝tileset.json ＋ 段ごとの glb。prefix＝glb の名（level0.glb …）・gePerCell＝geometricError＝セル × これ */
export async function cloudTo3DTiles(c: CloudData, { prefix = "level", gePerCell = 16, frac = 12 }: { prefix?: string; gePerCell?: number; frac?: number } = {}): Promise<ExportFile[]> {
	if (!c.levels.length) throw new Error("splat: no levels");
	const files: ExportFile[] = [{ name: "tileset.json", bytes: new TextEncoder().encode(JSON.stringify(cloudTileset(c.levels, c.anchor, { prefix, gePerCell }))) }];
	for (let i = 0; i < c.levels.length; i++) {
		const d = enuToGltfAxes(cloudLevelToSplatData(c.levels[i]));
		files.push({ name: `${prefix}${i}.glb`, bytes: cloudLevelGlb(d, await gzip(encodeSpzRaw(d, { frac }))) });
	}
	return files;
}

// ── 無圧縮の ZIP（sdk/glbconv の zip.ts と同じ形・依存を増やさないためここにも） ──
const enc = new TextEncoder();
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export const crc32 = (b: Uint8Array): number => { let c = -1; for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 255]; return (c ^ -1) >>> 0; };
/** files → .zip（store） */
export function zipStore(files: ExportFile[]): Uint8Array<ArrayBuffer> {
	const parts: Uint8Array[] = [], cd: Array<{ name: Uint8Array; crc: number; size: number; off: number }> = [];
	const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
	let off = 0;
	for (const f of files) {
		const name = enc.encode(f.name), bytes = f.bytes, lfh = new Uint8Array(30 + name.length), dv = new DataView(lfh.buffer), crc = crc32(bytes);
		dv.setUint32(0, 0x04034B50, true); dv.setUint16(4, 20, true); dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true);
		dv.setUint32(14, crc, true); dv.setUint32(18, bytes.length, true); dv.setUint32(22, bytes.length, true); dv.setUint16(26, name.length, true);
		lfh.set(name, 30); parts.push(lfh, bytes); cd.push({ name, crc, size: bytes.length, off }); off += lfh.length + bytes.length;
	}
	const cdStart = off;
	for (const e of cd) {
		const h = new Uint8Array(46 + e.name.length), dv = new DataView(h.buffer);
		dv.setUint32(0, 0x02014B50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(12, dosTime, true); dv.setUint16(14, dosDate, true);
		dv.setUint32(16, e.crc, true); dv.setUint32(20, e.size, true); dv.setUint32(24, e.size, true); dv.setUint16(28, e.name.length, true); dv.setUint32(42, e.off, true);
		h.set(e.name, 46); parts.push(h); off += h.length;
	}
	const eocd = new Uint8Array(22), dv = new DataView(eocd.buffer);
	dv.setUint32(0, 0x06054B50, true); dv.setUint16(8, cd.length, true); dv.setUint16(10, cd.length, true); dv.setUint32(12, off - cdStart, true); dv.setUint32(16, cdStart, true);
	parts.push(eocd);
	const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
	let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
