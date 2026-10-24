#!/usr/bin/env node
// scenes エディタの UI 検定（tests/t-scene・t-scene-data・t-export）。走らせ方は globe の共通の道具（ui-runner）＝ortho-japan の verify-ui と同じ。
// 2026-10-24 に頁ごと ortho-japan からこのアプリへ移った（ortho-japan の verify-ui の頁の一覧から外した）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages } from "@ortho-earth/globe/scripts/lib/ui-runner.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VUI_PORT || 5239;
const ALL_PAGES = ["t-scene", "t-scene-data", "t-export"];
const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ALL_PAGES.filter(p => ARGS.includes(p)) : ALL_PAGES;

const stop = await startVite({ cwd: APP, port: PORT, portEnv: "VUI_PORT", readyUrl: `http://localhost:${PORT}/japan/scene.html` });
const fail = await runPages({ pages: PAGES, realtime: new Set(["t-export"]), jobs: +process.env.VG_JOBS || 3,   // t-export＝WebCodecs の符号器（実時間の callback）
	urlOf: (page, q) => `http://localhost:${PORT}/japan/tests/${page}.html?${q}` });
stop();
process.exit(fail ? 1 : 0);
