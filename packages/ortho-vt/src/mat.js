// 最小限の mat4（列優先, WebGL規約）。透視カメラ用。
export function multiply(a, b) {
	const o = new Float64Array(16);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
		let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
		o[c * 4 + r] = s;
	}
	return o;
}

export function perspective(fovy, aspect, near, far) {
	const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
	const o = new Float64Array(16);
	o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1;
	o[14] = 2 * far * near * nf;
	return o;
}

export function lookAt(eye, center, up) {
	let z = norm(sub(eye, center));           // 前方(カメラ→対象の逆)
	let x = norm(cross(up, z));
	let y = cross(z, x);
	const o = new Float64Array(16);
	o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
	o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
	o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
	o[12] = -dot(x, eye); o[13] = -dot(y, eye); o[14] = -dot(z, eye); o[15] = 1;
	return o;
}

export function invert(m) {
	const o = new Float64Array(16), a = m;
	const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
	const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
	const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
	const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
	let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) return null; det = 1 / det;
	o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
	o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
	o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
	o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
	o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
	o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
	o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
	o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
	o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
	o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
	o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
	o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
	o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
	o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
	o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
	o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
	return o;
}

// m(列優先) × v(vec4) → vec4
export function transform(m, v) {
	const o = new Array(4);
	for (let r = 0; r < 4; r++) o[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3];
	return o;
}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const toF32 = m => Float32Array.from(m);
