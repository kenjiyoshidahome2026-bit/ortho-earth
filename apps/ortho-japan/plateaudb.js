// 建物3D（PLATEAU）データ管理モーダル：全国カタログ（300市区町村）に IDB キャッシュ状況（済・容量）を重ね、
// プレロード（事前ダウンロード）と地区単位の削除を行う。回線の細い環境（タブレット・外出先）へ出る前に
// 自宅で仕込み、ストレージが気になれば返す道具。DOM は open 初回に自前で組む＝main は worker 配線
// （idbList/idbDelete/preload）とカタログの getter を渡すだけ。進捗は main の renderPlateauProg から onProg で中継される。
import { PREF } from "./search.js";
import { tr } from "./i18n.js";

const t = tr({
	"建物3D（PLATEAU）データ管理": "3D buildings (PLATEAU) — data manager",
	"閉じる": "Close",
	"読込中…": "Loading…",
	"全削除": "Delete all",
	"市区町村名で絞り込み": "Filter by municipality name",
	"キャッシュ済みの {0} 地区をすべて削除しますか？": "Delete all {0} cached districts?",
	"その他": "Other",
	"描画": "Draw",
	"この地区へ飛んで建物3Dを表示": "Fly to this district and show its 3D buildings",
	"待機中…": "Waiting…",
	"済 {0}": "Done {0}",
	"削除": "Delete",
	"途中 {0}": "Partial {0}",
	"続きから": "Resume",
	"プレロード": "Preload",
	"キャッシュ済み {0} 地区 ・ 約{1}": "Cached: {0} districts, about {1}",
	"（端末割当 {0}・使用 {1}）": "(device quota {0}, in use {1})",
	"{0}/{1}枚": "{0}/{1} tiles",
	"カタログ走査 {0}…": "scanning catalog {0}…",
});

export function createPlateauDb({ getSets, idbList, idbDelete, preload, show }) {
	let root = null, listEl = null, sumEl = null, filterEl = null;
	const rows = new Map();      // name → { set, pref, rowEl, statusEl, actEl }
	let blocks = [];             // 都道府県ブロック：{ headerEl, rows: [row…] }（絞り込みで空になった見出しは隠す）
	let cached = new Map();      // base → { bytes, count, ts }
	const busy = new Set();      // 実行中の地区名（ボタン連打防止）
	let wasLoading = new Set(), lastProg = new Map();
	const fmtMB = b => b >= 1048576 ? (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + "MB" : b > 0 ? (b / 1024).toFixed(0) + "KB" : "";

	function build() {
		root = document.createElement("div"); root.id = "pdb";
		root.innerHTML = `
			<div id="pdb-panel">
				<div id="pdb-head">${t("建物3D（PLATEAU）データ管理")}<button id="pdb-close" title="${t("閉じる")}">×</button></div>
				<div id="pdb-sub"><span id="pdb-sum">${t("読込中…")}</span><button id="pdb-purge">${t("全削除")}</button></div>
				<input id="pdb-filter" type="search" placeholder="${t("市区町村名で絞り込み")}" autocomplete="off" spellcheck="false">
				<div id="pdb-list"></div>
			</div>`;
		(document.getElementById("map") || document.body).appendChild(root);   // #map 配下＝埋め込み時もモーダルが地図領域に収まる
		listEl = root.querySelector("#pdb-list"); sumEl = root.querySelector("#pdb-sum"); filterEl = root.querySelector("#pdb-filter");
		root.addEventListener("pointerdown", e => { if (e.target === root) close(); });   // 背景クリックで閉じる
		root.querySelector("#pdb-close").addEventListener("click", close);
		filterEl.addEventListener("input", applyFilter);
		root.querySelector("#pdb-purge").addEventListener("click", async () => {
			if (!cached.size || !confirm(t("キャッシュ済みの {0} 地区をすべて削除しますか？", cached.size))) return;
			for (const base of [...cached.keys()]) await idbDelete(base);
			refresh();
		});
	}
	function applyFilter() {
		const q = filterEl.value.trim();
		// 市区町村名 or 都道府県名でマッチ（「東京」で東京都ブロック全体が出る）。空見出しのブロックは隠す。
		for (const r of rows.values()) r.rowEl.style.display = !q || r.set.name.includes(q) || r.pref.includes(q) ? "" : "none";
		for (const b of blocks) b.headerEl.style.display = b.rows.some(r => r.rowEl.style.display !== "none") ? "" : "none";
	}
	function buildRows() {
		rows.clear(); blocks = []; listEl.innerHTML = "";
		// 市区町村コード順（base URL の "39386-bldg-…" がコード）＝地理院・e-Stat と同じ並び。先頭2桁＝都道府県で見出し。
		const code = s => +(s.base.match(/\/(\d{5})-/)?.[1] || 99999);
		const sets = [...getSets()].sort((a, b) => code(a) - code(b));
		let curPref = -1, block = null;
		for (const set of sets) {
			const pn = Math.floor(code(set) / 1000);
			if (pn !== curPref) {
				curPref = pn;
				const headerEl = document.createElement("div"); headerEl.className = "pdb-pref";
				headerEl.textContent = PREF[pn] || t("その他");
				listEl.appendChild(headerEl);
				blocks.push(block = { headerEl, rows: [] });
			}
			const rowEl = document.createElement("div"); rowEl.className = "pdb-row";
			const nameEl = document.createElement("span"); nameEl.className = "pdb-name"; nameEl.textContent = set.name;
			const statusEl = document.createElement("span"); statusEl.className = "pdb-status";
			const drawEl = document.createElement("button"); drawEl.className = "pdb-act draw"; drawEl.textContent = t("描画");
			drawEl.title = t("この地区へ飛んで建物3Dを表示");
			drawEl.addEventListener("click", () => show(set));   // モーダルを閉じて球面フライト→autoPlateau がキャッシュ命中で即表示
			const actEl = document.createElement("button"); actEl.className = "pdb-act";
			actEl.addEventListener("click", () => onAct(set));
			rowEl.append(nameEl, statusEl, drawEl, actEl); listEl.appendChild(rowEl);
			const r = { set, pref: PREF[pn] || "", rowEl, statusEl, drawEl, actEl };
			rows.set(set.name, r); block.rows.push(r);
		}
		applyFilter();
	}
	async function onAct(set) {
		if (busy.has(set.name)) return;
		busy.add(set.name);
		try {
			const c = cached.get(set.base);
			if (c && !c.partial) await idbDelete(set.base);
			else { renderRow(rows.get(set.name), t("待機中…")); await preload(set); }   // 途中＝続きから（部分再開）。進捗は onProg が上書きする
		} finally { busy.delete(set.name); }
		refresh();
	}
	function renderRow(r, progText) {
		if (progText != null) { r.statusEl.textContent = progText; r.actEl.style.display = "none"; r.drawEl.style.display = "none"; return; }
		const c = cached.get(r.set.base);
		if (c && !c.partial) {
			r.statusEl.textContent = t("済 {0}", fmtMB(c.bytes) || c.count + " batch");
			r.drawEl.style.display = "";   // 読み込み済み＝明示的な「描画」ボタン
			r.actEl.textContent = t("削除"); r.actEl.className = "pdb-act del";
		} else if (c) {   // 中断の貯金（partial）＝続きからプレロードできる
			r.statusEl.textContent = t("途中 {0}", fmtMB(c.bytes) || c.count + " batch");
			r.drawEl.style.display = "none";
			r.actEl.textContent = t("続きから"); r.actEl.className = "pdb-act";
		} else {
			r.statusEl.textContent = ""; r.drawEl.style.display = "none";
			r.actEl.textContent = t("プレロード"); r.actEl.className = "pdb-act";
		}
		r.actEl.style.display = "";
	}
	async function refresh() {
		cached = new Map((await idbList()).map(it => [it.base, it]));
		if (!rows.size && getSets().length) buildRows();   // カタログ到着後の初回に一覧を組む
		let total = 0; for (const it of cached.values()) total += it.bytes || 0;
		// 端末のオリジン割当（クォータ）を添える＝デモ前の仕込みで残り容量を見ながら判断できる。取れない環境は地区合計のみ。
		const est = await navigator.storage?.estimate?.().catch(() => null);
		const fmtGB = b => b >= 1073741824 ? (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1) + "GB" : fmtMB(b) || "0MB";
		sumEl.innerHTML = t("キャッシュ済み {0} 地区 ・ 約{1}", cached.size, fmtGB(total))   // 挿入値は全て数値生成＝innerHTML可（<br>で2行に）
			+ (est?.quota ? "<br>" + t("（端末割当 {0}・使用 {1}）", fmtGB(est.quota), fmtGB(est.usage || 0)) : "");
		for (const r of rows.values()) renderRow(r);
		onProg(lastProg);   // 進行中の行は進捗表示を優先で上書き
	}
	// main の進捗 Map（name → {scan}|{done,total}）を行表示へ。autoPlateau 起点の読み込みも同じ経路で見える。
	// 進行中だった行が消えた＝完了/失敗＝一覧を引き直して「済」へ（vanish→refresh→onProg は wasLoading が同期済みなので循環しない）。
	function onProg(progMap) {
		lastProg = progMap;
		if (!root || root.style.display === "none") return;
		const nowLoading = new Set();
		for (const [name, p] of progMap) {
			nowLoading.add(name);
			const r = rows.get(name); if (!r) continue;
			renderRow(r, p.total ? t("{0}/{1}枚", p.done, p.total) : t("カタログ走査 {0}…", p.scan ?? 0));
		}
		let vanished = false;
		for (const n of wasLoading) if (!nowLoading.has(n)) vanished = true;
		wasLoading = nowLoading;
		if (vanished) refresh();
	}
	function open() { if (!root) build(); root.style.display = "flex"; refresh(); }
	function close() { root.style.display = "none"; }
	return { open, close, onProg };
}
