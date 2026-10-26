// CZML・GPX の時刻付きの位置を共通の時計で描く（#113 段 3・2026-09-29）＝render worker の組み込みオーバーレイ（renderworker.js の BUILTIN_OVERLAYS）。
// 地球・注記と同じフレーム・同じ cam で WebGL2 に描く（2026-10-22・旧＝canvas2D）。位置（ECEF→画面）と隠れは CPU、描くのは GPU の画面の図形：
//   尾＝線分ごとの四角（端は butt・継ぎは丸＝線分の距離場）。継ぎ目の重なりは覆い率の和集合（不透明の色で混ぜる）。半透明の尾は別の窓へ不透明で描いてから
//   色の不透明度で重ねる（同じ尾の重なりを二度塗りしない＝canvas2D の stroke 1 回と同じ）／点＝丸（縁つき）／
//   billboard と札＝アトラス（2048² の前乗算 RGBA・棚詰め）に焼いた絵の四角。札の字は canvas2D で一度だけ焼く（字を焼くだけ＝テキスト GPU 化の §2 と同じ線引き）。main（gadgets/czml.js・段 4）は読み込み・軌跡の組み立て（czml-time.js の trackOf/styleOf）を持ち、
// ここへは { type:"tracks", tracks:[{ id, name, t, p, degree, inertial, avail, style }] }（t/p は transfer）を渡すだけ。
// 描く物＝path（尾・lead/trail/resolution）→ 点 / billboard（画像・data URI と http(s)＝取れなければ点）→ label。出ている区間の外・標本の範囲の外は描かない。
// 置き方＝衛星（apps/sats/sats.ts）と同じ：球＝測地の緯度・経度・高さ（単位球の地表点×(1＋h/R)）・楕円体＝ECEF を a で割り y を b/a で割る（β ワールド）。
// 隠れ＝視線（eye→点）が地球（単位球）を通るか＝地平線の向こうでも高い衛星は地球の縁の外に見える（api.projectH の表裏は高さを見ない＝使わない）。
// 断面（#111）で切られた側も描かない。時計が動いている間（実時間を含む）は描き続ける（frame が true）。
// 契約（map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
// 当たり判定（統一 picking・deck.gl 差分 PR-1・2026-10-11）：pick(x, y, r, ctx)＝最後に描いたフレームの点・画像・札の位置（device px）から半径 r の中で一番近い軌跡
//   ＝{ id, distance, lngLat, properties:{ id, name, description } }｜null。描いた物だけ当たる（出ていない区間・地球の陰は描いていない＝当たらない）。
import { positionAt, availableAt, pathTimes, numberAt, boolAt, ecefToLlh } from "../czml-time.ts";
import { ellipsoidOn, worldRadiusM } from "@ortho-earth/core/camera";
import type { CameraPose, CameraState } from "@ortho-earth/core/camera";
import type { LonLat, OverlayFrameApi } from "../../globe.d.ts";
import type { CzmlStyle, CzmlTrack } from "../czml-time.ts";

/** render worker の host（init の第 3 引数）＝読む分 */
interface OverlayHost { post(data: unknown): void; requestDraw(): void }
/** frame の api（断面＝clip は render worker が足す・#111） */
type FrameApi = OverlayFrameApi & { clip?: { distM(lon: number, lat: number, hM?: number): number } | null };
/** main（czml.ts）から来る軌跡（style つき・description は main に残る） */
type DrawTrack = CzmlTrack & { style?: CzmlStyle };
/** 最後に描いた印（device px・r＝当たり半径） */
interface Mark { x: number; y: number; r: number; tr: DrawTrack }
/** main からの指示＋検定の probe */
/** 高さのある線（CZML の polyline・P0 #5＝gadgets/czml-scene.ts の CzmlLine3D）＝ECEF の点列・出ている区間 */
interface DrawLine { p: number[]; color: string; width: number; avail: [number, number][] | null; show: unknown; dash?: LineDash | null; arrow?: boolean }
/** 破線（Cesium の PolylineDash）＝len＝16 ビットの模様 1 巡の長さ（CSS px）・pattern＝立っているビットが線（下位から） */
interface LineDash { len: number; pattern: number }
type CzmlDrawMsg = { type: "probe"; id?: unknown } | { type: "tracks"; tracks?: DrawTrack[] } | { type: "lines"; lines?: DrawLine[] } | { type: "clear" };
type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Prog { p: WebGLProgram; u: Uniforms }
/** アトラスの中の絵（u0,v0,u1,v1＝0..1・w,h＝device px） */
interface Slot { u0: number; v0: number; u1: number; v1: number; w: number; h: number }

const D2R = Math.PI / 180, MIN_EARTH_PX = 14;   // 地球の見かけの半径（CSS px）がこれ未満＝太陽系圏の奥＝描かない（衛星と同じ）
const FONT = '"Noto Sans",system-ui,sans-serif';   // 地域の書体は名指ししない（regionless）＝各言語の文字は OS の書体が受ける
const ATLAS = 2048, IMG_MAX = 256;   // アトラスの一辺・billboard の絵の長辺の上限（焼く時に縮める）
let canvas: OffscreenCanvas | null = null, gl: WebGL2RenderingContext | null = null, host: OverlayHost | null = null, tracks: DrawTrack[] = [];
let marks2: Mark[] = [], lines: DrawLine[] = [];   // 最後に描いた印＝[{ x, y, r（当たり半径・device px）, tr }]（pick が読む）
const images = new Map<string, ImageBitmap | "loading" | "bad">();   // src → ImageBitmap | "loading" | "bad"
const probes: unknown[] = [];

const imageOf = (src: string) => {
	const im = images.get(src);
	if (im) return im instanceof ImageBitmap ? im : null;
	if (!/^(data:|https?:)/.test(src)) { images.set(src, "bad"); return null; }
	images.set(src, "loading");
	fetch(src, { credentials: "omit" }).then(r => r.ok ? r.blob() : Promise.reject(new Error(r.status as unknown as string))).then(b => createImageBitmap(b))
		.then(bm => { images.set(src, bm); host?.requestDraw(); }, () => { images.set(src, "bad"); host?.requestDraw(); });   // CORS で取れない等＝点で描く（本人裁定）
	return null;
};
// CSS の色（czml-time の colorOf＝"rgba(r,g,b,a)"・#rgb/#rrggbb も）→ 前乗算の [r,g,b,a]（0..1）
const colorMemo = new Map<string, number[]>();
const rgbaOf = (c: string | null | undefined): number[] => {
	if (!c) return [0, 0, 0, 0];
	let v = colorMemo.get(c); if (v) return v;
	const m = /^rgba?\(([^)]+)\)$/.exec(c.trim()), h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
	let q = [0, 0, 0, 1];
	if (m) { const a = m[1].split(",").map(x => +x); q = [a[0] / 255, a[1] / 255, a[2] / 255, a[3] ?? 1]; }
	else if (h) { const x = h[1].length === 3 ? h[1].split("").map(d => d + d).join("") : h[1]; q = [parseInt(x.slice(0, 2), 16) / 255, parseInt(x.slice(2, 4), 16) / 255, parseInt(x.slice(4, 6), 16) / 255, 1]; }
	v = [q[0] * q[3], q[1] * q[3], q[2] * q[3], q[3]]; colorMemo.set(c, v); return v;
};

// 尾＝線分 a→b の四角（幅 w・端 cap＝1 なら丸く伸ばす＝継ぎ目・0＝butt）。画素は線分までの距離で覆い率
const VS_SEG = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_ab; layout(location=2) in vec3 a_wc;   // a_wc＝幅・始点の丸・終点の丸
uniform vec2 u_scr; uniform vec4 u_color;
out vec2 v_p; flat out vec4 v_ab; flat out vec3 v_wc;
void main() {
	vec2 a = a_ab.xy, b = a_ab.zw, d = b - a; float L = max(length(d), 1e-4); vec2 t = d / L, n = vec2(-t.y, t.x);
	float e = a_wc.x * 0.5 + 1.0;
	vec2 p = (a_corner.x < 0.0 ? a - t * e : b + t * e) + n * a_corner.y * e;
	v_p = p; v_ab = a_ab; v_wc = a_wc;
	gl_Position = vec4(p.x / u_scr.x * 2.0 - 1.0, 1.0 - p.y / u_scr.y * 2.0, 0.0, 1.0);
}`;
const FS_SEG = `#version 300 es
precision highp float;
in vec2 v_p; flat in vec4 v_ab; flat in vec3 v_wc; uniform vec4 u_color; out vec4 o;
void main() {
	vec2 a = v_ab.xy, d = v_ab.zw - a; float L2 = max(dot(d, d), 1e-8), h = dot(v_p - a, d) / L2;
	if ((h < 0.0 && v_wc.y < 0.5) || (h > 1.0 && v_wc.z < 0.5)) discard;   // 端は butt（canvas2D の既定）
	float dist = length(v_p - a - d * clamp(h, 0.0, 1.0));
	float cov = clamp(v_wc.x * 0.5 - dist + 0.5, 0.0, 1.0);
	if (cov <= 0.0) discard;
	o = u_color * cov;
}`;
// 印＝丸（k 0・塗り＋縁）か絵（k 1・アトラスの四角）。中心 c・半幅 hs・左上からの片寄り off（device px）
const VS_MARK = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_box;    // 中心 x,y・半幅 hx,hy
layout(location=2) in vec4 a_fill; layout(location=3) in vec4 a_line;
layout(location=4) in vec4 a_p;      // 丸＝半径・縁の幅・k / 絵＝-・-・k
layout(location=5) in vec4 a_uv;
uniform vec2 u_scr;
out vec2 v_l; out vec2 v_uv; flat out vec4 v_fill; flat out vec4 v_line; flat out vec4 v_p;
void main() {
	vec2 p = a_box.xy + a_corner * a_box.zw;
	v_l = a_corner * a_box.zw; v_uv = mix(a_uv.xy, a_uv.zw, a_corner * 0.5 + 0.5);
	v_fill = a_fill; v_line = a_line; v_p = a_p;
	gl_Position = vec4(p.x / u_scr.x * 2.0 - 1.0, 1.0 - p.y / u_scr.y * 2.0, 0.0, 1.0);
}`;
const FS_MARK = `#version 300 es
precision highp float;
in vec2 v_l; in vec2 v_uv; flat in vec4 v_fill; flat in vec4 v_line; flat in vec4 v_p; uniform sampler2D u_atlas; out vec4 o;
void main() {
	if (v_p.z > 0.5) { o = texture(u_atlas, v_uv); return; }
	float d = length(v_l), r = v_p.x, lw = v_p.y;
	vec4 c = v_fill * clamp(r - d + 0.5, 0.0, 1.0);
	if (lw > 0.0) { float s = clamp(lw * 0.5 - abs(d - r) + 0.5, 0.0, 1.0); c = v_line * s + c * (1.0 - v_line.a * s); }   // 縁は塗りの上（arc の fill→stroke と同じ）
	if (c.a <= 0.0) discard;
	o = c;
}`;
// 半透明の尾の窓 → 画面（不透明度を掛けて重ねる・前乗算）
const VS_CMP = `#version 300 es
layout(location=0) in vec2 a_corner; out vec2 v_uv;
void main() { v_uv = a_corner * 0.5 + 0.5; gl_Position = vec4(a_corner, 0.0, 1.0); }`;
const FS_CMP = `#version 300 es
precision highp float;
in vec2 v_uv; uniform sampler2D u_t; uniform float u_a; out vec4 o;
void main() { o = texture(u_t, v_uv) * u_a; }`;
let cmp: Prog | null = null, tmp: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } | null = null;
let seg: Prog | null = null, mark: Prog | null = null, quad: WebGLBuffer | null = null, segBuf: WebGLBuffer | null = null, markBuf: WebGLBuffer | null = null, segVao: WebGLVertexArrayObject | null = null, markVao: WebGLVertexArrayObject | null = null;
let atlas: WebGLTexture | null = null, shelfX = 0, shelfY = 0, shelfH = 0;
const slots = new Map<string, Slot | null>();   // 焼いた絵（"i:"＋src・"t:"＋札の鍵）→ アトラスの場所（入らなかった物は null）
let bake: OffscreenCanvas | null = null, bctx: OffscreenCanvasRenderingContext2D | null = null;

function compile(vs: string, fs: string, names: string[]): Prog {
	const g = gl!, p = g.createProgram();
	for (const [t, src] of [[g.VERTEX_SHADER, vs], [g.FRAGMENT_SHADER, fs]] as [GLenum, string][]) {
		const sh = g.createShader(t)!; g.shaderSource(sh, src); g.compileShader(sh);
		if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(sh)!);
		g.attachShader(p, sh);
	}
	g.linkProgram(p);
	if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p)!);
	const u: Uniforms = {}; for (const k of names) u[k] = g.getUniformLocation(p, k);
	return { p, u };
}
// アトラスへ置く（棚詰め・1px の余白）。満杯＝全部を捨てて詰め直す（次に要る物から焼き直す）
function place(key: string, src: TexImageSource, w: number, h: number): Slot | null {
	const g = gl!;
	if (w + 2 > ATLAS || h + 2 > ATLAS) { slots.set(key, null); return null; }
	if (shelfX + w + 2 > ATLAS) { shelfX = 0; shelfY += shelfH; shelfH = 0; }
	if (shelfY + h + 2 > ATLAS) { slots.clear(); shelfX = shelfY = shelfH = 0; }
	g.bindTexture(g.TEXTURE_2D, atlas);
	g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
	g.texSubImage2D(g.TEXTURE_2D, 0, shelfX + 1, shelfY + 1, w, h, g.RGBA, g.UNSIGNED_BYTE, src);
	g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	const s: Slot = { u0: (shelfX + 1) / ATLAS, v0: (shelfY + 1) / ATLAS, u1: (shelfX + 1 + w) / ATLAS, v1: (shelfY + 1 + h) / ATLAS, w, h };
	shelfX += w + 2; shelfH = Math.max(shelfH, h + 2); slots.set(key, s);
	return s;
}
const imageSlot = (src: string, img: ImageBitmap) => {
	const k = "i:" + src; if (slots.has(k)) return slots.get(k)!;
	const sc = Math.min(1, IMG_MAX / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * sc)), h = Math.max(1, Math.round(img.height * sc));
	const c = new OffscreenCanvas(w, h), x = c.getContext("2d")!; x.drawImage(img, 0, 0, w, h);   // ImageData で上げる＝前乗算を pixelStorei で揃える（ImageBitmap は自前の設定に従う）
	return place(k, x.getImageData(0, 0, w, h), w, h);
};
// 札＝白抜きの縁（3px）と字を canvas2D で一度だけ焼く。pad＝字の左端・縦の中心までの片寄り（置く側が引く）
const LABEL_PAD = 2;
function labelSlot(text: string, px: number, color: string, outline: string, dpr: number) {
	const k = `t:${px * dpr}|${color}|${outline}|${text}`; if (slots.has(k)) return slots.get(k)!;
	bake ??= new OffscreenCanvas(64, 64); bctx ??= bake.getContext("2d")!;
	const font = `${px * dpr}px ${FONT}`, ow = 3 * dpr; bctx.font = font;
	const tw = Math.ceil(bctx.measureText(text).width), w = Math.ceil(tw + ow + LABEL_PAD * 2), h = Math.ceil(px * dpr * 1.5 + ow + LABEL_PAD * 2);
	if (bake.width < w || bake.height < h) { bake.width = Math.max(bake.width, w); bake.height = Math.max(bake.height, h); }
	bctx.clearRect(0, 0, bake.width, bake.height);
	bctx.font = font; bctx.textBaseline = "middle"; bctx.textAlign = "left";
	const x = LABEL_PAD + ow / 2, y = h / 2;
	bctx.lineWidth = ow; bctx.strokeStyle = outline; bctx.strokeText(text, x, y);
	bctx.fillStyle = color; bctx.fillText(text, x, y);
	const img = bctx.getImageData(0, 0, w, h);
	return place(k, img, w, h);
}

export function init(cv: OffscreenCanvas, opts: unknown, h: OverlayHost) {
	canvas = cv; host = h;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
	if (!gl) return;
	seg = compile(VS_SEG, FS_SEG, ["u_scr", "u_color"]); mark = compile(VS_MARK, FS_MARK, ["u_scr", "u_atlas"]); cmp = compile(VS_CMP, FS_CMP, ["u_t", "u_a"]);
	quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	segBuf = gl.createBuffer(); markBuf = gl.createBuffer();
	segVao = gl.createVertexArray(); gl.bindVertexArray(segVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
	gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribDivisor(1, 1);
	gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16); gl.vertexAttribDivisor(2, 1);
	markVao = gl.createVertexArray(); gl.bindVertexArray(markVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, markBuf);
	for (let i = 0; i < 5; i++) { gl.enableVertexAttribArray(1 + i); gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, 80, i * 16); gl.vertexAttribDivisor(1 + i, 1); }
	gl.bindVertexArray(null);
	atlas = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, atlas);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS, ATLAS);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
export function message(d: CzmlDrawMsg | null | undefined) {
	if (d?.type === "probe") { probes.push(d.id); host?.requestDraw(); return; }   // 検定用＝次に描いた直後の画素を main へ（dbgHost.__ovPixels）
	if (d?.type === "tracks") tracks = d.tracks || [];
	else if (d?.type === "lines") lines = d.lines || [];
	else if (d?.type === "clear") { tracks = []; lines = []; }
	host?.requestDraw();
}
export function destroy() { tracks = []; lines = []; for (const v of images.values()) if (v instanceof ImageBitmap) v.close(); images.clear(); slots.clear(); gl?.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }

// 検定用の画素（premultiplied RGBA・上が先＝旧 canvas2D の getImageData と同じ向きに並べ直す）
function answerProbes(w: number, h: number) {
	if (!probes.length || !gl) return;
	const ids = probes.splice(0);
	try { const raw = new Uint8Array(w * h * 4), data = new Uint8Array(w * h * 4), row = w * 4; gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw); for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row); for (const id of ids) host?.post({ type: "pixels", id, w, h, flipY: false, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post({ type: "pixels", id, error: String((e as Error)?.message || e) }); }
}
export function frame(cam: CameraPose, s: CameraState, { w, h }: { w: number; h: number }, api: FrameApi) {
	if (!gl) return false;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	const r = draw(cam, s, w, h, api);
	answerProbes(w, h);
	return r;
}
function draw(cam: CameraPose, s: CameraState, w: number, h: number, api: FrameApi) {
	const g = gl!;
	marks2 = [];
	if (!tracks.length && !lines.length) return false;
	const E = s.eye, m = s.mvp, dpr = api.dpr || 1;
	if (s.focal / Math.sqrt(Math.max(E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1, 1e-12)) / dpr < MIN_EARTH_PX) return api.clock?.rate !== 0;
	const ell = ellipsoidOn(), R = worldRadiusM(), rAx = api.rAx || 1, ms = api.time;
	// ECEF（m）→ 画面（device px）｜null（地球の陰・カメラの後ろ・断面で切られた側）
	const toScreen = (q: ArrayLike<number>): [number, number] | null => {
		let x: number, y: number, z: number, llh: [number, number, number] | null = null;
		if (ell) { x = q[0] / R; y = q[2] / (R * rAx); z = q[1] / R; }
		else { llh = ecefToLlh(q[0], q[1], q[2]); const a = llh[0] * D2R, b = llh[1] * D2R, k = 1 + llh[2] / R, cb = Math.cos(b); x = cb * Math.cos(a) * k; y = Math.sin(b) * k; z = cb * Math.sin(a) * k; }
		const ww = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (ww <= 1e-6) return null;
		const dx = x - E[0], dy = y - E[1], dz = z - E[2], dd = dx * dx + dy * dy + dz * dz, tt = -(E[0] * dx + E[1] * dy + E[2] * dz) / dd;
		if (tt > 0 && tt < 1) { const px = E[0] + dx * tt, py = E[1] + dy * tt, pz = E[2] + dz * tt; if (px * px + py * py + pz * pz < 1) return null; }
		if (api.clip) { llh ??= ecefToLlh(q[0], q[1], q[2]); if (api.clip.distM(llh[0], llh[1], llh[2]) < 0) return null; }
		return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / ww * 0.5 + 0.5) * w, (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / ww * 0.5 + 0.5)) * h];
	};
	g.enable(g.BLEND); g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
	// 尾（path）＝尾 1 本ごとに 1 回描く。不透明の色はそのまま画面へ（継ぎ目は覆い率の和集合）・半透明は窓へ不透明で描いて不透明度を掛けて重ねる（尾の外接矩形だけ）
	const segDraw = (out: number[], col: number[]) => {
		g.useProgram(seg!.p); g.uniform2f(seg!.u.u_scr, w, h); g.uniform4fv(seg!.u.u_color, col);
		g.bindVertexArray(segVao); g.bindBuffer(g.ARRAY_BUFFER, segBuf); g.bufferData(g.ARRAY_BUFFER, new Float32Array(out), g.STREAM_DRAW);
		g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, out.length / 7);
	};
	// 線分の列（device px の [x0,y0,x1,y1,幅,継ぎ前,継ぎ後]×n）を 1 本の線として描く（尾・3D の線の共通）
	const stroke = (out: number[], c: number[], lw: number) => {
		if (out.length && c[3] >= 0.999) segDraw(out, c);
		else if (out.length && c[3] > 0) {
			if (!tmp || tmp.w !== w || tmp.h !== h) {
				if (tmp) { g.deleteTexture(tmp.tex); g.deleteFramebuffer(tmp.fbo); }
				const tex = g.createTexture(); g.bindTexture(g.TEXTURE_2D, tex); g.texStorage2D(g.TEXTURE_2D, 1, g.RGBA8, w, h);
				g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
				const fbo = g.createFramebuffer(); g.bindFramebuffer(g.FRAMEBUFFER, fbo); g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
				tmp = { tex, fbo, w, h };
			}
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (let i = 0; i < out.length; i += 7) { x0 = Math.min(x0, out[i], out[i + 2]); x1 = Math.max(x1, out[i], out[i + 2]); y0 = Math.min(y0, out[i + 1], out[i + 3]); y1 = Math.max(y1, out[i + 1], out[i + 3]); }
			const e = lw / 2 + 2, sx = Math.max(0, Math.floor(x0 - e)), sy = Math.max(0, Math.floor(h - y1 - e)), sw = Math.min(w, Math.ceil(x1 + e)) - sx, sh = Math.min(h, Math.ceil(h - y0 + e)) - sy;
			if (sw > 0 && sh > 0) {
				g.enable(g.SCISSOR_TEST); g.scissor(sx, sy, sw, sh);
				g.bindFramebuffer(g.FRAMEBUFFER, tmp.fbo); g.clear(g.COLOR_BUFFER_BIT);
				segDraw(out, [c[0] / c[3], c[1] / c[3], c[2] / c[3], 1]);
				g.bindFramebuffer(g.FRAMEBUFFER, null);
				g.useProgram(cmp!.p); g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, tmp.tex); g.uniform1i(cmp!.u.u_t, 0); g.uniform1f(cmp!.u.u_a, c[3]);
				g.bindVertexArray(markVao); g.drawArrays(g.TRIANGLE_STRIP, 0, 4);   // markVao の属性 0＝画面の四角（他の属性は使わない）
				g.disable(g.SCISSOR_TEST);
			}
		}
	};
	const marks: Array<[[number, number], Partial<CzmlStyle>, DrawTrack]> = [];
	// 高さのある線（CZML の polyline・P0 #5）＝尾と同じ描き方（隠れた所・切られた所で途切れる）
	for (const L of lines) {
		if ((L.avail && !L.avail.some(([a, b]) => ms >= a && ms <= b)) || !boolAt(L.show, ms, true)) continue;
		const lw = L.width * dpr, out: number[] = [];
		let run: Array<[number, number]> = [];
		const flush = () => {
			if (L.arrow && run.length > 1) arrowRun(run, lw, out);
			else if (L.dash) dashRun(run, lw, L.dash.len * dpr, L.dash.pattern, out);
			else for (let i = 0; i + 1 < run.length; i++) out.push(run[i][0], run[i][1], run[i + 1][0], run[i + 1][1], lw, i > 0 ? 1 : 0, i + 2 < run.length ? 1 : 0);
			run = [];
		};
		for (let i = 0; i + 2 < L.p.length; i += 3) { const P = toScreen([L.p[i], L.p[i + 1], L.p[i + 2]]); if (!P) { flush(); continue; } run.push(P); }
		flush();
		stroke(out, rgbaOf(L.color), lw);
	}
	for (const tr of tracks) {
		if (!availableAt(tr, ms)) continue;
		const st: Partial<CzmlStyle> = tr.style || {};
		const ph = st.path;
		if (ph && boolAt(ph.show, ms, true)) {
			const times = pathTimes(tr, ms, { lead: numberAt(ph.lead, ms, null), trail: numberAt(ph.trail, ms, null), resolution: numberAt(ph.resolution, ms, 60) });
			const lw = ph.width * dpr, out: number[] = [];
			let run: Array<[number, number]> = [];
			const flush = () => { for (let i = 0; i + 1 < run.length; i++) out.push(run[i][0], run[i][1], run[i + 1][0], run[i + 1][1], lw, i > 0 ? 1 : 0, i + 2 < run.length ? 1 : 0); run = []; };   // 継ぎは丸・尾の端は butt
			for (const t of times) { const q = positionAt(tr, t), P = q && toScreen(q); if (!P) { flush(); continue; } run.push(P); }
			flush();
			stroke(out, rgbaOf(ph.color), lw);
		}
		const q = positionAt(tr, ms), P = q && toScreen(q);
		if (P) marks.push([P, st, tr]);
	}
	// 点・画像・札は尾の上に（印の順＝軌跡の順・印ごとに 点か画像 → 札）
	const mk: number[] = [];
	const push = (cx: number, cy: number, hx: number, hy: number, fill: number[], line: number[], p: number[], uv: number[]) => mk.push(cx, cy, hx, hy, ...fill, ...line, ...p, ...uv);
	const Z4 = [0, 0, 0, 0];
	for (const [P, st, tr] of marks) {
		let hitR = 4 * dpr;   // 当たり半径＝描いた物の大きさ（画像＝短辺の半分・点＝半径・最低 4px）
		const img = st.image && boolAt(st.image.show, ms, true) ? imageOf(st.image.src) : null, sl = img ? imageSlot(st.image!.src, img) : null;
		if (img && sl) {
			const sw = img.width * st.image!.scale * dpr, sh = img.height * st.image!.scale * dpr;
			push(P[0] + st.image!.offset[0] * dpr, P[1] + st.image!.offset[1] * dpr, sw / 2, sh / 2, Z4, Z4, [0, 0, 1, 0], [sl.u0, sl.v0, sl.u1, sl.v1]);
			hitR = Math.max(hitR, Math.min(sw, sh) / 2);
		} else if ((st.point && boolAt(st.point.show, ms, true)) || st.image) {   // 画像が取れない（取れる前も）＝点
			const pt = st.point || { size: 8, color: "rgba(255,255,255,1)", outline: "rgba(0,0,0,0.8)", outlineWidth: 1 };
			const r = Math.max(1, pt.size) * dpr / 2, lw = pt.outline && pt.outlineWidth ? pt.outlineWidth * dpr : 0, e = r + lw / 2 + 1;
			push(P[0], P[1], e, e, rgbaOf(pt.color), lw ? rgbaOf(pt.outline) : Z4, [r, lw, 0, 0], Z4);
			hitR = Math.max(hitR, r);
		}
		marks2.push({ x: P[0], y: P[1], r: hitR, tr });
		const lb = st.label;
		if (lb && boolAt(lb.show, ms, true) && lb.text) {
			const L = labelSlot(lb.text, lb.px, lb.color, lb.outline || "rgba(0,0,0,0.85)", dpr);
			if (L) {
				const x = P[0] + lb.offset[0] * dpr, y = P[1] + lb.offset[1] * dpr, ink = L.w - LABEL_PAD * 2 - 3 * dpr;   // ink＝字の幅
				const x0 = lb.align === "left" ? x - LABEL_PAD - 1.5 * dpr : lb.align === "right" ? x - ink - LABEL_PAD - 1.5 * dpr : x - L.w / 2;
				push(Math.round(x0) + L.w / 2, Math.round(y - L.h / 2) + L.h / 2, L.w / 2, L.h / 2, Z4, Z4, [0, 0, 1, 0], [L.u0, L.v0, L.u1, L.v1]);
			}
		}
	}
	if (mk.length) {
		g.useProgram(mark!.p); g.uniform2f(mark!.u.u_scr, w, h);
		g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, atlas); g.uniform1i(mark!.u.u_atlas, 0);
		g.bindVertexArray(markVao); g.bindBuffer(g.ARRAY_BUFFER, markBuf); g.bufferData(g.ARRAY_BUFFER, new Float32Array(mk), g.STREAM_DRAW);
		g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, mk.length / 20);
	}
	g.bindVertexArray(null); g.disable(g.BLEND);
	return api.clock?.rate !== 0;   // 時計が動いている（null＝実時間も）間は描き続ける
}
// 破線＝画面の長さで模様を刻む（Cesium の PolylineDash と同じ：1 巡 len px を 16 等分・ビットが立つ所が線）。線分の列 [x0,y0,x1,y1,幅,継ぎ前,継ぎ後] を out へ
export function dashRun(run: Array<[number, number]>, lw: number, len: number, pattern: number, out: number[]) {
	const bit = len / 16, on = (d: number) => ((pattern >> (Math.floor((((d % len) + len) % len) / bit) & 15)) & 1) === 1;
	let d = 0;
	for (let i = 0; i + 1 < run.length; i++) {
		const [x0, y0] = run[i], [x1, y1] = run[i + 1], L = Math.hypot(x1 - x0, y1 - y0);
		let a = 0;
		while (a < L) {
			const r = bit - ((d + a) % bit), b = Math.min(L, a + (r > 1e-6 ? r : bit));   // 次のビットの境まで
			if (on(d + (a + b) / 2)) out.push(x0 + (x1 - x0) * a / L, y0 + (y1 - y0) * a / L, x0 + (x1 - x0) * b / L, y0 + (y1 - y0) * b / L, lw, 0, 0);
			a = b;
		}
		d += L;
	}
}
// 矢印（Cesium の PolylineArrow）＝終点が先。軸は幅の 1/3、先の 1.5 幅ぶんは幅から 0 へ細る三角（細る段を短い線分で積む）
export function arrowRun(run: Array<[number, number]>, lw: number, out: number[]) {
	let total = 0;
	for (let i = 0; i + 1 < run.length; i++) total += Math.hypot(run[i + 1][0] - run[i][0], run[i + 1][1] - run[i][1]);
	const head = Math.min(total, lw * 1.5), shaft = Math.max(1, lw / 3), K = 8;
	let d = 0;
	for (let i = 0; i + 1 < run.length; i++) {
		const [x0, y0] = run[i], [x1, y1] = run[i + 1], L = Math.hypot(x1 - x0, y1 - y0);
		if (!(L > 0)) continue;
		const at = (u: number): [number, number] => [x0 + (x1 - x0) * (u - d) / L, y0 + (y1 - y0) * (u - d) / L];
		const h0 = total - head, a = d, b = Math.min(d + L, h0);
		if (b > a) { const p = at(a), q = at(b); out.push(p[0], p[1], q[0], q[1], shaft, i > 0 ? 1 : 0, b < d + L ? 1 : 0); }
		for (let k = 0; k < K; k++) {   // 先の三角：k 段目の幅＝lw·(1 − (k+0.5)/K)
			const u0 = h0 + head * k / K, u1 = h0 + head * (k + 1) / K, s0 = Math.max(u0, d), s1 = Math.min(u1, d + L);
			if (s1 > s0) { const p = at(s0), q = at(s1); out.push(p[0], p[1], q[0], q[1], Math.max(0.5, lw * (1 - (k + 0.5) / K)), 0, 0); }
		}
		d += L;
	}
}
// 印の列から (x, y) に一番近い物（中心の距離 − 印の半径 ≤ r）＝純関数（node の検定 tests/pick.mjs が読む）
export function nearestMark<M extends { x: number; y: number; r: number }>(marks: M[], x: number, y: number, r: number) {
	let best: { m: M; d: number } | null = null;
	for (const m of marks) {
		const d = Math.hypot(m.x - x, m.y - y);
		if (d - m.r > r) continue;
		if (!best || d < best.d) best = { m, d };
	}
	return best;
}
export function pick(x: number, y: number, r: number, ctx?: { api?: { time?: number } | null } | null) {
	const b = nearestMark(marks2, x, y, r);
	if (!b) return null;
	const tr = b.m.tr, ms = ctx?.api?.time, q = ms != null ? positionAt(tr, ms) : null, llh = q ? ecefToLlh(q[0], q[1], q[2]) : null;
	return { id: tr.id, distance: b.d, lngLat: llh ? [llh[0], llh[1]] as LonLat : null, properties: { id: tr.id, name: tr.name ?? null } };   // 説明（description）は main（gadgets/czml.js）が持つ＝ここには来ない
}
