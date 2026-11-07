// WebGPU パイプラインの束（2026-11-06 Galaxy/Mali-G615 実測：起動時に 59 本の createRenderPipeline を GPU プロセスが 1 本ずつ 9.6 秒掛けて作り、
// 描画 worker は命令バッファ満杯で 7 秒止まった）。renderer / gint / text が共有：
//   pipeSet(set, lazy, factories)＝鍵ごとの工場。lazy＝getter で初回アクセス時に作る（memo）／eager＝その場で全部（従来）。
//   どちらも作る間だけ curPipeLabel を立て、工場の中の device.createRenderPipeline({ label: lbl(), … }) が「セット.鍵」を名乗る＝GPU プロセスのトレースで 1 本ずつ読める。
//   named(label, fn)＝束に入らない 1 本に名前を付けて作る。
//   warmPipes(set, device, keys)＝lazy の束の指定の鍵を createRenderPipelineAsync で「並列に」先に作る（直し③・2026-11-06）：
//     同期の createRenderPipeline は GPU プロセスの主スレッドが 1 本ずつ処理し（Mali/Vulkan で 0.1〜1.4 秒）、その間 描画 worker の命令バッファが詰まる。
//     Async は Dawn の worker プールで走る＝主スレッドを塞がず、複数本が同時に進む。工場を「記録モード」で呼んで記述子を取り（device.createRenderPipeline を
//     一時的に差し替える）、Async の結果を束のキャッシュへ入れる。失敗（検証エラー等）はキャッシュせず、初回アクセス時に従来の同期生成へ落ちる。
let curPipeLabel = "";
export const lbl = (): string => curPipeLabel;
export function named<T>(label: string, fn: () => T): T { curPipeLabel = label; try { return fn(); } finally { curPipeLabel = ""; } }

interface Rec { set: string; f: Record<string, () => unknown>; cache: Map<string, unknown>; }
const REC = new WeakMap<object, Rec>();

export function pipeSet<T extends object>(set: string, lazy: boolean, f: { [K in keyof T]: () => T[K] }): T {
	const o = {} as T;
	if (!lazy) {
		for (const k of Object.keys(f) as Array<keyof T & string>) o[k] = named(`${set}.${k}`, f[k]);
		return o;
	}
	const rec: Rec = { set, f: f as Record<string, () => unknown>, cache: new Map() };
	REC.set(o, rec);
	for (const k of Object.keys(f) as Array<keyof T & string>) {
		Object.defineProperty(o, k, { enumerable: true, get: () => {
			if (!rec.cache.has(k)) rec.cache.set(k, named(`${set}.${k}`, f[k]));
			return rec.cache.get(k) as T[typeof k];
		} });
	}
	return o;
}

/** 束の鍵が既に作られているか（lazy の束のみ意味がある。eager の束は常に true） */
export function pipeMade(o: object, key: string): boolean { const r = REC.get(o); return !r || r.cache.has(key); }

export interface WarmResult { asked: number; made: number; failed: string[]; ms: number; }
/** lazy の束の keys を createRenderPipelineAsync で並列に先に作る。eager の束（既に全部ある）は何もしない。 */
export async function warmPipes(o: object, device: GPUDevice, keys: readonly string[]): Promise<WarmResult> {
	const t0 = performance.now(); const r = REC.get(o);
	const res: WarmResult = { asked: 0, made: 0, failed: [], ms: 0 };
	if (!r) return res;
	const SENT = {} as GPURenderPipeline;
	const jobs: Promise<void>[] = [];
	for (const k of keys) {
		const f = r.f[k]; if (!f || r.cache.has(k)) continue;
		res.asked++;
		// 記録モード：工場の中の device.createRenderPipeline を記述子の採取に差し替える（インスタンスの own property＝prototype の本物は無事）
		const got: GPURenderPipelineDescriptor[] = [];
		(device as unknown as Record<string, unknown>).createRenderPipeline = (d: GPURenderPipelineDescriptor) => { got.push(d); return SENT; };
		let ret: unknown;
		try { ret = named(`${r.set}.${k}`, f); } finally { delete (device as unknown as Record<string, unknown>).createRenderPipeline; }
		if (ret !== SENT) { r.cache.set(k, ret); continue; }   // 工場が createRenderPipeline を通らなかった（null! 等）＝その値がそのまま答え
		if (got.length !== 1) { res.failed.push(`${k}:${got.length}`); continue; }   // 1 鍵＝1 本の前提が崩れた＝初回アクセス時の同期生成に任せる
		jobs.push(device.createRenderPipelineAsync(got[0]).then(p => { r.cache.set(k, p); res.made++; }, (e: unknown) => { res.failed.push(`${k}:${(e as Error)?.message || e}`); }));
	}
	await Promise.all(jobs);
	res.ms = performance.now() - t0;
	return res;
}
