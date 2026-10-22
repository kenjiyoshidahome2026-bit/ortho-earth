#!/usr/bin/env node
// 葉タイル走査（collectLeafTiles・meshdecode）のタイル変換の検定（ネット無し・fetch を差し替える）：
//   PDOK（オランダ 3D Basisvoorziening・2026-10-22）は root の transform に ECEF を持つ＝葉は「親から積んだ変換」を xf で持つ。
//   外部 tileset へ潜っても積みが続く／transform の無い tileset（PLATEAU・3DBAG）の葉は xf を持たない（従来と同じ形）。
import { collectLeafTiles } from "../src/meshdecode.ts";

let fails = 0; const ok = (name, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${info ? " " + info : ""}`); if (!c) fails++; };
const nearV = (a, b, e = 1e-9) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);

// 列優先 4×4：平行移動と z 軸回り 90°
const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const RZ = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c*4+r] += a[k*4+r] * b[c*4+k]; return o; };

const files = {
	"https://x.test/a/tileset.json": { root: { transform: T(3907526, 359211, 5011577), children: [
		{ content: { uri: "t/0.glb" } },
		{ transform: RZ, children: [{ content: { uri: "t/1.glb" } }] },
		{ content: { uri: "sub/tileset.json" } },
	] } },
	"https://x.test/a/sub/tileset.json": { root: { transform: T(10, 20, 30), children: [{ content: { uri: "2.glb" } }] } },
	"https://x.test/plain/tileset.json": { root: { children: [{ content: { uri: "p.b3dm" } }, { content: { uri: "q.b3dm" } }] } },
};
globalThis.fetch = async url => files[url] ? new Response(JSON.stringify(files[url]), { status: 200 }) : new Response("", { status: 404 });

const leaves = await collectLeafTiles("https://x.test/a/tileset.json");
const by = Object.fromEntries(leaves.map(t => [t.uri.replace("https://x.test/a/", ""), t]));
ok("leaves: 3", leaves.length === 3, leaves.map(t => t.uri).join(" "));
ok("root transform reaches the leaf", nearV(by["t/0.glb"]?.xf, T(3907526, 359211, 5011577)));
ok("child transform stacks after root (root·child)", nearV(by["t/1.glb"]?.xf, mul(T(3907526, 359211, 5011577), RZ)));
ok("external tileset stacks onto the parent", nearV(by["sub/2.glb"]?.xf, mul(T(3907526, 359211, 5011577), T(10, 20, 30))));
ok("leaf xf is its own copy (not the tileset's array)", by["t/0.glb"]?.xf !== files["https://x.test/a/tileset.json"].root.transform);

const plain = await collectLeafTiles("https://x.test/plain/tileset.json");
ok("no transform → no xf (PLATEAU/3DBAG shape unchanged)", plain.length === 2 && plain.every(t => !("xf" in t)));

if (fails) { console.log(`\n✗ ${fails} FAIL`); process.exit(1); }
console.log("\n✓ all PASS");
