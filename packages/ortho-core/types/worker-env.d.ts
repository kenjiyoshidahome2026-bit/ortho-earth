// worker の program（tsconfig.worker.json・lib webworker）だけが読む最小の宣言（TS 化 段 3・batch G2）。
// elevation/worker.ts → elevation/loader.ts → native-bucket（DOM 前提の src）を引く＝lib webworker には window・DOMParser が無い。
// 実行時の振る舞いは変わらない：window は typeof で避けている（worker では self へ落ちる）・DOMParser は xml/html の読み口だけ（標高の worker は通らない）。
declare var window: EventTarget | undefined;
declare var DOMParser: { new (): { parseFromString(text: string, type: string): unknown } };
