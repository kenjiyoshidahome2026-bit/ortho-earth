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
		fillText: (s, x, y) => log.push({ op: "fill", s, x: x + t.x, y: y + t.y, font: st.font, alpha: ctx.globalAlpha }),
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

console.log("labels2d: ok");
