// voxel の WebGL2 の描き手（同一フレームのオーバーレイ＝map.overlay・render worker の中で地球と同じ rAF・同じ cam）。@ortho-earth/voxel（2026-10-23・第 2 段 region／iso／断面）。
// ⚠ 依存ゼロ（実行時の import 文なし・型だけの import は消える）＝render worker が URL で import() する。深度の GLSL は host.depthGLSL を貼る（建物・地形に隠れる）。
// 一つの map の全部の層を一つのオーバーレイ＝一つの WebGL 文脈で描く（render worker の文脈は Chrome で 4 つまで）。当たりの答えに layer: q（本体の addLayerId と組む）。
// message { type:"layer", q, shape, dims, comps, tex（R8 か RGBA8）, cmap（256×RGBA8）, anchor:[lng,lat,alt], alt, A: Float64Array(9)（セル → 東北上 m・行優先）, radius（m）, geo?（region＝殻・経緯度の枠・セルの大きさ）,
//           mode: 0（blocks）|1（volume）|2（iso）, thr（0〜1）, step（セル）, opacity, clip?（[x0,x1,y0,y1,z0,z1] 割合）, depthTest, properties?, range, on }
//         ／{ type:"style", q, …（mode・thr・step・opacity・clip・depthTest・cmap・frame のどれか）}／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"clear" }／{ type:"budget", bytes }／{ type:"probe", id }（検定）
// GPU の予算（第 5 段 ③）＝テクスチャは描く層の、描く段の、見せるこまの一枚だけ（他のこま・段は CPU に持ち、要る時に上げる）。予算を越えれば遠い層から粗い段（lods）へ（planLevels）、描かない層のテクスチャは捨てる。
// 描き方＝格子を包む箱（box＝セル空間 [0, dims]・region＝経緯度高の殻を東北上 m に）の裏面（cullFace FRONT＝目が中でも描ける）を描き、FS で目からの光線を辿る：
//   box の blocks＝DDA（Amanatides–Woo）で最初の空でないセルに止まり、面の法線で陰影。region の blocks＝一定の刻みで最近傍のセルを見る（セルの境界が経線・緯線・等高度面＝DDA は使えない・刻みはセルの 1/4）。
//   volume＝一定の刻みで三線形に引き、色表の色と α を前から重ねる（α が 0.98 を越えたら打ち切り）。iso＝値が閾を跨いだ所を二分探索で詰め、勾配を法線に。
//   region の点 → セル座標＝東北上 m → 単位球 → 経緯度・高さ（球・rAx で楕円体の緯度に戻す）。断面＝セル空間の範囲 [lo, hi]（box は箱そのものを狭める・region は範囲の外を空に）。
//   cylinder（u_geo 2・2026-10-26）＝殻は扇形を包む凸な箱（東北上 m）。入口と出口は光線と円柱（外の半径）・上下の面の交わり（局所 m＝u_cylM で）。点 → セル＝局所の半径・角度・高さ。
//     中空と角度の外はセルの範囲の外＝飛ばす。blocks の法線＝跨いだセルの軸（半径・角度・高さ）の局所の向き → 東北上（u_cylM の転置）。iso の勾配＝東北上 m で差分。
//   シーンの深度＝対数深度を w に戻し（w＝exp2(2·s/logCoef)−1）、光線はそこで止まる（w は光線に沿って線形＝mvp の第 4 行）。
// 当たり＝止まったセルの番号を RGBA8 に焼く別パス（volume は積算の α が 0.5 を越えたセル）・読む画素だけ scissor。
// 精度＝目の位置（セル空間／東北上 m）と箱の mvp は CPU の倍精度で作る（RTE・splat と同じ）。
import type { OverlayFrameApi } from "@ortho-earth/globe";
import type { GeoGrid, CylGrid, Clip, Level } from "./grid.ts";

type GL = WebGL2RenderingContext;
interface Program { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
export interface OverlayHost { depthGLSL?: string | null; requestDraw?(): void; post?(d: unknown): void; gpuDevice?(): GPUDevice | null }
export interface CamState { mvp: ArrayLike<number>; eye?: ArrayLike<number> | null }
export type VoxelApi = Pick<OverlayFrameApi, "rAx" | "elevM" | "liftScale"> & { depth?: OverlayFrameApi["depth"] };
export interface PickContext { s: CamState; api: VoxelApi; size: { w: number; h: number } }
export type VoxelAltitude = "relative" | "absolute";
export interface VoxelStyle { /** 見せるこま（時間の次元・frames の番号） */ frame?: number; mode?: 0 | 1 | 2; thr?: number; step?: number; opacity?: number; clip?: Clip | null; depthTest?: boolean; /** false＝面の陰を付けない（色そのまま・Cesium の VoxelPrimitive） */ lighting?: boolean; cmap?: Uint8Array; properties?: Record<string, unknown> | null }
export interface VoxelLayerBody extends VoxelStyle { /** ブリックの親の層の id（当たりの layer） */ layer?: string; /** ブリック＝テクスチャの 0 番のセルの親での位置・描く範囲・親の dims */ off?: [number, number, number]; own?: [number, number, number, number, number, number]; full?: [number, number, number]; /** 最大値（R8・RGBA は α）＝閾より下なら描かない */ vmax?: number; /** 時間の次元＝こまごとの値（frames[0]＝tex）。style の frame で選ぶ（GPU には見せるこまだけ） */ frames?: Uint8Array[] | null; /** 粗い段（s＝2, 4…）＝GPU の予算を越える時に遠い層で使う */ lods?: LevelBody[] | null; shape: "box" | "region" | "cylinder"; dims: [number, number, number]; comps: 1 | 4; tex: Uint8Array; cmap: Uint8Array; anchor: [number, number, number]; alt?: VoxelAltitude; A: Float64Array | ArrayLike<number>; radius: number; geo?: GeoGrid | null; mode: 0 | 1 | 2; thr: number; step: number; opacity: number; range: [number, number]; on?: boolean }
export type LevelBody = Pick<Level, "s" | "off" | "own" | "dims" | "tex" | "frames" | "vmax" | "anchor" | "A" | "radius" | "geo">;
export type VoxelMessage = ({ type: "layer"; q: string } & VoxelLayerBody) | ({ type: "style"; q: string } & VoxelStyle) | { type: "remove"; q: string } | { type: "vis"; q: string; on: boolean } | { type: "clear" } | { type: "budget"; bytes: number } | { type: "probe"; id: unknown };
export interface VoxelPickResult { id: number; q: string; layer: string; index: number; cell: [number, number, number]; value: number | null; distance: number; lngLat: [number, number]; properties: Record<string, unknown> & { index: number; cell: [number, number, number]; value: number | null } }
export interface EnuBasis { E: number[]; N: number[]; U: number[]; u: number[] }

// 深度の無い時の代わり（DEPTH_GLSL と同じ名前＝FS は同じ字で書ける）
const DEPTH_STUB = `uniform highp float u_sceneLogCoef; uniform highp float u_sceneDepthOn; highp float sceneDepthAt(highp vec2 uv) { return 1.0; }`;
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
uniform mat4 u_mvp; uniform vec3 u_dims; uniform int u_geo;
out vec3 v_p;
void main() { v_p = u_geo == 0 ? a_pos * u_dims : a_pos; gl_Position = u_mvp * vec4(v_p, 1.0); }`;
const FS = (depthGLSL: string, pick: boolean): string => `#version 300 es
precision highp float; precision highp int; precision highp sampler3D;
${depthGLSL}
uniform mat4 u_mvp; uniform vec3 u_dims; uniform vec3 u_eye; uniform vec2 u_vp;
uniform highp sampler3D u_vol; uniform sampler2D u_cmap;
uniform int u_mode; uniform int u_comps; uniform int u_maxSteps; uniform int u_geo;
uniform float u_thr; uniform float u_step; uniform float u_opacity; uniform float u_occl; uniform float u_lit;
uniform mat3 u_nrm; uniform mat3 u_gradM; uniform vec3 u_light; uniform highp uint u_base;
uniform vec3 u_lo; uniform vec3 u_hi;
uniform vec3 u_o; uniform vec3 u_E; uniform vec3 u_N; uniform vec3 u_U; uniform float u_R; uniform float u_rAx;
uniform vec4 u_geoW; uniform vec2 u_geoH; uniform vec4 u_bs;
uniform mat3 u_cylM; uniform vec4 u_cyl; uniform float u_cylEps;
in vec3 v_p;
out vec4 o;
// 光線の点 → セル座標（box＝そのまま・region＝東北上 m → 単位球 → 経緯度・高さ）
vec3 cellOf(vec3 p) {
	if (u_geo == 0) return p;
	if (u_geo == 2) {   // cylinder＝東北上 m → 局所 m → 半径・角度（始めから反時計回り）・高さ
		vec3 l = u_cylM * p;
		float da = mod(degrees(atan(l.y, l.x)) - u_cyl.z, 360.0);
		return vec3((length(l.xy) - u_cyl.x) / (u_cyl.y - u_cyl.x) * u_dims.x, da / u_cyl.w * u_dims.y, (l.z - u_geoH.x) / (u_geoH.y - u_geoH.x) * u_dims.z);
	}
	vec3 P = u_o + (u_E * p.x + u_N * p.y + u_U * p.z) / u_R;
	float r = length(P);
	float lat = asin(clamp(P.y / r, -1.0, 1.0));
	if (u_rAx != 1.0) lat = atan(tan(lat) / u_rAx);
	float lon = degrees(atan(P.z, P.x));
	float dl = mod(lon - u_geoW.x, 360.0);
	return vec3(dl / u_geoW.z * u_dims.x, (degrees(lat) - u_geoW.y) / u_geoW.w * u_dims.y, ((r - 1.0) * u_R - u_geoH.x) / (u_geoH.y - u_geoH.x) * u_dims.z);
}
bool inRange(vec3 c) { return all(greaterThanEqual(c, u_lo)) && all(lessThan(c, u_hi)); }
// セルの値（R8＝0 は空・1〜255 → 0〜1。RGBA＝そのまま・α 0 は空）
vec4 cellColor(ivec3 c, out bool solid) {
	vec4 s = texelFetch(u_vol, c, 0);
	if (u_comps == 4) { solid = s.a > 0.0; return s; }
	float vn = (s.r * 255.0 - 1.0) / 254.0;
	solid = s.r > 0.0 && vn >= u_thr;
	return texture(u_cmap, vec2(vn, 0.5));
}
// 三線形の値（iso）＝空は −1
float valueAt(vec3 c) {
	vec4 s = texture(u_vol, c / u_dims);
	if (u_comps == 4) return s.a > 0.0 ? s.a : -1.0;
	return s.r > 0.5 / 255.0 ? (s.r * 255.0 - 1.0) / 254.0 : -1.0;
}
// cylinder のセルの軸の向き（nc＝±x 半径・±y 角度・±z 高さ）→ 東北上の法線（局所の法線は u_cylM の転置で）
vec3 cylN(vec3 nc, vec3 p) {
	vec3 l = u_cylM * p; vec2 u = dot(l.xy, l.xy) > 0.0 ? normalize(l.xy) : vec2(1.0, 0.0);
	return normalize(transpose(u_cylM) * (nc.x * vec3(u, 0.0) + nc.y * vec3(-u.y, u.x, 0.0) + vec3(0.0, 0.0, nc.z)));
}
vec4 shade(vec4 col, vec3 ne) { float l = mix(1.0, 0.55 + 0.45 * max(0.0, dot(ne, u_light)), u_lit); float a = u_opacity; return vec4(col.rgb * l * a, a); }
${pick ? `vec4 encode(highp uint id) { return vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float((id >> 24) & 255u)) / 255.0; }
highp uint cellId(ivec3 c) { return u_base + uint(c.x + int(u_dims.x) * (c.y + int(u_dims.y) * c.z)); }` : ""}
void main() {
	vec3 ro = u_eye, rd = normalize(v_p - ro);
	float t0, t1; int axis0 = -1; bool inside = false;
	if (u_geo == 0) {   // 箱 [lo, hi]（セル空間）との交わり
		vec3 inv = 1.0 / rd;
		vec3 ta = (u_lo - ro) * inv, tb = (u_hi - ro) * inv, tmin = min(ta, tb), tmax = max(ta, tb);
		t0 = max(max(tmin.x, tmin.y), tmin.z); t1 = min(min(tmax.x, tmax.y), tmax.z);
		axis0 = t0 == tmin.x ? 0 : t0 == tmin.y ? 1 : 2;
		inside = t0 < 0.0; t0 = max(t0, 0.0);
	} else if (u_geo == 2) {   // cylinder＝箱の裏面まで。入口と出口は外の円柱と上下の面（局所 m・t は東北上 m と同じ）
		t1 = length(v_p - ro);
		vec3 lp = u_cylM * ro, ld = u_cylM * rd;
		float a = dot(ld.xy, ld.xy), b = dot(lp.xy, ld.xy), c = dot(lp.xy, lp.xy) - u_cyl.y * u_cyl.y, ta = -1e30, tb = 1e30;
		if (a > 1e-12) { float disc = b * b - a * c; if (disc < 0.0) discard; float sq = sqrt(disc); ta = (-b - sq) / a; tb = (-b + sq) / a; }
		else if (c > 0.0) discard;
		if (abs(ld.z) > 1e-12) { float za = (u_geoH.x - lp.z) / ld.z, zb = (u_geoH.y - lp.z) / ld.z; ta = max(ta, min(za, zb)); tb = min(tb, max(za, zb)); }
		else if (lp.z < u_geoH.x || lp.z > u_geoH.y) discard;
		t0 = max(ta, 0.0); t1 = min(t1, tb);
	} else {   // 殻の裏面まで。入口は殻を包む球
		t1 = length(v_p - ro);
		vec3 oc = ro - u_bs.xyz; float b = dot(oc, rd), c = dot(oc, oc) - u_bs.w * u_bs.w, disc = b * b - c;
		t0 = disc > 0.0 ? max(0.0, -b - sqrt(disc)) : 0.0;
	}
	// シーンの深度＝光線を w がそこへ届く所で切る（w は光線に沿って線形）
	if (u_occl > 0.5 && u_sceneDepthOn > 0.5) {
		vec2 uv = gl_FragCoord.xy / u_vp;
		float s = sceneDepthAt(uv);
		float ws = s < 1.0 ? exp2(2.0 * s / u_sceneLogCoef) - 1.0 : -1.0;
#ifdef SCENE_GLOBE
		float wg = sceneGlobeW(uv);   // 海面の球（深度に書かれない）＝地球を包む箱は地球の向こうを見せない（Cesium と同じ）
		if (wg > 0.0 && (ws < 0.0 || wg < ws)) ws = wg;
#endif
		if (ws > 0.0) {
			float w0 = dot(vec4(ro, 1.0), vec4(u_mvp[0][3], u_mvp[1][3], u_mvp[2][3], u_mvp[3][3])), dw = dot(rd, vec3(u_mvp[0][3], u_mvp[1][3], u_mvp[2][3]));
			if (dw > 1e-12) t1 = min(t1, (ws - w0) / dw);
		}
	}
	if (t1 <= t0) discard;
	if (u_mode == 0 && u_geo == 0) {   // box の blocks＝DDA
		vec3 p = ro + rd * (t0 + 1e-4);
		ivec3 c = clamp(ivec3(floor(p)), ivec3(floor(u_lo)), ivec3(ceil(u_hi)) - 1);
		ivec3 st = ivec3(sign(rd));
		vec3 inv = 1.0 / rd;
		vec3 tMax = (vec3(c) + vec3(greaterThan(rd, vec3(0.0))) - ro) * inv, tDelta = abs(inv);
		int axis = inside ? -1 : axis0;
		for (int i = 0; i < 1024; i++) {
			if (i >= u_maxSteps) break;
			bool solid; vec4 col = cellColor(c, solid);
			if (solid) {
				${pick ? `o = encode(cellId(c)); return;` : `
				vec3 nc = axis < 0 ? -rd : (axis == 0 ? vec3(-float(st.x), 0.0, 0.0) : axis == 1 ? vec3(0.0, -float(st.y), 0.0) : vec3(0.0, 0.0, -float(st.z)));
				o = shade(col, normalize(u_nrm * nc)); return;`}
			}
			if (tMax.x < tMax.y && tMax.x < tMax.z) { if (tMax.x > t1) break; c.x += st.x; tMax.x += tDelta.x; axis = 0; }
			else if (tMax.y < tMax.z) { if (tMax.y > t1) break; c.y += st.y; tMax.y += tDelta.y; axis = 1; }
			else { if (tMax.z > t1) break; c.z += st.z; tMax.z += tDelta.z; axis = 2; }
			if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, ivec3(u_dims)))) break;
		}
		discard;
	}
	// 一定の刻み（box＝セル・region＝m）。刻みの位相を画素ごとに散らす（縞を消す）
	float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
	float t = t0 + u_step * (0.25 + 0.5 * jit);
	vec4 acc = vec4(0.0);
	ivec3 prevC = ivec3(-1); float prevV = -1.0, prevT = t0; bool havePrev = false;
	for (int i = 0; i < 4096; i++) {
		if (i >= u_maxSteps || t >= t1) break;
		vec3 p = ro + rd * t, c = cellOf(p);
		if (inRange(c)) {
			if (u_mode == 0) {   // region の blocks＝最近傍
				ivec3 ci = ivec3(floor(c)); bool solid; vec4 col = cellColor(ci, solid);
				if (solid) {
					${pick ? `o = encode(cellId(ci)); return;` : `
					vec3 nc = vec3(0.0);
					if (havePrev) { ivec3 d = ci - prevC; nc = d.x != 0 ? vec3(-float(sign(d.x)), 0.0, 0.0) : d.y != 0 ? vec3(0.0, -float(sign(d.y)), 0.0) : d.z != 0 ? vec3(0.0, 0.0, -float(sign(d.z))) : vec3(0.0); }
					o = shade(col, nc == vec3(0.0) ? -rd : u_geo == 2 ? cylN(nc, p) : normalize(u_nrm * nc)); return;`}
				}
				prevC = ci; havePrev = true;
			} else if (u_mode == 1) {   // volume
				vec4 s = texture(u_vol, c / u_dims);
				vec4 col; float a;
				if (u_comps == 4) { col = s; a = s.a; }
				else { float vn = (s.r * 255.0 - 1.0) / 254.0; if (s.r > 0.5 / 255.0 && vn >= u_thr) { col = texture(u_cmap, vec2(max(vn, 0.0), 0.5)); a = col.a; } else { col = vec4(0.0); a = 0.0; } }
				if (a > 0.0) {
					a = 1.0 - pow(1.0 - min(a * u_opacity, 0.999), u_geo == 0 ? u_step : 1.0);
					acc.rgb += (1.0 - acc.a) * col.rgb * a; acc.a += (1.0 - acc.a) * a;
					${pick ? `if (acc.a >= 0.5) { o = encode(cellId(clamp(ivec3(floor(c)), ivec3(0), ivec3(u_dims) - 1))); return; }` : `if (acc.a > 0.98) break;`}
				}
			} else {   // iso＝閾を跨いだら二分探索
				float v = valueAt(c);
				if (havePrev && (prevV - u_thr) * (v - u_thr) < 0.0) {
					float a = prevT, b = t, va = prevV;
					for (int k = 0; k < 6; k++) { float m = 0.5 * (a + b); float vm = valueAt(cellOf(ro + rd * m)); if ((vm - u_thr) * (va - u_thr) < 0.0) b = m; else { a = m; va = vm; } }
					vec3 ch = cellOf(ro + rd * b);
					${pick ? `o = encode(cellId(clamp(ivec3(floor(ch)), ivec3(0), ivec3(u_dims) - 1))); return;` : `
					vec3 ne;
					if (u_geo == 2) {   // cylinder＝東北上 m で差分（セルの軸が場所ごとに回る）
						vec3 ph = ro + rd * b; float e = u_cylEps;
						ne = vec3(valueAt(cellOf(ph + vec3(e, 0.0, 0.0))) - valueAt(cellOf(ph - vec3(e, 0.0, 0.0))), valueAt(cellOf(ph + vec3(0.0, e, 0.0))) - valueAt(cellOf(ph - vec3(0.0, e, 0.0))), valueAt(cellOf(ph + vec3(0.0, 0.0, e))) - valueAt(cellOf(ph - vec3(0.0, 0.0, e))));
					} else {
						vec3 g = vec3(valueAt(ch + vec3(0.5, 0.0, 0.0)) - valueAt(ch - vec3(0.5, 0.0, 0.0)), valueAt(ch + vec3(0.0, 0.5, 0.0)) - valueAt(ch - vec3(0.0, 0.5, 0.0)), valueAt(ch + vec3(0.0, 0.0, 0.5)) - valueAt(ch - vec3(0.0, 0.0, 0.5)));
						ne = u_gradM * g;
					}
					ne = dot(ne, ne) > 1e-12 ? normalize(ne) : -rd;
					if (dot(ne, u_geo == 2 ? rd : u_nrm * rd) > 0.0) ne = -ne;   // 見ている側へ
					vec4 col = u_comps == 4 ? texture(u_vol, ch / u_dims) : texture(u_cmap, vec2(u_thr, 0.5));
					o = shade(col, ne); return;`}
				}
				prevV = v; prevT = t; havePrev = true;
			}
		} else havePrev = false;
		t += u_step;
	}
	${pick ? `discard;` : `if (u_mode != 1 || acc.a < 1.0 / 255.0) discard; o = acc;`}
}`;
interface Layer {
	shape: "box" | "region" | "cylinder"; dims: [number, number, number]; comps: 1 | 4; n: number; anchor: [number, number, number]; alt: VoxelAltitude; A: Float64Array; Ainv: Float64Array; radius: number;
	mode: 0 | 1 | 2; thr: number; step: number; opacity: number; occl: boolean; lit: boolean; clip: Clip | null; properties: Record<string, unknown> | null; range: [number, number];
	tex: WebGLTexture; cmap: WebGLTexture; on: boolean; base: number; dist: number; nrm: Float32Array; gradM: Float32Array;
	geo: GeoGrid | null; vao: WebGLVertexArrayObject | null; vb: WebGLBuffer | null; nVerts: number;
	layer: string | null; off: [number, number, number] | null; own: [number, number, number, number, number, number] | null; full: [number, number, number] | null; vmax: number;
	/** 見せているこま・段（levels の番号）・その段の倍率・段（0＝元の格子）・元のセルの大きさ（m・遠さの尺）・元の格子の dims（当たりと断面） */ frame: number; lv: number; s: number; levels: Lvl[]; cell: number; fullFine: [number, number, number];
}
/** 一つの段＝置き方と CPU の値（こまごと）と、GPU に上げた一枚（無ければ null・up＝上げたこま） */
interface Lvl {
	s: number; dims: [number, number, number]; off: [number, number, number] | null; own: [number, number, number, number, number, number] | null; anchor: [number, number, number]; A: Float64Array; Ainv: Float64Array; radius: number;
	nrm: Float32Array; gradM: Float32Array; geo: GeoGrid | null; vao: WebGLVertexArrayObject | null; vb: WebGLBuffer | null; nVerts: number; frames: Uint8Array[]; tex: WebGLTexture | null; up: number; bytes: number;
}
let budget = Infinity, glc: GL | null = null, host: OverlayHost | null = null, prog: Program | null = null, pickProg: Program | null = null, boxVao: WebGLVertexArrayObject | null = null, wantDepth = false, dummyTex: WebGLTexture | null = null, max3d = 256;
let pickFbo: WebGLFramebuffer | null = null, pickTex: WebGLTexture | null = null, pickW = 0, pickH = 0;
const layers = new Map<string, Layer>(), probes: unknown[] = [];
const R_SPHERE = 6371000, R_ELL = 6378137, D2R = Math.PI / 180;
const LIGHT = ((): number[] => { const v = [-0.35, 0.45, 0.82], l = Math.hypot(...v); return v.map(x => x / l); })();   // 東北上＝北西の上から
function compile(vs: string, fs: string): Program {
	const gl = glc!;
	const mk = (type: number, src: string): WebGLShader => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(s))); return s; };
	const p = gl.createProgram()!; gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)));
	const u: Record<string, WebGLUniformLocation | null> = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number; i < n; i++) { const nm = gl.getActiveUniform(p, i)!.name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
// 単位立方体の 12 枚の三角形（外向きの CCW）＝cullFace(FRONT) で裏面だけ描く
export const BOX = ((): Float32Array => {
	const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];   // -z +z -x +x +y -y（各面を外から見て CCW）
	const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
	const out: number[] = [];
	for (const [a, b, c, d] of f) for (const i of [a, c, b, a, d, c]) out.push(...v[i]);
	return new Float32Array(out);
})();
export function init(canvas: OffscreenCanvas, opts: { depth?: boolean } = {}, h: OverlayHost | null = null): { depth: true } | undefined {
	host = h;
	layers.clear(); probes.length = 0; pickFbo = null; pickTex = null; pickW = 0; pickH = 0; dummyTex = null;   // 同じ名前で立て直したオーバーレイ＝モジュールの実体は使い回し（前の文脈の物は捨てる）
	const gl = glc = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (voxel overlay)");
	wantDepth = opts.depth !== false && !!h?.depthGLSL;
	const dg = wantDepth && h?.depthGLSL ? h.depthGLSL : DEPTH_STUB;
	prog = compile(VS, FS(dg, false));
	try { pickProg = compile(VS, FS(dg, true)); } catch (e) { pickProg = null; console.warn("[voxel] pick pass unavailable", (e as { message?: string } | null)?.message); }
	max3d = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number || 256;
	boxVao = gl.createVertexArray(); gl.bindVertexArray(boxVao);
	const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, BOX, gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	return wantDepth ? { depth: true } : undefined;
}
const unit = (lon: number, lat: number, rAx: number): number[] => { const a = lon * D2R; let b = lat * D2R; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
/** 錨の東北上 m → 単位球（列＝東・北・上×1/R） */
export function enuBasis(lon: number, lat: number, rAx = 1): EnuBasis {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	return { E: E.map(v => v * k), N: N.map(v => v * k), U: u.map(v => v * k), u };
}
function inv3(m: ArrayLike<number>): Float64Array {
	const [a, b, c, d, e, f, g, h, i] = Array.from(m, Number);
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C, k = 1 / det;
	return Float64Array.from([A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k]);
}
/** 法線の行列（セルの軸 → 東北上の単位ベクトル・列優先）と勾配の行列（A⁻ᵀ・列優先） */
export function normalMats(A: Float64Array, Ainv: Float64Array): { nrm: Float32Array; gradM: Float32Array } {
	const nrm = new Float32Array(9), gradM = new Float32Array(9);
	for (let c = 0; c < 3; c++) { const l = Math.hypot(A[c], A[3 + c], A[6 + c]) || 1; nrm[c * 3] = A[c] / l; nrm[c * 3 + 1] = A[3 + c] / l; nrm[c * 3 + 2] = A[6 + c] / l; }
	for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) gradM[c * 3 + r] = Ainv[c * 3 + r];   // A⁻ᵀ の列 c＝A⁻¹ の行 c
	return { nrm, gradM };
}
const upCmap = (t: WebGLTexture, cmap: Uint8Array): void => { const gl = glc!; gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, cmap); gl.bindTexture(gl.TEXTURE_2D, null); };
/** 元のセルの大きさ（m）＝box は A の列の短い方・region／cylinder は cellM の短い方 */
export const cellOf = (A: ArrayLike<number>, geo: GeoGrid | null): number => geo ? Math.min(...geo.cellM) : Math.min(...[0, 1, 2].map(c => Math.hypot(A[c], A[3 + c], A[6 + c])));
function mkLvl(b: LevelBody, comps: 1 | 4, region: boolean, single: boolean): Lvl {
	const gl = glc!, [nx, ny, nz] = b.dims;
	if (nx > max3d || ny > max3d || nz > max3d) throw new Error(`voxel: dims ${b.dims.join("×")} exceed MAX_3D_TEXTURE_SIZE ${max3d}`);
	const A = Float64Array.from(b.A as ArrayLike<number>), Ainv = inv3(A), { nrm, gradM } = normalMats(A, Ainv);
	let vao: WebGLVertexArrayObject | null = null, vb: WebGLBuffer | null = null, nVerts = 36;
	const geo = region ? b.geo ?? null : null;
	if (geo) {   // region＝殻（東北上 m）
		vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, geo.shell, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null); nVerts = geo.shell.length / 3;
	}
	const frames = b.frames?.length ? b.frames : [b.tex];
	return { s: b.s, dims: [nx, ny, nz], off: single ? null : b.off, own: single ? null : b.own, anchor: b.anchor, A, Ainv, radius: b.radius || 0, nrm, gradM, geo, vao, vb, nVerts, frames, tex: null, up: -1, bytes: nx * ny * nz * comps };
}
/** 段 i を層の「いま」にする（置き方・範囲・殻） */
function useLevel(L: Layer, i: number): void {
	const V = L.levels[i]; L.lv = i; L.s = V.s;
	L.dims = V.dims; L.off = V.off; L.own = V.own; L.anchor = V.anchor; L.A = V.A; L.Ainv = V.Ainv; L.radius = V.radius; L.nrm = V.nrm; L.gradM = V.gradM; L.geo = V.geo; L.vao = V.vao; L.vb = V.vb; L.nVerts = V.nVerts;
	L.full = V.off ? L.fullFine : null;
}
/** いまの段の、見せるこまを GPU に（無ければ作る・こまが違えば上げ直す） */
function ensure(L: Layer): void {
	const gl = glc!, V = L.levels[L.lv], f = Math.min(V.frames.length - 1, Math.max(0, L.frame)), [nx, ny, nz] = V.dims, data = V.frames[f];
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	if (!V.tex) {
		V.tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_3D, V.tex);
		if (L.comps === 4) gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, nx, ny, nz, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		else gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, nx, ny, nz, 0, gl.RED, gl.UNSIGNED_BYTE, data);
		for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
		gl.bindTexture(gl.TEXTURE_3D, null); V.up = f;
	} else if (V.up !== f) {
		gl.bindTexture(gl.TEXTURE_3D, V.tex);
		gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, nx, ny, nz, L.comps === 4 ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, data);
		gl.bindTexture(gl.TEXTURE_3D, null); V.up = f;
	}
	L.tex = V.tex;
}
const freeTex = (V: Lvl): void => { if (V.tex) { glc!.deleteTexture(V.tex); V.tex = null; V.up = -1; } };
function build(d: VoxelLayerBody): Layer {
	const gl = glc!, region = d.shape !== "box", single = !d.off;   // region・cylinder＝殻（geo）
	const levels = [mkLvl({ s: 1, off: d.off ?? [0, 0, 0], own: d.own ?? [0, 0, 0, ...d.dims], dims: d.dims, tex: d.tex, frames: d.frames ?? null, vmax: d.vmax ?? 255, anchor: d.anchor, A: d.A as Float64Array, radius: d.radius, geo: d.geo ?? null }, d.comps, region, single), ...(d.lods ?? []).map(b => mkLvl(b, d.comps, region, false))];
	const cmap = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, cmap);
	for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
	upCmap(cmap, d.cmap);
	const V = levels[0], fullFine = d.full ?? d.dims;
	const L: Layer = { shape: d.shape, dims: V.dims, comps: d.comps, n: V.dims[0] * V.dims[1] * V.dims[2], anchor: V.anchor, alt: d.alt || "relative", A: V.A, Ainv: V.Ainv, radius: V.radius, mode: d.mode, thr: d.thr || 0, step: d.step || 0.5, opacity: d.opacity ?? 1, occl: d.depthTest !== false, lit: d.lighting !== false, clip: d.clip ?? null, properties: d.properties ?? null, range: d.range,
		tex: null as unknown as WebGLTexture, cmap, on: d.on !== false, base: 0, dist: 0, nrm: V.nrm, gradM: V.gradM, geo: V.geo, vao: V.vao, vb: V.vb, nVerts: V.nVerts, layer: d.layer ?? null, off: V.off, own: V.own, full: d.full ?? null, vmax: d.vmax ?? 255,
		frame: Math.max(0, d.frame ?? 0), lv: 0, s: 1, levels, cell: cellOf(V.A, V.geo), fullFine: [fullFine[0], fullFine[1], fullFine[2]] };
	useLevel(L, 0);
	return L;
}
const drop = (L: Layer | undefined): void => { if (!L) return; const gl = glc!; for (const V of L.levels) { freeTex(V); if (V.vb) gl.deleteBuffer(V.vb); if (V.vao) gl.deleteVertexArray(V.vao); } gl.deleteTexture(L.cmap); };
/** LoD の割り振り（第 5 段 ③）＝予算（bytes）に収まる中で一番細かく。遠い（元のセルが小さく見える）層から粗く：
 *  lv_i = clamp(floor(x + log2(dist_i / cell_i)), 0, 段の数 − 1) の x を二分で（x が大きいほど粗い・合計は x に単調）。一番粗くしても越えるなら全部一番粗く */
export function planLevels(items: ReadonlyArray<{ dist: number; cell: number; bytes: readonly number[] }>, budget: number): number[] {
	if (!items.length) return [];
	const g = items.map(it => Math.log2(Math.max(1e-9, it.dist) / Math.max(1e-9, it.cell)));
	const at = (x: number): number[] => items.map((it, i) => Math.min(it.bytes.length - 1, Math.max(0, Math.floor(x + g[i]))));
	const total = (lv: number[]): number => lv.reduce((a, l, i) => a + items[i].bytes[l], 0);
	let lo = -Math.max(...g) - 1, hi = -Math.min(...g) + 9;   // lo＝全部 0・hi＝全部一番粗い
	const fine = at(lo); if (total(fine) <= budget) return fine;
	const coarse = at(hi); if (total(coarse) > budget) return coarse;
	for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (total(at(m)) <= budget) hi = m; else lo = m; }
	return at(hi);
}
/** 描く層の段を決めてテクスチャを揃え、予算を越えれば描かない層のテクスチャを捨てる */
function settle(vis: Layer[]): void {
	const lv = planLevels(vis.map(L => ({ dist: L.dist, cell: L.cell, bytes: L.levels.map(V => V.bytes) })), budget);
	vis.forEach((L, i) => { if (L.lv !== lv[i]) useLevel(L, lv[i]); L.levels.forEach((V, k) => { if (k !== L.lv) freeTex(V); }); ensure(L); });
	let used = 0; for (const L of layers.values()) for (const V of L.levels) if (V.tex) used += V.bytes;
	if (used <= budget) return;
	const on = new Set(vis);
	for (const L of layers.values()) { if (on.has(L)) continue; for (const V of L.levels) if (V.tex) { used -= V.bytes; freeTex(V); } if (used <= budget) return; }
}
function rebase(): void { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
export function message(d: VoxelMessage): void {
	if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (d.type === "budget" && !glc) { budget = d.bytes > 0 ? d.bytes : Infinity; return; }
	if (!glc) return;
	if (d.type === "layer") {
		drop(layers.get(d.q)); layers.delete(d.q);
		try { layers.set(d.q, build(d)); } catch (e) { host?.post?.({ type: "error", q: d.q, error: String((e as { message?: string } | null)?.message || e) }); }
		rebase(); host?.requestDraw?.();
	}
	else if (d.type === "style") {
		const L = layers.get(d.q); if (!L) return;
		if (d.frame != null) L.frame = Math.max(0, d.frame);   // 次に描く時に上げ直す（ensure）
		if (d.mode != null) L.mode = d.mode; if (d.thr != null) L.thr = d.thr; if (d.step != null) L.step = d.step; if (d.opacity != null) L.opacity = d.opacity;
		if (d.clip !== undefined) L.clip = d.clip ?? null; if (d.depthTest != null) L.occl = d.depthTest; if (d.lighting != null) L.lit = d.lighting; if (d.properties !== undefined) L.properties = d.properties ?? null;
		if (d.cmap) upCmap(L.cmap, d.cmap);
		host?.requestDraw?.();
	}
	else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); host?.requestDraw?.(); }
	else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; host?.requestDraw?.(); }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); host?.requestDraw?.(); }
	else if (d.type === "budget") { budget = d.bytes > 0 ? d.bytes : Infinity; host?.requestDraw?.(); }
}
// 層の mvp（box＝セル空間 → clip＝mvp × [E N U o] × A・region＝東北上 m → clip）と、目の位置（同じ空間）。倍精度で掛けてから f32
const mvpL = new Float64Array(16), mvpC = new Float32Array(16), eyeC = new Float32Array(3), geoU = { o: new Float32Array(3), E: new Float32Array(3), N: new Float32Array(3), U: new Float32Array(3), R: 0, rAx: 1 };
function place(L: Layer, s: CamState, api: VoxelApi | null | undefined): boolean {
	const rAx = api?.rAx || 1, [lon, lat, alt] = L.anchor, B = enuBasis(lon, lat, rAx), R = rAx === 1 ? R_SPHERE : R_ELL, k = 1 / R;
	const ls = L.alt !== "absolute" ? (api?.liftScale || 0) : 0, r = 1 + (ls > 0 ? (api!.elevM(lon, lat) || 0) * ls : 0) + (alt || 0) * k;
	const o = [B.u[0] * r, B.u[1] * r, B.u[2] * r], M = s.mvp, cols = [B.E, B.N, B.U];
	for (let j = 0; j < 3; j++) for (let row = 0; row < 4; row++) mvpL[j * 4 + row] = M[row] * cols[j][0] + M[4 + row] * cols[j][1] + M[8 + row] * cols[j][2];
	for (let row = 0; row < 4; row++) mvpL[12 + row] = M[row] * o[0] + M[4 + row] * o[1] + M[8 + row] * o[2] + M[12 + row];
	const E = s.eye;
	if (!E) return false;
	const d = [E[0] - o[0], E[1] - o[1], E[2] - o[2]], enu = [0, 0, 0];
	for (let j = 0; j < 3; j++) enu[j] = (d[0] * cols[j][0] + d[1] * cols[j][1] + d[2] * cols[j][2]) * R * R;   // 列は 1/R 倍の単位ベクトル＝内積 ×R で単位球の長さ・×R で m
	if (L.geo) {   // region＝東北上 m のまま
		for (let i = 0; i < 16; i++) mvpC[i] = mvpL[i];
		for (let i = 0; i < 3; i++) { eyeC[i] = enu[i]; geoU.o[i] = o[i]; geoU.E[i] = cols[0][i] * R; geoU.N[i] = cols[1][i] * R; geoU.U[i] = cols[2][i] * R; }
		geoU.R = R; geoU.rAx = rAx;
	} else {   // box＝× A（セル → 東北上 m・行優先）＝列 c の clip ベクトル＝Σ_j mvpL 列 j × A[j][c]
		const A = L.A;
		for (let c = 0; c < 3; c++) for (let row = 0; row < 4; row++) mvpC[c * 4 + row] = mvpL[row] * A[c] + mvpL[4 + row] * A[3 + c] + mvpL[8 + row] * A[6 + c];
		for (let row = 0; row < 4; row++) mvpC[12 + row] = mvpL[12 + row];
		const Ai = L.Ainv, off = L.off;
		for (let i = 0; i < 3; i++) eyeC[i] = Ai[i * 3] * enu[0] + Ai[i * 3 + 1] * enu[1] + Ai[i * 3 + 2] * enu[2];
		if (off) for (let row = 0; row < 4; row++) mvpC[12 + row] += mvpC[row] * off[0] + mvpC[4 + row] * off[1] + mvpC[8 + row] * off[2];   // ブリック＝セルを off だけずらす（A·off）
		if (off) for (let i = 0; i < 3; i++) eyeC[i] -= off[i];
	}
	L.dist = centerDist(L, enu);
	const rr = L.radius * k;   // 地平線の向こう（錨の半径ぶんの余裕）
	const behind = o[0] * d[0] + o[1] * d[1] + o[2] * d[2] < -rr * Math.hypot(...o) - 1e-9;
	return !behind;
}
function bindDepth(P: Program, api: VoxelApi | null | undefined): void {
	const gl = glc!;
	if (!wantDepth) return;
	if (api?.depth) { api.depth.bind(gl, P.p, 3); return; }
	if (P.u.u_sceneDepthOn) gl.uniform1f(P.u.u_sceneDepthOn, 0);
	if (P.u.u_sceneDepth) { if (!dummyTex) { dummyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); gl.bindTexture(gl.TEXTURE_2D, null); } gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(P.u.u_sceneDepth, 3); }
}
/** 刻み（box＝セル・region＝m）と最大の歩数（光線の空間で） */
export function stepsOf(L: { shape: "box" | "region" | "cylinder"; dims: [number, number, number]; mode: number; step: number; geo: GeoGrid | null }): { step: number; maxSteps: number } {
	if (L.geo) { const cm = Math.min(...L.geo.cellM), step = (L.mode === 0 ? Math.min(L.step, 0.25) : L.step) * cm; return { step, maxSteps: Math.min(4096, Math.ceil(2 * L.geo.bs[3] / step) + 2) }; }
	if (L.mode === 0) return { step: L.step, maxSteps: L.dims[0] + L.dims[1] + L.dims[2] + 2 };
	return { step: L.step, maxSteps: Math.min(4096, Math.ceil(Math.hypot(L.dims[0], L.dims[1], L.dims[2]) / L.step) + 2) };
}
/** 断面 → セル空間の範囲 */
export const clipBounds = (dims: [number, number, number], clip: Clip | null): { lo: number[]; hi: number[] } => ({ lo: [0, 1, 2].map(i => (clip ? clip[i * 2] : 0) * dims[i]), hi: [0, 1, 2].map(i => (clip ? clip[i * 2 + 1] : 1) * dims[i]) });
type BrickLike = { dims: [number, number, number]; clip: Clip | null; off: [number, number, number] | null; own: [number, number, number, number, number, number] | null; full: [number, number, number] | null; s?: number };
/** 描く範囲（テクスチャのセル座標）＝断面（親の割合）と持ち分の交わり。空なら null（そのブリックは描かない）。粗い段（s）は親もその段のセルで測る */
export function drawBounds(L: BrickLike): { lo: number[]; hi: number[] } | null {
	if (!L.full || !L.off || !L.own) return clipBounds(L.dims, L.clip);
	const s = L.s ?? 1, c = clipBounds([L.full[0] / s, L.full[1] / s, L.full[2] / s], L.clip), lo = [0, 1, 2].map(i => Math.max(L.own![i], c.lo[i] - L.off![i])), hi = [0, 1, 2].map(i => Math.min(L.own![3 + i], c.hi[i] - L.off![i]));
	return lo.every((v, i) => v < hi[i]) ? { lo, hi } : null;
}
/** 閾より下しか無い層（ブリック）＝描かない（vmax＝R8 の 0〜255。RGBA は α 0 の時だけ） */
export const isEmpty = (L: { vmax: number; thr: number; comps: 1 | 4 }): boolean => L.vmax === 0 || (L.comps === 1 && (L.vmax - 1) / 254 < L.thr);
/** 目（東北上 m）から層の中心まで＝奥から描く順（同じ大きさの箱が並ぶブリックは中心の遠い順で正しく重なる） */
export function centerDist(L: { dims: [number, number, number]; A: ArrayLike<number>; off: [number, number, number] | null; geo: GeoGrid | null }, enu: number[]): number {
	let c: number[];
	if (L.geo) c = [L.geo.bs[0], L.geo.bs[1], L.geo.bs[2]];
	else { const o = L.off ?? [0, 0, 0], m = [0, 1, 2].map(i => o[i] + L.dims[i] / 2), A = L.A; c = [0, 1, 2].map(r => A[r * 3] * m[0] + A[r * 3 + 1] * m[1] + A[r * 3 + 2] * m[2]); }
	return Math.hypot(enu[0] - c[0], enu[1] - c[1], enu[2] - c[2]);
}
/** 当たり（層の中の番号）→ 親の層の id・番号・セル（ブリックは off と full で戻す・粗い段は元のセルの真ん中へ） */
export function pickedCell(q: string, L: { layer: string | null; dims: [number, number, number]; off: [number, number, number] | null; full: [number, number, number] | null; s?: number }, index: number): { layer: string; index: number; cell: [number, number, number] } {
	const [nx, ny] = L.dims, i = index % nx, j = Math.floor(index / nx) % ny, k = Math.floor(index / (nx * ny));
	if (!L.off || !L.full) return { layer: L.layer ?? q, index, cell: [i, j, k] };
	const s = L.s ?? 1, f = (v: number, a: number): number => s === 1 ? v : Math.min(L.full![a] - 1, Math.floor((v + 0.5) * s));
	const cell: [number, number, number] = [f(i + L.off[0], 0), f(j + L.off[1], 1), f(k + L.off[2], 2)];
	return { layer: L.layer ?? q, index: cell[0] + L.full[0] * (cell[1] + L.full[1] * cell[2]), cell };
}
function drawAll(pick: boolean, s: CamState, api: VoxelApi | null | undefined, w: number, h: number): void {
	const gl = glc!;
	const P = (pick ? pickProg : prog)!;
	gl.disable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
	if (pick) gl.disable(gl.BLEND); else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
	gl.useProgram(P.p); bindDepth(P, api);
	gl.uniform2f(P.u.u_vp, w, h); gl.uniform1i(P.u.u_vol, 0); gl.uniform1i(P.u.u_cmap, 1); gl.uniform3f(P.u.u_light, LIGHT[0], LIGHT[1], LIGHT[2]);
	const vis: Layer[] = [];
	for (const L of layers.values()) if (L.on && L.n && !isEmpty(L) && drawBounds(L) && place(L, s, api)) vis.push(L);
	settle(vis);
	vis.sort((a, b) => b.dist - a.dist);   // 層は奥から
	for (const L of vis) {
		place(L, s, api);
		const { step, maxSteps } = stepsOf(L), { lo, hi } = drawBounds(L)!;
		gl.uniformMatrix4fv(P.u.u_mvp, false, mvpC); gl.uniform3f(P.u.u_dims, L.dims[0], L.dims[1], L.dims[2]); gl.uniform3fv(P.u.u_eye, eyeC);
		gl.uniformMatrix3fv(P.u.u_nrm, false, L.nrm); gl.uniformMatrix3fv(P.u.u_gradM, false, L.gradM);
		gl.uniform1i(P.u.u_mode, L.mode); gl.uniform1i(P.u.u_comps, L.comps); gl.uniform1i(P.u.u_geo, L.geo ? (L.geo.cyl ? 2 : 1) : 0); gl.uniform1i(P.u.u_maxSteps, maxSteps);
		gl.uniform1f(P.u.u_thr, L.thr); gl.uniform1f(P.u.u_step, step); gl.uniform1f(P.u.u_opacity, L.opacity); gl.uniform1f(P.u.u_occl, L.occl ? 1 : 0); gl.uniform1f(P.u.u_lit, L.lit ? 1 : 0);
		gl.uniform3f(P.u.u_lo, lo[0], lo[1], lo[2]); gl.uniform3f(P.u.u_hi, hi[0], hi[1], hi[2]);
		gl.uniform1ui(P.u.u_base, L.base);
		if (L.geo) {
			gl.uniform3fv(P.u.u_o, geoU.o); gl.uniform3fv(P.u.u_E, geoU.E); gl.uniform3fv(P.u.u_N, geoU.N); gl.uniform3fv(P.u.u_U, geoU.U); gl.uniform1f(P.u.u_R, geoU.R); gl.uniform1f(P.u.u_rAx, geoU.rAx);
			gl.uniform4f(P.u.u_geoW, L.geo.west, L.geo.south, L.geo.spanLon, L.geo.spanLat); gl.uniform2f(P.u.u_geoH, L.geo.h0, L.geo.h1); gl.uniform4f(P.u.u_bs, L.geo.bs[0], L.geo.bs[1], L.geo.bs[2], L.geo.bs[3]);
			const c = L.geo.cyl;
			if (c) { gl.uniformMatrix3fv(P.u.u_cylM, false, colMajor(c.inv)); gl.uniform4f(P.u.u_cyl, c.r0, c.r1, c.a0, c.span); gl.uniform1f(P.u.u_cylEps, 0.5 * Math.min(...L.geo.cellM)); }
		}
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, L.tex);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, L.cmap);
		gl.bindVertexArray(L.vao ?? boxVao); gl.drawArrays(gl.TRIANGLES, 0, L.nVerts);
	}
	gl.activeTexture(gl.TEXTURE0); gl.bindVertexArray(null); gl.disable(gl.CULL_FACE);
}
function answerProbes(w: number, h: number): void {
	if (!probes.length) return;
	const gl = glc!;
	const ids = probes.splice(0);
	const ls = [...layers].map(([q, L]) => ({ q, on: L.on, n: L.n, dims: L.dims, mode: L.mode, shape: L.shape, dist: +L.dist.toFixed(4), anchor: L.anchor, alt: L.alt, lv: L.lv, s: L.s, gpu: L.levels.reduce((a, V) => a + (V.tex ? V.bytes : 0), 0) }));
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, layers: ls, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as { message?: string } | null)?.message || e) }); }
}
export function frame(cam: unknown, s: CamState, { w, h }: { w: number; h: number }, api: VoxelApi): boolean {
	const gl = glc;
	if (!gl) return false;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (layers.size) drawAll(false, s, api, w, h);
	answerProbes(w, h);
	return false;
}
const decodeId = (r: number, g: number, b: number, a: number): number => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
/** 行優先 3×3 → 列優先（uniformMatrix3fv） */
export const colMajor = (m: ArrayLike<number>): Float32Array => Float32Array.of(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]);
/** cylinder のセルの中心 → 錨からの東北上 m */
export function cylCellEnu(c: CylGrid, dims: [number, number, number], cc: number[]): number[] {
	const r = c.r0 + (c.r1 - c.r0) * cc[0] / dims[0], g = (c.a0 + c.span * cc[1] / dims[1]) * D2R, l = [r * Math.cos(g), r * Math.sin(g), c.z0 + (c.z1 - c.z0) * cc[2] / dims[2]], F = c.F;
	return [F[0] * l[0] + F[1] * l[1] + F[2] * l[2], F[3] * l[0] + F[4] * l[1] + F[5] * l[2], F[6] * l[0] + F[7] * l[1] + F[8] * l[2]];
}
/** 当たりの番号 → セル・経緯度（セルの中心＝box は A で・region は経緯度の枠で・cylinder は扇形の局所で） */
export function hitOf(L: { dims: [number, number, number]; A: Float64Array; anchor: [number, number, number]; geo: GeoGrid | null; properties: Record<string, unknown> | null; off?: [number, number, number] | null }, index: number): { cell: [number, number, number]; lngLat: [number, number] } {
	const [nx, ny] = L.dims, i = index % nx, j = Math.floor(index / nx) % ny, k = Math.floor(index / (nx * ny)), cc = [i + 0.5, j + 0.5, k + 0.5];
	if (L.geo?.cyl) { const [e, nn] = cylCellEnu(L.geo.cyl, L.dims, cc), a = L.anchor; return { cell: [i, j, k], lngLat: [a[0] + e / (Math.cos(a[1] * D2R) * D2R * R_SPHERE), a[1] + nn / (D2R * R_SPHERE)] }; }
	if (L.geo) return { cell: [i, j, k], lngLat: [((L.geo.west + L.geo.spanLon * cc[0] / nx + 180) % 360 + 360) % 360 - 180, L.geo.south + L.geo.spanLat * cc[1] / ny] };
	if (L.off) for (let a = 0; a < 3; a++) cc[a] += L.off[a];   // ブリック＝親のセル座標へ
	const A = L.A, e = A[0] * cc[0] + A[1] * cc[1] + A[2] * cc[2], nn = A[3] * cc[0] + A[4] * cc[1] + A[5] * cc[2], a = L.anchor;
	return { cell: [i, j, k], lngLat: [a[0] + e / (Math.cos(a[1] * D2R) * D2R * R_SPHERE), a[1] + nn / (D2R * R_SPHERE)] };
}
export function pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): VoxelPickResult | null {
	const gl = glc;
	if (!gl || !pickProg || !layers.size || !ctx?.s) return null;
	const { w, h } = ctx.size;
	if (pickW !== w || pickH !== h || !pickFbo) {
		if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo);
		pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h); gl.bindTexture(gl.TEXTURE_2D, null);
		pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
		pickW = w; pickH = h;
	} else gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
	const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;
	const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
	gl.viewport(0, 0, w, h);
	gl.enable(gl.SCISSOR_TEST); gl.scissor(cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0));   // 光線を辿るのは読む画素だけ（全画面の当たりパスは SwiftShader で秒単位）
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (cx1 > cx0 && cy1 > cy0) drawAll(true, ctx.s, ctx.api, w, h);
	gl.disable(gl.SCISSOR_TEST);
	let best: { id: number; distance: number } | null = null;
	if (cx1 > cx0 && cy1 > cy0) {
		const sub = new Uint8Array((cx1 - cx0) * (cy1 - cy0) * 4);
		gl.readPixels(cx0, cy0, cx1 - cx0, cy1 - cy0, gl.RGBA, gl.UNSIGNED_BYTE, sub);
		for (let j = 0; j < cy1 - cy0; j++) for (let i = 0; i < cx1 - cx0; i++) {
			const k = (j * (cx1 - cx0) + i) * 4, id = decodeId(sub[k], sub[k + 1], sub[k + 2], sub[k + 3]); if (!id) continue;
			const dd = Math.hypot(cx0 + i - (x0 + rr), cy0 + j - (y0 + rr));
			if (!best || dd < best.distance) best = { id, distance: dd };
		}
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	if (!best) return null;
	for (const [q, L] of layers) if (best.id >= L.base && best.id < L.base + L.n) {
		const { lngLat } = hitOf(L, best.id - L.base), { layer, index, cell } = pickedCell(q, L, best.id - L.base);
		return { id: best.id, q, layer, index, cell, value: null, distance: best.distance, lngLat, properties: { ...(L.properties || {}), index, cell, value: null } };
	}
	return null;
}
export function destroy(): void { layers.forEach(drop); layers.clear(); glc = null; }
