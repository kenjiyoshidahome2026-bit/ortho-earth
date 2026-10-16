// worldsearch.js（JS のまま）の型。gadgets/searchbox.ts が読む分だけ（TS 化 段 4・batch 2）＝worldsearch.js が TS になれば消える。
import type { SearchHit } from "../globe.d.ts";

/** 世界の既定の問い合わせ先（国・州・都市・地形）。url＝索引の置き場（末尾 /）・lang＝名前の言語（既定＝UI の言語） */
export function createWorldSearch(o?: { url?: string; lang?: string; limit?: number }): { histKey: string; query(q: string, signal?: AbortSignal): Promise<SearchHit[]> };
