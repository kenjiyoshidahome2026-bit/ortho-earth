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

// ── 9. text-translate（px・anchor map は −bearing で回す／viewport はそのまま）・icon-translate・text-variable-anchor-offset（錨ごとの em のずらし）
{
	const { layer } = mkLayer();
	const base = () => { layer.setLabels([lab("T", 139.7, 35.68, { ov: true })]); layer.draw(cam); return layer.placed()[0]; };
	const p0 = base();
	layer.setLabels([lab("T", 139.7, 35.68, { ov: true, tt: [10, -4], tta: "viewport" })]); layer.draw(cam); const pv = layer.placed()[0];
	assert.ok(Math.abs(pv.x - p0.x - 10) < 1e-6 && Math.abs(pv.y - p0.y + 4) < 1e-6, "viewport＝画面でそのまま足す");
	layer.setLabels([lab("T", 139.7, 35.68, { ov: true, tt: [10, 0] })]); layer.draw({ ...cam, bearing: Math.PI / 2 }); const pm = layer.placed()[0];
	assert.ok(Math.abs(pm.x - p0.x) < 1e-3 && Math.abs(pm.y - p0.y + 10) < 1e-3, `map＝bearing 90° で (10,0) は上へ（${(pm.x - p0.x).toFixed(2)}, ${(pm.y - p0.y).toFixed(2)}）`);
	const V = lab("V", 139.7, 35.68, { va: ["top", "bottom"], vao: { top: [0, -2], bottom: [0, 2] }, size: 10, ov: true });
	layer.setLabels([V]); layer.draw(cam); const pt = layer.placed()[0];
	layer.setLabels([lab("V", 139.7, 35.68, { an: "top", off: [0, -2], size: 10, ov: true })]); layer.draw(cam); const pe = layer.placed()[0];
	assert.ok(Math.abs(pt.x - pe.x) < 1e-6 && Math.abs(pt.y - pe.y) < 1e-6, "variable-anchor-offset の最初の候補＝anchor top＋offset [0,−2] と同じ箱");
}

// ── 10. format の区間（sec＝区間ごとの書体・大きさ・色）＝行は run の列・行の高さは最大の font-scale・run ごとの書体で描く。縦書き（wm）＝列は右から左・字は上から下・ラテンは回す・並びの順に試す
{
	const { layer, ctx } = mkLayer();
	const S = lab("東京\nTokyo", 139.7, 35.68, { ov: true, size: 10, lh: 1.2, sec: [{ t: "東京", fs: 1.5 }, { t: "\n" }, { t: "Tokyo", col: [1, 0, 0, 1], fnt: { fam: ["Noto Sans"], w: 700, st: "normal" } }] });
	layer.setLabels([S]); ctx.log.length = 0; layer.draw(cam);
	const p = layer.placed()[0];
	assert.ok(Math.abs(p.h - (1.2 * 15 + 1.2 * 10)) < 1e-6, `行の高さ＝1.2×15＋1.2×10（${p.h}）`);
	assert.ok(Math.abs(p.w - Math.max(2 * 15 * 0.6, 5 * 10 * 0.6)) < 1e-6, `幅＝広い行（${p.w}）`);
	const fills = ctx.log.filter(e => e.op === "fill");
	assert.deepEqual(fills.map(e => e.s), ["東京", "Tokyo"]);
	assert.ok(/^15px/.test(fills[0].font) && /700 10px "Noto Sans"/.test(fills[1].font), `run ごとの書体（${fills[0].font}／${fills[1].font}）`);
	assert.ok(/^rgba\(255,0,0/.test(String(fills[1].fill)) && !/^rgba\(255,0,0/.test(String(fills[0].fill)), "区間の text-color");
	assert.ok(fills[1].y > fills[0].y, "2 行目は下");
	// 縦書き
	const fresh = list => { const m = mkLayer(); m.layer.setLabels(list); m.layer.draw(cam); return m; };   // 新しい層＝最初の描画は即出す（フェードの時計に依らない）
	const V = lab("東京タワー", 139.7, 35.68, { ov: true, size: 10, lh: 1.2, wm: "v" });
	const mv = fresh([V]);
	const pv = mv.layer.placed()[0], fv = mv.ctx.log.filter(e => e.op === "fill");
	assert.ok(Math.abs(pv.w - 12) < 1e-6 && Math.abs(pv.h - 50) < 1e-6, `縦書きの箱＝幅 1.2 字・高さ 5 字（${pv.w}×${pv.h}）`);
	assert.deepEqual(fv.map(e => e.s), ["東", "京", "タ", "ワ", "｜"], "字は 1 つずつ・長音は縦の形");
	assert.ok(fv.every((e, i) => i === 0 || e.y > fv[i - 1].y) && fv.every(e => Math.abs(e.x - fv[0].x) < 1e-6), "上から下へ同じ列");
	// 2 列（"\n"）＝右から左・ラテンは回す（translate で描く＝x,y が字の中心）
	const V2 = lab("東京\nAB", 139.7, 35.68, { ov: true, size: 10, lh: 1, wm: "v" });
	const f2 = fresh([V2]).ctx.log.filter(e => e.op === "fill");
	assert.deepEqual(f2.map(e => e.s), ["東", "京", "A", "B"]);
	assert.ok(f2[2].x < f2[0].x, "2 列目は左");
	// 並びの順＝"hv"＝横が置ければ横・塞がれたら縦
	const H = lab("横縦", 139.7, 35.68, { size: 10, lh: 1, wm: "hv", pad: 0 });
	layer.setLabels([H]); layer.draw(cam);
	const ph = layer.placed()[0]; assert.ok(ph.w > ph.h, "横書きが先");
	const wide = lab("Blocker", 139.7, 35.68, { an: "left", off: [0.55, 0], sort: -1, size: 10, lh: 1, pad: 0 });   // 錨の右 5.5px から塞ぐ＝横（幅 12＝右 6px）は当たる・縦（幅 10＝右 5px）は当たらない
	layer.setLabels([wide, H]); layer.draw(cam);
	const ph2 = layer.placed().find(q => q.text === "横縦"); assert.ok(ph2 && ph2.h > ph2.w, "塞がれたら縦書き");
	// 線に沿う注記＝縦に近い線で縦書き（上から下・正立の字は 1 字分の送り）
	const path = new Float64Array([139.7, 35.69, 139.7, 35.67]);   // 南北
	const fl = fresh([lab("山手線", 139.7, 35.68, { lp: true, path, ai: 0, ov: true, size: 12, wm: "hv" })]).ctx.log.filter(e => e.op === "fill");
	assert.equal(fl.length, 3); assert.ok(fl[1].y - fl[0].y > 11 && fl[2].y > fl[1].y && Math.abs(fl[1].x - fl[0].x) < 1e-6, `縦の線＝上から下へ 1 字分（${(fl[1].y - fl[0].y).toFixed(1)}）`);
	const hpath = new Float64Array([139.69, 35.68, 139.71, 35.68]);
	const fh = fresh([lab("山手線", 139.7, 35.68, { lp: true, path: hpath, ai: 0, ov: true, size: 12, wm: "hv" })]).ctx.log.filter(e => e.op === "fill");
	assert.ok(fh[1].x > fh[0].x && Math.abs(fh[1].y - fh[0].y) < 1e-6, "横の線＝横書きのまま");
}

// ── 11. 線を丸ごと持つ注記（lp 2・symbol-placement line）＝錨は描く側が表示の整数 z で symbol-spacing の間隔に置く（MapLibre の getAnchors）。
// 間隔は画面 px＝z が 1 上がると線は 2 倍に伸び錨は約 2 倍・最初の錨＝（文字/2＋2 字）% spacing・枠に続く線（lc）は spacing/2・置けない短い線は中心に 1 つ（枠に続く線は無し）・錨はタイルの枠（tbx）の中だけ・z を跨ぐと鍵が替わりフェード
{
	const PXM = 256 * 2 ** 14 / 360, PXD = PXM * Math.cos(35.68 * Math.PI / 180);   // z14 の 1°＝メルカトル（タイル単位）の px・画面（正射の球＝cos 緯度）の px
	const road = (lon0, lon1, extra = {}) => { const px = (lon1 - lon0) * PXM; return lab("Road", (lon0 + lon1) / 2, 35.68, { lp: 2, path: new Float64Array([lon0, 35.68, lon1, 35.68]), cum: new Float32Array([0, px * 16]), tz: 14, upp: 16, tbx: [139, 35, 140, 36], lc: 0, sp: 100, ov: true, size: 12, key: "road" + lon0 + lon1, ...extra }); };
	const lines = layer => layer.placed().filter(q => q.line).sort((a, b) => a.x - b.x);
	const { layer, ctx } = mkLayer();
	const LEN = 0.04 * PXD;   // 画面 378.5px・文字 "Road"＝4×12×0.6＝28.8px・間隔 100・最初＝(14.4＋24) % 100＝38.4 → 38.4・138.4・238.4・338.4（＋14.4 ≤ 378.5）
	layer.setLabels([road(139.68, 139.72)]);
	layer.draw(cam); const a = lines(layer);
	assert.equal(a.length, 4, `z14＝4 つ: ${a.length}`);
	const x0 = 400 - LEN / 2;   // 線の西端の画面 x
	assert.ok(Math.abs(a[0].x - (x0 + 38.4)) < 1.5, `最初の錨＝文字/2＋2 字分（${a[0].x.toFixed(1)} vs ${(x0 + 38.4).toFixed(1)}）`);
	assert.ok(Math.abs(a[1].x - a[0].x - 100) < 1.5, "間隔＝symbol-spacing（画面 px）");
	ctx.log.length = 0; layer.draw({ ...cam, zoom: 15 }); const b = lines(layer);
	assert.equal(b.length, 8, `z15＝線は 2 倍（757px）・錨 8 つ: ${b.length}`);
	const rx = ctx.log.filter(e => e.op === "fill" && e.s === "R").map(e => e.x);   // 字 "R" の中心＝錨 − 28.8/2 ＋ 7.2/2
	assert.ok(a.every(q => rx.some(x => Math.abs(x - (400 + (q.x - 400) * 2 - 10.8)) < 1.5)), `z を跨いだ直後＝前の z の錨（経緯度に固定＝z15 では間隔 2 倍）がフェードアウト中も描かれる（${rx.map(v => v.toFixed(0))} vs ${a.map(q => (400 + (q.x - 400) * 2 - 10.8).toFixed(0))}）`);
	for (let i = 0; i < 10; i++) layer.draw({ ...cam, zoom: 15 });
	assert.equal(lines(layer).length, 8, "落ち着けば新しい z の錨だけ");
	// 枠に続く線（lc 1）＝最初の錨は spacing/2
	const { layer: l2 } = mkLayer(); l2.setLabels([road(139.68, 139.72, { lc: 1 })]); l2.draw(cam); const c = lines(l2);
	assert.ok(c.length === 4 && Math.abs(c[0].x - (x0 + 50)) < 1.5, `続く線＝spacing/2 から（${c.length}・${c[0]?.x.toFixed(1)}）`);
	// 短い線（40px・最初の錨が収まらない）＝中心に 1 つ・枠に続く線なら無し
	const d40 = 40 / PXD, { layer: l3 } = mkLayer(); l3.setLabels([road(139.7 - d40 / 2, 139.7 + d40 / 2)]); l3.draw(cam); const d = lines(l3);
	assert.ok(d.length === 1 && Math.abs(d[0].x - 400) < 1.5, `短い線＝中心に 1 つ（${d.map(q => q.x.toFixed(1))}）`);
	const { layer: l4 } = mkLayer(); l4.setLabels([road(139.7 - d40 / 2, 139.7 + d40 / 2, { lc: 1 })]); l4.draw(cam);
	assert.equal(lines(l4).length, 0, "枠に続く短い線＝置かない（隣のタイルの続きに任せる）");
	// タイルの枠（tbx）＝西半分だけのタイル＝東半分の錨は出ない
	const { layer: l5 } = mkLayer(); l5.setLabels([road(139.68, 139.72, { tbx: [139, 35, 139.7, 36] })]); l5.draw(cam); const e = lines(l5);
	assert.ok(e.length === 2 && e.every(q => q.x < 400), `枠の中だけ: ${e.map(q => q.x.toFixed(0))}`);
	// 字送りの倍率（szn）＝"RoadName" は z15 で 2 倍（115.2px）・spacing−長さ＜spacing/4 なら間隔＝長さ＋spacing/4＝140.2（MapLibre の getAnchors）
	const { layer: l6 } = mkLayer(); l6.setLabels([road(139.68, 139.72, { text: "RoadName", szn: [6, 24] })]); l6.draw({ ...cam, zoom: 15 }); const f = lines(l6);
	assert.ok(f.length === 5 && Math.abs(f[1].x - f[0].x - 140.2) < 1.5, `長い文字＝間隔は文字＋spacing/4（${f.length}・${f.length > 1 ? (f[1].x - f[0].x).toFixed(1) : "?"}）`);
}

console.log("labels2d: ok");
