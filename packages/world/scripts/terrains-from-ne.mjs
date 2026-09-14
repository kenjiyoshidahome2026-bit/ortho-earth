#!/usr/bin/env node
// seed/terrains.csv を作る。基準＝「世界の優秀な高校生が知っている地形」（Kenji 2026-09-11）。
//   骨格＝Natural Earth 10m（v5.1.2 固定）の scalerank（地図帳での目立ち度）で機械的に選ぶ → wikidataid で Wikidata に結ぶ
//   → seed/terrains-manual.json（追加・除外・分類の上書き・形状の結合・手書き軸線）を重ねる
//   → 英語版 Wikipedia の記事が無いものは落とす（「wiki に無いものはいらない」）。位置は Wikidata P625、無ければ NE の代表点（lon/lat 列）
//   出力列: qid, category, name_en（enwiki 記事名・同名は括弧で区別）, ne_extra, axis, rank（NE scalerank）, lon, lat（NE の代表点）
//   使い方: node scripts/terrains-from-ne.mjs [--review]   （NE は .cache/ne/ に取得・再利用）
//   2026-09-15 Python（terrains-from-ne.py）から移植。出力は移植前とバイト一致（float の "15.0" 表記・round の半数偶数丸めも合わせてある）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCSV } from "../build/csv.js";
import { plates as pb2002Plates } from "./lib/pb2002.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "ortho-earth-world-build/2.0 (kenji.yoshida.home.2026@gmail.com)";
const NE_TAG = "v5.1.2";
const NE = ["ne_10m_geography_regions_polys", "ne_10m_geography_regions_points", "ne_10m_geography_regions_elevation_points", "ne_10m_geography_marine_polys", "ne_10m_lakes", "ne_10m_rivers_lake_centerlines_scale_rank", "ne_10m_playas"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rd = p => readFile(path.join(ROOT, p), "utf8");

async function fetchJSON(url, savePath) {
	for (let i = 0; i < 4; i++) {
		try {
			const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const b = Buffer.from(await r.arrayBuffer());
			if (savePath) await writeFile(savePath, b);
			return JSON.parse(b.toString("utf8"));
		} catch (e) { console.error("  retry", i, e.message); await sleep(2000 * (i + 1)); }
	}
	throw new Error("fetch failed: " + url);
}
async function ne(name) {
	const dir = path.join(ROOT, ".cache/ne"); await mkdir(dir, { recursive: true });
	const p = path.join(dir, `${name}.${NE_TAG}.geojson`);
	const g = existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : await fetchJSON(`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_TAG}/geojson/${name}.geojson`, p);
	for (const f of g.features) f.properties = Object.fromEntries(Object.entries(f.properties).map(([k, v]) => [k.toLowerCase(), v]));
	return g.features;
}
const longest = arrs => { let best = arrs[0]; for (const a of arrs) if (a.length > best.length) best = a; return best; };   // Python の max(key=len)＝最初の最大
function repPoint(g) {   // 代表点: Point はそのまま・線は中間頂点・面は最大リングの頂点平均
	const t = g.type, c = g.coordinates;
	if (t === "Point") return c;
	if (t === "LineString") return c[Math.floor(c.length / 2)];
	if (t === "MultiLineString") { const l = longest(c); return l[Math.floor(l.length / 2)]; }
	const rings = t === "MultiPolygon" ? c.map(p => p[0]) : [c[0]];
	const r = longest(rings); let sx = 0, sy = 0; for (const p of r) { sx += p[0]; sy += p[1]; }
	return [sx / r.length, sy / r.length];
}
// Python の round(x, 3)＝正しく丸めた上で真の同点は偶数へ。toFixed は同点をゼロから遠い側へ寄せるので、同点だけ直す
function round3(x) {
	const s = x * 1000, fl = Math.floor(s);
	if (s - fl === 0.5) return (fl % 2 === 0 ? fl : fl + 1) / 1000;
	return +x.toFixed(3);
}
// Python の float の文字列化（15.0 / -0.0 / 92.733）
const pyFloat = v => v === null || v === undefined ? "" : Object.is(v, -0) ? "-0.0" : Number.isInteger(v) ? v.toFixed(1) : String(v);

const M = JSON.parse(await rd("seed/terrains-manual.json"));
const PB = existsSync(path.join(ROOT, ".cache/pb2002/PB2002_plates.dig.txt")) ? pb2002Plates(await rd(".cache/pb2002/PB2002_plates.dig.txt")) : {};   // プレートの位置用（scripts/plates.mjs が落とす）
const nations = new Set(parseCSV(await rd("seed/nations.csv")).map(r => r.qid));
// alias_geo: 位置条件付きの wikidataid 読み替え（NE が別の同名河川の QID を付けた区間を直す＝米国コロラド川）
const ALIAS_GEO = M.alias_geo || [];
function applyAliasGeo(features) {
	if (!ALIAS_GEO.length) return features;
	const rep = g => { const c = g.type === "Point" ? g.coordinates : g.type === "LineString" ? g.coordinates[Math.floor(g.coordinates.length / 2)] : g.type === "MultiLineString" ? g.coordinates[0][Math.floor(g.coordinates[0].length / 2)] : (g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0])[0]; return c; };
	for (const f of features) {
		if (!f.geometry) continue;
		for (const a of ALIAS_GEO) {
			if (f.properties.wikidataid !== a.from) continue;
			const [x, y] = rep(f.geometry);
			if ((a.latMin === undefined || y >= a.latMin) && (a.latMax === undefined || y <= a.latMax) && (a.lonMin === undefined || x >= a.lonMin) && (a.lonMax === undefined || x <= a.lonMax)) f.properties.wikidataid = a.to;
		}
	}
	return features;
}
const [regions, points, elev, marine, lakes, rivers, playas] = (await Promise.all(NE.map(ne))).map(applyAliasGeo);
const sel = new Map();   // qid → {category, rank, ne_name, lon, lat}（挿入順が Python の dict と同じ意味を持つ）
const ALIAS = M.alias || {};   // NE の wikidataid が英語記事の無い重複項目を指す時、正規の項目へ読み替える
const allowNation = new Set(M.allow_nation || []);
function pick(f, cat, rank) {
	const p = f.properties; let q = p.wikidataid; q = ALIAS[q] ?? q;
	if (!q || !f.geometry) return;
	if (nations.has(q) && !allowNation.has(q)) return;   // 国そのもの（Japan・Kiribati…）は NationDB 側
	if (!sel.has(q) || rank < sel.get(q).rank) {
		const [lon, lat] = repPoint(f.geometry);
		sel.set(q, { category: cat, rank, ne_name: p.name_en ?? p.name ?? null, lon: round3(lon), lat: round3(lat) });
	}
}
const ANT = p => p.region === "Antarctica";
const ANT_OK = new Set(["Transantarctic Mountains", "Ellsworth Mountains", "Antarctic Plateau", "East Antarctica", "West Antarctica", "Alexander Island"]);
// 1) 地形ポリゴン
const POLY = { "Range/mtn": ["range", 4], "Plateau": ["plateau", 4], "Desert": ["desert", 4], "Pen/cape": ["peninsula", 4], "Peninsula": ["peninsula", 5], "Island": ["island", 4], "Island group": ["islands", 3],
	"Geoarea": ["region", 2], "Tundra": ["region", 1], "Plain": ["plain", 3], "Lowland": ["plain", 3], "Delta": ["delta", 4], "Basin": ["basin", 4], "Depression": ["basin", 5], "Valley": ["valley", 5], "Gorge": ["valley", 4],
	"Isthmus": ["isthmus", 3], "Wetlands": ["wetland", 5], "Continent": ["continent", 0] };
for (const f of regions) {
	const p = f.properties, m = POLY[p.featurecla], sr = p.scalerank;
	if (!m || sr === null || sr === undefined || sr > m[1]) continue;
	if (ANT(p) && !ANT_OK.has(p.name_en)) continue;
	pick(f, m[0], sr);
}
// 2) 海域
const MAR = { ocean: ["ocean", 0], sea: ["sea", 5], gulf: ["bay", 4], bay: ["bay", 4], sound: ["bay", 4], fjord: ["bay", 4], lagoon: ["bay", 6], river: ["bay", 4], strait: ["strait", 5], channel: ["strait", 5], reef: ["reef", 5] };
for (const f of marine) { const p = f.properties, m = MAR[p.featurecla]; if (m && p.scalerank <= m[1]) pick(f, m[0], p.scalerank); }
// 3) 湖（面積基準の scalerank）
for (const f of lakes) if (f.properties.scalerank <= 3) pick(f, "lake", f.properties.scalerank);
// 4) 標高点（山）・峠
for (const f of elev) {
	const p = f.properties;
	if (p.featurecla === "mountain" && p.scalerank <= 3 && !ANT(p)) pick(f, "peak", p.scalerank);
	if (p.featurecla === "pass" && p.scalerank <= 3) pick(f, "pass", p.scalerank);
}
// 5) 点（岬・滝）
for (const f of points) {
	const p = f.properties;
	if (p.featurecla === "cape" && p.scalerank <= 3) pick(f, "cape", p.scalerank);
	if (p.featurecla === "waterfall") pick(f, "waterfall", p.scalerank);
}
// 5b) 塩原（playas・面積基準の scalerank）≤1 → saltflat（3 まで広げると Carson Sink・Sevier Lake など僻地が入る＝有名どころは手動層で名指し）
for (const f of playas) if (f.properties.scalerank <= 1) pick(f, "saltflat", f.properties.scalerank);
// 6) 川＝QID ごとの最小 scalerank ≤4（5 は手動層で名指し）。結合先（merge の値側）は単独では入れない
const mergedInto = new Set(Object.values(M.merge).flat());
const rmin = new Map();
for (const f of rivers) {
	const p = f.properties; let q = p.wikidataid; q = ALIAS[q] ?? q;
	if (!q || p.featurecla === "Canal") continue;
	if (!rmin.has(q) || p.scalerank < rmin.get(q)[0]) rmin.set(q, [p.scalerank, f]);
}
for (const [q, [sr, f]] of rmin) if (sr <= 4 && !mergedInto.has(q)) pick(f, "river", sr);
// 6b) NE の名指し追加（閾値外でも入れる）: manual.add_ne = { NE name_en: category }
for (const [name, cat] of Object.entries(M.add_ne || {})) {
	let hit = null;
	for (const F of [regions, marine, lakes, points, elev]) {
		for (const f of F) if (f.properties.name_en === name || f.properties.name === name) { hit = [f, f.properties.scalerank ?? 9]; break; }
		if (hit) break;
	}
	if (!hit) { for (const [, [sr, f]] of rmin) if (f.properties.name_en === name) { hit = [f, sr]; break; } }
	if (hit) pick(hit[0], cat, hit[1]); else console.log("  add_ne: NE に無い", name);
}
const neCnt = new Map(); for (const v of sel.values()) neCnt.set(v.category, (neCnt.get(v.category) || 0) + 1);
// 7) 手動層
for (const e of M.add) {
	const q = e.qid;
	if (nations.has(q) && !allowNation.has(q)) continue;   // 手動層でも国の QID は入れない（Cuba・Jamaica…＝島の項目は NE から入る）
	if (sel.has(q)) { sel.get(q).category = e.category ?? sel.get(q).category; continue; }
	const r = rmin.get(q);
	if (r) { const [lon, lat] = repPoint(r[1].geometry); sel.set(q, { category: e.category, rank: r[0], ne_name: e.name ?? null, lon: round3(lon), lat: round3(lat) }); }
	else {
		let lon = e.lon ?? null, lat = e.lat ?? null;   // 手動の lon/lat＝Wikidata に座標が無い項目（南海トラフ・楯状地）の位置
		if (lon === null && (M.merge?.[q] || []).some(x => x.startsWith("~PB2002:"))) {   // プレート＝PB2002 の面の頂点平均を位置に
			const code = M.merge[q].find(x => x.startsWith("~PB2002:")).slice(8), ring = PB[code];
			if (ring) { let sx = 0, sy = 0, sc = 0; for (const [x, y] of ring) { const c = Math.cos(y * Math.PI / 180); sx += Math.cos(x * Math.PI / 180) * c; sy += Math.sin(x * Math.PI / 180) * c; sc += Math.sin(y * Math.PI / 180); } lon = round3(Math.atan2(sy, sx) * 180 / Math.PI); lat = round3(Math.atan2(sc, Math.hypot(sx, sy)) * 180 / Math.PI); }
		}
		if (lon === null && M.axis?.[q]) { const l = String(M.axis[q]).split("|")[0].split(";").map(x => x.trim().split(/\s+/).map(Number)); const m = l[l.length >> 1]; if (m && m.length === 2) [lon, lat] = m; }   // 手書きの線（海流）がある項目は線の中点を位置に
		sel.set(q, { category: e.category, rank: null, ne_name: e.name ?? null, lon, lat, picture: !!e.picture });
	}
}
const dropQ = new Set(M.drop.filter(d => d.startsWith("Q"))), dropN = new Set(M.drop.filter(d => !d.startsWith("Q")));
for (const q of [...sel.keys()]) { const v = sel.get(q); if (dropQ.has(q) || dropN.has(v.ne_name) || mergedInto.has(q)) sel.delete(q); }
for (const [k, cat] of Object.entries(M.category)) {
	if (k.startsWith("Q")) { if (sel.has(k)) sel.get(k).category = cat; }
	else for (const v of sel.values()) if (v.ne_name === k) v.category = cat;
}
// 8) Wikidata: 英語版記事名（無ければ落とす）と P625 の有無
const ids = [...sel.keys()].sort(), wiki = new Map(), hasCoord = new Set();
for (let i = 0; i < ids.length; i += 50) {
	const v = await fetchJSON("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks|claims&sitefilter=enwiki&ids=" + ids.slice(i, i + 50).join("|"));
	for (const [q, e] of Object.entries(v.entities || {})) {
		const q0 = e.redirects?.from || q;   // リダイレクト（旧 QID → 新 QID）は要求した側の QID で受ける
		const t = e.sitelinks?.enwiki?.title; if (t) wiki.set(q0, t);
		if (e.claims && "P625" in e.claims) hasCoord.add(q0);
	}
	await sleep(200);
}
const pictures = new Map();   // 英語記事なし＋picture:true ＝ 絵として台帳にだけ載せる（terrains-pictures.csv）
const nowiki = ids.filter(q => !wiki.has(q) && !sel.get(q).picture).map(q => [q, sel.get(q).category, sel.get(q).ne_name]);
for (const [q] of nowiki) sel.delete(q);
for (const q of [...sel.keys()]) if (!wiki.has(q)) { const v = sel.get(q); v.name = v.ne_name; v.coord_src = v.lon !== null ? "seed" : "NONE"; pictures.set(q, v); sel.delete(q); }
for (const q of [...sel.keys()]) if (dropN.has(wiki.get(q))) sel.delete(q);   // enwiki 記事名での除外
// 同じ英語記事に落ちる QID（統合済み項目・NE の別 QID）は rank の小さい方＝先に見つかった方だけ残す
const rankOf = q => sel.get(q).rank ?? 9;
const seenT = new Set();
for (const q of [...sel.keys()].sort((a, b) => rankOf(a) - rankOf(b))) { const t = wiki.get(q); if (seenT.has(t)) sel.delete(q); else seenT.add(t); }
// 9) 名前＝enwiki 記事名。同じ基底名（括弧を外した名）に NE 由来と手動由来が並んだら NE 由来（島の項目など）を残す
const baseOf = t => t.replace(/ \(.*\)$/, "");
const byb = new Map(); for (const q of sel.keys()) { const b = baseOf(wiki.get(q)); if (!byb.has(b)) byb.set(b, []); byb.get(b).push(q); }
for (const qs of byb.values()) if (qs.length > 1 && qs.some(q => sel.get(q).rank !== null)) for (const q of qs) if (sel.get(q).rank === null) sel.delete(q);
const base = new Map(); for (const q of sel.keys()) { const b = baseOf(wiki.get(q)); base.set(b, (base.get(b) || 0) + 1); }
for (const [q, v] of sel) {
	const t = wiki.get(q), b = baseOf(t); v.name = (base.get(b) === 1 ? b : t).replace(", Greenland", "");
	v.coord_src = hasCoord.has(q) ? "wikidata" : (v.lon !== null && v.lon !== undefined ? "ne" : "NONE");
}
const noloc = [...sel].filter(([, v]) => v.coord_src === "NONE").map(([q, v]) => [q, v.category, v.name]);
for (const [q] of noloc) sel.delete(q);
// 10) 書き出し（分類の順・rank・名前）
const ORDER = ["continent", "plate", "ocean", "current", "region", "shield", "sea", "bay", "strait", "reef", "island", "islands", "peninsula", "cape", "isthmus", "range", "peak", "volcano", "pass", "plateau", "plain", "basin", "valley", "desert", "saltflat", "delta", "wetland", "ice", "lake", "river", "waterfall", "canal", "trench", "ridge", "pole"];
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const rows = [...sel].sort((x, y) => cmp(ORDER.includes(x[1].category) ? ORDER.indexOf(x[1].category) : 99, ORDER.includes(y[1].category) ? ORDER.indexOf(y[1].category) : 99) || cmp(x[1].rank ?? 9, y[1].rank ?? 9) || cmp(x[1].name, y[1].name));
const esc = v => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
const lines = ["qid,category,name_en,ne_extra,axis,rank,lon,lat"];
for (const [q, v] of rows) lines.push([q, v.category, v.name, (M.merge[q] || []).join("|"), M.axis[q] ?? "", v.rank === null ? "" : String(v.rank), pyFloat(v.lon), pyFloat(v.lat)].map(esc).join(","));
await writeFile(path.join(ROOT, "seed/terrains.csv"), lines.join("\n") + "\n");
const plines = ["qid,category,name_en,ne_extra,axis,rank,lon,lat"];
for (const [q, v] of [...pictures].sort((x, y) => cmp(ORDER.indexOf(x[1].category), ORDER.indexOf(y[1].category)) || cmp(x[1].name, y[1].name))) plines.push([q, v.category, v.name, (M.merge[q] || []).join("|"), M.axis[q] ?? "", "", pyFloat(v.lon), pyFloat(v.lat)].map(esc).join(","));
await writeFile(path.join(ROOT, "seed/terrains-pictures.csv"), plines.join("\n") + "\n");
console.log(`terrains-pictures.csv: ${pictures.size} 件（英語記事なし・絵として台帳にだけ載せる）: ${[...pictures.values()].map(v => `${v.name}(${v.category})`).join(", ")}`);
const cnt = new Map(); for (const [, v] of rows) cnt.set(v.category, (cnt.get(v.category) || 0) + 1);
console.log(`terrains.csv: ${rows.length} 件（NE 閾値 ${[...neCnt.values()].reduce((a, b) => a + b, 0)} + 手動 ${M.add.length} − 除外/結合/記事なし）`);
console.log("  分類別:", ORDER.filter(c => cnt.get(c)).map(c => `${c} ${cnt.get(c)}`).join(", "));
console.log(`  enwiki 記事なし＝除外 ${nowiki.length}:`, nowiki.map(([q, c, n]) => `${n}(${c} ${q})`).join(", "));
console.log(`  位置なし＝除外 ${noloc.length}:`, noloc.map(([, c, n]) => `${n}(${c})`).join(", "));
console.log(`  座標が NE 代表点のみ（Wikidata P625 なし）: ${rows.filter(([, v]) => v.coord_src === "ne").length} 件`);
const nameCnt = new Map(); for (const [, v] of rows) nameCnt.set(v.name, (nameCnt.get(v.name) || 0) + 1);
const dup = [...nameCnt].filter(([, k]) => k > 1).map(([n]) => n); if (dup.length) console.log("  同名:", dup);
if (process.argv.includes("--review")) for (const c of ORDER) {
	const L = rows.filter(([, v]) => v.category === c).map(([, v]) => `${v.name}[${v.rank ?? ""}${v.coord_src === "wikidata" ? "" : "·ne"}]`);
	if (L.length) console.log(`\n## ${c} (${L.length}): ` + L.join(", "));
}
