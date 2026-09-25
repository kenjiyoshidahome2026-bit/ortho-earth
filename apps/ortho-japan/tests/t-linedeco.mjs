#!/usr/bin/env node
// 線の飾り（MapLibre の line-offset／line-gradient・#49）の canvas2D の口（globe/pattern-2d.js）の常設検定。
// 見るもの：平行ずらしの向き（右が正＝画面 y 下向き）とマイター・鋭角の打ち切り・色の止めの切り出し・
// 偽の canvas で回して「線分ごとに線形の色」「ずらした座標で描く」「模様の層は従来どおり」。
import { offsetPolyline, gradStops, init, message, frame } from "@ortho-earth/globe/pattern-2d.js";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

{
	const q = offsetPolyline(new Float64Array([0, 0, 10, 0]), 2);   // 東向き＝右は画面の下（+y）
	t("直線：東向きの右は +y", near(q[1], 2) && near(q[3], 2) && near(q[0], 0) && near(q[2], 10), [...q].join());
	const l = offsetPolyline(new Float64Array([0, 0, 10, 0]), -3);
	t("負＝左へ", near(l[1], -3) && near(l[3], -3));
	const c = offsetPolyline(new Float64Array([0, 0, 10, 0, 10, 10]), 1);   // 右折（東→南）＝角は内側 (9,1)
	t("直角のマイター＝(9,1)", near(c[2], 9) && near(c[3], 1), [...c].join());
	const s = offsetPolyline(new Float64Array([0, 0, 10, 0, 0, 0.1]), 1);   // ほぼ折り返し＝打ち切り 2×|off| 以内
	t("鋭角は 2×|off| で打ち切る", Math.hypot(s[2] - 10, s[3]) <= 2 + 1e-9, [...s].join());
	t("0 は元のまま", offsetPolyline(new Float64Array([1, 2, 3, 4]), 0).join() === "1,2,3,4");
}
{
	const lut = ["a", "b", "c", "d", "e"];   // 0, .25, .5, .75, 1
	const st = gradStops(lut, 0.25, 0.75);
	t("色の止め：区間の両端＋中の見本", st.map(x => x[1]).join() === "b,c,d" && near(st[1][0], 0.5), JSON.stringify(st));
	t("色の止め：長さ 0 の区間でも 2 つ", gradStops(lut, 0.5, 0.5).length === 2);
}
{
	const calls = [];
	const grad = () => { const g = { stops: [], addColorStop: (o, c) => g.stops.push([o, c]) }; return g; };
	const ctx = { setTransform() {}, clearRect() {}, beginPath() { calls.push(["begin"]); }, moveTo: (x, y) => calls.push(["M", x, y]), lineTo: (x, y) => calls.push(["L", x, y]), closePath() {}, stroke() { calls.push(["S", ctx.strokeStyle]); }, fill() {}, setLineDash: d => calls.push(["dash", d.join()]),
		createLinearGradient: (...a) => { const g = grad(); calls.push(["G", ...a, g]); return g; }, createPattern: () => ({ setTransform() {} }), strokeStyle: null, fillStyle: null, lineWidth: 1, lineJoin: "", lineCap: "", globalAlpha: 1 };
	init({ getContext: () => ctx });
	const api = { dpr: 1, project: (lon, lat) => [lon * 100, -lat * 100, 1] };   // 経度→x・緯度→上
	const ring = new Float64Array([0, 0, 1, 0, 2, 0]);
	message({ type: "layer", id: "g", kind: "line", order: 0, items: [{ rings: [ring], color: "#000", opacity: 1, width: 4, grad: { lut: ["red", "green", "blue"], prog: [new Float32Array([0, 0.5, 1])] } }] });
	frame({}, {}, { w: 400, h: 300 }, api);
	const gs = calls.filter(c => c[0] === "G");
	t("line-gradient＝線分ごとに線形の色（2 本）", gs.length === 2 && calls.filter(c => c[0] === "S").length === 2);
	t("止めは頭 red→中 green→尻 blue", gs[0][5].stops.map(s => s[1]).join() === "red,green" && gs[1][5].stops.map(s => s[1]).join() === "green,blue", JSON.stringify(gs.map(g => g[5].stops)));
	calls.length = 0;
	message({ type: "removeLayer", id: "g" });
	message({ type: "layer", id: "o", kind: "line", order: 0, items: [{ rings: [ring], color: "rgba(0,0,255,1)", opacity: 1, width: 2, offset: 5, dash: [2, 1] }] });
	frame({}, {}, { w: 400, h: 300 }, api);
	const ys = calls.filter(c => c[0] === "M" || c[0] === "L").map(c => c[2]);
	t("line-offset＝ずらした座標で描く（東向き＋5 → y=5）", ys.length === 3 && ys.every(y => near(y, 5)), JSON.stringify(calls));
	t("line-dasharray は線幅倍（[2,1]×2）", calls.some(c => c[0] === "dash" && c[1] === "4,2"));
	t("色は color（模様なし）", calls.some(c => c[0] === "S" && c[1] === "rgba(0,0,255,1)"));
	message({ type: "removeLayer", id: "o" });
}

console.log(`\n${ok} ok / ${ng} ng`);
process.exit(ng ? 1 : 0);
