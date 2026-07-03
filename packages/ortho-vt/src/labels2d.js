// ラベルを Canvas2D オーバーレイで描く（GL幾何の上に重ねる最前面レイヤ）。
// ネイティブのCJKテキスト描画で高品質。投影・球体カリング・衝突は JS（GL幾何と同一の projectDelta）。
import { projectDelta } from "./project.js";

const FONT_STACK = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif`;
const css = (c, op = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;

const keyOf = L => L.text + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5);

export function createLabelLayer(canvas, { pad = 5, fade = 0.22 } = {}) {
	const ctx = canvas.getContext("2d");
	let labels = [];
	const fades = new Map();   // key → 現在の不透明度（フェード用）

	function setLabels(list) {
		labels = list.slice().sort((a, b) => a.sort - b.sort);   // sort-key 昇順＝優先度高い順
	}

	// cam: { center, scale, translate(device px), dpr }。戻り値: フェード継続中か（true なら次フレーム継続）。
	function draw(cam) {
		const dpr = cam.dpr || 1, W = canvas.width, H = canvas.height, Wc = W / dpr, Hc = H / dpr;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, W, H);
		ctx.scale(dpr, dpr);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;
		const lcam = { origin: [0, 0], center: cam.center, scale: cam.scale, translate: cam.translate };

		// パス1: 投影＋衝突で「今フレームの勝者」を決める（画面内・前面のみ）
		const placed = [], shown = [];
		let font = "";
		for (const L of labels) {
			const [dx, dy, front] = projectDelta(lcam, L.anchor[0], L.anchor[1]);
			if (front < 0) continue;                    // 裏半球
			const sx = Math.round(dx / dpr), sy = Math.round(dy / dpr);
			const f = `${L.size}px ${FONT_STACK}`;
			if (f !== font) { ctx.font = font = f; }
			const w = ctx.measureText(L.text).width, h = L.size;
			if (sx + w / 2 < 0 || sx - w / 2 > Wc || sy + h / 2 < 0 || sy - h / 2 > Hc) continue;   // 画面外
			const box = [sx - w / 2 - pad, sy - h / 2 - pad, sx + w / 2 + pad, sy + h / 2 + pad];
			if (placed.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue; // 衝突
			placed.push(box);
			shown.push({ L, sx, sy });
		}

		// パス2: 勝者=フェードイン / それ以外=フェードアウト。透明度>0 のものを描く。
		const winners = new Set(shown.map(s => keyOf(s.L)));
		let animating = false;
		for (const { L, sx, sy } of shown) {
			const k = keyOf(L), target = 1;
			let op = fades.get(k) ?? 0;
			op += (target - op) * fade; if (op > 0.999) op = 1; else animating = true;
			fades.set(k, op);
			drawLabel(L, sx, sy, op);
		}
		// フェードアウト中（今回勝者でない）＝直前まで表示。位置再計算して薄く描き続ける。
		for (const [k, op0] of [...fades]) {
			if (winners.has(k)) continue;
			const op = op0 * (1 - fade);
			if (op < 0.02) { fades.delete(k); continue; }
			fades.set(k, op); animating = true;
			const L = labels.find(x => keyOf(x) === k); if (!L) { fades.delete(k); continue; }
			const [dx, dy, front] = projectDelta(lcam, L.anchor[0], L.anchor[1]);
			if (front < 0) continue;
			drawLabel(L, Math.round(dx / dpr), Math.round(dy / dpr), op);
		}
		return animating;

		function drawLabel(L, sx, sy, op) {
			ctx.font = `${L.size}px ${FONT_STACK}`;
			if (L.haloW > 0) { ctx.strokeStyle = css(L.halo, op); ctx.lineWidth = L.haloW * 2; ctx.strokeText(L.text, sx, sy); }
			ctx.fillStyle = css(L.color, op); ctx.fillText(L.text, sx, sy);
		}
	}

	return { setLabels, draw };
}
