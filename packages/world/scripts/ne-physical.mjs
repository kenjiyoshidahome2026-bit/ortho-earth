#!/usr/bin/env node
// 地形の形状台帳＝ out/ne-physical.geopbf を作る（NE の Physical 区分＝地形。Cultural＝国別は ne-cultural.mjs）。Physical ブラッシュアップ①・Kenji 2026-09-15「形状の一元化」。
//   seed/terrains.csv（912 件・31 分類）の各地形に Natural Earth 10m v5.1.2 の形を結び、1 本の GeoPBF（混在ジオメトリ）にまとめる。
//   結び方: wikidataid（seed/terrains-manual.json の alias で正規化）＋ ne_extra（merge の相手＝別 QID か "~NE 名"）で 6 データセットを引く
//     geography_regions_polys / geography_marine_polys / lakes / glaciated_areas / antarctic_ice_shelves_polys / playas → 面（MultiPolygon）
//     rivers_lake_centerlines_scale_rank → 線（MultiLineString・同じ QID の線分を全部束ねる＝build の rivers.geojson と同じ）
//     rivers_europe / north_america / australia＝地域別補完: 本体に無いか本体の 1.3 倍より長い時だけ差し替え（source=ne-eu / ne-na / ne-au）
//     geography_regions_elevation_points / geography_regions_points → 点
//   形が無いもの: seed の lon/lat（NE 代表点）→ 無ければ Wikidata P625（.cache/wikidata-p625.json に保存）→ 点
//   山脈（range）は NE ポリゴンに加えて軸線（seed の axis 手書き > geom.js の自動抽出）を別地物で持つ＝表示側で spline＋幅でポリゴン化（9/11 裁定）
//   属性: qid, category, name, rank, shape（polygon / line / point / axis）, source（ne / ne-point / wikidata / seed）, scalerank（NE の最小）, width/length（axis のみ・km）
//   使い方: node scripts/ne-physical.mjs [--out PATH(拡張子なし)] [--geojson] [--precision 5]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GeoPBF } from "../../geopbf/src/pbf-base.js";
import { parseCSV } from "../build/csv.js";
import { rangeAxis, parseAxis } from "../build/geom.js";
import { plates as pb2002Plates, PLATE_NAMES } from "./lib/pb2002.mjs";

globalThis.ImageData ??= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "ortho-earth-world-build/2.0 (kenji.yoshida.home.2026@gmail.com)";
const NE_TAG = "v5.1.2";
const ARGS = process.argv.slice(2);
const opt = (name, dflt) => { const i = ARGS.indexOf("--" + name); return i < 0 ? dflt : (ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : true); };
const OUT = path.resolve(ROOT, typeof opt("out") === "string" ? opt("out") : "out/ne-physical");
const WANT_GEOJSON = !!opt("geojson", false);
const PRECISION = +opt("precision", 5);
const T0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, savePath) {
	for (let i = 0; i < 4; i++) {
		try {
			const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const b = Buffer.from(await r.arrayBuffer()); if (savePath) await writeFile(savePath, b);
			return JSON.parse(b.toString("utf8"));
		} catch (e) { log("  retry", i, e.message); await sleep(2000 * (i + 1)); }
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

// 手書き軸線（2〜4 点）を自動軸線と同じ密度（約 120 km 間隔）に Catmull-Rom で再標本化する＝形は手書きのまま・見た目の粗さだけ揃える
function densifyAxis(ax, spacingKm = 120) {
	if (!ax) return null;
	const P = ax.line.map(p => [p[0], p[1]]), n = P.length; if (n < 2) return ax;
	for (let i = 1; i < n; i++) { while (P[i][0] - P[i - 1][0] > 180) P[i][0] -= 360; while (P[i][0] - P[i - 1][0] < -180) P[i][0] += 360; }   // 経度をほどく（日付変更線をまたぐ海流が逆回りしないように）。戻しは末尾
	const km = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180), (b[1] - a[1]) * 110.57);
	const out = [P[0]];
	for (let i = 0; i + 1 < n; i++) {
		const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)], k = Math.max(1, Math.round(km(p1, p2) / spacingKm));
		for (let j = 1; j <= k; j++) {
			const u = j / k, u2 = u * u, u3 = u2 * u;
			out.push([0, 1].map(d => +(0.5 * ((2 * p1[d]) + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u3)).toFixed(3)));
		}
	}
	for (const p of out) { while (p[0] > 180) p[0] -= 360; while (p[0] < -180) p[0] += 360; }
	return { ...ax, line: out };
}

// ── 入力 ──────────────────────────────────────────────────────────────────────────────────────────
const terrains = parseCSV(await readFile(path.join(ROOT, "seed/terrains.csv"), "utf8"));
const picPath = path.join(ROOT, "seed/terrains-pictures.csv");
if (existsSync(picPath)) for (const t of parseCSV(await readFile(picPath, "utf8"))) terrains.push({ ...t, picture: true });   // 英語記事なし＝絵として収録（wiki:false）
const M = JSON.parse(await readFile(path.join(ROOT, "seed/terrains-manual.json"), "utf8"));
const ALIAS = M.alias || {};
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
const NOSHAPE = new Set(M.noshape || []);   // NE の形を使わない（誤ポリゴン）＝Wikidata の位置の点だけ
const SETS = { regions: "ne_10m_geography_regions_polys", marine: "ne_10m_geography_marine_polys", lakes: "ne_10m_lakes", rivers: "ne_10m_rivers_lake_centerlines_scale_rank", elev: "ne_10m_geography_regions_elevation_points", points: "ne_10m_geography_regions_points", glaciated: "ne_10m_glaciated_areas", iceshelves: "ne_10m_antarctic_ice_shelves_polys", playas: "ne_10m_playas", rivers_eu: "ne_10m_rivers_europe", rivers_na: "ne_10m_rivers_north_america", rivers_au: "ne_10m_rivers_australia" };
const RIVER_SUPP = new Set(["rivers_eu", "rivers_na", "rivers_au"]);   // 地域別の補完（本体と同じ川を細かく持つ＝重ねると二重になるので、本体に無いか本体より明らかに長い時だけ差し替える）
const NEF = Object.fromEntries(await Promise.all(Object.entries(SETS).map(async ([k, n]) => [k, applyAliasGeo(await ne(n))])));
log(`NE: ${Object.entries(NEF).map(([k, fs]) => `${k} ${fs.length}`).join("・")}・地形 ${terrains.length}`);

// 索引: 正規化した wikidataid → 地物・"~名前" → 地物（データセット横断）
const byQ = new Map(), byName = new Map();
for (const [set, fs] of Object.entries(NEF)) for (const f of fs) {
	if (!f.geometry) continue;
	const p = f.properties, q = ALIAS[p.wikidataid] ?? p.wikidataid, n = p.name_en || p.name;
	f._set = set;
	if (q) { if (!byQ.has(q)) byQ.set(q, []); byQ.get(q).push(f); }
	if (n) { if (!byName.has("~" + n)) byName.set("~" + n, []); byName.get("~" + n).push(f); }
}
// PB2002 のプレート面を "~PB2002:記号" で引けるようにする（category plate・scripts/plates.mjs と同じ原本）
{
	const pbPath = path.join(ROOT, ".cache/pb2002/PB2002_plates.dig.txt");
	if (existsSync(pbPath)) for (const [code, ring] of Object.entries(pb2002Plates(await readFile(pbPath, "latin1")))) byName.set("~PB2002:" + code, [{ properties: { name_en: PLATE_NAMES[code] || code, wikidataid: null }, geometry: { type: "Polygon", coordinates: [ring] }, _set: "pb2002" }]);
	else log("PB2002 が無い（scripts/plates.mjs を先に走らせると .cache/pb2002 に落ちる）＝プレートの面なし");
}
const polysOf = fs => fs.flatMap(f => f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : []);
const linesOf = fs => fs.flatMap(f => f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : []);
const pointsOf = fs => fs.flatMap(f => f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.type === "MultiPoint" ? f.geometry.coordinates : []);
const minRank = fs => { const r = fs.map(f => f.properties.scalerank).filter(v => v !== null && v !== undefined); return r.length ? Math.min(...r) : undefined; };

// ── 地形ごとに形を決める ───────────────────────────────────────────────────────────────────────────
const features = [], needP625 = [], stat = {};
const tally = (cat, shape, source) => { const k = `${cat}`; stat[k] ||= {}; const s = `${shape}/${source}`; stat[k][s] = (stat[k][s] || 0) + 1; };
for (const t of terrains) {
	const ids = [t.qid, ...(t.ne_extra ? t.ne_extra.split("|") : [])];
	let fs = NOSHAPE.has(t.qid) ? [] : [...new Set(ids.flatMap(id => byQ.get(id) || byName.get(id) || []))];
	const base = { qid: t.qid, category: t.category, name: t.name_en, rank: t.rank === "" ? undefined : +t.rank, wiki: t.picture ? false : undefined };
	// 川の線: 本体（rivers_lake_centerlines_scale_rank）を既定に、地域別補完は「本体に無い」か「本体の 1.3 倍より長い」時だけ丸ごと差し替え（Cooper Creek・Murrumbidgee）
	const lineKm = fs => { let L = 0; for (const l of linesOf(fs)) for (let j = 1; j < l.length; j++) L += Math.hypot((l[j][0] - l[j - 1][0]) * Math.cos(l[j][1] * Math.PI / 180), l[j][1] - l[j - 1][1]) * 111; return L; };
	const mainL = fs.filter(f => !RIVER_SUPP.has(f._set)), suppBySet = new Map();
	for (const f of fs) if (RIVER_SUPP.has(f._set)) { if (!suppBySet.has(f._set)) suppBySet.set(f._set, []); suppBySet.get(f._set).push(f); }
	let useFs = mainL, riverSrc = "ne";
	const mainKm = lineKm(mainL);
	for (const [set, sfs] of suppBySet) { const L = lineKm(sfs); if (L > Math.max(mainKm * 1.3, lineKm(useFs.filter(f => RIVER_SUPP.has(f._set))))) { useFs = [...mainL.filter(f => f.geometry.type !== "LineString" && f.geometry.type !== "MultiLineString"), ...sfs]; riverSrc = set.replace("rivers_", "ne-"); } }
	fs = useFs;
	const polys = polysOf(fs), lines = linesOf(fs), pts = pointsOf(fs);
	if (t.category === "current" || (t.axis && t.category !== "range" && !fs.length)) {   // 手書きの線＝海流（flow 付き）と、NE に形が無い川など（seed の axis・"|" で複数の線）
		const parts = String(t.axis || "").split("|").map(x => densifyAxis(parseAxis(x), t.category === "current" ? 250 : 60)).filter(Boolean).map(a => a.line);
		if (!parts.length) { log(`  線なし: ${t.qid} ${t.name_en}`); continue; }
		features.push({ type: "Feature", properties: { ...base, shape: "line", source: "seed", flow: (M.flow || {})[t.qid] }, geometry: parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts } });
		tally(t.category, "line", "seed"); continue;
	}
	if (t.category === "range") {   // 軸線＝手書き > ポリゴンから自動抽出（NE に形が無い山脈でも手書き軸線は持つ）
		const ax = t.axis ? densifyAxis(parseAxis(t.axis)) : polys.length ? rangeAxis(fs.filter(f => f._set === "regions")) : null;
		if (ax) { features.push({ type: "Feature", properties: { ...base, shape: "axis", source: t.axis ? "seed" : "ne", width: ax.width, length: ax.length }, geometry: { type: "LineString", coordinates: ax.line } }); tally(t.category, "axis", t.axis ? "seed" : "ne"); }
	}
	// 形の優先順: 川・運河は線 > 面（アマゾン・長江は marine_polys に河口の面もある）・それ以外は面 > 線 > 点
	const poly = () => polys.length ? [polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys }, "polygon"] : null;
	const line = () => lines.length ? [lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines }, "line"] : null;
	const point = () => pts.length ? [{ type: "Point", coordinates: pts[0] }, "point"] : null;
	const pick = (t.category === "river" || t.category === "canal" ? [line, poly, point] : [poly, line, point]).reduce((a, f) => a || f(), null);
	let geometry, shape, source = "ne";
	if (pick) { [geometry, shape] = pick; if (shape === "line") source = riverSrc; }
	else if (t.lon !== "" && t.lat !== "" && !NOSHAPE.has(t.qid)) { geometry = { type: "Point", coordinates: [+t.lon, +t.lat] }; shape = "point"; source = "ne-point"; }
	else { needP625.push(t); continue; }
	features.push({ type: "Feature", properties: { ...base, shape, source, scalerank: fs.length ? minRank(fs) : undefined }, geometry });
	tally(t.category, shape, source);
}
// 形も NE 代表点も無いもの → Wikidata P625（キャッシュ）
if (needP625.length) {
	const cachePath = path.join(ROOT, ".cache/wikidata-p625.json");
	const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, "utf8")) : {};
	const ask = needP625.map(t => t.qid).filter(q => !(q in cache));
	if (ask.length) log(`Wikidata P625: ${ask.length} 件を問い合わせ`);
	for (let i = 0; i < ask.length; i += 50) {
		const v = await fetchJSON("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=" + ask.slice(i, i + 50).join("|"));
		for (const [q, e] of Object.entries(v.entities || {})) {
			const q0 = e.redirects?.from || q, c = e.claims?.P625?.find(x => x.mainsnak?.datavalue)?.mainsnak.datavalue.value;
			cache[q0] = c ? [+c.longitude.toFixed(4), +c.latitude.toFixed(4)] : null;
		}
		await sleep(200);
	}
	await writeFile(cachePath, JSON.stringify(cache));
	for (const t of needP625) {
		const c = cache[t.qid];
		if (!c) { log(`  位置なし: ${t.qid} ${t.category} ${t.name_en}`); tally(t.category, "none", "-"); continue; }
		features.push({ type: "Feature", properties: { qid: t.qid, category: t.category, name: t.name_en, rank: t.rank === "" ? undefined : +t.rank, shape: "point", source: "wikidata" }, geometry: { type: "Point", coordinates: c } });
		tally(t.category, "point", "wikidata");
	}
}

// 火山フラグ: Wikidata P31（instance of）が volcano（Q8072）の下位クラスなら volcano:true（peak にある富士山なども火山と分かる＝山との被りの扱い・Kenji 2026-09-15）
{
	const clsPath = path.join(ROOT, ".cache/wikidata-volcano-classes.json"), p31Path = path.join(ROOT, ".cache/wikidata-p31.json");
	const classes = new Set(existsSync(clsPath) ? JSON.parse(await readFile(clsPath, "utf8")) : ["Q8072"]);
	const p31 = existsSync(p31Path) ? JSON.parse(await readFile(p31Path, "utf8")) : {};
	const ask = [...new Set(features.map(f => f.properties.qid))].filter(q => !(q in p31));
	if (ask.length) log(`Wikidata P31: ${ask.length} 件を問い合わせ`);
	for (let i = 0; i < ask.length; i += 50) {
		const v = await fetchJSON("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=" + ask.slice(i, i + 50).join("|"));
		for (const [q, e] of Object.entries(v.entities || {})) { const q0 = e.redirects?.from || q; p31[q0] = (e.claims?.P31 || []).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean); }
		await sleep(200);
	}
	await writeFile(p31Path, JSON.stringify(p31));
	let n = 0; for (const f of features) if ((p31[f.properties.qid] || []).some(c => classes.has(c))) { f.properties.volcano = true; n++; }
	log(`火山フラグ volcano:true = ${n} 地物（分類 volcano 以外にも peak などに付く）`);
}

// ── 書き出し ──────────────────────────────────────────────────────────────────────────────────────
await mkdir(path.dirname(OUT), { recursive: true });
const fc = { type: "FeatureCollection", name: "ne-physical", features };
const pbf = await new GeoPBF({ name: "ne-physical", precision: PRECISION, attribution: `Natural Earth 10m ${NE_TAG} (public domain); positions from Wikidata (CC0)`, description: "ortho-earth world terrains: shapes for seed/terrains.csv (properties qid / category / name / shape / source)" }).set(fc);
const buf = gzipSync(Buffer.from(pbf.arrayBuffer), { level: 9 });
await writeFile(OUT + ".geopbf", buf);
if (WANT_GEOJSON) await writeFile(OUT + ".geojson", JSON.stringify(fc));
const byShape = {}; for (const f of features) { const k = `${f.properties.shape}/${f.properties.source}`; byShape[k] = (byShape[k] || 0) + 1; }
let verts = 0; const walk = c => Array.isArray(c[0]) ? c.forEach(walk) : verts++; for (const f of features) walk(f.geometry.coordinates);
const summary = { source: `Natural Earth 10m ${NE_TAG}`, generated: new Date().toISOString(), precision: PRECISION, terrains: terrains.length, features: features.length, vertices: verts, bytes: buf.length, byShape, byCategory: stat };
// ── ⑤ 地理線 out/ne-physical-lines.geopbf（球の飾り・Kenji 2026-09-15）──────────────────────────────────────
// 赤道・回帰線・極圏は緯度の定数線なので NE を写さず今の黄道傾斜角 ε から計算する（NE v5.1.2 は北回帰線 23.50°/南回帰線 −23.56° と不揃いで古い）。
// ε は IAU 2006 の式 ε = 23°26′21.406″ − 46.836769″·T（T＝J2000 からのユリウス世紀）を EPOCH 年で評価。日付変更線だけは取り決めの折れ線なので NE から。
// 名前と wikidataid は NE の同名地物から取る。頂点は経度 1° 刻み（描画側は辺を大円で結ぶ＝1° の弦なら緯線からのずれは 1 km 未満）
{
	const EPOCH = 2026, T = (EPOCH - 2000) / 100, eps = (23 + 26 / 60 + (21.406 - 46.836769 * T) / 3600);
	const glines = await ne("ne_10m_geographic_lines");
	const meta = name => { const f = glines.find(f => f.properties.name === name); return f ? { wikidataid: f.properties.wikidataid, name_ja: f.properties.name_ja } : {}; };
	const circle = lat => { const c = []; for (let x = -180; x <= 180; x++) c.push([x, +lat.toFixed(4)]); return { type: "LineString", coordinates: c }; };
	const gf = [];
	for (const [name, kind, lat] of [["Equator", "equator", 0], ["Tropic of Cancer", "tropic", eps], ["Tropic of Capricorn", "tropic", -eps], ["Arctic Circle", "polar", 90 - eps], ["Antarctic Circle", "polar", -(90 - eps)]])
		gf.push({ type: "Feature", properties: { name, kind, lat: +lat.toFixed(4), epoch: EPOCH, ...meta(name) }, geometry: circle(lat) });
	const idl = glines.find(f => f.properties.featurecla === "Date line");
	if (idl) gf.push({ type: "Feature", properties: { name: "International Date Line", kind: "dateline", source: "ne", ...meta("International Date Line") }, geometry: idl.geometry });
	const gp = await new GeoPBF({ name: "ne-physical-lines", precision: 4, attribution: `circles of latitude computed for ${EPOCH} (IAU 2006 obliquity); International Date Line from Natural Earth 10m ${NE_TAG} (public domain)`, description: "equator, tropics, polar circles, date line (properties name / kind / lat / epoch)" }).set({ type: "FeatureCollection", name: "ne-physical-lines", features: gf });
	const gb = gzipSync(Buffer.from(gp.arrayBuffer), { level: 9 });
	await writeFile(path.join(path.dirname(OUT), "ne-physical-lines.geopbf"), gb);
	if (WANT_GEOJSON) await writeFile(path.join(path.dirname(OUT), "ne-physical-lines.geojson"), JSON.stringify({ type: "FeatureCollection", features: gf }));
	summary.geographicLines = { file: "ne-physical-lines.geopbf", features: gf.length, epoch: EPOCH, obliquity: +eps.toFixed(5), bytes: gb.length };
	log(`ne-physical-lines.geopbf: ${gf.length} 本（ε=${eps.toFixed(4)}°・${EPOCH} 年）・${(gb.length / 1024).toFixed(1)} KB`);
}
await writeFile(OUT + ".json", JSON.stringify(summary, null, 1));
log(`${OUT}.geopbf: 地形 ${terrains.length} → 地物 ${features.length}（${Object.entries(byShape).map(([k, n]) => `${k} ${n}`).join("・")}）・頂点 ${verts}・${(buf.length / 1e6).toFixed(1)} MB (gzip)`);
