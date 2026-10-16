// 3D Tiles 1.1 implicit tiling（subtree）の純関数の検定（node・網なし・fixtures/tiles3d-implicit＝make.mjs で生成）。
// 並び（Morton・段の始まり・ビットの順）・subtree の各書式（バイナリ／JSON／外部 buffer／constant／1.0 拡張の bufferView）・境界体積の分割・URI テンプレート・
// 試料の木を subtree を辿って数え上げ、作った時の available の表と一致するか。
import { readFileSync, existsSync } from "node:fs";
import { implicitOf, levelOffset, morton, childCoord, indexIn, childSubtreeIndex, isAvailable, rankOf, expandUri, geometricErrorAt, volumeAt, parseSubtree } from "../src/tiles3d-implicit.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const throws = async (f, re) => { try { await f(); return false; } catch (e) { return re.test(e.message); } };
const near = (a, b, tol = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const dir = new URL("./fixtures/tiles3d-implicit/", import.meta.url);
const ab = f => { const b = readFileSync(new URL(f, dir)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// ── implicitOf
const ts = JSON.parse(readFileSync(new URL("tileset.json", dir), "utf8")), ts10 = JSON.parse(readFileSync(new URL("tileset-10.json", dir), "utf8"));
const T = implicitOf(ts.root), T10 = implicitOf(ts10.root);
ok("implicitOf 1.1", T.n === 4 && T.subtreeLevels === 2 && T.availableLevels === 4 && T.subtreeUri === "subtrees/{level}.{x}.{y}.subtree");
ok("implicitOf 1.0 拡張（maximumLevel＋1）", JSON.stringify(T10) === JSON.stringify(T));
ok("implicitOf 無し＝null", implicitOf({ content: { uri: "a.glb" } }) === null && implicitOf(null) === null);
ok("implicitOf 八分木", implicitOf({ implicitTiling: { subdivisionScheme: "OCTREE", subtreeLevels: 3, availableLevels: 6, subtrees: { uri: "s" } } }).n === 8);
ok("implicitOf 崩れ＝例外", await throws(() => implicitOf({ implicitTiling: { subdivisionScheme: "BINARY", subtreeLevels: 2, availableLevels: 2, subtrees: { uri: "s" } } }), /subdivisionScheme/)
	&& await throws(() => implicitOf({ implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 0, availableLevels: 2, subtrees: { uri: "s" } } }), /subtreeLevels/)
	&& await throws(() => implicitOf({ implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2, subtrees: { uri: "s" } } }), /availableLevels/)
	&& await throws(() => implicitOf({ implicitTiling: { subdivisionScheme: "QUADTREE", subtreeLevels: 2, availableLevels: 2 } }), /subtrees/));

// ── 並び（仕様の図：四分木の段 2 で (2,2)＝12・(3,3)＝15、八分木の (1,1,1)＝7）
ok("levelOffset", [0, 1, 2, 3].map(l => levelOffset(4, l)).join() === "0,1,5,21" && [0, 1, 2].map(l => levelOffset(8, l)).join() === "0,1,9");
ok("morton 2D", morton(0, 0) === 0 && morton(1, 0) === 1 && morton(0, 1) === 2 && morton(2, 2) === 12 && morton(3, 3) === 15 && morton(5, 3) === 0b011011);
ok("morton 3D", morton(1, 1, 1) === 7 && morton(0, 0, 1) === 4 && morton(2, 0, 0) === 8);
ok("morton 大きな座標（2^20）", morton(2 ** 20, 0) === 2 ** 40 && morton(0, 2 ** 20) === 2 ** 41);
ok("childCoord", JSON.stringify(childCoord({ level: 1, x: 1, y: 0 }, 3)) === JSON.stringify({ level: 2, x: 3, y: 1 })
	&& JSON.stringify(childCoord({ level: 0, x: 0, y: 0, z: 0 }, 5)) === JSON.stringify({ level: 1, x: 1, y: 0, z: 1 }));
ok("indexIn", indexIn({ level: 0, x: 0, y: 0 }, { level: 1, x: 1, y: 1 }, 4) === 4 && indexIn({ level: 2, x: 3, y: 3 }, { level: 3, x: 6, y: 6 }, 4) === 1 && indexIn({ level: 2, x: 3, y: 3 }, { level: 3, x: 7, y: 7 }, 4) === 4);
ok("childSubtreeIndex", childSubtreeIndex({ level: 0, x: 0, y: 0 }, { level: 2, x: 2, y: 2 }, 4) === 12 && childSubtreeIndex({ level: 2, x: 1, y: 0 }, { level: 4, x: 5, y: 0 }, 4) === 1);

// ── ビット（下位から）と順位
const av = { constant: null, bits: new Uint8Array([0b11011, 0b10000001]), count: null };
ok("isAvailable", [0, 1, 2, 3, 4, 8, 9, 15].map(i => +isAvailable(av, i)).join("") === "11011101");
ok("rankOf", [0, 1, 3, 4, 8, 15].map(i => rankOf(av, i)).join() === "0,1,2,3,4,5");
ok("constant", isAvailable({ constant: 1, bits: null }, 99) && !isAvailable({ constant: 0, bits: null }, 0) && rankOf({ constant: 1, bits: null }, 7) === 7);

// ── テンプレート・誤差
ok("expandUri", expandUri("t/{level}/{x}/{y}/{z}.glb", { level: 3, x: 5, y: 2, z: 1 }) === "t/3/5/2/1.glb" && expandUri("{level}_{x}_{y}{w}", { level: 1, x: 0, y: 1 }) === "1_0_1{w}");
ok("geometricErrorAt", geometricErrorAt(300, 0) === 300 && geometricErrorAt(300, 3) === 37.5);

// ── 境界体積の分割
const B = { box: [10, 20, 30, 8, 0, 0, 0, 4, 0, 0, 0, 2] };
ok("box 四分木＝z は割らない", near(volumeAt(B, { level: 1, x: 1, y: 0 }, 4).box, [14, 18, 30, 4, 0, 0, 0, 2, 0, 0, 0, 2]));
ok("box 八分木", near(volumeAt(B, { level: 1, x: 0, y: 1, z: 1 }, 8).box, [6, 22, 31, 4, 0, 0, 0, 2, 0, 0, 0, 1]));
ok("box 段 0＝そのまま", near(volumeAt(B, { level: 0, x: 0, y: 0 }, 4).box, B.box));
const rot = { box: [0, 0, 0, 0, 4, 0, -4, 0, 0, 0, 0, 1] };   // 半軸が回った box（u＝+y・v＝−x）
ok("box 回った半軸", near(volumeAt(rot, { level: 1, x: 1, y: 1 }, 4).box, [-2, 2, 0, 0, 2, 0, -2, 0, 0, 0, 0, 1]));
const R = { region: [-1, -0.5, 1, 0.5, 0, 100] };
ok("region 四分木＝高さは割らない", near(volumeAt(R, { level: 1, x: 1, y: 0 }, 4).region, [0, -0.5, 1, 0, 0, 100]));
ok("region 八分木", near(volumeAt(R, { level: 1, x: 0, y: 1, z: 1 }, 8).region, [-1, 0, 0, 0.5, 50, 100]));
const AM = { region: [3, 0, -3, 0.2, 0, 0] };   // 日付変更線を跨ぐ（w > e）＝幅 2π−6
ok("region 日付変更線", near(volumeAt(AM, { level: 2, x: 3, y: 0 }, 4).region, [3 + (2 * Math.PI - 6) * 3 / 4 - 2 * Math.PI, 0, -3, 0.05, 0, 0], 1e-12)
	&& near(volumeAt(AM, { level: 1, x: 0, y: 0 }, 4).region, [3, 0, Math.PI, 0.1, 0, 0], 1e-12));
ok("sphere＝null", volumeAt({ sphere: [0, 0, 0, 1] }, { level: 0, x: 0, y: 0 }, 4) === null);

// ── subtree の書式
const loadBuf = rel => uri => Promise.resolve(ab(new URL(uri, new URL(rel, dir)).href));
const st0 = await parseSubtree(ab("subtrees/0.0.0.subtree"), T);
ok("バイナリ＋内部 buffer", st0.tile.bits?.[0] === 0b11011 && st0.content.length === 1 && st0.content[0].bits === st0.tile.bits && st0.child.bits?.length === 2 && st0.child.count === 6);
const stJ = await parseSubtree(ab("subtrees/2.0.0.subtree"), T);
ok("JSON だけ＋constant", stJ.tile.constant === 1 && stJ.tile.count === 5 && stJ.content[0].constant === 1 && stJ.child.constant === 0 && stJ.child.count === 0);
ok("外部 buffer に loadBuffer が無い＝例外", await throws(() => parseSubtree(ab("subtrees/2.1.0.subtree"), T), /2\.1\.0\.bin/));
const stX = await parseSubtree(ab("subtrees/2.1.0.subtree"), T, loadBuf("subtrees/2.1.0.subtree"));
ok("外部 buffer", stX.tile.bits?.[0] === 1 && isAvailable(stX.tile, 0) && !isAvailable(stX.tile, 1));
const legacy = { buffers: [{ uri: "x.bin", byteLength: 2 }], bufferViews: [{ buffer: 0, byteLength: 1 }, { buffer: 0, byteOffset: 1, byteLength: 1 }],
	tileAvailability: { bufferView: 0 }, contentAvailability: { bufferView: 1 }, childSubtreeAvailability: { constant: 0 } };   // 1.0 拡張＝bufferView・contentAvailability が 1 個のオブジェクト
const stL = await parseSubtree(legacy, { ...T, subtreeLevels: 1 }, () => Promise.resolve(new Uint8Array([1, 0]).buffer));
ok("1.0 拡張の bufferView", isAvailable(stL.tile, 0) && stL.content.length === 1 && !isAvailable(stL.content[0], 0));
ok("content 無し＝contentAvailability を省く", (await parseSubtree({ tileAvailability: { constant: 1 }, childSubtreeAvailability: { constant: 0 } }, T)).content.length === 0);
const hdr = (ver, jl, bl, total) => { const b = new ArrayBuffer(total), dv = new DataView(b); new Uint8Array(b).set([0x73, 0x75, 0x62, 0x74]); dv.setUint32(4, ver, true); dv.setBigUint64(8, BigInt(jl), true); dv.setBigUint64(16, BigInt(bl), true); return b; };
ok("version 2＝例外", await throws(() => parseSubtree(hdr(2, 0, 0, 24), T), /version 2/));
ok("切れた＝例外", await throws(() => parseSubtree(hdr(1, 100, 0, 40), T), /truncated/));
ok("ビット列が短い＝例外", await throws(() => parseSubtree({ buffers: [{ byteLength: 1 }], bufferViews: [{ buffer: 0, byteLength: 1 }], tileAvailability: { constant: 1 }, childSubtreeAvailability: { bitstream: 0 } }, T, null), /no binary chunk/)
	&& await throws(() => parseSubtree({ buffers: [{ uri: "a", byteLength: 1 }], bufferViews: [{ buffer: 0, byteLength: 1 }], tileAvailability: { constant: 1 }, childSubtreeAvailability: { bitstream: 0 } }, T, () => Promise.resolve(new ArrayBuffer(1))), /too short/));
ok("bufferView が範囲外＝例外", await throws(() => parseSubtree({ buffers: [{ uri: "a", byteLength: 1 }], bufferViews: [{ buffer: 0, byteOffset: 1, byteLength: 1 }], tileAvailability: { bitstream: 0 }, childSubtreeAvailability: { constant: 0 } }, T, () => Promise.resolve(new ArrayBuffer(1))), /out of range/));
ok("availability 欠け＝例外", await throws(() => parseSubtree({ childSubtreeAvailability: { constant: 0 } }, T), /tileAvailability missing/));

// ── 試料の木を辿る（tiles3d.ts の歩きと同じ順：subtree の中は子をビットで、最下段の下は子 subtree）
const want = { 0: ["0,0"], 1: ["0,0", "0,1", "1,1"], 2: ["0,0", "1,0", "0,1", "1,1", "2,2", "3,3"], 3: ["0,0", "1,0", "0,1", "1,1", "6,6"] };
const seen = { 0: [], 1: [], 2: [], 3: [] }, uris = [];
let subtrees = 0;
async function walkSubtree(r) {
	const rel = expandUri(T.subtreeUri, r), st = await parseSubtree(ab(rel), T, loadBuf(rel)); subtrees++;
	const visit = async c => {
		if (c.level - r.level === T.subtreeLevels) { if (c.level < T.availableLevels && isAvailable(st.child, childSubtreeIndex(r, c, T.n))) await walkSubtree(c); return; }
		const i = indexIn(r, c, T.n);
		if (!isAvailable(st.tile, i)) return;
		seen[c.level].push(`${c.x},${c.y}`);
		if (isAvailable(st.content[0], i)) uris.push(expandUri(ts.root.content.uri, c));
		for (let k = 0; k < T.n; k++) await visit(childCoord(c, k));
	};
	await visit(r);
}
await walkSubtree({ level: 0, x: 0, y: 0 });
ok("試料の木＝作った表どおり", Object.keys(want).every(L => [...seen[L]].sort().join(" ") === [...want[L]].sort().join(" ")), JSON.stringify(seen));
ok("試料の subtree＝7 個", subtrees === 7);
ok("content の URI＝全部ファイルがある", uris.length === 15 && uris.every(u => existsSync(new URL(u, dir))), `${uris.length}`);
const bv33 = volumeAt(ts.root.boundingVolume, { level: 3, x: 6, y: 6 }, 4).box;
ok("段 3 (6,6) の箱（中心 東 200・北 200・半辺 40）", near(bv33, [200, 200, 25, 40, 0, 0, 0, 40, 0, 0, 0, 25]));

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ tiles3d-implicit 全 PASS");
process.exit(fail ? 1 : 0);
