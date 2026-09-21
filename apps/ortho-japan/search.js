// 地名検索の窓：UIは Quiet Mono の作法（白の静かな箱、候補は下に）。ヒット→ onGo(lon, lat, zoom, tilt) を呼ぶだけ＝
// 飛び方（球面フライト）は呼び出し側の領分。何をどこへ問い合わせるか（API・前処理・着地ズーム）は地域宣言の供給元
// （日本＝jp/search-gsi.js の地理院 AddressSearch）＝窓は国を知らない（2026-09-22 分離）。
import { tr } from "./i18n.js";
const t = tr();

export function createSearch({ provider, onGo, signal }) {   // provider＝地域宣言の検索供給元（jp/search-gsi.js の形）・signal＝map.destroy() で document リスナーを束ごと外すため
	const box = document.getElementById("search");
	const btn = document.getElementById("search-btn");
	const input = document.getElementById("search-in");
	const list = document.getElementById("search-list");
	let items = [], sel = -1, ac = null, timer = null, composing = false;
	const close = () => { list.style.display = "none"; list.innerHTML = ""; items = []; sel = -1; };
	// 検索履歴（オートコンプリート）：飛んだ地点だけを保存＝「検索した」でなく「行った」場所。入力が空の時に出す。
	const HIST_KEY = provider.histKey, HIST_MAX = 8;
	const loadHist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch { return []; } };
	const saveHist = c => {
		try {
			const h = loadHist().filter(x => x.title !== c.title);
			h.unshift({ title: c.title, note: c.note || "", lon: c.lon, lat: c.lat });
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
		try {
			render(await provider.query(q, ac.signal));
		} catch (e) { if (e.name !== "AbortError") render(null); }   // 通信断も言葉で（白画面同様、黙らない）
	}

	// 候補リストは #map 直下の動的要素（ガジェットスタックの外＝下段のガジェットより上に描く）。
	// 表示のたびに検索箱へ位置と幅を追随させる（スタック内の段はガジェット構成で動くため座標は毎回読む）。
	const placeList = () => {
		const mapEl = document.getElementById("map");
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

	function go(i) {
		const c = items[i]; if (!c) return;
		saveHist(c);   // 行った場所だけ履歴へ（次回のオートコンプリート候補）
		input.value = "";   // 飛んだら入力欄は空に戻す＝行き先は履歴（最近の検索）に居るので消えても迷子にならない
		close(); input.blur();
		box.classList.remove("open");   // 飛んだら畳む＝フライトの見せ場と着地の地図を広く
		const v = provider.viewFor(c.title);
		onGo(c.lon, c.lat, v.zoom, v.tilt);
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
