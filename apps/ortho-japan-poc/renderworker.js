// render worker：WebGL2 を OffscreenCanvas で回す。main から init/set/draw/resize/destroy を受け、
// GL 描画だけを担う。createRenderer は DOM 非依存（getContext と数学のみ）なのでそのまま動く。
// DOM・レポーティング・入力は main 側。ortho-map createRemoteLayer の worker 側と同じ役割。
import { createRenderer } from "ortho-japan";

let renderer = null, canvas = null;

onmessage = e => {
	const m = e.data;
	switch (m.type) {
		case "init":
			canvas = m.canvas;                       // OffscreenCanvas（transfer 済）
			renderer = createRenderer(canvas);
			break;
		case "resize":                               // main は transfer 後 canvas.width を触れない＝worker が持つ
			if (canvas) { canvas.width = m.width; canvas.height = m.height; }
			break;
		case "set":                                  // 汎用 set(cmd,data,prop)：view/scene/overlay/elevAtlas/elevCell…
			if (renderer) renderer.set(m.cmd, m.data, m.prop);
			break;
		case "draw":                                 // 毎フレームの幾何 payload（center/zoom/pitch/bearing/dpr）
			if (renderer) renderer.draw(m.cam, m.opts);
			break;
		case "destroy":
			if (renderer && renderer.dispose) renderer.dispose();
			renderer = null;
			break;
	}
};
