// ガジェット：デモ（発表の台本再生）。オプトイン＝orthoJapan() の戻り値から map.gadget.demo({scenes}) で搭載。
// ▶ボタン → 下部中央に操縦バー（左＝「‹ タイトル n/N ›」の送り・右＝別ピルで「▤ ▷」のモード）が出て、台本（scenes）を順に上演する。
// 終了＝点灯した▶の再押下か Esc（×ボタンは置かない＝送りの隣に破壊的ボタンを並べない）。
// ★台本の一行＝共有URLハッシュそのまま（#z/lat/lon[/t][/r][/l=…]）＝アドレスバーのURLを貼るだけでシーンになる。
//   移動は球面フライト（flyView 注入＝van Wijk 三段振り付け・t/r 着地対応）＝トランジション自体が見せ場。
//   view の代わりに glide＝近距離滑走（シーンチェンジでなく「シーン内の動き」＝起きずに 位置→方位→チルト の
//   時分割で滑る。引き・回り込み・立ち上がりの画。大手町→レインボーブリッジのような同じ街のホップ用）。
//   点火チップ(l=)は「l= を書いたシーンだけ」がチップに触る＝無ければ現状維持（発表者の手動チップが台本に勝つ）。
//   シーンの見た目を固定したい時は明示的に l= を（全消し＝末尾 "l="）。
//   c= 付きシーン＝配色の幕替わり：現テーマと違えば「暗転」＝進行を sessionStorage に預け、そのシーンのURLで
//   reload→起動時に自動で台本を再開（着せ替えは元々 reload の設計＝パレットの切替と同じ道。タイル/PLATEAUは
//   IDBが温まっているので復帰は速い）。幕替わりシーンはフルスペック（l= 込み）で書く事＝reloadは状態を持ち越さない。
// スライド＝各シーンの持ち物（view と併存可）：slide="画像URL"（svg/png/webp…拡張子か data:/http で判定）
//   または slide="生テキスト"（思いついた一言を紙のカードで・\n改行可）。
// view+slide 併記＝三拍子の遷移：(view・幕なし) →›→ (幕) →›→ (幕なし) →›→ 次シーン
//   ＝着いた地図を見せ、幕で語り、幕を下ろしてもう一度地図、それから次へ。スライドが無ければ › は素直に次シーンへ。
//   slide だけのシーン＝入場で幕（紙芝居の停留所）。‹ は同じ拍を逆順に戻る。
//   バーの▤ボタン／Space／幕クリック＝いつでも幕の上げ下げ（語りの呼吸。手で上げ下げした分は拍を消化した扱い）。
// opts.slide=false＝スライドを一切出さない上演モード（公開チュートリアル用。スライドだけのシーンは台本から抜く）。
// 自動上演（▷）＝「動画」モード：シーンを hold ms（既定 opts.hold=7000・シーン毎 scene.hold 上書き）で自動送り。
//   三拍子の三拍目（スライドを見終えた後の地図）だけは短い（最大1.5秒）＝既に見た画は「間」だけで次へ。
//   フライトも幕もそのまま流れる＝画面収録（macOS ⌘⇧5 等）と組めばこのまま動画ファイルになる。もう一押しで停止。
// ▶の瞬間に台本の全 view を prefetchViews（app注入）へ＝寄るシーンのPLATEAU区を裏でIDBへ仕込む。
//   序盤の構成（球・列島・スライド）で時間を稼ぐ＝PLATEAUシーン到着時、初見のPCでも一発で街が立つ。
// 操縦：Space/→/PageDown=進む・BS/←/PageUp=戻る（プレゼンの標準作法）・▤=幕・▷=自動上演・Esc/▶=終了。
//   PageUp/Down＝プレゼン用クリッカーがそのまま効く。
// デモ中も地図は生きたまま（掴めば飛行は中断＝主導権は常に人・›でいつでも台本に復帰）＝ビデオでない証明が最大の演出。
// キーボードの地図操作（矢印パン等）はデモ中だけ止める＝keys.js の MODAL_SELECTORS に #demo-bar.on を登録済み。
import { gadgetStack } from "./stack.js";
import { isTypingTarget } from "./keys.js";

// ▶（上演開始）。線色は本線インク直書き＝quiet-mono の夜節が自動反転（palette と同じ流儀）。
const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
	<circle cx="12" cy="12" r="9"/><path d="M10 8.2 L16 12 L10 15.8 Z"/></svg>`;

// slide の中身が画像か生テキストか：画像拡張子・data:/blob:/http(s): だけを画像と見る（それ以外は全部テキスト＝安全側）
const isImg = s => /\.(svg|png|jpe?g|webp|gif|avif)([?#]|$)/i.test(s) || /^(data:|blob:|https?:)/.test(s);
// ビュー文字列の c= トークン（配色テーマ名）＝幕替わり判定用。書式は viewurl.js の共有URL語彙と同じ
const themeTok = s => (/[#/]c=([\w-]+)/.exec(s) || [])[1];
const RESUME_KEY = "oj.demo.resume";   // 幕替わり（reload）を跨ぐ進行の預け先（タブ限り・60秒で失効）

// opts.scenes＝台本 [{title, view?, glide?, slide?, hold?}]。view/glide=共有URLハッシュ文字列（glide=近距離滑走）／
//   slide=画像URLか生テキスト。
// opts.slide=false＝スライド抜き上演。opts.hold＝自動上演の1シーン滞在ms（既定7000）。opts.flyView＝共有URLへ飛ぶ（app が注入）。
// opts.theme＝現テーマ名（app が注入）＝c= 付きシーンの幕替わり（暗転reload）判定に使う。
// opts.prefetchViews＝PLATEAU先読み（app が注入・任意）：▶の瞬間に台本の全 view を渡す＝寄るシーンの区が裏でIDBへ。
//   序盤のシーン構成で時間を稼げば、PLATEAUシーン到着時には初見のPCでも一発で街が立つ（データ重力の種まき兼用）。
// 戻り値＝{start, next, prev, exit, play, pause, toggleSlide}（テスト・プログラム駆動用）。
export function demo({ scenes, slide: slideOn = true, hold = 7000, flyView, prefetchViews, theme, signal } = {}) {
	const mapEl = this.mapEl;
	if (!slideOn && Array.isArray(scenes)) scenes = scenes.filter(s => s.view || !s.slide);   // スライドだけのシーン＝空の停留所になるので抜く
	if (!Array.isArray(scenes) || !scenes.length) { console.warn("[demo] scenes が空＝ガジェットは搭載しない"); return; }
	if (mapEl.querySelector("#demo-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "demo-btn"; btn.dataset.tip = "デモを上演"; btn.setAttribute("aria-label", "デモを上演");
	btn.setAttribute("aria-pressed", "false");   // 上演中＝点灯（星空劇場の家具退場からも除外される＝いつでも止められる）
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）

	// スライド → 操縦バー の順で append＝バーが DOM 順で上（スライド表示中も ‹ › × が押せる）
	const slide = document.createElement("div");
	slide.id = "demo-slide";
	slide.innerHTML = `<img alt=""><div class="ds-text"></div>`;
	const bar = document.createElement("div");
	bar.id = "demo-bar";
	// 二丸薬構成：左＝送りだけ（‹ タイトル n/N ›）、右＝モード（▤ ▷）を間を空けて分離＝発表中の押し間違いを断つ。
	// 終了ボタンは置かない＝点灯した▶の再押下か Esc（星空劇場でも▶は残す＝止める口は常にある）。
	bar.innerHTML = `
		<span class="db-main">
			<button id="demo-prev" aria-label="前のシーンへ" title="前へ (BS/←)">‹</button>
			<span id="demo-title" aria-live="polite"></span><span id="demo-step"></span>
			<button id="demo-next" aria-label="次のシーンへ" title="次へ (Space/→)">›</button>
		</span>
		<span class="db-aux">
			<button id="demo-slidetoggle" aria-label="スライドの表示切替" aria-pressed="false" title="スライド">▤</button>
			<button id="demo-play" aria-label="自動上演" aria-pressed="false" title="自動上演">▷</button>
		</span>`;
	mapEl.append(slide, bar);
	const img = slide.querySelector("img"), textEl = slide.querySelector(".ds-text"),
		titleEl = bar.querySelector("#demo-title"), stepEl = bar.querySelector("#demo-step"),
		stBtn = bar.querySelector("#demo-slidetoggle"), playBtn = bar.querySelector("#demo-play");
	if (!slideOn) stBtn.style.display = "none";   // スライド抜き上演＝▤ごと出さない

	let idx = -1, playing = false, timer = 0, slideShown = false;   // slideShown＝このシーン滞在中に幕を一度見せたか（三拍子の現在拍）
	const on = () => bar.classList.contains("on");
	const schedule = () => {   // 自動上演の滞在timer＝シーン入場と各拍で仕切り直す（幕にも hold 一拍を与える）
		clearTimeout(timer);
		if (!playing) return;
		const s = scenes[idx], h = s?.hold ?? hold;
		// スライドを見終えた後の三拍目（幕を下ろした地図）＝短く：既に見た画への戻りは「間」だけ置いて次へ
		const ms = hasSlide(s) && s.view && slideShown && !slide.classList.contains("open") ? Math.min(1500, h) : h;
		timer = setTimeout(() => { if (on()) next(); }, ms);
	};
	const curtain = open => {   // 幕の上げ下げ＝表示と▤の押下状態を常に一致させる（唯一の出入口）
		slide.classList.toggle("open", open);
		stBtn.setAttribute("aria-pressed", String(open));
		if (open) slideShown = true;
	};
	const hasSlide = s => !!(s && s.slide && slideOn);
	function show(i, fly = true) {   // fly=false＝幕替わり復帰（起動ビュー＝もうシーンの視点に居る＝飛ばない）
		idx = i;
		const s = scenes[i];
		// 配色の幕替わり：シーンの c= が現テーマと違えば「暗転」＝進行を預けて、そのシーンのURLで reload。
		// 起動時に下の resume が拾って自動再開する（着せ替えは reload の設計＝パレット切替と同じ道）。
		const tgt = s.view ?? s.glide, want = tgt && themeTok(tgt);
		if (want && theme && want !== theme) {
			let saved = false;
			try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ i, playing, t: Date.now() })); saved = true; } catch { /* private mode 等 */ }
			if (saved) { location.hash = tgt.startsWith("#") ? tgt : "#" + tgt; location.reload(); return; }
			console.warn("[demo] sessionStorage不可＝幕替わり（配色reload）を諦めて配色そのままで続行");
		}
		titleEl.textContent = s.title || "";
		titleEl.classList.remove("in"); void titleEl.offsetWidth; titleEl.classList.add("in");   // タイトルは毎シーン淡入（reflowでアニメ再点火）
		stepEl.textContent = `${i + 1}/${scenes.length}`;
		bar.querySelector("#demo-prev").disabled = i === 0;
		stBtn.disabled = !hasSlide(s);   // ▤はスライドを持つシーンでだけ効く
		slideShown = false;
		if (hasSlide(s)) {
			const image = isImg(s.slide);
			slide.classList.toggle("text", !image);   // CSS が img / .ds-text を排他表示
			if (image) img.src = s.slide; else { img.removeAttribute("src"); textEl.textContent = s.slide; }   // 生テキスト＝紙のカード（改行は \n）
			curtain(!s.view);   // slideだけのシーン＝入場で幕（紙芝居の停留所）。view併記＝まず地図（幕は›の第二拍）
		}
		else { curtain(false); img.removeAttribute("src"); }
		if (fly) {
			if (s.view) flyView?.(s.view);
			else if (s.glide) flyView?.(s.glide, { glide: true });   // シーン内の動き＝滑走（起きない・時分割）
		}
		schedule();
	}
	let prefetched = false;
	const start = (i = 0, fly = true) => {
		bar.classList.add("on"); show(i, fly);
		btn.setAttribute("aria-pressed", "true"); btn.dataset.tip = "デモを終了 (Esc)"; btn.setAttribute("aria-label", "デモを終了");
		if (!prefetched) { prefetched = true; prefetchViews?.(scenes.map(s => s.view ?? s.glide).filter(Boolean)); }   // ▶＝裏で台本の街をIDBへ（1回だけ・以降はIDB命中でタダ）
	};
	const pause = () => { playing = false; clearTimeout(timer); playBtn.textContent = "▷"; playBtn.setAttribute("aria-pressed", "false"); };
	const play = () => { playing = true; playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-pressed", "true"); schedule(); };
	const exit = () => {
		pause(); bar.classList.remove("on"); curtain(false); img.removeAttribute("src"); idx = -1;
		btn.setAttribute("aria-pressed", "false"); btn.dataset.tip = "デモを上演"; btn.setAttribute("aria-label", "デモを上演");
	};
	// ›＝view+slide 併記シーンでは三拍子：(地図)→(幕)→(地図)→次シーン。幕の無いシーンは素直に次へ。
	// 手で幕を上げ下げした分（▤/Space/クリック）は拍を消化した扱い＝shown&閉なら次で進む。
	const next = () => {
		const s = scenes[idx];
		if (hasSlide(s) && s.view) {
			if (slide.classList.contains("open")) { curtain(false); schedule(); return; }   // 第三拍＝幕を下ろしてもう一度地図
			if (!slideShown) { curtain(true); schedule(); return; }                          // 第二拍＝幕
		}
		if (idx + 1 < scenes.length) show(idx + 1); else exit();   // 最終シーンの先＝そのまま終演（自動上演もここで止まる）
	};
	const prev = () => {   // ‹＝同じ拍を逆順に：幕中→地図(未見に戻す)、見終わり→幕へ、地図(未見)→前シーンへ
		const s = scenes[idx];
		if (hasSlide(s) && s.view) {
			if (slide.classList.contains("open")) { curtain(false); slideShown = false; schedule(); return; }
			if (slideShown) { curtain(true); schedule(); return; }
		}
		if (idx > 0) show(idx - 1);
	};
	const toggleSlide = () => { if (!stBtn.disabled && on()) { curtain(!slide.classList.contains("open")); schedule(); } };   // 手の幕にも拍の仕切り直し

	btn.addEventListener("click", () => on() ? exit() : start());   // ▶＝開始／上演中の再押下＝終了
	bar.querySelector("#demo-next").addEventListener("click", next);
	bar.querySelector("#demo-prev").addEventListener("click", prev);
	stBtn.addEventListener("click", toggleSlide);
	playBtn.addEventListener("click", () => playing ? pause() : play());
	slide.addEventListener("click", () => { curtain(false); schedule(); });   // 幕のクリック＝幕だけ下ろす（シーンは残る）。自動上演中は拍も仕切り直す
	window.addEventListener("keydown", e => {
		if (!on() || isTypingTarget()) return;   // 検索欄などの入力中は譲る（BSの文字削除・Spaceの入力を奪わない）
		if (e.key === " " || e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); next(); }        // Space＝次（プレゼンの標準作法）
		else if (e.key === "Backspace" || e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); prev(); }   // BS＝戻る
		else if (e.key === "Escape") { e.preventDefault(); exit(); }
	}, { signal });
	// 幕替わり（配色reload）からの自動復帰：預けた進行があれば拾って再開。起動ビュー＝もうそのシーンの視点・
	// チップ・テーマで立ち上がっている＝飛ばずに（fly=false）バーだけ点けて続きから。自動上演中だったら再生も継続。
	try {
		const r = JSON.parse(sessionStorage.getItem(RESUME_KEY) || "null");
		sessionStorage.removeItem(RESUME_KEY);
		if (r && Date.now() - r.t < 60000 && r.i >= 0 && r.i < scenes.length) {
			start(r.i, false);
			if (r.playing) play();
		}
	} catch { /* storage 不可＝復帰なし（▶で最初から） */ }
	return { start, next, prev, exit, play, pause, toggleSlide };
}
