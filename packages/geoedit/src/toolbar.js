// ツールバー：ツール切替（選択/点/線/面）・undo/redo・スナップ格子（1e-3〜1e-7）・取込/書出。
// 作図ツール選択中は「次に描くもの」の既定スタイルパネル（styleform＝点/線/面それぞれ）を出す。
// 全部 DOM 直組み＝依存ゼロ。重なりは DOM 順（z-index 禁止の掟）。
import { styleForm } from "./styleform.js";
import { tr } from "./i18n.js";   // UI 多言語化（英語キー＝既定値・訳はパッケージ持参の i18n/ui.json → i18n/lang/<code>.json）
const t = tr();

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
	free: S('<path d="M3 17c2.5-7 4.5-9.5 5.5-6.5s.8 8 3 5.5 3.5-9.5 5.5-8 2 6.5 4 8.5"/>'),   // フリーハンド＝一筆書きの波
	hole: S('<circle cx="6" cy="6" r="2.8"/><circle cx="6" cy="18" r="2.8"/><path d="M20 4L8.2 15.9M8.2 8.1L20 20"/>'),   // 鋏＝旧ツールバー準拠（本人裁定 8/20）
	imp: S('<path d="M3 7h6l2 2h10v11H3z"/>'),   // 取込＝素のフォルダ（矢印なし・本人裁定 9/15）
	exp: S('<path d="M12 3v11m0 0l-3.5-3.5M12 14l3.5-3.5"/><path d="M4 15v5h16v-5"/>'),   // 書出＝下向き矢印（受け皿へ落とす＝「そっちの方が感覚が合う」本人裁定 9/15）
	cloud: S('<path d="M7 17a4 4 0 1 1 .7-7.95A5.5 5.5 0 0 1 18.5 10 3.5 3.5 0 0 1 18 17z"/><path d="M12 21v-7m0 0l-2.5 2.5M12 14l2.5 2.5"/>'),
	close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
	trash: S('<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>'),
};

export function initToolbar(el, api, signal) {
	el.hidden = false;
	el.innerHTML = "";
	// 吹き出し説明＝quiet-mono の data-tip 流儀（OS既定の title は廃止＝遅い/意匠が揃わない）。aria-label は読み上げ用に別途
	const btn = (icon, tip, fn) => {
		const b = document.createElement("button");
		b.innerHTML = ICONS[icon] ?? icon; b.dataset.tip = tip; b.setAttribute("aria-label", tip);
		b.addEventListener("click", fn, { signal });
		el.append(b);
		return b;
	};
	const sep = () => { const s = document.createElement("span"); s.className = "ge-sep"; el.append(s); };

	// ---- undo/redo（旧ツールバー準拠＝左端）----
	const undoB = btn("undo", t("Undo (⌘Z)"), () => api.undo());
	const redoB = btn("redo", t("Redo (⇧⌘Z)"), () => api.redo());
	const syncHist = (canU, canR) => { undoB.disabled = !canU; redoB.disabled = !canR; };
	sep();

	// ---- ツール ----
	// 並び＝選択・点・文字・線・自由曲線・矩形・円・多角形・くり抜き・移動（本人裁定 9/15）。グループ化/解除はツールバーに置かず右クリックメニュー（複数選択＝⌘/Ctrl+クリック）
	const tools = {
		select: btn("select", t("Select / edit vertices (V)"), () => api.setTool("select")),
		point: btn("point", t("Place a point (icon / shape) (A)"), () => api.setTool("point")),
		text: btn("text", t("Place text (T)"), () => api.setTool("text")),
		line: btn("line", t("Draw a line (L)"), () => api.setTool("line")),
		free: btn("free", t("Draw freehand (drag = line; release near the start to close a polygon) (F)"), () => api.setTool("free")),
		rect: btn("rect", t("Draw a rectangle (2 clicks) (R)"), () => api.setTool("rect")),
		circle: btn("circle", t("Draw a circle (center → radius, 2 clicks) (C)"), () => api.setTool("circle")),
		polygon: btn("polygon", t("Draw a polygon (P)"), () => api.setTool("polygon")),
		hole: btn("hole", t("Cut a hole (draw inside a polygon, then Enter) (H)"), () => api.setTool("hole")),
	};
	tools.move = btn("move", t("Move a feature (click to select → drag; wheel while holding = rotate about its centroid, ⌥/Alt+wheel = rotate without grabbing, Shift = 15° steps) (M)"), () => api.setTool("move"));
	const syncTool = t => { for (const [k, b] of Object.entries(tools)) b.classList.toggle("on", k === t); symPanel(t); };

	sep();
	// ---- スナップ格子 ----
	// <select> は ::after を描けない＝包みの span に data-tip を持たせて吹き出しを出す（他ボタンと同じ流儀・OS title は使わない）
	const snapWrap = document.createElement("span");
	snapWrap.className = "ge-snapwrap"; snapWrap.dataset.tip = t("Snap grid (degrees)");
	const snap = document.createElement("select");
	snap.className = "ge-snap"; snap.setAttribute("aria-label", t("Snap grid (degrees)"));
	for (const e of [3, 4, 5, 6, 7]) {
		const o = document.createElement("option");
		o.value = e; o.textContent = `1e-${e}`;
		snap.append(o);
	}
	snap.value = String(api.gridExp());
	snap.addEventListener("change", () => api.setGrid(+snap.value), { signal });
	snapWrap.append(snap); el.append(snapWrap);

	sep();
	btn("imp", t("Import a GIS file (or drop it)"), () => file.click());
	const file = document.createElement("input");
	file.type = "file";
	file.accept = ".geopbf,.pbf,.geojson,.ndjson,.geojsonl,.jsonl,.json,.topojson,.fgb,.zip,.kmz,.gpx,.gml,.xml,.gpkg,.sqlite,.spatialite,.dxf,.gz,.png,.jpg,.jpeg,.webp,.gif,.avif";   // 画像＝四隅で貼る（古地図・写真）
	file.hidden = true;
	file.addEventListener("change", () => { if (file.files[0]) api.importFile(file.files[0]); file.value = ""; }, { signal });
	el.append(file);
	btn("exp", t("Export (8 formats)"), () => api.exportOpen());
	if (api.cloudOpen) btn("cloud", t("Cloud save / open (login required)"), () => api.cloudOpen());   // ホストがクラウド保存パネルを注入した時だけ
	btn("trash", t("Clear all (new session)"), () => api.clearAll());
	// 部品として開かれた時だけ＝右端の「×」＝持ち主（japan）へ戻る（結果で持ち主の図形を置き換える）。単独起動は出さない
	if (api.close) { const x = btn("close", t("Finish editing"), () => api.close()); x.classList.add("ge-close"); }

	// ---- 作図ツールの既定スタイルパネル（点/線/面それぞれ＝「次に描くもの」に効く）----
	let panel = null;
	const GEOM = { point: "Point", text: "Point", line: "LineString", polygon: "Polygon", free: "LineString", rect: "Polygon", circle: "Polygon" };
	const TITLE = { point: t("Point style (next point)"), text: t("Text (next label)"), line: t("Line style (next line)"), polygon: t("Polygon style (next polygon)"), free: t("Line style (freehand)"), rect: t("Polygon style (rectangle)"), circle: t("Polygon style (circle)") };
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
