#!/usr/bin/env node
// AO の見た目の裁定（#63）＝tests/t-aogallery.html を実 GPU（WebGPU）で回し、視点 × 強さ × 半径 × 時刻の PNG を撮って並べる。回帰検定ではない。
// 使い方（apps/ortho-japan で）：node scripts/ao-gallery.mjs [--out <dir>] [--only 17] [--size 1280x800]。port は VAG_PORT。
// 出す物＝<out>/<名前>.png と <out>/index.html（並べて見比べる頁）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runRealtime, REALGPU } from "../../../packages/globe/scripts/lib/ui-runner.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VAG_PORT || 5265;
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg("--out", path.join(APP, "out/ao-gallery"))), ONLY = arg("--only", ""), SIZE = arg("--size", "1280x800").replace("x", ",");
fs.mkdirSync(OUT, { recursive: true });
// 視点＝東京駅（建物の足元）z16/17/18・60° と 山地（甲府盆地の南＝谷の陰）z11・60°。時刻＝正午と夕方（春分）
const VIEWS = [
	{ id: "tokyo-z16", v: "139.7671/35.6812/16/60/20", wait: 16000 },
	{ id: "tokyo-z17", v: "139.7671/35.6812/17/60/20", wait: 16000 },
	{ id: "tokyo-z18", v: "139.7660/35.6800/18/60/340", wait: 16000 },
	{ id: "hills-z11", v: "138.72/35.52/11/60/300", wait: 14000 },
];
const TIMES = [["noon", "2026-03-20T03:00:00Z"], ["evening", "2026-03-20T07:30:00Z"]];
const SETS = [["off", { ao: "0" }], ["s05", { ao: "1", s: "0.5" }], ["s06", { ao: "1", s: "0.6" }], ["s07", { ao: "1", s: "0.7" }], ["s06-r15", { ao: "1", s: "0.6", r: "0.15" }]];
const stop = await startVite({ cwd: APP, port: PORT, portEnv: "VAG_PORT", readyUrl: `http://localhost:${PORT}/japan/` });
const shots = [];
try {
	let seq = 0;
	for (const V of VIEWS) {
		if (ONLY && !V.id.includes(ONLY)) continue;
		for (const [tn, tv] of TIMES) for (const [sn, o] of SETS) {
			const q = new URLSearchParams({ v: V.v, t: tv, wait: String(V.wait), hud: "0", ...o });
			const name = `${V.id}-${tn}-${sn}`, file = path.join(OUT, name + ".png");
			const title = await runRealtime(`http://localhost:${PORT}/japan/tests/t-aogallery.html?${q}`, { limitS: 120, profilePrefix: "oj-aogallery", seq: ++seq, flags: [...REALGPU, `--window-size=${SIZE}`, "--force-device-scale-factor=1"], shot: file });
			console.log(title.startsWith("PASS") ? `✓ ${name}` : `✗ ${name} ${title.slice(0, 200)}`);
			if (title.startsWith("PASS")) shots.push({ name, view: V.id, time: tn, set: sn });
		}
	}
	// 見比べ帳
	const views = [...new Set(shots.map(s => s.view))], sets = SETS.map(s => s[0]);
	let html = `<!doctype html><meta charset="utf-8"><title>AO gallery</title><style>body{background:#111;color:#ddd;font:13px system-ui;margin:12px}h2{margin:18px 0 6px}.row{display:grid;grid-template-columns:repeat(${sets.length},1fr);gap:6px}.row div{text-align:center}img{width:100%;display:block}</style>`;
	for (const v of views) for (const [tn] of TIMES) { html += `<h2>${v} · ${tn}</h2><div class="row">` + sets.map(sn => shots.find(s => s.view === v && s.time === tn && s.set === sn) ? `<div><img src="${v}-${tn}-${sn}.png"><br>${sn}</div>` : `<div>${sn}: —</div>`).join("") + `</div>`; }
	fs.writeFileSync(path.join(OUT, "index.html"), html);
	console.log(`${shots.length} shots → ${OUT}/index.html`);
} finally { stop(); }
