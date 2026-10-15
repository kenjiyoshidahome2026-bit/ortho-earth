// @ortho-earth/globe の "#pointcloud-formats" の差し替え先（#178）。アプリの vite で
//   resolve.alias: [{ find: "#pointcloud-formats", replacement: "@ortho-earth/tile-formats/pointcloud" }]
// とすると、globe の COPC の読み手（worker）が LAZ を解けるようになる。解読器（laz-perf）は最初の節で動的 import（起動の束には入らない）。
//   形＝{ [名前]: () => Promise<decode(bytes, { format, recordLength, count }) → Uint8Array> }・lazFile＝ファイル丸ごと（普通の LAZ・段 3-3）→ decode(bytes, onBatch(rec, count))
//   POINTCLOUD_NAMES＝名前だけ（globe 本体の capabilities 用）。本体はこちらだけを読む＝下の表（動的 import）が本体の束から落ち、laz-web.ts が 2 本できない
import type { decodeLaz, decodeLazWhole } from "./laz-web.ts";

export interface PointcloudFormats { laz: () => Promise<typeof decodeLaz>; lazFile: () => Promise<typeof decodeLazWhole> }
export const POINTCLOUD_NAMES: string[] = ["laz"];
export const POINTCLOUD_FORMATS: PointcloudFormats = {
	laz: () => import("./laz-web.ts").then(m => m.decodeLaz),
	lazFile: () => import("./laz-web.ts").then(m => m.decodeLazWhole),
};
