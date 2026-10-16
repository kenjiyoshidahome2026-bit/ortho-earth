#!/usr/bin/env node
// 日本の温泉の台帳（ortho-data/japan/onsen.json）の常設検定＝scripts/onsen-ledger の生成物が onsen.js の前提を満たすか。
//   ①台帳の形（id・種別・名前・座標・精度）②座標は日本の範囲 ③泉質の分類は 10 種の番号 ④温泉郷は閉じた面を持ち、所属の id は郷を指す
//   ⑤源泉が離れている物（岳温泉）・会員宿は温泉に結ぶ ⑥都道府県名は 47 ⑦辞書（i18n/pages/onsen.json）は 25 言語揃い・onsen.js の t() を全部持つ
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url))), PUB = path.join(APP, "../../ortho-data/japan");   // 正本＝リポの根の ortho-data/japan/
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };

const db = JSON.parse(fs.readFileSync(path.join(PUB, "onsen.json"), "utf8")), items = db.items, byId = new Map(items.map(d => [d.id, d]));
const inJapan = c => Array.isArray(c) && c[0] >= 122 && c[0] <= 154.5 && c[1] >= 20 && c[1] <= 46;
t("台帳：1,500 件以上", items.length >= 1500, String(items.length));
t("台帳：id は一意", byId.size === items.length);
t("台帳：全件に id・種別（o|g）・名前・座標", items.every(d => /^[jw]Q?\d+$/.test(d.id) && (d.k === "o" || d.k === "g") && d.n && d.c?.length === 2), JSON.stringify(items.find(d => !(/^[jw]Q?\d+$/.test(d.id) && d.n && d.c?.length === 2))));
t("台帳：座標は日本の範囲（lon 122〜154.5・lat 20〜46）", items.every(d => inJapan(d.c)), JSON.stringify(items.filter(d => !inJapan(d.c)).slice(0, 3).map(d => d.n)));
t("台帳：精度 a は 0 以上・推定（a>0）には方法 e がある", items.every(d => d.a >= 0 && (d.a === 0 || ["osm", "addr", "muni", "region", "kyo"].includes(d.e))), JSON.stringify(items.find(d => !(d.a >= 0 && (d.a === 0 || d.e)))));
t("台帳：推定は全体の 4 割未満", items.filter(d => d.a > 0).length < items.length * 0.4, String(items.filter(d => d.a > 0).length));
t("台帳：都道府県コードは 1〜47", items.every(d => d.p == null || (d.p >= 1 && d.p <= 47)));
t("泉質：分類は 10 種", db.classes?.length === 10 && db.classes[0] === "単純温泉" && db.classes[8] === "硫黄泉");
t("泉質：qc は 0〜9 の番号", items.every(d => !d.qc || (d.qc.length && d.qc.every(i => Number.isInteger(i) && i >= 0 && i < 10))));
t("泉質：半数以上に分類がある", items.filter(d => d.qc).length > items.length / 2, String(items.filter(d => d.qc).length));
t("泉質：pH は 0〜14・泉温は 0〜120", items.every(d => (d.ph == null || (d.ph >= 0 && d.ph <= 14)) && (d.t == null || (d.t > 0 && d.t < 120))));
const kyos = items.filter(d => d.k === "g");
t("温泉郷：50 以上", kyos.length >= 50, String(kyos.length));
t("温泉郷：全部が閉じた面（4 点以上・始点＝終点）を持つ", kyos.every(d => d.poly?.length >= 4 && d.poly[0][0] === d.poly.at(-1)[0] && d.poly[0][1] === d.poly.at(-1)[1] && d.poly.every(inJapan)), JSON.stringify(kyos.filter(d => !d.poly).map(d => d.n)));
t("温泉郷：所属（par）は郷を指す", items.every(d => !d.par || d.par.every(g => byId.get(g)?.k === "g")));
// 構成する温泉の記事が無い郷（男鹿温泉郷など）は郷の記事の座標と範囲だけで面を作っている＝7 割に構成員がいれば良い
t("温泉郷：7 割以上の郷に構成する温泉がある", kyos.filter(g => items.some(d => d.par?.includes(g.id))).length >= kyos.length * 0.7, JSON.stringify(kyos.filter(g => !items.some(d => d.par?.includes(g.id))).map(d => d.n)));
for (const [name, check] of [["草津温泉", d => d.k === "o" && d.qc?.includes(6) && d.qc?.includes(8) && d.a === 0 && d.p === 10], ["道後温泉", d => d.p === 38], ["別府温泉", d => d.p === 44], ["登別温泉", d => d.p === 1], ["乳頭温泉郷", d => d.k === "g" && d.poly]])
	t(`台帳：${name} が居る`, items.some(d => d.n === name && check(d)), JSON.stringify(items.find(d => d.n === name) || "無い"));
const dake = items.find(d => d.n === "岳温泉" && d.p === 7);
t("源泉：岳温泉は源泉が離れている（s・距離 5 km 以上・根拠の文）", dake?.s && dake.s.d >= 5000 && dake.s.x, JSON.stringify(dake));
t("源泉：s を持つ物は 30 件以上・座標は日本の範囲・引湯元は台帳の id", items.filter(d => d.s).length >= 30 && items.every(d => !d.s || ((!d.s.c || inJapan(d.s.c)) && (!d.s.f || byId.has(d.s.f)))));
t("会員宿：80 軒以上", db.inns?.length >= 80, String(db.inns?.length));
t("会員宿：o は温泉の id・h は宿の番号で往復が合う", db.inns.every((x, j) => !x.o || byId.get(x.o)?.h?.includes(j)) && items.every(d => !d.h || d.h.every(j => db.inns[j]?.o === d.id)));
t("会員宿：url は hitou.or.jp・座標は日本の範囲", db.inns.every(x => /^https:\/\/www\.hitou\.or\.jp\//.test(x.u) && (!x.c || inJapan(x.c))));
t("都道府県名：47・26 言語", Object.keys(db.prefNames || {}).length === 47 && Object.values(db.prefNames).every(v => v.ja && v.en && v.zh && v.he));
t("記事：w.ja は 1,500 件以上", items.filter(d => d.w?.ja).length >= 1500);
t("名前が QID のままの物は居ない", !items.some(d => /^Q\d+$/.test(d.n)));
t("文字列に undefined・null が混ざらない", !/"(undefined|null)"/.test(JSON.stringify(items)));

// 辞書＝英語キー→25 言語。onsen.js の t("…") は全部この辞書か本体の ui.json に居る
const dict = JSON.parse(fs.readFileSync(path.join(APP, "i18n/pages/onsen.json"), "utf8")).ui;
const core = JSON.parse(fs.readFileSync(fileURLToPath(import.meta.resolve("@ortho-earth/globe/i18n/ui.json")), "utf8")).ui ?? {};   // 本体の訳＝globe の公開の口（./i18n/*）
const LANGS = "ja zh ko fr de es pt it nl pl ru uk hu sv tr el id vi th bn hi ar fa ur he".split(" ");
t("辞書：全キーが 25 言語", Object.values(dict).every(v => LANGS.every(l => v[l])), JSON.stringify(Object.entries(dict).filter(([, v]) => !LANGS.every(l => v[l])).map(([k]) => k)));
t("辞書：$1 の数がキーと揃う", Object.entries(dict).every(([k, v]) => LANGS.every(l => (v[l].match(/\$\d/g) || []).length === (k.match(/\$\d/g) || []).length)));
const src = fs.readFileSync(path.join(APP, "onsen.js"), "utf8"), used = [...src.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
const missing = [...new Set(used)].filter(k => !dict[k] && !(k in core));
t("辞書：onsen.js の t() は全部ある", !missing.length, JSON.stringify(missing));

console.log(`\n${ng ? "✗" : "✓"} onsen: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
