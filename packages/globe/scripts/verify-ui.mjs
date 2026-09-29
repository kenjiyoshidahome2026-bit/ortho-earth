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

const ALL_PAGES = ["t-gintlod", "t-gintembed", "t-gintmultigl", "t-gintswap", "t-gintdepth", "t-globefloor", "t-qr", "t-elevcell",   // t-globefloor＝写真を貼った球の床がカメラの摂動で揺れない（#65・GL2 変種）・t-elevcell＝標高セルの GPU 再標本化（GL2＝R16F FBO）対 CPU 参照（perf plan P1 step 1）
	"t-anno", "t-camera", "t-mllayers", "t-mlstyle", "t-linedeco?md=1", "t-linedeco?nomd=1", "t-tiles3d", "t-marker", "t-footprint", "t-request", "t-sunshadow", "t-dem", "t-qmesh", "t-viewshed", "t-clock", "t-bootview", "t-mlboot?v=default", "t-mlboot?v=ml",
	"t-overlaydepth", "t-overlaydepth?lowmem=1", "t-mlcompat?g=layers", "t-mlcompat?g=style", "t-mlcompat?g=relief", "t-mlcompat?g=vector", "t-mlcompat?g=extrude", "t-mlcompat?g=mlt", "t-mlzoom?zs=maplibre", "t-mlzoom?zs=ortho", "t-mlzoom?zs=mercator", "t-columnar?g=same", "t-columnar?g=perf", "t-columnar?g=route", "t-columnar?g=depth",
	"t-ellparity?ell=0", "t-ellparity?ell=1", "t-ellparity?g=cache", "t-ellparity?g=scan&ell=1",
	"t-marker?ell=1", "t-anno?ell=1", "t-columnar?g=same&ell=1", "t-mlcompat?g=extrude&ell=1", "t-overlaydepth?ell=1", "t-sunshadow?ell=1"];   // 楕円体でも通る既存の頁（#43 段 0 の基準線・走らせ台が起動ログの世界を検める）   // t-ellparity＝楕円体の測る台（#43 段 0）＝各機能の描いた位置と projectLL の差を球と楕円体の両方で・既知の失敗は tests/ell-known.json・g=cache＝列チャンク層のキャッシュが球と楕円体を跨がないか   // t-columnar＝列チャンク層（#90）＝gint と同じ絵・GeoParquet・段 0 の物差し   // t-mlcompat＝MapLibre 互換の爪車（tests/mlcompat-known.json・台帳 maplibre-compat.md）・g=mlt＝MVT と MLT で同じ絵（#88）　t-overlaydepth＝オーバーレイへシーンの深度（#47）・lowmem=1＝LOW_MEM では作らない
// t-linedeco の 2 変種＝基図の line-offset を GL2 の両経路で（md=1＝multi_draw の線分プール／nomd=1＝classic の属性・#49）
// 実時間で回す頁＝render worker 内の動的 import（map.overlay のモジュール）や実 GPU の async init に依る検定。
// 仮想時間（--virtual-time-budget）では worker の import() が永久に解決しない＝偽陽性（2026-09-20 実測）。
const REALTIME = new Set(["t-anno", "t-camera", "t-mllayers", "t-mlstyle", "t-linedeco", "t-tiles3d", "t-marker", "t-footprint", "t-request", "t-sunshadow", "t-dem", "t-qmesh", "t-viewshed", "t-clock", "t-bootview", "t-overlaydepth", "t-mlcompat", "t-mlzoom", "t-elevcell", "t-globefloor", "t-columnar", "t-mlboot", "t-ellparity"]);   // t-elevcell＝実 GPU の R16F FBO（SwiftShader でも回るが実時間で）・t-globefloor＝rAF 待ちが仮想時間では進まず無題（#86 の GL2 変種・2026-09-27）
const LONG = { "t-request": 180, "t-footprint": 120, "t-linedeco": 150, "t-dem": 170, "t-qmesh": 200, "t-bootview": 240, "t-overlaydepth": 150, "t-mlcompat": 300, "t-mlzoom": 120, "t-columnar": 240, "t-mlboot": 180, "t-ellparity": 300 };   // t-bootview＝5 回起動し直す   // 段が多い実描画＝枠を広げる

const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ALL_PAGES.filter(p => ARGS.includes(p.split("?")[0])) : ALL_PAGES;

const stop = await startVite({ cwd: PKG, port: PORT, portEnv: "VGU_PORT", readyUrl: `http://localhost:${PORT}/tests/` });
const fail = await runPages({ pages: PAGES, realtime: REALTIME, long: LONG, urlOf: (page, q) => `http://localhost:${PORT}/tests/${page}.html?${q}` });
stop();
process.exit(fail ? 1 : 0);
