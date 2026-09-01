// ガジェット：注釈レイヤ（geoedit の @スタイル付き geopbf を canvas2D で再生）。
// 「エディタで作った表現がビューアで同じ動きで再生される」を**実装の共有**で担保する正典＝
// 図形/帯/曲線のプリミティブ（PICTO/SHAPE_SCALE/smoothRing/buildLinePath）はここが正本で、
// geoedit（overlay/model/styleform）はここから import する（pop/tip ガジェット共有と同じ型）。
// 描画は全て canvas2D（地形ドレープなし＝本人裁定・注釈スケールなら十分軽い）。gint は使わない＝
// fid⇄feature の propTub 併合問題も styleTable も無縁。識別は pbf.identifyAt（JS幾何・描画レス）。
// 対応 @属性：@shape(@fill/@stroke/@size・pin=3Dピン)/@icon(画像・中央クロップ)/@text/@width/
//             @spline(曲線)/@blur(ぼかし面・線なし)/@poly+@start/@end(帯+端形状)/@tip(ホバー)/@pop(クリック吹き出し)
// 依存は geopbf/sanitize のみ（i18n 不使用）＝worker からの import も安全（トップレベルに DOM なし）。

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

// ---- @tip/@pop の HTML 消毒（正典は geopbf/sanitize へ昇格 8/29）----
// 「表示側は必ず消毒」はフォーマットの作法＝実装はパッケージが正本（docs §11）。ここは
// 再輸出（プリミティブ共有と同じ型）＝geoedit は overlay.js 経由で同じ一本を使う。
import { sanitizeHTML } from "geopbf/sanitize";
export { sanitizeHTML };

// ---- @spline（滑らか曲線）：正典は geopbf/edit/spline へ昇格 8/29（ここは再輸出＝sanitize と同じ型）----
// ★import してから export する（sanitize と同じ二段の形）。`export … from` は再輸出だけで
//   このモジュールにローカル束縛を作らない＝下の set() が smoothRing を呼んだ瞬間 ReferenceError。
//   輸入側（geoedit）は再輸出でも解決できるため、エディタでは曲線が出るのにビューアだけ落ちる
//   ＝WYSIWYG の担保が壊れる形の非対称バグだった（2026-09-01 発見・8/29 の正典昇格からの潜伏）。
import { smoothRing, smoothGeom } from "geopbf/edit/spline";
export { smoothRing, smoothGeom };

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

// ---- ビューア再生本体（createAnno）：map の公開口だけで完結（projector/onFrame/tip/pop/unproject/getZoom）----
const FONT = '12px "Noto Sans JP","Hiragino Sans",sans-serif';
const DEF_FILL = "rgba(120,170,221,.25)", DEF_STROKE = "#2b5f8f", DEF_PT = "#cc4444";

export function createAnno(map, { signal } = {}) {
	const mapEl = map.mapEl;
	const canvas = document.createElement("canvas");
	canvas.className = "anno-overlay";
	Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
	mapEl.append(canvas);
	const ctx = canvas.getContext("2d");
	let W = 0, H = 0, dpr = 1;
	const syncSize = () => {
		const w = mapEl.clientWidth, h = mapEl.clientHeight, d = devicePixelRatio || 1;
		if (w === W && h === H && d === dpr) return;
		W = w; H = h; dpr = d;
		canvas.width = w * d; canvas.height = h * d;
	};

	let pbf = null, items = [];   // items[fid]＝前処理済み（@spline は set 時に一度だけ細分）
	let tipSet = null, popFn = null, symHits = [];
	let tipRaw = null, tipClean = null;   // 消毒キャッシュ（毎 move の DOMParser を避ける）
	const openedPops = new Map();   // fid → pop div

	// 大圏分割つき投影（geoedit overlay と同じ規約）
	const seg = (pr, a, b) => {
		const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
		const n = Math.min(32, Math.max(1, Math.ceil(Math.max(dx, dy) / 0.5)));
		const out = [];
		for (let i = 0; i <= n; i++) { const t = i / n; out.push(pr(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)); }
		return out;
	};
	const tracePts = (pr, coords) => {
		let started = false;
		for (let i = 0; i < coords.length - 1; i++) for (const p of seg(pr, coords[i], coords[i + 1])) {
			if (p[2] < 0) { started = false; continue; }
			if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
		}
	};
	const projLine = (pr, coords) => {   // 帯用＝画面座標列（裏半球は落とす）
		const q = [];
		for (let i = 0; i < coords.length - 1; i++) for (const s of seg(pr, coords[i], coords[i + 1])) if (s[2] >= 0) q.push(s);
		return q;
	};

	const pictoCache = new Map();
	const getPicto = n => pictoCache.get(n) || (pictoCache.set(n, new Path2D(PICTO[n])), pictoCache.get(n));
	const images = new Map();   // @icon 値 → Image（data:URI / Blob 共通キャッシュ）
	const iconImg = v => {
		let im = images.get(v);
		if (im) return im.complete ? im : null;
		im = new Image();
		if (typeof v === "string") im.src = v.startsWith("data:") ? v : "";
		else if (v instanceof Blob) im.src = URL.createObjectURL(v);
		else return null;
		im.onload = () => map.requestDraw();
		images.set(v, im);
		return im.complete ? im : null;
	};
	const shapePath = (kind, x, y, r) => {   // solid 図形（円/四角/三角/菱形/星）
		ctx.beginPath();
		if (kind === "square") ctx.rect(x - r, y - r, r * 2, r * 2);
		else if (kind === "triangle") { ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.87, y + r * 0.5); ctx.lineTo(x - r * 0.87, y + r * 0.5); ctx.closePath(); }
		else if (kind === "diamond") { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
		else if (kind === "star") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx[i ? "lineTo" : "moveTo"](x + rr * Math.cos(a), y + rr * Math.sin(a)); } ctx.closePath(); }
		else ctx.arc(x, y, r, 0, Math.PI * 2);
	};

	function set(newPbf) {   // 積み込み＝@spline の細分はここで一度だけ（毎フレやらない）
		pbf = newPbf;
		clearPops(); tipSet?.(null);
		items = [];
		const feats = pbf ? pbf.features : [];
		for (let i = 0; i < feats.length; i++) {
			const f = feats[i], g = f?.geometry;
			if (!g) { items.push(null); continue; }
			const p = f.properties || {};
			const it = { p };
			if (g.type === "Point") it.pts = [g.coordinates];
			else if (g.type === "MultiPoint") it.pts = g.coordinates;
			else if (g.type === "LineString") it.lines = [g.coordinates];
			else if (g.type === "MultiLineString") it.lines = g.coordinates;
			else if (g.type === "Polygon") it.rings = g.coordinates;
			else if (g.type === "MultiPolygon") it.rings = g.coordinates.flat();
			else { items.push(null); continue; }
			if (p["@spline"]) {
				if (it.lines) it.lines = it.lines.map(l => smoothRing(l, false));
				if (it.rings) it.rings = it.rings.map(r => smoothRing(r, true));
			}
			items.push(it);
		}
		map.requestDraw();
	}
	function clear() { pbf = null; items = []; clearPops(); tipSet?.(null); map.requestDraw(); }
	function clearPops() { for (const [, div] of openedPops) div._remove?.(); openedPops.clear(); }

	function draw() {
		syncSize();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		symHits = [];
		if (!items.length) return;
		const pr = map.makeProjector(), prH = map.makeProjectorH?.();
		const zoom = map.getZoom();
		// ① ぼかし面（下地）
		for (const it of items) {
			if (!it?.rings) continue;
			const blur = +it.p["@blur"];
			if (!(blur > 0)) continue;
			ctx.save(); ctx.filter = `blur(${blur}px)`;
			ctx.beginPath();
			for (const r of it.rings) { tracePts(pr, r); ctx.closePath(); }
			ctx.fillStyle = it.p["@fill"] || "rgba(120,170,221,.5)"; ctx.fill("evenodd");
			ctx.restore();
		}
		// ② 面（crisp）
		for (const it of items) {
			if (!it?.rings || +it.p["@blur"] > 0) continue;
			ctx.beginPath();
			for (const r of it.rings) { tracePts(pr, r); ctx.closePath(); }
			ctx.fillStyle = it.p["@fill"] || DEF_FILL; ctx.fill("evenodd");
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
			const p = it.p, size = +p["@size"] > 0 ? +p["@size"] : 24;
			for (const c of it.pts) {
				const s = pr(c[0], c[1]);
				if (s[2] < 0 || s[0] < -60 || s[0] > W + 60 || s[1] < -60 || s[1] > H + 60) continue;
				const icon = p["@icon"] && iconImg(p["@icon"]);
				const shape = p["@shape"], text = p["@text"];
				const textOnly = !icon && !shape && text != null && text !== "";
				if (!icon && shape === "pin" && prH) {   // 3Dピン＝棒(地面→頭)＋球。高さ=画面基準(@size×2px相当を現ズームでm換算)
					// ＝真俯瞰は投影が潰して自然に円・チルトで立つ（worldの鉛直＝カメラ方位にも正しく追従）
					const mpp = 40075016.686 * Math.cos(c[1] * Math.PI / 180) / (256 * Math.pow(2, zoom));
					const g0 = prH(c[0], c[1], 0), h1 = prH(c[0], c[1], size * 2 * mpp);
					if (g0[2] < 0) continue;
					const r = (size / 2) * (SHAPE_SCALE.pin || 1);
					ctx.beginPath(); ctx.arc(g0[0], g0[1], 2, 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fill();   // 接地点
					ctx.beginPath(); ctx.moveTo(g0[0], g0[1]); ctx.lineTo(h1[0], h1[1]);
					ctx.lineWidth = Math.max(1.5, size / 8); ctx.lineCap = "round"; ctx.strokeStyle = p["@stroke"] || "rgba(30,40,60,.6)"; ctx.stroke();
					ctx.beginPath(); ctx.arc(h1[0], h1[1], r, 0, Math.PI * 2);
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill();
					ctx.lineWidth = 1.5; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.45)"; ctx.stroke();
					symHits.push({ x0: h1[0] - r - 4, y0: h1[1] - r - 4, x1: h1[0] + r + 4, y1: h1[1] + r + 4, fid });
					if (text) drawText(String(text), h1[0], h1[1] - r, 12, p, false);   // ピンの頭上に「それが何か」
					continue;
				}
				const bottom = BOTTOM_ANCHOR.has(shape);
				if (!textOnly) symHits.push(bottom
					? { x0: s[0] - size / 2, y0: s[1] - size * 1.1, x1: s[0] + size * (shape === "flag" ? 0.75 : 0.5), y1: s[1], fid }
					: { x0: s[0] - size / 2, y0: s[1] - size / 2, x1: s[0] + size / 2, y1: s[1] + size / 2, fid });
				if (icon) {   // 中央アンカー＋アスペクト維持（中央正方クロップ）
					const iw = icon.naturalWidth || icon.width, ih = icon.naturalHeight || icon.height, sd = Math.min(iw, ih);
					ctx.drawImage(icon, (iw - sd) / 2, (ih - sd) / 2, sd, sd, s[0] - size / 2, s[1] - size / 2, size, size);
				} else if (shape && PICTO[shape]) {
					const path = getPicto(shape), bs = size * (SHAPE_SCALE[shape] || 1);
					ctx.save();
					ctx.translate(s[0] - bs / 2, bottom ? s[1] - bs : s[1] - bs / 2); ctx.scale(bs / 24, bs / 24);
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill(path, "evenodd");
					ctx.lineWidth = 1.4; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.35)"; ctx.stroke(path);
					ctx.restore();
				} else if (shape) {
					shapePath(shape, s[0], s[1], (size / 2) * (SHAPE_SCALE[shape] || 1));
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill();
					ctx.lineWidth = 1.5; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.45)"; ctx.stroke();
				} else if (!text) {
					ctx.beginPath(); ctx.arc(s[0], s[1], 4, 0, Math.PI * 2);
					ctx.fillStyle = p["@fill"] || DEF_PT; ctx.fill();
					ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.stroke();
				}
				if (text) {
					const fpx = textOnly ? Math.max(11, size * 0.7) : 12;
					const rect = drawText(String(text), s[0], textOnly ? s[1] : s[1] - size * 0.6 - 3, fpx, p, textOnly);
					if (textOnly && rect) symHits.push({ ...rect, fid });
				}
			}
		}
	}
	function drawText(text, x, yBase, fpx, p, centerV) {   // 白フチ文字（geoedit と同じ流儀）。centerV=座標に縦中央
		ctx.font = `${fpx}px "Noto Sans JP","Hiragino Sans",sans-serif`;
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

	// ---- 識別（tip/pop）＝pbf.identifyAt（JS幾何）＋シンボルの画面矩形。geoedit と同じ許容量（画面px基準）----
	const identify = (lng, lat) => {
		const zoom = map.getZoom();
		const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, zoom));
		const fid = pbf?.identifyAt?.(lng, lat, { point: Math.max(50, 12 * mpp), polyline: Math.max(30, 8 * mpp) });
		return fid == null || fid < 0 ? null : fid;
	};
	const symbolAt = (x, y) => {
		for (let i = symHits.length - 1; i >= 0; i--) {
			const r = symHits[i];
			if (x >= r.x0 - 4 && x <= r.x1 + 4 && y >= r.y0 - 4 && y <= r.y1 + 4) return r.fid;
		}
		return null;
	};
	const localXY = e => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	// nearestOnLine（pop の錨＝クリック点に最寄りの線分上・経度は cos 補正）
	const nearestOnLine = (lines, ll) => {
		const k = Math.cos(ll[1] * Math.PI / 180) || 1;
		let best = null, bd = Infinity;
		for (const cs of lines) for (let i = 0; i + 1 < cs.length; i++) {
			const ax = cs[i][0] * k, ay = cs[i][1], bx = cs[i + 1][0] * k, by = cs[i + 1][1];
			const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
			let t = l2 ? ((ll[0] * k - ax) * dx + (ll[1] - ay) * dy) / l2 : 0;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
			const qx = (ax + t * dx) / k, qy = ay + t * dy;
			const ddx = (qx - ll[0]) * k, ddy = qy - ll[1], dd = ddx * ddx + ddy * ddy;
			if (dd < bd) { bd = dd; best = [qx, qy]; }
		}
		return best;
	};

	mapEl.addEventListener("pointermove", e => {   // @tip＝ホバー即時（geoedit と同じ：位置も内容も毎move・離れたら即消す）
		if (!items.length || e.buttons) return;
		const [x, y] = localXY(e);
		const ll = map.unprojectXY(x, y);
		const fid = symbolAt(x, y) ?? (ll ? identify(ll[0], ll[1]) : null);
		const tip = fid != null ? items[fid]?.p["@tip"] : null;
		const raw = tip != null && tip !== "" ? String(tip) : null;
		if (raw !== tipRaw) { tipRaw = raw; tipClean = raw == null ? null : sanitizeHTML(raw); }   // 内容変化時だけ消毒
		tipSet ??= map.gadget.tip();
		tipSet(tipClean);
	}, { signal, passive: true });
	let downXY = null;
	mapEl.addEventListener("pointerdown", e => { downXY = localXY(e); }, { signal, passive: true });
	mapEl.addEventListener("click", e => {   // @pop＝クリックで開く（ビューアは通常クリック＝本人裁定）。×は閉じるだけ
		if (!items.length || e.target.tagName !== "CANVAS") return;   // pop箱やUI上のクリックは素通し
		const [x, y] = localXY(e);
		if (downXY && Math.hypot(x - downXY[0], y - downXY[1]) >= 4) return;   // ドラッグ＝パン
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		const fid = symbolAt(x, y) ?? identify(ll[0], ll[1]);
		const it = fid != null ? items[fid] : null;
		const pop = it?.p["@pop"];
		if (pop == null || pop === "" || openedPops.has(fid)) return;
		// 参照点＝点:座標・線:クリック点に最寄りの線分上・面:クリック点そのもの（geoedit と同じ規約）
		const a = it.pts ? it.pts[0] : it.lines ? (nearestOnLine(it.lines, ll) || ll) : ll;
		popFn ??= map.gadget.pop();
		const div = popFn(sanitizeHTML(pop), { lng: a[0], lat: a[1], x, y, hideOffscreen: true, onClose: () => { openedPops.delete(fid); div._remove?.(); } });
		if (div) openedPops.set(fid, div);
	}, { signal });

	const unsub = map.onFrame(draw);
	signal?.addEventListener("abort", () => { unsub(); clearPops(); canvas.remove(); });
	return { set, clear, get pbf() { return pbf; }, get count() { return items.filter(Boolean).length; } };
}
