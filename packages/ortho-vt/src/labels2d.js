// ラベルを Canvas2D オーバーレイで描く（GL幾何の上に重ねる最前面レイヤ）。
// 衝突判定（どのラベルを出すか）は間引き（recollideMs毎）で安定化し、描画位置は毎フレーム・ライブ投影。
// これで文字は地図と一緒に滑らかに動きつつ、当選集合が安定して明滅しない。距離フェードでフォグと連動。
import { cameraState, project, lonlatTo3D } from "./camera.js";

const FONT_STACK = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif`;
const css = (c, op = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;
const keyOf = L => L.text + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5);
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// shieldFor(L) → { img:CanvasImageSource, w, h }（CSS px）を返すとテキストの代わりにその絵を描く。
// 国道おにぎり等の標識をアプリ側で供給する差し込み口（エンジンは汎用のまま）。
export function createLabelLayer(canvas, { pad = 5, fade = 0.3, recollideMs = 150, shieldFor = null } = {}) {
	const ctx = canvas.getContext("2d");
	let labels = [];
	const fades = new Map();        // key → 不透明度（フェード）
	let winners = new Map();         // key → L（現在の当選集合。間引きで更新）
	let lastCollide = -1e9, dirty = true;

	function setLabels(list) { labels = list.slice().sort((a, b) => a.sort - b.sort); dirty = true; }
	function clear() {
		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
		fades.clear(); winners.clear();
	}

	// 衝突判定（優先度順の貪欲）。当選集合 winners を更新。
	function collide(st, dpr, Wc, Hc) {
		const placed = [], w = new Map();
		let font = "";
		for (const L of labels) {
			const [dx, dy, front] = project(st, L.anchor[0], L.anchor[1]);
			if (front < 0) continue;
			const sx = dx / dpr, sy = dy / dpr;
			const shield = shieldFor && shieldFor(L);
			let tw, h;
			if (shield) { tw = shield.w; h = shield.h; }
			else { const f = `${L.size}px ${FONT_STACK}`; if (f !== font) { ctx.font = font = f; } tw = ctx.measureText(L.text).width; h = L.size; }
			if (sx + tw / 2 < 0 || sx - tw / 2 > Wc || sy + h / 2 < 0 || sy - h / 2 > Hc) continue;
			const box = [sx - tw / 2 - pad, sy - h / 2 - pad, sx + tw / 2 + pad, sy + h / 2 + pad];
			if (placed.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
			placed.push(box); w.set(keyOf(L), L);
		}
		winners = w;
	}

	// 戻り値: フェード継続中か（true なら次フレーム継続）。
	function draw(cam) {
		const dpr = cam.dpr || 1, W = canvas.width, H = canvas.height, Wc = W / dpr, Hc = H / dpr;
		const st = cameraState(cam, W, H);
		const now = nowMs();
		if (dirty || now - lastCollide > recollideMs) { collide(st, dpr, Wc, Hc); lastCollide = now; dirty = false; }

		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.scale(dpr, dpr);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;

		const fNear = st.camDist * 2, fFar = st.camDist * 9, eye = st.eye;   // 距離フェード（フォグ連動）
		const distOp = (lon, lat) => { const v = lonlatTo3D(lon, lat); const d = Math.hypot(v[0] - eye[0], v[1] - eye[1], v[2] - eye[2]); return 1 - Math.min(1, Math.max(0, (d - fNear) / (fFar - fNear))); };

		let animating = false, font = "";
		const keys = new Set([...winners.keys(), ...fades.keys()]);
		for (const k of keys) {
			const L = winners.get(k) || labels.find(x => keyOf(x) === k);
			if (!L) { fades.delete(k); continue; }
			const target = winners.has(k) ? 1 : 0;
			let op = fades.get(k) ?? 0; op += (target - op) * fade;
			if (target ? op > 0.99 : op < 0.02) { op = target; if (!op) { fades.delete(k); continue; } } else animating = true;
			fades.set(k, op);
			const [dx, dy, front] = project(st, L.anchor[0], L.anchor[1]);   // ライブ投影
			if (front < 0) continue;
			const o = op * distOp(L.anchor[0], L.anchor[1]);
			if (o <= 0.01) continue;
			const sx = Math.round(dx / dpr), sy = Math.round(dy / dpr);
			const shield = shieldFor && shieldFor(L);
			if (shield) {
				ctx.globalAlpha = o;
				ctx.drawImage(shield.img, sx - shield.w / 2, sy - shield.h / 2, shield.w, shield.h);
				ctx.globalAlpha = 1;
				continue;
			}
			const f = `${L.size}px ${FONT_STACK}`; if (f !== font) { ctx.font = font = f; }
			if (L.haloW > 0) { ctx.strokeStyle = css(L.halo, o); ctx.lineWidth = L.haloW * 2; ctx.strokeText(L.text, sx, sy); }
			ctx.fillStyle = css(L.color, o); ctx.fillText(L.text, sx, sy);
		}
		return animating;
	}

	return { setLabels, draw, clear };
}
