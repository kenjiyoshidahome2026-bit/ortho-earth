// 列優先の小さな行列算（純関数・依存ゼロ・main と worker の両方が読む）。
// gltf-anim（4x4）・meshdecode・tiles3d-decode・gadgets/model（3x3）・customgl-args・geom-tile（4x4）が逐語コピーで持っていた物を一本化（2026-11-05）。
// 列優先＝glTF／WebGL の並び（m[c*4+r]）。積は a·b＝「b を先に、a を後に」掛ける合成。

/** 4x4 の積 a·b（列優先・Float64Array） */
export const m4mul = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array<ArrayBuffer> => {
	const o = new Float64Array(16);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
	return o;
};

/** 3x3 の積 a·b（列優先・Float64Array） */
export const m3mul = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array<ArrayBuffer> => {
	const o = new Float64Array(9);
	for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c*3+r] = a[r]*b[c*3] + a[3+r]*b[c*3+1] + a[6+r]*b[c*3+2];
	return o;
};

/** 列優先 3x3 × ベクトル */
export const m3v = (m: ArrayLike<number>, v: ArrayLike<number>): number[] => [m[0]*v[0] + m[3]*v[1] + m[6]*v[2], m[1]*v[0] + m[4]*v[1] + m[7]*v[2], m[2]*v[0] + m[5]*v[1] + m[8]*v[2]];
