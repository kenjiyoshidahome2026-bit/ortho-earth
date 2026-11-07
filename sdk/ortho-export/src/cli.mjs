#!/usr/bin/env node
// ortho-export：範囲を指定して地形・PLATEAU 建物を Unity 向けの GLB に焼く（docs/notes/unity-roundtrip.md §3）。
//
//   npx ortho-export --bbox 139.7625,35.6785,139.7700,35.6840 --out out/marunouchi
//   オプション：
//     --anchor lon,lat[,height]   錨（省略＝bbox の中心・高さ＝地面）
//     --geoid auto|<m>            ジオイド高（既定 auto＝地理院 API。東京 ≈ 36.7）
//     --zoom 17                   画像タイルの z（最大 18）
//     --imagery seamlessphoto|std|pale|none
//     --dem-zoom 14               標高タイルの z（dem_png は 14 まで）
//     --segments 32               画像タイル 1 枚あたりの地形の分割数
//     --buildings catalog|<tileset.json url>[,<url>…]|none   既定 catalog＝packages/jp/assets/plateau-sets.json から bbox の市区町村を引く
//     --textured                  catalog のセット名の notexture を texture に置き換えて読む（配信があれば）
//     --no-terrain
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportArea } from "./export.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (!a.startsWith("--")) continue;
	const k = a.slice(2), v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
	opt[k] = v;
}
if (!opt.bbox || opt.help) {
	console.error("usage: ortho-export --bbox w,s,e,n --out <dir> [--anchor lon,lat[,h]] [--geoid auto|m] [--zoom 17] [--imagery seamlessphoto|std|pale|none] [--buildings catalog|url[,url]|none] [--textured] [--no-terrain]");
	process.exit(opt.help ? 0 : 2);
}
const nums = s => String(s).split(",").map(Number);
const bbox = nums(opt.bbox);
const anchor = opt.anchor ? (([lon, lat, height]) => ({ lon, lat, height }))(nums(opt.anchor)) : null;
const geoid = opt.geoid == null || opt.geoid === "auto" ? "auto" : Number(opt.geoid);
const terrain = opt["no-terrain"] ? null : { zoom: opt.zoom ? Number(opt.zoom) : 17, imagery: opt.imagery || "seamlessphoto", demZoom: opt["dem-zoom"] ? Number(opt["dem-zoom"]) : 14, segments: opt.segments ? Number(opt.segments) : 32 };
let buildings;
if (opt.buildings === "none") buildings = null;
else if (!opt.buildings || opt.buildings === "catalog") buildings = { catalog: JSON.parse(fs.readFileSync(path.join(HERE, "../../../packages/jp/assets/plateau-sets.json"), "utf8")), textured: !!opt.textured };
else buildings = { tilesets: String(opt.buildings).split(",") };

const t0 = Date.now();
const r = await exportArea({ bbox, out: opt.out || "out", anchor, geoid, terrain, buildings, log: s => console.error(s) });
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${opt.out || "out"}/ (${r.files.map(f => f.name).join(", ")})`);
