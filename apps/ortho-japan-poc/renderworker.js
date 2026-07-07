// render worker：WebGL2 の地図 と Canvas2D のラベルを OffscreenCanvas で回す。
// worker-driven：自前 rAF で「最新の cam から mvp 生成 → 地図→ラベルを同じ frame で描画」。
// main は cam を投げるだけ（往復待ちを排し、溜まった draw は最新一枚に畳む＝低レイテンシ）。
// 描画フレームは軽い処理のみ（mvp生成+draw）。重い生成は main/他worker が停止後に行い set で渡す。
import { createRenderer, createLabelLayer } from "ortho-japan";
import { shieldFor } from "./shields.js";

let renderer = null, labelLayer = null, canvas = null, labelCanvas = null;
let cam = null, opts = null, dirty = false;   // 最新の描画状態。dirty の時だけ rAF で描く。
let gintSyncPort = null;   // gint worker への直結：1枚描く度に「この cam で描け」＝海岸線を地図フレームに従属させる。

onmessage = e => {
	const m = e.data;
	switch (m.type) {
		case "init":
			canvas = m.canvas;                                   // GL 用 OffscreenCanvas
			renderer = createRenderer(canvas);
			labelCanvas = m.labelCanvas;                         // ラベル用 OffscreenCanvas（2D）
			labelLayer = createLabelLayer(labelCanvas, { shieldFor, elevBase: m.elevBase });
			if (m.scenePort) m.scenePort.onmessage = ev => {     // scene worker から直結：main を経由しない geometry
				renderer.set("scene", ev.data.scene, ev.data.slot);
				dirty = true;                                    // 内容更新→次の rAF で最新camで描き直す
			};
			if (m.gintSyncPort) gintSyncPort = m.gintSyncPort;   // 海岸線(gint)従属の出口
			requestAnimationFrame(frame);                        // worker 自前の描画ループ開始
			break;
		case "resize":                                           // 両キャンバスを同じ寸法に（main は transfer 後触れない）
			if (canvas) { canvas.width = m.width; canvas.height = m.height; }
			if (labelCanvas) { labelCanvas.width = m.width; labelCanvas.height = m.height; }
			dirty = true;
			break;
		case "set":
			if (m.cmd === "labels") { if (labelLayer) labelLayer.setLabels(m.data); }   // ラベル集合の更新
			else if (renderer) renderer.set(m.cmd, m.data, m.prop);                      // view/scene/overlay/elev…
			dirty = true;                                        // 内容が変わった→描き直す
			break;
		case "draw":                                             // main からは cam を記録するだけ（実描画は rAF）
			cam = m.cam; opts = m.opts; dirty = true;
			break;
		case "destroy":
			if (renderer && renderer.dispose) renderer.dispose();
			renderer = null;
			break;
	}
};

// worker 自前の rAF ループ。dirty かつ cam があれば、最新 cam で mvp 生成→地図→ラベルを同フレームで描く。
function frame() {
	if (dirty && renderer && cam) {
		dirty = false;
		renderer.draw(cam, opts);                                // cameraState=mvp生成 + GL描画（軽い）
		if (gintSyncPort) gintSyncPort.postMessage({ cam });     // 描いた cam を海岸線(gint)へ即転送＝従属（スライド消滅）
		const animating = labelLayer && labelLayer.draw(cam);    // ラベルも同じ cam で（＝完全同期）
		if (animating) dirty = true;                             // フェード継続は自前で次フレーム（main関与なし）
	}
	requestAnimationFrame(frame);
}
