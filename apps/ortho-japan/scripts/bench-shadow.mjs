#!/usr/bin/env node
// 影の深度パスの物差し（#112 段 0）＝tests/t-shadowbench.html を実 GPU（WebGPU）・実時間で回し、東京駅の 6 か所 × 4 つの動き方の
// gpuMap（本体＝受け手の派生込み）・gpuShadow（深度パス）・描いた/使い回した回数・窓の幅と texel・落とした三角形・窓の覆いを表にする。
// 回帰検定ではない（verify には載せない）。カスケードの要否を数字で決めるための台（本人裁定 2026-09-29）。
// 使い方（apps/ortho-japan で）：node scripts/bench-shadow.mjs [--flags "&lowmem=1"] [--pos 15/60] [--runs 3]
//   --size＝窓の大きさ（CSS px・既定 1920x1080＝計画の前提。影の窓の幅は画面の対角で決まる）。--runs＝繰り返し（中央値・既定 1）。port は VSB_PORT で逃がせる。掟：ema は vsync 量子化で差が出ない＝gpu* と描いた回数で見る。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runRealtime, REALGPU } from "../../../packages/globe/scripts/lib/ui-runner.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VSB_PORT || 5264;
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const FLAGS = arg("--flags", ""), POS = arg("--pos", ""), RUNS = +arg("--runs", "1") || 1, SIZE = arg("--size", "1920x1080").replace("x", ",");

const stop = await startVite({ cwd: APP, port: PORT, portEnv: "VSB_PORT", readyUrl: `http://localhost:${PORT}/japan/` });
let fail = 0;
try {
	const url = `http://localhost:${PORT}/japan/tests/t-shadowbench.html?perf=1&hud=0&lang=ja${FLAGS}${POS ? `&pos=${POS}` : ""}`;
	const runs = [];
	for (let r = 0; r < RUNS; r++) {
		const title = await runRealtime(url, { limitS: 600, profilePrefix: "oj-shadowbench", seq: r + 1, flags: [...REALGPU, `--window-size=${SIZE}`, "--force-device-scale-factor=1"] });
		if (!title.startsWith("PASS ")) { console.error("FAIL", title.slice(0, 300)); fail = 1; break; }
		runs.push(JSON.parse(title.slice(5)));
	}
	if (!fail && runs.length) {
		const med = a => { const s = a.filter(v => v != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
		const r0 = runs[runs.length - 1];
		console.log(`backend=${r0.backend} gpu="${r0.gpu}" viewport=${r0.viewport.join("×")} t=${r0.t} flags="${FLAGS}" runs=${runs.length}`);
		console.log("pos    mode    gpuMap  aa res   gpuShadow  fps  drawn/reused  window km  m/texel  sun°  bld tris  meshes (tris)      cover (in/far km)");
		for (let i = 0; i < r0.rows.length; i++) {
			const col = k => med(runs.map(r => r.rows[i][k]));
			const s = r0.rows[i], f = (v, d = 2) => v == null ? "-" : (+v).toFixed(d);
			console.log(`${s.pos.padEnd(6)} ${s.mode.padEnd(6)} ${f(col("gpuMap")).padStart(7)}  ${String(s.aa ?? "-").padStart(2)} ${f(s.res, 2).padStart(4)}  ${f(col("gpuShadow")).padStart(9)}  ${String(col("fps") ?? "-").padStart(3)}  ${(s.mode === "off" ? "-" : `${col("drawn")}/${col("reused")}`).padStart(12)}  ${f(s.windowKm).padStart(9)}  ${f(s.texelM).padStart(7)}  ${f(s.altDeg, 1).padStart(4)}  ${String(s.bldTris ?? "-").padStart(8)}  ${(s.meshBatches == null ? "-" : `${s.meshBatches} (${s.meshTris})`).padStart(17)}  ${(s.cover ? `${s.cover.inside} / ${s.cover.farKm}` : "").padStart(16)}`);
		}
		console.log("(gpuMap＝本体パス（影の受け手の派生 FS 込み）・gpuShadow＝深度パス（描いたパスだけの EMA）・drawn/reused＝深度パスを描いた/使い回した回数（計測窓の間）・cover＝画面の地面のうち影の窓に入る割合 / 見えている地面の最遠）");
	}
} finally { stop(); }
process.exit(fail);
