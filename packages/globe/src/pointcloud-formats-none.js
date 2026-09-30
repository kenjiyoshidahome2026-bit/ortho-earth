// "#pointcloud-formats" の既定＝点群の解読器なし（#178）。LAZ（COPC）を読むアプリは vite の alias でプラグインへ差し替える：
//   { find: "#pointcloud-formats", replacement: "@ortho-earth/tile-formats/pointcloud" }
// globe は laz-perf（Apache-2.0）に依存しない＝差し替えない限り束に入らない。
export const POINTCLOUD_FORMATS = {};
