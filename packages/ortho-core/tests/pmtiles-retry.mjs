// PMTiles の失敗を覚えっぱなしにしない（src/pmtiles-src.js・2026-09-25）。node packages/ortho-core/tests/pmtiles-retry.mjs
// 一時的な失敗（オフライン）の後、RETRY_MS を過ぎたら同じ archive を読み直せること。直後は再取得の嵐を起こさないこと。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { pmtilesInfo } from "../src/pmtiles-src.js";

// 最小の PMTiles v3（ヘッダ 127B＋空の root ディレクトリ 1B＋metadata JSON・内部圧縮なし）
const md = new TextEncoder().encode(JSON.stringify({ vector_layers: [{ id: "roads" }], name: "tiny" }));
const buf = new Uint8Array(128 + md.length), dv = new DataView(buf.buffer);
buf.set(new TextEncoder().encode("PMTiles"), 0); buf[7] = 3;
const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
u64(8, 127); u64(16, 1); u64(24, 128); u64(32, md.length); u64(40, 0); u64(48, 0); u64(56, buf.length); u64(64, 0);
buf[96] = 1; buf[97] = 1; buf[98] = 1; buf[99] = 1; buf[100] = 0; buf[101] = 5;   // clustered・内部圧縮 none・タイル圧縮 none・mvt・z0-5
dv.setInt32(102, -1800000000, true); dv.setInt32(106, -850000000, true); dv.setInt32(110, 1800000000, true); dv.setInt32(114, 850000000, true);

let online = false, calls = 0;
globalThis.fetch = async () => { calls++; if (!online) throw new TypeError("Failed to fetch"); return new Response(buf, { status: 200 }); };
mock.timers.enable({ apis: ["setTimeout"] });
const URL_ = "pmtiles://https://example.test/tiny.pmtiles";

await assert.rejects(pmtilesInfo(URL_), "オフラインでは失敗");
online = true;
const before = calls;
await assert.rejects(pmtilesInfo(URL_), "RETRY_MS 内は同じ失敗（取り直しの嵐を起こさない）");
assert.equal(calls, before, "RETRY_MS 内は fetch しない");
await new Promise(r => setImmediate(r));
mock.timers.tick(5000);
const info = await pmtilesInfo(URL_);
assert.equal(info.maxZoom, 5); assert.equal(info.tileType, "mvt");   // ヘッダが読めた＝archive を作り直した
console.log("  ✔ 一時的な失敗の後、RETRY_MS を過ぎたら読み直せる（直後は fetch しない）");
mock.timers.reset();
console.log("\n✅ pmtiles-retry 1 件");
