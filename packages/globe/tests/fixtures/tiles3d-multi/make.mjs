// 3D Tiles の複数 content（1.1 の contents・1.0 の 3DTILES_multiple_contents）の検定試料（tests/tiles3d-implicit.mjs・t-tiles3d-multi）を作る＝node tests/fixtures/tiles3d-multi/make.mjs
// 東京駅の ENU の根（tiles3d と同じ）に 640m 四方の四分木 2 段（段 0＝根・段 1＝4 枚）。タイルごとに content 2 個：
//   a＝橙の箱（タイルの西半分・高さ 10／20）・b＝青の箱（東半分・高さ 15／30）。段 1 の (1,1) だけ b が無い＝出すのは a 4＋b 3＝7 個。
// tileset.json＝1.1 の明示的な木（contents・content ごとの metadata と group・(1,1) は content 1 個）。
// tileset-implicit.json＝1.1 の implicit（content ごとのテンプレート・subtree の contentAvailability 2 本・contentMetadata 2 本）。
// tileset-10.json／tileset-implicit-10.json＝1.0 の 3DTILES_multiple_contents 拡張（implicit は subtree の拡張の contentAvailability・metadata は読まない）。
import { mkdirSync, writeFileSync } from "node:fs";
import { ENU, boxGlb, subt } from "../tiles3d-lib.mjs";

const SIZE = 640, ORANGE = [1, 0.5, 0, 1], BLUE = [0.1, 0.2, 0.95, 1];
const tiles = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1]], hasB = (L, x, y) => !(L === 1 && x === 1 && y === 1);
mkdirSync("a", { recursive: true }); mkdirSync("b", { recursive: true }); mkdirSync("subtrees", { recursive: true }); mkdirSync("subtrees10", { recursive: true });
for (const [L, x, y] of tiles) {
	const s = SIZE / 2 ** L, cx = -SIZE / 2 + (x + 0.5) * s, cy = -SIZE / 2 + (y + 0.5) * s;   // ENU の東 x・北 y → glTF の x・−z
	writeFileSync(`a/${L}_${x}_${y}.glb`, boxGlb(s * 0.4, s * 0.8, 10 * (L + 1), ORANGE, cx - s / 4, -cy));
	if (hasB(L, x, y)) writeFileSync(`b/${L}_${x}_${y}.glb`, boxGlb(s * 0.4, s * 0.8, 15 * (L + 1), BLUE, cx + s / 4, -cy));
}
const boxOf = (L, x, y) => { const s = SIZE / 2 ** L; return [-SIZE / 2 + (x + 0.5) * s, -SIZE / 2 + (y + 0.5) * s, 25, s / 2, 0, 0, 0, s / 2, 0, 0, 0, 25]; };
const schema = { id: "multiFixture", classes: { content: { properties: { name: { type: "STRING" } } }, layer: { properties: { name: { type: "STRING" } } } } };
const content = (k, L, x, y, meta) => ({ uri: `${k}/${L}_${x}_${y}.glb`, ...(meta ? { group: k === "a" ? 0 : 1, metadata: { class: "content", properties: { name: `${k}${L}/${x}/${y}` } } } : {}) });
const contentsOf = (L, x, y, meta) => hasB(L, x, y) ? [content("a", L, x, y, meta), content("b", L, x, y, meta)] : [content("a", L, x, y, meta)];
// 明示的な木（1.1）：(1,1) は content 1 個（contents でなく content）
const tile11 = (L, x, y) => ({ boundingVolume: { box: boxOf(L, x, y) }, geometricError: L ? 0 : 300, ...(hasB(L, x, y) ? { contents: contentsOf(L, x, y, true) } : { content: content("a", L, x, y, true) }) });
const kids = tiles.slice(1);
writeFileSync("tileset.json", JSON.stringify({ asset: { version: "1.1" }, schema, groups: [{ class: "layer", properties: { name: "west" } }, { class: "layer", properties: { name: "east" } }], geometricError: 600,
	root: { ...tile11(0, 0, 0), transform: ENU, refine: "REPLACE", children: kids.map(([L, x, y]) => tile11(L, x, y)) } }, null, 1));
const tile10 = (L, x, y) => ({ boundingVolume: { box: boxOf(L, x, y) }, geometricError: L ? 0 : 300, extensions: { "3DTILES_multiple_contents": { content: contentsOf(L, x, y, false) } } });
writeFileSync("tileset-10.json", JSON.stringify({ asset: { version: "1.0" }, extensionsUsed: ["3DTILES_multiple_contents"], extensionsRequired: ["3DTILES_multiple_contents"], geometricError: 600,
	root: { ...tile10(0, 0, 0), transform: ENU, refine: "REPLACE", children: kids.map(([L, x, y]) => tile10(L, x, y)) } }, null, 1));
// implicit：subtree 1 個（段 0..1）。b の availability＝[段 0, 段 1 の Morton (0,0)(1,0)(0,1)(1,1)]＝0b01111
//   property table（行＝content ごとに available の順）：a＝5 行・b＝4 行
{
	const views = [], parts = [];
	let off = 0;
	const put = (buf, align = 1) => { const pad = (align - off % align) % align; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; } views.push({ buffer: 0, byteOffset: off, byteLength: buf.length }); parts.push(buf); off += buf.length; return views.length - 1; };
	const strs = list => { const b = Buffer.from(list.join("")), o = new Uint32Array(list.length + 1); list.forEach((x, i) => { o[i + 1] = o[i] + Buffer.byteLength(x); }); return [b, Buffer.from(o.buffer)]; };
	const bBits = put(Buffer.from([0b01111]));
	const table = names => { const [b, o] = strs(names), so = put(o, 4), v = put(b); return { class: "content", count: names.length, properties: { name: { values: v, stringOffsets: so } } }; };
	const ta = table(["a0/0/0", "a1/0/0", "a1/1/0", "a1/0/1", "a1/1/1"]), tb = table(["b0/0/0", "b1/0/0", "b1/1/0", "b1/0/1"]);
	const bin = Buffer.concat(parts);
	writeFileSync("subtrees/0.0.0.subtree", subt({ buffers: [{ byteLength: bin.length }], bufferViews: views,
		tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }, { bitstream: bBits, availableCount: 4 }], childSubtreeAvailability: { constant: 0 },
		propertyTables: [ta, tb], contentMetadata: [0, 1] }, bin));
	writeFileSync("subtrees10/0.0.0.subtree", subt({ buffers: [{ byteLength: 1 }], bufferViews: [{ buffer: 0, byteLength: 1 }],
		tileAvailability: { constant: 1 }, childSubtreeAvailability: { constant: 0 }, extensions: { "3DTILES_multiple_contents": { contentAvailability: [{ constant: 1 }, { bufferView: 0 }] } } }, Buffer.from([0b01111])));
}
const imp = { transform: ENU, boundingVolume: { box: boxOf(0, 0, 0) }, geometricError: 300, refine: "REPLACE" }, tiling = { subdivisionScheme: "QUADTREE", subtreeLevels: 2 };
const templates = meta => ["a", "b"].map((k, i) => ({ uri: `${k}/{level}_{x}_{y}.glb`, ...(meta ? { group: i } : {}) }));
writeFileSync("tileset-implicit.json", JSON.stringify({ asset: { version: "1.1" }, schema, groups: [{ class: "layer", properties: { name: "west" } }, { class: "layer", properties: { name: "east" } }], geometricError: 600,
	root: { ...imp, contents: templates(true), implicitTiling: { ...tiling, availableLevels: 2, subtrees: { uri: "subtrees/{level}.{x}.{y}.subtree" } } } }, null, 1));
writeFileSync("tileset-implicit-10.json", JSON.stringify({ asset: { version: "1.0" }, extensionsUsed: ["3DTILES_implicit_tiling", "3DTILES_multiple_contents"], extensionsRequired: ["3DTILES_implicit_tiling", "3DTILES_multiple_contents"], geometricError: 600,
	root: { ...imp, extensions: { "3DTILES_implicit_tiling": { ...tiling, maximumLevel: 1, subtrees: { uri: "subtrees10/{level}.{x}.{y}.subtree" } }, "3DTILES_multiple_contents": { content: templates(false) } } } }, null, 1));
console.log("ok");
