// 塗り/線の模様（MapLibre の fill-pattern／line-pattern 相当・2026-09-21）＝canvas2D のオーバーレイ。
// ⚠設計原則「紙の遺物を捨てる」（破線・ハッチ＝紙の産物）の側の機能＝既定では何も描かない。MapLibre の層を受けるための互換の口だけ。
// main（app.js の addLayer）が記号帳の画像（名前→ImageBitmap・pixelRatio）と、面/線の経緯度列・模様の名前を渡す。
// 模様は画面ピクセルで敷き詰め（MapLibre と同じく大きさはズームで変わらない）・錨＝層の最初の頂点の投影＝パンに合わせて地図と一緒に動く。
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size, api) / destroy()。依存ゼロ。

let ctx = null;
const images = new Map(), pats = new Map(), layers = new Map();
export function init(canvas) { ctx = canvas.getContext("2d"); }
// data＝{ type:"image", name, bitmap, pixelRatio } | { type:"layer", id, kind:"fill"|"line", items:[{ rings:[Float64Array(lon,lat…)], pattern, opacity, width }], order } | { type:"removeLayer", id }
export function message(d) {
	if (d.type === "image") { images.set(d.name, { bm: d.bitmap, pr: d.pixelRatio || 1 }); pats.delete(d.name); }
	else if (d.type === "layer") layers.set(d.id, d);
	else if (d.type === "removeLayer") layers.delete(d.id);
}
const patOf = name => { let p = pats.get(name); if (!p) { const im = images.get(name); if (!im || !ctx) return null; p = { p: ctx.createPattern(im.bm, "repeat"), pr: im.pr }; pats.set(name, p); } return p; };
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
			const pt = patOf(it.pattern); if (!pt) continue;
			pt.p.setTransform(new DOMMatrix().translate(anc[0], anc[1]).scale(1 / pt.pr));   // 錨＝地図に貼り付く・pixelRatio で実寸
			ctx.beginPath();
			let back = false;
			for (const r of it.rings) {
				for (let i = 0; i < r.length; i += 2) { const q = api.project(r[i], r[i + 1]); if (q[2] < 0) { back = true; break; } i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }
				if (back) break;
				if (L.kind === "fill") ctx.closePath();
			}
			if (back) continue;   // 地球の裏へ回る図形は描かない（地平で切らない＝簡略）
			ctx.globalAlpha = it.opacity ?? 1;
			if (L.kind === "fill") { ctx.fillStyle = pt.p; ctx.fill("evenodd"); }
			else { ctx.strokeStyle = pt.p; ctx.lineWidth = it.width || 1; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke(); }
		}
	}
	ctx.globalAlpha = 1;
	return false;
}
export function destroy() { ctx = null; layers.clear(); pats.clear(); images.clear(); }
