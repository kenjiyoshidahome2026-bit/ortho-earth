// Minecraft の書き出しの検定（網を使わない）：合成の terrain.glb（写真つきの平面）と buildings.glb（赤い箱）から
//   格子・Java のワールド（region を読み戻す）・.schem・統合版の LevelDB のログを検める。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { inflateSync, gunzipSync } from "node:zlib";
import { toGlb } from "glbconv";
import { encodePng, decodePng } from "../src/png.mjs";
import { stampGlb } from "../src/export.mjs";
import { writeNbt, readNbt, byte, long, list, longArray } from "../src/minecraft/nbt.mjs";
import { PAINT, makeMatcher } from "../src/minecraft/palette.mjs";
import { packSection } from "../src/minecraft/anvil.mjs";
import { crc32c } from "../src/minecraft/leveldb.mjs";
import { exportMinecraft } from "../src/minecraft/export.mjs";
import { blockAt, AIR, BLOCKS } from "../src/minecraft/voxelize.mjs";
import { writeJavaWorld } from "../src/minecraft/anvil.mjs";
import { readLevelDb } from "../src/minecraft/leveldb.mjs";
import { importMinecraft, bedrockWorld, blockInfo } from "../src/minecraft/import.mjs";
import { glbToScene, parseGlb } from "glbconv";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const ok = async (name, f) => { await f(); pass++; console.log("✓", name); };
const nameAt = (g, x, y, z) => BLOCKS[blockAt(g, x, y, z)].java;

await ok("NBT の往復（BE・LE・long・list・long の配列の速い道）", () => {
	const v = { a: byte(-3), b: 7, c: "日本", d: long(-5n), e: list("string", ["x", "y"]), f: { g: list("compound", [{ h: 1 }]) }, i: longArray(new BigInt64Array([1n, -2n, 1n << 62n])) };
	for (const le of [false, true]) {
		const r = readNbt(writeNbt(v, { name: "root", le }), { le });
		assert.equal(r.name, "root"); assert.equal(r.value.a, -3); assert.equal(r.value.b, 7); assert.equal(r.value.c, "日本"); assert.equal(r.value.d, -5n);
		assert.deepEqual(r.value.e, ["x", "y"]); assert.equal(r.value.f.g[0].h, 1); assert.deepEqual([...r.value.i], [1n, -2n, 1n << 62n]);
	}
});
await ok("CRC32C の既知の値（\"123456789\" → 0xE3069283）", () => assert.equal(crc32c(new TextEncoder().encode("123456789")), 0xe3069283));
await ok("色 → ブロック：近い色のブロックを選ぶ", () => {
	const m = makeMatcher();
	assert.equal(PAINT[m(207, 213, 214)].java, "minecraft:white_concrete");
	assert.equal(PAINT[m(140, 30, 30)].java, "minecraft:red_concrete");
	assert.equal(PAINT[m(90, 110, 45)].java, "minecraft:moss_block");
});
await ok("区画の詰め方（Java）：値は long をまたがない・5 bit なら 1 long に 12 個", () => {
	const ids = new Uint8Array(4096); for (let i = 0; i < 4096; i++) ids[i] = (i % 17) + 1;
	const blocks = Array.from({ length: 18 }, (_, i) => ({ java: `minecraft:b${i}` }));
	const { palette, data } = packSection(ids, blocks);
	assert.equal(palette.v.length, 17); assert.equal(data.v.length, Math.ceil(4096 / 12));
	const longs = data.v, get = (i) => Number((BigInt.asUintN(64, longs[Math.floor(i / 12)]) >> BigInt((i % 12) * 5)) & 31n);
	for (const i of [0, 1, 11, 12, 13, 4095]) assert.equal(palette.v[get(i)].Name, `minecraft:b${(i % 17) + 1}`);
});

// ── 合成の出力フォルダ ──
const keep = process.env.ORTHO_MC_KEEP;   // 出力を残す先（Amulet などの別の読み手で開いて確かめる時）
const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), "ortho-mc-"));
fs.rmSync(path.join(dir, "area"), { recursive: true, force: true }); fs.rmSync(path.join(dir, "mc"), { recursive: true, force: true });
const from = path.join(dir, "area"), out = path.join(dir, "mc");
fs.mkdirSync(from);
// 地形：x −32..32・z −24..24（glTF の z＝南）・高さ 0。写真＝西半分が緑・東半分が灰
const tw = 16, th = 16, rgb = new Uint8Array(tw * th * 3);
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) rgb.set(x < tw / 2 ? [90, 110, 45] : [125, 125, 125], (y * tw + x) * 3);
const photo = encodePng(tw, th, rgb);
const plane = { positions: new Float32Array([-32, 0, -24, 32, 0, -24, -32, 0, 24, 32, 0, 24]), normals: null, uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), colors: null, indices: new Uint32Array([0, 2, 1, 1, 2, 3]), material: { name: "t", baseColor: [1, 1, 1, 1], doubleSided: false, image: { mime: "image/png", bytes: photo } } };
const extras = { version: 1, anchor: { lon: 139.7663, lat: 35.6812, height: 40 }, frame: "enu", heading: 0, geoid: 36.7, bbox: [139.7625, 35.6785, 139.77, 35.684] };
fs.writeFileSync(path.join(from, "terrain.glb"), stampGlb(toGlb({ rtc: null, prims: [plane], bbox: [-32, 0, -24, 32, 0, 24] }, { name: "terrain" })[0].bytes, extras));
// 建物：x 10..20・z −10..0（北側）・高さ 0..30 の赤い箱（12 面）
const box = (x0, y0, z0, x1, y1, z1) => {
	const P = [], I = [];
	const v = (x, y, z) => (P.push(x, y, z), P.length / 3 - 1);
	const quad = (a, b, c, d) => I.push(a, b, c, a, c, d);
	const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(p => v(...p));
	quad(c[0], c[1], c[2], c[3]); quad(c[5], c[4], c[7], c[6]); quad(c[4], c[0], c[3], c[7]); quad(c[1], c[5], c[6], c[2]); quad(c[3], c[2], c[6], c[7]); quad(c[4], c[5], c[1], c[0]);
	return { positions: new Float32Array(P), normals: null, uvs: null, colors: null, indices: new Uint32Array(I), material: { name: "red", baseColor: [0.27, 0.015, 0.015, 1], doubleSided: false, image: null } };
};
fs.writeFileSync(path.join(from, "buildings.glb"), stampGlb(toGlb({ rtc: null, prims: [box(10.2, 0, -9.8, 19.8, 29.8, -0.2)], bbox: [10, 0, -10, 20, 30, 0] }, { name: "b" })[0].bytes, extras));
fs.writeFileSync(path.join(from, "anchor.json"), JSON.stringify({ ...extras, source: [] }));

const r = await exportMinecraft({ from, out, name: "test", decodeImage: async (b) => decodePng(b), roofFromImagery: false });
const g = r.grid;
await ok("格子：広さ 64 × 48・錨＝ (0, 0, 0)・地面の上面は写真の色・下は土と石", () => {
	assert.equal(g.W, 64); assert.equal(g.D, 48); assert.equal(g.x0, -32); assert.equal(g.z0, -24); assert.equal(g.yOrigin, 0);
	assert.equal(nameAt(g, -20, 0, 5), "minecraft:moss_block");
	assert.equal(nameAt(g, 25, 0, 5), "minecraft:stone");
	assert.equal(nameAt(g, -20, -1, 5), "minecraft:dirt"); assert.equal(nameAt(g, -20, -4, 5), "minecraft:stone");
	assert.equal(blockAt(g, -20, 1, 5), AIR);
});
await ok("建物：外殻は赤・中は空・床は 4 m ごと・屋根は y=29", () => {
	assert.equal(nameAt(g, 10, 15, -5), "minecraft:red_concrete", "west wall");
	assert.equal(nameAt(g, 15, 15, -1), "minecraft:red_concrete", "south wall");
	assert.equal(nameAt(g, 15, 29, -5), "minecraft:red_concrete", "roof");
	assert.equal(blockAt(g, 15, 30, -5), AIR, "above roof");
	assert.equal(blockAt(g, 15, 15, -5), AIR, "inside");
	assert.equal(nameAt(g, 15, 4, -5), "minecraft:smooth_stone", "floor at 4 m");
	assert.equal(nameAt(g, 15, 8, -5), "minecraft:smooth_stone", "floor at 8 m");
	assert.equal(blockAt(g, 15, 6, -5), AIR);
	assert.deepEqual(r.spawn, [0, 1, 0]);
});

// Java の region を読み戻す
const readRegion = (file) => {
	const b = fs.readFileSync(file), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), chunks = new Map();
	for (let k = 0; k < 1024; k++) {
		const e = dv.getUint32(k * 4); if (!e) continue;
		const off = (e >>> 8) * 4096, len = dv.getUint32(off);
		assert.equal(b[off + 4], 2, "zlib");
		chunks.set(k, readNbt(new Uint8Array(inflateSync(b.subarray(off + 5, off + 4 + len)))).value);
	}
	return chunks;
};
const javaBlock = (chunks, x, y, z) => {
	const c = chunks.get(((x >> 4) & 31) + ((z >> 4) & 31) * 32); if (!c) return "minecraft:air";
	const s = c.sections.find(s => s.Y === y >> 4); if (!s) return "minecraft:air";
	const pal = s.block_states.palette; if (!s.block_states.data) return pal[0].Name;
	const bits = Math.max(4, Math.ceil(Math.log2(pal.length))), per = Math.floor(64 / bits), i = ((y & 15) * 16 + (z & 15)) * 16 + (x & 15);
	return pal[Number((BigInt.asUintN(64, s.block_states.data[Math.floor(i / per)]) >> BigInt((i % per) * bits)) & ((1n << BigInt(bits)) - 1n))].Name;
};
await ok("Java：level.dat・region（4 枚＝錨が region の角）・塊を読み戻すと同じブロック", () => {
	const w = path.join(out, "test");
	const ld = readNbt(new Uint8Array(gunzipSync(fs.readFileSync(path.join(w, "level.dat"))))).value.Data;
	assert.equal(ld.LevelName, "test"); assert.equal(ld.DataVersion, 3955); assert.equal(ld.WorldGenSettings.dimensions["minecraft:overworld"].generator.type, "minecraft:flat");
	assert.deepEqual([ld.SpawnX, ld.SpawnY, ld.SpawnZ], [0, 1, 0]);
	const regs = fs.readdirSync(path.join(w, "region")).sort();
	assert.deepEqual(regs, ["r.-1.-1.mca", "r.-1.0.mca", "r.0.-1.mca", "r.0.0.mca"]);
	const all = new Map(regs.map(f => [f, readRegion(path.join(w, "region", f))]));
	const at = (x, y, z) => javaBlock(all.get(`r.${x >> 9}.${z >> 9}.mca`), x, y, z);
	for (const [x, y, z] of [[-20, 0, 5], [25, 0, 5], [-20, -1, 5], [10, 15, -5], [15, 4, -5], [15, 15, -5], [0, 1, 0], [-32, 0, -24], [31, 0, 23]]) assert.equal(at(x, y, z), nameAt(g, x, y, z), `${x},${y},${z}`);
	const c = all.get("r.0.0.mca").get(0);
	assert.equal(c.Status, "minecraft:full"); assert.equal(c.xPos, 0); assert.equal(c.zPos, 0); assert.equal(c.yPos, -4);
	assert.ok(fs.existsSync(path.join(w, "icon.png")) && fs.existsSync(path.join(w, "ortho-earth.json")));
});
await ok(".schem（Sponge v2）：大きさ・Offset・BlockData を読み戻すと同じ", () => {
	const s = readNbt(new Uint8Array(gunzipSync(fs.readFileSync(path.join(out, "test.schem")))));
	assert.equal(s.name, "Schematic"); const v = s.value;
	assert.equal(v.Version, 2); assert.equal(v.Width, 64); assert.equal(v.Length, 48); assert.equal(v.Height, g.H);
	assert.deepEqual([...v.Offset], [-32, g.y0 - g.yOrigin, -24]);
	const inv = Object.fromEntries(Object.entries(v.Palette).map(([k, i]) => [i, k]));
	const data = []; for (let i = 0, p = 0; i < v.BlockData.length;) { let x = 0, sh = 0, b; do { b = v.BlockData[i++]; x |= (b & 127) << sh; sh += 7; } while (b & 128); data.push(x); p++; }
	assert.equal(data.length, g.W * g.D * g.H);
	for (const [x, y, z] of [[-20, 0, 5], [10, 15, -5], [15, 15, -5]]) assert.equal(inv[data[(x + 32) + (z + 24) * 64 + (y - g.y0) * 64 * 48]], nameAt(g, x, y, z));
});
// 統合版：zip を開き、LevelDB のログを読み戻す
const unzip = (b) => { const files = {}; let p = 0; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	while (dv.getUint32(p, true) === 0x04034b50) { const size = dv.getUint32(p + 18, true), nl = dv.getUint16(p + 26, true), xl = dv.getUint16(p + 28, true), name = new TextDecoder().decode(b.subarray(p + 30, p + 30 + nl)); files[name] = b.subarray(p + 30 + nl + xl, p + 30 + nl + xl + size); p += 30 + nl + xl + size; }
	return files; };
const readLog = (b) => {
	const recs = []; let cur = [];
	for (let blk = 0; blk < b.length; blk += 32768) {
		let p = blk;
		while (p + 7 <= Math.min(b.length, blk + 32768)) {
			const dv = new DataView(b.buffer, b.byteOffset + p), len = dv.getUint16(4, true), type = b[p + 6];
			if (!type) break;
			cur.push(b.subarray(p + 7, p + 7 + len)); if (type === 1 || type === 4) { recs.push(Buffer.concat(cur)); cur = []; }
			p += 7 + len;
		}
	}
	const kv = new Map();
	for (const r of recs) {
		const n = r.readUInt32LE(8); let p = 12;
		const vi = () => { let x = 0, s = 0, c; do { c = r[p++]; x += (c & 127) * 2 ** s; s += 7; } while (c & 128); return x; };
		for (let i = 0; i < n; i++) { assert.equal(r[p++], 1); const kl = vi(), k = r.subarray(p, p + kl); p += kl; const vl = vi(), v = r.subarray(p, p + vl); p += vl; kv.set(Buffer.from(k).toString("hex"), v); }
	}
	return kv;
};
await ok("統合版：.mcworld に db/・level.dat・levelname.txt・塊の鍵と区画（v9）を読み戻すと同じブロック", () => {
	const z = unzip(new Uint8Array(fs.readFileSync(path.join(out, "test.mcworld"))));
	for (const f of ["db/CURRENT", "db/MANIFEST-000002", "db/000003.log", "level.dat", "levelname.txt", "ortho-earth.json"]) assert.ok(z[f], f);
	const ld = z["level.dat"], ldv = new DataView(ld.buffer, ld.byteOffset);
	assert.equal(ldv.getInt32(0, true), 10); assert.equal(ldv.getInt32(4, true), ld.length - 8);
	const lv = readNbt(ld.subarray(8), { le: true }).value; assert.equal(lv.Generator, 2); assert.equal(lv.LevelName, "test");
	const kv = readLog(z["db/000003.log"]);
	const k = (cx, cz, tag, sy) => { const b = Buffer.alloc(sy == null ? 9 : 10); b.writeInt32LE(cx, 0); b.writeInt32LE(cz, 4); b[8] = tag; if (sy != null) b.writeInt8(sy, 9); return b.toString("hex"); };
	const block = (x, y, z_) => {
		const v = kv.get(k(x >> 4, z_ >> 4, 0x2f, y >> 4)); if (!v) return "minecraft:air";
		assert.equal(v[0], 9); assert.equal(v[1], 1); assert.equal(v.readInt8(2), y >> 4);
		const bits = v[3] >> 1, per = Math.floor(32 / bits), words = Math.ceil(4096 / per), i = ((x & 15) << 8) | ((z_ & 15) << 4) | (y & 15);
		const w = v.readUInt32LE(4 + Math.floor(i / per) * 4), j = (w >>> ((i % per) * bits)) & ((1 << bits) - 1);
		let p = 4 + words * 4; const n = v.readInt32LE(p); p += 4; const pal = [];
		for (let q = 0; q < n; q++) { const r = readNbt(v.subarray(p), { le: true }); pal.push(r.value); p += r.length; }
		return pal[j];
	};
	assert.equal(kv.get(k(0, 0, 0x2c))[0], 40);
	assert.equal(block(-20, 0, 5).name, "minecraft:moss_block");
	assert.deepEqual(block(25, 0, 5), { name: "minecraft:stone", states: { stone_type: "stone" }, version: (1 << 24) | (20 << 16) | 1 });
	assert.deepEqual(block(10, 15, -5).states, { color: "red" });
	assert.equal(block(15, 15, -5).name, "minecraft:air");
	assert.equal(block(15, 4, -5).name, "minecraft:smooth_stone");
});
// ── 取り込み（Minecraft → GLB） ──
const sceneBox = (sc) => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (const p of sc.prims) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], p.positions[i + k]); b[3 + k] = Math.max(b[3 + k], p.positions[i + k]); } return b; };
const buildingBox = [8, 1, -12, 22, 40, 2];   // 赤い箱を囲む（地面 y=0 は入れない）
for (const [label, src] of [["Java のワールド", path.join(out, "test")], ["統合版の .mcworld", path.join(out, "test.mcworld")]]) {
	await ok(`取り込み（${label}）：箱の範囲 → 錨つき GLB・赤い箱が元の場所 (10..20, 0..30, −10..0)`, async () => {
		const f = path.join(dir, `in-${label.length}.glb`);
		const r = importMinecraft({ src, out: f, box: buildingBox });
		assert.ok(r.blocks > 1000);
		const glb = new Uint8Array(fs.readFileSync(f)), { json } = parseGlb(glb);
		assert.equal(json.asset.extras.orthoEarth.anchor.lon, extras.anchor.lon);
		const sc = await glbToScene(glb, { anchor: false }), b = sceneBox(sc);
		assert.deepEqual(b.map(v => Math.round(v)), [10, 1, -10, 20, 30, 0]);   // 床の一番下は y=4・壁は 1..29（地面の段は範囲の外）
		const red = sc.prims.find(p => p.material.name === "red_concrete"); assert.ok(red, "red");
		assert.ok(red.material.baseColor[0] > 0.2 && red.material.baseColor[1] < 0.05);
	});
}
await ok("取り込み（.schem）：Offset で元の場所へ・地面も入る", async () => {
	const f = path.join(dir, "in-schem.glb");
	importMinecraft({ src: path.join(out, "test.schem"), out: f, meta: path.join(out, "ortho-earth.json") });
	const b = sceneBox(await glbToScene(new Uint8Array(fs.readFileSync(f)), { anchor: false }));
	assert.deepEqual(b.map(v => Math.round(v)), [-32, -4, -24, 32, 30, 24]);
});
await ok("取り込み（--diff）：建てた 1 ブロックだけ → 6 面・錨の座標 (3..4, 1..2, 5..6)", async () => {
	const g2 = { ...g, data: g.data.slice() }; g2.data[((1 - g.y0) * g.D + (5 - g.z0)) * g.W + (3 - g.x0)] = 1;   // (3, 1, 5) に白のコンクリート
	const w2 = path.join(dir, "built"); writeJavaWorld(g2, w2, { name: "built", spawn: [0, 1, 0] }); fs.copyFileSync(path.join(out, "ortho-earth.json"), path.join(w2, "ortho-earth.json"));
	const f = path.join(dir, "in-diff.glb"), r = importMinecraft({ src: w2, out: f, diff: path.join(out, "test") });
	assert.equal(r.blocks, 1); assert.equal(r.triangles, 12);
	const sc = await glbToScene(new Uint8Array(fs.readFileSync(f)), { anchor: false });
	assert.deepEqual(sceneBox(sc), [3, 1, 5, 4, 2, 6]); assert.equal(sc.prims[0].material.name, "white_concrete");
});
await ok("LevelDB の表（本物の LevelDB が焼いた zlib の .ldb）を読む：統合版の区画が分かる", () => {
	const world = path.join(HERE, "fixtures", "bedrock-db-world"), d = path.join(world, "db");   // Amulet（本物の LevelDB）で開いて閉じた後の db＝ログが .ldb に焼かれた物
	const kv = readLevelDb(fs.readdirSync(d).map(n => ({ name: n, bytes: new Uint8Array(fs.readFileSync(path.join(d, n))) })));
	assert.ok(kv.size > 50);
	const w = bedrockWorld(world);
	assert.equal(w.get(-20, 0, 5).name, "minecraft:moss_block"); assert.deepEqual(w.get(10, 15, -5).states, { color: "red" }); assert.equal(w.get(15, 15, -5).name, "minecraft:air");
});
await ok("ブロックの色：統合版の古い名前・今の名前・知らない名前・飾りは null", () => {
	assert.deepEqual(blockInfo({ name: "minecraft:concrete", states: { color: "red" } }).rgb, [142, 32, 32]);
	assert.deepEqual(blockInfo("minecraft:red_concrete").rgb, [142, 32, 32]);
	assert.deepEqual(blockInfo({ name: "minecraft:red_concrete", states: {} }).rgb, [142, 32, 32]);
	assert.deepEqual(blockInfo("minecraft:oak_log").rgb, [102, 81, 50]);
	assert.equal(blockInfo("minecraft:torch"), null); assert.equal(blockInfo("minecraft:air"), null);
});
if (!keep) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nPASS  ${pass}`);
