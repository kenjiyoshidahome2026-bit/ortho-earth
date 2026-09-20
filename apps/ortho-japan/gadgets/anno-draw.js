// 注釈レイヤの描画本体＝レンダーワーカー内のオーバーレイ（map.overlay・#13）。地球・注記と同じフレーム・同じ cam で canvas2D に描く。
// main（gadgets/anno.js）は geopbf の読み込み・識別（tip/pop）・DOM を持ち、ここへは前処理済みの items（@spline は細分済み）を渡す。
// 図形/帯/曲線のプリミティブ（PICTO/SHAPE_SCALE/makeTracer/buildLinePath）の正本は geopbf/edit/draw＝geoedit も同じ一本を使う。
// このモジュールは render worker の**組み込み**（renderworker.js の BUILTIN_OVERLAYS＝import("../gadgets/anno-draw.js")）＝バンドルされるので import を持てる
// （旧＝?url のそのまま置き＝依存ゼロが掟で球面ヘルパの写しを抱えていた。正典を geopbf/edit/draw に一本化するために組み込みへ・2026-09-20）。
// 契約（app.js map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   api.project(lon,lat)→[x,y,f]（CSS px・地形リフト込み・f<0=裏側）／api.projectH(lon,lat,hM)＝h メートル上（3D ピン）／api.W,H,dpr
//   host.requestDraw()＝@icon 画像の到着で次フレーム／host.post({ type:"hits" })＝シンボルの画面矩形（main の hover/click 用）
import { SHAPE_NAMES, SHAPE_SCALE, PICTO, BOTTOM_ANCHOR, makeTracer, buildLinePath } from "geopbf/edit/draw";   // 正典（geoedit と同じ一本）

// ---- worker 側の描画状態（オーバーレイ 1 枚ぶん）----
const FONT_FAMILY = '"Noto Sans JP","Hiragino Sans",sans-serif';
const DEF_FILL = "rgba(120,170,221,.25)", DEF_STROKE = "#2b5f8f", DEF_PT = "#cc4444";
let canvas = null, ctx = null, host = null, tracer = null;
let items = [];                    // main から届く前処理済み items（[fid] → { p, pts|lines|rings }・null 可）
const pictoCache = new Map();
const images = new Map();          // @icon 値（data:URI 文字列 / Blob）→ ImageBitmap | "loading" | "bad"
const getPicto = n => pictoCache.get(n) || (pictoCache.set(n, new Path2D(PICTO[n])), pictoCache.get(n));
const iconImg = v => {
	const im = images.get(v);
	if (im) return im instanceof ImageBitmap ? im : null;
	const key = v;
	if (typeof v !== "string" && !(v instanceof Blob)) { images.set(key, "bad"); return null; }
	if (typeof v === "string" && !v.startsWith("data:")) { images.set(key, "bad"); return null; }
	images.set(key, "loading");
	(typeof v === "string" ? fetch(v).then(r => r.blob()) : Promise.resolve(v)).then(b => createImageBitmap(b))
		.then(bm => { images.set(key, bm); host?.requestDraw(); }, () => images.set(key, "bad"));
	return null;
};
const shapePath = (kind, x, y, r) => {   // solid 図形（円/四角/三角/菱形/星）
	ctx.beginPath();
	if (kind === "square") ctx.rect(x - r, y - r, r * 2, r * 2);
	else if (kind === "triangle") { ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.87, y + r * 0.5); ctx.lineTo(x - r * 0.87, y + r * 0.5); ctx.closePath(); }
	else if (kind === "diamond") { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
	else if (kind === "star") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx[i ? "lineTo" : "moveTo"](x + rr * Math.cos(a), y + rr * Math.sin(a)); } ctx.closePath(); }
	else ctx.arc(x, y, r, 0, Math.PI * 2);
};
function drawText(text, x, yBase, fpx, p, centerV) {   // 白フチ文字（geoedit と同じ流儀）。centerV=座標に縦中央
	ctx.font = `${fpx}px ${FONT_FAMILY}`;
	ctx.textAlign = "center";
	const lines = text.split("\\n").join("\n").split("\n");
	const y0 = centerV ? yBase + fpx * 0.35 - (lines.length - 1) * fpx * 0.6 : yBase - (lines.length - 1) * fpx * 1.2;
	let maxW = 0;
	lines.forEach((l, i) => {
		const yy = y0 + i * fpx * 1.2;
		ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)";
		ctx.strokeText(l, x, yy);
		ctx.fillStyle = centerV ? (p["@fill"] || "#223") : (p["@stroke"] || "#223");
		ctx.fillText(l, x, yy);
		maxW = Math.max(maxW, ctx.measureText(l).width);
	});
	ctx.textAlign = "start";
	return { x0: x - maxW / 2 - 4, y0: y0 - fpx, x1: x + maxW / 2 + 4, y1: y0 + (lines.length - 1) * fpx * 1.2 + 4 };
}

export function init(cv, opts, h) {
	canvas = cv; host = h;
	ctx = canvas.getContext("2d");
	tracer = makeTracer(ctx);
}
export function message(d) {
	if (d.type === "set") { items = d.items || []; }
	else if (d.type === "clear") { items = []; }
	else if (d.type === "probe") {   // 検定用＝実画素を main へ（tests/t-anno）
		try { const im = ctx.getImageData(0, 0, canvas.width, canvas.height); host?.post({ type: "pixels", id: d.id, w: im.width, h: im.height, data: im.data }); }
		catch (e) { host?.post({ type: "pixels", id: d.id, error: String(e?.message || e) }); }
	}
}
export function destroy() { images.forEach(im => im instanceof ImageBitmap && im.close()); images.clear(); items = []; ctx = null; canvas = null; }

export function frame(cam, s, size, api) {
	if (!ctx) return false;
	const dpr = api.dpr, W = api.W, H = api.H, pr = api.project, prH = api.projectH, zoom = cam.zoom;
	const { tracePts, projLine } = tracer;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, W, H);
	const symHits = [];
	if (items.length) {
		// ① ぼかし面（下地）
		for (const it of items) {
			if (!it?.rings) continue;
			const blur = +it.p["@blur"];
			if (!(blur > 0)) continue;
			ctx.save(); ctx.filter = `blur(${blur}px)`;
			ctx.beginPath();
			for (const r of it.rings) { tracePts(pr, r, true); ctx.closePath(); }
			ctx.fillStyle = it.p["@fill"] || "rgba(120,170,221,.5)"; ctx.fill("evenodd");
			ctx.restore();
		}
		// ② 面（crisp）
		for (const it of items) {
			if (!it?.rings || +it.p["@blur"] > 0) continue;
			ctx.beginPath();
			for (const r of it.rings) { tracePts(pr, r, true); ctx.closePath(); }   // 塗り＝地平円クランプで閉じる
			ctx.fillStyle = it.p["@fill"] || DEF_FILL; ctx.fill("evenodd");
			ctx.beginPath();
			for (const r of it.rings) tracePts(pr, r);   // 線＝見えない区間で切る（地平線沿いに輪郭を引かない）
			ctx.lineWidth = +it.p["@width"] > 0 ? +it.p["@width"] : 1.5;
			ctx.lineJoin = "round"; ctx.strokeStyle = it.p["@stroke"] || DEF_STROKE; ctx.stroke();
		}
		// ③ 線（@poly=帯／素の線）
		for (const it of items) {
			if (!it?.lines) continue;
			const w = +it.p["@width"] > 0 ? +it.p["@width"] : 1.5;
			if (it.p["@poly"]) {
				const capS = it.p["@start"] || it.p["@cap0"] || "", capE = it.p["@end"] || it.p["@cap1"] || "";   // @cap0/1＝旧名の後方互換
				for (const l of it.lines) {
					const q = projLine(pr, l);
					if (q.length < 2) continue;
					ctx.beginPath();
					buildLinePath(ctx, q, w, capS, capE);
					ctx.fillStyle = it.p["@fill"] || DEF_FILL; ctx.fill();
					ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.strokeStyle = it.p["@stroke"] || DEF_STROKE; ctx.stroke();
				}
			} else {
				ctx.beginPath();
				for (const l of it.lines) tracePts(pr, l);
				ctx.lineWidth = w; ctx.lineJoin = ctx.lineCap = "round"; ctx.strokeStyle = it.p["@stroke"] || DEF_STROKE; ctx.stroke();
			}
		}
		// ④ 点シンボル（@shape/@icon/@text・pin=3Dピン）
		for (let fid = 0; fid < items.length; fid++) {
			const it = items[fid];
			if (!it?.pts) continue;
			const p = it.p, size_ = +p["@size"] > 0 ? +p["@size"] : 24;
			for (const c of it.pts) {
				const sxy = pr(c[0], c[1]);
				if (sxy[2] < 0 || sxy[0] < -60 || sxy[0] > W + 60 || sxy[1] < -60 || sxy[1] > H + 60) continue;
				const icon = p["@icon"] && iconImg(p["@icon"]);
				const shape = p["@shape"], text = p["@text"];
				const textOnly = !icon && !shape && text != null && text !== "";
				if (!icon && shape === "pin") {   // 3Dピン＝棒(地面→頭)＋球。高さ=画面基準(@size×2px相当を現ズームでm換算)
					// ＝真俯瞰は投影が潰して自然に円・チルトで立つ（worldの鉛直＝カメラ方位にも正しく追従）。接地は worker の地形＝同期
					const mpp = 40075016.686 * Math.cos(c[1] * Math.PI / 180) / (256 * Math.pow(2, zoom));
					const g0 = prH(c[0], c[1], 0), h1 = prH(c[0], c[1], size_ * 2 * mpp);
					if (g0[2] < 0) continue;
					const r = (size_ / 2) * (SHAPE_SCALE.pin || 1);
					ctx.beginPath(); ctx.arc(g0[0], g0[1], 2, 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fill();   // 接地点
					ctx.beginPath(); ctx.moveTo(g0[0], g0[1]); ctx.lineTo(h1[0], h1[1]);
					ctx.lineWidth = Math.max(1.5, size_ / 8); ctx.lineCap = "round"; ctx.strokeStyle = p["@stroke"] || "rgba(30,40,60,.6)"; ctx.stroke();
					ctx.beginPath(); ctx.arc(h1[0], h1[1], r, 0, Math.PI * 2);
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill();
					ctx.lineWidth = 1.5; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.45)"; ctx.stroke();
					symHits.push({ x0: h1[0] - r - 4, y0: h1[1] - r - 4, x1: h1[0] + r + 4, y1: h1[1] + r + 4, fid });
					if (text) drawText(String(text), h1[0], h1[1] - r, 12, p, false);   // ピンの頭上に「それが何か」
					continue;
				}
				const bottom = BOTTOM_ANCHOR.has(shape);
				if (!textOnly) symHits.push(bottom
					? { x0: sxy[0] - size_ / 2, y0: sxy[1] - size_ * 1.1, x1: sxy[0] + size_ * (shape === "flag" ? 0.75 : 0.5), y1: sxy[1], fid }
					: { x0: sxy[0] - size_ / 2, y0: sxy[1] - size_ / 2, x1: sxy[0] + size_ / 2, y1: sxy[1] + size_ / 2, fid });
				if (icon) {   // 中央アンカー＋アスペクト維持（中央正方クロップ）
					const iw = icon.width, ih = icon.height, sd = Math.min(iw, ih);
					ctx.drawImage(icon, (iw - sd) / 2, (ih - sd) / 2, sd, sd, sxy[0] - size_ / 2, sxy[1] - size_ / 2, size_, size_);
				} else if (shape && PICTO[shape]) {
					const path = getPicto(shape), bs = size_ * (SHAPE_SCALE[shape] || 1);
					ctx.save();
					ctx.translate(sxy[0] - bs / 2, bottom ? sxy[1] - bs : sxy[1] - bs / 2); ctx.scale(bs / 24, bs / 24);
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill(path, "evenodd");
					ctx.lineWidth = 1.4; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.35)"; ctx.stroke(path);
					ctx.restore();
				} else if (shape) {
					shapePath(shape, sxy[0], sxy[1], (size_ / 2) * (SHAPE_SCALE[shape] || 1));
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill();
					ctx.lineWidth = 1.5; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.45)"; ctx.stroke();
				} else if (!text) {
					ctx.beginPath(); ctx.arc(sxy[0], sxy[1], 4, 0, Math.PI * 2);
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill();
					ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.stroke();
				}
				if (text) {
					const fpx = textOnly ? Math.max(11, size_ * 0.7) : 12;
					const rect = drawText(String(text), sxy[0], textOnly ? sxy[1] : sxy[1] - size_ * 0.6 - 3, fpx, p, textOnly);
					if (textOnly && rect) symHits.push({ ...rect, fid });
				}
			}
		}
	}
	host?.post({ type: "hits", hits: symHits });   // main の hover/click（symbolAt）用＝毎フレーム最新の矩形
	return false;
}
