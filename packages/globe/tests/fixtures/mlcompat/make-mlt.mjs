// MLT（MapLibre Tile）の検定試料＝vt/ の MVT（make-mvt.mjs の出力）を同じ地物の MLT へ（#88）。
// node packages/globe/tests/fixtures/mlcompat/make-mlt.mjs
// 出力：vt-mlt/{z}/{x}/{y}.mlt（XYZ・style の "encoding":"mlt" で読む）・vt-mlt.pmtiles（同じタイル・tileType 6＝ヘッダで形式が決まる）・
//       vt-mlt.json（TileJSON＝vt.json と同じ範囲・tiles だけ .mlt）。t-mlcompat?g=mlt が「同じ場所・同じ style で MVT の源と MLT の源を切り替えて同じ絵か」を見る。
// 変換は @ortho-earth/tile-formats の道具（scripts/mvt2mlt.mjs＝core の decodeMVT → @maplibre/mlt の encodeTile）。
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("@ortho-earth/tile-formats/node-hook", import.meta.url);
const { mvtToMLT, writePMTiles } = await import("@ortho-earth/tile-formats/scripts/mvt2mlt.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const tj = JSON.parse(readFileSync(join(HERE, "vt.json"), "utf8"));
const tiles = [];
for (const z of readdirSync(join(HERE, "vt"))) for (const x of readdirSync(join(HERE, "vt", z))) for (const f of readdirSync(join(HERE, "vt", z, x))) {
	const m = /^(\d+)\.pbf$/.exec(f); if (!m) continue;
	const buf = mvtToMLT(readFileSync(join(HERE, "vt", z, x, f)));
	const out = join(HERE, "vt-mlt", z, x, `${m[1]}.mlt`); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, buf);
	tiles.push({ z: +z, x: +x, y: +m[1], buf });
}
await writePMTiles(join(HERE, "vt-mlt.pmtiles"), tiles, { tileType: 6, bounds: tj.bounds, metadata: { name: "t-mlcompat-vt-mlt", vector_layers: tj.vector_layers.map(l => ({ id: l.id })) } });
writeFileSync(join(HERE, "vt-mlt.json"), JSON.stringify({ ...tj, name: "t-mlcompat-vt-mlt", attribution: "t-mlcompat fixture tiles (MLT)", tiles: ["vt-mlt/{z}/{x}/{y}.mlt"] }, null, "\t") + "\n");
console.log(`mlt tiles ${tiles.map(t => `${t.z}/${t.x}/${t.y}`).join(" ")} · ${tiles.reduce((s, t) => s + t.buf.length, 0)} B · pmtiles tileType 6`);
