#!/usr/bin/env node
// 8) 温泉一覧（source/onsen-list.csv＝Kenji の元データ・4,566 行）を台帳 ortho-data/japan/onsen.json に重ねる。ledger-build.mjs の後に走らせる
//    node ledger-list.mjs [--csv FILE]
//
// 一覧の列：都道府県・市区町村・温泉郷・温泉郷読み・温泉名・温泉読み・ローマ字・番付・wiki・コード（市区町村）・経度・緯度・深度・湯量・湯温・pH・成分
//   温泉名は「温泉」を付けない地名（新川・札幌(中央)）。深度 -1＝自然湧出。湯量 L/分。成分は分析表の記号（Na-Cl・単純S泉・単純弱Rn泉）。
//   番付は江戸の番付（諸國温泉効能鑑）の位（東前頭8・行司4/西前頭41・勧進元・差添）。1／-1 は位でない印＝持たない。
//   列が 10 しか無い行（29 行・「幸福温泉</span>(西諸県郡高原町)」）は よみ・番付・wiki・測定値が無い＝名前の後ろの残骸を落とし、座標だけ使う。
//
// 重ね方（一覧を元データとして優先する）
//   ① 突き合わせ＝同じ県で ⓐ wiki の題が台帳の w.ja と同じ、か ⓑ 名前（温泉・鉱泉・温泉郷・括弧を除く）が同じ、で 15 km 以内（推定の点は誤差の分も許す）
//   ② 当たった温泉：推定の点（a>0）は一覧の座標へ置き直す（a=0・cs=1）。泉温・pH・泉質の分類・よみが無ければ一覧で埋める
//   ③ 当たらない行は新しい温泉（id＝k＋行番号）。名前は「温泉」を補う（新川→新川温泉・札幌(中央)→札幌温泉(中央)）。同じ名前で 1 km 以内の行は 1 件にまとめる
//   ④ 一覧の測定値は x:[{ n:一覧の名, dp:深度 m（-1＝自然湧出）, fl:湯量 L/分, t, ph, f:成分, c:座標（温泉の点と違う時だけ）}] に持つ
//   ⑤ 温泉郷：一覧の郷の列を正とする。一覧に出る郷は、一覧に当たった温泉の所属を一覧どおりに置き換える（台帳の郷に名前で当て、無ければ新しい郷 id＝kg＋番号）。
//      一覧に出ない郷の所属は台帳のまま。郷の面は所属を直した後で作り直す
//   ⑥ 江戸の番付の位は bz に持つ（頁の江戸番付はこれで温泉を当てる）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, enFromReading, kyoPolys } from "./shape.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), APP = path.resolve(HERE, "../..");
const ci = process.argv.indexOf("--csv"), CSV = ci > 0 ? path.resolve(process.argv[ci + 1]) : path.join(HERE, "source/onsen-list.csv");
const OUT = path.join(APP, "../../ortho-data/japan/onsen.json");

const db = JSON.parse(fs.readFileSync(OUT, "utf8"));
if (db.items.some(d => d.x || /^k/.test(d.id))) throw new Error("onsen.json は既に一覧を重ねてある＝先に ledger-build.mjs で組み直す");
const items = db.items, prefCode = Object.fromEntries(Object.entries(db.prefNames).map(([c, v]) => [v.ja, +c]));
const r5 = v => Math.round(v * 1e5) / 1e5;
const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);
const numOr = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// ── 一覧を読む（列の欠けた行を直す）──
const rows = readCsv(CSV).map((r, i) => {
	const short = r["経度"] === "" && r["コード"] !== "" && r["番付"] !== "";   // 10 列の行＝番付の位置にコード・wiki に経度・コードに緯度
	const o = short ? { ...r, コード: r["番付"], 経度: r["wiki"], 緯度: r["コード"], 番付: "0", wiki: "0", 深度: "", 湯量: "", 湯温: "", pH: "", 成分: "" } : r;
	const v = k => (o[k] === "0" || o[k] == null ? "" : o[k].trim());
	return { i: i + 1, pref: v("都道府県"), muni: v("市区町村"), kyo: v("温泉郷"), kyoR: v("温泉郷読み"), name: v("温泉名").replace(/<\/span>.*$/, ""), r: v("温泉読み"),
		rank: /^(東|西|行司|勧進元|差添)/.test(v("番付")) ? v("番付") : "", wiki: v("wiki").replace(/_/g, " "), c: [r5(+o["経度"]), r5(+o["緯度"])],
		dp: numOr(o["深度"]), fl: numOr(o["湯量"]), t: numOr(o["湯温"]), ph: numOr(o["pH"]), f: v("成分") === "-" ? "" : v("成分") };
}).filter(r => r.name && r.c[0] > 120 && r.c[1] > 20);

// 名前の鍵：全角・半角を揃え、温泉／鉱泉／温泉郷・括弧を除く（「湯の川温泉 (北海道)」→ 湯の川）
const key = s => String(s || "").normalize("NFKC").replace(/\s*[(（][^)）]*[)）]\s*/g, "").replace(/(温泉郷|温泉峡|温泉群|温泉|鉱泉)$/, "").replace(/[ヶケが]/g, "ヶ").replace(/\s/g, "");
const wikiTitle = w => w.split("#")[0].trim();

// 成分記号 → 泉質 10 分類（環境省の掲示用新泉質名の順：単純 塩化物 炭酸水素塩 硫酸塩 二酸化炭素 含鉄 酸性 含よう素 硫黄 放射能）。記号の現れた順
function classesOf(f) {
	if (!f) return [];
	const hits = [], add = (i, at) => { if (at >= 0) hits.push([at, i]); };
	const pos = re => { const m = re.exec(f); return m ? m.index : -1; };
	add(9, pos(/Rn/)); add(8, pos(/H_?2S|(^|[^A-Za-z])S(?![A-Za-z_])/)); add(7, pos(/(^|[^A-Za-z])I(?![A-Za-z])/)); add(6, pos(/(^|[^A-Za-z])H(?=[-・])|酸性/));
	add(5, pos(/Fe/)); add(4, pos(/CO_?2/)); add(3, pos(/SO_?4/)); add(2, pos(/HCO_?3/)); add(1, pos(/Cl/));
	const out = [...new Map(hits.sort((a, b) => a[0] - b[0]).map(([, i]) => [i, i])).keys()];
	if (/単純/.test(f) && !/単純(弱)?(S|Rn|CO|Fe|H)/.test(f)) out.unshift(0);   // 単純泉（単純S泉は硫黄泉・単純弱Rn泉は放射能泉）
	return [...new Set(out)];
}

// ── ① 突き合わせ ──
const onsens = items.filter(d => d.k === "o"), kyos = items.filter(d => d.k === "g");
const byWiki = new Map(); for (const d of items) if (d.w?.ja) (byWiki.get(d.w.ja) || byWiki.set(d.w.ja, []).get(d.w.ja)).push(d);
const near = (d, r) => kmOf(d.c, r.c) <= 15 + (d.a || 0) / 1000;
function matchOf(r) {
	const p = prefCode[r.pref], k = key(r.name);
	const byName = onsens.filter(d => d.p === p && key(d.n) === k && near(d, r)).sort((a, b) => kmOf(a.c, r.c) - kmOf(b.c, r.c))[0];
	if (byName) return byName;
	const w = r.wiki && byWiki.get(wikiTitle(r.wiki))?.find(d => d.p === p && near(d, r));
	if (w && w.k === "o") return w;
	if (w && w.k === "g" && key(w.n) === k) return w;   // 郷そのものの行（箱根・道後）
	return null;   // wiki が郷を指す行は郷の構成員＝新しい温泉にする（⑤で郷へ結ぶ）
}
const matched = new Map(), rest = [];
for (const r of rows) { const d = matchOf(r); if (d) (matched.get(d) || matched.set(d, []).get(d)).push(r); else rest.push(r); }
// ⓒ 片方の名前がもう片方を含み 1.5 km 以内（裏磐梯早稲沢↔早稲沢・海ノ口↔佐久海ノ口・湯原温泉 猫鼻の湯↔湯原）。まだ一覧に当たっていない温泉だけ。
//    差が 1 字か「新・西・東・下・奥…」だけの物は別の温泉（西鉛↔鉛・新五色↔五色）
const fresh = [], PREFIX = /^(新|西|東|南|北|下|上|奥|元|中|本|裏|表)+$/;
for (const r of rest) {
	const p = prefCode[r.pref], k = key(r.name);
	const d = k.length >= 2 && onsens.filter(d => d.p === p && !matched.has(d) && kmOf(d.c, r.c) <= 1.5 + (d.a || 0) / 1000).find(d => {
		const o = key(d.n); if (o.length < 2 || o === k) return false;
		const [lo, sh] = o.length > k.length ? [o, k] : [k, o]; if (!lo.includes(sh)) return false;
		const diff = lo.replace(sh, ""); return diff.length >= 2 && !PREFIX.test(diff);
	});
	if (d) matched.set(d, [r]); else fresh.push(r);
}

// 一覧の 1 行 → 測定値の記録（深度 0・湯量 0 は記載なし）
const rec = (r, c) => { const x = { n: r.name }; if (r.dp === -1 || r.dp > 0) x.dp = r.dp; if (r.fl != null && r.fl > 0) x.fl = r.fl; if (r.t != null && r.t > 0 && r.t < 120) x.t = r.t;
	if (r.ph != null && r.ph >= 0 && r.ph <= 14) x.ph = r.ph; if (r.f) x.f = r.f; if (!c || kmOf(c, r.c) > 0.05) x.c = r.c; return x; };
const isRec = x => Object.keys(x).length > 1;   // 名前だけの記録（10 列の行）は持たない

// ── ② 当たった温泉を一覧で埋める ──
let relocated = 0;
for (const [d, rs] of matched) {
	const best = rs.find(r => key(r.name) === key(d.n)) || rs.slice().sort((a, b) => kmOf(a.c, d.c) - kmOf(b.c, d.c))[0];
	if (d.a > 0) { d.c = best.c; d.a = 0; delete d.e; d.cs = 1; relocated++; }
	if (d.t == null && best.t > 0 && best.t < 120) d.t = best.t;
	if (d.ph == null && best.ph != null && best.ph >= 0 && best.ph <= 14) d.ph = best.ph;
	if (!d.qc) { const qc = classesOf(best.f); if (qc.length) d.qc = qc; }
	if (!d.r && best.r) d.r = /温泉|鉱泉/.test(best.name) ? best.r : best.r + "おんせん";
	if (!d.en && d.r) d.en = enFromReading(d.r) || undefined;
	const x = rs.map(r => rec(r, d.c)).filter(isRec); if (x.length) d.x = x;
	const bz = [...new Set(rs.flatMap(r => r.rank ? r.rank.split("/") : []))]; if (bz.length) d.bz = bz;
}

// ── ③ 新しい温泉 ──
const named = n => /温泉|鉱泉/.test(n) ? n : n.replace(/^([^(（]+)([(（].*)?$/, (_, a, b) => a + "温泉" + (b || ""));
const reading = (n, r) => !r ? "" : /温泉|鉱泉/.test(n) ? r : r.replace(/^([^(（]+)([(（].*)?$/, (_, a, b) => a + "おんせん" + (b || ""));
const groups = [];
for (const r of fresh) {
	const g = groups.find(g => g[0].pref === r.pref && key(g[0].name) === key(r.name) && g[0].name.replace(/[(（].*/, "") === r.name.replace(/[(（].*/, "") && kmOf(g[0].c, r.c) <= 1);
	if (g) g.push(r); else groups.push([r]);
}
const added = groups.map(rs => {
	const r = rs[0], n = named(r.name), rd = reading(r.name, r.r);
	const d = { id: "k" + r.i, k: "o", n };
	if (rd) d.r = rd.replace(/[(（].*$/, "");
	const en = enFromReading(d.r); if (en) d.en = en;
	const p = prefCode[r.pref]; if (p) d.p = p;
	if (r.muni) d.m = r.muni;
	d.c = r.c; d.a = 0; d.cs = 1;
	const qc = classesOf(r.f); if (qc.length) d.qc = qc;
	if (r.t != null && r.t > 0 && r.t < 120) d.t = r.t;
	if (r.ph != null && r.ph >= 0 && r.ph <= 14) d.ph = r.ph;
	const wt = r.wiki && wikiTitle(r.wiki); if (wt && !byWiki.get(wt)?.some(x => x.k === "g")) d.w = { ja: wt };   // 郷の記事を指す行は郷へ結ぶだけ（記事は郷の物）
	const x = rs.map(q => rec(q, d.c)).filter(isRec); if (x.length) d.x = x;
	const bz = [...new Set(rs.flatMap(q => q.rank ? q.rank.split("/") : []))]; if (bz.length) d.bz = bz;
	d._rows = rs; return d;
});
items.push(...added);

// ── ⑤ 温泉郷 ──
const rowsOf = new Map([...matched].map(([d, rs]) => [d, rs])); for (const d of added) rowsOf.set(d, d._rows);
const kyoKeys = new Map();   // 県:郷の鍵 → 郷の項目
const newKyo = [];
for (const [d, rs] of rowsOf) for (const r of rs) {
	if (!r.kyo) continue;
	const p = prefCode[r.pref], kk = p + ":" + key(r.kyo);
	if (kyoKeys.has(kk)) continue;
	let g = kyos.find(g => g.p === p && key(g.n) === key(r.kyo));
	if (!g) {
		const n = /温泉/.test(r.kyo) ? r.kyo : r.kyo + "温泉郷", rd = r.kyoR ? (/おんせん/.test(r.kyoR) ? r.kyoR : r.kyoR + "おんせんきょう") : "";
		g = { id: "kg" + (newKyo.length + 1), k: "g", n }; if (rd) g.r = rd; const en = enFromReading(rd); if (en) g.en = en;
		g.p = p; if (r.muni) g.m = r.muni; g.c = r.c; g.a = 0; g.cs = 1;
		newKyo.push(g); items.push(g);
	}
	kyoKeys.set(kk, g);
}
const listedKyo = new Set([...kyoKeys.values()].map(g => g.id));
let linked = 0, unlinkedK = 0;
for (const [d, rs] of rowsOf) {
	if (d.k !== "o") continue;
	const want = [...new Set(rs.filter(r => r.kyo).map(r => kyoKeys.get(prefCode[r.pref] + ":" + key(r.kyo)).id))];
	const keep = (d.par || []).filter(g => !listedKyo.has(g));
	unlinkedK += (d.par || []).filter(g => listedKyo.has(g) && !want.includes(g)).length;
	const par = [...new Set([...keep, ...want])]; linked += want.filter(g => !(d.par || []).includes(g)).length;
	if (par.length) d.par = par; else delete d.par;
}
// 新しい郷の座標＝構成員の中央（郷の記事が無い）
for (const g of newKyo) { const m = items.filter(d => d.par?.includes(g.id)); if (m.length) g.c = [r5(m.reduce((s, d) => s + d.c[0], 0) / m.length), r5(m.reduce((s, d) => s + d.c[1], 0) / m.length)]; }
for (const d of added) delete d._rows;
kyoPolys(items);

// ── ⑦ 有名さの段 f（地図の LOD・本人 2026-10-24）：0＝現代番付・1＝英語版 Wikipedia か湯量 3,000 L/分以上・2＝日本語版 Wikipedia・秘湯の宿・湯量 300 L/分以上・3＝その他（持たない）
//    江戸の番付は当てにならない＝使わない（本人 2026-10-24）。郷は f を持たない（面と名札で出す）
const { 現代番付, 番付の比定 } = await import("../../onsen-banzuke.ts");
const modern = new Set(), prefShort = Object.fromEntries(Object.entries(prefCode).map(([n, c]) => [n.replace(/[都府県]$/, ""), c]));
const names = ["東", "西"].flatMap(s => 現代番付[s].map((_, i) => s + (i < 現代番付.三役.length ? 現代番付.三役[i] : "前頭" + (i - 現代番付.三役.length + 1))))
	.concat(現代番付.行司.map((_, i) => "行司" + (i + 1)), ["勧進元", "差添人"]);
for (const nm of names) {
	const ref = 番付の比定("現代", nm); if (!ref) continue;
	const [p, n] = ref.split(":"), d = items.find(d => d.p === prefShort[p] && d.n === n); if (d) modern.add(d);
}
const flow = d => (d.x || []).reduce((s, r) => s + (r.fl || 0), 0);
for (const d of items) {
	if (d.k !== "o") continue;
	const f = modern.has(d) ? 0 : d.w?.en || flow(d) >= 3000 ? 1 : d.w?.ja || d.h || flow(d) >= 300 ? 2 : 3;
	if (f < 3) d.f = f;
}

// ── 出す ──
db._ = db._.replace(/）$/, "／温泉一覧（Wikipedia と、長年現地を巡った記録から編纂・source/onsen-list.csv）") + "）";
db.generated = new Date().toISOString().slice(0, 10);
fs.writeFileSync(OUT, JSON.stringify(db));
const cnt = f => items.filter(f).length;
console.log(JSON.stringify({ rows: rows.length, matchedItems: matched.size, matchedRows: [...matched.values()].reduce((s, v) => s + v.length, 0), relocated, added: added.length, newKyo: newKyo.length,
	linked, unlinkedK, items: items.length, estimated: cnt(d => d.a > 0), withClass: cnt(d => d.qc), withX: cnt(d => d.x), bz: cnt(d => d.bz), f0: cnt(d => d.f === 0), f1: cnt(d => d.f === 1), f2: cnt(d => d.f === 2), f3: cnt(d => d.k === "o" && d.f == null), modern: modern.size, bytes: fs.statSync(OUT).size }));
