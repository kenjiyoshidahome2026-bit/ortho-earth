// @ortho-earth/globe の "#pointcloud-formats" の差し替え先（#178）。アプリの vite で
//   resolve.alias: [{ find: "#pointcloud-formats", replacement: "@ortho-earth/tile-formats/pointcloud" }]
// とすると、globe の COPC の読み手（worker）が LAZ を解けるようになる。解読器（laz-perf）は最初の節で動的 import（起動の束には入らない）。
//   形＝{ [名前]: () => Promise<decode(bytes, { format, recordLength, count }) → Uint8Array> }
//   POINTCLOUD_NAMES＝名前だけ（globe 本体の capabilities 用）。本体はこちらだけを読む＝下の表（動的 import）が本体の束から落ち、laz-web.js が 2 本できない
export const POINTCLOUD_NAMES = ["laz"];
export const POINTCLOUD_FORMATS = {
	laz: () => import("./laz-web.js").then(m => m.decodeLaz),
};
