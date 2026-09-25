// シーン再生プレーヤー＝共有シーン台本（type:"scenes"）の上映・停止・タイムライン（スクラブ）・開幕/終幕の黒幕・フェード遷移・
// 読み込み待ちパネル。組み込み ▶ デモ（gadgets/demo.js）と同じ再生ルーチンを「素モード」で借りる＝demoHandle は demo ガジェットの搭載時に
// app が預ける。app.js の一塊（旧 2238〜2500 行のうち ?scene= / ?g= の起点と remoteUrl を除く）を**動作を変えずに**ここへ移した（2026-09-17）。
// env … mapEl, LOW_MEM, gpuBackend, meshOn, meshMgr, flightCtl, CAM_ZOOM_MIN, themeFixed（生成前に定義済み）／
//       themeName・elevBusy（getter）／onMove・flyView・applyCamView・applyViewLayers・switchTheme・viewHash・saveView（app の関数＝ラップ）
// 戻り値 … playScenes / playScene / stopScenes / sceneTimeline / playingNow / fadeViewRun と、demoHandle（app が預ける）・fadeBusy（demo の着地待ち）のアクセサ
import { parseViewHash } from "@ortho-earth/core";
import { parseScenes } from "../demo/scene-adapter.js";     // 共有シーン台本→プレーヤー受け渡しの純関数
import { buildSceneTimeline } from "../demo/scene-timeline.js";   // 台本→総タイムライン（時刻評価・純関数）
import { tr } from "../i18n.js";
const t = tr();

export function createScenePlayer(env) {
const { mapEl, LOW_MEM, gpuBackend, meshOn, meshMgr, flightCtl, CAM_ZOOM_MIN, themeFixed, bldLabels = {} } = env;

let demoHandle = null;
let sceneBusy = false, sceneRun = 0;   // sceneBusy＝上映ライフサイクル中（準備〜走破〜終幕括弧）／sceneRun＝世代トークン：stopScenes が進めると準備中の再生は静かに降りる
const playingNow = () => sceneBusy || !!mapEl.querySelector("#demo-bar.on");   // 上映中判定＝▶デモ(バー点灯)もシーン再生も（上映中はドロップ禁止の裁定）
// ★scene-player API（プラットフォーム公開面・map.playScenes）：台本オブジェクトを直接上映する第三の入口（drop / ?scene= も同じ道）。
//   opts.from＝開始行／opts.quick=true＝軽い試写（黒幕・waitLoadingゲート・終幕括弧なし＝エディタの行プレビュー用）／
//   opts.onScene(i, scene)＝行の上映開始（フライト開始前＝行ハイライト用）／opts.onEnd(reason)＝どの終わり方でも1発（"finished"=走破・"stopped"=中断）。
//   戻り値＝受けたら true・上映中で受けなければ false（先に map.stopScenes()）。終演/中断/失敗のどの経路でも黒幕と上映ロックを残さない（手仕舞い一本化）。
function playScenes(obj, { from = 0, quick = false, onScene, onEnd, lang: langOpt } = {}) {
	if (playingNow()) { console.warn("[scene] already playing = rejected (call stopScenes() first)"); return false; }
	const lang = langOpt ?? null;   // null＝demo の T() が画面の言語 getLang()（?lang= か端末の言語・旧綴り jp: も読む）で解く（B12 と揃える・旧＝?lang= の生値＝ja-JP 等で外れた）。opts.lang＝エディタの字幕プレビュー用の上書き
	const { scenes, mobile, hold = 3, slideHold, preload, waitLoading } = parseScenes(obj);   // scene 再生の保持既定＝3秒（▶デモは5.5のまま＝発表の間合いは別物）
	if (!scenes.length) { console.warn("[scene] scenes empty = not playing", obj?.title); return false; }
	if (!demoHandle) { console.warn("[scene] demo not mounted = retry shortly (just after boot)"); return false; }   // demo は起動時に index.html が搭載済み（通常は在る）＝ ▶ と同じ実体の再生ルーチンを借りる
	sceneBusy = true;   // 解除＝終幕括弧の閉じ（returnToStart 完了）／endHook（中断・quick走破）／失敗 fallback＝どの経路でも必ず一箇所
	const run = ++sceneRun;
	const views = scenes.flatMap(s => s.via != null ? [s.via] : [s.view ?? s.glide ?? s.fade]).filter(Boolean);   // 全視点（via 通過点も込み）＝先読み対象
	const returnView = env.viewHash();   // ★上映前の画面（l=/c= 込みの共有URL）＝終幕の戻り先 兼 失敗時の fallback（括弧構造）
	// 終幕＝最終シーンの hold を終えたら、黒を挟んで上映前の画面へ帰る（映画の括弧＝始まった所で終わる）。上映ロックもここで解除。
	// 帰還 jump は黒の中で行い、350ms 置いてから溶明＝戻った画面の再構築（タイル敷き直し）を黒の下で始めさせる
	const returnToStart = async () => { await sceneCover(true, { fade: true }); env.flyView(returnView, { jump: true }); await new Promise(r => setTimeout(r, 350)); sceneCover(false); sceneBusy = false; };
	// 終演フック（demo の exit から必ず1発）：フル上映の走破は finale=returnToStart が括弧を閉じて解除＝ここは素通し。
	// それ以外（中断・quick の走破）はここで即解除＝ demoHandle.exit() 直叩きでもロックが残らない（旧バグの根治）
	const endHook = r => { if (r !== "finished" || quick) { sceneBusy = false; sceneCover(false); } onEnd?.(r); };
	if (!quick) sceneCover(true);   // ★開幕の黒幕＝jump も読み込みも隠し、開始の瞬間に fade-in（quick＝試写は儀式なし）
	Promise.resolve(demoHandle.ready).then(async () => {   // 遅延本体の到着を待ってから（起動直後の保険。通常は解決済み＝即）
		if (!quick && waitLoading && meshOn) {   // ★読み込み待ちモード＝プリロード前提：重いデータを読み切り、都市をGPUへ立て切ってから開幕。
			// scene 再生＝「綺麗な動画が撮れる」側のプロファイル（PC前提）＝タイムアウトで妥協しない（▶デモ＝「絶対失敗しない」側とは別・そちらは従来どおり）。
			const first = scenes[from] ?? scenes[0], firstView = first.view ?? first.glide ?? first.fade;   // 開始行の視点（via は parseScenes が先頭から除去済み）
			if (firstView) env.flyView(firstView, { jump: true });   // 開始画へ即 jump（黒幕の下・demo の内部先読みを起こさず、自前の進捗つき先読みへ一本化）
			// パネルは「実際に読むものがある時」だけ出す（IDB温間・全て焼き済みなら黒幕→即開幕＝何も出さない）。
			// 実読みの兆候＝(a)建物のネットワーク進捗 meshProg（renderMeshProg の tap＝網経路のみ発火・区名+枚数）
			//             (b)標高タイル読込 elevBusy（jump した開始画の地形＝先読みポンプの柵でもある）。
			let ward = { done: 0, total: 0 };
			const poke = () => sceneLoading({ ...ward, show: true });       // 兆候あり＝出す（以降は更新）
			const tick = setInterval(() => { if (meshMgr.progress.size || env.elevBusy) poke(); }, 400);   // env.elevBusy はイベントが無い＝小さく見回る
			meshMgr.setProgressTap(poke);   // 建物の枚数進捗はイベント駆動で即時反映
			// 読み切るまで待つ（タイムアウト無し）：各区は成功/失敗(meshFailed)で必ず終端＝この await も必ず終わる。待ち時間の顔はパネルが引き受ける
			const wanted = (await meshMgr.prefetch(views, preload, (d, total) => { ward = { done: d, total }; sceneLoading(ward); }).catch(() => [])) || [];
			clearInterval(tick); meshMgr.setProgressTap(null);
			// ★リビール準備＝立ち切ってから開幕：最初のフレームから本物の3D（基図の押し出し箱を見せない）。
			// PC（WebGPU×非LOW_MEM＝全保持ヒステリシスと同じゲート）＝台本の全区を停止中に GPU 常駐まで積む＝道中・後続シーンも vis 点灯だけで即立つ。
			// 「ロードは停止中に・移動中は点灯だけ」の原則は不変（今は停止中）。低級機フォールバック＝最初のリビール視点の区だけ（従来）。
			// 失敗区(meshFailed)は諦めて進む＝黒画面で永遠に待たない。
			// 低級機フォールバックの選抜（firstRevealSets＝bbox交差）はプリロード選抜（前方点ゲート）より緩い＝
			// 未プリロード区が混ざると立ち上げ段で網ロードが始まる（実測=千代田区・リビール直前の想定外ネットワーク）。
			// →プリロード済み区との積集合に絞る＝立ち上げ段は常に IDB→GPU だけ（wanted 空の縁だけ従来通り）。
			const wantedNames = new Set(wanted.map(s => s.name));
			const targets = ((gpuBackend && !LOW_MEM && wanted.length) ? wanted
				: meshMgr.firstRevealSets(views).filter(s => !wanted.length || wantedNames.has(s.name))).filter(s => !meshMgr.isDead(s.name));
			if (targets.length) {
				const gpuHint = setTimeout(() => sceneLoading({ ...ward, show: true, phase: "gpu" }), 700);   // 一瞬で立ち切る時はパネルを出さない
				await Promise.all(targets.map(s => meshMgr.standUp(s)));
				// standUpWard は「既に可視ロードが走行中」の区を false 即決で素通しする＝活性化の完了を見届ける（安全弁120秒・failed も抜け口）
				for (const t0 = performance.now(); !targets.every(s => meshMgr.isActive(s.name) || meshMgr.isDead(s.name)) && performance.now() - t0 < 120000;) await new Promise(r => setTimeout(r, 250));
				clearTimeout(gpuHint);
			}
			sceneLoading(false);
			if (run !== sceneRun) { sceneCover(false); return; }   // 準備中に stopScenes された＝静かに降りる（先読み済みは貯金）
		}
		if (run !== sceneRun) { sceneCover(false); return; }
		// ★上映：組み込み demo(▶) と同じ再生ルーチンを「素モード(バー/操作なし・上映中ノーアクション)」で呼ぶだけ＝台本を渡す。
		//   ▶ は次に組み込み設定を渡されて再生する＝demoHandle を上書きも復帰もしない（壊さない）。via の畳み込みは start 側（compileVias）。
		demoHandle.start?.(from, true, { scenes, lang, mobile, hold, slideHold, preload, finale: quick ? null : returnToStart, bare: true, onScene, onEnd: endHook });   // フル＝終演で括弧を閉じる（黒→上映前の画面へ）
		if (!quick) sceneCover(false);   // ★開始と同時に黒幕を fade-out＝最初の画面へ fade-in（約1.2秒）
	}).catch(e => {   // ★fallback＝どの失敗でも「黒幕を残さず、上映前の画面へ帰る」＝終幕と同じ着地（上映ロックも解除）
		sceneLoading(false); meshMgr.setProgressTap(null); sceneBusy = false;
		console.warn("[scene] playback prep failed = returning to pre-show view", e);
		if (!quick) { env.flyView(returnView, { jump: true }); sceneCover(false); }
	});
	return true;
}
const playScene = obj => playScenes(obj);   // 旧名の薄い別名（dropfile / ?scene= 注入用＝既定の儀式フル）
// 停止（scene-player API・map.stopScenes）：上映中でも準備中（黒幕+読み込み待ち）でも安全に降ろす＝黒幕・パネル・ロックを残さない。
// 現在地に留まる（括弧は閉じない＝終幕の帰還は走破だけの儀式）。戻り値＝止める物があったか。
function stopScenes() {
	if (!playingNow()) return false;
	sceneRun++;   // 準備中の再生を降ろす（黒幕の下で待っている then 連鎖が run 不一致で静かに終わる）
	demoHandle?.exit?.();   // 上映中なら exit→onEnd("stopped")→endHook が解除（▶デモの上映中でも安全＝ただ終演するだけ）
	sceneBusy = false; sceneLoading(false); sceneCover(false); meshMgr.setProgressTap(null);
	return true;
}
// ★タイムライン・スクラブ（scene-player API・map.sceneTimeline）：台本→時刻評価＝再生せず任意秒の絵を出す（エディタのスクラブ用）。
// 中身は純関数（demo/scene-timeline.js＝プレーヤー規則の写し × flightCtl.plan＝飛行の時刻評価プラン）。
// seek(秒)＝l=/c= はその行までの累積（l= は絶対指定＝手前の最後に書いた行が勝つ・無ければ現状維持＝プレーヤーの離陸時点火と同じ意味論・逆走も決定的）
// ＋カメラ直書き＋fade の黒(cover)。URL は書かない＝end() で1回（スクラブ終了＝確定視点の掟・saveView）。上映中は受けない（先に stopScenes）。
function sceneTimeline(obj) {
	const tl = buildSceneTimeline(obj, { plan: flightCtl.plan, parseView: parseViewHash, portrait: mapEl.clientHeight > mapEl.clientWidth, zoomMin: CAM_ZOOM_MIN });
	if (!tl) return null;
	const rowV = tl.rows.map(r => r.hash ? parseViewHash(r.hash) : null);   // 行ごとの l=/c=（累積適用の材料）
	let lastI = -1;
	const seek = sec => {
		if (playingNow()) return false;   // 上映中はスクラブ不可（先に map.stopScenes()）
		const f = tl.at(sec);
		if (f.i !== lastI) {   // 行を跨いだ＝この行までの l=/c= を累積適用
			lastI = f.i;
			for (let j = f.i; j >= 0; j--) if (rowV[j]?.layers || rowV[j]?.contour) { env.applyViewLayers(rowV[j]); break; }
			for (let j = f.i; j >= 0; j--) if (rowV[j]?.theme) { if (!themeFixed && rowV[j].theme !== env.themeName) env.switchTheme(rowV[j].theme); break; }
		}
		flightCtl.cancel();   // 手綱＝走行中の飛行があれば降ろしてから直書き
		env.applyCamView(f);      // クランプ（ZOOM/MAXPITCH/緯度）は共有URLの掟と同じ
		scrubCover(f.cover);
		env.onMove();
		return true;
	};
	return { dur: tl.dur, rows: tl.rows, at: tl.at, seek, end: () => { scrubCover(0); env.saveView(); } };
}
// スクラブ用の黒（fade 行の途中絵）＝透明度直書きの薄い幕（sceneCover は CSS transition 前提＝別物）。0 で退場。
let scrubEl = null;
function scrubCover(a) {
	if (!(a > 0)) { scrubEl?.remove(); scrubEl = null; return; }
	if (!scrubEl) {
		scrubEl = document.createElement("div");
		scrubEl.id = "scrub-cover";
		Object.assign(scrubEl.style, { position: "absolute", inset: "0", background: "#000", zIndex: "6", pointerEvents: "none" });
		mapEl.append(scrubEl);
	}
	scrubEl.style.opacity = String(Math.min(1, a));
}

// ★開幕の黒幕（fade-in）：ドロップ/?scene= の再生は必ず黒から立ち上がる＝jump・読み込み・基図タイルの立ち上がりを
// 隠し、開始と同時に約1.2秒で溶明。DOMオーバーレイ＝#underground（地中フェード）と同じ流儀。パネル(#scene-loading)は
// zIndex 7＝黒幕(6)より上。触れない（pointerEvents:none）＝掴んで中断する主導権は奪わない。
let coverEl = null, coverT = 0, coverSecs = 1.2;   // coverSecs＝直近の溶暗/溶明の尺（fade 行の travel が上書き・既定1.2秒）
function sceneCover(on, { fade = false, secs } = {}) {
	if (on) {
		clearTimeout(coverT);
		if (!coverEl) {
			coverEl = document.createElement("div");
			coverEl.id = "scene-cover";
			Object.assign(coverEl.style, { position: "absolute", inset: "0", background: "#000", opacity: "1", transition: "opacity 1.2s ease", zIndex: "6", pointerEvents: "none" });
		}
		coverSecs = (Number.isFinite(secs) && secs > 0) ? secs : 1.2;
		coverEl.style.transitionDuration = coverSecs + "s";
		mapEl.append(coverEl);   // 再ドロップでも常に最前へ（DOM順）
		if (!fade) { coverEl.style.opacity = "1"; return Promise.resolve(); }   // 即・黒（開幕前）
		// fade:true＝黒へ溶暗（終幕・fade 行）：透明から黒へ。reflow flush で transition を確実に発火（rAF 依存を断つ＝
		// 静止後の headless 実測で rAF 連鎖が遅れて溶暗が飛ぶ轍・demo.js のタイトル淡入と同じ作法）。解決＝ほぼ真っ黒になった頃
		coverEl.style.opacity = "0";
		void coverEl.offsetWidth;
		coverEl.style.opacity = "1";
		return new Promise(r => { coverT = setTimeout(r, coverSecs * 1000 + 150); });
	}
	if (coverEl) {
		requestAnimationFrame(() => { coverEl && (coverEl.style.opacity = "0"); });   // 次フレームで溶明開始（append 直後の transition 不発を避ける）
		coverT = setTimeout(() => { coverEl?.remove(); }, coverSecs * 1000 + 300);
	}
}
// フェード遷移（fade: 行・demo が注入で呼ぶ）＝黒への溶暗→jump→溶明（sceneCover 流用）。secs＝溶暗/溶明それぞれの尺（既定1.2）。
// fadeBusy＝demo の flightActive（着地待ち）に乗せる＝黒の間は hold の計時も字幕も走らない（フライトと同じ扱い）
let fadeBusy = false;
async function fadeViewRun(hash, secs) {
	fadeBusy = true;
	try {
		await sceneCover(true, { fade: true, secs });
		env.flyView(hash, { jump: true });
		await new Promise(r => setTimeout(r, 300));   // 切替後のタイル敷き直しを黒の下で始めさせる
		sceneCover(false);
	} finally { fadeBusy = false; }
}
// waitLoading の待機中に画面中央へ出す進捗パネル。**実際に読むものがある時だけ**出す（state.show が兆候の合図＝
// 温間・全焼き済みは無表示のまま黒幕→即開幕）。「何をどう読んでいるか」＝ meshProg（区名+枚数・網経路のみ）と
// elevBusy（標高タイル）をここで直接読んで一行に組む。触れない・待ち終わりに退場。
let slEl = null, slFill = null, slSub = null, slCount = null;
function sceneLoading(state) {
	if (state === false) { if (slEl) slEl.style.display = "none"; return; }
	if (!state.show && !(slEl && slEl.style.display !== "none")) return;   // 兆候(show)が来るまで出さない＝区tickだけではパネルを開かない
	if (!slEl) {
		slEl = document.createElement("div");
		slEl.id = "scene-loading";
		Object.assign(slEl.style, { position: "absolute", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(8,12,20,.45)", zIndex: "7", pointerEvents: "none" });
		const card = document.createElement("div");
		Object.assign(card.style, { minWidth: "min(320px, 78vw)", maxWidth: "82vw", padding: "28px 36px", borderRadius: "18px", background: "rgba(16,24,36,.92)", color: "#fff", textAlign: "center", fontFamily: "system-ui, sans-serif", boxShadow: "0 8px 40px rgba(0,0,0,.45)" });
		const title = document.createElement("div");
		title.textContent = t("Loading the scene…");
		Object.assign(title.style, { fontSize: "23px", fontWeight: "700", letterSpacing: ".01em", marginBottom: "6px" });
		slSub = document.createElement("div");
		Object.assign(slSub.style, { fontSize: "13px", opacity: ".7", marginBottom: "18px", minHeight: "1.4em" });
		const bar = document.createElement("div");
		Object.assign(bar.style, { height: "9px", borderRadius: "999px", background: "rgba(255,255,255,.16)", overflow: "hidden" });
		slFill = document.createElement("div");
		Object.assign(slFill.style, { height: "100%", width: "6%", borderRadius: "999px", background: "linear-gradient(90deg,#4b90ff,#7db4ff)", transition: "width .35s ease" });
		bar.append(slFill);
		slCount = document.createElement("div");
		Object.assign(slCount.style, { fontSize: "13.5px", opacity: ".88", marginTop: "12px", fontVariantNumeric: "tabular-nums" });
		card.append(title, slSub, bar, slCount);
		slEl.append(card);
	}
	mapEl.append(slEl);   // 毎回最後尾へ＝黒幕(#scene-cover)より必ず上（DOM順＋zIndex の二重保険）
	slEl.style.display = "flex";
	// 今まさに読んでいる物＝建物（区名 done/total枚・カタログ走査）＋標高。網経路のみ＝IDB命中は現れない（それが正しい）
	const parts = [...meshMgr.progress.values()].map(p =>
		p.total ? t("$1 $2/$3 tiles", p.name, p.done, p.total) : t("$1 scanning catalog $2…", p.name, p.scan ?? 0));
	if (env.elevBusy) parts.push(t("terrain tiles"));
	slSub.textContent = parts.join("・") || (bldLabels.city ? t(bldLabels.city) : t("3D city"));   // 文言＝地域の申告（出所の名）・無ければ汎用
	const { done = 0, total = 0 } = state;
	if (state.phase === "gpu") {   // 読み切った後の最終段＝IDB→GPU 常駐へ立ち切る待ち（開幕の直前）
		slFill.style.width = "100%";
		slCount.textContent = t("standing up the city…");
	} else if (total) {
		// バーは区の歩み＋読みかけ区のタイル進捗（なめらか担当・並行読みの分は全部加算＝残り区数でクランプ）
		const frac = Math.min(Math.max(0, total - done), [...meshMgr.progress.values()].reduce((a, p) => a + (p.total ? Math.min(1, p.done / p.total) : 0), 0));
		slFill.style.width = Math.max(6, Math.round(Math.min(1, (done + frac) / total) * 100)) + "%";
		slCount.textContent = t("$1 / $2 districts", done, total);
	} else {
		slFill.style.width = "6%";
		slCount.textContent = t("preparing…");
	}
}

return { playScenes, playScene, stopScenes, sceneTimeline, playingNow, fadeViewRun,
	get demoHandle() { return demoHandle; }, set demoHandle(h) { demoHandle = h; },   // demo ガジェットの搭載時に app が預ける（▶ と同じ実体）
	get fadeBusy() { return fadeBusy; } };                                             // 黒の間＝demo の flightActive（着地待ち）に乗せる
}
