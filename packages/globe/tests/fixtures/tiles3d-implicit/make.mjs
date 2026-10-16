// 3D Tiles 1.1 implicit tiling の検定試料（tests/tiles3d-implicit.mjs・t-tiles3d-implicit）を作る＝node tests/fixtures/tiles3d-implicit/make.mjs
// 東京駅の ENU の根（tiles3d と同じ）に 640m 四方の四分木。subtreeLevels 2・availableLevels 4（段 0..3）の疎な木＝子 subtree を実際に読む深さ。
//   段 0＝赤（高さ 10）・段 1＝黄（20）・段 2＝緑（30）・段 3＝青（40）。content は available なタイル全部（REPLACE）。
//   段 1：(1,0) だけ無い。段 2：(0,0)(1,0)(0,1)(1,1)(2,2)(3,3)。段 3：(0..1,0..1) と (6,6)。
// subtree の書式を散らす：根＝バイナリ＋内部 buffer（bitstream）・2.0.0＝JSON だけ（constant）・2.1.0＝外部 .bin・2.3.3＝子 1 つ・他＝バイナリ（自分だけ）。
//   tileset.json＝1.1 の implicitTiling・tileset-10.json＝1.0 の 3DTILES_implicit_tiling 拡張（同じ subtree を読む）。
import { mkdirSync, writeFileSync } from "node:fs";
import { ENU, pad8, boxGlb } from "../tiles3d-lib.mjs";

const SIZE = 640, COLORS = [[0.9, 0.1, 0.1, 1], [0.95, 0.85, 0.1, 1], [0.1, 0.8, 0.2, 1], [0.1, 0.2, 0.95, 1]];
const avail = { 0: [[0, 0]], 1: [[0, 0], [0, 1], [1, 1]], 2: [[0, 0], [1, 0], [0, 1], [1, 1], [2, 2], [3, 3]], 3: [[0, 0], [1, 0], [0, 1], [1, 1], [6, 6]] };
// 箱の glb（タイルの足元の 8 割・ENU の東 x・北 y → glTF の x・−z）
mkdirSync("content", { recursive: true }); mkdirSync("subtrees", { recursive: true });
for (const [L, list] of Object.entries(avail)) for (const [x, y] of list) {
	const s = SIZE / 2 ** L, cx = -SIZE / 2 + (x + 0.5) * s, cy = -SIZE / 2 + (y + 0.5) * s;
	writeFileSync(`content/${L}_${x}_${y}.glb`, boxGlb(s * 0.8, s * 0.8, 10 * (+L + 1), COLORS[L], cx, -cy));
}
// subtree のバイナリ（"subt"・version 1・JSON と本体の長さ uint64）
function subt(json, bin = null) {
	const J = pad8(Buffer.from(JSON.stringify(json))), B = bin ? pad8(bin, 0) : Buffer.alloc(0), h = Buffer.alloc(24);
	h.write("subt", 0); h.writeUInt32LE(1, 4); h.writeBigUInt64LE(BigInt(J.length), 8); h.writeBigUInt64LE(BigInt(B.length), 16);
	return Buffer.concat([h, J, B]);
}
const ZERO = { constant: 0 };
// 根（0.0.0）：タイル／content＝[段 0 の 1 ビット, 段 1 の 4 ビット（Morton：(0,0)(1,0)(0,1)(1,1)）]＝0b11011・子 subtree＝段 2 の 16 ビット（Morton 0,1,2,3,12,15）
writeFileSync("subtrees/0.0.0.subtree", subt({
	buffers: [{ byteLength: 3 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }, { buffer: 0, byteOffset: 1, byteLength: 2 }],
	tileAvailability: { bitstream: 0, availableCount: 4 }, contentAvailability: [{ bitstream: 0, availableCount: 4 }], childSubtreeAvailability: { bitstream: 1, availableCount: 6 },
}, Buffer.from([0b11011, 0x0f, 0x90])));
// 2.0.0：段 2 の 1＋段 3 の 4＝全部（constant 1）・JSON だけ
writeFileSync("subtrees/2.0.0.subtree", JSON.stringify({ tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }], childSubtreeAvailability: ZERO }));
// 自分だけ（段 2 の 1 ビット）
const only = { buffers: [{ byteLength: 1 }], bufferViews: [{ buffer: 0, byteLength: 1 }], tileAvailability: { bitstream: 0 }, contentAvailability: [{ bitstream: 0 }], childSubtreeAvailability: ZERO };
writeFileSync("subtrees/2.1.0.subtree", subt({ ...only, buffers: [{ uri: "2.1.0.bin", byteLength: 1 }] }));
writeFileSync("subtrees/2.1.0.bin", Buffer.from([1]));
for (const k of ["2.0.1", "2.1.1", "2.2.2"]) writeFileSync(`subtrees/${k}.subtree`, subt(only, Buffer.from([1])));
// 2.3.3：自分と段 3 の (6,6)＝局所 (0,0)＝番号 1
writeFileSync("subtrees/2.3.3.subtree", subt(only, Buffer.from([0b11])));

const root = { transform: ENU, boundingVolume: { box: [0, 0, 25, SIZE / 2, 0, 0, 0, SIZE / 2, 0, 0, 0, 25] }, geometricError: 300, refine: "REPLACE", content: { uri: "content/{level}_{x}_{y}.glb" } };
const tiling = { subdivisionScheme: "QUADTREE", subtreeLevels: 2, subtrees: { uri: "subtrees/{level}.{x}.{y}.subtree" } };
writeFileSync("tileset.json", JSON.stringify({ asset: { version: "1.1" }, geometricError: 600, root: { ...root, implicitTiling: { ...tiling, availableLevels: 4 } } }, null, 1));
writeFileSync("tileset-10.json", JSON.stringify({ asset: { version: "1.0" }, extensionsUsed: ["3DTILES_implicit_tiling"], extensionsRequired: ["3DTILES_implicit_tiling"], geometricError: 600,
	root: { ...root, extensions: { "3DTILES_implicit_tiling": { ...tiling, maximumLevel: 3 } } } }, null, 1));
console.log("ok");
