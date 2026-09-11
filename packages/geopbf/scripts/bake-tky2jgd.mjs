#!/usr/bin/env node
// scripts/bake-tky2jgd.mjs ── 国土地理院 TKY2JGD.par → geopbf/tky2jgd が読む二進形（.bin と .bin.gz）。実体は src/convert/tky2jgd.js の bakeTKY2JGD。
//   node scripts/bake-tky2jgd.mjs TKY2JGD.par out/tky2jgd.bin
// 出来た tky2jgd.bin.gz を native-bucket（例: GIS/datum/）へ置き、その URL を opts.tky2jgd / --tky2jgd に渡す。
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { bakeTKY2JGD } from "../src/convert/tky2jgd.js";

const [, , inPath, outPath = "tky2jgd.bin"] = process.argv;
if (!inPath) { console.error("bake-tky2jgd <TKY2JGD.par> [out.bin]"); process.exit(1); }
const { bytes, meta, maxResidualArcsec } = bakeTKY2JGD(new TextDecoder("shift_jis").decode(readFileSync(inPath)));
writeFileSync(outPath, bytes); const gz = gzipSync(bytes, { level: 9 }); writeFileSync(outPath + ".gz", gz);
console.log(`${meta.version}: cells ${meta.cells}・blocks ${meta.blocks}・max residual ${maxResidualArcsec}"  →  ${outPath} ${(bytes.length / 1e6).toFixed(2)} MB / gz ${(gz.length / 1e6).toFixed(2)} MB`);
