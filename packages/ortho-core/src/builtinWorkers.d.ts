// builtinWorkers.js（JS のまま＝Vite の alias が "./builtinWorkers.js" を文字どおりに差し替える）の型。
import type { WorkerRole } from "./workerFactory.ts";
/** エンジン自身の worker を作る唯一の場所。知らない役割は null。 */
export function builtinWorker(role: WorkerRole): Worker | null;
