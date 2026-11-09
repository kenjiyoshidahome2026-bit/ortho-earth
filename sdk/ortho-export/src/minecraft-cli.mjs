#!/usr/bin/env node
// ortho-minecraft：ortho-export の出力フォルダを Minecraft のワールドに焼く（docs/notes/minecraft.md）。
//
//   node sdk/ortho-export/src/minecraft-cli.mjs out/marunouchi --out out/marunouchi-mc
//   オプション：
//     --edition java,bedrock   既定＝両方。java＝ワールドのフォルダ＋.schem・bedrock＝.mcworld・schem＝.schem だけ
//     --scale 1                1 ブロックの m（広い範囲は 2・4）
//     --floors 4               建物の床の間隔（m）・0＝外殻だけ
//     --y-origin <Y>           錨の高さが入るブロックの Y（既定 0・入りきらなければずらす）
//     --no-roof-imagery        屋根の色を写真から取らない（建物の材質の色）
//     --name <名前>            ワールドの名前（既定＝入力フォルダの名前）
//     --image-tool sharp|sips|ffmpeg|magick
//
//   取り込み（Minecraft → 錨つき GLB・§6）：
//   node sdk/ortho-export/src/minecraft-cli.mjs import <ワールド|.mcworld|.schem> --out house.glb [--box x0,y0,z0,x1,y1,z1] [--diff <書き出した時のワールド>]
//     --box    ブロックの座標の範囲（両端を含む・F3 の XYZ）。.schem は省略＝全体
//     --diff   同じ形式の元のワールド：違うブロックだけを焼く（建てた物・壊した所は入らない）
//     --at x,y,z  .schem を貼った点（省略＝ortho-minecraft が書いた .schem の Offset＝元の場所）
//     --meta   ortho-earth.json（省略＝ワールドの中・横・.mcworld の中）
import { exportMinecraft } from "./minecraft/export.mjs";
import { importMinecraft } from "./minecraft/import.mjs";

const args = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (!a.startsWith("--")) { pos.push(a); continue; }
	opt[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
}
const nums = (v) => String(v).split(",").map(Number);
if (pos[0] === "import") {
	if (!pos[1] || !opt.out) { console.error("usage: ortho-minecraft import <world|.mcworld|.schem> --out model.glb [--box x0,y0,z0,x1,y1,z1] [--diff original] [--at x,y,z] [--meta ortho-earth.json]"); process.exit(2); }
	importMinecraft({ src: pos[1], out: opt.out, box: opt.box ? nums(opt.box) : null, diff: opt.diff || null, at: opt.at ? nums(opt.at) : null, meta: opt.meta || null, log: s => console.error(s) });
	process.exit(0);
}
if (!pos[0] || opt.help) {
	console.error("usage: ortho-minecraft <ortho-export folder> --out <dir> [--edition java,bedrock|schem] [--scale 1] [--floors 4] [--y-origin Y] [--no-roof-imagery] [--name name] [--image-tool sharp|sips|ffmpeg|magick]");
	process.exit(opt.help ? 0 : 2);
}
const editions = String(opt.edition || "java,bedrock").split(",");
for (const e of editions) if (!["java", "bedrock", "schem"].includes(e)) { console.error("--edition java,bedrock,schem"); process.exit(2); }
const t0 = Date.now();
const r = await exportMinecraft({
	from: pos[0], out: opt.out || `${pos[0].replace(/\/$/, "")}-minecraft`, name: opt.name || null, editions,
	scale: opt.scale ? Number(opt.scale) : 1, floors: opt.floors != null ? Number(opt.floors) : 4, yOrigin: opt["y-origin"] != null ? Number(opt["y-origin"]) : null,
	roofFromImagery: !opt["no-roof-imagery"], imageTool: opt["image-tool"] || null, log: s => console.error(s),
});
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${r.files.map(f => f.name).join(", ")} (spawn ${r.spawn.join(" ")})`);
