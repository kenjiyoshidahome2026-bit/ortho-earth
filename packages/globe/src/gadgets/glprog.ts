// overlay の GL2 描き手（arcs・points・trips・sprites・copc・customgl・columnar）が共有する小物（2026-10-31・7 個の写しを 1 つに）。
// glProgram＝VS/FS を組んで全 uniform の場所を引く（失敗は投げる）・readPickWindow＝ピックの FBO から (x,y) 中心の (2r+1)² 窓を読む・
// decodeId／nearestId＝読んだ窓から中心に一番近い 0 でない番号（純関数・node の検定 tests/pick.mjs が points-gl 経由で読む）。

export type Uniforms = Record<string, WebGLUniformLocation | null>;

/** 組んだ program と、そこにある全 uniform の場所。withSrc＝組めなかった時、投げる文に FS/VS の本文を添える（columnar） */
export function glProgram(gl: WebGL2RenderingContext, vs: string, fs: string, withSrc = false): { p: WebGLProgram; u: Uniforms } {
	const mk = (type: GLenum, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(withSrc ? gl.getShaderInfoLog(s) + "\n" + src : gl.getShaderInfoLog(s)!); return s; };
	const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
	const u: Uniforms = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl.getActiveUniform(p, i)!.name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}

/** 今の FRAMEBUFFER（w×h）から、画面座標 (x,y)（上が 0）を中心に半径 r の正方窓を読む。窓が端にかかる分は 0 のまま（canvas の外は当たらない）。GL は下が 0 */
export function readPickWindow(gl: WebGL2RenderingContext, x: number, y: number, r: number, w: number, h: number): { data: Uint8Array; side: number } {
	const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;
	const data = new Uint8Array(side * side * 4);
	const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
	if (cx1 > cx0 && cy1 > cy0) {
		const sub = new Uint8Array((cx1 - cx0) * (cy1 - cy0) * 4);
		gl.readPixels(cx0, cy0, cx1 - cx0, cy1 - cy0, gl.RGBA, gl.UNSIGNED_BYTE, sub);
		for (let j = 0; j < cy1 - cy0; j++) data.set(sub.subarray(j * (cx1 - cx0) * 4, (j + 1) * (cx1 - cx0) * 4), ((j + cy0 - y0) * side + (cx0 - x0)) * 4);
	}
	return { data, side };
}

// 読んだ窓（RGBA8・side×side・GL の並び＝下の行が先）から中心に一番近い 0 でない番号を選ぶ
export const decodeId = (r: number, g: number, b: number, a: number): number => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
export function nearestId(data: ArrayLike<number>, side: number, flipY = true) {
	const c = (side - 1) / 2;
	let best: { id: number; distance: number; dx: number; dy: number } | null = null;
	for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
		const k = (j * side + i) * 4, id = decodeId(data[k], data[k + 1], data[k + 2], data[k + 3]);
		if (!id) continue;
		const dy = flipY ? (side - 1 - j) - c : j - c, dx = i - c, d = Math.hypot(dx, dy);
		if (!best || d < best.distance) best = { id, distance: d, dx, dy };
	}
	return best;
}
