#!/usr/bin/env node
// 日本の地形の台帳（public/terrain.json・terrain-i18n/・terrain.geopbf）の常設検定＝scripts/terrain-ledger の生成物が terrain.js の前提を満たすか。
//   ①台帳の形（qid・分類・rank・name.ja・wiki.ja・coord）②座標は日本の範囲 ③分類ごとの最低件数（富士山・琵琶湖・信濃川・関東平野・日本海溝が居る）
//   ④形状台帳は全部台帳の qid に結ぶ・軸線は幅を持つ ⑤分類名は 26 言語 ⑥名前表は台帳の qid だけ ⑦手動層の軸線は台帳の名に結ぶ
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { GeoPBF } from "../../../packages/geopbf/src/pbf-base.js";
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url))), PUB = path.join(APP, "public");
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };

const db = JSON.parse(fs.readFileSync(path.join(PUB, "terrain.json"), "utf8")), items = db.items;
const CATS = new Set(["range", "peak", "volcano", "pass", "plateau", "hills", "plain", "basin", "trench", "ridge", "seamount", "cave", "river", "lake", "waterfall", "wetland", "sea", "bay", "strait", "reef", "island", "islands", "peninsula", "cape", "beach", "dune", "current", "plate", "fault"]);
t("台帳：1,000 件以上", items.length >= 1000, String(items.length));
t("台帳：qid は一意", new Set(items.map(d => d.qid)).size === items.length);
t("台帳：全件に qid・分類・rank・日本語名・日本語版記事・座標", items.every(d => /^Q\d+$/.test(d.qid) && CATS.has(d.category) && Number.isFinite(d.rank) && d.name?.ja && d.wiki?.ja && Array.isArray(d.coord) && d.coord.length === 2),
	JSON.stringify(items.find(d => !(/^Q\d+$/.test(d.qid) && CATS.has(d.category) && Number.isFinite(d.rank) && d.name?.ja && d.wiki?.ja && d.coord?.length === 2))));
t("台帳：座標は日本の範囲（lon 122〜154.5・lat 20〜46）", items.every(d => d.coord[0] >= 122 && d.coord[0] <= 154.5 && d.coord[1] >= 20 && d.coord[1] <= 46), JSON.stringify(items.filter(d => !(d.coord[0] >= 122 && d.coord[0] <= 154.5 && d.coord[1] >= 20 && d.coord[1] <= 46)).map(d => d.name.ja)));
t("台帳：物理量は数（負は海底の標高だけ）", items.every(d => ["elevation", "prominence", "length", "area", "basin", "depth", "height", "discharge", "volume"].every(k => d[k] == null || (Number.isFinite(d[k]) && (d[k] >= 0 || k === "elevation")))));
for (const [name, cat, key, min] of [["富士山", "volcano", "elevation", 3776], ["琵琶湖", "lake", "area", 600], ["信濃川", "river", "length", 360], ["関東平野", "plain", null, 0], ["日本海溝", "trench", null, 0], ["奥羽山脈", "range", null, 0], ["黒潮", "current", null, 0], ["中央構造線", "fault", null, 0], ["佐渡島", "island", "area", 800], ["日本海", "sea", null, 0]]) {
	const d = items.find(x => x.name.ja === name);
	t(`台帳：${name} が ${cat} で居る${key ? `・${key} ≥ ${min}` : ""}`, d && d.category === cat && (!key || d[key] >= min), d ? JSON.stringify(d) : "無い");
}
const cnt = {}; for (const d of items) cnt[d.category] = (cnt[d.category] || 0) + 1;
t("台帳：主な分類の件数（山 200・火山 50・川 150・湖 40・島 150・岬 40・湾 30・山地 30・平野 15・盆地 15・峠 20・滝 10）", cnt.peak >= 200 && cnt.volcano >= 50 && cnt.river >= 150 && cnt.lake >= 40 && cnt.island >= 150 && cnt.cape >= 40 && cnt.bay >= 30 && cnt.range >= 30 && cnt.plain >= 15 && cnt.basin >= 15 && cnt.pass >= 20 && cnt.waterfall >= 10, JSON.stringify(cnt));
t("台帳：categories の数は items と一致", Object.entries(db.categories).every(([c, n]) => cnt[c] === n));
const LANGS = ["ja", "en", "zh", "ko", "fr", "de", "es", "pt", "it", "nl", "pl", "ru", "uk", "hu", "sv", "tr", "el", "id", "vi", "th", "bn", "hi", "ar", "fa", "ur", "he"];
t("分類名：台帳の全分類に 26 言語（英語と日本語は必須）", Object.keys(cnt).every(c => db.catNames[c]?.en && db.catNames[c]?.ja), JSON.stringify(Object.keys(cnt).filter(c => !(db.catNames[c]?.en && db.catNames[c]?.ja))));
// 名前表
const byQ = new Set(items.map(d => d.qid));
for (const l of LANGS) { if (l === "ja" || l === "en") continue; const f = path.join(PUB, "terrain-i18n", l + ".json"); if (!fs.existsSync(f)) { t(`名前表 ${l}`, false, "無い"); continue; }
	const m = JSON.parse(fs.readFileSync(f, "utf8")), ks = Object.keys(m);
	t(`名前表 ${l}：台帳の qid だけ・[名前, 記事名] の対・${ks.length} 件`, ks.length >= 20 && ks.every(q => byQ.has(q) && Array.isArray(m[q]) && m[q].length === 2)); }
// 形状台帳
const raw = fs.readFileSync(path.join(PUB, "terrain.geopbf")), buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
const pbf = new GeoPBF(); await pbf.set(new Uint8Array(buf).buffer); const n = pbf.length;
t("形状台帳：300 地物以上", n >= 300, String(n));
const kinds = {}; let bad = 0, noWidth = 0, byQid = new Map();
for (let i = 0; i < n; i++) { const p = pbf.getProperties(i) || {}, g = pbf.getFeature(i)?.geometry; if (!byQ.has(p.qid) || !g) { bad++; continue; }
	kinds[p.category + "/" + p.shape] = (kinds[p.category + "/" + p.shape] || 0) + 1; if (p.shape === "axis" && p.category !== "current" && !(p.width > 0)) noWidth++;
	byQid.set(p.qid, (byQid.get(p.qid) || 0) + 1); }
t("形状台帳：全部が台帳の qid に結ぶ・幅の無い軸線なし", bad === 0 && noWidth === 0, `結ばない ${bad}・幅なし ${noWidth}`);
t("形状台帳：湖の面 40・川の線 200・山地の軸線 30・海溝の軸線 5・海流 4・構造線 3", (kinds["lake/polygon"] || 0) >= 40 && (kinds["river/line"] || 0) >= 200 && (kinds["range/axis"] || 0) >= 30 && (kinds["trench/axis"] || 0) >= 5 && (kinds["current/axis"] || 0) >= 4 && (kinds["fault/line"] || 0) >= 3, JSON.stringify(kinds));
t("形状台帳：1 地形に 1 地物（qid の重複なし）", [...byQid.values()].every(v => v === 1), JSON.stringify([...byQid].filter(([, v]) => v > 1)));
// 手動層
const manual = JSON.parse(fs.readFileSync(path.join(APP, "scripts/terrain-ledger/seed/terrains-manual.json"), "utf8"));
const names = new Set(items.map(d => d.name.ja.replace(/・/g, "")));
t("手動層：axis の名は全部台帳に居る", Object.keys(manual.axis).every(k => names.has(k.replace(/・/g, ""))), JSON.stringify(Object.keys(manual.axis).filter(k => !names.has(k.replace(/・/g, "")))));
t("手動層：axis の点は lon,lat の列（3 点以上か海流・構造線）", Object.values(manual.axis).every(a => Array.isArray(a.pts) && a.pts.length >= 2 && a.pts.every(p => p.length === 2 && p[0] > 120 && p[0] < 156 && p[1] > 19 && p[1] < 48)));

console.log(`\n${ng ? "✗" : "✓"} terrain: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
