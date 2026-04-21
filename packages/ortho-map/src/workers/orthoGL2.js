export function orthoGL2(gl, dpr) {
	gl.enable(gl.BLEND);
	gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
	gl.clearColor(0, 0, 0, 0);

	// ==========================================
	// 1. ベース（ER画像）用のプログラム
	// ==========================================
	const baseVs = `#version 300 es
        in vec2 position;
        void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
	const baseFs = `#version 300 es
        precision mediump float;
        uniform sampler2D u_image;
        uniform vec2 translate;
        uniform float scale;
        uniform vec3 rotate;
        out vec4 outColor;
        const float pi = 3.14159265358979323846264;
        const float rad = pi / 180.0;
        void applyRotation(in float rx, in float ry, in float rz, inout float lng, inout float lat) {
            float x, y, coslat, z, dx, dy, dz, cosdy, sindy, cosdz, sindz, k;
            z = sin(lat); coslat = cos(lat);
            x = cos(lng) * coslat; y = sin(lng) * coslat;
            dx = rx * rad; dy = -ry * rad; dz = -rz * rad;
            cosdy = cos(dy); sindy = sin(dy);
            cosdz = cos(dz); sindz = sin(dz);
            k = z * cosdz - y * sindz;
            lng = atan(y * cosdz + z * sindz, x * cosdy + k * sindy) - dx;
            k = k * cosdy - x * sindy;
            k = clamp(k, -0.99999, 0.99999);
            lat = asin(k);
        }
        void main() {
            float x = (gl_FragCoord.x - translate.x) / scale;
            float y = (translate.y - gl_FragCoord.y) / scale;
            float rho = sqrt(x * x + y * y);
            if (rho <= 1.0) {
                float c = asin(rho);
                float sinc = sin(c);
                float cosc = cos(c);
                float lng = atan(x * sinc, rho * cosc);
                float lat = asin(y * sinc / rho);
                applyRotation(rotate.x, rotate.y, rotate.z, lng, lat);
                vec2 uv = vec2((lng + pi) / (2.0 * pi), (lat + pi / 2.0) / pi);
                outColor = texture(u_image, uv);
            } else { discard; }
        }`;
	const baseProgram = createProgram(gl, baseVs, baseFs);
	const baseLocs = {
		position: gl.getAttribLocation(baseProgram, "position"),
		rotate: gl.getUniformLocation(baseProgram, "rotate"),
		scale: gl.getUniformLocation(baseProgram, "scale"),
		translate: gl.getUniformLocation(baseProgram, "translate")
	};
	const baseVao = gl.createVertexArray();
	const baseBuffer = gl.createBuffer();
	gl.bindVertexArray(baseVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, baseBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(baseLocs.position);
	gl.vertexAttribPointer(baseLocs.position, 2, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);

	// ==========================================
	// 2. タイル用のプログラム
	// ==========================================
	const tileVs = `#version 300 es
        layout(location = 0) in vec2 a_position;
        layout(location = 1) in vec2 a_coords;
        out vec2 v_textCoords;
        void main(void) { 
            v_textCoords = a_coords; 
            gl_Position = vec4(a_position, 0.0, 1.0); 
        }`;
	const tileFs = `#version 300 es
        precision mediump float;
        uniform sampler2D u_texture;
        in vec2 v_textCoords;
        out vec4 outColor;
        void main(void) { outColor = texture(u_texture, v_textCoords); }`;
	const tileProgram = createProgram(gl, tileVs, tileFs);
	const tileVao = gl.createVertexArray();
	const tileCoordsBuf = gl.createBuffer();
	const tilePosBuf = gl.createBuffer();
	gl.bindVertexArray(tileVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, tilePosBuf);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, tileCoordsBuf);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);

	// ==========================================
	// 3. テクスチャ生成（ベース用とタイル用）
	// ==========================================

	// ✅ ベースは地球の裏側で繋がるように REPEAT を指定する
	gl.createBaseTexture = img => {
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); // 経度はリピート
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); // 緯度はリピートしない
		return texture;
	};

	// ✅ タイルは隣り合う画像が滲まないように CLAMP_TO_EDGE を指定する
	gl.createTileTexture = img => {
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return texture;
	};

	gl.resizeBySize = (w, h) => {
		gl.canvas.width = w * dpr;
		gl.canvas.height = h * dpr;
		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
		gl.useProgram(baseProgram);
		gl.uniform2f(baseLocs.translate, gl.canvas.width / 2, gl.canvas.height / 2);
	};

	gl.clearContext = () => {
		gl.clear(gl.COLOR_BUFFER_BIT);
		return gl;
	};

	// ==========================================
	// 4. 描画メソッド
	// ==========================================
	gl.drawBase = (texture, proj) => {
		if (!texture || !proj) return gl;
		gl.useProgram(baseProgram);
		gl.bindVertexArray(baseVao);
		gl.bindTexture(gl.TEXTURE_2D, texture);

		gl.uniform3fv(baseLocs.rotate, proj.rotate());
		gl.uniform1f(baseLocs.scale, proj.scale() * dpr);

		gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
		gl.bindVertexArray(null);
		return gl;
	};

	gl.drawTile = (texture, uvs, positions) => {
		if (!texture || !uvs || !positions) return gl;
		gl.useProgram(tileProgram);
		gl.bindVertexArray(tileVao);

		gl.bindBuffer(gl.ARRAY_BUFFER, tileCoordsBuf);
		gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STREAM_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, tilePosBuf);
		gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STREAM_DRAW);

		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		gl.bindVertexArray(null);
		return gl;
	};

	return gl;

	function createProgram(gl, vs, fs) {
		const p = gl.createProgram();
		[vs, fs].forEach((src, i) => {
			const s = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
			gl.attachShader(p, s);
		});
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
		return p;
	}
}