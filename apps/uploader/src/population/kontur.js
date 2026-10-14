// Kontur Population（H3 のセルごとの人口・CC BY 4.0）→ bucket GIS/h3/kontur-20231101/（/globe/hex・issue #310・2026-10-14）。
// 配っている所（Kontur の S3）は CORS のヘッダを返さない＝ブラウザの頁からは直に読めない＝ここ（uploader）で読んで、
// 「セルの id と人口」だけの小さな二進（apps/ortho-globe/hex-pop.js の H3P1）にして置く。読む側＝apps/ortho-globe/hex.js。
//   r4.h3p          … 解像度 4（一辺 約 26 km）の全球 1 本（7.1 万セル・gzip で約 200KB）。2・3 は頁が足し上げて作る
//   r6/<親>.h3p      … 解像度 6（一辺 約 3.7 km）を res 1 の親ごとに 1 本（501 本・計 約 7.6MB）。頁は視野に入った親だけ読む。5 は頁が足し上げる
//   r6/index.json   … 親 → セル数（頁が「無い親」を読みに行かない）
//   meta.json       … 出典・ライセンス・版・数
// 同じ版＝同じ中身＝既にある物は置き直さない（途中で止まっても押し直せば続きから）。gpkg は自前の SQLite 読み（geopbf/sqlite）。
import { openSqlite } from "geopbf/sqlite";
import { h3 } from "@ortho-earth/h3/core";
import { encodeHexPop } from "../../../ortho-globe/hex-pop.js";

const VERSION = "20231101";
const SRC = res => `https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_${VERSION}_r${res}.gpkg.gz`;
const DIR = `GIS/h3/kontur-${VERSION}`;
const META = { source: "Kontur Population", url: "https://data.humdata.org/dataset/kontur-population-dataset", license: "CC BY 4.0", version: VERSION };

// gpkg.gz を proxy 経由で読み、[[h3, 人口], …] を返す（r6 は 185MB→展開 509MB・数十秒）
async function readKontur(q, Fetch, res) {
	q.log(`r${res}: ${SRC(res)} を読む…`);
	const buf = await Fetch(SRC(res), { type: "arraybuffer", cors: true });   // gzip は Fetch が解く
	if (!buf) throw new Error(`r${res}: 取れない`);
	q.log(`r${res}: ${(buf.byteLength / 1e6).toFixed(0)}MB の gpkg を開く`);
	const db = openSqlite(new Uint8Array(buf));
	const rows = [];
	for (const r of db.rows("population")) rows.push([r.h3, r.population]);
	const total = rows.reduce((a, r) => a + r[1], 0);
	q.log(`r${res}: ${rows.length.toLocaleString()} セル・${Math.round(total).toLocaleString()} 人`);
	return { rows, total };
}

const put = (bucket, name, u8, type = "application/octet-stream") => bucket.put(new File([u8], name, { type }));

export async function konturR4(q, { Fetch, Bucket }) {
	q.clear(); q.title(`Kontur population r4 → ${DIR}`);
	const bucket = await Bucket(DIR);
	if (!bucket) throw new Error(`Bucket(${DIR}) に到達できない`);
	if (await bucket.exist("r4.h3p")) { q.log("= r4.h3p（既にある）"); return; }
	const { rows, total } = await readKontur(q, Fetch, 4);
	const u8 = encodeHexPop(rows, { parentRes: 0 });
	await put(bucket, "r4.h3p", u8);
	await put(bucket, "meta.json", new TextEncoder().encode(JSON.stringify({ ...META, r4: { cells: rows.length, total: Math.round(total) } })), "application/json");
	q.success(`↑ ${DIR}/r4.h3p（${(u8.length / 1e3).toFixed(0)}KB 生・gzip で置く）`);
}

export async function konturR6(q, { Fetch, Bucket }) {
	q.clear(); q.title(`Kontur population r6 → ${DIR}/r6`);
	const bucket = await Bucket(`${DIR}/r6`);
	if (!bucket) throw new Error(`Bucket(${DIR}/r6) に到達できない`);
	const have = new Set((await bucket.list()).map(o => o.Key));
	if (have.has("index.json")) { q.log("= r6/index.json（既にある＝全部置き終えている）"); return; }
	const { rows } = await readKontur(q, Fetch, 6);
	const by = new Map();
	for (const r of rows) { const p = h3.cellToParent(r[0], 1); (by.get(p) ?? by.set(p, []).get(p)).push(r); }
	const index = {};
	let done = 0, bytes = 0;
	for (const [p, list] of [...by].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
		index[p] = list.length;
		const name = `${p}.h3p`;
		if (!have.has(name)) { const u8 = encodeHexPop(list, { parentRes: 1 }); await put(bucket, name, u8); bytes += u8.length; }
		if (++done % 50 === 0) q.log(`r6: ${done} / ${by.size}`);
	}
	await put(bucket, "index.json", new TextEncoder().encode(JSON.stringify({ res: 6, parentRes: 1, parents: index })), "application/json");   // 最後に置く＝これが在る＝全部揃った
	q.success(`↑ ${DIR}/r6/（${by.size} 本・新たに ${(bytes / 1e6).toFixed(1)}MB 生）`);
}
