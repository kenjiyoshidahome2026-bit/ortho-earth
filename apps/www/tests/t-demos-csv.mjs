// デモの文言 CSV（scripts/demos-csv.mjs）の検定：往復で 1 バイトも変わらない・英語の直しで訳が引っ越す・空セル＝訳なし・Excel の CSV も読める
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toCSV, toSimpleCSV, applyCSV, parseCSV } from "../scripts/demos-csv.mjs";

const rd = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const demos = JSON.parse(rd("demos.json")), ui = JSON.parse(rd("i18n/ui.json")).ui;
const langs = JSON.parse(readFileSync(new URL("../../../packages/world/i18n/langs.json", import.meta.url), "utf8")).map(l => l.code);
const J = o => JSON.stringify(o, null, "\t") + "\n";
const edit = (csv, id, field, lang, value) => {
	const rows = parseCSV(csv), h = rows[0], r = rows.find(r => r[0] === id && r[1] === field);
	r[h.indexOf(lang)] = value;
	return rows.map(r => r.map(v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(",")).join("\n");
};

test("書き出し：18 件 × 題と説明＝36 行・列は demo,field,note,en＋25 言語・BOM 付き", () => {
	const csv = toCSV(demos, ui, langs), rows = parseCSV(csv);
	assert.ok(csv.startsWith("﻿"));
	assert.equal(rows.length, 1 + demos.demos.length * 2);
	assert.deepEqual(rows[0].slice(0, 5), ["demo", "field", "note", "en", "ja"]);
	assert.equal(rows[0].length, 3 + langs.length);
	assert.equal(rows.find(r => r[0] === "equal" && r[1] === "title")[2], "proper");
});
test("簡易形（1 デモ 1 行・タイトル,日本語説明）：往復で不変・日本語説明だけ変わる・知らないタイトルは誤り", () => {
	const simple = toSimpleCSV(demos, ui), rows = parseCSV(simple);
	assert.deepEqual(rows[0], ["タイトル", "日本語説明"]);
	assert.equal(rows.length, 1 + demos.demos.length);
	let r = applyCSV(simple, demos, ui, langs);
	assert.deepEqual(r.report.errors, []);
	assert.equal(J(r.demos), rd("demos.json")); assert.equal(J({ ui: r.ui }), rd("i18n/ui.json"));
	const d = demos.demos.find(d => d.id === "world");
	const edited = rows.map(x => x[0] === d.title ? [x[0], "直した, \"説明\""] : x).map(x => x.map(v => /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(",")).join("\n");
	r = applyCSV(edited, demos, ui, langs);
	assert.equal(r.ui[d.desc].ja, '直した, "説明"'); assert.equal(r.report.changedTr, 1);
	assert.deepEqual(r.ui[d.title], ui[d.title]);   // 題の訳は触らない
	assert.ok(applyCSV(edited.replace(d.title, "Renamed"), demos, ui, langs).report.errors.some(e => e.startsWith("「Renamed」")));   // import は止まる（何も書き換えない）
});
test("既定の書き出し（demo,field,en,ja の 4 列）で直した日本語だけが変わり、他の 24 言語はそのまま", () => {
	const narrow = toCSV(demos, ui, langs, ["ja"]), rows = parseCSV(narrow);
	assert.deepEqual(rows[0], ["demo", "field", "en", "ja"]);
	let r = applyCSV(narrow, demos, ui, langs);
	assert.equal(J({ ui: r.ui }), rd("i18n/ui.json"));
	const d = demos.demos.find(d => d.id === "geopbf");
	r = applyCSV(edit(narrow, "geopbf", "desc", "ja", "直した説明"), demos, ui, langs);
	assert.equal(r.ui[d.desc].ja, "直した説明");
	for (const c of langs.filter(c => c !== "en" && c !== "ja")) assert.equal(r.ui[d.desc][c], ui[d.desc][c], c);
	assert.equal(r.report.changedTr, 1);
});
test("往復：書き出して何も直さずに読み込む＝demos.json・ui.json が 1 バイトも変わらない", () => {
	const r = applyCSV(toCSV(demos, ui, langs), demos, ui, langs);
	assert.deepEqual(r.report.errors, []);
	assert.equal(J(r.demos), rd("demos.json"));
	assert.equal(J({ ui: r.ui }), rd("i18n/ui.json"));
});
test("英語を直す＝demos.json の文言と ui.json のキーが一緒に変わり、訳は引っ越す（直さなかった訳は古いかもと報告）", () => {
	const d = demos.demos.find(d => d.id === "world"), csv = edit(toCSV(demos, ui, langs), "world", "desc", "en", "New description.");
	const r = applyCSV(csv, demos, ui, langs);
	assert.equal(r.demos.demos.find(d => d.id === "world").desc, "New description.");
	assert.equal(r.ui["New description."].ja, ui[d.desc].ja);
	assert.equal(r.ui[d.desc], undefined);
	assert.equal(Object.keys(r.ui).indexOf("New description."), Object.keys(ui).indexOf(d.desc));   // 並び順も保つ
	assert.equal(r.report.stale.length, 1);
});
test("訳を直す・空にする＝その言語だけ変わる（空＝訳なし＝英語で出る）", () => {
	const d = demos.demos.find(d => d.id === "quakes");
	let csv = edit(toCSV(demos, ui, langs), "quakes", "desc", "fr", "Nouvelle description");
	csv = edit(csv, "quakes", "desc", "ja", "");
	const r = applyCSV(csv, demos, ui, langs);
	assert.equal(r.ui[d.desc].fr, "Nouvelle description");
	assert.equal(r.ui[d.desc].ja, undefined);
	for (const c of langs.filter(c => !["en", "ja", "fr"].includes(c))) assert.equal(r.ui[d.desc][c], ui[d.desc][c], c);   // 他の言語はそのまま
	assert.equal(r.report.changedTr, 2);
});
test("固有名詞の題＝訳は任意（入れた言語だけ訳が付く・空は英語名のまま）・知らない id と空の英語は誤り", () => {
	assert.equal(parseCSV(toCSV(demos, ui, langs, ["ja"])).find(r => r[0] === "solar" && r[1] === "title")[3], "太陽系");   // 訳のある固有名詞の題は書き出しにも出る
	let csv = edit(toCSV(demos, ui, langs), "equal", "title", "ja", "イコール");
	let r = applyCSV(csv, demos, ui, langs);
	assert.deepEqual(r.ui["Equal Earth"], { ja: "イコール" }); assert.equal(r.report.changedTr, 1);
	r = applyCSV(edit(toCSV(demos, ui, langs), "solar", "title", "ja", ""), demos, ui, langs);
	assert.equal(r.ui["ortho-solar"], undefined);   // 空にした＝訳なし＝英語名のまま
	csv = edit(toCSV(demos, ui, langs), "world", "title", "en", "");
	assert.equal(applyCSV(csv, demos, ui, langs).report.errors.length, 1);
	csv = toCSV(demos, ui, langs).replace("\r\nworld,", "\r\nnope,");
	assert.ok(applyCSV(csv, demos, ui, langs).report.errors.some(e => e.startsWith("nope/")));
});
test("並び：簡易形の行を入れ替える＝demos.json の並びが CSV の順に（空行は読み飛ばす）", () => {
	const rows = parseCSV(toSimpleCSV(demos, ui));
	const body = rows.slice(1).reverse();
	const csv = [rows[0], ...body].map(r => r.map(v => /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(",")).join("\n\n");
	const r = applyCSV(csv, demos, ui, langs);
	assert.deepEqual(r.demos.demos.map(d => d.id), demos.demos.map(d => d.id).reverse());
	assert.equal(r.report.reordered, true); assert.equal(J({ ui: r.ui }), rd("i18n/ui.json"));
});
test("CSV の読み：引用符・セル内の改行とカンマ・CRLF/LF・BOM", () => {
	assert.deepEqual(parseCSV('﻿a,"b,c","d ""e""\nf"\r\n1,2,3\n'), [["a", "b,c", 'd "e"\nf'], ["1", "2", "3"]]);
});
