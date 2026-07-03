// ラベルを Canvas2D オーバーレイで描く（GL幾何の上に重ねる最前面レイヤ）。
// ネイティブのCJKテキスト描画で高品質。投影・球体カリング・衝突は JS（GL幾何と同一の projectDelta）。
import { projectDelta } from "./project.js";

const FONT_STACK = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif`;
const css = (c, op = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;

const keyOf = L => L.text + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5);

export function createLabelLayer(canvas, { pad = 5, fade = 0.3 } = {}) {
	const ctx = canvas.getContext("2d");
	let labels = [];
	const fades = new Map();   // key → 不透明度（軽いフェード用）

	function setLabels(list) {
		labels = list.slice().sort((a, b) => a.sort - b.sort);   // sort-key 昇順＝優先度高い順
	}

	// 移動中に呼ぶ：ラベルを消してフェード状態もリセット（停止時に改めてフェードイン）。
	function clear() {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		fades.clear();
	}

	// cam: { center, scale, translate(device px), dpr }。投影→衝突→（軽い）フェード描画。戻り値: 継続中か。
	function draw(cam) {
		const dpr = cam.dpr || 1, W = canvas.width, H = canvas.height, Wc = W / dpr, Hc = H / dpr;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, W, H);
		ctx.scale(dpr, dpr);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;
		const lcam = { origin: [0, 0], center: cam.center, scale: cam.scale, translate: cam.translate };

		// 衝突で勝者を決める（画面内・前面のみ）。位置も保持。
		const placed = [], shown = new Map();
		let font = "";
		for (const L of labels) {
			const [dx, dy, front] = projectDelta(lcam, L.anchor[0], L.anchor[1]);
			if (front < 0) continue;
			const sx = Math.round(dx / dpr), sy = Math.round(dy / dpr);
			const f = `${L.size}px ${FONT_STACK}`;
			if (f !== font) { ctx.font = font = f; }
			const w = ctx.measureText(L.text).width, h = L.size;
			if (sx + w / 2 < 0 || sx - w / 2 > Wc || sy + h / 2 < 0 || sy - h / 2 > Hc) continue;
			const box = [sx - w / 2 - pad, sy - h / 2 - pad, sx + w / 2 + pad, sy + h / 2 + pad];
			if (placed.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
			placed.push(box); shown.set(keyOf(L), { L, sx, sy });
		}

		let animating = false;
		// 勝者：フェードイン
		for (const [k, s] of shown) {
			let op = fades.get(k) ?? 0; op += (1 - op) * fade; if (op > 0.99) op = 1; else animating = true;
			fades.set(k, op); drawLabel(s.L, s.sx, s.sy, op);
		}
		// 非勝者：フェードアウト（残存分のみ、位置再計算して薄く）
		for (const [k, op0] of [...fades]) {
			if (shown.has(k)) continue;
			const op = op0 * (1 - fade);
			if (op < 0.03) { fades.delete(k); continue; }
			fades.set(k, op); animating = true;
			const L = labels.find(x => keyOf(x) === k); if (!L) { fades.delete(k); continue; }
			const [dx, dy, front] = projectDelta(lcam, L.anchor[0], L.anchor[1]);
			if (front >= 0) drawLabel(L, Math.round(dx / dpr), Math.round(dy / dpr), op);
		}
		return animating;

		function drawLabel(L, sx, sy, op) {
			ctx.font = `${L.size}px ${FONT_STACK}`;
			if (L.haloW > 0) { ctx.strokeStyle = css(L.halo, op); ctx.lineWidth = L.haloW * 2; ctx.strokeText(L.text, sx, sy); }
			ctx.fillStyle = css(L.color, op); ctx.fillText(L.text, sx, sy);
		}
	}

	return { setLabels, draw, clear };
}
