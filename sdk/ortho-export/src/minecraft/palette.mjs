// 色 → ブロック（docs/notes/minecraft.md §4）：塗れる不透明の 1 マスのブロックを平均の色で並べ、Lab の近さで選ぶ。
//   色はテクスチャの平均の目安（地図絵の道具が使う値に近い物）。重力で落ちる物（砂・コンクリートパウダー）と
//   バイオームで色の変わる物（草・葉）は塗り色に使わない（地面の上だけ grass_block を別に使う）。
//   java＝Java 版 1.21 のブロック名。bedrock＝統合版の 1.20.0 の名前と states（ゲームが開く時に今の名前へ上げる＝§5.3）。
const C = (java, rgb, bedrock, states = {}) => ({ java, rgb, bedrock: { name: `minecraft:${bedrock}`, states } });
const DYES = [["white", 207, 213, 214, 209, 178, 161], ["orange", 224, 97, 0, 161, 83, 37], ["magenta", 169, 48, 159, 149, 88, 108], ["light_blue", 35, 137, 198, 113, 108, 137],
	["yellow", 240, 175, 21, 186, 133, 35], ["lime", 94, 168, 24, 103, 117, 52], ["pink", 213, 101, 142, 161, 78, 78], ["gray", 54, 57, 61, 57, 42, 35],
	["light_gray", 125, 125, 115, 135, 106, 97], ["cyan", 21, 119, 136, 86, 91, 91], ["purple", 100, 31, 156, 118, 70, 86], ["blue", 44, 46, 143, 74, 59, 91],
	["brown", 96, 59, 31, 77, 51, 35], ["green", 73, 91, 36, 76, 83, 42], ["red", 142, 32, 32, 143, 61, 46], ["black", 8, 10, 15, 37, 22, 16]];
const bedrockColor = (c) => c === "light_gray" ? "silver" : c;

/** 塗り色に使うブロック（順番は id＝変えると検定の期待値が変わる） */
export const PAINT = [
	...DYES.map(([c, r, g, b]) => C(`minecraft:${c}_concrete`, [r, g, b], "concrete", { color: bedrockColor(c) })),
	...DYES.map(([c, , , , r, g, b]) => C(`minecraft:${c}_terracotta`, [r, g, b], "stained_hardened_clay", { color: bedrockColor(c) })),
	C("minecraft:terracotta", [152, 94, 67], "hardened_clay"),
	C("minecraft:stone", [125, 125, 125], "stone", { stone_type: "stone" }),
	C("minecraft:smooth_stone", [158, 158, 158], "smooth_stone"),
	C("minecraft:andesite", [136, 136, 136], "stone", { stone_type: "andesite" }),
	C("minecraft:polished_andesite", [132, 134, 133], "stone", { stone_type: "andesite_smooth" }),
	C("minecraft:diorite", [188, 188, 188], "stone", { stone_type: "diorite" }),
	C("minecraft:polished_diorite", [192, 193, 194], "stone", { stone_type: "diorite_smooth" }),
	C("minecraft:granite", [149, 103, 85], "stone", { stone_type: "granite" }),
	C("minecraft:cobblestone", [127, 127, 127], "cobblestone"),
	C("minecraft:stone_bricks", [122, 121, 122], "stonebrick", { stone_brick_type: "default" }),
	C("minecraft:polished_blackstone", [53, 48, 56], "polished_blackstone"),
	C("minecraft:dirt", [134, 96, 67], "dirt", { dirt_type: "normal" }),
	C("minecraft:coarse_dirt", [119, 85, 59], "dirt", { dirt_type: "coarse" }),
	C("minecraft:moss_block", [89, 109, 45], "moss_block"),
	C("minecraft:sandstone", [216, 203, 155], "sandstone", { sand_stone_type: "default" }),
	C("minecraft:smooth_sandstone", [223, 214, 170], "sandstone", { sand_stone_type: "smooth" }),
	C("minecraft:bricks", [150, 97, 83], "brick_block"),
	C("minecraft:quartz_block", [235, 229, 222], "quartz_block", { chisel_type: "default", pillar_axis: "y" }),
	C("minecraft:snow_block", [249, 254, 254], "snow"),
	C("minecraft:clay", [160, 166, 179], "clay"),
	C("minecraft:mud_bricks", [137, 103, 79], "mud_bricks"),
	C("minecraft:packed_mud", [142, 106, 79], "packed_mud"),
	C("minecraft:oak_planks", [162, 130, 78], "planks", { wood_type: "oak" }),
	C("minecraft:spruce_planks", [114, 84, 48], "planks", { wood_type: "spruce" }),
	C("minecraft:birch_planks", [192, 175, 121], "planks", { wood_type: "birch" }),
	C("minecraft:dark_oak_planks", [66, 43, 20], "planks", { wood_type: "dark_oak" }),
	C("minecraft:prismarine", [99, 156, 151], "prismarine", { prismarine_block_type: "default" }),
	C("minecraft:dark_prismarine", [51, 91, 75], "prismarine", { prismarine_block_type: "dark" }),
];
/** 色以外に使う物 */
export const SPECIAL = {
	air: { java: "minecraft:air", bedrock: { name: "minecraft:air", states: {} } },
	stone: PAINT.find(b => b.java === "minecraft:stone"),
	dirt: PAINT.find(b => b.java === "minecraft:dirt"),
	grass: { java: "minecraft:grass_block", rgb: [124, 189, 107], bedrock: { name: "minecraft:grass", states: {} } },
	floor: PAINT.find(b => b.java === "minecraft:smooth_stone"),
};

// sRGB → CIE Lab（D65）
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const f = (t) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
export function toLab([r, g, b]) {
	const R = lin(r), G = lin(g), B = lin(b);
	const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
	const fx = f(X), fy = f(Y), fz = f(Z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * 色 → PAINT の番号。5 bit/ch の表で覚える（32768 通り）。
 * @param {{ exclude?: string[] }} [o]  使わないブロック（Java の名前）
 */
export function makeMatcher({ exclude = [] } = {}) {
	const use = PAINT.map((b, i) => ({ i, lab: toLab(b.rgb) })).filter(x => !exclude.includes(PAINT[x.i].java));
	const memo = new Int16Array(32768).fill(-1);
	return function nearest(r, g, b) {
		const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
		if (memo[k] >= 0) return memo[k];
		const L = toLab([r, g, b]); let best = 0, bd = Infinity;
		for (const u of use) { const d = (L[0] - u.lab[0]) ** 2 + (L[1] - u.lab[1]) ** 2 + (L[2] - u.lab[2]) ** 2; if (d < bd) { bd = d; best = u.i; } }
		return (memo[k] = best);
	};
}
