// ?drawstat=1（診断）：render worker が 1 コマに出している描画命令を、パイプラインの名前ごとに数える。
// 2026-11-17 Galaxy（4GB・Mali）：UNMAP を z7 まで寄せると 1 回の描画が約 84 ms・地形を消しても 57 ms・解像度に依らない
// ＝画素ではなく「描く物の量」で詰まっている。どのパイプラインが何回・何万三角形を出しているかを実測する。
// 仕組み＝GPURenderPassEncoder の setPipeline／draw／drawIndexed と GPUCommandEncoder の beginRenderPass を包んで数えるだけ
// （renderer には手を入れない）。切の時は何も包まない＝本番の経路は変わらない。
type Row = { calls: number; n: number };
const acc = new Map<string, Row>();
let passes = 0, on = false;

type Proto = Record<string, (...a: unknown[]) => unknown>;
export function installDrawStat(): boolean {
	if (on) return true;
	const g = globalThis as unknown as { GPURenderPassEncoder?: { prototype: Proto }; GPUCommandEncoder?: { prototype: Proto } };
	const P = g.GPURenderPassEncoder?.prototype, E = g.GPUCommandEncoder?.prototype;
	if (!P || !E) return false;
	const cur = new WeakMap<object, string>();
	const add = (pass: object, n: number) => {
		const k = cur.get(pass) || "?";
		let r = acc.get(k); if (!r) acc.set(k, r = { calls: 0, n: 0 });
		r.calls++; r.n += n;
	};
	const sp = P.setPipeline, d = P.draw, di = P.drawIndexed, bp = E.beginRenderPass;
	P.setPipeline = function (this: object, p: unknown) { cur.set(this, (p as { label?: string })?.label || "?"); return sp.call(this, p); };
	P.draw = function (this: object, ...a: unknown[]) { add(this, (Number(a[0]) || 0) * (a[1] == null ? 1 : Number(a[1]))); return d.apply(this, a); };
	P.drawIndexed = function (this: object, ...a: unknown[]) { add(this, (Number(a[0]) || 0) * (a[1] == null ? 1 : Number(a[1]))); return di.apply(this, a); };
	E.beginRenderPass = function (this: object, ...a: unknown[]) { passes++; return bp.apply(this, a); };
	return on = true;
}
/** 前回からの累計を frames コマで割って 1 行にする：`p<パス数> c<命令数> t<三角形 千> | 名前:命令数/三角形 千 …`（三角形の多い順・上位 top 本）。切なら "" */
export function drawStatLine(frames: number, top = 14): string {
	if (!on) return "";
	const f = Math.max(1, frames), rows = [...acc].sort((a, b) => b[1].n - a[1].n);
	let calls = 0, n = 0;
	for (const [, r] of rows) { calls += r.calls; n += r.n; }
	const k = (v: number) => (v / 3 / f / 1000).toFixed(1);
	const s = `p${(passes / f).toFixed(1)} c${Math.round(calls / f)} t${k(n)}k | ` + rows.slice(0, top).map(([name, r]) => `${name}:${Math.round(r.calls / f)}/${k(r.n)}k`).join(" ");
	acc.clear(); passes = 0;
	return s;
}
