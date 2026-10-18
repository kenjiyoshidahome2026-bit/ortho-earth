// three.js を render worker の中で描く同一フレームのオーバーレイ（deck.gl 差分 PR-3・計画 段 C1〜C2・2026-10-11）。
// 既存の customgl（MapLibre の CustomLayerInterface の通訳）は main の別 canvas＝地図と深度を共有せず常に手前・起動中心で局所線形化。
// こちらは OffscreenCanvas の WebGL2 に THREE.WebGLRenderer を立て、地球・注記と同じ rAF・同じ cam で描き、本体の深度（#47・api.depth）で
// 地形・建物に**隠れる**。three.js は repo の依存にしない（裁定 2026-10-11）＝利用者が URL で持ち込む（opts.three）。利用者の模型コードも URL（opts.module）。
//
// 契約（map.overlay の builtin "three"）：init(canvas, opts, host) / message(data) / frame(cam, s, size, api) / pick(x, y, r, ctx) / destroy()
//   opts＝{ three: URL（three.module.js）, addons: URL（three/examples/jsm/・省略＝three の URL から推す）, module: URL（利用者のモジュール）, origin: [lon, lat, hM]（シーンの原点＝ENU の m・RTE）, depth: true, params: 何でも（setup へ）}
//   利用者のモジュール＝export function setup(THREE, scene, h) / update?(dt, h) → true＝描き続ける / onMessage?(data, h) / dispose?(h)
//     モジュールは `import * as THREE from "three"`・`import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"` と書いてよい（three-resolve.ts が worker の中で解く＝setup の THREE と同じ実体）
//   h（helpers）＝{ THREE, scene, camera, renderer, origin, params, lnglatToLocal(lon, lat, hM) → Vector3（ENU m）, localToLnglat(v) → [lon, lat, hM], importAddon(path), requestDraw(), post(data), earthRadiusM, time, clock }
// 実体＝create() の閉包（renderworker の BUILTIN_OVERLAYS が overlay ごとに呼ぶ＝addThree を 2 つ置いても状態が混ざらない・2026-10-18）。ただし 1 つごとに WebGL 文脈が 1 つ増える
//   （render worker の文脈は Chrome で 4 つまで・地球が 1 つ）＝模型が多い時は 1 つの addThree に載せる。
// renderer: "webgpu"（three.webgpu.js）＝WebGPURenderer で描く（three-webgpu.ts）。本体が WebGPU なら本体の GPUDevice を共有し、深度は本体の GPUTexture を
//   そのまま前置きで three の深度へ書く（材質を直さない・毎フレームの読み戻しなし）。本体が WebGL2 なら three は自前の device・深度は writeTexture で上がる。
// 版：depth（本体の深度で隠す）は THREE.ExternalTexture（r180〜）を使う。古い three は depth を切って描く（警告を 1 回）。setup が済んだら host.stage("setup")＝addThree の ready
//
// 座標：scene の単位は m・原点 origin の東北上（ENU）。world（β 単位球）← ENU は行列 M（customgl と同じ作り・楕円体は y を 1/rAx）。
//   カメラ＝projectionMatrix を本体の透視（s.projection・clip.x の反転込み）に、matrixWorldInverse を P⁻¹·mvp·M（THREE.Matrix4＝f64 の配列で掛けてから f32 へ）＝
//   原点相対の小さな値だけが f32 に落ちる＝RTE（高ズームで震えない）。ENU は右手系・world は左手系（E×N＝−U）だが mvp の clip.x 反転と相殺＝面の向き（culling）は正しい。
// 深度：材質ごとに onBeforeCompile で本体の DEPTH_GLSL（host.depthGLSL）を貼り、gl_Position.w を varying で運んで FS で sceneOcclusion(gl_FragCoord.xy / 描画面, w) なら discard。
//   深度テクスチャは THREE.ExternalTexture（本体が上げた WebGLTexture をそのまま束ねる・コピーなし）。深度の無いフレーム（申し出前・LOW_MEM）は u_sceneDepthOn=0＝隠れない。
// 当たり判定（統一 picking・PR-1）＝THREE.Raycaster（カメラの行列はそのまま使える）。
import { lonlatTo3D, ellipsoidOn, worldRadiusM } from "@ortho-earth/core/camera";
import type { CameraPose, CameraState } from "@ortho-earth/core/camera";
import type { OverlayFrameApi } from "../../globe.d.ts";
import { createThreeLoader, addonsBaseOf } from "./three-resolve.ts";
import { createDepthPrepass, toWebGPUDepth, readCanvasPixels } from "./three-webgpu.ts";
import type { ThreeGPU } from "./three-webgpu.ts";

// three.js は利用者が URL で持ち込む（repo の依存にしない）＝型も持たない。ここで使う分だけを構造で書く
interface TMatrix4 { fromArray(a: ArrayLike<number>): TMatrix4; clone(): TMatrix4; invert(): TMatrix4; multiply(m: TMatrix4): TMatrix4; copy(m: TMatrix4): TMatrix4; decompose(position: TVector3, quaternion: unknown, scale: unknown): TMatrix4 }
interface TVector3 { x: number; y: number; z: number; clone(): TVector3; applyMatrix4(m: TMatrix4): TVector3 }
interface TVector2 { set(x: number, y: number): TVector2 }
interface TShader { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }
interface TMaterial { onBeforeCompile?: (shader: TShader, renderer: unknown) => void; customProgramCacheKey?: () => string; needsUpdate: boolean }
interface TObject3D { id: number; name: string; userData: Record<string, unknown>; material?: TMaterial | TMaterial[] | null; children: TObject3D[] }
interface TScene extends TObject3D { traverse(fn: (o: TObject3D) => void): void }
interface TCamera { coordinateSystem?: number; projectionMatrix: TMatrix4; projectionMatrixInverse: TMatrix4; matrixWorldInverse: TMatrix4; matrixWorld: TMatrix4; position: TVector3; quaternion: unknown; scale: unknown; matrixAutoUpdate: boolean; matrixWorldAutoUpdate: boolean }
interface TRenderer { setPixelRatio(r: number): void; setClearColor(color: number, alpha: number): void; autoClear: boolean; getContext(): WebGL2RenderingContext; setSize(w: number, h: number, updateStyle: boolean): void; render(scene: TScene, camera: TCamera): void; dispose(): void; forceContextLoss?(): void }
/** three.webgpu.js の WebGPURenderer（使う分） */
interface TGpuRenderer extends TRenderer { init(): Promise<unknown>; clear(): void; backend: { isWebGPUBackend?: boolean; device?: GPUDevice } }
interface TExternalTexture { sourceTexture: WebGLTexture | null }
interface TRaycaster { setFromCamera(coords: TVector2, camera: TCamera): void; intersectObjects(objects: TObject3D[], recursive: boolean): Array<{ object: TObject3D; point: TVector3 }> }
/** three.module.js（opts.three の URL）の使う分 */
interface ThreeModule {
	Matrix4: new () => TMatrix4; Vector3: new (x: number, y: number, z: number) => TVector3; Vector2: new (x: number, y: number) => TVector2;
	WebGLRenderer: new (o: { canvas: OffscreenCanvas; alpha: boolean; antialias: boolean; premultipliedAlpha: boolean; preserveDrawingBuffer: boolean }) => TRenderer;
	Scene: new () => TScene; PerspectiveCamera: new () => TCamera; ExternalTexture?: new (texture: WebGLTexture | null) => TExternalTexture; Raycaster: new () => TRaycaster;
	REVISION?: string;
	/** three.webgpu.js だけが持つ（renderer: "webgpu"） */
	WebGPURenderer?: new (o: { canvas: OffscreenCanvas; alpha: boolean; antialias: boolean; device?: GPUDevice }) => TGpuRenderer;
	WebGPUCoordinateSystem?: number;
}
/** 利用者のモジュール（opts.module の URL） */
interface UserModule { setup?(THREE: ThreeModule, scene: TScene, h: Helpers): unknown; update?(dt: number, h: Helpers): unknown; onMessage?(data: ThreeMsg, h: Helpers): void; dispose?(h: Helpers | null): void }
/** 利用者のモジュールへ渡す h（helpers） */
interface Helpers {
	THREE: ThreeModule; scene: TScene; camera: TCamera; renderer: TRenderer; origin: number[]; params: unknown;
	lnglatToLocal(lon: number, lat: number, h?: number): TVector3; localToLnglat(v: TVector3): number[]; importAddon(path: string): Promise<unknown>; requestDraw(): void; post(d: unknown): void;
	earthRadiusM: number; time: number; clock: OverlayFrameApi["clock"];
}
/** init の opts（map.addThree が渡す） */
interface ThreeOpts { three?: string; addons?: string; renderer?: "webgl" | "webgpu"; module?: string; origin?: number[]; depth?: boolean; params?: unknown }
/** render worker の host（init の第 3 引数）＝読む分 */
interface OverlayHost { post(data: unknown): void; requestDraw(): void; depthGLSL: string; stage?(st: string, extra?: Record<string, unknown>): void; gpuDevice?(): GPUDevice | null }
/** 本体の深度の uniform（材質に貼る） */
interface DepthUniforms { u_sceneDepth: { value: TExternalTexture }; u_sceneLogCoef: { value: number }; u_sceneDepthEps: { value: number }; u_sceneDepthOn: { value: number }; u_oeSize: { value: TVector2 } }
/** main からの指示（検定の probe 以外は利用者の onMessage へそのまま） */
type ThreeMsg = { type?: unknown; id?: unknown } | null | undefined;
/** 深度で隠すのに要る three の版（THREE.ExternalTexture） */
export const MIN_DEPTH_REVISION = 180;
const D2R = Math.PI / 180;


export function create() {
	let THREE: ThreeModule | null = null, renderer: TRenderer | null = null, scene: TScene | null = null, camera: TCamera | null = null, host: OverlayHost | null = null, user: UserModule | null = null, opts: ThreeOpts | null = null;
	let M: TMatrix4 | null = null, Minv: TMatrix4 | null = null, origin: number[] | null = null, ready = false, failed: string | null = null, lastT = 0, lastW = 0, lastH = 0;
	let du: DepthUniforms | null = null, extTex: TExternalTexture | null = null, depthUsed = false, dead = false;
	let loader: ReturnType<typeof createThreeLoader> | null = null, queue: ThreeMsg[] | null = null;
	let gpu: { device: GPUDevice; ctx: GPUCanvasContext; renderer: TGpuRenderer; pre: ReturnType<typeof createDepthPrepass> | null } | null = null, canvasRef: OffscreenCanvas | null = null;   // renderer: "webgpu" の時
	const patched = new WeakSet<TMaterial>();
	const probes: unknown[] = [];
	let helpers: Helpers | null = null;

	// ENU（m）→ world（β 単位球）の行列（列優先・THREE.Matrix4 の set は行優先なので fromArray で入れる）
	function buildM([lon, lat, h = 0]: number[]) {
		const a = lon * D2R, b = lat * D2R, rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, K = 1 / worldRadiusM();
		const T = lonlatTo3D(lon, lat);
		const E = [-Math.sin(a), 0, Math.cos(a)], N = [-Math.sin(b) * Math.cos(a), Math.cos(b) / rAx, -Math.sin(b) * Math.sin(a)], U = [Math.cos(b) * Math.cos(a), Math.sin(b) / rAx, Math.cos(b) * Math.sin(a)];
		const o = [T[0] + U[0] * h * K, T[1] + U[1] * h * K, T[2] + U[2] * h * K];
		const m = new THREE!.Matrix4();
		m.fromArray([E[0] * K, E[1] * K, E[2] * K, 0, N[0] * K, N[1] * K, N[2] * K, 0, U[0] * K, U[1] * K, U[2] * K, 0, o[0], o[1], o[2], 1]);
		return m;
	}
	function lnglatToLocal(lon: number, lat: number, h = 0) {
		const a = lon * D2R, b = lat * D2R, rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, K = 1 / worldRadiusM();
		const p = lonlatTo3D(lon, lat), U = [Math.cos(b) * Math.cos(a), Math.sin(b) / rAx, Math.cos(b) * Math.sin(a)];
		return new THREE!.Vector3(p[0] + U[0] * h * K, p[1] + U[1] * h * K, p[2] + U[2] * h * K).applyMatrix4(Minv!);
	}
	function localToLnglat(v: TVector3) {
		const p = v.clone().applyMatrix4(M!), rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, r = Math.hypot(p.x, p.y, p.z);
		const lon = Math.atan2(p.z, p.x) / D2R, beta = Math.asin(Math.max(-1, Math.min(1, p.y / r)));
		return [lon, Math.atan(Math.tan(beta) / rAx) / D2R, (r - 1) * worldRadiusM()];
	}
	// 本体の深度で隠す＝材質の shader に貼る（1 回だけ・customProgramCacheKey で本体の program と分ける）
	function patchMaterial(mat: TMaterial | null | undefined) {
		if (!mat || patched.has(mat) || !du) return;
		patched.add(mat);
		const prev = mat.onBeforeCompile;
		mat.onBeforeCompile = (shader: TShader, r: unknown) => {
			prev?.call(mat, shader, r);
			Object.assign(shader.uniforms, du);
			shader.vertexShader = "varying float oeW;\n" + shader.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n\toeW = gl_Position.w;");
			shader.fragmentShader = host!.depthGLSL + "\nvarying float oeW;\nuniform vec2 u_oeSize;\n" + shader.fragmentShader.replace("#include <dithering_fragment>", "\tif (sceneOcclusion(gl_FragCoord.xy / u_oeSize, oeW) > 0.5) discard;\n#include <dithering_fragment>");
		};
		const prevKey = mat.customProgramCacheKey;
		mat.customProgramCacheKey = () => "oe-depth:" + (prevKey ? prevKey.call(mat) : "");
		mat.needsUpdate = true;
	}
	function patchScene() { scene!.traverse(o => { const m = o.material; if (!m) return; if (Array.isArray(m)) m.forEach(patchMaterial); else patchMaterial(m); }); }
	const fail = (e: unknown) => { failed = String((e as Error)?.message || e); console.error("[three overlay] failed", e); host!.post({ type: "error", error: failed }); host!.stage?.("failed", { error: failed }); };

	function init(canvas: OffscreenCanvas, o: ThreeOpts | null | undefined, h: OverlayHost) {
		host = h; opts = o || {};
		if (!opts.three) { fail("three: URL of three.module.js is required (opts.three)"); return; }
		const want = opts.depth !== false;
		(async () => {
			try {
				THREE = await import(/* @vite-ignore */ opts!.three!) as ThreeModule;
				if (dead) return;
				loader = createThreeLoader({ three: opts!.three!, addons: opts!.addons || addonsBaseOf(opts!.three!) });
				user = opts!.module ? await loader.load(opts!.module) as UserModule : {};
				if (dead) return;
				const rev = parseInt(THREE.REVISION || "0", 10);
				let depthOn = want;
				if (want && !THREE.ExternalTexture && opts!.renderer !== "webgpu") { depthOn = false; console.warn(`[three overlay] three r${rev || "?"} has no THREE.ExternalTexture: drawn without scene depth (not hidden by terrain or buildings). Use three r${MIN_DEPTH_REVISION} or later, or pass depth: false.`); }
				canvasRef = canvas;
				if (opts!.renderer === "webgpu") {
					const WGR = THREE.WebGPURenderer;
					if (!WGR) throw new Error(`three overlay: renderer "webgpu" needs three.webgpu.js (opts.three = ${opts!.three})`);
					const shared = host!.gpuDevice?.() ?? undefined;   // 本体が WebGPU＝同じ device（深度をコピーなしで）
					const r = new WGR({ canvas, alpha: true, antialias: true, device: shared });
					await r.init();
					if (dead) { r.dispose(); return; }
					if (!r.backend.isWebGPUBackend || !r.backend.device) throw new Error("three overlay: WebGPU is not available in this browser (use renderer: \"webgl\")");
					renderer = r; renderer.autoClear = false;
					gpu = { device: r.backend.device, ctx: canvas.getContext("webgpu") as GPUCanvasContext, renderer: r, pre: null };
				} else {
					renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
					renderer.autoClear = true;
				}
				renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0);
				scene = new THREE.Scene();
				camera = new THREE.PerspectiveCamera(); camera.matrixAutoUpdate = false; camera.matrixWorldAutoUpdate = false;
				if (gpu) camera.coordinateSystem = THREE.WebGPUCoordinateSystem;   // 先に揃える（揃っていないと render が updateProjectionMatrix で透視を既定に戻す）
				origin = opts!.origin || [0, 0, 0];
				M = buildM(origin); Minv = M.clone().invert();
				if (depthOn && gpu) gpu.pre = createDepthPrepass(THREE as unknown as ThreeGPU);
				else if (depthOn) { extTex = new THREE.ExternalTexture!(null); du = { u_sceneDepth: { value: extTex }, u_sceneLogCoef: { value: 1 }, u_sceneDepthEps: { value: 2e-6 }, u_sceneDepthOn: { value: 0 }, u_oeSize: { value: new THREE.Vector2(1, 1) } }; }
				helpers = { THREE, scene, camera, renderer, origin, params: opts!.params, lnglatToLocal, localToLnglat, importAddon: (path: string) => loader!.addon(path),
					requestDraw: () => host!.requestDraw(), post: (d: unknown) => host!.post(d), earthRadiusM: worldRadiusM(), time: 0, clock: null };
				await user.setup?.(THREE, scene, helpers);
				if (dead) return;
				if (depthOn) patchScene();
				ready = true; host!.stage?.("setup", { revision: rev, depth: depthOn }); host!.requestDraw();
			} catch (e) { if (!dead) fail(e); }
		})();
		return want ? { depth: true } : undefined;
	}
	function message(d: ThreeMsg) {
		if (d?.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!ready) { (queue ??= []).push(d); return; }
		try { user!.onMessage?.(d, helpers!); } catch (e) { console.error("[three overlay] onMessage", e); }
		host!.requestDraw();
	}
	function answerProbes(w: number, h: number) {
		if (!probes.length) return;
		if (gpu) {   // WebGPU の canvas＝今の絵を buffer へ写して読む（非同期・行は上から）
			const ids = probes.splice(0);
			readCanvasPixels(gpu.device, gpu.ctx, w, h).then(data => { for (const id of ids) host!.post({ type: "pixels", id, w, h, flipY: false, data: id === ids[ids.length - 1] ? data : data.slice() }); })
				.catch(e => { for (const id of ids) host!.post({ type: "pixels", id, error: String((e as Error)?.message || e) }); });
			return;
		}
		const gl = renderer!.getContext(), ids = probes.splice(0);
		try { const data = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host!.post({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice() }); }
		catch (e) { for (const id of ids) host!.post({ type: "pixels", id, error: String((e as Error)?.message || e) }); }
	}
	// カメラ＝本体の透視と P⁻¹·mvp·M（f64 の配列で掛ける）
	function setCamera(s: CameraState) {
		const P = new THREE!.Matrix4().fromArray(s.projection), V = P.clone().invert().multiply(new THREE!.Matrix4().fromArray(s.mvp)).multiply(M!);
		const Pc = gpu ? new THREE!.Matrix4().fromArray(toWebGPUDepth(s.projection)) : P;   // WebGPU の深度は [0, 1]
		camera!.projectionMatrix.copy(Pc); camera!.projectionMatrixInverse.copy(Pc).invert();
		camera!.matrixWorldInverse.copy(V); camera!.matrixWorld.copy(V).invert();
		camera!.matrixWorld.decompose(camera!.position, camera!.quaternion, camera!.scale);   // 利用者の Raycaster・lookAt 系の便宜（matrixAutoUpdate は false のまま）
	}
	function frame(cam: CameraPose, s: CameraState, { w, h }: { w: number; h: number }, api: OverlayFrameApi) {
		if (!ready) return false;
		if (queue) { const q = queue; queue = null; for (const d of q) message(d); }
		if (w !== lastW || h !== lastH) { renderer!.setSize(w, h, false); lastW = w; lastH = h; }
		setCamera(s);
		if (gpu?.pre) {
			const d = api.depth, src = d ? d.gpuTexture(gpu.device) : null;
			gpu.pre.update(src, d?.logCoef ?? 1, d?.w ?? 1, d?.h ?? 1, w, h, s.projection);
			if (src) depthUsed = true;
		}
		if (du) {
			if (api.depth) { extTex!.sourceTexture = api.depth.texture(renderer!.getContext()); du.u_sceneLogCoef.value = api.depth.logCoef; du.u_sceneDepthOn.value = 1; depthUsed = true; }
			else du.u_sceneDepthOn.value = 0;
			du.u_oeSize.value.set(w, h);
			patchScene();   // setup の後に足された材質も拾う
		}
		helpers!.time = api.time; helpers!.clock = api.clock;
		const now = api.time ?? 0, dt = lastT ? (now - lastT) / 1000 : 0; lastT = now;
		let more = false;
		try { more = !!user!.update?.(dt, helpers!); } catch (e) { console.error("[three overlay] update", e); }
		if (gpu) { gpu.renderer.clear(); if (gpu.pre) renderer!.render(gpu.pre.scene as unknown as TScene, camera!); }   // 前置き（本体の深度）→ 利用者のシーン（深度は引き継ぐ）
		renderer!.render(scene!, camera!);
		answerProbes(w, h);
		return more;
	}
	// 統一 picking：x, y＝device px（上が 0）。Raycaster で一番手前の物＝{ id, name, distance:0, lngLat, properties:{ name, userData } }
	function pick(x: number, y: number, r: number, ctx: { s?: unknown; size: { w: number; h: number } } | null | undefined) {
		if (!ready || !ctx?.s) return null;
		const { w, h } = ctx.size;
		const rc = new THREE!.Raycaster();
		rc.setFromCamera(new THREE!.Vector2(x / w * 2 - 1, 1 - y / h * 2), camera!);
		const hit = rc.intersectObjects(scene!.children, true)[0];
		if (!hit) return null;
		const ll = localToLnglat(hit.point);
		return { id: hit.object.id, name: hit.object.name || null, distance: 0, lngLat: [ll[0], ll[1]], properties: { name: hit.object.name || null, userData: hit.object.userData || {}, altitudeM: ll[2] } };
	}
	function destroy() {
		dead = true;
		try { user?.dispose?.(helpers); } catch { /* 利用者の後始末 */ }
		try { renderer?.dispose(); renderer?.forceContextLoss?.(); } catch { /* 文脈はもう無い */ }
		loader?.dispose(); gpu?.pre?.dispose(); gpu = null; canvasRef = null;
		THREE = renderer = scene = camera = user = helpers = M = Minv = du = extTex = loader = null; ready = false; lastW = lastH = 0; queue = null;
	}
	return { init, message, frame, pick, destroy, _state: () => ({ ready, failed, depthUsed }) };
}
