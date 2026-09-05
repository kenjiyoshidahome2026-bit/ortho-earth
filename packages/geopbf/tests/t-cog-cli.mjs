// t-cog-cli: bin/geopbf.mjs の cog サブコマンド検定（サブプロセス起動＝t-cli.mjs と同じ経路）。
// 合成 COG を一時ファイルに書き、info の各欄・--bench・png 出力（マジック/IHDR 寸法）を見る。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCog } from "./cog/build-cog.mjs";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "geopbf-cog-"));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

const tif = join(dir, "t.tif");
writeFileSync(tif, buildCog({ width: 64, height: 48, epsg: 32654, compression: "deflate", predictor: true, overviews: [2, 4], nodata: 0 }));

// ---- info -----------------------------------------------------------------------
const info = run("cog", "info", tif);
ok(/size\s+64 x 48/.test(info), "info: 寸法");
ok(/tile\s+16 x 16/.test(info), "info: タイル格子");
ok(/EPSG:32654/.test(info), "info: CRS");
ok(/compression deflate/.test(info), "info: 圧縮");
ok(/overviews\s+64x48\s+32x24\s+16x12/.test(info), "info: overview 3段");
ok(/nodata 0/.test(info), "info: nodata");

const bench = run("cog", "info", tif, "--bench");
ok(/--bench\s+TTFH \d+ ms/.test(bench), "info --bench: TTFH が出る");
ok(/range \d+ 本/.test(bench), "info --bench: range 本数が出る");

// ---- png ------------------------------------------------------------------------
const png = join(dir, "out.png");
const msg = run("cog", "png", tif, png, "--level", "0", "--width", "64");
ok(/out\.png\s+64 x \d+/.test(msg), "png: 実行報告");
const b = readFileSync(png);
ok(b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71, "png: マジック");
const dv = new DataView(b.buffer, b.byteOffset);
ok(dv.getUint32(16) === 64, `png: IHDR width=64（実測 ${dv.getUint32(16)}）`);

// ---- 異常系 ----------------------------------------------------------------------
let threw = false;
try { run("cog", "nosuch", tif); } catch { threw = true; }
ok(threw, "未知サブコマンドは終了コード 1");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
