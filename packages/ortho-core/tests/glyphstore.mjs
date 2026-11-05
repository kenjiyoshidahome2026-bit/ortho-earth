#!/usr/bin/env node
// 焼いた字の保存（gpu/glyphstore.ts）の検証。IDB は無い＝native-bucket の Cache と同じ口（d()／d(key)／d(key,val)／d(key,null)）を Map で作る。
//   1. pack/unpack＝往復で同じ字（寸法・位置・SDF）・壊れた塊は途中まで
//   2. 版が違う＝全部捨てる／同じ＝読める・put は塊で書かれ idx が進む・次の起動で読める
//   3. 実行中に載せた Web フォントの家族＝保存しない・読んだ分も捨てて詰め直す
//   4. 塊が COMPACT を超えたら詰め直す
// 使い方: node packages/ortho-core/tests/glyphstore.mjs
import { packChunk, unpackChunk, createGlyphStore, CHUNK, COMPACT } from "../src/gpu/glyphstore.ts";

let fails = 0, n = 0;
const ok = (name, cond, note = "") => { n++; console.log(`  ${cond ? "✔" : "✘"} ${name}${note ? " (" + note + ")" : ""}`); if (!cond) fails++; };
const fakeCache = (map = new Map()) => {
	const d = async (key, val) => {
		if (key === undefined) return [...map.keys()];
		if (val === undefined) return map.get(key);
		if (val === null || val === false) { map.delete(key); return key; }
		map.set(key, structuredClone(val)); return key;
	};
	d.map = map; return d;
};
const rec = (w, h, seed) => ({ w, h, ox: -seed, oy: -(seed + 1), sdf: Uint8Array.from({ length: w * h }, (_, i) => (i * 7 + seed) & 255) });
const same = (a, b) => a.w === b.w && a.h === b.h && a.ox === b.ox && a.oy === b.oy && a.sdf.length === b.sdf.length && a.sdf.every((v, i) => v === b.sdf[i]);
const K = (font, ch) => `32px ${font}\u0001${ch}`;
const quiet = { flushMs: 1, log: () => {} };

// 1. pack/unpack
{
	const e = [[K("sans-serif", "あ"), rec(40, 44, 1)], [K("sans-serif", "い"), rec(38, 44, 2)], [K("serif", "A"), rec(20, 30, 3)]];
	const c = packChunk(e), out = new Map();
	ok("pack: 3 keys / meta 12 / sdf = sum", c.keys.length === 3 && c.meta.length === 12 && c.sdf.length === 40 * 44 + 38 * 44 + 20 * 30);
	ok("unpack: 3 restored, all equal", unpackChunk(c, out) === 3 && e.every(([k, r]) => same(out.get(k), r)));
	const broken = { ...c, sdf: c.sdf.subarray(0, 40 * 44 + 10) }, out2 = new Map();
	ok("unpack: broken chunk stops after the intact glyph", unpackChunk(broken, out2) === 1 && out2.has(K("sans-serif", "あ")));
	const out3 = new Map();
	ok("unpack: skip() filters", unpackChunk(c, out3, k => k.includes("serif\u0001A")) === 2 && !out3.has(K("serif", "A")));
}
// 2. version / put / flush / reload
{
	const cache = fakeCache();
	const s1 = createGlyphStore(async () => cache, "v1", quiet); await s1.ready;
	ok("empty store: idx written", cache.map.get("idx")?.ver === "v1" && cache.map.get("idx")?.chunks === 0);
	for (let i = 0; i < CHUNK + 5; i++) s1.put(K("sans-serif", String.fromCharCode(0x4e00 + i)), rec(40, 44, i));
	s1.put(K("sans-serif", "一"), rec(1, 1, 99));   // 同じ鍵＝二度は覚えない
	ok("get: returns what was put", s1.get(K("sans-serif", "丁"))?.ox === -1);
	await s1.flush();
	ok(`flush: ${CHUNK}+5 glyphs → 2 chunks`, s1.stats().chunks === 2 && cache.map.get("idx").chunks === 2 && cache.map.get("c0").keys.length === CHUNK && cache.map.get("c1").keys.length === 5, JSON.stringify(s1.stats()));
	const s2 = createGlyphStore(async () => cache, "v1", quiet); await s2.ready;
	ok("reload same version: all glyphs back", s2.stats().loaded === CHUNK + 5 && same(s2.get(K("sans-serif", "丂")), rec(40, 44, 2)));
	const s3 = createGlyphStore(async () => cache, "v2", quiet); await s3.ready;
	ok("reload other version: cleared", s3.stats().loaded === 0 && cache.map.get("idx").chunks === 0 && !cache.map.has("c0") && !cache.map.has("c1"));
	const s4 = createGlyphStore(async () => { throw new Error("no idb"); }, "v1", quiet); await s4.ready;
	s4.put(K("x", "a"), rec(2, 2, 1)); await s4.flush();
	ok("no IDB: keeps working in memory", s4.get(K("x", "a"))?.w === 2 && s4.stats().chunks === 0);
}
// 3. excluded families
{
	const cache = fakeCache();
	const s1 = createGlyphStore(async () => cache, "v1", quiet); await s1.ready;
	s1.put(K('"Noto Sans JP", sans-serif', "字"), rec(40, 44, 1)); s1.put(K("sans-serif", "字"), rec(40, 44, 2));
	await s1.flush();
	const s2 = createGlyphStore(async () => cache, "v1", quiet); await s2.ready;
	ok("before exclude: both loaded", s2.stats().loaded === 2);
	s2.excludeFamily("Noto Sans JP");
	ok("exclude: web-font glyph dropped from memory, system font kept", !s2.get(K('"Noto Sans JP", sans-serif', "字")) && !!s2.get(K("sans-serif", "字")));
	s2.put(K('"Noto Sans JP", sans-serif', "新"), rec(40, 44, 3));
	ok("exclude: new web-font glyph not remembered", !s2.get(K('"Noto Sans JP", sans-serif', "新")));
	await s2.flush();
	const s3 = createGlyphStore(async () => cache, "v1", quiet); await s3.ready;
	ok("after exclude + flush: disk rewritten without the web font", s3.stats().loaded === 1 && !!s3.get(K("sans-serif", "字")));
}
// 4. compaction
{
	const cache = fakeCache();
	let s = createGlyphStore(async () => cache, "v1", quiet); await s.ready;
	for (let i = 0; i <= COMPACT; i++) { s = createGlyphStore(async () => cache, "v1", quiet); await s.ready; s.put(K("sans-serif", String.fromCharCode(0x3041 + i)), rec(10, 10, i)); await s.flush(); }
	ok(`${COMPACT + 1} launches → ${COMPACT + 1} chunks`, cache.map.get("idx").chunks === COMPACT + 1);
	s = createGlyphStore(async () => cache, "v1", quiet); await s.ready;
	ok("reload compacts to 1 chunk, nothing lost", cache.map.get("idx").chunks === 1 && s.stats().loaded === COMPACT + 1 && !cache.map.has("c1"));
}
console.log(fails ? `\nFAIL ${fails}/${n}` : `\nPASS ${n}`);
process.exit(fails ? 1 : 0);
