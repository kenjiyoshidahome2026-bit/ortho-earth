// render worker：WebGL2 の地図 と Canvas2D のラベルを OffscreenCanvas で回す。
// worker-driven：自前 rAF で「最新の cam から mvp 生成 → 地図→ラベルを同じ frame で描画」。
// main は cam を投げるだけ（往復待ちを排し、溜まった draw は最新一枚に畳む＝低レイテンシ）。
// 描画フレームは軽い処理のみ（mvp生成+draw）。重い生成は main/他worker が停止後に行い set で渡す。
import { createRenderer, createLabelLayer } from "ortho-japan";
import { shieldFor } from "./shields.js";
import { createTerrain } from "./terrain.js";

let renderer = null, labelLayer = null, canvas = null, labelCanvas = null;
let cam = null, opts = null, dirty = false;   // 最新の描画状態。dirty の時だけ rAF で描く。
let gintSyncPort = null;   // gint worker への直結：1枚描く度に「この cam で描け」＝海岸線を地図フレームに従属させる。
let terrain = null, pendingLabels = null;   // pendingLabels: cam 未着で標高付与を保留した最新ラベル集合

onmessage = e => {
	const m = e.data;
	switch (m.type) {
		case "init":
			canvas = m.canvas;                                   // GL 用 OffscreenCanvas
			renderer = createRenderer(canvas);
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
				renderer.set("scene", ev.data.scene, ev.data.slot);
				dirty = true;                                    // 内容更新→次の rAF で最新camで描き直す
			};
			if (m.gintSyncPort) gintSyncPort = m.gintSyncPort;   // 海岸線(gint)従属の出口
			requestAnimationFrame(frame);                        // worker 自前の描画ループ開始
			break;
		case "plateauPort":                                      // plateau worker → ここ のメッシュ直結パイプ（workerプール1本につき1ポート）
			m.port.onmessage = ev => {                           // ~160MB の typed array を main を経由させず transfer で受ける
				if (renderer) renderer.set("plateauMesh", ev.data.meshData, ev.data.name);
				dirty = true;
			};
			break;
		case "resize":                                           // 両キャンバスを同じ寸法に（main は transfer 後触れない）
			if (canvas) { canvas.width = m.width; canvas.height = m.height; }
			if (labelCanvas) { labelCanvas.width = m.width; labelCanvas.height = m.height; }
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

// worker 自前の rAF ループ。dirty かつ cam があれば、最新 cam で mvp 生成→地図→ラベルを同フレームで描く。
function frame() {
	if (dirty && renderer && cam) {
		dirty = false;
		// ズーム中(zoom非stable)は標高アトラスを再構築しない＝cellRes連続変化による陰影チラつきを防ぐ（main が opts.terrainGate で通知）。
		// noTerrain＝全球ビュー(z<4)では地形そのものが不要。
		if (terrain && !opts?.noTerrain && opts?.terrainGate !== false) terrain.ensure(cam, { w: canvas.width, h: canvas.height });
		renderer.draw(cam, opts);                                // cameraState=mvp生成 + GL描画（軽い）
		if (gintSyncPort) gintSyncPort.postMessage({ cam });     // 描いた cam を海岸線(gint)へ即転送＝従属（スライド消滅）
		const animating = labelLayer && labelLayer.draw(cam);    // ラベルも同じ cam で（＝完全同期）
		if (animating) dirty = true;                             // フェード継続は自前で次フレーム（main関与なし）
	}
	requestAnimationFrame(frame);
}
