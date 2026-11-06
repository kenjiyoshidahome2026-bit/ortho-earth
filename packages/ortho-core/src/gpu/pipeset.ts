// WebGPU パイプラインの束（2026-11-06 Galaxy/Mali-G615 実測：起動時に 59 本の createRenderPipeline を GPU プロセスが 1 本ずつ 9.6 秒掛けて作り、
// 描画 worker は命令バッファ満杯で 7 秒止まった）。renderer / gint / text が共有：
//   pipeSet(set, lazy, factories)＝鍵ごとの工場。lazy＝getter で初回アクセス時に作る（memo）／eager＝その場で全部（従来）。
//   どちらも作る間だけ curPipeLabel を立て、工場の中の device.createRenderPipeline({ label: lbl(), … }) が「セット.鍵」を名乗る＝GPU プロセスのトレースで 1 本ずつ読める。
//   named(label, fn)＝束に入らない 1 本に名前を付けて作る。
let curPipeLabel = "";
export const lbl = (): string => curPipeLabel;
export function named<T>(label: string, fn: () => T): T { curPipeLabel = label; try { return fn(); } finally { curPipeLabel = ""; } }
export function pipeSet<T extends object>(set: string, lazy: boolean, f: { [K in keyof T]: () => T[K] }): T {
	const o = {} as T;
	for (const k of Object.keys(f) as Array<keyof T & string>) {
		if (!lazy) { o[k] = named(`${set}.${k}`, f[k]); continue; }
		let v: T[typeof k] | undefined, made = false;
		Object.defineProperty(o, k, { enumerable: true, get: () => { if (!made) { v = named(`${set}.${k}`, f[k]); made = true; } return v; } });
	}
	return o;
}
