// 2D の雲（第 3 波 W6・2026-10-12）＝setClouds({ type: "image", url, altitude, opacity, color, wind }) の builtin の描き手。
//   全球の雲量の画像（等経緯度・左上＝西経 180°/北緯 90°）を、球の少し上（altitude m）の殻として描く。殻は全球 1 枚のメッシュ（0.5° の格子）＝
//   模型と同じメッシュの道（setMesh＝MESH_TEX・uv＋頂点色＋テクスチャ・BLEND・noLift・keep2d＝真俯瞰でも・影を落とさない）で描く＝両レンダラに新しいシェーダは要らない。
//   テクスチャ＝画像そのまま（最大 4096）。RTE の原点＝地心（float32 で ≈ 0.4 m＝雲には十分）。1 バッチ＝renderer の受け取り（1 フレーム 1 バッチ）でも一度に立つ。
//   風（wind＝[東 m/s, 北 m/s]）＝殻を剛体として回す（W4 の meshXf）：東西＝極軸まわりの回転（全球の殻＝どの角でも厳密・360° で畳む）、
//   南北＝視点の中心の子午線に直交する水平軸まわりの回転（±10° で頭打ち＝全球の剛体回転では南北の流れは近似）。時計＝map.getNow（setNow で止められる＝決定論の撮影）。
//   α＝画像に α があればそれ（色は画像×color）、無ければ輝度（色は color）＝alphaFrom "auto"|"alpha"|"luminance"。opacity を掛ける。
//   coverage／density／thickness（手続きの雲）・体積雲・降水は spec のまま（capabilities "clouds.procedural"／"precipitation"）。
import { lonlatTo3D } from "@ortho-earth/core";
import { batchXf } from "./gltf-anim.js";
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const STEP_DEG = 0.5;
const MAX_IMG = 4096, LAT_DRIFT_MAX = 10;   // 殻の格子＝0.5°（弦の垂れ＝R(1−cos 0.25°) ≈ 61 m＝高度 3000 m の殻でも地面に潜らない）
// 東西 θlon°（経度が増える向き）と南北 θlat°（視点の中心の経度 lonC の子午線上で緯度が増える向き）の回転＝3x3 列優先。L = Rlon · Rlat
export function cloudRotation(thetaLonDeg, thetaLatDeg, lonCenterDeg) {
	const a = thetaLonDeg * D2R, c = Math.cos(a), s = Math.sin(a);
	const Rlon = [c, 0, s, 0, 1, 0, -s, 0, c];   // e_x=(1,0,0)（経度 0）→(cos, 0, sin)（経度 θ）
	const b = thetaLatDeg * D2R, lc = lonCenterDeg * D2R;
	// 子午線 lonC に直交する水平軸（東向き e）まわりの回転（Rodrigues）＝右手で正の角が北向き（検定 tests/clouds.mjs rot.lat）
	const ex = -Math.sin(lc), ey = 0, ez = Math.cos(lc), t = b, ct = Math.cos(t), st = Math.sin(t), vt = 1 - ct;
	const Rlat = [ct + ex*ex*vt, ey*ex*vt + ez*st, ez*ex*vt - ey*st, ex*ey*vt - ez*st, ct + ey*ey*vt, ez*ey*vt + ex*st, ex*ez*vt + ey*st, ey*ez*vt - ex*st, ct + ez*ez*vt];
	const o = new Float64Array(9);
	for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) o[col*3+row] = Rlon[row]*Rlat[col*3] + Rlon[3+row]*Rlat[col*3+1] + Rlon[6+row]*Rlat[col*3+2];
	return o;
}
export const wrapLon = th => ((th + 180) % 360 + 360) % 360 - 180;   // 極軸まわりの回転＝360° で畳む（全球 1 枚の殻＝見た目は同じ）
// 画像の画素 → 雲の RGBA（α の出どころ・色・opacity）。純関数＝検定できる
export function cloudPixels(src, w, h, { color = "#ffffff", opacity = 1, alphaFrom = "auto" } = {}) {
	const n = w * h, out = new Uint8Array(n * 4), col = parseHex(color);
	let mode = alphaFrom;
	if (mode === "auto") { mode = "luminance"; for (let i = 3; i < src.length; i += 4) if (src[i] !== 255) { mode = "alpha"; break; } }
	for (let i = 0; i < n; i++) {
		const r = src[i*4], g = src[i*4+1], b = src[i*4+2], a = src[i*4+3];
		if (mode === "alpha") { out[i*4] = r * col[0] / 255; out[i*4+1] = g * col[1] / 255; out[i*4+2] = b * col[2] / 255; out[i*4+3] = Math.round(a * opacity); }
		else { const lum = Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)); out[i*4] = col[0]; out[i*4+1] = col[1]; out[i*4+2] = col[2]; out[i*4+3] = Math.round(lum * opacity); }
	}
	return { rgba: out, mode };
}
export function parseHex(c) {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || "").trim()); if (!m) return [255, 255, 255];
	let h = m[1]; if (h.length === 3) h = [...h].map(x => x + x).join("");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// 全球の殻＝1 枚のメッシュ { pos, nrm, idx, uv, col, origin, bbox }（経度 step 刻み・緯度 step 刻み・uv＝等経緯度の画像そのまま）。hr＝高さ／R。
//   原点＝地心（RTE の原点相対＝float32 で ≈ 0.4 m の精度＝雲には十分）。1 バッチ＝renderer の「1 フレーム 1 バッチ」の受け取りでも一度に立つ
export function shellMesh(hr, step = STEP_DEG) {
	const nx = Math.round(360 / step), ny = Math.round(180 / step), NX = nx + 1, NY = ny + 1, n = NX * NY;
	const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), nrm = new Int8Array(n * 4), col = new Uint8Array(n * 4).fill(255), s = 1 + hr;
	for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
		const u = i / nx, v = j / ny, p = lonlatTo3D(-180 + 360 * u, 90 - 180 * v), l = Math.hypot(p[0], p[1], p[2]), k = j * NX + i;
		pos[k*3] = p[0] * s; pos[k*3+1] = p[1] * s; pos[k*3+2] = p[2] * s;
		uv[k*2] = u; uv[k*2+1] = v;
		nrm[k*4] = Math.round(p[0] / l * 127); nrm[k*4+1] = Math.round(p[1] / l * 127); nrm[k*4+2] = Math.round(p[2] / l * 127);
	}
	const idx = new Uint32Array(nx * ny * 6); let w = 0;
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1; idx[w++] = a; idx[w++] = c; idx[w++] = b; idx[w++] = b; idx[w++] = c; idx[w++] = d; }
	return { pos, nrm, idx, uv, col, origin: [0, 0, 0], bbox: [-180, -90, 180, 90] };
}
export function createCloudShell(map, { setMesh, setMeshXf = null, requestDraw = () => {}, earthM = 6371000, now = () => performance.now(), emit = () => {} }) {
	let cur = null, seq = 0, timer = 0, lastT = null, theta = [0, 0], sent = [NaN, NaN];
	const stopWind = () => { if (timer) clearInterval(timer); timer = 0; lastT = null; };
	const clear = () => { stopWind(); if (cur) { setMesh(cur.name, null); cur = null; } theta = [0, 0]; sent = [NaN, NaN]; };
	async function loadImage(url) {
		const r = await fetch(url, { credentials: "omit" }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
		let bmp = await createImageBitmap(await r.blob());
		const s = Math.min(1, MAX_IMG / Math.max(bmp.width, bmp.height));
		const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
		const cv = new OffscreenCanvas(w, h), ctx = cv.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(bmp, 0, 0, w, h); bmp.close?.();
		return { w, h, data: ctx.getImageData(0, 0, w, h).data };
	}
	function tick() {
		if (!cur) return;
		const t = now(), dt = lastT == null ? 0 : Math.min(3600, Math.max(0, (t - lastT) / 1000)); lastT = t;   // 1 刻み 1 時間まで（setNow の跳びを追う・裏タブ復帰の暴走は防ぐ）
		const [we, wn] = cur.spec.wind, latc = map.getCenter?.()?.lat ?? 0, lonc = map.getCenter?.()?.lng ?? 0;
		theta[0] = wrapLon(theta[0] + (we * dt / (earthM * Math.max(0.2, Math.cos(latc * D2R)))) * R2D);
		theta[1] = Math.max(-LAT_DRIFT_MAX, Math.min(LAT_DRIFT_MAX, theta[1] + (wn * dt / earthM) * R2D));
		if (Math.abs(theta[0] - sent[0]) < 1e-4 && Math.abs(theta[1] - sent[1]) < 1e-4) return;
		sent = [theta[0], theta[1]];
		if (!setMeshXf) return;
		const xf = (theta[0] || theta[1]) ? { L: cloudRotation(theta[0], theta[1], lonc), t: [0, 0, 0] } : null;
		setMeshXf(`${cur.name}#0`, batchXf(xf, [0, 0, 0]));
		requestDraw();
	}
	async function set(spec) {
		const my = ++seq;
		if (!spec || spec.type !== "image" || !spec.url) { clear(); return null; }
		let img;
		try { img = await loadImage(spec.url); } catch (e) { if (my === seq) { clear(); emit({ state: "error", error: e?.message || String(e) }); } return null; }
		if (my !== seq) return null;
		clear();
		const { rgba, mode } = cloudPixels(img.data, img.w, img.h, spec);
		const name = `clouds/${my}`, m = shellMesh(spec.altitude / earthM), tris = m.idx.length / 3;   // idx は transfer で渡る＝数は先に取る
		setMesh(`${name}#0`, { ...m, ward: name, twoSided: 1, noLift: true, keep2d: true, castShadow: false, tex: { rgba, w: img.w, h: img.h }, alphaMode: "BLEND", alphaCutoff: 0.5 });
		cur = { spec, name, image: { w: img.w, h: img.h, alphaFrom: mode }, tris };
		if (spec.wind[0] || spec.wind[1]) { lastT = now(); timer = setInterval(tick, 250); }
		requestDraw();
		emit({ state: "ready", tris: cur.tris, image: cur.image });
		return cur.image;
	}
	return { set, clear, tick, destroy: clear, get current() { return cur ? { name: cur.name, tris: cur.tris, image: cur.image } : null; }, angles: () => [...theta] };
}
