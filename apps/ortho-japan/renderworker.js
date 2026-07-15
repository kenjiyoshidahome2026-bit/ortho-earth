// render worker：WebGL2 の地図 と Canvas2D のラベルを OffscreenCanvas で回す。
// worker-driven：自前 rAF で「最新の cam から mvp 生成 → 地図→ラベルを同じ frame で描画」。
// main は cam を投げるだけ（往復待ちを排し、溜まった draw は最新一枚に畳む＝低レイテンシ）。
// 描画フレームは軽い処理のみ（mvp生成+draw）。重い生成は main/他worker が停止後に行い set で渡す。
import { createRenderer, createLabelLayer, createTerrain } from "ortho-core";
import { shieldFor } from "./shields.js";   // 地図記号＝日本の語彙。この静的importがある限り renderworker は app の合成点

let renderer = null, labelLayer = null, canvas = null, labelCanvas = null;
let cam = null, opts = null, dirty = false;   // 最新の描画状態。dirty の時だけ rAF で描く。
let glRef = null, sentFrame1 = false, sentCtxLost = false;   // 起動ウォッチドッグ(frame1)とコンテキストロスト監視（main へ各1回だけ通知）
let gintSyncPort = null;   // gint worker への直結：1枚描く度に「この cam で描け」＝海岸線を地図フレームに従属させる。
let terrain = null, pendingLabels = null;   // pendingLabels: cam 未着で標高付与を保留した最新ラベル集合

onmessage = e => {
	const m = e.data;
	switch (m.type) {
		case "init":
			canvas = m.canvas;                                   // GL 用 OffscreenCanvas
			// GL 初期化失敗（WebGL2不可・GPUブロックリスト等）は黙って死なず main へ通知＝案内を出させる。
			try { renderer = createRenderer(canvas); }
			catch (err) { postMessage({ type: "glfail", error: String(err && err.message || err) }); return; }
			glRef = canvas.getContext("webgl2");                 // 同一コンテキストが返る＝isContextLost() の監視用
			labelCanvas = m.labelCanvas;                         // ラベル用 OffscreenCanvas（2D）
			labelLayer = createLabelLayer(labelCanvas, { shieldFor, elevBase: m.elevBase });
			// 標高アトラス：fetch(altpbf自前worker)・視野→セル範囲計算・ダウンサンプルまで全部ここで完結させ、
			// main には触れさせない（postMessage/main側CPUを丸ごと排除）。DOM(読込インジケータ)だけ main へ通知。
			terrain = createTerrain({
				renderer, requestDraw: () => { dirty = true; },
				exag: m.terrainExag, earthM: m.earthM, apiUrl: m.apiUrl,
				onPending: (count, range) => postMessage({ type: "elevPending", count, range }),
			});
			// 全球R90（8枚・計55MB・初回のみ＝以後IDB常備）を起動の山が過ぎた頃に先読み＝
			// 低ズームの地球ぐるぐるで陰影が最初から途切れない（z1-4を塗る前提の仕込み）。
			setTimeout(() => { for (const lng of [-180, -90, 0, 90]) for (const lat of [-90, 0]) terrain.prefetch(lng, lat, 90); }, 6000);
			if (m.scenePort) m.scenePort.onmessage = ev => {     // scene worker から直結：main を経由しない geometry
				sceneInbox.set(ev.data.slot, ev.data.scene);     // 貯めるだけ＝適用は drainUploads（1件/フレーム・slotごと最新だけ＝ズーム中の中間版は上げずに捨てる）
				dirty = true;
			};
			if (m.gintSyncPort) gintSyncPort = m.gintSyncPort;   // 海岸線(gint)従属の出口
			requestAnimationFrame(frame);                        // worker 自前の描画ループ開始
			break;
		case "plateauPort":                                      // plateau worker → ここ のメッシュ直結パイプ（workerプール1本につき1ポート）
			m.port.onmessage = ev => { plateauInbox.push(ev.data); dirty = true; };   // 受信は貯めるだけ＝GPU転送は frame() が1件/フレームで平準化（下の drainUploads）
			break;
		case "resize":                                           // 両キャンバスを同じ寸法に（main は transfer 後触れない）
			baseW = m.width; baseH = m.height;
			applyRes();                                          // GL 側は動的解像度スケールを掛けて適用
			if (labelCanvas) { labelCanvas.width = m.width; labelCanvas.height = m.height; }   // ラベル(文字)は常にフル解像度
			dirty = true;
			break;
		case "set":
			if (m.cmd === "labels") { pendingLabels = m.data; applyLabels(); }   // ラベル集合の更新（標高は cam が揃ってから付与）
			else if (m.cmd === "skyLabels") { if (labelLayer) labelLayer.setSky(m.data); }   // 星空劇場の注記（星座名・メシエ）＝ラベルcanvasへ
			else if (m.cmd === "skyMoon") { if (labelLayer) labelLayer.setMoon(m.data); }    // 月の満ち欠け円盤＝ラベルcanvasへ（常設）
			else if (m.cmd === "plateauMesh") plateauInbox.push({ meshData: m.data, name: m.prop });   // 解放(null)も同じ列へ＝キュー内の未転送バッチを追い越さない（先に解放が効くと後から亡霊バッチが立つ）
			else if (m.cmd === "plateauVis") plateauInbox.push({ vis: !!m.data, name: m.prop });      // 表示切替も同じ列＝未転送バッチ/解放との順序を保つ（適用は軽い＝フレーム予算を消費しない）
			else if (m.cmd === "scene") sceneInbox.set(m.prop, m.data);          // mainからのシーンクリア（退場の layers:[]）も同じ受け口＝キュー内の古いシーンに追い越されない
			else if (renderer) renderer.set(m.cmd, m.data, m.prop);              // view/overlay/elev…
			dirty = true;                                        // 内容が変わった→描き直す
			break;
		case "draw":                                             // main からは cam を記録するだけ（実描画は rAF）
			cam = m.cam; opts = m.opts; dirty = true;
			if (pendingLabels) applyLabels();                    // cam が届いた時点で保留中のラベルへ標高を付与
			break;
		case "snapshot": snapshot(m.id); break;   // shot（画面保存）：今のカメラで1枚描いて ImageBitmap で返す
		case "destroy":
			if (renderer && renderer.dispose) renderer.dispose();
			renderer = null;
			break;
	}
};

// shot 用：WebGL は preserveDrawingBuffer 無し＝別タスクでは読めない。同一タスクで「描画直後に createImageBitmap」
// （呼び出し時点のバッファを捕獲）。基図(GL)とラベル(2D)の両キャンバスを返し、合成は main が担う。
function snapshot(id) {
	try {
		if (renderer && cam) {
			const s = RES_STEPS[resIdx];
			const glCam = s === 1 ? cam : { ...cam, dpr: (cam.dpr || 1) * s };
			renderer.draw(glCam, opts);
			labelLayer && labelLayer.draw(cam);
		}
		// readPixels＝GLキャンバスを確実に読む唯一の手（createImageBitmap/transferToImageBitmap は headless GL で詰まる）。
		// 生画面は消さない（読むだけ）＝復元不要。GL は上下反転で返るので flip フラグを立て main で戻す。
		const gl = glRef, w = canvas.width, h = canvas.height;
		const base = new Uint8Array(w * h * 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, base);
		let labels = null, lw = 0, lh = 0;
		if (labelCanvas) {   // ラベルは2D＝getImageDataで上下正のまま
			lw = labelCanvas.width; lh = labelCanvas.height;
			labels = new Uint8Array(labelCanvas.getContext("2d").getImageData(0, 0, lw, lh).data.buffer);
		}
		const transfer = [base.buffer]; if (labels) transfer.push(labels.buffer);
		postMessage({ type: "snapshot", id, base: base.buffer, w, h, labels: labels ? labels.buffer : null, lw, lh }, transfer);
	} catch (e) { console.error("[render] snapshot例外", e?.message, e?.stack); }
}

// ラベルに標高を付与（傾き時に地物と一致）。main.js が持っていた terrain.sampleElev(...) 呼び出しをそのままこちらへ移設。
function applyLabels() {
	if (!labelLayer || !cam) return;
	const list = pendingLabels; pendingLabels = null;
	for (const L of list) L.elev = terrain.sampleElev(L.anchor[0], L.anchor[1], cam);
	labelLayer.setLabels(list);
}

// --- 動的解像度（タブレット対策）：連続描画中のフレーム間隔を EMA で監視し、間に合わない端末では
// GL キャンバスの実解像度を段階的に下げる（1→0.85→0.7→0.55）。ラベルは別キャンバス＝文字は常にくっきり。
// renderer は毎フレーム canvas.width を読む＝サイズ変更だけで全系（viewport/mvp/terrain）が追随する。
// 復帰は「軽い状態が続いたら一段上げて様子見」のプローブ式。失敗（また重くなる）したら待ち時間を倍にする
// ＝重い端末で上げ下げが振動しない。60Hz でも 120Hz でも閾値が成立する（重い=24ms超、軽い=17.5ms未満）。
let baseW = 0, baseH = 0, resIdx = 0;
const RES_STEPS = [1, 0.85, 0.7, 0.55];
let emaMs = 0, lastFrameT = 0, prevDrew = false, resHold = 0, upStreak = 0, upDelay = 300;
let uploadSkip = 0, pendingUp = false;   // uploadSkip＝PLATEAU転送直後の計測除外（転送スパイクで誤降格しない）。pendingUp＝解像度復帰の予約（適用は静止フレーム）

// 重い GPU 転送の平準化（1フレーム1件）：同一フレームに bufferData が束で乗るとフレームが飛ぶ。
// ・シーン（swapBase/swapScene のマージ結果＝丸ごと差し替え）は slot ごとに「最新だけ」保持＝
//   ズーム中に連続で届く粗い下地の中間版は上げずに捨てる（転送の仕事そのものが減る）。
// ・PLATEAU バッチ（typed array 10〜20MB）は FIFO＝解放(null)の追い越し禁止（先に解放が効くと
//   後から亡霊バッチが立つ）。解放は deleteBuffer だけで軽い＝同フレームで続けて消化。
const sceneInbox = new Map(), plateauInbox = [];
function drainUploads() {
	if (!renderer) return;
	if (sceneInbox.size) {   // シーン優先＝基図の見た目への効きが大きい（PLATEAUは1フレーム待つだけ）
		const [slot, scene] = sceneInbox.entries().next().value;
		sceneInbox.delete(slot);
		try { renderer.set("scene", scene, slot); }
		catch (err) { console.error("[render] scene適用失敗:", err && (err.message || err)); }   // 適用失敗も黙らせない（次の merge で回復）
		dirty = true; uploadSkip = 2;
		return;
	}
	while (plateauInbox.length) {
		const item = plateauInbox.shift();
		if ("vis" in item) { renderer.set("plateauVis", item.vis, item.name); dirty = true; continue; }   // 表示切替＝フラグだけ＝同フレームで続けて消化
		const { meshData, name } = item;
		renderer.set("plateauMesh", meshData, name);
		dirty = true;
		if (meshData) { uploadSkip = 2; break; }   // 重い転送は1件で打ち切り。転送の山は「次フレームのdt」に出る＝EMA計測を2フレーム除外
	}
}
function applyRes() {
	if (!canvas || !baseW) return;
	const s = RES_STEPS[resIdx], w = Math.round(baseW * s), h = Math.round(baseH * s);
	if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
}
function tuneRes(drew) {
	const now = performance.now(), dt = now - lastFrameT;
	lastFrameT = now;
	const skip = uploadSkip > 0 && (uploadSkip--, true);   // PLATEAU転送フレームのdt＝転送コミコミ＝描画の実力でない
	const measured = drew && prevDrew && !skip && dt < 200;   // 連続描画フレームだけ計測（アイドル明け・タブ切替の外れ値は捨てる）
	prevDrew = drew;
	if (!measured) return;
	emaMs = emaMs ? emaMs + (dt - emaMs) * 0.1 : dt;
	if (resHold > 0) { resHold--; return; }
	if (emaMs > 24 && resIdx < RES_STEPS.length - 1) {
		pendingUp = false;   // また重くなった＝予約中の復帰は取り消し
		resIdx++; applyRes(); resHold = 30; upStreak = 0; upDelay = Math.min(upDelay * 2, 4800); emaMs = 0;
		console.log(`[render] 動的解像度 ↓ ×${RES_STEPS[resIdx]}`);
	} else if (resIdx > 0 && emaMs < 17.5 && ++upStreak >= upDelay) {
		pendingUp = true; upStreak = 0; emaMs = 0;   // 即switchせず予約＝適用は静止フレーム（パン/ズーム中に切替の1重フレームを見せない）
	}
}

// terrain.ensure は視野→セル範囲計算（cameraState＋108回unproject）を伴う＝毎フレームは無駄。
// アトラス構成が変わり得るだけのカメラ移動（視野幅の~10%・ズーム0.05・チルト/方位~1°）があった時だけ呼ぶ。
let lastEnsure = null;
// c＝dpr補正済みカメラ（動的解像度中は dpr×resScale）。素の cam を渡すと縮小 canvas と食い違い、
// camDist が×s に潰れた（＝ズームインした）仮想視点で標高窓の票を取ってしまう→実視野の遠景が窓の外＝
// 標高ゼロの帯＋窓の縁の壁（スリット）になる（実測: res×0.55 で実視野の3.4%が窓外。res復帰で直る＝
// 「リロードすると綺麗」の正体）。draw と同じ glCam を受け取り、描画と窓計算の視野を常に一致させる。
function ensureIfMoved(c) {
	const tol = 36 / Math.pow(2, c.zoom);   // 視野スパンの~10%相当(deg)
	if (lastEnsure &&
		Math.abs(c.center[0] - lastEnsure.lon) < tol && Math.abs(c.center[1] - lastEnsure.lat) < tol &&
		Math.abs(c.zoom - lastEnsure.zoom) < 0.05 &&
		Math.abs((c.pitch || 0) - lastEnsure.pitch) < 0.02 && Math.abs((c.bearing || 0) - lastEnsure.bearing) < 0.02 &&
		canvas.width === lastEnsure.w && canvas.height === lastEnsure.h) return;
	lastEnsure = { lon: c.center[0], lat: c.center[1], zoom: c.zoom, pitch: c.pitch || 0, bearing: c.bearing || 0, w: canvas.width, h: canvas.height };
	// false＝標高ローダ未準備（起動直後）。記憶を消して次フレームで再試行——ここで記憶したままだと
	// 「リロード直後にカメラを動かすまで地形が平ら」になる（チルト復元起動で顕在化した）。
	if (terrain.ensure(c, { w: canvas.width, h: canvas.height }) === false) lastEnsure = null;
}

// worker 自前の rAF ループ。dirty かつ cam があれば、最新 cam で mvp 生成→地図→ラベルを同フレームで描く。
// try/catch：draw中の例外が末尾の requestAnimationFrame に到達しないとループが永久死＝最後のフレームで凍結する。
// 失敗フレームは落として次フレームへ（エラーはconsoleに出す＝原因調査可能なまま画は生き続ける）。
function frame() {
	let drew = false;
	try {
		drainUploads();   // 重いGPU転送（シーン/PLATEAU）の平準化＝1件/フレーム。dirty を立てる＝同フレームの下の描画で反映
		if (dirty && renderer && cam) {
			dirty = false; drew = true;
			// 動的解像度中は GL 側の dpr に resScale を掛ける＝線の太さ(SDF capsule)が CSS 上で不変。
			// ラベルは自前 canvas（フル解像度）＋自前 cameraState なので素の cam のまま＝幾何は両者で一致する。
			const s = RES_STEPS[resIdx];
			const glCam = s === 1 ? cam : { ...cam, dpr: (cam.dpr || 1) * s };
			// ズーム中(zoom非stable)は標高アトラスを再構築しない＝cellRes連続変化による陰影チラつきを防ぐ（main が opts.terrainGate で通知）。
			// noTerrain＝全球ビュー(z<4)では地形そのものが不要。ensure には draw と同じ glCam＝縮小 canvas と整合する視野を渡す。
			if (terrain && !opts?.noTerrain && opts?.terrainGate !== false) ensureIfMoved(glCam);
			if (gintSyncPort) gintSyncPort.postMessage({ cam });     // 海岸線(gint)へ先に転送＝GL描画と並走して同じvsyncに乗せる（描画後に送ると常に1フレーム遅れる）
			const fogAnim = renderer.draw(glCam, opts);              // cameraState=mvp生成 + GL描画（軽い）。true=フォグ追従が収束中
			// skipMain（ズームアウトで古い詳細シーンを退場）中は文字も一緒に退場＝clear()でフェード状態ごと流す。
			// 新しい段の merge で戻る時はフェードインから始まる＝可逆な退場。
			const animating = labelLayer && (opts?.skipMain ? (labelLayer.clear(), false) : labelLayer.draw(cam));    // ラベルも同じ cam で（＝完全同期）
			if (animating || fogAnim) dirty = true;                  // フェード/フォグ追従の継続は自前で次フレーム（main関与なし）
			if (!sentFrame1) { sentFrame1 = true; postMessage({ type: "frame1" }); }   // 初描画成功＝main の起動ウォッチドッグを解除
		}
		if (glRef && !sentCtxLost && glRef.isContextLost()) { sentCtxLost = true; postMessage({ type: "contextlost" }); }   // GPU喪失＝mainが立て直す
	} catch (e) {
		console.error("[render] frame例外（このフレームは破棄して継続）", e?.message, e?.stack);
	}
	tuneRes(drew);
	if (!drew && pendingUp) {   // 解像度復帰は静止フレームで適用＝切替の1重フレームが操作中に見えない（静止中の描き直しは1回きり＋止まれば画面が鮮明に戻る）
		pendingUp = false;
		if (resIdx > 0) {
			resIdx--; applyRes(); resHold = 60;
			console.log(`[render] 動的解像度 ↑ ×${RES_STEPS[resIdx]}（静止時適用）`);
		}
	}
	requestAnimationFrame(frame);
}
