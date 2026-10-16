// gadgets/czml.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝czml.js が TS になれば消える。
import type { Feature } from "geopbf";
import type { Bbox } from "../../globe.d.ts";
import type { CzmlTrack } from "../czml-time.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** CZML・GPX の時刻再生（render worker の組み込み czml・#113） */
export interface CzmlPlayer {
	readonly tracks: CzmlTrack[];
	/** 時刻つきの地物を出す（packets＝CZML の生の packet・clock を読む）。戻り＝出した数 */
	show(features: Feature[], opts?: { packets?: unknown }): number;
	clear(): void;
	/** 時刻つきの地物か */
	isTimed(f: Feature): boolean;
	/** 出している軌跡の範囲 */
	bounds(): Bbox | null;
	/** 点の吹き出し（当たれば true） */
	clickAt(x: number, y: number): boolean;
}
export function createCzmlPlayer(o: { map: GlobeMap; keepUrlClock?: () => boolean }): CzmlPlayer;
