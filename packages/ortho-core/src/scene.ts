// タイル結合（merge）の純関数。worker でもメインでも使える。
// order の各タイルの geometry(ops/buildings) を style層(li)ごとに1バッファへ結合し、共通 origin へ再ベース。
// geomOf(key) → { ops, buildings } | null（geometry の供給元。cache でも worker の Map でも）。

import type { PaintZoom } from "./paintzoom.ts";

/** 塗りの op（build.ts が作る・タイル単体は idx が Uint16・結合後は Uint32） */
// fx＝層の画面効果（S-P1-4/5・build.ts の layerFx）＝[tx, ty, anchor, blur, rel]・持つ層だけ
// pat＝fill-pattern の画像の名前（S-P1-4/5・build.ts の fillPatternOf）・持つ層だけ
// pz＝ズーム連続の差し替えの式（V-Ph3＝S-P1-2・paintzoom.ts の layerPaintZoom）・持つ層だけ
export interface FillOp { kind: "fill"; li: number; id?: string; pos: Float32Array; col: Uint8Array; idx: Uint16Array | Uint32Array; fx?: number[]; pat?: string; pz?: PaintZoom }
/** 線の op（off＝line-offset の [off, tS, tE]×線分・持つ層だけ） */
// jf＝線の端と継ぎ（S-P1-1・2026-10-22）：線分ごとの旗（build.ts の JF_*＝始点を前の線分と継ぐ・終点を次の線分と継ぐ・閉じた環の継ぎ目）。
// 継ぐ相手は並びのすぐ前後の線分＝線分レコード（P1・P2）から読む（隣の点を別に持たない）。cj＝層の端と継ぎの種類（build.ts の lineCapJoin）。
// 0（丸い端・丸い継ぎ）の層は jf を持たない＝従来の capsule
// dist＝シェーダで描く破線（S-P1-3・2026-10-22）の始点までの線に沿う距離（z24 の px・build.ts の DASH_GPU_MAX の所）・dash＝模様（線幅の倍数・MapLibre の並びのまま）・dz＝作ったタイルの z
export interface LineOp { kind: "line"; li: number; id?: string; P1: Float32Array; P2: Float32Array; col: Uint8Array; half: Float32Array; off?: Float32Array | null; jf?: Uint8Array | null; cj?: number; dist?: Float32Array | null; dash?: number[]; dz?: number; fx?: number[]; pz?: PaintZoom }
export type DrawOp = FillOp | LineOp;
/** 建物の押し出し（buildings.ts）＝xyz（z＝高さ m）・面の陰影・足元の xy */
export interface BuildingsGeom { pos: Float32Array; shade: Float32Array; anchor: Float32Array }
/** geomOf(key) が返すタイルの幾何 */
export interface TileGeom { ops?: DrawOp[] | null; buildings?: BuildingsGeom | null }
/** order の 1 件＝タイル鍵と、その ops の原点（経緯度） */
export interface MergeOrderItem { key: string; origin: ArrayLike<number> }
export interface MergeOptions { origin?: ArrayLike<number> | null; hidden?: Set<number> | null }
export interface MergedScene { origin: ArrayLike<number>; layers: DrawOp[]; buildings: BuildingsGeom | null }

// 図郭外フォールバック水域（build.js buildEmptySeaOps）の擬似 li 帯：擬似li = SEA_FB_BASE + 実li。
// 実在の style 層(0..n)と衝突せず、li 昇順ソートで実層より先＝全レイヤの下に敷かれ、かつ帯内では
// 実li の相対順（water → water-hi）を保つ。renderer はこの帯を見て u_seaGate=1（標高h>0をdiscard）を立てる。
// merge の hidden（チップ消灯）判定は seaFbReal で実li に還元＝水系チップの点消灯にフォールバックも追随する。
export const SEA_FB_BASE = -1000;
export const seaFbReal = (li: number): number | null => li < -500 ? li - SEA_FB_BASE : null;   // 擬似→実li（非該当は null）

// LOD重複の線ゲート：order 内に「自分の子孫タイル」が居るタイル（＝blanket/祖先フォールバックの下敷き）の集合。
// 塗りは z 昇順の上塗りで隠れるが、線は加算的に二重描きされ「簡略化度の違う同じ高速道路が2本」になる
// ＝下敷きタイルの線は結合に組み込まない（そのタイルの塗りは残す＝空白は出さない）。
// 通常の cover（selectLOD）は重なりなし＝ゲートは無発動。発動するのは base の混成（毛布z4+粗z8+fallback）だけ。
export function coveredTiles(order: readonly { key: string }[]): Set<string> {
	const covered = new Set<string>();
	for (const o of order) {
		let [z, x, y] = o.key.split("/").map(Number);
		while (z > 0) { z--; x >>= 1; y >>= 1; const k = `${z}/${x}/${y}`; if (covered.has(k)) break; covered.add(k); }
	}
	return covered;
}

interface SizeEntry { kind: "fill" | "line"; fillN: number; idxN: number; lineN: number; off?: boolean; jf?: boolean; cj?: number; dash?: number[]; dz?: number; fx?: number[]; pat?: string; pz?: PaintZoom }
interface FillAcc { kind: "fill"; li: number; pos: Float32Array; col: Uint8Array; idx: Uint32Array; fx?: number[]; pat?: string; pz?: PaintZoom; pi: number; ci: number; ii: number }
interface LineAcc { kind: "line"; li: number; P1: Float32Array; P2: Float32Array; col: Uint8Array; half: Float32Array; off: Float32Array | null; jf: Uint8Array | null; cj: number; dist: Float32Array | null; dash?: number[]; dz?: number; fx?: number[]; pz?: PaintZoom; pi: number; ci: number; hi: number }

export function mergeTiles(order: readonly MergeOrderItem[], geomOf: (key: string) => TileGeom | null | undefined, opts: MergeOptions = {}): MergedScene {
	if (!order.length) return { origin: [0, 0], layers: [], buildings: null };
	const origin = opts.origin || order[0].origin;
	const hidden = opts.hidden || EMPTY;
	const lineOff = coveredTiles(order);   // 子孫に覆われる下敷きタイル＝線を伏せる（上のコメント参照）
	const tileOps: { ox: number; oy: number; ops: DrawOp[]; noLine: boolean }[] = [];
	const size = new Map<number, SizeEntry>();
	for (const { key, origin: to } of order) {
		const g = geomOf(key); if (!g || !g.ops) continue;
		tileOps.push({ ox: to[0] - origin[0], oy: to[1] - origin[1], ops: g.ops, noLine: lineOff.has(key) });
		for (const op of g.ops) {
			if (hidden.has(seaFbReal(op.li) ?? op.li)) continue;   // フォールバック水域は実liでチップ消灯判定
			if (op.kind === "line" && lineOff.has(key)) continue;
			let e = size.get(op.li); if (!e) { e = { kind: op.kind, fillN: 0, idxN: 0, lineN: 0 }; size.set(op.li, e); }
			if (op.fx) e.fx ??= op.fx;   // 層の画面効果（S-P1-4/5）＝最初に持つタイルの値（cj と同じ）
			if (op.pz) e.pz ??= op.pz;   // ズーム連続の式（V-Ph3＝S-P1-2）＝層で同じ
			if (op.kind === "fill" && op.pat) e.pat ??= op.pat;   // 模様の名前（同上）
			if (op.kind === "fill") { e.fillN += op.pos.length / 2; e.idxN += op.idx.length; } else { e.lineN += op.half.length; if (op.off) e.off = true; if (op.jf) { e.jf = true; e.cj ??= op.cj; } if (op.dist && !e.dash) { e.dash = op.dash; e.dz = op.dz; } }
		}
	}
	const buf = new Map<number, FillAcc | LineAcc>();
	for (const [li, e] of size) {
		// fill の index は結合後に頂点数が 65k を超え得るので常に Uint32（タイル単体は Uint16 で届く）
		buf.set(li, e.kind === "fill"
			? { kind: "fill", li, pos: new Float32Array(e.fillN * 2), col: new Uint8Array(e.fillN * 4), idx: new Uint32Array(e.idxN), fx: e.fx, pat: e.pat, pz: e.pz, pi: 0, ci: 0, ii: 0 }
			: { kind: "line", li, P1: new Float32Array(e.lineN * 2), P2: new Float32Array(e.lineN * 2), col: new Uint8Array(e.lineN * 4), half: new Float32Array(e.lineN), off: e.off ? new Float32Array(e.lineN * 3) : null, jf: e.jf ? new Uint8Array(e.lineN) : null, cj: e.cj ?? 0, dist: e.dash ? new Float32Array(e.lineN) : null, dash: e.dash, dz: e.dz, fx: e.fx, pz: e.pz, pi: 0, ci: 0, hi: 0 });   // off＝line-offset（#49）の [off, tS, tE]×線分・持つ層だけ・持たないタイルの分は 0。jf＝端と継ぎ（S-P1-1）の旗・持たないタイルの分は 0（端）・cj は最初に持つタイルの値（層の種類＝タイルで変わるのは zoom の式だけ）。dist＝破線（S-P1-3）の距離・持たないタイルの分は 0・模様は最初に持つタイルの値
	}
	for (const { ox, oy, ops, noLine } of tileOps) {
		for (const op of ops) {
			if (hidden.has(seaFbReal(op.li) ?? op.li)) continue;   // サイズ集計と同条件
			if (op.kind === "line" && noLine) continue;   // 下敷きタイルの線（サイズ集計と同条件）
			if (op.kind === "fill") {
				const m = buf.get(op.li) as FillAcc;
				const base = m.pi >> 1;   // このタイル分の頂点オフセット（index 再ベース用）
				const p = op.pos; let pi = m.pi; for (let i = 0; i < p.length; i += 2) { m.pos[pi++] = p[i] + ox; m.pos[pi++] = p[i + 1] + oy; } m.pi = pi;
				m.col.set(op.col, m.ci); m.ci += op.col.length;
				const ix = op.idx; let ii = m.ii; for (let i = 0; i < ix.length; i++) m.idx[ii++] = ix[i] + base; m.ii = ii;
			} else {
				const m = buf.get(op.li) as LineAcc;
				const P1 = op.P1, P2 = op.P2; let pi = m.pi;
				for (let i = 0; i < P1.length; i += 2) { m.P1[pi] = P1[i] + ox; m.P1[pi + 1] = P1[i + 1] + oy; m.P2[pi] = P2[i] + ox; m.P2[pi + 1] = P2[i + 1] + oy; pi += 2; } m.pi = pi;
				m.col.set(op.col, m.ci); m.ci += op.col.length;
				if (m.off && op.off) m.off.set(op.off, m.hi * 3);
				if (m.jf && op.jf) m.jf.set(op.jf, m.hi);   // 旗はタイルの中で閉じる（タイルの境を跨いで継がない）＝そのまま写す
				if (m.dist && op.dist) m.dist.set(op.dist, m.hi);
				m.half.set(op.half, m.hi); m.hi += op.half.length;
			}
		}
	}
	const layers: DrawOp[] = [...buf.values()].sort((a, b) => a.li - b.li).map((m): DrawOp => m.kind === "fill"
		? { kind: "fill", li: m.li, pos: m.pos, col: m.col, idx: m.idx, ...(m.fx ? { fx: m.fx } : {}), ...(m.pat ? { pat: m.pat } : {}), ...(m.pz ? { pz: m.pz } : {}) }
		: { kind: "line", li: m.li, P1: m.P1, P2: m.P2, col: m.col, half: m.half, ...(m.off ? { off: m.off } : {}), ...(m.jf ? { jf: m.jf, cj: m.cj } : {}), ...(m.dist ? { dist: m.dist, dash: m.dash, dz: m.dz } : {}), ...(m.fx ? { fx: m.fx } : {}), ...(m.pz ? { pz: m.pz } : {}) });

	// 建物：全タイルから結合。xy を原点へ再ベース、z(高さ)はそのまま。
	let bN = 0;
	for (const { key } of order) { const g = geomOf(key); if (g && g.buildings) bN += g.buildings.pos.length; }
	let buildings: BuildingsGeom | null = null;
	if (bN) {
		const pos = new Float32Array(bN), shade = new Float32Array(bN / 3), anchor = new Float32Array(bN / 3 * 2);
		let pi = 0, si = 0, ai = 0;
		for (const { key, origin: to } of order) {
			const g = geomOf(key); if (!g || !g.buildings) continue;
			const ox = to[0] - origin[0], oy = to[1] - origin[1], bp = g.buildings.pos, ba = g.buildings.anchor;
			for (let i = 0; i < bp.length; i += 3) { pos[pi++] = bp[i] + ox; pos[pi++] = bp[i + 1] + oy; pos[pi++] = bp[i + 2]; }
			for (let i = 0; i < ba.length; i += 2) { anchor[ai++] = ba[i] + ox; anchor[ai++] = ba[i + 1] + oy; }
			shade.set(g.buildings.shade, si); si += g.buildings.shade.length;
		}
		buildings = { pos, shade, anchor };
	}
	return { origin, layers, buildings };
}
const EMPTY = new Set<number>();

// op 列（＋建物）の型付き配列のバッファ＝transfer の対象・実バイトの数え上げ（tile worker・pipeline・tilemanager・scene worker で共用）。
// op＝fill { pos, col, idx } ／ line { P1, P2, col, half, off?, jf?, dist? }・シーン（結合後の layers）も同じ形
export function opBuffers(ops: readonly DrawOp[], buildings?: BuildingsGeom | null): ArrayBufferLike[] {
	const bufs: ArrayBufferLike[] = [];
	for (const op of ops) {
		if (op.kind === "fill") bufs.push(op.pos.buffer, op.col.buffer, op.idx.buffer);
		else { bufs.push(op.P1.buffer, op.P2.buffer, op.col.buffer, op.half.buffer); if (op.off) bufs.push(op.off.buffer); if (op.jf) bufs.push(op.jf.buffer); if (op.dist) bufs.push(op.dist.buffer); }
	}
	if (buildings) bufs.push(buildings.pos.buffer, buildings.shade.buffer, buildings.anchor.buffer);
	return bufs;
}

// 破線（S-P1-3・2026-10-22）の模様（線幅の倍数・MapLibre の並び）→ 線の区間 [a, b, a, b, …]（周期 P の中・最大 DASH_IV 個）。
// 奇数個は最後と最初の線がつながる（MapLibre の LineAtlas.getDashRanges）＝区間が P を越える。
// round＝丸い端：長さ 0 の線（点）を残す。それ以外（butt・square）は長さ 0 の線を捨て、接する線をつなぐ（MapLibre の addRegularDash）。
// 全部が線（間が 0）＝実線＝[−P, 2P]
export const DASH_IV = 4;
export function dashIntervals(p: readonly number[], round: boolean): { P: number; iv: number[] } {
	let iv: number[] = [], c = 0;
	for (let i = 0; i < p.length; i++) { if (!(i & 1)) iv.push(c, c + p[i]); c += p[i]; }
	const P = c;
	if (p.length & 1 && iv.length > 2) { const b = iv[1]; iv = iv.slice(2); iv[iv.length - 1] = P + b; }
	if (!round) {
		const out: number[] = [];
		for (let i = 0; i < iv.length; i += 2) {
			if (iv[i + 1] <= iv[i]) continue;
			if (out.length && out[out.length - 1] >= iv[i]) out[out.length - 1] = Math.max(out[out.length - 1], iv[i + 1]);
			else out.push(iv[i], iv[i + 1]);
		}
		if (out.length > 2 && out[out.length - 1] >= out[0] + P) { out[out.length - 1] = Math.max(out[out.length - 1], out[1] + P); out.splice(0, 2); }
		iv = out;
	}
	for (let i = 0; i < iv.length; i += 2) if (iv[i + 1] - iv[i] >= P) return { P, iv: [-P, 2 * P] };
	return { P, iv };
}
// 線分の長さ（z24 の px＝256 px 世界の 2^24 倍）：経緯度（原点 o に足す）から＝メルカトルの縦は中点の緯度で近似（細分した短い線分・シェーダの LINE_MAIN と同式）
const W24 = 2 ** 32, D2R = Math.PI / 180;
export function segLen24(o: ArrayLike<number>, x1: number, y1: number, x2: number, y2: number): number {
	const dx = (x2 - x1) / 360, dy = (y2 - y1) * D2R / Math.cos((o[1] + (y1 + y2) * 0.5) * D2R) / (2 * Math.PI);
	return Math.hypot(dx, dy) * W24;
}
// mdDash を名乗らない描き手（2026-10-22 より前の WebGPU・今は ?nolx=1）の逃げ道：dist を持つ線の層を CPU で刻む（classic＝renderer・md＝scene worker が常駐の前に）。尺は作ったタイルの z（dz）の px＝従来の CPU の破線と同じ。
// 片の端は丸（WebGPU の線は capsule）・長さ 0 の片（点）は丸い端の層だけ。ずらす層（off＝層で 1 つの値・paintzoom.ts）は片ごとに [off, tS, tE]＝角の継ぎは線分の頭と尻に届いた片だけ
export function chopDash(L: LineOp, o: ArrayLike<number>): LineOp {
	if (!L.dist || !L.dash) return L;
	const { P, iv } = dashIntervals(L.dash, !((L.jf ? L.cj ?? 0 : 0) & 3)), s = 2 ** ((L.dz ?? 24) - 24), n = L.half.length;
	const P1: number[] = [], P2: number[] = [], col: number[] = [], half: number[] = [], off: number[] | null = L.off ? [] : null;
	for (let i = 0; i < n; i++) {
		const w = 2 * L.half[i]; if (!(w > 0)) continue;
		const x1 = L.P1[i * 2], y1 = L.P1[i * 2 + 1], x2 = L.P2[i * 2], y2 = L.P2[i * 2 + 1];
		const d0 = L.dist[i] * s / w, len = segLen24(o, x1, y1, x2, y2) * s / w;
		for (let k = Math.floor(d0 / P) - 1; k * P < d0 + len + P; k++) for (let j = 0; j < iv.length; j += 2) {
			const a0 = iv[j] + k * P, b0 = iv[j + 1] + k * P;
			if (b0 === a0 ? a0 < d0 || a0 >= d0 + len : b0 <= d0 || a0 >= d0 + len) continue;   // 点（長さ 0）は線分の頭に含め尻に含めない＝次の線分と重ねない
			const a = Math.max(a0, d0), b = Math.min(b0, d0 + len);
			const ta = len > 0 ? (a - d0) / len : 0, tb = len > 0 ? (b - d0) / len : 0;
			P1.push(x1 + (x2 - x1) * ta, y1 + (y2 - y1) * ta); P2.push(x1 + (x2 - x1) * tb, y1 + (y2 - y1) * tb);
			col.push(L.col[i * 4], L.col[i * 4 + 1], L.col[i * 4 + 2], L.col[i * 4 + 3]); half.push(L.half[i]);
			if (off) off.push(L.off![i * 3], a <= d0 ? L.off![i * 3 + 1] : 0, b >= d0 + len ? L.off![i * 3 + 2] : 0);
		}
	}
	return { kind: "line", li: L.li, ...(L.id ? { id: L.id } : {}), P1: new Float32Array(P1), P2: new Float32Array(P2), col: new Uint8Array(col), half: new Float32Array(half), ...(off ? { off: new Float32Array(off) } : {}), ...(L.fx ? { fx: L.fx } : {}), ...(L.pz ? { pz: L.pz } : {}) };
}
