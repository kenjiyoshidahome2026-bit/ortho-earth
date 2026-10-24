// H3 のセルごとの人口（Kontur Population）の置き形＝「セルの id と人口」だけの小さな二進（/globe/hex・issue #310・2026-10-14）。
// 書く側＝scripts/kontur-h3.mjs（Kontur の gpkg を読んで焼く→ GitHub Pages の ortho-data/globe/h3/kontur-<日付>/ へ）・読む側＝hex.ts。
// DOM・地図無し＝node の検定（tests/t-hex-pop.mjs）が直接読む。
//
// 形（little endian）：
//   "H3P1" | u8 res | u8 parentRes | u16 0 | u32 nGroups | u32 nTotal
//   nGroups × { u32 hi, u32 lo（親セルの 64bit id）, u32 n }   … 親ごとの束（親の id 順）
//   nTotal × u16 childPos（親の中での子の番号＝h3 の cellToChildPos・res − parentRes ≤ 5 なら 7^5 = 16807 < 65536）
//   （4 バイト境界まで 0 埋め）
//   nTotal × u32 人口（Kontur の人口は整数）
// 64bit の id を文字列で持たない＝r4（7.1 万セル）で 428KB・gzip で更に小さい。r6 は res 1 の親ごとに 1 本（501 本・最大 1.7 万セル）。
import { h3 } from "@ortho-earth/h3/core";

const MAGIC = 0x31503348;   // "H3P1"
const HEAD = 16, GROUP = 12;

// rows＝[[cell, pop], …]（iterable）→ Uint8Array
export function encodeHexPop(rows: Iterable<[string, number | string]>, { parentRes = 0 } = {}) {
	const groups = new Map<string, [number, number][]>();
	let res = -1;
	for (const [cell, pop] of rows) {
		const r = h3.getResolution(cell);
		if (res < 0) res = r; else if (r !== res) throw new Error(`hex-pop: mixed resolutions (${res} and ${r})`);
		const p = h3.cellToParent(cell, parentRes);
		(groups.get(p) ?? groups.set(p, []).get(p)!).push([h3.cellToChildPos(cell, parentRes), Math.max(0, Math.round(+pop || 0))]);
	}
	if (res < 0) res = parentRes;
	if (res - parentRes > 5) throw new Error(`hex-pop: res ${res} is more than 5 levels below parentRes ${parentRes}`);
	const keys = [...groups.keys()].sort();
	const nTotal = keys.reduce((a, k) => a + groups.get(k)!.length, 0);
	const posBytes = (nTotal * 2 + 3) & ~3;
	const u8 = new Uint8Array(HEAD + keys.length * GROUP + posBytes + nTotal * 4), dv = new DataView(u8.buffer);
	dv.setUint32(0, MAGIC, true); dv.setUint8(4, res); dv.setUint8(5, parentRes); dv.setUint32(8, keys.length, true); dv.setUint32(12, nTotal, true);
	let g = HEAD, pos = HEAD + keys.length * GROUP, pp = pos + posBytes;
	for (const k of keys) {
		const list = groups.get(k)!.sort((a, b) => a[0] - b[0]);
		const [lo, hi] = h3.h3IndexToSplitLong(k);
		dv.setUint32(g, hi >>> 0, true); dv.setUint32(g + 4, lo >>> 0, true); dv.setUint32(g + 8, list.length, true); g += GROUP;
		for (const [c, v] of list) { dv.setUint16(pos, c, true); pos += 2; dv.setUint32(pp, v, true); pp += 4; }
	}
	return u8;
}

// Uint8Array → { res, parentRes, cells: string[], pop: Uint32Array, parents: [{ id, n }] }
export function decodeHexPop(u8: Uint8Array | ArrayBuffer) {
	if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.byteLength < HEAD || dv.getUint32(0, true) !== MAGIC) throw new Error("hex-pop: not an H3P1 file");
	const res = dv.getUint8(4), parentRes = dv.getUint8(5), nGroups = dv.getUint32(8, true), nTotal = dv.getUint32(12, true);
	const posAt = HEAD + nGroups * GROUP, popAt = posAt + ((nTotal * 2 + 3) & ~3);
	if (popAt + nTotal * 4 > u8.byteLength) throw new Error("hex-pop: truncated");
	const cells: string[] = new Array(nTotal), pop = new Uint32Array(nTotal), parents: { id: string; n: number }[] = [];
	let i = 0;
	for (let k = 0; k < nGroups; k++) {
		const o = HEAD + k * GROUP, id = h3.splitLongToH3Index(dv.getUint32(o + 4, true), dv.getUint32(o, true)), n = dv.getUint32(o + 8, true);
		parents.push({ id, n });
		for (let j = 0; j < n; j++, i++) {
			cells[i] = h3.childPosToCell(dv.getUint16(posAt + i * 2, true), id, res);
			pop[i] = dv.getUint32(popAt + i * 4, true);
		}
	}
	return { res, parentRes, cells, pop, parents };
}

// 細かい段 → 粗い段（親へ足し上げ）。置くのは res 4 と res 6 だけ＝2・3 は r4 から、5 は r6 から作る
export function sumToParent(cells: string[], pop: ArrayLike<number>, res: number) {
	const out = new Map<string, number>();
	for (let i = 0; i < cells.length; i++) { const p = h3.cellToParent(cells[i], res); out.set(p, (out.get(p) || 0) + pop[i]); }
	return out;
}

// 入った物が gzip のままでも読む（Pages には gzip のまま置く＝Content-Encoding が付かずに来る。?data= の配り手が解いて送っても読める）
export async function bytesOf(res: Response) {

	const u8 = new Uint8Array(await res.arrayBuffer());
	if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
	return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
