// ?perf=1：Cesium の層の毎フレームの CPU ms を名ごとに貯め、2 秒ごとに [csperf] 行（名=平均/最大 ms・呼ばれた回数）で console へ出す
// （改善計画 段階 0＝display の JSON 比較・collections の弧・primitives の作り直しが本当に重いかを測ってから手を入れる）
const on = typeof location !== "undefined" && /[?&]perf=1/.test(location.search);
const acc = new Map<string, { n: number; ms: number; max: number }>();
let since = 0;

/** f を測る（?perf=1 の時だけ・それ以外はそのまま呼ぶ） */
export function timed<T>(name: string, f: () => T): T {
	if (!on) return f();
	const t0 = performance.now();
	try { return f(); }
	finally {
		const t1 = performance.now(), ms = t1 - t0;
		let a = acc.get(name);
		if (!a) acc.set(name, a = { n: 0, ms: 0, max: 0 });
		a.n++; a.ms += ms; if (ms > a.max) a.max = ms;
		if (!since) since = t1;
		else if (t1 - since > 2000) {
			console.log("[csperf] " + [...acc].map(([k, v]) => `${k}=${(v.ms / v.n).toFixed(2)}/${v.max.toFixed(1)}ms×${v.n}`).join(" "));
			acc.clear(); since = t1;
		}
	}
}
