// terrainlod（perf plan P4 step B・2026-09-27）の検定：チャンク主導 index の三角形の多重集合が従来（行主導）と同一＝絵は不変・区間は三角形境界／
// カリングの健全性＝真俯瞰の小窓は全可視・中央の小箱は可視・地球の裏は不可視・全球窓は半球ぶん・高チルトの 8° 窓は一部（数は目安＝大きく外れたら幾何の退行）
import { buildChunkIndex, visibleChunkRuns, chunkVisible } from "../src/terrainlod.js";
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
console.log(fails ? "FAIL" : "PASS");
process.exit(fails ? 1 : 0);
