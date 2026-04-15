function orthoBaseGL2(gl, dpr) {
    // WebGL2用シェーダーソース (GLSL 300 es)
    const vsSource = `#version 300 es
    in vec2 position;
    void main() {
        gl_Position = vec4(position, 0.0, 1.0);
    }`;

    const fsSource = `#version 300 es
    precision mediump float;
    uniform sampler2D u_image;
    uniform vec2 translate;
    uniform float scale;
    uniform vec3 rotate;
    out vec4 outColor; // WebGL2では出力先を宣言

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
            
            // WebGL2のtexture関数を使用
            vec2 uv = vec2((lng + pi) / (2.0 * pi), (lat + pi / 2.0) / pi);
            outColor = texture(u_image, uv);
        } else {
            discard; // 範囲外を描画しない
        }
    }`;

    // プログラムの初期化 (ヘルパー関数化するとスッキリします)
    const program = createProgram(gl, vsSource, fsSource);
    gl.useProgram(program);

    const positionLoc = gl.getAttribLocation(program, "position");
    const rotateLoc = gl.getUniformLocation(program, "rotate");
    const scaleLoc = gl.getUniformLocation(program, "scale");
    const translateLoc = gl.getUniformLocation(program, "translate");

    // VAO (Vertex Array Object) の作成
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    // --- メソッド拡張 ---
    gl.setImage = img => {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // WebGL2では内部フォーマットをより詳細に指定可能
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D); // 縮小時の綺麗さのため
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return texture;
    };

    gl.drawByProjection = proj => {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindVertexArray(vao);
        gl.uniform3fv(rotateLoc, proj.rotate());
        gl.uniform1f(scaleLoc, proj.scale() * dpr);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
        return gl;
    };

    gl.resizeBySize = (w, h) => {
        const canvas = gl.canvas;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(translateLoc, canvas.width / 2, canvas.height / 2);
        return gl;
    };

    return gl;

    // --- Helper ---
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