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
// elevBase = 誇張/地球半径m（地物の u_elevScale の pitch非依存部分）。各ラベルを L.elev(m) 分だけ
// 地形に乗せて投影＝傾き時に地物とラベルの位置が一致する（標高視差のズレを解消）。
export function createLabelLayer(canvas, { pad = 5, fade = 0.3, recollideMs = 150, shieldFor = null, elevBase = 0 } = {}) {
	// pitch ゲート（renderer と同式）。真俯瞰0→11.5°で全開。cityFlat（z13.5→16で地形が平らになる）も
	// 同式で畳む＝地形が沈むのにラベルだけ持ち上がったまま「浮く」のを防ぐ。
	const pitchScale = (pitch, zoom) => {
		const t = Math.max(0, Math.min(1, ((pitch || 0) - 0.06) / 0.14));
		const cf = 1 - Math.max(0, Math.min(1, ((zoom || 0) - 13.5) / 2.5));
		return elevBase * t * t * (3 - 2 * t) * cf;
	};
	// 標高の持ち上げは地形の遠景平坦化(df・TERRAIN_VSと同式)にも追随＝平坦化された遠くの山の上で
	// ラベルだけがフル標高で浮かない。fogF=フォグ終端（renderer の fogFarCap と同式・camDist近似）。
	const radiusOf = (L, eScale, st, fogF) => {
		if (!L.elev || !eScale) return 1;
		const v = lonlatTo3D(L.anchor[0], L.anchor[1]);
		const d = Math.hypot(v[0] - st.eye[0], v[1] - st.eye[1], v[2] - st.eye[2]);
		const t = Math.max(0, Math.min(1, (d - fogF * 0.8) / (fogF * 1.2)));
		return 1 + L.elev * eScale * (1 - t * t * (3 - 2 * t));
	};
	const ctx = canvas.getContext("2d");
	let labels = [];
	const fades = new Map();        // key → 不透明度（フェード）
	let winners = new Map();         // key → L（現在の当選集合。間引きで更新）
	let lastCollide = -1e9, dirty = true, lastShowFlat = true;   // showFlat=傾き閾値下（真俯瞰）だけ測量点等の flat ラベルを出す
	const widthCache = new Map();   // "size|text" → measureText 幅。measureText は高コスト＝再衝突判定(150ms毎)の度に全ラベル分呼ばない
	let labelByKey = new Map();     // key → L（フェードアウト中ラベルの逆引き。draw 毎の線形探索を排除）

	function setLabels(list) {
		labels = list.slice().sort((a, b) => a.sort - b.sort);
		labelByKey = new Map(labels.map(L => [keyOf(L), L]));
		dirty = true;
	}
	function clear() {
		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
		fades.clear(); winners.clear();
	}

	// 衝突判定（優先度順の貪欲）。当選集合 winners を更新。
	function collide(st, dpr, Wc, Hc, eScale, showFlat, fogF) {
		const placed = [], w = new Map();
		let font = "";
		for (const L of labels) {
			if (L.flat && !showFlat) continue;   // 傾けたら測量点(真俯瞰の作法)は当選集合から外す＝以降フェードアウト（等高線と対称）
			const [dx, dy, front] = project(st, L.anchor[0], L.anchor[1], radiusOf(L, eScale, st, fogF));
			if (front < 0) continue;
			const sx = dx / dpr, sy = dy / dpr;
			const shield = shieldFor && shieldFor(L);
			let tw, h;
			if (shield) { tw = shield.w; h = shield.h; }
			else {
				const wk = L.size + "|" + L.text;
				tw = widthCache.get(wk);
				if (tw === undefined) {
					const f = `${L.size}px ${FONT_STACK}`; if (f !== font) { ctx.font = font = f; }
					tw = ctx.measureText(L.text).width;
					widthCache.set(wk, tw);
					if (widthCache.size > 4096) widthCache.clear();   // 念のための上限（テキスト種は高々数千）
				}
				h = L.size;
			}
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
		const eScale = pitchScale(cam.pitch, cam.zoom);   // 標高→単位球（pitch・cityFlat連動、地物と同式）
		// フォグ終端（renderer の fogFarCap と同式・camDist近似）＝遠景平坦化 df の基準
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		const showFlat = (cam.pitch || 0) < 0.06;      // 等高線と同じゲート（pitch 0.06rad で 3D と入れ替わり消える）
		const now = nowMs();
		if (showFlat !== lastShowFlat) { dirty = true; lastShowFlat = showFlat; }   // 閾値跨ぎで即再衝突判定→flat を外す/戻す
		const fogF = Math.max(st.camDist * 5.0, 0.026 * pfFog);
		if (dirty || now - lastCollide > recollideMs) { collide(st, dpr, Wc, Hc, eScale, showFlat, fogF); lastCollide = now; dirty = false; }

		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.scale(dpr, dpr);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;

		const fNear = st.camDist * 2, fFar = st.camDist * 9, eye = st.eye;   // 距離フェード（フォグ連動）
		const distOp = (lon, lat) => { const v = lonlatTo3D(lon, lat); const d = Math.hypot(v[0] - eye[0], v[1] - eye[1], v[2] - eye[2]); return 1 - Math.min(1, Math.max(0, (d - fNear) / (fFar - fNear))); };

		let animating = false, font = "";
		const keys = new Set([...winners.keys(), ...fades.keys()]);
		for (const k of keys) {
			const L = winners.get(k) || labelByKey.get(k);
			if (!L) { fades.delete(k); continue; }
			const target = winners.has(k) ? 1 : 0;
			let op = fades.get(k) ?? 0; op += (target - op) * fade;
			if (target ? op > 0.99 : op < 0.02) { op = target; if (!op) { fades.delete(k); continue; } } else animating = true;
			fades.set(k, op);
			const [dx, dy, front] = project(st, L.anchor[0], L.anchor[1], radiusOf(L, eScale, st, fogF));   // ライブ投影（標高込み）
			if (front < 0) continue;
			const o = op * distOp(L.anchor[0], L.anchor[1]);
			if (o <= 0.01) continue;
			const sx = Math.round(dx / dpr), sy = Math.round(dy / dpr);
			const shield = shieldFor && shieldFor(L);
			if (shield) {
				ctx.globalAlpha = o;
				shield.draw(ctx, sx, sy);   // ベクター直描き（DPRスケール済みctx上＝常にシャープ）
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
