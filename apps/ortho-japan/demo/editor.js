// scenes エディタの芯（器は apps/ortho-japan/scene.html・回帰は tests/t-scene.html）。
// 流れ＝「定義（画面フレーム）→ 撮影（撮る/通過点・並べ替え）→ 編集（hold/travel/glide・字幕）→ 出力（.scenes）」。
// 肝＝z と画面サイズが独立（正射の掟・[[ortho-z-definition]]）：最初に選ぶフレーム（16:9 等）そのものが作品の画角で、
//   枠(#sc-frame)を舞台に内接させ #map（quiet-mono の 100%/100%）がそれに従う＝構図した通りが再生・録画される。
// ガジェット三戒に従い DOM 自給。依存は map の公開面だけ＝map.view（撮る）・map.playScenes/stopScenes（試写・scene-format.md §7）・
//   location.hash（行ジャンプ＝URL⇄描画状態の一元化に乗る）・純関数 parseScenes/compileVias（診断）。
// フレームは .scenes の top-level `frame:"16:9"`（任意・プレーヤーは無視＝エディタ用メタ）として保存・復元。
import { parseScenes, compileVias } from "./scene-adapter.js";
import { sniffScene } from "../gadgets/dropfile.js";

const FRAMES = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:3": [4, 3] };   // "free"＝舞台いっぱい（枠なし）
const isVia = r => r?.via != null && !r.view && !r.glide && !r.fade;
const hashOf = r => r.view ?? r.glide ?? r.fade ?? r.via;   // 行の視点（遷移キー3種＋via）

const CSS = `
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
	.sc-foot { display:flex; gap:6px; padding:10px 14px; border-top:1px solid rgba(255,255,255,.08); }
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

	// ── 復元（下書き＝localStorage）。無ければ「定義」＝フレーム選択から始める ──
	let restored = false;
	try { const d = JSON.parse(localStorage.getItem(storageKey) || "null"); if (d?.type === "scenes") { doc = { frame: "16:9", ...d }; restored = true; } } catch { /* 壊れた下書きは捨てる */ }
	const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(storageKey, JSON.stringify(doc)); } catch { /* 容量等 */ } }, 300); };

	// ── 画面定義：フレーム枠(#sc-frame)を舞台へ内接（自由=舞台いっぱい）。#map は quiet-mono の 100%/100% で枠に従う ──
	const frameEl = stageEl.querySelector("#sc-frame");
	const fit = () => {
		const f = FRAMES[doc.frame];
		if (!f) { frameEl.style.width = "100%"; frameEl.style.height = "100%"; return; }
		const pad = 18, W = stageEl.clientWidth - pad * 2, H = stageEl.clientHeight - pad * 2;
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
		<div class="sc-brand">${LOGO}<span>Scene エディタ</span></div>
		<div class="sc-head">
			<input id="sc-title" type="text" placeholder="作品タイトル">
			<div class="sc-defrow">
				<label>画角 <select id="sc-frame-sel">
					${Object.keys(FRAMES).map(k => `<option value="${k}">${k}</option>`).join("")}<option value="free">自由</option>
				</select></label>
				<label title="全シーンの街を読み切り、立て切ってから開幕（本番の儀式・書式キーは waitLoading）"><input type="checkbox" id="sc-wait"> Plateauファイルの先読み</label>
			</div>
			<div class="sc-tools">
				<button id="sc-shoot" title="今の視点を行として追加（選択行の後ろへ）">📷 撮影</button>
				<button id="sc-via" title="今の視点を通過点（ドリーの中継）として追加">◇ 通過点</button>
			</div>
			<div class="sc-tools">
				<button id="sc-play-here" title="軽い試写（選択行から・未選択なら先頭から。黒幕・読み込み待ちなし）">▶ ここから</button>
				<button id="sc-dress" title="本番同等＝最初から（黒幕・読み込み待ち・終幕の括弧つき）">🎬 上映</button>
				<button id="sc-stop">■ 停止</button>
			</div>
		</div>
		<ol id="sc-rows"></ol>
		<div class="sc-foot">
			<button id="sc-export">書き出し .scenes</button>
			<label>読み込み<input id="sc-load" type="file" accept=".scenes,.gz,.json" hidden></label>
			<button id="sc-clear" title="全行を消して最初から">全消去</button>
		</div>`;
	const $ = id => panelEl.querySelector(id);
	const rowsEl = $("#sc-rows"), titleEl = $("#sc-title"), waitEl = $("#sc-wait"), frameSel = $("#sc-frame-sel");

	// ── compiled index（プレーヤーの scenes[] 位置）への写像＝ここから試写・行ハイライト用。
	//    compileVias/parseScenes と同じ裁き：via は次の view/glide 行（着点）に属す・出発点前/着点無しの via は -1（捨てられる）
	const groupsOf = rows => {
		const g = new Array(rows.length).fill(-1);
		let gi = -1, pend = [], seenView = false;
		rows.forEach((r, i) => {
			if (isVia(r)) { if (seenView) pend.push(i); return; }
			gi++; g[i] = gi;
			if (r.view || r.glide || r.fade) { seenView = true; pend.forEach(p => { g[p] = gi; }); }
			pend = [];
		});
		return g;
	};

	// ── 行の描画（構造変更で全再描画・入力はモデル直結＝再描画しない） ──
	const paint = () => {
		titleEl.value = doc.title ?? "";
		waitEl.checked = !!doc.waitLoading;
		frameSel.value = FRAMES[doc.frame] ? doc.frame : "free";
		panelEl.classList.toggle("playing", playing);
		const issues = [];
		parseScenes(doc, issues); compileVias(doc.scenes, issues);   // 診断＝原本の行番号で集める（scene-format.md §7）
		const errOf = i => issues.filter(x => x.row === i).map(x => x.msg).join(" / ");
		const groups = groupsOf(doc.scenes);
		rowsEl.innerHTML = doc.scenes.length ? doc.scenes.map((r, i) => {
			const via = isVia(r), err = errOf(i);
			const hash = (hashOf(r) ?? "").split("/l=")[0];
			const trans = r.glide ? "glide" : r.fade ? "fade" : "view";
			const afterVia = i > 0 && isVia(doc.scenes[i - 1]);   // via の着点＝地図遷移でも travel（最終区間の尺）が効く
			const travelInput = dis => `<input type="number" data-k="travel" step="0.5" min="0" value="${r.travel ?? ""}" placeholder="自動"${dis ? ` disabled title="地図遷移の尺は自動（通過点の着点なら有効）"` : ""}>`;
			return `<li class="sc-row${via ? " via" : ""}${i === sel ? " sel" : ""}${groups[i] >= 0 && groups[i] === liveGroup ? " live" : ""}${err ? " err" : ""}" data-i="${i}">
				<span class="sc-n">${i + 1}</span>
				<div class="sc-main">
					${via
		? `<div class="sc-sub sc-via-head">◇ 通過点 <label title="この点に到達するまでの秒（ドリーの緩急・省略=自動）">遷移 ${travelInput(false)}秒</label></div>`
		: `<input class="sc-t" data-k="title" value="${(r.title ?? "").replace(/"/g, "&quot;")}" placeholder="キャプション">`}
					<div class="sc-sub">
						<button data-op="reshoot" title="この行の視点を今のカメラで撮り直す">📷再撮影</button>
						<span class="sc-hash">${hash}</span>
					</div>
					${via ? "" : `<div class="sc-sub sc-ctl">
						<label>保持 <input type="number" data-k="hold" step="0.5" min="0" value="${r.hold ?? ""}" placeholder="5.5">秒</label>
						<label>遷移 <select data-k="trans">
							<option value="view"${trans === "view" ? " selected" : ""}>地図遷移</option>
							<option value="glide"${trans === "glide" ? " selected" : ""}>直線移動</option>
							<option value="fade"${trans === "fade" ? " selected" : ""}>フェード</option>
						</select></label>
						<label title="遷移の秒（直線移動/フェード・通過点の着点。省略=自動）">${travelInput(trans === "view" && !afterVia)}秒</label>
					</div>`}
					${err ? `<div class="sc-err-msg">⚠ ${err}</div>` : ""}
				</div>
				<div class="sc-ops">
					<button data-op="del" title="削除">✕</button>
					<span class="sc-grip" draggable="true" title="ドラッグで並べ替え">⠿</span>
				</div>
			</li>`;
		}).join("") : `<li class="sc-empty">地図を構図して「📷 撮影」＝permalink がそのまま行になる。<br>view の間に「◇ 通過点」を挟むと1本のドリーで貫く。<br><br>行クリック＝その視点へ・⠿＝並べ替え</li>`;
	};

	// ── 撮影 ──
	const insertAt = () => (sel >= 0 && sel < doc.scenes.length ? sel + 1 : doc.scenes.length);
	const shoot = () => { const r = { title: "", view: map.view.hash }; doc.scenes.splice(insertAt(), 0, r); sel = doc.scenes.indexOf(r); save(); paint(); return r; };
	const addVia = () => { const r = { via: map.view.hash }; doc.scenes.splice(insertAt(), 0, r); sel = doc.scenes.indexOf(r); save(); paint(); return r; };

	// ── 試写（scene-player API）：quick＝黒幕・ゲート・括弧なし／dress＝本番同等。onScene で行ハイライト・onEnd で解除 ──
	const play = opts => {
		map.stopScenes();
		const okd = map.playScenes(doc, {
			...opts,
			onScene: ci => { liveGroup = ci; paint(); },
			onEnd: () => { playing = false; liveGroup = -1; paint(); },
		});
		playing = okd === true; liveGroup = -1; paint();
		return okd;
	};
	const playFrom = () => play({ quick: true, from: Math.max(0, groupsOf(doc.scenes)[sel] ?? 0) });
	const stop = () => map.stopScenes();

	// ── 出力／読み込み ──
	const exportText = () => JSON.stringify(doc, null, 2);
	const download = () => {
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([exportText()], { type: "application/json" }));
		a.download = `${(doc.title || "untitled").replace(/[\\/:*?"<>|]/g, "_")}.scenes`;
		a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
	};
	const load = obj => { if (obj?.type !== "scenes") return false; doc = { frame: "16:9", ...obj }; sel = -1; save(); fit(); paint(); return true; };

	// ── 配線 ──
	titleEl.addEventListener("input", () => { doc.title = titleEl.value; save(); });
	waitEl.addEventListener("change", () => { doc.waitLoading = waitEl.checked; save(); });
	frameSel.addEventListener("change", () => { doc.frame = frameSel.value; save(); fit(); });
	$("#sc-shoot").addEventListener("click", shoot);
	$("#sc-via").addEventListener("click", addVia);
	$("#sc-play-here").addEventListener("click", playFrom);   // 未選択＝先頭から（「最初から」は本番に統合＝ボタンは少なく）
	$("#sc-dress").addEventListener("click", () => play({}));
	$("#sc-stop").addEventListener("click", stop);
	$("#sc-export").addEventListener("click", download);
	$("#sc-clear").addEventListener("click", () => { if (doc.scenes.length && !confirm("全行を消しますか？")) return; doc.scenes = []; sel = -1; save(); paint(); });
	$("#sc-load").addEventListener("change", async e => {
		const f = e.target.files?.[0]; e.target.value = "";
		if (!f) return;
		const obj = await sniffScene(f);   // .scenes / .scenes.gz / .json＝gzip も中身判定で解凍
		if (!load(obj)) alert("scenes 台本として読めませんでした（type:\"scenes\" が必要）");
	});
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
		delete r.view; delete r.glide; delete r.fade;
		r[e.target.value] = h;   // "view"（地図遷移）| "glide"（移動）| "fade"（フェード＝黒挟み）
		save(); paint();
	});
	rowsEl.addEventListener("click", e => {
		const li = e.target.closest(".sc-row"); if (!li) return;
		const i = +li.dataset.i, r = doc.scenes[i], op = e.target.dataset.op;
		if (op === "del") { doc.scenes.splice(i, 1); if (sel >= doc.scenes.length) sel = doc.scenes.length - 1; save(); paint(); return; }
		if (op === "reshoot") { const h = map.view.hash; if (r.view) r.view = h; else if (r.glide) r.glide = h; else if (r.fade) r.fade = h; else r.via = h; save(); paint(); return; }
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
		start.innerHTML = `<div class="card"><h1>画面の定義</h1><p>z と画面サイズは独立＝この枠が作品の画角になります（後から変更可）</p>
			<div class="fr">
				<button data-f="16:9">${box(64, 36)}16:9 横</button>
				<button data-f="9:16">${box(27, 48)}9:16 縦</button>
				<button data-f="1:1">${box(44, 44)}1:1</button>
				<button data-f="free">${box(64, 44)}自由</button>
			</div></div>`;
		start.addEventListener("click", e => {
			const b = e.target.closest("button[data-f]"); if (!b) return;
			doc.frame = b.dataset.f; save(); fit(); paint(); start.remove();
		});
		stageEl.append(start);
	}

	// ── 出典（#attr）＝画角フレームの外へ＝パネル最下部（録画の絵を汚さない・クレジットは常時視認）。app が作った実体を養子縁組 ──
	const adoptAttr = tries => {
		const a = map.mapEl.querySelector("#attr") || document.getElementById("attr");
		if (a) panelEl.append(a); else if (tries < 50) setTimeout(() => adoptAttr(tries + 1), 100);
	};
	adoptAttr(0);

	fit(); paint();
	const destroy = () => { window.removeEventListener("resize", fit); clearTimeout(saveT); map.stopScenes?.(); styleEl.remove(); };
	return { get doc() { return doc; }, load, exportText, shoot, addVia, play, playFrom, stop, fit, destroy,
		select: i => { sel = i; paint(); } };
}
