// シーンの深度を同一フレームのオーバーレイへ渡す（#47・2026-09-25）。バックエンド非依存の約束だけをここに置く。
// 本体（gl/depthout.js・gpu/depthout.js）が描き終えたフレームの深度を RGBA8 に詰め、render worker がそれを
// オーバーレイの api.depth として配る。オーバーレイは自前の WebGL2 コンテキスト＝テクスチャは共有できない＝
// 1 フレーム 1 回、画素（GL2＝readPixels の Uint8Array／WebGPU＝transferToImageBitmap の ImageBitmap）で渡す。
//
// 詰め方：本体の深度そのもの＝対数深度 d = log2(1+w)·logCoef/2（w＝目からの距離・単位球の単位・logCoef＝2/log2(far+1)）を
// 24bit で RGB に（R が上位）。A＝255。d=1（クリア値）＝「何も書かれていない」。海面の球は深度を書かない（地平線の向こうの
// 隠れは従来どおり解析で＝api.project の f<0）＝ここで隠れるのは地形（傾けた時）・ビル・メッシュ・gint の建物。
// 行の向き＝下から（GL の窓座標と同じ）＝オーバーレイは uv = gl_FragCoord.xy / 自分の描画面の大きさ で引けばよい。
// 解像度は本体の canvas（動的解像度の縮小込み）＝オーバーレイの canvas（常にフル解像度）とは違ってよい（uv で引く）。

// オーバーレイの FS に貼る GLSL（#version の後・precision の後）。bindSceneDepth(gl, prog, unit, depth) が uniform を埋める。
//   sceneDepthAt(uv)＝本体の深度（1.0＝何も無い）／depthOfW(w)＝自分の clip w（＝gl_Position.w）を同じ尺度へ／
//   sceneOcclusion(uv, w)＝1.0＝本体の物の陰（隠れる）・0.0＝見える。捨てる（discard）か薄めるかはオーバーレイの自由。
export const DEPTH_GLSL = `
uniform highp sampler2D u_sceneDepth;
uniform highp float u_sceneLogCoef;
uniform highp float u_sceneDepthEps;
uniform highp float u_sceneDepthOn;
highp float sceneDepthAt(highp vec2 uv) {
	highp vec3 c = floor(texture(u_sceneDepth, uv).rgb * 255.0 + 0.5);
	return dot(c, vec3(65536.0, 256.0, 1.0)) / 16777215.0;
}
highp float depthOfW(highp float w) { return 0.5 * log2(max(1.0 + w, 1e-6)) * u_sceneLogCoef; }
highp float sceneOcclusion(highp vec2 uv, highp float w) {
	if (u_sceneDepthOn < 0.5) return 0.0;
	highp float s = sceneDepthAt(uv);
	return (s < 1.0 && depthOfW(w) > s + u_sceneDepthEps) ? 1.0 : 0.0;
}
`;
// 既定の許し（深度の単位）＝24bit の約 34 目盛。近景（far≈30km）で数 cm・全球で数百 m＝屋上や地表に置いた物が自分で欠けない幅
export const DEPTH_EPS = 2e-6;

// render worker 側：1 フレーム分の深度（{ pixels | bitmap, w, h, logCoef }）を、オーバーレイの gl へテクスチャとして上げる口を作る。
// 同じフレームで同じ gl が二度呼んでも上げ直さない（gl ごとに WeakMap）。上げる時は gl の束縛と unpack の状態を戻す。
const texCache = new WeakMap();   // gl → { tex, id, w, h }（フレームを跨いで持つ＝同じテクスチャへ texSubImage2D で上げ直す）
const locCache = new WeakMap();   // prog → { name: location }
const UNPACK2 = ["UNPACK_ROW_LENGTH", "UNPACK_SKIP_PIXELS", "UNPACK_SKIP_ROWS", "UNPACK_IMAGE_HEIGHT", "UNPACK_SKIP_IMAGES"];   // WebGL2 の詰め方（オーバーレイが変えていても素で上げる）
export function makeDepthApi(f, id) {
	function texture(gl) {
		let e = texCache.get(gl);
		if (!e) { e = { tex: gl.createTexture(), id: -1, w: 0, h: 0 }; texCache.set(gl, e); }
		if (e.id === id) return e.tex;
		const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
		const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), pma = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
		const csc = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL), align = gl.getParameter(gl.UNPACK_ALIGNMENT);
		const u2 = UNPACK2.map(n => gl.getParameter(gl[n]));
		gl.bindTexture(gl.TEXTURE_2D, e.tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
		for (const n of UNPACK2) gl.pixelStorei(gl[n], 0);
		const same = e.w === f.w && e.h === f.h;   // 同じ大きさ＝上げ直し（確保し直さない）
		if (f.bitmap) { if (same) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.bitmap); else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.bitmap); }
		else if (same) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.w, f.h, gl.RGBA, gl.UNSIGNED_BYTE, f.pixels);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.pixels);
		if (e.id === -1) {   // 初回だけ＝NEAREST（詰めた 24bit を補間で壊さない）・端は伸ばす
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		}
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pma);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, csc); gl.pixelStorei(gl.UNPACK_ALIGNMENT, align);
		UNPACK2.forEach((n, i) => gl.pixelStorei(gl[n], u2[i]));
		gl.bindTexture(gl.TEXTURE_2D, prev);
		e.id = id; e.w = f.w; e.h = f.h;
		return e.tex;
	}
	// DEPTH_GLSL の uniform を埋める。prog は useProgram 済みであること。unit＝使ってよいテクスチャユニット番号（そのユニットの束縛は変わる・活性ユニットは戻す）
	function bind(gl, prog, unit = 7, eps = DEPTH_EPS) {
		const tex = texture(gl);
		const act = gl.getParameter(gl.ACTIVE_TEXTURE);
		gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.activeTexture(act);
		let L = locCache.get(prog); if (!L) { L = {}; locCache.set(prog, L); }
		const u = n => n in L ? L[n] : (L[n] = gl.getUniformLocation(prog, n));
		gl.uniform1i(u("u_sceneDepth"), unit);
		gl.uniform1f(u("u_sceneLogCoef"), f.logCoef);
		gl.uniform1f(u("u_sceneDepthEps"), eps);
		gl.uniform1f(u("u_sceneDepthOn"), 1);
	}
	return { w: f.w, h: f.h, logCoef: f.logCoef, backend: f.bitmap ? "webgpu" : "webgl2", glsl: DEPTH_GLSL, texture, bind };
}
// 深度が無いフレーム（申し出前・LOW_MEM・作れない環境）＝オーバーレイは自分で u_sceneDepthOn を 0 にする（依存ゼロ＝この module は import できない）
