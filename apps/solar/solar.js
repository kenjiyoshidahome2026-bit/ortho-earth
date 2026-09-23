// ortho-solar — 地動説の劇場：太陽系の実スケール3D。世界座標＝日心黄道J2000（単位AU）。
// 部品（2026-09-19 本人裁定「gadget 的に一つの div に対して生成して destroy できる構成」）：
//   const app = await createSolar({ target: "#app", lang, view, hash, keyboard });
//   app.addButton({ text, title, arrow, onClick })  … 左上の縦並びに持ち主のボタン（戻る・保存など）
//   app.view（取得/設定＝"f=moon&d=…" の書式）・app.on("view", fn)・app.flyTo(id)・app.destroy()
// 頁（index.html＋main.js）は殻＝URL を読んで部品を置くだけ（?back= の戻り口も殻の仕事）。サンプル集・埋め込みは同じ口で置く。
// 設計の芯（ortho-japan からの移植思想）：
//  - RTE＝絶対座標を f32 に通さない：CPU(f64)でカメラ相対化してから GPU へ（globe-local-mesh-RTE と同族）
//  - 実スケール・誇張なし：軌道も半径も本物。ただし見えなくなる惑星は「最小ピクセル径クランプ」で
//    点として残す（far-DB のランドマークと同じ思想＝誇張でなく可視性の下駄）
//  - 依存ゼロ WebGL2 直書き・恒星は bucket の stars.6（ortho-japan と同じ星表）
//  - 対数深度バッファ：惑星表面(1e-7AU)〜海王星軌道(60AU)を1パスで
// 部品の掟：DOM は受け取った div の中だけ（CSS も .ortho-solar の中に閉じる・幅の裁きはコンテナクエリ）・大域のイベントは
// AbortController で一括して外す・描画ループ/監視/タイマー/GL は destroy で必ず止める。同じ頁に同時に置くのは 1 つを目安
// （WebGL のコンテキストには上限がある）。言語は頁で 1 つ（i18n.js の既定＝最初に来た lang）。
import { createGeopbf, geopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
import { BODIES, byId, bodyPos, orientation, orbitPointsRel, moonOrbitPoints, eqToEcl, AU_KM, LIGHT_MIN_PER_AU, D2R,
	SATELLITES, satById, satPos, satOrbitPoints } from "@ortho-earth/ephem";   // packages/ephem へ昇格（japan太陽系圏と共用）
import { tr, setLang, getLang, isRTL, applyDom } from "./i18n.js";
import { createClock, fmtUTC } from "@ortho-earth/ephem/clock";   // 共通の時計（#42）＝地図（globe）と同じ部品

// bucket 基盤は頁で一度（ortho-japan と同じ・読み出しキー不要）＝部品を何度作り直しても 1 回
let geopbfReady = false;
const ensureGeopbf = () => { if (!geopbfReady) { createGeopbf("https://api.ortho-earth.com", { bucket: nativeBucket }); geopbfReady = true; } };

// 見た目は ortho-japan の計器盤の血筋＝rgba(16,24,44,.4)の板と#cdd6e6の文字。全部 .ortho-solar の中＝頁の他の物に触らない
const CSS = `
.ortho-solar { position: relative; width: 100%; height: 100%; overflow: hidden; background: #05070f; container-type: size;
	font: 13px/1.5 system-ui, "Helvetica Neue", sans-serif; color: #cdd6e6; }
.ortho-solar * { margin: 0; box-sizing: border-box; }
.ortho-solar .os-c { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.ortho-solar .os-c:active { cursor: grabbing; }
.ortho-solar .os-nogl { display: none; position: absolute; inset: 0; place-items: center; color: #cdd6e6; }
.ortho-solar .os-title { position: absolute; top: 10px; inset-inline-start: 14px; pointer-events: none; text-shadow: 0 1px 4px #000; }
/* ロゴ・題字は明示白＝継承色に頼らない（Android自動テーマ等の強制配色で黒字化させない） */
.ortho-solar .os-title h1 { font-size: 17px; font-weight: 600; letter-spacing: .04em; color: #fff; display: flex; align-items: center; gap: 7px; }
.ortho-solar .os-title h1 svg { flex: 0 0 auto; filter: drop-shadow(0 1px 2px #000); }
.ortho-solar .os-title p { font-size: 11.5px; opacity: .72; color: #cdd6e6; }
.ortho-solar .os-info { position: absolute; top: 10px; inset-inline-end: 12px; display: flex; flex-direction: column; gap: 1px; padding: 7px 11px;
	background: rgba(16,24,44,.42); border: 1px solid rgba(255,255,255,.14); border-radius: 9px;
	backdrop-filter: blur(4px); text-align: end; pointer-events: none; }
.ortho-solar .os-info b { font-size: 14px; }
.ortho-solar .os-info span { font-size: 11px; opacity: .82; }
.ortho-solar .os-labels { position: absolute; inset: 0; pointer-events: none; }
.ortho-solar .os-sky2d { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.ortho-solar button { font: 11.5px/1 system-ui, sans-serif; color: #cdd6e6; background: rgba(255,255,255,.06);
	border: 1px solid rgba(255,255,255,.14); border-radius: 7px; padding: 5px 9px; cursor: pointer; }
.ortho-solar button:hover { background: rgba(255,255,255,.14); }
.ortho-solar :focus-visible { outline: 2px solid rgba(150,180,255,.9); outline-offset: 2px; }
/* 天体ラベル＝button（Tab で辿れる）。見た目は文字だけ＝上の button 一般則（板・枠・余白）を打ち消す */
.ortho-solar .bl { position: absolute; top: 0; left: 0; font: 11px/1.5 system-ui, "Helvetica Neue", sans-serif; letter-spacing: .05em; cursor: pointer;
	background: none; border: 0; padding: 0; border-radius: 3px; white-space: nowrap;
	pointer-events: auto; text-shadow: 0 1px 3px #000, 0 0 6px rgba(0,0,0,.8); will-change: transform; }
.ortho-solar .bl.bl:hover { text-decoration: underline; background: none; }
.ortho-solar .os-bottom { position: absolute; left: 0; right: 0; bottom: calc(8px + env(safe-area-inset-bottom, 0px));
	display: flex; flex-direction: column; align-items: center; gap: 7px; pointer-events: none; }
.ortho-solar .os-chips, .ortho-solar .os-timebar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; justify-content: center;
	padding: 5px 8px; background: rgba(16,24,44,.42); border: 1px solid rgba(255,255,255,.14);
	border-radius: 10px; backdrop-filter: blur(4px); pointer-events: auto; max-width: min(96%, 780px); }
.ortho-solar .os-chips button.on, .ortho-solar .os-const-btn.on { background: rgba(120,160,255,.28); border-color: rgba(150,180,255,.55); }   /* 点灯＝選択中と同じ意匠 */
.ortho-solar .os-timebar input[type=datetime-local] { font: 12px/1 system-ui, sans-serif; color: #cdd6e6;
	background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); border-radius: 7px; padding: 4px 6px; color-scheme: dark; }
.ortho-solar .os-transport { display: flex; gap: 4px; }
.ortho-solar .os-speed { min-width: 74px; text-align: center; font-size: 11.5px; opacity: .9; }
/* 左上の縦並び：星座（常設）→ 持ち主のボタン（addButton＝戻る など）。上から詰める */
.ortho-solar .os-stack { position: absolute; top: 60px; inset-inline-start: 14px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.ortho-solar .os-stack button { display: flex; align-items: center; gap: 4px; }
/* 矢印は文字でなく向き＝RTL では左右を返す（文言側に ← を持ち込まない＝訳が矢印を抱えない） */
.ortho-solar .os-arrow { font-style: normal; display: inline-block; }
.ortho-solar[dir="rtl"] .os-arrow { transform: scaleX(-1); }
/* 距離スケール＝ortho-earth（quiet-mono #scale）と同じ物差し：1-2-5 刻み・両端ティック・太い下線。下段（チップ＋時間バー）の上・中央。
   縮尺は「焦点天体の距離で」＝遠近のある 3D なので、物差しが正しいのは画面中央の天体の奥行きだけ */
.ortho-solar .os-scale { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(var(--bottomH, 100px) + 16px + env(safe-area-inset-bottom, 0px));
	text-align: center; font: 12px system-ui, sans-serif; font-variant-numeric: tabular-nums; color: rgba(225, 232, 242, .9); pointer-events: none; }
.ortho-solar .os-scale-txt { display: block; margin-bottom: -2px; white-space: nowrap; text-shadow: 0 0 3px rgba(0, 0, 0, .85); }
.ortho-solar .os-scale-bar { margin: 0 auto; height: 12px; box-sizing: border-box;
	border-left: 1px solid currentColor; border-right: 1px solid currentColor; border-bottom: 3px solid currentColor; }
.ortho-solar .os-hint { position: absolute; inset-inline-start: 14px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); font-size: 10.5px;
	opacity: .5; pointer-events: none; }
.ortho-solar .os-attr { position: absolute; inset-inline-end: 12px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); font-size: 10px;
	opacity: .55; text-align: end; }
.ortho-solar .os-attr a { color: inherit; }
/* 狭い部品（縦画面・埋め込みの小窓）＝頁の幅でなく部品自身の幅で裁く（コンテナクエリ）。情報パネルを下段の上へ。
   下段の高さは言語で変わる（長い天体名はチップが3段に折れる）＝固定値でなく実測（--bottomH を部品が書く） */
@container (max-width: 720px) {
	.ortho-solar .os-hint, .ortho-solar .os-attr { display: none; }
	.ortho-solar .os-scale { left: auto; transform: none; inset-inline-start: 14px; text-align: start; }   /* 情報パネルが下段右の上に来る＝物差しは左へ */
	.ortho-solar .os-scale-bar { margin: 0; }
	.ortho-solar .os-info { top: auto; bottom: calc(var(--bottomH, 100px) + 8px); }
}`;
const injectCSS = () => {
	if (document.getElementById("ortho-solar-css")) return;
	const s = document.createElement("style"); s.id = "ortho-solar-css"; s.textContent = CSS; document.head.append(s);
};

// 文言は英語が原本＝この雛形の英語がそのまま辞書のキー（data-t＝本文・data-t-title＝ツールチップ）。訳は i18n/ui.json → i18n/lang/<code>.json
const MARKUP = `
	<canvas class="os-c"></canvas>
	<canvas class="os-sky2d" aria-hidden="true"></canvas><!-- 星座名・メシエ天体・月の地名（drawSky2d）＝GL の上・天体ラベルの下 -->
	<div class="os-nogl" data-t>This page needs WebGL2.</div>
	<div class="os-title">
		<!-- ロゴ＝いつもの球儀マーク（favicon と同意匠）。ただし白固定＝favicon の light 用 media query（黒化）は持ち込まない -->
		<h1><svg viewBox="0 0 100 100" width="21" height="21" aria-hidden="true"><g fill="none" stroke="#ffffff" stroke-width="6"><ellipse cx="50" cy="50" rx="45" ry="45"/><ellipse cx="50" cy="50" rx="25" ry="45"/><path d="M11 28H88 M11 72H88M50 5V95M5 50 H95"/></g></svg><span data-t>The Solar System</span></h1>
		<p data-t>Heliocentric — real scale, real time</p>
	</div>
	<div class="os-stack">
		<button class="os-const-btn" title="Show / hide constellations and Messier objects (C)" data-t-title aria-pressed="false"><span data-t>Constellations</span></button>
	</div>
	<div class="os-labels"></div>
	<div class="os-info"></div>
	<div class="os-bottom">
		<div class="os-chips"></div>
		<div class="os-timebar">
			<!-- 再生の三つ組は RTL でも鏡像にしない（dir="ltr"）＝◀◀ は常に左・▶▶ は常に右。記号の向きは言語で変わらない
			     （時間の矢の図像は万国共通）＝並びだけ返すと「右の ◀◀ が戻る」のねじれになる。Material の「再生操作はミラーしない」と同じ -->
			<span class="os-transport" dir="ltr">
				<button class="os-slower" title="Slower — keep pressing to run time backwards" data-t-title>◀◀</button>
				<!-- ⏸(U+23F8) は Apple 系で絵文字表示になり字面が浮く＝図形の ❚❚(U+275A×2) へ。clock の change と対 -->
				<button class="os-play" title="Play / pause" data-t-title>❚❚</button>
				<button class="os-faster" title="Faster" data-t-title>▶▶</button>
			</span>
			<span class="os-speed" data-t>Real time</span><!-- 初期表示＝時計の change は view に t=/s= が無いと起きない＝ここが起動時の唯一の出所 -->
			<input class="os-dt" type="datetime-local" min="1800-01-01T00:00" max="2049-12-31T23:59" step="60" title="Set date &amp; time (valid 1800–2050)" data-t-title>
			<button class="os-now" title="Back to the present" data-t-title><span data-t>Now</span></button>
		</div>
	</div>
	<div class="os-scale"><span class="os-scale-txt"></span><div class="os-scale-bar"></div></div>
	<div class="os-hint" data-t>Drag to orbit · Scroll to zoom · Click a world to visit it</div>
	<div class="os-attr"><span data-t>Textures</span>: <a href="https://www.solarsystemscope.com/textures/" target="_blank" rel="noopener">Solar System Scope</a> (CC BY 4.0) · <span data-t>Pluto</span>: NASA/JHUAPL/SwRI<br>
		<span data-t>Stars</span>: d3-celestial · <span data-t>Ephemeris</span>: <span data-t>JPL approximate elements</span> · © 2026 Kenji Yoshida</div>`;

// target＝置き場（要素か CSS セレクタ・大きさは持ち主が決める）。lang＝UI 言語（省略＝?lang= かブラウザ）。
// view＝初期視点（"f=moon&d=…" 書式・省略時 hash:true なら location.hash）。hash＝URL のハッシュと往復する（殻＝true・埋め込み＝false）。
// keyboard＝矢印/+/−/Space/C のキー操作を聞く（頁に他の主役がいる埋め込みでは false）。texBase＝テクスチャの置き場（既定＝この頁の tex/）
export async function createSolar({ target, lang, view, hash = false, keyboard = true, texBase = "tex/" } = {}) {
	const host = typeof target === "string" ? document.querySelector(target) : target;
	if (!host) throw new Error("createSolar: target not found");
	await setLang(lang);   // UI を組む前に一度だけ待つ＝訳が揃ってから文字が出る
	const t = tr(), LANG = getLang();
	injectCSS(); ensureGeopbf();
	const rootEl = document.createElement("div");
	rootEl.className = "ortho-solar"; rootEl.lang = LANG; rootEl.dir = isRTL() ? "rtl" : "ltr";   // RTL＝配置は論理プロパティに委ねる
	rootEl.innerHTML = MARKUP;
	applyDom(rootEl);   // 雛形の英語（＝キー）をその場で訳へ
	host.append(rootEl);
	const $ = n => rootEl.querySelector(".os-" + n);
	// 後片付けの台帳：大域のイベント（signal）・監視（observers）・描画ループ（raf）
	const ac = new AbortController(), signal = ac.signal, observers = [];
	const observe = (node, fn) => { const o = new ResizeObserver(fn); o.observe(node); observers.push(o); };
	let raf = 0, destroyed = false;
	const handlers = {};
	const emit = (type, v) => { for (const fn of handlers[type] || []) try { fn(v); } catch (e) { console.error(e); } };

	const canvas = $("c");
	const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
	if (!gl) { $("nogl").style.display = "grid"; throw new Error("WebGL2 unavailable"); }

	// 数は言語の流儀で（桁区切り・アラビア数字）。d 指定＝小数桁を固定（指定なし＝元の桁のまま）
	const nfmt = (n, d) => n.toLocaleString(LANG, d === undefined ? undefined : { minimumFractionDigits: d, maximumFractionDigits: d });
	const MYRIAD = new Set(["ja", "zh", "ko"]);   // 億で読む言語＝大きな距離は 1e8 刻み（他は百万 km）＝読み癖に合わせる
	// 天体名も UI 文言＝ephem の英語名がそのままキー（"Earth" は出口ボタンと同じ 1 行）。
	// この台帳は検定（verify:i18n）に「使っている」と見せるための並び＝ephem と食い違えば起動時に気づく
	const BODY_KEYS = ["Sun", "Mercury", "Venus", "Earth", "Moon", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto", "Dwarf planet",
		"Io", "Europa", "Ganymede", "Callisto", "Phobos", "Deimos", "Mimas", "Enceladus", "Tethys", "Dione", "Rhea", "Titan", "Iapetus",
		"Miranda", "Ariel", "Umbriel", "Titania", "Oberon", "Triton", "Charon"];
	// 天体の棚：BODIES＝太陽・惑星・月・冥王星（下段チップの顔ぶれ）／SATELLITES＝惑星と冥王星の主な衛星（親に寄ると現れる＝チップには並べない）。
	// ALL＝描画・ラベル・タップ・影の総なめ用。any＝id 引き。posOf＝日心位置の一本口。parentOf＝「親の点に埋まる間は描かない」の親
	const ALL = [...BODIES, ...SATELLITES];
	const any = { ...byId, ...satById };
	const posOf = (id, date) => satById[id] ? satPos(id, date) : bodyPos(id, date);
	const parentOf = b => b.parent || (b.id === "moon" ? "earth" : null);
	for (const b of ALL) if (!BODY_KEYS.includes(b.name)) console.warn("[solar] body name missing from the i18n ledger:", b.name);
	const bName = b => t(b.name);

	// ---- 時刻機械：共通の時計（@ortho-earth/core/clock・#42）＝時刻(ms)と符号つき速度段（−8〜+8：0=停止・正=順行・負=逆行）。
	// 範囲＝1800〜2049（JPL 要素の有効期間）で端に着くと止まる。◀◀は停止を通り越してそのまま逆再生へ。実時間で「今」を見ている間は時計が Date.now() に張り付く
	const clock = createClock();
	const simDate = () => clock.date;

	// ---- カメラ：焦点天体を球面座標で周回（yaw/pitch/dist）。焦点は天体と一緒に動く＝時を回すと追走 ----
	const cam = { focus: "sun", yaw: -60 * D2R, pitch: 22 * D2R, dist: 26, fovy: 45 * D2R };
	const OVERVIEW_DIST = 26;   // Sunボタン＝太陽系全景（土星軌道まで入る）
	let camPos = [0, 0, 26], viewR = null, camD = 26;   // 毎フレーム更新（f64）。camD＝カメラ〜焦点の今の距離（飛行中は補間値）
	let flight = null;   // {t0,dur, fromFocus,toFocus, fromD,toD} 焦点間フライト（800ms・log補間）
	// 次の rAF で描き直す旗。宣言はここ（上の方）＝起動時の readHash・星座・テクスチャ到着など、描画の節より上で
	// 走る口がみな触る（下で宣言していた頃は readHash から触って TDZ で落ちた 2026-09-19）
	let needsDraw = true;

	const v3 = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len: a => Math.hypot(a[0], a[1], a[2]) };
	const P = {};   // id → 日心位置（AU・f64）。frame() の頭で一度だけ引く＝カメラ・描画・影・情報パネルが同じ値を見る
	function focusPos(id, date) { return P[id] || posOf(id, date); }
	function updateCamera(date) {
		let F = focusPos(cam.focus, date), d = cam.dist;
		if (flight) {   // フライト中＝焦点位置と距離を同時補間（位置は生きた天体位置で毎フレーム評価）
			const k = Math.min(1, (performance.now() - flight.t0) / flight.dur);
			const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // easeInOutCubic
			const A = focusPos(flight.fromFocus, date);
			F = [A[0] + (F[0] - A[0]) * e, A[1] + (F[1] - A[1]) * e, A[2] + (F[2] - A[2]) * e];
			d = Math.exp(Math.log(flight.fromD) + (Math.log(flight.toD) - Math.log(flight.fromD)) * e);
			if (k >= 1) { flight = null; cam.dist = d; }
		}
		const cp = Math.cos(cam.pitch), off = [d * cp * Math.cos(cam.yaw), d * cp * Math.sin(cam.yaw), d * Math.sin(cam.pitch)];
		camPos = [F[0] + off[0], F[1] + off[1], F[2] + off[2]]; camD = d;
		// 視線基底（前=−z）。up＝黄道北。行優先3行＝right/up/back
		const f = [-off[0] / d, -off[1] / d, -off[2] / d];
		let r = [f[1], -f[0], 0]; const rl = Math.hypot(r[0], r[1]) || 1; r = [r[0] / rl, r[1] / rl, 0];
		const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
		viewR = [r, u, [-f[0], -f[1], -f[2]]];
	}
	function flyTo(id) {
		const b = any[id];
		requestTex(b);   // 着くまでの 0.9 秒で絵を取りに行く（遅延テクスチャ）
		// 近景＝半径の9倍＝天体の直径が画面高の約27%。旧5.5倍は45%＝寄りすぎで、土星は環（半径2.33R）の
		// 半角25°が視野半角22.5°を越えて上下が切れていた（9倍なら15°＝環まで余白ごと収まる）。
		// 手でのドリー下限（focusMinDist＝半径1.1倍）はそのまま＝寄りたければ地表まで寄れる
		const near = Math.max(b.radiusAU * 9, b.radiusAU + 2e-7);
		// 太陽だけ二段：初手は太陽系の全景（＝この劇場のホーム）、全景で見ている時にもう一度押すと太陽そのものの近景へ。
		// 近景でもう一度押せば全景へ戻る＝押すたび行き来する一つのボタン（チップ・ラベル・天体クリックの全入口で同じ）。
		const atOverview = cam.focus === "sun" && (flight ? flight.toD : cam.dist) > near * 4;
		const toD = id === "sun" ? (atOverview ? near : OVERVIEW_DIST) : near;
		flight = { t0: performance.now(), dur: 900, fromFocus: cam.focus, toFocus: id, fromD: flight ? flight.toD : cam.dist, toD };
		cam.focus = id; cam.dist = toD;
		if (id !== "sun") {   // 昼面側に着地（真っ黒な夜面とにらめっこしない）：太陽方向+30°の斜光＝陰影が立つ
			const p = posOf(id, simDate());
			cam.yaw = Math.atan2(-p[1], -p[0]) + 30 * D2R;
			cam.pitch = Math.max(8 * D2R, Math.min(35 * D2R, cam.pitch));
		}
		// 衛星はチップを持たない＝訪問中は親を灯す
		const chipId = satById[id] ? satById[id].parent : id;
		chipsEl.querySelectorAll("button").forEach(el => el.classList.toggle("on", el.dataset.id === chipId));
		uiDirty = true;
		writeHash();
	}

	// ---- GL 基盤 ----
	const LOG_FAR = 200;   // 対数深度の far（AU）
	const logC = 2 / Math.log2(LOG_FAR + 1);
	const LOGZ = `P.z = (log2(max(P.w + 1.0, 1e-9)) * u_logC - 1.0) * P.w;`;
	function prog(vs, fs) {
		const mk = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
			if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) + "\n" + s); return o; };
		const p = gl.createProgram();
		gl.attachShader(p, mk(gl.VERTEX_SHADER, "#version 300 es\nprecision highp float;\n" + vs));
		gl.attachShader(p, mk(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float;\n" + fs));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
		const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
		for (let i = 0; i < n; i++) { const inf = gl.getActiveUniform(p, i); u[inf.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, inf.name); }
		return { p, u };
	}
	// 球（テクスチャ+ランバート／emissive）。u_model＝向き×半径、u_trans＝カメラ相対位置
	const sphereP = prog(`
		in vec3 a_pos; in vec2 a_uv;
		uniform mat3 u_model; uniform vec3 u_trans; uniform mat4 u_view, u_proj; uniform float u_logC;
		out vec2 v_uv; out vec3 v_n;
		void main() {
			vec3 w = u_model * a_pos + u_trans;
			v_uv = a_uv; v_n = u_model * a_pos;
			vec4 P = u_proj * (u_view * vec4(w, 1.0));
			${LOGZ}
			gl_Position = P;
		}`, `
		uniform sampler2D u_tex; uniform sampler2D u_night; uniform sampler2D u_ringTex;
		uniform vec3 u_sun; uniform float u_emiss; uniform float u_cloud; uniform float u_hasNight;
		// 影：単位は全て「この天体の半径」・向きは世界（黄道）＝地表の点 p は正規化した法線そのもの。
		// u_occ[i]＝遮る球（xyz＝この天体の中心から見た中心・w＝半径）。u_sunAng＝ここから見た太陽の視半径(rad)。
		// u_umbra＝本影に残る色（月食の赤銅＝地球大気が屈折させた夕焼けの光。他は 0＝真っ暗）。
		// 環の影＝u_ringN（環の法線）と u_ringR（内縁・外縁）。u_hasRing=0 なら何もしない
		uniform vec4 u_occ[4]; uniform int u_nOcc; uniform float u_sunAng; uniform vec3 u_umbra;
		uniform float u_hasRing; uniform vec3 u_ringN; uniform vec2 u_ringR;
		in vec2 v_uv; in vec3 v_n; out vec4 o;
		void main() {
			vec4 t = texture(u_tex, v_uv);
			vec3 p = normalize(v_n);
			float dl = dot(p, u_sun);
			// 食：地表の点から見て、太陽の円盤が遮る球の円盤にどれだけ隠れるか（小角近似）。
			// 離角 sep が |ro−rs| 以下＝すっぽり（本影 or 金環）・ro+rs 以上＝掛からない・その間＝半影をなめらかに。
			// 隠せる上限は面積比 (ro/rs)²＝小さい衛星の影は真っ黒にならない（イオの影は濃く、遠いカリストは淡い）
			float shade = 0.0;
			for (int i = 0; i < 4; i++) {
				if (i >= u_nOcc) break;
				vec3 q = u_occ[i].xyz - p;
				float along = dot(q, u_sun);
				if (along <= 0.0) continue;                              // 遮る球が太陽と反対側＝影は落ちない
				float sep = length(q - along * u_sun) / along, ro = u_occ[i].w / along;
				float f = (1.0 - smoothstep(abs(ro - u_sunAng), ro + u_sunAng, sep)) * min(1.0, (ro * ro) / (u_sunAng * u_sunAng));
				shade = max(shade, f);
			}
			// 環の影：地表の点から太陽へ向かう線が環の平面を貫く所が、環の帯の中なら、環の濃さ（α）ぶん暗い
			if (u_hasRing > 0.5) {
				float dn = dot(u_sun, u_ringN);
				if (abs(dn) > 1e-4) {
					float k = -dot(p, u_ringN) / dn;
					if (k > 0.0) {
						float r = length(p + k * u_sun);
						if (r > u_ringR.x && r < u_ringR.y)
							shade = max(shade, 0.85 * textureLod(u_ringTex, vec2((r - u_ringR.x) / (u_ringR.y - u_ringR.x), 0.5), 0.0).a);
					}
				}
			}
			float direct = clamp(dl * 1.1, 0.0, 1.0) * 0.94;
			float l = mix(direct * (1.0 - shade) + 0.05, 1.0, u_emiss);
			vec3 c = t.rgb * l + t.rgb * u_umbra * (direct * shade);
			// 夜面の街明かり（地球のみ u_hasNight=1）：昼夜境界 dl=0 の外側で立ち上げて加算＝影に入った側に灯が点る。
			// 加算なのは街明かり自体が光源だから（反射光の l を掛けない）。境界の幅 0.08→-0.10 は薄明の帯の見立て
			c += texture(u_night, v_uv).rgb * (smoothstep(0.08, -0.10, dl) * u_hasNight);
			// u_cloud=1（地球の雲殻）＝白黒の雲図の輝度をそのままアルファに＝薄い雲は薄く抜ける。
			// 通常の球は u_cloud=0＝不透明（既定値0のまま＝他の天体は何も変わらない）
			float a = mix(1.0, max(max(t.r, t.g), t.b), u_cloud);
			o = vec4(c, a);
		}`);
	// 土星の環（平板アニュラス・radial UV・両面）。透明部は discard＝深度も正しく抜く
	const ringP = prog(`
		in vec2 a_pos; in float a_u;
		uniform mat3 u_model; uniform vec3 u_trans; uniform mat4 u_view, u_proj; uniform float u_logC; uniform float u_R;
		out float v_u; out vec3 v_q;
		void main() {
			vec3 w = u_model * vec3(a_pos, 0.0) + u_trans;
			v_u = a_u; v_q = (u_model * vec3(a_pos, 0.0)) / u_R;   // 環の上の点（惑星中心から・惑星半径単位・世界向き）
			vec4 P = u_proj * (u_view * vec4(w, 1.0));
			${LOGZ}
			gl_Position = P;
		}`, `
		uniform sampler2D u_tex; uniform float u_light; uniform vec3 u_sun;
		in float v_u; in vec3 v_q; out vec4 o;
		void main() {
			vec4 c = texture(u_tex, vec2(v_u, 0.5));
			if (c.a < 0.05) discard;
			// 本体の影：この点から太陽へ向かう線が惑星（半径 1 の球）に当たるか＝線と中心の最短距離 < 1 かつ 惑星が太陽側。
			// 土星の扁平（極が 10% 短い）は無視＝影の縁が緯度方向に少し甘いだけ
			float along = dot(v_q, u_sun);
			float sh = along < 0.0 ? 1.0 - smoothstep(0.97, 1.03, length(v_q - along * u_sun)) : 0.0;
			o = vec4(c.rgb * u_light * (1.0 - 0.93 * sh), c.a);
		}`);
	// 軌道線（頂点＝基準天体からの相対 AU→シェーダ内でカメラ相対化）。惑星の軌道＝基準は惑星自身、
	// 月・衛星の軌道＝基準は親天体＝u_camPos に「カメラ−基準」を f64 で引いてから渡す（RTE＝絶対座標を f32 に通さない）
	const lineP = prog(`
		in vec3 a_pos;
		uniform vec3 u_camPos; uniform mat4 u_view, u_proj; uniform float u_logC;
		void main() {
			vec4 P = u_proj * (u_view * vec4(a_pos - u_camPos, 1.0));
			${LOGZ}
			gl_Position = P;
		}`, `
		uniform vec4 u_color; out vec4 o;
		void main() { o = u_color; }`);
	// 恒星（無限遠天球＝平行移動を無視・80AUの殻に置く）
	const starP = prog(`
		in vec3 a_pos; in vec3 a_col; in float a_size; in float a_bright;
		uniform mat4 u_view, u_proj; uniform float u_logC;
		out vec3 v_col; out float v_b;
		void main() {
			vec3 v = mat3(u_view) * (a_pos * 80.0);
			v_col = a_col; v_b = a_bright;
			vec4 P = u_proj * vec4(v, 1.0);
			${LOGZ}
			gl_Position = P;
			gl_PointSize = a_size;
		}`, `
		in vec3 v_col; in float v_b; out vec4 o;
		void main() {
			float d = length(gl_PointCoord - 0.5) * 2.0;
			float a = smoothstep(1.0, 0.25, d) * v_b;
			o = vec4(v_col * a, a);
		}`);
	// 星座線（恒星と同じ無限遠の天球＝平行移動を無視・80AU の殻）。LINES の端点列
	const constP = prog(`
		in vec3 a_pos;
		uniform mat4 u_view, u_proj; uniform float u_logC;
		void main() {
			vec4 P = u_proj * vec4(mat3(u_view) * (a_pos * 80.0), 1.0);
			${LOGZ}
			gl_Position = P;
		}`, `
		uniform vec4 u_color; out vec4 o;
		void main() { o = u_color; }`);
	// 太陽グロー（ビルボード・加算）
	const glowP = prog(`
		in vec2 a_corner;
		uniform vec3 u_center; uniform float u_size; uniform mat4 u_view, u_proj; uniform float u_logC;
		out vec2 v_c;
		void main() {
			vec3 v = mat3(u_view) * u_center;
			v.xy += a_corner * u_size;
			v_c = a_corner;
			vec4 P = u_proj * vec4(v, 1.0);
			${LOGZ}
			gl_Position = P;
		}`, `
		in vec2 v_c; out vec4 o;
		void main() {
			float r = length(v_c);
			float a = exp(-r * 4.5) * 1.4;
			o = vec4(vec3(1.0, 0.87, 0.6) * a, 0.0);
		}`);

	// ---- メッシュ ----
	function buf(target, data) { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; }
	// UV球（96×48）：v=0が北極（画像の上端）・u=0が経度180°W＝正距円筒テクスチャの標準
	const sphere = (() => {
		const NX = 96, NY = 48, pos = [], uv = [], idx = [];
		for (let iy = 0; iy <= NY; iy++) {
			const lat = Math.PI / 2 - iy / NY * Math.PI, cl = Math.cos(lat);
			for (let ix = 0; ix <= NX; ix++) {
				const lon = -Math.PI + ix / NX * 2 * Math.PI;
				pos.push(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
				uv.push(ix / NX, iy / NY);
			}
		}
		for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
			const a = iy * (NX + 1) + ix, b = a + NX + 1;
			idx.push(a, b, a + 1, a + 1, b, b + 1);
		}
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		buf(gl.ARRAY_BUFFER, new Float32Array(pos)); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		buf(gl.ARRAY_BUFFER, new Float32Array(uv)); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
		buf(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx));
		return { vao, n: idx.length };
	})();
	// 環アニュラス（128分割・2三角形帯）。座標は惑星半径単位＝u_model の半径スケールで実寸へ
	function ringMesh(inner, outer) {
		const N = 128, pos = [], us = [];
		for (let i = 0; i <= N; i++) {
			const t = i / N * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
			pos.push(c * inner, s * inner, c * outer, s * outer); us.push(0, 1);
		}
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		buf(gl.ARRAY_BUFFER, new Float32Array(pos)); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		buf(gl.ARRAY_BUFFER, new Float32Array(us)); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
		return { vao, n: (N + 1) * 2 };
	}
	const glowMesh = (() => {
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		buf(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		return vao;
	})();
	// 軌道線 VBO（動的）：惑星ごとに保持。頂点＝惑星自身からの相対（RTE・惑星の傍ほど密）＝時刻が動いたら焼き直す
	// （512 点×10 惑星のケプラー解き＝0.1ms 級。止めて見回す間は焼かない）
	const orbitVbo = {};
	function lineVao(data) {
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		const b = buf(gl.ARRAY_BUFFER, data);
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		return { vao, b, n: data.length / 3 };
	}
	function ensureOrbit(id, date) {
		let o = orbitVbo[id];
		if (o && o.t === date.getTime()) return o;
		const pts = orbitPointsRel(id, date);
		if (!o) { o = lineVao(pts); orbitVbo[id] = o; }
		else { gl.bindBuffer(gl.ARRAY_BUFFER, o.b); gl.bufferData(gl.ARRAY_BUFFER, pts, gl.DYNAMIC_DRAW); }
		o.t = date.getTime();
		return o;
	}
	// 月の軌道線：形は 6 時間キャッシュ。頂点は「焼いた時刻の地球」からの相対＝描く時は今の地球に付いて動く。
	// （旧：絶対座標のまま 6 時間持っていた＝地球は 6 時間で 65 万 km 進む＝早回しで軌道の輪が地球から外れ、6 時間ごとに戻った）
	let moonOrbit = null, moonOrbitT = -1;
	function ensureMoonOrbit(date) {
		if (moonOrbit && Math.abs(date.getTime() - moonOrbitT) < 216e5) return moonOrbit;
		const pts = moonOrbitPoints(date), e = bodyPos("earth", date);
		for (let i = 0; i < pts.length; i += 3) { pts[i] -= e[0]; pts[i + 1] -= e[1]; pts[i + 2] -= e[2]; }
		if (!moonOrbit) moonOrbit = lineVao(pts);
		else { gl.bindBuffer(gl.ARRAY_BUFFER, moonOrbit.b); gl.bufferData(gl.ARRAY_BUFFER, pts, gl.STATIC_DRAW); }
		moonOrbitT = date.getTime();
		return moonOrbit;
	}
	// 衛星の軌道線（その時刻の楕円）：親からの相対。起点＝衛星の今の位置（衛星は常に折れ線の頂点）＝描くたびに焼く（192 点×衛星数＝親の傍でだけ）
	const satOrbit = {};
	function ensureSatOrbit(b, date) {
		const pts = satOrbitPoints(b.id, date, 192, true);   // 親心のまま受け取る（日心で f32 を通すと遠い親ほど線が崩れる）
		let o = satOrbit[b.id];
		if (!o) o = satOrbit[b.id] = lineVao(pts);
		else { gl.bindBuffer(gl.ARRAY_BUFFER, o.b); gl.bufferData(gl.ARRAY_BUFFER, pts, gl.DYNAMIC_DRAW); }
		return o;
	}

	// ---- テクスチャ：まず 1px の天体色。絵は「見える大きさになった時」か「訪ねると決めた時」に取りに行く ----
	// 全景では惑星はどれも 2.6px の点＝絵は 1 画素も見えていない。旧版は起動時に 14 枚 5.8MB を全部取っていた
	// （実測 2026-09-18）＝さりげなく読む（autoPlateau と同じ型）。環の α だけは起動時（12KB・クランプ中も環は描く）。
	// 衛星は絵を持たない＝天体色の球のまま（tex なし）
	function makeTex(color) {
		const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
			new Uint8Array([color[0] * 255, color[1] * 255, color[2] * 255, 255]));
		return t;
	}
	function loadInto(tex, src, clampS) {
		const img = new Image();
		img.onload = () => {
			if (gl.isContextLost()) return;
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
			if (clampS) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			needsDraw = true;
		};
		img.src = texBase + src;
	}
	const textures = {}, texAsked = new Set();
	const TEX_PX = 3;   // 見かけの半径がこの px を超えたら絵を取りに行く（クランプの点 2.6px より上＝点の間は取らない）
	function requestTex(b) {
		if (!b.tex || texAsked.has(b.id)) return;
		texAsked.add(b.id);
		loadInto(textures[b.id], b.tex);
		// 地球の追加2枚（雲殻・夜の街明かり）。届くまで殻は描かず・街明かりは消灯＝読み込み途中でも嘘にならない
		for (const [key, slot] of [["clouds", "cloudTex"], ["night", "nightTex"]]) {
			if (!b[key]) continue;
			const tex = gl.createTexture(), img = new Image();
			img.onload = () => {
				if (gl.isContextLost()) return;
				gl.bindTexture(gl.TEXTURE_2D, tex);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
				gl.generateMipmap(gl.TEXTURE_2D);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
				b[slot] = tex; needsDraw = true;
			};
			img.src = texBase + b[key];
		}
	}
	for (const b of ALL) {
		textures[b.id] = makeTex(b.color);
		if (b.ring) {
			b.ringTex = makeTex([0.8, 0.75, 0.65]);
			b.ringMesh = ringMesh(b.ring.inner, b.ring.outer);
			loadInto(b.ringTex, b.ring.tex, true);
		}
	}
	const blackTex = makeTex([0, 0, 0]);   // ユニット1（街明かり）・ユニット2（環の影）の既定＝持たない天体でも未バインドを踏まない

	// ---- 恒星：bucket の stars.6（RA/Dec・等級・B-V）→黄道系単位ベクトル＋色＋点径（ortho-japan と同式） ----
	let starVao = null, starN = 0;
	const bvColor = v => v < -0.3 ? [0.70, 0.78, 1] : v < 0.0 ? [0.85, 0.89, 1] : v < 0.3 ? [0.97, 0.98, 1] : v < 0.6 ? [1, 0.97, 0.94] :
		v < 0.8 ? [1, 0.95, 0.78] : v < 1.1 ? [1, 0.88, 0.71] : v < 1.4 ? [1, 0.80, 0.60] : [1, 0.67, 0.57];
	(async () => {
		try {
			const pbf = await geopbf("stars.6", { gint: false });
			const fs = pbf?.geojson?.features; if (!fs || destroyed) return;
			const dpr = Math.min(2, devicePixelRatio || 1);
			const data = new Float32Array(fs.length * 8);
			for (let i = 0; i < fs.length; i++) {
				const { mag, bv } = fs[i].properties, [ra, dec] = fs[i].geometry.coordinates;
				const p = eqToEcl(ra, dec), c = bvColor(bv);
				data.set([p[0], p[1], p[2], c[0], c[1], c[2],
					Math.max(1.5, (9 - mag) * 0.4 * dpr), Math.max(0, 1 - mag / 8)], i * 8);
			}
			const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
			buf(gl.ARRAY_BUFFER, data);
			const S = 32;
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
			gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 12);
			gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, S, 24);
			gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S, 28);
			starVao = vao; starN = fs.length; needsDraw = true;
			console.log(`[stars] ${starN} stars loaded`);
		} catch (e) { console.warn("[stars] load failed (sky stays dark):", e); }
	})();

	// ---- 星座：japan と同じ bucket の constellation_lines（d3-celestial・RA/Dec の折れ線）＋ messier。初めて点けた時に一度だけ読む ----
	// 線＝薄い青（japan の太陽系圏と同じ）・星座名とメシエ天体＝2D の重ね絵（#sky2d）に同じ天球の向きを投影（japan の labels2d と同じ色と記号）。
	// 名前＝bucket GIS/space/i18n/<lang>.json（正本は packages/space・uploader が焼く）を fetch＝コードでなくデータで繋ぐ（japan も同じ JSON を読める）。
	// 状態は URL の c=1（writeHash）・ボタンと c キーで切替
	let constOn = false, constVao = null, constN = 0, constLoad = null, skyLab = null;
	// その言語の 1 本＋英語（欠けは英語で補う＝星座は IAU 名・メシエは英語の通称。英語も取れなければ略号/番号のまま＝壊れない）。
	// 読み口は native-bucket の get＝uploader の put は .json を gzip で置く（Content-Type も application/gzip）＝素の fetch では読めない
	// （world の i18n は別経路で素の JSON＝apps/equal は fetch で読めている・2026-09-19 実測）。lazy＝到達確認の一覧 1 本を省く
	async function loadSkyNames(lang) {
		const space = nativeBucket("https://api.ortho-earth.com").Bucket("GIS/space", { lazy: true, silent: true });
		const get = l => space.then(b => b?.get(`i18n/${l}.json`, "json")).catch(() => null);
		const [p, en] = await Promise.all([lang === "en" ? null : get(lang), get("en")]);
		const E = en || { c: {}, m: {} }, L = p || E;
		if (!en) console.warn("[space] names not reachable (bucket GIS/space/i18n) — showing IAU abbreviations");
		return {
			lang: p ? lang : "en",
			constellation: a => L.c[a] || E.c[a] || String(a ?? ""),
			messierLabel: id => { const n = L.m[id] || E.m[id]; return n ? `${id} ${n}` : String(id); },
		};
	}
	// メシエの種別（d3-celestial）→記号。銀河は s/e/i（渦巻・楕円・不規則）で来る
	const messierKind = t => t === "gc" ? "globular" : t === "oc" ? "open" : t === "s" || t === "e" || t === "i" ? "galaxy" : "nebula";
	const constBtn = $("const-btn");
	function ensureConst() {
		constLoad ||= Promise.all([
			geopbf("constellation_lines", { gint: false }),
			geopbf("messier", { gint: false }).catch(() => null),   // 任意（無ければ線と星座名だけ）
			loadSkyNames(LANG),
		]).then(([pbf, ms, n]) => {
			if (destroyed) return;
			const seg = [], names = [], messier = [];
			for (const f of pbf?.geojson?.features || []) {
				const lines = f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates];
				let vx = 0, vy = 0, vz = 0;
				for (const line of lines) for (let i = 0; i < line.length; i++) {
					const v = eqToEcl(line[i][0], line[i][1]); vx += v[0]; vy += v[1]; vz += v[2];
					if (i < line.length - 1) seg.push(...v, ...eqToEcl(line[i + 1][0], line[i + 1][1]));
				}
				// 名前の置き場＝全頂点の天球ベクトル平均（RA の 0/360 跨ぎに無縁＝japan と同じ）
				const l = Math.hypot(vx, vy, vz) || 1;
				names.push({ v: [vx / l, vy / l, vz / l], text: n.constellation(f.properties?.name) });
			}
			for (const f of ms?.geojson?.features || []) {
				const c = f.geometry.coordinates;
				messier.push({ v: eqToEcl(c[0], c[1]), text: n.messierLabel(f.properties?.name || ""), kind: messierKind(f.properties?.type) });
			}
			constVao = lineVao(new Float32Array(seg)).vao; constN = seg.length / 3;
			skyLab = { names, messier }; needsDraw = true;
			console.log(`[constellation] ${constN / 2} segments, ${names.length} names, ${messier.length} Messier objects (${n.lang})`);
		}).catch(e => { console.warn("[constellation] load failed", e); constLoad = null; });
		return constLoad;
	}
	// 星座名とメシエ天体の 2D 注記：天球の向き v（黄道 J2000 単位ベクトル）を回転だけで投影（平行移動なし＝無限遠）。
	// 毎描画で消して描き直す（消灯時も消すだけ走る）＝88 文字列＋110 記号・1ms 未満
	const sky2d = $("sky2d"), sctx = sky2d.getContext("2d");
	// ---- 月の地名：bucket の geopbf "moon_nomenclature"（IAU 採択の主な地名 2,023・英語・由来つき＝正本 packages/space/moon.json）＋
	// 多言語 bucket GIS/space/i18n/moon/<lang>.json（{ GPN id: 名前 }・欠けは英語＝IAU 名）。月が画面で大きくなった時に初めて読む（さりげなく読む）。
	// 座標は月面の経緯度（IAU・東経正）＝体固定の単位ベクトル（x＝本初子午線・z＝北極＝球メッシュと同じ約束）→ orientation("moon") で世界へ
	let moonNames = null, moonNamesLoad = null;
	const MOON_SEAS = new Set(["ME", "OC", "LC", "SI", "PA"]);   // 海・大洋・湖・入江・沼＝月見の地図の主役（常に優先）
	const MOON_SITES = new Set(["ST", "PL"]);                     // 着陸地点（Statio＝アポロ 11 号の静かの基地・嫦娥・チャンドラヤーン）・着陸平原（ルナ 9 号）
	const MOON_LINES = new Set(["RI", "DO", "VA", "CA", "RU"]);    // 谷・尾根・谷・クレーター列・断崖＝細長い（diameter は長さ）＝閾値を高めに
	// 宇宙飛行士の命名（LF＝アポロ着陸地点まわりの数 km の小地形）は大きさで判定＝着陸地点へ深く寄った時だけ出る
	function ensureMoonNames() {
		moonNamesLoad ||= Promise.all([
			geopbf("moon_nomenclature", { gint: false }),
			nativeBucket("https://api.ortho-earth.com").Bucket("GIS/space", { lazy: true, silent: true })
				.then(b => LANG === "en" ? null : b?.get(`i18n/moon/${LANG}.json`, "json")).catch(() => null),
		]).then(([pbf, pack]) => {
			const L = pack?.names || {};
			const list = (pbf?.geojson?.features || []).map(f => {
				const p = f.properties, [lon, lat] = f.geometry.coordinates, cl = Math.cos(lat * D2R);
				const rank = MOON_SEAS.has(p.code) ? 0 : MOON_SITES.has(p.code) ? 1 : 2;
				return { v: [cl * Math.cos(lon * D2R), cl * Math.sin(lon * D2R), Math.sin(lat * D2R)], text: L[p.id] || p.name, code: p.code, d: p.diameter, rank };
			});
			list.sort((a, b) => a.rank - b.rank || b.d - a.d);   // 描く順＝優先順（重なったら後ろが譲る）
			moonNames = list; needsDraw = true;
			console.log(`[moon] ${list.length} features (${Object.keys(L).length} ${LANG} names)`);
		}).catch(e => { console.warn("[moon] names load failed", e); moonNames = []; });   // 失敗＝この回は地名なし（毎フレームの取り直しで回線を叩かない）
	}
	const MOON_R_KM = 1737.4;
	function drawMoonNames(dpr, screens, w, h) {
		const b = byId.moon, s = screens.moon;
		if (!s || b.hidden || b.clamped) return;
		const rPx = b.radiusAU / s.dist * pxPerRad / dpr;   // 月の見かけの半径（CSS px）
		if (rPx < 60) return;
		if (!moonNames) { ensureMoonNames(); return; }
		const M = orientation("moon", simDate()), c = P.moon, R = b.radiusAU;
		const placed = [];
		sctx.textAlign = "center"; sctx.textBaseline = "middle"; sctx.direction = isRTL() ? "rtl" : "ltr";
		for (const f of moonNames) {
			// 画面上の大きさで間引く：海など＝画面で 16px 以上・着陸地点＝月が 140px から・細長い地形＝70px 以上・他＝36px 以上
			const dPx = f.d / (2 * MOON_R_KM) * 2 * rPx;
			if (f.rank === 0 ? dPx < 16 : f.rank === 1 ? rPx < 140 : dPx < (MOON_LINES.has(f.code) ? 70 : 36)) continue;
			const n = [M[0][0] * f.v[0] + M[0][1] * f.v[1] + M[0][2] * f.v[2], M[1][0] * f.v[0] + M[1][1] * f.v[1] + M[1][2] * f.v[2], M[2][0] * f.v[0] + M[2][1] * f.v[1] + M[2][2] * f.v[2]];
			const pw = [c[0] + n[0] * R, c[1] + n[1] * R, c[2] + n[2] * R], toCam = v3.sub(camPos, pw), tl = v3.len(toCam);
			const facing = (n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2]) / tl;
			if (facing < 0.2) continue;                                   // 裏側と縁すれすれは描かない（縁は字が潰れる）
			const q = project(pw); if (!q || q.x < 0 || q.x > w || q.y < 0 || q.y > h) continue;
			sctx.font = f.rank === 0 ? "italic 12px system-ui, sans-serif" : "10.5px system-ui, sans-serif";
			const tw = sctx.measureText(f.text).width, box = [q.x - tw / 2 - 3, q.y - 8, q.x + tw / 2 + 3, q.y + 8];
			if (placed.some(o => box[0] < o[2] && o[0] < box[2] && box[1] < o[3] && o[1] < box[3])) continue;   // 重なり＝優先の低い方が譲る
			placed.push(box);
			const a = Math.min(1, (facing - 0.2) / 0.25);                 // 縁へ向かって薄く
			sctx.fillStyle = f.rank === 0 ? `rgba(235, 240, 250, ${0.85 * a})` : f.rank === 1 ? `rgba(255, 214, 140, ${0.9 * a})` : `rgba(215, 222, 235, ${0.75 * a})`;
			sctx.shadowColor = "rgba(0, 0, 0, .85)"; sctx.shadowBlur = 3;
			if (f.rank === 1) { sctx.beginPath(); sctx.arc(q.x, q.y, 2, 0, Math.PI * 2); sctx.fill(); sctx.fillText(f.text, q.x, q.y - 10); }   // 着陸地点＝点＋名前
			else sctx.fillText(f.text, q.x, q.y);
			sctx.shadowBlur = 0;
		}
	}
	// screens＝天体の画面位置（frame の値）。天体の円盤の内側に落ちる注記は描かない＝線と星が天体の後ろに隠れるのと揃える
	function drawSky2d(dpr, screens) {
		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (sky2d.width !== Math.round(w * dpr) || sky2d.height !== Math.round(h * dpr)) { sky2d.width = Math.round(w * dpr); sky2d.height = Math.round(h * dpr); }
		sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, w, h);
		drawMoonNames(dpr, screens, w, h);   // 月の地名（月に寄った時だけ・星座の点灯とは独立）
		if (!constOn || !skyLab) return;
		const k = pxPerRad / dpr, [R, U, B] = viewR;
		const discs = [];
		for (const b of ALL) {
			const sb = screens[b.id]; if (!sb || b.hidden) continue;
			const r = b.radiusAU / sb.dist * k * (b.ring && !b.clamped ? b.ring.outer : 1);   // 土星は環の外縁まで
			if (r > 3) discs.push([sb.x, sb.y, r + 4]);
		}
		const put = v => {
			const z = B[0] * v[0] + B[1] * v[1] + B[2] * v[2];
			if (z > -0.05) return null;   // 背後と視野の縁すれすれは描かない
			const x = w / 2 + (R[0] * v[0] + R[1] * v[1] + R[2] * v[2]) / -z * k, y = h / 2 - (U[0] * v[0] + U[1] * v[1] + U[2] * v[2]) / -z * k;
			if (x < -80 || x > w + 80 || y < -20 || y > h + 20) return null;
			for (const [dx, dy, r] of discs) if (Math.hypot(x - dx, y - dy) < r) return null;
			return [x, y];
		};
		sctx.textAlign = "center"; sctx.direction = isRTL() ? "rtl" : "ltr";
		sctx.font = "11px system-ui, sans-serif"; sctx.fillStyle = "rgba(160, 200, 255, .55)";
		for (const L of skyLab.names) { const p = put(L.v); if (p) sctx.fillText(L.text, p[0], p[1]); }
		const sz = 4.5, P2 = Math.PI * 2;
		sctx.lineWidth = 0.8; sctx.strokeStyle = "rgba(255, 200, 100, .6)"; sctx.fillStyle = "rgba(255, 220, 150, .55)"; sctx.font = "9px system-ui, sans-serif";
		for (const M of skyLab.messier) {
			const p = put(M.v); if (!p) continue;
			const [x, y] = p;
			sctx.beginPath();
			if (M.kind === "globular") { sctx.arc(x, y, sz, 0, P2); sctx.moveTo(x - sz, y); sctx.lineTo(x + sz, y); sctx.moveTo(x, y - sz); sctx.lineTo(x, y + sz); sctx.stroke(); }
			else if (M.kind === "galaxy") { sctx.ellipse(x, y, sz * 1.5, sz * 0.6, 0.4, 0, P2); sctx.stroke(); }
			else if (M.kind === "open") { sctx.setLineDash([2, 2]); sctx.arc(x, y, sz, 0, P2); sctx.stroke(); sctx.setLineDash([]); }
			else { sctx.rect(x - sz, y - sz, sz * 2, sz * 2); sctx.stroke(); }
			sctx.fillText(M.text, x, y + sz + 10);
		}
	}
	function setConst(on) {
		constOn = on;
		constBtn.classList.toggle("on", on); constBtn.setAttribute("aria-pressed", String(on));
		if (on) ensureConst();
		needsDraw = true;
	}
	constBtn.onclick = () => { setConst(!constOn); writeHash(); };

	// ---- 行列 ----
	let proj = null, pxPerRad = 1;
	function resize() {
		const dpr = Math.min(2, devicePixelRatio || 1);
		const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
		const f = 1 / Math.tan(cam.fovy / 2), aspect = w / h;
		proj = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1.0000002, -1, 0, 0, -2e-7, 0]);   // near/far は対数深度が上書き
		pxPerRad = (h / 2) / Math.tan(cam.fovy / 2);
		needsDraw = true;
	}
	observe(canvas, resize);
	// 行列は使い回す（旧：毎フレーム天体の数だけ new Float32Array＝60fps で GC の種）
	const VIEW = new Float32Array(16), M3 = new Float32Array(9);
	const viewMat4 = () => {
		VIEW.set([viewR[0][0], viewR[1][0], viewR[2][0], 0, viewR[0][1], viewR[1][1], viewR[2][1], 0, viewR[0][2], viewR[1][2], viewR[2][2], 0, 0, 0, 0, 1]);
		return VIEW;
	};
	const model3 = (M, k) => { M3.set([M[0][0] * k, M[1][0] * k, M[2][0] * k, M[0][1] * k, M[1][1] * k, M[2][1] * k, M[0][2] * k, M[1][2] * k, M[2][2] * k]); return M3; };
	// 世界→スクリーン（px）。視野外/背後は null
	function project(pw) {
		const r = v3.sub(pw, camPos);
		const x = viewR[0][0] * r[0] + viewR[0][1] * r[1] + viewR[0][2] * r[2];
		const y = viewR[1][0] * r[0] + viewR[1][1] * r[1] + viewR[1][2] * r[2];
		const z = viewR[2][0] * r[0] + viewR[2][1] * r[1] + viewR[2][2] * r[2];
		if (z > -1e-9) return null;
		return { x: canvas.clientWidth / 2 + x / -z * pxPerRad / (Math.min(2, devicePixelRatio || 1)),
			y: canvas.clientHeight / 2 - y / -z * pxPerRad / (Math.min(2, devicePixelRatio || 1)), dist: -z };
	}

	// ---- UI：下段チップ（Sun=全景ホーム／もう一度押すと太陽の近景）・時間バー・ラベル・情報パネル ----
	const chipsEl = $("chips");
	for (const b of BODIES) {
		const el = document.createElement("button");
		el.textContent = bName(b); el.dataset.id = b.id;
		el.title = b.id === "sun" ? t("Solar system view (press again for a close-up)") : t("Visit $1", bName(b));
		if (b.id === "sun") el.classList.add("on");
		el.onclick = () => flyTo(b.id);
		chipsEl.appendChild(el);
	}
	const labels = {};
	const labelsEl = $("labels");
	for (const b of ALL) {
		const el = document.createElement("button");   // button＝Tab で辿れて Enter で訪ねられる（旧 div は指とマウス専用だった）
		el.className = "bl"; el.textContent = bName(b); el.title = t("Visit $1", bName(b));
		el.style.color = `rgb(${b.color.map(c => Math.round(160 + c * 95)).join(",")})`;
		el.onclick = () => flyTo(b.id);
		labelsEl.appendChild(el); labels[b.id] = el;
		el._w = el.offsetWidth;   // 団子よけの幅＝実測（旧 64px 決め打ち＝"ดาวพฤหัสบดี" や "Sao Thiên Vương" で重なりを見落とした）
	}
	const dtEl = $("dt"), speedEl = $("speed");
	const fmtLocal = t => {   // datetime-local 用（ローカル時刻・分まで）
		const d = new Date(t), p = n => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
	};
	let dtEditing = false;
	dtEl.addEventListener("focus", () => dtEditing = true);
	dtEl.addEventListener("blur", () => dtEditing = false);
	dtEl.addEventListener("change", () => { const t = new Date(dtEl.value).getTime(); if (Number.isFinite(t)) clock.setTime(t); });
	// 時計の状態が変わった（段・時刻・範囲の端で停止・URL の読み込み）＝表示と URL を追わせる
	clock.on("change", () => {
		speedEl.textContent = clock.label(t);
		$("play").textContent = clock.playing ? "❚❚" : "▶";   // ⏸ は Apple 系で絵文字化して浮く＝図形の ❚❚（index.html と対）
		needsDraw = true; uiDirty = true; writeHash();
	});
	$("slower").onclick = () => clock.slower();
	$("faster").onclick = () => clock.faster();
	$("play").onclick = () => clock.toggle();
	$("now").onclick = () => clock.live();
	const infoEl = $("info");
	// 下段（チップ＋時間バー）の実測高を CSS へ渡す＝縦画面で情報パネルがその上に載る。
	// 高さは言語で変わる（"Меркурий" のような長い名前はチップが 1 段増える）＝固定値にしない
	const bottomEl = $("bottom");
	const syncBottomH = () => rootEl.style.setProperty("--bottomH", bottomEl.offsetHeight + "px");
	observe(bottomEl, syncBottomH);
	syncBottomH();
	let infoShown = "";
	function updateInfo(date) {
		const b = any[cam.focus];
		let html;
		if (b.id === "sun") {
			html = `<b>${bName(b)}</b>` + [t("Radius $1 km", nfmt(695700)), t("Spectral type G2V"), t("Rotation ≈ 25 days (equator)")]
				.map(r => `<span>${r}</span>`).join("");
		} else {
			const p = P[b.id] || posOf(b.id, date), rSun = v3.len(p);
			const e = P.earth || bodyPos("earth", date), rE = v3.len(v3.sub(p, e));
			const lm = rE * LIGHT_MIN_PER_AU;
			// 数と単位はキーの中で繋ぐ（"Radius " + n + " km" の足し算は言語で語順が壊れる＝語順の掟）。
			// 距離の副表記だけ刻みを言語で替える：百万km／億km（億で読む言語＝MYRIAD）＝それぞれの読み癖に合わせる
			const light = lm < 1.5 ? t("$1 s", nfmt(lm * 60, 0)) : t("$1 min", nfmt(lm, 1));
			const rot = b.rotHours < 48 ? t("$1 h", nfmt(b.rotHours, 1)) : t("$1 days", nfmt(b.rotHours / 24, 1));
			const orb = b.periodDays < 1000 ? t("$1 days", nfmt(b.periodDays, b.periodDays < 30 ? 2 : 1)) : t("$1 years", nfmt(b.periodDays / 365.25, 1));
			const far = MYRIAD.has(LANG) ? t("$1 hundred million km", nfmt(rSun * AU_KM / 1e8, 2))
				: t("$1 million km", nfmt(Math.round(rSun * AU_KM / 1e6)));
			html = `<b>${bName(b)}</b>` + [
				b.note ? t(b.note) : "",
				b.parent ? t("Moon of $1", bName(any[b.parent])) : "",
				t("Radius $1 km", nfmt(b.radiusKm)),
				b.parent ? t("From $1: $2 km", bName(any[b.parent]), nfmt(Math.round(b.aKm))) : "",
				t("From Sun $1 AU ($2)", nfmt(rSun, 3), far),
				b.id !== "earth" ? t("From Earth $1 AU · light $2", nfmt(rE, 3), light) : "",
				b.rot.Wd < 0 ? t("Rotation $1 (retrograde)", rot) : t("Rotation $1", rot),
				b.periodDays ? t("Orbit $1", orb) : "",
			].filter(Boolean).map(r => `<span>${r}</span>`).join("");
		}
		if (html !== infoShown) infoEl.innerHTML = infoShown = html;   // 旧：毎フレーム innerHTML（実測 60 回/秒）
	}
	// 距離スケール（ortho-earth の #scale と同じ 1-2-5 の物差し）。縮尺＝焦点天体の奥行きでの 1px の長さ。
	// 単位は km→AU（0.05AU＝750 万 km で切替）・横に光の到達時間（光年の考え方を太陽系の尺度で＝情報パネルの「光で◯分」と同じ読み）。
	// 1 光年（63,241AU）はカメラの上限 120AU の遥か先＝光年の目盛りは出さない（2026-09-19 本人裁定）
	const scaleTxt = $("scale-txt"), scaleBar = $("scale-bar");
	let scaleShown = "";
	const nice125 = x => { const r = Math.pow(10, Math.floor(Math.log10(x))), m = x / r; return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * r; };
	const sig2 = v => v.toLocaleString(LANG, { maximumSignificantDigits: 2 });   // 有効 2 桁（旧＝小数 3 桁で丸めて 100km が「光で 0 秒」だった）
	function lightTime(au) {
		const s = au * LIGHT_MIN_PER_AU * 60;
		return s < 90 ? t("$1 s", sig2(s)) : s < 5400 ? t("$1 min", sig2(s / 60)) : s < 172800 ? t("$1 h", sig2(s / 3600)) : t("$1 days", sig2(s / 86400));
	}
	function updateScale() {
		const dpr = Math.min(2, devicePixelRatio || 1), auPx = camD * dpr / pxPerRad;   // 焦点の奥行きで CSS 1px が何 AU か
		const base = auPx * (canvas.clientWidth < 720 ? 110 : 160);                      // 物差しの最長（px）。1-2-5 で丸めて 40%〜100%
		let au = nice125(base), dist;
		if (au < 0.05) { const km = nice125(base * AU_KM); au = km / AU_KM; dist = t("$1 km", nfmt(km)); }
		else dist = t("$1 AU", nfmt(au));
		const txt = t("$1 · light $2", dist, lightTime(au)), w = (au / auPx).toFixed(1);
		if (txt + w === scaleShown) return;   // 変わった時だけ DOM に触る
		scaleShown = txt + w;
		scaleTxt.textContent = txt; scaleBar.style.width = w + "px";
	}
	// 時刻欄と情報パネル＝描画とは別の拍（最大 4 回/秒・中身が変わった時だけ DOM に触る）
	let lastUi = 0, uiDirty = true, dtShown = "";
	function uiTick(now, date) {
		if (!uiDirty && now - lastUi < 250) return;
		lastUi = now; uiDirty = false;
		if (clock.playing && now - hashAt > 1000) { hashAt = now; writeHash(); }   // 先に刻む＝250ms 拍の度に debounce を巻き戻さない   // 再生中も URL の t を追わせる＝いつコピーしても今の場面
		const v = fmtLocal(clock.time);
		if (!dtEditing && v !== dtShown) dtEl.value = dtShown = v;
		updateInfo(date);
	}

	// ---- URL ⇄ 状態（applyView 一本の流儀：読み＝起動時＋貼り替え（hashchange）・書き＝操作後debounce＋再生中は 1 秒ごと） ----
	// t＝UTC（末尾 Z）。旧版はタイムゾーン無しのローカル時刻＝別の時間帯で開くと場面がずれた（東京→オランダで 7〜8 時間）。
	// Z の無い旧リンクは従来どおりローカル時刻として読む（new Date の規則）。
	// 実時間で「今」を見ている時は t を書かない＝後で開いても「今」から始まる生きたリンク（日時を固定したい時は止めて共有）
	let hashTimer = null, hashWritten = "", hashAt = 0;
	// 視点の文字列（URL のハッシュと同じ書式＝"f=moon&d=…&t=…"）。hash:true（殻）は location.hash と往復・埋め込みは view と "view" イベント
	const viewString = () => {
		const p = new URLSearchParams({ f: cam.focus, d: cam.dist.toPrecision(4),
			yaw: (cam.yaw / D2R).toFixed(1), pit: (cam.pitch / D2R).toFixed(1), s: String(clock.step) });
		if (!clock.isLive()) p.set("t", fmtUTC(clock.time));
		if (constOn) p.set("c", "1");
		return p.toString().replace(/%3A/g, ":");   // フラグメントの ':' は素のままで合法＝人が読める日時に
	};
	function writeHash() {
		clearTimeout(hashTimer);
		hashTimer = setTimeout(() => {
			const v = viewString(); hashAt = performance.now();
			if (hash) { hashWritten = "#" + v; history.replaceState(null, "", hashWritten); }
			emit("view", v);
		}, 300);
	}
	function readHash(str = hash ? location.hash : "") {
		const p = new URLSearchParams(String(str).replace(/^#/, ""));
		if (p.get("t") || (p.get("s") ?? "") !== "") clock.fromParams(p);   // t＝UTC・s＝段（t 無し＋s=1＝生きたリンク＝開いた瞬間の「今」）。どちらも無い貼り替えは時刻に触らない
		if (p.get("f") && any[p.get("f")]) cam.focus = p.get("f");
		// 下限＝焦点天体の半径の 1.1 倍（手のドリーの下限 focusMinDist より手前＝URL の手書きで天体の中に入らない。
		// focusMinDist は下で宣言＝ここから呼ぶと TDZ）
		if (p.get("d")) cam.dist = Math.max(any[cam.focus].radiusAU * 1.1, Math.min(120, +p.get("d") || OVERVIEW_DIST));
		if (p.get("yaw")) cam.yaw = +p.get("yaw") * D2R;
		if (p.get("pit")) cam.pitch = Math.max(-88, Math.min(88, +p.get("pit"))) * D2R;
		const chipId = satById[cam.focus] ? satById[cam.focus].parent : cam.focus;
		chipsEl.querySelectorAll("button").forEach(el => el.classList.toggle("on", el.dataset.id === chipId));
		setConst(p.get("c") === "1");
		flight = null; uiDirty = true; needsDraw = true;
	}
	readHash(view ?? (hash ? location.hash : ""));
	// 同じタブで URL を貼り替えた時（replaceState は hashchange を起こさない＝自分の書き込みでは走らない）
	if (hash) window.addEventListener("hashchange", () => { if (location.hash !== hashWritten) readHash(); }, { signal });

	// ---- 入力：1本指/マウス=周回・ホイール=対数ドリー・2本指=ピンチ（重心で周回＋間隔でドリー）・タップ=天体訪問 ----
	// 指は Map で1本ずつ独立に追う（ortho-japan の input.js と同じ裁き）。旧実装は pointermove が届くたびに
	// 「別の指の座標」を lastX/lastY と引き算していた＝2本指で触れた瞬間に指の間隔ぶん yaw が跳ね、
	// タブレットではピンチのたびに視点がぐるぐる回った。pinchD ガードも touchmove 到着まで効かず素通りしていた。
	// 3本以上は関知しない＝iPadOS のシステムジェスチャに譲る。
	const ORBIT_RATE = 0.005;      // rad/CSSpx（周回の手触り＝ortho-japan 太陽系圏と共通）
	const pts = new Map();         // pointerId → {x,y}（触れている指/ボタン）
	let pinch = null;              // 2本指状態 {d,cx,cy}（前フレーム）
	let tap = null;                // 単指タップ候補（2本目が触れた/6px以上動いた時点で捨てる）
	// 手でのドリー下限＝天体が画面の95%を占めるところで止める（旧: 半径1.1倍＝地表すれすれまで寄れて
	// 2k テクスチャの粗が出た）。視野は縦(fovy)基準なので、縦画面では横幅が先に尽きる＝min(1,W/H)を掛ける。
	// tanθ=t の見かけ半角に対し d = R·√(1+t²)/t（球の接線から）。焦点天体ごと・画面比ごとに毎回引き直す
	const focusMinDist = () => {
		const t = 0.95 * Math.tan(cam.fovy / 2) * Math.min(1, canvas.clientWidth / canvas.clientHeight);
		return any[cam.focus].radiusAU * Math.sqrt(1 + t * t) / t + 1e-8;
	};
	const setDist = d => { cam.dist = Math.max(focusMinDist(), Math.min(120, d)); if (flight) flight.toD = cam.dist; needsDraw = true; };
	const orbitBy = (dx, dy) => {
		cam.yaw -= dx * ORBIT_RATE;
		cam.pitch = Math.max(-88 * D2R, Math.min(88 * D2R, cam.pitch + dy * ORBIT_RATE));
		needsDraw = true;
	};
	const pinchNow = () => {
		const [a, b] = [...pts.values()];
		return { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
	};
	canvas.addEventListener("pointerdown", e => {
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成イベントはcapture不可＝無視 */ }
		tap = pts.size === 1 ? { x: e.clientX, y: e.clientY } : null;
		pinch = pts.size === 2 ? pinchNow() : null;
	});
	canvas.addEventListener("pointermove", e => {
		const p = pts.get(e.pointerId);
		if (!p) return;
		const px = p.x, py = p.y;
		p.x = e.clientX; p.y = e.clientY;
		if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap = null;
		if (pts.size === 1) { orbitBy(e.clientX - px, e.clientY - py); writeHash(); return; }
		if (pts.size === 2 && pinch) {
			const n = pinchNow();
			orbitBy(n.cx - pinch.cx, n.cy - pinch.cy);   // 重心の移動＝周回（1本指と同じ所作）
			setDist(cam.dist * pinch.d / n.d);           // 間隔＝ドリー（ひらく＝寄る）
			pinch = n;
			writeHash();
		}
	});
	const liftPointer = e => {
		pts.delete(e.pointerId);
		pinch = pts.size === 2 ? pinchNow() : null;   // 3本→2本＝残った2本で仕切り直し／1本以下＝解除
		if (pts.size) { tap = null; return; }         // まだ指が残っている＝タップではない
		if (tap) {   // タップ／クリック＝一番近い天体ヒットで訪問
			let best = null, bestD = 18;
			for (const b of ALL) {
				if (b.hidden) continue;                                  // 親の点に埋まっている月・衛星は当てない
				const s = project(P[b.id] || posOf(b.id, simDate())); if (!s) continue;
				const rPx = b.radiusAU / s.dist * pxPerRad / (Math.min(2, devicePixelRatio || 1));
				const d = Math.hypot(s.x - tap.x, s.y - tap.y) - Math.max(0, rPx);
				if (d < bestD) { bestD = d; best = b.id; }
			}
			tap = null;
			if (best && (best !== cam.focus || best === "sun")) flyTo(best);   // 太陽だけは注視中でも受ける＝全景⇄近景の行き来
		}
		writeHash();
	};
	canvas.addEventListener("pointerup", liftPointer);
	canvas.addEventListener("pointercancel", liftPointer);   // OSにジェスチャを取られた時に指が残り続けるのを防ぐ
	canvas.addEventListener("wheel", e => {
		e.preventDefault();
		setDist(cam.dist * Math.exp(e.deltaY * 0.0012));
		writeHash();
	}, { passive: false });

	// ---- キーボード：矢印＝周回・+/−＝寄る/引く・Space＝再生/停止・, .＝遅く/速く・Home＝太陽系の全景 ----
	// 入力欄（日時）に居る時は奪わない。ボタンにフォーカスがある時の Space/Enter はそのボタンのもの
	// 埋め込み：頁のどこかの入力に居る時・部品の外の要素に居る時は奪わない（keyboard:false で全く聞かない）
	if (keyboard) window.addEventListener("keydown", e => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const ae = document.activeElement;
		if (ae && ae !== document.body && !rootEl.contains(ae)) return;
		const tag = ae?.tagName;
		if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
		const step = e.shiftKey ? 80 : 24;
		const act = {
			ArrowLeft: () => orbitBy(step, 0), ArrowRight: () => orbitBy(-step, 0), ArrowUp: () => orbitBy(0, step), ArrowDown: () => orbitBy(0, -step),
			"+": () => setDist(cam.dist * 0.85), "=": () => setDist(cam.dist * 0.85), "-": () => setDist(cam.dist / 0.85),
			c: () => setConst(!constOn),
			",": () => clock.slower(), ".": () => clock.faster(), Home: () => flyTo("sun"),
			" ": tag === "BUTTON" ? null : () => clock.toggle(),
		}[e.key];
		if (!act) return;
		e.preventDefault(); act(); writeHash();
	}, { signal });

	// ---- GL コンテキスト消失：iOS でタブを裏へ回して戻ると起きる。握りつぶさずに受け、戻ったら読み直す ----
	// 視点・時刻・速度は URL（writeHash）に居る＝読み直しで同じ場面へ帰る。資源を全部作り直す道より短く確実（埋め込みは作り直しを持ち主へ）
	let glLost = false;
	canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); glLost = true; });
	canvas.addEventListener("webglcontextrestored", () => { if (hash) location.reload(); else emit("contextlost"); });   // 殻＝読み直し（視点は URL に居る）・埋め込み＝持ち主に知らせる

	// ---- 描画 ----
	let lastFrame = performance.now();
	const MIN_PX = 2.6;   // 最小ピクセル半径クランプ（実スケールのまま可視性の下駄）
	// 衛星が現れる距離（カメラ〜親）＝親ごとに「一番外の衛星の軌道半径の 9.5 倍」＝衛星系が画面に収まり始める頃
	// （木星 0.12AU＝カリスト 0.0126AU の 9.5 倍・土星はイアペトゥスで 0.23AU・火星はダイモスで 0.0015AU）
	const SAT_NEAR = {};
	for (const b of SATELLITES) SAT_NEAR[b.parent] = Math.max(SAT_NEAR[b.parent] || 0, 9.5 * b.aKm / AU_KM);
	const satNear = b => v3.len(v3.sub(P[b.parent], camPos)) < SAT_NEAR[b.parent];
	gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
	gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	function setCommon(P_, view) {
		gl.uniformMatrix4fv(P_.u.u_view, false, view); gl.uniformMatrix4fv(P_.u.u_proj, false, proj);
		gl.uniform1f(P_.u.u_logC, logC);
	}
	// 影を落とし合う組：[受ける側] → 遮る側（親⇄その衛星）。月食の本影だけ赤銅色が残る（地球の大気が曲げた夕焼けの光）
	const OCCLUDERS = { earth: ["moon"], moon: ["earth"] };
	for (const b of SATELLITES) { (OCCLUDERS[b.parent] ||= []).push(b.id); OCCLUDERS[b.id] = [b.parent]; }
	const MAX_OCC = 4;   // シェーダの u_occ[4]。土星（7）・天王星（5）は「太陽の側にいて、太陽の方向に一番近い」順に 4 つ＝影を落とし得るもの
	const UMBRA = { moon: [0.30, 0.09, 0.04] };
	const OCC = new Float32Array(16);

	// 「時が進んだだけ」の時に描くかどうか：最後に描いた絵から、画面の上で何かが MOVE_PX 以上動いたか。
	// 旧版は速度が 0 でない限り毎フレーム全部描いていた（実時間の放置で 60 回/秒・実測 2026-09-18）。実時間では
	// 惑星は 1 秒に 1px も動かない＝見た目は何も変わらないまま電池だけ減っていた。動きの出所は二つ：
	//   天体の画面上の移動（公転・カメラが焦点天体を追う分も含む）／自転による表面の流れ（角度差×見かけの半径）
	// 入力・飛行・絵の到着は needsDraw が別に立てる＝この判定を通らない。
	const MOVE_PX = 0.3;
	const drawn = {};   // id → { x, y, t }＝最後に描いた時の画面位置（見えていなければ x=null）と時刻
	function movedSinceDraw() {
		const dpr = Math.min(2, devicePixelRatio || 1), half = Math.hypot(canvas.clientWidth, canvas.clientHeight) / 2;
		for (const b of ALL) {
			const k = drawn[b.id], s = project(P[b.id]);
			if (!k) return true;
			if (!s !== (k.x === null)) return true;                    // 視野への出入り
			if (!s) continue;
			if (Math.hypot(s.x - k.x, s.y - k.y) >= MOVE_PX) return true;
			const rPx = Math.min(half, b.radiusAU / s.dist * pxPerRad / dpr);
			if (rPx > 1 && Math.abs(b.rot.Wd * D2R * (clock.time - k.t) / 864e5) * rPx >= MOVE_PX) return true;
		}
		return false;
	}

	function frame(now) {
		if (destroyed) return;
		raf = requestAnimationFrame(frame);
		const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
		if (glLost) return;
		const sp = clock.speed;
		clock.tick(dt);   // 範囲の端では時計が止まり change が表示を追わせる
		if (!sp && !needsDraw && !flight) return;                      // 停止中で何も起きていない＝位置すら引かない
		if (!proj) return;
		const date = simDate();
		for (const b of ALL) P[b.id] = posOf(b.id, date);              // 位置はここで一度だけ（f64）
		updateCamera(date);
		updateScale();
		uiTick(now, date);
		if (!needsDraw && !flight && !movedSinceDraw()) return;
		needsDraw = false;
		const view = viewMat4();
		gl.clearColor(0.012, 0.016, 0.038, 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		// 1) 恒星（深度書かず・無限遠）
		if (starVao) {
			gl.depthMask(false);
			gl.useProgram(starP.p); setCommon(starP, view);
			gl.bindVertexArray(starVao); gl.drawArrays(gl.POINTS, 0, starN);
			gl.depthMask(true);
		}
		// 1b) 星座線（同じ天球・深度書かず）。色＝japan の太陽系圏と同じ青（v1 の rgba(120,160,255)）を薄く
		if (constOn && constVao) {
			gl.depthMask(false);
			gl.useProgram(constP.p); setCommon(constP, view);
			gl.uniform4f(constP.u.u_color, 0.47, 0.63, 1.0, 0.14);   // 0.22→0.14（本人 2026-09-19「少し薄く」＝星と惑星が主役）
			gl.bindVertexArray(constVao); gl.drawArrays(gl.LINES, 0, constN);
			gl.depthMask(true);
		}

		// 2) 天体球（+土星の環）。位置はCPUでカメラ相対化（RTE）・遠い天体は最小px径に半径を持ち上げ
		const dpr = Math.min(2, devicePixelRatio || 1);
		const screens = {};
		for (const b of ALL) { screens[b.id] = project(P[b.id]); drawn[b.id] = { x: screens[b.id] ? screens[b.id].x : null, y: screens[b.id] ? screens[b.id].y : 0, t: clock.time }; }
		gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
		gl.useProgram(sphereP.p); setCommon(sphereP, view);
		// ユニット0＝地表テクスチャ（天体ごとに差し替え）、ユニット1＝夜の街明かり（地球の1枚）、ユニット2＝環の α（環の影用・土星の時だけ差し替え）
		gl.uniform1i(sphereP.u.u_tex, 0); gl.uniform1i(sphereP.u.u_night, 1); gl.uniform1i(sphereP.u.u_ringTex, 2);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, byId.earth.nightTex || blackTex);
		gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, blackTex);
		gl.activeTexture(gl.TEXTURE0);
		for (const b of ALL) {
			const p = P[b.id];
			const rel = v3.sub(p, camPos), dist = v3.len(rel);
			const minR = (b.id === "sun" ? 4 : MIN_PX) * dist / pxPerRad * dpr;
			const drawR = Math.max(b.radiusAU, minR);
			b.clamped = drawR > b.radiusAU * 1.001;
			// 月・衛星：クランプ表示で親の点に埋まる間（画面上8px未満）は描かない＝二重点のちらつき回避。
			// 衛星はさらに、カメラが親の傍（SAT_NEAR）に来るまで出さない＝全景は惑星だけ（引き算）
			const par = parentOf(b);
			b.hidden = false;
			if (par) {
				const sp_ = screens[par], sb = screens[b.id];
				if (b.parent && !satNear(b)) b.hidden = true;
				else if (b.clamped && sp_ && sb && Math.hypot(sp_.x - sb.x, sp_.y - sb.y) < 8) b.hidden = true;
			}
			if (b.hidden) continue;
			// 見える大きさになった＝絵を取りに行く。太陽は 8px から＝地球の距離で 5px あるが、グローに埋もれて絵は見えない（822KB を無駄に取らない）
			if (b.radiusAU / dist * pxPerRad / dpr > (b.emissive ? 8 : TEX_PX)) requestTex(b);
			const M = orientation(b.id, date);
			gl.uniformMatrix3fv(sphereP.u.u_model, false, model3(M, drawR));
			gl.uniform3f(sphereP.u.u_trans, rel[0], rel[1], rel[2]);
			const pl = v3.len(p);
			const sd = b.id === "sun" ? [0, 0, 1] : [-p[0] / pl, -p[1] / pl, -p[2] / pl];
			gl.uniform3f(sphereP.u.u_sun, sd[0], sd[1], sd[2]);
			gl.uniform1f(sphereP.u.u_emiss, b.emissive ? 1 : 0);
			gl.uniform1f(sphereP.u.u_hasNight, b.nightTex ? 1 : 0);   // 街明かりを持つのは地球だけ
			// 影（食・環）：実寸で描いている時だけ（クランプ中の点は寸法が嘘＝影を載せない）。単位＝この天体の半径
			let occ = !b.clamped && !b.emissive && OCCLUDERS[b.id] || [];
			if (occ.length > MAX_OCC) occ = occ.map(oid => {   // 遮る側の向きと太陽方向のなす角（太陽の反対側＝影にならない＝外す）
				const q = v3.sub(P[oid], p), ql = v3.len(q);
				return [oid, (q[0] * sd[0] + q[1] * sd[1] + q[2] * sd[2]) / ql];
			}).filter(o => o[1] > 0).sort((a, b_) => b_[1] - a[1]).slice(0, MAX_OCC).map(o => o[0]);
			let nOcc = 0;
			for (const oid of occ) {
				const q = P[oid];
				OCC.set([(q[0] - p[0]) / b.radiusAU, (q[1] - p[1]) / b.radiusAU, (q[2] - p[2]) / b.radiusAU, any[oid].radiusAU / b.radiusAU], nOcc * 4);
				nOcc++;
			}
			gl.uniform1i(sphereP.u.u_nOcc, nOcc);
			if (nOcc) {
				gl.uniform4fv(sphereP.u.u_occ, OCC);
				gl.uniform1f(sphereP.u.u_sunAng, byId.sun.radiusAU / pl);
				const um = UMBRA[b.id] || [0, 0, 0]; gl.uniform3f(sphereP.u.u_umbra, um[0], um[1], um[2]);
			}
			const ringShadow = b.ring && !b.clamped;
			gl.uniform1f(sphereP.u.u_hasRing, ringShadow ? 1 : 0);
			if (ringShadow) {
				gl.uniform3f(sphereP.u.u_ringN, M[0][2], M[1][2], M[2][2]);
				gl.uniform2f(sphereP.u.u_ringR, b.ring.inner, b.ring.outer);
				gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, b.ringTex); gl.activeTexture(gl.TEXTURE0);
			}
			gl.bindTexture(gl.TEXTURE_2D, textures[b.id]);
			gl.bindVertexArray(sphere.vao); gl.drawElements(gl.TRIANGLES, sphere.n, gl.UNSIGNED_SHORT, 0);
			// 雲殻（地球のみ）＝地表の直後に、深度テストを切って重ねる。
			// 深度で競わせない理由：対数深度は far=200AU に合わせて刻まれており、地球に寄った時(w≈2.5e-4 AU)の
			// 1目盛(1.19e-7 NDC)に対し、殻の浮き 0.25%(16km) が生む差は 4e-8＝1/3目盛しかない＝z-fightingで
			// ちらつく。殻を3%(190km)浮かせれば勝てるが、それは見た目が嘘になる。背面カリング済み＝見えている
			// 殻の面は必ず地表より手前だと幾何学的に確定しているので、順序だけで正しい（深度も書かない）。
			// 月が地球の手前に来る場合も BODIES 順で月が後＝月が雲の上に正しく描かれる。月影は殻にも同じ式で落ちる
			if (b.cloudTex && !b.clamped) {
				gl.uniformMatrix3fv(sphereP.u.u_model, false, model3(M, drawR * 1.0025));   // ≒16km上（実際の雲の高さ。見た目のためだけの浮きではない）
				gl.uniform1f(sphereP.u.u_hasNight, 0);   // 街明かりは地表の一枚だけ＝殻には乗せない（雲は明かりを遮る側）
				gl.uniform1f(sphereP.u.u_cloud, 1);
				gl.bindTexture(gl.TEXTURE_2D, b.cloudTex);
				gl.disable(gl.DEPTH_TEST);
				gl.drawElements(gl.TRIANGLES, sphere.n, gl.UNSIGNED_SHORT, 0);
				gl.enable(gl.DEPTH_TEST);
				gl.uniform1f(sphereP.u.u_cloud, 0);
			}
			b._rel = rel; b._drawR = drawR; b._sun = sd; b._M = M;
		}
		// 環は球の後（半透明・両面）。クランプ中も環ごと拡大＝土星の見た目を保つ
		gl.disable(gl.CULL_FACE);
		for (const b of BODIES) {
			if (!b.ring || b.hidden) continue;
			gl.useProgram(ringP.p); setCommon(ringP, view);
			const M = b._M, s = b._drawR;
			gl.uniformMatrix3fv(ringP.u.u_model, false, model3(M, s));
			gl.uniform1f(ringP.u.u_R, s);
			gl.uniform3f(ringP.u.u_trans, b._rel[0], b._rel[1], b._rel[2]);
			gl.uniform3f(ringP.u.u_sun, b._sun[0], b._sun[1], b._sun[2]);
			const n = [M[0][2], M[1][2], M[2][2]];
			gl.uniform1f(ringP.u.u_light, 0.35 + 0.65 * Math.abs(n[0] * b._sun[0] + n[1] * b._sun[1] + n[2] * b._sun[2]));
			gl.uniform1i(ringP.u.u_tex, 0); gl.bindTexture(gl.TEXTURE_2D, b.ringTex);
			gl.bindVertexArray(b.ringMesh.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, b.ringMesh.n);
		}

		// 3) 軌道線（深度テストのみ＝手前の球に隠れる）。惑星に寄ったら空を横切る他軌道は退場
		//    （飛行中の重い層抑制と同じ引き算＝主役の惑星と星空だけ残す）。焦点天体の半径比で判定
		const lineFade = Math.min(1, Math.max(0, (cam.dist / any[cam.focus].radiusAU - 12) / 48));
		if (lineFade > 0.01) {
			gl.depthMask(false);
			gl.useProgram(lineP.p); setCommon(lineP, view);
			// 頂点は基準天体からの相対＝「カメラ − 基準」を f64 で引いて渡す（惑星の軌道＝惑星自身・月と衛星の軌道＝親）
			const relLine = (o, parentId, col, a) => {
				const c = P[parentId];
				gl.uniform3f(lineP.u.u_camPos, camPos[0] - c[0], camPos[1] - c[1], camPos[2] - c[2]);
				gl.uniform4f(lineP.u.u_color, col[0], col[1], col[2], a * lineFade);
				gl.bindVertexArray(o.vao); gl.drawArrays(gl.LINE_LOOP, 0, o.n);
			};
			for (const b of BODIES) if (b.id !== "sun" && b.id !== "moon") relLine(ensureOrbit(b.id, date), b.id, b.color, 0.32);
			// 月・衛星の軌道＝親に寄った時だけ（全景ではただの汚れ）
			if (v3.len(v3.sub(P.earth, camPos)) < 0.25) relLine(ensureMoonOrbit(date), "earth", [0.78, 0.78, 0.78], 0.3);
			for (const b of SATELLITES) if (satNear(b)) relLine(ensureSatOrbit(b, date), b.parent, b.color, 0.3);
			gl.depthMask(true);
		}

		// 4) 太陽グロー（加算・最前）
		const sunS = screens.sun;
		if (sunS) {
			gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE);
			gl.useProgram(glowP.p); setCommon(glowP, view);
			const rel = v3.sub([0, 0, 0], camPos), dist = v3.len(rel);
			const size = Math.max(byId.sun.radiusAU * 3.2, 26 * dist / pxPerRad * dpr);
			gl.uniform3f(glowP.u.u_center, rel[0], rel[1], rel[2]); gl.uniform1f(glowP.u.u_size, size);
			gl.bindVertexArray(glowMesh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			gl.depthMask(true); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		}

		// 4b) 星座名・メシエ天体（2D の重ね絵）
		drawSky2d(dpr, screens);

		// 5) HTML ラベル（クリック＝訪問）。寄っている天体（画面の1/4超）は引っ込める。
		//    全景の中心では内惑星のラベルが団子になる＝縦に押し下げて整列（BODIES順＝太陽から優先）。幅は実測（el._w）
		const placed = [];
		for (const b of ALL) {
			const el = labels[b.id], s = screens[b.id];
			if (!s || b.hidden || s.x < -40 || s.x > canvas.clientWidth + 40 || s.y < 0 || s.y > canvas.clientHeight) { if (el._on !== false) { el.style.display = "none"; el._on = false; } continue; }
			const rPx = b.radiusAU / s.dist * pxPerRad / dpr;
			// 手前の天体の円盤の内側に落ちる名前＝その天体の向こう側＝隠す（月に寄った時、背後の土星・海王星の名前が月面に出ていた）
			const behind = ALL.some(o => o !== b && !o.hidden && screens[o.id] && screens[o.id].dist < s.dist &&
				Math.hypot(screens[o.id].x - s.x, screens[o.id].y - s.y) < o.radiusAU / screens[o.id].dist * pxPerRad / dpr);
			if (behind || rPx > canvas.clientHeight * 0.22) { if (el._on !== false) { el.style.display = "none"; el._on = false; } continue; }
			const w = el._w || 64, off = Math.max(6, rPx * 0.8) + 4;
			let x = s.x + off, y = s.y - 9;
			if (x + w > canvas.clientWidth - 4 && s.x - off - w > 4) x = s.x - off - w;   // 右端で切れるなら天体の左へ回す（縦画面の衛星名）
			for (let guard = 0; guard < 12 && placed.some(q => x < q.x + q.w + 6 && q.x < x + w + 6 && Math.abs(q.y - y) < 13); guard++) y += 13;
			placed.push({ x, y, w });
			if (el._on !== true) { el.style.display = "block"; el._on = true; if (!el._w) el._w = el.offsetWidth; }
			el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
		}
	}
	resize();
	raf = requestAnimationFrame(frame);

	// ---- 持ち主へ渡す口 ----
	return {
		el: rootEl,
		// 左上の縦並び（星座ボタンの下）に持ち主のボタンを足す＝戻る・保存など。arrow＝先頭に ←（RTL で向きを返す）
		addButton({ text = "", title = "", arrow = false, onClick } = {}) {
			const b = document.createElement("button");
			if (arrow) { const i = document.createElement("i"); i.className = "os-arrow"; i.setAttribute("aria-hidden", "true"); i.textContent = "←"; b.append(i); }
			b.append(text); if (title) { b.title = title; b.setAttribute("aria-label", title); }
			if (onClick) b.addEventListener("click", onClick);
			$("stack").append(b);
			return b;
		},
		get view() { return viewString(); },
		set view(v) { readHash(v); },
		flyTo,
		on(type, fn) { (handlers[type] ||= new Set()).add(fn); return () => handlers[type].delete(fn); },
		// 跡形なく消す：描画ループ・監視・大域のイベント・タイマーを止め、GL を手放し、DOM を外す（作り直しは createSolar をもう一度）
		destroy() {
			if (destroyed) return;
			destroyed = true;
			cancelAnimationFrame(raf); clearTimeout(hashTimer);
			ac.abort();
			for (const o of observers) o.disconnect();
			gl.getExtension("WEBGL_lose_context")?.loseContext();
			rootEl.remove();
			emit("destroy");
		},
	};
}
