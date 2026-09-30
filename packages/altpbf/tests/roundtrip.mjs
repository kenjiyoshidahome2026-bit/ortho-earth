// altpbf の往復の検定（src/format.js）。node packages/altpbf/tests/roundtrip.mjs
// 守るもの：①encode→decode で寸法・原点・標高が元に戻る ②差分が Int16 の幅を越えても値が戻る ③書いた分だけを圧縮する（末尾のゼロを持たない）
import assert from "node:assert/strict";
import { encode, decode } from "../src/format.js";
import { inflateRaw } from "geopbf/gzip";
const W = 64, H = 48, data = new Int16Array(W * H);
for (let i = 0; i < data.length; i++) data[i] = Math.round(3000 * Math.sin(i / 7) + (i % 13) * 11);
data[5] = 32000; data[6] = -32000;   // 差分 −64000＝Int16 では折り返す
const obj = { name: "R01N035E139", source: "TEST", lng: 139, lat: 35, range: 1, width: W, height: H, data };
const bytes = await encode(obj);
const back = await decode(new Blob([bytes]));
for (const k of ["name", "source", "lng", "lat", "range", "width", "height"]) assert.equal(back[k], obj[k], k);
assert.deepEqual(Array.from(back.data), Array.from(data));
const raw = await inflateRaw(bytes);
assert.notEqual(raw[raw.length - 1], 0, "末尾に確保容量のゼロが無い");
console.log("✓ altpbf roundtrip");
