// t-clock の試料＝同一フレームのオーバーレイが受け取る api.time を main へ返すだけ（依存ゼロ）
let host = null, last = 0;
export function init(canvas, opts, h) { host = h; }
export function message() {}
export function frame(cam, s, size, api) {
	const now = performance.now();
	if (now - last > 100) { last = now; host.post({ time: api?.time ?? null, clock: api?.clock ?? null }); }
	return true;
}
export function destroy() {}
