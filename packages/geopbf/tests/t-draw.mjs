#!/usr/bin/env node
// t-draw: src/edit/draw.ts（@スタイル描画の正典＝図形表・大円トレーサ・帯のパス・経度の最短差）の検定（改良点 17・2026-10-12）。
//   canvas は要らない＝moveTo/lineTo/arc を記録するスタブ ctx で「何点がどこへ出たか」を数字で見る。
import { SHAPE_NAMES, SHAPE_SCALE, PICTO, BOTTOM_ANCHOR, makeTracer, dLon, buildLinePath } from "../src/edit/draw.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const ctxRec = () => { const ops = []; return { ops, moveTo: (x, y) => ops.push(["M", x, y]), lineTo: (x, y) => ops.push(["L", x, y]), arc: (...a) => ops.push(["A", ...a]), closePath: () => {} }; };

// 図形表
ok(Object.keys(PICTO).every(k => SHAPE_NAMES.includes(k)) && Object.keys(SHAPE_SCALE).every(k => SHAPE_NAMES.includes(k)) && [...BOTTOM_ANCHOR].every(k => SHAPE_NAMES.includes(k)), "PICTO / SHAPE_SCALE / BOTTOM_ANCHOR の鍵は SHAPE_NAMES にある");
ok(Object.values(PICTO).every(d => /^M[\d.\s,A-Za-z-]+Z?$/.test(d.trim())) && Object.values(SHAPE_SCALE).every(v => v > 0.5 && v < 2), "PICTO は M で始まるパス・SHAPE_SCALE は 0.5〜2");
ok(new Set(SHAPE_NAMES).size === SHAPE_NAMES.length, "SHAPE_NAMES に重複なし");

// 経度の最短差
ok(dLon(170, -170) === 20 && dLon(-170, 170) === -20 && Math.abs(dLon(0, 180)) === 180 && dLon(10, 10) === 0 && dLon(179.9, -179.9) > 0 && Math.abs(dLon(179.9, -179.9) - 0.2) < 1e-9, "dLon: antimeridian をまたぐ最短差");

// トレーサ（正射影の代わりの単純な投影＝[lon, lat, 可視=1 か -1]）
{
	const pr = (lon, lat) => [lon, lat, lon >= 0 ? 1 : -1];   // 西半球は裏側
	const ctx = ctxRec(), T = makeTracer(ctx);
	const seg = T.seg(pr, [0, 0], [10, 0]);
	ok(seg.length === 21 && seg[0][0] === 0 && Math.abs(seg[20][0] - 10) < 1e-9 && seg.every((p, i) => i === 0 || p[0] >= seg[i - 1][0]), `seg: 10° の辺は 0.5° 刻みで 21 点（${seg.length}）`);
	ok(T.seg(pr, [0, 0], [0.2, 0]).length === 2, "seg: 短い辺は端点だけ（n=1）");
	const gc = T.seg(pr, [0, 60], [90, 60]);
	ok(gc.length > 2 && Math.max(...gc.map(p => p[1])) > 60.5, "seg: 大円＝緯線より北へ膨らむ（60°N の 90° 区間）");
	const far = T.seg(pr, [170, 0], [-170, 0]);
	ok(far.length === 41 && far.every(p => Math.abs(p[0]) >= 170 || Math.abs(Math.abs(p[0]) - 180) < 1e-9), "seg: 反対側回りにならない（antimeridian の最短側）");
	// tracePts: fill=false は見えない区間で切る
	T.tracePts(pr, [[-5, 0], [5, 0]], false);
	const M = ctx.ops.filter(o => o[0] === "M").length, L = ctx.ops.filter(o => o[0] === "L").length;
	ok(M === 1 && L === 10 && ctx.ops.find(o => o[0] === "M")[1] === 0, `tracePts(fill=false): 可視になった所から moveTo（M${M} L${L}）`);
	ctx.ops.length = 0;
	T.tracePts(pr, [[-5, 0], [5, 0]], true);
	ok(ctx.ops.filter(o => o[0] === "M").length === 1 && ctx.ops.length === 21 && ctx.ops[0][1] === -5, "tracePts(fill=true): 不可視も切らず一本（21 点）");
	ctx.ops.length = 0;
	T.tracePts(pr, [[-10, 0], [-5, 0]], true);
	ok(ctx.ops.length === 0, "tracePts(fill=true): 全点不可視は描かない");
	// 写らない点（カメラ後方＝同次座標 [x,y,f<0,hx,hy,hw] つき）は近平面で切る：見える点から (h−a·w) の向きの遠方へ。(0,0) へは行かない（2026-10-24）
	ctx.ops.length = 0;
	const prB = (lon, lat) => lat < 0 ? [0, 0, -1, 500 * -1, (100 - lat * 10) * -1, -1] : [500 + lon, 100 - lat * 10, 1];   // 南＝カメラ後方（hw<0）
	T.tracePts(prB, [[-10, 5], [10, 5], [10, -5], [-10, -5], [-10, 5]], true);
	const ys = ctx.ops.map(o => o[2]);
	ok(!ctx.ops.some(o => o[1] === 0 && o[2] === 0) && Math.max(...ys.map(Math.abs)) > 1e4 && ctx.ops[0][0] === "M", `tracePts(fill=true): カメラ後方の点は (0,0) でなく画面の遠方へ（最遠 |y| ${Math.max(...ys.map(Math.abs)).toFixed(0)}）`);
	ctx.ops.length = 0;
	T.tracePts(prB, [[-10, -5], [10, -5], [10, -6], [-10, -5]], true);
	ok(ctx.ops.length === 0, "tracePts(fill=true): 全点がカメラ後方は描かない");
	const pl = T.projLine(pr, [[-5, 0], [5, 0]]);
	ok(pl.length === 11 && pl.every(p => p[2] >= 0) && pl[0][0] === 0, "projLine: 裏半球の点を落とす（-5..5 の 21 点のうち 0 以上の 11 点）");
	ok(T.projLine(pr, [[1, 1]]).length === 0, "projLine: 1 点は空");
}
// 帯のパス
{
	const ctx = ctxRec();
	buildLinePath(ctx, [[0, 0], [100, 0]], 10, "", "");
	ok(ctx.ops.length === 4 && ctx.ops[0][0] === "M" && Math.abs(ctx.ops[0][2]) === 5 && ctx.ops.every(o => Math.abs(o[2]) === 5), "butt: 直線は 4 頂点の長方形（半幅 5）");
	const c2 = ctxRec();
	buildLinePath(c2, [[0, 0], [100, 0]], 10, "", "arrow");
	const tip = c2.ops.find(o => o[0] === "L" && o[1] === 100 && o[2] === 0);
	const shoulders = c2.ops.filter(o => Math.abs(o[2]) === 10);
	ok(tip && shoulders.length === 2 && Math.abs(shoulders[0][1] - (100 - 10 * Math.sqrt(3))) < 1e-9, "arrow: 先端は端点そのもの・肩は幅 2w・基部は w√3 手前");
	const c3 = ctxRec();
	buildLinePath(c3, [[0, 0], [100, 0]], 10, "round", "round");
	ok(c3.ops.filter(o => o[0] === "A").length === 2 && c3.ops.filter(o => o[0] === "A").every(o => o[3] === 5), "round: 両端に半径 hw の弧");
	const c4 = ctxRec();
	buildLinePath(c4, [[0, 0], [100, 0]], 10, "square", "square");
	ok(c4.ops.some(o => o[1] === 105) && c4.ops.some(o => o[1] === -5), "square: hw だけ外へ張り出す");
	const c5 = ctxRec();
	buildLinePath(c5, [[0, 0], [0.05, 0.05], [0, 0]], 10, "", "");
	ok(c5.ops.length === 0, "重複点だけ（長さ 0）は何も描かない");
	const c6 = ctxRec();
	buildLinePath(c6, [[0, 0], [50, 0], [50, 0.01], [100, 0]], 10, "", "");
	ok(c6.ops.length === 6 && c6.ops.every(o => Math.abs(Math.abs(o[2]) - 5) < 0.02), "連続重複点（0.1px 未満）は 1 点に＝miter のスパイクが出ない");
	const c7 = ctxRec();
	buildLinePath(c7, [[0, 0], [100, 0], [0, 0.0001]], 10, "", "");
	ok(c7.ops.filter(o => Math.abs(o[1] - 100) < 1).every(o => Math.abs(o[2]) <= 5 * 2.9 + 1e-9) && c7.ops.length === 6, "180° 折返しの miter は clamp（折返し点のオフセットは半幅の 2.9 倍まで）");
}
if (fails) { console.error(`${fails} 件失敗`); process.exit(1); }
console.log("全件通過");
