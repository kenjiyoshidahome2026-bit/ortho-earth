// 記号（sprite の icon-image）と文字の層＝canvas2D のオーバーレイ（MapLibre の symbol 層相当・2026-09-21）。
// main（gadgets/symbols.js）が記号帳（名前→ImageBitmap・pixelRatio・sdf）と、評価済みの記号の列を渡す。ここは毎フレーム投影して、
// 重なり判定（icon/text-allow-overlap＝false が既定＝MapLibre と同じ「先に置いたものが勝つ」・symbol-sort-key 昇順）をして描く。
// SDF の記号＝icon-color で塗る（縁＝0.75＝MapLibre と同じしきい値・色ごとに一度だけ焼いて覚える）。地球の裏側は描かない。
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size, api) / destroy()。依存ゼロ。

let ctx = null, images = new Map(), layers = new Map(), tinted = new Map();
let lastPlaced = [];   // 直近のフレームで置いた記号＝{ layer, text, icon, lon, lat, x, y, w, h }（公式例の門 段 0＝文字を測る材料。描画は変えない）
export function placed() { return lastPlaced; }
export function init(canvas) { ctx = canvas.getContext("2d"); }
// data＝{ type:"image", name, bitmap, pixelRatio, sdf } | { type:"removeImage", name } | { type:"layer", id, items:[…], order } | { type:"removeLayer", id }
export function message(d) {
	if (d.type === "image") { images.get(d.name)?.bm?.close?.(); images.set(d.name, { bm: d.bitmap, pr: d.pixelRatio || 1, sdf: !!d.sdf, sx: d.stretchX || null, sy: d.stretchY || null, ct: d.content || null }); for (const k of [...tinted.keys()]) if (k.startsWith(d.name + "|")) tinted.delete(k); }   // 古い絵は閉じる（動く記号＝毎フレーム差し替え）
	else if (d.type === "removeImage") images.delete(d.name);
	else if (d.type === "layer") layers.set(d.id, { id: d.id, items: d.items, order: d.order ?? 0 });
	else if (d.type === "removeLayer") layers.delete(d.id);
}
// 伸びる記号（MapLibre の stretchX／stretchY／content）＝icon-text-fit の時、文字の箱 t＝[x0,y0,x1,y1] に余白 p＝[上,右,下,左] を足した箱へ content が重なるよう、伸びる区間だけを同じ倍率で伸ばす（伸びない区間は元の大きさ）。
// 戻り＝{ box:[x0,y0,x1,y1], X, Y, s }（X/Y の segs＝[元の始点, 元の幅, 先の始点, 先の幅]（元 px）・s＝元 px→CSS px）。drawStretched が区間の組ごとに drawImage（9 分割の一般形）。symbols-2d と ortho-core/labels2d に同じ式（overlay は依存ゼロ）
function stretchFit(im, size, fit, t, p) {
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
const isStretch = im => !!(im && (im.sx?.length || im.sy?.length || im.ct));
// 文字の行の束（ortho-core/labels2d の textLayout と同じ考え方＝"\n"・text-max-width（em）で折る・空白で区切れる語は語ごと・CJK は字ごと）。font＋設定＋文字で覚える
const layouts = new Map();
function layoutText(it) {
	const font = fontOf(it), size = it.textSize, mw = it.textMaxWidth || 0, lh = it.textLineHeight || 1.2, ls = it.textLetterSpacing || 0, key = font + "\u0001" + mw + "|" + lh + "|" + ls + "\u0001" + it.text;
	let tl = layouts.get(key); if (tl) return tl;
	if (layouts.size > 20000) layouts.clear();
	ctx.font = font; if ("letterSpacing" in ctx) ctx.letterSpacing = ls ? `${ls * size}px` : "0px";
	const measure = t => ctx.measureText(t).width, maxPx = mw > 0 ? mw * size : Infinity, lines = [];
	for (const para of String(it.text).split("\n")) {
		if (measure(para) <= maxPx || !para) { lines.push(para); continue; }
		const units = /\s/.test(para) ? para.split(/(\s+)/).filter(Boolean) : [...para];
		let cur = "";
		for (const u of units) { const t = cur + u; if (cur && measure(t.trimEnd()) > maxPx && !/^\s+$/.test(u)) { lines.push(cur.trimEnd()); cur = u.trimStart(); } else cur = t; }
		if (cur.trim()) lines.push(cur.trimEnd());
	}
	const ws = lines.map(measure);
	tl = { lines, ws, w: Math.max(0, ...ws), h: Math.max(1, lines.length) * lh * size, lh, ls };
	layouts.set(key, tl);
	return tl;
}
// SDF を色で焼く（縁 0.75・なめらか幅 0.1）
function sdfTint(name, im, color) {
	const key = name + "|" + color;
	let c = tinted.get(key);
	if (c) return c;
	const w = im.bm.width, h = im.bm.height, cv = new OffscreenCanvas(w, h), g = cv.getContext("2d");
	g.drawImage(im.bm, 0, 0);
	const px = g.getImageData(0, 0, w, h), a = px.data;
	g.fillStyle = color; g.fillRect(0, 0, 1, 1); const [r, gg, b, al] = g.getImageData(0, 0, 1, 1).data;
	for (let i = 0; i < a.length; i += 4) {
		const d = a[i + 3] / 255, t = Math.max(0, Math.min(1, (d - 0.7) / 0.1)), s = t * t * (3 - 2 * t);
		a[i] = r; a[i + 1] = gg; a[i + 2] = b; a[i + 3] = Math.round(s * al);
	}
	g.putImageData(px, 0, 0);
	tinted.set(key, cv);
	return cv;
}
// 重なり判定の格子（置いた箱を 64px 升に登録＝候補は近くの升だけ見る）。旧＝置いた箱の全件と比べる線形＝数千件で 2 乗
// 書体＝text-font（fnt）があれば fontCss（family/weight/style＋既定の束）・無ければ従来（500・Noto Sans JP）
const FALLBACK = '"Noto Sans JP",system-ui,sans-serif';
const fontCss = (f, size, fallback) => `${f?.st && f.st !== "normal" ? f.st + " " : ""}${f?.w && f.w !== 400 ? f.w + " " : ""}${size}px ${f?.fam?.length ? f.fam.map(x => `"${x.replace(/"/g, "")}"`).join(",") + "," : ""}${fallback}`;   // ortho-core/fontstack.js と同式（overlay は依存ゼロ）
const fontOf = it => it.fnt ? fontCss(it.fnt, it.textSize, FALLBACK) : `${it.textWeight || 500} ${it.textSize}px ${it.textFont || FALLBACK}`;
const CELL = 64;
function makeIndex() {
	const grid = new Map();
	const cells = (b, fn) => { const x0 = Math.floor(b[0] / CELL), x1 = Math.floor(b[2] / CELL), y0 = Math.floor(b[1] / CELL), y1 = Math.floor(b[3] / CELL);
		for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (fn(cx * 65536 + cy)) return true; return false; };
	return {
		free: b => !cells(b, k => { const L = grid.get(k); return !!L && L.some(p => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]); }),
		push: b => { cells(b, k => { let L = grid.get(k); if (!L) grid.set(k, L = []); L.push(b); return false; }); },
	};
}
const pad = (b, p) => p ? [b[0] - p, b[1] - p, b[2] + p, b[3] + p] : b;   // text-padding＝判定だけ広げる（描く位置は変えない）
const ANCH = { center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5], "top-left": [0, 0], "top-right": [1, 0], "bottom-left": [0, 1], "bottom-right": [1, 1] };
export function frame(cam, s, { w, h }, api) {
	if (!ctx) return false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, w, h);
	if (!layers.size || !api) return false;
	const dpr = api.dpr || 1, W = w / dpr, H = h / dpr;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	const idx = makeIndex(), free = idx.free;   // 置いた箱（重なり判定＝格子）
	const placedNow = [];
	for (const L of [...layers.values()].sort((a, b) => a.order - b.order)) {
		for (const it of L.items) {
			const [x, y, f] = api.project(it.lon, it.lat);
			if (f < 0 || x < -64 || y < -64 || x > W + 64 || y > H + 64) continue;
			// 縁の近く（地平線の手前で斜めに潰れる所）は出さない（layer.horizon）：f＝dot(u,E)−1・|E−u|²＝|E|²−2f−1 ⇒ cos＝f／|E−u|
			if (it.horizon > 0 && s?.eye) { const e2 = s.eye[0] * s.eye[0] + s.eye[1] * s.eye[1] + s.eye[2] * s.eye[2]; if (f / Math.sqrt(Math.max(1e-12, e2 - 2 * f - 1)) < it.horizon) continue; }
			let ib = null, tb = null, im = null, iw = 0, ih = 0, placedAnchor = null;
			if (it.icon) im = images.get(it.icon) || null;
			const fit = im && it.text && it.iconTextFit && it.iconTextFit !== "none" ? it.iconTextFit : null;   // icon-text-fit（#39）
			if (im && !fit) {
				iw = im.bm.width / im.pr * it.size; ih = im.bm.height / im.pr * it.size;
				const a = ANCH[it.anchor] || ANCH.center, ox = x + it.offset[0] * it.size - a[0] * iw, oy = y + it.offset[1] * it.size - a[1] * ih;
				ib = [ox, oy, ox + iw, oy + ih];
			}
			// 文字の箱（text-variable-anchor＝候補を順に試し、空いている最初の位置・#39）
			const tl = it.text ? layoutText(it) : null;
			const textBox = anchor => {
				const tw = tl.w, th = tl.h, a = ANCH[anchor] || ANCH.center;
				let ox = it.textOffset[0], oy = it.textOffset[1];
				if (it.textVariableAnchor) {   // 候補ごとに錨から離す向き＝錨の反対側へ（MapLibre と同じ：radial があればそれ・無ければ text-offset の大きさ）
					const r = it.textRadialOffset ?? Math.max(Math.abs(ox), Math.abs(oy)), k = anchor.includes("-") ? Math.SQRT1_2 : 1;
					ox = (anchor.includes("left") ? r : anchor.includes("right") ? -r : 0) * k; oy = (anchor.startsWith("top") ? r : anchor.startsWith("bottom") ? -r : 0) * k;
				}
				const tx = x + ox * it.textSize - a[0] * tw, ty = y + oy * it.textSize - a[1] * th;
				return [tx, ty, tx + tw, ty + th];
			};
			let i9 = null;   // 伸びる記号の区間（stretchFit）
			const iconFor = t => {   // icon-text-fit：文字の箱＋余白（上・右・下・左 px）へ伸ばす（width/height は片方だけ）・伸びる記号は伸びる区間だけ（stretchFit）
				if (isStretch(im)) { const f = stretchFit(im, it.size, fit, t, it.iconTextFitPadding || [0, 0, 0, 0]); i9 = f; return f.box; }
				const [pt, pr, pb, pl] = it.iconTextFitPadding || [0, 0, 0, 0], nw = im.bm.width / im.pr * it.size, nh = im.bm.height / im.pr * it.size;
				const cx = (t[0] + t[2]) / 2, cy = (t[1] + t[3]) / 2;
				const x0 = fit === "height" ? cx - nw / 2 : t[0] - pl, x1 = fit === "height" ? cx + nw / 2 : t[2] + pr;
				const y0 = fit === "width" ? cy - nh / 2 : t[1] - pt, y1 = fit === "width" ? cy + nh / 2 : t[3] + pb;
				return [x0, y0, x1, y1];
			};
			if (it.text) {
				const cands = it.textVariableAnchor?.length ? it.textVariableAnchor : [it.textAnchor];
				for (const an of cands) {
					const t = textBox(an), i2 = fit ? iconFor(t) : ib;
					if (it.textOverlap || (free(pad(t, it.textPadding)) && (!i2 || it.iconOverlap || free(i2)))) { tb = t; if (fit) ib = i2; placedAnchor = an; break; }
				}
				if (!tb) continue;   // どの候補も置けない＝この記号は出さない
				if (fit) { iw = ib[2] - ib[0]; ih = ib[3] - ib[1]; }
			}
			// 重なり（MapLibre：記号と文字は一緒に置けなければ両方出さない＝optional は扱わない）
			if (ib && !it.iconOverlap && !free(ib)) continue;
			if (ib && !it.iconIgnore) idx.push(ib);
			if (tb && !it.textIgnore) idx.push(pad(tb, it.textPadding));
			{ const b = tb || ib; placedNow.push({ layer: L.id, text: it.text || null, icon: ib ? it.icon || null : null, ibox: ib ? [(ib[0] + ib[2]) / 2, (ib[1] + ib[3]) / 2, ib[2] - ib[0], ib[3] - ib[1]] : null, lon: it.lon, lat: it.lat, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, w: b[2] - b[0], h: b[3] - b[1], font: tb ? fontOf(it) : null }); }
			ctx.globalAlpha = it.opacity ?? 1;
			if (ib) {
				const src = im.sdf ? sdfTint(it.icon, im, it.color || "#000") : im.bm;
				if (fit && i9) drawStretched(ctx, src, i9);   // 伸びる記号＝区間ごと（9 分割）
				else if (it.rotate) { ctx.save(); ctx.translate((ib[0] + ib[2]) / 2, (ib[1] + ib[3]) / 2); ctx.rotate(it.rotate * Math.PI / 180); ctx.drawImage(src, -iw / 2, -ih / 2, iw, ih); ctx.restore(); }
				else ctx.drawImage(src, ib[0], ib[1], iw, ih);
			}
			if (tb) {
				ctx.font = fontOf(it);   // 幅は覚えから＝描く前に書体を必ず据える（text-font → family/weight/style・無ければ従来の 500 と既定の束）
				if ("letterSpacing" in ctx) ctx.letterSpacing = tl.ls ? `${tl.ls * it.textSize}px` : "0px";
				ctx.textAlign = "left"; ctx.textBaseline = "top";
				// 行ごと＝justify（auto＝錨の向き・ML 既定 center・ネイティブ left）で寄せる。1 行目の y は従来と同じ（上辺＋0.1 字）・行の高さ lh
				const an = placedAnchor || it.textAnchor || "center", just = it.textJustify === "auto" ? (an.includes("left") ? "left" : an.includes("right") ? "right" : "center") : (it.textJustify || "left"), step = tl.lh * it.textSize, dy0 = (step - it.textSize * 1.2) / 2 + it.textSize * 0.1;
				for (let i = 0; i < tl.lines.length; i++) {
					const x = just === "right" ? tb[0] + tl.w - tl.ws[i] : just === "center" ? tb[0] + (tl.w - tl.ws[i]) / 2 : tb[0], y = tb[1] + i * step + dy0;
					if (it.haloWidth > 0) { ctx.lineJoin = "round"; ctx.lineWidth = it.haloWidth * 2; ctx.strokeStyle = it.haloColor || "#fff"; ctx.strokeText(tl.lines[i], x, y); }
					ctx.fillStyle = it.textColor || "#000"; ctx.fillText(tl.lines[i], x, y);
				}
			}
		}
	}
	ctx.globalAlpha = 1;
	lastPlaced = placedNow;
	return false;
}
export function destroy() { ctx = null; images.clear(); layers.clear(); tinted.clear(); }
