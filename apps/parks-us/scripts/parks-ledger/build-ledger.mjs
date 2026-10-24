// 台帳 parks-us.json と外周 parks-boundary.geojson（id を持たせる）を組む。入力＝parks-raw.json（Wikidata/Commons/一覧）・states.json・parks-boundary-raw.geojson（NPS）
import fs from "node:fs";
const [rawPath, statesPath, bndPath, outJson, outGeo] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(rawPath, "utf8")), states = JSON.parse(fs.readFileSync(statesPath, "utf8")), bnd = JSON.parse(fs.readFileSync(bndPath, "utf8"));
// 一覧の記事名 → NPS の UNIT_CODE（名前の揺れ＝Glacier (U.S.)・Redwood National and State Parks・Hawaiʻi の ʻ・Wrangell–St. Elias の –）
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[ʻ'’]/g, "").replace(/[–—]/g, "-").replace(/\s*\(U\.S\.\)/, "").replace(/ and Preserve$/, "").replace(/ National and State Parks$/, " National Park").toLowerCase().trim();
const byName = {};
for (const f of bnd.features) { const p = f.properties; if (p.UNIT_TYPE === "National Parks" || p.UNIT_CODE === "NERI") byName[norm(p.UNIT_NAME)] = p.UNIT_CODE; }
const REGION = { AKR: "alaska", PWR: "pacific-west", IMR: "intermountain", MWR: "midwest", SER: "southeast", NER: "northeast" };
const ORDER = ["alaska", "pacific-west", "intermountain", "midwest", "southeast", "northeast"];
const slug = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[ʻ'’.]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const walk = (c, b) => { if (typeof c[0] === "number") { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); } else for (const x of c) walk(x, b); };
const out = [], feats = [];
for (const p of raw) {
	const code = byName[norm(p.title)]; if (!code) { console.error("no boundary:", p.title, norm(p.title)); continue; }
	const fs_ = bnd.features.filter(f => f.properties.UNIT_CODE === code && (f.properties.UNIT_TYPE === "National Parks" || f.properties.UNIT_TYPE === "National Preserves"));
	const id = slug(p.short === "American Samoa" ? "american-samoa" : p.short);
	const bb = [1e9, 1e9, -1e9, -1e9]; for (const f of fs_) walk(f.geometry.coordinates, bb);
	for (const f of fs_) feats.push({ type: "Feature", properties: { id, code, kind: f.properties.UNIT_TYPE === "National Preserves" ? "preserve" : "park", name: f.properties.UNIT_NAME }, geometry: f.geometry });
	const region = REGION[fs_[0].properties.REGION];
	const ph = p.photo || {};
	out.push({ id, key: code, qid: p.qid, region, established: p.established, areaAcres: p.areaAcres, areaKm2: Math.round(p.areaAcres * 0.0040468564224 * 10) / 10, visitors: p.visitors, preserve: fs_.some(f => f.properties.UNIT_TYPE === "National Preserves"),
		states: p.stateCodes, coord: p.coord, bbox: bb.map(x => Math.round(x * 1e4) / 1e4), name: { ...p.name, en: p.name.en || p.title }, wiki: { ...p.wiki, en: p.wiki.en || p.title },
		site: p.site || `https://www.nps.gov/${code.toLowerCase()}/`, desc: p.desc,
		photo: ph.src ? { src: ph.src, thumb: ph.thumb, page: ph.page, artist: ph.artist, license: ph.license, licenseUrl: ph.licenseUrl } : null });
}
out.sort((a, b) => ORDER.indexOf(a.region) - ORDER.indexOf(b.region) || (a.coord?.[0] ?? 0) - (b.coord?.[0] ?? 0));   // 地域の順（西→東）・地域の中も西→東
const doc = { _: "アメリカ合衆国の国立公園 63 の台帳（/globe/parks・parks.html）。名前 26 言語・Wikipedia の頁名・公式サイト＝Wikidata（CC0）／写真＝Wikimedia Commons（各写真の artist/license を表示する義務）／指定日・面積（acre・2023 年の NPS 面積報告）・来訪者（2025）・州＝英語版 Wikipedia「List of national parks of the United States」（出典は NPS）／外周 bbox＝NPS の境界（パブリックドメイン）。生成＝scripts/parks-ledger",
	source: { boundary: "National Park Service, Land Resources Division — NPS Boundary (public domain)", facts: "Wikipedia: List of national parks of the United States (NPS acreage report 2023, visitation 2025)", names: "Wikidata", photos: "Wikimedia Commons" },
	stateNames: Object.fromEntries(Object.entries(states).map(([c, v]) => [c, v.name])), parks: out };
fs.writeFileSync(outJson, JSON.stringify(doc, null, 1));
fs.writeFileSync(outGeo, JSON.stringify({ type: "FeatureCollection", features: feats }));
console.log(out.length, "parks", feats.length, "boundary features", fs.statSync(outJson).size, "bytes;", "no photo:", out.filter(p => !p.photo).map(p => p.id), "; regions:", ORDER.map(r => r + "=" + out.filter(p => p.region === r).length).join(" "));
