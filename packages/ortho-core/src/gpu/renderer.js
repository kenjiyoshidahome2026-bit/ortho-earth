// WebGPU レンダラ＝gl/renderer.js の臓器移植。
// Phase 1: globe＋基図シーン（fill/line・classic merge 経路）。Phase 2: 標高アトラス（R16F）・地形サーフェス・
// 深度（対数・尾根の遮蔽）・建物押し出し・等高線。公開面は createRenderer と同形 { set, draw, dispose, md, mdMax, gintCtx }。
// md=false＝scene worker は CPU merge フォールバック（?nomd=1 と同じ実証済み経路）で typed array シーンを送ってくる。
// 未搭載（set は握り潰し・描画は素通し）：建物メッシュ・overlay(stencil)・星空/夜面・gint。
//
// WebGL 版との設計差：
// ・uniform は 1 フレーム 1 回の UBO 書込：Frame（512B×5スロット＝base/main/terrain/bld/terrainFar。origin と fog の違いを
//   スロットで表現＝GL の setCommonUniforms＋per-program 上書きの写し）＋DrawP（役割別 6 スロット＝seaGate/lift/色ノブ）。
// ・深度は depth24plus を常設し、パイプライン変種で GL の enable/disable/depthMask を表現
//   （fill/line: off / test-only、terrain: write+polygonOffset≒depthBias、building: test+write）。
// ・標高アトラスは r16float＝CPU で f32→f16 変換（GL は texImage2D がドライバ変換。WebGPU は生バイト渡し）。
//   r16float はコアで filterable＝GL 版が R16F を選んだ理由（全デバイス線形補間）がそのまま活きる。
// ・MSAA 4x 明示（GL の canvas antialias:true と同格）。リサイズは getCurrentTexture が canvas 寸法へ自動追随。
import { cameraState, lonlatTo3D, project, betaOf, ellipsoidOn, sphereRayUniforms, anchorUV } from "../camera.js";
import { seaFbReal } from "../scene.js";
import { resolveWorldPal } from "../worldpal.js";   // 全球ハイプソの正準パレット（テーマ＝view.worldHypso の部分上書き）
import * as mat from "../mat.js";
import { clockNow } from "@ortho-earth/ephem/clock";   // 共通の時計（#42）＝view.clock（{sim,wall,rate}）からその時刻。無ければ実時刻
import { gmstAt, sunSubpoint } from "@ortho-earth/ephem/sun";   // 恒星時と太陽直下点の正本（solar と同じ式）
import { FILL_WGSL, LINE_WGSL, GLOBE_WGSL, TERRAIN_WGSL, BUILDING_WGSL, CONTOUR_WGSL, MESH_WGSL, MESH_TEX_WGSL, SKY_WGSL, OVERLAY_WGSL, RASTER_ATLAS_WGSL, ATLAS_FILL_WGSL,
	TERRAIN_SH_WGSL, FILL_SH_WGSL, LINE_SH_WGSL, BUILDING_SH_WGSL, MESH_SH_WGSL, MESH_TEX_SH_WGSL, GLOBE_SH_WGSL, BUILDING_CAST_WGSL, MESH_CAST_WGSL, MESH_TEX_CAST_WGSL, TERRAIN_CAST_WGSL,
	TERRAIN_CLIP_WGSL, MESH_CLIP_WGSL, MESH_TEX_CLIP_WGSL, FILL_CLIP_WGSL, LINE_CLIP_WGSL, BUILDING_CLIP_WGSL, GLOBE_CLIP_WGSL,
	TERRAIN_SH_CLIP_WGSL, MESH_SH_CLIP_WGSL, MESH_TEX_SH_CLIP_WGSL, FILL_SH_CLIP_WGSL, LINE_SH_CLIP_WGSL, BUILDING_SH_CLIP_WGSL, GLOBE_SH_CLIP_WGSL,
	TERRAIN_CAST_CLIP_WGSL, MESH_CAST_CLIP_WGSL, MESH_TEX_CAST_CLIP_WGSL, BUILDING_CAST_CLIP_WGSL, CLIP_CAP_WGSL, OVERLAY_CLIP_WGSL } from "./wgsl.js";
import { gndMixSlow, ELEV_RESAMPLE_WGSL } from "./wgsl.js";   // ?gndfast=0（perf plan P6 の逃げ道）＝gndMix0 を旧順序へ機械変換／標高セルの GPU 再標本化（P1 step 1）
import { f32ToF16, f16ToF32 } from "./f16.js";   // 標高セルの f16 変換（Float16Array の native 変換・perf plan P1 step 0）・読み戻し（検定）
import { downsampleFlipped, cropResample } from "../elevation.js";   // 標高セルの CPU 退避経路（?cpuelev=1・生タイルの型が想定外）＝GPU 再標本化と同式の正本
import { worldAtlasCell } from "../elevation/worldatlas.js";
import { buildChunkIndex, visibleChunkRuns, shadowChunkRuns, TERR_HMAX_M } from "../terrainlod.js";   // 地形メッシュのチャンク主導 index と視錐台/地平線カリング（perf plan P4 step B）
import { sunVector, shadowWindow, shadowHalfM, shadowBias, bboxInShadowWindow, SH_CAST_HMAX_M } from "../shadow.js";   // 建物の影（点けた時だけ）
import { normClip, clipPlanesFor, packClip, CLIP_MAX, CLIP_F32 } from "../clip.js";   // 断面とクリッピング平面（#111・切った時だけ）
import { groundWindows, windowsKey } from "../ground.js";   // 地面アトラスの 3 段窓（RTT ドレープ・GL と共通）
import { createDepthOutGPU } from "./depthout.js";   // シーンの深度をオーバーレイへ（#47）＝申し出がある時だけ 1 パス足す
import { createAoGPU } from "./ao.js";   // AO（#46 段 3）＝fx.ao の間だけ main パスの後に 4 パス足す（AO・ぼかし縦横・合成）

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)＝gl/renderer.js と同一（?quad4=0 の旧経路）
const CORNERS4 = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);            // 4 隅 A−,A+,B−,B+（perf plan P3）＝index [0,1,2,2,1,3] で旧 CORNERS の三角形 (A−,A+,B−)(B−,A+,B+) と同一
const LINE_IDX = new Uint16Array([0, 1, 2, 2, 1, 3]);
const FRAME_SLOT = 512;    // frame UBO のスロット境界（実使用480B＝FRAME_F32×4・minUniformBufferOffsetAlignment 上限256の倍数）
const FRAME_F32 = 120;     // 480B/4（wgsl.js Frame と厳密対応。詰め順は packFrame 参照。invMvp の枠＝rayF/rayX/rayY/eyeC（#65）・末尾 mesh/farBounds/farP/ellTrig/ellP/cogP/gnd0-3/eyeO/elevOff/sun vec4f 含む）
const SLOT = { base: 0, main: 1, terrain: 2, bld: 3, terrainFar: 4, user: 5 };   // user＝利用者の vector source の塗りと線（MapLibre 互換 段 8⑤）   // terrain/bld は main と同 origin・fog だけ違うスロット。terrainFar＝遠景メッシュパス（mesh=遠窓・farPass=1）   // terrain/bld は main と同 origin・fog だけ違うスロット。terrainFar＝遠景メッシュパス（mesh=遠窓・farPass=1）
const PARAM_SLOT = 256;    // DrawP（3×vec4=48B）のスロット境界
const OVERLAY_LIFT = 3;   // overlay（外部ベクタ線/面）を地形から m 単位で浮かせる＝地形メッシュとの z-fight（境界線の明滅・消失）を断つ。gint drape(2m)と同族＝高ズームで浮きが見えない最小値（15mは上げすぎ・本人指摘2026-08-12）
const ROLE = { normal: 0, water: 1, seaFb: 2, terrain: 3, bld: 4, contour: 5, mesh: 6, fadeNormal: 7, fadeWater: 8, fadeSeaFb: 9, fadeBld: 10, user: 11 };   // fade*=クロスフェード中の新シーン用（p0.w=α）・user＝利用者の vector の層（基図の濃さに従わない＝p0.w=1・段 8⑤）
const N_ROLES = 12;
const FADE_MS = 180;   // classic merge のシーン一括差し替えをフェードに（「ポンッ」→融ける。モバイルのパラパラ感対策）
const PL_BATCH_SLOT = 256; // mesh per-batch UBO（meshOrigin+cullBack, clipMesh, alpha, pbr0, emis, lp, sh[9]＝240B・#46 段 2）のスロット境界（dynamic offset）
const MAX_PL_BATCH = 512;  // 1フレームに描く可視バッチ上限（超過は log して打ち切り）
const MAX_MESH_MASKS = 4;

// f32→f16 は ./f16.js（Float16Array の native 変換＋旧ループのフォールバック・perf plan P1 step 0）

// ── 空の環境光（#46 段 2）＝段 1 と同じ散乱式（wgsl.js atmScatter の JS 写し・帯の幅 k と太陽の強さも同じ）で天球を積み、SH9（照度の係数 A_l 込み）と
// 太陽の強さ（地表での透過率込み）を「原点で水平な白＝1」に正規化して返す（自動露出＝屋根の明るさが時刻で大きく動かない・壁との比が動く）。
// 夜（太陽が地平線の下）は E_ref の床で割る＝空の残光がそのまま出る（黒くならないのは固定光の重み lp.w が受け持つ）。
// 鍵（太陽・原点 0.5°・ノブ）で記憶＝毎フレームは掛け算だけ。方向は Fibonacci の 96 点（上半球＝空・下半球＝地面の反射 albedo 0.3）。
const SKY_N = 96, SKY_DIRS = (() => { const d = []; const ga = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < SKY_N; i++) { const z = 1 - 2 * (i + 0.5) / SKY_N, r = Math.sqrt(1 - z * z), t = ga * i; d.push([r * Math.cos(t), r * Math.sin(t), z]); } return d; })();
function skyEnvCompute(sun, oPt, { k = 4, sunI = 20, fill = 0.35 } = {}) {
	const RT = 1 + 0.0157 * k, HR = 0.001256 * k, HM = 0.000188 * k, BR = [36.9 / k, 86.0 / k, 210.9 / k], BM = 133.8 / k, BME = 147.2 / k, G = 0.76, N = 8, NS = 3;
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], add = (a, b, t) => [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t], len = a => Math.hypot(a[0], a[1], a[2]);
	const shell = (o, d, r) => { const b = dot(o, d), c = dot(o, o) - r * r, h = b * b - c; if (h < 0) return [-1, -1]; const q = Math.sqrt(h); return [-b - q, -b + q]; };
	const dens = p => { const h = Math.max(len(p) - 1, 0) / k; return [Math.exp(-h / 0.001256), Math.exp(-h / 0.000188)]; };
	const optSun = (p, s) => { const b = dot(p, s); if (b < 0 && dot(p, p) - b * b < 1) return [1e9, 1e9]; const sh = shell(p, s, RT), ds = Math.max(sh[1], 0) / NS; let r = 0, m = 0; for (let i = 0; i < NS; i++) { const q = dens(add(p, s, ds * (i + 0.5))); r += q[0] * ds; m += q[1] * ds; } return [r, m]; };
	const scatter = (o, d, t0, t1, s) => {   // 戻り＝放射輝度 L（rgb・sunI 込み）
		const mu = dot(d, s), phR = 3 / (16 * Math.PI) * (1 + mu * mu), g2 = G * G, phM = 3 / (8 * Math.PI) * (1 - g2) * (1 + mu * mu) / ((2 + g2) * Math.pow(1 + g2 - 2 * G * mu, 1.5));
		const ds = (t1 - t0) / N; let oR = 0, oM = 0; const sR = [0, 0, 0], sM = [0, 0, 0];
		for (let i = 0; i < N; i++) {
			const pp = add(o, d, t0 + ds * (i + 0.5)), dn = dens(pp); oR += dn[0] * ds; oM += dn[1] * ds;
			const os = optSun(pp, s), odR = oR + os[0], odM = oM + os[1];
			for (let c = 0; c < 3; c++) { const tr = Math.exp(-(BR[c] * odR + BME * odM)); sR[c] += tr * dn[0] * ds; sM[c] += tr * dn[1] * ds; }
		}
		return [0, 1, 2].map(c => (sR[c] * BR[c] * phR + sM[c] * BM * phM) * sunI);
	};
	const up = [oPt[0], oPt[1], oPt[2]], lu = len(up); for (let i = 0; i < 3; i++) up[i] /= lu;
	const e0 = [up[2], 0, -up[0]], le = len(e0), east = le > 1e-6 ? e0.map(v => v / le) : [1, 0, 0];
	const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
	const o = up.map(v => v * (1 + 1e-6));
	// 太陽：地表での透過率（sunI×T）と高度
	const sinAlt = dot(up, sun);
	const od = optSun(o, sun), Tsun = [0, 1, 2].map(c => Math.exp(-(BR[c] * od[0] + BME * od[1])));
	const Esun = Tsun.map(t => sunI * t);   // 法線に垂直な面の照度（rgb）
	// 空の放射輝度（上半球）と水平面の空の照度
	const L = new Array(SKY_N), w = 4 * Math.PI / SKY_N; let Eh = [0, 0, 0];
	for (let i = 0; i < SKY_N; i++) {
		const dl = SKY_DIRS[i]; if (dl[2] <= 0) { L[i] = null; continue; }
		const d = [0, 1, 2].map(c => east[c] * dl[0] + north[c] * dl[1] + up[c] * dl[2]);
		const sh = shell(o, d, RT); L[i] = scatter(o, d, 0, Math.max(sh[1], 0), sun);
		for (let c = 0; c < 3; c++) Eh[c] += L[i][c] * dl[2] * w;
	}
	const Eg = [0, 1, 2].map(c => 0.3 / Math.PI * (Esun[c] * Math.max(sinAlt, 0) + Eh[c]));   // 地面の放射輝度（albedo 0.3・太陽＋空）
	for (let i = 0; i < SKY_N; i++) if (!L[i]) L[i] = Eg;
	// SH9 の射影→照度の係数（A0=π, A1=2π/3, A2=π/4）→E_ref で正規化
	const Y = d => { const [x, y, z] = d; return [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)]; };
	const A = [Math.PI, 2 * Math.PI / 3, 2 * Math.PI / 3, 2 * Math.PI / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
	const sh = new Float32Array(36);
	for (let i = 0; i < SKY_N; i++) { const y = Y(SKY_DIRS[i]); for (let j = 0; j < 9; j++) for (let c = 0; c < 3; c++) sh[j * 4 + c] += L[i][c] * y[j] * w; }
	const Eref = Math.max((Esun[0] + Esun[1] + Esun[2]) / 3 * Math.max(sinAlt, 0.6) + (Eh[0] + Eh[1] + Eh[2]) / 3, sunI * 0.03);   // 水平な白＝1（夜は床）。低い太陽は sinAlt でなく 0.6 で割る＝朝夕に太陽を向く壁が飛ばない（屋根は暗くなる＝朝夕の読み）
	for (let j = 0; j < 9; j++) for (let c = 0; c < 3; c++) sh[j * 4 + c] *= A[j] / Eref;
	sh[3] = fill;   // sh[0].w＝fill（昼でも固定光を混ぜる割合）
	return { sh, lp: Float32Array.of(Esun[0] / Eref, Esun[1] / Eref, Esun[2] / Eref, 0), Eref };
}

export async function createRendererGPU(canvas, rOpts = {}) {
	if (typeof navigator === "undefined" || !navigator.gpu) throw new Error("WebGPU unavailable");
	const adapter = await navigator.gpu.requestAdapter(rOpts.powerPreference ? { powerPreference: rOpts.powerPreference } : undefined);
	if (!adapter) throw new Error("WebGPU adapter unavailable");
	// A/B 計測用の GPU 識別（WebGL の WEBGL_debug_renderer_info 相当）。info は環境で空の事があるので緩く。
	const ai = adapter.info || {};
	const gpuInfo = [ai.vendor, ai.architecture, ai.device, ai.description].filter(Boolean).join(" ") || "unknown";
	const wantTQ = !rOpts.noTQ && !!(adapter.features && adapter.features.has && adapter.features.has("timestamp-query"));   // noTQ＝?notq=1 の切り分けフラグ（iOS Safari 診断 2026-08-02）
	// float32-blendable＝gint コロプレス塗り(idfill)の winding 和を rg32float へ加算する前提。
	// 無いと rg16float(半精度・整数2048まで)へ落ち、市区町村1919個の fid(最大1920)×加算途中和が精度崩壊し
	// 塗りに穴が出る（GL 経路は EXT_float_blend で RG32F を選ぶのと同義・2026-08-12 実機WebGPUで判明）。
	const reqFeats = [];
	if (wantTQ) reqFeats.push("timestamp-query");
	if (adapter.features?.has?.("float32-blendable")) reqFeats.push("float32-blendable");
	// maxTextureDimension2D＝既定8192のままだと、縦長ウィンドウ×高dpr（ブラウザ拡大率等）でスワップチェイン/
	// 画面サイズ従属テクスチャ（gint idTex 等）が上限超えで即死する（実測 2026-09-02: 2042x9677）。アダプタの
	// 実力値（Apple系=16384）をそのまま要求＝タダで倍の頭上空間。適用失敗の互換性リスクはアダプタ自己申告値ゆえ無い
	const device = await adapter.requestDevice({
		...(reqFeats.length ? { requiredFeatures: reqFeats } : {}),
		requiredLimits: { maxTextureDimension2D: adapter.limits?.maxTextureDimension2D || 8192 },
	});
	const ctx = canvas.getContext("webgpu");
	if (!ctx) throw new Error("webgpu context unavailable");
	const format = navigator.gpu.getPreferredCanvasFormat();
	// COPY_SRC＝snapshot（shot/print）が resolve 済みの canvas テクスチャを copyTextureToBuffer で読む。
	// alphaMode:"opaque"＝**キャンバスのα channel を合成に使わせない**（既定値でもある）。地図は画面全面を
	// 不透明に塗る＝αは常に1のはずで、premultiplied との差はゼロ……**αが1でない端末を除けば**。
	// αがどこかで落ちると、透けた先はページ背景 #0b1021（起動スプラッシュの紺）＝画面が暗転して
	// 「白黒反転」に見える。Android 実機の反転（?gl2=1では正常・?nofade/noterr/nogint すべてで再現）は
	// この形の疑いが濃い＝合成をαから切り離して構造的に断つ（2026-08-03）。
	ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
	const isBGRA = format === "bgra8unorm";   // Mac の既定＝readback は BGRA＝RGBA へ swizzle
	// WebKit(Safari) は GPUDevice の EventTarget 実装が無い版がある＝onuncapturederror 属性も併用（両対応・二重発火なし＝どちらか一方しか効かない環境前提）
	const onUncap = e => console.error("[gpu] uncaptured:", e.error?.message || e.error);
	if (device.addEventListener) device.addEventListener("uncapturederror", onUncap);
	else if ("onuncapturederror" in device) device.onuncapturederror = onUncap;

	// --- iOS Safari 診断（2026-08-02）：沈黙故障の可視化 ---
	// パイプラインの WGSL コンパイル失敗は非同期＝環境によっては console にも uncaptured にも出ず、
	// 無効パイプラインを含む submit が丸ごと落ちて「クリアすら出ない白画面」になる。
	// ①全シェーダの getCompilationInfo で行番号つきの失敗を暴く ②init/初回フレームを errorScope で包む。
	// 発見物は gpuErrors へ＝renderworker が frame1 後に main へ転写（モバイルでも見える）。
	const gpuErrors = [];
	let frame1Scoped = 0;
	const gpuErr = (where, msg) => { const t = `${where}: ${msg}`; gpuErrors.push(t); console.error("[gpu] " + t); };
	const mkMod = (code, label) => {
		if (rOpts.gndFast === false) code = gndMixSlow(code);   // 逃げ道（perf plan P6）＝A/B と切り分け。既定は早期 return の新順序
		const m = device.createShaderModule({ code });
		m.getCompilationInfo && m.getCompilationInfo().then(info => {
			for (const x of info.messages || []) if (x.type === "error") gpuErr(`WGSL ${label}`, `${x.lineNum}:${x.linePos} ${x.message}`);
		});
		return m;
	};
	device.pushErrorScope("validation");   // init 全体（pipeline/texture/buffer 作成）を包む＝pop は return 直前

	// --- GPU 実時間（timestamp-query）＝GL の EXT_disjoint_timer_query_webgl2 相当 ---
	// パス単位で begin/end を打ち（writeTimestamp は仕様から撤去済＝pass の timestampWrites 一択）、
	// flush で resolveQuerySet→staging コピー→mapAsync＝数フレーム遅れの非同期回収（GL と同じ運用）。
	// 消費者は renderworker の tqFeed：動的解像度の busyMs・GPU格付け(gpuFast＝静止時の手前詳細化)・
	// perf 行の gpuMap/gpuGint が WebGPU でも復活する。未対応 GPU は tq=null＝従来の壁時計フォールバック。
	// ⚠Chrome は値を~100µs に量子化＝ms 級のパス計測には十分（GL タイマも同程度のノイズ）。
	const TQ_N = 16;   // 1フレームの計測パス上限×2（begin/end）。枠切れは打たない＝計測を落とすだけで本業は止めない
	let tq = wantTQ ? {   // 自己修復で null 化あり（下 tqOff）
		qs: device.createQuerySet({ type: "timestamp", count: TQ_N }),
		resolve: device.createBuffer({ size: TQ_N * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
		staging: Array.from({ length: 3 }, () => ({ buf: device.createBuffer({ size: TQ_N * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false, spans: null, n: 0 })),
		idx: 0, spans: [], ready: [],
	} : null;
	// timestampWrites を受け付けない環境（WebKit の版差等）＝初回の失敗で TQ を丸ごと畳む（以後 undefined＝無計測で本業続行）
	function tqOff(err) {
		console.warn("[gpu] timestamp-query disabled (unavailable in this environment):", err && (err.message || err));
		try { tq && tq.qs.destroy && tq.qs.destroy(); } catch {}
		tq = null;
	}
	function passTS(tag) {   // beginRenderPass の timestampWrites（未対応/枠切れ＝undefined＝無計測）
		if (!tq || tq.idx + 2 > TQ_N) return undefined;
		const i0 = tq.idx; tq.idx += 2;
		tq.spans.push({ tag, i0 });
		return { querySet: tq.qs, beginningOfPassWriteIndex: i0, endOfPassWriteIndex: i0 + 1 };
	}

	// premultiplied 合成（gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA) と同じ）
	const BLEND = {
		color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
		alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
	};
	// MSAA 4x＝WebGL 版 canvas の antialias:true と同格。?msaa=0（rOpts.msaa1）＝常時 1x 直描き＝
	// 「MSAA テクスチャを複数パスで store→load し終端で resolve」という、タイル型GPU（Adreno/Mali）の
	// ドライバが最も踏み外しやすい経路を丸ごと外す切り分けノブ（Android 実機の黒背景 2026-08-03。
	// Vulkan 界の定石でも multisampled attachment の store/load は避けよ＝ARM 公式ガイダンス）。
	// 遷移時AA（2026-08-19）：この store/load/resolve 帯域が ?perf=1 実測でフレーム最大の固定費と判明＝
	// カメラ遷移中は draw(opts.aa===false) で 1x 直描きへ落とし、静止フレームだけ SAMPLES(4x) で一枚描く
	//（静止時詳細化と同じ思想。動きの最中のエッジは見えない＝実測で動的解像度の降段も消える）。
	const SAMPLES = rOpts.msaa1 ? 1 : 4;   // 品質段（静止フレームの段数）。msaa1＝常時1x（従来どおり）
	// 描画の質の旗（#46・2026-09-26）＝globe の opts.render と ?fx= を boot/tier.js renderFx が裁いた結果（LOW_MEM・GL2 は全部 false）。
	// 段 0 は旗を運ぶだけ＝段 1（atmosphere）・段 2（pbr）・段 3（ao）が順に読む。無指定＝全部 false＝従来の絵。
	const FX = { atmosphere: false, pbr: false, ao: false, ...(rOpts.fx || {}) };
	const DEPTH = "depth24plus-stencil8";   // stencil は gint（winding 塗り）が同一アタッチメントで使う（renderer 自身は不使用＝既定 keep で不干渉）
	const target = { format, blend: BLEND };
	const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

	// 共有レイアウト：group(0)=Frame＋標高（テクスチャは VS でも引く＝ドレープ）、group(1)=DrawP（役割別）
	const bgl0 = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: VF, buffer: {} },
		{ binding: 1, visibility: VF, texture: { sampleType: "float" } },
		{ binding: 2, visibility: VF, sampler: { type: "filtering" } },
		{ binding: 3, visibility: VF, texture: { sampleType: "float" } },   // 遠景層（far）アトラス。elev() が静的参照＝FRAME を含む全モジュールのレイアウトに必須
		{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // ユーザ COG（FRAME 全モジュール宣言＝未使用は dummy）
		{ binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: {} },                          // Cog0P（bbox+has）
		{ binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // 地面アトラス 近窓（未使用は dummy）
		{ binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // 同・中窓
		{ binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // 同・遠窓
		{ binding: 9, visibility: GPUShaderStage.FRAGMENT, buffer: {} },                          // GndP（窓 bbox×3＋有効数）
		{ binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },     // アトラスのサンプラ（mips・異方性・clamp）
		{ binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },  // 同・4 段目（前景あり時）
	] });
	const bgl1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
	const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
	// building group(2)＝メッシュ被覆マスク（count+bbox UBO＋4テクスチャ＋sampler）。メッシュ無しでも count=0 で素通し
	const bglMask = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
	] });
	const bldLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglMask] });
	// mesh group(2)＝per-batch UBO（meshOrigin+cullBack, clipMesh）を dynamic offset で切替。
	// cullBack(meshOrigin.w) は FS が裏面判定に読む＝visibility は VERTEX|FRAGMENT 両方。
	const bglPlBatch = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }] });
	const plLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglPlBatch] });
	// 模型（glb 直読み・2026-09-20）＝メッシュ派生パイプライン。group(3)=サンプラ＋テクスチャ（バッチごと）
	const bglPlTex = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }] });   // ラスタのアトラス合成が流用（サンプラ＋1 枚）
	const bglPlTex5 = device.createBindGroupLayout({ entries: [0, 1, 2, 3, 4, 5].map(b => b === 0 ? { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } } : { binding: b, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }) });   // 模型＝baseColor＋MR＋法線＋AO＋発光（#46 段 2）
	const plTexLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglPlBatch, bglPlTex5] });

	const fillMod = mkMod(FILL_WGSL, "fill");
	const lineMod = mkMod(LINE_WGSL, "line");
	const globeMod = mkMod(GLOBE_WGSL, "globe");
	const terrMod = mkMod(TERRAIN_WGSL, "terrain");
	const bldMod = mkMod(BUILDING_WGSL, "building");
	const contMod = mkMod(CONTOUR_WGSL, "contour");
	const plMod = mkMod(MESH_WGSL, "mesh");
	const plTexMod = mkMod(MESH_TEX_WGSL, "meshTex");
	// 画像タイル層（raster.js・2026-09-21・RTT ドレープ）：アトラス合成パイプライン＝group(0)=per-tile UBO（dynamic offset）・group(1)=サンプラ＋テクスチャ（bglPlTex 流用）
	const rasAtlasMod = mkMod(RASTER_ATLAS_WGSL, "rasterAtlas");
	const bglRasP = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }] });
	const rasAtlasLayout = device.createPipelineLayout({ bindGroupLayouts: [bglRasP, bglPlTex] });
	const atlasFillMod = mkMod(ATLAS_FILL_WGSL, "atlasFill");   // ベクタ塗りを地面アトラスへ（3D 限定）＝group(0)=Frame（origin/標高）・group(1)=DrawP（未使用）・group(2)=AtlP
	const atlasFillLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglRasP] });
	const RASTER_BUFS = [
		{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },   // a_delta（タイル北西隅からの dLL）
		{ arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },   // a_uv
	];
	// 深度状態の変種＝GL の enable/disable/depthMask/polygonOffset の写し（深度アタッチメントは常設）
	const dsOff = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always" };
	const dsTest = { format: DEPTH, depthWriteEnabled: false, depthCompare: "less-equal" };
	const dsWrite = { format: DEPTH, depthWriteEnabled: true, depthCompare: "less-equal" };
	const dsTerrain = { ...dsWrite, depthBias: 4, depthBiasSlopeScale: 1.0 };   // gl.polygonOffset(1.0, 4.0) 相当＝ドレープした基図が z-fight せず表に出る
	// 建物マスク（面ドレープの深度統合・2026-08-14）：建物 FS が通った画素に stencil bit7(0x80) を刻む
	//（reference は建物ドロー直前に 0x80）。gint の cover/idResolve が「建物の陰」を画素単位でスキップする根拠。
	// 扇形状の深度テストは不可（fan は winding の便法＝内部 frag は地形面に乗っていない）＝この bit が唯一の正解。
	const SBLD = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" };
	const dsWriteBld = { ...dsWrite, stencilFront: SBLD, stencilBack: SBLD, stencilWriteMask: 0x80 };
	const dsWriteBldNoZ = { ...dsWriteBld, depthWriteEnabled: false };   // 模型の半透明（BLEND）＝深度テストはするが書かない
	const FILL_BUFS = [
		{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },   // a_delta
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "unorm8x4" }] },    // a_color
	];
	const LINE_BUFS = [
		{ arrayStride: 8, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },     // corner
		{ arrayStride: 8, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },   // p1
		{ arrayStride: 8, stepMode: "instance", attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },   // p2
		{ arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 3, offset: 0, format: "unorm8x4" }] },    // color
		{ arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 4, offset: 0, format: "float32" }] },     // half(CSS px)
		{ arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 5, offset: 0, format: "float32x3" }] },  // line-offset #49＝[off CSS px, tS, tE]
	];
	// globe は Frame 非依存＝専用レイアウト。旧 "auto" は遷移時AAのセット複製で bind group を共有できない＝明示化
	// binding1-3＝全球ハイプソ（標高R90全球窓＋気候場）。未使用時も dummy を張る（レイアウトは常に完全充足）
	const bglGlobe = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: VF, buffer: {} },
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
		{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {} },   // WorldPal（世界パレット＝terrain 側と同一バッファ）
		{ binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // far床（未使用は dummy）
		{ binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // ユーザ COG（未使用は dummy）
		{ binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: {} },                          // CogP（bbox+has）
		{ binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // 地面アトラス 近窓（球の床）
		{ binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },   // 同・中窓
		{ binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },  // 同・遠窓
		{ binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer: {} },                         // GGndP
		{ binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },  // 同・4 段目
	] });
	const globeLayout = device.createPipelineLayout({ bindGroupLayouts: [bglGlobe] });
	// terrain group(2)＝気候場（全球ハイプソの cross-blend）。未着は dummy（DrawP p2.z=0 で不使用）
	const bglClim = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
		{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },   // WorldPal（globe 側 binding(4) と同一バッファ＝同色契約）
	] });
	const terrLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglClim] });
	// 星空劇場（z<4）：Sky UBO（group0）＋星座線の色 UBO（group1）。深度無関係の背景（dsOff）
	const skyMod = mkMod(SKY_WGSL, "sky");
	const bglSky = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
	const bglSkyLine = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
	const skyLayout = device.createPipelineLayout({ bindGroupLayouts: [bglSky] });
	const skyLineLayout = device.createPipelineLayout({ bindGroupLayouts: [bglSky, bglSkyLine] });
	const STAR_BUF = [{ arrayStride: 32, stepMode: "instance", attributes: [   // cel.xyz + rgba + size（GL の 8f interleave）
		{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x4" }, { shaderLocation: 2, offset: 28, format: "float32" }] }];
	// overlay（外部ベクタ）：per-scene の Frame(group0)＋DrawP(group1) を dynamic offset で切替。
	// stencil-then-cover 塗り＋境界線（線は LINE_WGSL 流用）。深度 off・stencil で巻き数塗り。
	const ovMod = mkMod(OVERLAY_WGSL, "overlay");
	const bglOvFrame = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } },
		{ binding: 1, visibility: VF, texture: { sampleType: "float" } },
		{ binding: 2, visibility: VF, sampler: { type: "filtering" } },
		{ binding: 3, visibility: VF, texture: { sampleType: "float" } },   // 遠景層（LINE/BUILDING/OVERLAY モジュールの elev() が静的参照）
	] });
	const bglOvParam = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }] });
	const ovLayout = device.createPipelineLayout({ bindGroupLayouts: [bglOvFrame, bglOvParam] });
	const dsOvStencil = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always",   // fan→巻き数（FRONT+1/BACK-1）
		stencilFront: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "increment-wrap" },
		stencilBack: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "decrement-wrap" }, stencilWriteMask: 0xFF };
	const dsOvCover = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always",     // stencil≠0 を塗り→0 へ戻す
		stencilFront: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "zero" },
		stencilBack: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "zero" }, stencilWriteMask: 0xFF };
	// 周辺マスク用（overlayHi の o.mask）：stencil==0（地物の外側）を暗く塗る逆カバー＋内側stencilの後始末。
	// 「地物を塗りつぶす」でなく「周辺を暗くして地物を浮かせる」＝データ（基図・境界）が読める（本人裁定2026-08-14）。
	const dsOvMaskCover = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always",
		stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" },
		stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilWriteMask: 0 };
	const dsOvZero = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always",
		stencilFront: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "zero" },
		stencilBack: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "zero" }, stencilWriteMask: 0xFF };
	// gintBld（moj筆ドレープ線/点）＝BUILDING_WGSL 流用・独自 origin（dynamic frame）＋DrawP(dynamic)＋mask(count0)。
	// GL_LINES/GL_POINTS → topology line-list/point-list。深度で地形/尾根に遮蔽（建物と同じ dsWrite）。
	const gbLayout = device.createPipelineLayout({ bindGroupLayouts: [bglOvFrame, bglOvParam, bglMask] });
	const GB_BUFS = [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },   // a_pos (dlon,dlat,hWorld)
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },      // a_shade
		{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },    // a_anchor
	];
	// ── パイプライン工場（遷移時AA）：multisample.count はパイプラインに焼き込み＝実行時切替は「セット取替」
	// でしか出来ない。セットは sampleCount 毎に遅延生成・恒久キャッシュ（1x/4x の2つが上限）。
	function buildPipes(sc) {
		const ms = { count: sc };
		const pipe = (mod, bufs, ds, fsEntry = "fs", lay = layout, cull = "none") => device.createRenderPipeline({
			layout: lay,
			vertex: { module: mod, entryPoint: "vs", buffers: bufs },
			fragment: { module: mod, entryPoint: fsEntry, targets: [target] },
			primitive: { topology: "triangle-list", cullMode: cull },
			depthStencil: ds, multisample: ms,
		});
		return {
			fillOff: pipe(fillMod, FILL_BUFS, dsOff),
			fillTest: pipe(fillMod, FILL_BUFS, dsTest),
			lineOff: pipe(lineMod, LINE_BUFS, dsOff),
			lineTest: pipe(lineMod, LINE_BUFS, dsTest),
			terrain: pipe(terrMod, [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }], dsTerrain, "fs", terrLayout),   // group(2)=気候場（全球ハイプソ）
			bld: pipe(bldMod, [
				{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },   // a_pos (dlon,dlat,hWorld)
				{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },      // a_shade
				{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },    // a_anchor
			], dsWriteBld, "fs", bldLayout),   // group(2)=メッシュ被覆マスク。stencil bit7=建物マスク（gint 面ドレープの深度統合）
			// 建物メッシュ（LOD2 等）：頂点=重心相対 pos(f32x3)＋int8量子化法線(snorm8x4・stride4)。裏面カリングは FS（両面データ）＝cullMode none
			mesh: pipe(plMod, [
				{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },   // a_pos（重心相対 delta）
				{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "snorm8x4" }] },     // a_normal（xyz+pad・FS で normalize）
			], dsWriteBld, "fs", plLayout),   // stencil bit7=建物マスク（bld と同じ）
			meshTex: pipe(plTexMod, [   // 模型（glb 直読み）＝メッシュ派生＋uv/頂点色＋テクスチャ group(3)
				{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
				{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "snorm8x4" }] },
				{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },   // a_uv
				{ arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: "unorm8x4" }] },    // a_col（baseColorFactor×COLOR_0）
			], dsWriteBld, "fs", plTexLayout),
			meshTexBlend: pipe(plTexMod, [   // 模型の半透明（alphaMode=BLEND）＝同シェーダ・深度書き込み無し（target の blend は premultiplied 既定）
				{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
				{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "snorm8x4" }] },
				{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },
				{ arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: "unorm8x4" }] },
			], dsWriteBldNoZ, "fs", plTexLayout),
			contour: pipe(contMod, undefined, dsOff),
			globe: device.createRenderPipeline({
				layout: globeLayout,
				vertex: { module: globeMod, entryPoint: "vs" },
				fragment: { module: globeMod, entryPoint: "fs", targets: [target] },
				primitive: { topology: "triangle-list" },
				depthStencil: dsOff, multisample: ms,
			}),
			wdCover: device.createRenderPipeline({   // 海面下の陸地の cover＝landK=1 強制のハイプソ本体（globe と同一バインド・巻き数 ref のみ塗り＝球体カリング）
				layout: globeLayout,
				vertex: { module: globeMod, entryPoint: "vs" },
				fragment: { module: globeMod, entryPoint: "fsWdepr", targets: [target] },
				primitive: { topology: "triangle-list" },
				depthStencil: dsOvCover, multisample: ms,
			}),
			grat: device.createRenderPipeline({   // 10度レチクル（v1 geoGraticule10 移植・globe と同一バインド・出現度=G.seaC.w）
				layout: globeLayout,
				vertex: { module: globeMod, entryPoint: "vs" },
				fragment: { module: globeMod, entryPoint: "fsGrat", targets: [target] },
				primitive: { topology: "triangle-list" },
				depthStencil: dsOff, multisample: ms,
			}),
			stars: device.createRenderPipeline({
				layout: skyLayout, vertex: { module: skyMod, entryPoint: "vsStar", buffers: STAR_BUF },
				fragment: { module: skyMod, entryPoint: "fsStar", targets: [target] },
				primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms,
			}),
			starLine: device.createRenderPipeline({
				layout: skyLineLayout, vertex: { module: skyMod, entryPoint: "vsLine", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
				fragment: { module: skyMod, entryPoint: "fsLine", targets: [target] },
				primitive: { topology: "line-list" }, depthStencil: dsOff, multisample: ms,
			}),
			night: device.createRenderPipeline({
				layout: skyLayout, vertex: { module: skyMod, entryPoint: "vsNight" },
				fragment: { module: skyMod, entryPoint: "fsNight", targets: [target] },
				primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms,
			}),
			ovStencil: device.createRenderPipeline({
				layout: ovLayout, vertex: { module: ovMod, entryPoint: "vsStencil", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
				fragment: { module: ovMod, entryPoint: "fsNull", targets: [{ format, writeMask: 0 }] },   // 色は書かない（stencil のみ）
				primitive: { topology: "triangle-list" }, depthStencil: dsOvStencil, multisample: ms,
			}),
			ovCover: device.createRenderPipeline({
				layout: ovLayout, vertex: { module: ovMod, entryPoint: "vsCover" },
				fragment: { module: ovMod, entryPoint: "fsCover", targets: [target] },
				primitive: { topology: "triangle-list" }, depthStencil: dsOvCover, multisample: ms,
			}),
			ovMaskCover: device.createRenderPipeline({
				layout: ovLayout, vertex: { module: ovMod, entryPoint: "vsCover" },
				fragment: { module: ovMod, entryPoint: "fsCover", targets: [target] },
				primitive: { topology: "triangle-list" }, depthStencil: dsOvMaskCover, multisample: ms,
			}),
			ovZero: device.createRenderPipeline({
				layout: ovLayout, vertex: { module: ovMod, entryPoint: "vsCover" },
				fragment: { module: ovMod, entryPoint: "fsNull", targets: [{ format, writeMask: 0 }] },
				primitive: { topology: "triangle-list" }, depthStencil: dsOvZero, multisample: ms,
			}),
			ovLine: device.createRenderPipeline({   // 境界線/N02線＝LINE_WGSL 流用（dynamic frame レイアウト）
				layout: ovLayout, vertex: { module: lineMod, entryPoint: "vs", buffers: LINE_BUFS },
				fragment: { module: lineMod, entryPoint: "fs", targets: [target] },
				primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms,
			}),
			gbLine: device.createRenderPipeline({
				layout: gbLayout, vertex: { module: bldMod, entryPoint: "vs", buffers: GB_BUFS },
				fragment: { module: bldMod, entryPoint: "fs", targets: [target] },
				primitive: { topology: "line-list" }, depthStencil: dsWrite, multisample: ms,
			}),
			gbPoint: device.createRenderPipeline({
				layout: gbLayout, vertex: { module: bldMod, entryPoint: "vs", buffers: GB_BUFS },
				fragment: { module: bldMod, entryPoint: "fs", targets: [target] },
				primitive: { topology: "point-list" }, depthStencil: dsWrite, multisample: ms,
			}),
		};
	}
	const pipeSets = new Map();
	const pipesFor = sc => { let p = pipeSets.get(sc); if (!p) { p = buildPipes(sc); pipeSets.set(sc, p); } return p; };
	let P = pipesFor(SAMPLES);   // 品質段（既定4x）は起動時に先行コンパイル＝初回フレーム検証スコープで検札。1x は初の遷移フレームで遅延生成

	// ── 建物の影（リアルタイム shadow map・2026-09-24）。set("shadow",{on:true}) の間だけ、ここの資源・シェーダ・パイプラインを作って使う。
	// 影なしのフレームは従来と同じパイプライン・bind group・パスのまま（影響ゼロの約束）＝消したら資源を返す（パイプラインは再点灯用に保持）。
	// 流れ：太陽の正射影（shadow.js）で建物（基図の押し出し＋メッシュ）の深度を描く別パス → 受け手（地形・球の床・塗り・線・建物・メッシュ）の派生 FS が比べて暗くする。
	let shadow = { on: false };
	const sunF = new Float32Array([0, 1, 0, 1]);   // Frame.sun（#46 段 0）＝draw() が共通の時計から毎フレーム詰める（方向 xyz＋昼の度合い w）
	const envCache = { key: "", env: { sh: new Float32Array(36), lp: new Float32Array([0, 0, 0, 1]) } };   // 空の環境光（#46 段 2）＝fx.pbr off は全 0＋固定光の重み 1（PB に入るだけで読まれない）
	let sh = null;
	const SH_N = rOpts.lowMem ? 1024 : 2048;   // 深度テクスチャの一辺（2048²×4B＝16MB・点けている間だけ）
	const SH_FADE_R0 = 0.7;   // 縁のフェードが始まる半径（窓の半幅に対する比・#112 段 3）＝真俯瞰の画面の四隅（窓の 0.67）は薄めない
	const SH_BLD_BUFS = [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },
		{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },
	];
	const SH_MESH_BUFS = [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "snorm8x4" }] },
	];
	const SH_TEX_BUFS = [...SH_MESH_BUFS,   // 模型の受け手（#112 段 1）＝本体 meshTex と同じ頂点（uv・頂点色）
		{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },
		{ arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: "unorm8x4" }] },
	];
	function shadowRes() {
		if (sh) return sh;
		const bgl = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: VF, buffer: {} },
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
		] });
		const tex = device.createTexture({ size: [SH_N, SH_N], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		const view = tex.createView();
		const pBuf = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		const frameB = device.createBuffer({ size: FRAME_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		const frameT = device.createBuffer({ size: FRAME_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // 地形を落とす側の Frame（#112 段 2）＝地形の窓（F.mesh）＋太陽の正射影
		const batch = device.createBuffer({ size: PL_BATCH_SLOT * MAX_PL_BATCH, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		const samp = device.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
		const mods = sh0mods || (sh0mods = {
			terr: mkMod(TERRAIN_SH_WGSL, "terrainSh"), fill: mkMod(FILL_SH_WGSL, "fillSh"), line: mkMod(LINE_SH_WGSL, "lineSh"),
			bld: mkMod(BUILDING_SH_WGSL, "buildingSh"), mesh: mkMod(MESH_SH_WGSL, "meshSh"), meshTex: mkMod(MESH_TEX_SH_WGSL, "meshTexSh"), globe: mkMod(GLOBE_SH_WGSL, "globeSh"),
			bldCast: mkMod(BUILDING_CAST_WGSL, "buildingCast"), meshCast: mkMod(MESH_CAST_WGSL, "meshCast"), meshTexCast: mkMod(MESH_TEX_CAST_WGSL, "meshTexCast"), terrCast: mkMod(TERRAIN_CAST_WGSL, "terrainCast"),
		});
		const lay = a => device.createPipelineLayout({ bindGroupLayouts: a });
		// 模型の受け手の group(2)＝バッチごとの PB（binding 0・dynamic offset）＋影（binding 1〜3）＝group(3) はテクスチャで埋まっている（#112 段 1）
		const bglPlSh = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } },
			{ binding: 1, visibility: VF, buffer: {} },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
			{ binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
		] });
		const dsCast = { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBiasSlopeScale: 1.5 };
		sh = {
			bgl, tex, view, pBuf, frameB, frameT, batch, samp,
			bg: device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: pBuf } }, { binding: 1, resource: view }, { binding: 2, resource: samp }] }),
			batchBG: device.createBindGroup({ layout: bglPlBatch, entries: [{ binding: 0, resource: { buffer: batch, offset: 0, size: PL_BATCH_SLOT } }] }),   // PB は 240B（#46 段 2＝sh[9] 込み）
			plShBG: device.createBindGroup({ layout: bglPlSh, entries: [{ binding: 0, resource: { buffer: plBatchBuf, offset: 0, size: PL_BATCH_SLOT } }, { binding: 1, resource: { buffer: pBuf } }, { binding: 2, resource: view }, { binding: 3, resource: samp }] }),   // 模型の受け手＝本体と同じ PB（plBatchBuf）＋影
			lay: { terr: lay([bgl0, bgl1, bglClim, bgl]), fill: lay([bgl0, bgl1, bgl]), bld: lay([bgl0, bgl1, bglMask, bgl]), mesh: lay([bgl0, bgl1, bglPlBatch, bgl]), meshTex: lay([bgl0, bgl1, bglPlSh, bglPlTex5]), globe: lay([bglGlobe, bgl]) },
			cast: {
				bld: device.createRenderPipeline({ layout: bldLayout, vertex: { module: mods.bldCast, entryPoint: "vs", buffers: SH_BLD_BUFS },
					fragment: { module: mods.bldCast, entryPoint: "fs", targets: [] }, primitive: { topology: "triangle-list" }, depthStencil: dsCast }),
				mesh: device.createRenderPipeline({ layout: plLayout, vertex: { module: mods.meshCast, entryPoint: "vs", buffers: SH_MESH_BUFS },
					primitive: { topology: "triangle-list" }, depthStencil: dsCast }),
				meshTex: device.createRenderPipeline({ layout: plTexLayout, vertex: { module: mods.meshTexCast, entryPoint: "vs", buffers: SH_TEX_BUFS },
					fragment: { module: mods.meshTexCast, entryPoint: "fsCast", targets: [] }, primitive: { topology: "triangle-list" }, depthStencil: dsCast }),   // 模型の MASK（#112 段 4）＝α で抜く
				terr: device.createRenderPipeline({ layout: lay([bgl0]), vertex: { module: mods.terrCast, entryPoint: "vs", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
					primitive: { topology: "triangle-list" }, depthStencil: dsCast }),   // 地形（#112 段 2）＝頂点は group(0)（Frame・標高）だけ読む
			},
			pipes: new Map(), bg0: null, bg0Key: "", bg0T: null,
			cpu: new Float32Array(32), batchCPU: new Float32Array(PL_BATCH_SLOT / 4 * MAX_PL_BATCH),
		};
		return sh;
	}
	let sh0mods = null;   // 派生シェーダのモジュール（初点灯で一度だけ・消灯後も再利用）
	let castRev = 0;      // 影を落とす側の中身の版（メッシュ・標高・表示区が変わるたび+1）＝同じ窓・同じ中身なら深度パスを省く
	// 影の計器（#112 段 0）＝点けた後だけ積む。passes/skipped＝深度パスを描いた／省いた回数・last＝直近に描いた窓と落とした物・active＝このフレームに窓が立ったか
	const shStat = { passes: 0, skipped: 0, active: false, last: null };
	function shadowFree() { if (!sh) return; sh.tex.destroy(); sh.pBuf.destroy(); sh.frameB.destroy(); sh.frameT.destroy(); sh.batch.destroy(); sh = null; }
	function shadowPipes(sc) {   // 受け手の派生パイプライン（sampleCount 毎・遅延）＝本体 buildPipes と同じ頂点/深度/ブレンド
		let p = sh.pipes.get(sc); if (p) return p;
		const ms = { count: sc }, m = sh0mods, L = sh.lay;
		const pipe = (mod, bufs, ds, lay) => device.createRenderPipeline({ layout: lay, vertex: { module: mod, entryPoint: "vs", buffers: bufs },
			fragment: { module: mod, entryPoint: "fs", targets: [target] }, primitive: { topology: "triangle-list", cullMode: "none" }, depthStencil: ds, multisample: ms });
		p = {
			fillOff: pipe(m.fill, FILL_BUFS, dsOff, L.fill), fillTest: pipe(m.fill, FILL_BUFS, dsTest, L.fill),
			lineOff: pipe(m.line, LINE_BUFS, dsOff, L.fill), lineTest: pipe(m.line, LINE_BUFS, dsTest, L.fill),
			terrain: pipe(m.terr, [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }], dsTerrain, L.terr),
			bld: pipe(m.bld, SH_BLD_BUFS, dsWriteBld, L.bld),
			mesh: pipe(m.mesh, SH_MESH_BUFS, dsWriteBld, L.mesh),
			meshTex: pipe(m.meshTex, SH_TEX_BUFS, dsWriteBld, L.meshTex),          // 模型・3D Tiles・I3S・押し出し（#112 段 1）
			meshTexBlend: pipe(m.meshTex, SH_TEX_BUFS, dsWriteBldNoZ, L.meshTex),  // その半透明（BLEND）＝同じ派生・深度書き込み無し
			globe: device.createRenderPipeline({ layout: L.globe, vertex: { module: m.globe, entryPoint: "vs" },
				fragment: { module: m.globe, entryPoint: "fs", targets: [target] }, primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms }),
		};
		sh.pipes.set(sc, p);
		return p;
	}
	function shadowBG0(which = "bg0") {   // 影を落とす側の group(0)＝bg0.bld と同じ素材で Frame だけ太陽の正射影（bg0＝sh.frameB・bg0T＝地形の sh.frameT）
		const v = (elev.has && elevTexView) ? elevTexView : dummyView, fv = (far.has && farTexView) ? farTexView : dummyView, cv = cogTexView || dummyView;
		const c = sh[which + "K"];
		if (sh[which] && c && c.v === v && c.fv === fv && c.cv === cv) return sh[which];
		sh[which + "K"] = { v, fv, cv };
		return (sh[which] = device.createBindGroup({ layout: bgl0, entries: [
			{ binding: 0, resource: { buffer: which === "bg0T" ? sh.frameT : sh.frameB, offset: 0, size: FRAME_SLOT } },
			{ binding: 1, resource: v }, { binding: 2, resource: elevSampler }, { binding: 3, resource: fv },
			{ binding: 4, resource: cv }, { binding: 5, resource: { buffer: cogBuf } },
			{ binding: 6, resource: dummyView }, { binding: 7, resource: dummyView }, { binding: 8, resource: dummyView },
			{ binding: 9, resource: { buffer: gndPBuf } }, { binding: 10, resource: rasSampler }, { binding: 11, resource: dummyView },
		] }));
	}

	// ── 断面とクリッピング平面（#111 段 0〜2・2026-09-29）。set("clip",{on, vertical?, horizontal?, box?, planes?, param?, cap?, edge?}) の間だけ、ここの資源・派生シェーダ・パイプラインを作って使う。
	// 切らないフレームは従来と同じパイプライン・bind group のまま（影と同じ約束）＝消したら資源を返す（モジュールは再点灯用に保持）。
	// 切る物＝地形（近・遠）・球の床（海を含む）・基図と利用者の層の塗りと線・基図の押し出し建物・建物メッシュ・模型（3D Tiles・I3S・押し出し）。
	// 面の記述は clip.js（毎フレーム面を作り直す＝楕円体の切替にも追従・高々 6 枚）。K は原点ごと＝束縛も原点ごと（CLIP_SLOTS：main＝地形/建物/床/メッシュ/模型・base・user）。
	// 段 2：地形の蓋（面ごとの板＝地面の中だけ塗る）・建物の疑似の蓋（閉じた建物の裏面を蓋の色）・縁の帯・影と重ねる（受け手は影＋面の派生・深度パスも面で切る）
	// 段 4＝対象ごとの面：スロット＝対象（terrain＝地形・床・蓋／buildings＝基図の押し出し・建物メッシュ／models＝模型・3D Tiles・I3S・押し出し）＋塗りと線の原点（main/base/user＝vector の面）
	const CLIP_SLOTS = ["terrain", "buildings", "models", "main", "base", "user"], CLIP_SLOT_B = 256;   // uniform のオフセット境界（ClipP＝160B）
	const CS = Object.fromEntries(CLIP_SLOTS.map((k, i) => [k, i]));
	const CAP_SLOT_B = 512;   // 地形の蓋の CapP（320B）＝近窓・遠窓の 2 スロット
	let clip = null;   // 正規化した切り方（clip.js normClip＝{ groups, style }）・null＝切らない
	let cl = null, cl0mods = null, clipFrame = null, clipS = SAMPLES;   // clipS＝このフレームの MSAA 段（オーバーレイの派生パイプライン）
	function clipRes() {
		if (cl) return cl;
		const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
		const buf = device.createBuffer({ size: CLIP_SLOT_B * CLIP_SLOTS.length, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		const capBuf = device.createBuffer({ size: CAP_SLOT_B * 2, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		cl0mods ??= {
			terr: mkMod(TERRAIN_CLIP_WGSL, "terrainClip"), mesh: mkMod(MESH_CLIP_WGSL, "meshClip"), meshTex: mkMod(MESH_TEX_CLIP_WGSL, "meshTexClip"),
			fill: mkMod(FILL_CLIP_WGSL, "fillClip"), line: mkMod(LINE_CLIP_WGSL, "lineClip"), bld: mkMod(BUILDING_CLIP_WGSL, "buildingClip"), globe: mkMod(GLOBE_CLIP_WGSL, "globeClip"),
			cap: mkMod(CLIP_CAP_WGSL, "clipCap"),
		};
		// 模型の group(2)＝バッチごとの PB（binding 0・dynamic offset）＋面（binding 1＝main）＝group(3) はテクスチャで埋まっている（影と同じ置き方）
		const bglPlCl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }, { binding: 1, visibility: VF, buffer: {} }] });
		// 影と重ねる：影（uniform・深度・比較サンプラ）の後ろに面（binding 3）／模型は PB＋影＋面（binding 4）
		const bglShCl = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: VF, buffer: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } }, { binding: 3, visibility: VF, buffer: {} }] });
		const bglPlShCl = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }, { binding: 1, visibility: VF, buffer: {} },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } }, { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
			{ binding: 4, visibility: VF, buffer: {} }] });
		const bglCap = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }, { binding: 1, visibility: VF, buffer: {} }] });
		const lay = a => device.createPipelineLayout({ bindGroupLayouts: a });
		const slotRes = i => ({ buffer: buf, offset: i * CLIP_SLOT_B, size: CLIP_F32 * 4 });
		// オーバーレイ（段 3）＝原点ごとの K を dynamic offset で（MAX_OV スロット）
		const bglClDyn = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }] });
		const ovBuf = device.createBuffer({ size: CLIP_SLOT_B * MAX_OV, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		cl = { bgl, buf, capBuf, bglShCl, bglPlShCl, bglPlCl, slotRes, ovBuf, ovCPU: new Float32Array(CLIP_SLOT_B / 4 * MAX_OV), pipesOv: new Map(),
			ovBG: device.createBindGroup({ layout: bglClDyn, entries: [{ binding: 0, resource: { buffer: ovBuf, offset: 0, size: CLIP_F32 * 4 } }] }),
			layOv: lay([bglOvFrame, bglOvParam, bglClDyn]),
			bg: Object.fromEntries(CLIP_SLOTS.map((k, i) => [k, device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: slotRes(i) }] })])),
			plBG: device.createBindGroup({ layout: bglPlCl, entries: [{ binding: 0, resource: { buffer: plBatchBuf, offset: 0, size: PL_BATCH_SLOT } }, { binding: 1, resource: slotRes(CS.models) }] }),
			capBG: [0, 1].map(k => device.createBindGroup({ layout: bglCap, entries: [{ binding: 0, resource: slotRes(CS.terrain) }, { binding: 1, resource: { buffer: capBuf, offset: k * CAP_SLOT_B, size: 320 } }] })),
			lay: { terr: lay([bgl0, bgl1, bglClim, bgl]), mesh: lay([bgl0, bgl1, bglPlBatch, bgl]), meshTex: lay([bgl0, bgl1, bglPlCl, bglPlTex5]),
				fill: lay([bgl0, bgl1, bgl]), bld: lay([bgl0, bgl1, bglMask, bgl]), globe: lay([bglGlobe, bgl]), cap: lay([bgl0, bglCap]) },
			laySh: { terr: lay([bgl0, bgl1, bglClim, bglShCl]), mesh: lay([bgl0, bgl1, bglPlBatch, bglShCl]), meshTex: lay([bgl0, bgl1, bglPlShCl, bglPlTex5]),
				fill: lay([bgl0, bgl1, bglShCl]), bld: lay([bgl0, bgl1, bglMask, bglShCl]), globe: lay([bglGlobe, bglShCl]) },
			layCast: { terr: lay([bgl0, bgl]), bld: lay([bgl0, bgl1, bglMask, bgl]), mesh: lay([bgl0, bgl1, bglPlBatch, bgl]), meshTex: lay([bgl0, bgl1, bglPlCl, bglPlTex5]) },
			pipes: new Map(), pipesSh: new Map(), cast: null, shx: null,
			cpu: new Float32Array(CLIP_SLOT_B / 4 * CLIP_SLOTS.length), capCPU: new Float32Array(CAP_SLOT_B / 4 * 2) };
		return cl;
	}
	function clipFree() { if (!cl) return; cl.buf.destroy(); cl.capBuf.destroy(); cl.ovBuf.destroy(); cl = null; }
	function clipOvPipes(sc) {   // オーバーレイの覆う（塗り・周辺マスク）と線＝切る派生（段 3）
		let p = cl.pipesOv.get(sc); if (p) return p;
		const ms = { count: sc }, m = (cl0mods.ov ??= mkMod(OVERLAY_CLIP_WGSL, "overlayClip"));
		const cover = ds => device.createRenderPipeline({ layout: cl.layOv, vertex: { module: m, entryPoint: "vsCover" },
			fragment: { module: m, entryPoint: "fsCover", targets: [target] }, primitive: { topology: "triangle-list" }, depthStencil: ds, multisample: ms });
		p = { ovCover: cover(dsOvCover), ovMaskCover: cover(dsOvMaskCover),
			ovLine: device.createRenderPipeline({ layout: cl.layOv, vertex: { module: cl0mods.line, entryPoint: "vs", buffers: LINE_BUFS },
				fragment: { module: cl0mods.line, entryPoint: "fs", targets: [target] }, primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms }) };
		cl.pipesOv.set(sc, p);
		return p;
	}
	// 派生パイプライン（sampleCount 毎・遅延）＝本体 buildPipes と同じ頂点・深度・ブレンド。mods＝切るだけ／影＋面・L＝その束縛
	function clipPipeSet(sc, m, L) {
		const ms = { count: sc };
		const pipe = (mod, bufs, ds, lay) => device.createRenderPipeline({ layout: lay, vertex: { module: mod, entryPoint: "vs", buffers: bufs },
			fragment: { module: mod, entryPoint: "fs", targets: [target] }, primitive: { topology: "triangle-list", cullMode: "none" }, depthStencil: ds, multisample: ms });
		return {
			terrain: pipe(m.terr, [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }], dsTerrain, L.terr),
			mesh: pipe(m.mesh, SH_MESH_BUFS, dsWriteBld, L.mesh),
			meshTex: pipe(m.meshTex, SH_TEX_BUFS, dsWriteBld, L.meshTex),
			meshTexBlend: pipe(m.meshTex, SH_TEX_BUFS, dsWriteBldNoZ, L.meshTex),
			fillOff: pipe(m.fill, FILL_BUFS, dsOff, L.fill), fillTest: pipe(m.fill, FILL_BUFS, dsTest, L.fill),
			lineOff: pipe(m.line, LINE_BUFS, dsOff, L.fill), lineTest: pipe(m.line, LINE_BUFS, dsTest, L.fill),
			bld: pipe(m.bld, SH_BLD_BUFS, dsWriteBld, L.bld),
			globe: device.createRenderPipeline({ layout: L.globe, vertex: { module: m.globe, entryPoint: "vs" },
				fragment: { module: m.globe, entryPoint: "fs", targets: [target] }, primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms }),
			cap: m.cap ? device.createRenderPipeline({ layout: L.cap, vertex: { module: m.cap, entryPoint: "vs" },   // 地形の蓋＝深度は画素で書く（frag_depth）
				fragment: { module: m.cap, entryPoint: "fs", targets: [target] }, primitive: { topology: "triangle-list", cullMode: "none" }, depthStencil: dsWrite, multisample: ms }) : null,
		};
	}
	function clipPipes(sc) { let p = cl.pipes.get(sc); if (!p) { p = clipPipeSet(sc, cl0mods, cl.lay); cl.pipes.set(sc, p); } return p; }
	function clipShPipes(sc) {   // 影と重ねる受け手（影の束縛の後ろに面）
		let p = cl.pipesSh.get(sc); if (p) return p;
		cl0mods.sh ??= { terr: mkMod(TERRAIN_SH_CLIP_WGSL, "terrainShClip"), mesh: mkMod(MESH_SH_CLIP_WGSL, "meshShClip"), meshTex: mkMod(MESH_TEX_SH_CLIP_WGSL, "meshTexShClip"),
			fill: mkMod(FILL_SH_CLIP_WGSL, "fillShClip"), line: mkMod(LINE_SH_CLIP_WGSL, "lineShClip"), bld: mkMod(BUILDING_SH_CLIP_WGSL, "buildingShClip"), globe: mkMod(GLOBE_SH_CLIP_WGSL, "globeShClip") };
		p = clipPipeSet(sc, cl0mods.sh, cl.laySh);
		cl.pipesSh.set(sc, p);
		return p;
	}
	function clipShBG() {   // 影と重ねる束縛（影の資源が作り直されたら作り直す）
		if (cl.shx && cl.shx.sh === sh) return cl.shx;
		const shE = [{ binding: 0, resource: { buffer: sh.pBuf } }, { binding: 1, resource: sh.view }, { binding: 2, resource: sh.samp }];
		cl.shx = { sh,
			bg: Object.fromEntries(CLIP_SLOTS.map((k, i) => [k, device.createBindGroup({ layout: cl.bglShCl, entries: [...shE, { binding: 3, resource: cl.slotRes(i) }] })])),
			plBG: device.createBindGroup({ layout: cl.bglPlShCl, entries: [{ binding: 0, resource: { buffer: plBatchBuf, offset: 0, size: PL_BATCH_SLOT } },
				{ binding: 1, resource: { buffer: sh.pBuf } }, { binding: 2, resource: sh.view }, { binding: 3, resource: sh.samp }, { binding: 4, resource: cl.slotRes(CS.models) }] }),
			castPlBG: device.createBindGroup({ layout: cl.bglPlCl, entries: [{ binding: 0, resource: { buffer: sh.batch, offset: 0, size: PL_BATCH_SLOT } }, { binding: 1, resource: cl.slotRes(CS.models) }] }),
		};
		return cl.shx;
	}
	function clipCastPipes() {   // 影の深度パスを切った形で（落とす側・深度だけ）
		if (cl.cast) return cl.cast;
		const m = cl0mods.cast ??= { terr: mkMod(TERRAIN_CAST_CLIP_WGSL, "terrainCastClip"), mesh: mkMod(MESH_CAST_CLIP_WGSL, "meshCastClip"),
			meshTex: mkMod(MESH_TEX_CAST_CLIP_WGSL, "meshTexCastClip"), bld: mkMod(BUILDING_CAST_CLIP_WGSL, "buildingCastClip") };
		const L = cl.layCast, dsCast = { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBiasSlopeScale: 1.5 };
		const pipe = (mod, bufs, fs, lay) => device.createRenderPipeline({ layout: lay, vertex: { module: mod, entryPoint: "vs", buffers: bufs },
			fragment: { module: mod, entryPoint: fs, targets: [] }, primitive: { topology: "triangle-list" }, depthStencil: dsCast });
		cl.cast = {
			terr: pipe(m.terr, [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }], "fsClip", L.terr),
			bld: pipe(m.bld, SH_BLD_BUFS, "fs", L.bld),
			mesh: pipe(m.mesh, SH_MESH_BUFS, "fsClip", L.mesh),
			meshTex: pipe(m.meshTex, SH_TEX_BUFS, "fsCast", L.meshTex),
		};
		return cl.cast;
	}
	// 地形の蓋の CapP（面ごとの四角＝カメラの注視点を面へ下ろした点を中心に、窓の対角ほどの大きさ）。win＝その回の窓 [W,S,spanLng,spanLat]・far＝遠窓の回
	function packCap(k, planes, O, origin, win, center, far) {
		const u = cl.capCPU, o = k * CAP_SLOT_B / 4, N = terrain.G - 1;
		u.fill(0, o, o + 80);
		u[o] = (origin[0] - win[0]) / win[2] * N; u[o + 1] = (origin[1] - win[1]) / win[3] * N; u[o + 2] = N / win[2]; u[o + 3] = N / win[3];
		u[o + 4] = N; u[o + 5] = far ? 1 : 0;
		const C = lonlatTo3D(center[0], center[1]), cl0 = Math.cos(center[1] * Math.PI / 180);
		const L = Math.min(1.2, Math.hypot(win[2] * cl0, win[3]) * Math.PI / 180);   // 窓の対角（単位球）
		const up = mat.norm(C), a0 = center[0] * Math.PI / 180, east = [-Math.sin(a0), 0, Math.cos(a0)];
		planes.forEach(([nx, ny, nz, c], i) => {
			const n = [nx, ny, nz], dc = nx * C[0] + ny * C[1] + nz * C[2] - c;
			const P0 = [C[0] - dc * nx, C[1] - dc * ny, C[2] - dc * nz];
			const ref = Math.abs(nx * up[0] + ny * up[1] + nz * up[2]) > 0.9 ? east : up;
			const t1 = mat.norm([n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]]);
			const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
			const q = o + 8 + i * 12;
			u[q] = P0[0] - O[0]; u[q + 1] = P0[1] - O[1]; u[q + 2] = P0[2] - O[2];
			u[q + 4] = t1[0] * L; u[q + 5] = t1[1] * L; u[q + 6] = t1[2] * L;
			u[q + 8] = t2[0] * L; u[q + 9] = t2[1] * L; u[q + 10] = t2[2] * L;
		});
	}

	// UBO：Frame 4スロット / DrawP N_ROLESスロット / globe 専用 / mesh per-batch（dynamic offset）
	const frameBuf = device.createBuffer({ size: FRAME_SLOT * 6, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // 5スロット目=terrainFar（遠景メッシュパス）・6 スロット目=user（段 8⑤）
	const paramBuf = device.createBuffer({ size: PARAM_SLOT * N_ROLES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const globeBuf = device.createBuffer({ size: 384, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // rayF/rayX/rayY/eyeC（旧 mat4 の枠・#65）+land+atmo+elevBounds+whP+seaC+farBounds+farP+misc(globeAlpha)+sun+anc/anc2/eyeO+atmP（#46 段 1）+cogOff/gndOff0-3/elevOff（#65）＝368B
	const worldPalBuf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // WorldPal（10×vec4f・globe/terrain 両パイプラインで共有＝knob 変化時のみ書込）
	let globeBG = null;   // rebuildGlobeBG() が生成（elev/clim テクスチャ差し替えで作り直し。明示レイアウト＝1x/4x 両セット互換）
	const paramBG = [];   // 役割別（静的オフセット＝dynamic offset 不要）
	for (let r = 0; r < N_ROLES; r++) paramBG.push(device.createBindGroup({
		layout: bgl1, entries: [{ binding: 0, resource: { buffer: paramBuf, offset: r * PARAM_SLOT, size: 48 } }],
	}));
	// mesh per-batch UBO（dynamic offset＝1つの bind group で全バッチを切替）
	const plBatchBuf = device.createBuffer({ size: PL_BATCH_SLOT * MAX_PL_BATCH, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const plBatchBG = device.createBindGroup({ layout: bglPlBatch, entries: [{ binding: 0, resource: { buffer: plBatchBuf, offset: 0, size: PL_BATCH_SLOT } }] });   // PB＝meshOrigin+clipMesh+alpha+pbr0+emis+lp+sh[9]＝240B（#46 段 2）
	const plBatchCPU = new Float32Array(PL_BATCH_SLOT / 4 * MAX_PL_BATCH);
	// 画像タイル層の per-tile UBO（dynamic offset・アトラス合成 1 回あたり最大 MAX_RAS 枚＝近窓＋遠窓の合算）
	const RAS_SLOT = 256, MAX_RAS = 1200;
	const rasBuf = device.createBuffer({ size: RAS_SLOT * MAX_RAS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const rasBG = device.createBindGroup({ layout: bglRasP, entries: [{ binding: 0, resource: { buffer: rasBuf, offset: 0, size: 48 } }] });
	const rasCPU = new Float32Array(RAS_SLOT / 4 * MAX_RAS);
	// 星空劇場：Sky UBO（176B）＋星座線の色 UBO（3スロット×256B＝constel/ecliptic/celeq を静的 offset で切替）
	const skyBuf = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const skyCPU = new Float32Array(48);   // Sky（176B＝44f、192B確保でアラインメント余白）
	const skyBG = device.createBindGroup({ layout: bglSky, entries: [{ binding: 0, resource: { buffer: skyBuf } }] });
	const LINE_SLOT = 256, LINE_ROLE = { constel: 0, ecliptic: 1, celeq: 2 };
	const skyLineBuf = device.createBuffer({ size: LINE_SLOT * 3, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const skyLineCPU = new Float32Array(LINE_SLOT / 4 * 3);
	const skyLineBG = [0, 1, 2].map(i => device.createBindGroup({ layout: bglSkyLine, entries: [{ binding: 0, resource: { buffer: skyLineBuf, offset: i * LINE_SLOT, size: 16 } }] }));
	let skySolarPrev = null;   // 太陽系圏モードの前回値＝constel 色 UBO の書き直しを跨ぎの瞬間だけに
	// 星座線の色（GL renderer と同値）：星座=青 / 黄道=淡黄 / 天の赤道=淡紅。fadeSky.x（出現α）は VS で掛ける
	skyLineCPU.set([0.47, 0.63, 1.0, 0.4], LINE_ROLE.constel * (LINE_SLOT / 4));
	skyLineCPU.set([1.0, 0.8, 0.45, 0.35], LINE_ROLE.ecliptic * (LINE_SLOT / 4));
	skyLineCPU.set([1.0, 0.55, 0.5, 0.32], LINE_ROLE.celeq * (LINE_SLOT / 4));
	device.queue.writeBuffer(skyLineBuf, 0, skyLineCPU);
	let stars = null, planets = null, constel = null, ecliptic = null, celeq = null;   // { buf, count }
	function setStarBuf(cur, data, stride) {
		if (cur) cur.buf.destroy();
		if (!data || !data.length) return null;
		const src = data instanceof Float32Array ? data : new Float32Array(data);
		const buf = device.createBuffer({ size: (src.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(buf, 0, src);
		return { buf, count: src.length / stride };
	}
	// overlay：per-scene の Frame（FRAME_SLOT）＋DrawP（PARAM_SLOT）を dynamic offset で切替。最大 MAX_OV シーン/フレーム。
	// 末尾スロット GB_SLOT は gintBld（moj筆ドレープ線・独自 origin）が間借り＝同じ dynamic frame 機構を再利用。
	// gintBld は色別バッチ最大 GB_BATCH_MAX 本（田/畑等の fid 色をドレープへ運ぶ）＝Frame は GB_SLOT を共有し
	// DrawP（色）だけ GB_SLOT+i の別スロット＝queue.writeBuffer が描画前に全着地しても互いに潰さない。
	// 末尾+1 の WD_SLOT は wdepr（海面下の陸地・?world=1）専用＝drawOverlay より前（タイル前）に別途描くため、
	// writeBuffer が pass 実行前に全着地しても drawOverlay の 0..n-1 スロットと互いに潰さない固定席。
	// 末尾+2 の LK_SLOT は lakes（NE湖・?world=1）＝wdepr 直後に描く固定席（WD_SLOT と同じ理由の独立スロット）。
	const MAX_OV = 32, GB_SLOT = MAX_OV, GB_BATCH_MAX = 8, WD_SLOT = MAX_OV + GB_BATCH_MAX, LK_SLOT = WD_SLOT + 1, OV_SLOTS = MAX_OV + GB_BATCH_MAX + 2;
	const ovFrameBuf = device.createBuffer({ size: FRAME_SLOT * OV_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const ovParamBuf = device.createBuffer({ size: PARAM_SLOT * OV_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const ovParamCPU = new Float32Array(PARAM_SLOT / 4 * OV_SLOTS);
	let ovFrameBG = null, ovFrameBGView = null, ovFrameBGFarView = null;   // drawOverlay が elevTexView/farTexView 変化時だけ作り直す（rebuildBG0 と独立）
	const ovParamBG = device.createBindGroup({ layout: bglOvParam, entries: [{ binding: 0, resource: { buffer: ovParamBuf, offset: 0, size: 48 } }] });
	function ensureOvFrameBG() {
		const v = (elev.has && elevTexView) ? elevTexView : dummyView;
		const fv = (far.has && farTexView) ? farTexView : dummyView;
		if (ovFrameBG && ovFrameBGView === v && ovFrameBGFarView === fv) return;
		ovFrameBGView = v; ovFrameBGFarView = fv;
		ovFrameBG = device.createBindGroup({ layout: bglOvFrame, entries: [
			{ binding: 0, resource: { buffer: ovFrameBuf, offset: 0, size: FRAME_SLOT } },
			{ binding: 1, resource: v }, { binding: 2, resource: elevSampler }, { binding: 3, resource: fv }] });
	}
	// overlay スロット：{ fanBuf, fanCount, lineBufs?, lineCount, origin, fill, minZoom }
	let overlay = null, overlayHi = null, overlayHover = null, rail = [];   // overlayHover＝ホバー中の地物境界を太線で（選択マスク overlayHi とは別スロット＝両立）
	let wdepr = null;   // 海面下の陸地（?world=1・全球ハイプソの一部）＝湖より先に描く塗り専用スロット。whK フェード連動
	let lakes = null;   // 湖（NE lakes・?world=1）＝wdepr 直後・タイルより先に描く塗り専用スロット（色は worldPal.sea 平色）
	const wdParamCPU = new Float32Array(PARAM_SLOT / 4);
	const u8colOv = col => { const u = new Uint8Array(col.length); for (let i = 0; i < col.length; i++) u[i] = Math.max(0, Math.min(255, Math.round(col[i] * 255))); return u; };
	function buildOverlaySlot(s, fill) {
		if (!s || (!s.fanPos.length && !(s.lineHalf && s.lineHalf.length))) return null;
		const o = { origin: s.origin, fill, minZoom: s.minZoom || 0, fanCount: s.fanPos.length / 2, lineCount: 0, bufs: [], feats: s.feats || null };   // feats＝feature毎レンジ+外接円（wdepr の球体カリング用）
		if (s.fanPos.length) { o.fanBuf = makeBuf(s.fanPos, GPUBufferUsage.VERTEX); o.bufs.push(o.fanBuf); }
		if (s.lineHalf && s.lineHalf.length) {
			o.lineCount = s.lineHalf.length;
			o.bP1 = makeBuf(s.P1, GPUBufferUsage.VERTEX); o.bP2 = makeBuf(s.P2, GPUBufferUsage.VERTEX);
			o.bCol = makeBuf(u8colOv(s.lineCol), GPUBufferUsage.VERTEX); o.bHalf = makeBuf(s.lineHalf, GPUBufferUsage.VERTEX);
			o.bufs.push(o.bP1, o.bP2, o.bCol, o.bHalf);
			zeroOffFit(o.lineCount);   // overlay の線はずらさない＝共有の 0 列

		}
		return o;
	}
	function disposeOverlay(o) { if (o) for (const b of o.bufs) b.destroy(); }
	function setOverlay(s, fill) { disposeOverlay(overlay); overlay = s ? buildOverlaySlot(s, fill || [0.20, 0.45, 0.85, 0.32]) : null; }
	function setOverlayHi(s, fill) {   // fill=配列は従来の面塗り／{mask,color}は周辺マスク（外側を暗く・地物は塗らない）
		disposeOverlay(overlayHi);
		if (!s) { overlayHi = null; return; }
		const isMask = fill && !Array.isArray(fill);
		overlayHi = buildOverlaySlot(s, isMask ? (fill.color || [0, 0, 0, 0.15]) : (fill || [0.95, 0.55, 0.15, 0.6]));
		if (overlayHi) overlayHi.mask = !!(isMask && fill.mask);
	}
	function setOverlayHover(s) { disposeOverlay(overlayHover); overlayHover = s ? buildOverlaySlot(s, [0, 0, 0, 0]) : null; }   // 塗り透明＝境界線のみ（太線はシーン側の lineWidth）
	function setRail(scenes) { for (const o of rail) disposeOverlay(o); rail = (scenes || []).map(s => buildOverlaySlot(s, [0, 0, 0, 0])); }
	function setWdepr(s) { disposeOverlay(wdepr); wdepr = s ? buildOverlaySlot(s, [0, 0, 0, 0]) : null; }   // 海面下の陸地（?world=1）＝タイル前に描く塗り専用シーン（色は cover が画素単位で計算＝fill 不使用）
	function setLakes(s) { disposeOverlay(lakes); lakes = s ? buildOverlaySlot(s, [0, 0, 0, 0]) : null; }   // 湖（NE lakes・?world=1）＝wdepr 直後に描く塗り専用シーン（色は worldPal.sea 平色＝drawLakes が毎フレ書く）
	// wdepr の発行（draw() がタイル前・whK>0 の時だけ呼ぶ）：stencil fan（WD_SLOT の Frame/DrawP）→
	// cover＝P.wdCover（globe と同一バインド＝landK=1 強制のハイプソ本体・α=G.whP.x の whK フェード）。
	// 線は作らない前提（buildGeoJSONOverlay {lines:false}）＝塗りのみ。
	// 全球面ポリゴンの stencil 段（wdepr/lakes 共用）：slot の Frame/DrawP を書き fan を巻き数へ。
	// fill＝DrawP p1（lakes の ovCover 用の平色。wdepr は cover が画素単位で計算＝null）。
	function stencilWorldFan(pass, packF, st, o, slot, fill) {
		ensureOvFrameBG();
		device.queue.writeBuffer(ovFrameBuf, slot * FRAME_SLOT, packF(o.origin));
		wdParamCPU.fill(0);
		wdParamCPU[1] = OVERLAY_LIFT; wdParamCPU[2] = 1; wdParamCPU[3] = 1;   // p0.y=リフト p0.z=地平円クランプ（球体カリング＝vsStencil） p0.w=グローバルα
		if (fill) { wdParamCPU[4] = fill[0]; wdParamCPU[5] = fill[1]; wdParamCPU[6] = fill[2]; wdParamCPU[7] = fill[3]; }   // p1=塗り色
		device.queue.writeBuffer(ovParamBuf, slot * PARAM_SLOT, wdParamCPU.buffer, 0, PARAM_SLOT);
		const fOff = slot * FRAME_SLOT, pOff = slot * PARAM_SLOT;
		pass.setStencilReference(0);
		pass.setPipeline(P.ovStencil);
		pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]);
		pass.setVertexBuffer(0, o.fanBuf);
		// 球体カリング二段構え（gl/renderer.js stencilWorldFan と対）：①完全裏側 feature は CPU でレンジごと
		// 描かない（対蹠点付近は VS クランプがリング一周巻き＝全面+1化）②跨ぎは vsStencil の地平円クランプ。
		if (o.feats) {
			const E = st.eye, eLen = Math.hypot(E[0], E[1], E[2]) || 1;
			const cosH = Math.min(1, 1 / eLen), sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
			const ex = E[0] / eLen, ey = E[1] / eLen, ez = E[2] / eLen;
			let run0 = -1, runN = 0;
			for (const f of o.feats) {
				const vis = f.C[0] * ex + f.C[1] * ey + f.C[2] * ez > f.cosR * cosH - f.sinR * sinH;
				if (vis && run0 >= 0 && f.start === run0 + runN) { runN += f.count; continue; }
				if (runN) pass.draw(runN, 1, run0);
				run0 = vis ? f.start : -1; runN = vis ? f.count : 0;
			}
			if (runN) pass.draw(runN, 1, run0);
		} else pass.draw(o.fanCount);
		// 球体カリングは VS の地平円クランプ（p0.z=1）が担う＝裏側は円周に縮退（巻き数0）・跨ぎは可視部のみ。
		// 旧・ref=±1 方式は跨ぎポリゴンの投影折返しが作る±1斑を殺しきれなかった（GL だけ幻影の実測 2026-09-02）。
		return [fOff, pOff];
	}
	function drawWdepr(pass, packF, st) {
		if (!wdepr || !wdepr.fanCount || !globeBG) return;
		stencilWorldFan(pass, packF, st, wdepr, WD_SLOT, null);
		pass.setPipeline(P.wdCover);   // NOTEQUAL 0 → 塗って 0 へ後始末（dsOvCover と同じ）
		pass.setBindGroup(0, globeBG);
		pass.draw(3);
	}
	// 湖（NE lakes・?world=1）＝wdepr の兄弟：stencil 共用・cover は ovCover（DrawP p1 の平色＝worldPal.sea）。
	// 旧 world-water タイル層（Protomaps/OSM）の置き換え（2026-09-03 本人裁定「湖はNE経由＝B案」）＝
	// α=whK＝全球ハイプソと同時に現れ同時に消える（z≥6.5 は自動不可視・日本の湖は GSI 基図の領分）。
	function drawLakes(pass, packF, st, whK) {
		if (!lakes || !lakes.fanCount) return;
		const sc = worldPal().sea;   // globe u_seaC と単一の出所（テーマの worldHypso.sea が両方へ届く）
		const [fOff, pOff] = stencilWorldFan(pass, packF, st, lakes, LK_SLOT, [sc[0], sc[1], sc[2], whK * (view.globeAlpha ?? 1)]);   // 湖も球体の不透明度に従う
		pass.setPipeline(P.ovCover);
		pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]);
		pass.draw(3);
	}
	// gintBld（gint ユーザー層の地形沿い境界線・点）＝独自 origin・BUILDING_WGSL 24B レイアウト・line/point 描画。null=解放。
	// data＝{origin, batches:[{lines,points,color}...]}（色別バッチ＝fid色のドレープ）または旧形 {origin,lines,points,color}。
	let gintBld = null;   // { origin, batches:[{ color, line?:{bPos,bSh,bAnc,count}, point?:{...} }] }
	function gbMesh(g) {
		if (!g || !g.pos?.length) return null;
		return { bPos: makeBuf(g.pos, GPUBufferUsage.VERTEX), bSh: makeBuf(g.shade, GPUBufferUsage.VERTEX), bAnc: makeBuf(g.anchor, GPUBufferUsage.VERTEX), count: g.pos.length / 3 };
	}
	function disposeGintBld() { if (gintBld) { for (const bt of gintBld.batches) for (const m of [bt.line, bt.point]) if (m) for (const b of [m.bPos, m.bSh, m.bAnc]) b.destroy(); gintBld = null; } }
	function setGintBld(data) {
		disposeGintBld();
		if (!data) return;
		const src = (data.batches || [data]).slice(0, GB_BATCH_MAX);
		const batches = src.map(b => ({ line: gbMesh(b.lines), point: gbMesh(b.points), color: b.color || null })).filter(b => b.line || b.point);
		if (!batches.length) return;
		gintBld = { origin: data.origin, batches };
	}
	// overlay 群を描く（基図の上・建物の下・深度off）。per-scene Frame＋DrawP を dynamic offset で切替。
	// 呼び出し側 draw() が Frame を書く（packFrame の scene origin 版）＝ここは stencil-then-cover＋線の発行だけ。
	function drawOverlay(pass, st, packF, zoom) {
		const scenes = [];
		if (view.showRail !== false) for (const o of rail) if (o && zoom >= o.minZoom) scenes.push(o);
		if (overlay) scenes.push(overlay);
		if (overlayHi) scenes.push(overlayHi);
		if (overlayHover) scenes.push(overlayHover);   // 最後＝ホバー境界を最前面に（マスクの上）
		if (!scenes.length) return;
		ensureOvFrameBG();
		const n = Math.min(scenes.length, MAX_OV);
		// per-scene の Frame＋DrawP を一括で書く（writeBuffer は pass より先に適用）
		ovParamCPU.fill(0);
		for (let i = 0; i < n; i++) {
			const o = scenes[i];
			device.queue.writeBuffer(ovFrameBuf, i * FRAME_SLOT, packF(o.origin));   // scene origin の Frame
			const po = i * (PARAM_SLOT / 4);
			ovParamCPU[po + 1] = OVERLAY_LIFT;   // p0.y=地形からのリフト(m)＝境界線/面が地形メッシュと同一面で z-fight し明滅・消失する件の根治（小地域の町丁目境界で実証 2026-08-12）
			ovParamCPU[po + 3] = 1;   // p0.w=グローバルα（LINE FS が乗算＝境界線の可視・fill(0)のままだと全消灯）
			if (o.feats) ovParamCPU[po + 2] = 1;   // p0.z=地平円クランプ＝地球規模の地物（国＝スポットライト）だけ（gl/renderer.js と対・2026-09-23）
			ovParamCPU[po + 4] = o.fill[0]; ovParamCPU[po + 5] = o.fill[1]; ovParamCPU[po + 6] = o.fill[2]; ovParamCPU[po + 7] = o.fill[3];   // p1=塗り色
		}
		device.queue.writeBuffer(ovParamBuf, 0, ovParamCPU.buffer, 0, n * PARAM_SLOT);
		// 断面（#111 段 3）＝覆う（塗り・マスク）と線を切る派生へ。面の K はオーバーレイの原点ごと
		const OC = clipFrame ? clipOvPipes(clipS) : null;
		if (OC) {
			const sty = clip.style;
			for (let i = 0; i < n; i++) { const o = scenes[i].origin; packClip(clipFrame.planes, lonlatTo3D(o[0], o[1]), cl.ovCPU.subarray(i * CLIP_SLOT_B / 4, i * CLIP_SLOT_B / 4 + CLIP_F32), sty); }
			device.queue.writeBuffer(cl.ovBuf, 0, cl.ovCPU.buffer, 0, n * CLIP_SLOT_B);
		}
		const ovClipBG = i => { if (OC) pass.setBindGroup(2, cl.ovBG, [i * CLIP_SLOT_B]); };
		pass.setStencilReference(0);
		for (let i = 0; i < n; i++) {
			const o = scenes[i], fOff = i * FRAME_SLOT, pOff = i * PARAM_SLOT;
			if (o.fanCount) {   // 面：stencil fan → cover（stencil≠0 を塗り・0 へ戻す）／o.mask は外側(stencil==0)を暗く塗る
				pass.setPipeline(P.ovStencil);
				pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]);
				pass.setVertexBuffer(0, o.fanBuf);
				// 球体カリング二段構え（wdepr/lakes の stencilWorldFan と同型）：完全裏側の feature はレンジごと
				// 描かない＝球の向こうの国が手前へ punch しない。feats を持たない局所ポリゴンは従来どおり一括
				if (o.feats) {
					const E = st.eye, eLen = Math.hypot(E[0], E[1], E[2]) || 1;
					const cosH = Math.min(1, 1 / eLen), sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
					const ex = E[0] / eLen, ey = E[1] / eLen, ez = E[2] / eLen;
					let run0 = -1, runN = 0;
					for (const f of o.feats) {
						const vis = f.C[0] * ex + f.C[1] * ey + f.C[2] * ez > f.cosR * cosH - f.sinR * sinH;
						if (vis && run0 >= 0 && f.start === run0 + runN) { runN += f.count; continue; }
						if (runN) pass.draw(runN, 1, run0);
						run0 = vis ? f.start : -1; runN = vis ? f.count : 0;
					}
					if (runN) pass.draw(runN, 1, run0);
				} else pass.draw(o.fanCount);
				if (o.mask) {   // 周辺マスク＝外側を暗く塗り→内側stencilを0へ後始末（gint/次スロットのため）
					pass.setPipeline(OC ? OC.ovMaskCover : P.ovMaskCover);
					pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]); ovClipBG(i);
					pass.draw(3);
					pass.setPipeline(P.ovZero);
					pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]);
					pass.draw(3);
				} else {
					pass.setPipeline(OC ? OC.ovCover : P.ovCover);
					pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]); ovClipBG(i);
					pass.draw(3);
					if (OC) { pass.setPipeline(P.ovZero); pass.draw(3); }   // 切って捨てた画素は巻き数が残る（覆うパスが 0 へ戻せない）＝ゼロ書きで後始末
				}
			}
			if (o.lineCount) {   // 線（境界線 / N02 の鉄道線）＝LINE_WGSL 流用
				pass.setPipeline(OC ? OC.ovLine : P.ovLine);
				pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]); ovClipBG(i);
				pass.setVertexBuffer(0, cornerBuf); pass.setVertexBuffer(1, o.bP1); pass.setVertexBuffer(2, o.bP2); pass.setVertexBuffer(3, o.bCol); pass.setVertexBuffer(4, o.bHalf); pass.setVertexBuffer(5, zeroOffBuf);
				drawLine(pass, o.lineCount);
			}
		}
	}
	// line-offset（#49）を持たない線の 5 番目の頂点列＝全部 0 の共有バッファ（層ごとに 0 の配列を持たない）。
	// インスタンス数ぶんの長さが要る＝線を組む時（符号化の外）に伸ばす。古い物は提出済みの仕事が終われば破棄される（WebGPU の destroy の約束）
	let zeroOffBuf = null, zeroOffN = 0;
	function zeroOffFit(n) {
		if (n <= zeroOffN) return;
		zeroOffBuf?.destroy();
		zeroOffN = Math.max(n, zeroOffN * 2, 4096);
		zeroOffBuf = device.createBuffer({ size: zeroOffN * 12, usage: GPUBufferUsage.VERTEX });   // 作りたては 0 で埋まっている
	}
	// 線の角＝index の 4 頂点（perf plan P3・既定）／旧 6 頂点（?quad4=0）。線分 1 本の VS 起動 6→4（VS は両端点の elevQ を毎回引く＝3D では重い）
	const QUAD4 = rOpts.quad4 !== false;
	const cornerSrc = QUAD4 ? CORNERS4 : CORNERS;
	const cornerBuf = device.createBuffer({ size: cornerSrc.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
	device.queue.writeBuffer(cornerBuf, 0, cornerSrc);
	const lineIdxBuf = device.createBuffer({ size: LINE_IDX.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
	device.queue.writeBuffer(lineIdxBuf, 0, LINE_IDX);
	const drawLine = (pass, count) => { if (QUAD4) { pass.setIndexBuffer(lineIdxBuf, "uint16"); pass.drawIndexed(6, count); } else pass.draw(6, count); };

	// 静的 view（色・見た目）と海ゲート＝gl/renderer.js と同じ意味論
	let view = { clear: null, land: null, atmo: null, bldColor: null };
	// 世界パレット（view.worldHypso の参照変化でだけ再解決＋worldPalBuf へ書込）。globe/terrain/wdepr は
	// 同一バッファを読む＝wdepr⇄globe の縫い目（色の bit 一致契約）が構造的に保たれる。gl/renderer.js worldPal() と対。
	let wpalSrc = false, wpal = null;   // 初期 false＝worldHypso が null でも初回は必ず書く
	const wpalCPU = new Float32Array(40);
	const worldPal = () => {
		if (view.worldHypso !== wpalSrc) {
			wpalSrc = view.worldHypso; wpal = resolveWorldPal(wpalSrc);
			[wpal.lowHumid, wpal.lowArid, wpal.midHumid, wpal.midArid, wpal.ramp1, wpal.ramp2, wpal.peak, wpal.snow, wpal.belowSea, wpal.grat]
				.forEach((c, i) => wpalCPU.set(c, i * 4));   // 各色 vec4f スロット（grat のみ w=α係数・他の w は 0 のまま）
			device.queue.writeBuffer(worldPalBuf, 0, wpalCPU);
		}
		return wpal;
	};
	let sea = { li: -1, minzoom: Infinity };
	// 利用者の vector の層の差し込み（#123）＝ranges [[liLo, liHi, anchor]…]：user の枠の li がその範囲の op は、基図の li が anchor 以上の項の前に描く（表に無い＝今どおり基図の上）。rev＝アトラスの鍵
	let userAnchor = { ranges: [], rev: 0 };
	let bldFill = { li: -1 };   // 建物フットプリント塗りの li。3D（チルト）時は伏せる＝押し出しと二重表現になるため
	let fogDist = 0;            // フォグ距離の臨界減衰追従（gl/renderer.js と同じ）
	let elevScaleEff = 0;       // pitch で変調した実効スケール（真俯瞰では0＝平面）

	// --- 標高アトラス（r16float）＋地形メッシュ ---
	// GL 版と同じダブルバッファ：stage で舞台裏に組み、セルが揃ったら commit で一括スワップ（山影がパッと消えない）。
	const elevSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const dummyTex = device.createTexture({ size: [1, 1], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummyView = dummyTex.createView();
	// 気候場テクスチャ（全球ハイプソ cross-blend・view.worldHypso.clim の URL から一度だけ取得）。
	// 未着の間はシェーダが緯度近似へフォールバック（hasClim=0）＝1-2フレームの色ズレのみ。
	let climTexView = null, climLoading = false, climBG = null;
	function ensureClimTex(url) {
		if (climTexView || climLoading || !url) return;
		climLoading = true;
		fetch(url).then(r => r.blob()).then(b => createImageBitmap(b, { premultiplyAlpha: "none" })).then(bm => {
			const tex = device.createTexture({ size: [bm.width, bm.height], format: "rgba8unorm",
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
			device.queue.copyExternalImageToTexture({ source: bm }, { texture: tex }, [bm.width, bm.height]);
			climTexView = tex.createView(); bm.close();
			rebuildBG0();   // globeBG/climBG が気候テクスチャを掴み直す
			rOpts.requestDraw?.();   // 到着フレームを一枚要求（静止中でも気候色へ差し替わる）
		}).catch(e => console.warn("[hypso] climate texture load failed (continuing with latitude approximation)", e));
	}
	// ユーザ COG アトラス（rgba8unorm・gadgets/cog.js が等経緯度 RGBA を渡す）。globe binding(6-7)/terrain group(2) binding(3-4)
	const cogBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // CogP: bbox(vec4f)+p(vec4f)
	let cogTexObj = null, cogTexView = null, memCog = 0, cogHas = 0, cogGeo = null;   // cogGeo=[west,south,spanLon,spanLat]（f64 のまま＝packFrame の前計算用）
	function setCogTex(data) {
		if (cogTexObj) { cogTexObj.destroy(); cogTexObj = null; cogTexView = null; memCog = 0; }
		cogHas = data ? 1 : 0;
		cogGeo = data ? [data.bboxLL[0], data.bboxLL[1], data.bboxLL[2] - data.bboxLL[0], data.bboxLL[3] - data.bboxLL[1]] : null;
		if (data) {
			const { rgba, w, h, bboxLL } = data;
			cogTexObj = device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
			// writeTexture の bytesPerRow は 256 の倍数が必須＝端数幅はパディングして書く（アトラスは通常 1024/2048 幅で無縁）
			const row = w * 4, pad = Math.ceil(row / 256) * 256;
			let src = new Uint8Array(rgba.buffer || rgba, rgba.byteOffset || 0, rgba.byteLength ?? rgba.length);
			if (pad !== row) {
				const padded = new Uint8Array(pad * h);
				for (let j = 0; j < h; j++) padded.set(src.subarray(j * row, (j + 1) * row), j * pad);
				src = padded;
			}
			device.queue.writeTexture({ texture: cogTexObj }, src, { bytesPerRow: pad }, { width: w, height: h });
			cogTexView = cogTexObj.createView();
			memCog = w * h * 4;
			device.queue.writeBuffer(cogBuf, 0, new Float32Array([bboxLL[0], bboxLL[1], bboxLL[2] - bboxLL[0], bboxLL[3] - bboxLL[1], 1, 0, 0, 0]));
		} else {
			device.queue.writeBuffer(cogBuf, 0, new Float32Array(8));   // has=0
		}
		rebuildBG0();   // globeBG/climBG が COG テクスチャを掴み直す
	}
	let elevTexObj = null, elevTexView = null, elev = { bounds: [0, 0, 1, 0], scale: 0, has: 0 }, terrain = null, elevStage = null;
	// 遠景層（far）＝近窓の外を受け持つ粗い R10 第2アトラス（terrain.js が深ズーム×チルトで常設）
	let farTexObj = null, farTexView = null, far = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 };
	// ?mem=1 台帳のGPU固定常駐（自前確保分の概算）：標高アトラス（近/舞台裏/遠）＋地形メッシュ＋MSAAターゲット
	let memAtlas = 0, memStage = 0, memFar = 0, memMesh = 0, memMsaa = 0;
	let bg0 = null;   // group(0) の5スロット bind group（elevTex/farTex 差し替えで作り直し）
	let bg0Atl = null;   // 地面アトラス合成パス用（アトラス自身を dummy にした bg0）
	// 地面アトラスの状態（rebuildBG0 が bind group に張る＝先に宣言・TDZ 回避）：w[i]＝{ tex, view, size, levels, win:[W,S,spanLon,spanLat], bytes }
	const gnd = { w: [null, null, null, null], n: 0, key: "", tiles: 0, bytes: 0, rasterOn: false, fillsIn: false, faces: 0 };   // faces＝直近合成で焼いた gint 面の層数（窓の和）   // 段は細かい順（前景/近/中/遠・前景は強いチルト時のみ）
	const gndPBuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // GndP/GGndP：w0..w3,p
	const rasSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 8, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });   // CLAMP＝隣接タイルの滲み防止
	function rebuildBG0() {
		elevTexView = elevTexObj ? elevTexObj.createView() : null;   // view は1回だけ作って使い回す（gint の bind group キャッシュも view 同一性で安定）
		farTexView = farTexObj ? farTexObj.createView() : null;
		const view = (elev.has && elevTexView) ? elevTexView : dummyView;
		const farView = (far.has && farTexView) ? farTexView : dummyView;
		bg0 = {}; bg0Atl = {};
		// 地面アトラスへ塗りを焼くパス用＝同じレイアウトだがアトラス自身（binding 6-8）は dummy：描き込み先のテクスチャを同じ同期スコープで
		// 読み取り側にも張ると「writable usage と別 usage の同居」で CommandBuffer ごと無効になる（実際に踏んだ 2026-09-21）
		for (const [name, idx] of Object.entries(SLOT)) bg0Atl[name] = device.createBindGroup({
			layout: bgl0, entries: [
				{ binding: 0, resource: { buffer: frameBuf, offset: idx * FRAME_SLOT, size: FRAME_SLOT } },
				{ binding: 1, resource: view }, { binding: 2, resource: elevSampler }, { binding: 3, resource: farView },
				{ binding: 4, resource: cogTexView || dummyView }, { binding: 5, resource: { buffer: cogBuf } },
				{ binding: 6, resource: dummyView }, { binding: 7, resource: dummyView }, { binding: 8, resource: dummyView },
				{ binding: 9, resource: { buffer: gndPBuf } }, { binding: 10, resource: rasSampler }, { binding: 11, resource: dummyView },
			],
		});
		for (const [name, idx] of Object.entries(SLOT)) bg0[name] = device.createBindGroup({
			layout: bgl0, entries: [
				{ binding: 0, resource: { buffer: frameBuf, offset: idx * FRAME_SLOT, size: FRAME_SLOT } },
				{ binding: 1, resource: view },
				{ binding: 2, resource: elevSampler },
				{ binding: 3, resource: farView },
				{ binding: 4, resource: cogTexView || dummyView },   // ユーザ COG（無ければ dummy＝Cog0P.p.x=0 ガード）
				{ binding: 5, resource: { buffer: cogBuf } },
				{ binding: 6, resource: gnd.w[0] ? gnd.w[0].view : dummyView },   // 地面アトラス（無ければ dummy＝GndP.p.x=0 ガード）
				{ binding: 7, resource: gnd.w[1] ? gnd.w[1].view : dummyView },
				{ binding: 8, resource: gnd.w[2] ? gnd.w[2].view : dummyView },
				{ binding: 9, resource: { buffer: gndPBuf } },
				{ binding: 10, resource: rasSampler },
				{ binding: 11, resource: gnd.w[3] ? gnd.w[3].view : dummyView },
			],
		});
		// globe（全球ハイプソ＝標高+気候）と terrain group(2)（気候）も同じ素材に依存＝一緒に作り直す
		globeBG = device.createBindGroup({ layout: bglGlobe, entries: [
			{ binding: 0, resource: { buffer: globeBuf } },
			{ binding: 1, resource: view },
			{ binding: 2, resource: elevSampler },
			{ binding: 3, resource: climTexView || dummyView },
			{ binding: 4, resource: { buffer: worldPalBuf } },
			{ binding: 5, resource: farView },   // far床（farViewはbg0のbinding3と同じ実体＝無ければdummy）
			{ binding: 6, resource: cogTexView || dummyView },   // ユーザ COG（無ければ dummy＝CogP.p.x=0 ガード）
			{ binding: 7, resource: { buffer: cogBuf } },
			{ binding: 8, resource: gnd.w[0] ? gnd.w[0].view : dummyView },   // 地面アトラス（球の床）
			{ binding: 9, resource: gnd.w[1] ? gnd.w[1].view : dummyView },
			{ binding: 10, resource: gnd.w[2] ? gnd.w[2].view : dummyView },
			{ binding: 11, resource: { buffer: gndPBuf } },
			{ binding: 12, resource: gnd.w[3] ? gnd.w[3].view : dummyView },
		] });
		climBG = device.createBindGroup({ layout: bglClim, entries: [
			{ binding: 0, resource: climTexView || dummyView },
			{ binding: 1, resource: elevSampler },
			{ binding: 2, resource: { buffer: worldPalBuf } },
		] });
	}
	rebuildBG0();
	const mkAtlasTex = (W, H) => device.createTexture({ size: [W, H], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });   // 生成時ゼロ初期化＝海。RENDER_ATTACHMENT＝GPU 再標本化の的（P1 step 1）・COPY_SRC＝検定の読み戻し
	function writeCell(tex, cx, cy, data, cellRes) {
		castRev++;   // 標高が変わる＝建物の足元（リフト）が変わる＝影の深度を描き直す
		// 計器 a（perf plan §1）：f16 変換と writeTexture 発行の時間を分けて terrain.js の upload 行へ渡す（?perf=1 の時だけ）
		const perf = self.__perfElev, t0 = perf ? performance.now() : 0;
		const half = f32ToF16(data);
		const t1 = perf ? performance.now() : 0;
		device.queue.writeTexture({ texture: tex, origin: { x: cx * cellRes, y: cy * cellRes } },
			half, { bytesPerRow: cellRes * 2 }, { width: cellRes, height: cellRes });
		if (perf) self.__perfElevLast = { f16: t1 - t0, write: performance.now() - t1 };
	}
	function atlasMeta(a, scale) {
		const span = a.cellSpan || 10;
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale, exag: a.exag || 1, has: 1, edgeFade: a.edgeFade || 0, liftBounds: a.liftBounds || null };
		const G = Math.min(a.gMax || 1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));   // gMax＝terrain.js が lowMem で 1024 に絞る（メッシュ 75→33.5MB）
		buildTerrainMesh(a.originLng, a.originLat, a.cellsX * span, a.cellsY * span, G);
	}
	function setElevationAtlas(a, scale) {
		if (elevTexObj) elevTexObj.destroy();
		elevTexObj = mkAtlasTex(a.cellsX * a.cellRes, a.cellsY * a.cellRes);
		memAtlas = a.cellsX * a.cellRes * a.cellsY * a.cellRes * 2;   // r16float=2B/texel
		atlasMeta(a, scale);
		rebuildBG0();
	}
	function setElevationCell(cx, cy, data, cellRes) { if (elevTexObj) putCellAny(elevTexObj, cx, cy, data, cellRes); }
	function setElevationAtlasStage(a, scale) {
		if (elevStage) elevStage.tex.destroy();
		elevStage = { tex: mkAtlasTex(a.cellsX * a.cellRes, a.cellsY * a.cellRes), a, scale };
		memStage = a.cellsX * a.cellRes * a.cellsY * a.cellRes * 2;
	}
	function setElevationCellStage(cx, cy, data, cellRes) { if (elevStage) putCellAny(elevStage.tex, cx, cy, data, cellRes); }
	function commitElevationStage() {
		if (!elevStage) return;
		if (elevTexObj) elevTexObj.destroy();
		elevTexObj = elevStage.tex;
		memAtlas = memStage; memStage = 0;
		atlasMeta(elevStage.a, elevStage.scale);
		elevStage = null;
		rebuildBG0();
	}
	// ── 遠景層（far）アトラス ──：ダブルバッファ無し（R10 は LRU ヒットが常＝terrain.js 側コメント参照）。
	// メッシュは近窓と同じ単位格子を Frame.mesh（terrainFar slot）で遠窓へ伸ばす＝専用メッシュ不要。
	function setElevationAtlasFar(a) {
		const span = a.cellSpan || 10;
		if (farTexObj) farTexObj.destroy();
		farTexObj = mkAtlasTex(a.cellsX * a.cellRes, a.cellsY * a.cellRes);
		memFar = a.cellsX * a.cellRes * a.cellsY * a.cellRes * 2;
		far = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], has: 1, edgeFade: a.edgeFade || 0 };
		rebuildBG0();
	}
	function setElevationCellFar(cx, cy, data, cellRes) { if (farTexObj) putCellAny(farTexObj, cx, cy, data, cellRes); }
	function clearElevationFar() {   // 深ズーム離脱＝GPU メモリを返す（10-16MB）
		if (!farTexObj) return;
		farTexObj.destroy(); farTexObj = null;
		far = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 }; memFar = 0;
		rebuildBG0();
	}
	// ── 標高セルの GPU 再標本化（perf plan P1 step 1・2026-09-27）──
	// terrain.js が生タイルの記述子 { tile, mode:"down" } | { tile, mode:"crop", lng0, lat0, span } | { atlas, mode:"world", cx, cy } を渡し、
	// renderer が storage buffer（LRU＝同じ親 R10 から 64 セルを切る混成窓で 1 回の上げ）から fullscreen 三角形 1 発でセル矩形へ焼く
	// ＝JS の N² ループ（再標本化＋f16 変換）が描画スレッドから消える（残る費用＝生タイルの writeBuffer＝memcpy 1 回）。
	// CPU 経路（elevation.js・worldatlas.js）と同式＝門 t-elevcell（|Δ| ≤ f16 1ulp）。逃げ道 ?cpuelev=1（rOpts.cpuElev）＝記述子を CPU で焼く。
	// 生タイルの型が想定外（Int16/Float32 以外）・全球アトラスの寸法が N を割らない時も CPU へ退避＝絵は同じ。
	const gpuResample = !rOpts.cpuElev;
	const RS_SLOT = 256, RS_RING = 64, RS_BYTES = 112;   // uniform リング（dynamic offset・1 セル 1 スロット。submit 順で古いスロットの再利用が安全）
	let rs = null;
	const rawLRU = new Map();   // tile(object) → { buf, bg, bytes, kind }（挿入順 LRU・バイト予算）
	let rawBytes = 0;
	const RAW_BUDGET = (rOpts.lowMem ? 16 : 64) << 20;   // R01 3600² Int16＝26MB・R10 2400²＝11.5MB
	function rsInit() {
		if (rs) return rs;
		const mod = mkMod(ELEV_RESAMPLE_WGSL, "elevResample");
		const bgl = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { hasDynamicOffset: true, minBindingSize: RS_BYTES } },
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } } ] });
		const pipe = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
			vertex: { module: mod, entryPoint: "vs" }, fragment: { module: mod, entryPoint: "fs", targets: [{ format: "r16float" }] }, primitive: { topology: "triangle-list" } });
		const ubuf = device.createBuffer({ size: RS_SLOT * RS_RING, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		const u32 = new Uint32Array(RS_BYTES / 4);
		rs = { pipe, bgl, ubuf, u32, f32: new Float32Array(u32.buffer), slot: 0 };
		return rs;
	}
	function rawBuf(tile) {   // 生タイルの storage buffer（LRU）。kind 0＝Int16Array・1＝Float32Array。他＝null（CPU へ）
		const hit = rawLRU.get(tile);
		if (hit) { rawLRU.delete(tile); rawLRU.set(tile, hit); hit.fresh = 0; return hit; }
		const d = tile.data, kind = d instanceof Int16Array ? 0 : d instanceof Float32Array ? 1 : -1;
		if (kind < 0) return null;
		let src = d, bytes = d.byteLength;
		if (bytes & 3) { src = new Int16Array(d.length + 1); src.set(d); bytes = src.byteLength; }   // 奇数個の Int16＝4B 境界へ詰め物（稀）
		const r = rsInit();
		const buf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(buf, 0, src.buffer, src.byteOffset, bytes);
		const bg = device.createBindGroup({ layout: r.bgl, entries: [{ binding: 0, resource: { buffer: r.ubuf, offset: 0, size: RS_BYTES } }, { binding: 1, resource: { buffer: buf } }] });
		const e = { buf, bg, bytes, kind, fresh: bytes };
		rawLRU.set(tile, e); rawBytes += bytes;
		for (const [k, v] of rawLRU) { if (rawBytes <= RAW_BUDGET || k === tile) break; rawLRU.delete(k); rawBytes -= v.bytes; v.buf.destroy(); }
		return e;
	}
	const atlasViews = new WeakMap();
	const viewOf = tex => { let v = atlasViews.get(tex); if (!v) { v = tex.createView(); atlasViews.set(tex, v); } return v; };
	function resampleCell(tex, cx, cy, N, src) {   // 戻り＝true（GPU で焼いた）／false（CPU 経路へ）
		if (!gpuResample) return false;
		const tile = src.tile || src.atlas, w = tile.width, h = tile.height;
		if (!(w >= 2 && h >= 2)) return false;
		const r = rsInit(), u = r.u32, f = r.f32;
		u.fill(0);
		// 標本位置は整数の分数 gx = (Ax + Bx·(2i+1)) / Dx で厳密に（ix/iy）。切り出しの幾何が整数で書けない（外来 DEM の端数など）時だけ f32 の一般形（mode 3）
		if (src.mode === "down") { u[20] = 0; u[21] = w - 1; u[22] = 2 * N; u[24] = 0; u[25] = h - 1; u[26] = 2 * N; }
		else if (src.mode === "crop") {
			const rg = tile.range, dl = src.lng0 - tile.lng, dt = src.lat0 - tile.lat, sp = src.span;
			const ints = [rg, dl, dt, sp, N].every(Number.isInteger) && dl >= 0 && dt >= 0 && rg > 0 && sp > 0;
			const Ax = dl * 2 * N * (w - 1), Ay = dt * 2 * N * (h - 1), Bx = sp * (w - 1), By = sp * (h - 1), D = 2 * N * rg;
			if (ints && Ax + Bx * (2 * N - 1) < 0x100000000 && Ay + By * (2 * N - 1) < 0x100000000 && D < 0x100000000) { u[3] = 2; u[20] = Ax; u[21] = Bx; u[22] = D; u[24] = Ay; u[25] = By; u[26] = D; }
			else { u[3] = 3; f[4] = dl / rg * (w - 1); f[5] = sp / N / rg * (w - 1); f[6] = dt / rg * (h - 1); f[7] = sp / N / rg * (h - 1); f[8] = -1e30; f[9] = 1e30; f[10] = -1e30; f[11] = 1e30; }
		}
		else if (src.mode === "world") { const C = w >> 2; if (C % N) return false; u[3] = 1; u[15] = C / N; u[16] = w; u[17] = (1 - src.cy) * C; u[18] = src.cx * C; }
		else return false;
		const e = rawBuf(tile);
		if (!e) return false;
		castRev++;   // 標高が変わる＝建物の足元（リフト）が変わる＝影の深度を描き直す（writeCell と同じ）
		u[0] = w; u[1] = h; u[2] = e.kind; u[12] = cx * N; u[13] = cy * N; u[14] = N;
		const slot = r.slot; r.slot = (slot + 1) % RS_RING;
		device.queue.writeBuffer(r.ubuf, slot * RS_SLOT, u.buffer, 0, RS_BYTES);
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({ colorAttachments: [{ view: viewOf(tex), loadOp: "load", storeOp: "store" }] });
		pass.setViewport(cx * N, cy * N, N, N, 0, 1); pass.setScissorRect(cx * N, cy * N, N, N);
		pass.setPipeline(r.pipe); pass.setBindGroup(0, e.bg, [slot * RS_SLOT]); pass.draw(3); pass.end();
		device.queue.submit([enc.finish()]);
		if (self.__perfElev) self.__perfElevLast = { f16: 0, write: 0, gpu: 1, raw: e.fresh };   // 計器 a：GPU 経路＝f16/write なし・raw＝この呼びで上げた生タイルのバイト（LRU ヒットは 0）
		return true;
	}
	const cpuCell = (src, N) => src.mode === "down" ? downsampleFlipped(src.tile, N) : src.mode === "crop" ? cropResample(src.tile, src.lng0, src.lat0, src.span, N) : worldAtlasCell(src.atlas, src.cx, src.cy, N);
	function putCellAny(tex, cx, cy, data, N) {   // data＝Float32Array（従来・CPU 済み）か生タイルの記述子（mode あり）
		if (data && data.mode) { if (!resampleCell(tex, cx, cy, N, data)) writeCell(tex, cx, cy, cpuCell(data, N), N); }
		else writeCell(tex, cx, cy, data, N);
	}
	// 検定用（t-elevcell）：アトラス（near/stage/far）のセルを Float32（南上げ・row0=南）で読み戻す
	async function readElevCell(which, cx, cy, N) {
		const tex = which === "far" ? farTexObj : which === "stage" ? (elevStage && elevStage.tex) : elevTexObj;
		if (!tex) return null;
		const bpr = Math.ceil(N * 2 / 256) * 256;
		const buf = device.createBuffer({ size: bpr * N, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: tex, origin: { x: cx * N, y: cy * N } }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: N }, { width: N, height: N });
		device.queue.submit([enc.finish()]);
		await new Promise(res => setTimeout(res, 0));   // readback と同じ WebKit 轍の予防
		await buf.mapAsync(GPUMapMode.READ);
		const src = new Uint8Array(buf.getMappedRange()), out = new Float32Array(N * N);
		for (let y = 0; y < N; y++) { const row = new Uint16Array(src.buffer, src.byteOffset + y * bpr, N); for (let x = 0; x < N; x++) out[y * N + x] = f16ToF32(row[x]); }
		buf.unmap(); buf.destroy();
		return out;
	}
	// 地形メッシュ＝単位格子 [0,1]²（G だけに依存）。窓の原点/幅は uniform（u_mesh＝Frame.mesh）で渡す
	// ＝標高アトラスの窓替え（パンのたびの atlasMeta）でメッシュを作り直さない。旧実装は毎回 lon/lat を
	// 焼いた頂点配列(G=1536 で 18.9MB)＋index(56.5MB)を作って GPU へ上げ直しており、広域×高チルトの
	// パンで「1窓替えごとに 75MB の GPU バッファ再確保」＝GPUメモリが単調に膨れる主因（GL 版 295c1e5 と同処置）。
	// G が変わる時だけ作り直す＝実質「起動時に一度」。頂点は uv 不変なので mesh 更新は Float32×4 の uniform だけ。
	function buildTerrainMesh(oLng, oLat, spanLng, spanLat, G) {
		if (terrain && terrain.G === G) { terrain.mesh = [oLng, oLat, spanLng, spanLat]; return; }
		const uv = new Float32Array(G * G * 2);
		for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const k = (j * G + i) * 2; uv[k] = i / (G - 1); uv[k + 1] = j / (G - 1); }
		const { idx, chunks } = buildChunkIndex(G);   // チャンク主導の index（P4 step B）＝三角形の分割・巻きは従来と同一・並びだけチャンク毎に連続
		if (terrain) { terrain.vbo.destroy(); terrain.ibo.destroy(); }
		const vbo = device.createBuffer({ size: uv.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		const ibo = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(vbo, 0, uv);
		device.queue.writeBuffer(ibo, 0, idx);
		memMesh = uv.byteLength + idx.byteLength;
		terrain = { vbo, ibo, count: idx.length, G, mesh: [oLng, oLat, spanLng, spanLat], chunks };
	}
	// 地形チャンクのカリング（perf plan P4 step B）：可視チャンクの区間だけ drawIndexed。?terrlod=0（rOpts.terrLod===false）＝従来の全量 1 draw
	let TERR_LOD = rOpts.terrLod !== false;   // set("terrLod", bool) で実行時切替（門 t-terrcull＝同じ絵の A/B）
	const terrStat = { near: { drawn: 0, of: 0 }, far: { drawn: 0, of: 0 } };   // ?perf=1／HUD の物差し（renderworker が mem テレメトリに載せる）
	const terrRuns = (mesh, st, which) => TERR_LOD ? visibleChunkRuns(terrain.chunks, mesh, st, elev.scale, terrStat[which]) : (terrStat[which].drawn = terrStat[which].of = terrain.chunks.length, [[0, terrain.count]]);

	// --- 建物メッシュ（LOD2 等）（gl/renderer.js setMeshSet/setMeshVis/meshBboxVisible の移植）---
	// meshes: key("区名#i") → { vbo(pos), nbo(normal), ibo, count, origin, bbox, ward, lodH, lodCounts, two }
	// meshMasks: 区名 → { ward, rev, tex(r8unorm 被覆マスク), bbox }（基図建物 FS が uv 参照して footprint を伏せる）
	// ward/rev＝buildMaskBG のシグネチャ（どの区のどの版か）。rev は writeTexture ごとに全体通しの連番＝作り直した区とも衝突しない
	const meshes = new Map();
	const meshKeep2d = () => { for (const p of meshes.values()) if (p.keep2d) return true; return false; };   // 真俯瞰でも描くバッチがあるか
	const meshMasks = new Map();
	let maskRevSeq = 0;
	const meshHidden = new Set();
	const maskSampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	// 模型のテクスチャ（glb 直読み）：ミップ＝GPU 生成（レベルごとに全画面三角形でブリット）・三線形＋異方性 8・repeat。無しは白 1x1（頂点色だけ）
	const texSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 8, addressModeU: "repeat", addressModeV: "repeat" });
	let mipPipe = null, mipSampler = null;
	function genMips(tex, levels) {   // rgba8unorm・level0 書き込み済み → 1..levels-1 を順に半分へ（queue 順＝copyExternalImageToTexture の後に走る）
		if (!mipPipe) {
			const mod = device.createShaderModule({ code: `@group(0) @binding(0) var s: sampler; @group(0) @binding(1) var t: texture_2d<f32>;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO { var o: VO; let x = f32((i << 1u) & 2u); let y = f32(i & 2u); o.uv = vec2f(x, 1.0 - y); o.p = vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0); return o; }
@fragment fn fs(in: VO) -> @location(0) vec4f { return textureSample(t, s, in.uv); }` });
			mipPipe = device.createRenderPipeline({ layout: "auto", vertex: { module: mod, entryPoint: "vs" }, fragment: { module: mod, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
			mipSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
		}
		const enc = device.createCommandEncoder();
		for (let i = 1; i < levels; i++) {
			const bg = device.createBindGroup({ layout: mipPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: mipSampler }, { binding: 1, resource: tex.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }) }] });
			const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView({ baseMipLevel: i, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store" }] });
			pass.setPipeline(mipPipe); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
		}
		device.queue.submit([enc.finish()]);
	}
	// 模型のテクスチャは rgba8unorm で持ち（mips の生成は今までどおり表示空間）、標本化は rgba8unorm-srgb ビュー＝FS が受けるのはリニア（#46 段 0・出口で srgbEncode）
	const SRGB_VIEW = { format: "rgba8unorm-srgb" };
	// 模型の既定テクスチャ（1×1）：baseColor＝白（sRGB）・MR＝白（G=粗さ 1・B=金属 1＝factor がそのまま効く・リニア）・法線＝(128,128,255)＝恒等（リニア）・AO＝白（リニア）・発光＝白（sRGB・factor がそのまま）
	const tex1 = (rgba, srgb) => { const t = device.createTexture({ size: [1, 1], format: "rgba8unorm", viewFormats: ["rgba8unorm-srgb"], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); device.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]); return { tex: t, view: t.createView(srgb ? SRGB_VIEW : undefined) }; };
	const whiteTex = tex1([255, 255, 255, 255], true), mrTex1 = tex1([255, 255, 255, 255], false), nrmTex1 = tex1([128, 128, 255, 255], false), occTex1 = tex1([255, 255, 255, 255], false), emTex1 = tex1([255, 255, 255, 255], true);
	const TEX_DEF = [whiteTex, mrTex1, nrmTex1, occTex1, emTex1];   // 並び＝bglPlTex5 の binding 1..5（tex, texMR, texN, texOcc, texEm）・sRGB は baseColor と発光だけ
	const TEX_SRGB = [true, false, false, false, true];
	function meshTexture(t, srgb = true) {   // ImageBitmap か {rgba,w,h} → { tex, view }（無ければ null）。glTF の uv 原点＝画像左上＝copyExternalImageToTexture と一致
		if (!t) return null;
		const w = t.bitmap ? t.bitmap.width : t.w, h = t.bitmap ? t.bitmap.height : t.h;
		const levels = 1 + Math.floor(Math.log2(Math.max(w, h)));
		const tex = device.createTexture({ size: [w, h], mipLevelCount: levels, format: "rgba8unorm", viewFormats: ["rgba8unorm-srgb"], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
		if (t.bitmap) device.queue.copyExternalImageToTexture({ source: t.bitmap }, { texture: tex }, [w, h]);
		else device.queue.writeTexture({ texture: tex }, t.rgba, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h]);
		if (levels > 1) genMips(tex, levels);
		return { tex, view: tex.createView(srgb ? SRGB_VIEW : undefined) };
	}
	function meshTexBG(texs) {   // 5 枚（無い所は既定）→ group(3)
		return device.createBindGroup({ layout: bglPlTex5, entries: [{ binding: 0, resource: texSampler }, ...texs.map((t, i) => ({ binding: i + 1, resource: (t || TEX_DEF[i]).view }))] });
	}
	// ── 地面アトラス（RTT ドレープ・2026-09-21）＝ラスタ基図 → ベクタ塗り（3D 時）→ ラスタ重ね を 3 段窓（近/中/遠）へ合成し、地形・球・塗りの
	// FS が gndMix0 で画素標本化する（gl/renderer.js と対）。合成は鍵（窓・ラスタ rev・シーン rev・ゲート）が変わった時だけ＝別エンコーダで
	// main パスより先に submit → mips。raster.js の契約：rasterTex/rasterMesh/rasterFree/setRasterDraws（rd={rev,hideFills,layers}）
	let rasterDraws = null, memRaster = 0, sceneRev = 0;
	let rasAtlasPipe = null, atlasFillPipe = null;
	const atlBuf = device.createBuffer({ size: RAS_SLOT * 24, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // AtlP：窓 4×スロット 3（base/main/user）×ゲート 2＝24 枠
	const atlBG = device.createBindGroup({ layout: bglRasP, entries: [{ binding: 0, resource: { buffer: atlBuf, offset: 0, size: 32 } }] });
	const atlCPU = new Float32Array(RAS_SLOT / 4 * 24);
	function rasterTex(bitmap) {
		const w = bitmap.width, h = bitmap.height, levels = 1 + Math.floor(Math.log2(Math.max(w, h)));
		const tex = device.createTexture({ size: [w, h], mipLevelCount: levels, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
		device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex }, [w, h]);   // 行0＝北＝メッシュ v=0・premultipliedAlpha 既定 false＝合成 FS が α を掛ける
		if (levels > 1) genMips(tex, levels);
		const bytes = Math.round(w * h * 4 * 4 / 3);
		memRaster += bytes;
		return { kind: "tex", tex, bg: device.createBindGroup({ layout: bglPlTex, entries: [{ binding: 0, resource: rasSampler }, { binding: 1, resource: tex.createView() }] }), bytes, w, h };
	}
	function rasterMesh({ pos, uv, idx }) {
		const bPos = makeBuf(pos, GPUBufferUsage.VERTEX), bUv = makeBuf(uv, GPUBufferUsage.VERTEX), bIdx = makeBuf(idx, GPUBufferUsage.INDEX);
		const bytes = pos.byteLength + uv.byteLength + idx.byteLength;
		memRaster += bytes;
		return { kind: "mesh", bPos, bUv, bIdx, count: idx.length, bufs: [bPos, bUv, bIdx], bytes };
	}
	// 破棄は次フレームの冒頭（前フレームの submit の後）へ遅延＝記録済み・未 submit のコマンドが参照するテクスチャを destroy しない保険
	const rasFreeQ = [];
	function rasterFree(h) { if (!h) return; rasFreeQ.push(h); memRaster -= h.bytes || 0; }
	function rasterFlushFree() { for (const h of rasFreeQ) { if (h.kind === "tex") h.tex.destroy(); else for (const b of h.bufs) b.destroy(); } rasFreeQ.length = 0; }
	function setRasterDraws(rd) { rasterDraws = rd; }
	function writeGndP() {
		const f = new Float32Array(20);
		for (let i = 0; i < 4; i++) { const a = i < gnd.n ? gnd.w[i] : null; f[i * 4] = a ? a.win[0] : 0; f[i * 4 + 1] = a ? a.win[1] : 0; f[i * 4 + 2] = a ? a.win[2] : 1; f[i * 4 + 3] = a ? a.win[3] : 1; }
		f[16] = gnd.n;
		device.queue.writeBuffer(gndPBuf, 0, f);
	}
	function gndAlloc(size) {
		const levels = 1 + Math.floor(Math.log2(size));
		const tex = device.createTexture({ size: [size, size], mipLevelCount: levels, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
		const bytes = Math.round(size * size * 4 * 4 / 3);
		gnd.bytes += bytes;
		return { tex, view: tex.createView(), view0: tex.createView({ baseMipLevel: 0, mipLevelCount: 1 }), size, levels, win: [0, 0, 1, 1], bytes };
	}
	function gndFree1(a) { if (!a) return; a.tex.destroy(); gnd.bytes -= a.bytes; }
	let groundHook = null, groundSig = null;   // gint の面を窓へ焼くフック（renderworker が bakeFaces/bakeSig を結線）：fn(cam, { enc, view, size, win, index })・sig()＝合成鍵
	function setGroundHook(fn, sig) { groundHook = fn || null; groundSig = sig || null; }
	// 合成の入口（draw の Frame 書込の後・main パスより先）。fillsIn＝3D（地形あり）＝塗りはアトラス側へ（直描きは伏せる）。
	// 窓は packFrame（gnd0..2 の係数）が先に読む＝prepareGround で確定し、composeGround で描く（同じフレーム）
	let gndWins = null, gndKey = "";
	function prepareGround(cam, fillsIn, slots) {
		const rasterOn = !!(rasterDraws && rasterDraws.layers.length);
		const wantFills = fillsIn && !(rasterOn && rasterDraws.hideFills);
		gnd.rasterOn = rasterOn; gnd.fillsIn = fillsIn;
		const hook = fillsIn && groundHook;   // gint の面（3D＝地面アトラス側）
		if (!rasterOn && !wantFills && !hook) { if (gnd.n) { gnd.n = 0; gnd.key = ""; gnd.tiles = 0; writeGndP(); } gndWins = null; return null; }
		const wins = groundWindows(cam, canvas.width, canvas.height);
		const seaOff = cam.zoom < sea.minzoom, baseA = view.baseAlpha ?? 1;
		// 利用者の vector の塗り（段 8⑤）＝基図の塗りの後・gint の面の前。ラスタ基図の hideFills と基図の濃さ（baseAlpha）には従わない（gl/renderer.js と同じ）
		const userIn = fillsIn && slots.indexOf("user") >= 0, baseSlots = userIn ? slots.filter(x => x !== "user") : slots;
		const key = windowsKey(wins) + `|${rasterOn ? rasterDraws.rev : -1}|${wantFills ? sceneRev + ":" + baseSlots.join("") : -1}|${seaOff}|${baseA}|${bldFill.li}|${hook ? (groundSig ? groundSig() : "") : -1}` + (userIn ? `|u${sceneRev}` : "");
		if (key === gnd.key) return null;
		let rebuilt = false;
		const N = rOpts.lowMem ? 1024 : 2048, sizes = wins.length === 4 ? [N, N, N >> 1, N >> 1] : [N, N >> 1, N >> 1];   // 前景あり＝4 段
		for (let i = 0; i < wins.length; i++) {
			const bb = wins[i], size = sizes[i];
			if (!gnd.w[i] || gnd.w[i].size !== size) { if (gnd.w[i]) gndFree1(gnd.w[i]); gnd.w[i] = gndAlloc(size); rebuilt = true; }
			gnd.w[i].win = [bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]];
		}
		if (gnd.n !== wins.length) rebuilt = true;   // 段数が変わる（前景の出入り）＝bind group の 4 段目が dummy⇄実体
		gnd.n = wins.length; gnd.key = key;
		if (rebuilt) rebuildBG0();   // アトラスの view が変わった＝bg0/globeBG を作り直す（Frame 書込より前でよい＝バッファは同じ）
		writeGndP();
		return { wins, rasterOn, wantFills, seaOff, baseA, cam, hook, userIn, baseSlots };
	}
	function composeGround(job, slots) {
		if (!job) return;
		const { wins, rasterOn, wantFills, seaOff, baseA, cam, hook, userIn, baseSlots } = job;
		gnd.tiles = 0; gnd.faces = 0;
		if (!rasAtlasPipe) rasAtlasPipe = device.createRenderPipeline({ layout: rasAtlasLayout,
			vertex: { module: rasAtlasMod, entryPoint: "vs", buffers: RASTER_BUFS },
			fragment: { module: rasAtlasMod, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: BLEND }] },
			primitive: { topology: "triangle-list" } });
		if (!atlasFillPipe) atlasFillPipe = device.createRenderPipeline({ layout: atlasFillLayout,
			vertex: { module: atlasFillMod, entryPoint: "vs", buffers: FILL_BUFS },
			fragment: { module: atlasFillMod, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: BLEND }] },
			primitive: { topology: "triangle-list" } });
		// per-draw uniform：ラスタタイル（rasBuf）と塗り（atlBuf：窓×スロット×ゲート）を先に全部書く（writeBuffer は submit より先に着地）
		let n = 0, m = 0;
		const jobs = [];
		for (let i = 0; i < wins.length; i++) {
			const a = gnd.w[i], bb = wins[i];
			const tiles = [];
			if (rasterOn) for (const order of ["under", "over"]) for (const L of rasterDraws.layers) {
				if (L.order !== order) continue;
				for (const d of L.draws) {
					const b = d.bounds;
					if (b[2] <= bb[0] || b[0] >= bb[2] || b[3] <= bb[1] || b[1] >= bb[3]) continue;
					if (n >= MAX_RAS) { console.warn(`[gpu] raster atlas draws exceed ${MAX_RAS} = truncated`); break; }
					const o = n * (RAS_SLOT / 4);
					rasCPU[o] = d.nw[0] - a.win[0]; rasCPU[o + 1] = d.nw[1] - a.win[1]; rasCPU[o + 2] = 1 / a.win[2]; rasCPU[o + 3] = 1 / a.win[3];
					rasCPU[o + 4] = d.uvT[0]; rasCPU[o + 5] = d.uvT[1]; rasCPU[o + 6] = d.uvT[2]; rasCPU[o + 7] = d.uvT[3];
					rasCPU[o + 8] = L.opacity; rasCPU[o + 9] = 0; rasCPU[o + 10] = 0; rasCPU[o + 11] = 0;
					tiles.push({ d, slot: n, order }); n++; gnd.tiles++;
				}
			}
			const fills = [];
			const fillSlots = [...(wantFills ? baseSlots : []), ...(userIn ? ["user"] : [])];
			for (const slot of fillSlots) {
				const scene = scenes[slot]; if (!scene.draws.length) continue;
				const user = slot === "user";
				for (const gate of user ? [0] : [0, 1]) {   // user の li は図郭外の水域の帯に掛からない＝ゲート 0 だけ
					const o = m * (RAS_SLOT / 4);
					atlCPU[o] = scene.origin[0] - a.win[0]; atlCPU[o + 1] = scene.origin[1] - a.win[1]; atlCPU[o + 2] = 1 / a.win[2]; atlCPU[o + 3] = 1 / a.win[3];
					atlCPU[o + 4] = gate; atlCPU[o + 5] = user ? 1 : baseA; atlCPU[o + 6] = 0; atlCPU[o + 7] = 0;
					fills.push({ slot, gate, at: m, user }); m++;
				}
			}
			jobs.push({ a, tiles, fills, index: i });
		}
		if (n) device.queue.writeBuffer(rasBuf, 0, rasCPU.buffer, 0, n * RAS_SLOT);
		if (m) device.queue.writeBuffer(atlBuf, 0, atlCPU.buffer, 0, m * RAS_SLOT);
		const enc = device.createCommandEncoder();
		for (const { a, tiles, fills, index } of jobs) {
			let pass = enc.beginRenderPass({ colorAttachments: [{ view: a.view0, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
			const drawTiles = order => {
				let any = false;
				for (const t of tiles) {
					if (t.order !== order) continue;
					if (!any) { pass.setPipeline(rasAtlasPipe); any = true; }
					pass.setBindGroup(0, rasBG, [t.slot * RAS_SLOT]); pass.setBindGroup(1, t.d.tex.bg);
					pass.setVertexBuffer(0, t.d.mesh.bPos); pass.setVertexBuffer(1, t.d.mesh.bUv);
					pass.setIndexBuffer(t.d.mesh.bIdx, "uint16"); pass.drawIndexed(t.d.mesh.count);
				}
			};
			drawTiles("under");
			if (fills.length) {
				pass.setPipeline(atlasFillPipe);
				pass.setBindGroup(1, paramBG[ROLE.normal]);
				for (const { slot, gate, at, user } of fills) {
					const scene = scenes[slot];
					pass.setBindGroup(0, bg0Atl[slot]);   // アトラス自身を読まない版（同期スコープの衝突回避）
					pass.setBindGroup(2, atlBG, [at * RAS_SLOT]);
					for (const d of scene.draws) {
						if (d.kind !== "fill") continue;
						const seaFB = seaFbReal(d.li) != null, waterC = d.li === sea.li || d.li === sea.li2;
						if ((seaFB ? 1 : 0) !== gate) continue;   // ゲート別に 2 周（uniform は dynamic offset＝ドロー毎の書換不要）
						if (!user && (seaFB || waterC) && seaOff) continue;   // 海の点火ゲート（直描きと同じ）
						if (bldFill.li >= 0 && d.li === bldFill.li) continue;   // 3D＝フットプリント塗りは伏せる
						pass.setVertexBuffer(0, d.bPos); pass.setVertexBuffer(1, d.bCol);
						if (d.bIdx) { pass.setIndexBuffer(d.bIdx, "uint32"); pass.drawIndexed(d.count); } else pass.draw(d.count);
					}
				}
			}
			if (hook) {   // gint の面（基図の塗りの上・ラスタ重ねの下）＝pass を切り、gint が自分の pass（stencil 付き）を同じエンコーダへ足す
				pass.end();
				try { gnd.faces += hook(cam, { enc, view: a.view0, size: a.size, win: a.win, index }) | 0; } catch (e) { console.error("[gpu] ground hook", e?.message); }
				pass = enc.beginRenderPass({ colorAttachments: [{ view: a.view0, loadOp: "load", storeOp: "store" }] });
			}
			drawTiles("over");
			pass.end();
		}
		device.queue.submit([enc.finish()]);
		for (const { a } of jobs) if (a.levels > 1) genMips(a.tex, a.levels);   // 斜め視のちらつき防止（queue 順＝合成の後）
	}
	const dummyMask = device.createTexture({ size: [1, 1], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummyMaskView = dummyMask.createView();
	// building group(2)：mask params UBO（count vec4u + 4×bbox vec4f＝80B）＋4テクスチャ＋sampler。
	// active mask 集合が変わった時だけ作り直す（毎フレーム生成を避ける）。
	const maskParamBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const maskParamCPU = new ArrayBuffer(96);
	const maskParamU = new Uint32Array(maskParamCPU), maskParamF = new Float32Array(maskParamCPU);
	let maskBG = null, maskSig = "";
	function buildMaskBG(active, origin) {
		// 区と版（rev）の並び＋origin＝シグネチャ。区が入れ替わる（カメラ移動で近い 4 区が変わる）・テクスチャ/bbox の差し替え・
		// シーン差し替え（off の焼き直し）のどれでも作り直す（旧＝m.ward が無く件数しか見ておらず、原点が同じまま 4 区が
		// 入れ替わると古い BG が残って別の区のマスクが基図建物を伏せた・2026-09-27）
		const sig = active.map(m => m.ward + ":" + m.rev).join("|") + "@" + origin[0] + "," + origin[1];
		if (maskBG && sig === maskSig) return maskBG;   // active 集合・版・origin 不変＝作り直さない
		maskSig = sig;
		maskParamU[0] = active.length;
		for (let i = 0; i < MAX_MESH_MASKS; i++) {
			// スロットは (off, inv)＝FS の uv = off + rel×inv。off=(origin−bboxMin)/span を JS の f64 で前計算＝
			// FS は原点相対の小値だけ扱う（絶対経緯度 varying の f32 ジッタ＝深ズームの点描ゴースト根治・gl 同文）。空きは uv 圏外。
			const bb = active[i] && active[i].bbox;
			const sx = bb ? bb[2] - bb[0] : 1, sy = bb ? bb[3] - bb[1] : 1;
			maskParamF[4 + i * 4] = bb ? (origin[0] - bb[0]) / sx : 2e9;
			maskParamF[5 + i * 4] = bb ? (origin[1] - bb[1]) / sy : 2e9;
			maskParamF[6 + i * 4] = bb ? 1 / sx : 0;
			maskParamF[7 + i * 4] = bb ? 1 / sy : 0;
		}
		device.queue.writeBuffer(maskParamBuf, 0, maskParamCPU);
		maskBG = device.createBindGroup({ layout: bglMask, entries: [
			{ binding: 0, resource: { buffer: maskParamBuf } },
			{ binding: 1, resource: active[0] ? active[0].view : dummyMaskView },
			{ binding: 2, resource: active[1] ? active[1].view : dummyMaskView },
			{ binding: 3, resource: active[2] ? active[2].view : dummyMaskView },
			{ binding: 4, resource: active[3] ? active[3].view : dummyMaskView },
			{ binding: 5, resource: maskSampler },
		] });
		return maskBG;
	}
	// gintBld 用の固定「マスク無し」BG（count=0・専用 param）＝building の maskParamBuf 共有によるフレーム毎 thrashing を避ける
	const emptyMaskParamBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // count=0 で初期化（createBuffer はゼロ）
	const emptyMaskBG = device.createBindGroup({ layout: bglMask, entries: [
		{ binding: 0, resource: { buffer: emptyMaskParamBuf } },
		{ binding: 1, resource: dummyMaskView }, { binding: 2, resource: dummyMaskView },
		{ binding: 3, resource: dummyMaskView }, { binding: 4, resource: dummyMaskView }, { binding: 5, resource: maskSampler },
	] });
	function freeMeshWard(ward) {
		castRev++;
		for (const k of [...meshes.keys()]) {
			if (k !== ward && !k.startsWith(ward + "#")) continue;
			const p = meshes.get(k);
			p.vbo.destroy(); p.nbo.destroy(); p.ibo.destroy(); p.uvbo?.destroy(); p.cbo?.destroy(); for (const t of p.texs || []) t?.tex.destroy();
			meshes.delete(k);
		}
		const m = meshMasks.get(ward);
		if (m) { m.tex.destroy(); meshMasks.delete(ward); }
		meshHidden.delete(ward);
		maskSig = "\0";   // active 集合が変わり得る＝次フレーム再構築を強制
	}
	function setMeshSet(key, data) {
		castRev++;
		if (!data) { freeMeshWard(key); return; }   // key=区名：全バッチ+マスク解放
		const old = meshes.get(key);
		if (old) { old.vbo.destroy(); old.nbo.destroy(); old.ibo.destroy(); old.uvbo?.destroy(); old.cbo?.destroy(); for (const t of old.texs || []) t?.tex.destroy(); meshes.delete(key); }
		if (data.pos?.length && data.idx?.length) {
			const nrm = data.nrm instanceof Int8Array ? data.nrm : Int8Array.from(data.nrm || new Int8Array(data.pos.length / 3 * 4));
			const vbo = device.createBuffer({ size: (data.pos.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
			const nbo = device.createBuffer({ size: (nrm.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
			const ibo = device.createBuffer({ size: (data.idx.byteLength + 3) & ~3, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
			device.queue.writeBuffer(vbo, 0, data.pos.buffer, data.pos.byteOffset, data.pos.byteLength);
			device.queue.writeBuffer(nbo, 0, nrm.buffer, nrm.byteOffset, nrm.byteLength);
			device.queue.writeBuffer(ibo, 0, data.idx.buffer, data.idx.byteOffset, data.idx.byteLength);
			const textured = !!(data.uv && data.col); let uvbo = null, cbo = null, texs = null, texBG = null;   // 模型（glb 直読み）
			if (textured) {
				uvbo = device.createBuffer({ size: (data.uv.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
				cbo = device.createBuffer({ size: (data.col.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
				device.queue.writeBuffer(uvbo, 0, data.uv.buffer, data.uv.byteOffset, data.uv.byteLength);
				device.queue.writeBuffer(cbo, 0, data.col.buffer, data.col.byteOffset, data.col.byteLength);
				texs = ["tex", "texMR", "texN", "texOcc", "texEm"].map((k, i) => meshTexture(data[k], TEX_SRGB[i]));   // baseColor＋材質 4 枚（#46 段 2）
				texBG = meshTexBG(texs);
			}
			const pb = data.pbr || null;   // 材質の数値（metallic, roughness, normalScale, occlusion, emissive[3]）＝無ければ既定（金属 0・粗さ 1）
			// α の扱い（模型）：cut＝これ未満は discard（MASK=alphaCutoff・OPAQUE=−1＝テクスチャの α を無視・BLEND=1/255）／blend＝半透明＝奥から手前・深度書き込み無し
			const blend = textured && data.alphaMode === "BLEND", cut = !textured ? -1 : data.alphaMode === "MASK" ? (data.alphaCutoff ?? 0.5) : blend ? 1 / 255 : -1;
			meshes.set(key, { vbo, nbo, ibo, textured, blend, cut, uvbo, cbo, texs, texBG, pbr: pb, count: data.idx.length, origin: data.origin || [0, 0, 0],
				bbox: data.bbox || [1e9, 1e9, -1e9, -1e9], ward: data.ward || String(key).split("#")[0],
				lodH: data.lodH || null, lodCounts: data.lodCounts || null, two: data.twoSided ? 1 : 0, noLift: !!data.noLift, drape: !!data.drape, keep2d: !!data.keep2d,
				noCast: data.castShadow === false || (!!data.keep2d && data.castShadow !== true) });   // 影を落とさない（#112 段 1）＝keep2d は出元が castShadow:true と言った時だけ落とす（統計の柱は落とさない）   // noLift＝地形へ持ち上げない（平面に浮かせる）／drape＝DTM 保証域に縛らず全ズームで地形へ持ち上げる／keep2d＝真俯瞰でも描き・高さの間引きをしない（統計の押し出し・2026-09-22）
		}
		// 被覆マスク（r8unorm・NEAREST）＝届いたバッチの断片(maskCells)だけをOR合成。
		// 旧・全量スナップショット差し替えはマスクがメッシュに先行し「基図は伏せたのに建物メッシュが無い」
		// 矩形の隙間を作った（demote/cancel/復元中断で顕在化）。断片方式ならマスクはメッシュと同時にしか
		// 育たず、解放は区単位（freeMeshWard＝メッシュとマスクを同時破棄）で対称＝隙間は構造的に出ない。
		if (data.ward && (data.maskCells || data.mask) && (data.maskN | 0) > 0 && data.maskBbox) {
			const N = data.maskN | 0;
			let m = meshMasks.get(data.ward);
			if (!m || m.n !== N) {
				if (m) m.tex.destroy();
				const tex = device.createTexture({ size: [N, N], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
				m = { ward: data.ward, rev: 0, tex, view: tex.createView(), bbox: data.maskBbox, n: N, bytes: new Uint8Array(N * N) };
				meshMasks.set(data.ward, m);
			}
			m.bbox = data.maskBbox;
			if (data.maskCells) { for (let i = 0; i < data.maskCells.length; i++) { const c = data.maskCells[i]; if (c < m.bytes.length) m.bytes[c] = 255; } }
			else for (let i = 0; i < data.mask.length && i < m.bytes.length; i++) if (data.mask[i]) m.bytes[i] = 255;   // 旧worker互換（全量OR＝単調なので破壊しない）
			device.queue.writeTexture({ texture: m.tex }, m.bytes, { bytesPerRow: N, rowsPerImage: N }, [N, N]);
			m.rev = ++maskRevSeq;
			maskSig = "\0";   // 次フレーム再構築
		}
	}
	function setMeshVis(ward, on) {
		castRev++;
		if (on) meshHidden.delete(ward); else meshHidden.add(ward);
		maskSig = "\0";   // 非表示区はマスクスロットから外す＝基図建物が戻る（次フレーム再構築）
	}
	// バッチ bbox（経緯度deg）の可視判定＝gl/renderer.js meshBboxVisible と同一（4隅+中心を投影）
	function meshBboxVisible(st, bbox, center, pad) {
		if (center[0] >= bbox[0] && center[0] <= bbox[2] && center[1] >= bbox[1] && center[1] <= bbox[3]) return true;
		const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]], [(bbox[0] + bbox[2]) * 0.5, (bbox[1] + bbox[3]) * 0.5]];
		let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, nf = 0;
		for (const q of pts) {
			const [sx, sy, f] = project(st, q[0], q[1]);
			if (f < 0) continue;
			nf++;
			if (sx < minx) minx = sx; if (sx > maxx) maxx = sx;
			if (sy < miny) miny = sy; if (sy > maxy) maxy = sy;
		}
		if (!nf) return false;
		return !(maxx < -pad || minx > st.W + pad || maxy < -pad || miny > st.H + pad);
	}

	// --- シーン（classic merge）：slot → { origin, draws, bld } ---
	const scenes = {
		base: { origin: [0, 0], draws: [], bld: null },
		main: { origin: [0, 0], draws: [], bld: null },
		user: { origin: [0, 0], draws: [], bld: null },   // 利用者の vector source の塗りと線（段 8⑤）＝空なら slots に入らない＝今までと同じ絵
	};
	let dbg = null;   // 直近フレームの描画実績（?drawhud=1 の実機計器。draw() が毎フレーム詰め替える）
	function makeBuf(data, usage) {
		const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
		return b;
	}
	const u8col = col => col instanceof Uint8Array ? col : Uint8Array.from(col, v => Math.max(0, Math.min(255, Math.round(v * 255))));   // geojson 由来 float32 の保険
	function disposeFadePrev(slot) {
		const fp = scenes[slot].fadePrev;
		if (!fp) return;
		for (const d of fp.draws) for (const b of d.bufs) b.destroy();
		if (fp.bld) for (const b of fp.bld.bufs) b.destroy();
		scenes[slot].fadePrev = null;
	}
	function disposeSlot(slot) {
		disposeFadePrev(slot);
		for (const d of scenes[slot].draws) for (const b of d.bufs) b.destroy();
		if (scenes[slot].bld) for (const b of scenes[slot].bld.bufs) b.destroy();
		scenes[slot] = { origin: scenes[slot].origin, draws: [], bld: null };
	}
	function setScene(s, slot = "main") {
		if (!scenes[slot]) return;   // overlay 等の未知スロットは対象外
		const pT0 = self.__perfScene ? performance.now() : 0;   // 計器 b（?perf=1）
		sceneRev++;   // 地面アトラス（3D の塗り）の再合成の鍵
		// クロスフェード：main の同一原点差し替え（ロード流入中の典型）は旧シーンを FADE_MS だけ温存し
		// 新シーンをα昇順で重ねる＝classic merge の「ポンッ」を溶かす（モバイルのパラパラ感対策）。
		// 原点が変わる大移動は従来どおり即替え（旧シーンの Frame origin が異なり二重描画できないため）。
		// ?nofade=1＝クロスフェードを丸ごと止める切り分けノブ（WebGPU にしか無い機構＝実機で「遷移中だけ壊れる」
		// 現象の容疑者。Android 実機で基図が黒く落ちる報告 2026-08-03。旧シーンは即破棄＝Phase 6 以前の挙動）。
		let keepPrev = null;
		if (!rOpts.noFade && slot === "main" && scenes[slot].draws.length && scenes[slot].origin && s.origin
			&& scenes[slot].origin[0] === s.origin[0] && scenes[slot].origin[1] === s.origin[1]) {
			disposeFadePrev(slot);
			keepPrev = { draws: scenes[slot].draws, bld: scenes[slot].bld };
			scenes[slot].draws = []; scenes[slot].bld = null;   // disposeSlot に破棄させない（付け替え）
		}
		disposeSlot(slot);
		const draws = [];
		for (const L of s.layers || []) {
			if (!L) continue;
			if (L.kind === "fill") {
				if (!L.pos.length) continue;
				const bPos = makeBuf(L.pos, GPUBufferUsage.VERTEX), bCol = makeBuf(u8col(L.col), GPUBufferUsage.VERTEX);
				const hasIdx = L.idx && L.idx.length;
				const bIdx = hasIdx ? makeBuf(L.idx instanceof Uint32Array ? L.idx : Uint32Array.from(L.idx), GPUBufferUsage.INDEX) : null;
				draws.push({ kind: "fill", li: L.li, bufs: bIdx ? [bPos, bCol, bIdx] : [bPos, bCol], bPos, bCol, bIdx, count: hasIdx ? L.idx.length : L.pos.length / 2 });
			} else {
				if (!L.half.length) continue;
				const bP1 = makeBuf(L.P1, GPUBufferUsage.VERTEX), bP2 = makeBuf(L.P2, GPUBufferUsage.VERTEX);
				const bCol = makeBuf(u8col(L.col), GPUBufferUsage.VERTEX), bHalf = makeBuf(L.half, GPUBufferUsage.VERTEX);
				const bOff = L.off ? makeBuf(L.off, GPUBufferUsage.VERTEX) : null;   // line-offset を持つ層だけ（無い層は共有の 0 列）
				if (!bOff) zeroOffFit(L.half.length);
				draws.push({ kind: "line", li: L.li, bufs: bOff ? [bP1, bP2, bCol, bHalf, bOff] : [bP1, bP2, bCol, bHalf], bP1, bP2, bCol, bHalf, bOff, count: L.half.length });
			}
		}
		let bld = null;
		if (s.buildings && s.buildings.pos.length) {
			const bPos = makeBuf(s.buildings.pos, GPUBufferUsage.VERTEX), bSh = makeBuf(s.buildings.shade, GPUBufferUsage.VERTEX), bAnc = makeBuf(s.buildings.anchor, GPUBufferUsage.VERTEX);
			bld = { bufs: [bPos, bSh, bAnc], bPos, bSh, bAnc, count: s.buildings.pos.length / 3 };
		}
		scenes[slot] = { origin: s.origin, draws, bld, fadePrev: keepPrev, fadeT0: keepPrev ? performance.now() : 0 };
		if (pT0) {   // 計器 b（perf plan §1）：描画スレッドでのシーン適用＝全層の createBuffer＋writeBuffer の時間と量。4ms 超は引っ掛かりとして数える（mem テレメトリの hitch.scene）
			let bytes = 0, n = 0;
			for (const L of s.layers || []) { if (!L) continue; n++; for (const k of ["pos", "col", "idx", "P1", "P2", "half", "off"]) if (L[k]) bytes += L[k].byteLength; }
			if (s.buildings) bytes += s.buildings.pos.byteLength + s.buildings.shade.byteLength + s.buildings.anchor.byteLength;
			const ms = performance.now() - pT0;
			if (ms > 4) (self.__perfHitch ||= { elev: 0, scene: 0 }).scene++;
			console.log(`[scene] apply ${slot} ${ms.toFixed(1)}ms ${(bytes / 1024) | 0}KB layers=${n} fade=${keepPrev ? 1 : 0}`);
		}
	}

	// frame UBO の詰め物（wgsl.js Frame と厳密対応）。RTE 錨（clipT/originPt/trig）は CPU double で。
	const frameF32 = new Float32Array(FRAME_F32);
	let qMesh = null, qG = 0;   // 案A: fill/line slot へ配る近メッシュ窓と格子 G（draw が terrainActive で毎フレーム更新）
	// 全画面レイキャスト（球の床・海面下・経緯線・等高線・夜面）の視線一式（#65）を f32 配列の at から 16 要素（rayF/rayX/rayY/eyeC）に詰める。
	// 中身は camera.js sphereRayUniforms（f64・st に記憶＝フレームに一度）＝wgsl.js の RAY 節と対
	function packRays(a, at, st) {
		const u = sphereRayUniforms(st);
		a[at] = u.F[0]; a[at + 1] = u.F[1]; a[at + 2] = u.F[2]; a[at + 3] = 0;
		a[at + 4] = u.X[0]; a[at + 5] = u.X[1]; a[at + 6] = u.X[2]; a[at + 7] = 0;
		a[at + 8] = u.Y[0]; a[at + 9] = u.Y[1]; a[at + 10] = u.Y[2]; a[at + 11] = 0;
		a[at + 12] = u.E[0]; a[at + 13] = u.E[1]; a[at + 14] = u.E[2]; a[at + 15] = u.c;
	}
	function packFrame(st, origin, fogNear, fogFar, fogColor, logCoef, dpr, mesh, farPass) {
		const f = frameF32;
		f.set(st.mvp, 0);
		packRays(f, 16, st);   // 全画面レイキャストの視線一式（#65・rayF/rayX/rayY/eyeC＝旧 invMvp の枠）：等高線が読む
		const oPt = lonlatTo3D(origin[0], origin[1]);
		const cT = mat.transform(st.mvp, [oPt[0], oPt[1], oPt[2], 1]);
		f[32] = cT[0]; f[33] = cT[1]; f[34] = cT[2]; f[35] = cT[3];
		// 楕円体＝緯度側は β（更成緯度）の三角（球＝β=φ＝従来値。glsl 側 setCommonUniforms と同判断）
		const lr = origin[0] * Math.PI / 180, br = betaOf(origin[1]) * Math.PI / 180;
		f[36] = Math.cos(lr); f[37] = Math.sin(lr); f[38] = Math.cos(br); f[39] = Math.sin(br);
		f[40] = oPt[0]; f[41] = oPt[1]; f[42] = oPt[2]; f[43] = 0;
		f[44] = st.eye[0]; f[45] = st.eye[1]; f[46] = st.eye[2]; f[47] = 0;
		f[48] = origin[0]; f[49] = origin[1];
		f[50] = canvas.width; f[51] = canvas.height;
		f[52] = fogColor[0]; f[53] = fogColor[1]; f[54] = fogColor[2]; f[55] = 0;
		f[56] = fogNear; f[57] = fogFar; f[58] = logCoef; f[59] = dpr;
		f[60] = elev.bounds[0]; f[61] = elev.bounds[1]; f[62] = elev.bounds[2]; f[63] = elev.bounds[3];
		f[64] = elevScaleEff; f[65] = elev.has; f[66] = elev.edgeFade || 0; f[67] = 0;
		// mesh（地形メッシュの窓：原点lon/lat＋幅deg）＝terrain/terrainFar slot のみ。他スロットは 0（未使用）
		f[68] = mesh ? mesh[0] : 0; f[69] = mesh ? mesh[1] : 0; f[70] = mesh ? mesh[2] : 0; f[71] = mesh ? mesh[3] : 0;
		// 遠景層（far）：bounds/has/edgeFade は全スロット共通（elev() のフォールバック参照）・farPass は terrainFar slot のみ 1
		f[72] = far.bounds[0]; f[73] = far.bounds[1]; f[74] = far.bounds[2]; f[75] = far.bounds[3];
		f[76] = far.has; f[77] = far.edgeFade || 0; f[78] = farPass ? 1 : 0; f[79] = 0;
		// 楕円体 dβ 錨（原点の測地緯度 2φ/4φ 三角・CPU double）＋ゲート。球＝全0＝シェーダ補正が厳密0
		const _ell = ellipsoidOn(), _pr = origin[1] * Math.PI / 180;
		f[80] = _ell ? Math.cos(2 * _pr) : 0; f[81] = _ell ? Math.sin(2 * _pr) : 0;
		f[82] = _ell ? Math.cos(4 * _pr) : 0; f[83] = _ell ? Math.sin(4 * _pr) : 0;
		f[84] = _ell ? 1 : 0; f[85] = 0; f[86] = 0; f[87] = 0;
		// 案A: terrain系 slot（mesh 引数あり）は自前の窓＝elevQ 不使用（ellP.y=0）。fill/line 系は近窓+G を配る
		if (!mesh && qMesh) { f[68] = qMesh[0]; f[69] = qMesh[1]; f[70] = qMesh[2]; f[71] = qMesh[3]; f[85] = qG; }
		// ユーザ COG uv 係数（f64 前計算＝f32 絶対経緯度ジッタ根治）：terrain系 slot（mesh 有）＝a_uv 変換・fill系＝dLL 変換
		if (cogGeo) {
			const [W, S, sLon, sLat] = cogGeo;
			if (mesh) { f[88] = (mesh[0] - W) / sLon; f[89] = (mesh[1] - S) / sLat; f[90] = mesh[2] / sLon; f[91] = mesh[3] / sLat; }
			else { f[88] = (origin[0] - W) / sLon; f[89] = (origin[1] - S) / sLat; f[90] = 1 / sLon; f[91] = 1 / sLat; }
		} else { f[88] = 0; f[89] = 0; f[90] = 0; f[91] = 0; }
		{   // 等高線の交点を原点相対で持つ錨（#65）：eyeO＝目−originPt（f64）＋β0・elevOff＝近窓の uv 係数（f64）
			const u = sphereRayUniforms(st, origin), eo = anchorUV(origin, elev.bounds);
			f[108] = u.EO[0]; f[109] = u.EO[1]; f[110] = u.EO[2]; f[111] = u.beta0;
			f[112] = eo[0]; f[113] = eo[1]; f[114] = eo[2]; f[115] = eo[3];
		}
		f[116] = sunF[0]; f[117] = sunF[1]; f[118] = sunF[2]; f[119] = sunF[3];   // 太陽（#46 段 0）＝全スロット共通
		// 地面アトラス（近/中/遠）＝cogP と同形の係数（terrain系 slot＝a_uv 変換・fill系＝dLL 変換）
		for (let k = 0; k < 4; k++) {
			const i = 92 + k * 4, a = k < gnd.n ? gnd.w[k] : null;
			if (!a) { f[i] = 0; f[i + 1] = 0; f[i + 2] = 0; f[i + 3] = 0; continue; }
			const [W, S, sLon, sLat] = a.win;
			if (mesh) { f[i] = (mesh[0] - W) / sLon; f[i + 1] = (mesh[1] - S) / sLat; f[i + 2] = mesh[2] / sLon; f[i + 3] = mesh[3] / sLat; }
			else { f[i] = (origin[0] - W) / sLon; f[i + 1] = (origin[1] - S) / sLat; f[i + 2] = 1 / sLon; f[i + 3] = 1 / sLat; }
		}
		return f;
	}
	// DrawP N_ROLESスロットを一括で書く（256Bストライド・各48B使用）
	const paramF32 = new Float32Array(PARAM_SLOT / 4 * N_ROLES);
	function packParams({ cityLift, land, bldColor, contour, liftBounds, fadeK = 1, worldHypsoK = 0, hasClim = 0 }) {   // p0.y＝線の接地リフト（塗りは 3D では地面アトラス側＝リフト/厳密深度は撤去 2026-09-21）
		const baseA = view.baseAlpha ?? 1;   // 基図の濃さ（表示パネル）＝fill/line の p0.w に一括（COG は下層にも合成済み＝紙と線だけが引く）
		const f = paramF32; f.fill(0);
		const at = (role, vals) => { const o = role * (PARAM_SLOT / 4); for (let i = 0; i < vals.length; i++) f[o + i] = vals[i]; };
		at(ROLE.normal, [0, cityLift, 0, baseA]);
		at(ROLE.water, [0, 0, 0, baseA]);
		at(ROLE.seaFb, [1, 0, 0, baseA]);
		const hy = view.hypso;
		at(ROLE.terrain, [land[0], land[1], land[2], 0,
			hy ? hy.color[0] : 0, hy ? hy.color[1] : 0, hy ? hy.color[2] : 0, hy ? (hy.amount ?? 0.5) : 0,
			hy ? 1 / (hy.max || 3000) : 0, worldHypsoK, hasClim, view.globeAlpha ?? 1]);   // p2.y=全球ハイプソ出現度 p2.z=気候場到着 p2.w=球体の不透明度（gl 側 u_whK/u_hasClim/u_globeAlpha と同義）
		at(ROLE.bld, [bldColor[0], bldColor[1], bldColor[2], 1]);
		at(ROLE.contour, [contour.color[0], contour.color[1], contour.color[2], contour.interval,
			contour.major, contour.alpha, 0, 0]);
		// mesh: p0=liftBounds（DTM保証域・無ければ全0＝リフト無し）, p1=bldColor
		const lb = liftBounds || [0, 0, 0, 0];
		at(ROLE.mesh, [lb[0], lb[1], lb[2], lb[3], bldColor[0], bldColor[1], bldColor[2], 0]);
		// クロスフェード中の新シーン用＝通常ロールの複製＋p0.w=α（旧シーンは通常ロールでα1のまま下に描く）
		at(ROLE.fadeNormal, [0, cityLift, 0, fadeK * baseA]);
		at(ROLE.fadeWater, [0, 0, 0, fadeK * baseA]);
		at(ROLE.fadeSeaFb, [1, 0, 0, fadeK * baseA]);
		at(ROLE.fadeBld, [bldColor[0], bldColor[1], bldColor[2], fadeK]);
		at(ROLE.user, [0, cityLift, 0, 1]);   // 利用者の vector の層（段 8⑤）＝線の接地リフトは通常と同じ・濃さは 1
		return f;
	}

	// MSAA カラー＋深度ターゲット（canvas 寸法に追随・sampleCount 毎＝遷移時AA）。resolve 先は毎フレーム getCurrentTexture。
	// 1x（遷移フレーム／?msaa=0）はカラーを作らない＝全パスが canvas の current texture へ直描き（resolve 自体が消える）。
	// 1x/4x 両方が生きる（遷移⇄静止で行き来）＝両方保持。追加費用は 1x 深度1枚（W×H×4B）のみ。
	const tgtBySc = new Map();   // sampleCount → { tex, depth, view, depthView, w, h }
	function targets(W, H, sc) {
		let t = tgtBySc.get(sc);
		if (!t || t.w !== W || t.h !== H) {
			if (t) { t.tex?.destroy(); t.depth.destroy(); }
			const tex = sc > 1 ? device.createTexture({ size: [W, H], sampleCount: sc, format, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
			// TEXTURE_BINDING＝深度の書き出し（#47）が読む。常に付ける（費用なし）＝申し出の出入りでターゲットを作り直さない
			const depth = device.createTexture({ size: [W, H], sampleCount: sc, format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
			t = { tex, depth, view: tex ? tex.createView() : null, depthView: depth.createView(), w: W, h: H };
			tgtBySc.set(sc, t);
			memMsaa = 0;   // color(bgra8・1xは直描き=0)+depth24plus-stencil8 ≈ 各4B/sample（生存セットの合算）
			for (const [c, x] of tgtBySc) memMsaa += x.w * x.h * c * ((c > 1 ? 4 : 0) + 4);
		}
		return t;
	}

	// 影を落とす側のパス（太陽の正射影で深度だけ）：基図の押し出し建物（main シーン・被覆マスクで PLATEAU の所は伏せる）＋建物メッシュ
	//（非表示の区・noCast＝統計の柱や出元が申告しない keep2d・半透明の模型は落とさない）。窓の外のバッチは粗い距離判定で飛ばす。真俯瞰でも描く＝平面の地面に影。
	function encodeShadowCasters(enc, win, cam, opts, terrOn, clipPl) {   // terrOn＝地形も落とす（#112 段 2・地形が描かれているフレームだけ＝真俯瞰は平ら）・clipPl＝断面の面（#111 段 2＝切った形で落とす・null＝切らない）
		const bld0 = !(opts && opts.skipMain) && !(opts && opts.noBld) ? scenes.main.bld : null;
		// 窓（行列）・中身の版・標高リフト・マスク・建物シーンが前回と同じ＝深度テクスチャはそのまま使える（静止中は影のコストほぼ 0）
		const key = `${win.mvp.join(",")}|${castRev}|${elevScaleEff}|${qG}|${qMesh ? qMesh.join(",") : ""}|${maskSig}|${elev.has}|${far.has}|${terrOn ? 1 : 0}|${clipPl ? JSON.stringify(clipPl) : ""}|${clipPl ? (scenes.main.origin || [0, 0]).join(",") : ""}`;   // 面が変われば描き直す（面の K は main 原点に依る）
		const KC = clipPl ? clipCastPipes() : null, KX = clipPl ? clipShBG() : null;   // 切った形で落とす（#111 段 2）・clipPl＝対象ごとの面（段 4）
		if (sh.castKey === key && sh.castBld === bld0) { shStat.skipped++; return; }
		sh.castKey = key; sh.castBld = bld0;
		const spDesc = { colorAttachments: [], depthStencilAttachment: { view: sh.view, depthLoadOp: "clear", depthClearValue: 1.0, depthStoreOp: "store" }, timestampWrites: passTS("shadow") };   // GPU 実時間＝tag "shadow"（#112 段 0）
		let sp;
		try { sp = enc.beginRenderPass(spDesc); }
		catch (err) {   // timestampWrites 非対応の環境＝main パスと同じく TQ を畳んで無計測で続行
			if (!tq) throw err;
			tqOff(err);
			delete spDesc.timestampWrites;
			sp = enc.beginRenderPass(spDesc);
		}
		const cnt = { bldTris: 0, meshBatches: 0, meshTris: 0, terrTris: 0 };
		if (terrOn) {   // 地形＝影の窓に太陽方向で投げて掛かるチャンクだけ（カメラの視野では刈らない＝画面の外の山も画面の中へ落とす）。z13 の近窓 8° のうち 1〜数チャンク
			const runs = shadowChunkRuns(terrain.chunks, terrain.mesh, win.mvp, 1 + TERR_HMAX_M * (elev.scale || 0));
			if (runs.length) {
				sp.setPipeline(KC ? KC.terr : sh.cast.terr);
				sp.setBindGroup(0, shadowBG0("bg0T"));
				if (KC) sp.setBindGroup(1, cl.bg.terrain);
				sp.setVertexBuffer(0, terrain.vbo);
				sp.setIndexBuffer(terrain.ibo, "uint32");
				for (const [f0, n] of runs) { sp.drawIndexed(n, 1, f0); cnt.terrTris += n / 3; }
			}
		}
		const bg0s = shadowBG0("bg0");
		const bld = !(opts && opts.skipMain) && !(opts && opts.noBld) ? scenes.main.bld : null;
		if (bld) {
			const mcx = cam.center[0], mcy = cam.center[1], mcw = Math.cos(mcy * Math.PI / 180);
			const mdist = m => { const bb = m.bbox; const dx = Math.max(bb[0] - mcx, 0, mcx - bb[2]) * mcw, dy = Math.max(bb[1] - mcy, 0, mcy - bb[3]); return dx * dx + dy * dy; };
			const act = [...meshMasks.entries()].filter(([w]) => !meshHidden.has(w)).map(([, m]) => m).sort((a, b) => mdist(a) - mdist(b)).slice(0, MAX_MESH_MASKS);
			sp.setPipeline(KC ? KC.bld : sh.cast.bld);
			sp.setBindGroup(0, bg0s);
			sp.setBindGroup(1, paramBG[ROLE.bld]);
			sp.setBindGroup(2, buildMaskBG(act, scenes.main.origin || [0, 0]));   // main パスと同じ鍵＝キャッシュ命中
			if (KC) sp.setBindGroup(3, cl.bg.buildings);
			sp.setVertexBuffer(0, bld.bPos); sp.setVertexBuffer(1, bld.bSh); sp.setVertexBuffer(2, bld.bAnc);
			sp.draw(bld.count);
			cnt.bldTris = bld.count / 3;
		}
		if (meshes.size) {
			const list = [];
			for (const p of meshes.values()) {
				if (list.length >= MAX_PL_BATCH) break;
				if (meshHidden.has(p.ward) || p.noCast || p.blend) continue;
				if (!bboxInShadowWindow(win.mvp, p.bbox, SH_CAST_HMAX_M)) continue;   // 窓の矩形に太陽方向で投げて掛からない束は落とさない（#112 段 3・旧＝窓の半幅×1.5＋影の長さの円）
				const slot = list.length, o = slot * (PL_BATCH_SLOT / 4), b = sh.batchCPU;
				const cM = mat.transform(win.mvp, [p.origin[0], p.origin[1], p.origin[2], 1]);
				b[o] = p.origin[0]; b[o + 1] = p.origin[1]; b[o + 2] = p.origin[2]; b[o + 3] = 0;
				b[o + 4] = cM[0]; b[o + 5] = cM[1]; b[o + 6] = cM[2]; b[o + 7] = cM[3];
				const mask = p.textured && p.cut > 0;   // 模型の MASK（葉など）＝α で抜く落とす側（#112 段 4）
				b[o + 8] = mask ? p.cut : -1; b[o + 9] = 0; b[o + 10] = p.noLift ? 1 : 0; b[o + 11] = p.drape ? 1 : 0;
				if (clipPl) { const O = lonlatTo3D(...(scenes.main.origin || [0, 0])); b[o + 60] = p.origin[0] - O[0]; b[o + 61] = p.origin[1] - O[1]; b[o + 62] = p.origin[2] - O[2]; }   // clipO（#111 段 2）
				list.push({ p, slot, mask });
			}
			if (list.length) {
				device.queue.writeBuffer(sh.batch, 0, sh.batchCPU.buffer, 0, list.length * PL_BATCH_SLOT);
				for (const tex of [false, true]) {   // 頂点だけ（建物・不透明の模型）→ α で抜く（MASK の模型）
					const part = list.filter(e => e.mask === tex);
					if (!part.length) continue;
					sp.setPipeline(tex ? (KC ? KC.meshTex : sh.cast.meshTex) : (KC ? KC.mesh : sh.cast.mesh));
					sp.setBindGroup(0, bg0s);
					sp.setBindGroup(1, paramBG[ROLE.mesh]);
					for (const { p, slot } of part) {
						if (KC && !tex) sp.setBindGroup(3, p.textured ? cl.bg.models : cl.bg.buildings);   // 対象ごとの面（段 4）＝模型か建物メッシュか
						sp.setBindGroup(2, KC && tex ? KX.castPlBG : sh.batchBG, [slot * PL_BATCH_SLOT]);
						sp.setVertexBuffer(0, p.vbo); sp.setVertexBuffer(1, p.nbo);
						if (tex) { sp.setVertexBuffer(2, p.uvbo); sp.setVertexBuffer(3, p.cbo); sp.setBindGroup(3, p.texBG); }
						sp.setIndexBuffer(p.ibo, "uint32");
						sp.drawIndexed(p.count);
						cnt.meshTris += p.count / 3;
					}
				}
				cnt.meshBatches = list.length;
			}
		}
		sp.end();
		shStat.passes++;
		shStat.last = { N: SH_N, halfM: win.texelM * SH_N / 2, texelM: win.texelM, altDeg: win.alt * 180 / Math.PI, mvp: Array.from(win.mvp), ...cnt };
	}
	// frame＝開いたコマンドエンコーダ＋描画の的（gint が自分の render pass を足す口）。flush() で resolve→submit。
	let frame = null, gctx = null;
	function draw(cam, opts) {
		if (frame) flush();   // 保険：前フレームの flush 漏れ（例外経路）を清算してから
		const W = canvas.width, H = canvas.height;
		if (!W || !H) return false;
		// 遷移時AA：opts.aa===false（renderworker がカメラ遷移・アニメ継続中に指定）＝このフレームは 1x 直描き。
		// 既定（未指定＝snapshot/print 含む）＝SAMPLES（品質段）。パイプラインとターゲットをセットごと取替。
		const S = opts && opts.aa === false ? 1 : SAMPLES;
		P = pipesFor(S); clipS = S;
		const st = cameraState(cam, W, H);
		// フォグ距離の臨界減衰追従（gl/renderer.js draw と同式・同閾値）
		if (!fogDist) fogDist = st.camDist;
		else fogDist += (st.camDist - fogDist) * 0.18;
		if (Math.abs(st.camDist - fogDist) < st.camDist * 0.002) fogDist = st.camDist;
		st.fogDist = fogDist;
		const fogAnimating = fogDist !== st.camDist;
		// 視程下限のチルト係数／真俯瞰では標高オフ・傾けるほどフェードイン（gl/renderer.js と同式）
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14));
		const pf = pt * pt * (3 - 2 * pt);
		elevScaleEff = elev.scale * pf;
		const land = view.land || [0.96, 0.96, 0.95, 1], atmo = view.atmo || [0.45, 0.62, 0.95, 0.6];
		// 建物の影：点灯中かつ建物の見えるズーム・太陽が地平線の上の時だけ窓が立つ（null＝このフレームは影なし＝従来経路そのまま）
		const shWin = shadow.on && cam.zoom >= 13 ? shadowWindow(sunVector(shadow.time ?? clockNow(view.clock)), cam.center, shadowHalfM(cam.zoom, cam.center[1], W, H, cam.dpr || 1), SH_N) : null;
		// 断面（#111）の面＝対象ごと（段 4）にこのフレームで作り直す（楕円体の切替にも追従）。どれかの対象に面があれば「切っている」
		const tp = clip ? { terrain: clipPlanesFor(clip, "terrain"), buildings: clipPlanesFor(clip, "buildings"), models: clipPlanesFor(clip, "models"), vector: clipPlanesFor(clip, "vector") } : null;
		const clipAny = !!tp && (tp.terrain.length + tp.buildings.length + tp.models.length + tp.vector.length) > 0;
		const flat2d = !shWin && !clipAny && (cam.pitch || 0) < 0.02 && cam.zoom >= 9 && !cogHas && !gnd.rasterOn;   // 影と断面の間は球の床を描く（真俯瞰の地面も影を受ける・床の切れ目を陸の色で埋めない）   // COG/画像タイル層の搭載中は真俯瞰でも globe パスを通す（陸の下地に画像を敷く唯一の層）
		const c = flat2d ? [land[0], land[1], land[2], 1] : (view.clear || [1, 1, 1, 1]);
		const _limb = Math.sqrt(Math.max((1 + st.camDist) * (1 + st.camDist) - 1, 1e-12));
		const logCoef = 2.0 / Math.log2(_limb * 1.15 + st.camDist + 1.0);
		const fogFarCap = Math.max(st.fogDist * 5.0, 0.026 * pfFog);   // fill/line/terrain 共通の終端＝線が地形に厳密追随
		const terrainActive = !!(terrain && elev.has && elevScaleEff > 1e-9) && !(opts && opts.noTerrain);
		qMesh = terrainActive ? terrain.mesh : null; qG = terrainActive ? terrain.G : 0;   // 案A: fill/line slot の QELEV 配布
		const terrainDepth = terrainActive;   // 地形の深度書き＝尾根の遮蔽（gl/renderer.js と同じ全ズーム）
		// z14切替のランプ化：DSM帯⇄都市帯のリフト（川面30⇄10m・接地0⇄5m）を z13.5→14 の0.5幅で連続モーフ＝
		// keepFine保持のズームアウトで露出した「跨いだ瞬間の段差ポップ」対策。両端値は実測チューニングのまま
		//（z≥14とz≤13.5の絵は従来と完全一致）。gl/renderer.js と同式。
		const cityK = terrainDepth ? Math.max(0, Math.min(1, (cam.zoom - 13.5) / 0.5)) : 0;
		const cityLift = 5 * cityK;   // 線の接地リフト（塗りは 3D では地面アトラス側）
		const hideBldFill = bldFill.li >= 0 && (cam.pitch || 0) >= 0.02;
		const dpr = cam.dpr || 1;
		const mainOrigin = scenes.main.origin || [0, 0];
		// 太陽（#46 段 0）：共通の時計の太陽方向（地球固定）と、シーン原点での昼の度合い（高度 −6°→+6°＝市民薄明の幅で 0→1）。
		// 影の shadow.time は影だけの時刻＝ここは時計に従う（面の照明は「その時刻の空」に合わせる・段 2）。
		// 評価点＝カメラの中心（シーンの原点は無い時に (0,0) へ落ちる＝レンダラ直叩き・世界ビュー）
		const sunAt = [cam.center[0], cam.center[1]];
		{ const sv = sunVector(clockNow(view.clock)), o3 = lonlatTo3D(sunAt[0], sunAt[1]);
			const alt = (sv[0] * o3[0] + sv[1] * o3[1] + sv[2] * o3[2]) / Math.hypot(o3[0], o3[1], o3[2]);   // sin(太陽高度)
			const t = Math.max(0, Math.min(1, (alt + 0.1045) / 0.209));   // sin(6°)=0.1045
			sunF[0] = sv[0]; sunF[1] = sv[1]; sunF[2] = sv[2]; sunF[3] = t * t * (3 - 2 * t); }
		// 空の環境光（#46 段 2）＝鍵（太陽 1e-3・原点 0.5°・ノブ）が変われば積み直す。lp.w＝固定光の重み（夜＝1−昼の度合い）
		const envKey = FX.pbr ? `${sunF[0].toFixed(3)},${sunF[1].toFixed(3)},${sunF[2].toFixed(3)}|${Math.round(sunAt[0] * 2)},${Math.round(sunAt[1] * 2)}|${view.atmScale ?? 4},${view.atmSun ?? 20},${view.pbrFill ?? 0.35}` : "";
		if (envKey && envKey !== envCache.key) { envCache.key = envKey; envCache.env = skyEnvCompute([sunF[0], sunF[1], sunF[2]], lonlatTo3D(sunAt[0], sunAt[1]), { k: view.atmScale ?? 4, sunI: view.atmSun ?? 20, fill: view.pbrFill ?? 0.35 }); }
		const env = envCache.env; env.lp[3] = 1 - sunF[3];
		rasterFlushFree();      // 前フレームは submit 済み＝退避されたタイルテクスチャをここで実際に破棄
		// 地面アトラス（RTT ドレープ）：窓と鍵を確定（packFrame が窓の係数を読む）→ Frame 書込 → 合成（別エンコーダ・main パスより先に submit）
		const slotsG = (opts && opts.skipMain) ? ["base"] : (opts && opts.skipBase) ? ["main"] : ["base", "main"];
		const userOn = scenes.user.draws.length > 0;   // 利用者の vector の層（段 8⑤）＝空なら足さない（鍵も Frame の書込も今と同じ）
		if (userOn) slotsG.push("user");
		const gndJob = prepareGround(cam, terrainActive, slotsG);
		// Frame 4スロット：base/main=fill/line（fogFar=cap）、terrain=遠山ブルー、bld=既定fog(2.5×/14×)
		device.queue.writeBuffer(frameBuf, SLOT.base * FRAME_SLOT, packFrame(st, scenes.base.origin || [0, 0], st.fogDist * 2.5, fogFarCap, land, logCoef, dpr));
		device.queue.writeBuffer(frameBuf, SLOT.main * FRAME_SLOT, packFrame(st, mainOrigin, st.fogDist * 2.5, fogFarCap, land, logCoef, dpr));
		const dc = view.distColor || [0.63, 0.72, 0.83];   // 空気遠近法＝遠くの山は青く霞む
		device.queue.writeBuffer(frameBuf, SLOT.terrain * FRAME_SLOT, packFrame(st, mainOrigin, Math.max(st.fogDist * 1.2, 0.008 * pfFog), fogFarCap, dc, logCoef, dpr, terrain ? terrain.mesh : null));
		const farActive = terrainActive && far.has && !!farTexObj;   // 遠景メッシュパス（terrain slot と同 fog・mesh=遠窓・farPass=1）
		if (farActive) device.queue.writeBuffer(frameBuf, SLOT.terrainFar * FRAME_SLOT, packFrame(st, mainOrigin, Math.max(st.fogDist * 1.2, 0.008 * pfFog), fogFarCap, dc, logCoef, dpr, far.bounds, 1));
		// 地形チャンクの可視区間（P4 step B）＝近窓・遠窓それぞれ（同じ単位格子・別の窓）。カメラの行列が同じ静止フレームでも安い（256 箱×20 点）
		const nearRuns = terrainActive ? terrRuns(terrain.mesh, st, "near") : null;
		const farRuns = farActive ? terrRuns(far.bounds, st, "far") : null;
		if (!farActive) { terrStat.far.drawn = 0; terrStat.far.of = 0; }
		device.queue.writeBuffer(frameBuf, SLOT.bld * FRAME_SLOT, packFrame(st, mainOrigin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr));
		if (userOn) device.queue.writeBuffer(frameBuf, SLOT.user * FRAME_SLOT, packFrame(st, scenes.user.origin || [0, 0], st.fogDist * 2.5, fogFarCap, land, logCoef, dpr));   // base/main と同じ fog
		if (shWin) {   // 影：太陽の正射影の Frame（落とす側）と ShadowP（受け手）
			shadowRes();
			device.queue.writeBuffer(sh.frameB, 0, packFrame({ mvp: shWin.mvp, invMvp: st.invMvp, eye: shWin.eye, rays: st.rays }, mainOrigin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr));
			// 地形を落とす側（#112 段 2）＝terrain スロットと同じ窓・同じ距離フェード（eye はカメラ＝画面の地形と同じ形）で行列だけ太陽
			if (terrainActive) device.queue.writeBuffer(sh.frameT, 0, packFrame({ mvp: shWin.mvp, invMvp: st.invMvp, eye: st.eye, rays: st.rays }, mainOrigin, Math.max(st.fogDist * 1.2, 0.008 * pfFog), fogFarCap, dc, logCoef, dpr, terrain.mesh));
			const oPt = lonlatTo3D(mainOrigin[0], mainOrigin[1]), cT = mat.transform(shWin.mvp, [oPt[0], oPt[1], oPt[2], 1]), u = sh.cpu;
			u.set(shWin.mvp, 0);
			u[16] = cT[0]; u[17] = cT[1]; u[18] = cT[2]; u[19] = cT[3];
			u[20] = oPt[0]; u[21] = oPt[1]; u[22] = oPt[2]; u[23] = 0;   // Frame.originPt と同じ f32 丸め（main スロットで差が厳密 0）
			u[24] = shadow.darkness ?? 0.66; u[25] = shadowBias(shWin); u[26] = 1 / SH_N; u[27] = SH_FADE_R0;
			device.queue.writeBuffer(sh.pBuf, 0, u);
		}
		// 断面（#111）：面は描画の原点からの相対（K を f64 で）。main＝地形（terrain/terrainFar も main と同じ原点）・建物・球の床・メッシュと模型（バッチ原点との差は PB の clipO）／
		// base・user＝そのシーンの原点（基図と利用者の層の塗りと線）
		const clipOPt = clipAny ? lonlatTo3D(mainOrigin[0], mainOrigin[1]) : null;
		clipFrame = clipAny && tp.vector.length ? { planes: tp.vector, st } : null;   // gint・外部ベクタ（#111 段 3）＝vector の面とカメラ（全画面レイ）
		if (clipOPt) {
			clipRes();
			const sty = clip.style;
			CLIP_SLOTS.forEach((k, i) => {   // 対象のスロット＝main 原点・塗りと線のスロット＝そのシーンの原点で vector の面。蓋はその対象に面がある時だけ
				const o = k === "base" || k === "user" ? (scenes[k].origin || [0, 0]) : mainOrigin, pl = tp[k] || tp.vector;
				packClip(pl, lonlatTo3D(o[0], o[1]), cl.cpu.subarray(i * CLIP_SLOT_B / 4, i * CLIP_SLOT_B / 4 + CLIP_F32), { ...sty, capOn: sty.capOn && pl.length > 0 });
			});
			device.queue.writeBuffer(cl.buf, 0, cl.cpu);
		}
		composeGround(gndJob, slotsG);   // 鍵が変わった時だけ（Frame 書込の後＝塗りの焼き込みが bg0[slot] の origin を読む）
		// 等高線：真俯瞰でだけ茶の等高線（gl/renderer.js と同式のフェード・間隔）
		const ps = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.01) / 0.05));
		const zf = 1 - Math.max(0, Math.min(1, (cam.zoom - 17.5) / 1.5));
		const rasterBase = gnd.rasterOn && !!(rasterDraws && rasterDraws.hideFills);   // ラスタ基図の間は湖・海面下陸地・等高線も伏せる（gl/renderer.js と対）
		const cAlpha = (elev.has && !(opts && opts.noTerrain) && view.showContour === true && !rasterBase) ? (1 - ps * ps * (3 - 2 * ps)) * zf : 0;
		const iv = cam.zoom >= 15 ? 15 : cam.zoom >= 12 ? 30 : 60;
		// クロスフェード進行（main の同一原点差し替え）：期限切れは旧を破棄、進行中は fadeK(0→1) を fade ロールへ
		let fadeK = 1, fading = false;
		if (scenes.main.fadePrev) {
			const fa = performance.now() - scenes.main.fadeT0;
			if (fa >= FADE_MS) disposeFadePrev("main");
			else { fadeK = fa / FADE_MS; fading = true; }
		}
		// 全球ハイプソの出現度（globe/terrain 共有＝ピッチで色が変わらない）。z5.7→6.5 フェードアウト
		// ＝R90 全球窓の限界に着地（gl/renderer.js と同式）。気候場テクスチャも必要時に一度だけ取得
		const whZ = view.worldHypsoZ ?? 6.5;   // 世界ハイプソの退場ズーム（gl/renderer.js と対・地域の申告が無い器は最後まで世界の色）
		const worldHypsoK = view.worldHypso && elev.has ? Math.max(0, Math.min(1, (whZ - cam.zoom) / 0.8)) : 0;
		if (worldHypsoK > 0) ensureClimTex(view.worldHypso.clim);
		worldPal();   // 世界パレット＝knob 参照変化時のみ worldPalBuf へ書込（バインドは常設）
		device.queue.writeBuffer(paramBuf, 0, packParams({
			fadeK,
			cityLift,
			land, bldColor: view.bldColor || [0.86, 0.86, 0.85],
			contour: { color: view.contourColor || [0.42, 0.30, 0.18], interval: iv, major: iv * 5.0, alpha: cAlpha * (view.contourAlpha || 1) },
			liftBounds: elev.liftBounds,   // メッシュ接地リフトの DTM 保証域
			worldHypsoK, hasClim: climTexView ? 1 : 0,
		}));
		if (!flat2d) {
			const g = new Float32Array(92);   // +farBounds/farP（far床＝タイラーのバグ根治 9/2）+misc（球体の不透明度 9/13）+sun/atmP（大気散乱 #46 段 1）+錨と uv 係数（#65）
			packRays(g, 0, st);   // 視線の基底（#65・旧 invMvp の枠）
			g[16] = land[0]; g[17] = land[1]; g[18] = land[2]; g[19] = land[3];
			g[20] = atmo[0]; g[21] = atmo[1]; g[22] = atmo[2]; g[23] = atmo[3];
			g[24] = elev.bounds[0]; g[25] = elev.bounds[1]; g[26] = elev.bounds[2]; g[27] = elev.bounds[3];   // 全球ハイプソ（R90全球窓）
			g[28] = worldHypsoK; g[29] = elev.has ? 1 : 0; g[30] = ellipsoidOn() ? 1 : 0; g[31] = climTexView ? 1 : 0;
			const sc = worldPal().sea;   // 正準パレット（worldpal.js 既定＝NE流の淡青・knobで差し替え可）
			// seaC.w の空き＝10度レチクルの出現度（fsGrat・v1 geoGraticule10 移植）：z1.7→2.2 出現・z6.0→6.5 退場×基礎α0.5
			g[32] = sc[0]; g[33] = sc[1]; g[34] = sc[2];
			g[35] = view.graticule ? Math.max(0, Math.min(1, (cam.zoom - 1.7) / 0.5)) * Math.max(0, Math.min(1, (whZ - cam.zoom) / 0.5)) * 0.5 : 0;   // 罫線もハイプソと同じ帯で退場
			g[36] = far.bounds[0]; g[37] = far.bounds[1]; g[38] = far.bounds[2]; g[39] = far.bounds[3];   // far床（世界帯z<8=R90全球固定窓）
			g[40] = far.has; g[41] = elev.edgeFade || 0;   // farP=(hasFar, 近窓縁フェード幅deg, 0, 0)
			g[44] = view.globeAlpha ?? 1;   // misc.x＝球体の不透明度（globe/wdepr/terrain(p2.w)/湖/夜面に一括）
			// 大気散乱（#46 段 1）：太陽の方向（段 0 の sunF）と点ける度合い＝fx.atmosphere × 全球ハイプソの出現度（紙のテーマ・基図の帯＝従来のリム光）。atmP＝太陽の強さ・露出
			g[48] = sunF[0]; g[49] = sunF[1]; g[50] = sunF[2]; g[51] = FX.atmosphere && view.worldHypso ? Math.max(0, Math.min(1, (whZ - cam.zoom) / 0.8)) : 0;   // ハイプソと同じ帯（標高の到着は待たない＝殻の絵は標高に依らない）
			{   // 錨（#65）：球の床・海面下の交点を原点相対 δ で持ち、uv は f64 前計算の (off, 1/span) で作る＝絶対経緯度（f32 で 1.4 m 刻み）を経ない
				const u = sphereRayUniforms(st, mainOrigin);
				g[52] = u.O[0]; g[53] = u.O[1]; g[54] = u.O[2]; g[55] = u.rho;
				g[56] = u.ll[0]; g[57] = u.ll[1]; g[58] = u.beta0; g[59] = 0;
				g[60] = u.EO[0]; g[61] = u.EO[1]; g[62] = u.EO[2]; g[63] = 0;
				g.set(anchorUV(mainOrigin, cogGeo), 68);
				for (let k = 0; k < 4; k++) g.set(anchorUV(mainOrigin, k < gnd.n ? gnd.w[k].win : null), 72 + k * 4);
				g.set(anchorUV(mainOrigin, elev.bounds), 88);
			}
			g[64] = view.atmSun ?? 20; g[65] = view.atmExposure ?? 1; g[66] = view.atmGround ?? 0.5; g[67] = view.atmScale ?? 4;   // 太陽の強さ・露出・床の空気遠近の強さ・帯の幅 k（本人裁定 4）（診断と調律のノブ＝公開面には出さない）
			device.queue.writeBuffer(globeBuf, 0, g);
		}
		// 星空劇場（z<5）：星/夜面共通の出現フェード（gl/renderer.js と同式）。恒星時 GMST の天球回転・太陽方位も。
		const worldFade = !flat2d && cam.zoom < 5 ? Math.min(1, (5 - cam.zoom) / 0.5) : 0;
		const starFade = (stars || constel || planets) ? worldFade : 0;
		const showConst = view.showConst && (constel || ecliptic || celeq);
		if (worldFade > 0) {
			const now = clockNow(view.clock);   // 共通の時計（#42）
			const gmst = gmstAt(now);
			// z1 の硬クランプ（max）は天球スケールの変化が z1 で急停止＝太陽系圏の出入りで星の動きが不連続に
			// 見えた（本人指摘 2026-09-02「上手に繋げて」）→ softplus の軟クランプ＝C∞接続：z≫1 は従来の線形・
			// z≪1 は z1 相当へ漸近凍結（無限遠の星空はズームアウトで縮まない・負zの係数反転も防ぐ＝旧仕様を保存）。
			const zx = cam.zoom - 1, zs = 1 + (zx > 0 ? zx + 0.25 * Math.log(1 + Math.exp(-zx / 0.25)) : 0.25 * Math.log(1 + Math.exp(zx / 0.25)));   // 数値安定形 softplus（幅0.25z）
			const skyK = (0.4 + 0.3 * zs) / 1.6;
			const [sunLng, sunLat] = sunSubpoint(now);   // 夜面の太陽直下点（ephem/sun＝solar と同じ式・均時差込み）
			const cs = Math.cos(sunLat);
			const s = skyCPU;
			s.set(st.mvp, 0); packRays(s, 16, st);   // 夜面の視線（#65・旧 invMvp の枠）
			s[32] = Math.cos(gmst); s[33] = Math.sin(gmst);
			s[34] = starFade; s[35] = skyK;
			s[36] = W; s[37] = H;
			s[40] = cs * Math.cos(sunLng); s[41] = Math.sin(sunLat); s[42] = cs * Math.sin(sunLng);
			s[43] = 0.5 * worldFade * (view.globeAlpha ?? 1);   // 夜面 50% × 出現フェード × 球体の不透明度
			device.queue.writeBuffer(skyBuf, 0, skyCPU);
		}

		const t = targets(W, H, S);
		const enc = device.createCommandEncoder();
		if (!frame1Scoped) { frame1Scoped = 1; device.pushErrorScope("validation"); }   // 初回フレーム全体を包む（pop は flush）
		if (tq) { tq.idx = 0; tq.spans.length = 0; }   // フレーム開始＝計測枠をリセット（draw→gint→flush で1周）
		const R = shWin ? shadowPipes(S) : null;   // 受け手の派生パイプライン（影のフレームだけ）
		const C = clipOPt ? clipPipes(S) : null;   // 断面の派生パイプライン（切っているフレームだけ・#111 段 0）
		const CR = C && R ? clipShPipes(S) : null, CX = CR ? clipShBG() : null;   // 影と重ねる（#111 段 2）＝受け手は影＋面の派生
		const PX = CR || C || R || P;   // 描く物ごとの派生の選び（影＋面 → 面 → 影 → 素）
		const grp = k => CR ? CX.bg[k] : C ? cl.bg[k] : R ? sh.bg : null;   // その派生の束縛（k＝原点のスロット・影だけの時は共通）
		if (shadow.on) shStat.active = !!shWin;
		if (shWin) encodeShadowCasters(enc, shWin, cam, opts, terrainActive, clipOPt ? tp : null);
		// 1x（遷移フレーム／?msaa=0）＝canvas の current texture へ直描き。以降の全パス（gint 含む）が同じ view に
		// load で重ね、flush() の resolve パスは丸ごと消える＝MSAA store/load/resolve がフレームから消滅する。
		const colorView = S > 1 ? t.view : ctx.getCurrentTexture().createView();
		const passDesc = {
			timestampWrites: passTS("map"),
			colorAttachments: [{
				view: colorView,
				loadOp: "clear",
				clearValue: { r: c[0] * c[3], g: c[1] * c[3], b: c[2] * c[3], a: c[3] },
				storeOp: "store",   // gint パスが同じ的に重ねる＝resolve は flush() の終端パスで（GL の「地図の後に gint」と同順）
			}],
			depthStencilAttachment: {
				view: t.depthView,
				depthLoadOp: "clear", depthClearValue: 1.0, depthStoreOp: "store",   // gint の隠線（地形深度テスト）が読む
				stencilLoadOp: "clear", stencilStoreOp: "store",                      // bit7=建物マスク（bld/mesh が刻み gint パスが load で読む）
			},
		};
		let pass;
		try { pass = enc.beginRenderPass(passDesc); }
		catch (err) {   // timestampWrites 非対応の環境＝TQ を畳んで同フレームを無計測で続行（絵は止めない）
			if (!tq) throw err;
			tqOff(err);
			delete passDesc.timestampWrites;
			pass = enc.beginRenderPass(passDesc);
		}
		// 星空劇場（z<5）：globe より先に描く＝陸には上書きされ・大気ハローは星の上に薄く重なり・宇宙には星が残る
		if (starFade > 0) {
			pass.setBindGroup(0, skyBG);
			if (stars) { pass.setPipeline(P.stars); pass.setVertexBuffer(0, stars.buf); pass.draw(6, stars.count); }
			if (planets) { pass.setPipeline(P.stars); pass.setVertexBuffer(0, planets.buf); pass.draw(6, planets.count); }
			if (showConst) {   // 星座線・黄道・天の赤道（view.showConst のみ・色は per-buffer UBO）
				// view.skySolar（太陽系圏 z<1）：黄道/天の赤道は消灯・星座線は減光（gl/renderer.js と対）。
				// 色 UBO の constel α だけモード替わりで書き直す（16B・跨ぎの瞬間のみ）
				if (skySolarPrev !== !!view.skySolar) {
					skySolarPrev = !!view.skySolar;
					device.queue.writeBuffer(skyLineBuf, LINE_ROLE.constel * LINE_SLOT, new Float32Array([0.47, 0.63, 1.0, 0.4 * (skySolarPrev ? 0.55 : 1)]));
				}
				pass.setPipeline(P.starLine);
				for (const [b, role] of [[constel, LINE_ROLE.constel], [view.skySolar ? null : ecliptic, LINE_ROLE.ecliptic], [view.skySolar ? null : celeq, LINE_ROLE.celeq]]) {
					if (!b) continue;
					pass.setBindGroup(1, skyLineBG[role]);
					pass.setVertexBuffer(0, b.buf);
					pass.draw(b.count);
				}
			}
		}
		if (!flat2d) {   // 球体本体：land基色を縁(リム)まで敷く。2D高速パス時は clear で代替＝省略
			pass.setPipeline(PX.globe);
			pass.setBindGroup(0, globeBG);
			if (grp("terrain")) pass.setBindGroup(1, grp("terrain"));   // 球の床＝地形の対象
			pass.draw(3);
		}
		// 地形サーフェス（標高変位＋hillshade）。深度を書く＝尾根の向こうの基図・建物が隠れる
		if (terrainActive) {
			pass.setPipeline(PX.terrain);
			pass.setBindGroup(0, bg0.terrain);
			pass.setBindGroup(1, paramBG[ROLE.terrain]);
			pass.setBindGroup(2, climBG);   // 気候場（全球ハイプソ）。未着は dummy（p2.z=0 で不使用）
			if (grp("terrain")) pass.setBindGroup(3, grp("terrain"));
			pass.setVertexBuffer(0, terrain.vbo);
			pass.setIndexBuffer(terrain.ibo, "uint32");
			for (const [f0, n] of nearRuns) pass.drawIndexed(n, 1, f0);   // 可視チャンクの区間だけ（P4 step B）
			if (farActive) {
				// 遠景メッシュ＝同じ単位格子を遠窓へ2度目のドロー（FS が近窓の内側を discard＝二重描画なし）。
				// 近を先に描く＝遠の被り分は深度で早期棄却。頂点コストは近と同額＝チルト×深ズーム時のみ発生。
				pass.setBindGroup(0, bg0.terrainFar);
				for (const [f0, n] of farRuns) pass.drawIndexed(n, 1, f0);
			}
			// 地形の蓋（#111 段 2）＝切った面ごとに「地面の中」だけ塗る板（近窓・遠窓の 2 回・地形と同じ分担）
			if (C && tp.terrain.length && clip.style.capOn) {
				const O = clipOPt, clipPl = tp.terrain;
				packCap(0, clipPl, O, mainOrigin, terrain.mesh, cam.center, false);
				if (farActive) packCap(1, clipPl, O, mainOrigin, far.bounds, cam.center, true);
				device.queue.writeBuffer(cl.capBuf, 0, cl.capCPU);
				pass.setPipeline(C.cap);
				pass.setBindGroup(0, bg0.terrain); pass.setBindGroup(1, cl.capBG[0]); pass.draw(6, clipPl.length);
				if (farActive) { pass.setBindGroup(0, bg0.terrainFar); pass.setBindGroup(1, cl.capBG[1]); pass.draw(6, clipPl.length); }
			}
		}
		// 等高線：真俯瞰でだけ敷く（ベクタの下＝道路/区界は上に乗る）。深度無関係
		if (cAlpha > 0.003 && cam.zoom >= 9) {
			pass.setPipeline(P.contour);
			pass.setBindGroup(0, bg0.main);   // invMvp と elev だけ使う＝main スロットで足りる
			pass.setBindGroup(1, paramBG[ROLE.contour]);
			pass.draw(3);
		}
		// 海面下の陸地（?world=1・below_sea_land）＝全球ハイプソの一部として「タイル(湖)より先」に敷く。
		// 描画順が精度を代替（2026-09-01 本人指摘）：海側だけ焼きが正確（admin0海岸線でクリップ）ならよく、
		// 湖側は上に乗る湖の塗り・陸側は cover（landK=1 のハイプソ本体）が外側と同色に溶ける。gl/renderer.js と対。
		if (worldHypsoK > 0 && !rasterBase) {
			const packOv = (origin) => packFrame(st, origin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr);
			drawWdepr(pass, packOv, st);
			// 湖（NE lakes）＝wdepr の上・タイルの下（海→海面下→湖→陸の順のまま供給源だけ NE へ 2026-09-03）
			drawLakes(pass, packOv, st, worldHypsoK);
		}
		// 基図（塗り/線）：ペインタ順。山岳ビュー＝地形深度でテストだけ（書かない）＝尾根の向こうが透けない
		// dbg＝?drawhud=1 の実機計器（描いた枚数と状態）。「背景が黒＝塗りが一枚も出ていない」時に、
		// 犯人が CPU 側（シーンが空・スロット退場）か GPU 側（描いたのに出ない）かを画面で名指しするための物差し
		// （Android 実機の反転 2026-08-03。数え上げは加算だけ＝常時オンでも実害なし）。
		dbg = { baseFill: 0, baseLine: 0, mainFill: 0, mainLine: 0, skipMain: !!(opts && opts.skipMain), skipBase: !!(opts && opts.skipBase), fadeK, terrainDepth: !!terrainDepth, zoom: +(cam.zoom || 0).toFixed(1), aa: S, get raster() { return gnd.rasterOn ? gnd.tiles : 0; }, get fillsIn() { return gnd.fillsIn; }, get gndFaces() { return gnd.fillsIn ? gnd.faces : 0; } };
		dbg.shadow = shWin ? +(shWin.alt * 180 / Math.PI).toFixed(1) : 0;   // ?drawhud=1：影の窓が立ったか（太陽高度°・0＝影なしのフレーム）
		const slots = (opts && opts.skipMain) ? ["base"] : (opts && opts.skipBase) ? ["main"] : ["base", "main"];
		if (userOn) slots.push("user");   // 利用者の vector の層（段 8⑤）＝基図の塗りと線の後
		const mainLinesOn = slots.indexOf("main") >= 0 && scenes.main.draws.length > 0;
		const fillPipe = terrainDepth ? PX.fillTest : PX.fillOff;   // 断面の間は断面の派生（#111 段 1〜2・影と重ねる時は影＋面）
		const linePipe = terrainDepth ? PX.lineTest : PX.lineOff;
		// 塗りの直描きを伏せる条件：3D（地形あり）＝塗りは地面アトラスへ焼いてある（RTT ドレープ）／ラスタ基図（under・hideFills）＝裁定（線と注記は残す）
		const rasterHide = gnd.fillsIn || !!(rasterDraws && rasterDraws.hideFills && gnd.rasterOn);
		for (const slot of slots) {
			const scene = scenes[slot];
			// フェード中の main＝旧シーン（通常ロール・α1）を先に敷き、新シーンを fade ロール（α=fadeK）で重ねる
			const passes = (slot === "main" && fading)
				? [[scene.fadePrev.draws, scene.fadePrev.bldIgnored, false], [scene.draws, null, true]]
				: [[scene.draws, null, false]];
			for (const [drawList,, useFade] of passes) {
			if (!drawList.length) continue;
			const userSlot = slot === "user";   // 基図の濃さとラスタ基図の hideFills に従わない（3D の塗りはアトラス側）
			for (const d of drawList) {
				if (d.kind === "fill") {
					if (userSlot ? gnd.fillsIn : rasterHide) continue;   // ラスタ基図＝塗りを伏せる
					const seaFB = seaFbReal(d.li) != null;   // 図郭外フォールバック水域（標高ゲート付き全面WA）
					const waterC = d.li === sea.li || d.li === sea.li2;
					if ((seaFB || waterC) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（紙の海）
					if (hideBldFill && d.li === bldFill.li) continue;            // 3D時＝フットプリント塗りを伏せる
					const roof = R && !C && d.li === bldFill.li;   // 影の間の真俯瞰＝建物の塗りは屋根＝影を受けない（地面の高さに描くと自分の屋根の影に沈む）
					pass.setPipeline(roof ? (terrainDepth ? P.fillTest : P.fillOff) : fillPipe);   // 直描きは 2D だけ（3D の塗りは地面アトラス側）
					pass.setBindGroup(0, bg0[slot]);
					pass.setBindGroup(1, paramBG[userSlot ? ROLE.user : useFade ? (seaFB ? ROLE.fadeSeaFb : waterC ? ROLE.fadeWater : ROLE.fadeNormal) : (seaFB ? ROLE.seaFb : waterC ? ROLE.water : ROLE.normal)]);
					if (!roof && grp(slot)) pass.setBindGroup(2, grp(slot));
					pass.setVertexBuffer(0, d.bPos);
					pass.setVertexBuffer(1, d.bCol);
					if (d.bIdx) { pass.setIndexBuffer(d.bIdx, "uint32"); pass.drawIndexed(d.count); }
					else pass.draw(d.count);
					if (slot === "base") dbg.baseFill++; else dbg.mainFill++;
				} else {
					if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
					pass.setPipeline(linePipe);
					pass.setBindGroup(0, bg0[slot]);
					pass.setBindGroup(1, paramBG[userSlot ? ROLE.user : useFade ? ROLE.fadeNormal : ROLE.normal]);   // 線の接地リフト＝cityLift（fill の通常塗りと同じ）
					if (grp(slot)) pass.setBindGroup(2, grp(slot));
					pass.setVertexBuffer(0, cornerBuf);
					pass.setVertexBuffer(1, d.bP1);
					pass.setVertexBuffer(2, d.bP2);
					pass.setVertexBuffer(3, d.bCol);
					pass.setVertexBuffer(4, d.bHalf);
					pass.setVertexBuffer(5, d.bOff || zeroOffBuf);
					drawLine(pass, d.count);
					if (slot === "base") dbg.baseLine++; else dbg.mainLine++;
				}
			}
			}
		}
		// overlay（外部ベクタ=geopbf/e-Stat/N02）：基図の上・建物の下・深度off。per-scene origin の Frame を渡す
		drawOverlay(pass, st, (origin) => packFrame(st, origin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr), cam.zoom || 0);
		// 10度レチクル（v1「地図の上に重ねる」と同じ最前面・ラベルの下）。出現度は globe UBO の seaC.w に書き込み済み
		if (!flat2d && view.graticule && globeBG && cam.zoom > 1.7 && cam.zoom < whZ) {   // 退場は世界ハイプソと同じ帯（出現度 seaC.w も whZ でフェード＝GL と同じ・旧 6.5 固定は地域の申告が無い器で z6.5〜8 の罫線を切っていた）
			pass.setPipeline(P.grat);
			pass.setBindGroup(0, globeBG);
			pass.draw(3);
		}
		// 建物マスクの reference＝bit7（★overlay の後＝overlay cover の not-equal 比較は ref 0 前提のまま守る）
		pass.setStencilReference(0x80);
		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。真俯瞰では描かない＝平面地図
		const show3d = (cam.pitch || 0) >= 0.02;
		// メッシュの実フットプリントが立つ区の被覆マスク（最大4・非表示区は除外）＝基図建物を伏せる
		// 可視優先の4枠選抜（2026-08-04・gl/renderer.js と同文）：旧・読み込み順slice(0,4)は全保持化でマスクが
		// 溜まると今見ている区が枠に入らず、基図建物の壁がメッシュの壁と深度戦い＝pan/zoom中の壁面の瞬き。
		const mcx = cam.center[0], mcy = cam.center[1], mcw = Math.cos(mcy * Math.PI / 180);
		const mdist = m => { const bb = m.bbox; const dx = Math.max(bb[0] - mcx, 0, mcx - bb[2]) * mcw, dy = Math.max(bb[1] - mcy, 0, mcy - bb[3]); return dx * dx + dy * dy; };
		const activeMasks = [...meshMasks.entries()].filter(([w]) => !meshHidden.has(w)).map(([, m]) => m)
			.sort((a, b) => mdist(a) - mdist(b)).slice(0, MAX_MESH_MASKS);
		const bldMaskBG = buildMaskBG(activeMasks, scenes.main.origin || [0, 0]);
		const bld = show3d && !(opts && opts.skipMain) && !(opts && opts.noBld) ? scenes.main.bld : null;   // noBld=?nobld=1診断ノブ（二重壁の切り分け）
		const bldPrev = show3d && !(opts && opts.skipMain) && !(opts && opts.noBld) && fading ? scenes.main.fadePrev.bld : null;
		if (bldPrev) {   // フェード中＝旧建物を通常ロール（α1）で先に（新は fadeBld で重なる＝クロスフェード）
			pass.setPipeline(PX.bld);
			pass.setBindGroup(0, bg0.bld);
			pass.setBindGroup(1, paramBG[ROLE.bld]);
			pass.setBindGroup(2, bldMaskBG);
			if (grp("buildings")) pass.setBindGroup(3, grp("buildings"));
			pass.setVertexBuffer(0, bldPrev.bPos);
			pass.setVertexBuffer(1, bldPrev.bSh);
			pass.setVertexBuffer(2, bldPrev.bAnc);
			pass.draw(bldPrev.count);
		}
		if (bld) {
			pass.setPipeline(PX.bld);
			pass.setBindGroup(0, bg0.bld);
			pass.setBindGroup(1, paramBG[fading ? ROLE.fadeBld : ROLE.bld]);
			pass.setBindGroup(2, bldMaskBG);   // メッシュの区の footprint を伏せる（count=0 なら素通し）
			if (grp("buildings")) pass.setBindGroup(3, grp("buildings"));
			pass.setVertexBuffer(0, bld.bPos);
			pass.setVertexBuffer(1, bld.bSh);
			pass.setVertexBuffer(2, bld.bAnc);
			pass.draw(bld.count);
		}
		// gintBld（gint ユーザー層の地形沿い境界線/点＝moj筆ドレープ）：独自 origin・深度で地形/尾根に遮蔽・マスク無し。
		// ★常時描画（show3d/skipMain ゲート無し＝GL 同等）＝真俯瞰(elevScaleEff=0)は海面の平面、チルトで地形へ立ち上がる（GL と同じモーフ）。
		if (gintBld) {
			ensureOvFrameBG();
			device.queue.writeBuffer(ovFrameBuf, GB_SLOT * FRAME_SLOT, packFrame(st, gintBld.origin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr));
			pass.setBindGroup(0, ovFrameBG, [GB_SLOT * FRAME_SLOT]);   // Frame＝origin 共有＝バッチ間で同一
			pass.setBindGroup(2, emptyMaskBG);   // マスク無し（count=0＝footprint 伏せ無し・固定BGで thrashing 回避）
			for (let bi = 0; bi < gintBld.batches.length; bi++) {
				const bt = gintBld.batches[bi];
				const gc = bt.color || view.bldColor || [0.86, 0.86, 0.85];
				const gpo = (GB_SLOT + bi) * (PARAM_SLOT / 4);
				ovParamCPU[gpo] = gc[0]; ovParamCPU[gpo + 1] = gc[1]; ovParamCPU[gpo + 2] = gc[2]; ovParamCPU[gpo + 3] = 1;   // p0=bldColor＋w=グローバルα（BUILDING FS が乗算）
				device.queue.writeBuffer(ovParamBuf, (GB_SLOT + bi) * PARAM_SLOT, ovParamCPU.buffer, (GB_SLOT + bi) * PARAM_SLOT, PARAM_SLOT);
				pass.setBindGroup(1, ovParamBG, [(GB_SLOT + bi) * PARAM_SLOT]);
				if (bt.line) { pass.setPipeline(P.gbLine); pass.setVertexBuffer(0, bt.line.bPos); pass.setVertexBuffer(1, bt.line.bSh); pass.setVertexBuffer(2, bt.line.bAnc); pass.draw(bt.line.count); }
				if (bt.point) { pass.setPipeline(P.gbPoint); pass.setVertexBuffer(0, bt.point.bPos); pass.setVertexBuffer(1, bt.point.bSh); pass.setVertexBuffer(2, bt.point.bAnc); pass.draw(bt.point.count); }
			}
		}
		// 建物メッシュ（LOD2 等）（任意三角形・面法線陰影）。バッチ単位フラスタムカリング＋高さLOD打ち切り。
		// per-batch uniform（meshOrigin/clipMesh/cullBack）は dynamic offset UBO で1バッチ1スロット。
		// ⚠skipMain では消さない（GL 867 と同等）：skipMain＝ズームアウト滑走中の「古いタイルシーン退場」であり、
		// 建物メッシュは別ソース＝退場対象でない。移植時にここへ !skipMain を発明していた＝滑走中に街ごと消える
		// 「シーン抜け」（gpu単独・東京駅〜丸の内で実測）の正体。基図退場中も街は立ち続けるのが GL の挙動。
		if (meshes.size && (show3d || meshKeep2d())) {   // 真俯瞰でも keep2d のバッチ（統計の押し出し）は描く＝色を平面のまま見せる
			const pad = 0.5 * Math.max(st.W, st.H);   // 高層ビルの頭のはみ出し余白（半画面）
			const mppx = 156543.03392 * 0.819 / Math.pow(2, cam.zoom || 0);   // 画面1pxが何m（LOD打ち切りの物差し）
			const cosLat = Math.cos((cam.center[1] || 0) * Math.PI / 180);
			// ① CPU カリング＋LOD＝可視バッチ列を作り、per-batch uniform を一括で書く（writeBuffer は pass より先に適用）
			const draws = [];
			for (const p of meshes.values()) {
				if (draws.length >= MAX_PL_BATCH) { console.warn(`[gpu] mesh visible batches exceed ${MAX_PL_BATCH} = truncated`); break; }
				if (!show3d && !p.keep2d) continue;   // 真俯瞰＝建物 3D は描かない（keep2d だけ通す）
				if (meshHidden.has(p.ward)) continue;
				if (!meshBboxVisible(st, p.bbox, cam.center, pad)) continue;
				let count = p.count;
				if (p.lodH && !p.two && !p.keep2d) {   // index は建物高さ降順＝先頭 count で「高さ閾値以上だけ」（橋梁 two は全描画・keep2d＝統計は間引かない）
					const dm = Math.hypot(((p.bbox[0] + p.bbox[2]) / 2 - cam.center[0]) * 111320 * cosLat, ((p.bbox[1] + p.bbox[3]) / 2 - cam.center[1]) * 111320);
					const minH = mppx * (1 + dm / 4000);
					let li = 0;
					for (let i = p.lodH.length - 1; i > 0; i--) if (p.lodH[i] <= minH) { li = i; break; }
					count = p.lodCounts[li];
					if (!count) continue;
				}
				const slot = draws.length, o = slot * (PL_BATCH_SLOT / 4);
				const cM = mat.transform(st.mvp, [p.origin[0], p.origin[1], p.origin[2], 1]);   // clip錨を CPU(double) で
				plBatchCPU[o] = p.origin[0]; plBatchCPU[o + 1] = p.origin[1]; plBatchCPU[o + 2] = p.origin[2]; plBatchCPU[o + 3] = p.two ? 0 : 1;   // meshOrigin.xyz + cullBack
				plBatchCPU[o + 4] = cM[0]; plBatchCPU[o + 5] = cM[1]; plBatchCPU[o + 6] = cM[2]; plBatchCPU[o + 7] = cM[3];   // clipMesh
				plBatchCPU[o + 8] = p.cut ?? -1; plBatchCPU[o + 9] = p.blend ? 1 : 0; plBatchCPU[o + 10] = p.noLift ? 1 : 0; plBatchCPU[o + 11] = p.drape ? 1 : 0;   // alpha.xy（模型の派生 PB だけが読む）・.z＝noLift・.w＝drape（素も派生も読む）
				// #46 段 2：pbr0（材質の数値）・emis（発光＋fx.pbr の旗）・lp（太陽の強さ・固定光の重み）・sh[9]（空の環境光・sh[0].w＝fill）＝skyEnv はフレームで一度
				const pb = p.pbr;
				plBatchCPU[o + 12] = pb ? pb.metallic : 0; plBatchCPU[o + 13] = pb ? pb.roughness : 1; plBatchCPU[o + 14] = pb ? pb.normalScale : 1; plBatchCPU[o + 15] = pb ? pb.occlusion : 1;
				plBatchCPU[o + 16] = pb ? pb.emissive[0] : 0; plBatchCPU[o + 17] = pb ? pb.emissive[1] : 0; plBatchCPU[o + 18] = pb ? pb.emissive[2] : 0; plBatchCPU[o + 19] = FX.pbr ? 1 : 0;
				plBatchCPU.set(env.lp, o + 20);
				plBatchCPU.set(env.sh, o + 24);
				if (clipOPt) { plBatchCPU[o + 60] = p.origin[0] - clipOPt[0]; plBatchCPU[o + 61] = p.origin[1] - clipOPt[1]; plBatchCPU[o + 62] = p.origin[2] - clipOPt[2]; }   // clipO＝バッチ原点 − main 原点（f64 で引く・断面の派生だけが読む）
				draws.push({ p, count, slot });
			}
			dbg.pl = draws.length;   // ?drawhud=1：メッシュの可視バッチ数（「建物は出ているのに紙が無い」の裏取り）
			if (draws.length) {
				device.queue.writeBuffer(plBatchBuf, 0, plBatchCPU.buffer, 0, draws.length * PL_BATCH_SLOT);
				// 描く順＝素の建物メッシュ → 模型（不透明/MASK）→ 模型（BLEND＝半透明・奥から手前＝バッチ重心とカメラの距離・深度書き込み無し）
				const ex = st.eye, d2 = p => (p.origin[0] - ex[0]) ** 2 + (p.origin[1] - ex[1]) ** 2 + (p.origin[2] - ex[2]) ** 2;
				const meshPipe = PX.mesh;   // 影の間は派生の受け手（素の建物メッシュ＝group(3)・模型＝group(2) に PB と同居・#112 段 1）・断面の間は断面の派生（#111 段 0・group(3)）
				const TX = PX;   // 模型の受け手＝影＋面 → 面 → 影 → 素（#111 段 1〜2）
				const lists = [[meshPipe, draws.filter(d => !d.p.textured)], [TX.meshTex, draws.filter(d => d.p.textured && !d.p.blend)], [TX.meshTexBlend, draws.filter(d => d.p.blend).sort((x, y) => d2(y.p) - d2(x.p))]];
				for (const [pipeline, list] of lists) {
					const tx = pipeline !== meshPipe;
					if (!list.length) continue;
					pass.setPipeline(pipeline);
					pass.setBindGroup(0, bg0.bld);              // フレーム共通（mvp/eye/fog/elev）は建物と同一
					pass.setBindGroup(1, paramBG[ROLE.mesh]); // p0=liftBounds, p1=bldColor
					if (!tx && grp("buildings")) pass.setBindGroup(3, grp("buildings"));   // 素の建物メッシュ＝建物の対象（模型は group(2) に models の面）
					for (const { p, count, slot } of list) {
						pass.setBindGroup(2, !tx ? plBatchBG : CR ? CX.plBG : C ? cl.plBG : R ? sh.plShBG : plBatchBG, [slot * PL_BATCH_SLOT]);   // dynamic offset＝このバッチの uniform（影・断面の間の模型は、その束縛と同居の group）
						pass.setVertexBuffer(0, p.vbo);
						pass.setVertexBuffer(1, p.nbo);
						if (tx) { pass.setVertexBuffer(2, p.uvbo); pass.setVertexBuffer(3, p.cbo); pass.setBindGroup(3, p.texBG); }
						pass.setIndexBuffer(p.ibo, "uint32");
						pass.drawIndexed(count);
					}
				}
			}
		}
		// 夜面（星空劇場と同じ z<4 ゲート・同じフェード）：現在時刻の太陽を平行光源に夜半球を夜紺で減光。
		// 基図の全レイヤの上に重ねる（この後の gint 海岸線パスは loadOp:load で夜面の上に描く＝GL と同順）。view.night＝false で描かない（GL と同じ）
		if (worldFade > 0 && view.night !== false) {
			pass.setPipeline(P.night);
			pass.setBindGroup(0, skyBG);
			pass.draw(3);
		}
		pass.end();
		// AO（#46 段 3）＝チルトした 3D の時だけ（真俯瞰は足元も谷も無い）。main の色へ乗算＝gint の線は暗くならない（この後に描く）。
		// 入口はフェード（チルト 0.02→0.10 rad で強さ 0→1）＝真俯瞰から傾けた瞬間に建物の周りの陰がポンと点かない
		const aoIn = Math.min(1, Math.max(0, ((cam.pitch || 0) - 0.02) / 0.08));
		if (FX.ao && !flat2d && aoIn > 0) {
			ao ??= createAoGPU(device, format);
			ao.encode(enc, { depthTex: t.depth, samples: S, W, H, colorView, mvp: st.mvp, invMvp: st.invMvp, eye: st.eye, focal: st.focal, logCoef,
				strength: (view.aoStrength ?? 0.5) * aoIn * aoIn * (3 - 2 * aoIn), radiusK: view.aoRadius ?? 0.10, biasSin: view.aoBias ?? 0.15, phase: view.aoPhase ?? 0 });   // 調律ノブ（公開面には出さない）。半径＝視距離の 10%（20〜400m）・強さ 0.5・接平面の sin の下駄 0.15（地平線型・2026-09-26）。aoPhase＝模様の位相（t-ao の安定の検定）
		} else if (ao && !FX.ao) { ao.dispose(); ao = null; }   // 旗を落としたら資源を返す
		lastDepth = dOut ? { tex: t.depth, samples: S, w: W, h: H, logCoef } : null;   // 深度の書き出し（#47）＝申し出中だけ・flush の後に詰める
		frame = { enc, colorView, depthView: t.depthView, w: W, h: H, samples: S };   // 1x＝colorView は canvas 直（gint も同じ的に load で重ねる）。samples＝gint がパイプラインセットを揃える（遷移時AA）
		// gint の深度統合コンテキスト（GL renderer の gintCtx と同意味論＝terrainDepth の間だけ非null）。
		// elevView は安定参照（rebuildBG0 で1回生成）＝gint 側の bind group キャッシュが毎フレーム破れない。
		gctx = terrainDepth ? {
			terrainDepth: true, logCoef, fogFar: fogFarCap,
			elevView: (elev.has && elevTexView) ? elevTexView : null, elevSampler,
			elevBounds: elev.bounds, elevScale: elevScaleEff, hasElev: elev.has, edgeFade: elev.edgeFade || 0,
			meshQ: qMesh, meshG: qG,   // 案A: gint も描画メッシュ面へ量子化
			noSub: view.gintSub === false,   // 地形適応細分の逃げ道（view.gintSub=false＝?nosub=1）
			facesInAtlas: gnd.fillsIn,       // gint の面は地面アトラス側（bakeFaces）＝画面では線・点だけ
		} : null;
		return fogAnimating || fading;   // fading＝クロスフェード進行中も連続フレーム
	}
	// フレーム確定：MSAA を canvas へ resolve して submit（gint パスが足された後＝地図と同フレーム同カメラの1枚）。
	// 1x（遷移フレーム／?msaa=0）は直描き済み＝resolve パス自体が不要（TQ 回収と submit だけ行う）。
	function flush() {
		if (!frame) return;
		if (frame.samples > 1) {
			const flushDesc = {
				timestampWrites: passTS("map"),   // resolve の実費も map に計上
				colorAttachments: [{ view: frame.colorView, resolveTarget: ctx.getCurrentTexture().createView(), loadOp: "load", storeOp: "discard" }],
			};
			let pass;
			try { pass = frame.enc.beginRenderPass(flushDesc); }
			catch (err) {
				if (!tq) throw err;
				tqOff(err);
				delete flushDesc.timestampWrites;
				pass = frame.enc.beginRenderPass(flushDesc);
			}
			pass.end();
		}
		let st = null;
		if (tq && tq.idx) {
			frame.enc.resolveQuerySet(tq.qs, 0, tq.idx, tq.resolve, 0);
			st = tq.staging.find(s => !s.busy) || null;   // 空きが無い＝そのフレームは計測を落とす（結果詰まりで本業を止めない）
			if (st) { st.busy = true; st.spans = tq.spans.slice(); st.n = tq.idx; frame.enc.copyBufferToBuffer(tq.resolve, 0, st.buf, 0, tq.idx * 8); }
		}
		device.queue.submit([frame.enc.finish()]);
		frame = null;
		if (frame1Scoped === 1) { frame1Scoped = 2; device.popErrorScope().then(e => { if (e) gpuErr("初回フレーム検証", e.message); }).catch(() => {}); }
		// ⚠WebKit(Safari) の轍：submit と同一タスクで mapAsync を呼ぶと canvas present が黙って止まる
		//（例外・検証エラー・uncaptured 一切なし＝白画面。Playwright WebKit の二分探索で確定 2026-08-02：
		//  timestampWrites／resolveQuerySet／copyBufferToBuffer は全て無罪、同一タスクの mapAsync だけが毒）。
		// 別タスク（setTimeout 0）へ剥がすだけで全環境無害・TQ 全機能が生きる＝iOS Safari 白画面の根治。
		if (st) { setTimeout(() => {
			st.buf.mapAsync(GPUMapMode.READ).then(() => {
				const v = new BigUint64Array(st.buf.getMappedRange(0, st.n * 8));
				const sums = {};
				for (const sp of st.spans) {
					const ms = Number(v[sp.i0 + 1] - v[sp.i0]) / 1e6;
					if (ms >= 0 && ms < 1e4) sums[sp.tag] = (sums[sp.tag] || 0) + ms;   // 負値/異常値は捨てる（GL の disjoint 相当）
				}
				st.buf.unmap(); st.busy = false;
				for (const tg in sums) tq.ready.push({ tag: tg, ms: sums[tg] });
			}).catch(() => { st.busy = false; });
		}, 0); }
	}
	// シーンの深度の書き出し（#47）：depthOut(true)＝口 { begin(), end() → { bitmap, w, h, logCoef }, abort() }／depthOut(false)＝畳む。
	// begin＝申し出の確認だけ（深度テクスチャは常に読める形）。end＝flush の後に 1 パスで詰めて ImageBitmap に。
	// ImageBitmap をオーバーレイの gl へ上げる所で GPU の完了を待つ＝1 フレーム 1 回の同期（申し出がある間だけの費用・GL2 の readPixels と同じ）
	let dOut = null, lastDepth = null, dOutFailed = false;
	let ao = null;   // AO（#46 段 3）＝fx.ao の間だけ
	function depthOut(on) {
		if (!on || dOutFailed) { if (dOut) { dOut.dispose(); dOut = null; } lastDepth = null; return null; }
		if (!dOut) {
			try { dOut = createDepthOutGPU(device); }
			catch (e) { dOutFailed = true; console.warn("[gpu] depthOut unavailable:", e?.message || e); return null; }
		}
		return {
			begin: () => { if (dOutFailed || !dOut) throw new Error("depthOut disabled"); return true; },   // 落ちた後の口＝投げる（renderworker が畳む）
			abort: () => {},
			end: () => {
				const d = lastDepth; lastDepth = null;
				if (!d || !dOut) return null;
				try { return { bitmap: dOut.encode(d), w: d.w, h: d.h, logCoef: d.logCoef }; }
				catch (e) { dOutFailed = true; console.warn("[gpu] depthOut failed (disabled):", e?.message || e); depthOut(false); return null; }
			},
		};
	}
	// 回収済み GPU 時間の引き取り口（renderworker の tqPoll から）。未対応=null＝呼び出し側が壁時計へフォールバック
	function tqTake() {
		if (!tq) return null;
		if (!tq.ready.length) return [];
		const r = tq.ready; tq.ready = [];
		return r;
	}
	// snapshot 基図読み出し（shot/print）：flush 直後（同一タスク・present 前）に current texture を
	// copyTextureToBuffer→mapAsync で読む。GL の readPixels 相当だが top-down（flip 不要）＋Mac は BGRA＝RGBA へ swizzle。
	// 戻り＝{ base: ArrayBuffer(RGBA・行パディング除去済), w, h }。呼び出し側（renderworker）は draw→gint.draw→flush の直後に await。
	async function readback() {
		const W = canvas.width, H = canvas.height;
		if (!W || !H) return null;
		const bpr = Math.ceil(W * 4 / 256) * 256;
		const buf = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: ctx.getCurrentTexture() }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: H }, { width: W, height: H });
		device.queue.submit([enc.finish()]);
		await new Promise(r => setTimeout(r, 0));   // WebKit 轍の予防：submit と同一タスクの mapAsync は present を止める（TQ で実証）
		await buf.mapAsync(GPUMapMode.READ);
		const src = new Uint8Array(buf.getMappedRange());
		const out = new Uint8Array(W * H * 4);
		for (let y = 0; y < H; y++) {
			const so = y * bpr, do2 = y * W * 4;
			if (isBGRA) for (let x = 0; x < W; x++) { const s = so + x * 4, d = do2 + x * 4; out[d] = src[s + 2]; out[d + 1] = src[s + 1]; out[d + 2] = src[s]; out[d + 3] = src[s + 3]; }
			else out.set(src.subarray(so, so + W * 4), do2);
		}
		buf.unmap(); buf.destroy();
		return { base: out.buffer, w: W, h: H };
	}

	// 未搭載の set は静かに握り潰す（初回だけ告知）＝app の呼び出しを壊さない。md 系＝classic merge 固定ゆえ無縁
	const IGNORE = new Set(["mdGrow", "mdUp", "mdScene"]);
	const ignored = new Set();
	function set(cmd, data, prop) {
		switch (cmd) {
			case "overlay":   setOverlay(data, prop); break;    // prop=fillColor（任意）
			case "overlayHi": setOverlayHi(data, prop); break;
			case "overlayHover": setOverlayHover(data); break;
			case "rail":      setRail(data); break;               // data=[シーン…] 交通の常駐オーバーレイ群
			case "wdepr":     setWdepr(data); break;             // 海面下の陸地（?world=1）＝タイル前に描く塗り専用シーン（色は cover が画素単位で計算）
			case "lakes":     setLakes(data); break;             // 湖（NE lakes・?world=1）＝wdepr 直後に描く塗り専用シーン（色は worldPal.sea 平色）
			case "gintBld":   setGintBld(data); break;           // data={origin,lines,points,color}／null=解放
			case "view":    view = { ...view, ...data }; break;
			case "sea":     sea = { ...sea, ...data }; break;
			case "shadow":  shadow = { ...shadow, ...data }; if (!shadow.on) shadowFree(); break;   // 建物の影（{on, time?, darkness?}）＝消灯で資源を返す
			case "clip":    clip = normClip(data); if (!clip) clipFree(); break;   // 断面（#111）＝群か群の配列（{vertical, horizontal, box, planes, param, targets, cap, edge}・clip.js normClip）＝消して資源を返す
			case "fx":      Object.assign(FX, data || {}); break;   // 描画の質の旗の実行時切替（#46）＝{atmosphere?, pbr?, ao?}（検定と A/B・起動時の値は rOpts.fx）
			case "bldFill": bldFill = { ...bldFill, ...data }; break;
			case "userAnchor": userAnchor = { ranges: Array.isArray(data?.ranges) ? data.ranges : [], rev: userAnchor.rev + 1 }; break;   // 基図の層の間への差し込み（#123）
			case "scene":   setScene(data, prop); break;
			case "elevAtlas": setElevationAtlas(data, prop); break;
			case "elevCell": setElevationCell(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasStage": setElevationAtlasStage(data, prop); break;
			case "elevCellStage": setElevationCellStage(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasCommit": commitElevationStage(); break;
			case "elevAtlasFar": setElevationAtlasFar(data); break;
			case "elevCellFar": setElevationCellFar(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasFarOff": clearElevationFar(); break;
			case "terrLod": TERR_LOD = data !== false; break;   // 地形チャンク刈りの実行時切替（P4 step B・門 t-terrcull の A/B）
			case "meshSet": setMeshSet(prop, data); break;   // prop=キー(区名#i)、data={pos,nrm,idx,...}／null=区解放
			case "meshVis":  setMeshVis(prop, data); break;    // prop=区名、data=真偽（GPU常駐のまま表示切替）
			case "stars":       stars = setStarBuf(stars, data, 8); break;         // data=Float32Array [cel.xyz,rgba,size]×n
			case "planets":     planets = setStarBuf(planets, data, 8); break;     // 惑星（starsと同8fレイアウト・アプリが実位置更新）
			case "constellations": constel = setStarBuf(constel, data, 3); break;  // [cel.xyz]×2n（LINES端点列）表示は view.showConst
			case "ecliptic":    ecliptic = setStarBuf(ecliptic, data, 3); break;   // 黄道の大円
			case "celequator":  celeq = setStarBuf(celeq, data, 3); break;         // 天の赤道の大円
			case "cogTex":      setCogTex(data); break;                             // data={rgba,w,h,bboxLL}|null ユーザ COG（等経緯度整列 RGBA）
			default:
				if (IGNORE.has(cmd)) { if (!ignored.has(cmd)) { ignored.add(cmd); console.log(`[gpu] set("${cmd}") not implemented = ignored (next phase of WebGPU port)`); } }
				else console.warn("[gpu] renderer.set: unknown cmd", cmd);
		}
	}
	function dispose() {
		frame = null; gctx = null;
		shadowFree(); clipFree();
		disposeSlot("base"); disposeSlot("main"); disposeSlot("user");
		frameBuf.destroy(); paramBuf.destroy(); globeBuf.destroy(); cornerBuf.destroy();
		plBatchBuf.destroy(); maskParamBuf.destroy(); rasBuf.destroy(); atlBuf.destroy(); gndPBuf.destroy(); rasterFlushFree(); for (let i = 0; i < 4; i++) { gndFree1(gnd.w[i]); gnd.w[i] = null; } gnd.n = 0;
		skyBuf.destroy(); skyLineBuf.destroy();
		ovFrameBuf.destroy(); ovParamBuf.destroy(); emptyMaskParamBuf.destroy();
		disposeOverlay(overlay); disposeOverlay(overlayHi); disposeOverlay(overlayHover); disposeOverlay(wdepr); disposeOverlay(lakes); for (const o of rail) disposeOverlay(o); disposeGintBld();
		for (const b of [stars, planets, constel, ecliptic, celeq]) if (b) b.buf.destroy();
		for (const p of meshes.values()) { p.vbo.destroy(); p.nbo.destroy(); p.ibo.destroy(); p.uvbo?.destroy(); p.cbo?.destroy(); for (const t of p.texs || []) t?.tex.destroy(); }
		meshes.clear();
		for (const m of meshMasks.values()) m.tex.destroy();
		meshMasks.clear(); meshHidden.clear();
		dummyMask.destroy();
		if (terrain) { terrain.vbo.destroy(); terrain.ibo.destroy(); terrain = null; }
		if (elevTexObj) { elevTexObj.destroy(); elevTexObj = null; }
		if (farTexObj) { farTexObj.destroy(); farTexObj = null; }
		if (elevStage) { elevStage.tex.destroy(); elevStage = null; }
		for (const v of rawLRU.values()) v.buf.destroy(); rawLRU.clear(); rawBytes = 0;
		if (rs) { rs.ubuf.destroy(); rs = null; }
		dummyTex.destroy();
		if (dOut) { dOut.dispose(); dOut = null; }
		if (ao) { ao.dispose(); ao = null; }
		for (const t of tgtBySc.values()) { t.tex?.destroy(); t.depth.destroy(); }
		tgtBySc.clear();
		device.destroy();
	}
	// lost：GPU デバイス喪失（WebGL の contextlost と同じ扱いで main が立て直す）
	device.popErrorScope().then(e => { if (e) gpuErr("init検証", e.message); }).catch(() => {});
	// device/format/frameInfo/flush＝gint（createGintLayerGPU）のホスト面：開いたフレームに render pass を足す口。
	// passTS("gint")＝gint が自分のパスに GPU タイマを打つ口。tqTake/hasTQ＝renderworker の計測回収。
	return { set, draw, flush, readback, dispose, md: false, mdMax: 0, gintCtx: () => gctx, clipInfo: () => clipFrame, backend: "webgpu", lost: device.lost, maxTex: device.limits.maxTextureDimension2D,
		gpuResample, readElevCell,   // 標高セルの GPU 再標本化（perf plan P1 step 1）：terrain.js が記述子を渡す合図／検定の読み戻し
		terrStats: () => terrStat,   // 地形チャンクの刈り（P4 step B）：直近フレームの near/far の描いたチャンク数/総数
		device, format, gpuInfo, frameInfo: () => frame, passTS, tqTake, gpuErrors, get hasTQ() { return !!tq; },
		shadowStats: () => shadow.on ? { on: true, active: shStat.active, passes: shStat.passes, skipped: shStat.skipped, ...(shStat.last || {}) } : null,   // 影の計器（#112 段 0・?hud=1 のテレメトリ）＝消している間は null
		samples: SAMPLES,   // 品質段（静止フレームの段数）。フレーム毎の実段数は frameInfo().samples（遷移時AA＝遷移中1x）
		quad4: QUAD4,   // 線・点＝index の 4 頂点（perf plan P3）。gint（createGintLayerGPU）の既定がこれに揃う
		fx: FX,   // 描画の質の旗（#46）＝atmosphere/pbr/ao の実効値（計器・検定が読む）
		// ?mem=1 台帳のGPU固定常駐（自前確保分の概算バイト）：標高アトラス（近/舞台裏/遠）＋地形メッシュ＋MSAAターゲット
		memEstimate: () => ({ atlas: memAtlas + memStage + memFar, mesh: memMesh, msaa: memMsaa, raster: memRaster + gnd.bytes, depthOut: dOut ? dOut.bytes() : 0, ao: ao ? ao.bytes() : 0 }),
		depthOut,   // シーンの深度をオーバーレイへ（#47）
		rasterTex, rasterMesh, rasterFree, setRasterDraws, setGroundHook,   // 画像タイル層（raster.js の renderer 契約・RTT ドレープ）・gint 面の焼き込みフック
		dbg: () => dbg };   // ?drawhud=1：直近フレームの描画実績（実機の画面に出す計器）
}
