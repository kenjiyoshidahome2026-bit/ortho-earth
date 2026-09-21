// 宇宙＝星座線・メシエ・天体名の 26 言語・月の地名 → GIS/pbf・GIS/space。
// 名前データの正本は packages/space（names.json / moon.json / packs.js）＝ここは bucket へ焼くだけ（world と同じ型）。
import { comma } from "common";
import { geopbf } from "geopbf";
import spaceNamesJSON from "../../../../packages/space/names.json";
import { packs as spacePacks, DIRE as SPACE_DIRE, moonGeoJSON, moonPacks, MOON_GEOPBF } from "../../../../packages/space/packs.js";
import moonJSON from "../../../../packages/space/moon.json";
import constellationLines from "./constellation-lines.json";   // d3-celestial 由来の星座線（旧 main.js に直書きだった 89 星座）

export async function constellations(q) {
	const data = structuredClone(constellationLines);
	data.features.forEach(f => { f.properties.name = f.id; });
	q.clear();
	q.title("constellation lines");
	const pbf = await geopbf(data, { name: "constellation_lines", nocache: true, gint: false });
	if (!pbf.length) throw new Error("constellation_lines: encoding produced 0 features");
	q.log(`constellation_lines: ${pbf.length} features`);
	await pbf.save();
	q.success("constellation_lines: saved");
}

export async function messier(q) {
	const ofrohn = _ => `https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/${_}.json`;
	q.clear();
	q.title("messier");
	const pbf = await geopbf(ofrohn("messier"), { name: "messier", nocache: true, gint: false });
	if (!pbf.length) throw new Error("messier: encoding produced 0 features");
	q.log(`messier: ${pbf.length} features, keys: [${pbf.keys.join(', ')}]`);
	await pbf.save();
	q.success("messier: saved");
}

// 星座名・メシエ通称の 26 言語パック → bucket GIS/space/i18n/<lang>.json（solar が fetch＝コードでなくデータで繋ぐ）
export async function spaceNames(q, { Bucket }) {
	q.clear();
	q.title(`space names → ${SPACE_DIRE}/i18n/<lang>.json`);
	const bucket = await Bucket(SPACE_DIRE);
	if (!bucket) throw new Error(`Bucket(${SPACE_DIRE}) に到達できない`);
	const updated = new Date().toISOString().slice(0, 10);
	for (const [lang, p] of Object.entries(spacePacks(spaceNamesJSON))) {
		const body = JSON.stringify({ updated, ...p });
		await bucket.put(new File([body], `i18n/${lang}.json`, { type: "application/json" }));
		q.log(`${lang}: ${Object.keys(p.c).length} constellations, ${Object.keys(p.m).length} Messier names (${comma(body.length)} bytes)`);
	}
	q.success("space names: saved");
}

// 月の地名（IAU 採択の主な地名 2,023・packages/space/moon.json）→ geopbf "moon_nomenclature"（英語・点・由来つき）＋
// 多言語 bucket GIS/space/i18n/moon/<lang>.json（{ <GPN id>: 名前 }）。座標は月面の経緯度＝読む側が月の球へ貼る
export async function moonNames(q, { Bucket }) {
	q.clear();
	q.title(`moon names → geopbf "${MOON_GEOPBF}" + ${SPACE_DIRE}/i18n/moon/<lang>.json`);
	const pbf = await geopbf(moonGeoJSON(moonJSON), { name: MOON_GEOPBF, nocache: true, gint: false, precision: 4,   // 0.0001°＝月面で約 3 m
		attribution: "IAU / USGS Gazetteer of Planetary Nomenclature (public domain)",
		description: "Moon nomenclature (IAU-approved main features, no satellite craters): selenographic lon/lat (east +), id=GPN Feature ID, code=IAU descriptor, diameter km, origin" });
	if (pbf.length !== moonJSON.features.length) throw new Error(`${MOON_GEOPBF}: ${pbf.length} / ${moonJSON.features.length} features`);
	await pbf.save();
	q.log(`${MOON_GEOPBF}: ${pbf.length} features, keys: [${pbf.keys.join(", ")}]`);
	const bucket = await Bucket(SPACE_DIRE);
	if (!bucket) throw new Error(`Bucket(${SPACE_DIRE}) に到達できない`);
	const updated = new Date().toISOString().slice(0, 10);
	for (const [lang, names] of Object.entries(moonPacks(moonJSON))) {
		const body = JSON.stringify({ updated, names });
		await bucket.put(new File([body], `i18n/moon/${lang}.json`, { type: "application/json" }));
		q.log(`${lang}: ${Object.keys(names).length} names (${comma(body.length)} bytes)`);
	}
	q.success("moon names: saved");
}
