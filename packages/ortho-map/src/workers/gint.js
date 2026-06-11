import { geoOrthographic } from "common";
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


// src/workers/gint.js の loadGintBuffers() を完全実装に格上げ

let mortonPoolTex, stitchedIboTex; // バッファテクスチャの参照保持

async function loadGintBuffers(pbfPolygonData) {
	// メメインスレッドの GeoPBF から引き渡されたトポロジーオブジェクト
	// pbfPolygonData = { buffer, meta, mlen, count }
	const { buffer, meta, mlen, count } = pbfPolygonData;

	sharedVAO = gl.createVertexArray();
	gl.bindVertexArray(sharedVAO);

	// =================================================================
	// 📊 Buffer 0: インスタンス属性（ポリゴン単位で1回進む / Divisor=1）
	// =================================================================
	// 各ポリゴンが「IBO内のどこから」「何頂点分」描画されるかのメタデータ
	const polyMeta = new Uint32Array(count * 3); // [offset, len, poly_id]

	let currentArcOffset = 0;
	const indicesStream = [];

	for (let i = 0; i < count; i++) {
		const off = meta[i * mlen];     // 全体バッファにおけるリングの開始位置
		const len = meta[i * mlen + 1]; // このリングの持つ頂点数（LOD前の生数）

		if (len < 3) continue;

		// 🌟 ここで「LOD対応の三角形ファン（Fan）ストリーム」を切り出す
		// 頂点シェーダー側が gl.TRIANGLE_FAN でインスタンス描画するため、
		// IBOストリームには「元バッファの絶対インデックス」をそのまま順番通りに敷き詰める
		polyMeta[totalPolygons * 3 + 0] = currentArcOffset; // a_arc_offset
		polyMeta[totalPolygons * 3 + 1] = len;             // a_arc_len
		polyMeta[totalPolygons * 3 + 2] = i;               // a_poly_id (属性テーブルの行番号)

		// このポリゴンを構成するインデックス（絶対位置）をストリームにプッシュ
		for (let k = 0; k < len; k++) {
			indicesStream.push(off + k);
		}

		currentArcOffset += len;
		totalPolygons++;
	}

	// GPUへインスタンスメタデータを転送
	const metaBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, metaBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, polyMeta.subarray(0, totalPolygons * 3), gl.STATIC_DRAW);

	// a_arc_offset (Location 1)
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 1, gl.UNSIGNED_INT, false, 12, 0);
	gl.vertexAttribDivisor(1, 1); // インスタンスごとに1進める

	// a_arc_len (Location 2)
	gl.enableVertexAttribArray(2);
	gl.vertexAttribPointer(2, 1, gl.UNSIGNED_INT, false, 12, 4);
	gl.vertexAttribDivisor(2, 1);

	// a_arc_id (Location 3)
	gl.enableVertexAttribArray(3);
	gl.vertexAttribPointer(3, 1, gl.UNSIGNED_INT, false, 12, 8);
	gl.vertexAttribDivisor(3, 1);

	// =================================================================
	// 🧵 Texture Buffer 0: 接続済み IBO (SamplerBuffer)
	// =================================================================
	const iboBuffer = gl.createBuffer();
	gl.bindBuffer(gl.TEXTURE_BUFFER, iboBuffer);
	gl.bufferData(gl.TEXTURE_BUFFER, new Uint32Array(indicesStream), gl.STATIC_DRAW);

	stitchedIboTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_BUFFER, stitchedIboTex);
	gl.texBuffer(gl.TEXTURE_BUFFER, gl.R32UI, iboBuffer); // 32bit型整数ストリームとして宣言

	// =================================================================
	// 💎 Texture Buffer 1: Morton Pool (BigUint64Array のダイレクト転送)
	// =================================================================
	// GeoPBFから引き抜いた 64bit整数の生配列を、そのままVRAMへ滑り込ませる
	const mortonBuffer = gl.createBuffer();
	gl.bindBuffer(gl.TEXTURE_BUFFER, mortonBuffer);
	gl.bufferData(gl.TEXTURE_BUFFER, buffer, gl.STATIC_DRAW); // CPUでのループ展開は完全ゼロ！

	mortonPoolTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_BUFFER, mortonPoolTex);
	gl.texBuffer(gl.TEXTURE_BUFFER, gl.RG32UI, mortonBuffer); // 64bitを「32bit×2(RG)」としてシェーダーへマッピング！

	gl.bindVertexArray(null);
}

function resize(data) {
	gl.resizeBySize(width = data.width, height = data.height);
	proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
}

// src/workers/gint.js の drawing(data) の完全統合版
function drawing(data) {
	if (!totalPolygons) return; // データロード前ならスキップ

	proj.rotate(data.rotate).scale(data.scale);
	zoom = log2(data.scale * PI * 2 / 256);

	gl.clear(gl.COLOR_BUFFER_BIT);
	if (zoom < 5) return; // ズームが引きすぎている時はLOD制御のため非表示

	// ヤコビアンマトリクス（歪み・回転・スケールの統合演算）の適用
	const jacob = updateJacobian(proj, width, height);
	gl.useProgram(gl.programInstance); // 有効化

	gl.uniformMatrix2fv(gl.jacobian_loc, false, jacob.matrix);
	gl.uniform2iv(gl.center_int_loc, jacob.centerInt);

	// 🌟 現在のズーム（0.0 〜 22.0）に応じて、シェーダー内の1px-LOD閾値（0 〜 63）を動的に叩き込む！
	const SWITCH_ZOOM = 5.0;
	const lodThresh = max(0, 63 - (zoom - SWITCH_ZOOM) * 8); // ズームインするほど閾値が下がり、細かい頂点が出現
	gl.uniform1f(gl.lod_thresh_loc, lodThresh);

	// 🌟 テクスチャバッファのユニット結合（0番と1番を完全確保）
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_BUFFER, stitchedIboTex); // u_stitched_ibo

	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_BUFFER, mortonPoolTex);   // u_morton_pool

	// 🚀 一撃インスタンスドロー（Single Dispatch !!）
	// ループも回さず、数百万の三角形ファンがGPUのコアに直列分散されて一瞬で描画される
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