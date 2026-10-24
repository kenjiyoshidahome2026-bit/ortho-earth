#!/usr/bin/env node
// 打ち上げ花火の実描画の検分（tests/t-fireworks.html＝overlay の import と粒子の進み）。走らせ方は globe の共通の道具（ui-runner）＝ortho-japan の verify-ui と同じ。
// 2026-10-24 に頁ごと ortho-japan からこのアプリへ移った（ortho-japan の verify-ui の頁の一覧から外した）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages } from "@ortho-earth/globe/scripts/lib/ui-runner.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VUI_PORT || 5238;

const stop = await startVite({ cwd: APP, port: PORT, portEnv: "VUI_PORT", readyUrl: `http://localhost:${PORT}/japan/fireworks.html` });
const fail = await runPages({ pages: ["t-fireworks"], realtime: new Set(["t-fireworks"]), long: { "t-fireworks": 240 }, jobs: 1,   // 玉が開くまで 8 秒＋ソフトウェア描画
	urlOf: (page, q) => `http://localhost:${PORT}/japan/tests/${page}.html?${q}` });
stop();
process.exit(fail ? 1 : 0);
