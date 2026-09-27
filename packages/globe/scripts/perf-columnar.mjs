#!/usr/bin/env node
// 列チャンク層（#90）の物差し＝tests/t-columnar.html?g=perf を大きさ違いで回して「最初の 1 枚まで」を並べる（段 0）。
// 使い方: packages/globe で `node scripts/perf-columnar.mjs [n=20000 n=60000 kind=points&n=1000000 …]`（省略＝既定の 4 本）。ポートは VGP_PORT。
// 実 GPU でない（headless・SwiftShader）数字は相対比較にだけ使う＝絶対値は本人の機で。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages } from "./lib/ui-runner.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VGP_PORT || 5257;
const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const VARIANTS = ARGS.length ? ARGS : ["n=20000", "n=60000", "n=150000", "kind=points&n=1000000"];
const PAGES = VARIANTS.map(v => `t-columnar?g=perf&${v}`);
const stop = await startVite({ cwd: PKG, port: PORT, portEnv: "VGP_PORT", readyUrl: `http://localhost:${PORT}/tests/` });
const fail = await runPages({ pages: PAGES, realtime: new Set(["t-columnar"]), long: { "t-columnar": 600 }, urlOf: (page, q) => `http://localhost:${PORT}/tests/${page}.html?${q}` });
stop();
process.exit(fail ? 1 : 0);
