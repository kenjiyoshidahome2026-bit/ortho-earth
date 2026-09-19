// 注釈レイヤの描画本体＝レンダーワーカー内のオーバーレイ（map.overlay・#13）。地球・注記と同じフレーム・同じ cam で canvas2D に描く。
// main（gadgets/anno.js）は geopbf の読み込み・識別（tip/pop）・DOM を持ち、ここへは前処理済みの items（@spline は細分済み）を渡す。
// 図形/帯/曲線のプリミティブ（PICTO/SHAPE_SCALE/makeTracer/buildLinePath）は**ここが正本**＝anno.js が再輸出し geoedit も同じ一本を使う。
// このモジュールは anno.js から `?url` で参照される（vite はファイルをそのまま置く）＝worker が URL で import()。だから import 文を持たない。
// 契約（app.js map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   api.project(lon,lat)→[x,y,f]（CSS px・地形リフト込み・f<0=裏側）／api.projectH(lon,lat,hM)＝h メートル上（3D ピン）／api.W,H,dpr
//   host.requestDraw()＝@icon 画像の到着で次フレーム／host.post({ type:"hits" })＝シンボルの画面矩形（main の hover/click 用）
// ⚠ このモジュールは依存ゼロ（import 文なし）：vite は ?url のファイルをそのまま置く＝bare import は本番で解決できない
//   （?worker&url は worker 入口扱いで export が tree-shake され殻になる・2026-09-20 実測）。下の球面ヘルパは geopbf/edit/sphere.js の**写し**
//   （正本はそちら・変えるときは両方）。完全球体＝辺は大円で結ぶ（geoedit overlay / gint 度アンカーと同じ線・9/14）。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrapLon = x => (x >= -180 && x < 180) ? x : ((x + 180) % 360 + 360) % 360 - 180;
const toVec = (lon, lat) => { const c = Math.cos(lat * D2R); return [c * Math.cos(lon * D2R), c * Math.sin(lon * D2R), Math.sin(lat * D2R)]; };
const toLL = v => [wrapLon(Math.atan2(v[1], v[0]) * R2D), Math.atan2(v[2], Math.hypot(v[0], v[1])) * R2D];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const angleBetween = (a, b) => { const c = cross(a, b); return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b)); };   // 中心角 [0,π]
const slerp = (a, b, t) => {   // 大円補間 a→b（最短側）
	const w = angleBetween(a, b), s = Math.sin(w);
	if (s < 1e-12) return norm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
	const ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
	return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
};

// ---- 基本図形（正典）----
// marker=涙滴マーカー。pin=3Dピン（棒＋球）＝チルトで立つ／真俯瞰は円。他はスプライト。
export const SHAPE_NAMES = ["pin", "marker", "circle", "square", "triangle", "diamond", "star", "flag", "home", "camera", "train", "warn", "drop"];
// 塗り面積を「円と大体同じ」にそろえる描画スケール（solid は解析面積 f=√(π/面積係数)・シルエットは手調整）。未指定は 1。
export const SHAPE_SCALE = {
	circle: 0.9, square: 0.8, triangle: 1.25, diamond: 1.13, star: 1.39, pin: 0.8,   // pin は球(円)＝circleより少し小さめ
	marker: 1.2, flag: 1.35, home: 1.25, camera: 1.2, train: 1.15, warn: 1.35, drop: 1.3,
};
// 単色シルエット図形（塗り=@fill・穴は evenodd）。marker/flag は足元アンカー（先端/棒根本= y=24＝座標に接地）。24×24 viewBox。
export const PICTO = {
	marker: "M12 24C9.2 19.55 5.5 14.1 5.5 9.2A6.5 6.5 0 0 1 18.5 9.2C18.5 14.1 14.8 19.55 12 24Z M12 6.9A2.4 2.4 0 1 0 12.01 11.7 2.4 2.4 0 0 0 12 6.9Z",
	flag: "M11.1 2H12.9V24H11.1Z M12.9 3H21L18.2 6.7 21 10.4H12.9Z",
	home: "M12 3l9 8h-2.6v9h-4.9v-6h-3v6H5.6v-9H3z",
	camera: "M8.5 5h7l1.4 2.4H21V20H3V7.4h4.1z M12 9.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z",
	train: "M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3l1.8 3.4h-2.3l-1.8-3.4H9.3l-1.8 3.4H5.2L7 17a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M8 7v4.6h8V7z",
	warn: "M12 3l9.6 17.6H2.4z M11 9.5h2v5.4h-2z M11 16.4h2v2h-2z",
	drop: "M12 3s6.2 7.6 6.2 11.6a6.2 6.2 0 0 1-12.4 0C5.8 10.6 12 3 12 3z",
};
export const BOTTOM_ANCHOR = new Set(["marker", "flag"]);   // 足元＝座標にアンカー（他は中心）

// ---- 大円分割つき投影のトレーサ（canvas2D 1 枚に束ねる）＝geoedit overlay とビューア再生の単一実装（効率レビュー H-1/§5）----
// seg: a→b を中心角 0.5° 刻みの大円（最短側＝antimeridian 跨ぎで裏側回りにしない）で分割して投影。n=1（編集ズームの大半）は
// slerp/toLL を通さず端点を直接投影＝経緯度の往復丸めもしない。walk は前辺の vb を次辺の va に使い回す（toVec は 1 頂点 1 回）。
// tracePts(fill=true)＝見えない点（projector が地平円へクランプした位置）でも切らずに一本で結ぶ＝可視部＋地平線沿いの閉路（全点不可視は描かない）。
// fill=false＝見えない区間で切る（地平線沿いに線を引かない）。projLine＝帯用の画面座標列（裏半球は落とす）。
export function makeTracer(ctx) {
	const segEmit = (pr, a, b, va, vb, emit) => {
		const n = Math.min(256, Math.max(1, Math.ceil(angleBetween(va, vb) * 180 / Math.PI / 0.5)));
		emit(pr(a[0], a[1]));
		for (let i = 1; i < n; i++) { const p = toLL(slerp(va, vb, i / n)); emit(pr(p[0], p[1])); }
		emit(pr(b[0], b[1]));
	};
	const walk = (pr, coords, emit) => {
		if (!coords || coords.length < 2) return;
		let va = toVec(coords[0][0], coords[0][1]);
		for (let i = 0; i < coords.length - 1; i++) { const b = coords[i + 1], vb = toVec(b[0], b[1]); segEmit(pr, coords[i], b, va, vb, emit); va = vb; }
	};
	const seg = (pr, a, b) => { const out = []; segEmit(pr, a, b, toVec(a[0], a[1]), toVec(b[0], b[1]), q => out.push(q)); return out; };
	const tracePts = (pr, coords, fill = false) => {
		if (fill) {
			const pts = []; let any = false;
			walk(pr, coords, q => { if (q[2] >= 0) any = true; pts.push(q); });
			if (!any) return;
			for (let i = 0; i < pts.length; i++) i ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]);
			return;
		}
		let started = false;
		walk(pr, coords, q => {
			if (q[2] < 0) { started = false; return; }
			if (!started) { ctx.moveTo(q[0], q[1]); started = true; } else ctx.lineTo(q[0], q[1]);
		});
	};
	const projLine = (pr, coords) => { const q = []; walk(pr, coords, s => { if (s[2] >= 0) q.push(s); }); return q; };
	return { seg, tracePts, projLine, walk };
}
// 経度の最短差（antimeridian 跨ぎ）：線分の内挿・中点・平行移動の差分は必ずこれを通す（正典・geoedit も import）。
// 生の差 b-a で内挿すると ±179.9 の混在（normLon 産）が「地球の裏側回り」の帯になる（2026-09-12・geoedit の円で発覚）。
export const dLon = (from, to) => { const d = to - from; return d - Math.round(d / 360) * 360; };

// ---- @poly（ポリゴン化した線＝帯）＝折れ線を「幅 w の帯＋端形状」の単一閉路として ctx へパス構築（正典）。
// 塗り(+alpha)が矢じり込みで均一・輪郭が端形状まで一周。capS/capE ∈ ""(butt)/"square"/"round"/"arrow"。
// arrow は太さ純比例（最大幅=線幅×2・先端60°）・先端＝端点そのもの。join は miter（clamp 付き）。----
export function buildLinePath(ctx, q0, w, capS, capE) {
	const hw = Math.max(0.5, w / 2), ahalf = w, alen = w * Math.sqrt(3);   // 矢じり＝最大幅2w・先端60°（len=half/tan30°）
	// ★連続重複点の除去：seg() は区間ごとに両端点込み＝継ぎ目が二重＝方向ゼロ→miter cos=0→スパイク（ゲジゲジ）
	let q = [];
	for (const p2 of q0) { const l = q[q.length - 1]; if (!l || Math.hypot(p2[0] - l[0], p2[1] - l[1]) > 0.1) q.push(p2); }
	if (q.length < 2) return;
	const tipS = q[0], tipE = q[q.length - 1];
	const trim = (pts, atEnd, len) => {   // 矢じり側＝基部まで線体を切り詰め。★複数点を跨いで累積距離で（密点列の鈍角化防止）
		const out = atEnd ? pts.slice() : pts.slice().reverse();
		let rest = len;
		while (out.length >= 2) {
			const b = out[out.length - 1], a = out[out.length - 2];
			const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
			if (l >= rest || out.length === 2) {   // このセグメント内で切る（最短でも1割は線体を残す）
				const t = Math.min(rest, l * 0.9) / (l || 1);
				out[out.length - 1] = [b[0] - (b[0] - a[0]) * t, b[1] - (b[1] - a[1]) * t];
				break;
			}
			out.pop(); rest -= l;   // セグメントごと矢じりに呑まれる＝点を落として先へ
		}
		return atEnd ? out : out.reverse();
	};
	if (capS === "arrow") q = trim(q, false, alen);
	if (capE === "arrow") q = trim(q, true, alen);
	const n = q.length, d = [];
	for (let i = 0; i < n - 1; i++) { const dx = q[i + 1][0] - q[i][0], dy = q[i + 1][1] - q[i][1], l = Math.hypot(dx, dy) || 1; d.push([dx / l, dy / l]); }
	const R = [], L = [];
	for (let i = 0; i < n; i++) {   // miter オフセット（端は素のセグメント法線）
		const da = d[Math.max(0, i - 1)], db = d[Math.min(n - 2, i)];
		let mx = da[0] + db[0], my = da[1] + db[1], ml = Math.hypot(mx, my), nx, ny, sc;
		if (ml < 1e-6) { nx = -db[1]; ny = db[0]; sc = hw; }   // 180°折返し
		else {
			mx /= ml; my /= ml; nx = -my; ny = mx;
			sc = hw / Math.max(0.35, Math.abs(nx * -db[1] + ny * db[0]));   // 1/cos(θ/2)・clamp≈2.9倍
		}
		R.push([q[i][0] + nx * sc, q[i][1] + ny * sc]);
		L.push([q[i][0] - nx * sc, q[i][1] - ny * sc]);
	}
	const uE = d[d.length - 1], nE = [-uE[1], uE[0]];
	const uS = [-d[0][0], -d[0][1]], nS = [-d[0][1], d[0][0]];
	const qs = q[0], qe = q[n - 1];
	ctx.moveTo(R[0][0], R[0][1]);
	for (let i = 1; i < n; i++) ctx.lineTo(R[i][0], R[i][1]);
	if (capE === "arrow") {   // 肩へ張り出し→先端→肩
		ctx.lineTo(qe[0] + nE[0] * ahalf, qe[1] + nE[1] * ahalf);
		ctx.lineTo(tipE[0], tipE[1]);
		ctx.lineTo(qe[0] - nE[0] * ahalf, qe[1] - nE[1] * ahalf);
	} else if (capE === "square") {   // hw だけ外へ張り出す角
		ctx.lineTo(qe[0] + (nE[0] + uE[0]) * hw, qe[1] + (nE[1] + uE[1]) * hw);
		ctx.lineTo(qe[0] + (uE[0] - nE[0]) * hw, qe[1] + (uE[1] - nE[1]) * hw);
	} else if (capE === "round") {
		const a0 = Math.atan2(nE[1], nE[0]);
		ctx.arc(qe[0], qe[1], hw, a0, a0 - Math.PI, true);   // 減角方向＝外向き uE を通る半円
	}
	ctx.lineTo(L[n - 1][0], L[n - 1][1]);
	for (let i = n - 2; i >= 0; i--) ctx.lineTo(L[i][0], L[i][1]);
	if (capS === "arrow") {
		ctx.lineTo(qs[0] - nS[0] * ahalf, qs[1] - nS[1] * ahalf);
		ctx.lineTo(tipS[0], tipS[1]);
		ctx.lineTo(qs[0] + nS[0] * ahalf, qs[1] + nS[1] * ahalf);
	} else if (capS === "square") {
		ctx.lineTo(qs[0] + (uS[0] - nS[0]) * hw, qs[1] + (uS[1] - nS[1]) * hw);
		ctx.lineTo(qs[0] + (uS[0] + nS[0]) * hw, qs[1] + (uS[1] + nS[1]) * hw);
	} else if (capS === "round") {
		const a0 = Math.atan2(-nS[1], -nS[0]);
		ctx.arc(qs[0], qs[1], hw, a0, a0 - Math.PI, true);
	}
	ctx.closePath();
}


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
