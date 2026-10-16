// transcoders.js（JS のまま）の型。gadgets の model・tiles3d が読む分だけ（TS 化 段 4・batch 2）＝transcoders.js が TS になれば消える。
import type { GlobeMap } from "./types/map.ts";

/** registry.textureTranscoders の写し（worker が import() する変換器の { name, url }） */
export function transcodersOf(map: GlobeMap | null | undefined): Array<{ name: string; url: string }>;
