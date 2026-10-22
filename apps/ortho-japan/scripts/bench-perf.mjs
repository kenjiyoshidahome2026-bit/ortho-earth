#!/usr/bin/env node
// 性能の基準線（perf plan §1・Phase 0）＝tests/t-perfbench.html を実 GPU・実時間で回し、シーンごとの gpuMap／gpuGint（timestamp-query の EMA）・
// res 段・AA 段・引っ掛かり（計器 a/b の 4ms 超）を表にする。回帰検定ではない（verify には載せない）。
// 使い方（apps/ortho-japan で）：node scripts/bench-perf.mjs [--flags "&gmax=768"] [--scene fuji-z13-60t] [--runs 3] [--set labels] [--app nl]
//   --set labels＝注記の計測場面（テキスト GPU 化 T-P0・東京 z15／東京駅 z17.5 55°／世界 z3）。--app nl＝ortho-nl の tests/t-labelbench.html（デルフト＝線に沿う注記の本命）
//   --flags＝頁に足す旗（例 "&gmax=768"＝P4 の天井・"&quad4=0"＝P3 の A/B）。--runs＝繰り返し（中央値を採る・既定 1）
// 掟：ema は vsync 量子化で差が出ない＝gpuMap/gpuGint と引っ掛かり数で見る（計画書 §1）。port は VPB_PORT で逃がせる。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runRealtime, REALGPU } from "../../../packages/globe/scripts/lib/ui-runner.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VPB_PORT || 5263;
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const FLAGS = arg("--flags", ""), SCENE = arg("--scene", ""), RUNS = +arg("--runs", "1") || 1, SET = arg("--set", ""), NL = arg("--app", "") === "nl";
const ROOT = NL ? path.join(path.dirname(APP), "ortho-nl") : APP, BASE = NL ? "nl" : "japan", PAGE = NL ? "t-labelbench" : "t-perfbench";

const stop = await startVite({ cwd: ROOT, port: PORT, portEnv: "VPB_PORT", readyUrl: `http://localhost:${PORT}/${BASE}/` });
let fail = 0;
try {
	const url = `http://localhost:${PORT}/${BASE}/tests/${PAGE}.html?perf=1&hud=0&lang=ja${FLAGS}${SCENE ? `&scene=${SCENE}` : ""}${SET ? `&set=${SET}` : ""}`;
	const runs = [];
	for (let r = 0; r < RUNS; r++) {
		const title = await runRealtime(url, { limitS: 300, profilePrefix: NL ? "nl-labelbench" : "oj-perfbench", seq: r + 1, flags: REALGPU });
		if (!title.startsWith("PASS ")) { console.error("FAIL", title.slice(0, 300)); fail = 1; break; }
		runs.push(JSON.parse(title.slice(5)));
	}
	if (!fail && runs.length) {
		const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
		console.log(`backend=${runs[0].backend} gpu="${runs[0].gpu}" flags="${FLAGS}" runs=${runs.length}`);
		console.log("scene                 gpuMap  gpuGint  frameMs  fps   res   aa  hitch(load e/s)  hitch(move e/s)  cells  cell avg ms (res+up)  max(res/up)  terr near/far");
		for (let i = 0; i < runs[0].scenes.length; i++) {
			const col = k => med(runs.map(r => +r.scenes[i][k] || 0));
			const cellCol = k => med(runs.map(r => +(r.scenes[i].cell?.[k]) || 0));
			const s = runs[runs.length - 1].scenes[i];
			console.log(`${s.name.padEnd(21)} ${col("gpuMap").toFixed(2).padStart(6)}  ${col("gpuGint").toFixed(2).padStart(7)}  ${col("frameMs").toFixed(1).padStart(7)}  ${String(col("fps")).padStart(3)}  ${String(s.res).padStart(4)}  ${String(s.aa).padStart(2)}  ${String(s.hitchLoad.elev + "/" + s.hitchLoad.scene).padStart(15)}  ${String(s.hitchMove.elev + "/" + s.hitchMove.scene).padStart(15)}  ${String(cellCol("n")).padStart(5)}  ${(cellCol("avgMs").toFixed(2) + " (" + cellCol("avgResMs").toFixed(2) + "+" + cellCol("avgUpMs").toFixed(2) + ")").padStart(20)}  ${(cellCol("maxResMs").toFixed(1) + "/" + cellCol("maxUpMs").toFixed(1)).padStart(11)}  ${(s.terr ? `${s.terr.near.drawn}/${s.terr.near.of} ${s.terr.far.drawn}/${s.terr.far.of}` : "-").padStart(13)}`);
		}
		// 計器 e／f（vt perf plan §2・§8 の表の列）：基図のタイルの「必要になった→画面」（主層・中央値/p90・ms）と、その内訳の中央値（wait＝キューと転送／fetch＝取得＋復号／build）・main merge の回数と 1 回の変化枚数/全枚数。着地窓（load）と移動窓（move＝9 秒）
		console.log("\nscene                 need→screen load med/p90  (wait fetch build)   merges  chg/tiles | move med/p90  (wait fetch build)   merges  chg/tiles");
		for (let i = 0; i < runs[0].scenes.length; i++) {
			const s = runs[runs.length - 1].scenes[i], v = s.vt; if (!v) continue;
			const col = (k, f) => med(runs.map(r => +(r.scenes[i].vt?.[k]?.[f]) || 0));
			const w = k => `${(col(k, "med") + "/" + col(k, "p90")).padStart(9)}  (${String(col(k, "wait")).padStart(4)} ${String(col(k, "fetch")).padStart(5)} ${col(k, "build").toFixed(1).padStart(5)})  ${String(col(k, "merges")).padStart(6)}  ${(col(k, "changed").toFixed(1) + "/" + col(k, "tiles")).padStart(9)}`;
			console.log(`${s.name.padEnd(21)} ${w("load")} | ${w("move")}`);
		}
		console.log("(need→screen＝主層タイルが選抜で必要になってから main のシーンに載るまで・ms。merges＝main merge の要求回数・chg/tiles＝1 回あたりの変わった枚数／全枚数＝classic は全枚を結合し直す＝P2 が消す量)");
		if (runs[0].scenes.some(s => s.lab)) {   // 注記の計器（テキスト GPU 化 T-P0）＝labels2d の draw（EMA）・衝突判定・描いた注記と字の数
			console.log("scene                 labMs  collideMs  labels  glyphs");
			for (let i = 0; i < runs[0].scenes.length; i++) {
				const lab = k => med(runs.map(r => +(r.scenes[i].lab?.[k]) || 0)), s = runs[runs.length - 1].scenes[i];
				console.log(`${s.name.padEnd(21)} ${lab("ms").toFixed(2).padStart(5)}  ${lab("collideMs").toFixed(2).padStart(9)}  ${String(lab("labels")).padStart(6)}  ${String(lab("glyphs")).padStart(6)}`);
			}
		}
		console.log("(cell avg ms＝標高セル 1 枚の再標本化＋GPU への上げ・描画スレッドの CPU 時間＝P1 の前後比較の物差し。gpuMap/gpuGint＝timestamp-query の EMA・hitch＝4ms 超の回数・terr＝地形チャンクの描いた数/総数（近窓 遠窓・P4）)");
	}
} finally { stop(); }
process.exit(fail);
