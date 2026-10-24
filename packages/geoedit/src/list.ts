// 地物の一覧（2026-10-24）：全地物を表で並べ、属性の全文検索で絞り、行を押すとその地物を選んで寄る。
// 表＝ホストが注入する仮想スクロール表（ortho-earth では common/bigtable の BigTable＝温泉・横浜と同じ部品）。geoedit は npm 部品＝
// common に依存しない（cloudPanel と同じ注入の流儀）。注入が無ければツールバーに一覧ボタンを出さない。
// 置き場＝書き出し/クラウドと同じ一枠（.ge-dialog）。開いている間に地物が増減したら refresh() で行を組み直す（controller が呼ぶ）。
import { tr } from "./i18n.ts";
import { small } from "./model-util.ts";
import type { Model } from "./types.ts";
const t = tr();

/** 表の列（BigTable の Column と同じ形の部分） */
export interface ListColumn { index: number; label?: string; width?: number; align?: "left" | "right" | "center"; numeric?: boolean }
/** 表の手綱（BigTable の公開面の部分） */
export interface ListTable { setRows(rows: unknown[][]): void; setQuery(q: string): void; select(i: number | null, o?: { scroll?: boolean }): void; destroy?(): void }
/** ホストの注入＝box に表を組む（遅延 import してよい） */
export type ListTableFactory = (box: HTMLElement, opts: {
	columns: ListColumn[]; rows: unknown[][]; rowNumbers: boolean; theme: "dark"; rowHeight: number;
	onRowClick: (row: unknown, srcIndex: number) => void; onCountChange: (c: { total: number; shown: number }) => void;
}) => ListTable | Promise<ListTable>;

const NAME_KEYS = ["name", "名称", "title", "@text", "NAME", "Name", "label"];
const MAX_ATTR_COLS = 12;
const kindOf = (type: string): string => type.includes("Poly") ? t("Polygon") : type.includes("Line") ? t("Line") : t("Point");

/** 地物の外接矩形 [w,s,e,n]（小規模＝featureVerts・大規模＝点の座標か arc を繋いだ線） */
export function featureBbox(m: Model, eid: number): [number, number, number, number] | null {
	let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
	const add = (x: number, y: number): void => { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; };
	if (m.large) {
		const f = m.feats.get(eid);
		if (!f) return null;
		if (f.coords) for (const [x, y] of f.coords) add(x, y);
		else for (const { list } of m.listsOf(f)) for (const [x, y] of m.stitch(list)) add(x, y);
	} else {
		const v = small(m).featureVerts(eid);
		if (!v) return null;
		if (v.coords) for (const [x, y] of v.coords) add(x, y);
		else for (const r of v.rings) for (let i = 0; i < r.pts.length; i += 2) add(r.pts[i], r.pts[i + 1]);
	}
	return w <= e ? [w, s, e, n] : null;
}

export interface ListPanelApi {
	getModel(): Model | null;
	/** 行を押した＝選んで寄る */
	go(eid: number): void;
	selection(): number | null;
	makeTable: ListTableFactory;
}

export function listPanel(container: HTMLElement, api: ListPanelApi): { el: HTMLDivElement; refresh(): void; mark(): void } {
	container.querySelector(".ge-dialog")?.remove();   // 書き出し/クラウドと同じ一枠
	const panel = document.createElement("div");
	panel.className = "ge-panel ge-dialog ge-list";
	const head = document.createElement("div");
	head.className = "ge-head";
	const h3 = document.createElement("h3"); h3.textContent = t("Features");
	const close = Object.assign(document.createElement("button"), { className: "ge-icon-btn", innerHTML: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' });
	close.dataset.tip = t("Close"); close.setAttribute("aria-label", t("Close"));
	head.append(h3, close);
	const find = Object.assign(document.createElement("input"), { type: "search", className: "ge-find", placeholder: t("Search attributes") });
	const cnt = Object.assign(document.createElement("div"), { className: "ge-hint ge-cnt" });
	const box = Object.assign(document.createElement("div"), { className: "ge-table" });
	panel.append(head, find, cnt, box);
	container.append(panel);

	let eids: number[] = [], table: ListTable | null = null, alive = true;
	const build = (): { columns: ListColumn[]; rows: unknown[][] } => {
		const m = api.getModel();
		eids = m ? [...m.feats.keys()] : [];
		const feats = eids.map(eid => m!.feats.get(eid)!);
		// 属性の列＝@ 以外の鍵（先頭から出た順・名前らしき鍵は「名前」列へ回す）。多すぎる表は横に長いだけ＝MAX_ATTR_COLS で打ち切り（検索は表に出ている列＝名前と属性）
		const keys: string[] = [], seen = new Set<string>();
		for (const f of feats) { for (const k of Object.keys(f.properties || {})) if (!k.startsWith("@") && !k.startsWith("__") && !seen.has(k)) { seen.add(k); keys.push(k); } if (keys.length >= 64) break; }
		const nameKey = (p: Record<string, unknown>): unknown => { for (const k of NAME_KEYS) if (p[k] != null && p[k] !== "") return p[k]; return ""; };
		const attr = keys.filter(k => !NAME_KEYS.includes(k)).slice(0, MAX_ATTR_COLS);
		const str = (v: unknown): string => v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
		const rows = feats.map((f, i) => {
			const p = f.properties || {};
			return [eids[i], kindOf(f.type), str(nameKey(p)), ...attr.map(k => p[k] ?? null)];
		});
		const columns: ListColumn[] = [
			{ index: 0, label: "#", width: 52, align: "right", numeric: true },
			{ index: 1, label: t("Type"), width: 64 },
			{ index: 2, label: t("Name"), width: 140 },
			...attr.map((k, i) => ({ index: 3 + i, label: k, width: 110 })),
		];
		return { columns, rows };
	};
	const mark = (): void => { if (!table) return; const s = api.selection(); const i = s == null ? -1 : eids.indexOf(s); table.select(i >= 0 ? i : null, { scroll: false }); };
	const setCount = (c: { total: number; shown: number }): void => { cnt.textContent = c.shown === c.total ? t("$1 features", c.total.toLocaleString()) : t("$1 of $2 features", c.shown.toLocaleString(), c.total.toLocaleString()); };
	let columnsKey = "";
	const refresh = async (): Promise<void> => {
		const { columns, rows } = build();
		const key = columns.map(c => c.label).join("\u0001");
		if (table && key === columnsKey) { table.setRows(rows); table.setQuery(find.value); mark(); return; }   // 列の顔ぶれが同じ＝行だけ差し替え
		table?.destroy?.(); box.replaceChildren(); columnsKey = key;
		const tb = await api.makeTable(box, { columns, rows, rowNumbers: false, theme: "dark", rowHeight: 26,
			onRowClick: (_row, k) => { const eid = eids[k]; if (eid != null) api.go(eid); },
			onCountChange: setCount });
		if (!alive) { tb.destroy?.(); return; }
		table = tb; setCount({ total: rows.length, shown: rows.length });
		if (find.value) tb.setQuery(find.value);
		mark();
	};
	find.addEventListener("input", () => table?.setQuery(find.value));
	close.onclick = () => panel.remove();
	// 外されたら（×・別のダイアログ・destroy）表も畳む
	new MutationObserver((_, ob) => { if (!panel.isConnected) { alive = false; table?.destroy?.(); table = null; ob.disconnect(); } }).observe(container, { childList: true });
	refresh();
	return { el: panel, refresh: () => { if (panel.isConnected) refresh(); }, mark };
}
