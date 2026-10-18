#!/usr/bin/env node
// three.js の bare import を worker の中で解く仕掛け（src/gadgets/three-resolve.ts・map.addThree・2026-10-18）の常設検定：
//   ・addons の基底の推し方（build/three.module(.min).js → examples/jsm/）
//   ・"three"／"three/addons/…"／"three/examples/jsm/…"／相対／よその bare の解き方
//   ・本文の書き換え（静的 import・export from・動的 import・import.meta.url）と、相対の先・addons の先まで辿ること（three 本体は辿らない）
// 実描画（worker の中で GLTFLoader を読む・THREE が同じ実体）は tests/t-three.html（verify:ui）。
// 使い方：node packages/globe/tests/three-resolve.mjs
import { addonsBaseOf, resolveSpec, rewriteSource, specifiersOf, createThreeLoader } from "../src/gadgets/three-resolve.ts";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const T = "https://cdn.example/npm/three@0.186.1/build/three.module.js", A = "https://cdn.example/npm/three@0.186.1/examples/jsm/";

ok(addonsBaseOf(T) === A, "addons の基底＝build/three.module.js → examples/jsm/");
ok(addonsBaseOf(T.replace(".js", ".min.js")) === A, "min.js でも推せる");
ok(addonsBaseOf("https://x/three.js") === null, "推せない形は null");

const map = { three: T, addons: A }, base = "https://app.example/models/scene.js";
ok(resolveSpec("three", base, map)?.url === T && resolveSpec("three", base, map)?.rewrite === false, '"three" → three の URL（辿らない）');
ok(resolveSpec("three/addons/loaders/GLTFLoader.js", base, map)?.url === A + "loaders/GLTFLoader.js", '"three/addons/…" → addons');
ok(resolveSpec("three/examples/jsm/controls/OrbitControls.js", base, map)?.url === A + "controls/OrbitControls.js", '"three/examples/jsm/…" → addons');
ok(resolveSpec("./util.js", base, map)?.url === "https://app.example/models/util.js", "相対 ./ を元の URL で解く");
ok(resolveSpec("../lib/a.js", base, map)?.url === "https://app.example/lib/a.js", "相対 ../");
ok(resolveSpec("/abs.js", base, map)?.url === "https://app.example/abs.js", "/ 始まり");
ok(resolveSpec("lodash", base, map) === null && resolveSpec("https://esm.sh/x", base, map) === null, "よその bare・絶対 URL は触らない");
{ let threw = false; try { resolveSpec("three/addons/x.js", base, { three: T, addons: null }); } catch { threw = true; } ok(threw, "addons が推せない時の three/addons は分かるエラー"); }

const src = `import * as THREE from "three";
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { helper } from "./util.js";
import "./side.js";
const m = await import("three/addons/libs/x.js");
const url = new URL("./a.glb", import.meta.url);`;
ok(JSON.stringify(specifiersOf(src)) === JSON.stringify(["three", "three/addons/loaders/GLTFLoader.js", "./util.js", "./side.js", "three/addons/libs/x.js"]), "指定子を拾う（静的・export from・副作用・動的）");
const out = rewriteSource(src, base, s => s === "three" ? T : s.startsWith("three/") ? "blob:" + s : null);
ok(out.includes(`from "${T}"`) && out.includes(`from 'blob:three/addons/loaders/GLTFLoader.js'`) && out.includes(`import("blob:three/addons/libs/x.js")`) && out.includes(`from "./util.js"`), "置き換える物だけ置き換える");
ok(out.includes(`new URL("./a.glb", "${base}")`), "import.meta.url は元の URL に");

// 辿り方：利用者 → 相対 → addons（addons の中の "three" と相対）。three 本体は取りに行かない
const files = {
	[base]: `import * as THREE from "three"; import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"; import { k } from "./util.js"; export function setup() {}`,
	"https://app.example/models/util.js": `import { Vector3 } from "three"; export const k = 1;`,
	[A + "loaders/GLTFLoader.js"]: `import { Loader } from "three"; import { toTrianglesDrawMode } from "../utils/BufferGeometryUtils.js"; export class GLTFLoader {}`,
	[A + "utils/BufferGeometryUtils.js"]: `import { BufferGeometry } from "three"; export function toTrianglesDrawMode() {}`,
};
const fetched = [], texts = new Map();
const origCreate = URL.createObjectURL;
let n = 0;
URL.createObjectURL = blob => { const u = "blob:test/" + (++n); texts.set(u, blob); return u; };
const loader = createThreeLoader(map, async u => { fetched.push(u); if (!(u in files)) throw new Error("404 " + u); return files[u]; });
const top = await loader.prepare(base);
const text = async u => await texts.get(u).text();
const topText = await text(top);
ok(!fetched.includes(T), "three 本体は取りに行かない（import はそのまま URL）");
ok(fetched.length === 4 && new Set(fetched).size === 4, "4 つを 1 回ずつ取る（" + fetched.length + "）");
ok(topText.includes(`from "${T}"`) && !/from "three/.test(topText) && /from "blob:test\/\d+"/.test(topText), "利用者のモジュール＝three は URL・addons と相対は blob:");
{ const all = await Promise.all([...texts.keys()].map(text)); ok(all.every(t => !/from "three"/.test(t) && !/from "\.\.?\//.test(t)), "どの本文にも bare の three・相対が残らない"); }
await loader.prepare(base); ok(fetched.length === 4, "同じ URL は 2 度取らない");
{ const l2 = createThreeLoader(map, async u => ({ "https://c/a.js": `import "./b.js";`, "https://c/b.js": `import "./a.js";` })[u]); let msg = ""; try { await l2.prepare("https://c/a.js"); } catch (e) { msg = e.message; } ok(/circular import/.test(msg), "循環は分かるエラー（" + msg + "）"); }
URL.createObjectURL = origCreate;

if (fails) { console.error(`\n✗ ${fails} 件`); process.exit(1); }
console.log("\n✓ three-resolve");
