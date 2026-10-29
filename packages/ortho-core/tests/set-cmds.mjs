// renderer の set(cmd) の case は一つの名に一つ（2026-10-29）：同じ名の case が二つあると後ろの方は死ぬ（switch は最初の一致だけ）。
// 鏡面の環境の立方体図を "meshEnv" で足した時、模型ごとの環境光の "meshEnv"（SH9）を殺して Mac の WebGPU で機体が白っぽくなった。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "src");
let bad = 0;
for (const f of ["gl/renderer.ts", "gpu/renderer.ts"]) {
	const s = fs.readFileSync(path.join(SRC, f), "utf8"), i = s.indexOf("\tfunction set(cmd: string"), j = s.indexOf("\n\t}\n", i);
	if (i < 0 || j < 0) { console.error(`✗ ${f}: function set(cmd) が見つからない`); bad++; continue; }
	const seen = new Map();
	for (const m of s.slice(i, j).matchAll(/case "([^"]+)":/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
	const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
	if (dup.length) { console.error(`✗ ${f}: set(cmd) の case が重なっている：${dup.join(", ")}`); bad++; }
	else console.log(`✓ ${f}: set(cmd) の case ${seen.size} 個は重ならない`);
}
if (bad) process.exit(1);
