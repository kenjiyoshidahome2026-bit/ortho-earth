#!/usr/bin/env node
// 月の地名の常設検定：正本（moon.json）の形・範囲・取り違えの疑い・パックと GeoJSON の形
import fs from "node:fs";
import { LANGS, moonGeoJSON, moonPacks } from "../packs.js";
let fail = 0;
const check = (name, ok, info = "") => { if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`); };
const { features: F } = JSON.parse(fs.readFileSync(new URL("../moon.json", import.meta.url), "utf8"));
const CODES = new Set(["AA", "RI", "LF", "MO", "DO", "ME", "LC", "CA", "VA", "SI", "PR", "RU", "ST", "PA", "AL", "PL", "OC"]);
check("2,023 main features (no satellite craters)", F.length === 2023 && !F.some(f => / [A-Z]{1,2}$/.test(f.name) && f.code === "AA" && /^[A-Z]$/.test(f.name.split(" ").pop())), `${F.length}`);
check("ids are unique GPN numbers", new Set(F.map(f => f.id)).size === F.length && F.every(f => Number.isInteger(f.id) && f.id > 0));
check("coordinates on the Moon (lon -180..180, lat -90..90)", F.every(f => f.lon >= -180 && f.lon <= 180 && f.lat >= -90 && f.lat <= 90));
check("known IAU feature codes", F.every(f => CODES.has(f.code)), [...new Set(F.map(f => f.code).filter(c => !CODES.has(c)))].join());
check("every feature has an English name, diameter (0 = point sites such as landing sites) and origin", F.every(f => f.name && f.diameter >= 0 && f.origin));
check("names use only the 25 non-English languages", F.every(f => Object.keys(f.names).every(l => LANGS.includes(l) && l !== "en")));
check("no localized name equals the English (IAU) name", F.every(f => Object.values(f.names).every(v => v !== f.name)));
for (const l of LANGS.slice(1)) {
	const seen = new Map(), dup = [];
	for (const f of F) { const v = f.names[l]; if (!v) continue; if (seen.has(v)) dup.push(`${seen.get(v)}/${f.name}=${v}`); seen.set(v, f.name); }
	if (dup.length) check(`${l}: no duplicate names`, false, dup.slice(0, 4).join(" "));
}
const seas = F.filter(f => ["ME", "OC", "LC", "SI", "PA"].includes(f.code));
check("maria, lakes, bays and marshes all have Japanese names", seas.every(f => f.names.ja), seas.filter(f => !f.names.ja).map(f => f.name).join());
const known = n => F.find(f => f.name === n);
check("spot check: 静かの海・嵐の大洋・ティコ・静かの基地", known("Mare Tranquillitatis").names.ja === "静かの海" && known("Oceanus Procellarum").names.ja === "嵐の大洋" && known("Tycho").names.ja === "ティコ" && known("Statio Tranquillitatis").names.ja === "静かの基地");
check("Statio Tranquillitatis near the Apollo 11 site (0.67N 23.47E)", Math.hypot(known("Statio Tranquillitatis").lat - 0.67, known("Statio Tranquillitatis").lon - 23.47) < 0.2);
const g = moonGeoJSON({ features: F }), P = moonPacks({ features: F });
check("GeoJSON: points with English properties", g.features.length === F.length && g.features.every(x => x.geometry.type === "Point" && x.properties.name && !("names" in x.properties)));
check("packs: 25 languages keyed by id", Object.keys(P).length === 25 && P.ja[F.find(f => f.name === "Mare Imbrium").id] === "雨の海");
console.log(fail ? `\nFAIL  ${fail}` : "\nPASS");
process.exit(fail ? 1 : 0);
