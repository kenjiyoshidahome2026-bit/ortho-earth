// 型の門（1.15.0〜）：types/*.d.ts が自分で矛盾せず、公開の口を TypeScript から呼べることを tsc --noEmit で見る。
// tsc は root の devDependency（typescript）。無ければ落ちる（npm install を促す）。
// 2.0（TS 化 段 2）：実行時と型の突き合わせ＝package.json の exports の口ごとに、実行時のモジュールの輸出名と
// 型（types を持つ口＝その .d.ts・口そのものが .ts＝その源）が宣言する値の名（export function|const|let|class・export { … }・export * from）を比べる。
// 型だけにある名も実行時だけにある名も落ちる。.d.ts／.ts の export * from は辿る（.d.ts からは .js→.d.ts・.ts はそのまま）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const root = path.resolve(pkgDir, "../..");

// ── 1) tsc --noEmit（fixtures/types/use.ts が公開の口を呼ぶ）
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");   // root の devDependency
if (!existsSync(tsc)) { console.error("types: typescript not installed (npm install at the repository root)"); process.exit(1); }
const r = spawnSync(process.execPath, [tsc, "-p", path.join(here, "fixtures/types/tsconfig.json")], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stdout || r.stderr); console.error("types: FAIL (tsc)"); process.exit(1); }

// ── 2) 実行時 vs 型
// .d.ts が宣言する「値」の名（型・interface・export type { } は数えない）。export * from は辿る。
function declaredNames(file, out = new Set(), seen = new Set()) {
	if (seen.has(file)) return out; seen.add(file);
	const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
	for (const m of src.matchAll(/^export\s+\{([^}]*)\}/gm)) {
		for (const item of m[1].split(",")) {
			const t = item.trim(); if (!t || t.startsWith("type ")) continue;
			out.add(t.split(/\s+as\s+/).pop());
		}
	}
	for (const m of src.matchAll(/^export\s+\*\s+from\s+["']([^"']+)["']/gm)) {
		const dts = m[1].endsWith(".ts") ? m[1] : m[1].replace(/\.js$/, ".d.ts");   // 根の .d.ts は src/*.ts を直に束ねる（2.0）
		declaredNames(path.resolve(path.dirname(file), dts), out, seen);
	}
	return out;
}
// worker の入口（import の副作用で動く）は Worker の場の名を見る＝Node では最小の代役を置く
globalThis.self ??= globalThis; globalThis.onmessage ??= null; globalThis.postMessage ??= (() => {});
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
let bad = 0, n = 0;
for (const [sub, spec] of Object.entries(pkg.exports)) {
	// 口が .ts そのもの（TS 化済み）＝型の源は実行時のファイル。types を持つ口（JS のまま）＝手書きの .d.ts。それ以外（"./internal/*" 等）は見ない
	const [typesFile, runtimeFile] = typeof spec === "string" ? (spec.endsWith(".ts") ? [spec, spec] : [null, null]) : [spec.types ?? null, spec.default];
	if (!typesFile) continue;
	const declared = declaredNames(path.join(pkgDir, typesFile));
	let runtime;
	try { runtime = new Set(Object.keys(await import(pathToFileURL(path.join(pkgDir, runtimeFile)).href))); }
	catch (e) { console.error(`types: ${sub}: cannot import ${runtimeFile}: ${e?.message ?? e}`); bad++; continue; }
	const onlyTypes = [...declared].filter(k => !runtime.has(k)).sort(), onlyRuntime = [...runtime].filter(k => !declared.has(k)).sort();
	if (onlyTypes.length) { console.error(`types: ${sub}: declared in ${typesFile} but missing at runtime: ${onlyTypes.join(", ")}`); bad++; }
	if (onlyRuntime.length) { console.error(`types: ${sub}: exported by ${runtimeFile} but missing in ${typesFile}: ${onlyRuntime.join(", ")}`); bad++; }
	n++;
}
if (bad) { console.error("types: FAIL (runtime vs .d.ts)"); process.exit(1); }
console.log(`types: ok (tsc; ${n} entry points match their types)`);
