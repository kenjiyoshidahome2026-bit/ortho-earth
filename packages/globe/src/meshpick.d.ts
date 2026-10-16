// meshpick.js（JS のまま）の型。gadgets の model・tiles3d が読む分だけ（TS 化 段 4・batch 2）＝meshpick.js が TS になれば消える。
import type { LonLat } from "../globe.d.ts";
import type { MeshFeatures } from "./mesh-features.d.ts";
import type { MeshPickEnv } from "./types/install.ts";

/** 当てる束（原点相対の頂点・xf＝剛体変換（L 9＋xt 3）・lift＝原点の向きへの持ち上げ（世界単位）） */
export interface PickItem { pos: ArrayLike<number>; idx: ArrayLike<number>; origin: ArrayLike<number>; xf?: ArrayLike<number> | null; lift?: number; features?: Pick<MeshFeatures, "ids"> | null; hidden?: boolean }
/** 一番手前の当たり（item＝束の番号・w＝奥行き（clip の w）・vertex＝一番近い頂点・world＝当たった点の世界座標） */
export interface MeshPickHit { item: number; tri: number; w: number; featureId: number | null; vertex: number; world: number[] }
export function pickMeshes(items: Array<PickItem | null>, view: MeshPickEnv["view"], x: number, y: number): MeshPickHit | null;
/** 世界座標（β の単位球）→ [経度, 緯度]（度・測地） */
export function lngLatOfWorld(P: ArrayLike<number>): LonLat;
/** feature state の色＝元の頂点色（RGBA8）を地物ごとに差し替えた列。colorOf(id) → [r,g,b(,a)]（0..255）| null（元のまま） */
export function tintColors(col0: Uint8Array, ids: ArrayLike<number> | null | undefined, colorOf: (id: number) => ArrayLike<number> | null): Uint8Array;
