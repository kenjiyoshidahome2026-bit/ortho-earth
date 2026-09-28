// 楕円体の測る台（t-ellparity・#43 段 0）の試料を作る＝node tests/fixtures/ell/make.mjs（packages/globe で）
// square.parquet＝東京（139.70, 35.69）から東へ 150m・北へ 100m を中心にした 60m 四方の面 1 枚（GeoParquet）。
//   列チャンク層のキャッシュ（IDB・鍵＝URL＋サイズ）が球と楕円体を跨いで使い回されないかを見る＝URL で配れる物が要る（Blob の URL は頁ごとに変わる）。
//   GeoParquet にするのは、列チャンク層が URL のまま読める（＝キャッシュに入る）のが GeoParquet だから（GeoPBF の読み手は ArrayBuffer/Blob だけ）。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
globalThis.ImageData ??= class ImageData { };   // pbf-base の makeKeys が触る（ブラウザの型）＝Node では空の型で
const { GeoPBF } = await import("geopbf/pbf-base");
const { toGeoParquet } = await import("geopbf/geoparquet");
const LON = 139.70, LAT = 35.69, E = 150, N = 100, S = 60;
const d2 = 111320, dLon = m => m / (d2 * Math.cos(LAT * Math.PI / 180)), dLat = m => m / d2;
const cx = LON + dLon(E), cy = LAT + dLat(N), hx = dLon(S / 2), hy = dLat(S / 2);
const ring = [[cx - hx, cy - hy], [cx + hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy], [cx - hx, cy - hy]];
const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { id: 1, kind: "square" }, geometry: { type: "Polygon", coordinates: [ring] } }] };
const pbf = new GeoPBF({ name: "ell-square" }); await pbf.set(fc);
const { buffer } = await toGeoParquet(pbf, { codec: "gzip", gpu: false, order: "str" });
writeFileSync(fileURLToPath(new URL("./square.parquet", import.meta.url)), Buffer.from(buffer));
console.log("square.parquet", buffer.byteLength, "bytes", { center: [cx, cy] });
