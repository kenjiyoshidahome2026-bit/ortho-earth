// MapLibre の custom 層に渡す args（CustomLayerInterface の render(gl, args)）を cam から組む純関数＝main の customgl.js と render worker の customgl-draw.js が同じ物を使う（deck.gl 差分 PR-7・2026-10-12）。
// 行列＝mvp · [メルカトル → 単位球]（視点の中心で局所線形化）・prelude（mercator／globe の variant）・getProjectionData（タイル単位）。中身は customgl.js から切り出し（挙動は同じ）。
import { cameraState, lonlatTo3D, ellipsoidOn } from "@ortho-earth/core";
import type { CameraPose } from "@ortho-earth/core/camera";

const PI = Math.PI, D2R = PI / 180, EARTH_R_ML = 6371008.8;   // MapLibre の地球の半径（MercatorCoordinate と同じ）
const mercX = (lng: number) => (180 + lng) / 360;
const mercY = (lat: number) => (180 - (180 / PI) * Math.log(Math.tan(PI / 4 + lat * PI / 360))) / 360;
// 4×4（列優先・gl-matrix の並び）の積 a·b
const mul = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array => { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
// メルカトルの vertex の下ごしらえ（MapLibre の shaders/_prelude_projection.vertex.glsl の mercator 版と同じ名前・同じ働き）
const PRELUDE = `uniform mat4 u_projection_matrix;
uniform vec4 u_projection_tile_mercator_coords;
uniform vec4 u_projection_clipping_plane;
uniform float u_projection_transition;
uniform mat4 u_projection_fallback_matrix;
vec4 projectTile(vec2 p) { return u_projection_matrix * vec4(p, 0.0, 1.0); }
vec4 projectTile(vec2 p, vec2 rawPos) { return u_projection_matrix * vec4(p, 0.0, 1.0); }
vec4 projectTileFor3D(vec2 p, float elevation) { return u_projection_matrix * vec4(p, elevation, 1.0); }
vec4 projectTileWithElevation(vec2 posInTile, float elevation) { return u_projection_matrix * vec4(posInTile, elevation, 1.0); }
`;
// 球の vertex の下ごしらえ（MapLibre の projectionGlobe と同じ名前・同じ働き＝2026-09-30）。タイルの座標 → メルカトル → 経緯度 → この地図の単位球（β 空間）→ u_projection_matrix（＝この地図の mvp）。
// 球の座標の軸はこの地図の流儀（x＝cosφcosλ・y＝sinφ・z＝cosφsinλ・core lonlatTo3D）＝MapLibre（x＝sinλ）とは軸が違うが、層は projectTile しか呼ばないので絵は同じ。
// 極の頂点（rawPos.y＝-32768／32767・tilemesh.js）は極へ。裏側は u_projection_clipping_plane（(dot(pos, xyz)+w) が 0 未満＝裏）で z を 1 の外へ＝描かない（MapLibre の globeComputeClippingZ と同じ式）。
// u_projection_transition は常に 1（球のまま）・u_projection_fallback_matrix は mercator の局所線形化（層が transition を混ぜても壊れない）
const PRELUDE_GLOBE = `#ifndef PI
#define PI 3.141592653589793
#endif
#define GLOBE_RADIUS 6371008.8
uniform mat4 u_projection_matrix;
uniform highp vec4 u_projection_tile_mercator_coords;
uniform highp vec4 u_projection_clipping_plane;
uniform highp float u_projection_transition;
uniform mat4 u_projection_fallback_matrix;
out highp float v_projection_tile_x;
vec3 globeRotateVector(vec3 vec, vec2 angles) { vec3 axisRight = vec3(vec.z, 0.0, -vec.x); vec3 axisUp = cross(axisRight, vec); axisRight = normalize(axisRight); axisUp = normalize(axisUp); vec2 t = tan(angles); return normalize(vec + axisRight * t.x + axisUp * t.y); }
mat3 globeGetRotationMatrix(vec3 spherePos) { vec3 axisRight = vec3(spherePos.z, 0.0, -spherePos.x); vec3 axisDown = cross(axisRight, spherePos); axisRight = normalize(axisRight); axisDown = normalize(axisDown); return mat3(axisRight, axisDown, spherePos); }
float circumferenceRatioAtTileY(float tileY) { float my = u_projection_tile_mercator_coords.y + u_projection_tile_mercator_coords.w * tileY; float t = exp(PI - (my * PI * 2.0)); return (2.0 * t) / (t * t + 1.0); }
float projectLineThickness(float tileY) { return 1.0 / circumferenceRatioAtTileY(tileY); }
float projectCircleRadius(float tileY) { return 1.0 / circumferenceRatioAtTileY(tileY); }
vec3 projectToSphere(vec2 translatedPos, vec2 rawPos) {
	vec2 m = u_projection_tile_mercator_coords.xy + u_projection_tile_mercator_coords.zw * translatedPos;
	float lon = m.x * PI * 2.0 - PI;
	float t = exp(PI - (m.y * PI * 2.0)); float t2 = t * t; float denom = t2 + 1.0;
	float sinLat = (t2 - 1.0) / denom; float cosLat = (2.0 * t) / denom;
	vec3 pos = vec3(cos(lon) * cosLat, sinLat, sin(lon) * cosLat);
	if (rawPos.y < -32767.5) { pos = vec3(0.0, 1.0, 0.0); }
	if (rawPos.y > 32766.5) { pos = vec3(0.0, -1.0, 0.0); }
	return pos;
}
vec3 projectToSphere(vec2 posInTile) { return projectToSphere(posInTile, vec2(0.0, 0.0)); }
float globeComputeClippingZ(vec3 spherePos) { return (1.0 - (dot(spherePos, u_projection_clipping_plane.xyz) + u_projection_clipping_plane.w)); }
vec4 interpolateProjection(vec2 posInTile, vec3 spherePos, float elevation) {
	v_projection_tile_x = posInTile.x;
	vec3 elevatedPos = spherePos * (1.0 + elevation / GLOBE_RADIUS);
	vec4 globePosition = u_projection_matrix * vec4(elevatedPos, 1.0);
	globePosition.z = globeComputeClippingZ(elevatedPos) * globePosition.w;
	if (u_projection_transition > 0.999) { return globePosition; }
	vec4 flatPosition = u_projection_fallback_matrix * vec4(posInTile, elevation, 1.0);
	vec4 result = globePosition;
	result.z = mix(0.0, globePosition.z, clamp((u_projection_transition - 0.2) / 0.8, 0.0, 1.0));
	result.xyw = mix(flatPosition.xyw, globePosition.xyw, u_projection_transition);
	return result;
}
vec4 interpolateProjectionFor3D(vec2 posInTile, vec3 spherePos, float elevation) {
	v_projection_tile_x = posInTile.x;
	vec4 globePosition = u_projection_matrix * vec4(spherePos * (1.0 + elevation / GLOBE_RADIUS), 1.0);
	if (u_projection_transition > 0.999) { return globePosition; }
	return mix(u_projection_fallback_matrix * vec4(posInTile, elevation, 1.0), globePosition, u_projection_transition);
}
vec4 projectTile(vec2 posInTile) { return interpolateProjection(posInTile, projectToSphere(posInTile), 0.0); }
vec4 projectTile(vec2 posInTile, vec2 rawPos) { return interpolateProjection(posInTile, projectToSphere(posInTile, rawPos), 0.0); }
vec4 projectTileWithElevation(vec2 posInTile, float elevation) { return interpolateProjection(posInTile, projectToSphere(posInTile), elevation); }
vec4 projectTileFor3D(vec2 posInTile, float elevation) { return interpolateProjectionFor3D(posInTile, projectToSphere(posInTile, posInTile), elevation); }
`;
export const GLOBE_MAX_Z = 13;   // これより寄ったら mercator の variant（局所線形化）＝f32 の単位球座標では震える（MapLibre も z12 前後で球→メルカトルへ移る）

/** makeCustomArgs の opts＝earthM（m→世界単位の換算半径）・globe（球の variant） */
export interface CustomArgsOptions { earthM: number; globe?: boolean }
/** args.getProjectionData の tileID（{z,x,y}｜{canonical,wrap}） */
export interface CustomTileID { z?: number; x?: number; y?: number; wrap?: number; canonical?: { z: number; x: number; y: number } }
// args を組む。camUse＝描く絵の cam、w, h＝描画面（device px）、earthM＝m→世界単位の換算半径、globe＝球の variant（寄っていない間だけ・呼ぶ側が z<GLOBE_MAX_Z と投影を見る）
export function makeCustomArgs(camUse: CameraPose, w: number, h: number, { earthM, globe = false }: CustomArgsOptions = {} as CustomArgsOptions) {
	const st = cameraState(camUse, w, h);
	const [lon, lat] = camUse.center, a = lon * D2R, b = lat * D2R;
	const T = lonlatTo3D(lon, lat);                                                        // 中心（単位球・楕円体なら β 単位球）
	// 東・北・上（測地）の β 空間像＝S⁻¹·n（楕円体表示＝y だけ 1/rAx・#43）。球（rAx＝1）は従来の式と同値
	const rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1;
	const E = [-Math.sin(a), 0, Math.cos(a)], N = [-Math.sin(b) * Math.cos(a), Math.cos(b) / rAx, -Math.sin(b) * Math.sin(a)], U = [Math.cos(b) * Math.cos(a), Math.sin(b) / rAx, Math.cos(b) * Math.sin(a)];
	const K = 2 * PI * EARTH_R_ML * Math.cos(b) / earthM;                                  // メルカトル 1 単位 → 単位球の長さ（中心緯度・等角＝東西南北同じ）
	const x0 = mercX(lon), y0 = mercY(lat);
	// 列優先：col0＝x（東）・col1＝y（南＝メルカトルの y は下向き）・col2＝z（上）・col3＝平行移動（x0,y0 を中心へ）
	const M = new Float64Array(16);
	M[0] = E[0] * K; M[1] = E[1] * K; M[2] = E[2] * K; M[3] = 0;
	M[4] = -N[0] * K; M[5] = -N[1] * K; M[6] = -N[2] * K; M[7] = 0;
	M[8] = U[0] * K; M[9] = U[1] * K; M[10] = U[2] * K; M[11] = 0;
	M[12] = T[0] - M[0] * x0 - M[4] * y0; M[13] = T[1] - M[1] * x0 - M[5] * y0; M[14] = T[2] - M[2] * x0 - M[6] * y0; M[15] = 1;
	const main = mul(Float64Array.from(st.mvp), M);
	const fovy = camUse.fovy ?? 50 * D2R;
	// 球の variant（寄っていない間）：u_projection_matrix＝この地図の mvp（β 単位球→クリップ）・裏側の面＝(E·s, −s)（E＝目の位置・s＝2/(|E|−1)＝地平線で 1・真下で −1・裏で 1 超＝描かない）
	const eyeP = st.eye, eL = Math.hypot(eyeP[0], eyeP[1], eyeP[2]), sC = 2 / Math.max(1e-9, eL - 1), clip = [eyeP[0] * sC, eyeP[1] * sC, eyeP[2] * sC, -sC];
	const mvp = Float64Array.from(st.mvp);
	const dataOf = (mMerc: Float64Array, tmc: number[]) => globe
		? { mainMatrix: mvp, fallbackMatrix: mMerc, tileMercatorCoords: tmc, clippingPlane: clip, projectionTransition: 1 }
		: { mainMatrix: mMerc, fallbackMatrix: mMerc, tileMercatorCoords: tmc, clippingPlane: [0, 0, 0, 0], projectionTransition: 0 };
	return {
		farZ: st.camDist * 1.15 * earthM, nearZ: Math.max(1e-7, st.camDist * 0.3) * earthM, fov: fovy,
		modelViewProjectionMatrix: main, projectionMatrix: st.projection ? Float64Array.from(st.projection) : main,   // projectionMatrix＝透視だけ（MapLibre と同じ・mainMatrix＝P·V）。3D Tiles の例は inv(P)·main で視点を取り出す
		defaultProjectionData: dataOf(main, [0, 0, 1, 1]),
		shaderData: globe ? { variantName: "globe", vertexShaderPrelude: PRELUDE_GLOBE, define: "#define GLOBE" } : { variantName: "mercator", vertexShaderPrelude: PRELUDE, define: "" },
		// タイル単位の投影（MapLibre の args.getProjectionData({ tileID:{z,x,y}|{canonical,wrap} })）＝タイルの中の座標 0..EXTENT（8192）→ メルカトル → クリップ。wrap＝世界の写し
		getProjectionData({ tileID }: { tileID?: CustomTileID } = {}) {
			const z = tileID?.z ?? tileID?.canonical?.z ?? 0, x = tileID?.x ?? tileID?.canonical?.x ?? 0, y = tileID?.y ?? tileID?.canonical?.y ?? 0, wrap = tileID?.wrap ?? 0, n = 2 ** z, EXT = 8192;
			const T = new Float64Array(16); T[0] = 1 / (n * EXT); T[5] = 1 / (n * EXT); T[10] = 1; T[15] = 1; T[12] = x / n + wrap; T[13] = y / n;
			return dataOf(mul(main, T), [x / n + wrap, y / n, 1 / (n * EXT), 1 / (n * EXT)]);
		},
		_st: st,   // 内部用（worker の深度の前置きパスが透視行列を読む）
	};
}
