// ラベルを Canvas2D オーバーレイで描く（GL幾何の上に重ねる最前面レイヤ）。
// 衝突判定（どのラベルを出すか）は間引き（recollideMs毎）で安定化し、描画位置は毎フレーム・ライブ投影。
// これで文字は地図と一緒に滑らかに動きつつ、当選集合が安定して明滅しない。距離フェードでフォグと連動。
import { cameraState, project, unproject, lonlatTo3D } from "./camera.js";

const FONT_STACK = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif`;
const ANCH = { center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5], "top-left": [0, 0], "top-right": [1, 0], "bottom-left": [0, 1], "bottom-right": [1, 1] };   // text-anchor＝箱のどの点を錨に置くか（MapLibre）
const css = (c, op = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;
const keyOf = L => (L.k ? L.k + "|" : "") + L.text + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5);   // k＝利用者層 id（層またぎのキー衝突防止）
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
	const hasLS = "letterSpacing" in ctx;   // 字間（Chrome 99+・無い環境は 0 扱い）
	let curFont = "";   // ctx.font の覚え（collide/draw/textLayout で共有＝設定は変わる時だけ）
	const setFont = f => { if (f !== curFont) { ctx.font = curFont = f; } };
	let labels = [];
	const fades = new Map();        // key → 不透明度（フェード）
	let winners = new Map();         // key → L（現在の当選集合。間引きで更新）
	let lastCollide = -1e9, dirty = true, lastShowFlat = true;   // showFlat=傾き閾値下（真俯瞰）だけ測量点等の flat ラベルを出す
	const widthCache = new Map();   // "size|text" → measureText 幅。measureText は高コスト＝再衝突判定(150ms毎)の度に全ラベル分呼ばない
	let labelByKey = new Map();     // key → L（フェードアウト中ラベルの逆引き。draw 毎の線形探索を排除）

	function setLabels(list) {
		labels = list.slice();
		rebuild();
	}
	// ── 利用者層のラベル集合（gint 多層の text-field・2026-09-09）＝基図ラベルと同じ衝突/フェード/標高投影に相乗り。
	// id 別に持ち、層の setVisible/remove と連動。minZoom/maxZoom＝層の属性（ラベルへ焼き込み・collide で裁く）。
	// sort 既定 -1＝利用者データのラベルが基図注記に勝つ（「今載せたデータを見たい」）。
	const userSets = new Map();   // id → { list, visible }
	function rebuild() {
		const u = [];
		for (const st of userSets.values()) if (st.visible) u.push(...st.list);
		// 優先順＝MapLibre の層（ml）は「後の層が先に置く」（層の添字 li の降順）→ 層の中は symbol-sort-key 昇順。ネイティブの層は従来どおり sort だけ（この地図の注記の設計＝sort に焼いてある）。
		// 利用者の層（vtdraw/gint）は sort に −1e6 − 層順×1e3 を焼いてある＝常に基図より先（MapLibre の「後から足した層が勝つ」と同じ）
		const pri = L => (L.sort ?? 0) - (L.mlp && L.li != null ? L.li * 1e3 : 0);
		const all = [...u, ...labels].sort((a, b) => pri(a) - pri(b));
		labelByKey = new Map(all.map(L => [keyOf(L), L]));
		combined = all;
		dirty = true;
	}
	let combined = [];
	function setUserLabels(id, list, meta = {}) {
		if (!list?.length) userSets.delete(id);
		else userSets.set(id, {
			visible: userSets.get(id)?.visible ?? true,
			list: list.map(L => ({ sort: -1, size: 12, color: [0.15, 0.18, 0.22, 1], halo: [1, 1, 1, 0.9], haloW: 2, ...L,
				k: String(id), minZ: meta.minZoom ?? null, maxZ: meta.maxZoom ?? null })),
		});
		rebuild();
	}
	function setUserVisible(id, v) {
		const st = userSets.get(id);
		if (st && st.visible !== !!v) { st.visible = !!v; rebuild(); }
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
	let winBox = new Map();   // key → [sx, sy, tw, h]（当選ラベルの画面上の箱＝placed() の材料・公式例の門 段 0）
	let dbg = { zoom: null, outOfZoom: {}, total: 0 };   // 診断（placedDebug）＝直近の衝突判定の地図 z と、zoom 域で外した数（層の添字/利用者層 id ごと・minZ/maxZ の見本）
	function collide(st, dpr, Wc, Hc, eScale, showFlat, fogF, zoomV) {
		const placed = [], w = new Map(), wb = new Map();
		dbg = { zoom: zoomV, outOfZoom: {}, total: combined.length };
		for (const L of combined) {
			if (L.flat && !showFlat) continue;
			if ((L.minZ != null && zoomV < L.minZ - 1e-3) || (L.maxZ != null && zoomV > L.maxZ + 1e-3)) { const key = L.k ?? ("li" + L.li); const e = dbg.outOfZoom[key] ??= { n: 0, minZ: L.minZ, maxZ: L.maxZ }; e.n++; continue; }   // 層の zoom 域で裁く（利用者層＝meta・基図＝labels.js の minZ/maxZ）。1e-3＝整数の境（MapLibre の zoom 3＝こちらの換算で 2.999998）を落とさない   // 傾けたら測量点(真俯瞰の作法)は当選集合から外す＝以降フェードアウト（等高線と対称）
			const [dx, dy, front] = project(st, L.anchor[0], L.anchor[1], radiusOf(L, eScale, st, fogF));
			if (front < 0) continue;
			const sx = dx / dpr, sy = dy / dpr;
			const shield = shieldFor && shieldFor(L);
			// 箱＝標識ならその絵・文字なら layout（折り返し・字間・行の高さ）で組んだ行の束（textLayout）。錨からの置き方＝text-anchor/offset（variable-anchor は候補を順に試す）
			let tw, h, tl = null;
			if (shield) { tw = shield.w; h = shield.h; }
			else { tl = textLayout(L); tw = tl.w; h = tl.h; }
			const padL = L.pad ?? pad, cands = shield ? [["center", 0, 0]] : anchorCands(L);
			let hit = null;
			for (const [an, ox, oy] of cands) {
				const a = ANCH[an] || ANCH.center, x0 = sx + ox - a[0] * tw, y0 = sy + oy - a[1] * h;   // 箱の左上（錨＋offset を箱のどの点に合わせるか）
				if (x0 + tw < 0 || x0 > Wc || y0 + h < 0 || y0 > Hc) continue;
				const box = [x0 - padL, y0 - padL, x0 + tw + padL, y0 + h + padL];
				if (!L.ov && placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;   // 重なり＝厳密な不等号（接しているだけは重ならない＝MapLibre の格子と同じ）
				hit = { box, x0, y0, an }; break;
			}
			if (!hit) continue;
			if (!L.ig) placed.push(hit.box);   // ignore-placement＝他を押しのけない（自分は置く）
			w.set(keyOf(L), L); wb.set(keyOf(L), [sx, sy, tw, h, hit.x0 - sx, hit.y0 - sy, tl, hit.an]);   // dx,dy＝錨から箱の左上（描く時はライブ投影の錨に足す）
		}
		winners = w; winBox = wb;
	}
	// 錨の候補＝[anchor, 画面 x の足し, y の足し]。text-offset は em（size 倍）。variable-anchor＝候補ごとに錨の反対側へ離す（radial-offset か offset の大きさ・MapLibre と同じ・symbols-2d と同式）
	function anchorCands(L) {
		const size = L.size || 12, off = L.off || [0, 0];
		if (L.va?.length) {
			const r = (L.ro ?? Math.max(Math.abs(off[0]), Math.abs(off[1]))) * size;
			return L.va.map(an => { const k = an.includes("-") ? Math.SQRT1_2 : 1; return [an, (an.includes("left") ? r : an.includes("right") ? -r : 0) * k, (an.startsWith("top") ? r : an.startsWith("bottom") ? -r : 0) * k]; });
		}
		return [[L.an || "center", off[0] * size, off[1] * size]];
	}
	// 文字の行の束（折り返し＝text-max-width（em）・"\n"＝改行・字間＝letter-spacing（em）・行の高さ＝line-height（em））。key で覚える（measureText は高い）
	function textLayout(L) {
		const size = L.size || 12, ls = L.ls || 0, lh = L.lh || 1, mw = L.mw ?? 0;   // layout を持たないラベル（gint・旧い利用者層）＝折り返し無し・行高 1＝従来の箱
		const wk = size + "|" + ls + "|" + mw + "|" + lh + "|" + L.text;
		let tl = widthCache.get(wk);
		if (tl) return tl;
		setFont(`${size}px ${FONT_STACK}`);
		if (hasLS) ctx.letterSpacing = ls ? `${ls * size}px` : "0px";
		const measure = t => ctx.measureText(t).width;
		const maxPx = mw > 0 ? mw * size : Infinity, lines = [];
		for (const para of String(L.text).split("\n")) {
			if (measure(para) <= maxPx || !para) { lines.push(para); continue; }
			// 折り返し（MapLibre の考え方の近似）：空白で区切れる語は語ごと・区切れない（CJK）は字ごとに詰める。行が maxPx を超える手前で折る
			const units = /\s/.test(para) ? para.split(/(\s+)/).filter(Boolean) : [...para];
			let cur = "";
			for (const u of units) { const t = cur + u; if (cur && measure(t.trimEnd()) > maxPx && !/^\s+$/.test(u)) { lines.push(cur.trimEnd()); cur = u.trimStart(); } else cur = t; }
			if (cur.trim()) lines.push(cur.trimEnd());
		}
		const ws = lines.map(measure), w = Math.max(0, ...ws), h = Math.max(1, lines.length) * lh * size;
		tl = { lines, ws, w, h, size, ls, lh };
		widthCache.set(wk, tl);
		if (widthCache.size > 4096) widthCache.clear();   // 念のための上限（テキスト種は高々数千）
		return tl;
	}
	// 置いたラベル（直近の衝突判定の当選集合）＝{ text, lon, lat, x, y（CSS px・中心）, w, h, size, li（基図の層の添字）, set（利用者層の id） }。
	// 公式例の門 段 0（文字を測る）＝本物の queryRenderedFeatures の symbol と突き合わせる材料。描いた物の申告＝描画は変えない
	function placed() {
		const out = [];
		for (const [k, L] of winners) { const b = winBox.get(k); if (!b) continue; out.push({ text: L.text, lon: L.anchor[0], lat: L.anchor[1], x: b[0] + b[4] + b[2] / 2, y: b[1] + b[5] + b[3] / 2, w: b[2], h: b[3], size: L.size, li: L.li ?? null, set: L.k ?? null }); }   // x,y＝箱の中心（錨＋dx,dy＋w/2,h/2）
		return out;
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
		if (dirty || now - lastCollide > recollideMs) { collide(st, dpr, Wc, Hc, eScale, showFlat, fogF, cam.zoom ?? 99); lastCollide = now; dirty = false; }

		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.scale(dpr, dpr);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.miterLimit = 2;
		curFont = "";   // 前のフレームの末尾（星空の注記・標識）が ctx.font を触っている＝覚えを捨てて据え直す

		const fNear = st.camDist * 2, fFar = st.camDist * 9, eye = st.eye;   // 距離フェード（フォグ連動）
		const distOp = (lon, lat) => { const v = lonlatTo3D(lon, lat); const d = Math.hypot(v[0] - eye[0], v[1] - eye[1], v[2] - eye[2]); return 1 - Math.min(1, Math.max(0, (d - fNear) / (fFar - fNear))); };

		let animating = false;
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
			const o = op * distOp(L.anchor[0], L.anchor[1]) * (L.op ?? 1);
			if (o <= 0.01) continue;
			const sx = Math.round(dx / dpr), sy = Math.round(dy / dpr);
			const shield = shieldFor && shieldFor(L);
			if (shield) {
				ctx.globalAlpha = o;
				shield.draw(ctx, sx, sy);   // ベクター直描き（DPRスケール済みctx上＝常にシャープ）
				ctx.globalAlpha = 1;
				continue;
			}
			const b = winBox.get(k), tl = b?.[6] ?? textLayout(L);
			setFont(`${L.size}px ${FONT_STACK}`);   // textLayout が別の書体を据えた後でも、この行の描画は自分の大きさで
			if (hasLS) ctx.letterSpacing = tl.ls ? `${tl.ls * tl.size}px` : "0px";
			// 箱の左上＝ライブ投影の錨＋衝突判定の時の相対位置（winBox の dx,dy）。フェードアウト中（当選集合に無い）は最後の箱の位置＝無ければ中央
			const x0 = b ? sx + b[4] : sx - tl.w / 2, y0 = b ? sy + b[5] : sy - tl.h / 2;
			const just = L.just === "auto" ? ((b?.[7] || L.an || "center").includes("left") ? "left" : (b?.[7] || L.an || "center").includes("right") ? "right" : "center") : (L.just || "center");
			ctx.textAlign = just === "left" ? "left" : just === "right" ? "right" : "center"; ctx.textBaseline = "middle";
			const ax = just === "left" ? x0 : just === "right" ? x0 + tl.w : x0 + tl.w / 2;
			if (L.blur > 0) { ctx.shadowColor = css(L.halo, o); ctx.shadowBlur = L.blur; } else ctx.shadowBlur = 0;
			for (let i = 0; i < tl.lines.length; i++) {
				const ly = y0 + (i + 0.5) * tl.lh * tl.size;
				if (L.haloW > 0) { ctx.strokeStyle = css(L.halo, o); ctx.lineWidth = L.haloW * 2; ctx.strokeText(tl.lines[i], ax, ly); }
				ctx.fillStyle = css(L.color, o); ctx.fillText(tl.lines[i], ax, ly);
			}
			ctx.shadowBlur = 0;
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
			// v1 の記号語彙：gc=球状星団 銀河=楕円 oc=散開星団 他=矩形。銀河は d3-celestial の種別で s/e/i（渦巻・楕円・不規則）
			// で来る＝旧版は gx/gg だけを見ていて銀河が全部矩形になっていた（2026-09-19・packages/space README と solar の messierKind と同じ読み）
			const sz = 5, P2 = Math.PI * 2, GALAXY = new Set(["s", "e", "i", "gx", "gg"]);
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
				} else if (GALAXY.has(Mo.type)) {
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

	function placedDebug() { return dbg; }
	return { setLabels, setUserLabels, setUserVisible, setSky, setMoon, draw, clear, placed, placedDebug };
}
