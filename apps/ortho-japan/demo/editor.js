// scenes エディタの芯（器は apps/ortho-japan/scene.html・回帰は tests/t-scene.html）。
// 流れ＝「定義（画面フレーム）→ 撮影（撮る/通過点・並べ替え）→ 編集（hold/travel/glide・字幕）→ 出力（.scenes）」。
// 肝＝z と画面サイズが独立（正射の掟・[[ortho-z-definition]]）：最初に選ぶフレーム（16:9 等）そのものが作品の画角で、
//   枠(#sc-frame)を舞台に内接させ #map（quiet-mono の 100%/100%）がそれに従う＝構図した通りが再生・録画される。
// ガジェット三戒に従い DOM 自給。依存は map の公開面だけ＝map.view（撮る）・map.playScenes/stopScenes（試写・scene-format.md §7）・
//   location.hash（行ジャンプ＝URL⇄描画状態の一元化に乗る）・純関数 parseScenes/compileVias（診断）。
// フレームは .scenes の top-level `frame:"16:9"`（任意・プレーヤーは無視＝エディタ用メタ）として保存・復元。
import { parseScenes, compileVias } from "./scene-adapter.js";
import { sniffScene } from "../gadgets/dropfile.js";
import { tr } from "../i18n.js";   // UI二言語化（ja正典・en辞書引き＝エンジンと同じ ?lang= / ブラウザ言語の解決）。台本の中身は訳さない
const t = tr({
	"Scene エディタ": "Scene editor", "作品タイトル": "Title", "画角": "Frame", "自由": "Free",
	"全シーンの街を読み切り、立て切ってから開幕（本番の儀式・書式キーは waitLoading）": "Load and stand up every city in the script before the curtain rises (the real-show ritual; key: waitLoading)",
	"Plateauファイルの先読み": "Preload PLATEAU files",
	"📷 撮影": "📷 Shoot", "今の視点を行として追加（選択行の後ろへ）": "Add the current view as a row (after the selected row)",
	"◇ 通過点": "◇ Waypoint", "今の視点を通過点（ドリーの中継）として追加": "Add the current view as a waypoint (dolly relay)",
	"▶ ここから": "▶ From here", "軽い試写（選択行から・未選択なら先頭から。黒幕・読み込み待ちなし）": "Quick preview (from the selected row, or the top; no curtain or load wait)",
	"🎬 上映": "🎬 Show", "本番同等＝最初から（黒幕・読み込み待ち・終幕の括弧つき）": "Full show from the top (curtain, load wait, closing bracket)",
	"🎥 録画": "🎥 Record", "上映を録画して動画ファイル（MP4）に＝iMovie 等へそのまま。最初に「このタブを共有」を1回許可": "Record the show to a video file (MP4) for iMovie etc. Allow “share this tab” once",
	"⏺ 録画中…": "⏺ Recording…", "■ 停止": "■ Stop",
	"書き出し .scenes": "Export .scenes", "読み込み": "Open", "全消去": "Clear all", "全行を消して最初から（⌘Z で戻せる）": "Remove every row (⌘Z undoes)",
	"↶ 元に戻す": "↶ Undo", "直前の操作を取り消す（⌘Z）": "Undo the last action (⌘Z)",
	"自動": "auto", "地図遷移の尺は自動（通過点の着点なら有効）": "Map-transition duration is automatic (editable when this row ends a dolly)",
	"この点に到達するまでの秒（ドリーの緩急・省略=自動）": "Seconds to reach this point (dolly pacing; blank = auto)",
	"遷移": "Transition", "秒": "s", "キャプション": "Caption",
	"📷再撮影": "📷 Reshoot", "この行の視点を今のカメラで撮り直す": "Replace this row's view with the current camera",
	"保持": "Hold", "地図遷移": "Map flight", "直線移動": "Glide", "フェード": "Fade",
	"遷移の秒（直線移動/フェード・通過点の着点。省略=自動）": "Transition seconds (glide/fade, or the end of a dolly; blank = auto)",
	"削除": "Delete", "ドラッグで並べ替え": "Drag to reorder",
	"地図を構図して「📷 撮影」＝permalink がそのまま行になる。<br>view の間に「◇ 通過点」を挟むと1本のドリーで貫く。<br><br>行クリック＝その視点へ・⠿＝並べ替え・ファイルはここへドロップ": "Compose the map and press “📷 Shoot” — the permalink becomes a row.<br>Put “◇ Waypoint” rows between views for one continuous dolly.<br><br>Click a row to jump to it, ⠿ reorders, drop a .scenes file here to open it",
	"タイムライン＝ドラッグでその時刻の絵（上映は止まる）": "Timeline — drag to see that moment (stops playback)",
	"scenes 台本として読めませんでした（type:\"scenes\" が必要）": "Not a scenes script (needs type:\"scenes\")",
	"読み込みました: {0}": "Opened: {0}", "全行を消しました（⌘Z で戻せる）": "All rows removed (⌘Z undoes)",
	"画面の定義": "Define the frame", "z と画面サイズは独立＝この枠が作品の画角になります（後から変更可）": "z is independent of screen size — this frame is the work's aspect (changeable later)",
	"16:9 横": "16:9 landscape", "9:16 縦": "9:16 portrait",
	"カメラ {0}　高度 {1}　方位 {2}°　視野 {3}°×{4}°": "Camera {0}  Alt {1}  Hdg {2}°  FOV {3}°×{4}°",
});
// 台本由来の文字列（title・視点ハッシュ）を innerHTML に入れる前の消毒＝読み込んだファイルは他人作かもしれない
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const FRAMES = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:3": [4, 3] };   // "free"＝舞台いっぱい（枠なし）
const isVia = r => r?.via != null && !r.view && !r.glide && !r.fade;
const hashOf = r => r.view ?? r.glide ?? r.fade ?? r.via;   // 行の視点（遷移キー3種＋via）

const CSS = `
	#sc-stage { padding:38px 0 46px; box-sizing:border-box; }   /* 上端＝カメラ実位置チップの帯・下端＝タイムライン・スクラブの帯（fit も同じ分を差し引く） */
	#sc-scrub { position:absolute; left:16px; right:16px; bottom:9px; display:flex; align-items:center; gap:10px; color:#cdd6e6; font:11px/1 system-ui,sans-serif; user-select:none; }
	#sc-scrub .tk { position:relative; flex:1; height:22px; cursor:pointer; touch-action:none; }
	#sc-scrub .tk::before { content:""; position:absolute; left:0; right:0; top:9px; height:4px; border-radius:2px; background:rgba(255,255,255,.12); }
	#sc-scrub .sg { position:absolute; top:9px; height:4px; border-radius:2px; background:rgba(255,255,255,.38); }
	#sc-scrub .sg.tr { background:rgba(125,180,255,.6); }
	#sc-scrub .kn { position:absolute; top:6px; width:2px; height:10px; background:#e8b64c; }
	#sc-scrub .ph { position:absolute; top:2px; width:2px; height:18px; background:#fff; box-shadow:0 0 4px rgba(0,0,0,.8); pointer-events:none; }
	#sc-scrub .tm { min-width:92px; text-align:right; font-variant-numeric:tabular-nums; opacity:.85; }
	#sc-cam { position:absolute; top:11px; right:16px; pointer-events:none; white-space:nowrap;
		font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; letter-spacing:.02em;
		color:#cdd6e6; opacity:.92; }
	#sc-panel { display:flex; flex-direction:column; font:13px/1.5 system-ui,sans-serif; color:#cdd6e6; }
	.sc-brand { display:flex; align-items:center; gap:9px; padding:12px 14px 2px; font-size:15px; font-weight:700; color:#e6edf3; letter-spacing:.02em; }
	.sc-brand svg { width:22px; height:22px; color:#cdd6e6; flex:none; }
	#sc-panel #attr { position:static !important; inset:auto !important; background:none !important; border:none !important;
		box-shadow:none !important; text-align:left !important; font-size:10.5px !important; line-height:1.55; opacity:.72; padding:6px 14px 12px !important; }
	.sc-head { padding:8px 14px 8px; border-bottom:1px solid rgba(255,255,255,.08); }
	.sc-head input[type=text], #sc-title { width:100%; box-sizing:border-box; background:#0d1117; color:#e6edf3; border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:7px 10px; font-size:14px; }
	.sc-defrow { display:flex; gap:10px; align-items:center; margin-top:8px; font-size:12px; }
	.sc-defrow select { background:#0d1117; color:#e6edf3; border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:4px 6px; }
	.sc-tools { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
	.sc-tools button { background:#1b2330; color:#e6edf3; border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:6px 10px; cursor:pointer; font-size:12.5px; }
	.sc-tools button:hover { background:#243044; }
	.sc-tools button:disabled { opacity:.4; cursor:default; }
	#sc-shoot { background:#2b4a7a; border-color:rgba(140,180,255,.4); }
	#sc-rows { list-style:none; margin:0; padding:8px 10px; flex:1; overflow-y:auto; }
	.sc-row { display:flex; gap:8px; padding:8px 8px 8px 6px; margin-bottom:6px; border:1px solid rgba(255,255,255,.1); border-radius:10px; background:#151c27; cursor:pointer; }
	.sc-row.sel { border-color:#4b90ff; background:#182338; }
	.sc-row.live { border-color:#7db4ff; box-shadow:0 0 0 1px #7db4ff inset; }
	.sc-row.via { background:#131820; border-style:dashed; margin-left:22px; }
	.sc-row.err { border-color:#c0564f; }
	.sc-n { opacity:.5; font-variant-numeric:tabular-nums; min-width:1.4em; text-align:right; padding-top:4px; }
	.sc-main { flex:1; min-width:0; }
	.sc-main input.sc-t { width:100%; box-sizing:border-box; background:transparent; color:#e6edf3; border:none; border-bottom:1px dashed rgba(255,255,255,.15); padding:2px 0 3px; font-size:13.5px; }
	.sc-sub { display:flex; gap:10px; align-items:center; margin-top:5px; font-size:11.5px; opacity:.85; flex-wrap:wrap; }
	.sc-sub input[type=number] { width:44px; background:#0d1117; color:#e6edf3; border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:2px 3px; }
	.sc-sub input[type=number]:disabled { opacity:.35; }
	.sc-sub select { background:#0d1117; color:#e6edf3; border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:2px 3px; font-size:11px; }
	.sc-sub.sc-ctl { flex-wrap:nowrap; gap:7px; }
	.sc-sub.sc-ctl label { display:flex; align-items:center; gap:3px; white-space:nowrap; }
	.sc-via-head { margin-top:0 !important; }
	.sc-sub .sc-hash { opacity:.5; font-size:10.5px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.sc-err-msg { color:#e0837c; font-size:11.5px; margin-top:4px; }
	.sc-ops { display:flex; flex-direction:column; gap:2px; align-items:center; }
	.sc-ops button { background:transparent; color:#9aa7bd; border:none; cursor:pointer; padding:1px 4px; font-size:12px; border-radius:5px; }
	.sc-ops button:hover { background:#243044; color:#fff; }
	.sc-grip { flex:1; display:flex; align-items:center; color:#9aa7bd; cursor:grab; user-select:none; padding:0 4px; font-size:14px; }
	.sc-grip:active { cursor:grabbing; }
	.sc-row.over-top { box-shadow:0 -2px 0 #4b90ff; }
	.sc-row.over-bot { box-shadow:0 2px 0 #4b90ff; }
	.sc-row.dragging { opacity:.45; }
	.sc-foot { display:flex; gap:6px; padding:10px 14px; border-top:1px solid rgba(255,255,255,.08); flex-wrap:wrap; }
	.sc-note { padding:0 14px 8px; font-size:12px; color:#9ec5ff; min-height:1.2em; }
	#sc-stage.sc-drop::after { content:""; position:absolute; inset:10px; border:2px dashed rgba(125,180,255,.8); border-radius:12px; pointer-events:none; }
	.sc-foot button, .sc-foot label { background:#1b2330; color:#e6edf3; border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:6px 10px; cursor:pointer; font-size:12.5px; }
	#sc-export { background:#2b4a7a; border-color:rgba(140,180,255,.4); }
	.sc-empty { opacity:.55; text-align:center; padding:28px 10px; font-size:12.5px; }
	#sc-panel.playing #sc-rows { opacity:.75; }
	#sc-start { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(8,12,20,.72); }
	#sc-start .card { background:#141b26; border:1px solid rgba(255,255,255,.14); border-radius:16px; padding:28px 34px; text-align:center; box-shadow:0 12px 48px rgba(0,0,0,.5); }
	#sc-start h1 { font-size:17px; margin:0 0 4px; color:#e6edf3; }
	#sc-start p { font-size:12px; opacity:.7; margin:0 0 16px; }
	#sc-start .fr { display:flex; gap:10px; justify-content:center; }
	#sc-start button { background:#1b2330; color:#e6edf3; border:1px solid rgba(255,255,255,.2); border-radius:10px; padding:14px 16px; cursor:pointer; font-size:13px; }
	#sc-start button:hover { background:#2b4a7a; }
	#sc-start .box { display:block; margin:0 auto 8px; background:#0d1117; border:1px solid rgba(255,255,255,.35); }
`;

export function mountSceneEditor({ map, stageEl, panelEl, storageKey = "oj.sceneDraft" }) {
	let doc = { type: "scenes", title: "", frame: "16:9", waitLoading: true, scenes: [] };
	let sel = -1, playing = false, liveGroup = -1, saveT = 0;
	let tlDirty = true, tlRefresh = () => {};   // タイムライン（スクラブ）の鮮度＝編集(save)で汚れ、300msデバウンスで作り直す（実体は下のスクラブ節）

	// ── 復元（下書き＝localStorage）。無ければ「定義」＝フレーム選択から始める ──
	let restored = false;
	try { const d = JSON.parse(localStorage.getItem(storageKey) || "null"); if (d?.type === "scenes") { doc = { frame: "16:9", ...d }; restored = true; } } catch { /* 壊れた下書きは捨てる */ }
	const save = () => { tlDirty = true; clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(storageKey, JSON.stringify(doc)); } catch { /* 容量等 */ } tlRefresh(); }, 300); };

	// ── 画面定義：フレーム枠(#sc-frame)を舞台へ内接（自由=舞台いっぱい）。#map は quiet-mono の 100%/100% で枠に従う ──
	const frameEl = stageEl.querySelector("#sc-frame");
	const fit = () => {
		const f = FRAMES[doc.frame];
		if (!f) { frameEl.style.width = "100%"; frameEl.style.height = "100%"; return; }
		const pad = 18, W = stageEl.clientWidth - pad * 2, H = stageEl.clientHeight - 38 - 46 - pad * 2;   // 38/46＝上端カメラ帯・下端スクラブ帯（#sc-stage の padding）
		const k = Math.max(1, Math.min(W / f[0], H / f[1]));
		frameEl.style.width = Math.round(f[0] * k) + "px";
		frameEl.style.height = Math.round(f[1] * k) + "px";
	};
	window.addEventListener("resize", fit);

	// ── パネル（DOM自給）──
	const styleEl = document.createElement("style"); styleEl.textContent = CSS; document.head.append(styleEl);
	// ロゴ＝起動画面と同じ球儀マーク（index.html #boot の一筆書きを currentColor で）
	const LOGO = `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="6"><ellipse cx="50" cy="50" rx="45" ry="45"/><ellipse cx="50" cy="50" rx="25" ry="45"/><path d="M11 28H88 M11 72H88M50 5V95M5 50 H95"/></g></svg>`;
	panelEl.innerHTML = `
		<div class="sc-brand">${LOGO}<span>${t("Scene エディタ")}</span></div>
		<div class="sc-head">
			<input id="sc-title" type="text" placeholder="${t("作品タイトル")}">
			<div class="sc-defrow">
				<label>${t("画角")} <select id="sc-frame-sel">
					${Object.keys(FRAMES).map(k => `<option value="${k}">${k}</option>`).join("")}<option value="free">${t("自由")}</option>
				</select></label>
				<label title="${t("全シーンの街を読み切り、立て切ってから開幕（本番の儀式・書式キーは waitLoading）")}"><input type="checkbox" id="sc-wait"> ${t("Plateauファイルの先読み")}</label>
			</div>
			<div class="sc-tools">
				<button id="sc-shoot" title="${t("今の視点を行として追加（選択行の後ろへ）")}">${t("📷 撮影")}</button>
				<button id="sc-via" title="${t("今の視点を通過点（ドリーの中継）として追加")}">${t("◇ 通過点")}</button>
				<button id="sc-undo" title="${t("直前の操作を取り消す（⌘Z）")}" disabled>${t("↶ 元に戻す")}</button>
			</div>
			<div class="sc-tools">
				<button id="sc-play-here" title="${t("軽い試写（選択行から・未選択なら先頭から。黒幕・読み込み待ちなし）")}">${t("▶ ここから")}</button>
				<button id="sc-dress" title="${t("本番同等＝最初から（黒幕・読み込み待ち・終幕の括弧つき）")}">${t("🎬 上映")}</button>
				<button id="sc-rec" title="${t("上映を録画して動画ファイル（MP4）に＝iMovie 等へそのまま。最初に「このタブを共有」を1回許可")}">${t("🎥 録画")}</button>
				<button id="sc-stop">${t("■ 停止")}</button>
			</div>
		</div>
		<ol id="sc-rows"></ol>
		<div class="sc-note" id="sc-note"></div>
		<div class="sc-foot">
			<button id="sc-export">${t("書き出し .scenes")}</button>
			<label>${t("読み込み")}<input id="sc-load" type="file" accept=".scenes,.gz,.json" hidden></label>
			<button id="sc-clear" title="${t("全行を消して最初から（⌘Z で戻せる）")}">${t("全消去")}</button>
		</div>`;
	const $ = id => panelEl.querySelector(id);
	const rowsEl = $("#sc-rows"), titleEl = $("#sc-title"), waitEl = $("#sc-wait"), frameSel = $("#sc-frame-sel"), noteEl = $("#sc-note"), undoBtn = $("#sc-undo");
	// ── 一言の告知（alert/confirm の代わり・4秒で消える）──
	let noteT = 0;
	const note = msg => { noteEl.textContent = msg; clearTimeout(noteT); noteT = setTimeout(() => { noteEl.textContent = ""; }, 4000); };
	// ── undo（スナップショット式＝台本は小さな JSON・構造操作の前に控える。読込/削除/全消去/並べ替え/撮影/遷移切替が ⌘Z で戻る）──
	const undoStack = [];
	const mark = () => { undoStack.push(JSON.stringify({ doc, sel })); if (undoStack.length > 100) undoStack.shift(); undoBtn.disabled = false; };
	const undo = () => {
		const snap = undoStack.pop();
		undoBtn.disabled = !undoStack.length;
		if (!snap) return;
		({ doc, sel } = JSON.parse(snap));
		save(); fit(); paint();
	};

	// ── compiled index（プレーヤーの scenes[] 位置）への写像＝ここから試写・行ハイライト用。
	//    compileVias/parseScenes と同じ裁き：via は次の view/glide 行（着点）に属す・出発点前/着点無しの via は -1（捨てられる）
	//    規則の正本は adapter（parseScenes/compileVias の trace）＝ここで同じ裁きを書き直さない
	const groupsOf = rows => {
		const g = new Array(rows.length).fill(-1), t1 = {}, t2 = {};
		const p = parseScenes({ scenes: rows }, [], t1);
		compileVias(p.scenes, [], t2);
		p.scenes.forEach((_, k) => { g[t1.rowIdx[k]] = t2.group[k]; });
		return g;
	};

	// ── 行の描画（構造変更で全再描画・入力はモデル直結＝再描画しない） ──
	const paint = () => {
		titleEl.value = doc.title ?? "";
		waitEl.checked = !!doc.waitLoading;
		frameSel.value = FRAMES[doc.frame] ? doc.frame : "free";
		panelEl.classList.toggle("playing", playing);
		const issues = [], tr1 = {}, sub = [];
		const parsed = parseScenes(doc, issues, tr1);
		compileVias(parsed.scenes, sub, {});   // 畳み込みの診断はプレーヤーと同じ順（parse 後の行）で＝空行を挟んだ via を孤児にしない
		for (const x of sub) issues.push({ ...x, row: tr1.rowIdx[x.row] });   // 元の行番号へ写す（scene-format.md §7）
		const errOf = i => issues.filter(x => x.row === i).map(x => x.msg).join(" / ");
		const groups = groupsOf(doc.scenes);
		rowsEl.innerHTML = doc.scenes.length ? doc.scenes.map((r, i) => {
			const via = isVia(r), err = errOf(i);
			const hash = esc((hashOf(r) ?? "").split("/l=")[0]);
			const trans = r.glide ? "glide" : r.fade ? "fade" : "view";
			const afterVia = i > 0 && isVia(doc.scenes[i - 1]);   // via の着点＝地図遷移でも travel（最終区間の尺）が効く
			const num = v => (Number.isFinite(v) ? v : "");   // 数値欄＝数値以外は空（台本由来の値も属性へ素で入れない）
			const travelInput = dis => `<input type="number" data-k="travel" step="0.5" min="0" value="${num(r.travel)}" placeholder="${t("自動")}"${dis ? ` disabled title="${t("地図遷移の尺は自動（通過点の着点なら有効）")}"` : ""}>`;
			return `<li class="sc-row${via ? " via" : ""}${i === sel ? " sel" : ""}${groups[i] >= 0 && groups[i] === liveGroup ? " live" : ""}${err ? " err" : ""}" data-i="${i}">
				<span class="sc-n">${i + 1}</span>
				<div class="sc-main">
					${via
		? `<div class="sc-sub sc-via-head">${t("◇ 通過点")} <label title="${t("この点に到達するまでの秒（ドリーの緩急・省略=自動）")}">${t("遷移")} ${travelInput(false)}${t("秒")}</label></div>`
		: `<input class="sc-t" data-k="title" value="${esc(r.title)}" placeholder="${t("キャプション")}">`}
					<div class="sc-sub">
						<button data-op="reshoot" title="${t("この行の視点を今のカメラで撮り直す")}">${t("📷再撮影")}</button>
						<span class="sc-hash">${hash}</span>
					</div>
					${via ? "" : `<div class="sc-sub sc-ctl">
						<label>${t("保持")} <input type="number" data-k="hold" step="0.5" min="0" value="${num(r.hold)}" placeholder="3">${t("秒")}</label>
						<label>${t("遷移")} <select data-k="trans">
							<option value="view"${trans === "view" ? " selected" : ""}>${t("地図遷移")}</option>
							<option value="glide"${trans === "glide" ? " selected" : ""}>${t("直線移動")}</option>
							<option value="fade"${trans === "fade" ? " selected" : ""}>${t("フェード")}</option>
						</select></label>
						<label title="${t("遷移の秒（直線移動/フェード・通過点の着点。省略=自動）")}">${travelInput(trans === "view" && !afterVia)}${t("秒")}</label>
					</div>`}
					${err ? `<div class="sc-err-msg">⚠ ${esc(err)}</div>` : ""}
				</div>
				<div class="sc-ops">
					<button data-op="del" title="${t("削除")}">✕</button>
					<span class="sc-grip" draggable="true" title="${t("ドラッグで並べ替え")}">⠿</span>
				</div>
			</li>`;
		}).join("") : `<li class="sc-empty">${t("地図を構図して「📷 撮影」＝permalink がそのまま行になる。<br>view の間に「◇ 通過点」を挟むと1本のドリーで貫く。<br><br>行クリック＝その視点へ・⠿＝並べ替え・ファイルはここへドロップ")}</li>`;
	};

	// ── 撮影 ──
	const insertAt = () => (sel >= 0 && sel < doc.scenes.length ? sel + 1 : doc.scenes.length);
	const shoot = () => { mark(); const r = { title: "", view: map.view.hash }; doc.scenes.splice(insertAt(), 0, r); sel = doc.scenes.indexOf(r); save(); paint(); return r; };
	const addVia = () => { mark(); const r = { via: map.view.hash }; doc.scenes.splice(insertAt(), 0, r); sel = doc.scenes.indexOf(r); save(); paint(); return r; };

	// ── 試写（scene-player API）：quick＝黒幕・ゲート・括弧なし／dress＝本番同等。onScene で行ハイライト＋上映ヘッド再同期・onEnd で解除 ──
	const play = opts => {
		map.stopScenes();
		const okd = map.playScenes(doc, {
			...opts,
			onScene: ci => { liveGroup = ci; paint(); headSync(ci); },
			onEnd: r => { playing = false; liveGroup = -1; headStop(); paint(); opts?.onEnd?.(r); },   // 呼び出し側の onEnd も連鎖（録画の停止フック等）
		});
		playing = okd === true; liveGroup = -1; paint();
		return okd;
	};
	const playFrom = () => play({ quick: true, from: Math.max(0, groupsOf(doc.scenes)[sel] ?? 0) });
	const stop = () => map.stopScenes();

	// ── タイムライン・スクラブ（map.sceneTimeline＝時刻評価・scene-format.md §7）：ドラッグで任意秒の絵＝再生せず構図と緩急を確かめる ──
	// 総尺は常時表示（作品の長さの読み）。目盛り＝行ごとの遷移(青)+保持(白)・◇通過点=黄の刻み。編集(save)の300msデバウンスで作り直し。
	// ドラッグ中は行ハイライト（.live＝試写と同じ印）が追随・離した時に URL を1回確定（tl.end()＝saveView の掟）。
	const scrub = document.createElement("div");
	scrub.id = "sc-scrub";
	scrub.innerHTML = `<div class="tk" title="${t("タイムライン＝ドラッグでその時刻の絵（上映は止まる）")}"></div><span class="tm"></span>`;
	stageEl.append(scrub);
	const scrubTk = scrub.querySelector(".tk"), scrubTm = scrub.querySelector(".tm");
	const fmtSec = s => (Math.round(s * 10) / 10).toFixed(1) + "s";
	let tl = null, scrubSec = 0;
	tlRefresh = () => {
		tlDirty = false;
		try { tl = doc.scenes.length ? (map.sceneTimeline?.(doc) ?? null) : null; } catch { tl = null; }   // 診断エラー中の台本でも落とさない（バーを引っ込めるだけ）
		scrub.style.display = tl ? "" : "none";
		if (!tl) return;
		scrubSec = Math.min(scrubSec, tl.dur);
		const W = 100 / tl.dur;
		scrubTk.innerHTML = tl.rows.map(r => (r.tArrive > r.t0 ? `<div class="sg tr" style="left:${(r.t0 * W).toFixed(3)}%;width:${((r.tArrive - r.t0) * W).toFixed(3)}%"></div>` : "")
			+ `<div class="sg" style="left:${(r.tArrive * W).toFixed(3)}%;width:${((r.t1 - r.tArrive) * W).toFixed(3)}%"></div>`
			+ (r.knots || []).slice(0, -1).map(k => `<div class="kn" style="left:${((r.t0 + k) * W).toFixed(3)}%"></div>`).join("")).join("")
			+ `<div class="ph" style="left:${(scrubSec * W).toFixed(3)}%"></div>`;
		scrubTm.textContent = `${fmtSec(scrubSec)} / ${fmtSec(tl.dur)}`;
	};
	const headPaint = sec => {   // ヘッドと時刻の表示だけ（seek しない）＝スクラブと上映追随の共用
		const ph = scrubTk.querySelector(".ph");
		if (ph) ph.style.left = (sec / tl.dur * 100) + "%";
		scrubTm.textContent = `${fmtSec(sec)} / ${fmtSec(tl.dur)}`;
	};
	const seekAt = clientX => {
		const rc = scrubTk.getBoundingClientRect();
		if (!tl || !rc.width) return;
		scrubSec = Math.max(0, Math.min(1, (clientX - rc.left) / rc.width)) * tl.dur;
		tl.seek(scrubSec);
		headPaint(scrubSec);
		const ci = tl.at(scrubSec).i;   // 行ハイライト追随（compiled index＝試写の onScene と同じ座標系）
		if (ci !== liveGroup) {
			liveGroup = ci;
			const g = groupsOf(doc.scenes);
			rowsEl.querySelectorAll(".sc-row").forEach(li => li.classList.toggle("live", g[+li.dataset.i] === ci));
		}
	};
	// 上映ヘッド＝再生中の現在位置をバーに追随表示（表示のみ・seek しない＝絵は本物の再生が描いている）。
	// 行頭（onScene）で実時間クロックを t0 へ再同期し、行の終端 t1 で待機＝実再生の揺らぎ（読み待ち・着地待ち・
	// 200ms刻みの計時）は次の行頭で吸収する。遷移尺はプラン共有（flight 時刻評価）＝道中はほぼ実尺どおり進む。
	// 止めは世代トークン（flight.js の cancelled と同じ流儀）＝rAF が setTimeout に差し替わる虚時間ハーネスでも確実に止まる
	let headRun = 0;
	const headSync = ci => {
		if (tlDirty || !tl) tlRefresh();
		const r = tl?.rows[ci];
		if (!r) return;
		const run = ++headRun;
		const t0 = performance.now();
		const step = () => {
			if (run !== headRun) return;
			scrubSec = Math.min(r.t1, r.t0 + (performance.now() - t0) / 1000);
			headPaint(scrubSec);
			requestAnimationFrame(step);
		};
		step();
	};
	const headStop = () => { headRun++; };
	let scrubbing = false;
	scrubTk.addEventListener("pointerdown", e => {
		map.stopScenes();   // スクラブは上映と排他（掴んだら止める＝主導権は人）
		if (tlDirty || !tl) tlRefresh();
		if (!tl) return;
		scrubbing = true;
		try { scrubTk.setPointerCapture(e.pointerId); } catch { /* 合成イベント（テスト）等 */ }
		seekAt(e.clientX);
	});
	scrubTk.addEventListener("pointermove", e => { if (scrubbing) seekAt(e.clientX); });
	const scrubEnd = () => { if (scrubbing) { scrubbing = false; tl?.end(); } };   // 離す＝URL確定（saveView は1回）
	scrubTk.addEventListener("pointerup", scrubEnd);
	scrubTk.addEventListener("pointercancel", scrubEnd);

	// ── 録画（🎥）＝画角フレームを Region Capture でタブから切り出し、MediaRecorder の MP4/H.264 で直接動画ファイル化 ──
	// iMovie 等へそのまま渡せる .mp4（MP4 録画が無い環境だけ .webm へフォールバック）。字幕・黒フェード等の DOM 演出も忠実に写る。
	// 画質＝①録画中は動的解像度を固定（map.pinRes・縮み絵を混ぜない）②フレームを目標解像度（16:9=1920×1080 等）の
	// CSS×dpr サイズへ一時リサイズ（舞台に入り切らない分は内接クランプ＝実際に切り出されるのは画面上のピクセル）③高ビットレート。
	// 頭とケツ＝上映の儀式そのまま：黒幕が立ってから録画開始・終幕の黒が完成した頃に停止＝黒 in/黒 out の完成素材。
	const REC_RES = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:3": [1440, 1080] };
	let recState = null;
	const recFit = () => {   // 目標解像度に合わせた CSS サイズへ（戻しは fit()）。返り値＝実効デバイス px
		const t = REC_RES[doc.frame], dpr = devicePixelRatio || 1;
		if (!t) return [Math.round(frameEl.clientWidth * dpr), Math.round(frameEl.clientHeight * dpr)];   // 自由枠＝今の実寸のまま
		const pad = 18, cssW = t[0] / dpr, cssH = t[1] / dpr;
		const k = Math.min(1, (stageEl.clientWidth - pad * 2) / cssW, (stageEl.clientHeight - 38 - 46 - pad * 2) / cssH);
		frameEl.style.width = Math.round(cssW * k) + "px"; frameEl.style.height = Math.round(cssH * k) + "px";
		return [Math.round(cssW * k * dpr), Math.round(cssH * k * dpr)];
	};
	const record = async () => {
		if (playing || recState) return false;
		const px = recFit();
		map.pinRes?.(true);   // 動的解像度を固定＝録画に縮み絵を混ぜない
		let stream;
		try {
			stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false, preferCurrentTab: true });
		} catch { map.pinRes?.(false); fit(); return false; }   // 共有ダイアログのキャンセル＝静かに戻す
		const [track] = stream.getVideoTracks();
		try { await track.cropTo(await CropTarget.fromElement(frameEl)); } catch { /* Region Capture 非対応＝タブ全面のまま */ }
		const mime = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find(m => MediaRecorder.isTypeSupported(m)) || "";
		const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: Math.max(12e6, Math.round(px[0] * px[1] * 30 * 0.2)) });   // ≈0.2bit/px/frame（1080p30≒12Mbps・編集の中間素材として十分な高品質）
		const chunks = [];
		rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
		const recBtn = $("#sc-rec");
		const finalize = () => {   // 保存＋原状復帰の一本道（停止・共有停止・エラーどの経路でもここ）
			if (!recState) return;
			clearTimeout(recState.timer); recState = null;
			stream.getTracks().forEach(t2 => t2.stop());
			map.pinRes?.(false); fit(); recBtn.textContent = t("🎥 録画");
			const blob = new Blob(chunks, { type: mime || "video/webm" });
			if (!blob.size) return;
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = `${(doc.title || "untitled").replace(/[\\/:*?"<>|]/g, "_")}.${mime.startsWith("video/mp4") ? "mp4" : "webm"}`;
			a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
		};
		rec.onstop = finalize;
		track.addEventListener("ended", () => { map.stopScenes(); if (rec.state !== "inactive") rec.stop(); else finalize(); });   // Chrome の「共有を停止」からも安全に閉じる
		recState = { rec, stream, timer: 0 };
		recBtn.textContent = t("⏺ 録画中…");
		// 上映の儀式で再生：終演(finished)＝終幕の黒が完成した頃に停止（黒 out）／中断(stopped)＝間を置かず停止（素材は保存）
		const okd = play({ onEnd: r => { if (recState) recState.timer = setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, r === "finished" ? 1700 : 300); } });
		if (okd !== true) { finalize(); return false; }
		setTimeout(() => { if (recState && rec.state === "inactive") rec.start(1000); }, 150);   // 黒幕が乗った直後から＝頭は黒 in
		return true;
	};

	// ── 出力／読み込み ──
	const exportText = () => JSON.stringify(doc, null, 2);
	const download = () => {
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([exportText()], { type: "application/json" }));
		a.download = `${(doc.title || "untitled").replace(/[\\/:*?"<>|]/g, "_")}.scenes`;
		a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
	};
	const load = obj => { if (obj?.type !== "scenes") return false; mark(); doc = { frame: "16:9", ...obj }; sel = -1; save(); fit(); paint(); return true; };   // 読込＝下書きの上書きも ⌘Z で戻る

	// ── 配線 ──
	titleEl.addEventListener("input", () => { doc.title = titleEl.value; save(); });
	waitEl.addEventListener("change", () => { doc.waitLoading = waitEl.checked; save(); });
	frameSel.addEventListener("change", () => { doc.frame = frameSel.value; save(); fit(); });
	$("#sc-shoot").addEventListener("click", shoot);
	$("#sc-via").addEventListener("click", addVia);
	$("#sc-play-here").addEventListener("click", playFrom);   // 未選択＝先頭から（「最初から」は本番に統合＝ボタンは少なく）
	$("#sc-dress").addEventListener("click", () => play({}));
	$("#sc-rec").addEventListener("click", record);
	$("#sc-stop").addEventListener("click", stop);
	$("#sc-export").addEventListener("click", download);
	$("#sc-clear").addEventListener("click", () => { if (!doc.scenes.length) return; mark(); doc.scenes = []; sel = -1; save(); paint(); note(t("全行を消しました（⌘Z で戻せる）")); });   // 確認ダイアログなし＝undo が安全網
	$("#sc-undo").addEventListener("click", undo);
	const openFile = async f => {   // ファイル入力・ドロップ共通（.scenes / .scenes.gz / .json＝gzip も中身判定で解凍）
		const obj = await sniffScene(f);
		if (load(obj)) note(t("読み込みました: {0}", f.name)); else note(t("scenes 台本として読めませんでした（type:\"scenes\" が必要）"));
	};
	$("#sc-load").addEventListener("change", e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) openFile(f); });
	// ドロップ受付（舞台・パネルとも）：dropFile ガジェットはこのページに載せない＝落とした台本は再生でなく編集へ
	let dropDepth = 0;
	const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
	const dropTargets = [stageEl, panelEl];
	const onDragEnter = e => { if (hasFiles(e)) { e.preventDefault(); dropDepth++; stageEl.classList.add("sc-drop"); } };
	const onDragOver = e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } };
	const onDragLeave = () => { if (--dropDepth <= 0) { dropDepth = 0; stageEl.classList.remove("sc-drop"); } };
	const onDrop = e => { dropDepth = 0; stageEl.classList.remove("sc-drop"); if (!hasFiles(e)) return; e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) openFile(f); };
	for (const el of dropTargets) { el.addEventListener("dragenter", onDragEnter); el.addEventListener("dragover", onDragOver); el.addEventListener("dragleave", onDragLeave); el.addEventListener("drop", onDrop); }
	// キー操作（PC ツール）：⌘Z/⇧⌘Z は undo（redo は未実装＝⇧は無視）・Delete＝選択行の削除・Space＝試写/停止。入力中は譲る
	const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable); };
	const onKey = e => {
		if (typing()) return;
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (!e.shiftKey) undo(); return; }
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0 && sel < doc.scenes.length && !playing) { e.preventDefault(); mark(); doc.scenes.splice(sel, 1); if (sel >= doc.scenes.length) sel = doc.scenes.length - 1; save(); paint(); return; }
		if (e.key === " " && !document.getElementById("demo-bar")?.classList.contains("on")) { e.preventDefault(); playFrom(); }   // 上映中の Space はプレーヤー側（bare モードでは無視）
	};
	window.addEventListener("keydown", onKey);
	rowsEl.addEventListener("input", e => {   // 行の入力＝モデル直結（再描画しない＝フォーカスを保つ）
		const li = e.target.closest(".sc-row"); if (!li) return;
		const r = doc.scenes[+li.dataset.i], k = e.target.dataset.k;
		if (!r || !k || k === "glide") return;
		if (k === "title") r.title = e.target.value;
		else { const v = parseFloat(e.target.value); if (Number.isFinite(v)) r[k] = v; else delete r[k]; }   // 空欄＝キー削除（既定へ）
		save();
	});
	rowsEl.addEventListener("change", e => {   // 遷移セレクタだけ change（キー名が変わる＝再描画）。v2 の掟＝キー名が遷移
		const li = e.target.closest(".sc-row"); if (!li || e.target.dataset.k !== "trans") return;
		const r = doc.scenes[+li.dataset.i], h = r.view ?? r.glide ?? r.fade;
		mark();
		delete r.view; delete r.glide; delete r.fade;
		r[e.target.value] = h;   // "view"（地図遷移）| "glide"（移動）| "fade"（フェード＝黒挟み）
		save(); paint();
	});
	rowsEl.addEventListener("click", e => {
		const li = e.target.closest(".sc-row"); if (!li) return;
		const i = +li.dataset.i, r = doc.scenes[i], op = e.target.dataset.op;
		if (op === "del") { mark(); doc.scenes.splice(i, 1); if (sel >= doc.scenes.length) sel = doc.scenes.length - 1; save(); paint(); return; }
		if (op === "reshoot") { mark(); const h = map.view.hash; if (r.view) r.view = h; else if (r.glide) r.glide = h; else if (r.fade) r.fade = h; else r.via = h; save(); paint(); return; }
		if (e.target.closest("input, label, select")) { sel = i; li.classList.add("sel"); return; }   // 入力操作＝選択だけ（再描画もしない＝フォーカス保持）
		sel = i; paint();
		if (!playing) location.hash = hashOf(r) ?? location.hash;   // 行クリック＝その視点へ（シーン切替が編集の主動線・URL一元化の道＝flyView が飛ぶ）
	});
	// number 入力へのホイール誤爆を断つ：フォーカス中の hold/travel にカーソルが乗ったままパネルをスクロールすると
	// Chrome 標準で値が回ってしまう＝「hold が勝手に変わる」の正体。1目盛りも入れずに止めて blur（以降は素直にスクロール）
	rowsEl.addEventListener("wheel", e => {
		if (e.target.matches?.('input[type="number"]')) { e.preventDefault(); e.target.blur(); }
	}, { passive: false });
	// 並べ替え＝右のハンドル（⠿）をドラッグ。HTML5 DnD 素実装（依存ゼロ）：上半分=前へ・下半分=後ろへ挿す
	let dragI = -1, overEl = null;
	const clearOver = () => { overEl?.classList.remove("over-top", "over-bot"); overEl = null; };
	rowsEl.addEventListener("dragstart", e => {
		const li = e.target.closest?.(".sc-row");
		if (!e.target.closest?.(".sc-grip") || !li) { e.preventDefault(); return; }   // 掴めるのはハンドルだけ（タイトルの文字ドラッグ等は殺す）
		dragI = +li.dataset.i;
		li.classList.add("dragging");
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", String(dragI));
		e.dataTransfer.setDragImage?.(li, 20, 20);
	});
	rowsEl.addEventListener("dragover", e => {
		if (dragI < 0) return;
		e.preventDefault(); e.dataTransfer.dropEffect = "move";
		const li = e.target.closest(".sc-row");
		if (li !== overEl) clearOver();
		if (li && +li.dataset.i !== dragI) {
			overEl = li;
			const r = li.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
			li.classList.toggle("over-top", top); li.classList.toggle("over-bot", !top);
		}
	});
	rowsEl.addEventListener("drop", e => {
		if (dragI < 0) return;
		e.preventDefault();
		const li = e.target.closest(".sc-row");
		let to = doc.scenes.length;
		if (li) { const r = li.getBoundingClientRect(); to = +li.dataset.i + (e.clientY < r.top + r.height / 2 ? 0 : 1); }
		mark();
		const [row] = doc.scenes.splice(dragI, 1);
		if (to > dragI) to--;
		doc.scenes.splice(to, 0, row);
		sel = to; dragI = -1; clearOver(); save(); paint();
	});
	rowsEl.addEventListener("dragend", () => { dragI = -1; clearOver(); paint(); });

	// ── 定義（最初の一歩）：下書きが無ければフレーム選択から ──
	if (!restored) {
		const start = document.createElement("div");
		start.id = "sc-start";
		const box = (w, h) => `<svg class="box" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="currentColor"/></svg>`;
		start.innerHTML = `<div class="card"><h1>${t("画面の定義")}</h1><p>${t("z と画面サイズは独立＝この枠が作品の画角になります（後から変更可）")}</p>
			<div class="fr">
				<button data-f="16:9">${box(64, 36)}${t("16:9 横")}</button>
				<button data-f="9:16">${box(27, 48)}${t("9:16 縦")}</button>
				<button data-f="1:1">${box(44, 44)}1:1</button>
				<button data-f="free">${box(64, 44)}${t("自由")}</button>
			</div></div>`;
		start.addEventListener("click", e => {
			const b = e.target.closest("button[data-f]"); if (!b) return;
			doc.frame = b.dataset.f; save(); fit(); paint(); start.remove();
		});
		stageEl.append(start);
	}

	// ── カメラ実位置チップ（本人「参考値程度・上映/録画時の確認用」）＝画角フレームの外・上方の帯＝録画クロップには写らない ──
	// 表示＝緯度・経度・高度・方位・チルト（map.view.eye＝透視カメラそのものの位置。中心でなくカメラ＝チルト時は注視点の後方上空）。
	// 更新は rAF・DOM書込は文字が変わる時だけ。
	const camChip = document.createElement("div");
	camChip.id = "sc-cam";
	stageEl.append(camChip);
	const fmtAlt = m => m < 10000 ? `${Math.round(m)} m` : m < 100000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000).toLocaleString("en")} km`;
	let camTxt = "";
	const camTick = () => {   // エンジンの描画フック＝地図が動いた時だけ（常時 rAF で回さない）
		const v = map.view, e = v.eye;
		if (!e) return;
		const brg = Math.round(((v.bearing * 180 / Math.PI) % 360 + 360) % 360) % 360;
		// 視野の角度（本人指定・チルトは各行の permalink にある）＝水平×垂直。垂直=エンジンの fovy（既定50°）・
		// 水平=画角フレームのアスペクトから 2·atan(tan(fovy/2)·W/H)＝16:9で79°・9:16で29°（レンズの素性が一目）
		const asp = map.mapEl.clientHeight ? map.mapEl.clientWidth / map.mapEl.clientHeight : 1;
		const hFov = Math.round(2 * Math.atan(Math.tan(e.fovy / 2) * asp) * 180 / Math.PI), vFov = Math.round(e.fovy * 180 / Math.PI);
		const pos = `${Math.abs(e.lat).toFixed(4)}°${e.lat < 0 ? "S" : "N"} ${Math.abs(e.lon).toFixed(4)}°${e.lon < 0 ? "W" : "E"}`;
		const txt = t("カメラ {0}　高度 {1}　方位 {2}°　視野 {3}°×{4}°", pos, fmtAlt(e.altM), brg, hFov, vFov);
		if (txt !== camTxt) { camTxt = txt; camChip.textContent = txt; }
	};
	const unsubCam = map.onFrame ? map.onFrame(camTick) : (requestAnimationFrame(camTick), () => {});
	camTick();

	// ── 出典（#attr）＝画角フレームの外へ＝パネル最下部（録画の絵を汚さない・クレジットは常時視認）。app が作った実体を養子縁組 ──
	const adoptAttr = tries => {
		const a = map.mapEl.querySelector("#attr") || document.getElementById("attr");
		if (a) panelEl.append(a); else if (tries < 50) setTimeout(() => adoptAttr(tries + 1), 100);
	};
	adoptAttr(0);

	fit(); paint(); tlRefresh();
	const destroy = () => {
		window.removeEventListener("resize", fit); window.removeEventListener("keydown", onKey); clearTimeout(saveT); clearTimeout(noteT);
		for (const el of dropTargets) { el.removeEventListener("dragenter", onDragEnter); el.removeEventListener("dragover", onDragOver); el.removeEventListener("dragleave", onDragLeave); el.removeEventListener("drop", onDrop); }
		map.stopScenes?.(); headStop(); unsubCam(); camChip.remove(); styleEl.remove(); scrub.remove();
	};
	return { get doc() { return doc; }, load, exportText, shoot, addVia, play, playFrom, stop, fit, destroy, undo, openFile,
		get canUndo() { return undoStack.length > 0; },
		select: i => { sel = i; paint(); } };
}
