#!/usr/bin/env node
// t-dts: 型定義・sideEffects・入口分割（geopbf 改良点 10・2026-10-12・俯瞰 §2-B 6）の常設検定。
//   ・package.json の main（.ts）／exports の "types" が指す .d.ts が全部ある・exports の全 subpath は「型あり」か「省略宣言（types/subpaths.d.ts）」のどちらかで漏れ無し
//   ・types/*.d.ts の相対 import 先が全部ある（.js で書いた参照 → .d.ts・../src/*.ts は実装の class＝段 4）
//   ・sideEffects＝トップレベルで onmessage を張る worker 本体・class へ配線する index.ts（wireEntry）／静的な名簿を載せる pbf-base.ts・wasm glue を全部覆う（tree-shake で消されると黙って死ぬ族）
//   ・geopbf/core（軽い入口）＝wasm glue・identify・dissolve・pbf-io・worker の入口を静的 import 閉包に含まない・export の名簿が固定
//   ・型ありの subpath ごとに、実行時の export（Object.keys(import(...))）と .d.ts の値の export（class・function・const）が 1:1（TS化 段 2・2026-10-15）
//   ・.ts を指す subpath（TS化 段 3・2026-10-16）は実装がそのまま型＝.d.ts も省略宣言も要らず、同じ .ts の値の export と Node で import した実行時の export を照合
//     ＝.d.ts にだけある値（実行時に無い）も、実行時にだけある export（型が無い）も落とす。型だけの名前（interface・type・export type）は照合の外
//   ・tests/fixtures/dts/consumer.ts を strict で型検査する（@ts-expect-error の行＝型が効いている証）
//   typescript は root の devDependency＝解決できなければ落とす（旧＝「skip」で黙って通していた）
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

// 1) main と exports の "types"（段 4・2026-10-16＝"." も .ts を直に指す＝root の types は無い・型は実装そのもの）
ok(!pkg.types && /\.ts$/.test(pkg.main) && existsSync(path.join(PKG, pkg.main)), `package.json main → ${pkg.main}（.ts＝実装が型・root の types は無い）がある`);
ok(Array.isArray(pkg.files) && pkg.files.includes("types"), `files に types が入っている（npm pack に載る）`);
const shorthand = new Set([...readFileSync(path.join(PKG, "types/subpaths.d.ts"), "utf8").matchAll(/declare module "([^"]+)";/g)].map(m => m[1]));
// .ts を指す subpath は実装がそのまま型（TS 化 段 3・2026-10-16）＝.d.ts も省略宣言も要らない（省略宣言があれば二重）
const isTs = target => typeof target === "string" && /\.ts$/.test(target) && !/\.d\.ts$/.test(target);
const exists = target => existsSync(path.join(PKG, target.includes("*") ? target.split("*")[0] : target));   // ワイルドカードは手前のディレクトリの有無
let typed = 0, tsTyped = 0, missing = [];
for (const [key, val] of Object.entries(pkg.exports)) {
	const spec = "geopbf" + key.slice(1);
	const target = typeof val === "object" ? val.default : val;
	if (typeof val === "object" && val.types) {
		typed++;
		if (!existsSync(path.join(PKG, val.types))) missing.push(`${key} → ${val.types} が無い`);
		if (!exists(target)) missing.push(`${key} → ${target} が無い`);
		if (shorthand.has(spec)) missing.push(`${key} は型ありなのに subpaths.d.ts にも省略宣言がある（二重）`);
	} else if (isTs(target)) {
		tsTyped++;
		if (!exists(target)) missing.push(`${key} → ${target} が無い`);
		if (shorthand.has(spec)) missing.push(`${key} は .ts（実装が型）なのに subpaths.d.ts にも省略宣言がある（二重）`);
	} else {
		if (!exists(target)) missing.push(`${key} → ${target} が無い`);
		if (!shorthand.has(spec)) missing.push(`${key} は型も省略宣言も無い（TS 利用者に TS7016 が出る）`);
	}
}
ok(missing.length === 0, `exports ${Object.keys(pkg.exports).length} 本＝.d.ts あり ${typed}・.ts（実装が型）${tsTyped}・省略宣言 ${Object.keys(pkg.exports).length - typed - tsTyped}（漏れ無し）${missing.length ? "\n   " + missing.join("\n   ") : ""}`);
const stale = [...shorthand].filter(s => !Object.keys(pkg.exports).some(k => "geopbf" + k.slice(1) === s));
ok(stale.length === 0, `subpaths.d.ts の省略宣言は全部 exports にある subpath${stale.length ? "（余り: " + stale.join(", ") + "）" : ""}`);

// 2) types/*.d.ts の相対参照
const dts = readdirSync(path.join(PKG, "types")).filter(f => f.endsWith(".d.ts"));
let broken = [];
for (const f of dts) {
	const src = readFileSync(path.join(PKG, "types", f), "utf8");
	for (const m of src.matchAll(/from "(\.\.?\/[^"]+)"|reference path="(\.\/[^"]+)"/g)) {
		const r = (m[1] || m[2]).replace(/\.js$/, ".d.ts");   // ../src/*.ts（実装の class）はそのまま
		if (!existsSync(path.join(PKG, "types", r))) broken.push(`${f}: ${m[1] || m[2]}`);
	}
}
ok(dts.length >= 7 && broken.length === 0, `types/*.d.ts ${dts.length} 枚の相対参照が全部ある${broken.length ? "\n   " + broken.join("\n   ") : ""}`);

// 3) sideEffects が worker 本体・prototype 拡張・wasm glue を覆う
const globRe = g => new RegExp("^" + g.replace(/^\.\//, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*") + "$");
const seRes = (pkg.sideEffects || []).map(globRe);
const covered = f => seRes.some(re => re.test(f));
const walk = (dir, out = []) => { for (const e of readdirSync(dir)) { const p = path.join(dir, e); if (statSync(p).isDirectory()) walk(p, out); else if (e.endsWith(".js") || e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p); } return out; };   // .ts も見る（.d.ts は型だけ）
const effectful = [];
for (const f of walk(path.join(PKG, "src"))) {
	const src = readFileSync(f, "utf8");
	const top = src.split("\n").some(l => /^(self\.)?onmessage\s*=|^self\.addEventListener\(\s*["']message/.test(l) || /^\tself\.onmessage\s*=/.test(l) && /worker_threads|isMainThread/.test(src));
	if (top || /^(wireEntry|useEntryClass)\(/m.test(src) || /Object\.defineProperty\(GeoPBF(Base)?[,.]/.test(src)) effectful.push(rel(f));   // 入口の配線（index.ts）・静的な名簿（pbf-base.ts）
}
for (const f of readdirSync(path.join(PKG, "wasm/pkg")).filter(f => f.endsWith(".js"))) effectful.push("wasm/pkg/" + f);
const uncovered = effectful.filter(f => !covered(f));
ok(Array.isArray(pkg.sideEffects) && effectful.length >= 30 && uncovered.length === 0, `sideEffects が副作用のある ${effectful.length} 本（worker 本体・pbf-base.ts・index.ts・wasm glue）を全部覆う${uncovered.length ? "\n   漏れ: " + uncovered.join(", ") : ""}`);
ok(!covered("src/core.ts") && !covered("src/modules/geojson-load.ts") && !covered("src/extension/identify.ts") && !covered("src/pbf.ts"), "副作用の無いモジュール（core／loader／identify／pbf.ts の class）は sideEffects に入っていない＝tree-shake できる");

// 4) geopbf/core の閉包と名簿（段 4＝器（GeoPBFBase）と GeoPBF は別の class＝full の入口を import しても core の GeoPBF に拡張メソッドは乗らない）
const closure = entry => { const seen = new Map(); const st = [path.resolve(PKG, entry)];
	while (st.length) { const f = st.pop(); if (seen.has(f)) continue; let s; try { s = readFileSync(f, "utf8"); } catch { continue; } seen.set(f, s.length);
		for (const m of s.matchAll(/^\s*(?:import|export)(?!\s+type\b)[^;]*?from\s*["']([^"']+)["']/gm)) if (m[1].startsWith(".")) st.push(path.resolve(path.dirname(f), m[1])); }   // import type／export type は消える＝閉包の外
	return { files: [...seen.keys()].map(rel), bytes: [...seen.values()].reduce((a, b) => a + b, 0) }; };
const core = closure("src/core.ts"), full = closure("src/index.ts");
const heavy = core.files.filter(f => /wasm\/|extension\/(identify|dissolve|gint|topology)|pbf-io|builtinWorkers|worker\.(js|ts)|convert\//.test(f));
ok(heavy.length === 0 && core.files.length * 2 <= full.files.length && core.bytes * 2 <= full.bytes,
	`geopbf/core の静的 import 閉包＝${core.files.length} ファイル／${(core.bytes / 1024).toFixed(0)} KB（full＝${full.files.length}／${(full.bytes / 1024).toFixed(0)} KB）に wasm・identify・dissolve・pbf-io・worker が無い${heavy.length ? "\n   混入: " + heavy.join(", ") : ""}`);
const coreMod = await import(path.join(PKG, "src/core.ts"));
const want = ["GeoPBFBase", "makeKeys", "propsKeyOf", "loadGeopbf", "decodeToGeojson", "fetchAndDecode", "sanitizeProperties", "resolveInnerUrl", "gzip", "gunzip", "isGzip"];
ok(want.every(k => k in coreMod) && Object.keys(coreMod).length === want.length, `geopbf/core の export＝${want.join(", ")}`);
const corePbf = await new coreMod.GeoPBFBase({ precision: 7 }).set({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { a: 1 } }] });
ok(corePbf.length === 1 && corePbf.getProperties(0).a === 1 && typeof corePbf.centroid !== "function", "core の GeoPBFBase は set/get が通り、拡張メソッド（centroid）は持たない");
const baseMod = await import(path.join(PKG, "src/pbf-base.ts"));
ok(!("GeoPBF" in coreMod) && !("GeoPBF" in baseMod) && baseMod.GeoPBFBase === coreMod.GeoPBFBase, "器の旧名 GeoPBF は geopbf/core・geopbf/pbf-base から外した（2.0・段 5 Q2）＝GeoPBFBase だけ・同じ class");
const { geojson, meta } = await coreMod.decodeToGeojson(corePbf.arrayBuffer);
ok(geojson.features.length === 1 && geojson.features[0].properties.a === 1 && typeof meta.name === "string", "core の decodeToGeojson が ArrayBuffer → FeatureCollection＋meta");

// 5) typescript（root の devDependency）＝無ければここから先の検定ができない＝落とす（旧＝skip と出して通していた）
const req = createRequire(import.meta.url);
let ts = null, tsBin = null;
try { tsBin = path.join(path.dirname(req.resolve("typescript/package.json")), "bin/tsc"); ts = req("typescript"); } catch {}
ok(!!ts, `typescript が解決できる（root の devDependency・${ts ? "v" + ts.version : "無い＝npm ci を回す"}）`);

if (ts) {
	// 6) 型ありの subpath ごとに、実行時の export と .d.ts の値の export を照合（型だけの名前は外す）
	//    .ts を指す subpath（types 無し）は「型＝実装そのもの」＝同じ .ts の値の export と Node（type stripping）で import した実行時の export を照合
	//    （export type／interface が値に混ざっていない・Node でそのまま読めることの検定。ワイルドカード（./edit/*）は個別の subpath ではないので外す）
	const typedSubpaths = Object.entries(pkg.exports).filter(([, v]) => typeof v === "object" && v.types)
		.concat(Object.entries(pkg.exports).filter(([k, v]) => isTs(v) && !k.includes("*")).map(([k, v]) => [k, { types: v, default: v }]));
	const prog = ts.createProgram(typedSubpaths.map(([, v]) => path.join(PKG, v.types)), {
		noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [],
		allowImportingTsExtensions: true,   // .ts 同士の相対 import（"./x.ts"）
		lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
	});
	const checker = prog.getTypeChecker();
	const dtsValues = file => {
		const sf = prog.getSourceFile(file), sym = sf && checker.getSymbolAtLocation(sf);
		if (!sym) return [];
		return checker.getExportsOfModule(sym)
			.filter(e => !checker.getTypeOnlyAliasDeclaration(e))   // export type { X }
			.filter(e => ((e.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(e) : e).flags & ts.SymbolFlags.Value)   // class・function・const（interface・type は外）
			.map(e => e.name).sort();
	};
	for (const [key, v] of typedSubpaths) {
		const spec = "geopbf" + key.slice(1);
		const declared = dtsValues(path.join(PKG, v.types));
		let runtime;
		if (key === "./worker") runtime = /^\s*export\b/m.test(readFileSync(path.join(PKG, v.default), "utf8")) ? ["(export 文あり)"] : [];   // worker 本体は Node の main で import できない（self が無い）＝export 文が無いことを静的に見る
		else runtime = Object.keys(await import(path.join(PKG, v.default))).sort();
		const onlyDts = declared.filter(n => !runtime.includes(n)), onlyRt = runtime.filter(n => !declared.includes(n));
		ok(!onlyDts.length && !onlyRt.length, `${spec}: 実行時の export ${runtime.length} 本＝${rel(path.join(PKG, v.types))} の値の export${onlyDts.length ? "\n   型にだけある（実行時に無い）: " + onlyDts.join(", ") : ""}${onlyRt.length ? "\n   実行時にだけある（型が無い）: " + onlyRt.join(", ") : ""}`);
	}

	// 7) tsc strict で消費者（tests/fixtures/dts/consumer.ts）を型検査
	const proj = path.join(PKG, "tests/fixtures/dts");
	const expectErrors = (readFileSync(path.join(proj, "consumer.ts"), "utf8").match(/@ts-expect-error/g) || []).length;
	let out = "", code = 0;
	try { out = execFileSync(process.execPath, [tsBin, "-p", proj, "--pretty", "false"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
	catch (e) { code = e.status ?? 1; out = String(e.stdout || "") + String(e.stderr || ""); }
	ok(code === 0, `tsc strict で tests/fixtures/dts/consumer.ts が通る（@ts-expect-error ${expectErrors} 行込み）${code ? "\n" + out.trim().split("\n").slice(0, 20).map(l => "   " + l).join("\n") : ""}`);

	// 8) npm に出す .d.ts（prepack＝tsc -p . が tsconfig.json の設定で出す）に @internal の欄が載らない（stripInternal・段 5-4）
	//    fmap は内部の表＝地物の数は length（公開の口）。ここは pbf-base.ts の宣言だけを書き出さずに組んで中身を見る
	const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(PKG, "tsconfig.json"), ts.sys.readFile).config, ts.sys, PKG);
	let baseDts = "";
	ts.createProgram([path.join(PKG, "src/pbf-base.ts")], { ...cfg.options, noEmit: false, declaration: true, emitDeclarationOnly: true })
		.emit(undefined, (f, text) => { if (f.endsWith("pbf-base.d.ts")) baseDts = text; }, undefined, true);
	ok(cfg.options.stripInternal === true && /\bget length\(\): number;/.test(baseDts) && !/^\s+fmap\s*[?:]/m.test(baseDts) && !/^\s+_name\s*[?:]/m.test(baseDts),
		"公開の .d.ts（pbf-base）は length を持ち、@internal の fmap・_name を載せない（tsconfig.json の stripInternal）");
}

if (fails) { console.error(`t-dts: ${fails} 件失敗`); process.exit(1); }
console.log("t-dts: all passed");
