// 標高の varint 読み（src/svarint.ts）の検定。node packages/altpbf/tests/svarint.mjs
// 守るもの：①wasm の台帳（.rs を変えたのに焼き直していない・埋めた wasm を手で触った を止める）
//           ②simd・scalar・js の 3 通りが Pbf.readSVarint の累積（旧 decode）と同じ値・同じ終わりの位置・同じ「−1」を返す
//             （1〜5 バイトの varint・32 bit 超え・切れた入力・1 MiB の塊の境目をまたぐ varint・out より多い値）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Pbf from "geopbf/pbf";
import { svarintRun, svarintKinds } from "../src/svarint.ts";
import * as sv from "../src/svarint.ts";

const DIR = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(DIR, "../scripts/wasm-embed.mjs"), "--check"], { stdio: "inherit" });

const kinds = svarintKinds();
assert.ok(kinds.includes("js"));
if (!kinds.includes("simd")) console.log("（この node は wasm SIMD を持たない＝simd の照合は飛ばす）");

// 参照＝旧 decode の読み（Pbf で値ごと）。32 bit 超えでも読める＝新しい読みが −1 を返した所は呼び手がこれでやり直す
const ref = (buf, start, end, n) => {
	const pbf = new Pbf(buf), out = new Int16Array(n); let sum = 0, i = 0; pbf.pos = start;
	while (pbf.pos < end) { sum += pbf.readSVarint(); out[i++] = sum; }
	return { out, i, pos: pbf.pos };
};
let seed = 11; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const gen = (n, mode) => {
	const vals = [];
	for (let i = 0; i < n; i++) {
		const r = rnd();
		vals.push(mode === 0 ? (rnd() * 128 | 0) - 64                                     // 1 バイト
			: mode === 1 ? (r < 0.9 ? (rnd() * 128 | 0) - 64 : (rnd() * 70000 | 0) - 35000)   // ほぼ 1 バイト・時々 2〜3 バイト
			: mode === 2 ? Math.round((rnd() - 0.5) * 2 ** 32)                                 // int32 全域＝5 バイト
			: (r < 0.999 ? (rnd() * 600 | 0) - 300 : Math.round((rnd() - 0.5) * 2 ** 40)));   // まれに 32 bit 超え
	}
	const pbf = new Pbf(); pbf.writeVarintField(4, 1); pbf.writePackedSVarint(10, vals); pbf.writeStringField(1, "after");
	const buf = pbf.finish(), p = new Pbf(buf); let start, end;
	p.readFields(tag => { if (tag === 10) { end = p.readPackedEnd(); start = p.pos; p.pos = end; } });
	return { buf, start, end, n };
};
let cases = 0;
const cmp = ({ buf, start, end, n }, label, cut = 0, short = 0) => {
	const e = end - cut, r = (() => { try { return ref(buf, start, e, n); } catch (err) { return { err: String(err) }; } })();
	for (const k of kinds) {
		const out = new Int16Array(Math.max(0, n - short)), got = svarintRun(buf, start, e, out, k);
		cases++;
		if (got < 0) { assert.ok(r.err || r.i !== undefined, `${label} ${k}: −1`); continue; }   // −1＝Pbf でやり直す（旧と同じになる）
		assert.ok(!r.err, `${label} ${k}: 旧は例外（${r.err}）なのに値を返した`);
		assert.equal(got, r.i, `${label} ${k}: 値の数`);
		assert.equal(sv.svarintPos, r.pos, `${label} ${k}: 終わりの位置`);
		for (let i = 0; i < out.length; i++) if (out[i] !== r.out[i]) assert.fail(`${label} ${k}: [${i}] ${out[i]} ≠ ${r.out[i]}`);
	}
};
for (let c = 0; c < 400; c++) {
	const mode = c % 4, n = c % 25 === 0 ? 600000 + (rnd() * 900000 | 0) : 1 + (rnd() * 20000 | 0);   // 16 通りは 1 MiB の塊を 2〜6 つまたぐ
	const g = gen(n, mode);
	cmp(g, `case ${c} mode ${mode} n ${n}`);
	if (c % 7 === 0) cmp(g, `case ${c} 切れ`, 1 + (rnd() * 3 | 0));
	if (c % 11 === 0) cmp(g, `case ${c} out 短い`, 0, 1 + (rnd() * 50 | 0));
}
// 塊の境目（1 MiB）の前後に 5 バイトの varint を置く
for (const at of [-6, -5, -4, -3, -2, -1, 0, 1]) {
	const vals = []; let bytes = 0;
	while (bytes < (1 << 20) + at) { vals.push(1); bytes++; }
	vals.push(-(2 ** 31)); for (let i = 0; i < 40; i++) vals.push(i - 20);
	const pbf = new Pbf(); pbf.writePackedSVarint(10, vals);
	const buf = pbf.finish(), p = new Pbf(buf); let start, end;
	p.readFields(tag => { if (tag === 10) { end = p.readPackedEnd(); start = p.pos; p.pos = end; } });
	assert.equal(start, buf.length - (end - start));
	cmp({ buf, start, end, n: vals.length }, `境目 ${at}`);
}
console.log(`✓ altpbf svarint（${kinds.join("・")}・${cases} 通り）`);
