// ラベルを Canvas2D オーバーレイで描く（GL幾何の上に重ねる最前面レイヤ）。
// 衝突判定（どのラベルを出すか）は間引き（recollideMs毎）で安定化し、描画位置は毎フレーム・ライブ投影。
// これで文字は地図と一緒に滑らかに動きつつ、当選集合が安定して明滅しない。距離フェードでフォグと連動。
import { cameraState, project, unproject, lonlatTo3D } from "./camera.js";

const FONT_STACK = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif`;
const css = (c, op = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;
const keyOf = L => L.text + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5);
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// shieldFor(L) → { img:CanvasImageSource, w, h }（CSS px）を返すとテキストの代わりにその絵を描く。
// 国道おにぎり等の標識をアプリ側で供給する差し込み口（エンジンは汎用のまま）。
// elevBase = 誇張/地球半径m（地物の u_elevScale の pitch非依存部分）。各ラベルを L.elev(m) 分だけ
// 地形に乗せて投影＝傾き時に地物とラベルの位置が一致する（標高視差のズレを解消）。
export function createLabelLayer(canvas, { pad = 5, fade = 0.3, recollideMs = 150, shieldFor = null, elevBase = 0 } = {}) {
	// pitch ゲート（renderer の elevScaleEff=elev.scale×pf と同式）。真俯瞰0→11.5°で全開。
	// 旧 cityFlat 項（z13.5→16でラベル標高を畳む）は撤去＝地形側の cityFlat 撤去（renderer 2026-07-26・
	// DEM10B=DTM化）に追随。残すと都市ズームのチルトで地形は起伏のまま・ラベルだけ楕円体へ沈み位置がズレる。
	const pitchScale = (pitch, zoom) => {
		const t = Math.max(0, Math.min(1, ((pitch || 0) - 0.06) / 0.14));
		return elevBase * t * t * (3 - 2 * t);
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
	// 星空劇場の注記（星座名・メシエ天体）。データは { constellations:[{cel,name}], messier:[{cel,name,type}] }、
	// cel＝天球単位ベクトル（RA/Dec焼き込み・アプリが供給）。null＝非表示（星座線のトグルと同期）。
	let sky = null;
	function setSky(data) { sky = data; }
	// 月＝満ち欠けの円盤（注記トグルと独立＝天体なので常設）。{ cel, sunCel, k }＝方向・太陽方向・輝面比。
	let moon = null;
	function setMoon(data) { moon = data; }
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
		const eScale = pitchScale(cam.pitch, cam.zoom);   // 標高→単位球（pitch連動＝renderer elevScaleEff と同式）
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
		drawSky(st, cam, Wc, Hc, dpr);
		return animating;
	}

	// 星空劇場の注記：GL星空(renderer)と厳密に同じ変換＝GMST回転→mvp×(dir,0)→天球倍率(u_sky同式)のNDCスケール。
	// 出現タイミング・フェードも星座線と同一（z<5・z5→4.5）。地球の背後は unproject（光線が球に当たる＝手前に地球）で遮蔽。
	function drawSky(st, cam, Wc, Hc, dpr) {
		if ((!sky && !moon) || cam.zoom >= 5) return;
		const fade = Math.min(1, (5 - cam.zoom) / 0.5);
		const gmst = (((18.697374 + 24.0657098 * (Date.now() / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360) * Math.PI / 180;
		const cg = Math.cos(gmst), sg = Math.sin(gmst);
		const skyK = (0.4 + 0.3 * cam.zoom) / 1.6;
		const m = st.mvp;
		const put = cel => {
			const x = cel[0] * cg + cel[2] * sg, y = cel[1], z = cel[2] * cg - cel[0] * sg;   // 天球→地球固定（STARS_VSと同式）
			const cx = m[0] * x + m[4] * y + m[8] * z, cy = m[1] * x + m[5] * y + m[9] * z, cw = m[3] * x + m[7] * y + m[11] * z;
			if (cw <= 1e-9) return null;   // 背後
			const sx = (cx / cw * skyK * 0.5 + 0.5) * Wc, sy = (1 - (cy / cw * skyK * 0.5 + 0.5)) * Hc;
			if (sx < -30 || sx > Wc + 30 || sy < -30 || sy > Hc + 30) return null;
			if (unproject(st, sx * dpr, sy * dpr)) return null;   // その画素は地球＝星は隠れる
			return [sx, sy];
		};
		// 月の円盤（満ち欠け）：暗い側は赤黒（地球照の佇まい）、輝面は暖白。輝面比 k と太陽の画面方位から
		// 半円＋半楕円（x方向スケール 2k-1＝符号で三日月/十三夜を自動で描き分け）の古典構成。
		if (moon) {
			const p = put(moon.cel);
			if (p) {
				// 太陽の画面方位：月の天球位置から太陽へ接線方向に一歩進めて再投影（w=0方向の射影は対蹠と縮退するため差分で取る）
				const mc = moon.cel, sc = moon.sunCel, dm = mc[0] * sc[0] + mc[1] * sc[1] + mc[2] * sc[2];
				let tx = sc[0] - mc[0] * dm, ty = sc[1] - mc[1] * dm, tz = sc[2] - mc[2] * dm;
				const tl = Math.hypot(tx, ty, tz) || 1;
				const p2 = put([mc[0] + tx / tl * 0.02, mc[1] + ty / tl * 0.02, mc[2] + tz / tl * 0.02]);
				const th = p2 ? Math.atan2(p2[1] - p[1], p2[0] - p[0]) : 0;
				const R = 8, k = Math.max(0, Math.min(1, moon.k));
				ctx.save();
				ctx.translate(p[0], p[1]); ctx.rotate(th);   // +x＝太陽方向
				ctx.globalAlpha = fade;
				ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
				ctx.fillStyle = "rgb(72,22,15)"; ctx.fill();                     // 欠けている側＝赤黒
				ctx.beginPath();
				ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2);                     // 太陽側の半円
				ctx.scale(Math.max(1e-3, Math.abs(2 * k - 1)) * Math.sign(2 * k - 1 || 1), 1);
				ctx.arc(0, 0, R, Math.PI / 2, Math.PI * 1.5);                    // 終端線＝半楕円（負スケール＝三日月側へ折り返し）
				ctx.fillStyle = "rgb(250,246,232)"; ctx.fill();                  // 輝面＝暖白
				ctx.globalAlpha = 1;
				ctx.restore();
			}
		}
		if (!sky) return;
		if (sky.constellations) {
			ctx.font = `11px ${FONT_STACK}`;
			ctx.fillStyle = `rgba(160,200,255,${0.65 * fade})`;   // v1 border.js と同色
			for (const L of sky.constellations) { const p = put(L.cel); if (p) ctx.fillText(L.name, p[0], p[1]); }
		}
		if (sky.planets) {
			ctx.font = `10px ${FONT_STACK}`;
			ctx.fillStyle = `rgba(255,235,200,${0.85 * fade})`;   // 惑星名＝暖色の白（点の少し下に添える）
			for (const L of sky.planets) { const p = put(L.cel); if (p) ctx.fillText(L.name, p[0], p[1] + 11); }
		}
		if (sky.messier) {
			const sz = 5, P2 = Math.PI * 2;   // v1 の記号語彙：gc=球状星団 gx/gg=銀河 oc=散開星団 他=矩形
			ctx.lineWidth = 0.8;
			ctx.strokeStyle = `rgba(255,200,100,${0.75 * fade})`;
			ctx.font = `8px ${FONT_STACK}`;
			for (const Mo of sky.messier) {
				const p = put(Mo.cel); if (!p) continue;
				const [px, py] = p;
				ctx.beginPath();
				if (Mo.type === "gc") {
					ctx.arc(px, py, sz, 0, P2);
					ctx.moveTo(px - sz, py); ctx.lineTo(px + sz, py);
					ctx.moveTo(px, py - sz); ctx.lineTo(px, py + sz);
					ctx.stroke();
				} else if (Mo.type === "gx" || Mo.type === "gg") {
					ctx.ellipse(px, py, sz * 1.5, sz * 0.6, 0.4, 0, P2); ctx.stroke();
				} else if (Mo.type === "oc") {
					ctx.setLineDash([2, 2]); ctx.arc(px, py, sz, 0, P2); ctx.stroke(); ctx.setLineDash([]);
				} else {
					ctx.rect(px - sz, py - sz, sz * 2, sz * 2); ctx.stroke();
				}
				ctx.fillStyle = `rgba(255,220,150,${0.65 * fade})`;
				ctx.fillText(Mo.name, px, py + sz + 6);
			}
		}
	}

	return { setLabels, setSky, setMoon, draw, clear };
}
