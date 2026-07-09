// 地名検索：地理院 AddressSearch API 直叩き（キー不要・CORS開放）＝ノーサーバーのまま住所も地名も引ける。
// 基図タイルが既に地理院依存なので実質的な依存追加ゼロ。UIは Quiet Mono の作法（白の静かな箱、候補は下に）。
// ヒット→ onGo(lon, lat, zoom) を呼ぶだけ＝飛び方（球面フライト）は呼び出し側の領分。
const API = "https://msearch.gsi.go.jp/address-search/AddressSearch?q=";

export function createSearch({ onGo }) {
	const input = document.getElementById("search-in");
	const list = document.getElementById("search-list");
	let items = [], sel = -1, ac = null, timer = null;
	const close = () => { list.style.display = "none"; list.innerHTML = ""; items = []; sel = -1; };

	async function query(q) {
		ac?.abort(); ac = new AbortController();
		try {
			const res = await fetch(API + encodeURIComponent(q), { signal: ac.signal });
			render(rerank(q, await res.json()).slice(0, 8));   // 再ランク→8件（APIの素の並びは住所の部分一致が先頭に来る癖がある）
		} catch (e) { if (e.name !== "AbortError") render(null); }   // 通信断も言葉で（白画面同様、黙らない）
	}

	// 再ランク：完全一致（「富士山」「琵琶湖」等の自然地名の正解はほぼこれ）→ 含む（短い題名ほど上＝
	// 「東京都渋谷区」が「福島県猪苗代町渋谷」より先）→ その他はAPI順。切り詰め前の全件に掛けるのが肝
	//（「大雪山」の正解は22件の奥に居る＝先に8件で切ると捨ててしまう）。
	function rerank(q, hits) {
		const score = t => t === q ? 0 : t.includes(q) ? 1 + (t.length - q.length) / 100 : 2;
		return hits.map((h, i) => [score(h.properties.title), i, h])
			.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
	}

	function render(hits) {
		list.innerHTML = ""; items = hits || []; sel = -1;
		if (!hits) list.innerHTML = `<div class="search-empty">検索できませんでした（通信状態をご確認ください）</div>`;
		else if (!hits.length) list.innerHTML = `<div class="search-empty">見つかりませんでした</div>`;
		else hits.forEach((h, i) => {
			const d = document.createElement("div");
			d.className = "search-item"; d.textContent = h.properties.title;
			d.addEventListener("pointerdown", ev => { ev.preventDefault(); go(i); });   // blur(候補を閉じる)より先に拾う
			list.appendChild(d);
		});
		list.style.display = "block";
	}

	// ヒットの粒度→着地ズーム＋チルト。APIは extent を返さないので名前で近似（v1の割り切り）。
	// 自然地名（山・湖・岬…）は山岳レジーム（z12・チルト55°）＝地形が主役の着地。
	// 住所・地名は z14.5＝PLATEAU自動ロード圏＝着地で街が立つ。
	const NATURE = /([山岳峰湖沼池岬崎峠島滝湾](\s*\(.*\))?|高原|湿原|ヶ原|渓谷|盆地|平野|半島|諸島|列島)$/;
	function viewFor(title) {
		if (/^(東京都|北海道|(京都|大阪)府|.{2,3}県)$/.test(title)) return { zoom: 9 };      // 都道府県
		if (NATURE.test(title)) return { zoom: 11.8, tilt: 55 };                            // 自然地名＝地形ビュー
		if (/[市区町村]$/.test(title)) return { zoom: 12 };                                 // 市区町村
		return { zoom: 14.5 };                                                              // 住所・丁目・施設
	}

	function go(i) {
		const h = items[i]; if (!h) return;
		const [lon, lat] = h.geometry.coordinates;
		input.value = h.properties.title;
		close(); input.blur();
		const v = viewFor(h.properties.title);
		onGo(lon, lat, v.zoom, v.tilt);
	}

	const highlight = () => [...list.children].forEach((d, i) => d.classList.toggle("sel", i === sel));
	input.addEventListener("input", () => {
		clearTimeout(timer);
		const q = input.value.trim();
		if (!q) { close(); return; }
		timer = setTimeout(() => query(q), 280);   // デバウンス＝タイプ中はAPIを叩かない
	});
	input.addEventListener("keydown", e => {
		if (e.key === "Enter") {
			if (items.length) go(sel < 0 ? 0 : sel);
			else { clearTimeout(timer); query(input.value.trim()).then(() => { if (items.length) go(0); }); }   // 一発Enter＝先頭ヒットへ飛ぶ
		} else if (e.key === "ArrowDown" && items.length) { sel = (sel + 1) % items.length; highlight(); e.preventDefault(); }
		else if (e.key === "ArrowUp" && items.length) { sel = (sel - 1 + items.length) % items.length; highlight(); e.preventDefault(); }
		else if (e.key === "Escape") { close(); input.blur(); }
	});
	input.addEventListener("blur", () => setTimeout(close, 120));   // 候補の pointerdown を先に通してから閉じる
}
