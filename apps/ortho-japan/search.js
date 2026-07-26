// 地名検索：地理院 AddressSearch API 直叩き（キー不要・CORS開放）＝ノーサーバーのまま住所も地名も引ける。
// 基図タイルが既に地理院依存なので実質的な依存追加ゼロ。UIは Quiet Mono の作法（白の静かな箱、候補は下に）。
// ヒット→ onGo(lon, lat, zoom) を呼ぶだけ＝飛び方（球面フライト）は呼び出し側の領分。
// APIの素性が悪い（同名の真の重複・全国散在の同名・並びの癖）ので、全件を前処理してから候補にする。
const API = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=";

// addressCode（JIS市区町村コード）先頭2桁→都道府県名。'' は市区町村に属さない広域地物（本物の富士山等）。
// export＝PLATEAUデータ管理モーダル（plateaudb.js）の都道府県ブロック見出しでも使う。
export const PREF = ",北海道,青森県,岩手県,宮城県,秋田県,山形県,福島県,茨城県,栃木県,群馬県,埼玉県,千葉県,東京都,神奈川県,新潟県,富山県,石川県,福井県,山梨県,長野県,岐阜県,静岡県,愛知県,三重県,滋賀県,京都府,大阪府,兵庫県,奈良県,和歌山県,鳥取県,島根県,岡山県,広島県,山口県,徳島県,香川県,愛媛県,高知県,福岡県,佐賀県,長崎県,熊本県,大分県,宮崎県,鹿児島県,沖縄県".split(",");

// 前処理：APIの生の全件（切り詰め前）を候補に整える。
// 1) 同タイトルで近接（〜2km）は真の重複（東京駅=路線別座標、スカイツリー=データ源違い）＝平均座標で1件に統合。
// 2) 統合後も同タイトルが複数残る＝全国散在の同名（富士山は完全一致だけで25件）＝県名の添え書きで区別。
//    添え書きは表示専用：検索マッチ（rerank）にも input への書き戻しにも viewFor にも使わない＝「長野」で富士山が引っかかったりしない。
export function preprocess(hits) {
	const byTitle = new Map();
	hits.forEach((h, i) => {
		const t = h.properties.title, [x, y] = h.geometry.coordinates;
		let group = byTitle.get(t);
		if (!group) byTitle.set(t, group = []);
		const near = group.find(c => Math.hypot(c.x / c.n - x, c.y / c.n - y) < 0.02);
		if (near) { near.x += x; near.y += y; near.n++; }
		else group.push({ x, y, n: 1, i, code: h.properties.addressCode || "" });
	});
	const out = [];
	for (const [title, group] of byTitle) for (const c of group)
		out.push({
			title,                                                                       // マッチ・入力値・viewFor は生タイトル
			note: group.length > 1 ? PREF[Math.floor(+c.code / 1000)] || "" : "",        // 同名が複数残る時だけ県名を添える
			lon: c.x / c.n, lat: c.y / c.n, i: c.i,
			national: !c.code,                                                           // 広域地物フラグ（同点決勝用）
		});
	return out;
}

// 再ランク：完全一致（「富士山」「琵琶湖」等の自然地名の正解はほぼこれ）→ 含む（短い題名ほど上＝
// 「東京都渋谷区」が「福島県猪苗代町渋谷」より先）→ その他はAPI順。切り詰め前の全件に掛けるのが肝
//（「大雪山」の正解は22件の奥に居る＝先に8件で切ると捨ててしまう）。
// 序列：広域地物の完全一致（本物の富士山=addressCode無し）＞ 市区の本体名一致（渋谷→東京都渋谷区）＞
// 字名の完全一致（全国の渋谷・上田市の富士山）。市区ブーストが無いと有名市区が全国の同名字名に埋もれる。
// 町村まで広げると字名の「〜町」（○○市渋谷町等）を誤って掬うので市・区に限定。1文字クエリも誤爆源（山→富山市）なので除外。
export function rerank(q, cands) {
	const muni = c => q.length >= 2 && (c.title.endsWith(q + "市") || c.title.endsWith(q + "区"));
	const score = c => c.title === q ? (c.national ? 0 : 0.001)
		: muni(c) ? 0.0005
		: c.title.includes(q) ? 1 + (c.title.length - q.length) / 100 : 2;
	return cands.map(c => [score(c), c.i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
}

export function createSearch({ onGo, signal }) {   // signal＝map.destroy() で document リスナーを束ごと外すため
	const box = document.getElementById("search");
	const btn = document.getElementById("search-btn");
	const input = document.getElementById("search-in");
	const list = document.getElementById("search-list");
	let items = [], sel = -1, ac = null, timer = null, composing = false;
	const close = () => { list.style.display = "none"; list.innerHTML = ""; items = []; sel = -1; };
	// 検索履歴（オートコンプリート）：飛んだ地点だけを保存＝「検索した」でなく「行った」場所。入力が空の時に出す。
	const HIST_KEY = "ortho-japan.searches", HIST_MAX = 8;
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
			const res = await fetch(API + encodeURIComponent(q), { signal: ac.signal });
			render(rerank(q, preprocess(await res.json())).slice(0, 8));
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
		if (!hits) list.innerHTML = `<div class="search-empty">検索できませんでした（通信状態をご確認ください）</div>`;
		else if (!hits.length) list.innerHTML = `<div class="search-empty">見つかりませんでした</div>`;
		else if (isHist) { const h = document.createElement("div"); h.className = "search-empty"; h.textContent = "最近の検索"; list.appendChild(h); }
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

	// ヒットの粒度→着地ズーム＋チルト。APIは extent を返さないので名前で近似（v1の割り切り）。
	// 自然地名（山・湖・岬…）は山岳レジーム（z13・チルト55°）＝地形が主役の着地。
	// 住所・地名は z15.5＝PLATEAU自動ロード圏＝着地で街が立つ。
	const NATURE = /([山岳峰湖沼池岬崎峠島滝湾](\s*\(.*\))?|高原|湿原|ヶ原|渓谷|盆地|平野|半島|諸島|列島)$/;
	function viewFor(title) {
		if (/^(東京都|北海道|(京都|大阪)府|.{2,3}県)$/.test(title)) return { zoom: 10 };     // 都道府県
		if (NATURE.test(title)) return { zoom: 12.8, tilt: 55 };                            // 自然地名＝地形ビュー
		if (/[市区町村]$/.test(title)) return { zoom: 13 };                                 // 市区町村
		return { zoom: 15.5 };                                                              // 住所・丁目・施設
	}

	function go(i) {
		const c = items[i]; if (!c) return;
		saveHist(c);   // 行った場所だけ履歴へ（次回のオートコンプリート候補）
		input.value = "";   // 飛んだら入力欄は空に戻す＝行き先は履歴（最近の検索）に居るので消えても迷子にならない
		close(); input.blur();
		box.classList.remove("open");   // 飛んだら畳む＝フライトの見せ場と着地の地図を広く
		const v = viewFor(c.title);
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
