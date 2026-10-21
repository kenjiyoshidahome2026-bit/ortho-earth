// common/bigtable ── 10 万〜数十万行の表をブラウザでスクロールさせる仮想スクロール表（2026-10-22・power-grid-survey/bigtable から移した）。
// 見えている行だけを DOM に描く＝40 万行でも DOM の行は常に 50 個ほど。依存なし（DOM だけ）。
//
//   import { BigTable, parseCSV, inferColumns } from "common/bigtable";
//   const { header, rows } = await parseCSV(text);                 // 文字列 → 配列の配列
//   const table = new BigTable(box, { columns: inferColumns(header, rows), rows });   // box の高さは呼び手が決める（例 height:70vh）
//   table.setQuery("太陽光");          // 全列の部分一致（大文字小文字を区別しない）
//   table.setColumnQuery(10, "北海道"); // 列別の部分一致
//   table.sortBy(4, "desc");           // 省くと 昇順 → 降順 → 解除 の順に回る（見出しのクリックと同じ）
//   table.select(123);                 // 元データの行番号を選んで見える所へ
//   table.toCSV();                     // 絞り込み・並べ替え後の表（Excel 向けに BOM 付き）
//
// 行は「配列の配列」が既定（オブジェクトより軽い）。列の index にキー名を入れればオブジェクトの配列でも使える（row[col.index] で引くだけ）。
// 掟：
//   行の高さは一定（rowHeight）。セルの中で改行しない（長い値は … で省く）。
//   行数 × 行高さが要素の高さの上限（Chrome 約 3,355 万px）に近いとき（約 43 万行超）は、スクロールの位置を内部で換算する（末尾の行まで届く）。
//   配色＝theme "auto"（prefers-color-scheme に従う・既定）／"dark"／"light"。色は --oe-bt-* の変数で差し替えられる。
//   文言は持たない（common は i18n を持たない）＝見出しの文字は columns の label で渡す。
//   CSS は 1 度だけ <style id="oe-bigtable-css"> で差し込む（panel と同じ）＝呼び手は CSS を読まなくてよい。
// 計測（Chromium・発電所一覧 4.7 万行×35 列／FIT 明細 39 万行×13 列 61MB）：解析 0.55／1.05 秒、末尾までスクロール 0.3／0.2 秒、
//   絞り込み 0.45／0.64 秒、降順 0.5／0.7 秒、DOM の行 45、JS ヒープ 54MB。100 万行を超えるなら parseCSV を Worker に移すのが次の一手。

/** 行（配列の配列の 1 行、またはオブジェクト） */
export type Row = ArrayLike<unknown> | Record<string, unknown>;
/** 列の鍵（配列なら添字、オブジェクトならキー名） */
export type ColumnKey = number | string;

export interface Column {
	index: ColumnKey;
	/** 見出し（文字として入れる）。既定は index を文字にした物 */
	label?: string;
	/** 幅（px）。既定 140 */
	width?: number;
	/** 既定 "left"（inferColumns は数値列を "right" にする） */
	align?: "left" | "right" | "center";
	/** 並べ替えを数値でするか。省くと先頭 200 行の 8 割が数なら数値 */
	numeric?: boolean;
	/** セルの表示（並べ替え・絞り込み・toCSV は元の値のまま） */
	format?: (v: unknown, row: Row) => string;
}
type Col = Column & { label: string; width: number; align: "left" | "right" | "center" };

export type SortDir = "asc" | "desc";
export interface SortState { col: ColumnKey; dir: SortDir }
export interface Counts { total: number; shown: number }

export interface BigTableOpts {
	columns: Column[];
	rows?: Row[];
	/** 行の高さ（px）。既定 28 */
	rowHeight?: number;
	/** 画面の外に余分に描く行数。既定 8 */
	overscan?: number;
	/** 左端に元データの行番号を出す。既定 true */
	rowNumbers?: boolean;
	/** 配色。既定 "auto" */
	theme?: "auto" | "dark" | "light";
	/** 行のクリック（srcIndex＝元データの行番号） */
	onRowClick?: (row: Row, srcIndex: number, ev: MouseEvent) => void;
	/** 件数が変わるたび（絞り込み・行の差し替え） */
	onCountChange?: (c: Counts) => void;
}

/** 要素の高さの上限（Chrome 約 3,355 万px・Firefox 約 1,790 万px）に余裕をもたせた値 */
export const MAX_SCROLL_PX = 12_000_000;
const ROWNUM_W = 72;   // 「389,736」が収まる幅

const cellOf = (r: Row, k: ColumnKey): unknown => (r as Record<ColumnKey, unknown>)[k];

/** 数として読めれば数（"1,234" も可）、空・"-"・数でない物は null */
export function toNumber(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (v == null) return null;
	const s = String(v).replace(/,/g, "").trim();
	if (s === "" || s === "-") return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}
const isBlank = (v: unknown) => v == null || v === "" || v === "-";

/** idx の先頭から空でない値を 200 個見て、8 割以上が数なら数値列 */
function looksNumeric(rows: readonly Row[], col: ColumnKey, idx: ArrayLike<number> | null): boolean {
	let num = 0, seen = 0;
	const n = idx ? idx.length : rows.length;
	for (let k = 0; k < n && seen < 200; k++) {
		const v = cellOf(rows[idx ? idx[k] : k], col);
		if (isBlank(v)) continue;
		seen++;
		if (toNumber(v) !== null) num++;
	}
	return seen > 0 && num / seen >= 0.8;
}

export interface ViewQuery {
	/** 全列（columns の index）の部分一致 */
	query?: string;
	/** 列別の部分一致（すべて満たす行だけ） */
	colQueries?: Iterable<[ColumnKey, string]>;
	sort?: SortState | null;
	/** sort の列が数値か。省くと columns の numeric → 無ければ値から推す */
	numeric?: boolean;
}

/**
 * 絞り込み → 並べ替えをした「表示順 → 元データの行番号」。何もしなければ null（全行そのまま）。
 * 並べ替えは安定（同じ値は元の順）。空・"-"・（数値列で）数でない値は向きに関わらず末尾。
 */
export function computeView(rows: readonly Row[], columns: readonly Column[], { query = "", colQueries = [], sort = null, numeric }: ViewQuery = {}): number[] | null {
	let idx: number[] | null = null;
	const q = query.trim().toLowerCase();
	const cq = [...colQueries].map(([c, s]) => [c, s.trim().toLowerCase()] as const).filter(([, s]) => s);
	if (q || cq.length) {
		idx = [];
		const cols = columns.map((c) => c.index);
		outer: for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			for (const [c, s] of cq) if (!String(cellOf(r, c) ?? "").toLowerCase().includes(s)) continue outer;
			if (q && !cols.some((c) => String(cellOf(r, c) ?? "").toLowerCase().includes(q))) continue;
			idx.push(i);
		}
	}
	if (sort) {
		const { col, dir } = sort;
		if (!idx) { idx = new Array(rows.length); for (let i = 0; i < rows.length; i++) idx[i] = i; }
		const sign = dir === "asc" ? 1 : -1;
		if (numeric ?? columns.find((c) => c.index === col)?.numeric ?? looksNumeric(rows, col, idx)) {
			// 数は先に Float64Array に移してから並べる（10 万行でも一瞬）。NaN＝空・数でない＝末尾
			const keys = new Float64Array(rows.length);
			for (const i of idx) keys[i] = toNumber(cellOf(rows[i], col)) ?? NaN;
			idx.sort((a, b) => {
				const ka = keys[a], kb = keys[b];
				if (Number.isNaN(ka) || Number.isNaN(kb)) return Number.isNaN(ka) === Number.isNaN(kb) ? a - b : Number.isNaN(ka) ? 1 : -1;
				return (ka - kb) * sign || a - b;
			});
		} else {
			const coll = new Intl.Collator("ja", { numeric: true });
			const keys: string[] = new Array(rows.length);
			for (const i of idx) keys[i] = String(cellOf(rows[i], col) ?? "");
			idx.sort((a, b) => {
				const sa = keys[a], sb = keys[b];
				if ((sa === "") !== (sb === "")) return sa === "" ? 1 : -1;
				return coll.compare(sa, sb) * sign || a - b;
			});
		}
	}
	return idx;
}

/** CSV の 1 セル（, " 改行を含めば "" で囲む） */
export const csvCell = (v: unknown): string => {
	const s = v == null ? "" : String(v);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export interface ParseCSVOpts {
	delimiter?: string;
	/** yieldEvery 行ごとと最後に、読んだ行数で呼ぶ */
	onProgress?: (rows: number) => void;
	/** この行数ごとに制御を返す（画面を固めない）。既定 20000 */
	yieldEvery?: number;
}

/**
 * CSV の文字列 → { header, rows }（rows は文字列の配列の配列）。
 * RFC 4180 の "" 囲み（中の , 改行 ""）・CRLF／LF／CR・先頭の BOM を扱う。末尾の空行は落とす。
 * 文字列は一度に受け取る（61MB で 1〜2 秒）。
 */
export async function parseCSV(text: string, { delimiter = ",", onProgress, yieldEvery = 20000 }: ParseCSVOpts = {}): Promise<{ header: string[]; rows: string[][] }> {
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const rows: string[][] = [];
	let header: string[] | null = null;
	const len = text.length;
	let i = 0, field = "", row: string[] = [], sinceYield = 0;
	while (i < len) {
		const ch = text[i];
		if (ch === '"') {
			i++;
			let start = i;
			for (;;) {
				const q = text.indexOf('"', i);
				if (q === -1) { field += text.slice(start); i = len; break; }
				if (text[q + 1] === '"') { field += text.slice(start, q + 1); i = q + 2; start = i; continue; }
				field += text.slice(start, q); i = q + 1; break;
			}
			continue;
		}
		if (ch === delimiter) { row.push(field); field = ""; i++; continue; }
		if (ch === "\r" || ch === "\n") {
			row.push(field); field = "";
			if (ch === "\r" && text[i + 1] === "\n") i++;
			i++;
			if (!header) header = row; else rows.push(row);
			row = [];
			if (++sinceYield >= yieldEvery) {
				sinceYield = 0;
				onProgress?.(rows.length);
				await new Promise((r) => setTimeout(r, 0));
			}
			continue;
		}
		// 囲まれていないセル＝次の区切りまで一気に
		let j = i;
		while (j < len) { const c = text[j]; if (c === delimiter || c === "\r" || c === "\n") break; j++; }
		field += text.slice(i, j);
		i = j;
	}
	if (field !== "" || row.length) { row.push(field); if (!header) header = row; else rows.push(row); }
	const tail = rows[rows.length - 1];
	if (tail && tail.length === 1 && tail[0] === "") rows.pop();
	onProgress?.(rows.length);
	return { header: header ?? [], rows };
}

export interface InferOpts { sample?: number; minWidth?: number; maxWidth?: number }

/** 見出しと先頭 sample 行から列の定義（数値か・揃え・幅）を推す。全角は 2 文字ぶんに数える */
export function inferColumns(header: readonly string[], rows: readonly Row[], { sample = 500, minWidth = 70, maxWidth = 360 }: InferOpts = {}): Column[] {
	const head = rows.slice(0, sample);
	return header.map((label, index) => {
		let maxLen = String(label).length;
		for (const r of head) {
			const v = cellOf(r, index);
			if (isBlank(v)) continue;
			let w = 0;
			for (const ch of String(v)) { w += ch.charCodeAt(0) > 255 ? 2 : 1; if (w >= 40) break; }
			maxLen = Math.max(maxLen, Math.min(40, w));
		}
		const numeric = looksNumeric(head, index, null);
		return { index, label, numeric, align: numeric ? "right" : "left", width: Math.max(minWidth, Math.min(maxWidth, maxLen * 8 + 20)) };
	});
}

/**
 * スクロールの換算。spacer（scroll 側の高さ）が full（行の高さの合計）より低いとき、
 * scrollTop 0〜(spacer-view) を 中身の位置 0〜(full-view) に一次で写す（末尾の行まで届く）。
 */
export function scrollToContent(scrollTop: number, full: number, spacer: number, view: number): number {
	const maxS = spacer - view, maxC = full - view;
	if (spacer >= full || maxS <= 0) return scrollTop;
	return Math.min(maxC, Math.max(0, scrollTop * (maxC / maxS)));
}
export function contentToScroll(top: number, full: number, spacer: number, view: number): number {
	const maxS = spacer - view, maxC = full - view;
	if (spacer >= full || maxC <= 0) return top;
	return Math.min(maxS, Math.max(0, top * (maxS / maxC)));
}

const CSS = `
.oe-bt{--oe-bt-bg:#fff;--oe-bt-fg:#222;--oe-bt-dim:#888;--oe-bt-odd:#f6f7f9;--oe-bt-line:#e3e5e8;--oe-bt-head:#f0f2f5;--oe-bt-hover:#e8f0fe;--oe-bt-select:#ffe9a8;--oe-bt-grip:rgba(0,120,255,.35);
 --oe-bt-font:13px/1.4 var(--qm-font,-apple-system,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif);
 position:relative;background:var(--oe-bt-bg);color:var(--oe-bt-fg);font:var(--oe-bt-font);border:1px solid var(--oe-bt-line);box-sizing:border-box;color-scheme:light}
.oe-bt.oe-bt-dark{--oe-bt-bg:#1b1d21;--oe-bt-fg:#e6e6e6;--oe-bt-dim:#8a8f99;--oe-bt-odd:#22252a;--oe-bt-line:#34373d;--oe-bt-head:#272a30;--oe-bt-hover:#2f3b52;--oe-bt-select:#5a4a1e;color-scheme:dark}
@media (prefers-color-scheme:dark){.oe-bt.oe-bt-auto{--oe-bt-bg:#1b1d21;--oe-bt-fg:#e6e6e6;--oe-bt-dim:#8a8f99;--oe-bt-odd:#22252a;--oe-bt-line:#34373d;--oe-bt-head:#272a30;--oe-bt-hover:#2f3b52;--oe-bt-select:#5a4a1e;color-scheme:dark}}
.oe-bt-scroller{position:absolute;inset:0;overflow:auto;overflow-anchor:none}
.oe-bt-header{position:sticky;top:0;z-index:2;display:flex;background:var(--oe-bt-head);border-bottom:1px solid var(--oe-bt-line);user-select:none;min-width:100%}
.oe-bt-spacer{position:relative;min-width:100%}
.oe-bt-body{position:absolute;top:0;left:0;will-change:transform}
.oe-bt-row{display:flex;box-sizing:border-box;border-bottom:1px solid var(--oe-bt-line);cursor:default}
.oe-bt-row.oe-bt-odd{background:var(--oe-bt-odd)}
.oe-bt-row:hover{background:var(--oe-bt-hover)}
.oe-bt-row.oe-bt-selected{background:var(--oe-bt-select)}
.oe-bt-cell{flex:0 0 auto;box-sizing:border-box;padding:0 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border-right:1px solid var(--oe-bt-line);line-height:var(--oe-bt-rh,28px)}
.oe-bt-th{position:relative;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px;line-height:30px}
.oe-bt-th:hover{background:var(--oe-bt-hover)}
.oe-bt-th-label{overflow:hidden;text-overflow:ellipsis;flex:1}
.oe-bt-sort{font-size:10px;opacity:.7;width:10px}
.oe-bt-rownum{width:${ROWNUM_W}px;text-align:right;color:var(--oe-bt-dim);font-variant-numeric:tabular-nums;background:inherit}
.oe-bt-grip{position:absolute;right:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:1}
.oe-bt-grip:hover{background:var(--oe-bt-grip)}`;

function injectCss(): void {
	if (document.getElementById("oe-bigtable-css")) return;
	const s = document.createElement("style");
	s.id = "oe-bigtable-css"; s.textContent = CSS;
	document.head.append(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	e.className = cls;
	return e;
}

export class BigTable {
	readonly container: HTMLElement;
	readonly scroller: HTMLDivElement;
	readonly header: HTMLDivElement;
	columns: Col[] = [];
	rows: Row[] = [];
	/** 表示順 → 元データの行番号（null＝全行そのまま） */
	view: number[] | null = null;
	sortState: SortState | null = null;
	query = "";
	readonly colQueries = new Map<ColumnKey, string>();
	/** 選択中の行（元データの行番号） */
	selected: number | null = null;
	readonly rowHeight: number;
	readonly overscan: number;
	readonly rowNumbers: boolean;
	onRowClick?: BigTableOpts["onRowClick"];
	onCountChange?: BigTableOpts["onCountChange"];
	private readonly spacer: HTMLDivElement;
	private readonly body: HTMLDivElement;
	private pool: HTMLDivElement[] = [];
	private full = 0;      // 行の高さの合計（px）
	private spacerH = 0;   // spacer の高さ（px）＝full か MAX_SCROLL_PX
	private raf = 0;
	private readonly ac = new AbortController();
	private readonly ro: ResizeObserver | null;

	constructor(container: HTMLElement, opts: BigTableOpts) {
		injectCss();
		this.container = container;
		this.rowHeight = opts.rowHeight ?? 28;
		this.overscan = opts.overscan ?? 8;
		this.rowNumbers = opts.rowNumbers ?? true;
		this.onRowClick = opts.onRowClick;
		this.onCountChange = opts.onCountChange;

		container.classList.add("oe-bt", `oe-bt-${opts.theme ?? "auto"}`);
		container.style.setProperty("--oe-bt-rh", `${this.rowHeight}px`);
		container.replaceChildren();
		this.scroller = el("div", "oe-bt-scroller");
		this.header = el("div", "oe-bt-header");
		this.spacer = el("div", "oe-bt-spacer");
		this.body = el("div", "oe-bt-body");
		this.spacer.append(this.body);
		this.scroller.append(this.header, this.spacer);
		container.append(this.scroller);

		const { signal } = this.ac;
		this.scroller.addEventListener("scroll", () => this.schedule(), { passive: true, signal });
		this.body.addEventListener("click", (ev) => {
			const rowEl = (ev.target as Element).closest<HTMLElement>(".oe-bt-row");
			if (!rowEl || !this.onRowClick) return;
			const i = Number(rowEl.dataset.i);
			this.onRowClick(this.rowAt(i), this.srcIndex(i), ev);
		}, { signal });
		this.ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.schedule());
		this.ro?.observe(this.scroller);

		this.columns = this.normCols(opts.columns);
		this.setRows(opts.rows ?? []);
	}

	// ── 公開の口 ──

	/** 行を差し替える（絞り込み・並べ替えは掛け直す） */
	setRows(rows: Row[]): void {
		this.rows = rows;
		if (this.selected != null && this.selected >= rows.length) this.selected = null;
		this.recompute();
	}

	/** 列を差し替える（並べ替え・列別の絞り込みは残す） */
	setColumns(columns: Column[]): void {
		this.columns = this.normCols(columns);
		for (const r of this.pool) r.remove();
		this.pool = [];
		this.recompute();
	}

	/** 全列の部分一致。空で解除 */
	setQuery(q: string | null | undefined): void {
		this.query = (q ?? "").trim();
		this.recompute();
	}

	/** 列別の部分一致。空で解除 */
	setColumnQuery(col: ColumnKey, q: string | null | undefined): void {
		const s = (q ?? "").trim();
		if (s) this.colQueries.set(col, s); else this.colQueries.delete(col);
		this.recompute();
	}

	/** 並べ替え。dir を省くと 昇順 → 降順 → 解除、null で解除 */
	sortBy(col: ColumnKey, dir?: SortDir | null): void {
		if (dir === undefined) {
			const s = this.sortState;
			dir = !s || s.col !== col ? "asc" : s.dir === "asc" ? "desc" : null;
		}
		this.sortState = dir ? { col, dir } : null;
		this.recompute();
	}

	counts(): Counts {
		return { total: this.rows.length, shown: this.view ? this.view.length : this.rows.length };
	}

	/** 表示順 i 番目の行 */
	rowAt(i: number): Row {
		return this.rows[this.srcIndex(i)];
	}

	/** 元データの行番号 → 表示順（絞り込みで消えていれば -1） */
	indexOf(srcIndex: number): number {
		if (!this.view) return srcIndex >= 0 && srcIndex < this.rows.length ? srcIndex : -1;
		return this.view.indexOf(srcIndex);
	}

	/** 表示順 i 番目を一番上に */
	scrollToRow(i: number): void {
		this.scroller.scrollTop = contentToScroll(i * this.rowHeight, this.full, this.spacerH, this.viewH());
	}

	/** 行を選ぶ（null で解除）。scroll（既定 true）＝見えていなければ真ん中へ */
	select(srcIndex: number | null, { scroll = true }: { scroll?: boolean } = {}): void {
		this.selected = srcIndex ?? null;
		if (scroll && this.selected != null) {
			const i = this.indexOf(this.selected);
			if (i >= 0) {
				const vh = this.viewH(), rh = this.rowHeight;
				const top = i * rh, cur = scrollToContent(this.scroller.scrollTop, this.full, this.spacerH, vh);
				if (top < cur || top + rh > cur + vh) this.scroller.scrollTop = contentToScroll(top - vh / 2 + rh / 2, this.full, this.spacerH, vh);
			}
		}
		this.render();
	}

	/** 絞り込み・並べ替え後の表を CSV の文字列で（Excel 向けに BOM 付き・CRLF） */
	toCSV(): string {
		const lines = [this.columns.map((c) => csvCell(c.label)).join(",")];
		const n = this.counts().shown;
		for (let i = 0; i < n; i++) {
			const r = this.rowAt(i);
			lines.push(this.columns.map((c) => csvCell(cellOf(r, c.index))).join(","));
		}
		return "﻿" + lines.join("\r\n");
	}

	/** 外す（器は空にして class も戻す） */
	destroy(): void {
		this.ac.abort();
		this.ro?.disconnect();
		if (this.raf) cancelAnimationFrame(this.raf);
		this.container.replaceChildren();
		this.container.classList.remove("oe-bt", "oe-bt-auto", "oe-bt-dark", "oe-bt-light");
		this.container.style.removeProperty("--oe-bt-rh");
	}

	// ── 中 ──

	private normCols(columns: Column[]): Col[] {
		return columns.map((c) => ({ ...c, width: c.width ?? 140, align: c.align ?? "left", label: c.label ?? String(c.index) }));
	}

	private srcIndex(i: number): number {
		return this.view ? this.view[i] : i;
	}

	private viewH(): number {
		return Math.max(0, this.scroller.clientHeight - this.header.offsetHeight);
	}

	private recompute(): void {
		this.view = computeView(this.rows, this.columns, { query: this.query, colQueries: this.colQueries, sort: this.sortState });
		this.full = this.counts().shown * this.rowHeight;
		this.spacerH = Math.min(this.full, MAX_SCROLL_PX);
		this.spacer.style.height = `${this.spacerH}px`;
		this.scroller.scrollTop = 0;
		this.renderHeader();
		this.render();
		this.onCountChange?.(this.counts());
	}

	private renderHeader(): void {
		const h = this.header;   // 見出しの要素は描き直すたびに作り直す＝聞き手は要素ごと捨てる（signal に溜めない）
		h.replaceChildren();
		if (this.rowNumbers) {
			const n = el("div", "oe-bt-cell oe-bt-th oe-bt-rownum");
			n.textContent = "#";
			h.append(n);
		}
		for (const col of this.columns) {
			const th = el("div", "oe-bt-cell oe-bt-th");
			th.style.textAlign = col.align;
			th.title = col.label;
			const label = el("span", "oe-bt-th-label");
			label.textContent = col.label;
			const arrow = el("span", "oe-bt-sort");
			const s = this.sortState;
			if (s && s.col === col.index) arrow.textContent = s.dir === "asc" ? "▲" : "▼";
			th.append(label, arrow);
			th.addEventListener("click", () => this.sortBy(col.index));
			// 列幅のドラッグ
			const grip = el("div", "oe-bt-grip");
			grip.addEventListener("pointerdown", (ev) => {
				ev.stopPropagation(); ev.preventDefault();
				const x0 = ev.clientX, w0 = col.width;
				const drag = new AbortController();
				window.addEventListener("pointermove", (e) => { col.width = Math.max(40, w0 + e.clientX - x0); this.applyWidths(); }, { signal: drag.signal });
				window.addEventListener("pointerup", () => drag.abort(), { signal: drag.signal });
			});
			grip.addEventListener("click", (e) => e.stopPropagation());
			th.append(grip);
			h.append(th);
		}
		this.applyWidths();
	}

	private applyWidths(): void {
		const total = this.columns.reduce((s, c) => s + c.width, 0) + (this.rowNumbers ? ROWNUM_W : 0);
		this.header.style.width = this.body.style.width = `${total}px`;
		const off = this.rowNumbers ? 1 : 0;
		const ths = this.header.children;
		this.columns.forEach((col, k) => { (ths[k + off] as HTMLElement).style.width = `${col.width}px`; });
		for (const rowEl of this.pool) {
			const cells = rowEl.children;
			this.columns.forEach((col, k) => { (cells[k + off] as HTMLElement).style.width = `${col.width}px`; });
		}
	}

	private schedule(): void {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
	}

	private render(): void {
		const n = this.counts().shown, rh = this.rowHeight;
		const vh = this.viewH(), st = this.scroller.scrollTop;
		const top = scrollToContent(st, this.full, this.spacerH, vh);
		const first = Math.max(0, Math.floor(top / rh) - this.overscan);
		const last = Math.min(n, first + Math.ceil(vh / rh) + this.overscan * 2);
		const need = Math.max(0, last - first);

		while (this.pool.length < need) {
			const rowEl = el("div", "oe-bt-row");
			rowEl.style.height = `${rh}px`;
			if (this.rowNumbers) rowEl.append(el("div", "oe-bt-cell oe-bt-rownum"));
			for (const col of this.columns) {
				const cell = el("div", "oe-bt-cell");
				cell.style.width = `${col.width}px`;
				cell.style.textAlign = col.align;
				rowEl.append(cell);
			}
			this.body.append(rowEl);
			this.pool.push(rowEl);
		}
		for (let k = need; k < this.pool.length; k++) this.pool[k].style.display = "none";

		// 行 i は中身の位置 i*rh − top だけ窓の上端から下＝spacer の中では st + i*rh − top（換算なしなら i*rh）
		this.body.style.transform = `translateY(${st + first * rh - top}px)`;

		const off = this.rowNumbers ? 1 : 0;
		for (let k = 0; k < need; k++) {
			const i = first + k, src = this.srcIndex(i), r = this.rows[src];
			const rowEl = this.pool[k];
			rowEl.style.display = "";
			rowEl.dataset.i = String(i);
			rowEl.classList.toggle("oe-bt-odd", i % 2 === 1);
			rowEl.classList.toggle("oe-bt-selected", src === this.selected);
			const cells = rowEl.children;
			if (this.rowNumbers) cells[0].textContent = (src + 1).toLocaleString();
			for (let c = 0; c < this.columns.length; c++) {
				const col = this.columns[c], v = cellOf(r, col.index);
				const s = col.format ? col.format(v, r) : v == null ? "" : String(v);
				const cell = cells[c + off];
				if (cell.textContent !== s) cell.textContent = s;
			}
		}
	}
}
