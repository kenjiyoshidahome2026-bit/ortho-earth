// ラベルを Canvas2D オーバーレイで描く（GL幾何の上に重ねる最前面レイヤ）。
// 衝突判定（どのラベルを出すか）は間引き（recollideMs毎）で安定化し、描画位置は毎フレーム・ライブ投影。
// これで文字は地図と一緒に滑らかに動きつつ、当選集合が安定して明滅しない。距離フェードでフォグと連動。
// 向き（段 5）＝text-rotate・rotation-alignment map・pitch-alignment map＝錨での地面の基底から transform を組む（orient）。線の字は上向きを地面の直角へ。
// 線に沿う注記（symbol-placement line・段 4）も同じ経路＝折れ線を毎フレーム投影して字を線に沿わせる（lineLayout）・字ごとの箱で衝突。
// 記号（icon-image・段 3）も同じ経路＝記号帳（setImage）を名前で引き、文字の箱と一緒に裁く（icon-text-fit・text/icon-optional・icon-allow-overlap/ignore-placement・icon-padding）。
import { cameraState, project, unproject, lonlatTo3D, worldRadiusM } from "./camera.js";
import { clipDistanceM } from "./clip.js";   // 断面（#111 段 3）＝切られた側に錨がある注記は出さない
import { fontCss } from "./fontstack.js";

const FONT_STACK = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",sans-serif`;
const ANCH = { center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5], "top-left": [0, 0], "top-right": [1, 0], "bottom-left": [0, 1], "bottom-right": [1, 1] };   // text-anchor＝箱のどの点を錨に置くか（MapLibre）
const css = (c, op = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * op})`;
const keyOf = L => (L.k ? L.k + "|" : "") + L.text + (L.icon ? "\u0001" + L.icon : "") + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5);   // k＝利用者層 id（層またぎのキー衝突防止）・icon＝記号だけのラベル（text ""）の区別
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
// 伸びる記号（MapLibre の stretchX／stretchY／content）＝icon-text-fit の時、文字の箱 t＝[x0,y0,x1,y1] に余白 p＝[上,右,下,左] を足した箱へ content が重なるよう、伸びる区間だけを同じ倍率で伸ばす（伸びない区間は元の大きさ）。
// 戻り＝{ box:[x0,y0,x1,y1], X, Y, s }（X/Y の segs＝[元の始点, 元の幅, 先の始点, 先の幅]（元 px）・s＝元 px→CSS px）。drawStretched が区間の組ごとに drawImage（9 分割の一般形）。symbols-2d と ortho-core/labels2d に同じ式（overlay は依存ゼロ）
export function stretchFit(im, size, fit, t, p) {
	const s = size / im.pr, W = im.bm.width, H = im.bm.height, c = im.ct || [0, 0, W, H];
	const axis = (zones, len, c0, c1, want) => {
		const Z = (zones || []).filter(z => Array.isArray(z) && z[1] > z[0]);
		const Sc = Z.reduce((a, [z0, z1]) => a + Math.max(0, Math.min(z1, c1) - Math.max(z0, c0)), 0), Fc = (c1 - c0) - Sc;
		const k = want != null && Sc > 0 ? Math.max(0, (want / s - Fc) / Sc) : 1;
		const cuts = [...new Set([0, len, ...Z.flat()])].filter(v => v >= 0 && v <= len).sort((a, b) => a - b), segs = [];
		let d = 0;
		for (let i = 0; i + 1 < cuts.length; i++) { const a = cuts[i], b = cuts[i + 1], st = Z.some(([z0, z1]) => a >= z0 && b <= z1), dw = (b - a) * (st ? k : 1); segs.push([a, b - a, d, dw]); d += dw; }
		const map = x => { for (const [a, w, dd, dw] of segs) if (x <= a + w) return dd + (x - a) * (w ? dw / w : 0); return d; };
		return { segs, total: d, map };
	};
	const X = axis(im.sx, W, c[0], c[2], fit === "height" ? null : t[2] - t[0] + p[1] + p[3]);
	const Y = axis(im.sy, H, c[1], c[3], fit === "width" ? null : t[3] - t[1] + p[0] + p[2]);
	const x0 = fit === "height" ? (t[0] + t[2]) / 2 - X.total * s / 2 : t[0] - p[3] - X.map(c[0]) * s;
	const y0 = fit === "width" ? (t[1] + t[3]) / 2 - Y.total * s / 2 : t[1] - p[0] - Y.map(c[1]) * s;
	return { box: [x0, y0, x0 + X.total * s, y0 + Y.total * s], X, Y, s };
}
function drawStretched(g, src, f, ox = 0, oy = 0) { const x0 = f.box[0] + ox, y0 = f.box[1] + oy; for (const [ax, aw, dx, dw] of f.X.segs) for (const [ay, ah, dy, dh] of f.Y.segs) if (aw > 0 && ah > 0 && dw > 0 && dh > 0) g.drawImage(src, ax, ay, aw, ah, x0 + dx * f.s, y0 + dy * f.s, dw * f.s, dh * f.s); }
export const isStretch = im => !!(im && (im.sx?.length || im.sy?.length || im.ct));


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
	const fontOf = (L, size) => fontCss(L.fnt, size, FONT_STACK);   // ラベルの書体（text-font → family/weight/style・無ければ既定の束）
	// 記号帳（段 3・2026-09-28）＝名前 → { bm: ImageBitmap, pr: pixelRatio, sdf }。main の記号帳（addImage / sprite）の写し＝届いた時に衝突判定をやり直す（名前だけ持って待っていたラベルが出る）
	// SDF の記号は icon-color で塗る（縁 0.7〜0.8＝symbols-2d と同式・名前×色で一度だけ焼いて覚える）
	const images = new Map(), tinted = new Map();
	function setImage(name, { bitmap, pixelRatio = 1, sdf = false, stretchX = null, stretchY = null, content = null }) {
		const prev = images.get(name), pr = pixelRatio || 1;
		images.set(name, { bm: bitmap, pr, sdf: !!sdf, sx: stretchX, sy: stretchY, ct: content });   // sx/sy/ct＝伸びる記号（stretchFit） for (const k of [...tinted.keys()]) if (k.startsWith(name + "|")) tinted.delete(k);
		if (!prev || prev.bm.width !== bitmap.width || prev.bm.height !== bitmap.height || prev.pr !== pr) dirty = true;   // 箱が変わる時だけ衝突判定をやり直す（動く記号＝毎フレームの差し替えで全件の再衝突をしない）
		prev?.bm?.close?.();
	}
	function removeImage(name) { images.delete(name); for (const k of [...tinted.keys()]) if (k.startsWith(name + "|")) tinted.delete(k); dirty = true; }
	function sdfTint(name, im, color) {
		const key = name + "|" + color;
		let c = tinted.get(key);
		if (c) return c;
		const w = im.bm.width, h = im.bm.height, cv = new OffscreenCanvas(w, h), g = cv.getContext("2d");
		g.drawImage(im.bm, 0, 0);
		const px = g.getImageData(0, 0, w, h), a = px.data;
		g.fillStyle = color; g.fillRect(0, 0, 1, 1); const [r, gg, b, al] = g.getImageData(0, 0, 1, 1).data;
		for (let i = 0; i < a.length; i += 4) { const d = a[i + 3] / 255, t = Math.max(0, Math.min(1, (d - 0.7) / 0.1)), sm = t * t * (3 - 2 * t); a[i] = r; a[i + 1] = gg; a[i + 2] = b; a[i + 3] = Math.round(sm * al); }
		g.putImageData(px, 0, 0);
		tinted.set(key, cv);
		return cv;
	}
	const missing = new Set(), reported = new Set();   // 記号帳に無い名前（styleimagemissing の材料）＝takeMissing で 1 回だけ渡す
	const iconImg = L => { if (!L.icon) return null; const im = images.get(L.icon); if (!im && !reported.has(L.icon)) missing.add(L.icon); return im || null; };   // 記号帳に無い名前＝記号は描かない（main が styleimagemissing を鳴らす）＝文字だけ残る
	function takeMissing() { if (!missing.size) return null; const out = [...missing]; for (const n of out) reported.add(n); missing.clear(); return out; }
	// 記号の自然な箱（icon-size 倍・icon-anchor／icon-offset（px×size）で錨に置く）＝[x0, y0, w, h]（錨からの相対）
	const iconBox = (L, im) => { const sz = L.isz ?? 1, w = im.bm.width / im.pr * sz, h = im.bm.height / im.pr * sz, a = ANCH[L.ian] || ANCH.center, off = L.ioff || [0, 0]; return [off[0] * sz - a[0] * w, off[1] * sz - a[1] * h, w, h]; };
	// icon-text-fit＝文字の箱（相対 [x0,y0,w,h]）＋余白（上・右・下・左 px）へ伸ばす（width/height は片方だけ・もう片方は自然の大きさで中央）
	const iconFit = (L, im, t) => {
		if (isStretch(im)) { const f = stretchFit(im, L.isz ?? 1, L.ifit, [t[0], t[1], t[0] + t[2], t[1] + t[3]], L.ifp || [0, 0, 0, 0]), q = f.box, r = [q[0], q[1], q[2] - q[0], q[3] - q[1]]; r.i9 = f; return r; }   // 伸びる記号＝伸びる区間だけ（箱に i9 を添える＝描く側が区間ごとに）
		const [pt, pr, pb, pl] = L.ifp || [0, 0, 0, 0], sz = L.isz ?? 1, nw = im.bm.width / im.pr * sz, nh = im.bm.height / im.pr * sz, cx = t[0] + t[2] / 2, cy = t[1] + t[3] / 2, fit = L.ifit;
		const x0 = fit === "height" ? cx - nw / 2 : t[0] - pl, x1 = fit === "height" ? cx + nw / 2 : t[0] + t[2] + pr, y0 = fit === "width" ? cy - nh / 2 : t[1] - pt, y1 = fit === "width" ? cy + nh / 2 : t[1] + t[3] + pb; return [x0, y0, x1 - x0, y1 - y0]; };
	const overlaps = (placed, box) => placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);   // 重なり＝厳密な不等号（接しているだけは重ならない＝MapLibre の格子と同じ）
	const grow = (b, p) => [b[0] - p, b[1] - p, b[2] + p, b[3] + p];
	// ── 向き（段 5・2026-09-28）＝錨での「地面の基底」：東と南へ画面 20px 相当だけ進めた点を投影した画面ベクトル（列＝東・南＝画面の利き手と同じ）。地図の回転（bearing）・傾き（pitch＝直角方向の縮み）・遠近が入る
	const groundBasis = (st, lon, lat, r, sx, sy, dpr, zoom) => {
		const d = 20 * 360 / (256 * Math.pow(2, zoom ?? 10)), dl = d * Math.max(0.05, Math.cos(lat * Math.PI / 180));
		const e = project(st, lon + d, lat, r), so = project(st, lon, Math.max(-89, lat - dl), r);
		if (e[2] < 0 || so[2] < 0) return null;
		return { a: (e[0] / dpr - sx) / 20, b: (e[1] / dpr - sy) / 20, c: (so[0] / dpr - sx) / 20, d: (so[1] / dpr - sy) / 20 };
	};
	const sigMax = M => { const S = M.a * M.a + M.b * M.b + M.c * M.c + M.d * M.d, D = Math.abs(M.a * M.d - M.b * M.c); return Math.sqrt((S + Math.sqrt(Math.max(0, S * S - 4 * D * D))) / 2); };
	const mul = (m, n) => ({ a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d });
	const rotM = t => ({ a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t) });
	// 点の注記の transform（錨を原点）：rotation-alignment map＝東の向きへ回す・pitch-alignment map＝地面の基底（一番伸びている向きを 1 に正規化＝傾けた直角方向が縮む）・text-rotate＝その上で回す。何も無ければ null
	function orient(st, lon, lat, r, sx, sy, dpr, zoom, ra, pa, rot) {
		if (pa === "auto") pa = ra;
		const th = (rot || 0) * Math.PI / 180;
		if (ra !== "map" && pa !== "map") return th ? rotM(th) : null;
		const M = groundBasis(st, lon, lat, r, sx, sy, dpr, zoom); if (!M) return th ? rotM(th) : null;
		if (pa === "map") { const k = sigMax(M) || 1, T = { a: M.a / k, b: M.b / k, c: M.c / k, d: M.d / k }; return th ? mul(T, rotM(th)) : T; }
		return rotM(Math.atan2(M.b, M.a) + th);   // rotation map・pitch viewport＝回すだけ
	}
	// transform した矩形（原点 (ox,oy)・左上 (lx,ly)・幅 w 高 h）を囲む画面の箱
	const aabb = (T, ox, oy, lx, ly, w, h) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [px, py] of [[lx, ly], [lx + w, ly], [lx, ly + h], [lx + w, ly + h]]) { const x = ox + T.a * px + T.c * py, y = oy + T.b * px + T.d * py; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
	const textT = (L, st, r, sx, sy, dpr, zoom) => (L.rot || L.ra === "map" || L.pa === "map") ? orient(st, L.anchor[0], L.anchor[1], r, sx, sy, dpr, zoom, L.ra === "map" ? "map" : "viewport", L.pa ?? "auto", L.rot) : null;   // 点＝auto は viewport
	const iconT = (L, st, r, sx, sy, dpr, zoom) => (L.ira === "map" || L.ipa === "map") ? orient(st, L.anchor[0], L.anchor[1], r, sx, sy, dpr, zoom, L.ira === "map" ? "map" : "viewport", L.ipa ?? "auto", L.irot) : null;   // 記号＝map の時だけ錨を原点に transform（それ以外の icon-rotate は箱の中心で回す＝従来）
	// ── 線に沿う注記（段 4・2026-09-28）＝折れ線（経緯度・labels.js の path）を画面（CSS px）へ投影し、錨（path[ai]）を中心に字を 1 字ずつ線の上へ置く。
	// null＝置けない（裏側・窓に収まらない・隣の字との角が text-max-angle を超える）。keep-upright＝並びが右から左になる時は逆から並べる（字は常に正立）。
	// text-offset の y＝線と直角の向き（em）。字送りは measureText（font×字で覚える）＋letter-spacing。毎フレーム投影し直す（点の注記と同じくライブ）
	const advCache = new Map();
	const advOf = (font, ch) => { const k = font + "\u0001" + ch; let v = advCache.get(k); if (v == null) { if (advCache.size > 8192) advCache.clear(); setFont(font); if (hasLS) ctx.letterSpacing = "0px"; v = ctx.measureText(ch).width; advCache.set(k, v); } return v; };
	// 記号（icon）は錨に置く＝線の向きに回す（icon-rotation-alignment auto/map＋icon-rotate）か正立（viewport）。文字が無い層（road_oneway の矢印）は記号だけ
	let nullWhy = "", fitDbg = null, angDbg = null;   // 診断＝lineLayout が null を返した理由（placedDebug の line）
	function lineLayout(L, st, dpr, r, zoom) {
		const P = L.path, n = P.length >> 1; if (n < 2) { nullWhy = "empty"; return null; }
		const im = iconImg(L), chars = L.text ? [...String(L.text)] : [];
		if (!chars.length && !im) { nullWhy = "empty"; return null; }
		// 投影＝錨を含む「表側の連続区間」だけ使う（全球ビューの赤道など＝窓の端が地球の裏に届いても錨の周りは置ける・旧＝裏の頂点が 1 つでもあれば丸ごと却下）。
		// 重なる点＝長さ 0 の線分は捨てる（錨が頂点と一致した時に角度が跳んで max-angle で落ちていた）。s0＝錨の弧長
		const ai = Math.min(L.ai ?? 0, n - 1), pr = new Array(n);
		for (let i = 0; i < n; i++) pr[i] = project(st, P[i * 2], P[i * 2 + 1], r);
		if (pr[ai][2] < 0) { nullWhy = "back"; return null; }
		let lo = ai, hi = ai; while (lo > 0 && pr[lo - 1][2] >= 0) lo--; while (hi < n - 1 && pr[hi + 1][2] >= 0) hi++;
		const xs = [], ys = [], cum = [];
		let s0 = 0;
		for (let i = lo; i <= hi; i++) {
			const [dx, dy] = pr[i];
			const x = dx / dpr, y = dy / dpr, k = xs.length;
			if (k && Math.hypot(x - xs[k - 1], y - ys[k - 1]) < 1e-3) { if (i === ai) s0 = cum[k - 1]; continue; }
			xs.push(x); ys.push(y); cum.push(k ? cum[k - 1] + Math.hypot(x - xs[k - 1], y - ys[k - 1]) : 0);
			if (i === ai) s0 = cum[k];
		}
		const m_n = xs.length; if (m_n < 2) { nullWhy = "empty"; return null; }
		const total = cum[m_n - 1]; if (!(total > 0)) { nullWhy = "empty"; return null; }
		const size = L.size || 12, font = fontOf(L, size), ls = (L.ls || 0) * size;
		const adv = chars.map(ch => advOf(font, ch) + ls), W = chars.length ? adv.reduce((a, b) => a + b, 0) - ls : 0;
		// 錨の弧長 s0 は、文字が窓（labels.js が焼いた前後の長さ・地球の縁で切れた分も）に収まる範囲へ寄せる（旧＝錨に固定＝縁の近くや短い窓で「fit」で落ちた。候補はタイルの目盛りで疎＝寄せて拾う。symbol-spacing は寄せた後の位置で裁く）
		if (W > total) { nullWhy = "fit"; fitDbg = [Math.round(s0), Math.round(W), Math.round(total), L.text, size, L.ls || 0, n, lo, hi]; return null; }
		s0 = Math.min(Math.max(s0, W / 2), total - W / 2);
		const at = q => { let i = 1; while (i < m_n - 1 && cum[i] < q) i++; const t = (q - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [xs[i - 1] + (xs[i] - xs[i - 1]) * t, ys[i - 1] + (ys[i] - ys[i - 1]) * t, Math.atan2(ys[i] - ys[i - 1], xs[i] - xs[i - 1])]; };
		const m = at(s0);
		let rev = false;
		if (chars.length && L.ku !== false) { const a = at(s0 - W / 2), b = at(s0 + W / 2); rev = b[0] < a[0]; }
		const g = [], ma = (L.ma ?? 45) * Math.PI / 180, oy = (L.off?.[1] || 0) * size;
		let q = s0 - W / 2, prev = null;
		// 字の向き＝字の中心を挟む弦（幅＝max(字送り, 1.5 字)＝微小な線分の向きは字ごとに振れる＝小川のジグザグで max-angle に当たっていた・タイルの z が MapLibre より細かい分だけ折れ線が粗い）。弦が潰れていれば線分の向き
		const chord = (q0, q1) => { const p0 = at(Math.max(0, q0)), p1 = at(Math.min(total, q1)), dx = p1[0] - p0[0], dy = p1[1] - p0[1]; return dx * dx + dy * dy > 1e-6 ? Math.atan2(dy, dx) : p1[2]; };
		for (let i = 0; i < chars.length; i++) {
			const k = rev ? chars.length - 1 - i : i, half = adv[k] / 2, cw = Math.max(adv[k], size * 1.5) / 2;
			const [x, y] = at(q + half), a0 = chord(q + half - cw, q + half + cw), a = rev ? a0 + Math.PI : a0;
			if (prev != null) { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; if (Math.abs(d) > ma) { nullWhy = "angle"; if (!angDbg) angDbg = { text: L.text, i, q: Math.round(q), s0: Math.round(s0), W: Math.round(W), total: Math.round(total), a: Math.round(a * 180 / Math.PI), prev: Math.round(prev * 180 / Math.PI), rev, pts: xs.map((x, j) => [Math.round(x), Math.round(ys[j]), Math.round(cum[j])]), gl: g.map(c => [Math.round(c.x), Math.round(c.y), Math.round(c.a * 180 / Math.PI)]) }; return null; } }
			prev = a;
			g.push({ ch: chars[k], x: x - Math.sin(a) * oy, y: y + Math.cos(a) * oy, a, w: adv[k] - ls });
			q += adv[k];
		}
		if (rev) g.reverse();
		// 字の transform（段 5）：pitch-alignment map（既定）＝字の上向きを「地面で線と直角」の向きへ（傾けると字が地面に寝る）。viewport＝画面で直角（回すだけ）。rotation-alignment viewport-glyph＝字は正立のまま線に沿って並ぶ
		const paMap = L.ra !== "viewport-glyph" && (L.pa ?? "auto") !== "viewport", M = paMap && g.length ? groundBasis(st, P[ai * 2], P[ai * 2 + 1], r, m[0], m[1], dpr, zoom) : null, det = M ? M.a * M.d - M.b * M.c : 0;
		for (const c of g) {
			if (L.ra === "viewport-glyph") { c.a = 0; c.t = null; continue; }
			if (M && Math.abs(det) > 1e-9) { const dx = Math.cos(c.a), dy = Math.sin(c.a), gx = (M.d * dx - M.c * dy) / det, gy = (-M.b * dx + M.a * dy) / det, px = -gy, py = gx; c.t = { a: dx, b: dy, c: M.a * px + M.c * py, d: M.b * px + M.d * py }; }   // 地面の向き d_g＝M⁻¹d_s・直角 p_g＝rot90(d_g)・画面へ M
			else c.t = rotM(c.a);
		}
		let icon = null;
		if (im) { const sz = L.isz ?? 1, iw = im.bm.width / im.pr * sz, ih = im.bm.height / im.pr * sz, a0 = chord(Math.max(0, s0 - iw / 2), Math.min(total, s0 + iw / 2)), a = (L.ira === "viewport" ? 0 : (rev ? a0 + Math.PI : a0)) + (L.irot || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)); icon = { x: m[0], y: m[1], a, w: iw, h: ih, bw: iw * c + ih * sn, bh: iw * sn + ih * c }; }   // bw/bh＝回した記号を囲む箱
		const ang = prev ?? m[2];
		return { g, w: W, h: size, x: m[0] - Math.sin(ang) * oy, y: m[1] + Math.cos(ang) * oy, font, icon };
	}
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
	// 標高の付け直し（DEM が後から届いた・生き替わった時＝render worker が呼ぶ）：基図と利用者層の全ラベルに fn(L) の標高を入れ、衝突判定をやり直す
	function setElev(fn) { for (const L of labels) L.elev = fn(L); for (const st of userSets.values()) for (const L of st.list) L.elev = fn(L); dirty = true; }
	function setUserVisible(id, v) {
		const st = userSets.get(id);
		if (st && st.visible !== !!v) { st.visible = !!v; rebuild(); }
	}
	// 星空劇場の注記（星座名・メシエ天体）。データは { constellations:[{cel,name}], messier:[{cel,name,type}] }、
	// cel＝天球単位ベクトル（RA/Dec焼き込み・アプリが供給）。null＝非表示（星座線のトグルと同期）。
	let sky = null;
	function setSky(data) { sky = data; }
	// 断面（#111 段 3）：面（clip.js clipPlanes の列・null＝切らない）。錨（標高の持ち上げ込み）が切られた側の注記は当選集合に入れない
	let clipPl = null;
	function setClip(planes) { clipPl = planes && planes.length ? planes : null; dirty = true; }
	// 月＝満ち欠けの円盤（注記トグルと独立＝天体なので常設）。{ cel, sunCel, k }＝方向・太陽方向・輝面比。
	let moon = null;
	function setMoon(data) { moon = data; }
	function clear() {
		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
		fades.clear(); winners.clear();
	}

	// 衝突判定（優先度順の貪欲）。当選集合 winners を更新。
	let winBox = new Map();   // key → { sx, sy, tw, h, dx, dy, tl, an, txt, ib }（当選ラベルの画面上の箱＝placed() と draw の材料・公式例の門 段 0）。txt＝文字を置いた・ib＝置いた記号の箱 [dx, dy, w, h]（錨からの相対）
	let dbg = { zoom: null, outOfZoom: {}, total: 0 };   // 診断（placedDebug）＝直近の衝突判定の地図 z と、zoom 域で外した数（層の添字/利用者層 id ごと・minZ/maxZ の見本）
	function collide(st, dpr, Wc, Hc, eScale, showFlat, fogF, zoomV) {
		const placed = [], w = new Map(), wb = new Map(), lineGrp = new Map();   // lineGrp＝線の注記の群（層＋文字）→ 置いた位置＝symbol-spacing（画面 px）を課す
		dbg = { zoom: zoomV, outOfZoom: {}, total: combined.length, line: { n: 0, layout: 0, off: 0, overlap: 0, spacing: 0, ok: 0 }, pt: {} };   // line＝線の注記の落ちた理由・pt＝点の注記の層ごとの結果（診断）
		const ptDbg = (L, k, eg) => { const key = L.k ?? ("li" + L.li), e = dbg.pt[key] ??= { n: 0, back: 0, noimg: 0, text: 0, icon: 0, off: 0, spacing: 0, ok: 0 }; e[k]++; if (k !== "n") e.n++; if (eg && !e[k + "Eg"]) e[k + "Eg"] = eg; };
		for (const L of combined) {
			if (L.flat && !showFlat) continue;
			if ((L.minZ != null && zoomV < L.minZ - 1e-3) || (L.maxZ != null && zoomV > L.maxZ + 1e-3)) { const key = L.k ?? ("li" + L.li); const e = dbg.outOfZoom[key] ??= { n: 0, minZ: L.minZ, maxZ: L.maxZ }; e.n++; continue; }   // 層の zoom 域で裁く（利用者層＝meta・基図＝labels.js の minZ/maxZ）。1e-3＝整数の境（MapLibre の zoom 3＝こちらの換算で 2.999998）を落とさない   // 傾けたら測量点(真俯瞰の作法)は当選集合から外す＝以降フェードアウト（等高線と対称）
			const rad = radiusOf(L, eScale, st, fogF), [dx, dy, front] = project(st, L.anchor[0], L.anchor[1], rad);
			if (clipPl && clipDistanceM(clipPl, L.anchor[0], L.anchor[1], (rad - 1) * worldRadiusM()) < 0) continue;   // 断面で切られた側（#111 段 3）
			if (front < 0) { if (!L.lp) ptDbg(L, "back", [String(L.text).slice(0, 20), +L.anchor[0].toFixed(2), +L.anchor[1].toFixed(2), +front.toFixed(3), +rad.toFixed(4)]); continue; }
			const sx = dx / dpr, sy = dy / dpr;
			if (L.lp) {   // 線に沿う注記（段 4）＝字ごとの箱（text-padding 込み）で裁く。全部の字が画面の外なら出さない
				const dl = dbg.line; dl.n++;
				const lb = (dbg.lineBy ??= {})[L.k ?? ("li" + L.li)] ??= { n: 0, layout: 0, off: 0, overlap: 0, spacing: 0, ok: 0 }; lb.n++;   // 層ごと（診断）
				const ll = lineLayout(L, st, dpr, rad, zoomV); if (!ll) { dl.layout++; lb.layout++; dl[nullWhy] = (dl[nullWhy] || 0) + 1; if (nullWhy === "fit" && !dl.fitEg) dl.fitEg = fitDbg; if (angDbg && !dl.angEg) dl.angEg = angDbg; continue; }
				const padL = L.pad ?? pad, boxes = ll.g.map(c => grow(c.t ? aabb(c.t, c.x, c.y, -c.w / 2, -ll.h / 2, c.w, ll.h) : [c.x - c.w / 2, c.y - ll.h / 2, c.x + c.w / 2, c.y + ll.h / 2], padL));
				let bb = null; for (const b of boxes) bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])] : b.slice();   // 全部の字を囲む箱（placed の w/h）
				if (ll.icon) { const ic = ll.icon, ip = L.ipad ?? 2; boxes.push([ic.x - ic.bw / 2 - ip, ic.y - ic.bh / 2 - ip, ic.x + ic.bw / 2 + ip, ic.y + ic.bh / 2 + ip]); }   // 記号の箱（icon-padding）＝文字と一緒に裁く（両方置けなければ出さない）
				if (boxes.every(b => b[2] < 0 || b[0] > Wc || b[3] < 0 || b[1] > Hc)) { dl.off++; lb.off++; continue; }
				if (!L.ov && boxes.some(b => overlaps(placed, b))) { dl.overlap++; lb.overlap++; continue; }
				const grp = L.sp ? (L.k ?? "b" + L.li) + "\u0001" + (L.lg ?? L.text) : null, ga = grp ? lineGrp.get(grp) : null;   // 群＝1 本の線（lg）・無ければ文字
				if (ga && ga.some(p => Math.hypot(p[0] - ll.x, p[1] - ll.y) < L.sp)) { dl.spacing++; lb.spacing++; continue; }   // symbol-spacing＝同じ文字の線の注記は画面 px でこの間隔より近くに置かない（候補はタイルが細かく焼く＝表示 z に追随）
				if (grp) { if (ga) ga.push([ll.x, ll.y]); else lineGrp.set(grp, [[ll.x, ll.y]]); }
				if (!L.ig) for (const b of boxes) placed.push(b);
				dl.ok++; lb.ok++;
				w.set(keyOf(L), L); wb.set(keyOf(L), { sx, sy, tw: ll.w, h: ll.h, dx: ll.x - sx - ll.w / 2, dy: ll.y - sy - ll.h / 2, tl: null, an: "center", txt: ll.g.length > 0, ib: null, ln: ll, bb: bb ? [bb[2] - bb[0] - 2 * padL, bb[3] - bb[1] - 2 * padL] : null });
				continue;
			}
			const shield = shieldFor && shieldFor(L), im = iconImg(L), hasText = !!shield || !!(L.text && String(L.text).length);
			if (!hasText && !im) { ptDbg(L, "noimg"); continue; }   // 記号だけのラベルで記号帳にまだ無い＝出さない（届いたら setImage が dirty にする）
			// 箱＝標識ならその絵・文字なら layout（折り返し・字間・行の高さ）で組んだ行の束（textLayout）。錨からの置き方＝text-anchor/offset（variable-anchor は候補を順に試す）
			let tw = 0, h = 0, tl = null;
			if (shield) { tw = shield.w; h = shield.h; }
			else if (hasText) { tl = textLayout(L); tw = tl.w; h = tl.h; }
			const padL = L.pad ?? pad, ipad = L.ipad ?? 2;
			const T = textT(L, st, rad, sx, sy, dpr, zoomV), Ti = im ? (iconT(L, st, rad, sx, sy, dpr, zoomV) ?? T) : null;   // 向き（段 5）＝文字の transform・記号は自分の map 指定があればそれ・無ければ文字と同じ
			const tb = (Tm, lx, ly, w, h) => Tm ? aabb(Tm, sx, sy, lx, ly, w, h) : [sx + lx, sy + ly, sx + lx + w, sy + ly + h];   // 錨からの箱 → 画面の箱（transform 込み）
			// 記号と文字の裁き（MapLibre の placement と同じ）：既定＝両方置けなければ両方出さない。text-optional＝記号だけでも出す・icon-optional＝文字だけでも出す
			const iconAlone = L.topt || !hasText, textAlone = L.iopt || !im;
			const judge = (tOK, iOK) => !textAlone && !iconAlone ? [tOK && iOK, tOK && iOK] : !textAlone ? [tOK && iOK, iOK] : !iconAlone ? [tOK, iOK && tOK] : [tOK, iOK];   // → [文字を置く, 記号を置く]
			const nat = im ? iconBox(L, im) : null;   // 記号の自然な箱（fit しない時＝候補に依らない）
			const iOKof = ib => !im || L.iov || !overlaps(placed, grow(tb(Ti, ib[0], ib[1], ib[2], ib[3]), ipad));
			let hit = null, lastWhy = "off";
			if (hasText) {
				const cands = shield ? [["center", 0, 0]] : anchorCands(L);
				for (const [an, ox, oy] of cands) {
					const a = ANCH[an] || ANCH.center, lx0 = ox - a[0] * tw, ly0 = oy - a[1] * h, x0 = sx + lx0, y0 = sy + ly0;   // 箱の左上（錨＋offset を箱のどの点に合わせるか）
					const bb = tb(T, lx0, ly0, tw, h);
					if (bb[2] < 0 || bb[0] > Wc || bb[3] < 0 || bb[1] > Hc) continue;
					const box = grow(bb, padL);
					const ib = im ? (L.ifit ? iconFit(L, im, [x0 - sx, y0 - sy, tw, h]) : nat) : null;
					const tOK = L.ov || !overlaps(placed, box), iOK = iOKof(ib), [pt, pi] = judge(tOK, iOK);
					if (!pt) { lastWhy = !tOK ? "text" : !iOK ? "icon" : "text"; continue; }   // 文字が置けない候補＝次の候補（variable-anchor）
					hit = { box, x0, y0, an, txt: true, ib: pi ? ib : null, bb: [bb[2] - bb[0], bb[3] - bb[1]] }; break;
				}
				if (!hit && im && iconAlone) { const [, pi] = judge(false, iOKof(nat)); if (pi) hit = { box: null, x0: sx, y0: sy, an: L.an || "center", txt: false, ib: nat }; }   // 文字はどの候補も置けない＝text-optional なら記号だけ
			} else { const [, pi] = judge(false, iOKof(nat)), nb = tb(Ti, nat[0], nat[1], nat[2], nat[3]); if (pi && !(nb[2] < 0 || nb[0] > Wc || nb[3] < 0 || nb[1] > Hc)) hit = { box: null, x0: sx, y0: sy, an: "center", txt: false, ib: nat }; }
			if (!hit) { ptDbg(L, hasText ? lastWhy : "icon", [String(L.text).slice(0, 20), Math.round(sx), Math.round(sy), Math.round(tw), Math.round(h), Math.round(Wc), Math.round(Hc)]); continue; }
			if (L.sp) {   // 線の錨に回さず置く注記（text-rotation-alignment viewport＝道路の盾）＝symbol-spacing を同じ群に課す
				const grp = (L.k ?? "b" + L.li) + "\u0001" + (L.lg ?? L.text + "\u0001" + (L.icon || "")), ga = lineGrp.get(grp);
				if (ga && ga.some(p => Math.hypot(p[0] - sx, p[1] - sy) < L.sp)) { ptDbg(L, "spacing"); continue; }
				if (ga) ga.push([sx, sy]); else lineGrp.set(grp, [[sx, sy]]);
			}
			ptDbg(L, "ok");
			if (hit.txt && !L.ig) placed.push(hit.box);   // ignore-placement＝他を押しのけない（自分は置く）
			if (hit.ib && !L.iig) placed.push(grow(tb(Ti, hit.ib[0], hit.ib[1], hit.ib[2], hit.ib[3]), ipad));
			w.set(keyOf(L), L); wb.set(keyOf(L), { sx, sy, tw, h, dx: hit.x0 - sx, dy: hit.y0 - sy, tl, an: hit.an, txt: hit.txt, ib: hit.ib, bb: hit.bb ?? null, ibb: hit.ib ? (q => [q[2] - q[0], q[3] - q[1]])(tb(Ti, hit.ib[0], hit.ib[1], hit.ib[2], hit.ib[3])) : null });   // dx,dy＝錨から箱の左上（描く時はライブ投影の錨に足す）
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
		const font = fontOf(L, size), wk = font + "|" + ls + "|" + mw + "|" + lh + "|" + L.text;
		let tl = widthCache.get(wk);
		if (tl) return tl;
		setFont(font);
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
		tl = { lines, ws, w, h, size, ls, lh, font };
		widthCache.set(wk, tl);
		if (widthCache.size > 4096) widthCache.clear();   // 念のための上限（テキスト種は高々数千）
		return tl;
	}
	// 置いたラベル（直近の衝突判定の当選集合）＝{ text, lon, lat, x, y（CSS px・中心）, w, h, size, li（基図の層の添字）, set（利用者層の id） }。
	// 公式例の門 段 0（文字を測る）＝本物の queryRenderedFeatures の symbol と突き合わせる材料。描いた物の申告＝描画は変えない
	// 記号（段 3）＝icon（置いた記号の名前・置けなかった／無い＝null）・ibox＝[中心 x, 中心 y, w, h]。文字を置いていないラベル（記号だけ）は text null・x,y,w,h＝記号の箱
	function placed() {
		const out = [];
		for (const [k, L] of winners) {
			const b = winBox.get(k); if (!b) continue;
			const ibox = b.ib ? [b.sx + b.ib[0] + b.ib[2] / 2, b.sy + b.ib[1] + b.ib[3] / 2, ...(b.ibb ?? [b.ib[2], b.ib[3]])] : b.ln?.icon ? [b.ln.icon.x, b.ln.icon.y, b.ln.icon.bw, b.ln.icon.bh] : null;
			const bx = b.txt ? [b.sx + b.dx + b.tw / 2, b.sy + b.dy + b.h / 2, ...(b.bb ?? [b.tw, b.h])] : ibox;   // w,h＝画面の箱（向きの transform 込み・段 5）
			out.push({ text: b.txt ? L.text : null, icon: (b.ib || b.ln?.icon) ? L.icon : null, ibox, line: !!b.ln, lon: L.anchor[0], lat: L.anchor[1], x: bx[0], y: bx[1], w: bx[2], h: bx[3], size: L.size, li: L.li ?? null, set: L.k ?? null, font: b.txt ? (b.tl?.font ?? b.ln?.font ?? null) : null });   // line＝線に沿う注記（x,y＝錨の字の位置・w＝字送りの和）   // x,y＝箱の中心（錨＋dx,dy＋w/2,h/2）・font＝据えた書体（検定）
		}
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
			const b = winBox.get(k);
			if (L.lp) {   // 線に沿う注記（段 4）＝毎フレーム投影し直して字ごとに回して描く（フェードアウト中も同じ）。裏へ回った・角が急＝描かない
				const ll = lineLayout(L, st, dpr, radiusOf(L, eScale, st, fogF), cam.zoom); if (!ll) continue;
				if (ll.icon) {   // 線の記号＝錨で線の向きに回す（viewport なら正立）・SDF は icon-color
					const im = iconImg(L), ic = ll.icon, oi = op * distOp(L.anchor[0], L.anchor[1]) * (L.iop ?? 1);
					if (im && oi > 0.01) { const src = im.sdf ? sdfTint(L.icon, im, css(L.icol || [0, 0, 0, 1])) : im.bm; ctx.save(); ctx.globalAlpha = oi; ctx.translate(ic.x, ic.y); ctx.rotate(ic.a); ctx.drawImage(src, -ic.w / 2, -ic.h / 2, ic.w, ic.h); ctx.restore(); }
				}
				if (!ll.g.length) continue;
				setFont(ll.font); if (hasLS) ctx.letterSpacing = "0px";
				ctx.textAlign = "center"; ctx.textBaseline = "middle";
				if (L.blur > 0) { ctx.shadowColor = css(L.halo, o); ctx.shadowBlur = L.blur; } else ctx.shadowBlur = 0;
				const halo = L.haloW > 0 ? css(L.halo, o) : null, fill = css(L.color, o);
				for (const c of ll.g) {
					ctx.save(); ctx.translate(c.x, c.y); if (c.t) ctx.transform(c.t.a, c.t.b, c.t.c, c.t.d, 0, 0); else ctx.rotate(c.a);
					if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = L.haloW * 2; ctx.strokeText(c.ch, 0, 0); }
					ctx.fillStyle = fill; ctx.fillText(c.ch, 0, 0);
					ctx.restore();
				}
				ctx.shadowBlur = 0;
				continue;
			}
			// 記号（段 3）＝当選の箱（fit 済み）・フェードアウト中は自然な箱。SDF は icon-color で焼いた写し・icon-rotate は箱の中心で回す・icon-opacity
			const im = iconImg(L), ib = b ? b.ib : (im ? iconBox(L, im) : null);
			const rad = radiusOf(L, eScale, st, fogF), T = textT(L, st, rad, sx, sy, dpr, cam.zoom), Ti = im ? (iconT(L, st, rad, sx, sy, dpr, cam.zoom) ?? T) : null;   // 向き（段 5）＝毎フレーム（回転・傾きに追随）
			if (im && ib) {
				const src = im.sdf ? sdfTint(L.icon, im, css(L.icol || [0, 0, 0, 1])) : im.bm, oi = op * distOp(L.anchor[0], L.anchor[1]) * (L.iop ?? 1);
				if (oi > 0.01) {
					ctx.globalAlpha = oi;
					if (ib.i9) { if (Ti) { ctx.save(); ctx.translate(sx, sy); ctx.transform(Ti.a, Ti.b, Ti.c, Ti.d, 0, 0); drawStretched(ctx, src, ib.i9); ctx.restore(); } else drawStretched(ctx, src, ib.i9, sx, sy); }   // 伸びる記号＝区間ごと（9 分割）
					else if (Ti) { ctx.save(); ctx.translate(sx, sy); ctx.transform(Ti.a, Ti.b, Ti.c, Ti.d, 0, 0); ctx.drawImage(src, ib[0], ib[1], ib[2], ib[3]); ctx.restore(); }   // 錨を原点に transform（map の向き・傾き）
					else if (L.irot) { ctx.save(); ctx.translate(sx + ib[0] + ib[2] / 2, sy + ib[1] + ib[3] / 2); ctx.rotate(L.irot * Math.PI / 180); ctx.drawImage(src, -ib[2] / 2, -ib[3] / 2, ib[2], ib[3]); ctx.restore(); }
					else ctx.drawImage(src, sx + ib[0], sy + ib[1], ib[2], ib[3]);
					ctx.globalAlpha = 1;
				}
			}
			if (!(L.text && String(L.text).length) || (b && !b.txt)) continue;   // 文字が無い・置かなかった（text-optional）
			const tl = b?.tl ?? textLayout(L);
			setFont(tl.font || fontOf(L, L.size));   // textLayout が別の書体を据えた後でも、この行の描画は自分の書体で
			if (hasLS) ctx.letterSpacing = tl.ls ? `${tl.ls * tl.size}px` : "0px";
			// 箱の左上＝ライブ投影の錨＋衝突判定の時の相対位置（winBox の dx,dy）。フェードアウト中（当選集合に無い）は最後の箱の位置＝無ければ中央。向きの transform があれば錨を原点に描く（段 5）
			const ox = T ? 0 : sx, oy = T ? 0 : sy;
			if (T) { ctx.save(); ctx.translate(sx, sy); ctx.transform(T.a, T.b, T.c, T.d, 0, 0); }
			const x0 = b ? ox + b.dx : ox - tl.w / 2, y0 = b ? oy + b.dy : oy - tl.h / 2;
			const just = L.just === "auto" ? ((b?.an || L.an || "center").includes("left") ? "left" : (b?.an || L.an || "center").includes("right") ? "right" : "center") : (L.just || "center");
			ctx.textAlign = just === "left" ? "left" : just === "right" ? "right" : "center"; ctx.textBaseline = "middle";
			const ax = just === "left" ? x0 : just === "right" ? x0 + tl.w : x0 + tl.w / 2;
			if (L.blur > 0) { ctx.shadowColor = css(L.halo, o); ctx.shadowBlur = L.blur; } else ctx.shadowBlur = 0;
			for (let i = 0; i < tl.lines.length; i++) {
				const ly = y0 + (i + 0.5) * tl.lh * tl.size;
				if (L.haloW > 0) { ctx.strokeStyle = css(L.halo, o); ctx.lineWidth = L.haloW * 2; ctx.strokeText(tl.lines[i], ax, ly); }
				ctx.fillStyle = css(L.color, o); ctx.fillText(tl.lines[i], ax, ly);
			}
			ctx.shadowBlur = 0;
			if (T) ctx.restore();
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
	function clearFontCache() { widthCache.clear(); curFont = ""; dirty = true; }   // 書体が載った（addFontFace）＝幅の覚えを捨てて衝突判定からやり直す
	return { setLabels, setUserLabels, setUserVisible, setElev, setSky, setClip, setMoon, setImage, removeImage, takeMissing, draw, clear, placed, placedDebug, clearFontCache };
}
