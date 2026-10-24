#!/usr/bin/env node
// Kontur Population（H3 のセルごとの人口・CC BY 4.0）→ /globe/hex が読む小さな二進（hex-pop.ts の H3P1）を焼く（issue #310・2026-10-14）。
// 置き場＝GitHub Pages（リポ ortho-data の globe/h3/kontur-<版>/・本人裁定 10/14「uploader を使わずに github.io に置く」）。
// 焼いた先＝packages/world/out/h3/（world の out/ と同じ＝作り直せる生成物・git に入らない）→ 置くのは world の publish-pages.mjs：
//   node apps/hex/scripts/kontur-h3.mjs                                   … Kontur の S3 から gpkg.gz を取って焼く（r6 は 185MB）
//   node apps/hex/scripts/kontur-h3.mjs --src=DIR                         … 手元の r4.gpkg[.gz]・r6.gpkg[.gz] から
//   npm run publish:pages -w world-data -- --only=h3            （予行）→ 同じに --write（commit して push）
// 焼く物：
//   r4.h3p.gz        … 解像度 4（一辺 約 26 km）の全球 1 本（7.1 万セル・約 200KB）。3 は頁が足し上げて作る
//   r6/<親>.h3p.gz   … 解像度 6（一辺 約 3.7 km）を res 1 の親ごとに 1 本（501 本・計 約 7.6MB）。頁は視野に入った親だけ読む。5 は頁が足し上げる
//   r6/index.json    … 親 → セル数（頁が「無い親」を読みに行かない）
//   meta.json        … 出典・ライセンス・版・数
// .gz＝中身を gzip のまま置く（Pages は二進を圧縮して配らない＝帯域が 2 倍になる）。頁は gzip の頭を見て自分で解く（hex-pop.ts の bytesOf）。
import fs from "node:fs"; import path from "node:path"; import { gunzipSync, gzipSync } from "node:zlib"; import { fileURLToPath } from "node:url";
import { openSqlite } from "geopbf/sqlite";
import { h3 } from "@ortho-earth/h3/core";
import { encodeHexPop } from "../hex-pop.ts";

const VERSION = "20231101";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? "").slice(n.length + 3);
const OUT = path.resolve(arg("out") || path.join(ROOT, "packages/world/out/h3", `kontur-${VERSION}`));
const SRC = arg("src") ? path.resolve(arg("src")) : null;
const URL_OF = res => `https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_${VERSION}_r${res}.gpkg.gz`;
const META = { source: "Kontur Population", url: "https://data.humdata.org/dataset/kontur-population-dataset", license: "CC BY 4.0", version: VERSION };

async function gpkg(res) {
	const local = SRC && [`r${res}.gpkg`, `r${res}.gpkg.gz`].map(f => path.join(SRC, f)).find(f => fs.existsSync(f));
	let buf;
	if (local) { console.log(`r${res}: ${local}`); buf = fs.readFileSync(local); }
	else {
		console.log(`r${res}: ${URL_OF(res)} を取る…`);
		const r = await fetch(URL_OF(res));
		if (!r.ok) throw new Error(`r${res}: ${r.status}`);
		buf = Buffer.from(await r.arrayBuffer());
	}
	if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
	const rows = [];
	for (const r of openSqlite(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)).rows("population")) rows.push([r.h3, r.population]);
	const total = Math.round(rows.reduce((a, r) => a + r[1], 0));
	console.log(`r${res}: ${rows.length.toLocaleString()} セル・${total.toLocaleString()} 人`);
	return { rows, total };
}
const write = (rel, data) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return data.length; };
// gzip の頭の時刻を 0 に（zlib の既定）＝同じ中身なら同じバイト＝publish-pages の「同じ」に乗る
const gz = u8 => gzipSync(u8, { level: 9 });

const r4 = await gpkg(4);
const n4 = write("r4.h3p.gz", gz(encodeHexPop(r4.rows, { parentRes: 0 })));
console.log(`  r4.h3p.gz ${(n4 / 1e3).toFixed(0)}KB`);

const r6 = await gpkg(6);
const by = new Map();
for (const r of r6.rows) { const p = h3.cellToParent(r[0], 1); (by.get(p) ?? by.set(p, []).get(p)).push(r); }
fs.rmSync(path.join(OUT, "r6"), { recursive: true, force: true });   // 版の中で親が減っても古い物を残さない
const parents = {};
let bytes = 0;
for (const [p, list] of [...by].sort((a, b) => a[0] < b[0] ? -1 : 1)) { parents[p] = list.length; bytes += write(`r6/${p}.h3p.gz`, gz(encodeHexPop(list, { parentRes: 1 }))); }
write("r6/index.json", JSON.stringify({ res: 6, parentRes: 1, parents }));
console.log(`  r6/ ${by.size} 本・${(bytes / 1e6).toFixed(1)}MB`);

write("meta.json", JSON.stringify({ ...META, r4: { cells: r4.rows.length, total: r4.total }, r6: { cells: r6.rows.length, total: r6.total, parents: by.size } }));
console.log(`焼いた: ${OUT}\n置く: npm run publish:pages -w world-data -- --only=h3   （予行 → --write）`);
