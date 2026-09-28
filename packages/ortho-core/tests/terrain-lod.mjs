// terrainlod（perf plan P4 step B・2026-09-27）の検定：チャンク主導 index の三角形の多重集合が従来（行主導）と同一＝絵は不変・区間は三角形境界／
// カリングの健全性＝真俯瞰の小窓は全可視・中央の小箱は可視・地球の裏は不可視・全球窓は半球ぶん・高チルトの 8° 窓は一部（数は目安＝大きく外れたら幾何の退行）
import { buildChunkIndex, visibleChunkRuns, chunkVisible, shadowChunkRuns } from "../src/terrainlod.js";
import { shadowWindow, sunVector, bboxInShadowWindow } from "../src/shadow.js";
import { cameraState } from "../src/camera.js";
let fails = 0; const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
for (const G of [769, 1024, 1536]) {
	const { idx, chunks } = buildChunkIndex(G);
	const Q = G - 1;
	ok(idx.length === Q * Q * 6, `G=${G}: index 数 ${idx.length} = ${Q * Q * 6}`);
	ok(chunks.length === 256 && chunks.reduce((s, c) => s + c.count, 0) === idx.length, `G=${G}: 256 チャンクの count 和 = 全 index`);
	// 三角形の集合が従来（行主導）と同一：各三角形を正規化した鍵の多重集合で比べる
	const key = (a, b, c) => a + "," + b + "," + c;
	const ref = new Map(); let p = 0;
	for (let j = 0; j < Q; j++) for (let i = 0; i < Q; i++) { const a = j * G + i, b = a + 1, c = a + G, d = c + 1; for (const t of [[a, c, b], [b, c, d]]) { const k = key(...t); ref.set(k, (ref.get(k) || 0) + 1); } }
	let miss = 0; for (let t = 0; t < idx.length; t += 3) { const k = key(idx[t], idx[t + 1], idx[t + 2]); const n = ref.get(k); if (!n) miss++; else if (n === 1) ref.delete(k); else ref.set(k, n - 1); }
	ok(miss === 0 && ref.size === 0, `G=${G}: 三角形の多重集合が従来と同一（欠け ${miss}・余り ${ref.size}）`);
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
console.log(fails ? "FAIL" : "PASS");
process.exit(fails ? 1 : 0);
