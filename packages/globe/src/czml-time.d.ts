// czml-time.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝czml-time.js が TS になれば消える。

/** CZML／GPX の時刻つきの軌跡（trackOf の戻り・中身は czml-time.js の自由） */
export interface CzmlTrack { id?: string; name?: string; [k: string]: unknown }
/** 地心直交（m）→ [lon, lat, h m] */
export function ecefToLlh(x: number, y: number, z: number): [number, number, number];
/** 時刻 ms の位置（地心直交 m）・範囲外は null */
export function positionAt(tr: CzmlTrack, ms: number): [number, number, number] | null;
