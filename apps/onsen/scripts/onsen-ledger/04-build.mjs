// 4) 記事と Wikidata を突き合わせて、地図向けの CSV / GeoJSON と統計を書く
//    座標の優先順: Wikipedia 記事の座標(API) > Template:温泉 の緯度経度 > 本文の {{coord}} > Wikidata P625
import { readJSON, writeJSON, ROOT, PREF_RE, PREFS, inJapan } from "./lib.mjs";
import { qualityClass } from "./quality.mjs";
import fs from "node:fs";
import path from "node:path";

const articles = readJSON("articles.json"), wd = readJSON("wikidata.json");
const geo = fs.existsSync(path.join(ROOT, "geocode.json")) ? readJSON("geocode.json") : {}; // 05-geocode.mjs の推定座標
const hitou = fs.existsSync(path.join(ROOT, "hitou.json")) ? readJSON("hitou.json") : []; // 06-hitou.mjs の会員宿
const KYO_RE = /温泉郷$|温泉群$|温泉峡$/;
// 温泉の記事らしさ: 情報箱か泉質があれば残す。無ければ題名が温泉らしく（温泉・鉱泉・湯）、かつ駅・ダム・ホテル等の非温泉記事でないこと。
// カテゴリ「○○温泉郷」には周辺の駅・橋・祭りなども入っているため、この篩が要る。落とした題名は data/excluded.csv に残す。
const ONSENISH = /温泉|鉱泉|の湯|湯$|泉$/;
const NONONSEN = /駅$|ダム$|ホテル|旅館$|道の駅|サービスエリア|インターチェンジ|発電所|百貨店|公園$|郵便局|祭り?$|橋$|林道$|神社|寺$|学校$|博物館|美術館|バスターミナル|中継局|トンネル$|空港$|病院|ランド$|センター$|会館$|記念館|資料館|町$|村$|市$|地区$|街道$|国道|県道|線$|フェス|ウォーク|焼きそば|饅頭|荘$|館$|閣$|屋$|亭$|庵$|ヴィラ|ハウス$|タワー$|スキー場|ゴルフ|キャンプ場|牧場$|遊園地|水族館|動物園|競馬|ホール$|本店$|支店$|組合$|協会$|会$|事件|問題$|市内の温泉$|の温泉$|百名湯|名湯百選|^銭湯$|^野湯$|^黒湯$|^モール泉$|^赤湯$|泉質$|^(単純温泉|塩化物泉|炭酸水素塩泉|硫酸塩泉|二酸化炭素泉|含鉄泉|酸性泉|含よう素泉|含ヨウ素泉|硫黄泉|放射能泉|冷鉱泉|鉱泉|熱水泉|間欠泉|人工温泉|外湯|内湯|隠し湯|にごり湯|源泉|湯治|湯)$|100選|百選|三古湯|七湯$|八十八湯|研究所|指導員|指導者|健康増進施設|藻$|料理$|ハップ$|企業$|泉源$|分析法|温泉法|温泉道|めぐり$|名湯$|秘湯$/;
const excluded = [];
// 座標の目安精度（m）。地図では推定点を薄く描き、この半径の円を添える想定。
const ACCURACY = { exact: "", name: 300, address: 500, region: 1500, municipality: 8000 };
const accuracy = (prec, note) => prec === "municipality" && /市$/.test((note || "").split(" → ").pop() || "") && !/区$/.test(note) ? 15000 : ACCURACY[prec] ?? ""; // 温泉郷＝温泉の集合体（Kenji 指示 2026-10-06）。面で持ち、配下は parent 列で結ぶ
const EXCLUDE = /一覧$|^温泉$|^(引湯|源泉|鉱泉|温泉街|温泉郷|温泉地|湯治|足湯|露天風呂|温泉旅館|秘湯|日本秘湯を守る会|温泉番付|温泉療法|温泉法|入湯税|温泉分析書|湯もみ|温泉地学|温泉ソムリエ|温泉マーク|温泉饅頭|温泉卵|湯の花|湯畑|温泉偽装問題|レジオネラ|泉質)$|温泉法|温泉街$|温泉地$|温泉旅館|温泉宿$|温泉饅頭|温泉卵|温泉マーク|温泉療法|温泉医学|源泉かけ流し|日帰り入浴|温泉番付|温泉ソムリエ|^Category:|^Template:|温泉文化|温泉学|温泉タマゴ|温泉むすめ|温泉宿泊|温泉協会|温泉組合|温泉観光|温泉施設/;
const rows = [];
const used = new Set();
for (const a of articles) {
  if (EXCLUDE.test(a.title) || a.disambig) { excluded.push({ title: a.title, reason: a.disambig ? "曖昧さ回避" : "除外語" }); continue; }
  if (!a.hasInfobox && !a.quality && !(ONSENISH.test(a.title) && !NONONSEN.test(a.title))) { excluded.push({ title: a.title, reason: "温泉記事でない（情報箱・泉質なし、題名が非温泉）" }); continue; }
  if (!a.hasInfobox && !a.quality && NONONSEN.test(a.title) && !/温泉|鉱泉/.test(a.title)) { excluded.push({ title: a.title, reason: "非温泉の題名" }); continue; }
  const w = a.qid ? wd[a.qid] : null; if (a.qid) used.add(a.qid);
  let coord = null, src = "";
  if (a.coord) { coord = a.coord; src = "wikipedia:api"; }
  else if (a.tplCoord) { coord = a.tplCoord; src = "wikipedia:infobox"; }
  else if (a.textCoord) { coord = a.textCoord; src = "wikipedia:coord-template"; }
  else if (w?.coord) { coord = w.coord; src = "wikidata:P625"; }
  // 日本の範囲外（経度 122–154, 緯度 20–46）は疑わしいので外して理由を残す
  let reason = "";
  if (coord && !(coord[0] >= 122 && coord[0] <= 154 && coord[1] >= 20 && coord[1] <= 46)) { reason = `座標が日本の範囲外 (${coord.join(",")}) ${src}`; coord = null; src = ""; }
  let precision = coord ? "exact" : "", note = "";
  if (!coord) { const g = geo["ja:" + a.pageid]; if (g?.coord) { coord = g.coord; src = g.source; precision = g.precision; note = `${g.query} → ${g.matched}`; } }
  if (!coord) reason ||= (a.qid ? (w ? "Wikipedia 記事にも Wikidata(P625) にも座標なし" : "Wikipedia 記事に座標なし・Wikidata 未取得") : "Wikipedia 記事に座標なし・Wikidata 項目なし") + (geo["ja:" + a.pageid] ? "・推定も不能" : "");
  const pref = a.pref || w?.pref || (a.cats.map(c => (c.match(PREF_RE) || [])[1]).find(Boolean)) || "";
  rows.push({
    id: "ja:" + a.pageid, kind: KYO_RE.test(a.title) || (w?.p527?.length > 1) ? "郷" : "温泉", parent: "", name: a.title.replace(/ \(.*\)$/, ""), title: a.title, reading: a.reading || "", pref, muni: a.muni || w?.muni || "",
    lon: coord ? coord[0] : "", lat: coord ? coord[1] : "", coord_source: src, coord_precision: precision, coord_accuracy_m: accuracy(precision, note), coord_note: note, missing_reason: reason,
    quality: a.quality || "", quality_class: qualityClass(a.quality), temp: a.temp || "", ph: a.ph || "", liquid: a.liquid || "", osmotic: a.osmotic || "", flow: a.flow || "", lodgings: a.lodgings || "", address: a.address || "",
    qid: a.qid || "", wikipedia_ja: "https://ja.wikipedia.org/wiki/" + encodeURIComponent(a.title.replace(/ /g, "_")), wikipedia_en: w?.enwiki ? "https://en.wikipedia.org/wiki/" + encodeURIComponent(w.enwiki.replace(/ /g, "_")) : "",
    wikidata: a.qid ? "https://www.wikidata.org/wiki/" + a.qid : "", image: w?.image || "", site: a.site || "", infobox: a.hasInfobox ? 1 : 0, sources: a.sources.join(";"),
    coord_kind: "", source_separate: a.sourceSeparate ? 1 : 0, source_kind: a.sourceKind || "", source_from: a.sourceFrom || "", source_from_id: "", source_lon: "", source_lat: "", source_distance_m: a.sourceDistanceM ?? "", source_note: a.sourceNote || "",
    _links: a.links || [], _cats: a.cats, _p361: w?.p361 || [], _p527: w?.p527 || [], _sourceCoord: a.sourceCoord || null,
  });
}
// Wikidata にはあるが日本語記事に結びつかなかった温泉（jawiki の無いもの）
const jaKeys = new Set(rows.map(r => r.name + "|" + r.pref));
let wdDup = 0, wdNoLabel = 0;
for (const w of Object.values(wd)) {
  if (!w.sparql || used.has(w.qid) || w.jawiki) continue;
  if (!w.labelJa && !w.labelEn) { wdNoLabel++; continue; } // ラベルすら無い項目は地図に出せないので持たない
  if (w.labelJa && jaKeys.has(w.labelJa + "|" + (w.pref || "")) ) { wdDup++; continue; } // 同名・同県の記事行がある（Wikidata 側に jawiki リンクが無いだけ）
  let coord = inJapan(w.coord) ? w.coord : null, src = coord ? "wikidata:P625" : "", precision = coord ? "exact" : "", note = "";
  const g = geo["wd:" + w.qid]; if (!coord && g?.coord) { coord = g.coord; src = g.source; precision = g.precision; note = `${g.query} → ${g.matched}`; }
  rows.push({ id: "wd:" + w.qid, kind: KYO_RE.test(w.labelJa || "") || (w.p527?.length > 1) ? "郷" : "温泉", parent: "", name: w.labelJa || w.labelEn || w.qid, title: "", reading: "", pref: w.pref || "", muni: w.muni || "", lon: coord ? coord[0] : "", lat: coord ? coord[1] : "",
    coord_source: src, coord_precision: precision, coord_accuracy_m: accuracy(precision, note), coord_note: note, missing_reason: coord ? "" : "Wikidata のみ・座標なし" + (g ? "・推定も不能" : ""), quality: "", quality_class: "", temp: "", ph: "", liquid: "", osmotic: "", flow: "", lodgings: "", address: "", qid: w.qid,
    wikipedia_ja: "", wikipedia_en: w.enwiki ? "https://en.wikipedia.org/wiki/" + encodeURIComponent(w.enwiki.replace(/ /g, "_")) : "", wikidata: "https://www.wikidata.org/wiki/" + w.qid, image: w.image || "", site: "", infobox: 0, sources: "wikidata:sparql",
    coord_kind: "", source_separate: 0, source_kind: "", source_from: "", source_from_id: "", source_lon: "", source_lat: "", source_distance_m: "", source_note: "", _links: [], _cats: [], _p361: w.p361 || [], _p527: w.p527 || [], _sourceCoord: null });
}

// ---- 温泉郷（集合体）と配下の温泉を結ぶ ----
// 根拠（いずれか・同じ都道府県に限る）: 郷の記事が配下を本文でリンク / 配下の記事が郷をリンク / 配下が「Category:○○温泉郷」に属する / Wikidata P527(構成要素)・P361(一部)
const byTitle = new Map(rows.filter(r => r.title).map(r => [r.title, r])), byQid = new Map(rows.filter(r => r.qid).map(r => [r.qid, r]));
const samePref = (a, b) => !a.pref || !b.pref || a.pref === b.pref;
// 郷の追加判定 (b): 記事と同名のカテゴリ（例: Category:別府温泉）に他の温泉記事が 2 件以上属していれば集合体とみなす
const catCount = {}; for (const r of rows) for (const c of r._cats) catCount[c] = (catCount[c] || 0) + 1;
for (const r of rows) if (r.kind !== "郷" && r.title && /温泉(郷|峡|群)?$/.test(r.title) && (catCount[r.title] || 0) >= 3) r.kind = "郷"; // 自分自身も数に入るので 3
const kyo = rows.filter(r => r.kind === "郷");
const members = new Map(kyo.map(k => [k.id, new Set()]));
const link = (k, m, why) => { if (m && m !== k && m.kind !== "郷" && samePref(k, m)) { members.get(k.id).add(m.id); (m._why ??= []).push(`${k.name}:${why}`); } };
for (const k of kyo) {
  for (const t of k._links) link(k, byTitle.get(t), "郷→本文リンク");
  for (const q of k._p527) link(k, byQid.get(q), "P527");
}
for (const r of rows) if (r.kind !== "郷") {
  for (const t of r._links) { const k = byTitle.get(t); if (k?.kind === "郷") link(k, r, "本文→郷リンク"); }
  for (const c of r._cats) { const k = byTitle.get(c) || kyo.find(x => x.name === c); if (k?.kind === "郷") link(k, r, "カテゴリ"); }
  for (const q of r._p361) { const k = byQid.get(q); if (k?.kind === "郷") link(k, r, "P361"); }
}
const byId = new Map(rows.map(r => [r.id, r]));
for (const k of kyo) for (const id of members.get(k.id)) { const m = byId.get(id); m.parent = m.parent ? m.parent + ";" + k.id : k.id; }
for (const k of kyo) k.parent = ""; // 郷同士の入れ子は持たない
// 座標が無い／市町村中心しか無い配下の温泉は、所属する郷の点（郷自身＋座標が実測の配下）の重心で置き直す（精度 region）
for (const k of kyo) {
  const ms = [...members.get(k.id)].map(id => byId.get(id));
  const pts = [k, ...ms].filter(r => r.coord_precision === "exact" || r.coord_precision === "name" || r.coord_precision === "address").map(r => [r.lon, r.lat]);
  if (!pts.length) continue;
  const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length].map(v => +v.toFixed(6));
  for (const m of ms) if (m.lon === "" || m.coord_precision === "municipality") { m.lon = c[0]; m.lat = c[1]; m.coord_source = "estimate:region"; m.coord_precision = "region"; m.coord_accuracy_m = ACCURACY.region; m.coord_note = `所属する ${k.name} の重心（${pts.length} 点）`; m.missing_reason = ""; }
}

// 面: 配下の点（＋郷自身の点）を半径 1 km の 16 角形に広げた凸包。配下が無く点も無い郷は面なし。
const R = 1000, EARTH = 6371008.8;
const circle = ([lon, lat]) => Array.from({ length: 16 }, (_, i) => { const t = (i / 16) * 2 * Math.PI; return [lon + (R * Math.cos(t)) / (EARTH * Math.cos((lat * Math.PI) / 180)) * (180 / Math.PI), lat + (R * Math.sin(t)) / EARTH * (180 / Math.PI)]; });
function hull(pts) { // Andrew の単調鎖
  const p = [...new Map(pts.map(q => [q.join(), q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
const kyoFeatures = [];
for (const k of kyo) {
  const ms = [...members.get(k.id)].map(id => byId.get(id));
  const pts = [...ms, k].filter(r => r.lon !== "").map(r => [r.lon, r.lat]);
  k.member_count = ms.length; k.members = ms.map(m => m.id).join(";");
  if (!pts.length) continue;
  const ring = hull(pts.flatMap(circle)).map(q => q.map(v => +v.toFixed(6))); ring.push(ring[0]);
  const { lon, lat, _links, _cats, _p361, _p527, _why, ...props } = k;
  kyoFeatures.push({ type: "Feature", id: k.id, geometry: { type: "Polygon", coordinates: [ring] }, properties: { ...props, center_lon: lon, center_lat: lat, member_names: ms.map(m => m.name).join(";"), member_points: pts.length - (k.lon !== "" ? 1 : 0), polygon_basis: pts.length - (k.lon !== "" ? 1 : 0) >= 2 ? "members-hull" : "point-buffer" } });
}
// ---- 日本秘湯を守る会の会員宿を温泉に結ぶ ----
// 根拠の優先順: 宿頁の温泉名が記事名と一致（同じ都道府県） > 宿名・住所に記事名（「温泉」を除いた芯、2 文字以上）を含む > 座標が 2.5 km 以内で最も近い実測点（同じ都道府県）
const hav = (a, b) => { const R = 6371008.8, d = Math.PI / 180, dLat = (b[1] - a[1]) * d, dLon = (b[0] - a[0]) * d, h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * d) * Math.cos(b[1] * d) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const coreOf = n => n.replace(/ \(.*\)$/, "").replace(/温泉郷?$|鉱泉$/, "");
for (const r of rows) { r.hitou_member = 0; r.hitou_inns = ""; r.hitou_urls = ""; }
const innRows = [];
for (const inn of hitou) {
  const cand = rows.filter(r => r.kind !== "郷" && (!inn.pref || !r.pref || r.pref === inn.pref));
  let hit = null, basis = "";
  if (inn.onsen) { hit = cand.find(r => r.name === inn.onsen) || cand.find(r => coreOf(r.name) === coreOf(inn.onsen)); if (hit) basis = "温泉名一致"; }
  if (!hit) { const txt = (inn.name || "") + " " + (inn.address || ""); const m = cand.filter(r => { const c = coreOf(r.name); return c.length >= 2 && txt.includes(c); }).sort((a, b) => coreOf(b.name).length - coreOf(a.name).length); if (m.length) { hit = m[0]; basis = "宿名・住所に記事名"; } }
  if (!hit && inn.lon != null) { let best = null, bd = 2500; for (const r of cand) if (r.lon !== "" && r.coord_precision === "exact") { const d = hav([inn.lon, inn.lat], [r.lon, r.lat]); if (d < bd) { bd = d; best = r; } } if (best) { hit = best; basis = `最近傍 ${Math.round(bd)} m`; } }
  // 郷にしか結べない場合（温泉名が郷の記事）も残す
  if (!hit && inn.onsen) { const k = rows.find(r => r.kind === "郷" && (r.name === inn.onsen || coreOf(r.name) === coreOf(inn.onsen)) && (!inn.pref || r.pref === inn.pref)); if (k) { hit = k; basis = "温泉郷名一致"; } }
  if (hit) { hit.hitou_member++; hit.hitou_inns += (hit.hitou_inns ? ";" : "") + inn.name; hit.hitou_urls += (hit.hitou_urls ? ";" : "") + inn.url; }
  innRows.push({ hitou_id: inn.id, inn: inn.name, onsen_on_site: inn.onsen || "", pref: inn.pref || "", address: inn.address || "", lon: inn.lon ?? "", lat: inn.lat ?? "", quality: inn.quality || "", season: inn.season || "", url: inn.url, onsen_id: hit?.id || "", onsen_name: hit?.name || "", match_basis: basis });
}

// ---- 源泉の位置 ----
// 源泉座標の出どころ: 本文の「源泉」近くの coord テンプレート > 引湯元の温泉記事の座標。両方あれば温泉地との距離（m）を計算。
// coord_kind: 温泉地（本文が源泉は別の場所と言っている、または源泉座標が別にある）/ 源泉（主座標が源泉座標と一致）/ 未判定（手がかりなし。通常は温泉街の代表点）
const haversine = (a, b) => { const R = 6371008.8, d = Math.PI / 180, dLat = (b[1] - a[1]) * d, dLon = (b[0] - a[0]) * d, h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * d) * Math.cos(b[1] * d) * Math.sin(dLon / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); };
const byName = new Map(rows.filter(r => r.title).map(r => [r.name, r]));
const sourceFeatures = [];
for (const r of rows) {
  let sc = inJapan(r._sourceCoord) ? r._sourceCoord : null;
  if (r.source_from) { const f = byTitle.get(r.source_from) || byName.get(r.source_from.replace(/ \(.*\)$/, "")); if (f) { r.source_from_id = f.id; if (!sc && f.lon !== "" && f.coord_precision === "exact") sc = [f.lon, f.lat]; } }
  if (sc) { r.source_lon = sc[0]; r.source_lat = sc[1]; }
  if (sc && r.lon !== "") { const d = haversine([r.lon, r.lat], sc); if (r.source_distance_m === "" || r.source_distance_m == null) r.source_distance_m = d; r.coord_kind = d < 150 ? "源泉" : "温泉地"; }
  else if (r.source_separate) r.coord_kind = "温泉地";
  else r.coord_kind = r.lon === "" ? "" : "未判定";
  if (sc && r.lon !== "") {
    const props = { onsen_id: r.id, name: r.name, pref: r.pref, source_kind: r.source_kind, source_from: r.source_from, source_from_id: r.source_from_id, source_distance_m: r.source_distance_m, source_note: r.source_note, wikipedia_ja: r.wikipedia_ja };
    sourceFeatures.push({ type: "Feature", id: r.id + ":source", geometry: { type: "Point", coordinates: sc }, properties: { ...props, role: "源泉" } });
    sourceFeatures.push({ type: "Feature", id: r.id + ":link", geometry: { type: "LineString", coordinates: [[r.lon, r.lat], sc] }, properties: { ...props, role: "温泉地→源泉" } });
  }
}
for (const r of rows) { delete r._sourceCoord; }
for (const r of rows) { delete r._links; delete r._cats; delete r._p361; delete r._p527; if (r.kind !== "郷") { delete r.member_count; delete r.members; } r.parent_basis = (r._why || []).join(";"); delete r._why; }
const prefOrder = p => { const i = PREFS.indexOf(p); return i < 0 ? 99 : i; };
rows.sort((a, b) => prefOrder(a.pref) - prefOrder(b.pref) || a.name.localeCompare(b.name, "ja"));

const DATA = path.join(ROOT, "data"); fs.mkdirSync(DATA, { recursive: true });
const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
const csv = v => { v = String(v ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
fs.writeFileSync(path.join(DATA, "onsen.csv"), "﻿" + [cols.join(","), ...rows.map(r => cols.map(c => csv(r[c])).join(","))].join("\n") + "\n");
const miss = rows.filter(r => !r.lon);
fs.writeFileSync(path.join(DATA, "onsen-missing.csv"), "﻿" + [cols.join(","), ...miss.map(r => cols.map(c => csv(r[c])).join(","))].join("\n") + "\n");
const fc = { type: "FeatureCollection", features: rows.filter(r => r.lon !== "").map(r => { const { lon, lat, ...p } = r; return { type: "Feature", id: r.id, geometry: { type: "Point", coordinates: [lon, lat] }, properties: p }; }) };
fs.writeFileSync(path.join(DATA, "onsen.geojson"), JSON.stringify(fc));
fs.writeFileSync(path.join(DATA, "onsen-kyo.geojson"), JSON.stringify({ type: "FeatureCollection", features: kyoFeatures }));
fs.writeFileSync(path.join(DATA, "onsen-sources.geojson"), JSON.stringify({ type: "FeatureCollection", features: sourceFeatures }));
fs.writeFileSync(path.join(DATA, "excluded.csv"), "\ufeff" + ["title,reason", ...excluded.map(e => csv(e.title) + "," + csv(e.reason))].join("\n") + "\n");
if (innRows.length) {
  const ic = Object.keys(innRows[0]);
  fs.writeFileSync(path.join(DATA, "hitou-inns.csv"), "\ufeff" + [ic.join(","), ...innRows.map(r => ic.map(c => csv(r[c])).join(","))].join("\n") + "\n");
  fs.writeFileSync(path.join(DATA, "hitou-inns.geojson"), JSON.stringify({ type: "FeatureCollection", features: innRows.filter(r => r.lon !== "").map(r => { const { lon, lat, ...p } = r; return { type: "Feature", id: "hitou:" + r.hitou_id, geometry: { type: "Point", coordinates: [lon, lat] }, properties: p }; }) }));
}
// 統計
const byPrec = {}; for (const r of rows) byPrec[r.coord_precision || "(なし)"] = (byPrec[r.coord_precision || "(なし)"] || 0) + 1;
const bySrc = {}; for (const r of rows) bySrc[r.coord_source || "(なし)"] = (bySrc[r.coord_source || "(なし)"] || 0) + 1;
const byPref = {}; for (const r of rows) { const k = r.pref || "(不明)"; byPref[k] ??= { total: 0, withCoord: 0 }; byPref[k].total++; if (r.lon !== "") byPref[k].withCoord++; }
const stats = { generated: new Date().toISOString(), total: rows.length, excludedArticles: excluded.length, wikidataDuplicatesDropped: wdDup, wikidataNoLabelDropped: wdNoLabel, fromWikipedia: rows.filter(r => r.title).length, wikidataOnly: rows.filter(r => !r.title).length,
  withCoord: rows.length - miss.length, exactCoord: rows.filter(r => r.coord_precision === "exact").length, estimatedCoord: rows.filter(r => r.lon !== "" && r.coord_precision !== "exact").length, byPrecision: byPrec,
  kyo: kyo.length, kyoPolygons: kyoFeatures.length, withParent: rows.filter(r => r.parent).length,
  hitouInns: innRows.length, hitouMatched: innRows.filter(r => r.onsen_id).length, onsenWithHitou: rows.filter(r => r.hitou_member).length,
  sourceSeparate: rows.filter(r => r.source_separate).length, sourceWithCoord: rows.filter(r => r.source_lon !== "").length, bySourceKind: (() => { const m = {}; for (const r of rows) if (r.source_kind) m[r.source_kind] = (m[r.source_kind] || 0) + 1; return m; })(), byCoordKind: (() => { const m = {}; for (const r of rows) if (r.coord_kind) m[r.coord_kind] = (m[r.coord_kind] || 0) + 1; return m; })(), coordRate: +((rows.length - miss.length) / rows.length).toFixed(3), withQuality: rows.filter(r => r.quality).length, withQualityClass: rows.filter(r => r.quality_class).length, byQualityClass: (() => { const m = {}; for (const r of rows) for (const k of (r.quality_class || "(なし)").split(";")) m[k] = (m[k] || 0) + 1; return m; })(), withReading: rows.filter(r => r.reading).length, withQid: rows.filter(r => r.qid).length, withInfobox: rows.filter(r => r.infobox).length, bySource: bySrc, byPref };
writeJSON("data/stats.json", stats);
console.error(JSON.stringify({ total: stats.total, withCoord: stats.withCoord, coordRate: stats.coordRate, bySource: bySrc }));
