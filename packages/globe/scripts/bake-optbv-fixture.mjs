#!/usr/bin/env node
// tests/fixtures/optbv の焼き直し（T3・2026-09-25）。t-mlstyle・t-request が東京湾 #10.5/35.5/139.85 で使う
// 地理院 optimal_bvmap のタイルを取り、判定に使う層（WA＝海の塗り・Anno＝注記）だけを残して置く。
// 層の間引きは MVT の最上位 field 3（layer）を丸ごと落とすだけ＝再エンコードしない（中身はバイト一致）。
// 一覧＝両頁を CDP で走らせ Network.requestWillBeSent（worker 含む）で拾った 35 枚。視野や LOD を変えたら取り直すこと
// （無いタイルは vite が 404＝紙色で描かれるだけで頁は壊れないが、判定の画素が欠ける）。
//   node packages/globe/scripts/bake-optbv-fixture.mjs
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../tests/fixtures/optbv/", import.meta.url));
const SRC = "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/";
const KEEP = new Set(["WA", "Anno"]);
const KEYS = "10/908/402 10/908/403 10/908/404 10/909/402 10/909/403 10/909/404 10/910/402 10/910/403 10/910/404 10/911/402 10/911/403 10/911/404 13/7276/3225 13/7277/3225 15/29104/12902 15/29107/12902 16/58209/25806 16/58210/25804 16/58210/25805 16/58210/25806 16/58210/25807 16/58211/25804 16/58211/25805 16/58211/25806 16/58211/25807 16/58212/25804 16/58212/25805 16/58212/25806 16/58212/25807 16/58213/25804 16/58213/25805 16/58213/25806 16/58213/25807 4/14/6 7/113/50".split(" ");

const varint = (b, p) => { let v = 0, s = 0, c; do { c = b[p++]; v += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return [v, p]; };
function layerName(b) {
	let p = 0;
	while (p < b.length) {
		let k; [k, p] = varint(b, p);
		const f = k >> 3, w = k & 7;
		if (w === 2) { let n; [n, p] = varint(b, p); if (f === 1) return new TextDecoder().decode(b.subarray(p, p + n)); p += n; }
		else if (w === 0) [, p] = varint(b, p);
		else if (w === 5) p += 4;
		else if (w === 1) p += 8;
		else throw new Error("unexpected wire type " + w);
	}
	return null;
}
function keepLayers(b) {
	const out = []; let p = 0;
	while (p < b.length) {
		const s = p; let k, n; [k, p] = varint(b, p); [n, p] = varint(b, p);
		if ((k >> 3) === 3 && KEEP.has(layerName(b.subarray(p, p + n)))) out.push(b.subarray(s, p + n));
		p += n;
	}
	return Buffer.concat(out);
}

rmSync(OUT, { recursive: true, force: true });
let inB = 0, outB = 0;
for (const key of KEYS) {
	const r = await fetch(SRC + key + ".pbf");
	if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
	const b = new Uint8Array(await r.arrayBuffer()), o = keepLayers(b);
	mkdirSync(path.dirname(OUT + key), { recursive: true });
	writeFileSync(OUT + key + ".pbf", o);
	inB += b.length; outB += o.length;
}
console.log(`${KEYS.length} tiles  ${(inB / 1024) | 0} KB → ${(outB / 1024) | 0} KB（${[...KEEP].join("・")}）`);
