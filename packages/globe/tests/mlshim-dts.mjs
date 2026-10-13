// MapLibre の口（@ortho-earth/globe/maplibre）の型の検定（F10・2026-10-12）
//  ① src/maplibre/index.js の実行時の export 名が全部 maplibre.d.ts にある（型が実装に遅れない）
//  ② tests/fixtures/dts/shim-usage.ts（MapLibre の書き方そのまま）が package.json の exports "./maplibre".types 経由で tsc を通る（moduleResolution bundler・strict）
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import { execFileSync } from "node:child_process";
const HERE = path.dirname(fileURLToPath(import.meta.url)), GLOBE = path.resolve(HERE, ".."), ROOT = path.resolve(GLOBE, "../..");
let fail = 0; const ok = (k, c, extra = "") => { console.log((c ? "ok  " : "FAIL ") + k + (extra ? " " + extra : "")); if (!c) fail++; };
// ① export 名
const idx = fs.readFileSync(path.join(GLOBE, "src/maplibre/index.js"), "utf8");
const runtime = new Set();
for (const m of idx.matchAll(/^export\s+\{([^}]+)\}\s+from/gm)) for (const n of m[1].split(",")) runtime.add(n.trim().split(/\s+as\s+/).pop());
for (const m of idx.matchAll(/^export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)) runtime.add(m[1]);
const dts = fs.readFileSync(path.join(GLOBE, "maplibre.d.ts"), "utf8");
const declared = new Set();
for (const m of dts.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|interface|type)\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
for (const m of dts.matchAll(/^export\s+\{([^}]+)\}\s+from/gm)) for (const n of m[1].split(",")) declared.add(n.trim().split(/\s+as\s+/).pop());
for (const m of dts.matchAll(/;\s*export\s+function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
const missing = [...runtime].filter(n => !declared.has(n));
ok("exportsDeclared", missing.length === 0 && runtime.size >= 30, missing.length ? "missing: " + missing.join(",") : `${runtime.size} names`);
const pkg = JSON.parse(fs.readFileSync(path.join(GLOBE, "package.json"), "utf8"));
ok("exportsMap", pkg.exports["./maplibre"]?.types === "./maplibre.d.ts" && pkg.files.includes("maplibre.d.ts"));
// ② tsc
const tsc = path.join(ROOT, "node_modules/.bin/tsc");
if (!fs.existsSync(tsc)) { ok("tsc", false, "typescript が node_modules に無い（root の devDependency）"); }
else {
	try {
		execFileSync(tsc, ["--noEmit", "--strict", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--lib", "es2022,dom", "--skipLibCheck", path.join(HERE, "fixtures/dts/shim-usage.ts")], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		ok("tsc.shimUsage", true);
	} catch (e) { ok("tsc.shimUsage", false, "\n" + String(e.stdout || e.stderr || e).slice(0, 3000)); }
}
console.log(fail ? `mlshim-dts: ${fail} FAIL` : "mlshim-dts: all ok"); process.exit(fail ? 1 : 0);
