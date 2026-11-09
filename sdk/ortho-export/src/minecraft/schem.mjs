// WorldEdit の .schem（Sponge Schematic v2・gzip の NBT）：既存のワールドに //paste で貼る用（docs/notes/minecraft.md §5.2）。
//   順は x + z·Width + y·Width·Length・BlockData は varint の列。Offset＝貼る点から見た格子の隅＝錨が貼る点になる。
import { gzipSync } from "node:zlib";
import { writeNbt, short, int, byteArray, intArray } from "./nbt.mjs";
import { JAVA } from "./anvil.mjs";

export function writeSchem(g, { dataVersion = JAVA.dataVersion } = {}) {
	if (g.W > 65535 || g.D > 65535 || g.H > 65535) throw new Error("schem: too large");
	const used = new Map(); const pal = {};
	for (let i = 0; i < g.data.length; i++) { const b = g.data[i]; if (!used.has(b)) { used.set(b, used.size); pal[g.blocks[b].java] = int(used.get(b)); } }
	// 格子の順（y, z, x）は schem と同じ＝並べ替えなし。番号が 128 未満なら 1 バイトずつ
	const lut = new Uint16Array(256); for (const [b, j] of used) lut[b] = j;
	let out = new Uint8Array(g.data.length + 16), n = 0;
	for (let i = 0; i < g.data.length; i++) {
		let v = lut[g.data[i]];
		if (n + 3 > out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; }
		while (v > 127) { out[n++] = (v & 127) | 128; v >>>= 7; } out[n++] = v;
	}
	const root = {
		Version: int(2), DataVersion: int(dataVersion), Width: short(g.W), Height: short(g.H), Length: short(g.D),
		Offset: intArray([g.x0, g.y0 - g.yOrigin, g.z0]), PaletteMax: int(used.size), Palette: pal, BlockData: byteArray(out.subarray(0, n)),
		Metadata: { WEOffsetX: int(g.x0), WEOffsetY: int(g.y0 - g.yOrigin), WEOffsetZ: int(g.z0) },
	};
	return gzipSync(writeNbt(root, { name: "Schematic" }));
}
