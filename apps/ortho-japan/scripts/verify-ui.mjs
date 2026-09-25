#!/usr/bin/env node
// 日本（apps/ortho-japan）の UI 検定＝**日本を試料に使う頁**。地球儀ホストそのものの門は packages/globe が持つ
// （2026-09-24・LAYERS.md 段階 4）。ここに残るのは二種類：
//   ① 地域の機能そのもの（搭載されるガジェット・基図の台帳・台本＝t-gadgets/t-providers/t-raster/t-demo/t-scene…）
//   ② globe の機能だが「見るものが要る」頁＝z≥6.5 の東京で基図・注記・印刷・計測・RTL・面の焼きを画素で見る
//      （日本の基図が無いと画面に何も無い＝地域パックがあって初めて成立する検定）
// 走らせ方は packages/globe/scripts/lib/ui-runner.mjs と共有（複製を作らない）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages } from "@ortho-earth/globe/scripts/lib/ui-runner.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VUI_PORT || 5237;

const ALL_PAGES = ["t-gadgets", "t-newgadgets", "t-providers", "t-raster", "t-demo", "t-scene",
	"t-gndfaces", "t-measure", "t-profile", "t-shot", "t-palette-live", "t-print", "t-opts", "t-input", "t-narrow", "t-rtl", "t-rtl?lang=ar", "t-model", "t-world", "t-fireworks"];   // t-fireworks＝打ち上げ花火（シーンの深度 #47 の見本）＝overlay の import と粒子の進み
const REALTIME = new Set(["t-raster", "t-gndfaces", "t-model", "t-fireworks"]);   // render worker 内の動的 import／実描画の到着に依る頁
const LONG = { "t-fireworks": 240 };   // 玉が開くまで 8 秒＋ソフトウェア描画

const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ALL_PAGES.filter(p => ARGS.includes(p)) : ALL_PAGES;

const stop = await startVite({ cwd: APP, port: PORT, readyUrl: `http://localhost:${PORT}/japan/` });
const fail = await runPages({ pages: PAGES, realtime: REALTIME, long: LONG, urlOf: (page, q) => `http://localhost:${PORT}/japan/tests/${page}.html?${q}` });
stop();
process.exit(fail ? 1 : 0);
