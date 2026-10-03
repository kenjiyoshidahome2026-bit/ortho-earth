// labels2d（注記の Canvas2D 層）を偽の 2D 文脈で回す：衝突判定の格子（boxGrid）が線形の当て方と同じ答え・
// フェードアウト中のラベルが最後の箱の位置に留まる・MapLibre の別の層の同じ点・同じ文字を 1 つに畳まない・
// 記号の差し替えで SDF の写しを焼き直す・標識が触った書体の覚えを捨てる・書体が載ったら字送りの覚えも捨てる
import assert from "node:assert/strict";
import { createLabelLayer, boxGrid } from "../src/labels2d.js";

// ── 1. boxGrid＝線形の当て方と同じ（無作為の箱・画面の外・大きな箱・NaN を混ぜる）
{
	let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const box = () => { const k = rnd(); const w = k < 0.05 ? 5000 * rnd() : 80 * rnd(), h = k < 0.05 ? 3000 * rnd() : 30 * rnd(); const x = -3000 + 9000 * rnd(), y = -3000 + 7000 * rnd(); return k > 0.99 ? [NaN, y, NaN, y + h] : [x, y, x + w, y + h]; };
	for (let trial = 0; trial < 20; trial++) {
		const lin = [], g = boxGrid();
		for (let i = 0; i < 400; i++) {
			const b = box();
			const a = lin.some(p => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
			assert.equal(g.hit(b), a, `格子と線形の答えが一致（試行 ${trial}・箱 ${i}）`);
			if (rnd() < 0.6) { lin.push(b); g.push(b); }
		}
	}
	const g = boxGrid(); g.push([0, 0, 10, 10]);
	assert.equal(g.hit([10, 0, 20, 10]), false, "接しているだけは重ならない");
	assert.equal(g.hit([9.9, 0, 20, 10]), true);
}

// ── 偽の 2D 文脈（描いた字と書体を記録する）
globalThis.OffscreenCanvas ??= class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return fakeCtx(this); } };
function fakeCtx(canvas) {
	const log = [];
	const st = { font: "10px sans-serif", letterSpacing: "0px", textAlign: "start", textBaseline: "alphabetic" };
	const t = { x: 0, y: 0 }, stack = [];
	const ctx = {
		canvas, log,
		get font() { return st.font; }, set font(v) { st.font = v; },
		get letterSpacing() { return st.letterSpacing; }, set letterSpacing(v) { st.letterSpacing = v; },
		get textAlign() { return st.textAlign; }, set textAlign(v) { st.textAlign = v; },
		get textBaseline() { return st.textBaseline; }, set textBaseline(v) { st.textBaseline = v; },
		measureText: s => ({ width: [...String(s)].length * parseFloat(st.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 10) * 0.6 }),
		fillText: (s, x, y) => log.push({ op: "fill", s, x: x + t.x, y: y + t.y, font: st.font, alpha: ctx.globalAlpha, fill: ctx.fillStyle }),
		strokeText() {}, setTransform() { t.x = 0; t.y = 0; }, translate(x, y) { t.x += x; t.y += y; }, save() { stack.push({ ...t, ...st }); }, restore() { const s = stack.pop(); if (s) { t.x = s.x; t.y = s.y; st.font = s.font; st.textAlign = s.textAlign; st.textBaseline = s.textBaseline; } },
		drawImage: (src, ...a) => log.push({ op: "img", src, a }),
		getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
		globalAlpha: 1,
	};
	return new Proxy(ctx, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
}
const W = 800, H = 600;
const cam = { center: [139.7, 35.68], zoom: 14, pitch: 0, bearing: 0, dpr: 1 };
const mkLayer = (opts) => { const canvas = { width: W, height: H }; const ctx = fakeCtx(canvas); canvas.getContext = () => ctx; return { layer: createLabelLayer(canvas, { recollideMs: 1e9, ...opts }), ctx }; };
const lab = (text, lon, lat, extra = {}) => ({ anchor: [lon, lat], text, size: 12, color: [0, 0, 0, 1], halo: [1, 1, 1, 1], haloW: 1, sort: 0, ...extra });
const texts = ctx => ctx.log.filter(e => e.op === "fill").map(e => e.s);

// ── 2. フェードアウト中のラベルは最後の箱（text-anchor＋offset）の位置に留まる
{
	const { layer, ctx } = mkLayer();
	const L = lab("Left", 139.7, 35.68, { an: "left", off: [2, 0] });
	layer.setLabels([L]);
	for (let i = 0; i < 30; i++) { ctx.log.length = 0; layer.draw(cam); }
	const shown = ctx.log.find(e => e.op === "fill" && e.s === "Left");
	assert.ok(shown, "当選したラベルが描かれる");
	// 同じ点に優先の高いラベルを足して押し出す＝フェードアウトへ
	layer.setLabels([lab("Winner!!", 139.7, 35.68, { sort: -10, size: 30 }), L]);
	ctx.log.length = 0; layer.draw(cam);
	const fading = ctx.log.find(e => e.op === "fill" && e.s === "Left");
	assert.ok(fading, "押し出されたラベルはフェードアウト中も描かれる");
	assert.ok(Math.abs(fading.x - shown.x) < 1e-6 && Math.abs(fading.y - shown.y) < 1e-6, `フェードアウト中も同じ位置（${shown.x},${shown.y} → ${fading.x},${fading.y}）`);
}

// ── 3. MapLibre の別の層（li 違い）の同じ点・同じ文字は別のラベル（フェードの状態を共有しない）
{
	const { layer, ctx } = mkLayer();
	layer.setLabels([lab("Stn", 139.7, 35.68, { mlp: true, li: 3, ov: true }), lab("Stn", 139.7, 35.68, { mlp: true, li: 7, ov: true })]);
	for (let i = 0; i < 30; i++) { ctx.log.length = 0; layer.draw(cam); }
	assert.equal(texts(ctx).filter(s => s === "Stn").length, 2, "層ごとに 1 つずつ描かれる");
	assert.equal(layer.placed().filter(p => p.text === "Stn").length, 2);
}

// ── 4. 記号の差し替え＝SDF の写しを焼き直す（古い写しを使い続けない）
{
	const { layer, ctx } = mkLayer();
	const bm = (w) => ({ width: w, height: w, close() {} });
	layer.setImage("dot", { bitmap: bm(8), sdf: true });
	layer.setLabels([lab("", 139.7, 35.68, { icon: "dot", icol: [1, 0, 0, 1] })]);
	for (let i = 0; i < 5; i++) { ctx.log.length = 0; layer.draw(cam); }
	const first = ctx.log.find(e => e.op === "img")?.src;
	assert.ok(first, "SDF の記号が描かれる");
	layer.setImage("dot", { bitmap: bm(8), sdf: true });
	ctx.log.length = 0; layer.draw(cam);
	const second = ctx.log.find(e => e.op === "img")?.src;
	assert.ok(second && second !== first, "差し替えた記号は焼き直した写しで描く");
}

// ── 5. 標識が restore の外で ctx.font を触っても、次のラベルは自分の書体で描かれる
{
	const shield = { w: 20, h: 12, draw(g) { g.font = "10px sans-serif"; } };
	const { layer, ctx } = mkLayer({ shieldFor: L => (L.code === 1 ? shield : null) });
	layer.setLabels([lab("A", 139.7, 35.68, { size: 20 }), lab("S", 139.72, 35.68, { code: 1, sort: 1 }), lab("B", 139.74, 35.68, { size: 20, sort: 2 })]);
	for (let i = 0; i < 30; i++) { ctx.log.length = 0; layer.draw(cam); }
	const b = ctx.log.find(e => e.op === "fill" && e.s === "B");
	assert.ok(b && /20px/.test(b.font), `標識の後のラベルは自分の書体（${b?.font}）`);
}

// ── 6. 書体が載った（clearFontCache）＝線の字送りの覚えも捨てる
{
	const { layer, ctx } = mkLayer();
	const path = new Float64Array([139.69, 35.68, 139.71, 35.68]);
	layer.setLabels([lab("Road", 139.7, 35.68, { lp: true, path, ai: 0, ov: true })]);
	for (let i = 0; i < 3; i++) { ctx.log.length = 0; layer.draw(cam); }
	const before = ctx.log.filter(e => e.op === "fill").map(e => e.x);
	assert.equal(before.length, 4, "線に沿う注記は字ごと");
	const realMeasure = ctx.measureText;
	ctx.measureText = s => ({ width: realMeasure(s).width * 2 });   // 書体が替わって字が 2 倍の幅になった
	layer.clearFontCache();
	ctx.log.length = 0; layer.draw(cam);
	const after = ctx.log.filter(e => e.op === "fill").map(e => e.x);
	assert.ok(Math.abs((after[3] - after[0]) - 2 * (before[3] - before[0])) < 1e-6, `字送りが新しい幅で測り直される（${before[3] - before[0]} → ${after[3] - after[0]}）`);
}

// ── 7. ズームに連続な文字の大きさ（szn＝[size(z−1), size(z+1)]・tz＝タイルの z）＝置いた箱の幅が表示の z で線形に補間され・±1 で止まる。線の注記は字送りも伸びる
{
	const { layer } = mkLayer();
	const L = lab("Scale", 139.7, 35.68, { size: 12, szn: [6, 24], tz: 14, ov: true });
	const widthAt = z => { layer.setLabels([L]); layer.draw({ ...cam, zoom: z }); return layer.placed()[0].w; };
	const w14 = widthAt(14), w145 = widthAt(14.5), w15 = widthAt(15), w16 = widthAt(16), w13 = widthAt(13), w125 = widthAt(12.5);
	assert.ok(Math.abs(w145 / w14 - 1.5) < 1e-6, `z+0.5＝1.5 倍（${w14}→${w145}）`);
	assert.ok(Math.abs(w15 / w14 - 2) < 1e-6 && Math.abs(w16 / w14 - 2) < 1e-6, "z+1 で 2 倍・それ以上は止まる");
	assert.ok(Math.abs(w13 / w14 - 0.5) < 1e-6 && Math.abs(w125 / w14 - 0.5) < 1e-6, "z−1 で半分・それ以下は止まる");
	const P = { ...lab("Fixed", 139.7, 35.68, { size: 12, ov: true }) };
	layer.setLabels([P]); layer.draw({ ...cam, zoom: 15 }); const fixed = layer.placed()[0].w; layer.draw({ ...cam, zoom: 14 });
	assert.equal(fixed, layer.placed()[0].w, "szn の無いラベルは z で変わらない");
	const { layer: ll, ctx: lc } = mkLayer();
	const path = new Float64Array([139.69, 35.68, 139.71, 35.68]);
	const adv = z => { ll.setLabels([lab("Road", 139.7, 35.68, { lp: true, path, ai: 0, ov: true, size: 12, szn: [6, 24], tz: 14 })]); lc.log.length = 0; ll.draw({ ...cam, zoom: z }); const xs = lc.log.filter(e => e.op === "fill").map(e => e.x); return xs[3] - xs[0]; };
	assert.ok(Math.abs(adv(15) / adv(14) - 2) < 1e-6, "線に沿う注記の字送りも z+1 で 2 倍");
}

// ── 8. フェードは時計（300ms の線形）＝フレームの数に依らない。variable-anchor は前回の錨を先に試す
{
	const { layer, ctx } = mkLayer();
	const A = lab("A", 139.7, 35.68, { sort: 1 });
	layer.setLabels([A]); layer.draw(cam);
	const alphaOf = s => { const e = ctx.log.find(e => e.op === "fill" && e.s === s); if (!e) return null; const m = /rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)/.exec(String(e.fill)); return m ? +m[1] : 1; };   // 文字の不透明度＝塗りの rgba の α（globalAlpha ではない）
	ctx.log.length = 0; layer.draw(cam);
	assert.equal(alphaOf("A"), 1, "最初の描画で現れる（フェードイン無し）");
	layer.setLabels([lab("B", 139.7, 35.68, { sort: 0 }), A]);   // B が勝ち A は消えていく
	const t0 = performance.now();
	let a1 = null; for (let i = 0; i < 50; i++) { ctx.log.length = 0; layer.draw(cam); a1 = alphaOf("A"); if (a1 == null) break; }
	assert.ok(a1 == null ? performance.now() - t0 >= 250 : a1 > 0 && a1 < 1, `50 フレームでは消え切らない（時計で進む・α=${a1}）`);
}
{
	const { layer } = mkLayer();
	const V = lab("Var", 139.7, 35.68, { va: ["left", "right"], ro: 1, size: 12 });
	layer.setLabels([V]); layer.draw(cam);
	assert.equal(layer.placed()[0].x > W / 2, true, "最初の候補（left＝錨の右側に置く）");
	const blocker = lab("Block", 139.7, 35.68, { an: "left", off: [1, 0], sort: -1, size: 12 });   // 右側を塞ぐ
	layer.setLabels([blocker, V]); layer.draw(cam);
	assert.equal(layer.placed().find(p => p.text === "Var").x < W / 2, true, "塞がれたら次の候補（right）へ");
	layer.setLabels([V]); layer.draw(cam);
	assert.equal(layer.placed()[0].x < W / 2, true, "塞ぎが消えても前回の錨（right）に留まる");
}

console.log("labels2d: ok");
