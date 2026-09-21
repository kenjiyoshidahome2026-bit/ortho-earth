// 古地図の見本 public/showcase/edo-nihonbashi-1850.geopbf を作る（node scripts/showcase-edo.mjs '[[lon,lat]×4 左上→右上→右下→左下]'）。
// 入力：SHOWCASE_SRC（既定 .showcase-src/）に kirie-crop.jpg ＝ NDL pid 1286645 の IIIF（…/R0000001/full/3072,/0/default.jpg）から紙の部分を切り出したもの
//       （切り出し枠＝1200px 幅で x236..978・y40..738）。四隅は 4 目印（筋違橋・柳橋・日本橋・新大橋西詰）の最小二乗アフィン。
globalThis.ImageData ??= class ImageData { };
import fs from "node:fs";
import { GeoPBF } from "../../../packages/geopbf/src/pbf.js";
import { quadPolygon, cornersOf } from "../../../packages/geopbf/src/edit/imagequad.js";
const S = process.env.SHOWCASE_SRC || new URL("../.showcase-src/", import.meta.url).pathname;
const corners = JSON.parse(process.argv[2]);
const img = new File([fs.readFileSync(S + "kirie-crop.jpg")], "nihonbashi-kita-1850.jpg", { type: "image/jpeg" });
const credit = "江戸切絵図「日本橋北神田浜町絵図」嘉永3年（1850）景山致恭著・尾張屋清七板／国立国会図書館デジタルコレクション（パブリックドメイン）";
const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: {
	name: "江戸切絵図 日本橋北神田浜町絵図（1850）",
	source: "https://dl.ndl.go.jp/pid/1286645",
	license: "Public Domain Mark (National Diet Library)",
	attribution: '江戸切絵図 日本橋北神田浜町絵図（1850）<a href="https://dl.ndl.go.jp/pid/1286645" target="_blank" rel="noopener">国立国会図書館デジタルコレクション</a>',
	"@image": img,
	"@tip": credit,
}, geometry: quadPolygon(corners) }] };
const pbf = await new GeoPBF().set(fc);
const out = new URL("../public/showcase/", import.meta.url).pathname + "edo-nihonbashi-1850.geopbf";
fs.writeFileSync(out, new Uint8Array(pbf.arrayBuffer));
const back = (await new GeoPBF().set(pbf.arrayBuffer)).geojson.features[0];
console.log(out, fs.statSync(out).size, JSON.stringify(cornersOf(back.geometry)), back.properties["@image"].size);
