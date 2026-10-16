// gadgets/searchbox.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝searchbox.js が TS になれば消える。
import type { SearchOptions } from "../../globe.d.ts";
import type { SearchProvider } from "../types/scope.ts";
import type { GlobeMap } from "../types/map.ts";

/** 地名・住所の検索の窓（provider＝地域の申告の供給元）。問い合わせ先が無い・二重搭載は undefined */
export function search(this: GlobeMap, opts?: Omit<SearchOptions, "provider"> & { provider?: SearchOptions["provider"] | SearchProvider | SearchProvider[] | null; signal?: AbortSignal; [k: string]: unknown }): HTMLDivElement | undefined;
