// copc2gs.py の下請け：タイルの生の配列（.bin＝n・位置・尺・四元数・RGBA）→ KHR_gaussian_splatting ＋ SPZ の glb（sdk/splat の書き出しをそのまま使う）
//   node gs-glb.mjs <jobs.json（[{ src, dst }]）>
import fs from "node:fs";
import { encodeSpzRaw } from "../../../sdk/splat/src/formats.ts";
import { cloudLevelGlb, enuToGltfAxes } from "../../../sdk/splat/src/cloud.ts";
import { gzip } from "../../../sdk/splat/src/cloud-export.ts";
const list = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const { src, dst } of list) {
	const b = fs.readFileSync(src), n = b.readUInt32LE(0); let o = 4;
	const f = k => { const a = new Float32Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + k * 4)); o += k * 4; return a; };
	const positions = f(n * 3), scales = f(n * 3), rotations = f(n * 4), colors = new Uint8Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + n * 4));
	const d = enuToGltfAxes({ n, crs: "local", positions, scales, rotations, colors });
	fs.writeFileSync(dst, cloudLevelGlb(d, await gzip(encodeSpzRaw(d, { frac: 12 }))));
	fs.unlinkSync(src);
}
