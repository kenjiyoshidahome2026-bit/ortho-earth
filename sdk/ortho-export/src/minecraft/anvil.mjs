// Java 版のワールド（docs/notes/minecraft.md §5.1）：level.dat（gzip の NBT）＋ region/r.X.Z.mca（Anvil・塊は zlib の NBT）。
//   書くのは 1.21.1（DataVersion 3955）の形。新しい版で開くとゲームが自分で上げる（DataFixer）＝古い形で書くのが一番通る。
//   外は空（void の平坦ワールド）・光は書かない（isLightOn=0＝ゲームが開く時に計算する）・高さ図も書かない（ゲームが作る）。
import fs from "node:fs";
import path from "node:path";
import { deflateSync, gzipSync } from "node:zlib";
import { writeNbt, byte, long, list, longArray, int } from "./nbt.mjs";
import { AIR } from "./voxelize.mjs";

export const JAVA = { dataVersion: 3955, name: "1.21.1" };

/** 1 区画（16³）の block_states：palette と詰めた long の列（1.16 以降＝値は long をまたがない・順は y,z,x） */
export function packSection(ids, blocks) {
	const local = [], map = new Map(), idx = new Uint16Array(4096);
	for (let i = 0; i < 4096; i++) { const b = ids[i]; let j = map.get(b); if (j === undefined) { j = local.length; map.set(b, j); local.push(b); } idx[i] = j; }
	const palette = list("compound", local.map(b => ({ Name: blocks[b].java })));
	if (local.length === 1) return { palette };
	const bits = Math.max(4, Math.ceil(Math.log2(local.length))), per = Math.floor(64 / bits), n = Math.ceil(4096 / per);
	const w = new Uint32Array(n * 2);   // [lo, hi]＝リトルエンディアンの long
	for (let i = 0; i < 4096; i++) {
		const L = Math.floor(i / per), sh = (i % per) * bits, v = idx[i];
		if (sh >= 32) w[L * 2 + 1] |= v << (sh - 32);
		else { w[L * 2] |= v << sh; if (sh + bits > 32) w[L * 2 + 1] |= v >>> (32 - sh); }
	}
	return { palette, data: longArray(new BigInt64Array(w.buffer)) };
}

/** 格子の 1 塊（cx, cz）の NBT。全部空気なら null */
export function chunkNbt(g, cx, cz, { dataVersion = JAVA.dataVersion } = {}) {
	const sections = [], ids = new Uint8Array(4096);
	const sy0 = Math.floor(g.y0 / 16), sy1 = Math.floor((g.y0 + g.H - 1) / 16);
	for (let sy = sy0; sy <= sy1; sy++) {
		let any = false;
		for (let y = 0; y < 16; y++) {
			const Y = sy * 16 + y, yy = Y - g.y0;
			for (let z = 0; z < 16; z++) {
				const Z = cz * 16 + z - g.z0, row = (y * 16 + z) * 16;
				for (let x = 0; x < 16; x++) {
					const X = cx * 16 + x - g.x0;
					const b = yy < 0 || yy >= g.H || X < 0 || Z < 0 || X >= g.W || Z >= g.D ? AIR : g.data[(yy * g.D + Z) * g.W + X];
					ids[row + x] = b; if (b) any = true;
				}
			}
		}
		if (any) sections.push({ Y: byte(sy), block_states: packSection(ids, g.blocks), biomes: { palette: list("string", ["minecraft:plains"]) } });
	}
	if (!sections.length) return null;
	return {
		DataVersion: int(dataVersion), xPos: int(cx), zPos: int(cz), yPos: int(-4), Status: "minecraft:full", LastUpdate: long(0), InhabitedTime: long(0),
		isLightOn: byte(0), sections: list("compound", sections), block_entities: list("end", []), block_ticks: list("end", []), fluid_ticks: list("end", []),
		structures: { References: {}, starts: {} },
	};
}

/** region ファイル 1 本：chunks＝[{ cx, cz, nbt }]（cx, cz は region の中の 0..31） */
export function regionFile(chunks) {
	const head = new Uint8Array(8192), hv = new DataView(head.buffer), parts = [head];
	let sector = 2;
	const now = Math.floor(Date.now() / 1000);
	for (const { lx, lz, bytes } of chunks) {
		const z = deflateSync(bytes), len = z.length + 1, sectors = Math.ceil((len + 4) / 4096);
		if (sectors > 255) throw new Error(`chunk too large (${len} bytes)`);
		const buf = new Uint8Array(sectors * 4096), bv = new DataView(buf.buffer);
		bv.setUint32(0, len); buf[4] = 2; buf.set(z, 5);
		const k = (lx & 31) + (lz & 31) * 32;
		hv.setUint32(k * 4, (sector << 8) | sectors); hv.setUint32(4096 + k * 4, now);
		parts.push(buf); sector += sectors;
	}
	return Buffer.concat(parts);
}

/** level.dat の中身（Data） */
export function levelDat({ name, spawn, dataVersion = JAVA.dataVersion, versionName = JAVA.name, seed = 0n }) {
	const flat = { type: "minecraft:flat", settings: { biome: "minecraft:plains", features: byte(0), lakes: byte(0), layers: list("compound", [{ block: "minecraft:air", height: int(1) }]), structure_overrides: list("end", []) } };
	return {
		Data: {
			DataVersion: int(dataVersion), version: int(19133), LevelName: name, GameType: int(1), Difficulty: byte(0), hardcore: byte(0), allowCommands: byte(1), initialized: byte(1),
			LastPlayed: long(Date.now()), Time: long(6000), DayTime: long(6000), raining: byte(0), thundering: byte(0), rainTime: int(1e8), clearWeatherTime: int(1e8),
			SpawnX: int(spawn[0]), SpawnY: int(spawn[1]), SpawnZ: int(spawn[2]), SpawnAngle: { $t: 5, v: 0 },
			Version: { Id: int(dataVersion), Name: versionName, Series: "main", Snapshot: byte(0) },
			DataPacks: { Enabled: list("string", ["vanilla"]), Disabled: list("end", []) },
			GameRules: { doDaylightCycle: "false", doWeatherCycle: "false", doMobSpawning: "false", doFireTick: "false", mobGriefing: "false", spawnRadius: "0" },
			WorldGenSettings: {
				seed: long(seed), generate_features: byte(0), bonus_chest: byte(0),
				dimensions: {
					"minecraft:overworld": { type: "minecraft:overworld", generator: flat },
					"minecraft:the_nether": { type: "minecraft:the_nether", generator: { type: "minecraft:noise", settings: "minecraft:nether", biome_source: { type: "minecraft:multi_noise", preset: "minecraft:nether" } } },
					"minecraft:the_end": { type: "minecraft:the_end", generator: { type: "minecraft:noise", settings: "minecraft:end", biome_source: { type: "minecraft:the_end" } } },
				},
			},
			ServerBrands: list("string", ["ortho-earth"]), WasModded: byte(0),
		},
	};
}

/**
 * ワールドのフォルダを書く（Minecraft の saves/ に置けば開ける）。
 * @returns {{ regions: number, chunks: number, bytes: number }}
 */
export function writeJavaWorld(g, dir, { name = "ortho-earth", spawn, dataVersion = JAVA.dataVersion, versionName = JAVA.name, icon = null } = {}) {
	fs.mkdirSync(path.join(dir, "region"), { recursive: true });
	const cx0 = Math.floor(g.x0 / 16), cx1 = Math.floor((g.x0 + g.W - 1) / 16), cz0 = Math.floor(g.z0 / 16), cz1 = Math.floor((g.z0 + g.D - 1) / 16);
	const regions = new Map(); let chunks = 0, bytes = 0;
	for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
		const nbt = chunkNbt(g, cx, cz, { dataVersion }); if (!nbt) continue;
		const key = `${cx >> 5},${cz >> 5}`; if (!regions.has(key)) regions.set(key, []);
		regions.get(key).push({ lx: cx & 31, lz: cz & 31, bytes: writeNbt(nbt) }); chunks++;
	}
	for (const [key, list_] of regions) {
		const [rx, rz] = key.split(","), b = regionFile(list_);
		fs.writeFileSync(path.join(dir, "region", `r.${rx}.${rz}.mca`), b); bytes += b.length;
	}
	const ld = gzipSync(writeNbt(levelDat({ name, spawn, dataVersion, versionName })));
	fs.writeFileSync(path.join(dir, "level.dat"), ld); bytes += ld.length;
	if (icon) fs.writeFileSync(path.join(dir, "icon.png"), icon);
	return { regions: regions.size, chunks, bytes };
}
