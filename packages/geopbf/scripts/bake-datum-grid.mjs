#!/usr/bin/env node
// scripts/bake-datum-grid.mjs ── 国土地理院の座標補正パラメータ（.par）→ geopbf/datum が読む二進形（.bin と .bin.gz）。
//   node scripts/bake-datum-grid.mjs TKY2JGD.par                    out/tky2jgd.bin      日本測地系 → JGD2000
//   node scripts/bake-datum-grid.mjs touhokutaiheiyouoki2011.par    out/patchjgd.bin     JGD2000    → JGD2011
// 出来た .bin.gz を native-bucket 等に置き、その URL を opts.tky2jgd / opts.patchjgd（CLI は --tky2jgd / --patchjgd）へ。
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { bakeMeshGrid } from "../src/convert/datum.js";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("bake-datum-grid <in.par> <out.bin>"); process.exit(1); }
const { bytes, meta, maxResidualArcsec } = bakeMeshGrid(new TextDecoder("shift_jis").decode(readFileSync(inPath)));
writeFileSync(outPath, bytes); const gz = gzipSync(bytes, { level: 9 }); writeFileSync(outPath + ".gz", gz);
console.log(`${meta.transform}  ${meta.version}\n  cells ${meta.cells}・blocks ${meta.blocks}・残差の目盛り ${meta.resScale}"・最大残差 ${maxResidualArcsec.toFixed(5)}"`);
console.log(`  → ${outPath} ${(bytes.length / 1e6).toFixed(2)} MB / gz ${(gz.length / 1e6).toFixed(2)} MB`);
