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
/** 作ったパイプラインの帳（label・JS 側の所要 ms・performance.now()）。createRenderPipeline（同期）は内容側では即返り、GPU プロセスのコンパイルは
 *  後の submit で待たされる＝ms は小さくても「どのフレームで何本頼んだか」が詰まりの前後関係を語る（2026-11-07 Galaxy：frame1 後の 4〜5 s の GPU 待ち）。上限 200 本 */
export interface PipeLogEntry { label: string; ms: number; at: number; }
const PIPE_LOG: PipeLogEntry[] = [];
export const pipeLog = (): readonly PipeLogEntry[] => PIPE_LOG;
export function named<T>(label: string, fn: () => T): T {
	curPipeLabel = label; const t0 = performance.now();
	try { return fn(); } finally { curPipeLabel = ""; if (PIPE_LOG.length < 200) PIPE_LOG.push({ label, ms: performance.now() - t0, at: t0 }); }
}

interface Rec { set: string; f: Record<string, () => unknown>; cache: Map<string, unknown>; pending: Set<string>; }   // pending＝warmPipesBg が Async で作っている途中の鍵（getter は null を返す＝描き手はその層を飛ばす）
const REC = new WeakMap<object, Rec>();

export function pipeSet<T extends object>(set: string, lazy: boolean, f: { [K in keyof T]: () => T[K] }): T {
	const o = {} as T;
	if (!lazy) {
		for (const k of Object.keys(f) as Array<keyof T & string>) o[k] = named(`${set}.${k}`, f[k]);
		return o;
	}
	const rec: Rec = { set, f: f as Record<string, () => unknown>, cache: new Map(), pending: new Set() };
	REC.set(o, rec);
	for (const k of Object.keys(f) as Array<keyof T & string>) {
		Object.defineProperty(o, k, { enumerable: true, get: () => {
			if (rec.pending.has(k)) return null as unknown as T[typeof k];   // 進行描き（warmPipesBg）＝コンパイル中は null＝呼び手がその層を飛ばす（同期生成で GPU プロセスを塞がない）
			if (!rec.cache.has(k)) rec.cache.set(k, named(`${set}.${k}`, f[k]));
			return rec.cache.get(k) as T[typeof k];
		} });
	}
	return o;
}

/** 束の鍵が既に作られているか（lazy の束のみ意味がある。eager の束は常に true） */
export function pipeMade(o: object, key: string): boolean { const r = REC.get(o); return !r || r.cache.has(key); }
/** 束の鍵が warmPipesBg でコンパイル中か（この間 getter は null） */
export function pipePending(o: object, key: string): boolean { const r = REC.get(o); return !!r && r.pending.has(key); }

/** 進行描き（?warmpipe=3・2026-11-07 Galaxy）：keys を createRenderPipelineAsync で「待たずに」作り始める。できるまで getter は null＝描き手はその層を
 *  飛ばし、1 本できるごとに onReady（＝requestDraw）で次のフレームを頼む。シェーダキャッシュが冷えた初回（deploy 直後）に frame1 が 10 本ぶん（4〜9 s）待たず、
 *  地球と地形だけ先に出て、線・建物・メッシュはコンパイルが済んだ順に現れる。Async は Dawn の worker プールで走る＝GPU プロセスの主スレッドを塞がない＝
 *  描画 worker の writeBuffer も待たない。失敗（検証エラー等）はキャッシュせず pending を外す＝初回アクセス時の同期生成へ落ちる。 */
export function warmPipesBg(o: object, device: GPUDevice, keys: readonly string[], onReady?: (key: string) => void): { asked: number; done: Promise<WarmResult> } {
	const t0 = performance.now(); const r = REC.get(o);
	const res: WarmResult = { asked: 0, made: 0, failed: [], ms: 0 };
	if (!r) return { asked: 0, done: Promise.resolve(res) };
	const SENT = {} as GPURenderPipeline;
	const jobs: Promise<void>[] = [];
	for (const k of keys) {
		const f = r.f[k]; if (!f || r.cache.has(k) || r.pending.has(k)) continue;
		const got: GPURenderPipelineDescriptor[] = [];
		(device as unknown as Record<string, unknown>).createRenderPipeline = (d: GPURenderPipelineDescriptor) => { got.push(d); return SENT; };
		let ret: unknown;
		try { ret = named(`${r.set}.${k}`, f); } finally { delete (device as unknown as Record<string, unknown>).createRenderPipeline; }
		if (ret !== SENT) { r.cache.set(k, ret); continue; }
		if (got.length !== 1) { res.failed.push(`${k}:${got.length}`); continue; }
		res.asked++; r.pending.add(k);
		const tk = performance.now();
		jobs.push(device.createRenderPipelineAsync(got[0]).then(p => { r.cache.set(k, p); res.made++; if (PIPE_LOG.length < 200) PIPE_LOG.push({ label: `${r.set}.${k}(bg)`, ms: performance.now() - tk, at: tk }); }, (e: unknown) => { res.failed.push(`${k}:${(e as Error)?.message || e}`); }).then(() => { r.pending.delete(k); onReady?.(k); }));
	}
	return { asked: res.asked, done: Promise.all(jobs).then(() => { res.ms = performance.now() - t0; return res; }) };
}

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
		jobs.push(device.createRenderPipelineAsync(got[0]).then(p => { r.cache.set(k, p); res.made++; if (PIPE_LOG.length < 200) PIPE_LOG.push({ label: `${r.set}.${k}(async)`, ms: performance.now() - t0, at: t0 }); }, (e: unknown) => { res.failed.push(`${k}:${(e as Error)?.message || e}`); }));
	}
	await Promise.all(jobs);
	res.ms = performance.now() - t0;
	return res;
}
