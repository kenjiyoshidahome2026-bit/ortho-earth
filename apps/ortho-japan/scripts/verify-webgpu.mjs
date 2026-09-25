#!/usr/bin/env node
// 日本（apps/ortho-japan）の WebGPU 検定＝実 GPU・実時間。地球儀ホストそのものの門は packages/globe が持つ
// （2026-09-24・LAYERS.md 段階 4）。ここに残るのは日本を試料に使う頁＝PLATEAU の OPFS・建物・基図の車線・
// 台帳・押し出しのドレープ・東京の gint 層など「日本のデータが無いと見るものが無い」検分。
// 仮想時間に載せない理由と、頁ごとに Chrome を立て直す作法は packages/globe/scripts/verify-webgpu.mjs と同じ。
// backend の検め（gl2=1 の無い頁は webgpu・ある頁は webgl2）も同じ＝runner の expectBackend（T1・2026-09-25）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages, REALGPU } from "@ortho-earth/globe/scripts/lib/ui-runner.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VWG_PORT || 5238;

const ALL_PAGES = ["t-webgpu", "t-extrude-drape?gl2=1&bottom=4000", "t-extrude-drape?gl2=1&bottom=drape", "t-extrude-drape?gl2=1&v=%2310/36.3/137.6",
	"t-aatrans", "t-gintlayers", "t-gintlayers?gl2=1", "t-zoomfill", "t-gndfaces",
	"t-meshfs", "t-baselane", "t-bld?gl2=1", "t-mesh?gl2=1&loadmax=1", "t-raster"];
const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ARGS : ALL_PAGES;

const stop = await startVite({ cwd: APP, port: PORT, readyUrl: `http://localhost:${PORT}/japan/` });
const fail = await runPages({
	pages: PAGES, realtime: new Set(PAGES.map(p => p.split("?")[0])),
	long: Object.fromEntries(PAGES.map(p => [p.split("?")[0], 90])),
	flags: REALGPU, drag: true, profilePrefix: "oj-webgpu", cdpBase: +process.env.VWG_CDP || 9535, pad: 18,
	base: "lang=ja", expectBackend: "webgpu", noBoot: new Set(["t-meshfs"]),   // noBoot＝地球儀を起こさない（OPFS の頁）
	urlOf: (page, q) => `http://localhost:${PORT}/japan/tests/${page}.html?${q}`,
});
stop();
process.exit(fail ? 1 : 0);
