#!/usr/bin/env node
// HEALPix のタイルの山（Norder{k}/Dir{d}/Npix{n}.mvt ＋ index.json）を、面ごとの PMTiles（face{f}.pmtiles・最大 12 個）に束ねる（2026-11-27）。
// 本人（2026-11-27）「12個に分けてpmタイル化というのはどうですか？」。HEALPix の面 1 つは段 k で 2^k × 2^k の四分木＝PMTiles の z/x/y と同じ形なので、
//   z ＝ Norder・x ＝ 面の中の ix（北東向き）・y ＝ 面の中の iy（北西向き）
// と読み替えるだけで、PMTiles v3 の仕様（Hilbert の番号・索引・Range 読み）をそのまま借りられる。y はメルカトルの「上から下」に直さない（iy のまま）。
// ＝既製のビューア（pmtiles.io 等）で開くと位置はでたらめになる。メタデータの healpix 節にこの約束を書く。全国 20 万枚（小さいファイルの山）を 1 回の PUT と Range 読みに変える。
// 書き手は geopbf の writePMTiles（同じ中身のタイルは 1 回だけ格納・タイルと索引は gzip）。全部を記憶に載せて組む＝面 1 つが数 GB までの大きさ向け（日本＝約 1.1 GB）。
//
// 使い方（repo の根から）:
//   node packages/ortho-core/scripts/pack-healpix-pmtiles.mjs                       # bake-out/hpx/osm → bake-out/hpx/osm-pm/face{f}.pmtiles
//   … --in=bake-out/hpx/osm-japan --out=bake-out/hpx/osm-pm --name="OSM Japan" --verify=500   # 束ねた後、無作為 500 枚を読み戻して元と突き合わせる（既定 200・0 で省く）
// 出力：<out>/face{f}.pmtiles ＋ <out>/index.json { made, source, layers, minOrder, maxOrder, extent, faces: [{ face, file, tiles, bytes }], tiles, bytes }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cellOf } from "../src/healpix.ts";
import { hpxFaceWindow } from "../src/healpixvt.ts";
import { writePMTiles, readPMTiles } from "../../geopbf/src/convert/pmtiles.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const opt = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IN = path.resolve(ROOT, opt("in", "bake-out/hpx/osm")), OUT = path.resolve(ROOT, opt("out", "bake-out/hpx/osm-pm")), VERIFY = +opt("verify", 200);
const idx = JSON.parse(fs.readFileSync(path.join(IN, "index.json"), "utf8")), t0 = Date.now();
if (!Array.isArray(idx.tiles) || !idx.tiles.length) { console.error(`タイルの一覧が無い：${path.join(IN, "index.json")}`); process.exit(1); }

// タイルを面ごとに分ける（パス → order・npix → 面・ix・iy）
const faces = new Map();
for (const rel of idx.tiles) {
	const m = /^Norder(\d+)\/Dir\d+\/Npix(\d+)\.\w+$/.exec(rel); if (!m) { console.error(`読めないパス：${rel}`); process.exit(1); }
	const z = +m[1], c = cellOf(z, +m[2]);
	(faces.get(c.face) ?? faces.set(c.face, []).get(c.face)).push({ rel, z, x: c.ix, y: c.iy });
}
console.log(`[hpx-pm] ${path.relative(ROOT, IN)}（${idx.tiles.length} 枚）→ ${path.relative(ROOT, OUT)}・面 ${[...faces.keys()].sort((a, b) => a - b).join(",")}`);
fs.mkdirSync(OUT, { recursive: true });
const made = []; let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (const face of [...faces.keys()].sort((a, b) => a - b)) {
	const list = faces.get(face); let raw = 0, zmin = 99, zmax = 0;
	const tiles = list.map(t => { const data = fs.readFileSync(path.join(IN, t.rel)); raw += data.length; if (t.z < zmin) zmin = t.z; if (t.z > zmax) zmax = t.z; return { z: t.z, x: t.x, y: t.y, data }; });
	const w = hpxFaceWindow(face), bounds = [w[0] > 180 ? w[0] - 360 : w[0], w[1], w[2] > 180 ? w[2] - 360 : w[2], w[3]];   // 面を含む経緯度の窓（目安・メルカトルの範囲ではない）
	const meta = {
		name: opt("name", `${path.basename(IN)} face ${face}`), format: "pbf", type: "overlay", attribution: idx.source ?? "", minzoom: zmin, maxzoom: zmax,
		vector_layers: (idx.layers ?? []).map(id => ({ id, fields: {}, minzoom: zmin, maxzoom: zmax })),
		// ★メルカトルではない：z＝Norder・x＝面の中の ix・y＝面の中の iy（北西向きに増える＝y を反転しない）。タイルの中の座標は面の (x, y)・y が上向き（docs/design/healpix.md §1・§5）
		healpix: { scheme: "healpix-face", face, z: "Norder", x: "ix", y: "iy", extent: idx.extent ?? 4096, tileY: "up" },
	};
	const buf = await writePMTiles(tiles, meta, { tileCompression: "gzip", internalCompression: "gzip", tileType: 1, minZoom: zmin, maxZoom: zmax, bounds, center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, zmin] });
	const file = `face${face}.pmtiles`; fs.writeFileSync(path.join(OUT, file), buf);
	made.push({ face, file, tiles: list.length, bytes: buf.length });
	console.log(`  面 ${face}：${list.length} 枚・元 ${(raw / 1e6).toFixed(1)} MB → ${file} ${(buf.length / 1e6).toFixed(1)} MB（${(buf.length / raw * 100).toFixed(0)}%）・Norder ${zmin}..${zmax}・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
	if (VERIFY > 0) {   // 読み戻し：無作為の VERIFY 枚＋各段の 1 枚目が、元のファイルと同じバイト列か。無いはずのタイルが null か
		const r = await readPMTiles(buf), pick = new Set(); for (let i = 0; i < Math.min(VERIFY, list.length); i++) pick.add(Math.floor(rnd() * list.length));
		const seenZ = new Set(); list.forEach((t, i) => { if (!seenZ.has(t.z)) { seenZ.add(t.z); pick.add(i); } });
		let bad = 0; for (const i of pick) { const t = list[i], got = await r.getTile(t.z, t.x, t.y); if (!got || !Buffer.from(got).equals(tiles[i].data)) { bad++; if (bad < 4) console.error(`    ✗ 読み戻しが違う：${t.rel}`); } }
		const have = new Set(list.map(t => `${t.z}/${t.x}/${t.y}`)); let ghosts = 0, tried = 0;
		for (let i = 0; i < 200; i++) { const t = list[Math.floor(rnd() * list.length)], x = t.x ^ 1, y = (t.y + 3) % (1 << t.z); if (have.has(`${t.z}/${x}/${y}`)) continue; tried++; if (await r.getTile(t.z, x, y)) ghosts++; }
		console.log(`    読み戻し：${pick.size} 枚中 違い ${bad}・無いはずのタイル ${tried} 個中 出てきた ${ghosts}・メタ healpix.face=${r.metadata.healpix?.face}`);
		if (bad || ghosts) { console.error("読み戻しが合わない＝止める"); process.exit(1); }
	}
}
const bytes = made.reduce((s, m) => s + m.bytes, 0);
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ made: new Date().toISOString(), source: idx.source, layers: idx.layers, minOrder: idx.minOrder, maxOrder: idx.maxOrder, extent: idx.extent, faces: made, tiles: idx.tiles.length, bytes }) + "\n");
console.log(`[hpx-pm] ${made.length} 個・${(bytes / 1e6).toFixed(1)} MB（元 ${((idx.bytes ?? 0) / 1e6).toFixed(1)} MB・${idx.tiles.length} 枚）・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
