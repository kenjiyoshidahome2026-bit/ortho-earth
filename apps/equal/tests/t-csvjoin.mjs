// CSV → 国の結合の検定（列の自動判定・文字コード・数値の読み・世界銀行形式）
import assert from "node:assert/strict";
import { parseCSV, decodeText, buildNationIndex, joinCSV, csvPreset } from "../src/csvjoin.js";

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// world の NationDB の最小模型（本物は bucket）
const world = { items: [
	{ key: "JP", qid: "Q17", name: { en: "Japan" }, iso: ["JP", "JPN", 392], ioc: "JPN", official: "" },
	{ key: "CN", qid: "Q148", name: { en: "China" }, iso: ["CN", "CHN", 156], ioc: "CHN", official: "People's Republic of _" },
	{ key: "US", qid: "Q30", name: { en: "United States" }, iso: ["US", "USA", 840], ioc: "USA", official: "_ of America", wiki: { en: "United States" } },
	{ key: "FR", qid: "Q142", name: { en: "France" }, iso: ["FR", "FRA", 250], ioc: "FRA" },
	{ key: "DE", qid: "Q183", name: { en: "Germany" }, iso: ["DE", "DEU", 276], ioc: "GER" },
	{ key: "B20", qid: "Q23681", name: { en: "Northern Cyprus" }, iso: [], official: "Turkish Republic of _" },
], ja: { JP: { name: "日本", wiki: "日本", official: "_国" }, CN: { name: "中華人民共和国", official: "_(中国)" }, US: { name: "アメリカ合衆国", official: "_合衆国" }, FR: { name: "フランス" }, DE: { name: "ドイツ" } } };
const idx = buildNationIndex(world);

// 1) parseCSV：引用符・区切りの自動判定・空行
eq([...parseCSV('a,b\n"x, y","1"\n\n2,3\n')], [["a", "b"], ["x, y", "1"], ["2", "3"]], "RFC4180");
ok(parseCSV("a;b\n1;2\n").delim === ";", "セミコロン区切り");
ok(parseCSV("a\tb\n1\t2\n").delim === "\t", "タブ区切り");

// 2) 文字コード：UTF-8 BOM と Shift_JIS
eq(decodeText(new TextEncoder().encode("﻿国名,x\n日本,1\n")), "国名,x\n日本,1\n", "BOM を剥がす");
const sjis = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x2c, 0x31, 0x0a]);   // "日本,1\n" の Shift_JIS
ok(decodeText(sjis).startsWith("日本,1"), "Shift_JIS フォールバック");

// 3) 結合キーの自動判定：ISO3 / ISO2 / 数値 / 英語名 / 正式名 / 日本語名 / 日本語略称 / QID
const cases = [
	["code,v\nJPN,1\nCHN,2\nUSA,3\n", "code", 3],
	["iso2;share\nJP;1,5\nCN;2\nDE;3\n", "iso2", 3],
	["num,v\n392,1\n156,2\n840,3\n", "num", 3],
	["Country,v\nJapan,1\nChina,2\nUnited States,3\nFrance,4\n", "Country", 4],
	["Country,v\nPeople's Republic of China,1\nUnited States of America,2\nJapan,3\n", "Country", 3],
	["国名,人口\n日本,1\n中国,2\nアメリカ合衆国,3\nフランス,4\n", "国名", 4],
	["qid,v\nQ17,1\nQ148,2\nQ30,3\n", "qid", 3],
];
for (const [text, key, matched] of cases) { const ds = joinCSV("t.csv", text, idx); ok(ds.header[ds.keyCol] === key && ds.matched === matched, `キー列 ${key}: ${ds.header[ds.keyCol]} matched ${ds.matched}`); }

// 4) 世界銀行形式：前置きのメタ行・末尾カンマ・値の列は右端の埋まった年
const wb = '"Data Source","World Development Indicators",\n\n"Last Updated Date","2026-07-01",\n\n"Country Name","Country Code","Indicator Name","Indicator Code","2021","2022","2023",\n"Japan","JPN","GDP","NY",1,2,\n"China","CHN","GDP","NY",3,4,5\n"World","WLD","GDP","NY",9,9,9\n';
const ds = joinCSV("wb.csv", wb, idx);
ok(ds.header[ds.keyCol] === "Country Name" || ds.header[ds.keyCol] === "Country Code", "世界銀行のキー列");
ok(ds.matched === 2 && ds.unmatched.length === 1 && ds.unmatched[0] === "World", "World は外れ");
ok(ds.header[ds.defaultCol] === "2022", `既定の値列＝データが揃った右端の年（${ds.header[ds.defaultCol]}）`);
const p = csvPreset(ds, ds.defaultCol);
ok(p.value(null, 0) === 2 && p.value(null, 1) === 4, "値の取り出し（国番号で）");

// 5) 欧州式の数値（; 区切り＝小数点カンマ・千の位ドット）と千の位カンマ
const eu = joinCSV("eu.csv", "iso2;v\nJP;1.234,5\nCN;2,5\nDE;3\n", idx), pe = csvPreset(eu, eu.defaultCol);
ok(pe.value(null, 0) === 1234.5 && pe.value(null, 1) === 2.5, "欧州式");
const us = joinCSV("us.csv", "iso2,v\nJP,\"1,234.5\"\nCN,2\nDE,3\n", idx), pu = csvPreset(us, us.defaultCol);
ok(pu.value(null, 0) === 1234.5, "千の位カンマ");

// 6) 質的な列（20 種以下）は category
const cat = joinCSV("cat.csv", "iso2,group\nJP,A\nCN,B\nDE,A\nFR,C\n", idx);
ok(cat.columns[0].type === "category" && csvPreset(cat, cat.columns[0].i).type === "categorical", "質的列");

// 7) 当たらない CSV は明確に失敗
assert.throws(() => joinCSV("x.csv", "a,b\n1,2\n3,4\n", idx), /No column/, "国が無い CSV は throw"); n++;
console.log(`t-csvjoin: ${n} ok`);
