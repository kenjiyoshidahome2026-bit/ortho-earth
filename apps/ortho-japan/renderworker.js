// render worker：WebGL2 の地図 と Canvas2D のラベルを OffscreenCanvas で回す。
// worker-driven：自前 rAF で「最新の cam から mvp 生成 → 地図→ラベルを同じ frame で描画」。
// main は cam を投げるだけ（往復待ちを排し、溜まった draw は最新一枚に畳む＝低レイテンシ）。
// 描画フレームは軽い処理のみ（mvp生成+draw）。重い生成は main/他worker が停止後に行い set で渡す。
import { createRenderer, createLabelLayer, createTerrain } from "ortho-japan";
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
			if (m.scenePort) m.scenePort.onmessage = ev => {     // scene worker から直結：main を経由しない geometry
				try { renderer.set("scene", ev.data.scene, ev.data.slot); }
				catch (err) { console.error("[render] scene適用失敗:", err && (err.message || err)); }   // 適用失敗も黙らせない（次の merge で回復）
				dirty = true;                                    // 内容更新→次の rAF で最新camで描き直す
			};
			if (m.gintSyncPort) gintSyncPort = m.gintSyncPort;   // 海岸線(gint)従属の出口
			requestAnimationFrame(frame);                        // worker 自前の描画ループ開始
			break;
		case "plateauPort":                                      // plateau worker → ここ のメッシュ直結パイプ（workerプール1本につき1ポート）
			m.port.onmessage = ev => {                           // バッチ単位の typed array を main を経由させず transfer で受ける（逐次表示）
				if (renderer) renderer.set("plateauMesh", ev.data.meshData, ev.data.name);
				dirty = true;
			};
			break;
		case "resize":                                           // 両キャンバスを同じ寸法に（main は transfer 後触れない）
			baseW = m.width; baseH = m.height;
			applyRes();                                          // GL 側は動的解像度スケールを掛けて適用
			if (labelCanvas) { labelCanvas.width = m.width; labelCanvas.height = m.height; }   // ラベル(文字)は常にフル解像度
			dirty = true;
			break;
		case "set":
			if (m.cmd === "labels") { pendingLabels = m.data; applyLabels(); }   // ラベル集合の更新（標高は cam が揃ってから付与）
			else if (renderer) renderer.set(m.cmd, m.data, m.prop);              // view/scene/overlay/elev…
			dirty = true;                                        // 内容が変わった→描き直す
			break;
		case "draw":                                             // main からは cam を記録するだけ（実描画は rAF）
			cam = m.cam; opts = m.opts; dirty = true;
			if (pendingLabels) applyLabels();                    // cam が届いた時点で保留中のラベルへ標高を付与
			break;
		case "destroy":
			if (renderer && renderer.dispose) renderer.dispose();
			renderer = null;
			break;
	}
};

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
function applyRes() {
	if (!canvas || !baseW) return;
	const s = RES_STEPS[resIdx], w = Math.round(baseW * s), h = Math.round(baseH * s);
	if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
}
function tuneRes(drew) {
	const now = performance.now(), dt = now - lastFrameT;
	lastFrameT = now;
	const measured = drew && prevDrew && dt < 200;   // 連続描画フレームだけ計測（アイドル明け・タブ切替の外れ値は捨てる）
	prevDrew = drew;
	if (!measured) return;
	emaMs = emaMs ? emaMs + (dt - emaMs) * 0.1 : dt;
	if (resHold > 0) { resHold--; return; }
	if (emaMs > 24 && resIdx < RES_STEPS.length - 1) {
		resIdx++; applyRes(); resHold = 30; upStreak = 0; upDelay = Math.min(upDelay * 2, 4800); emaMs = 0;
		console.log(`[render] 動的解像度 ↓ ×${RES_STEPS[resIdx]}`);
	} else if (resIdx > 0 && emaMs < 17.5 && ++upStreak >= upDelay) {
		resIdx--; applyRes(); resHold = 60; upStreak = 0; emaMs = 0;
		console.log(`[render] 動的解像度 ↑ ×${RES_STEPS[resIdx]}`);
	}
}

// terrain.ensure は視野→セル範囲計算（cameraState＋108回unproject）を伴う＝毎フレームは無駄。
// アトラス構成が変わり得るだけのカメラ移動（視野幅の~10%・ズーム0.05・チルト/方位~1°）があった時だけ呼ぶ。
let lastEnsure = null;
function ensureIfMoved() {
	const tol = 36 / Math.pow(2, cam.zoom);   // 視野スパンの~10%相当(deg)
	if (lastEnsure &&
		Math.abs(cam.center[0] - lastEnsure.lon) < tol && Math.abs(cam.center[1] - lastEnsure.lat) < tol &&
		Math.abs(cam.zoom - lastEnsure.zoom) < 0.05 &&
		Math.abs((cam.pitch || 0) - lastEnsure.pitch) < 0.02 && Math.abs((cam.bearing || 0) - lastEnsure.bearing) < 0.02 &&
		canvas.width === lastEnsure.w && canvas.height === lastEnsure.h) return;
	lastEnsure = { lon: cam.center[0], lat: cam.center[1], zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0, w: canvas.width, h: canvas.height };
	// false＝標高ローダ未準備（起動直後）。記憶を消して次フレームで再試行——ここで記憶したままだと
	// 「リロード直後にカメラを動かすまで地形が平ら」になる（チルト復元起動で顕在化した）。
	if (terrain.ensure(cam, { w: canvas.width, h: canvas.height }) === false) lastEnsure = null;
}

// worker 自前の rAF ループ。dirty かつ cam があれば、最新 cam で mvp 生成→地図→ラベルを同フレームで描く。
// try/catch：draw中の例外が末尾の requestAnimationFrame に到達しないとループが永久死＝最後のフレームで凍結する。
// 失敗フレームは落として次フレームへ（エラーはconsoleに出す＝原因調査可能なまま画は生き続ける）。
function frame() {
	let drew = false;
	try {
		if (dirty && renderer && cam) {
			dirty = false; drew = true;
			// ズーム中(zoom非stable)は標高アトラスを再構築しない＝cellRes連続変化による陰影チラつきを防ぐ（main が opts.terrainGate で通知）。
			// noTerrain＝全球ビュー(z<4)では地形そのものが不要。
			if (terrain && !opts?.noTerrain && opts?.terrainGate !== false) ensureIfMoved();
			if (gintSyncPort) gintSyncPort.postMessage({ cam });     // 海岸線(gint)へ先に転送＝GL描画と並走して同じvsyncに乗せる（描画後に送ると常に1フレーム遅れる）
			// 動的解像度中は GL 側の dpr に resScale を掛ける＝線の太さ(SDF capsule)が CSS 上で不変。
			// ラベルは自前 canvas（フル解像度）＋自前 cameraState なので素の cam のまま＝幾何は両者で一致する。
			const s = RES_STEPS[resIdx];
			const glCam = s === 1 ? cam : { ...cam, dpr: (cam.dpr || 1) * s };
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
	requestAnimationFrame(frame);
}
