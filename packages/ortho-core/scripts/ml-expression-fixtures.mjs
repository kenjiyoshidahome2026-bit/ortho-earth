// MapLibre の式の適合試験（maplibre-style-spec の test/integration/expression/tests）を 1 枚の JSON に束ねて取り置く（互換の計画 P0・2026-10-22）。
// 使い方：node scripts/ml-expression-fixtures.mjs <maplibre-style-spec の clone>
// 出力＝tests/fixtures/ml-expression/tests.json（{ source, tests: { 名前: test.json の中身 } }）。検定は tests/ml-expression.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.argv[2];
if (!root) { console.error("usage: node scripts/ml-expression-fixtures.mjs <maplibre-style-spec checkout>"); process.exit(2); }
const dir = path.join(root, "test/integration/expression/tests");
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "test.json" ? [path.join(d, e.name)] : []);
const tests = {};
for (const f of walk(dir).sort()) tests[path.relative(dir, path.dirname(f)).split(path.sep).join("/")] = JSON.parse(fs.readFileSync(f, "utf8"));
const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const out = new URL("../tests/fixtures/ml-expression/", import.meta.url);
fs.writeFileSync(new URL("tests.json", out), JSON.stringify({ source: { repo: "maplibre/maplibre-style-spec", version, commit, path: "test/integration/expression/tests" }, tests }) + "\n");
fs.copyFileSync(path.join(root, "LICENSE.txt"), new URL("LICENSE.txt", out));
console.log(`${Object.keys(tests).length} tests from maplibre-style-spec ${version} (${commit.slice(0, 8)})`);
