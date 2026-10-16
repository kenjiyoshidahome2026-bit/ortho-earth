// 門：src の相対 import（静的・動的 import("./…")・?url 付き）が実在のファイルを指すこと（globe.js の分割 ⑤・2026-10-15）。
// globe.js から src/api/ へ切り出すと "./x.js" が "../x.js" にずれる。node の試験は globe.js を読み込まないので、ずれはブラウザで初めて落ちる＝ここで先に止める。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const files = [];
const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|mjs|ts)$/.test(n) && !n.endsWith(".d.ts")) files.push(p); } };
walk(SRC);
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)(["'])(\.{1,2}\/[^"'`]+)\1/g;
let bad = 0, n = 0;
for (const f of files) {
	const src = readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");   // 行コメントの中の例は見ない
	for (const m of src.matchAll(SPEC)) {
		n++;
		const target = join(dirname(f), m[2].replace(/[?#].*$/, ""));
		if (!existsSync(target)) { bad++; console.log(`✗ ${relative(SRC, f)}: "${m[2]}" → missing ${relative(SRC, target)}`); }
	}
}
if (bad) { console.log(`relative-imports: ${bad} broken of ${n}`); process.exit(1); }
console.log(`✓ relative-imports PASS（${n} 本・${files.length} ファイル）`);
