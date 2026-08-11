// ガジェット：POI台帳の手差分編集（docs/poi-ledger.md §12）。?poiedit=1 のときだけ app.js が import して搭載＝
// 一般ビルドの死荷重ゼロ（作者専用・書込は bucket API key 保持者のみ＝§12.2）。
// 手差分はサーバー正本（bucket poi/overrides.json・ベクターファイルと分離＝本人裁定2026-08-10）。ここは
// 「1操作＝1レコード追記→即PUT→setOvr で地図へ即反映」だけを担い、意味論（match/fold）は表示側 applyPoiOvr／
// 焼き側 schema.applyOverrides に委ねる＝編集UIは器のschemaにだけ結合する。
// ★ガジェット規約：独立モジュール・注入＝抽象アクセス・signal で退場。注入の束：
//   getPOI/getOvr/setOvr＝台帳フィード（パッチ適用済＝表示と同じ景色）と手差分の読み書き
//   setClick＝createInput の onClick 横取り（measure と同型＝ドラッグ弁別は input.js が正本・armed中は識別へ素通りしない）
//   unprojectXY/makeProjector/distM＝座標ブリッジ（onClick と同じ canvas CSS px 系）
//   apiBase/name＝bucket API 基底と器の名（書込プロトコルは native-bucket Bucket.put が正本＝ここで再実装しない）
// デスクトップ専用（shot と同じ掟）＝モバイルは入口で return。
import { nativeBucket } from "native-bucket";
import { modalOpen } from "./keys.js";

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
// パネル部品の様式（inline＝?poiedit=1でしか出ない作者道具＝style.scssを太らせない）。微差はテンプレートで足す。
const S_INPUT = "width:100%;box-sizing:border-box;margin:2px 0;padding:3px 6px;border:1px solid #c9c2b4;border-radius:4px";
const S_BTN = "width:100%;margin-top:2px";

export function poiedit({ getPOI, getOvr, setOvr, setClick, unprojectXY, makeProjector, distM, apiBase, name, signal } = {}) {
	const mapEl = this.mapEl;
	if (window.matchMedia("(pointer: coarse)").matches) { console.warn("[poiedit] デスクトップ専用（§12.2）"); return; }
	if (mapEl.querySelector("#poiedit-panel")) return;   // 二重搭載は無害

	// ── パネル（右上）──
	const panel = document.createElement("div");
	panel.id = "poiedit-panel";
	panel.style.cssText = "position:absolute;top:8px;right:8px;width:248px;background:#fffdf8;color:#333;" +
		"border:1px solid #c9c2b4;border-radius:6px;padding:10px;font:12px/1.6 system-ui,sans-serif;box-shadow:0 2px 8px #0003;";
	panel.innerHTML = `
		<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
			<b style="flex:1">台帳編集（手差分）</b>
			<button data-act="hide" title="畳む" style="border:none;background:none;cursor:pointer">—</button>
		</div>
		<input data-el="key" type="password" placeholder="bucket APIキー" autocomplete="off" style="${S_INPUT};margin:0 0 6px">
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

	// ── サーバーへ保存（§12.3 保存成功→setOvr＝地図即反映）。gzip/ヘッダ/エラー整形は Bucket.put の持ち物 ──
	let bktKey = "", bktReq = null;   // キー毎に一度だけ接続検分（Bucket() は list で疎通確認する）
	const bucketOf = key => (key === bktKey && bktReq) ? bktReq : (bktKey = key, bktReq = nativeBucket(apiBase, { apiKey: key }).Bucket("GIS/pbf"));
	async function put(ovr) {
		const key = keyEl.value.trim();
		if (!key) throw new Error("APIキー未入力（uploader の .env.local と同じ値）");
		const bkt = await bucketOf(key);
		if (!bkt) { bktReq = null; throw new Error("bucket に接続できない（ネットワーク？）"); }
		await bkt.put(new File([JSON.stringify(ovr)], name, { type: "application/json" }));   // 403等は put failed で throw
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

	// ── クリック（armed中だけ setClick で横取り・x/y＝canvas CSS px）──
	function pickAt(x, y) {   // 表示と同じパッチ済みフィードから画面px最近傍（投影状態は1回だけ束ねる）
		const proj = makeProjector();
		let best = null, bd = PICK_PX;
		for (const p of getPOI() || []) {
			const [sx, sy, front] = proj(p.anchor[0], p.anchor[1]);
			if (front < 0) continue;   // 裏半球
			const d = Math.hypot(sx - x, sy - y);
			if (d < bd) { bd = d; best = p; }
		}
		return best;
	}
	function onMapClick(x, y) {
		const ll = unprojectXY(x, y);
		if (!ll) return;   // 球外
		if (st.mode === "add") { st.addLL = [ll[0], ll[1]]; render(); return; }
		if (st.mode === "move" && st.sel) { st.to = [ll[0], ll[1]]; render(); return; }   // 2打目＝置き先
		const hit = pickAt(x, y);
		if (!hit) { status("近くにPOIが無い（表示中の点を狙う）"); return; }
		st.sel = hit; st.to = null; render();
	}

	// ── 描画（モード行・フォーム・履歴）。クリック横取りとカーソルもここで同期（armed⇄解除の一点）──
	function render() {
		setClick(st.mode ? onMapClick : null);
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
					<input data-f="n" placeholder="名前" style="${S_INPUT}">
					<div style="display:flex;gap:4px;margin:2px 0">
						<select data-f="t" style="flex:1">${TYPES.map(([l, c, r]) => `<option value="${c}" data-rank="${r}">${l}</option>`).join("")}</select>
						<input data-f="r" type="number" min="1" max="255" value="${TYPES[0][2]}" title="rank（大＝早く出る）" style="width:52px">
					</div>
					<button data-f="go" style="${S_BTN}">追加を保存</button>`;
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
				<input data-f="to" value="${st.sel.n.replace(/"/g, "&quot;")}" style="${S_INPUT}">
				<button data-f="go" style="${S_BTN}">改名を保存</button>`;
			F.querySelector('[data-f="go"]').onclick = () => {
				const to = F.querySelector('[data-f="to"]').value.trim();
				if (!to || to === st.sel.n) { status("名前が同じ/空"); return; }
				save({ op: "rename", n: st.sel.n, ll: st.sel.anchor, to });
			};
			F.querySelector('[data-f="to"]').focus();
		} else if (st.mode === "move") {
			F.innerHTML = st.to
				? `<div>対象「${st.sel.n}」→ ${Math.round(distM(st.sel.anchor, st.to))}m 先へ</div><button data-f="go" style="${S_BTN}">移動を保存</button>`
				: `<div>対象「${st.sel.n}」</div><span>新しい位置を地図でクリック</span>`;
			const go = F.querySelector('[data-f="go"]');
			if (go) go.onclick = () => save({ op: "move", n: st.sel.n, ll: st.sel.anchor, to: st.to });
		} else if (st.mode === "del") {
			F.innerHTML = `<div>対象「${st.sel.n}」(r${st.sel.r}) ${fmt(st.sel.anchor)}</div>
				<button data-f="go" style="${S_BTN};color:#b3261e">削除を保存</button>`;
			F.querySelector('[data-f="go"]').onclick = () => save({ op: "del", n: st.sel.n, ll: st.sel.anchor });
		}
		renderList();
	}
	function renderList() {
		const recs = getOvr()?.recs || [];
		el("recs").innerHTML = (recs.length ? recs.slice(-5).reverse().map(r =>
			`<div>#${r.id} ${OPS[r.op] || r.op}「${r.n}」${r.op === "rename" ? "→" + r.to : ""} <small>${r.d || ""}</small></div>`).join("") :
			`<div style="color:#888">手差分なし</div>`) +
			(recs.length ? `<button data-act="undo" style="margin-top:2px">直近を取消</button>` : "");
		const u = el("recs").querySelector('[data-act="undo"]');
		if (u) u.onclick = undoLast;
	}
	panel.addEventListener("pointerenter", renderList, { signal });   // 開いた後に届いた手差分もここで拾う（初回fetchは非同期）
	panel.querySelector('[data-act="hide"]').onclick = () => { const on = panel.dataset.min === "1";
		panel.dataset.min = on ? "" : "1"; for (const k of ["key", "modes", "form", "status", "recs"]) el(k).style.display = on ? "" : "none"; };
	window.addEventListener("keydown", e => {
		if (e.key !== "Escape" || modalOpen(mapEl)) return;   // 共有ガード＝印刷/PLATEAU等のモーダル中は譲る（keys.js の掟）
		if (st.sel || st.addLL || st.to) { e.preventDefault(); reset(); }   // 1回目＝選択解除
		else if (st.mode) { e.preventDefault(); reset(false); }             // 2回目＝モード解除
	}, { signal });
	signal?.addEventListener("abort", () => { setClick(null); mapEl.style.cursor = ""; panel.remove(); }, { once: true });

	render();
	status("§12 手差分＝サーバー正本（保存で即反映・焼き直しで焼き込み）");
	return { close: () => panel.remove() };
}
