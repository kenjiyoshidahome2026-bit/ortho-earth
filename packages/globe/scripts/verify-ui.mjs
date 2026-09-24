#!/usr/bin/env node
// 地球儀ホスト（packages/globe）の UI 検定＝**この層の門はこの層が持つ**（2026-09-24・LAYERS.md 段階 4）。
// 頁＝packages/globe/tests/*.html（どれも公開面 `@ortho-earth/globe` の createGlobe で起動＝地域を渡さない）。
// 器＝packages/globe/vite.config.js（COI ヘッダ・worker es・builtinWorkers なし版）。走らせ方＝scripts/lib/ui-runner.mjs（japan と共有）。
// 使い方: packages/globe で `npm run verify:ui`（頁名を並べればその頁だけ）。
//
// ★ここに無い頁は「日本を試料に使う検定」＝apps/ortho-japan が宿す（間借りではない・地域パックの検定）。
//   例：z≥6.5 の東京で基図・注記・印刷・計測・RTL を見る頁は、日本の基図が無いと見るものが無い。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages } from "./lib/ui-runner.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VGU_PORT || 5245;

const ALL_PAGES = ["t-gintlod", "t-gintembed", "t-gintmultigl", "t-gintswap", "t-gintdepth", "t-qr",
	"t-anno", "t-camera", "t-mllayers", "t-mlstyle", "t-tiles3d", "t-marker", "t-request", "t-sunshadow", "t-dem", "t-viewshed", "t-clock", "t-bootview"];
// 実時間で回す頁＝render worker 内の動的 import（map.overlay のモジュール）や実 GPU の async init に依る検定。
// 仮想時間（--virtual-time-budget）では worker の import() が永久に解決しない＝偽陽性（2026-09-20 実測）。
const REALTIME = new Set(["t-anno", "t-camera", "t-mllayers", "t-mlstyle", "t-tiles3d", "t-marker", "t-request", "t-sunshadow", "t-dem", "t-viewshed", "t-clock", "t-bootview"]);
const LONG = { "t-request": 180, "t-dem": 170, "t-bootview": 240 };   // t-bootview＝5 回起動し直す   // 段が多い実描画＝枠を広げる

const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ALL_PAGES.filter(p => ARGS.includes(p.split("?")[0])) : ALL_PAGES;

const stop = await startVite({ cwd: PKG, port: PORT, readyUrl: `http://localhost:${PORT}/tests/` });
const fail = await runPages({ pages: PAGES, realtime: REALTIME, long: LONG, urlOf: (page, q) => `http://localhost:${PORT}/tests/${page}.html?${q}` });
stop();
process.exit(fail ? 1 : 0);
