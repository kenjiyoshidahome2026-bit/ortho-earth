#!/usr/bin/env node
// bench-tile の見本の焼き（vt perf plan §2・Phase 0）。globe/tests/fixtures/optbv は WA/Anno だけ＝都心 z16（道路・建物・街区が主）の
// 組み立て（earcut・線の細分）の比率が測れない。ここは地理院 optimal_bvmap の実タイルを、内蔵の gsi style が読む層（neededSourceLayers＋建物）
// だけ残して tests/fixtures/vt/<見本>/z/x/y.pbf に置く（層の間引きは MVT の最上位 field 3 を丸ごと落とすだけ＝中身はバイト一致）。
// ⚠配信元へ届く器で回す（クラウドの器は外へ出られない＝本人の Mac で）：node packages/ortho-core/scripts/bake-vt-fixture.mjs [--case tokyo-z16|fuji-z13]
// 見本（bench-perf.mjs の 3 シーンと同じ場所）：
//   tokyo-z16＝東京駅 z16 3×3（139.7671, 35.6812・都心＝建物と街区）  fuji-z13＝富士 z13 2×2（138.7274, 35.3606・郊外＝等高線・林・道路の線が主）
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neededSourceLayers } from "../src/decode.ts";
import gsi from "@ortho-earth/globe/style-gsi.js";

const OUT = fileURLToPath(new URL("../tests/fixtures/vt/", import.meta.url));
const SRC = "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/";
const only = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : null;
const KEEP = neededSourceLayers({ layers: gsi.layers, schema: gsi.schema });
const grid = (z, x0, y0, nx, ny) => { const o = []; for (let y = y0; y < y0 + ny; y++) for (let x = x0; x < x0 + nx; x++) o.push(`${z}/${x}/${y}`); return o; };
const CASES = {
	"tokyo-z16": grid(16, 58210, 25805, 3, 3),
	"fuji-z13": grid(13, 7253, 3234, 2, 2),
};

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

for (const [name, keys] of Object.entries(CASES)) {
	if (only && name !== only) continue;
	const dir = path.join(OUT, name);
	rmSync(dir, { recursive: true, force: true });
	let inB = 0, outB = 0;
	for (const key of keys) {
		const r = await fetch(SRC + key + ".pbf");
		if (r.status === 404) { console.warn(`${name} ${key}: 404（無いタイル＝飛ばす）`); continue; }
		if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
		const b = new Uint8Array(await r.arrayBuffer()), o = keepLayers(b);
		mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
		writeFileSync(path.join(dir, key + ".pbf"), o);
		inB += b.length; outB += o.length;
	}
	console.log(`${name}: ${keys.length} tiles  ${(inB / 1024) | 0} KB → ${(outB / 1024) | 0} KB（層 ${KEEP.size}）`);
}
