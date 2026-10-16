// modules/workerFactory.js の型（TS化 段 3・cog／convert の pool が読む分だけ）。modules/workerFactory.js が .ts になったらこのファイルは消す
export function setWorkerFactory(fn: ((role: string) => Worker | null | undefined) | null): void;
export const hasWorkerFactory: () => boolean;
/** fallback を渡せば必ず Worker（ホスト工場が無い／失敗したときは fallback() の戻り） */
export function spawnWorker(role: string, fallback: () => Worker): Worker;
export function spawnWorker(role: string, fallback?: (() => Worker) | null): Worker | null;
