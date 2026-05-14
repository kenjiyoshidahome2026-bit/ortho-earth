import { geoOrthographic } from "./geoOrthoGraphic.js";
const { PI, log2, max, sin, cos, round } = Math;
let gl, width, height, zoom;
let proj = geoOrthographic();

// WebGLリソース群
let sharedVAO, maxPolyVertices = 2000, totalPolygons = 0;

onmessage = async e => {
	const data = e.data;
	if (data.type === 'init') await init(data);
	if (data.type === 'resize') resize(data);
	if (data.type === 'drawing') drawing(data);
};

async function init(data) {
	gl = initWebGL(data.offscreen.getContext("webgl2"), data.dpr);
	await loadGintBuffers();
	postMessage({ action: 'done', type: 'init' });
}



async function loadGintBuffers() {
	// 実際の実装では IndexedDB 等から ArrayBuffer を直読みして転送
	// ここでは構造定義のスケルトンを示します
	sharedVAO = gl.createVertexArray();
	gl.bindVertexArray(sharedVAO);

	// --- Buffer 0: メタデータ(ポリゴン単位/Divisor=1) ---
	// [offset(uint), len(uint), id(uint)]
	const metaBuffer = gl.createBuffer();
	// ... gl.bufferData ...

	// 各属性の有効化とDivisor設定
	// a_arc_offset, a_arc_len, a_poly_id ...
	// gl.vertexAttribDivisor(loc, 1);

	// --- Texture Buffer 0: 接続済みIBO ---
	// uintの1Dストリームとしてバッファテクスチャ化

	// --- Texture Buffer 1: Morton Pool ---
	// uvec2 (8byte) の1Dストリームとしてバッファテクスチャ化

	// --- Texture 2: 属性テーブル (CSV) ---
	// 1Dのカラーパレット画像としてロード

	gl.bindVertexArray(null);
}

function resize(data) {
	gl.resizeBySize(width = data.width, height = data.height);
	proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
}

function drawing(data) {
	proj.rotate(data.rotate).scale(data.scale);
	zoom = log2(data.scale * PI * 2 / 256);
	gl.clear(gl.COLOR_BUFFER_BIT); if (zoom < 5) return;
	const jacob = updateJacobian(proj, width, height);
	gl.uniformMatrix2fv(gl.jacobian_loc, false, jacob.matrix);
	gl.uniform2iv(gl.center_int_loc, jacob.centerInt);

	// 現在のズームに応じたLOD閾値の算出 (例: 線形マッピング)
	const lodThresh = max(0, 63 - (zoom - SWITCH_ZOOM) * 10);
	gl.uniform1f(gl.lod_thresh_loc, lodThresh);

	// 一撃描画 (Single Dispatch)
	// CPUはループを回さず、すべての描画をGPUへ丸投げする
	gl.bindVertexArray(sharedVAO);
	gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, maxPolyVertices, totalPolygons);
	gl.bindVertexArray(null);
}
////------------------------------------------------------------------------------------
function initWebGL(gl, dpr) {
	export const gintVs = `#version 300 es
		precision highp float;

		in uvec2 a_gint64; // [low32, high32] - 8byte Morton

		// --- ポリゴン単位のインスタンス属性 (Divisor=1) ---
		in uint a_arc_offset; // IBO内の参照開始オフセット
		in uint a_arc_len;    // 頂点数
		in uint a_poly_id;    // 属性テーブル用ID

		uniform usamplerBuffer u_stitched_ibo; // 接続済みインデックスストリーム
		uniform usamplerBuffer u_morton_pool;  // 全ARC共有Mortonプール

		uniform mat2 u_jacobian;    // 回転・スケール・歪みを統合した行列
		uniform ivec2 u_center_int; // 現在の中心点の整数Morton (ix, iy)
		uniform vec2 u_center_px;   // 画面中心ピクセル (width/2, height/2)
		uniform vec2 u_viewport;    // (width, height)
		uniform float u_lod_thresh; // 1px-LOD用の閾値スコア (0-63)

		flat out uint v_id;

		uint compact16(uint m) {
			m &= 0x55555555u;
			m = (m | (m >> 1)) & 0x33333333u;
			m = (m | (m >> 2)) & 0x0F0F0F0Fu;
			m = (m | (m >> 4)) & 0x00FF00FFu;
			m = (m | (m >> 8)) & 0x0000FFFFu;
			return m & 0xFFFFu;
		}

		void main() {
			v_id = a_poly_id;

			// 1. 頂点の有効性判定 (ifなし)
			// 自身のVertexIDがポリゴンの長さを超えている場合は潰す
			float is_within_arc = step(float(gl_VertexID), float(a_arc_len) - 1.0);

			// 2. IBO経由で実際のMortonポインタを取得
			uint morton_ptr = texelFetch(u_stitched_ibo, int(a_arc_offset + uint(gl_VertexID))).r;

			// 3. Mortonデータの取得とUnpack
			uvec2 gint64 = texelFetch(u_morton_pool, int(morton_ptr)).rg;
			uint low32 = gint64.x;
			uint high32 = gint64.y;

			// 4. 重み抽出とLOD判定 (ifなし)
			uint is_l1 = high32 >> 31u;
			uint weight = (is_l1 * 63u) + ((1u - is_l1) * (low32 & 0x3Fu));
			float is_visible_lod = step(u_lod_thresh, float(weight));

			// 5. Morton座標の復元
			uint m_low = low32 & 0xFFFFFFC0u;
			uint m_high = high32 & 0x7FFFFFFFu;
			int ix = int((compact16(m_high) << 16) | compact16(m_low));
			int iy = int((compact16(m_high >> 1) << 16) | compact16(m_low >> 1));

			// 6. 整数空間での差分算出（Jitterの物理的消滅）と度数変換
			vec2 delta_deg = vec2(ix - u_center_int.x, iy - u_center_int.y) * 1e-7;

			// 7. ヤコビアン適用（歪み・スケール・回転を全適用）
			vec2 pixel_delta = u_jacobian * delta_deg;
			vec2 pixel_pos = u_center_px + pixel_delta;

			// 8. NDC変換と最終決定
			// 無効な頂点はすべて (0,0) に収束させ、面積ゼロの三角形として消去
			float total_visibility = is_within_arc * is_visible_lod;
			vec2 ndc = (pixel_pos / u_viewport) * 2.0 - 1.0;
			
			gl_Position = vec4(ndc * vec2(1.0, -1.0), 0.0, 1.0) * total_visibility;
		}`;

	const gintFs = `#version 300 es
		precision highp float;
		flat in uint v_id;
		out vec4 fragColor;

		// 属性テーブル (ID -> Color)
		uniform sampler2D u_attr_table;

		void main() {
			// CSV行番号に基づき属性を一発フェッチ
			fragColor = texelFetch(u_attr_table, ivec2(v_id, 0), 0);
		}`;
	// プログラム生成
	const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, gintVs); gl.compileShader(vs);
	const fs = gl.createShader(gl.SHADER); gl.shaderSource(fs, gintFs); gl.compileShader(fs);

	const program = gl.createProgram();
	gl.attachShader(program, vs); gl.attachShader(program, fs);
	gl.linkProgram(program);
	gl.useProgram(program);

	// Uniformロケーション取得
	gl.jacobian_loc = gl.getUniformLocation(program, 'u_jacobian');
	gl.center_int_loc = gl.getUniformLocation(program, 'u_center_int');
	gl.center_px_loc = gl.getUniformLocation(program, 'u_center_px');
	gl.viewport_loc = gl.getUniformLocation(program, 'u_viewport');
	gl.lod_thresh_loc = gl.getUniformLocation(program, 'u_lod_thresh');

	// テクスチャユニット設定
	gl.uniform1i(gl.getUniformLocation(program, 'u_stitched_ibo'), 0);
	gl.uniform1i(gl.getUniformLocation(program, 'u_morton_pool'), 1);
	gl.uniform1i(gl.getUniformLocation(program, 'u_attr_table'), 2);
	gl.applyProgram = () => gl.useProgram(program);
	gl.resizeBySize = (w, h) => {
		gl.viewport(0, 0, gl.canvas.width = w * dpr, gl.canvas.height = h * dpr);
		gl.useProgram(program);
		gl.uniform2f(gl.viewport_loc, gl.canvas.width, gl.canvas.height);
		gl.uniform2fv(gl.center_px_loc, [width / 2, height / 2]);
	};
	return gl;
}

function updateJacobian(width, height) {
	const rad = PI / 180;
	const lat = -rotate[1];
	const gamma = rotate[2];
	const cosPhi = cos(lat * rad);
	const cosG = cos(gamma * rad);
	const sinG = sin(gamma * rad);
	const s = scale * rad;

	// 列優先 (Column-major) の mat2 [j11, j21, j12, j22]
	// X軸(経度)の寄与: cos(phi)で縮み、gammaで回る
	const j11 = s * cosPhi * cosG;
	const j21 = -s * cosPhi * sinG; // Y-downスクリーンを考慮

	// Y軸(緯度)の寄与: gammaで回り、Y軸の向きを反転
	const j12 = s * sinG;
	const j22 = s * cosG;

	// 現在の画面中心に対応する Morton 整数値も計算
	const centerLng = -rotate[0];
	const centerLat = -rotate[1];
	const centerIntX = round((centerLng + 180) * 1e7);
	const centerIntY = round((centerLat + 90) * 1e7);

	return {
		matrix: new Float32Array([j11, j21, j12, j22]),
		centerInt: [centerIntX, centerIntY],
	};
}