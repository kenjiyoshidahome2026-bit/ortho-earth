// t-color: 色らしい文字列の往復（B6・2026-09-25）。保存→読み戻しで文字列が一字一句変わらないこと。
// 色（4 バイト）で持つのは正規形 rgb(r,g,b)・rgba(r,g,b,0.xx) だけ＝それ以外は文字列のまま。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf-base.js";
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const vals = ["#1234", "#12345", "#123", " #123 ", "#abcdef", "#ABCDEF", "rgb(1.5,2,3)", "rgb(1, 2, 3)", "rgb(300,0,0)", "rgb(01,2,3)",
	"rgb(17,34,51)", "rgba(1,2,3,0.50)", "rgba(1,2,3,0.3)", "red", "#", "rgba(0,0,0,0.00)"];
const src = await new GeoPBF().set({ type: "FeatureCollection", features: vals.map(v => ({ type: "Feature", properties: { c: v }, geometry: { type: "Point", coordinates: [0, 0] } })) });
const back = await new GeoPBF().set(src.arrayBuffer);
for (let i = 0; i < vals.length; i++) ok(back.getProperties(i).c === vals[i], `往復で変わらない：${JSON.stringify(vals[i])} → ${JSON.stringify(back.getProperties(i).c)}`);
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
