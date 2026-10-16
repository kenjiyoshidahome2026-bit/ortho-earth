// worker-rpc.js（JS のまま）の型。gadgets の model・tiles3d・vtdraw・vtextrude が読む分だけ（TS 化 段 4・batch 2）＝worker-rpc.js が TS になれば消える。

/** worker の口の束（workerPool の戻り）。rpc の答え＝worker の e.data（{ id, … }・error があれば reject）＝形は呼び手が T で言う */
export interface WorkerPool {
	/** 空いている順の 1 本へ */
	rpc<T = unknown>(msg: object, transfer?: Transferable[]): Promise<T>;
	/** その 1 本へ */
	rpc<T = unknown>(w: Worker, msg: object, transfer?: Transferable[]): Promise<T>;
	/** 鍵のハッシュで 1 本に固定 */
	pick(k: string): { w: Worker; i: number };
	next(): Worker;
	readonly workers: Worker[];
	readonly size: number;
	readonly pending: number;
	destroy(): void;
}
export function workerPool(spawn: (i: number) => Worker, opts?: { size?: number; tag?: string }): WorkerPool;
