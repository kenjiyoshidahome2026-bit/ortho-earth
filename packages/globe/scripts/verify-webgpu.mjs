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

// t-meshmask＝メッシュ被覆マスクの 4 枠選抜（原点そのままカメラだけ動いて近い 4 区が入れ替わる＝BG の作り直し）
// t-meshmany＝メッシュの可視バッチが 512 を越えても最後まで描く（PB の受け皿を倍々に広げる・cdb-yemen 2026-10-31）
// t-rectlook の 2 変種＝旧 verify:editor（japan）が引数で回していた円ツール・ズーム列の検分（頁が globe へ移ったのでここが宿す）
const ALL_PAGES = ["t-shadow", "t-shadow-terrain", "t-clip", "t-clipgint", "t-clipgint?gintsb=0", "t-clipmap", "t-qmesh", "t-meshmask", "t-meshmany", "t-gintgpu", "t-gintgpu?gintsb=0", "t-gintgpu?gintsb=0&gintlh=16", "t-gintgpu?gintlh=16", "t-gintlayers", "t-gintexpr", "t-gintexprdraw", "t-gintmulti", "t-backfill", "t-anchorfill", "t-rectlook",
	"t-rectlook?tool=circle&v=%235/9/-175&a=-178,9&b=-170,9&zs=7,6,5,4,3",
	"t-rectlook?tool=circle&v=%235/9/-175&a=-178,9&b=-162,9&zs=6&probe=450,325&far=2,-9,3",
	"t-spotlight", "t-linedeco", "t-linegrad", "t-mdparity", "t-shotov",
	"t-linejoin?md=1", "t-linejoin?nomd=1", "t-linedash?md=1", "t-linedash?nomd=1", "t-linefx?md=1", "t-linefx?nomd=1", "t-fillpattern?md=1", "t-fillpattern?nomd=1", "t-linepattern?md=1", "t-linepattern?nomd=1",   // t-linepattern＝線の模様（G-4）   // S-P1-1/3/4/5 の WebGPU 版（2026-10-22）＝線の端と継ぎ・破線・translate/blur・塗りの模様を md／classic の両経路で読み戻す   // t-linedeco＝基図の line-offset を WGSL でも（#49）・t-mdparity＝タイル GPU 常駐プール（md）と classic の絵一致（vt perf plan §4 step A）
	"t-overlaydepth", "t-overlaydepth?lowmem=1",
	"t-copc", "t-copc?v=depth",   // COPC の点群の WebGPU の描き手（copc-gpu.ts＝本体の device と深度を共有・2026-10-23）・?v=depth＝本体の深度で隠れる   // オーバーレイへシーンの深度（#47）＝WebGPU の詰めパス・lowmem=1＝LOW_MEM では作らない
	"t-cluster",   // map.gadget.cluster＝集約の source と層（丸は gint・件数は注記層の GPU の字・2026-10-22）
	"t-wgsl", "t-textgpu", "t-textpass", "t-light", "t-atmo", "t-pbr", "t-ao", "t-globefloor", "t-cogpair",   // t-cogpair＝COG の見比べ（2 枚組アトラス＋境の経度・tellus）
	
	"t-elevcell", "t-elevcell?cpuelev=1",   // 標高セルの GPU 再標本化＝CPU 経路と |Δ|≤f16 1ulp（perf plan P1 step 1）・cpuelev=1＝逃げ道は bit 一致
	"t-mlcompat?g=layers", "t-mlcompat?g=relief", "t-mlcompat?g=vector", "t-mlcompat?g=before", "t-mlcompat?g=extrude", "t-mlcompat?g=mlt", "t-mlcompat?g=cover", "t-container?v=abs", "t-container?v=zero", "t-container?v=novec", "t-container?v=ug", "t-qm", "t-multimap", "t-multimap?v=default", "t-multimap?v=lowmem", "t-multimap?v=gs", "t-multimap?v=sync", "t-compare", "t-compare?v=h", "t-compare?v=ml", "t-inspect", "t-inspect?v=world", "t-inspect?v=ml",   // t-inspect＝検査表示（#174）
	"t-columnar?g=same", "t-columnar?g=depth",
	"t-mlboot?v=default", "t-mlboot?v=ml",
	"t-snapearly?v=default", "t-snapearly?v=style", "t-extrude-size", "t-czml-draw", "t-czml", "t-czml?g=url",   // t-czml-draw＝CZML の時刻再生の描画（#113 段 3）   // 起動直後の撮影＝旧 WebGPU は cam 未着の snapshot を黙って捨て promise が宙吊り
	"t-ellparity?ell=0", "t-ellparity?ell=1", "t-ellparity?g=cache", "t-ellparity?g=scan&ell=1", "t-mlcompat?g=extrude&ell=1", "t-overlaydepth?ell=1",
	"t-postfx", "t-citylights", "t-lights", "t-clouds", "t-plugin?v=gltf",   // t-citylights＝夜の街明かりと夜の色（map.setCityLights／setGrade・2026-10-24）
	"t-three", "t-three?r=webgpu",   // three.js（map.addThree）＝本体 WebGPU の上で WebGLRenderer（深度は遅延の ImageBitmap）・WebGPURenderer（本体の device と深度テクスチャを共有・2026-10-18）
	"t-pvoxel",   // voxel の WebGPU の描き手（@ortho-earth/voxel＝光線行進・本体の device と深度を共有・pick は非同期・2026-10-23）
	"t-psplat",   // Gaussian splat の WebGPU の描き手（@ortho-earth/splat＝SH・GPU の並べ替え・本体の device と深度を共有・pick は非同期・2026-10-18）
	"t-tiles3d-drape",   // 3D Tiles に重ねる絵（map.setMeshImagery＝Cesium3DTileset.imageryLayers・塗る絵の枠と共用＝16 枚の上限・2026-10-30）
	"t-tiles3d-voxel",   // 3D Tiles の voxel（EXT_primitive_voxels＋KHR_implicit_shapes・3DTILES_content_voxels）＝タイルごとの voxel の層・WebGPU で検める（2026-10-23）
	"t-tiles3d-splat",   // 3D Tiles の Gaussian splat（KHR_gaussian_splatting）＝タイルごとの splat の層・当たりは WebGPU で検める（2026-10-18）
	"t-czml-scene",   // CZML の model・polyline・polygon（map.loadCZML・P0 #5・2026-10-25）
	"t-classify",   // 面の貼り付け（map.addClassification＝柱を深度に当てる・stencil の bit7 で 3D だけ／地形だけ・2026-10-25）
	"t-sungpu",   // 日影時間・可視域の GPU 版（2026-10-24）＝描いた 3D Tiles から測り、同じ tileset を読む CPU 版と突き合わせる
	"t-meshfs"];   // t-meshfs＝PLATEAU バッチの OPFS ストア（meshfs.ts）を dedicated worker で実往復（2026-10-16 に apps/ortho-japan から移した・段 5-7）   // t-lights＝局所の光源 point/spot/ambient/hemisphere（W2）   // 後処理 bloom・vignette（PR-8）＝flush の終端の WGSL パス   // 楕円体の測る台（#43 段 0）＝WebGPU の本体でも各機能の描いた位置が projectLL と合うか・既知の失敗は tests/ell-known.json   // 公式例の門 段 2＝idle・night/sky/terrain:false（既定は今と同じ）   // 列チャンク層（#90）＝オーバーレイは WebGL2 だが本体が WebGPU でも同じ絵   // MapLibre 互換の爪車（fill/line/circle の表・pass の重ね順）を WebGPU でも（台帳 R7）・g=mlt＝MVT と MLT で同じ絵（#88）   // t-atmo＝大気散乱（#46 段 1）・t-pbr＝PBR と環境光（段 2）・t-ao＝AO（段 3）   // t-wgsl＝WGSL 全モジュールのコンパイル（ソフトウェア WebGPU でも回る関門）・t-light＝メッシュの光は接地の局所系・模型の sRGB 往復（#46 段 0）
const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ARGS : ALL_PAGES;

const stop = await startVite({ cwd: PKG, port: PORT, portEnv: "VGW_PORT", readyUrl: `http://localhost:${PORT}/tests/` });
const fail = await runPages({
	pages: PAGES, realtime: new Set(PAGES.map(p => p.split("?")[0])),   // 全頁が実時間
	long: Object.fromEntries(PAGES.map(p => [p.split("?")[0], p.startsWith("t-mlcompat") || p.startsWith("t-mdparity") ? 240 : p.startsWith("t-three") || p.startsWith("t-psplat") || p.startsWith("t-pvoxel") || p.startsWith("t-tiles3d-splat") || p.startsWith("t-tiles3d-voxel") || p.startsWith("t-classify") ? 300 : p.startsWith("t-czml-scene") ? 420 : p.startsWith("t-clipmap") ? 150 : p.startsWith("t-mlboot") ? 180 : p.startsWith("t-ellparity") ? 300 : p.startsWith("t-shadow-terrain") || p.startsWith("t-sungpu") ? 150 : p.startsWith("t-qmesh") ? 200 : p.startsWith("t-gintexpr") ? 180 : p.startsWith("t-clouds") || p.startsWith("t-postfx") || p.startsWith("t-plugin") || p.startsWith("t-linepattern") ? 150 : 90])),   // t-mlcompat＝場面が多い（段 8⑤）
	jobs: +process.env.VG_JOBS || 4,   // 4 本ずつ並べる（2026-09-29・実 GPU でも全頁 PASS を 2 回確認）・VG_JOBS=1 で直列
	flags: REALGPU, drag: true, profilePrefix: "og-webgpu", cdpBase: +process.env.VGW_CDP || 9335, pad: 18,
	base: "lang=ja", expectBackend: "webgpu", noBoot: new Set(["t-shadow", "t-clip", "t-clipgint", "t-meshmask", "t-meshmany", "t-gintgpu", "t-gintlayers", "t-gintexpr", "t-gintmulti", "t-wgsl", "t-textgpu", "t-textpass", "t-light", "t-atmo", "t-pbr", "t-ao", "t-globefloor", "t-cogpair", "t-elevcell", "t-meshfs", "t-linegrad"]),   // noBoot＝createRenderer 直叩き（地球儀を起こさない）
	urlOf: (page, q) => `http://localhost:${PORT}/tests/${page}.html?${q}`,
});
stop();
process.exit(fail ? 1 : 0);
