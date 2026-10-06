#!/usr/bin/env node
// 形状台帳 public/terrain.geopbf を組む（台帳 terrain.json の qid で結ぶ・混在ジオメトリ・precision 5・gzip）
//   湖＝.cache/shapes-lakes.json（W09 の面）／川＝.cache/shapes-rivers.json（W05 の線）／
//   山地・海溝＝手動層の axis（shape=axis・width km＝表示側が帯の面にする・world の range と同じ作法）／海流＝axis＋flow／構造線＝line
//   属性: qid / category / shape（polygon・line・axis）/ width / flow / name（日本語＝検証用）
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DIR, CACHE, readManual } from "./lib.mjs";
const PUB = path.join(DIR, "../../public");
const db = JSON.parse(fs.readFileSync(path.join(PUB, "terrain.json"), "utf8")), manual = readManual();
const byJa = new Map(db.items.map(it => [it.name.ja, it])), byQ = new Map(db.items.map(it => [it.qid, it]));
const lakes = JSON.parse(fs.readFileSync(path.join(CACHE, "shapes-lakes.json"), "utf8")), rivers = JSON.parse(fs.readFileSync(path.join(CACHE, "shapes-rivers.json"), "utf8"));
const fs_ = [];
for (const [qid, g] of Object.entries(lakes)) if (byQ.has(qid)) fs_.push({ type: "Feature", geometry: g, properties: { qid, category: "lake", shape: "polygon", name: byQ.get(qid).name.ja } });
for (const [qid, g] of Object.entries(rivers)) if (byQ.has(qid)) fs_.push({ type: "Feature", geometry: g, properties: { qid, category: "river", shape: "line", name: byQ.get(qid).name.ja } });
// 手書き軸線＝名前（台帳の日本語名）で結ぶ。Catmull-Rom は表示側（physical.js の rangeBand と同じ）＝ここは折れ線のまま
const miss = [];
for (const [name, a] of Object.entries(manual.axis || {})) {
	const it = byJa.get(name) || db.items.find(x => x.name.ja.replace(/・/g, "") === name.replace(/・/g, "")); if (!it) { miss.push(name); continue; }
	const shape = it.category === "fault" ? "line" : "axis";
	fs_.push({ type: "Feature", geometry: { type: "LineString", coordinates: a.pts }, properties: { qid: it.qid, category: it.category, shape, ...(a.width ? { width: a.width } : {}), ...(a.flow ? { flow: a.flow } : {}), name: it.name.ja } });
}
if (miss.length) console.warn("軸線の名が台帳に無い:", miss.join(" "));
const gj = path.join(CACHE, "terrain-shapes.geojson");
fs.writeFileSync(gj, JSON.stringify({ type: "FeatureCollection", name: "terrain", features: fs_ }));
execFileSync("node", [path.join(DIR, "../../../../packages/geopbf/bin/geopbf.mjs"), "enc", gj, path.join(PUB, "terrain.geopbf"), "--precision", "5"], { stdio: "inherit" });
const cnt = {}; for (const f of fs_) { const k = f.properties.category + "/" + f.properties.shape; cnt[k] = (cnt[k] || 0) + 1; }
console.log(fs_.length, "地物", JSON.stringify(cnt), (fs.statSync(path.join(PUB, "terrain.geopbf")).size / 1024).toFixed(0) + " KB");
