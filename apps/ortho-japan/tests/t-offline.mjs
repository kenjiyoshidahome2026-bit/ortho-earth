#!/usr/bin/env node
// オフラインパック（#40）の純関数の常設検定：①タイル列挙（bbox×z・被覆で切る）②枚数＝列の長さ ③標高のセル名（altpbf の綴り）
// ④見積り ⑤実行器（並列・飛ばし・失敗・中断）
import { tilesFor, tileCount, demCells, demNames, estimateBytes, runFetches, bboxIntersects, fmtMB, splitBbox, tplOf } from "@ortho-earth/globe/offline-pack.js";
import { encodeName } from "altpbf";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };

const TOKYO = [139.70, 35.65, 139.80, 35.72];
const z14 = tilesFor(TOKYO, 14, 14);
t("z14 の東京＝十数枚（x 14551..14555・y 6449..6453 あたり）", z14.length >= 12 && z14.length <= 30 && z14.every(([z]) => z === 14), String(z14.length));
t("枚数＝列の長さ（z8..15）", tileCount(TOKYO, 8, 15) === tilesFor(TOKYO, 8, 15).length);
t("z が上がるほど増える", tileCount(TOKYO, 15, 15) > tileCount(TOKYO, 14, 14));
t("被覆の外＝0", tileCount([-10, 50, -9, 51], 8, 12, [121, 19, 155, 46]) === 0);
t("被覆で切る", tileCount([150, 40, 160, 50], 8, 8, [121, 19, 155, 46]) < tileCount([150, 40, 160, 50], 8, 8));
t("標高：R10 のセル名＝altpbf と同じ綴り", demCells(TOKYO, 10).join() === encodeName(130, 30, 10) && demCells(TOKYO, 10)[0] === "R10N030E130");
t("標高：R01＝1° 格子（東京＝1 枚）", demCells(TOKYO, 1).join() === "R01N035E139");
t("標高：跨ぐ範囲＝2×2", demCells([139.5, 35.5, 140.5, 36.5], 1).length === 4);
t("標高：南西半球の綴り", demCells([-70.5, -33.5, -70.4, -33.4], 1)[0] === "R01S034W071" && encodeName(-71, -34, 1) === "R01S034W071");
t("標高：z<9 は R10 だけ・z≥9 で R01 も", demNames(TOKYO, 8).length === 1 && demNames(TOKYO, 9).length === 2);
t("見積り：標本の平均×枚数／標本なしは既定", estimateBytes(10, [1000, 3000]) === 20000 && estimateBytes(4, []) === 4 * 24 * 1024);
t("±180 を跨ぐ範囲＝2 つに分けて数える", splitBbox([179, 30, -179, 31]).length === 2 && tileCount([179, 30, -179, 31], 8, 8) === tileCount([179, 30, 180, 31], 8, 8) + tileCount([-180, 30, -179, 31], 8, 8) && tileCount([179, 30, -179, 31], 8, 8) > 0);
t("緯度は ±85.05 に切る（y が範囲外にならない）", tilesFor([0, 80, 1, 89.9], 4, 4).every(([z, x, y]) => y >= 0 && y < 16) && splitBbox([0, -89, 1, 89])[0][1] === -85.0511);
t("tileUrl → 型紙", tplOf((z, x, y) => `https://a.example/xyz/${z}/${x}/${y}.pbf`) === "https://a.example/xyz/{z}/{x}/{y}.pbf" && tplOf((z, x, y) => `https://b.example/t?z=${z}&x=${x}&y=${y}&v=27`) === "https://b.example/t?z={z}&x={x}&y={y}&v=27");
t("bbox の交差", bboxIntersects([0, 0, 1, 1], [0.5, 0.5, 2, 2]) && !bboxIntersects([0, 0, 1, 1], [1, 1, 2, 2]));
t("fmtMB", fmtMB(1.5e9) === "1.50 GB" && fmtMB(2.5e6) === "2.5 MB" && fmtMB(3000) === "3 KB");

// 実行器：飛ばし（has）・失敗（-1）・中断
const urls = Array.from({ length: 20 }, (_, i) => "u" + i);
const seen = [];
const r = await runFetches(urls, { has: async u => u === "u3", fetchOne: async u => { seen.push(u); return u === "u5" ? -1 : 100; }, concurrency: 4 });
t("実行器：19 取って 1 飛ばし・1 失敗・1800 B", r.bytes === 1800 && r.failed === 1 && !r.aborted && seen.length === 19 && !seen.includes("u3"), JSON.stringify(r));
const ac = new AbortController(); let n = 0;
const r2 = await runFetches(urls, { fetchOne: async () => { if (++n === 5) ac.abort(); await new Promise(r => setTimeout(r, 2)); return 10; }, concurrency: 2, signal: ac.signal });
t("実行器：中断＝aborted・途中まで", r2.aborted && n < 20, JSON.stringify(r2) + " n=" + n);

console.log(`\n${ng ? "✗" : "✓"} offline: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
