// three.js を render worker の中で描く同一フレームのオーバーレイ（deck.gl 差分 PR-3・計画 段 C1〜C2・2026-10-11）。
// 既存の customgl（MapLibre の CustomLayerInterface の通訳）は main の別 canvas＝地図と深度を共有せず常に手前・起動中心で局所線形化。
// こちらは OffscreenCanvas の WebGL2 に THREE.WebGLRenderer を立て、地球・注記と同じ rAF・同じ cam で描き、本体の深度（#47・api.depth）で
// 地形・建物に**隠れる**。three.js は repo の依存にしない（裁定 2026-10-11）＝利用者が URL で持ち込む（opts.three）。利用者の模型コードも URL（opts.module）。
//
// 契約（map.overlay の builtin "three"）：init(canvas, opts, host) / message(data) / frame(cam, s, size, api) / pick(x, y, r, ctx) / destroy()
//   opts＝{ three: URL（three.module.js）, module: URL（利用者のモジュール）, origin: [lon, lat, hM]（シーンの原点＝ENU の m・RTE）, depth: true, params: 何でも（setup へ）}
//   利用者のモジュール＝export function setup(THREE, scene, h) / update?(dt, h) → true＝描き続ける / onMessage?(data, h) / dispose?(h)
//   h（helpers）＝{ THREE, scene, camera, renderer, origin, params, lnglatToLocal(lon, lat, hM) → Vector3（ENU m）, localToLnglat(v) → [lon, lat, hM], requestDraw(), post(data), earthRadiusM, time, clock }
//
// 座標：scene の単位は m・原点 origin の東北上（ENU）。world（β 単位球）← ENU は行列 M（customgl と同じ作り・楕円体は y を 1/rAx）。
//   カメラ＝projectionMatrix を本体の透視（s.projection・clip.x の反転込み）に、matrixWorldInverse を P⁻¹·mvp·M（THREE.Matrix4＝f64 の配列で掛けてから f32 へ）＝
//   原点相対の小さな値だけが f32 に落ちる＝RTE（高ズームで震えない）。ENU は右手系・world は左手系（E×N＝−U）だが mvp の clip.x 反転と相殺＝面の向き（culling）は正しい。
// 深度：材質ごとに onBeforeCompile で本体の DEPTH_GLSL（host.depthGLSL）を貼り、gl_Position.w を varying で運んで FS で sceneOcclusion(gl_FragCoord.xy / 描画面, w) なら discard。
//   深度テクスチャは THREE.ExternalTexture（本体が上げた WebGLTexture をそのまま束ねる・コピーなし）。深度の無いフレーム（申し出前・LOW_MEM）は u_sceneDepthOn=0＝隠れない。
// 当たり判定（統一 picking・PR-1）＝THREE.Raycaster（カメラの行列はそのまま使える）。
import { lonlatTo3D, ellipsoidOn, worldRadiusM } from "@ortho-earth/core/camera";

const D2R = Math.PI / 180;
let THREE = null, renderer = null, scene = null, camera = null, host = null, user = null, opts = null;
let M = null, Minv = null, origin = null, ready = false, failed = null, lastT = 0, lastW = 0, lastH = 0;
let du = null, extTex = null, depthUsed = false;
const patched = new WeakSet();
const probes = [];
let helpers = null;

// ENU（m）→ world（β 単位球）の行列（列優先・THREE.Matrix4 の set は行優先なので fromArray で入れる）
function buildM([lon, lat, h = 0]) {
	const a = lon * D2R, b = lat * D2R, rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, K = 1 / worldRadiusM();
	const T = lonlatTo3D(lon, lat);
	const E = [-Math.sin(a), 0, Math.cos(a)], N = [-Math.sin(b) * Math.cos(a), Math.cos(b) / rAx, -Math.sin(b) * Math.sin(a)], U = [Math.cos(b) * Math.cos(a), Math.sin(b) / rAx, Math.cos(b) * Math.sin(a)];
	const o = [T[0] + U[0] * h * K, T[1] + U[1] * h * K, T[2] + U[2] * h * K];
	const m = new THREE.Matrix4();
	m.fromArray([E[0] * K, E[1] * K, E[2] * K, 0, N[0] * K, N[1] * K, N[2] * K, 0, U[0] * K, U[1] * K, U[2] * K, 0, o[0], o[1], o[2], 1]);
	return m;
}
function lnglatToLocal(lon, lat, h = 0) {
	const a = lon * D2R, b = lat * D2R, rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, K = 1 / worldRadiusM();
	const p = lonlatTo3D(lon, lat), U = [Math.cos(b) * Math.cos(a), Math.sin(b) / rAx, Math.cos(b) * Math.sin(a)];
	return new THREE.Vector3(p[0] + U[0] * h * K, p[1] + U[1] * h * K, p[2] + U[2] * h * K).applyMatrix4(Minv);
}
function localToLnglat(v) {
	const p = v.clone().applyMatrix4(M), rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, r = Math.hypot(p.x, p.y, p.z);
	const lon = Math.atan2(p.z, p.x) / D2R, beta = Math.asin(Math.max(-1, Math.min(1, p.y / r)));
	return [lon, Math.atan(Math.tan(beta) / rAx) / D2R, (r - 1) * worldRadiusM()];
}
// 本体の深度で隠す＝材質の shader に貼る（1 回だけ・customProgramCacheKey で本体の program と分ける）
function patchMaterial(mat) {
	if (!mat || patched.has(mat) || !du) return;
	patched.add(mat);
	const prev = mat.onBeforeCompile;
	mat.onBeforeCompile = (shader, r) => {
		prev?.call(mat, shader, r);
		Object.assign(shader.uniforms, du);
		shader.vertexShader = "varying float oeW;\n" + shader.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n\toeW = gl_Position.w;");
		shader.fragmentShader = host.depthGLSL + "\nvarying float oeW;\nuniform vec2 u_oeSize;\n" + shader.fragmentShader.replace("#include <dithering_fragment>", "\tif (sceneOcclusion(gl_FragCoord.xy / u_oeSize, oeW) > 0.5) discard;\n#include <dithering_fragment>");
	};
	const prevKey = mat.customProgramCacheKey;
	mat.customProgramCacheKey = () => "oe-depth:" + (prevKey ? prevKey.call(mat) : "");
	mat.needsUpdate = true;
}
function patchScene() { scene.traverse(o => { const m = o.material; if (!m) return; if (Array.isArray(m)) m.forEach(patchMaterial); else patchMaterial(m); }); }

export function init(canvas, o, h) {
	host = h; opts = o || {};
	if (!opts.three) { failed = "three: URL of three.module.js is required (opts.three)"; console.error("[three overlay]", failed); return; }
	const want = opts.depth !== false;
	(async () => {
		try {
			THREE = await import(/* @vite-ignore */ opts.three);
			user = opts.module ? await import(/* @vite-ignore */ opts.module) : {};
			renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
			renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
			scene = new THREE.Scene();
			camera = new THREE.PerspectiveCamera(); camera.matrixAutoUpdate = false; camera.matrixWorldAutoUpdate = false;
			origin = opts.origin || [0, 0, 0];
			M = buildM(origin); Minv = M.clone().invert();
			if (want) { extTex = new THREE.ExternalTexture(null); du = { u_sceneDepth: { value: extTex }, u_sceneLogCoef: { value: 1 }, u_sceneDepthEps: { value: 2e-6 }, u_sceneDepthOn: { value: 0 }, u_oeSize: { value: new THREE.Vector2(1, 1) } }; }
			helpers = { THREE, scene, camera, renderer, origin, params: opts.params, lnglatToLocal, localToLnglat, requestDraw: () => host.requestDraw(), post: d => host.post(d), earthRadiusM: worldRadiusM(), time: 0, clock: null };
			await user.setup?.(THREE, scene, helpers);
			if (want) patchScene();
			ready = true; host.requestDraw();
		} catch (e) { failed = String(e?.message || e); console.error("[three overlay] failed", e); host.post({ type: "error", error: failed }); }
	})();
	return want ? { depth: true } : undefined;
}
export function message(d) {
	if (d?.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!ready) { (message.q ??= []).push(d); return; }
	try { user.onMessage?.(d, helpers); } catch (e) { console.error("[three overlay] onMessage", e); }
	host.requestDraw();
}
function answerProbes(w, h) {
	if (!probes.length) return;
	const gl = renderer.getContext(), ids = probes.splice(0);
	try { const data = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host.post({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host.post({ type: "pixels", id, error: String(e?.message || e) }); }
}
// カメラ＝本体の透視と P⁻¹·mvp·M（f64 の配列で掛ける）
function setCamera(s) {
	const P = new THREE.Matrix4().fromArray(s.projection), V = P.clone().invert().multiply(new THREE.Matrix4().fromArray(s.mvp)).multiply(M);
	camera.projectionMatrix.copy(P); camera.projectionMatrixInverse.copy(P).invert();
	camera.matrixWorldInverse.copy(V); camera.matrixWorld.copy(V).invert();
	camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);   // 利用者の Raycaster・lookAt 系の便宜（matrixAutoUpdate は false のまま）
}
export function frame(cam, s, { w, h }, api) {
	if (!ready) return false;
	if (message.q) { const q = message.q; message.q = null; for (const d of q) message(d); }
	if (w !== lastW || h !== lastH) { renderer.setSize(w, h, false); lastW = w; lastH = h; }
	setCamera(s);
	if (du) {
		if (api.depth) { extTex.sourceTexture = api.depth.texture(renderer.getContext()); du.u_sceneLogCoef.value = api.depth.logCoef; du.u_sceneDepthOn.value = 1; depthUsed = true; }
		else du.u_sceneDepthOn.value = 0;
		du.u_oeSize.value.set(w, h);
		patchScene();   // setup の後に足された材質も拾う
	}
	helpers.time = api.time; helpers.clock = api.clock;
	const now = api.time ?? 0, dt = lastT ? (now - lastT) / 1000 : 0; lastT = now;
	let more = false;
	try { more = !!user.update?.(dt, helpers); } catch (e) { console.error("[three overlay] update", e); }
	renderer.render(scene, camera);
	answerProbes(w, h);
	return more;
}
// 統一 picking：x, y＝device px（上が 0）。Raycaster で一番手前の物＝{ id, name, distance:0, lngLat, properties:{ name, userData } }
export function pick(x, y, r, ctx) {
	if (!ready || !ctx?.s) return null;
	const { w, h } = ctx.size;
	const rc = new THREE.Raycaster();
	rc.setFromCamera(new THREE.Vector2(x / w * 2 - 1, 1 - y / h * 2), camera);
	const hit = rc.intersectObjects(scene.children, true)[0];
	if (!hit) return null;
	const ll = localToLnglat(hit.point);
	return { id: hit.object.id, name: hit.object.name || null, distance: 0, lngLat: [ll[0], ll[1]], properties: { name: hit.object.name || null, userData: hit.object.userData || {}, altitudeM: ll[2] } };
}
export function destroy() {
	try { user?.dispose?.(helpers); } catch { /* 利用者の後始末 */ }
	try { renderer?.dispose(); renderer?.forceContextLoss?.(); } catch { /* 文脈はもう無い */ }
	THREE = renderer = scene = camera = user = helpers = M = Minv = du = extTex = null; ready = false; lastW = lastH = 0;
}
export const _state = () => ({ ready, failed, depthUsed });
