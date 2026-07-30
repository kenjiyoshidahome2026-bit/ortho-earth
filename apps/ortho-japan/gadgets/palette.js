// ガジェット：配色テーマ・ピッカー（オプトイン＝orthoJapan() の戻り値から map.gadget.palette() で搭載。
// 呼ばなければ搭載されず、配色は共有URLの c=<name> に従うだけ＝UI は c= を書き替える手段にすぎない）。
// 左スタックにパレット・ボタン → 押すと中央に「自分以外」のテーマの、★今見ている視点そのものの見本をポップ
// （＝この画面がそのテーマでどうなるか。色で選ぶ＝配色テーマの本質）。カード＝切替(onPick→reload)／ESC・外クリック＝取消。
// 見本の作り：style は起動時に worker へ焼き付く＝別テーマの実描画は地図3枚分の起動コストで不可。代わりに
// shot 用スナップショット（現在視点の合成画像）を1枚撮り、テーマ台帳の代表色で色域写像（最近傍分類＋比率転写＝
// 陰影・アンチエイリアスを保ったまま色だけ着せ替え）して3枚に増やす。SVG簡易マップは撮影が来るまでの即時プレースホルダ
// 兼 requestSnapshot 非注入時のフォールバック。
// テーマの語彙（並び・短名・見本色）はここが持つ（chips.js が主題の語彙を持つのと同じ流儀）。★テーマ追加時はここにも1行。
import { gadgetStack } from "./stack.js";
import { composeLayersToCanvas } from "./compose.js";

// 見本色＝palettes.js / style-*.js の実色（paper=紙・ink=注記・water=海(WA一律)・water2=水系点火(WA面/河川)・
// bldg=建物・roads=[幹線1, 幹線2, 一般]・contour=等高線・admin=界線）。地図に見える最小構成の色だけ持つ。
// ★実色写像（remapTheme）の分類語彙も兼ねる＝代表値でなく style-*.js の実色そのままにする事
// （水色をずらすと海が「幹線2の淡青」に最近傍で吸われ、地理院見本の海がオレンジ #e69212 になる実害があった）。
const THEMES = [
	{ k: "mono", name: "白地図", paper: "#f6f6f4", ink: "#86867f", water: "#e2e6ea", water2: "#aecbe6", bldg: "#ececea", roads: ["#2f6cad", "#8fb2d6", "#cececb"], contour: "#b28f5e", admin: "#aa7878" },
	{ k: "dark", name: "ダーク", paper: "#191d24", ink: "#9aa1a9", water: "#090c12", water2: "#2b6d80", bldg: "#21252d", roads: ["#5595dc", "#46688f", "#565c66"], contour: "#b89466", admin: "#a03a42" },
	{ k: "gsi", name: "地理院", paper: "#fefeff", ink: "#555555", water: "#bed2ff", water2: "#00b0ec", bldg: "#ffe6be", roads: ["#3d9738", "#e69212", "#b8b8b8"], contour: "#c8a03c", admin: "#440080" },
	{ k: "sepia", name: "セピア", paper: "#f0e6d3", ink: "#6a5c46", water: "#d6ddd7", water2: "#b9c8c1", bldg: "#e6d7bd", roads: ["#5f82a0", "#93a8bd", "#cab896"], contour: "#8c6b45", admin: "#a4685a" },
];

// 実写見本を出す最小ズーム。これ未満＝正射の球体の陰影（周縁減光）＋大気が画面全体に緩い明暗グラデを乗せ、
// 色域写像が破綻する：「紙(明るい灰)」と「注記ink(中間灰)」は色みが同じ＝明るさでしか分かれないため、陰で暗んだ
// 紙がink階級へ誤分類され、ダークが白いまま・グラデ境界に横縞が出る（分類を賢くしても直せない原理限界）。
// よって低ズームは実写化せず、テーマ色で描いた模式図(SVG見本)へ退避する。平ら＝高ズームでは実写のまま。
// ★実機で調整可：もっと引き（低ズーム）でも実写にしたければ下げる／まだ縞が出るなら上げる。
const LIVE_MIN_Z = 9;

// 簡易マップの見本（120×84）：紙→水→等高線→建物→道路→界線 の順に、その気配だけを描く。色は t で差し替わる。
const sampleSVG = t => `<svg viewBox="0 0 120 84" preserveAspectRatio="none" aria-hidden="true">
	<rect width="120" height="84" fill="${t.paper}"/>
	<path d="M0,84 L0,50 C16,55 29,66 33,84 Z" fill="${t.water}"/>
	<path d="M33,84 C40,63 60,57 67,40 C71,29 85,24 97,13" fill="none" stroke="${t.water}" stroke-width="3" stroke-linecap="round" opacity=".9"/>
	<path d="M74,8 C90,12 99,25 95,40" fill="none" stroke="${t.contour}" stroke-width="1" opacity=".75"/>
	<path d="M80,14 C90,17 95,26 92,37" fill="none" stroke="${t.contour}" stroke-width="1" opacity=".55"/>
	<g fill="${t.bldg}"><rect x="52" y="45" width="7" height="6"/><rect x="61" y="48" width="6" height="5"/><rect x="55" y="54" width="8" height="6"/><rect x="64" y="55" width="5" height="5"/></g>
	<path d="M6,22 C42,27 72,45 118,50" fill="none" stroke="${t.roads[2]}" stroke-width="1.4" stroke-linecap="round"/>
	<path d="M18,80 C34,54 54,45 112,29" fill="none" stroke="${t.roads[1]}" stroke-width="2.4" stroke-linecap="round"/>
	<path d="M2,42 C36,40 66,54 118,60" fill="none" stroke="${t.roads[0]}" stroke-width="3.2" stroke-linecap="round"/>
	<path d="M96,3 L90,28 L100,50 L91,82" fill="none" stroke="${t.admin}" stroke-width="1" stroke-dasharray="3 3" opacity=".85"/>
	<circle cx="46" cy="24" r="1.6" fill="${t.ink}"/>
</svg>`;

// 左スタックのパレット・アイコン（3つ重なる円＝配色の定番グリフ）。上下＝1つ上・2つ下（三色の重なりが下で開く）。
// 線色は本線インク #3f4757 を属性直書き＝quiet-mono の夜節(属性セレクタ)が明インクへ自動反転＝昼夜両対応（currentColor では夜に乗らない）。
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#3f4757" stroke-width="1.6" aria-hidden="true">
	<circle cx="12" cy="9" r="5"/><circle cx="9" cy="15" r="5"/><circle cx="15" cy="15" r="5"/></svg>`;

// --- 見本の実写化：現在視点のスナップショットを、テーマ台帳の代表色で別テーマの色へ写像する ---
const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// テーマの色クラス（分類の語彙）＝見本色そのもの＋宇宙(黒)。宇宙は全テーマ共通＝写像しても黒のまま
// （dark の紙は黒に近い＝この行が無いと低ズームの宇宙が「紙」に分類され、明テーマの見本で白い宇宙になる）。
const classesOf = t => [t.paper, t.ink, t.water, t.water2, t.bldg, ...t.roads, t.contour, t.admin].map(hex2rgb).concat([[0, 0, 0]]);
// 色域写像：各画素を from の最近傍クラスに分類→ to の対応色へ「比率転写」out = to × (px / from)。
// 比率＝陰影(hillshade・建物の面)は乗算的な暗まりなので、暗い紙のテーマへも陰影の向きが正しく移る（差分転写だと夜で破綻）。
// 距離には彩度差の罰則を足す＝無彩色（陰影・昼夜のグラデ）が有彩色クラス（等高線茶など）へ落ちない
// （低ズームの明暗境界が地理院見本でオレンジ帯になる誤分類の対策）。
// どのクラスからも遠い画素（大気のリム・星など）は原色のまま＝知らない色を無理に染めない。
// ★写像は「原寸」で呼ぶ事（縮小は写像の後）：縮小平均で生まれる中間色（道路網×紙のモアレ灰）は
//   どのクラスでもない混色＝先に縮めると誤分類が面で増幅される（東京の街区が地理院見本で一面オレンジになった）。
// 原寸のコストは 15bit 量子化LUTで吸収（地図の色数は少ない＝初出だけ分類し、以後は表引き。誤差は縮小で消える粒度）。
function remapTheme(img, from, to) {
	const A = classesOf(from), B = classesOf(to), n = img.data.length, s = img.data;
	const satA = A.map(c => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]));
	const out = new ImageData(img.width, img.height), d = out.data;
	const TH = 100 * 100;   // 分類を諦める距離²（陰影・ハローで代表色から離れた分は比率転写が吸収する）
	const lut = new Int32Array(32768).fill(-1);   // 5bit/ch 量子化色 → 写像済み色（packed RGB）
	for (let i = 0; i < n; i += 4) {
		const key = (s[i] & 0xf8) << 7 | (s[i + 1] & 0xf8) << 2 | s[i + 2] >> 3;
		let v = lut[key];
		if (v < 0) {   // 初出の色だけ本計算（量子化ビンの中心色で代表＝誤差±4は見本の縮小で消える）
			const r = (s[i] & 0xf8) + 4, g = (s[i + 1] & 0xf8) + 4, b = (s[i + 2] & 0xf8) + 4;
			const sat = Math.max(r, g, b) - Math.min(r, g, b);
			let bi = 0, bd = Infinity;
			for (let k = 0; k < A.length; k++) {
				const dr = r - A[k][0], dg = g - A[k][1], db = b - A[k][2], ds = sat - satA[k],
					dd = dr * dr + dg * dg + db * db + 2 * ds * ds;
				if (dd < bd) { bd = dd; bi = k; }
			}
			let or, og, ob;
			if (bd > TH) { or = r; og = g; ob = b; }
			else {
				const a = A[bi], t = B[bi];
				or = Math.min(255, Math.round(t[0] * (r / (a[0] || 1))));
				og = Math.min(255, Math.round(t[1] * (g / (a[1] || 1))));
				ob = Math.min(255, Math.round(t[2] * (b / (a[2] || 1))));
			}
			v = or << 16 | og << 8 | ob;
			lut[key] = v;
		}
		d[i] = v >> 16 & 255; d[i + 1] = v >> 8 & 255; d[i + 2] = v & 255;
		d[i + 3] = s[i + 3];
	}
	return out;
}

// opts.current＝いま焼き付いているテーマ名（見本から除く＝「自分以外」を出す）。opts.onPick(name)＝切替（app 側が生き替え＝reload無し）。
// opts.requestSnapshot＝shot と同じスナップショット（app が注入）＝見本を「今の視点の実写」にする。無ければ SVG 見本のまま。
export function palette({ current, onPick, requestSnapshot, getZoom, signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#palette-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "palette-btn"; btn.dataset.tip = "配色テーマ"; btn.setAttribute("aria-label", "配色テーマを選ぶ");
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）

	const picker = document.createElement("div");
	picker.id = "theme-picker";
	let curr = current;   // 現在テーマ＝生き替え(reload無し)で変わる＝pick後に更新＝見本の「自分以外」を追従させる
	const cardHTML = t => `<button class="tp-card" data-theme="${t.k}" aria-label="${t.name}に切替">${sampleSVG(t)}<canvas aria-hidden="true"></canvas><span class="tp-name">${t.name}</span></button>`;
	const buildCards = () => { picker.querySelector(".tp-grid").innerHTML = THEMES.filter(t => t.k !== curr).map(cardHTML).join(""); };   // curr以外を3枚（生き替え後は reload しないので手で組み直す）
	picker.innerHTML = `<div class="tp-grid"></div>`;
	mapEl.append(picker);   // 末尾append＝DOM順で最上面（z-index全廃の裁き）
	buildCards();

	// 開く度に撮り直す＝見本は常に「今の視点」。撮影→合成→画面の縦横比に追従して縮小→3テーマへ写像。
	// 失敗・未注入は SVG 見本のまま（.live が付かない＝CSS が SVG を出し続ける）。
	const CAP = 360;   // 見本の実寸＝長辺このpx（カード幅の約2倍＝Retinaでも締まる）。もう片辺は画面比で決める
	const canLive = () => !getZoom || getZoom() >= LIVE_MIN_Z;   // 実写化してよいズームか（低ズーム＝球の陰影で写像破綻＝SVG見本へ退避）
	let shooting = false;
	async function refresh() {
		if (!requestSnapshot || shooting) return;
		// 低ズーム＝球の陰影で色域写像が破綻（白いダーク・横縞）＝実写化せずSVG見本へ退避（.live を外すとCSSがSVGを出す）
		if (!canLive()) { picker.querySelectorAll(".tp-card.live").forEach(c => c.classList.remove("live")); return; }
		shooting = true;
		try {
			const snap = await requestSnapshot();
			// 基図+知性のみ。注記(labels)は縮小で読めずノイズ粒になるだけ＝混ぜない（色で選ぶ見本は色だけが綺麗）。計測の線も同様。
			const full = composeLayersToCanvas({ ...snap, render: snap.render && { ...snap.render, labels: null } });
			// 見本＝今の視点そのまま＝画面全体を使い、カードの縦横比も画面に追従させる（--tp-ar）。
			// 旧・横長10:7の中央切り出しは縦画面で「中央の薄い帯」だけになり実際の眺めと別物だった＝全画面を見本に。
			const sw = snap.W, sh = snap.H, ar = sw / sh;
			picker.style.setProperty("--tp-ar", String(ar));   // canvas も SVG もこの比で（CSS aspect-ratio）
			const src = full.getContext("2d").getImageData(0, 0, sw, sh);   // 原寸のまま写像へ（縮小は写像の後＝remapTheme の★を参照）
			const from = THEMES.find(t => t.k === curr) || THEMES[0];
			const cw = ar >= 1 ? CAP : Math.max(1, Math.round(CAP * ar));   // 長辺CAP・短辺は画面比（縦画面＝縦長カード）
			const ch = ar >= 1 ? Math.max(1, Math.round(CAP / ar)) : CAP;
			const tmp = new OffscreenCanvas(sw, sh), tctx = tmp.getContext("2d");
			for (const card of picker.querySelectorAll(".tp-card")) {   // 現在のカード群（curr追従＝生き替えで中身が入れ替わる）
				const t = THEMES.find(x => x.k === card.dataset.theme); if (!t) continue;
				const cv = card.querySelector("canvas");
				tctx.putImageData(remapTheme(src, from, t), 0, 0);
				cv.width = cw; cv.height = ch;
				cv.getContext("2d").drawImage(tmp, 0, 0, sw, sh, 0, 0, cw, ch);   // 写像済み原寸→見本寸へ縮小（本物を縮めたのと同じ混色）
				card.classList.add("live");   // 以降この開閉では実写見本（次の refresh で上書き）
			}
		} catch (e) { console.warn("[palette] 見本の実写化に失敗＝SVG見本のまま", e); }
		finally { shooting = false; }
	}

	const close = () => picker.classList.remove("open");
	// カードの縦横比を画面に合わせる（開いた瞬間＝まだSVG見本の段階にも効く。refresh は snap から精密に上書き）
	// 実写する時だけカードを画面比に合わせる。SVG見本（低ズーム退避）は本来比(120/84)のまま＝縦画面で模式図が引き伸びない
	const syncAspect = () => canLive()
		? picker.style.setProperty("--tp-ar", String((mapEl.clientWidth || 4) / (mapEl.clientHeight || 3)))
		: picker.style.removeProperty("--tp-ar");
	btn.addEventListener("click", () => { if (picker.classList.toggle("open")) { syncAspect(); refresh(); } });
	picker.addEventListener("click", e => {
		const card = e.target.closest(".tp-card");
		if (card) { const k = card.dataset.theme; onPick?.(k); curr = k; buildCards(); close(); }   // 生き替え＝地図を切替→現在テーマ更新→見本カード作り直し→閉じる（reloadしないので手で）
		else close();                             // カード外（背景）＝取消
	});
	window.addEventListener("keydown", e => {   // ESC＝取消（開いている時だけ・他の Esc 消費と競合しない）
		if (e.key === "Escape" && picker.classList.contains("open")) { e.preventDefault(); close(); }
	}, { signal });
	return { open: () => { picker.classList.add("open"); syncAspect(); refresh(); }, close };
}
