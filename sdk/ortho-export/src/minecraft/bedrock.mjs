// 統合版のワールド（.mcworld＝zip：db/・level.dat・levelname.txt・docs/notes/minecraft.md §5.3）。
//   塊の鍵＝x(i32 LE) z(i32 LE) 種(1 バイト) [区画の y(i8)]。区画＝SubChunkPrefix v9（パレットは LE の NBT {name, states, version}）。
//   ブロックの名前は 1.20.0 の形（version＝1.20.0.1）で書く＝ゲームが開く時に今の名前へ上げる（Java と同じ考え）。
import { writeNbt, int, long, byte, list } from "./nbt.mjs";
import { levelDbFiles } from "./leveldb.mjs";
import { AIR } from "./voxelize.mjs";
import { zipStore } from "glbconv";

export const BEDROCK = { blockVersion: (1 << 24) | (20 << 16) | (0 << 8) | 1, version: [1, 20, 0, 0, 0], networkVersion: 589, chunkVersion: 40 };
const TAG = { data3d: 0x2b, version: 0x2c, subchunk: 0x2f, finalized: 0x36 };

const key = (cx, cz, tag, sy) => {
	const b = new Uint8Array(sy == null ? 9 : 10), dv = new DataView(b.buffer);
	dv.setInt32(0, cx, true); dv.setInt32(4, cz, true); b[8] = tag; if (sy != null) dv.setInt8(9, sy);
	return b;
};
const BITS = [1, 2, 3, 4, 5, 6, 8, 16];

/** 区画（16³）の値：ids は Bedrock の順（x·256 + z·16 + y） */
export function subchunkValue(ids, blocks, sy, blockVersion = BEDROCK.blockVersion, cache = new Map()) {
	const local = [], map = new Map(), idx = new Uint16Array(4096);
	for (let i = 0; i < 4096; i++) { const b = ids[i]; let j = map.get(b); if (j === undefined) { j = local.length; map.set(b, j); local.push(b); } idx[i] = j; }
	const bits = BITS.find(b => (1 << b) >= local.length), per = Math.floor(32 / bits), words = Math.ceil(4096 / per);
	const w = new Uint32Array(words);
	for (let i = 0; i < 4096; i++) w[Math.floor(i / per)] |= idx[i] << ((i % per) * bits);
	const pal = local.map(b => { let n = cache.get(b); if (!n) { const { name, states } = blocks[b].bedrock; cache.set(b, n = writeNbt({ name, states: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, typeof v === "number" ? int(v) : v])), version: int(blockVersion) }, { le: true })); } return n; });
	const size = 3 + 1 + words * 4 + 4 + pal.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(size), dv = new DataView(out.buffer); let o = 0;
	out[o++] = 9; out[o++] = 1; dv.setInt8(o++, sy);
	out[o++] = bits << 1;
	new Uint8Array(out.buffer, o, words * 4).set(new Uint8Array(w.buffer)); o += words * 4;   // 機械はリトルエンディアン
	dv.setInt32(o, local.length, true); o += 4;
	for (const p of pal) { out.set(p, o); o += p.length; }
	return out;
}

/** Data3D：高さ図（256 × i16・x + z·16・最下段からの数）＋区画ごとの生物群系（平原＝1・2 段目から「下と同じ」） */
function data3d(heights) {
	const out = new Uint8Array(512 + 5 + 23), dv = new DataView(out.buffer);
	for (let i = 0; i < 256; i++) dv.setInt16(i * 2, heights[i], true);
	out[512] = 1; dv.setInt32(513, 1, true);   // bits 0（1 種類）＋ 値
	out.fill(0xff, 517);
	return out;
}

/** 格子 → LevelDB の [key, value] の列 */
export function* bedrockEntries(g, { blockVersion = BEDROCK.blockVersion } = {}) {
	const cx0 = Math.floor(g.x0 / 16), cx1 = Math.floor((g.x0 + g.W - 1) / 16), cz0 = Math.floor(g.z0 / 16), cz1 = Math.floor((g.z0 + g.D - 1) / 16);
	const sy0 = Math.floor(g.y0 / 16), sy1 = Math.floor((g.y0 + g.H - 1) / 16), ids = new Uint8Array(4096), cache = new Map();
	const fin = new Uint8Array(4); new DataView(fin.buffer).setInt32(0, 2, true);
	for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
		const subs = [], heights = new Int16Array(256);
		for (let sy = sy0; sy <= sy1; sy++) {
			let any = false;
			for (let x = 0; x < 16; x++) {
				const X = cx * 16 + x - g.x0;
				for (let z = 0; z < 16; z++) {
					const Z = cz * 16 + z - g.z0;
					for (let y = 0; y < 16; y++) {
						const yy = sy * 16 + y - g.y0;
						const b = yy < 0 || yy >= g.H || X < 0 || Z < 0 || X >= g.W || Z >= g.D ? AIR : g.data[(yy * g.D + Z) * g.W + X];
						ids[(x << 8) | (z << 4) | y] = b;
						if (b) { any = true; heights[z * 16 + x] = sy * 16 + y + 1 + 64; }
					}
				}
			}
			if (any) subs.push([key(cx, cz, TAG.subchunk, sy), subchunkValue(ids, g.blocks, sy, blockVersion, cache)]);
		}
		if (!subs.length) continue;
		yield [key(cx, cz, TAG.version), Uint8Array.of(BEDROCK.chunkVersion)];
		yield* subs;
		yield [key(cx, cz, TAG.data3d), data3d(heights)];
		yield [key(cx, cz, TAG.finalized), fin];
	}
}

/** level.dat（統合版）：i32 の版＋i32 の長さ＋LE の NBT */
export function bedrockLevelDat({ name, spawn, seed = 0n }) {
	const flat = JSON.stringify({ biome_id: 1, block_layers: [{ block_name: "minecraft:air", count: 1 }], encoding_version: 6, structure_options: null, world_version: "version.post_1_18" });
	const nbt = writeNbt({
		LevelName: name, StorageVersion: int(10), NetworkVersion: int(BEDROCK.networkVersion), Generator: int(2), FlatWorldLayers: flat, RandomSeed: long(seed),
		GameType: int(1), Difficulty: int(0), ForceGameType: byte(0), SpawnX: int(spawn[0]), SpawnY: int(spawn[1]), SpawnZ: int(spawn[2]),
		lastOpenedWithVersion: list("int", BEDROCK.version.map(int)), MinimumCompatibleClientVersion: list("int", BEDROCK.version.map(int)),
		LastPlayed: long(Math.floor(Date.now() / 1000)), Time: long(6000), currentTick: long(0), commandsEnabled: byte(1), hasBeenLoadedInCreative: byte(1),
		dodaylightcycle: byte(0), doweathercycle: byte(0), domobspawning: byte(0), dofiretick: byte(0), mobgriefing: byte(0), showcoordinates: byte(1), spawnMobs: byte(0),
		Platform: int(2), isHardcore: byte(0), spawnradius: int(0),
	}, { le: true });
	const out = new Uint8Array(8 + nbt.length), dv = new DataView(out.buffer);
	dv.setInt32(0, 10, true); dv.setInt32(4, nbt.length, true); out.set(nbt, 8);
	return out;
}

/** .mcworld（zip の中身＝ワールドのフォルダ） */
export function writeMcworld(g, { name = "ortho-earth", spawn, extra = [] } = {}) {
	const db = levelDbFiles(bedrockEntries(g));
	const files = [
		...db.map(f => ({ name: `db/${f.name}`, bytes: f.bytes })),
		{ name: "level.dat", bytes: bedrockLevelDat({ name, spawn }) },
		{ name: "levelname.txt", bytes: new TextEncoder().encode(name) },
		...extra,
	];
	return { bytes: zipStore(files), db: db.find(f => f.name.endsWith(".log")).bytes.length };
}
