// terrainlod（perf plan P4 step B・2026-09-27）の検定：チャンク主導 index の三角形の多重集合が従来（行主導）と同一＝絵は不変・区間は三角形境界／
// カリングの健全性＝真俯瞰の小窓は全可視・中央の小箱は可視・地球の裏は不可視・全球窓は半球ぶん・高チルトの 8° 窓は一部（数は目安＝大きく外れたら幾何の退行）
import { buildChunkIndex, visibleChunkRuns, chunkVisible, shadowChunkRuns, terrainMeshSliced, terrainGridUV } from "../src/terrainlod.ts";
import { shadowWindow, sunVector, bboxInShadowWindow } from "../src/shadow.ts";
import { cameraState } from "../src/camera.ts";
let fails = 0; const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
for (const G of [769, 1024, 1536]) {
	const { idx, chunks } = buildChunkIndex(G);
	const Q = G - 1;
	ok(idx.length === Q * Q * 6, `G=${G}: index 数 ${idx.length} = ${Q * Q * 6}`);
	ok(chunks.length === 256 && chunks.reduce((s, c) => s + c.count, 0) === idx.length, `G=${G}: 256 チャンクの count 和 = 全 index`);
	// 三角形の集合が従来（行主導）と同一：従来の三角形は格子のセル (i,j) ごとに [a,c,b]・[b,c,d] の 2 つ（頂点の並びもこの順）＝
	// index の各三角形をそのセルと種類に引き当てて数える（引き当たらない＝欠け・0 回＝余り・2 回以上＝重複）＝文字列の鍵の Map と同じ判定を
	// 数の配列で（G=1536 の 470 万三角形で 29 秒→0.1 秒・2026-10-03）
	const seen = new Uint8Array(Q * Q * 2);
	let miss = 0;
	for (let t = 0; t < idx.length; t += 3) {
		const x = idx[t], y = idx[t + 1], z = idx[t + 2];
		let a = -1, kind = 0;
		if (y === x + G && z === x + 1) a = x;                       // [a, c, b]
		else if (y === x + G - 1 && z === x + G) { a = x - 1; kind = 1; }   // [b, c, d]（b = a + 1）
		const i = a % G, j = (a - i) / G;
		if (a < 0 || i >= Q || j >= Q) { miss++; continue; }
		const s = (j * Q + i) * 2 + kind;
		if (seen[s] < 255) seen[s]++;
	}
	let rest = 0; for (let s = 0; s < seen.length; s++) if (seen[s] !== 1) rest++;
	ok(miss === 0 && rest === 0, `G=${G}: 三角形の多重集合が従来と同一（欠け ${miss}・余り/重複 ${rest}）`);
	ok(chunks.every(c => c.first % 3 === 0 && c.count % 3 === 0), `G=${G}: 区間は三角形境界`);
}
// カリング：真俯瞰 z6・窓 [130,30]+[10,10]：全チャンク可視ではないが中央は可視・全球窓の裏側は不可視
const st = cameraState({ center: [135, 35], zoom: 6, pitch: 0, bearing: 0, dpr: 1 }, 800, 600);
const { chunks } = buildChunkIndex(769);
const stats = {};
const runs = visibleChunkRuns(chunks, [130, 30, 10, 10], st, 1 / 6371000, stats);
ok(stats.drawn > 0 && stats.drawn <= 256 && runs.length >= 1, `z6 真俯瞰 10° 窓：可視 ${stats.drawn}/256・run ${runs.length}`);
ok(chunkVisible(134.9, 135.1, 34.9, 35.1, st, 1.001, [135, 35, Math.hypot(...st.eye)]), "中央の小箱は可視");
ok(!chunkVisible(-50, -40, -40, -30, st, 1.001, [135, 35, Math.hypot(...st.eye)]), "地球の裏の箱は不可視");
const stW = cameraState({ center: [135, 35], zoom: 2.5, pitch: 0, bearing: 0, dpr: 1 }, 800, 600);
const s2 = {}; visibleChunkRuns(chunks, [-180, -90, 360, 180], stW, 1 / 6371000, s2);
ok(s2.drawn > 40 && s2.drawn < 200, `z2.5 全球窓：半球ぶんだけ可視 ${s2.drawn}/256`);
// 高チルト z13：8° 混成窓＝可視は一部
const stT = cameraState({ center: [138.7274, 35.3606], zoom: 13, pitch: 60 * Math.PI / 180, bearing: 0, dpr: 1 }, 1200, 800);
const s3 = {}; const r3 = visibleChunkRuns(chunks, [135, 32, 8, 8], stT, 1 / 6371000, s3);
ok(s3.drawn > 0 && s3.drawn < 200, `z13 60° 8° 窓：可視 ${s3.drawn}/256・run ${r3.length}`);
// 影の深度パスの刈り（#112 段 2）：z13 の 8° 窓のうち、半幅 6km の影の窓（富士・冬至の昼）に掛かるチャンクだけ＝ごく一部・中心のチャンクは入る・遠い窓は 0
const T = Date.parse("2026-12-22T03:00:00Z"), win = shadowWindow(sunVector(T), [138.7274, 35.3606], 6000, 2048);
const s4 = {}; const r4 = shadowChunkRuns(chunks, [135, 32, 8, 8], win.mvp, 1 + 9000 / 6371000, s4);
const cIdx = Math.floor((138.7274 - 135) / 8 * 16) + 16 * Math.floor((35.3606 - 32) / 8 * 16), cc = chunks[cIdx];
ok(s4.drawn >= 1 && s4.drawn <= 9 && r4.some(([f, n]) => cc.first >= f && cc.first < f + n), `影の窓（半幅 6km）に掛かるチャンク ${s4.drawn}/256・中心のチャンクを含む`);
const s5 = {}; shadowChunkRuns(chunks, [135, 32, 8, 8], shadowWindow(sunVector(T), [100, 10], 6000, 2048).mvp, 1 + 9000 / 6371000, s5);
ok(s5.drawn === 0, `遠い影の窓は 0 チャンク（${s5.drawn}）`);
// 建物の束の刈り（#112 段 3）：東京駅・冬至の南中（太陽は南・31°）・半幅 5.8km の窓。窓は光に垂直＝地面の足は太陽の方位に 1/sin(高度)≈1.94 倍
//（南北に ±11.3km）。中心の区＝入る／北東 20km＝外れる／南 9km＝足の中＝入る／南 14km＝足の外（700m の塔の影が北へ 1.2km 伸びても届かない）＝外れる
const wT = shadowWindow(sunVector(Date.parse("2026-12-22T02:40:00Z")), [139.7671, 35.6812], 5800, 2048);
ok(bboxInShadowWindow(wT.mvp, [139.76, 35.675, 139.775, 35.69]), "中心の区は落とす");
ok(!bboxInShadowWindow(wT.mvp, [139.9, 35.8, 139.95, 35.85]), "北東 20km の区は刈る");
ok(bboxInShadowWindow(wT.mvp, [139.76, 35.59, 139.78, 35.6]), "南 9km の区は窓の足の中＝落とす");
ok(!bboxInShadowWindow(wT.mvp, [139.76, 35.545, 139.78, 35.555]), "南 14km の区は影が窓に届かない＝刈る");
// 時間で切る生成（terrainMeshSliced・2026-11-05）＝一気に作った物と byte 単位で同一（uv・index・チャンク）。小さな予算でも必ず終わる
for (const G of [257, 769, 1024]) {
	const it = terrainMeshSliced(G);
	let steps = 0; while (it.step(0.05)) steps++;   // 0.05 ms＝ほぼ毎回途中で返る
	ok(!it.step(10), `G=${G}: 完了後の step は false`);
	const r = it.result(), uv = terrainGridUV(G), ref = buildChunkIndex(G);
	let same = r.uv.length === uv.length && r.idx.length === ref.idx.length;
	for (let i = 0; same && i < uv.length; i++) if (r.uv[i] !== uv[i]) same = false;
	for (let i = 0; same && i < ref.idx.length; i++) if (r.idx[i] !== ref.idx[i]) same = false;
	ok(same, `G=${G}: 細切れ ${steps} 回の uv／index が一気の生成と同一`);
	ok(r.chunks.length === ref.chunks.length && r.chunks.every((c, k) => c.first === ref.chunks[k].first && c.count === ref.chunks[k].count && c.u0 === ref.chunks[k].u0 && c.v1 === ref.chunks[k].v1), `G=${G}: チャンク表も同一`);
	ok(steps > 1, `G=${G}: 途中で返る（${steps} 回）`);
}
// 退行（2026-11-06 deploy run 278・検定 clock で「terrainMeshSliced: not done」）：予算が毎回尽きる（負の予算＝常に時間切れ）と、
// 最後のチャンクを書いた直後の時間切れで step が false を返しながら完了の印を立てず、result() が投げた。step が false を返したら必ず result() が取れること
{
	const it = terrainMeshSliced(513);
	let steps = 0; while (it.step(-1)) steps++;
	let got = null; try { got = it.result(); } catch (e) { got = null; }
	ok(got !== null, `予算が常に尽きる（${steps} 回）でも step=false の後の result() は投げない`);
	ok(got !== null && got.chunks.length === 256, "チャンク 256 個そろう");
}
// 粗い index（stride・?terrcoarse・2026-11-07）：同じ頂点配列の上でチャンクの中を stride おきに結ぶ。stride 1＝従来と byte 単位で同一。
// 隣のチャンクと頂点を共有（各チャンクの列・行は i0 で始まり i1 で終わる）＝隙間なし。三角形はおよそ 1/stride²。全 index は格子の中。
for (const G of [1024, 1536]) {
	const base = buildChunkIndex(G);
	const same = buildChunkIndex(G, undefined, 1);
	ok(same.idx.length === base.idx.length && same.idx.every((v, k) => v === base.idx[k]) && same.chunks.length === 256, `G=${G}: stride 1 は従来と同一`);
	for (const s of [2, 4]) {
		const { idx, chunks } = buildChunkIndex(G, undefined, s);
		const Q = G - 1;
		ok(chunks.length === 256 && chunks.reduce((a, c) => a + c.count, 0) === idx.length && chunks.every(c => c.first % 3 === 0 && c.count % 3 === 0), `G=${G} stride ${s}: 256 チャンク・count 和・三角形境界`);
		const ratio = base.idx.length / idx.length;
		ok(ratio > s * s * 0.85 && ratio <= s * s, `G=${G} stride ${s}: 三角形 1/${(ratio).toFixed(1)}（≈1/${s * s}）`);
		ok(idx.every(v => v < G * G), `G=${G} stride ${s}: 全 index が格子の中`);
		// チャンクの箱と頂点：チャンクの三角形が使う頂点の i は [i0, i1]・j は [j0, j1] の中で、i0・i1・j0・j1 を必ず含む（隣と縁を共有）
		let box = true, edges = true;
		for (let k = 0; k < chunks.length; k++) {
			const c = chunks[k];
			const i0 = Math.round(c.u0 * Q), i1 = Math.round(c.u1 * Q), j0 = Math.round(c.v0 * Q), j1 = Math.round(c.v1 * Q);
			let hi0 = false, hi1 = false, hj0 = false, hj1 = false;
			for (let t = c.first; t < c.first + c.count; t++) {
				const v = idx[t], i = v % G, j = (v - i) / G;
				if (i < i0 || i > i1 || j < j0 || j > j1) box = false;
				if (i === i0) hi0 = true; if (i === i1) hi1 = true; if (j === j0) hj0 = true; if (j === j1) hj1 = true;
			}
			if (!(hi0 && hi1 && hj0 && hj1)) edges = false;
		}
		ok(box, `G=${G} stride ${s}: 各チャンクの頂点はその箱の中`);
		ok(edges, `G=${G} stride ${s}: 各チャンクは 4 辺の縁の頂点を使う（隣と隙間なし）`);
		// 1 チャンクの三角形の巻きが従来と同じ（a-c-b・b-c-d：a 左上・b 右・c 下・d 右下）
		const a = idx[0], cc = idx[1], b = idx[2];
		ok(b > a && cc > a && (b - a) <= s && (cc - a) % G === 0 && (cc - a) / G <= s && idx[3] === b && idx[4] === cc && idx[5] === cc + (b - a), `G=${G} stride ${s}: 最初のセルの巻き a-c-b / b-c-d`);
	}
}
console.log(fails ? "FAIL" : "PASS");
process.exit(fails ? 1 : 0);
