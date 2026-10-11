// NPS の境界（ArcGIS FeatureServer・パブリックドメイン）→ 国立公園 63（Park＋Preserve を同じ id に・kind で区別）の GeoJSON。
// maxAllowableOffset（度）で間引き・geometryPrecision で桁を落とす（日本版の DP 0.0005° と同じ尺）
import fs from "node:fs";
const [codesPath, outPath, offset = "0.0005", where = ""] = process.argv.slice(2);
const UA = { "User-Agent": "ortho-earth-parks/0.1 (kenji.yoshida.home.2026@gmail.com)" };
const B = "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2/query";
const codes = codesPath === "-" ? null : JSON.parse(fs.readFileSync(codesPath, "utf8"));
const W = codes ? `UNIT_CODE IN (${codes.map(c => `'${c}'`).join(",")}) AND UNIT_TYPE IN ('National Parks','National Preserves')` : (where || "1=1");
const feats = [];
for (let off = 0; ; off += 100) {
	const u = `${B}?where=${encodeURIComponent(W)}&outFields=UNIT_CODE,UNIT_NAME,UNIT_TYPE,STATE,REGION&outSR=4326&geometryPrecision=5&maxAllowableOffset=${offset}&resultOffset=${off}&resultRecordCount=100&f=geojson`;
	let j; for (let i = 0; i < 4; i++) { const r = await fetch(u, { headers: UA }); if (r.ok) { j = await r.json(); break; } console.error("retry", r.status); await new Promise(s => setTimeout(s, 3000)); }
	if (!j?.features) throw new Error(JSON.stringify(j).slice(0, 300));
	feats.push(...j.features); console.error("got", feats.length);
	if (!j.properties?.exceededTransferLimit && j.features.length < 100) break;
}
fs.writeFileSync(outPath, JSON.stringify({ type: "FeatureCollection", features: feats }));
console.log(feats.length, "features", fs.statSync(outPath).size, "bytes");
