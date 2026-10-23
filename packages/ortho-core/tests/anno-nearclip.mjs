// 注記/編集の塗り（canvas2D・geopbf/edit/draw makeTracer）の近平面クリップ（2026-10-24 本人スクショ「温泉郷の塗りが左上へ楔」）。
// チルトで面が画面下へ抜けてカメラ後方へ回ると、投影は写らない点を (0,0)＝画面左上で返し、塗りが左上へ細い楔を引いた。
// 今＝写らない点は画面の同次座標を運び（camera.ts projectClamped）、トレーサが近平面で環を切る。画素ごとに「塗られたか」と
// 「その画素の地面が面の中か」を突き合わせる（真値＝unproject して円の中心からの大円距離）。
import { cameraState, project, unproject } from "../src/camera.ts";
import { makeTracer } from "../../geopbf/src/edit/draw.ts";
let fail = 0; const ok = (n, c) => { if (!c) fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}`); };
const D2R = Math.PI / 180;
const W = 800, H = 600;
const st = cameraState({ center: [137.6, 36.4], zoom: 11, pitch: 60 * D2R, bearing: 0 }, W, H);
// 目の直下（真下の地面）＝カメラ後方と前方の境の近く
const E = st.eye, el = Math.hypot(...E);
const nadir = [Math.atan2(E[2], E[0]) / D2R, Math.asin(E[1] / el) / D2R];
const gcDist = (a, b) => { const [l1, p1, l2, p2] = [a[0] * D2R, a[1] * D2R, b[0] * D2R, b[1] * D2R]; return Math.acos(Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(l1 - l2))) / D2R; };
const circle = (c, rDeg, n = 96) => { const r = []; for (let i = 0; i <= n; i++) { const a = -2 * Math.PI * i / n; r.push([c[0] + Math.cos(a) * rDeg / Math.cos(c[1] * D2R), c[1] + Math.sin(a) * rDeg]); } return r; };
// パスを記録 → 偶奇規則で画素を判定
const rec = () => { const segs = []; let cur = null, start = null; return { segs,
	moveTo(x, y) { if (cur && start) segs.push([cur, start]); cur = start = [x, y]; },
	lineTo(x, y) { segs.push([cur, [x, y]]); cur = [x, y]; },
	closePath() { if (cur && start) segs.push([cur, start]); cur = start; }, arc() {} }; };
const inside = (segs, x, y) => { let c = false; for (const [a, b] of segs) if ((a[1] > y) !== (b[1] > y) && x < a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])) c = !c; return c; };
const check = (name, c, rDeg, pr) => {
	const ctx = rec(), T = makeTracer(ctx);
	T.tracePts(pr, circle(c, rDeg), true); ctx.closePath();
	let bad = 0, tl = 0, n = 0, inN = 0;
	for (let y = 4; y < H; y += 8) for (let x = 4; x < W; x += 8) {
		const g = unproject(st, x, y); if (!g) continue;
		const truth = gcDist(g, c) < rDeg * 0.999, edge = Math.abs(gcDist(g, c) - rDeg) < rDeg * 0.02;
		if (edge) continue;
		const got = inside(ctx.segs, x, y); n++; if (truth) inN++;
		if (got !== truth) { bad++; if (x < W / 3 && y < H / 3) tl++; }
	}
	return { bad, tl, n, inN, segs: ctx.segs.length };
};
const prNew = (lon, lat) => project(st, lon, lat);
const prOld = (lon, lat) => { const r = project(st, lon, lat); return [r[0], r[1], r[2]]; };   // 旧の投影（写らない点は (0,0)）
// 面の一部がカメラ後方（目の直下の少し後ろを中心に・画面下端を跨ぐ大きさ）
const fwd = unproject(st, W / 2, H - 1), c0 = [nadir[0] + (nadir[0] - fwd[0]) * 1.5, nadir[1] + (nadir[1] - fwd[1]) * 1.5];
const rr = gcDist(c0, fwd) * 1.15;
{
	const bw = project(st, c0[0], c0[1]);
	ok(`前提：面の中心はカメラ後方で写らない（同次座標つき・len=${bw.length}）`, bw.length === 6 && bw[2] < 0 && bw[5] <= 1e-6);
	const o = check("old", c0, rr, prOld), m = check("new", c0, rr, prNew);
	console.log(`  旧: 誤画素 ${o.bad}/${o.n}（左上 ${o.tl}）  新: 誤画素 ${m.bad}/${m.n}（左上 ${m.tl}）・中の画素 ${m.inN}`);
	ok("旧の投影は誤描画を再現する（左上を含む）", o.bad > 0 && o.tl > 0);
	ok("新：画面下端を跨いでカメラ後方へ回った面も誤画素 0", m.bad === 0 && m.inN > 0);
}
// 画面の左右下へ抜ける（中心は横にずらす）
for (const side of [-1, 1]) {
	const cn = unproject(st, side > 0 ? W - 1 : 0, H - 1);
	const c = [cn[0] + (nadir[0] - fwd[0]) * 1.5 + side * 0.01, cn[1] + (nadir[1] - fwd[1]) * 1.5];
	const m = check("new", c, gcDist(c, cn) * 1.15, prNew), o = check("old", c, gcDist(c, cn) * 1.15, prOld);
	ok(`新：${side > 0 ? "右" : "左"}下へ抜けた面も誤画素 0（新 ${m.bad}/${m.n}・旧 ${o.bad}・中 ${m.inN}）`, m.bad === 0 && m.inN > 0 && o.bad > 0);
}
// 全部が見える面は従来どおり（同次座標なし＝点列は旧と同一）
{
	const g = unproject(st, W / 2, H / 2), a = check("old", g, 0.02, prOld), b = check("new", g, 0.02, prNew);
	ok(`全部が見える面は旧と同じ（誤画素 ${b.bad}・パスの辺 ${a.segs}=${b.segs}）`, b.bad === 0 && a.segs === b.segs);
}
// 目の真下を囲む面（カメラ後方と前方の両方へ広がる）＝画面下側が塗られる
{
	const m = check("new", nadir, rr * 2, prNew);
	ok(`目の真下を囲む大きな面も誤画素 0（${m.bad}/${m.n}・中 ${m.inN}）`, m.bad === 0 && m.inN > 0);
}
if (fail) { console.error(`anno-nearclip: ${fail} FAIL`); process.exit(1); }
console.log("anno-nearclip: all PASS");
