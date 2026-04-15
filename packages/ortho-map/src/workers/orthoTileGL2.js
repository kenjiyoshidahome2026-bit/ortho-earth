function orthoTileGL2(gl, dpr) {
    // 1. シェーダーの定義 (GLSL ES 3.00 形式)
    const vsSource = `#version 300 es
        layout(location = 0) in vec2 a_position;
        layout(location = 1) in vec2 a_coords;
        out vec2 v_textCoords;
        void main(void) { 
            v_textCoords = a_coords; 
            gl_Position = vec4(a_position, 0.0, 1.0); 
        }`;
    const fsSource = `#version 300 es
        precision mediump float;
        uniform sampler2D u_texture;
        in vec2 v_textCoords;
        out vec4 outColor;
        void main(void) { 
            outColor = texture(u_texture, v_textCoords); 
        }`;
    function createShader(gl, type, source) {// --- シェーダーコンパイルヘルパー ---
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader));
        }
        return shader;
    }
    const program = gl.createProgram();
    gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    // --- 2. バッファとVAOの初期化 ---
    const coordsBuf = gl.createBuffer();
    const posBuf = gl.createBuffer();
    const vao = gl.createVertexArray();// VAOを作成してバインド（設定の録画開始）
    gl.bindVertexArray(vao);// 頂点位置属性の設定 (location = 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, coordsBuf);// UV座標属性の設定 (location = 1)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null); // 録画終了
    gl.enable(gl.BLEND);// アルファブレンディングの有効化
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    // --- 3. メソッドの実装 --- 
    gl.drawTile = (uvs, positions) => {
        if (!uvs || !positions) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, coordsBuf);// データの転送
        gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STREAM_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STREAM_DRAW);
        gl.bindVertexArray(vao);// 描画（TRIANGLE_STRIP）
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    };
    gl.setImage = (img) => { // 画像からテクスチャを生成
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);// ミップマップ（縮小用画像群）をGPU側で自動生成
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);// 縮小時のフィルタを「ミップマップ線形補間」に変更
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    };
    gl.setTexture = v => gl.bindTexture(gl.TEXTURE_2D, v);
    gl.clearContext = () => (gl.clear(gl.COLOR_BUFFER_BIT), gl);
    gl.resizeBySize = (w, h) => {
        gl.canvas.width = w * dpr; gl.canvas.height = h * dpr;
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    };
    return gl;
}