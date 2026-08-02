// ガジェット：デモ（発表の台本再生）。オプトイン＝orthoJapan() の戻り値から map.gadget.demo({scenes}) で搭載。
// ▶ボタン → 下部中央に操縦バー（左＝「‹ タイトル n/N ›」の送り・右＝別ピルで自動上演「▷」）が出て、台本（scenes）を順に上演する。
// 終了＝点灯した▶の再押下か Esc（×ボタンは置かない＝送りの隣に破壊的ボタンを並べない）。
// ★台本の一行＝共有URLハッシュそのまま（#z/lat/lon[/t][/r][/l=…]）＝アドレスバーのURLを貼るだけでシーンになる。
//   移動は球面フライト（flyView 注入＝van Wijk 三段振り付け・t/r 着地対応）＝トランジション自体が見せ場。
//   view の代わりに glide＝近距離滑走（シーンチェンジでなく「シーン内の動き」＝起きずに 位置→方位→チルト の
//   時分割で滑る。引き・回り込み・立ち上がりの画。大手町→レインボーブリッジのような同じ街のホップ用）。
//   点火チップ(l=)は「l= を書いたシーンだけ」がチップに触る＝無ければ現状維持（発表者の手動チップが台本に勝つ）。
//   シーンの見た目を固定したい時は明示的に l= を（全消し＝末尾 "l="）。
//   c= 付きシーン＝配色の幕替わり：flyView が「生き替え」で反映する（reload無し＝暗転が消える・進行はそのまま）。
//   タイルは新styleで再ビルド（IDB温間で速い）・建物/大気は uniform 差替＝飛行の継ぎ目でテーマが溶け替わる。
// スライド＝各シーンの持ち物（view と併存可）：slide="画像URL"（svg/png/webp…拡張子か data:/http で判定）
//   または slide="生テキスト"（思いついた一言を紙のカードで・\n改行可）。
// view+slide 併記＝三拍子の遷移：(view・幕なし) →›→ (幕) →›→ (幕なし) →›→ 次シーン
//   ＝着いた地図を見せ、幕で語り、幕を下ろしてもう一度地図、それから次へ。スライドが無ければ › は素直に次シーンへ。
//   slide だけのシーン＝入場で幕（紙芝居の停留所）。‹ は同じ拍を逆順に戻る。
//   幕クリック/幕中のSpace（手動）＝幕を下ろして0.8秒の間で次のシーンへ＝語り終わりのワンタップ送り。
//   ›/→＝拍どおり（幕を下ろしてもう一度地図＝三拍目を踏みたい時はこちら）。
// opts.slide=false＝スライドを一切出さない上演モード（公開チュートリアル用。スライドだけのシーンは台本から抜く）。
// 自動上演（▷）＝「動画」モード：シーンの「静止」hold ms（既定 opts.hold=7000・シーン毎 scene.hold 上書き）で自動送り。
//   静止はフライト/滑走の着地後から数える（flightActive で待つ）＝遷移の長いシーン（glide連鎖・大ジャンプ）でも
//   見る時間は削られない。幕（スライド）＝slideHold ms（既定 opts.slideHold=4000・シーン毎 scene.slideHold 上書き）。
//   幕前の地図は最大2秒（着いた画をひと目＝語りは幕で）・幕後の三拍目は最大1.5秒＝既に見た画は「間」だけで次へ。
//   静止中は字幕＝scene.caption（無ければ title 代用）を画面上部にやや大きめに出す＝無言の動画でも文脈が付く。
//   上映中は操縦バーごと退場（デスクトップ＝幅481px以上）＝画面は映画・停止は点灯した▶の一押し（＝一時停止でバー復帰）。
//   狭画面はバーを残す＝❚❚で止める（▶がガジェット退場で見えない事があるため）。
//   フライトも幕もそのまま流れる＝画面収録（macOS ⌘⇧5 等）と組めばこのまま動画ファイルになる。
// ▶の瞬間に台本の全 view を prefetchViews（app注入）へ＝寄るシーンのPLATEAU区を裏でIDBへ仕込む。
//   序盤の構成（球・列島・スライド）で時間を稼ぐ＝PLATEAUシーン到着時、初見のPCでも一発で街が立つ。
// 操縦：Space/→/PageDown=進む・BS/←/PageUp=戻る（プレゼンの標準作法）・▷=自動上演・Esc/▶=終了（上映中の▶=停止）。
//   PageUp/Down＝プレゼン用クリッカーがそのまま効く。
// タイトル/歩数のクリック＝シーン一覧（目次）がバーの真上にポップ→クリックでジャンプ（Esc=一覧だけ閉じる）。
// デモ中も地図は生きたまま（掴めば飛行は中断＝主導権は常に人・›でいつでも台本に復帰）＝ビデオでない証明が最大の演出。
// キーボードの地図操作（矢印パン等）はデモ中だけ止める＝keys.js の MODAL_SELECTORS に #demo-bar.on を登録済み。
import { gadgetStack } from "./stack.js";
import { isTypingTarget } from "./keys.js";

// ▶（上演開始）。線色は本線インク直書き＝quiet-mono の夜節が自動反転（palette と同じ流儀）。
const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
	<circle cx="12" cy="12" r="9"/><path d="M10 8.2 L16 12 L10 15.8 Z"/></svg>`;

// slide の中身が画像か生テキストか：画像拡張子・data:/blob:/http(s): だけを画像と見る（それ以外は全部テキスト＝安全側）
const isImg = s => /\.(svg|png|jpe?g|webp|gif|avif)([?#]|$)/i.test(s) || /^(data:|blob:|https?:)/.test(s);
// 配色テーマ（c=）の幕替わりは flyView 側の「生き替え」（reload無し）で反映＝ここでのトークン判定/進行預け(RESUME_KEY)は不要になった。

// opts.scenes＝台本 [{title, view?, glide?, pre?, slide?, caption?, hold?, mobile?}]。view/glide=共有URLハッシュ文字列（glide=近距離滑走）／
//   pre=入場の見せ玉：まず pre の画へ飛び、着地から1秒後に view を遷移なしで重ねる（同座標で l= だけ点ける演出）／
//   slide=画像URLか生テキスト／caption=自動上演の静止中に画面上部へ出す字幕（無ければ title 代用）／
//   mobile=Δz：縦長画面（縦>横）でだけシーンの z に足す差分（例 -1.2＝一段引く）。
//   横パノラマ構図の左右切り落とし対策＝中心・チルト・方位はそのまま、ズームだけ動かす＝台本は1枚のまま。
// opts.mobile＝Δz の台本全体の既定（全シーンに効く）。シーン毎の mobile が勝つ＝mobile: 0 でそのシーンだけ無効化。
// opts.slide=false＝スライド抜き上演。opts.hold＝自動上演の静止ms（既定7000・着地後から）。opts.slideHold＝幕の表示ms（既定4000）。
// opts.flyView＝共有URLへ飛ぶ（app が注入）。opts.flightActive＝フライト/滑走中か（app が注入）＝静止の計時を着地まで待たせる。
// （opts.theme は撤去：c= 付きシーンの幕替わりは flyView 側の生き替え＝reload無しが反映する＝demo は持たない）
// opts.prefetchViews＝PLATEAU先読み（app が注入・任意）：▶の瞬間に台本の全 view を渡す＝寄るシーンの区が裏でIDBへ。
//   序盤のシーン構成で時間を稼げば、PLATEAUシーン到着時には初見のPCでも一発で街が立つ（データ重力の種まき兼用）。
// 戻り値＝{start, next, prev, exit, play, pause}（テスト・プログラム駆動用）。
export function demo({ scenes, slide: slideOn = true, hold = 5500, slideHold = 4000, mobile, flyView, flightActive, prefetchViews, signal, plateau } = {}) {
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
	// 二丸薬構成：左＝送りだけ（‹ タイトル n/N ›）、右＝別ピルで自動上演（▷）＝発表中の押し間違いを断つ。
	// 終了ボタンは置かない＝点灯した▶の再押下か Esc（星空劇場でも▶は残す＝止める口は常にある）。
	bar.innerHTML = `
		<span class="db-main">
			<button id="demo-prev" aria-label="前のシーンへ" title="前へ (BS/←)">‹</button>
			<span id="demo-title" aria-live="polite"></span><span id="demo-step"></span>
			<button id="demo-next" aria-label="次のシーンへ" title="次へ (Space/→)">›</button>
		</span>
		<span class="db-aux">
			<button id="demo-play" aria-label="自動上演" aria-pressed="false" title="自動上演">▷</button>
		</span>`;
	// 字幕（自動上演専用）＝静止中だけ画面上部に caption（無ければ title）。触れない（pointer-events無し）＝地図の邪魔をしない
	const cap = document.createElement("div");
	cap.id = "demo-caption";
	mapEl.append(slide, bar, cap);
	const img = slide.querySelector("img"), textEl = slide.querySelector(".ds-text"),
		titleEl = bar.querySelector("#demo-title"), stepEl = bar.querySelector("#demo-step"),
		playBtn = bar.querySelector("#demo-play");
	// シーン一覧（目次）：タイトル/歩数のクリックでバーの真上にポップ＝クリックでそのシーンへジャンプ。
	// c= 付きシーンへのジャンプも show()→flyView 経由＝生き替え（reload無し）がそのまま効く。
	const list = document.createElement("div");
	list.id = "demo-list";
	const sceneLabel = s => s.title || (s.slide && !s.view && !s.glide ? "（スライド）" : (s.view ?? s.glide ?? "（無題）"));
	list.innerHTML = scenes.map((s, i) => `<button data-i="${i}">${i + 1}. ${sceneLabel(s)}</button>`).join("");
	bar.append(list);
	titleEl.title = "シーン一覧"; titleEl.setAttribute("role", "button"); titleEl.setAttribute("aria-haspopup", "listbox");
	const listOpen = () => list.classList.contains("open");
	const syncList = () => {
		list.querySelectorAll("button[data-i]").forEach(b => b.setAttribute("aria-current", String(+b.dataset.i === idx)));
		// 一覧は約10行でスクロール＝現在シーンが圏外なら見える所へ（開いた時・開いたままの送りの両方）
		if (listOpen()) list.querySelector('button[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
	};

	// mobile:Δz＝縦長画面ではシーンの z（ハッシュ先頭の数値）にだけ差分を足す。判定は show() の度＝回転にも追随。
	// 差分＝シーン毎 mobile が台本既定 opts.mobile に勝つ（mobile: 0＝そのシーンだけ明示無効）。t 指定＝pre 等の別ハッシュにも同じ補正
	const mobView = (s, t = s.view ?? s.glide) => {
		const d = s.mobile ?? mobile;
		if (!t || !d || mapEl.clientWidth >= mapEl.clientHeight) return t;
		// シフト後はアプリのズーム床(2)でクランプ：低z台本（例 地球と天体 z2）にΔを足すと床下(z0.8)になり、
		// glide（cam直書き＝床素通り）と jump（applyView＝床で弾く）の差で「星座が点く瞬間に z が跳ぶ」（モバイル実測 2026-08-02）
		return t.replace(/-?[\d.]+/, z => String(Math.max(2, Math.round((+z + d) * 100) / 100)));
	};

	let idx = -1, playing = false, timer = 0, preTimer = 0, slideShown = false;   // slideShown＝このシーン滞在中に幕を一度見せたか（三拍子の現在拍）
	const on = () => bar.classList.contains("on");
	const caption = show => {   // 自動上演の字幕：静止中だけ scene.caption（無ければ title 代用）を画面上部へ
		const text = show ? (scenes[idx]?.caption ?? scenes[idx]?.title ?? "") : "";
		if (text) cap.textContent = text;
		cap.classList.toggle("show", !!text);
	};
	const schedule = () => {   // 自動上演の滞在timer＝シーン入場と各拍で仕切り直す
		clearTimeout(timer);
		if (!playing) return;
		const s = scenes[idx], h = s?.hold ?? hold;
		// 拍ごとの滞在：幕＝slideHold（読む時間）／幕前の地図＝最大2秒（着いた画をひと目・語りは幕で）／
		// 幕後の三拍目＝最大1.5秒（既に見た画は「間」だけ）／素の地図シーン＝hold
		const ms = slide.classList.contains("open") ? (s?.slideHold ?? slideHold)
			: hasSlide(s) && s.view ? Math.min(slideShown ? 1500 : 2000, h)
			: h;
		// 静止の計時はフライト/滑走の「着地後」から＝遷移の長いシーンでも見る時間が削られない（200ms刻みで着地を待つ）。
		// 字幕も着地と同時に点く（飛行中・幕中は引っ込む＝地図とスライドが主役）
		const arm = () => {
			if (flightActive?.()) { caption(false); timer = setTimeout(arm, 200); return; }
			caption(!slide.classList.contains("open"));
			timer = setTimeout(() => { if (on()) next(); }, ms);
		};
		arm();
	};
	const curtain = open => {   // 幕の上げ下げの唯一の出入口
		slide.classList.toggle("open", open);
		if (open) slideShown = true;
	};
	const hasSlide = s => !!(s && s.slide && slideOn);
	function show(i, fly = true) {   // fly=false＝飛ばずに即表示（もうその視点に居る等・現状は常に fly=true）
		idx = i;
		clearTimeout(preTimer);   // 前シーンの pre→view 予約は持ち越さない
		const s = scenes[i];
		// 配色の幕替わり：シーンの c=（配色テーマ）は flyView が「生き替え」で反映する（reload無し＝暗転が消える・進行はそのまま）。
		// タイルは新styleで再ビルド（IDB温間で速い）・建物/大気は uniform 差替＝飛行の継ぎ目でテーマが溶け替わる。ここは素の送りに徹する。
		const tgt = mobView(s);   // mobile:Δz を効かせたシーンURL（c= 込み＝この後 flyView に渡り switchTheme が効く）
		titleEl.textContent = s.title || "";
		titleEl.classList.remove("in"); void titleEl.offsetWidth; titleEl.classList.add("in");   // タイトルは毎シーン淡入（reflowでアニメ再点火）
		stepEl.textContent = `${i + 1}/${scenes.length}`;
		syncList();   // 一覧の現在シーン印を追随（開いたままの送りにも効く）
		bar.querySelector("#demo-prev").disabled = i === 0;
		slideShown = false;
		if (hasSlide(s)) {
			const image = isImg(s.slide);
			slide.classList.toggle("text", !image);   // CSS が img / .ds-text を排他表示
			if (image) img.src = s.slide; else { img.removeAttribute("src"); textEl.textContent = s.slide; }   // 生テキスト＝紙のカード（改行は \n）
			curtain(!s.view);   // slideだけのシーン＝入場で幕（紙芝居の停留所）。view併記＝まず地図（幕は›の第二拍）
		}
		else { curtain(false); img.removeAttribute("src"); }
		if (fly && tgt) {
			// pre＝入場の見せ玉：まず pre の画へ飛び、着地から1秒だけ見せて view を遷移なし（jump）で重ねる。
			// pre と view は同座標が前提＝実際に動くのは l= だけ（素の地図が着いた後、レイヤが「点く」演出）
			if (s.pre) {
				flyView?.(mobView(s, s.pre), s.view ? undefined : { glide: true });
				const arm = () => { preTimer = flightActive?.() ? setTimeout(arm, 100) : setTimeout(() => flyView?.(tgt, { jump: true }), 1000); };
				arm();
			}
			else flyView?.(tgt, s.view ? undefined : { glide: true });   // glide＝シーン内の動き＝滑走（起きない・時分割）
		}
		schedule();
	}
	let prefetched = false;
	// 狭画面（スマホ）＝映画館モード：操縦バー/家具は出さず（quiet-mono #map.demo-live のCSS退場）、
	// ▶開始＝即・自動上演。止める口は点灯▶（と Esc）だけ＝「ストップボタンのみ」。回転に追随＝押下時評価。
	const narrow = () => window.matchMedia("(max-width: 480px)").matches;
	const start = (i = 0, fly = true) => {
		bar.classList.add("on"); mapEl.classList.add("demo-live"); show(i, fly);
		btn.setAttribute("aria-pressed", "true"); btn.dataset.tip = "デモを終了 (Esc)"; btn.setAttribute("aria-label", "デモを終了");
		if (!prefetched) { prefetched = true; prefetchViews?.(scenes.map(s => s.view ?? s.glide).filter(Boolean), plateau); }   // ▶＝裏で台本の街をIDBへ（1回だけ・以降はIDB命中でタダ）。plateau=台本の明示リスト（任意）
		if (narrow()) play();   // 狭画面の▶開始＝即・自動上演（play は再入無害）
	};
	// 上映中（.playing）＝デスクトップでは操縦バーごと退場（CSS）＝停止は点灯した▶が受ける。字幕も止まったら引っ込める
	const pause = () => {
		playing = false; clearTimeout(timer); caption(false); bar.classList.remove("playing");
		playBtn.textContent = "▷"; playBtn.setAttribute("aria-pressed", "false");
		if (on()) { btn.dataset.tip = "デモを終了 (Esc)"; btn.setAttribute("aria-label", "デモを終了"); }
	};
	const play = () => {
		if (playing) return;   // 再入（狭画面 start→play が重なる等）＝スケジューラを重ねない
		playing = true; bar.classList.add("playing");
		playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-pressed", "true");
		btn.dataset.tip = "上映を停止"; btn.setAttribute("aria-label", "上映を停止");
		schedule();
	};
	const exit = () => {
		pause(); clearTimeout(preTimer); bar.classList.remove("on"); mapEl.classList.remove("demo-live"); curtain(false); img.removeAttribute("src"); idx = -1;
		list.classList.remove("open");
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
	// ▶＝開始／自動上映中＝停止（バー復帰）／手動中の再押下＝終了。
	// 狭画面はバーが無い（映画館モード）＝pause で手動へ落とすと操縦不能＝▶は常に「終了」。
	btn.addEventListener("click", () => on() ? ((playing && !narrow()) ? pause() : exit()) : start());
	bar.querySelector("#demo-next").addEventListener("click", next);
	bar.querySelector("#demo-prev").addEventListener("click", prev);
	playBtn.addEventListener("click", () => playing ? pause() : play());
	const peelNext = () => {   // 幕を下ろすワンタップ送り：手動＝0.8秒の間で次のシーンへ／自動上演＝三拍目の「間」へ
		curtain(false);
		if (playing) { schedule(); return; }
		clearTimeout(timer); timer = setTimeout(() => { if (on()) next(); }, 800);
		// 途中で手動送りが入っても二重前進しない＝show()→schedule() が冒頭の clearTimeout でこの timer を握り潰す
	};
	slide.addEventListener("click", peelNext);
	const toggleList = () => { if (on()) { list.classList.toggle("open"); syncList(); } };
	titleEl.addEventListener("click", toggleList);
	stepEl.addEventListener("click", toggleList);   // 無題シーン（タイトル空）でも歩数から開ける
	list.addEventListener("click", e => {
		const b = e.target.closest("button[data-i]");
		if (b) { list.classList.remove("open"); show(+b.dataset.i); }   // ジャンプ＝一覧は閉じて向かう（c=シーンは flyView が生き替え）
	});
	window.addEventListener("keydown", e => {
		if (!on() || isTypingTarget()) return;   // 検索欄などの入力中は譲る（BSの文字削除・Spaceの入力を奪わない）
		if (e.key === " ") { e.preventDefault(); slide.classList.contains("open") ? peelNext() : next(); }          // Space＝次。幕中は幕クリックと同じワンタップ送り
		else if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); next(); }                   // →/PageDown＝拍どおりの次
		else if (e.key === "Backspace" || e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); prev(); }   // BS＝戻る
		else if (e.key === "Escape") { e.preventDefault(); listOpen() ? list.classList.remove("open") : exit(); }   // Esc＝一覧が開いていれば一覧だけ閉じる
	}, { signal });
	// 配色の幕替わりは flyView の生き替え（reload無し）へ移行＝reload を跨ぐ自動復帰は不要になった（RESUME_KEY 撤去）。
	return { start, next, prev, exit, play, pause };
}
