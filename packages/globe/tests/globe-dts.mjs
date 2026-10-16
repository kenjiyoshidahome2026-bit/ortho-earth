// 地図の口（@ortho-earth/globe）の型の検定（TS 化 段 2「契約を正す」・2026-10-15・tests/mlshim-dts.mjs と同型）。
// createGlobe は DOM（Worker・canvas・CSS）が要る＝node では起動できないので、源を**静的に**読んで globe.d.ts と突き合わせる：
//  ① src/globe.js と src/api/*.ts が map に生やすメンバー（`map.X =`・Object.defineProperty(map, "X")・`const map = { … }` の鍵）が全部 OrthoJapanMap にある。
//     OrthoJapanMap（＝GlobeMap）の本体は src/types/map.ts の *Api の合成（TS 化 段 4・batch 1）＝GlobeMap に並ぶ interface を全部読む。
//     内部の物（renderer・雲の殻 __clouds）は下の INTERNAL_MAP に明記して外す＝増やすなら理由を書く（型は map.ts の GlobeInternals）
//  ② 登録されたガジェット（`map.gadget("name", …)`）が全部 Gadgets にある（index signature [name: string] で逃げない）
//  ③ src/globe.js の root の export（値）が全部 globe.d.ts に宣言されている（逆＝d.ts が宣言した値の export は実装にある）
//  ④ globe.d.ts 自体が strict の tsc を通る（mlshim-dts は --skipLibCheck＝ここで初めて d.ts の中身が検査される）。src/types/map.ts も（利用者の tsc と同じ旗＝.ts の値の import は許さない）
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import { execFileSync } from "node:child_process";
const HERE = path.dirname(fileURLToPath(import.meta.url)), GLOBE = path.resolve(HERE, ".."), ROOT = path.resolve(GLOBE, "../..");
let fail = 0; const ok = (k, c, extra = "") => { console.log((c ? "ok  " : "FAIL ") + k + (extra ? " " + extra : "")); if (!c) fail++; };

// 内部＝d.ts に出さない map のメンバー（実行時には在る・型は src/types/map.ts の GlobeInternals）。公開面は view（読み取り専用の写し）・requestSnapshot・setClouds。
// cam（エンジンの生の視点）・pinRes（録画用の解像度固定）は公開の型に出した（判断 3・2026-10-16）
const INTERNAL_MAP = new Set([
	"renderer",   // render worker の口（内部）
	"__clouds",   // 雲の殻（api/camera.ts が setClouds の中で生やす検証窓）
]);

const read = f => fs.readFileSync(path.join(GLOBE, f), "utf8");
const apiFiles = fs.readdirSync(path.join(GLOBE, "src/api")).filter(f => /\.(js|ts)$/.test(f) && !f.endsWith(".d.ts")).map(f => "src/api/" + f).sort();
const sources = ["src/globe.js", ...apiFiles].map(f => [f, read(f)]);

// ── 実装の側 ──
const runtimeMap = new Map();   // name → 出所
const runtimeGadgets = new Map();
const note = (m, k, where) => { if (!m.has(k)) m.set(k, where); };
for (const [f, src] of sources) {
	for (const m of src.replace(/^\s*\/\/.*$/gm, "").matchAll(/(?<![\w$.])map\.([A-Za-z_$][\w$]*)\s*=[^=>]/g)) note(runtimeMap, m[1], f);   // `map.X =`（行頭でなくても＝`a ??= map.__x =` も）。行コメントは見ない
	for (const m of src.matchAll(/Object\.defineProperty\(map,\s*"([A-Za-z_$][\w$]*)"/g)) note(runtimeMap, m[1], f);
	for (const m of src.matchAll(/(?:map\.gadget|registerGadget)\("([A-Za-z_$][\w$]*)"/g)) note(runtimeGadgets, m[1], f);
}
// `const map = { … };`（globe.js）の鍵：行コメントを落として波括弧の深さ 1 の字面だけ集め、短縮形・get X()・X: を拾う
{
	const src = sources[0][1];
	const at = src.indexOf("\nconst map = {");
	ok("mapLiteral.found", at >= 0);
	if (at >= 0) {
		let depth = 0, top = "", i = src.indexOf("{", at), inStr = null;
		for (; i < src.length; i++) {
			const c = src[i];
			if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
			if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
			if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
			if (c === "{" || c === "(" || c === "[") { if (depth === 1) top += c; depth++; continue; }
			if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) break; continue; }
			if (depth === 1) top += c;
		}
		for (const m of top.matchAll(/(?:^|[,{]|\n)\s*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?=[,:({}\n]|$)/g)) note(runtimeMap, m[1], "src/globe.js (const map = { … })");
	}
}

// ── 型の側 ──
const dts = read("globe.d.ts"), mapTs = read("src/types/map.ts");
function membersOf(name, src = dts) {   // interface の本体（最初の階層）のメンバー名：行頭のタブ 1 つ＋（readonly）名前＋「(」「?」「:」「<」（tests/zoomscale.mjs と同じ読み方）
	const m = src.match(new RegExp(`export interface ${name}(?:<[^>]*>)?(?:\\s+extends[^{]+)?\\s*\\{([\\s\\S]*?)\\n\\}`));
	if (!m) { ok(`dts.interface.${name}`, false, "not found"); return new Set(); }
	const out = new Set();
	for (const line of m[1].split("\n")) {
		if (!/^\t(?:readonly\s+)?[A-Za-z_$]/.test(line)) continue;
		// 1 行に `a(): X; b(): Y;` と並ぶ物も拾う＝深さ 0 の「;」で切る（入れ子の { … } の中の ; は切らない）
		let depth = 0, seg = "", segs = [];
		for (const c of line) { if (c === "{" || c === "(" || c === "<" || c === "[") depth++; else if (c === "}" || c === ")" || c === ">" || c === "]") depth--; if (c === ";" && depth === 0) { segs.push(seg); seg = ""; } else seg += c; }
		segs.push(seg);
		for (const sgm of segs) { const k = sgm.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[(?:<]/); if (k) out.add(k[1]); }
	}
	return out;
}
// GlobeMap＝A & B & …（src/types/map.ts）の各 interface のメンバーの和＝公開の map の型
const mapParts = (mapTs.match(/export type GlobeMap\s*=\s*([^;]+);/)?.[1] ?? "").split("&").map(s => s.trim()).filter(Boolean);
ok("map.partsParsed", mapParts.length >= 10, mapParts.join(" & "));
ok("map.aliases", /export type OrthoJapanMap\s*=\s*GlobeMap;/.test(mapTs) && /import type \{ OrthoJapanMap \} from "\.\/src\/types\/map\.ts";/.test(dts), "globe.d.ts の OrthoJapanMap／GlobeMap は src/types/map.ts の別名");
const dtsMap = new Set(mapParts.flatMap(p => [...membersOf(p, mapTs)])), dtsGadgets = membersOf("Gadgets");
const dtsInternal = membersOf("GlobeInternals", mapTs);

// ① map のメンバー
{
	const missing = [...runtimeMap.keys()].filter(k => !dtsMap.has(k) && !INTERNAL_MAP.has(k));
	ok("map.membersDeclared", missing.length === 0 && runtimeMap.size >= 200, missing.length ? "undeclared: " + missing.map(k => `${k} (${runtimeMap.get(k)})`).join(", ") : `${runtimeMap.size} runtime / ${dtsMap.size} declared`);
	const stale = [...dtsMap].filter(k => !runtimeMap.has(k));
	ok("map.declaredExist", stale.length === 0, stale.length ? "declared but not assigned in src: " + stale.join(", ") : "");
	const both = [...INTERNAL_MAP].filter(k => dtsMap.has(k));
	ok("map.internalNotDeclared", both.length === 0, both.length ? "listed as internal yet declared: " + both.join(", ") : "");
	const gone = [...INTERNAL_MAP].filter(k => !runtimeMap.has(k));
	ok("map.internalExist", gone.length === 0, gone.length ? "listed as internal but no longer assigned: " + gone.join(", ") : "");
	const untyped = [...INTERNAL_MAP].filter(k => !dtsInternal.has(k));
	ok("map.internalTyped", untyped.length === 0, untyped.length ? "internal but not in GlobeInternals (src/types/map.ts): " + untyped.join(", ") : "");
}
// ② ガジェット
{
	const missing = [...runtimeGadgets.keys()].filter(k => !dtsGadgets.has(k));
	ok("gadget.namesDeclared", missing.length === 0 && runtimeGadgets.size >= 45, missing.length ? "undeclared: " + missing.map(k => `${k} (${runtimeGadgets.get(k)})`).join(", ") : `${runtimeGadgets.size} registered / ${dtsGadgets.size} declared`);
	const stale = [...dtsGadgets].filter(k => !runtimeGadgets.has(k));
	ok("gadget.declaredRegistered", stale.length === 0, stale.length ? "declared but never registered: " + stale.join(", ") : "");
	const gm = dts.match(/export interface Gadgets\s*\{([\s\S]*?)\n\}/);
	ok("gadget.noIndexSignature", !!gm && !/\[\s*name\s*:\s*string\s*\]/.test(gm[1]), "every registered gadget is declared, so no [name: string] escape hatch");
}
// ③ root の export
{
	const src = sources[0][1], runtime = new Set();
	for (const m of src.matchAll(/^export\s+\{([^}]+)\}/gm)) for (const n of m[1].split(",")) runtime.add(n.trim().split(/\s+as\s+/).pop());
	for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) runtime.add(m[1]);
	const declared = new Set();
	for (const m of dts.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let)\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
	for (const m of dts.matchAll(/^export\s+\{([^}]+)\}/gm)) for (const n of m[1].split(",")) declared.add(n.trim().split(/\s+as\s+/).pop());
	const missing = [...runtime].filter(n => !declared.has(n)), stale = [...declared].filter(n => !runtime.has(n));
	ok("exports.declared", missing.length === 0 && runtime.size >= 10, missing.length ? "missing in globe.d.ts: " + missing.join(",") : `${runtime.size} names`);
	ok("exports.exist", stale.length === 0, stale.length ? "declared but not exported by src/globe.js: " + stale.join(",") : "");
	const pkg = JSON.parse(read("package.json"));
	ok("exportsMap", pkg.exports["."]?.types === "./globe.d.ts" && pkg.types === "./globe.d.ts" && pkg.files.includes("globe.d.ts"));
}
// ④ tsc（d.ts そのものを strict で・skipLibCheck なし）
{
	const tsc = path.join(ROOT, "node_modules/.bin/tsc");
	if (!fs.existsSync(tsc)) ok("tsc", false, "typescript が node_modules に無い（root の devDependency）");
	else {
		try {
			execFileSync(tsc, ["--noEmit", "--strict", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--lib", "es2022,dom", path.join(GLOBE, "globe.d.ts")], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			ok("tsc.globeDts", true);
		} catch (e) { ok("tsc.globeDts", false, "\n" + String(e.stdout || e.stderr || e).slice(0, 3000)); }
	}
}
console.log(fail ? `globe-dts: ${fail} FAIL` : "globe-dts: all ok"); process.exit(fail ? 1 : 0);
