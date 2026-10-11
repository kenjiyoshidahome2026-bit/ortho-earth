#!/usr/bin/env node
// t-dts: 型定義・sideEffects・入口分割（geopbf 改良点 10・2026-10-12・俯瞰 §2-B 6）の常設検定。
//   ・package.json の types／exports の "types" が指す .d.ts が全部ある・exports の全 subpath は「型あり」か「省略宣言（types/subpaths.d.ts）」のどちらかで漏れ無し
//   ・types/*.d.ts の相対 import 先が全部ある（.js で書いた参照 → .d.ts）
//   ・sideEffects＝トップレベルで onmessage を張る worker 本体・prototype を足す pbf.js／pbf-base.js・wasm glue を全部覆う（tree-shake で消されると黙って死ぬ族）
//   ・geopbf/core（軽い入口）＝wasm glue・identify・dissolve・pbf-io・worker の入口を静的 import 閉包に含まない・export の名簿が固定
//   ・typescript が解決できれば tests/fixtures/dts/consumer.ts を strict で型検査する（@ts-expect-error 4 行＝型が効いている証）。
//     無ければその段だけ「skip」と明示する（手元で `npx tsc -p tests/fixtures/dts` で同じ検査）
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rel = f => path.relative(PKG, f);
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8"));

// 1) types と exports の "types"
ok(pkg.types && existsSync(path.join(PKG, pkg.types)), `package.json types → ${pkg.types} がある`);
ok(Array.isArray(pkg.files) && pkg.files.includes("types"), `files に types が入っている（npm pack に載る）`);
const shorthand = new Set([...readFileSync(path.join(PKG, "types/subpaths.d.ts"), "utf8").matchAll(/declare module "([^"]+)";/g)].map(m => m[1]));
let typed = 0, missing = [];
for (const [key, val] of Object.entries(pkg.exports)) {
	const spec = "geopbf" + key.slice(1);
	if (typeof val === "object" && val.types) {
		typed++;
		if (!existsSync(path.join(PKG, val.types))) missing.push(`${key} → ${val.types} が無い`);
		if (!existsSync(path.join(PKG, val.default))) missing.push(`${key} → ${val.default} が無い`);
		if (shorthand.has(spec)) missing.push(`${key} は型ありなのに subpaths.d.ts にも省略宣言がある（二重）`);
	} else {
		const target = typeof val === "object" ? val.default : val;
		if (!existsSync(path.join(PKG, target.replace("*", "model")))) missing.push(`${key} → ${target} が無い`);
		if (!shorthand.has(spec)) missing.push(`${key} は型も省略宣言も無い（TS 利用者に TS7016 が出る）`);
	}
}
ok(missing.length === 0, `exports ${Object.keys(pkg.exports).length} 本＝型あり ${typed}・省略宣言 ${Object.keys(pkg.exports).length - typed}（漏れ無し）${missing.length ? "\n   " + missing.join("\n   ") : ""}`);
const stale = [...shorthand].filter(s => !Object.keys(pkg.exports).some(k => "geopbf" + k.slice(1) === s));
ok(stale.length === 0, `subpaths.d.ts の省略宣言は全部 exports にある subpath${stale.length ? "（余り: " + stale.join(", ") + "）" : ""}`);

// 2) types/*.d.ts の相対参照
const dts = readdirSync(path.join(PKG, "types")).filter(f => f.endsWith(".d.ts"));
let broken = [];
for (const f of dts) {
	const src = readFileSync(path.join(PKG, "types", f), "utf8");
	for (const m of src.matchAll(/from "(\.\/[^"]+)"|reference path="(\.\/[^"]+)"/g)) {
		const r = (m[1] || m[2]).replace(/\.js$/, ".d.ts");
		if (!existsSync(path.join(PKG, "types", r))) broken.push(`${f}: ${m[1] || m[2]}`);
	}
}
ok(dts.length >= 12 && broken.length === 0, `types/*.d.ts ${dts.length} 枚の相対参照が全部ある${broken.length ? "\n   " + broken.join("\n   ") : ""}`);

// 3) sideEffects が worker 本体・prototype 拡張・wasm glue を覆う
const globRe = g => new RegExp("^" + g.replace(/^\.\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*") + "$");
const seRes = (pkg.sideEffects || []).map(globRe);
const covered = f => seRes.some(re => re.test(f));
const walk = (dir, out = []) => { for (const e of readdirSync(dir)) { const p = path.join(dir, e); if (statSync(p).isDirectory()) walk(p, out); else if (e.endsWith(".js")) out.push(p); } return out; };
const effectful = [];
for (const f of walk(path.join(PKG, "src"))) {
	const src = readFileSync(f, "utf8");
	const top = src.split("\n").some(l => /^(self\.)?onmessage\s*=|^self\.addEventListener\(\s*["']message/.test(l) || /^\tself\.onmessage\s*=/.test(l) && /worker_threads|isMainThread/.test(src));
	if (top || /^GeoPBF\.set(Prototype|Property|Getter)\(/m.test(src) || /^\s*Object\.defineProperty\(GeoPBF\.prototype/m.test(src)) effectful.push(rel(f));
}
for (const f of readdirSync(path.join(PKG, "wasm/pkg")).filter(f => f.endsWith(".js"))) effectful.push("wasm/pkg/" + f);
const uncovered = effectful.filter(f => !covered(f));
ok(Array.isArray(pkg.sideEffects) && effectful.length >= 30 && uncovered.length === 0, `sideEffects が副作用のある ${effectful.length} 本（worker 本体・pbf.js／pbf-base.js・index.js・wasm glue）を全部覆う${uncovered.length ? "\n   漏れ: " + uncovered.join(", ") : ""}`);
ok(!covered("src/core.js") && !covered("src/modules/geojson-load.js") && !covered("src/extension/identify.js"), "副作用の無いモジュール（core／loader／identify）は sideEffects に入っていない＝tree-shake できる");

// 4) geopbf/core の閉包と名簿
const closure = entry => { const seen = new Map(); const st = [path.resolve(PKG, entry)];
	while (st.length) { const f = st.pop(); if (seen.has(f)) continue; let s; try { s = readFileSync(f, "utf8"); } catch { continue; } seen.set(f, s.length);
		for (const m of s.matchAll(/^\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']/gm)) if (m[1].startsWith(".")) st.push(path.resolve(path.dirname(f), m[1])); }
	return { files: [...seen.keys()].map(rel), bytes: [...seen.values()].reduce((a, b) => a + b, 0) }; };
const core = closure("src/core.js"), full = closure("src/index.js");
const heavy = core.files.filter(f => /wasm\/|extension\/(identify|dissolve|gint|topology)|pbf-io|builtinWorkers|worker\.js|convert\//.test(f));
ok(heavy.length === 0 && core.files.length * 2 <= full.files.length && core.bytes * 2 <= full.bytes,
	`geopbf/core の静的 import 閉包＝${core.files.length} ファイル／${(core.bytes / 1024).toFixed(0)} KB（full＝${full.files.length}／${(full.bytes / 1024).toFixed(0)} KB）に wasm・identify・dissolve・pbf-io・worker が無い${heavy.length ? "\n   混入: " + heavy.join(", ") : ""}`);
const coreMod = await import(path.join(PKG, "src/core.js"));
const want = ["GeoPBF", "makeKeys", "propsKeyOf", "loadGeopbf", "decodeToGeojson", "fetchAndDecode", "sanitizeProperties", "resolveInnerUrl", "gzip", "gunzip", "isGzip"];
ok(want.every(k => k in coreMod) && Object.keys(coreMod).length === want.length, `geopbf/core の export＝${want.join(", ")}`);
const corePbf = await new coreMod.GeoPBF({ precision: 7 }).set({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { a: 1 } }] });
ok(corePbf.length === 1 && corePbf.getProperties(0).a === 1 && typeof corePbf.centroid !== "function", "core の GeoPBF は set/get が通り、拡張メソッド（centroid）は持たない");
const { geojson, meta } = await coreMod.decodeToGeojson(corePbf.arrayBuffer);
ok(geojson.features.length === 1 && geojson.features[0].properties.a === 1 && typeof meta.name === "string", "core の decodeToGeojson が ArrayBuffer → FeatureCollection＋meta");

// 5) tsc（解決できれば）。typescript の package → bin/tsc、無ければ PATH の tsc
let run = null;
try { const req = createRequire(import.meta.url); const bin = path.join(path.dirname(req.resolve("typescript/package.json")), "bin/tsc"); run = args => execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {}
if (!run) { try { execFileSync("tsc", ["-v"], { stdio: "ignore" }); run = args => execFileSync("tsc", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch {} }
if (run) {
	const proj = path.join(PKG, "tests/fixtures/dts");
	let out = "", code = 0;
	try { out = run(["-p", proj, "--pretty", "false"]); } catch (e) { code = e.status ?? 1; out = String(e.stdout || "") + String(e.stderr || ""); }
	ok(code === 0, `tsc strict で tests/fixtures/dts/consumer.ts が通る（@ts-expect-error 4 行込み）${code ? "\n" + out.trim().split("\n").slice(0, 20).map(l => "   " + l).join("\n") : ""}`);
} else {
	console.log("· tsc が見つからないので型検査は skip（手元: npx tsc -p tests/fixtures/dts）");
}

if (fails) { console.error(`t-dts: ${fails} 件失敗`); process.exit(1); }
console.log("t-dts: all passed");
