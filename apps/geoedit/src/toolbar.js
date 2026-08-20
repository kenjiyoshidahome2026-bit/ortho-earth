// ツールバー：ツール切替（選択/点/線/面）・undo/redo・スナップ格子（1e-3〜1e-7）・取込/書出。
// 作図ツール選択中は「次に描くもの」の既定スタイルパネル（styleform＝点/線/面それぞれ）を出す。
// 全部 DOM 直組み＝依存ゼロ。重なりは DOM 順（z-index 禁止の掟）。
import { styleForm } from "./styleform.js";

// モノクロ線画アイコン（currentColor）＝Kenji旧ツールバーの流儀（8/20 参考画像）。絵文字混在をやめて統一
const S = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
	undo: S('<path d="M5 5v6h6"/><path d="M5 11a8 8 0 1 1 2.3 6.3"/>'),
	redo: S('<path d="M19 5v6h-6"/><path d="M19 11a8 8 0 1 0-2.3 6.3"/>'),
	select: S('<path d="M6 3l12 9.5-6.5.8L8 20z"/>'),
	point: S('<path d="M12 21s-6-6.6-6-10.7A6 6 0 1 1 18 10.3C18 14.4 12 21 12 21z"/><circle cx="12" cy="10" r="2.2"/>'),
	text: S('<text x="12" y="15" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none" font-family="sans-serif">ABC</text><path d="M6 18.5l3 2 6-4"/>'),
	line: S('<path d="M3 17L9 8l6 5 6-8"/><circle cx="3" cy="17" r="1.6"/><circle cx="9" cy="8" r="1.6"/><circle cx="15" cy="13" r="1.6"/><circle cx="21" cy="5" r="1.6"/>'),
	rect: S('<rect x="4" y="6" width="16" height="12"/><circle cx="4" cy="6" r="1.5"/><circle cx="20" cy="6" r="1.5"/><circle cx="20" cy="18" r="1.5"/><circle cx="4" cy="18" r="1.5"/>'),
	circle: S('<circle cx="12" cy="12" r="8"/><circle cx="20" cy="12" r="1.6"/><path d="M12 12h6.5"/>'),
	move: S('<path d="M12 2v20M2 12h20"/><path d="M12 2l-2.5 3M12 2l2.5 3M12 22l-2.5-3M12 22l2.5-3M2 12l3-2.5M2 12l3 2.5M22 12l-3-2.5M22 12l-3 2.5"/>'),
	polygon: S('<path d="M12 3.5l8.5 6.2-3.2 10H6.7l-3.2-10z"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="20.5" cy="9.7" r="1.5"/><circle cx="17.3" cy="19.7" r="1.5"/><circle cx="6.7" cy="19.7" r="1.5"/><circle cx="3.5" cy="9.7" r="1.5"/>'),
	hole: S('<circle cx="6" cy="6" r="2.8"/><circle cx="6" cy="18" r="2.8"/><path d="M20 4L8.2 15.9M8.2 8.1L20 20"/>'),   // 鋏＝旧ツールバー準拠（本人裁定 8/20）
	imp: S('<path d="M3 7h6l2 2h10v11H3z"/><path d="M12 11v6m0 0l-2.5-2.5M12 17l2.5-2.5"/>'),
	exp: S('<path d="M12 14V3m0 0L8.5 6.5M12 3l3.5 3.5"/><path d="M4 15v5h16v-5"/>'),
	trash: S('<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>'),
};

export function initToolbar(el, api, signal) {
	el.hidden = false;
	el.innerHTML = "";
	const btn = (icon, title, fn) => {
		const b = document.createElement("button");
		b.innerHTML = ICONS[icon] ?? icon; b.title = title;
		b.addEventListener("click", fn, { signal });
		el.append(b);
		return b;
	};
	const sep = () => { const s = document.createElement("span"); s.className = "ge-sep"; el.append(s); };

	// ---- undo/redo（旧ツールバー準拠＝左端）----
	const undoB = btn("undo", "元に戻す (⌘Z)", () => api.undo());
	const redoB = btn("redo", "やり直す (⇧⌘Z)", () => api.redo());
	const syncHist = (canU, canR) => { undoB.disabled = !canU; redoB.disabled = !canR; };
	sep();

	// ---- ツール ----
	const tools = {
		select: btn("select", "選択・頂点編集 (V)", () => api.setTool("select")),
		point: btn("point", "点を置く（アイコン/図形） (A)", () => api.setTool("point")),
		text: btn("text", "テキストを置く (T)", () => api.setTool("text")),
		line: btn("line", "線を描く (L)", () => api.setTool("line")),
		polygon: btn("polygon", "面を描く (P)", () => api.setTool("polygon")),
		rect: btn("rect", "矩形を描く（2クリック） (R)", () => api.setTool("rect")),
		circle: btn("circle", "円を描く（中心→半径の2クリック） (C)", () => api.setTool("circle")),
		hole: btn("hole", "穴を開ける（ポリゴンの内側に描いてEnter） (H)", () => api.setTool("hole")),
		move: btn("move", "要素を移動（クリックで選択→ドラッグ） (M)", () => api.setTool("move")),
	};
	const syncTool = t => { for (const [k, b] of Object.entries(tools)) b.classList.toggle("on", k === t); symPanel(t); };

	sep();
	// ---- スナップ格子 ----
	const snap = document.createElement("select");
	snap.className = "ge-snap"; snap.title = "スナップ格子（度）";
	for (const e of [3, 4, 5, 6, 7]) {
		const o = document.createElement("option");
		o.value = e; o.textContent = `1e-${e}`;
		snap.append(o);
	}
	snap.value = String(api.gridExp());
	snap.addEventListener("change", () => api.setGrid(+snap.value), { signal });
	el.append(snap);

	sep();
	btn("imp", "GISファイルを取り込む（ドロップも可）", () => file.click());
	const file = document.createElement("input");
	file.type = "file";
	file.accept = ".geopbf,.pbf,.geojson,.json,.topojson,.fgb,.zip,.kmz,.gpx,.gml,.xml,.gz";
	file.hidden = true;
	file.addEventListener("change", () => { if (file.files[0]) api.importFile(file.files[0]); file.value = ""; }, { signal });
	el.append(file);
	btn("exp", "書き出し（8形式）", () => api.exportOpen());
	btn("trash", "全消去（新規セッション）", () => api.clearAll());

	// ---- 作図ツールの既定スタイルパネル（点/線/面それぞれ＝「次に描くもの」に効く）----
	let panel = null;
	const GEOM = { point: "Point", text: "Point", line: "LineString", polygon: "Polygon", rect: "Polygon", circle: "Polygon" };
	const TITLE = { point: "点のスタイル（次に置く点）", text: "テキスト（次に置く文字）", line: "線のスタイル（次に描く線）", polygon: "面のスタイル（次に描く面）", rect: "面のスタイル（矩形）", circle: "面のスタイル（円）" };
	const symPanel = t => {
		panel?.remove(); panel = null;
		if (!GEOM[t]) return;
		panel = document.createElement("div");
		panel.className = "ge-panel";
		panel.innerHTML = `<h3>${TITLE[t]}</h3>`;
		styleForm(panel, {
			geomType: GEOM[t],
			variant: t === "text" ? "text" : t === "point" ? "symbol" : undefined,
			get: () => api.getDefaults(t),
			set: partial => api.setDefaults(t, partial),   // 既定値＝履歴なし（フィーチャを触っていない）
		}, signal);
		el.parentElement.append(panel);
	};

	syncTool("select");
	return { syncTool, syncHist };
}
