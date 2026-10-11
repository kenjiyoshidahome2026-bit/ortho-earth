// NPS の全ユニット（442）の重ね＝種別を 7 群にまとめた属性 group を持たせる（重ねの色分け）。国立公園本体（parks-us.geopbf で描く）は除く
import fs from "node:fs";
const [inPath, outPath] = process.argv.slice(2);
const fc = JSON.parse(fs.readFileSync(inPath, "utf8"));
const GROUP = t => /Monument/.test(t) ? "monument" : /Historic|Memorial|Battlefield|Military|International/.test(t) ? "historic" : /Seashore|Lakeshore|River/.test(t) ? "shore" : /Recreation/.test(t) ? "recreation" : /Preserve|Reserve/.test(t) ? "preserve" : /Trail|Parkway/.test(t) ? "trail" : /National Parks/.test(t) ? "park" : "other";
const feats = fc.features.filter(f => f.properties.UNIT_TYPE !== "National Parks").map(f => ({ type: "Feature", properties: { code: f.properties.UNIT_CODE, name: f.properties.UNIT_NAME, type: f.properties.UNIT_TYPE, group: GROUP(f.properties.UNIT_TYPE || ""), state: f.properties.STATE }, geometry: f.geometry }));
fs.writeFileSync(outPath, JSON.stringify({ type: "FeatureCollection", features: feats }));
const n = {}; for (const f of feats) n[f.properties.group] = (n[f.properties.group] || 0) + 1; console.log(feats.length, n);
