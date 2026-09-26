#!/usr/bin/env node
// 地球儀ホスト（packages/globe）の WebGPU 検定＝実 GPU・実時間（2026-09-24・LAYERS.md 段階 4）。
// 仮想時間に載せない理由：WebGPU の async init（adapter/device の GPU IPC）と仮想時計は両立しない
// ——頁側の時計が先に燃え尽き、worker の rAF が凍った後に device が届く＝「実機では健全なのに CI だけ
// frame1 が来ない」偽陽性になる（2026-08-01 実測）。
// backend は runner が起動ログで検める（T1・2026-09-25）＝WebGPU の無い環境・GL2 へ落ちた起動は FAIL（旧＝runner が
// 全頁に gl2=1 を付けていて createGlobe の 4 頁は WebGL2 で走り、WebGPU 不在の skip も PASS に数えていた）。
// 頁ごとに Chrome を立て直すのは ui-runner の作法と同じ（前の頁の IDB/GPU を次へ漏らさない・9/24 の轍）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages, REALGPU } from "./lib/ui-runner.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VGW_PORT || 5246;

// t-rectlook の 2 変種＝旧 verify:editor（japan）が引数で回していた円ツール・ズーム列の検分（頁が globe へ移ったのでここが宿す）
const ALL_PAGES = ["t-shadow", "t-gintgpu", "t-gintgpu?gintsb=0", "t-gintmulti", "t-backfill", "t-anchorfill", "t-rectlook",
	"t-rectlook?tool=circle&v=%235/9/-175&a=-178,9&b=-170,9&zs=7,6,5,4,3",
	"t-rectlook?tool=circle&v=%235/9/-175&a=-178,9&b=-162,9&zs=6&probe=450,325&far=2,-9,3",
	"t-spotlight", "t-linedeco",   // t-linedeco＝基図の line-offset を WGSL でも（#49）
	"t-overlaydepth", "t-overlaydepth?lowmem=1",   // オーバーレイへシーンの深度（#47）＝WebGPU の詰めパス・lowmem=1＝LOW_MEM では作らない
	"t-wgsl", "t-light", "t-atmo", "t-pbr"];   // t-atmo＝大気散乱（#46 段 1）・t-pbr＝PBR と環境光（段 2）   // t-wgsl＝WGSL 全モジュールのコンパイル（ソフトウェア WebGPU でも回る関門）・t-light＝メッシュの光は接地の局所系・模型の sRGB 往復（#46 段 0）
const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ARGS : ALL_PAGES;

const stop = await startVite({ cwd: PKG, port: PORT, readyUrl: `http://localhost:${PORT}/tests/` });
const fail = await runPages({
	pages: PAGES, realtime: new Set(PAGES.map(p => p.split("?")[0])),   // 全頁が実時間
	long: Object.fromEntries(PAGES.map(p => [p.split("?")[0], 90])),
	flags: REALGPU, drag: true, profilePrefix: "og-webgpu", cdpBase: +process.env.VGW_CDP || 9335, pad: 18,
	base: "lang=ja", expectBackend: "webgpu", noBoot: new Set(["t-shadow", "t-gintgpu", "t-gintmulti", "t-wgsl", "t-light", "t-atmo", "t-pbr"]),   // noBoot＝createRenderer 直叩き（地球儀を起こさない）
	urlOf: (page, q) => `http://localhost:${PORT}/tests/${page}.html?${q}`,
});
stop();
process.exit(fail ? 1 : 0);
