// PLATEAU PoC - 変換済みバイナリ読み込み + WebGL2 逐次描画

const W = window.innerWidth, H = window.innerHeight;
const canvas = document.getElementById('c');
canvas.width = W; canvas.height = H;
const gl = canvas.getContext('webgl2');
const info = document.getElementById('info');

// --- WebGL2 setup ---
const VS = `#version 300 es
in vec3 a_pos;
uniform vec2 u_sc;
uniform vec3 u_east;
uniform vec3 u_north;
uniform float u_k;
uniform vec2 u_res;
void main() {
	float e = dot(a_pos, u_east);
	float n = dot(a_pos, u_north);
	vec2 s = u_sc + vec2(e, -n) * u_k;
	vec2 clip = (s / u_res) * 2.0 - 1.0;
	gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.24, 0.63, 1.0, 0.7); }`;

function compile(type, src) {
	const s = gl.createShader(type);
	gl.shaderSource(s, src); gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
	return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
gl.useProgram(prog);

const loc = {
	pos:   gl.getAttribLocation(prog, 'a_pos'),
	sc:    gl.getUniformLocation(prog, 'u_sc'),
	east:  gl.getUniformLocation(prog, 'u_east'),
	north: gl.getUniformLocation(prog, 'u_north'),
	k:     gl.getUniformLocation(prog, 'u_k'),
	res:   gl.getUniformLocation(prog, 'u_res'),
};
gl.uniform2f(loc.res, W, H);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// タイルキャッシュ
const tiles = [];

// --- 描画 ---
// 密集エリア(丸の内〜大手町)を中心に。皇居は千代田区南西側なので北に寄せる
let viewLon = 139.758, viewLat = 35.694;
// 1km を画面幅の 70% に収める (2.35km → 1.0km, 3倍ズーム)
let scale = (W * 0.35) / (0.5 / 6371);

function render() {
	gl.viewport(0, 0, W, H);
	gl.clearColor(0.067, 0.067, 0.067, 1);
	gl.clear(gl.COLOR_BUFFER_BIT);

	const cosV = Math.cos(viewLat * Math.PI / 180);
	const kp   = scale * Math.PI / 180;

	for (const t of tiles) {
		const scx = W/2 + kp * (t.lonlat[0] - viewLon) * cosV;
		const scy = H/2 - kp * (t.lonlat[1] - viewLat);
		gl.uniform2f(loc.sc, scx, scy);
		gl.uniform3fv(loc.east,  t.eastVec);
		gl.uniform3fv(loc.north, t.northVec);
		gl.uniform1f(loc.k, scale / t.earthR);
		gl.bindBuffer(gl.ARRAY_BUFFER, t.vbo);
		gl.enableVertexAttribArray(loc.pos);
		gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
		gl.drawArrays(gl.TRIANGLES, 0, t.count);
	}
}

// --- インタラクション ---
let dragging = false, lastX = 0, lastY = 0, zoomTimer = null;

canvas.addEventListener('wheel', e => {
	e.preventDefault();
	scale *= e.deltaY < 0 ? 1.06 : 1 / 1.06;
	clearTimeout(zoomTimer);
	zoomTimer = setTimeout(render, 150);
}, { passive: false });

// 座標表示
canvas.addEventListener('mousemove', e => {
	if (dragging) return;
	const kp = scale * Math.PI / 180;
	const cosV = Math.cos(viewLat * Math.PI / 180);
	const lon = viewLon + (e.clientX - W/2) / kp / cosV;
	const lat = viewLat - (e.clientY - H/2) / kp;
	document.getElementById('info').textContent =
		`${lon.toFixed(5)}, ${lat.toFixed(5)}\nWheel: zoom  Drag+release: pan`;
});

canvas.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mouseup', () => { if (dragging) { dragging = false; render(); } });
canvas.addEventListener('mousemove', e => {
	if (!dragging) return;
	const dx = e.clientX - lastX, dy = e.clientY - lastY;
	lastX = e.clientX; lastY = e.clientY;
	const kp = scale * Math.PI / 180;
	viewLon -= dx / kp / Math.cos(viewLat * Math.PI / 180);
	viewLat += dy / kp;
});

// --- ロード（変換済みバイナリ）---
async function main() {
	info.textContent = 'Loading index...';
	render();

	const index = await (await fetch('/plateau/index.json')).json();
	let totalTri = 0;

	// タイルを並列フェッチ → 届いた順に VBO 作成 & 描画
	const tasks = index.map(async (meta, i) => {
		const res  = await fetch(`/plateau/${meta.file}`);
		const ab   = await res.arrayBuffer();
		const data = new Float32Array(ab);

		const vbo = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

		tiles.push({
			lonlat:   meta.lonlat,
			earthR:   meta.earthR,
			eastVec:  meta.eastVec,
			northVec: meta.northVec,
			vbo,
			count: data.length / 3,
		});
		totalTri += meta.triCount;
		render(); // タイルが届くたびに即描画
		info.textContent = `${tiles.length}/${index.length} tiles  ${totalTri.toLocaleString()} tri`;
	});

	await Promise.all(tasks);
	info.textContent = `Done — ${totalTri.toLocaleString()} triangles\nWheel: zoom  Drag+release: pan`;
	render();
}

main().catch(e => { info.textContent = `Error: ${e.message}`; console.error(e); });
