// 描画の二本立ての線引き（2026-10-15）：src/gl/（WebGL2）と src/gpu/（WebGPU）は互いを読まない。
// 両方が使う部品は src/gint/（gint の状態・描画データ・焼き・属性列・style・辺の表）など共通の場所に置く。
// renderworker は選んだ方だけを読む（@ortho-earth/core/gl か /gpu）＝片方がもう片方を import すると、その機械が使わない描画まで束に入る。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "src");
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(m?js|ts)$/.test(e.name) ? [path.join(d, e.name)] : []);
const bad = [];
for (const [side, other] of [["gl", "gpu"], ["gpu", "gl"]]) {
	const otherDir = path.join(SRC, other) + path.sep;
	for (const f of walk(path.join(SRC, side))) {
		const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|new URL\(\s*["']([^"']+)["']/g)) {
			const spec = m[1] || m[2] || m[3];
			if (!spec.startsWith(".")) continue;
			if ((path.resolve(path.dirname(f), spec) + "").startsWith(otherDir)) bad.push(`${path.relative(SRC, f)} → ${spec}`);
		}
	}
}
if (bad.length) { console.error(`✗ gl/ と gpu/ が互いを読んでいる（共通の部品は src/gint/ などへ）：\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log("✓ backend-split：gl/ と gpu/ は互いを読まない");
