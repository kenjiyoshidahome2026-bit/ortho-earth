// ガジェット：デモ（発表の台本再生）。オプトイン＝orthoJapan() の戻り値から map.gadget.demo({scenes}) で搭載。
// ▶ボタン → 下部中央に操縦バー（左＝「‹ タイトル n/N ›」の送り・右＝別ピルで自動上演「▷」）が出て、台本（scenes）を順に上演する。
// 終了＝点灯した▶の再押下か Esc（×ボタンは置かない＝送りの隣に破壊的ボタンを並べない）。
// ★台本の一行＝共有URLハッシュそのまま（#z/lat/lon[/t][/r][/l=…]）＝アドレスバーのURLを貼るだけでシーンになる。
//   移動は球面フライト（flyView 注入＝van Wijk 三段振り付け・t/r 着地対応）＝トランジション自体が見せ場。
//   view の代わりに glide＝近距離滑走（シーンチェンジでなく「シーン内の動き」＝起きずに 位置→方位→チルト の
//   時分割で滑る。引き・回り込み・立ち上がりの画。大手町→レインボーブリッジのような同じ街のホップ用）。
//   { via:"#〜", travel:秒 } 行＝通過点：view/glide 行の間に挟むと、直前の着点から次の着点まで1本のスプライン
//   （連続ドリー・5自由度）で貫く。travel＝その点に到達するまでの区間尺[秒]（省略＝経路長比例の自動）。
//   via はシーンに数えない（歩数・目次から消える）。道中はカメラのみ＝l=/c= は直前シーンで設定しておく。
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
// 自動上演（▷）＝「動画」モード：シーンの「静止」hold 秒（既定 opts.hold=5.5・シーン毎 scene.hold 上書き）で自動送り。
//   時間は台本もオプションも全部「秒」＝ms 化はこのファイルの内側だけ（v2 で統一・2026-08-08）。
//   静止はフライト/滑走の着地後から数える（flightActive で待つ）＝遷移の長いシーン（via ドリー・大ジャンプ）でも
//   見る時間は削られない。幕（スライド）＝slideHold 秒（既定 opts.slideHold=4・シーン毎 scene.slideHold 上書き）。
//   幕前の地図は最大2秒（着いた画をひと目＝語りは幕で）・幕後の三拍目は最大1.5秒＝既に見た画は「間」だけで次へ。
//   静止中は字幕＝scene.caption（無ければ title 代用）を画面上部にやや大きめに出す＝無言の動画でも文脈が付く。
//   上映中は操縦バーごと退場（デスクトップ＝幅481px以上）＝画面は映画・停止は点灯した▶の一押し（＝一時停止でバー復帰）。
//   狭画面はバーを残す＝❚❚で止める（▶がガジェット退場で見えない事があるため）。
//   フライトも幕もそのまま流れる＝画面収録（macOS ⌘⇧5 等）と組めばこのまま動画ファイルになる。
// ▶の瞬間に台本の全 view を prefetchViews（app注入）へ＝寄るシーンのPLATEAU区を裏でIDBへ仕込む。
//   序盤の構成（球・列島・スライド）で時間を稼ぐ＝PLATEAUシーン到着時、初見のPCでも一発で街が立つ。
// 操縦：Space/→/PageDown=進む・BS/←/PageUp=戻る（プレゼンの標準作法）・▷=自動上演・Esc/▶=終了（上映中の▶=停止）。
//   PageUp/Down＝プレゼン用クリッカーがそのまま効く。
// タイトル/歩数のクリック＝シーン一覧（目次）がバーの真上にポップ→クリックでジャンプ（Esc/枠外クリック=一覧だけ閉じる）。
// デモ中も地図は生きたまま（掴めば飛行は中断＝主導権は常に人・›でいつでも台本に復帰）＝ビデオでない証明が最大の演出。
// キーボードの地図操作（矢印パン等）はデモ中だけ止める＝keys.js の MODAL_SELECTORS に #demo-bar.on を登録済み。
import { gadgetStack } from "./stack.js";
import { isTypingTarget } from "./keys.js";
import { compileVias } from "../demo/scene-adapter.js";   // via 行（通過点）→ 着点シーンの path:[{view,travel}…] への畳み込み（純関数・台本受領時に必ず通す）

// ▶（上演開始）。線色は本線インク直書き＝quiet-mono の夜節が自動反転（palette と同じ流儀）。
const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
	<circle cx="12" cy="12" r="9"/><path d="M10 8.2 L16 12 L10 15.8 Z"/></svg>`;

// slide の中身が画像か生テキストか：画像拡張子・data:/blob:/http(s): だけを画像と見る（それ以外は全部テキスト＝安全側）
const isImg = s => /\.(svg|png|jpe?g|webp|gif|avif)([?#]|$)/i.test(s) || /^(data:|blob:|https?:)/.test(s);
// 配色テーマ（c=）の幕替わりは flyView 側の「生き替え」（reload無し）で反映＝ここでのトークン判定/進行預け(RESUME_KEY)は不要になった。

// opts.scenes＝台本 [{title, view?, glide?, via?, travel?, pre?, slide?, caption?, hold?, mobile?}]。view/glide=共有URLハッシュ文字列（glide=近距離滑走）／
//   via=通過点（連続ドリー・compileVias が着点の path に畳む＝シーンに数えない）／travel=その点に到達するまでの区間尺[秒]／
//   pre=入場の見せ玉：まず pre の画へ飛び、着地から1秒後に view を遷移なしで重ねる（同座標で l= だけ点ける演出）／
//   slide=画像URLか生テキスト／caption=自動上演の静止中に画面上部へ出す字幕（無ければ title 代用）／
//   言語＝en基準・拡張可能：title は英語が正、シーンに言語コードのフィールド（jp:/en:…）を足すと opts.lang で切替。
//   opts.lang＝表示言語（例 "jp"。?lang= から index.html が渡す）：タイトル・字幕・一覧が scene[lang] ?? title で解決／
//   mobile=Δz：縦長画面（縦>横）でだけシーンの z に足す差分（例 -1.2＝一段引く）。
//   横パノラマ構図の左右切り落とし対策＝中心・チルト・方位はそのまま、ズームだけ動かす＝台本は1枚のまま。
// opts.mobile＝Δz の台本全体の既定（全シーンに効く）。シーン毎の mobile が勝つ＝mobile: 0 でそのシーンだけ無効化。
// opts.slide=false＝スライド抜き上演。opts.hold＝自動上演の静止秒（既定5.5・着地後から）。opts.slideHold＝幕の表示秒（既定4）。
// opts.flyView＝共有URLへ飛ぶ（app が注入）。opts.flightActive＝フライト/滑走中か（app が注入）＝静止の計時を着地まで待たせる。
// （opts.theme は撤去：c= 付きシーンの幕替わりは flyView 側の生き替え＝reload無しが反映する＝demo は持たない）
// opts.prefetchViews＝重いデータ（3D都市）の先読み（app が注入・任意）：▶の瞬間に台本の全 view を渡す＝寄るシーンの区が裏でIDBへ。
//   序盤のシーン構成で時間を稼げば、深ズームのシーン到着時には初見のPCでも一発で街が立つ（データ重力の種まき兼用）。
// opts.preload＝明示の先読みリスト（カタログ名・prefetchViews の第2引数へ）＝台本の持ち物（載せ替え時に台本の指定へ差し替わる）。
// opts.player=true＝素のプレーヤーとして搭載（組み込み台本なし可・▶を出さない）＝エディタ等が start({scenes}) で台本を持ち込む器。
// opts/start.onScene(i, scene)＝行の上映開始（フライト開始前＝エディタの行ハイライト用）／onEnd(reason)＝どの終わり方でも1発
//   （"finished"=走破・"stopped"=Esc/▶/exit()）。台本スコープ＝載せ替えでリセット（finale と同じ流儀）。
// 戻り値＝{start, next, prev, exit, play, pause}（テスト・プログラム駆動用）。
// opts.finale＝台本を最後まで走り切った時だけ呼ばれる終演フック（app が japan-fit を注入）。Esc/▶の途中終了では呼ばない。
// opts.fadeView＝フェード遷移（app が注入・任意）：黒への溶暗→切替→溶明（fade: 行・尺=travel）。無ければ fade 行は普通の飛行に落ちる。
export function demo({ scenes, slide: slideOn = true, hold = 5.5, slideHold = 4, mobile, zoomMin = 1, lang, flyView, fadeView, glidePath, flightActive, prefetchViews, finale, signal, preload, player: playerOnly = false } = {}) {
	const mapEl = this.mapEl;
	if (!slideOn && Array.isArray(scenes)) scenes = scenes.filter(s => s.view || !s.slide);   // スライドだけのシーン＝空の停留所になるので抜く
	scenes = compileVias(scenes ?? []);   // via 行→着点の path へ（via の無い台本は恒等＝同じ配列のまま）
	const hasBuiltin = Array.isArray(scenes) && scenes.length > 0;   // 組み込み台本の有無＝▶と builtin はこれがある時だけ
	if (!hasBuiltin) {
		if (!playerOnly) { console.warn("[demo] scenes が空＝ガジェットは搭載しない（素のプレーヤーは player:true）"); return; }
		scenes = [];   // player:true＝空台本マウント（エディタ等）：▶無しで器だけ組む＝台本は start({scenes}) が持ち込む
	}
	if (mapEl.querySelector("#demo-bar")) return;   // 二重搭載は無害（バーは常設＝player搭載でも在る確実な印）
	let btn = null;
	if (hasBuiltin) {   // ▶＝組み込み台本の入り口（player 搭載では出さない＝押しても流す物が無い）
		btn = document.createElement("button");
		btn.id = "demo-btn"; btn.dataset.tip = "デモを上演"; btn.setAttribute("aria-label", "デモを上演");
		btn.setAttribute("aria-pressed", "false");   // 上演中＝点灯（星空劇場の家具退場からも除外される＝いつでも止められる）
		btn.innerHTML = ICON;
		gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	}

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
	// 言語解決：scene[lang]（jp:/en:… の言語フィールド）→ 無ければ title（en基準）。タイトル・字幕・一覧の3か所共通
	const T = s => s?.[lang] ?? s?.title ?? "";
	const sceneLabel = s => T(s) || (s.slide && !s.view && !s.glide && !s.fade ? "（スライド）" : (s.view ?? s.glide ?? s.fade ?? "（無題）"));
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
	const mobView = (s, t = s.view ?? s.glide ?? s.fade) => {
		const d = s.mobile ?? mobile;
		if (!t || !d || mapEl.clientWidth >= mapEl.clientHeight) return t;
		// シフト後はアプリのズーム床(2)でクランプ：低z台本（例 地球と天体 z2）にΔを足すと床下(z0.8)になり、
		// glide（cam直書き＝床素通り）と jump（applyView＝床で弾く）の差で「星座が点く瞬間に z が跳ぶ」（モバイル実測 2026-08-02）
		return t.replace(/-?[\d.]+/, z => String(Math.max(zoomMin, Math.round((+z + d) * 100) / 100)));
	};

	let idx = -1, playing = false, timer = 0, preTimer = 0, slideShown = false;   // slideShown＝このシーン滞在中に幕を一度見せたか（三拍子の現在拍）
	// 「デモの入り口(▶)」と「ドロップの入り口」は別で、同じ再生ルーチン(start)を呼ぶだけ＝台本を渡すのが違うだけ。
	// ▶は常に組み込み設定を渡す＝ドロップで別台本を流しても壊れない（上書きも復帰もしない）。
	const dflt = { lang, mobile, hold, slideHold };   // マウント時の既定＝台本載せ替え時のリセット先（前の台本の設定を持ち越さない）
	const builtin = hasBuiltin ? { scenes, finale, preload } : null;   // 組み込み(▶)の再生設定＝マウント時に保持（lang等は dflt が復元する）
	let activeFinale = finale;   // 「今の再生」の終演フック（start で差し替え・ドロップ=null＝末尾に何も足さない）
	let activeOnScene = null, activeOnEnd = null;   // 観測面（scene-player API）：行の上映開始／終演（理由つき）＝台本スコープ（載せ替えでリセット）
	let bareLive = false;        // ドロップ再生中＝素モード（バー無し・上映中ノーアクション）＝操作ハンドラを不活性化する鍵
	const on = () => bar.classList.contains("on");
	const caption = show => {   // 自動上演の字幕：静止中だけ scene.caption（無ければ title 代用）を画面上部へ
		const text = show ? (scenes[idx]?.caption ?? T(scenes[idx])) : "";
		if (text) cap.textContent = text;
		cap.classList.toggle("show", !!text);
	};
	const schedule = () => {   // 自動上演の滞在timer＝シーン入場と各拍で仕切り直す
		clearTimeout(timer);
		if (!playing) return;
		const s = scenes[idx], h = (s?.hold ?? hold) * 1000;   // 台本は秒＝ms 化はここ（内側）だけ
		// 拍ごとの滞在：幕＝slideHold（読む時間）／幕前の地図＝最大2秒（着いた画をひと目・語りは幕で）／
		// 幕後の三拍目＝最大1.5秒（既に見た画は「間」だけ）／素の地図シーン＝hold
		const ms = slide.classList.contains("open") ? (s?.slideHold ?? slideHold) * 1000
			: hasSlide(s) && s.view ? Math.min(slideShown ? 1500 : 2000, h)
			: h;
		// 静止の計時はフライト/滑走の「着地後」から＝遷移の長いシーンでも見る時間が削られない（200ms刻みで着地を待つ）。
		// 字幕も着地と同時に点く（飛行中・幕中は引っ込む＝地図とスライドが主役）
		const arm = () => {
			if (flightActive?.()) { caption(scenes[idx]?.path ? !slide.classList.contains("open") : false); timer = setTimeout(arm, 200); return; }   // path（連続ドリー）は移動中も字幕を出す＝川を遡る間ずっと見出しが乗る
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
		titleEl.textContent = T(s);
		titleEl.classList.remove("in"); void titleEl.offsetWidth; titleEl.classList.add("in");   // タイトルは毎シーン淡入（reflowでアニメ再点火）
		stepEl.textContent = `${i + 1}/${scenes.length}`;
		syncList();   // 一覧の現在シーン印を追随（開いたままの送りにも効く）
		bar.querySelector("#demo-prev").disabled = i === 0;
		activeOnScene?.(i, s);   // 観測面：この行の上映開始（フライト開始前＝エディタの行ハイライト用）
		slideShown = false;
		if (hasSlide(s)) {
			const image = isImg(s.slide);
			slide.classList.toggle("text", !image);   // CSS が img / .ds-text を排他表示
			if (image) img.src = s.slide; else { img.removeAttribute("src"); textEl.textContent = s.slide; }   // 生テキスト＝紙のカード（改行は \n）
			curtain(!s.view);   // slideだけのシーン＝入場で幕（紙芝居の停留所）。view併記＝まず地図（幕は›の第二拍）
		}
		else { curtain(false); img.removeAttribute("src"); }
		if (fly && s.jump && tgt) {
			flyView?.(tgt, { jump: true });   // 先頭シーン等＝遷移なしで即その視点（遠景の弧を作らない＝「定義したそのまま」で開始）
		} else if (fly && s.path && glidePath) {
			glidePath(s.path.map(p => ({ view: mobView(s, p.view), travel: p.travel })));   // ★ via 連続＝1本のスプライン（隅田川ドリー）。cam から滑らかに入り、通過保証で曲線を辿る（5自由度：経緯度=曲線／zoom/pitch/bearing=区間補間）。travel＝各点への区間尺[秒]
		} else if (fly && s.fade && fadeView) {
			fadeView(tgt, s.travel);   // フェード遷移＝黒への溶暗→切替→溶明（尺=travel・既定1.2秒）。道中の絵を見せないカット
		} else if (fly && tgt) {
			// pre＝入場の見せ玉：まず pre の画へ飛び、着地から1秒だけ見せて view を遷移なし（jump）で重ねる。
			// pre と view は同座標が前提＝実際に動くのは l= だけ（素の地図が着いた後、レイヤが「点く」演出）
			if (s.pre) {
				flyView?.(mobView(s, s.pre), s.view ? undefined : { glide: true });
				const arm = () => { preTimer = flightActive?.() ? setTimeout(arm, 100) : setTimeout(() => flyView?.(tgt, { jump: true }), 1000); };
				arm();
			}
			else if (s.glide && s.travel && glidePath) glidePath([{ view: tgt, travel: s.travel }]);   // 尺指定の滑走＝1区間スプライン（同時補間・尺どおり。カメラのみ＝l=/c= は乗らない）
			else flyView?.(tgt, s.view ? undefined : { glide: true });   // glide＝シーン内の動き＝滑走（起きない・時分割・尺は自動）
		}
		schedule();
	}
	let prefetched = false;
	// 狭画面（スマホ）＝映画館モード：操縦バー/家具は出さず（quiet-mono #map.demo-live のCSS退場）、
	// ▶開始＝即・自動上演。止める口は点灯▶（と Esc）だけ＝「ストップボタンのみ」。回転に追随＝押下時評価。
	const narrow = () => window.matchMedia("(max-width: 480px)").matches;
	// start＝再生の共通ルーチンの入り口。opts で「どの台本(scenes)／終演(finale)／言語(lang)／Δz(mobile)／素モード(bare)」を渡す。
	// ▶（デモの入り口）は組み込み設定を、ドロップ（別の入り口）は落とした台本を渡すだけ＝ルーチンは共通・入り口だけ別。
	// bare＝素モード：バーも操作も出さない（上映中ノーアクション）・自動再生。落としたら始まり、最後まで流れて終わり。
	const start = (i = 0, fly = true, opts = {}) => {
		if ("finale" in opts) activeFinale = opts.finale;   // 終演フックの差し替え（ドロップ=null）
		if (Array.isArray(opts.scenes) && opts.scenes.length) {   // 別台本を渡された＝載せ替え＋目次再構築（▶=組み込み／ドロップ=落とした台本）
			// 表示設定は「この台本の指定 ?? マウント既定」へ毎回リセット＝前の台本の lang/hold 等を次の再生に持ち越さない。
			lang = opts.lang ?? dflt.lang; mobile = opts.mobile ?? dflt.mobile; hold = opts.hold ?? dflt.hold; slideHold = opts.slideHold ?? dflt.slideHold;
			preload = opts.preload;   // 明示先読みリストは台本の持ち物（無指定＝undefined＝視点から自動導出）
			activeOnScene = opts.onScene ?? null; activeOnEnd = opts.onEnd ?? null;   // 観測面も台本スコープ＝載せ替えでリセット（▶=組み込みは無し）
			const next = compileVias(slideOn ? opts.scenes : opts.scenes.filter(s => s.view || !s.slide));   // via 畳み込み（無ければ恒等＝識別比較を壊さない）
			// 先読みの撃ち直しは「台本が実際に入れ替わった時だけ」。▶は毎回 builtin を渡す（ドロップ台本から組み込みへ戻す口）ので、
			// 無条件に prefetched=false にすると ▶ を押すたび先読みが再発火する＝「▶の瞬間に1回だけ」の掟が壊れ、
			// 同じ区の二重読み（iPhone のクラッシュ圧の正体だった型）が戻ってくる。同一台本の再生は撃ち直さない。
			if (next.length !== scenes.length || next.some((s, k) => s !== scenes[k])) prefetched = false;
			scenes = next;
			list.innerHTML = scenes.map((s, k) => `<button data-i="${k}">${k + 1}. ${sceneLabel(s)}</button>`).join("");
		} else {   // 台本なしの再開（テスト・プログラム駆動）＝今の台本のまま個別上書きだけ
			if (opts.lang !== undefined) lang = opts.lang;
			if (opts.mobile !== undefined) mobile = opts.mobile;
		}
		if (!scenes.length) { console.warn("[demo] 台本が無い＝start しない（player 搭載は opts.scenes を渡す）"); return; }   // 空のまま start＝無害に断る
		bareLive = !!opts.bare;
		bar.classList.add("on"); mapEl.classList.add("demo-live"); show(i, fly);
		if (!bareLive && btn) { btn.setAttribute("aria-pressed", "true"); btn.dataset.tip = "デモを終了 (Esc)"; btn.setAttribute("aria-label", "デモを終了"); }   // 素モードは▶を触らない（バー/ボタンを出さない）
		if (!prefetched) { prefetched = true; prefetchViews?.(scenes.flatMap(s => s.path ? s.path.map(p => p.view) : [s.view ?? s.glide ?? s.fade]).filter(Boolean), preload); }   // ▶/ドロップとも裏で台本の街をIDBへ（1回だけ・path は通過点込み）
		if (bareLive || narrow()) play();   // 素モード＝自動再生（映画）／狭画面も自動（play は再入無害）
	};
	// 上映中（.playing）＝デスクトップでは操縦バーごと退場（CSS）＝停止は点灯した▶が受ける。字幕も止まったら引っ込める
	const pause = () => {
		playing = false; clearTimeout(timer); caption(false); bar.classList.remove("playing");
		playBtn.textContent = "▷"; playBtn.setAttribute("aria-pressed", "false");
		if (on() && btn) { btn.dataset.tip = "デモを終了 (Esc)"; btn.setAttribute("aria-label", "デモを終了"); }
	};
	const play = () => {
		if (playing) return;   // 再入（狭画面 start→play が重なる等）＝スケジューラを重ねない
		playing = true; bar.classList.add("playing");
		playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-pressed", "true");
		if (btn) { btn.dataset.tip = "上映を停止"; btn.setAttribute("aria-label", "上映を停止"); }
		schedule();
	};
	const exit = (reason = "stopped") => {   // reason："finished"=走破（next が渡す）／"stopped"=Esc・▶・exit() 直叩き（API/テスト）
		const wasOn = on();   // 実際に上映が立っていた時だけ終演イベント＝多重 exit は無音
		pause(); clearTimeout(preTimer); bar.classList.remove("on"); mapEl.classList.remove("demo-live"); curtain(false); img.removeAttribute("src"); idx = -1;
		list.classList.remove("open");
		if (btn) { btn.setAttribute("aria-pressed", "false"); btn.dataset.tip = "デモを上演"; btn.setAttribute("aria-label", "デモを上演"); }
		bareLive = false;   // 素モード解除（次の入り口が改めて設定）
		if (wasOn) activeOnEnd?.(reason);   // 観測面：どの終わり方でも1発（finale より先＝呼び出し側の手仕舞い一本化の鍵）
	};
	// ›＝view+slide 併記シーンでは三拍子：(地図)→(幕)→(地図)→次シーン。幕の無いシーンは素直に次へ。
	// 手で幕を上げ下げした分（▤/Space/クリック）は拍を消化した扱い＝shown&閉なら次で進む。
	const next = () => {
		const s = scenes[idx];
		if (hasSlide(s) && s.view) {
			if (slide.classList.contains("open")) { curtain(false); schedule(); return; }   // 第三拍＝幕を下ろしてもう一度地図
			if (!slideShown) { curtain(true); schedule(); return; }                          // 第二拍＝幕
		}
		if (idx + 1 < scenes.length) show(idx + 1); else { exit("finished"); activeFinale?.(); }   // 最終シーンの先＝終演("finished")＋「今の再生」の終演フックへ（▶=japan-fit／シーン再生=終幕括弧）。Esc等の途中終了は現在地に留まる
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
	btn?.addEventListener("click", () => { if (bareLive) return; on() ? ((playing && !narrow()) ? pause() : exit()) : start(0, true, builtin); });   // ▶＝デモの入り口＝常に組み込み設定を渡して再生（別台本が流れても▶は組み込みへ）。素モード中は不活性（上映中ノーアクション）。player搭載＝▶なし
	bar.querySelector("#demo-next").addEventListener("click", next);
	bar.querySelector("#demo-prev").addEventListener("click", prev);
	playBtn.addEventListener("click", () => playing ? pause() : play());
	const peelNext = () => {   // 幕を下ろすワンタップ送り：手動＝0.8秒の間で次のシーンへ／自動上演＝三拍目の「間」へ
		if (bareLive) return;   // 素モード＝上映中ノーアクション（幕クリック/Spaceも効かせない）
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
	// 枠外クリック（地図を掴む・他ガジェット等）＝一覧だけ閉じる。pointerdown＝地図ドラッグ開始（clickにならない）でも閉じる。
	// 一覧自身と開閉トグル（タイトル/歩数）は除外＝トグルの click と二重処理で「閉じて即開く」を防ぐ。
	window.addEventListener("pointerdown", e => {
		if (listOpen() && !e.target.closest("#demo-list, #demo-title, #demo-step")) list.classList.remove("open");
	}, { signal });
	window.addEventListener("keydown", e => {
		if (bareLive || !on() || isTypingTarget()) return;   // 素モード(ドロップ再生)は上映中ノーアクション／検索欄などの入力中は譲る（BSの文字削除・Spaceの入力を奪わない）
		if (e.key === " ") { e.preventDefault(); slide.classList.contains("open") ? peelNext() : next(); }          // Space＝次。幕中は幕クリックと同じワンタップ送り
		else if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); next(); }                   // →/PageDown＝拍どおりの次
		else if (e.key === "Backspace" || e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); prev(); }   // BS＝戻る
		else if (e.key === "Escape") { e.preventDefault(); listOpen() ? list.classList.remove("open") : exit(); }   // Esc＝一覧が開いていれば一覧だけ閉じる
	}, { signal });
	// ドロップ再生は別の入り口（playScene）から start(0, {scenes:落とした台本, bare:true}) を直接呼ぶ＝共通ルーチンを素モードで借りるだけ。
	// 旧 load() での台本上書きは廃止＝▶（組み込みの入り口）は常に builtin を渡すので壊れない（上書きも復帰もしない）。
	return { start, next, prev, exit, play, pause };
}
