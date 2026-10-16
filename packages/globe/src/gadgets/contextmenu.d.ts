// gadgets/contextmenu.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝contextmenu.js が TS になれば消える。
import type { ContextMenuItems, LonLat } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

export type { ContextMenuItems };
/** 右クリックメニュー。戻り値＝項目の setter（二重搭載＝{ setItems }） */
export function contextmenu(this: GlobeMap, opts?: { unprojectAt?: (clientX: number, clientY: number) => LonLat | null; signal?: AbortSignal; items?: ContextMenuItems; [k: string]: unknown }):
	((items: ContextMenuItems) => void) | { setItems(items: ContextMenuItems): void };
