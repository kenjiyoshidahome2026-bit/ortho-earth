// worker の program（tsconfig.worker.json・lib webworker）だけが読む最小の宣言（TS 化 段 4・globe batch 3・ortho-core の types/worker-env.d.ts と同じ）。
// meshworker.ts → native-bucket（DOM 前提の src：Bucket.ts／Fetch.ts）を引く＝lib webworker には window・DOMParser が無い。
// 実行時の振る舞いは変わらない：window は typeof で避けている（worker では self へ落ちる）・DOMParser は xml/html の読み口だけ（meshworker は Cache しか使わない）。
declare var window: EventTarget | undefined;
declare var DOMParser: { new (): { parseFromString(text: string, type: string): unknown } };
