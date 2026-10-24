// 5) 座標が取れなかった記事の位置を推定する（Kenji 指示 2026-10-06: 座標不明でも検索して推定する）
//    順: a. Nominatim(OSM) で名称そのものを検索（OSM に温泉のノードがあれば一致）→ precision "name"
//        b. 国土地理院 住所検索 API に Template:温泉 の所在地を渡す → "address"
//        c. 都道府県＋市町村の中心 → "municipality"
//    出力: geocode.json = { "ja:<pageid>"|"wd:<QID>": { coord:[lon,lat], source, precision, query, matched } }
//    OSM の座標は ODbL（出典表示: © OpenStreetMap contributors）、地理院は国土地理院コンテンツ利用規約（出典表示）。
import { getJSON, readJSON, writeJSON, inJapan, PREF_RE, ROOT } from "./lib.mjs";
import fs from "node:fs"; import path from "node:path";

const NOMINATIM = process.env.NOMINATIM || "https://nominatim.openstreetmap.org/search";
const GSI = process.env.GSI || "https://msearch.gsi.go.jp/address-search/AddressSearch";
const articles = readJSON("articles.json"), wd = readJSON("wikidata.json");
const prev = fs.existsSync(path.join(ROOT, "geocode.json")) ? readJSON("geocode.json") : {};
const out = {};

/** 04-build と同じ優先順で既知の座標を探す（無ければ null） */
const known = a => { const w = a.qid ? wd[a.qid] : null; return [a.coord, a.tplCoord, a.textCoord, w?.coord].find(inJapan) || null; };
const cleanAddr = s => (s || "").replace(/〒?\d{3}-?\d{4}/g, "").replace(/\s*[（(].*?[）)]/g, "").replace(/[\s　]+/g, "").split(/[、,／\/]/)[0];

async function nominatim(q) {
  const j = await getJSON(`${NOMINATIM}?format=jsonv2&countrycodes=jp&limit=5&accept-language=ja&q=${encodeURIComponent(q)}`, { tag: "geo-osm" });
  return Array.isArray(j) ? j : [];
}
async function gsi(q) {
  const j = await getJSON(`${GSI}?q=${encodeURIComponent(q)}`, { tag: "geo-gsi" });
  return Array.isArray(j) ? j : [];
}
async function estimate(id, name, pref, muni, address) {
  const base = name.replace(/ \(.*\)$/, "");
  // a. 名称で OSM を検索。表示名に名称（「温泉」を除いた芯）が含まれる候補だけ採る。
  const core = base.replace(/温泉郷?$|鉱泉$/, "");
  if (core.length >= 2) for (const q of [pref ? `${base} ${pref}` : base, base]) {
    const hits = (await nominatim(q)).filter(h => inJapan([+h.lon, +h.lat]) && (h.name || h.display_name || "").includes(core) && (!pref || (h.display_name || "").includes(pref)));
    if (hits.length) return { coord: [+(+hits[0].lon).toFixed(6), +(+hits[0].lat).toFixed(6)], source: "estimate:osm-name", precision: "name", query: q, matched: hits[0].display_name };
  }
  // b. 所在地の住所
  const addr = cleanAddr(address);
  if (addr && PREF_RE.test(addr)) {
    const hits = (await gsi(addr)).filter(h => inJapan(h.geometry.coordinates));
    if (hits.length) { const t = hits[0].properties.title; const prec = t.replace(/^.*?(市|区|町|村)/, "").length > 0 ? "address" : "municipality"; return { coord: hits[0].geometry.coordinates.map(v => +v.toFixed(6)), source: "estimate:gsi-address", precision: prec, query: addr, matched: t }; }
  }
  // c. 都道府県＋市町村
  if (pref && muni) {
    const q = pref + muni.replace(/^.*?郡/, m => m); // 「吾妻郡草津町」はそのまま通る
    const hits = (await gsi(q)).filter(h => inJapan(h.geometry.coordinates));
    if (hits.length) return { coord: hits[0].geometry.coordinates.map(v => +v.toFixed(6)), source: "estimate:gsi-municipality", precision: "municipality", query: q, matched: hits[0].properties.title };
  }
  return { source: "", precision: "", query: [base, pref, muni, addr].filter(Boolean).join(" / "), matched: "" };
}

const todo = [];
for (const a of articles) if (!a.disambig && !known(a)) { const w = a.qid ? wd[a.qid] : null; todo.push(["ja:" + a.pageid, a.title, a.pref || w?.pref || "", a.muni || w?.muni || "", a.address]); }
for (const w of Object.values(wd)) if (w.sparql && !w.jawiki && !inJapan(w.coord) && (w.labelJa || w.labelEn)) todo.push(["wd:" + w.qid, w.labelJa || w.labelEn, w.pref || "", w.muni || "", ""]);
console.error("to estimate", todo.length);
let n = 0;
for (const [id, name, pref, muni, address] of todo) {
  out[id] = prev[id] && !process.argv.includes("--refresh") ? prev[id] : await estimate(id, name, pref, muni, address);
  if (++n % 25 === 0) { console.error(`geocoded ${n}/${todo.length}`); writeJSON("geocode.json", out); }
}
writeJSON("geocode.json", out);
const by = {}; for (const g of Object.values(out)) by[g.precision || "(推定不能)"] = (by[g.precision || "(推定不能)"] || 0) + 1;
console.error(JSON.stringify(by));
