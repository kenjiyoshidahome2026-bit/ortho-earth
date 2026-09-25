// 塗り/線の模様（MapLibre の fill-pattern／line-pattern 相当・2026-09-21）＝canvas2D のオーバーレイ。
// 線の飾り（line-gradient／line-offset・#49・2026-09-25）も同じ口で描く＝gint の線は色が地物ごと一色・ずらしを持たない。
// ⚠設計原則「紙の遺物を捨てる」（破線・ハッチ＝紙の産物）の側の機能＝既定では何も描かない。MapLibre の層を受けるための互換の口だけ。
// main（app.js の addLayer）が記号帳の画像（名前→ImageBitmap・pixelRatio）と、面/線の経緯度列・模様の名前を渡す。
// 模様は画面ピクセルで敷き詰め（MapLibre と同じく大きさはズームで変わらない）・錨＝層の最初の頂点の投影＝パンに合わせて地図と一緒に動く。
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size, api) / destroy()。依存ゼロ。

let ctx = null;
const images = new Map(), pats = new Map(), layers = new Map();
let host = null;
export function init(canvas, _opts, h) { ctx = canvas.getContext("2d"); host = h || null; }
// data＝{ type:"image", name, bitmap, pixelRatio } | { type:"layer", id, kind:"fill"|"line", items, order } | { type:"removeLayer", id }
// items＝[{ rings:[Float64Array(lon,lat…)], pattern?, color?, opacity, width, offset?, dash?, grad? }]
//   pattern＝記号帳の名前（模様）・無ければ color（CSS 色）で塗る。offset＝line-offset（画面 px・右が正）。dash＝線幅倍の模様。
//   grad＝line-gradient＝{ prog:[Float32Array(各頂点の進み 0..1)]（rings と対）, lut:[CSS 色…]（進み 0..1 を等分した見本） }
export function message(d) {
	if (d.type === "probe") {   // 検定用＝今の画素を main へ（dbgHost.__ovPixels・t-linedeco）
		try { const im = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height); host?.post({ type: "pixels", id: d.id, w: im.width, h: im.height, data: im.data }); }
		catch (e) { host?.post({ type: "pixels", id: d.id, error: String(e?.message || e) }); }
		return;
	}
	if (d.type === "image") { images.set(d.name, { bm: d.bitmap, pr: d.pixelRatio || 1 }); pats.delete(d.name); }
	else if (d.type === "layer") layers.set(d.id, d);
	else if (d.type === "removeLayer") layers.delete(d.id);
}
const patOf = name => { let p = pats.get(name); if (!p) { const im = images.get(name); if (!im || !ctx) return null; p = { p: ctx.createPattern(im.bm, "repeat"), pr: im.pr }; pats.set(name, p); } return p; };

// 画面の折れ線（[x0,y0,x1,y1…]）を進行方向の右へ off px 平行にずらす（MapLibre の line-offset と同じ向き＝画面は y 下向き）。
// 角はマイター（二等分線の方向へ off/cos(θ/2)）。鋭角でマイターが伸びすぎる所（2×|off| 超）は二等分線の長さで打ち切る。
export function offsetPolyline(p, off) {
	const n = p.length >> 1, out = new Float64Array(p.length);
	if (n < 2 || !off) { out.set(p); return out; }
	const nrm = i => {   // 線分 i→i+1 の右の単位法線
		const dx = p[i * 2 + 2] - p[i * 2], dy = p[i * 2 + 3] - p[i * 2 + 1], l = Math.hypot(dx, dy) || 1;
		return [-dy / l, dx / l];
	};
	for (let i = 0; i < n; i++) {
		const a = nrm(Math.max(0, i - 1)), b = nrm(Math.min(n - 2, i));
		let mx = a[0] + b[0], my = a[1] + b[1];
		const ml = Math.hypot(mx, my);
		let k = off;
		if (ml < 1e-9) { mx = b[0]; my = b[1]; }   // 折り返し（180°）＝後ろの線分の法線
		else { mx /= ml; my /= ml; const c = mx * b[0] + my * b[1]; k = off / Math.max(c, 0.5); }   // cos(θ/2) の下限 0.5＝2×|off| で打ち切り
		out[i * 2] = p[i * 2] + mx * k; out[i * 2 + 1] = p[i * 2 + 1] + my * k;
	}
	return out;
}
// 見本（lut＝進み 0..1 の等分）から [t0,t1] の区間の色の止め（線分の中の 0..1）を作る
export function gradStops(lut, t0, t1) {
	const m = lut.length - 1, at = t => lut[Math.max(0, Math.min(m, Math.round(t * m)))];
	const stops = [[0, at(t0)]];
	if (t1 > t0) for (let j = Math.ceil(t0 * m + 1e-9); j < t1 * m; j++) stops.push([(j / m - t0) / (t1 - t0), lut[j]]);
	stops.push([1, at(t1)]);
	return stops;
}

export function frame(cam, s, { w, h }, api) {
	if (!ctx) return false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, w, h);
	if (!layers.size || !api) return false;
	const dpr = api.dpr || 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	for (const L of [...layers.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
		const a0 = L.items[0]?.rings?.[0];
		const anc = a0 ? api.project(a0[0], a0[1]) : [0, 0, 1];
		for (const it of L.items) {
			let paint = it.color || "#000";
			if (it.pattern) {
				const pt = patOf(it.pattern); if (!pt) continue;
				pt.p.setTransform(new DOMMatrix().translate(anc[0], anc[1]).scale(1 / pt.pr));   // 錨＝地図に貼り付く・pixelRatio で実寸
				paint = pt.p;
			}
			// 投影（画面の折れ線）。地球の裏へ回る図形は描かない（地平で切らない＝簡略）
			const scr = [];
			let back = false;
			for (const r of it.rings) {
				const q = new Float64Array(r.length);
				for (let i = 0; i < r.length; i += 2) { const v = api.project(r[i], r[i + 1]); if (v[2] < 0) { back = true; break; } q[i] = v[0]; q[i + 1] = v[1]; }
				if (back) break;
				scr.push(it.offset ? offsetPolyline(q, it.offset) : q);
			}
			if (back) continue;
			ctx.globalAlpha = it.opacity ?? 1;
			if (L.kind === "fill") {
				ctx.beginPath();
				for (const q of scr) { for (let i = 0; i < q.length; i += 2) i ? ctx.lineTo(q[i], q[i + 1]) : ctx.moveTo(q[i], q[i + 1]); ctx.closePath(); }
				ctx.fillStyle = paint; ctx.fill("evenodd");
				continue;
			}
			const wd = it.width || 1;
			ctx.lineWidth = wd; ctx.lineJoin = "round"; ctx.lineCap = it.dash ? "butt" : "round";
			ctx.setLineDash(it.dash ? it.dash.map(v => v * wd) : []);
			if (it.grad) {   // 線分ごとに線形の色（止めは見本から）＝線に沿った色の変化。丸端の重なりで継ぎ目を埋める
				scr.forEach((q, ri) => {
					const pr = it.grad.prog[ri];
					for (let i = 0; i + 3 < q.length; i += 2) {
						const g = ctx.createLinearGradient(q[i], q[i + 1], q[i + 2], q[i + 3]);
						for (const [o, c] of gradStops(it.grad.lut, pr[i >> 1], pr[(i >> 1) + 1])) g.addColorStop(o, c);
						ctx.beginPath(); ctx.moveTo(q[i], q[i + 1]); ctx.lineTo(q[i + 2], q[i + 3]);
						ctx.strokeStyle = g; ctx.stroke();
					}
				});
				continue;
			}
			ctx.beginPath();
			for (const q of scr) for (let i = 0; i < q.length; i += 2) i ? ctx.lineTo(q[i], q[i + 1]) : ctx.moveTo(q[i], q[i + 1]);
			ctx.strokeStyle = paint; ctx.stroke();
		}
	}
	ctx.globalAlpha = 1;
	ctx.setLineDash([]);
	return false;
}
export function destroy() { ctx = null; layers.clear(); pats.clear(); images.clear(); }
