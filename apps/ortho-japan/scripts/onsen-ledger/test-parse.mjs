// parse.mjs の検定（fixtures の wikitext に対する期待値）
import assert from "node:assert/strict";
import { parse } from "./parse.mjs";
import { PAGES } from "./fixtures/wikitext.mjs";
const k = parse(PAGES["草津温泉"]);
assert.equal(k.reading, "くさつおんせん"); assert.equal(k.pref, "群馬県"); assert.equal(k.muni, "吾妻郡草津町");
assert.equal(k.quality, "酸性泉（酸性低張性高温泉）"); assert.equal(k.ph, "2.1"); assert.equal(k.address, "群馬県吾妻郡草津町"); assert.equal(k.hasInfobox, true);
const y = parse(PAGES["湯の川温泉 (島根県)"]);
assert.equal(y.reading, "ゆのかわおんせん"); assert.equal(y.pref, "島根県"); assert.equal(y.muni, "出雲市");
assert.deepEqual(y.textCoord, [132.823611, 35.368056]); assert.equal(y.quality, "ナトリウム・カルシウム-硫酸塩・塩化物泉");
const b = parse(PAGES["別府温泉"]);
assert.deepEqual(b.tplCoord, [131.483333, 33.283333]); assert.equal(b.muni, "別府市"); assert.equal(b.quality, "単純温泉、塩化物泉ほか");
const f = parse(PAGES["架空温泉"]);
assert.equal(f.reading, "かくうおんせん"); assert.equal(f.pref, "北海道"); assert.equal(f.muni, "上川郡東川町");
const z = parse(PAGES["座標なし温泉"]);
assert.deepEqual(z.textCoord, [137.9, 36.2]); assert.equal(z.muni, "松本市");
console.error("test-parse: ok");
