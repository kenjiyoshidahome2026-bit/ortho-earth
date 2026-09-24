// 記号（sprite の icon-image）と文字の層＝canvas2D のオーバーレイ（MapLibre の symbol 層相当・2026-09-21）。
// main（gadgets/symbols.js）が記号帳（名前→ImageBitmap・pixelRatio・sdf）と、評価済みの記号の列を渡す。ここは毎フレーム投影して、
// 重なり判定（icon/text-allow-overlap＝false が既定＝MapLibre と同じ「先に置いたものが勝つ」・symbol-sort-key 昇順）をして描く。
// SDF の記号＝icon-color で塗る（縁＝0.75＝MapLibre と同じしきい値・色ごとに一度だけ焼いて覚える）。地球の裏側は描かない。
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size, api) / destroy()。依存ゼロ。

let ctx = null, images = new Map(), layers = new Map(), tinted = new Map();
export function init(canvas) { ctx = canvas.getContext("2d"); }
// data＝{ type:"image", name, bitmap, pixelRatio, sdf } | { type:"removeImage", name } | { type:"layer", id, items:[…], order } | { type:"removeLayer", id }
export function message(d) {
	if (d.type === "image") { images.set(d.name, { bm: d.bitmap, pr: d.pixelRatio || 1, sdf: !!d.sdf }); for (const k of [...tinted.keys()]) if (k.startsWith(d.name + "|")) tinted.delete(k); }
	else if (d.type === "removeImage") images.delete(d.name);
	else if (d.type === "layer") layers.set(d.id, { items: d.items, order: d.order ?? 0 });
	else if (d.type === "removeLayer") layers.delete(d.id);
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
// 文字幅の覚え（font＋文字列 → 幅）＝毎フレーム全候補の measureText をしない（世界帯の都市＝数千件で効く）。溢れたら丸ごと捨てる
const widths = new Map();
const widthOf = (font, text) => { const k = font + "\u0001" + text; let v = widths.get(k); if (v == null) { if (widths.size > 20000) widths.clear(); ctx.font = font; v = ctx.measureText(text).width; widths.set(k, v); } return v; };
// 重なり判定の格子（置いた箱を 64px 升に登録＝候補は近くの升だけ見る）。旧＝置いた箱の全件と比べる線形＝数千件で 2 乗
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
	for (const L of [...layers.values()].sort((a, b) => a.order - b.order)) {
		for (const it of L.items) {
			const [x, y, f] = api.project(it.lon, it.lat);
			if (f < 0 || x < -64 || y < -64 || x > W + 64 || y > H + 64) continue;
			// 縁の近く（地平線の手前で斜めに潰れる所）は出さない（layer.horizon）：f＝dot(u,E)−1・|E−u|²＝|E|²−2f−1 ⇒ cos＝f／|E−u|
			if (it.horizon > 0 && s?.eye) { const e2 = s.eye[0] * s.eye[0] + s.eye[1] * s.eye[1] + s.eye[2] * s.eye[2]; if (f / Math.sqrt(Math.max(1e-12, e2 - 2 * f - 1)) < it.horizon) continue; }
			let ib = null, tb = null, im = null, iw = 0, ih = 0;
			if (it.icon) im = images.get(it.icon) || null;
			const fit = im && it.text && it.iconTextFit && it.iconTextFit !== "none" ? it.iconTextFit : null;   // icon-text-fit（#39）
			if (im && !fit) {
				iw = im.bm.width / im.pr * it.size; ih = im.bm.height / im.pr * it.size;
				const a = ANCH[it.anchor] || ANCH.center, ox = x + it.offset[0] * it.size - a[0] * iw, oy = y + it.offset[1] * it.size - a[1] * ih;
				ib = [ox, oy, ox + iw, oy + ih];
			}
			// 文字の箱（text-variable-anchor＝候補を順に試し、空いている最初の位置・#39）
			const textBox = anchor => {
				const tw = widthOf(`${it.textWeight || 500} ${it.textSize}px ${it.textFont || '"Noto Sans JP",system-ui,sans-serif'}`, it.text), th = it.textSize * 1.2, a = ANCH[anchor] || ANCH.center;
				let ox = it.textOffset[0], oy = it.textOffset[1];
				if (it.textVariableAnchor) {   // 候補ごとに錨から離す向き＝錨の反対側へ（MapLibre と同じ：radial があればそれ・無ければ text-offset の大きさ）
					const r = it.textRadialOffset ?? Math.max(Math.abs(ox), Math.abs(oy)), k = anchor.includes("-") ? Math.SQRT1_2 : 1;
					ox = (anchor.includes("left") ? r : anchor.includes("right") ? -r : 0) * k; oy = (anchor.startsWith("top") ? r : anchor.startsWith("bottom") ? -r : 0) * k;
				}
				const tx = x + ox * it.textSize - a[0] * tw, ty = y + oy * it.textSize - a[1] * th;
				return [tx, ty, tx + tw, ty + th];
			};
			const iconFor = t => {   // icon-text-fit：文字の箱＋余白（上・右・下・左 px）へ伸ばす（width/height は片方だけ）
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
					if (it.textOverlap || (free(pad(t, it.textPadding)) && (!i2 || it.iconOverlap || free(i2)))) { tb = t; if (fit) ib = i2; break; }
				}
				if (!tb) continue;   // どの候補も置けない＝この記号は出さない
				if (fit) { iw = ib[2] - ib[0]; ih = ib[3] - ib[1]; }
			}
			// 重なり（MapLibre：記号と文字は一緒に置けなければ両方出さない＝optional は扱わない）
			if (ib && !it.iconOverlap && !free(ib)) continue;
			if (ib && !it.iconIgnore) idx.push(ib);
			if (tb && !it.textIgnore) idx.push(pad(tb, it.textPadding));
			ctx.globalAlpha = it.opacity ?? 1;
			if (ib) {
				const src = im.sdf ? sdfTint(it.icon, im, it.color || "#000") : im.bm;
				if (it.rotate) { ctx.save(); ctx.translate((ib[0] + ib[2]) / 2, (ib[1] + ib[3]) / 2); ctx.rotate(it.rotate * Math.PI / 180); ctx.drawImage(src, -iw / 2, -ih / 2, iw, ih); ctx.restore(); }
				else ctx.drawImage(src, ib[0], ib[1], iw, ih);
			}
			if (tb) {
				ctx.font = `${it.textWeight || 500} ${it.textSize}px ${it.textFont || '"Noto Sans JP",system-ui,sans-serif'}`;   // 幅は覚えから＝描く前に書体を必ず据える
				ctx.textAlign = "left"; ctx.textBaseline = "top";
				if (it.haloWidth > 0) { ctx.lineJoin = "round"; ctx.lineWidth = it.haloWidth * 2; ctx.strokeStyle = it.haloColor || "#fff"; ctx.strokeText(it.text, tb[0], tb[1] + it.textSize * 0.1); }
				ctx.fillStyle = it.textColor || "#000"; ctx.fillText(it.text, tb[0], tb[1] + it.textSize * 0.1);
			}
		}
	}
	ctx.globalAlpha = 1;
	return false;
}
export function destroy() { ctx = null; images.clear(); layers.clear(); tinted.clear(); }
