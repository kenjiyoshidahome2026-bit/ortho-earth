#!/usr/bin/env node
// 点の注記を字に割る（textsink.ts の pointGlyphs・テキスト GPU 化 T-P2）の検定（Node）。
// 偽の寸法の口＝字の幅の表＋字詰めの対（"AV" は −2）＋字間（字ごとの後ろ）。Canvas2D 版 pointText の置き方（寄せ・行の中央・format・縦書き）と同じ所に字が来るか
import { pointGlyphs, needsShaping } from "../src/textsink.ts";
let fails = 0;
const ok = (cond, label) => { if (cond) return; fails++; console.error(`  ✗ ${label}`); };
const near = (a, b, label, e = 1e-9) => ok(Math.abs(a - b) <= e, `${label}: ${a} ≠ ${b}`);

const W = { A: 8, V: 8, i: 3, W: 12, " ": 4, 東: 16, 京: 16 };
const KERN = { AV: -2 };
const scaleOf = font => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]) / 16;
const calls = [];
const measurer = (font, ls) => { calls.push([font, ls]); const k = scaleOf(font); return t => { const cs = [...t]; let w = 0; for (let i = 0; i < cs.length; i++) { w += (W[cs[i]] ?? 8) * k + ls; if (i && KERN[cs[i - 1] + cs[i]]) w += KERN[cs[i - 1] + cs[i]] * k; } return w; }; };
const F = "16px Noto Sans", F24 = "24px Noto Sans";
const plain = (lines, { ls = 0, lh = 1.2, size = 16 } = {}) => { const ws = lines.map(t => measurer(F, ls * size)(t)); return { lines, ws, w: Math.max(...ws), h: lines.length * lh * size, size, ls, lh, font: F }; };

// 素の 1 行・中央＝字の右端は「頭からその字までの部分文字列の幅」・中央はそこから字の送りの半分戻る（字詰めの −2 は A の送りに入る＝V が寄る）
{
	const tl = plain(["AVi"]), { g, img } = pointGlyphs(tl, F, "center", measurer);
	ok(g.length === 3 && img.length === 0, "AVi は 3 字・記号なし");
	near(tl.w, 17, "AVi の幅（8+8−2+3）");
	near(g[0].x, 4, "A の中央"); near(g[1].x, 14 - 4, "V の中央（字詰めで 2 だけ A に寄る＝箱は 6〜14）"); near(g[2].x, 14 + 1.5, "i の中央");
	near(g[0].y, 0.5 * 1.2 * 16, "行の中央");
	ok(g.every(q => !q.rot && !q.run && q.font === F && q.col === null), "回さない・割った字・書体・色なし");
}
// 寄せ＝行の束の幅（tl.w）の中で、その行を測った幅で寄せる・行の y は (i+0.5)×lh×size
{
	const tl = plain(["Wi", "i"]);
	const C = pointGlyphs(tl, F, "center", measurer).g, L = pointGlyphs(tl, F, "left", measurer).g, R = pointGlyphs(tl, F, "right", measurer).g;
	near(C[2].x, (15 - 3) / 2 + 1.5, "2 行目の i（中央）"); near(L[2].x, 1.5, "2 行目の i（左）"); near(R[2].x, 15 - 1.5, "2 行目の i（右）");
	near(C[2].y, 1.5 * 1.2 * 16, "2 行目の中央");
}
// 字間＝字ごとの後ろ（Canvas2D の letterSpacing）＝字の中央は送りから字間を除いた半分。空白は字を出さない（送りは進める）
{
	const tl = plain(["A i"], { ls: 0.25 }), ls = 4, g = pointGlyphs(tl, F, "left", measurer).g;
	ok(g.length === 2, "空白は字にしない");
	near(g[0].x, 4, "A の中央（字間を含まない）"); near(g[1].x, (8 + ls) + (4 + ls) + 1.5, "i の中央（A と空白の送り＋字間）");
	ok(calls.some(([f, l]) => f === F && l === ls), "字間は ls×size の px で測る");
}
// 繋げる字（アラビア文字）＝割らずに列ごと 1 枚（run）・列の箱の中央
{
	const ar = "القاهرة", tl = plain([ar]), g = pointGlyphs(tl, F, "center", measurer).g;
	ok(g.length === 1 && g[0].run && g[0].ch === ar, "アラビア文字は 1 枚の run");
	near(g[0].x, tl.w / 2, "run の中央");
	ok(needsShaping("नमस्ते") && needsShaping("é") && needsShaping("👨‍👩‍👧") && !needsShaping("東京駅 Tokyo") && !needsShaping("Ελλάδα"), "割れない列の見分け（デーヴァナーガリー・結合記号・絵文字は割れない／CJK・ラテン・ギリシャは割れる）");
}
// format（run）＝run ごとの書体と色・左から詰める・記号の区間は箱・縦の揃え（top／bottom／中央）
{
	const red = [1, 0, 0, 1];
	const runs = [[
		{ t: "A", si: 0, w: 8, h: 0, font: F, col: null, fs: 1, va: null },
		{ t: "", si: 1, img: "star", w: 10, h: 10, font: F, col: null, fs: 1, va: "top" },
		{ t: "i", si: 2, w: 4.5, h: 0, font: F24, col: red, fs: 1.5, va: "bottom" },
	]];
	const lhs = [Math.max(1.2 * 16 * 1.5, 10)], tl = { lines: ["Ai"], ws: [22.5], w: 30, h: lhs[0], size: 16, ls: 0, lh: 1.2, font: F, runs, lhs };
	const { g, img } = pointGlyphs(tl, F, "right", measurer);
	const x0 = 30 - 22.5;
	ok(g.length === 2 && img.length === 1, "字 2・記号 1");
	near(g[0].x, x0 + 4, "A（右寄せの頭から）"); near(g[0].y, lhs[0] / 2, "A は行の中央");
	near(img[0].x, x0 + 8, "記号の左"); near(img[0].y, 0, "記号は上揃え（top＝箱の上）"); ok(img[0].name === "star" && img[0].w === 10 && img[0].h === 10, "記号の名前と大きさ");
	near(g[1].x, x0 + 18 + 2.25, "i（24px の送り 4.5 の半分）"); near(g[1].y, lhs[0] - 16 * 1.5 / 2, "i は下揃え（bottom＝行の下から run の高さの半分）");
	ok(g[1].font === F24 && g[1].col === red, "run の書体と色");
}
// 縦書き＝列は右から左・字は上から下。Canvas2D は行頭の字間のまま 1 字ずつ中央揃え＝正立の字は左へ・回す字は上へ字間の半分ずれる
{
	const ls = 0.1, size = 16, lsPx = ls * size;
	const vcols = [[{ ch: "東", rot: false, adv: 16 + lsPx, font: F, col: null, fs: 1 }, { ch: "A", rot: true, adv: 8 + lsPx, font: F, col: null, fs: 1 }], [{ ch: "京", rot: false, adv: 16 + lsPx, font: F, col: null, fs: 1 }]];
	const ws = [19.2, 19.2], tl = { lines: ["東A", "京"], ws, w: 38.4, h: 40, size, ls, lh: 1.2, font: F, vcols, vhs: [27.2, 17.6], vert: true };
	const g = pointGlyphs(tl, F, "center", measurer).g;
	ok(g.length === 3, "縦書き 3 字");
	near(g[0].x, 38.4 - 9.6 - lsPx / 2, "東＝右の列の中央（字間の半分だけ左）"); near(g[0].y, (16 + lsPx) / 2, "東の y");
	ok(g[1].rot && !g[0].rot, "A は回す");
	near(g[1].x, 38.4 - 9.6, "A の x（列の中央）"); near(g[1].y, 16 + lsPx + (8 + lsPx) / 2 - lsPx / 2, "A の y（字間の半分だけ上）");
	near(g[2].x, 9.6 - lsPx / 2, "京＝左の列");
}
if (fails) { console.error(`pointglyphs: ${fails} 件 NG`); process.exit(1); }
console.log("pointglyphs: PASS");
