#!/usr/bin/env node
// sokutei の常設検定（Node だけ・外部網なし）＝射影変換で斜め撮りの基準物から正しい長さが出るか、体重の換算と係数の再推定、CSV の形。
import assert from "node:assert/strict";
import { solveHomography, applyH, homographyFromQuad, measure, polylineLength } from "../src/measure.js";
import { estimateWeight, fitK, fitC, errorStats, SPECIES } from "../src/weight.js";
import { toCSV, loadSettings, saveSettings } from "../src/store.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

// --- 射影変換：仮のカメラで地面の点を写真へ写し、4 隅から元の寸法が戻るか ---
// 地面 z=0 の点 (X,Y) を、高さ 1500mm・前傾 50° のカメラ（焦点 1000px）で写す（ピンホール）
function project([X, Y]) {
	const th = 50 * Math.PI / 180, cy = 1500;
	const x = X, y = Y * Math.cos(th), z = Y * Math.sin(th) + cy;   // カメラ座標（Y 軸を倒す）
	return [2000 + 1000 * x / z, 1500 + 1000 * y / z];
}
const A4 = [[0, 0], [297, 0], [297, 210], [0, 210]];                       // 基準物（mm）
const quad = A4.map(project);
const H = homographyFromQuad(quad, 297, 210);
assert.ok(H, "4 隅からホモグラフィが解ける");
for (const [i, p] of A4.entries()) { const q = applyH(H, quad[i]); near(q[0], p[0], 1e-6, "隅 X"); near(q[1], p[1], 1e-6, "隅 Y"); }
// 基準物の脇に横たわる 1100mm の個体（鼻先 (400,50) → 尾の付け根 (1500,120)）
const nose = [400, 50], tail = [1500, 120], trueLen = Math.hypot(1100, 70);
const r = measure({ mode: "a4", ref: quad, refSize: { w: 297, h: 210 }, body: [project(nose), project(tail)] });
near(r.cm, trueLen / 10, 0.01, "斜め撮りでも 4 隅方式は実長を返す");
assert.equal(r.warn, undefined, "基準物の近く＝注意なし");
// 回り順が逆（1→2 が長辺のまま反時計回り）でも、用紙を縦に置いても（1→2 を長辺で始めれば）長さは同じ
const r2 = measure({ mode: "a4", ref: [quad[1], quad[0], quad[3], quad[2]], refSize: { w: 297, h: 210 }, body: [project(nose), project(tail)] });
near(r2.cm, trueLen / 10, 0.01, "隅の回り順が逆でも同じ");
const quadV = [[0, 0], [0, 297], [210, 297], [210, 0]].map(project);   // 用紙を縦に置いた＝長辺が奥行き方向
const r3 = measure({ mode: "a4", ref: quadV, refSize: { w: 297, h: 210 }, body: [project(nose), project(tail)] });
near(r3.cm, trueLen / 10, 0.01, "用紙を縦に置いても 1→2 が長辺なら正しい");
// 画素の長さで長辺を当てるのは不可＝この向きでは長辺（297mm・奥行き）が短辺（210mm・横）より短く写る
assert.ok(Math.hypot(quadV[1][0] - quadV[0][0], quadV[1][1] - quadV[0][1]) < Math.hypot(quadV[2][0] - quadV[1][0], quadV[2][1] - quadV[1][1]), "斜め撮りでは長辺が短く写る");
const r3x = measure({ mode: "a4", ref: [quadV[1], quadV[2], quadV[3], quadV[0]], refSize: { w: 297, h: 210 }, body: [project(nose), project(tail)] });
assert.ok(Math.abs(r3x.cm - trueLen / 10) > 5, "短辺から始めると大きく外れる（UI が「長い辺の端から」と案内する理由）");
// 2 点方式は斜め撮りだと歪む（真上なら正しい）
const line = measure({ mode: "line", ref: [project([0, 0]), project([1000, 0])], refSize: { len: 1000 }, body: [project(nose), project(tail)] });
assert.ok(Math.abs(line.cm - trueLen / 10) > 1, "2 点方式は斜め撮りでは正確でない（だから 4 隅を推奨）");
const top = measure({ mode: "line", ref: [[0, 0], [1000, 0]], refSize: { len: 1000 }, body: [[400, 50], [1500, 120]] });
near(top.cm, trueLen / 10, 1e-9, "2 点方式：真上（画素＝mm）なら正しい");
// 折れ線（体が曲がった個体）＝区間の和
near(polylineLength([[0, 0], [30, 40], [30, 140]]), 150, 1e-9, "折れ線の長さ");
// 退化：3 点が一直線＝解けない、点が足りない＝null
assert.equal(solveHomography([[0, 0], [1, 0], [2, 0], [0, 1]], A4), null, "一直線の 4 隅は解けない");
assert.equal(measure({ mode: "a4", ref: quad.slice(0, 3), refSize: { w: 297, h: 210 }, body: [[0, 0], [1, 1]] }).cm, null, "隅が 3 つでは出さない");
assert.equal(measure({ mode: "a4", ref: quad, refSize: { w: 297, h: 210 }, body: [[0, 0]] }).cm, null, "個体の点が 1 つでは出さない");
assert.ok(measure({ mode: "a4", ref: quad, refSize: { w: 297, h: 210 }, body: [project([20000, 0]), project([25000, 0])] }).warn, "基準物から遠い個体には注意");

// --- 体重の換算 ---
const boar = SPECIES.find(s => s.id === "boar");
near(estimateWeight({ species: "boar", length: 100 }).kg, boar.k * 1e6, 0.06, "イノシシ：体長だけ＝k×L³");
assert.equal(estimateWeight({ species: "boar", length: 100 }).method, "length");
const g = estimateWeight({ species: "boar", length: 100, girth: 90 });
assert.equal(g.method, "girth"); near(g.kg, 100 * 90 * 90 / boar.c, 0.06, "イノシシ：胸囲があれば L×G²/c");
near(estimateWeight({ species: "boar", length: 100, coef: { k: 5e-5 } }).kg, 50, 0.06, "設定の係数で上書き");
assert.deepEqual(estimateWeight({ species: "other", length: 100 }), { kg: null, method: null }, "その他＝体重は出さない");
assert.deepEqual(estimateWeight({ species: "deer", length: null }), { kg: null, method: null }, "体長が無ければ出さない");
// 係数の再推定：W=4e-5·L³ の実測が 3 件以上あれば k=4e-5（中央値＝外れ値 1 件に引かれない）
const recs = [80, 100, 120, 140].map(L => ({ species: "boar", length: L, girth: L * 0.9, actWeight: 4e-5 * L ** 3 }));
near(fitK(recs), 4e-5, 1e-12, "fitK");
near(fitC(recs), 1 / (4e-5 / 0.81), 1e-6, "fitC＝L·G²/W");
assert.equal(fitK(recs.slice(0, 2)), null, "2 件では出さない");
near(fitK([...recs, { species: "boar", length: 100, actWeight: 999 }]), 4e-5, 1e-12, "外れ値 1 件に引かれない（中央値）");
const st = errorStats(recs, () => ({ k: 4e-5, c: 0.81 / 4e-5 }));   // 胸囲がある記録は L·G²/c の式で見られる＝c も合わせる
assert.equal(st.n, 4); assert.equal(st.medianPct, 0, "正しい係数なら誤差 0%");
assert.equal(errorStats([{ species: "boar", length: 100 }]), null, "実測が無ければ null");

// --- CSV と設定 ---
const csv = toCSV([{ id: "x1", at: "2026-10-23T13:00:00.000Z", species: "boar", sex: "m", age: "adult", length: 98.4, girth: null, estWeight: 31.1, estMethod: "length", actWeight: null, lat: 32.1, lon: 130.3, refMode: "a4", refSize: { w: 297, h: 210 }, note: 'メモ, "引用"' }], id => ({ boar: "イノシシ" })[id]);
const lines = csv.split("\r\n");
assert.ok(csv.startsWith("﻿日時,獣種,"), "BOM と見出し");
assert.equal(lines[1], '2026-10-23 13:00:00,イノシシ,オス,成獣,98.4,,31.1,体長,,32.1,130.3,297×210mm,"メモ, ""引用""",x1', "行の形（空は空欄・引用は二重）");
const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
saveSettings({ ref: { id: "a3" } }, storage); assert.deepEqual(loadSettings(storage), { ref: { id: "a3" } });
mem.set("sokutei:settings", "{broken"); assert.deepEqual(loadSettings(storage), {}, "壊れた設定は空から");
assert.deepEqual(loadSettings(null), {}, "storage が無くても動く");

console.log("✓ sokutei: ok");
