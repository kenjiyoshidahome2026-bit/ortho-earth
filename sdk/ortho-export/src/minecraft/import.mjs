// Minecraft → ortho-earth（docs/notes/minecraft.md §6）：ワールド（Java の region・統合版の db）か .schem の範囲のブロックを
//   見えている面だけの箱のメッシュにして、錨つきの GLB（asset.extras.orthoEarth）に焼く。錨とブロックの対応は書き出しの ortho-earth.json。
//   GLB の頂点＝錨の glTF 座標 (E, U, −N)＝(x·scale, (y − yOrigin)·scale, z·scale)＝Unity・Unreal の戻りと同じ取り込み口に載る。
import fs from "node:fs";
import path from "node:path";
import { inflateSync, inflateRawSync, gunzipSync } from "node:zlib";
import { toGlb } from "glbconv";
import { readNbt } from "./nbt.mjs";
import { readLevelDb } from "./leveldb.mjs";
import { PAINT, SPECIAL } from "./palette.mjs";
import { stampGlb, VERSION } from "../export.mjs";

const AIRS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:structure_void", "minecraft:light", "minecraft:light_block", "minecraft:barrier"]);
/** 箱にしない物（細い・平たい・透けた飾り） */
const SKIP = /torch|flower|sapling|short_grass|tall_grass|fern|button|pressure_plate|sign|rail|lever|vine|ladder|redstone_wire|tripwire|banner|candle|lantern|chain|_bars|pane$|carpet|snow_layer|kelp|seagrass|bush|dandelion|poppy|tulip|orchid|allium|bluet|daisy|cornflower|lily|rose|peony|lilac|sunflower|mushroom$|cobweb|head$|skull/;
const FALLBACK = [
	[/glass/, [175, 213, 219]], [/water/, [63, 118, 228]], [/lava/, [207, 92, 15]], [/leaves/, [72, 120, 40]], [/grass_block|^minecraft:grass$/, [124, 189, 107]],
	[/_log|_wood|stem|hyphae/, [102, 81, 50]], [/planks|slab|stairs|fence|door/, [162, 130, 78]], [/sand/, [219, 207, 163]], [/gravel/, [131, 127, 126]],
	[/iron/, [220, 220, 220]], [/gold/, [246, 208, 61]], [/diamond/, [98, 237, 228]], [/emerald/, [42, 203, 87]], [/lapis/, [30, 67, 140]], [/redstone/, [175, 24, 5]],
	[/glowstone|lamp|shroomlight|sea_lantern/, [250, 220, 160]], [/brick/, [150, 97, 83]], [/deepslate/, [80, 80, 82]], [/blackstone/, [42, 36, 41]], [/basalt/, [80, 81, 86]],
	[/netherrack|nether/, [97, 38, 38]], [/end_stone|purpur/, [219, 222, 158]], [/wool|concrete|terracotta/, [200, 200, 200]], [/ice/, [145, 183, 253]], [/obsidian/, [15, 10, 24]],
	[/copper/, [192, 107, 79]], [/quartz/, [235, 229, 222]], [/stone|ore|cobble|andesite|diorite|granite|tuff|calcite/, [125, 125, 125]], [/dirt|mud|podzol|mycelium|farmland|path/, [134, 96, 67]],
];
const byJava = new Map([...PAINT, SPECIAL.grass].map(b => [b.java, b.rgb]));
const byBedrock = new Map([...PAINT, SPECIAL.grass].map(b => [`${b.bedrock.name}|${JSON.stringify(b.bedrock.states)}`, b]));

/** ブロックの名前（Java＝"minecraft:x"・統合版＝{ name, states }）→ { key, name, rgb } か null（空気・飾り） */
export function blockInfo(b) {
	const name = typeof b === "string" ? b : b.name;
	if (AIRS.has(name) || SKIP.test(name)) return null;
	if (typeof b === "string" && (name === "minecraft:snow" || name === "minecraft:grass")) return null;   // Java の snow＝積もった雪・grass＝1.20.3 より前の草（統合版では同じ名前が塊）
	const key = typeof b === "string" ? name : `${name}|${JSON.stringify(b.states || {})}`;
	let rgb = byJava.get(name), label = name;
	if (!rgb && typeof b !== "string") { const m = byBedrock.get(`${name}|${JSON.stringify(Object.fromEntries(Object.entries(b.states || {}).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])))}`); if (m) { rgb = m.rgb; label = m.java; } }   // 統合版の古い名前＝Java の名前で呼ぶ
	if (!rgb) rgb = (FALLBACK.find(([re]) => re.test(name)) || [, [128, 128, 128]])[1];
	return { key, name: label, rgb };
}

// ── 読み手：どれも get(x, y, z) → 名前（か null＝空気・塊が無い） ──

/** Java のワールドのフォルダ（region/r.X.Z.mca・1.18 以降の塊） */
export function javaWorld(dir) {
	const regions = new Map(), chunks = new Map();
	const region = (rx, rz) => { const k = `${rx},${rz}`; if (!regions.has(k)) { const f = path.join(dir, "region", `r.${rx}.${rz}.mca`); regions.set(k, fs.existsSync(f) ? fs.readFileSync(f) : null); } return regions.get(k); };
	const chunk = (cx, cz) => {
		const k = `${cx},${cz}`; if (chunks.has(k)) return chunks.get(k);
		let out = null; const b = region(cx >> 5, cz >> 5);
		if (b) {
			const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), e = dv.getUint32(((cx & 31) + (cz & 31) * 32) * 4);
			if (e) {
				const off = (e >>> 8) * 4096, len = dv.getUint32(off), comp = b[off + 4], body = b.subarray(off + 5, off + 4 + len);
				const nbt = readNbt(new Uint8Array(comp === 1 ? gunzipSync(body) : comp === 2 ? inflateSync(body) : body)).value;
				const secs = new Map();
				for (const s of nbt.sections || nbt.Level?.Sections || []) {
					const bs = s.block_states; if (!bs) continue;
					const pal = bs.palette.map(p => p.Name);
					if (!bs.data) { secs.set(s.Y, { pal, get: () => 0 }); continue; }
					const bits = Math.max(4, Math.ceil(Math.log2(pal.length))), per = Math.floor(64 / bits), data = bs.data, m = (1n << BigInt(bits)) - 1n;
					secs.set(s.Y, { pal, get: (i) => Number((BigInt.asUintN(64, data[Math.floor(i / per)]) >> BigInt((i % per) * bits)) & m) });
				}
				out = secs;
			}
		}
		chunks.set(k, out); return out;
	};
	return { kind: "java", get(x, y, z) { const c = chunk(x >> 4, z >> 4); const s = c && c.get(y >> 4); if (!s) return null; return s.pal[s.get(((y & 15) * 16 + (z & 15)) * 16 + (x & 15))]; } };
}

/** 統合版：ワールドのフォルダか .mcworld（zip）。区画 v8・v9 の 1 番目の層だけ読む（2 番目＝水の層は見ない） */
export function bedrockWorld(src) {
	let files;
	if (fs.statSync(src).isDirectory()) { const d = path.join(src, "db"); files = fs.readdirSync(d).map(n => ({ name: n, bytes: new Uint8Array(fs.readFileSync(path.join(d, n))) })); }
	else files = Object.entries(unzip(new Uint8Array(fs.readFileSync(src)))).filter(([n]) => n.startsWith("db/")).map(([n, b]) => ({ name: n.slice(3), bytes: b }));
	const kv = readLevelDb(files), subs = new Map();
	const sub = (cx, cz, sy) => {
		const k = `${cx},${cz},${sy}`; if (subs.has(k)) return subs.get(k);
		const kb = Buffer.alloc(10); kb.writeInt32LE(cx, 0); kb.writeInt32LE(cz, 4); kb[8] = 0x2f; kb.writeInt8(sy, 9);
		const v = kv.get(kb.toString("hex")); let out = null;
		if (v && (v[0] === 8 || v[0] === 9)) {
			const b = Buffer.from(v.buffer, v.byteOffset, v.byteLength); let p = v[0] === 9 ? 3 : 2;
			const bits = b[p++] >> 1;
			if (bits === 0) { const r = readNbt(v.subarray(p + 4), { le: true }); out = { pal: [r.value], get: () => 0 }; }
			else {
				const per = Math.floor(32 / bits), words = Math.ceil(4096 / per), w0 = p, mask = (1 << bits) - 1; p += words * 4;
				const n = b.readInt32LE(p); p += 4; const pal = [];
				for (let i = 0; i < n; i++) { const r = readNbt(v.subarray(p), { le: true }); pal.push(r.value); p += r.length; }
				out = { pal, get: (i) => (b.readUInt32LE(w0 + Math.floor(i / per) * 4) >>> ((i % per) * bits)) & mask };
			}
		}
		subs.set(k, out); return out;
	};
	return { kind: "bedrock", get(x, y, z) { const s = sub(x >> 4, z >> 4, y >> 4); if (!s) return null; return s.pal[s.get(((x & 15) << 8) | ((z & 15) << 4) | (y & 15))]; } };
}

/** .schem（Sponge v2・v3）：get は schem の中の座標（0..W-1 …）。offset＝貼る点から見た隅 */
export function schematic(bytes) {
	let { value: v } = readNbt(new Uint8Array(gunzipSync(bytes)));
	if (v.Schematic) v = v.Schematic;   // v3 は根の下に Schematic
	const blocks = v.Blocks || v, pal = blocks.Palette, data = blocks.BlockData || blocks.Data;
	const W = v.Width & 0xffff, H = v.Height & 0xffff, L = v.Length & 0xffff, inv = [];
	for (const [k, i] of Object.entries(pal)) inv[i] = k.replace(/\[.*$/, "");
	const ids = new Uint32Array(W * H * L);
	for (let i = 0, p = 0; i < ids.length; i++) { let x = 0, s = 0, c; do { c = data[p++] & 255; x |= (c & 127) << s; s += 7; } while (c & 128); ids[i] = x; }
	const off = v.Offset ? [...v.Offset] : [0, 0, 0];
	return { kind: "schem", W, H, L, offset: off, get(x, y, z) { if (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= L) return null; return inv[ids[x + z * W + y * W * L]]; } };
}

function unzip(b) {
	// 中央ディレクトリから読む（deflate の zip＝Minecraft が書き出した .mcworld にも対応）
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); let e = b.length - 22;
	while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
	if (e < 0) throw new Error("zip: no end record");
	const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = {};
	for (let i = 0; i < n; i++) {
		const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
		const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
		const lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true), body = b.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + csize);
		if (!name.endsWith("/")) out[name] = method === 0 ? body : new Uint8Array(inflateRawSync(body));
		p += 46 + nl + xl + cl;
	}
	return out;
}

/** 範囲のブロック → 見えている面の四角（ブロックの種ごとに 1 つの prim） */
export function meshBlocks(get, [x0, y0, z0, x1, y1, z1], { scale = 1, yOrigin = 0, keep = null } = {}) {
	const info = new Map(), solid = (x, y, z) => { const b = get(x, y, z); if (b == null) return null; const k = typeof b === "string" ? b : `${b.name}|${JSON.stringify(b.states || {})}`; if (!info.has(k)) info.set(k, blockInfo(b)); return info.get(k); };
	const prims = new Map(); let count = 0;
	const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
	for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
		const me = solid(x, y, z); if (!me || (keep && !keep(x, y, z))) continue;
		count++;
		let p = prims.get(me.key); if (!p) prims.set(me.key, p = { info: me, pos: [], nrm: [], idx: [] });
		for (const [dx, dy, dz] of FACES) {
			const nx = x + dx, ny = y + dy, nz = z + dz;
			const inside = nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1 && nz >= z0 && nz <= z1;
			if (inside && solid(nx, ny, nz) && (!keep || keep(nx, ny, nz))) continue;
			const c = cubeFace(dx, dy, dz), base = p.pos.length / 3;
			for (const [u, v, w] of c) p.pos.push((x + u) * scale, (y + v - yOrigin) * scale, (z + w) * scale), p.nrm.push(dx, dy, dz);
			p.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
		}
	}
	const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
	return {
		count,
		prims: [...prims.values()].filter(p => p.idx.length).map(p => ({
			positions: new Float32Array(p.pos), normals: new Float32Array(p.nrm), uvs: null, colors: null, indices: new Uint32Array(p.idx),
			material: { name: p.info.name.replace(/^minecraft:/, ""), baseColor: [...p.info.rgb.map(lin), 1], doubleSided: false, image: null },
		})),
	};
}
/** 立方体の 1 面の 4 隅（0/1・外から見て反時計回り＝glTF の表） */
function cubeFace(dx, dy, dz) {
	if (dx === 1) return [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]];
	if (dx === -1) return [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]];
	if (dy === 1) return [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]];
	if (dy === -1) return [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]];
	if (dz === 1) return [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
	return [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]];
}

const sameBlock = (a, b) => (a == null ? null : typeof a === "string" ? a : `${a.name}|${JSON.stringify(a.states || {})}`) === (b == null ? null : typeof b === "string" ? b : `${b.name}|${JSON.stringify(b.states || {})}`);
/** 入力の形を見分けて読み手を返す */
export function openSource(src) {
	if (/\.schem$/i.test(src)) return schematic(fs.readFileSync(src));
	if (/\.mcworld$/i.test(src) || fs.existsSync(path.join(src, "db"))) return bedrockWorld(src);
	if (fs.existsSync(path.join(src, "region"))) return javaWorld(src);
	throw new Error(`${src}: not a Java world (region/), a Bedrock world (db/ or .mcworld) or a .schem`);
}
const findMeta = (src, given) => {
	for (const f of [given, path.join(src, "ortho-earth.json"), path.join(path.dirname(src), "ortho-earth.json")]) if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return JSON.parse(fs.readFileSync(f, "utf8"));
	if (/\.mcworld$/i.test(src)) { const z = unzip(new Uint8Array(fs.readFileSync(src))); if (z["ortho-earth.json"]) return JSON.parse(new TextDecoder().decode(z["ortho-earth.json"])); }
	return null;
};

/**
 * @param {object} o
 * @param {string} o.src     Java のワールドのフォルダ・統合版のフォルダか .mcworld・.schem
 * @param {string} o.out     書く GLB
 * @param {number[]} [o.box] [x0,y0,z0,x1,y1,z1]（ブロックの座標・両端を含む）。.schem は省略＝全体
 * @param {string} [o.diff]  書き出した時のワールド（同じ形式）＝違うブロックだけを焼く（建てた物だけ）
 * @param {number[]} [o.at]  .schem を貼る点（ブロックの座標）＝省略＝schem の Offset を錨から（ortho-minecraft の .schem はそのまま元の場所）
 * @param {string} [o.meta]  ortho-earth.json（省略＝ワールドの中・横・.mcworld の中を探す）
 */
export function importMinecraft({ src, out, box = null, diff = null, at = null, meta = null, log = () => {} }) {
	const m = findMeta(src, meta);
	if (!m) throw new Error("ortho-earth.json not found (the anchor of the world): pass --meta <file>");
	const { scale, yOrigin, grid } = m.minecraft;
	let s = openSource(src), get = s.get;
	if (s.kind === "schem") {
		const o = at || [s.offset[0], s.offset[1] + yOrigin, s.offset[2]];   // 錨 (0, yOrigin, 0) に貼った時の schem の隅＝Offset
		const sg = s.get; get = (x, y, z) => sg(x - o[0], y - o[1], z - o[2]);
		if (!box) box = [o[0], o[1], o[2], o[0] + s.W - 1, o[1] + s.H - 1, o[2] + s.L - 1];
	}
	if (!box) {
		if (!diff) throw new Error("--box x0,y0,z0,x1,y1,z1 (or --diff <original world>) is needed for a world");
		box = [grid.x0, grid.y0, grid.z0, grid.x0 + grid.width - 1, grid.y0 + grid.height - 1, grid.z0 + grid.length - 1];
	}
	let keep = null;
	if (diff) { const o = openSource(diff); keep = (x, y, z) => !sameBlock(get(x, y, z), o.get(x, y, z)); }
	const r = meshBlocks(get, box, { scale, yOrigin, keep });
	if (!r.prims.length) throw new Error("no blocks in the range");
	const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (const p of r.prims) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k], p.positions[i + k]); bb[3 + k] = Math.max(bb[3 + k], p.positions[i + k]); }
	const [file] = toGlb({ rtc: null, prims: r.prims, bbox: bb }, { name: path.basename(out, ".glb") });
	const glb = stampGlb(file.bytes, { version: 1, anchor: m.anchor, frame: "enu", heading: 0, geoid: m.geoid, bbox: m.bbox, generator: `ortho-export ${VERSION} minecraft import`, source: [{ kind: "minecraft", name: `${s.kind} ${path.basename(src)}`, box }] });
	fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
	fs.writeFileSync(out, glb);
	const tris = r.prims.reduce((n, p) => n + p.indices.length / 3, 0);
	log(`${out}: ${r.count} blocks, ${r.prims.length} block types, ${tris} triangles, ${(glb.length / 1e6).toFixed(2)} MB`);
	return { blocks: r.count, prims: r.prims.length, triangles: tris, bytes: glb.length, box };
}
