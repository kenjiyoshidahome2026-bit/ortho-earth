// gadgets/demo-stub.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝demo-stub.js が TS になれば消える。
import type { DemoHandle, DemoOptions } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** デモ（発表の台本再生）の入口（本体は初回に import）。戻り値＝手綱（本体の到着前はファサード） */
export function demo(this: GlobeMap, opts?: DemoOptions & {
	flyView?: (hash: string, opts?: { glide?: boolean; jump?: boolean }) => unknown; fadeView?: (hash: string, secs: number) => Promise<unknown>;
	glidePath?: (entries: Array<string | { view: string; travel?: number }>) => unknown; flightActive?: () => boolean;
	loadingActive?: () => string; onQuiet?: (views: string[]) => unknown; prefetchViews?: (views: unknown[], names?: string[], onProg?: (p: unknown) => void) => Promise<unknown>;
	finale?: () => void; signal?: AbortSignal; zoomMin?: number; [k: string]: unknown;
}): DemoHandle;
