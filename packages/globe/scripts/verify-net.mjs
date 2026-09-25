#!/usr/bin/env node
// 外部の配信に依る検定（T3・2026-09-25）＝相手（NASA GIBS・ArcGIS）の都合で揺れるので常設の関門（verify）には入れない。
// 画像タイル層の OGC 読み（WMTS の GetCapabilities・WMS の GetMap 割り）と I3S の実データ流しを、相手の仕様変更に
// 気づくために手で・定期的に回す。関門側の同じ機能は手元の資料で回っている（t-raster・t-tiles3d）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages } from "./lib/ui-runner.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VGN_PORT || 5249;
const ALL_PAGES = ["t-ogc", "t-ogc?kind=wms", "t-i3s"];
const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ARGS : ALL_PAGES;

const stop = await startVite({ cwd: PKG, port: PORT, readyUrl: `http://localhost:${PORT}/tests/` });
const fail = await runPages({
	pages: PAGES, realtime: new Set(PAGES.map(p => p.split("?")[0])),   // 外部取得の到着待ち＝全頁実時間
	long: { "t-ogc": 60, "t-i3s": 110 }, profilePrefix: "og-net", cdpBase: +process.env.VGN_CDP || 9435, pad: 16,
	urlOf: (page, q) => `http://localhost:${PORT}/tests/${page}.html?${q}`,
});
stop();
process.exit(fail ? 1 : 0);
