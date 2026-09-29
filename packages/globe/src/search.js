// 地名検索の窓：UIは Quiet Mono の作法（白の静かな箱、候補は下に）。ヒット→ onResult(hit) と onGo(lon, lat, zoom, tilt) を呼ぶだけ＝
// 飛び方（球面フライト）は呼び出し側の領分。何をどこへ問い合わせるか（API・前処理・着地ズーム）は供給元
// （日本＝packages/jp/src/search-gsi.js の地理院 AddressSearch・世界＝worldsearch.js・外の geocoder＝geocoder.js）＝窓は国を知らない（2026-09-22 分離）。
//
// 供給元の契約（#175 で広げた・今の形は無改修で動く）：
//   { histKey?, query(q, signal) → Promise<hit[]>, viewFor?(title) → { zoom, tilt? } }
//   hit ＝ { title, note?, lon, lat, bbox?, zoom?, tilt?, kind?, id? }
//     着地の決め方（先に在る物が勝つ）：hit.zoom ＞ hit.bbox（範囲に寄る＝fit）＞ provider.viewFor(title) ＞ 既定 z12
//   供給元は配列でもよい＝並べた順に候補を積む（地域 → 世界 → 外の geocoder）。どれかが落ちても他の候補は出す。
// 履歴（行った場所）は着地を覚える＝{ title, note, lon, lat, zoom?, tilt?, bbox?, kind?, id? }（旧い履歴＝zoom 無しは viewFor で）。
import { tr } from "./i18n.js";
const t = tr();

const LIMIT = 10, MIN_EACH = 3;   // 候補の総数・後ろの供給元に残す最低の枠（地域が 8 件返しても世界の 3 件は見える）
const DEFAULT_ZOOM = 12;
// 供給元ごとの候補 → 1 本（前の供給元が先・後ろの供給元にも最低 MIN_EACH 件の席を残す）
export function mergeHits(lists, limit = LIMIT, minEach = MIN_EACH) {
	const out = [];
	lists.forEach((hits, k) => {
		const reserve = lists.slice(k + 1).reduce((s, h) => s + Math.min(h.length, minEach), 0);
		out.push(...hits.slice(0, Math.max(0, limit - out.length - reserve)));
	});
	return out;
}
const histId = c => c.id || `${c.title}|${(+c.lon).toFixed(3)}|${(+c.lat).toFixed(3)}`;

export function createSearch({ provider, onGo, onResult, fit, signal, root = document, histKey }) {   // provider＝供給元（1 つか配列）・fit(bbox)→{ lon, lat, zoom }（範囲に寄る倍率＝地図の cameraForBounds）・signal＝map.destroy() で document リスナーを束ごと外すため
	const providers = [].concat(provider || []).filter(Boolean);
	// root＝地図の容れ物（#173）＝頁に地図が複数でも自分の窓を掴む（document.getElementById は頁で最初の物）
	const box = root.querySelector("#search");
	const btn = root.querySelector("#search-btn");
	const input = root.querySelector("#search-in");
	const list = root.querySelector("#search-list");
	let items = [], sel = -1, ac = null, timer = null, composing = false;
	const close = () => { list.style.display = "none"; list.innerHTML = ""; items = []; sel = -1; };
	// 検索履歴（オートコンプリート）：飛んだ地点だけを保存＝「検索した」でなく「行った」場所。入力が空の時に出す。
	// 鍵＝明示 → 最初に鍵を持つ供給元（地域＝利用者の履歴を引き継ぐ）→ 既定
	const HIST_KEY = histKey || providers.find(p => p.histKey)?.histKey || "ortho.searches", HIST_MAX = 8;
	const loadHist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch { return []; } };
	const saveHist = (c, v) => {
		try {
			const id = histId(c), h = loadHist().filter(x => histId(x) !== id && !(x.title === c.title && !x.id && x.zoom == null));   // 旧い履歴（倍率なし）の同名も入れ替える
			const e = { title: c.title, note: c.note || "", lon: c.lon, lat: c.lat };
			if (c.bbox) e.bbox = c.bbox; else { e.zoom = v.zoom; if (v.tilt != null) e.tilt = v.tilt; }   // 範囲は次も寄り直す（画面の大きさが変わっても収まる）・点は着いた倍率
			if (c.kind) e.kind = c.kind;
			if (c.id) e.id = c.id;
			h.unshift(e);
			localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, HIST_MAX)));
		} catch { /* private mode 等 */ }
	};
	const showHist = () => { const h = loadHist(); h.length ? render(h, true) : close(); };
	// Netflix式：普段は虫めがねだけ。押すと入力欄が右へ開く。空のまま外れたら畳む＝地図面を広く。
	// click でなく pointerdown＋preventDefault：人間のクリックは押下〜解放が100ms超あり、その間に input の
	// blur タイマー(120ms)が先に畳んでしまうと、後から来る click が「閉じてる→開く」と誤判定して再度開く
	//（＝虫めがねで畳めないバグ）。押した瞬間に開閉を確定させれば競合は構造的に消える。
	btn.addEventListener("pointerdown", e => {
		e.preventDefault();
		if (box.classList.contains("open")) { box.classList.remove("open"); close(); input.blur(); }
		else { box.classList.add("open"); input.focus(); }
	});

	async function query(q) {
		ac?.abort(); ac = new AbortController();
		const sig = ac.signal;
		const res = await Promise.allSettled(providers.map(p => Promise.resolve().then(() => p.query(q, sig)).then(hs => (hs || []).map(h => ({ ...h, src: p })))));
		if (sig.aborted) return;
		const ok = res.filter(r => r.status === "fulfilled");
		for (const r of res) if (r.status === "rejected" && r.reason?.name !== "AbortError") console.warn("[search] provider failed", r.reason);
		render(ok.length ? mergeHits(ok.map(r => r.value)) : null);   // 全部落ちた＝通信断も言葉で（白画面同様、黙らない）・一部なら出せる物を出す
	}

	// 候補リストは #map 直下の動的要素（ガジェットスタックの外＝下段のガジェットより上に描く）。
	// 表示のたびに検索箱へ位置と幅を追随させる（スタック内の段はガジェット構成で動くため座標は毎回読む）。
	const placeList = () => {
		const mapEl = root === document ? document.getElementById("map") : root;
		const r = box.getBoundingClientRect(), m = mapEl.getBoundingClientRect();
		list.style.left = (r.left - m.left) + "px";
		list.style.top = (r.bottom - m.top + 4) + "px";
		list.style.width = r.width + "px";
	};

	function render(hits, isHist = false) {
		list.innerHTML = ""; items = hits || []; sel = -1;
		if (!hits) list.innerHTML = `<div class="search-empty">${t("Search failed (please check your connection)")}</div>`;
		else if (!hits.length) list.innerHTML = `<div class="search-empty">${t("No results")}</div>`;
		else if (isHist) { const h = document.createElement("div"); h.className = "search-empty"; h.textContent = t("Recent searches"); list.appendChild(h); }
		if (hits?.length) hits.forEach((c, i) => {
			const d = document.createElement("div");
			d.className = "search-item"; d.textContent = c.title;
			d.setAttribute("role", "option"); d.setAttribute("aria-selected", "false");   // ↑↓選択は highlight が反映
			if (c.note) { const s = document.createElement("span"); s.className = "search-note"; s.textContent = c.note; d.appendChild(s); }
			d.addEventListener("pointerdown", ev => { ev.preventDefault(); go(i); });   // blur(候補を閉じる)より先に拾う
			list.appendChild(d);
		});
		placeList();
		list.style.display = "block";
	}

	async function go(i) {
		let c = items[i]; if (!c) return;
		input.value = "";   // 飛んだら入力欄は空に戻す＝行き先は履歴（最近の検索）に居るので消えても迷子にならない
		close(); input.blur();
		box.classList.remove("open");   // 飛んだら畳む＝フライトの見せ場と着地の地図を広く
		if (c.resolve) {   // 座標は選んだ時に引く候補（geocoderApi.getSuggestions → searchByPlaceId）
			const r = await c.resolve().catch(e => { console.warn("[search] resolve failed", e); return null; });
			if (!r) return;
			c = { ...r, title: c.title || r.title, note: c.note || r.note, src: c.src };
		}
		const v = viewOf(c);
		saveHist(c, v);   // 行った場所だけ履歴へ（次回のオートコンプリート候補）＝着いた倍率ごと
		const { src, resolve, ...hit } = c;
		onResult?.(hit);   // 選んだ候補（公式の "result" 事象と同じ中身の置き場）
		onGo(v.lon, v.lat, v.zoom, v.tilt);
	}
	// 着地：hit.zoom ＞ hit.bbox（fit）＞ 供給元の viewFor(title)（履歴＝どの供給元か分からない→鍵を持つ最初の供給元）＞ 既定
	function viewOf(c) {
		if (c.zoom != null) return { lon: c.lon, lat: c.lat, zoom: c.zoom, tilt: c.tilt };
		if (c.bbox && fit) { const f = fit(c.bbox); if (f) return { lon: f.lon, lat: f.lat, zoom: f.zoom, tilt: c.tilt }; }
		const p = c.src || providers.find(x => x.viewFor);
		const v = p?.viewFor?.(c.title) || { zoom: DEFAULT_ZOOM };
		return { lon: c.lon, lat: c.lat, zoom: v.zoom, tilt: v.tilt };
	}

	const highlight = () => [...list.children].forEach((d, i) => { d.classList.toggle("sel", i === sel); if (d.getAttribute("role") === "option") d.setAttribute("aria-selected", String(i === sel)); });
	// IME変換中は一切動かない：input は確定まで query しない（半端な読みで叩かない）、keydown は変換操作
	//（確定Enter・候補送りの↑↓）を奪わない。奪うと「確定Enterで go()→input書き換え→その後にIMEの確定
	// テキストが追記される」という二重入力になる（実害確認済み）。確定は compositionend で一度だけ拾う。
	const onInput = () => {
		clearTimeout(timer);
		const q = input.value.trim();
		if (!q) { showHist(); return; }   // 空に戻した＝履歴を出す
		timer = setTimeout(() => query(q), 280);   // デバウンス＝タイプ中はAPIを叩かない
	};
	input.addEventListener("focus", () => { if (!input.value.trim()) showHist(); });   // 開いた直後も履歴
	input.addEventListener("compositionstart", () => { composing = true; });
	input.addEventListener("compositionend", () => { composing = false; onInput(); });
	input.addEventListener("input", () => { if (!composing) onInput(); });
	input.addEventListener("keydown", e => {
		if (e.isComposing || e.keyCode === 229) return;   // IMEの確定Enter/候補送りはIMEの物
		if (e.key === "Enter") {
			if (items.length) go(sel < 0 ? 0 : sel);
			else { clearTimeout(timer); query(input.value.trim()).then(() => { if (items.length) go(0); }); }   // 一発Enter＝先頭ヒットへ飛ぶ
		} else if (e.key === "ArrowDown" && items.length) { sel = (sel + 1) % items.length; highlight(); e.preventDefault(); }
		else if (e.key === "ArrowUp" && items.length) { sel = (sel - 1 + items.length) % items.length; highlight(); e.preventDefault(); }
		else if (e.key === "Escape") { close(); input.blur(); }
	});
	input.addEventListener("blur", () => setTimeout(() => {   // 候補の pointerdown を先に通してから閉じる
		close();
		if (!input.value.trim()) box.classList.remove("open");   // 空のまま離れた＝アイコンへ畳む
	}, 120));
	// canvas はフォーカス可能要素でないため、地図をクリックしても input の blur は発火しない（＝空のまま
	// 地図を触っても窓が畳まれないバグの正体）。検索箱の外の pointerdown で明示的に畳む。
	document.addEventListener("pointerdown", e => {
		if (box.contains(e.target) || list.contains(e.target) || !box.classList.contains("open")) return;   // リストは箱の外（#map直下）＝外側クリック判定に含める
		close();
		if (!input.value.trim()) box.classList.remove("open");
		input.blur();
	}, { signal });
}
