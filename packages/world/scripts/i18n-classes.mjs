#!/usr/bin/env node
// 分類・境界種別・気候区分の多言語名を Wikidata のクラス項目のラベルから埋める（Kenji 2026-09-15「i18n で埋められるものは埋めて」）。
//   → i18n/ui.json の categories（地形 35 分類）と plateBoundaries（PB2002 の 7 種別）、.cache/wikidata-labels-classes.json（koppen.mjs が気候区分の name_<lang> に使う）
//   ラベルの無い言語は書かない＝表示側が en へ落ちる（build/i18n.js と同じ流儀）。en は Wikidata の英語ラベル
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "ortho-earth-world-build/2.0 (kenji.yoshida.home.2026@gmail.com)";
const ui = JSON.parse(await readFile(path.join(ROOT, "i18n/ui.json"), "utf8"));
const LANGS = ui.langs.map(l => l.code);
// 分類 → Wikidata のクラス（2026-09-15 確認済み）
export const CATEGORY_QID = { continent: "Q5107", plate: "Q215680", ocean: "Q9430", current: "Q129558", region: "Q82794", shield: "Q852013", sea: "Q165", bay: "Q39594", strait: "Q37901", reef: "Q184358", island: "Q23442", islands: "Q33837", peninsula: "Q34763", cape: "Q185113", isthmus: "Q93267", range: "Q46831", peak: "Q8502", volcano: "Q8072", pass: "Q133056", plateau: "Q75520", plain: "Q160091", basin: "Q813672", valley: "Q39816", desert: "Q8514", saltflat: "Q935277", delta: "Q43197", wetland: "Q170321", ice: "Q35666", lake: "Q23397", river: "Q4022", waterfall: "Q34038", canal: "Q12284", trench: "Q119253", ridge: "Q104698", pole: "Q183273" };
export const BOUNDARY_QID = { OSR: "Q104698", OTF: "Q664573", OCB: "Q1255282", CRB: "Q473935", CTF: "Q664573", CCB: "Q1255282", SUB: "Q4493162" };
// ケッペン 30 区分 → 最も近い Wikidata 項目（細分に項目が無いものは亜型/群の項目・Csc/Cwb/Cwc は無し）
export const KOPPEN_QID = { Af: "Q209531", Am: "Q863882", Aw: "Q113562", BWh: "Q5772665", BWk: "Q23662277", BSh: "Q23662280", BSk: "Q23662294", Csa: "Q23670163", Csb: "Q21578284", Csc: "", Cwa: "Q864320", Cwb: "", Cwc: "", Cfa: "Q864320", Cfb: "Q182090", Cfc: "Q23748224", Dsa: "Q589326", Dsb: "Q589326", Dsc: "Q5967371", Dsd: "Q5967371", Dwa: "Q589326", Dwb: "Q589326", Dwc: "Q5967371", Dwd: "Q5967371", Dfa: "Q589326", Dfb: "Q589326", Dfc: "Q5967371", Dfd: "Q5967371", ET: "Q2459798", EF: "Q5985406" };
const ids = [...new Set([...Object.values(CATEGORY_QID), ...Object.values(BOUNDARY_QID), ...Object.values(KOPPEN_QID)].filter(Boolean))];
const ent = {};
for (let i = 0; i < ids.length; i += 50) { const v = await fetch("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=" + ["en", ...LANGS].join("|") + "&ids=" + ids.slice(i, i + 50).join("|"), { headers: { "User-Agent": UA } }).then(r => r.json()); Object.assign(ent, v.entities || {}); }
const labelsOf = q => { const e = ent[q]; if (!e?.labels) return null; const o = {}; for (const l of ["en", ...LANGS]) if (e.labels[l]) o[l] = e.labels[l].value; return o; };
const table = map => Object.fromEntries(Object.entries(map).map(([k, q]) => [k, q && labelsOf(q) ? { qid: q, ...labelsOf(q) } : { qid: q || undefined }]));
ui.categories = table(CATEGORY_QID); ui.plateBoundaries = table(BOUNDARY_QID);
await writeFile(path.join(ROOT, "i18n/ui.json"), JSON.stringify(ui, null, 1) + "\n");
await writeFile(path.join(ROOT, ".cache/wikidata-labels-classes.json"), JSON.stringify({ categories: ui.categories, plateBoundaries: ui.plateBoundaries, koppen: table(KOPPEN_QID) }));
const cov = t => Object.values(t).map(v => LANGS.filter(l => v[l]).length);
console.log(`categories ${Object.keys(ui.categories).length}（言語被覆 min ${Math.min(...cov(ui.categories))}/${LANGS.length}）・plateBoundaries ${Object.keys(ui.plateBoundaries).length}・koppen ${Object.values(KOPPEN_QID).filter(Boolean).length}/30 に項目`);
for (const [k, v] of Object.entries(ui.categories)) { const miss = LANGS.filter(l => !v[l]); if (miss.length) console.log(`  ${k}: 欠け ${miss.join(",")}`); }
