// demo/scene-adapter.js（JS のまま）の型。gadgets/demo.ts が読む分だけ（TS 化 段 4・batch 2）＝scene-adapter.js が TS になれば消える。

/** via 行（通過点）→ 着点シーンの path:[{view,travel}…] へ畳む。via の無い台本は同じ配列（恒等）。trace.group＝入力行 → 畳み込み後の index */
export function compileVias<T>(rows: T[], issues?: unknown[], trace?: { group?: number[] }): T[];
