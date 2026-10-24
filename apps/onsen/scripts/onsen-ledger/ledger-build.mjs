#!/usr/bin/env node
// 7) 04-build の出力（data/onsen.csv・onsen-kyo.geojson・hitou-inns.csv）→ 頁が読む台帳 ortho-data/japan/onsen.json
//    node ledger-build.mjs [--data DIR]   既定の DIR＝$ONSEN_ROOT/data（= .cache/data）
//
// 台帳の形（onsen.js が読む・短い鍵＝2,000 件で 0.6 MB 程度に収める）
//   items[]  : { id, k:"o"|"g"（温泉／温泉郷）, n:名前, r:よみ, en:英語名（en 記事題名か よみのローマ字）, p:都道府県コード, m:市町村,
//                c:[lon,lat], a:精度 m（0＝実測）, e:推定の方法（"osm"|"addr"|"muni"|"region"）, q:泉質の原文, qc:[分類の番号],
//                t:泉温, ph, l:液性, w:{ja,en}（記事題名）, qid, site, par:[郷の id], h:[会員宿の番号],
//                s:{ c:[lon,lat]|null, d:m, k:種別, f:引湯元の id, x:根拠の文 }（源泉が離れている時だけ）, poly:[[lon,lat]…]（郷の面）}
//   classes  : 泉質 10 分類の日本語名（qc の番号の表）
//   inns[]   : 日本秘湯を守る会の会員宿 { n, c, u, o:温泉の id|null, q }
//   prefNames: 都道府県名 26 言語（ortho-data/japan/parks.json と同じ表を写す）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib.mjs";
import { readCsv, enFromReading, kyoPolys } from "./shape.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), APP = path.resolve(HERE, "../..");
const ai = process.argv.indexOf("--data"), DATA = ai > 0 ? path.resolve(process.argv[ai + 1]) : path.join(ROOT, "data");
const PUB = path.join(APP, "../../ortho-data/japan"), OUT = path.join(PUB, "onsen.json");   // 正本＝リポの根の ortho-data/japan/（置く＝npm run publish:pages -w world-data -- --scope=japan）

// ── 読み込み ──
const rows = readCsv(path.join(DATA, "onsen.csv"));
const kyoGeo = JSON.parse(fs.readFileSync(path.join(DATA, "onsen-kyo.geojson"), "utf8"));
const innsCsv = fs.existsSync(path.join(DATA, "hitou-inns.csv")) ? readCsv(path.join(DATA, "hitou-inns.csv")) : [];
const parks = JSON.parse(fs.readFileSync(path.join(PUB, "parks.json"), "utf8"));
const prefNames = parks.prefNames, prefCode = Object.fromEntries(Object.entries(prefNames).map(([c, v]) => [v.ja, +c]));
const CLASSES = ["単純温泉", "塩化物泉", "炭酸水素塩泉", "硫酸塩泉", "二酸化炭素泉", "含鉄泉", "酸性泉", "含よう素泉", "硫黄泉", "放射能泉"];

// 04-build の篩を抜けた施設記事のうち、題名から温泉でないと分かる物（駅・ビル・遊園地・滝・浜…）を落とす
const NOT_ONSEN = /駅$|ビル$|テック$|テニス村$|体育館$|^弓ヶ浜|の滝$/;
// Wikidata にしか居ず日本語・英語の名前も無い物（名前が QID のまま＝青森県の 20 件ほど）も落とす＝地図に Q49741929 と出ても読めない
const keep = rows.filter(r => !(NOT_ONSEN.test(r.name) && !/温泉|鉱泉/.test(r.name)) && !/^Q\d+$/.test(r.name) && r.lon !== "");
const dropped = rows.length - keep.length;
const shortId = id => id.replace(/^ja:/, "j").replace(/^wd:/, "w");
const ids = new Set(keep.map(r => shortId(r.id)));
const title = u => { const s = String(u || "").split("/wiki/")[1]; if (!s) return ""; try { return decodeURIComponent(s).replace(/_/g, " "); } catch { return ""; } };
const num = v => { const n = parseFloat(String(v).replace(/[,，]/g, "").match(/-?\d+(\.\d+)?/)?.[0]); return Number.isFinite(n) ? n : null; };
const EST = { "estimate:osm-name": "osm", "estimate:gsi-address": "addr", "estimate:gsi-municipality": "muni", "estimate:region": "region" };   // ＋下の後始末で "kyo"（温泉郷の位置に置いた）
const r5 = v => Math.round(v * 1e5) / 1e5;

// 会員宿（宿の番号＝inns の添字）
const inns = innsCsv.map(i => ({ n: i.inn, c: i.lon !== "" ? [r5(+i.lon), r5(+i.lat)] : null, u: i.url, o: i.onsen_id && ids.has(shortId(i.onsen_id)) ? shortId(i.onsen_id) : null, q: i.quality || undefined }));
const innsOf = new Map(); inns.forEach((x, j) => { if (x.o) (innsOf.get(x.o) || innsOf.set(x.o, []).get(x.o)).push(j); });
// 郷の面
const polyOf = new Map(kyoGeo.features.map(f => [shortId(f.id), f.geometry.coordinates[0].map(p => [+p[0].toFixed(4), +p[1].toFixed(4)])]));

const items = keep.map(r => {
	const id = shortId(r.id), en = title(r.wikipedia_en);
	const d = { id, k: r.kind === "郷" ? "g" : "o", n: r.name };
	if (r.reading) d.r = r.reading;
	d.en = /onsen|hot spring|spa|kosen/i.test(en) ? en.replace(/ \(.*\)$/, "") : enFromReading(r.reading) || undefined;
	const pc = prefCode[r.pref]; if (pc) d.p = pc;
	if (r.muni) d.m = r.muni;
	d.c = [r5(+r.lon), r5(+r.lat)];
	d.a = r.coord_precision === "exact" ? 0 : +r.coord_accuracy_m || 0;
	if (EST[r.coord_source]) d.e = EST[r.coord_source];
	if (r.quality) d.q = r.quality;
	const qc = (r.quality_class || "").split(";").filter(Boolean).map(k => CLASSES.indexOf(k)).filter(i => i >= 0); if (qc.length) d.qc = qc;
	const tv = num(r.temp); if (tv != null && tv > 0 && tv < 120) d.t = tv;
	const ph = num(r.ph); if (ph != null && ph >= 0 && ph <= 14) d.ph = ph;
	if (r.liquid) d.l = r.liquid;
	const w = {}; if (r.wikipedia_ja) w.ja = title(r.wikipedia_ja); if (en) w.en = en; if (w.ja || w.en) d.w = w;
	if (r.qid) d.qid = r.qid;
	if (/^https?:\/\//.test(r.site)) d.site = r.site;
	const par = (r.parent || "").split(";").filter(Boolean).map(shortId).filter(x => ids.has(x)); if (par.length) d.par = par;
	if (innsOf.has(id)) d.h = innsOf.get(id);
	if (r.source_separate === "1") d.s = { c: r.source_lon !== "" ? [r5(+r.source_lon), r5(+r.source_lat)] : null, d: num(r.source_distance_m) ?? undefined, k: r.source_kind || undefined,
		f: r.source_from_id && ids.has(shortId(r.source_from_id)) ? shortId(r.source_from_id) : undefined, fn: r.source_from || undefined, x: r.source_note || undefined };
	if (d.k === "g" && polyOf.has(id)) d.poly = polyOf.get(id);
	return d;
});

// ── 後始末（頁で見て分かった粗さを台帳の段で直す）──
//   ① 地域しか分からない推定（region）は地方の中心に置かれていた＝都道府県の実測の点の中央値へ寄せる（道後の宿が鳥取に出ていた）
//   ② 郷の構成員の所属はカテゴリ由来＝県の温泉が丸ごと入る事がある（水上温泉郷に草津・伊香保）。郷から 25 km 超は所属を外す。
//      ただし推定の点（地名の取り違え＝屈斜路のコタン温泉が別のコタンに出ていた）は郷の位置へ置き直して所属を残す
//   ③ 郷の面は所属を直した後の点（郷の座標＋構成員）を 1.5 km 太らせた凸包で作り直す（04-build の面は外した構成員も包んでいた）
const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);
const median = v => { const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const prefCenter = new Map();
for (let p = 1; p <= 47; p++) { const pts = items.filter(d => d.p === p && d.a === 0).map(d => d.c); if (pts.length) prefCenter.set(p, [r5(median(pts.map(c => c[0]))), r5(median(pts.map(c => c[1])))]); }
let moved = 0, unlinked = 0, relinked = 0;
for (const d of items) if (d.e === "region" && prefCenter.has(d.p)) { d.c = prefCenter.get(d.p); d.a = Math.max(d.a, 30000); moved++; }
const byId = new Map(items.map(d => [d.id, d]));
// 郷に入れない温泉（本人の裁定）。Wikidata の「一部」は広く付き過ぎることがある
const NO_KYO = new Set([
	"西那須野温泉",   // 塩原温泉郷・那須温泉郷のどちらでもない（本人 2026-10-24）
]);
for (const d of items) if (NO_KYO.has(d.n)) delete d.par;
for (const d of items) {
	if (!d.par) continue;
	d.par = d.par.filter(g => {
		const k = byId.get(g); if (!k || kmOf(d.c, k.c) <= 25) return true;
		if (d.a > 0 && !d.par.some(o => o !== g && byId.get(o) && kmOf(d.c, byId.get(o).c) <= 25)) { d.c = k.c; d.a = Math.max(k.a, 5000); d.e = "kyo"; relinked++; return true; }
		unlinked++; return false;
	});
	if (!d.par.length) delete d.par;
}
kyoPolys(items);

const doc = {
	_: "日本の温泉（scripts/onsen-ledger が組む・Wikipedia 日本語版 CC BY-SA 4.0／Wikidata CC0／推定座標 OpenStreetMap ODbL・国土地理院／会員宿 日本秘湯を守る会）",
	generated: new Date().toISOString().slice(0, 10),
	classes: CLASSES,
	items, inns, prefNames,
};
fs.writeFileSync(OUT, JSON.stringify(doc));
const cnt = k => items.filter(k).length;
console.log(JSON.stringify({ items: items.length, dropped, moved, unlinked, relinked, kyo: cnt(d => d.k === "g"), poly: cnt(d => d.poly), estimated: cnt(d => d.a > 0), withClass: cnt(d => d.qc), withSource: cnt(d => d.s), withSourceCoord: cnt(d => d.s?.c), inns: inns.length, innsLinked: inns.filter(x => x.o).length, en: cnt(d => d.en), bytes: fs.statSync(OUT).size }));
