// ガジェット：POI台帳の手差分編集（docs/poi-ledger.md §12）。?poiedit=1 のときだけ app.js が import して搭載＝
// 一般ビルドの死荷重ゼロ（作者専用・書込は bucket API key 保持者のみ＝§12.2）。
// 手差分は「ベクターファイルと分離してサーバー管理」（本人裁定2026-08-10）＝bucket の poi/overrides.json が正本。
// ここは「1操作＝1レコード追記 → 即PUT → setOvr で地図へ即反映」だけを担い、意味論（match/fold）は
// 表示側 applyPoiOvr／焼き側 schema.applyOverrides に委ねる＝編集UIは器のschemaにだけ結合する。
// ★ガジェット規約：独立モジュール・注入＝抽象アクセス（getPOI/getOvr/setOvr/unprojectAt/projectLL/base）・signal で退場。
// デスクトップ専用（shot と同じ掟）＝モバイルは入口で return。

// 手で足す種別の小さな棚（値はタイルschema §11.4 の t バイト＝interface値・rankは RANK_BASE と同値の既定）。
// KSJ系統（学校・郵便局・役場）は焼きが正＝手addの棚には載せない（直すなら rename/move/del で）。
const TYPES = [
	["観光資源", 0x46, 120], ["寺院", 0x71, 90], ["神社", 0x72, 90], ["教会", 0x73, 70],
	["博物館/美術館", 0x41, 140], ["図書館", 0x42, 110], ["ホール", 0x43, 110], ["体育/競技", 0x44, 100],
	["公園", 0x45, 90], ["百貨店/モール", 0x51, 180], ["市場", 0x54, 90], ["飲食", 0x57, 30],
	["宿泊", 0x58, 80], ["道の駅", 0x64, 120], ["バスターミナル", 0x65, 110],
	["塔/高構造物", 0x0E, 150], ["その他", 0x0F, 60],
];
const OPS = { add: "追加", rename: "改名", move: "移動", del: "削除" };
const PICK_PX = 20;   // クリック→対象選択の画面距離（CSS px）＝ラベル文字の当たり判定より少し緩め

export function poiedit({ getPOI, getOvr, setOvr, unprojectAt, projectLL, base, name, signal } = {}) {
	const mapEl = this.mapEl;
	if (window.matchMedia("(pointer: coarse)").matches) { console.warn("[poiedit] デスクトップ専用（§12.2）"); return; }
	if (mapEl.querySelector("#poiedit-panel")) return;   // 二重搭載は無害

	// ── パネル（右上・意匠は自前inline＝?poiedit=1でしか出ない作者道具＝style.scssを太らせない）──
	const panel = document.createElement("div");
	panel.id = "poiedit-panel";
	panel.style.cssText = "position:absolute;top:8px;right:8px;width:248px;background:#fffdf8;color:#333;" +
		"border:1px solid #c9c2b4;border-radius:6px;padding:10px;font:12px/1.6 system-ui,sans-serif;box-shadow:0 2px 8px #0003;";
	panel.innerHTML = `
		<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
			<b style="flex:1">台帳編集（手差分）</b>
			<button data-act="hide" title="畳む" style="border:none;background:none;cursor:pointer">—</button>
		</div>
		<input data-el="key" type="password" placeholder="bucket APIキー" autocomplete="off"
			style="width:100%;box-sizing:border-box;margin-bottom:6px;padding:3px 6px;border:1px solid #c9c2b4;border-radius:4px">
		<div data-el="modes" style="display:flex;gap:4px;margin-bottom:6px"></div>
		<div data-el="form" style="min-height:2em"></div>
		<div data-el="status" style="color:#6a3d9a;margin-top:4px"></div>
		<div data-el="recs" style="margin-top:6px;border-top:1px dashed #c9c2b4;padding-top:4px;max-height:9em;overflow-y:auto"></div>`;
	mapEl.append(panel);   // 末尾append＝DOM順で最上面
	const el = k => panel.querySelector(`[data-el="${k}"]`);
	const keyEl = el("key");
	keyEl.value = localStorage.getItem("poiEditKey") || "";
	keyEl.addEventListener("change", () => localStorage.setItem("poiEditKey", keyEl.value.trim()), { signal });

	// ── 状態機械：mode（armed中の操作）＋pending（選択済み対象/位置）──
	const st = { mode: null, sel: null, to: null, addLL: null };
	const reset = (keepMode = true) => { st.sel = st.to = st.addLL = null; if (!keepMode) st.mode = null; render(); };
	const today = () => new Date().toISOString().slice(0, 10);
	const fmt = ll => `${ll[0].toFixed(5)},${ll[1].toFixed(5)}`;
	const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(b[1] * Math.PI / 180), (a[1] - b[1]) * 111320);

	// ── サーバーへ保存（読み側と同じ bucket 面へ POST put・gzip・§12.3 保存成功→setOvr＝地図即反映）──
	async function put(ovr) {
		const key = keyEl.value.trim();
		if (!key) throw new Error("APIキー未入力（uploader の .env.local と同じ値）");
		const gz = await new Response(new Blob([JSON.stringify(ovr)]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
		const r = await fetch(base + name, {
			method: "POST", body: gz,
			headers: { "X-Action": "put", "X-API-Key": key, "X-Metadata-Type": "application/json", "X-Content-Encoding": "gzip" },
		});
		if (!r.ok) throw new Error(`保存失敗 HTTP ${r.status}${r.status === 403 ? "（キー違い？）" : ""}`);
	}
	async function save(rec) {
		const cur = getOvr() || { v: 0, seq: 1, recs: [] };
		const next = { v: Date.now(), seq: cur.seq + 1, recs: [...cur.recs, { id: cur.seq, ...rec, d: today() }] };
		status("保存中…");
		try { await put(next); setOvr(next); status(`#${cur.seq} ${OPS[rec.op]}「${rec.n}」を保存＝地図へ反映`); reset(); }
		catch (e) { status("⚠ " + e.message); }
	}
	async function undoLast() {
		const cur = getOvr();
		if (!cur?.recs?.length) { status("取り消すレコードが無い"); return; }
		const last = cur.recs[cur.recs.length - 1];
		const next = { ...cur, v: Date.now(), recs: cur.recs.slice(0, -1) };   // seq は戻さない＝idは使い捨て
		status("取消中…");
		try { await put(next); setOvr(next); status(`#${last.id} ${OPS[last.op]}「${last.n}」を取消`); render(); }
		catch (e) { status("⚠ " + e.message); }
	}
	const status = t => { el("status").textContent = t; };

	// ── クリック→対象選択（画面px距離＝projectLL・表示と同じパッチ済みフィード getPOI から最近傍）──
	const canvas = mapEl.querySelector("#c");
	function pickAt(clientX, clientY) {
		const r = canvas.getBoundingClientRect(), cx = clientX - r.left, cy = clientY - r.top;
		let best = null, bd = PICK_PX;
		for (const p of getPOI() || []) {
			const [sx, sy, front] = projectLL(p.anchor[0], p.anchor[1]);
			if (front < 0) continue;   // 裏半球
			const d = Math.hypot(sx - cx, sy - cy);
			if (d < bd) { bd = d; best = p; }
		}
		return best;
	}
	// クリック＝ドラッグでない pointerdown→up（6px/600ms）。パン操作と衝突させない＝preventDefault しない。
	let down = null;
	mapEl.addEventListener("pointerdown", e => { if (!e.target.closest("#poiedit-panel")) down = { x: e.clientX, y: e.clientY, t: performance.now() }; }, { capture: true, signal });
	mapEl.addEventListener("pointerup", e => {
		const d0 = down; down = null;
		if (!st.mode || !d0 || e.target.closest("#poiedit-panel")) return;
		if (Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > 6 || performance.now() - d0.t > 600) return;   // ドラッグ/長押し＝無視
		onMapClick(e.clientX, e.clientY);
	}, { capture: true, signal });
	function onMapClick(clientX, clientY) {
		const ll = unprojectAt(clientX, clientY);
		if (!ll) return;   // 球外
		if (st.mode === "add") { st.addLL = [ll[0], ll[1]]; render(); return; }
		if (st.mode === "move" && st.sel) { st.to = [ll[0], ll[1]]; render(); return; }   // 2打目＝置き先
		const hit = pickAt(clientX, clientY);
		if (!hit) { status("近くにPOIが無い（表示中の点を狙う）"); return; }
		st.sel = hit; st.to = null; render();
	}

	// ── 描画（モード行・フォーム・履歴）──
	function render() {
		mapEl.style.cursor = st.mode ? "crosshair" : "";
		el("modes").innerHTML = Object.entries(OPS).map(([m, label]) =>
			`<button data-mode="${m}" style="flex:1;padding:3px 0;border:1px solid #c9c2b4;border-radius:4px;cursor:pointer;` +
			`background:${st.mode === m ? "#6a3d9a" : "#f4f0e6"};color:${st.mode === m ? "#fff" : "#333"}">${label}</button>`).join("");
		for (const b of el("modes").querySelectorAll("button"))
			b.onclick = () => { st.mode = st.mode === b.dataset.mode ? null : b.dataset.mode; reset(); };
		const F = el("form");
		if (!st.mode) F.innerHTML = `<span style="color:#888">操作を選び、地図上の点をクリック。<br>Esc＝選択解除／解除</span>`;
		else if (st.mode === "add") {
			if (!st.addLL) F.innerHTML = `<span>追加する位置を地図でクリック</span>`;
			else {
				F.innerHTML = `<div>位置 ${fmt(st.addLL)}</div>
					<input data-f="n" placeholder="名前" style="width:100%;box-sizing:border-box;margin:2px 0;padding:3px 6px;border:1px solid #c9c2b4;border-radius:4px">
					<div style="display:flex;gap:4px;margin:2px 0">
						<select data-f="t" style="flex:1">${TYPES.map(([l, c, r]) => `<option value="${c}" data-rank="${r}">${l}</option>`).join("")}</select>
						<input data-f="r" type="number" min="1" max="255" value="${TYPES[0][2]}" title="rank（大＝早く出る）" style="width:52px">
					</div>
					<button data-f="go" style="width:100%;margin-top:2px">追加を保存</button>`;
				const sel = F.querySelector('[data-f="t"]');
				sel.onchange = () => { F.querySelector('[data-f="r"]').value = sel.selectedOptions[0].dataset.rank; };
				F.querySelector('[data-f="go"]').onclick = () => {
					const n = F.querySelector('[data-f="n"]').value.trim();
					if (!n) { status("名前が空"); return; }
					save({ op: "add", n, ll: st.addLL, t: +sel.value, r: +F.querySelector('[data-f="r"]').value || 120 });
				};
				F.querySelector('[data-f="n"]').focus();
			}
		} else if (!st.sel) F.innerHTML = `<span>${OPS[st.mode]}する点を地図でクリック</span>`;
		else if (st.mode === "rename") {
			F.innerHTML = `<div>対象「${st.sel.n}」(r${st.sel.r})</div>
				<input data-f="to" value="${st.sel.n.replace(/"/g, "&quot;")}" style="width:100%;box-sizing:border-box;margin:2px 0;padding:3px 6px;border:1px solid #c9c2b4;border-radius:4px">
				<button data-f="go" style="width:100%;margin-top:2px">改名を保存</button>`;
			F.querySelector('[data-f="go"]').onclick = () => {
				const to = F.querySelector('[data-f="to"]').value.trim();
				if (!to || to === st.sel.n) { status("名前が同じ/空"); return; }
				save({ op: "rename", n: st.sel.n, ll: st.sel.anchor, to });
			};
			F.querySelector('[data-f="to"]').focus();
		} else if (st.mode === "move") {
			F.innerHTML = st.to
				? `<div>対象「${st.sel.n}」→ ${Math.round(distM(st.sel.anchor, st.to))}m 先へ</div><button data-f="go" style="width:100%;margin-top:2px">移動を保存</button>`
				: `<div>対象「${st.sel.n}」</div><span>新しい位置を地図でクリック</span>`;
			const go = F.querySelector('[data-f="go"]');
			if (go) go.onclick = () => save({ op: "move", n: st.sel.n, ll: st.sel.anchor, to: st.to });
		} else if (st.mode === "del") {
			F.innerHTML = `<div>対象「${st.sel.n}」(r${st.sel.r}) ${fmt(st.sel.anchor)}</div>
				<button data-f="go" style="width:100%;margin-top:2px;color:#b3261e">削除を保存</button>`;
			F.querySelector('[data-f="go"]').onclick = () => save({ op: "del", n: st.sel.n, ll: st.sel.anchor });
		}
		renderList();
	}
	function renderList() {
		const cur = getOvr();
		const recs = cur?.recs || [];
		el("recs").innerHTML = (recs.length ? recs.slice(-5).reverse().map(r =>
			`<div>#${r.id} ${OPS[r.op] || r.op}「${r.n}」${r.op === "rename" ? "→" + r.to : ""} <small>${r.d || ""}</small></div>`).join("") :
			`<div style="color:#888">手差分なし</div>`) +
			(recs.length ? `<button data-act="undo" style="margin-top:2px">直近を取消</button>` : "");
		const u = el("recs").querySelector('[data-act="undo"]');
		if (u) u.onclick = undoLast;
	}
	panel.addEventListener("pointerenter", renderList, { signal });   // 開いた後に届いた手差分もここで拾う（初回fetchは非同期）
	panel.querySelector('[data-act="hide"]').onclick = () => { const b = el("modes"); const on = panel.dataset.min === "1";
		panel.dataset.min = on ? "" : "1"; for (const k of ["key", "modes", "form", "status", "recs"]) el(k).style.display = on ? "" : "none"; };
	window.addEventListener("keydown", e => {
		if (e.key !== "Escape") return;
		if (st.sel || st.addLL || st.to) { e.preventDefault(); reset(); }        // 1回目＝選択解除
		else if (st.mode) { e.preventDefault(); st.mode = null; render(); }      // 2回目＝モード解除
	}, { signal });
	signal?.addEventListener("abort", () => { mapEl.style.cursor = ""; panel.remove(); }, { once: true });

	render();
	status("§12 手差分＝サーバー正本（保存で即反映・焼き直しで焼き込み）");
	return { close: () => panel.remove() };
}
