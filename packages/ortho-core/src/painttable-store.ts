// paint 表の (b) 類の「描き手の側の表」（vt perf plan §5・2026-10-22 GL2・2026-11-01 WebGPU と共有）。
// 行の値（RGBA と線の半幅）を CPU の Float32Array に持ち、scene worker から着く行（常駐の荷 up.rows）と main から配られる
// 後の式（ptOver＝setPaintProperty の速い道）・feature-state を読む層（ptFsLayers）と置かれた状態（ptFs）から行を評価し直す。
// GPU への写し方だけが描き手で違う（GL2＝RGBA32F テクスチャ・WebGPU＝storage buffer）＝ここは純関数と状態だけ・GPU API を読まない。
// 1 行＝PT_ROW_F32（8）個の f32＝2 texel（0〜3＝色・4＝線の半幅・5〜7＝予約）。行 r の先頭＝r × 8。
import { ptCovers, ptRowColor, ptRowHalf, PT_ID } from "./painttable.ts";
import type { PtLayer } from "./painttable.ts";

/** 表の行（worker-msg.ts の up.rows）＝[通しの行, 層 id, 鍵の名, 組, 焼いた色（RGBA8 の語）, 焼いた線の半幅（表に置ける線幅の層＝段 2b）] */
export type PtRow = [number, string, string[], unknown[], number, number?];
/** 1 行の f32 数（2 texel × RGBA） */
export const PT_ROW_F32 = 8;

export interface PtStore {
	/** 行の値（行 r＝[r*8, r*8+8)）。伸びると差し替わる＝毎回読む */
	readonly data: Float32Array;
	/** 行数（最大の行＋1） */
	readonly n: number;
	/** 新しい行・値が変わった行（scene worker の up.rows）＝必要なら表を伸ばす */
	rows(rows: PtRow[]): void;
	/** setPaintProperty の (b) 類（層 id → 後の式）＝全部を置き換える（上書きが外れた層の行は焼いた色へ戻す） */
	setOver(list: [string, PtLayer][] | null): void;
	/** feature-state を読む基図の層（層 id・source-layer・式）＝style ごとに全部を置き換える（段 3） */
	setFsLayers(list: [string, string, PtLayer][] | null): void;
	/** 基図の source の setFeatureState／removeFeatureState＝[source-layer, 地物の id, 状態（null＝外す）]・id が null＝その source-layer（null＝全部）の状態を外す */
	setFs(list: [string | null, string | null, Record<string, unknown> | null][]): void;
	/** 書き換えた行の範囲 [lo, hi]（両端含む）を返して空にする。無ければ null */
	takeDirty(): [number, number] | null;
}

/**
 * 描き手の表を作る。unitRows＝表を伸ばす単位の行数（GL2＝テクスチャ 1 行＝PT_TEXW/2 の行・WebGPU は任意）。
 * 伸ばし方＝必要な単位数と今の 2 倍の大きい方（GL2 の実装と同じ＝同じ行の並びで絵が bit 同値）。
 */
export function createPtStore(unitRows = 512): PtStore {
	const unit = unitRows * PT_ROW_F32;
	let data = new Float32Array(0), n = 0, lo = Infinity, hi = -1;
	const rowsAt: PtRow[] = [];
	let over = new Map<string, PtLayer>();
	// feature-state（段 3）：層 id → source-layer と式・source-layer → 地物の id（文字列）→ 状態・地物の id → その地物の行（鍵に PT_ID を持つ行）
	let fsL = new Map<string, { sl: string; L: PtLayer }>();
	const fsS = new Map<string, Map<string, Record<string, unknown>>>(), byId = new Map<string, Set<number>>(), rowId: (string | undefined)[] = [];
	function put(row: PtRow): void {
		const [r, id, keys, t, c, hw] = row, o = r * PT_ROW_F32, F = fsL.get(id), st = F && rowId[r] !== undefined ? fsS.get(F.sl)?.get(rowId[r]!) : undefined;
		const Lo = over.get(id), L = Lo && ptCovers(Lo, keys) ? Lo : st && ptCovers(F!.L, keys) ? F!.L : null;
		if (L) { ptRowColor(L, keys, t, data, o, st); if (L.w != null) data[o + 4] = ptRowHalf(L, keys, t, st); else if (hw !== undefined) data[o + 4] = hw; }
		else { data[o] = (c & 255) / 255; data[o + 1] = (c >>> 8 & 255) / 255; data[o + 2] = (c >>> 16 & 255) / 255; data[o + 3] = (c >>> 24) / 255; if (hw !== undefined) data[o + 4] = hw; }
		if (r < lo) lo = r;
		if (r > hi) hi = r;
	}
	return {
		get data() { return data; },
		get n() { return n; },
		rows(rows) {
			for (const row of rows) {
				const r = row[0], need = ((r / unitRows) | 0) + 1;
				if (need * unit > data.length) { const d = new Float32Array(Math.max(need, data.length / unit * 2) * unit); d.set(data); data = d; }
				rowsAt[r] = row; if (r >= n) n = r + 1;
				const old = rowId[r], ki = row[2].indexOf(PT_ID), v = ki < 0 ? null : row[3][ki], nid = v == null ? undefined : String(v);   // 使い回された行＝前の地物の索引から外す
				if (old !== undefined) byId.get(old)?.delete(r);
				rowId[r] = nid;
				if (nid !== undefined) { let S = byId.get(nid); if (!S) byId.set(nid, S = new Set()); S.add(r); }
				put(row);
			}
		},
		setOver(list) {
			const prev = over;
			over = new Map(list ?? []);
			for (let r = 0; r < n; r++) { const row = rowsAt[r]; if (row && (prev.has(row[1]) || over.has(row[1]))) put(row); }
		},
		setFsLayers(list) {
			const prev = fsL;
			fsL = new Map((list ?? []).map(([id, sl, L]) => [id, { sl, L }]));
			for (let r = 0; r < n; r++) { const row = rowsAt[r]; if (row && rowId[r] !== undefined && (prev.has(row[1]) || fsL.has(row[1]))) put(row); }
		},
		setFs(list) {
			const touch = new Set<number>();
			for (const [sl, fid, st] of list) {
				if (fid == null) {
					for (const k of sl == null ? [...fsS.keys()] : [sl]) { const M = fsS.get(k); if (!M) continue; for (const i of M.keys()) for (const r of byId.get(i) ?? []) touch.add(r); fsS.delete(k); }
					continue;
				}
				let M = fsS.get(sl!); if (!M) fsS.set(sl!, M = new Map());
				if (st && Object.keys(st).length) M.set(fid, st); else M.delete(fid);
				for (const r of byId.get(fid) ?? []) touch.add(r);
			}
			for (const r of touch) { const row = rowsAt[r]; if (row && fsL.has(row[1])) put(row); }
		},
		takeDirty() {
			if (hi < 0) return null;
			const d: [number, number] = [lo, hi];
			lo = Infinity; hi = -1;
			return d;
		},
	};
}
