// "#pointcloud-formats" の既定＝点群の解読器なし（#178）。LAZ（COPC）を読むアプリは vite の alias でプラグインへ差し替える：
//   { find: "#pointcloud-formats", replacement: "@ortho-earth/tile-formats/pointcloud" }
// globe は laz-perf（Apache-2.0）に依存しない＝差し替えない限り束に入らない。
/** 解読器の表（"#pointcloud-formats" の形・@ortho-earth/tile-formats/pointcloud の PointcloudFormats と同じ鍵）＝laz＝COPC の節・lazFile＝ファイル丸ごと */
export interface PointcloudFormats {
	laz?: () => Promise<(bytes: Uint8Array | ArrayBuffer, opts: { format: number; recordLength: number; count: number }) => Promise<Uint8Array>>;
	lazFile?: () => Promise<(bytes: Uint8Array | ArrayBuffer, onBatch: (rec: Uint8Array, count: number) => void) => Promise<{ recordLength: number }>>;
}
export const POINTCLOUD_NAMES: string[] = [];
export const POINTCLOUD_FORMATS: PointcloudFormats = {};
