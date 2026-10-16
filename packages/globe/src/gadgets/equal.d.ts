// gadgets/equal.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝equal.js が TS になれば消える。
import type { ContextMenuItem, EqualOptions, LonLat } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** Equal Earth を地図の上に重ねる（center＝全球図の中心・morph:false＝変形なし・view＝全球図の視点・onFrame＝最初の 1 枚の合図） */
export function goEqual(map: GlobeMap, opts?: EqualOptions & { center?: LonLat; morph?: boolean; view?: { zoom: number; lat: number; lon: number }; onFrame?: () => void }): Promise<void>;
/** Equal Earth へのボタン。二重搭載は undefined */
export function equal(this: GlobeMap, opts?: EqualOptions): HTMLButtonElement | undefined;
/** 右クリックメニューの項目「ここを中心に Equal Earth」 */
export function equalHereItem(map: GlobeMap, opts?: EqualOptions): ContextMenuItem;
