// COPC の解読器はプラグイン（#178）：globe 既定の "#pointcloud-formats"（{}）のままなら、open が取りに行く前に「何を足すか」を返す。node packages/globe/tests/copc-noplugin.mjs
import assert from "node:assert/strict";
const out = [];
let fetched = 0;
globalThis.fetch = async () => { fetched++; throw new Error("must not fetch"); };
globalThis.self = { postMessage: m => out.push(m), location: { href: "file:///" } };
await import("../src/copc-worker.js");
await self.onmessage({ data: { type: "open", id: "x", src: "https://example.invalid/a.copc.laz" } });
assert.equal(out.length, 1);
assert.equal(out[0].type, "error");
assert.match(out[0].error, /no LAZ decoder.*@ortho-earth\/tile-formats\/pointcloud/);
assert.equal(fetched, 0);
console.log("  ✔ プラグイン無し＝取りに行かずに足す物を返す");
