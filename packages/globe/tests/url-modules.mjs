// 門：URL で読まれる同一フレームのオーバーレイのモジュール（`import x from "./m.js?url"`・`new URL("./m.js", import.meta.url)`）は依存ゼロ（2026-10-16）。
// vite はこれらをバンドルせず**そのまま**資産として置く（js-url-as-file・?url）＝中の import "./x.ts"／"@ortho-earth/core/…" は置いた先で解決できず、
// ビルドでだけ読み込みが落ちる（customgl-draw.js が customgl-args.ts と core/camera を import していた＝dev では動き、ビルドでは custom 層が出ない）。
// 要る物は render worker が host で渡す（host.depthGLSL・host.customArgs）。使い方：node packages/globe/tests/url-modules.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const files = [];
const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|mjs|ts)$/.test(n) && !n.endsWith(".d.ts")) files.push(p); } };
walk(SRC);
const strip = src => src.replace(/^[ \t]*\/\/.*$/gm, "");   // 行コメントの中の例は見ない
const URL_SPEC = [/\bfrom\s*["'](\.{1,2}\/[^"'?]+\.m?js)\?url["']/g, /\bnew URL\(\s*["'](\.{1,2}\/[^"']+\.m?js)["']\s*,\s*import\.meta\.url\s*\)/g];
const targets = new Map();   // 実体 → 読む側
for (const f of files) {
	const src = strip(readFileSync(f, "utf8"));
	for (const re of URL_SPEC) for (const m of src.matchAll(re)) targets.set(join(dirname(f), m[1]), relative(SRC, f));
}
// 静的 import／export … from／文字列の動的 import（利用者の URL を変数で import() するのは可）
const IMPORT = [/^[ \t]*import[ \t]*(?:[\w*{][^;]*?\bfrom[ \t]*)?["'][^"']+["']/gm, /^[ \t]*export[ \t][^;]*?\bfrom[ \t]*["'][^"']+["']/gm, /\bimport\(\s*["'`][^"'`]+["'`]\s*\)/g];
let bad = 0;
for (const [t, by] of targets) {
	const src = strip(readFileSync(t, "utf8"));
	for (const re of IMPORT) for (const m of src.matchAll(re)) { bad++; console.log(`✗ ${relative(SRC, t)}（${by} が URL で読む）: ${m[0].trim()}`); }
}
if (targets.size < 10) { console.log(`url-modules: URL で読むモジュールが ${targets.size} 本しか見つからない（検出の式が古い？）`); process.exit(1); }
if (bad) { console.log(`url-modules: ${bad} 件の import（URL で読むモジュールは依存ゼロ＝要る物は host で渡す）`); process.exit(1); }
console.log(`✓ url-modules PASS（${targets.size} 本・import なし）`);
