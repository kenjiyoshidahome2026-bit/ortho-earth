#!/usr/bin/env node
// デモの文言（題と説明・英語＋25 言語の訳）を CSV で編集する道具（本人 2026-09-24「18 個のデモの文言を csv にして編集できるように」）。
//   npm run demos:export -w www   … demos.json ＋ i18n/ui.json → demos.csv（Excel／Numbers でそのまま開ける UTF-8 BOM 付き）
//        既定＝1 デモ 1 行・「タイトル,日本語説明」の 2 列だけ（本人 9/24「もっとシンプルに一行に、タイトルと日本語説明だけ」）
//              タイトルは行の目印（demos.json の title と照合）＝ここでは変えない。直せるのは日本語説明だけ
//        -- --langs ja,fr,de … demo, field, en＋選んだ訳の列（題と説明の 2 行／デモ・英語も直せる）／ -- --all … 25 言語すべて＋note 列
//   npm run demos:import -w www   … demos.csv → demos.json ＋ i18n/ui.json（→ i18n:build で焼き → verify:i18n）
// 正本は今までどおり demos.json（英語）と i18n/ui.json（訳・英語がキー）。CSV は編集用の写し（git に入れない）。
// 行＝デモ 1 件につき title と desc の 2 行。列＝demo（demos.json の id）, field, [note,] en, 訳の列…（言語の並びは packages/world/i18n/langs.json）。
//   ・CSV に無い言語の列は触らない（4 列の CSV を読み込んでも他の 24 言語の訳はそのまま）
//   ・英語（en 列）を直す＝demos.json の文言と ui.json のキーが一緒に変わる（訳は新しいキーへ引っ越す。頁の他所でも使うキーなら写す）
//   ・訳の列を直す＝ui.json の訳が変わる。**空のセル＝その言語は訳なし（英語で出る）**
//   ・英語だけ直して訳を直さなかった行は「訳が古いかも」と報告する
//   ・note が「proper」の題＝固有名詞＝訳は任意（空＝英語名のまま・入れた言語だけその訳で出る。本人 9/24「ortho-solar → 太陽系」等）
//   ・demo と field は変えない（行の足し引き・デモの追加は demos.json で。追加したら export し直す）
//   ・行の順＝カードの並び（行を入れ替えると Gallery の並びが変わる）。空行は読み飛ばす
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProper } from "../cards.js";   // 固有名詞の題（訳は任意）の判定＝カードと同じもの

const FIELDS = ["title", "desc"];

// ── CSV（RFC 4180：" で囲む・"" で " ・セル内の改行可）──
const cell = v => { const s = String(v ?? ""); return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function parseCSV(text) {
	text = text.replace(/^﻿/, "");
	const rows = []; let row = [], s = "", q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"') { if (text[i + 1] === '"') { s += '"'; i++; } else q = false; }
			else s += c;
		} else if (c === '"') q = true;
		else if (c === ",") { row.push(s); s = ""; }
		else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(s); rows.push(row); row = []; s = ""; }
		else s += c;
	}
	if (s !== "" || row.length) { row.push(s); rows.push(row); }
	return rows.filter(r => r.some(v => v !== ""));
}

// demos.json ＋ ui.json → CSV の文字列。pick＝訳の列（既定＝全言語＋note 列。["ja"] 等を渡すと note 無しでその列だけ）
export function toCSV({ demos }, ui, langs, pick = null) {
	const others = pick ? langs.filter(c => c !== "en" && pick.includes(c)) : langs.filter(c => c !== "en");
	const note = !pick;
	const out = [["demo", "field", ...(note ? ["note"] : []), "en", ...others]];   // 先頭列は "demo"（"id" はインドネシア語の列名と衝突する）
	for (const d of demos) for (const f of FIELDS) {
		const en = d[f] ?? "", proper = f === "title" && isProper(d);
		out.push([d.id, f, ...(note ? [proper ? "proper" : ""] : []), en, ...others.map(c => ui[en]?.[c] ?? "")]);
	}
	return "﻿" + out.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// 簡易形（1 デモ 1 行・タイトル,日本語説明）
const SIMPLE = ["タイトル", "日本語説明"];
export function toSimpleCSV({ demos }, ui) {
	const out = [SIMPLE, ...demos.map(d => [d.title, ui[d.desc]?.ja ?? ""])];
	return "\uFEFF" + out.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// CSV を demos.json ＋ ui.json へ当てる（純関数＝新しい物を返す）。pageKeys＝index.html が使うキー（引っ越さず写す判定）
export function applyCSV(text, demosDoc, uiIn, langs, pageKeys = []) {
	let [head, ...rows] = parseCSV(text);
	let fields = FIELDS;
	const pre = [];
	if (head[0]?.trim() === SIMPLE[0]) {   // 簡易形＝タイトルで照合して標準形（demo, field=desc, ja）へ読み替える
		const byTitle = new Map(demosDoc.demos.map(d => [d.title, d.id]));
		const ja = head.findIndex(h => h.trim() === SIMPLE[1]);
		if (ja < 0) throw new Error(`CSV: "${SIMPLE[1]}" 列がありません`);
		rows = rows.flatMap(r => {
			const t = r[0]?.trim(), id = byTitle.get(t);
			if (!id) { pre.push(`「${t}」: このタイトルのデモはありません（タイトルは変えずに、日本語説明だけ直してください）`); return []; }
			return [[id, "desc", r[ja] ?? ""]];
		});
		head = ["demo", "field", "ja"]; fields = ["desc"];
	}
	const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
	for (const h of ["demo", "field"]) if (!(h in col)) throw new Error(`CSV: "${h}" 列がありません`);
	const doc = structuredClone(demosDoc);
	let ui = structuredClone(uiIn);
	const byId = new Map(doc.demos.map(d => [d.id, d]));
	const report = { changedEn: [], changedTr: 0, stale: [], errors: pre };
	const seen = new Set();
	// キーの付け替え（並び順を保つ）
	const rename = (from, to) => { ui = Object.fromEntries(Object.entries(ui).map(([k, v]) => [k === from ? to : k, v])); };
	for (const r of rows) {
		const id = r[col.demo]?.trim(), f = r[col.field]?.trim(), at = `${id}/${f}`;
		const d = byId.get(id);
		if (!d || !fields.includes(f)) { report.errors.push(`${at}: そのデモ／項目はありません`); continue; }
		if (seen.has(at)) { report.errors.push(`${at}: 行が重複しています`); continue; }
		seen.add(at);
		const oldEn = d[f] ?? "", en = "en" in col ? (r[col.en] ?? "").trim() : oldEn;   // en 列が無い CSV＝英語は変えない
		if (!en) { report.errors.push(`${at}: 英語（en）が空です`); continue; }
		if (en !== oldEn) {
			d[f] = en; report.changedEn.push(`${at}: "${oldEn}" → "${en}"`);
			const stillUsed = pageKeys.includes(oldEn) || doc.demos.some(x => FIELDS.some(g => x[g] === oldEn));
			if (ui[oldEn] && !ui[en]) stillUsed ? (ui[en] = { ...ui[oldEn] }) : rename(oldEn, en);
		}
		const prev = ui[en] ?? {}, next = {};
		for (const c of langs.filter(c => c !== "en")) {   // 並びは言語表どおり（CSV に無い列は元の値を残す）
			const v = c in col ? (r[col[c]] ?? "").trim() : prev[c] ?? "";
			if (v) next[c] = v;
		}
		for (const [k, v] of Object.entries(prev)) if (!(k in next) && !langs.includes(k)) next[k] = v;   // 言語表の外の列（あれば）は触らない
		const same = JSON.stringify(prev) === JSON.stringify(next);
		if (!same) report.changedTr += langs.filter(c => c !== "en" && (prev[c] ?? "") !== (next[c] ?? "")).length;
		if (en !== oldEn && same && Object.keys(next).length) report.stale.push(`${at}: 英語を直しましたが訳は元のままです`);
		if (Object.keys(next).length) ui[en] = next; else delete ui[en];
	}
	// 並び＝CSV の行の順（本人 9/24「順番も」）。CSV に無いデモは元の並びのまま後ろへ
	const order = [...new Set([...seen].map(k => k.split("/")[0]))];
	const moved = order.join() !== doc.demos.filter(d => order.includes(d.id)).map(d => d.id).join();
	doc.demos = [...order.map(id => byId.get(id)), ...doc.demos.filter(d => !order.includes(d.id))];
	report.reordered = moved;
	for (const d of doc.demos) for (const f of fields) if (!seen.has(`${d.id}/${f}`)) report.errors.push(`${d.id}/${f}: CSV に行がありません（その行は変えずに残します）`);
	return { demos: doc, ui, report };
}

// ── CLI ──
const main = async () => {
	const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const P = { demos: path.join(APP, "demos.json"), ui: path.join(APP, "i18n/ui.json"), csv: path.join(APP, "demos.csv") };
	const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8")).map(l => l.code);
	const demos = JSON.parse(fs.readFileSync(P.demos, "utf8"));
	const uiDoc = JSON.parse(fs.readFileSync(P.ui, "utf8"));
	const argv = process.argv.slice(2), flag = n => { const i = argv.indexOf(n); return i < 0 ? null : argv.splice(i, n === "--all" ? 1 : 2).slice(1)[0] ?? ""; };
	const all = flag("--all") != null, langsArg = flag("--langs");
	const [cmd, file = P.csv] = argv;
	if (cmd === "export") {
		if (!all && !langsArg) {
			fs.writeFileSync(file, toSimpleCSV(demos, uiDoc.ui));
			console.log(`${path.relative(process.cwd(), file)}: ${demos.demos.length} demos · columns: ${SIMPLE.join(",")}`);
			return;
		}
		const pick = all ? null : langsArg.split(",").map(s => s.trim()).filter(Boolean);
		fs.writeFileSync(file, toCSV(demos, uiDoc.ui, langs, pick));
		console.log(`${path.relative(process.cwd(), file)}: ${demos.demos.length} demos × ${FIELDS.length} rows · columns: en${pick ? "," + pick.join(",") : " + all " + (langs.length - 1) + " languages"}`);
		return;
	}
	if (cmd !== "import") { console.error("usage: demos-csv.mjs export|import [file.csv]"); process.exit(2); }
	const { uiKeys } = await import("./keys.mjs");
	const { demos: nd, ui, report } = applyCSV(fs.readFileSync(file, "utf8"), demos, uiDoc.ui, langs, uiKeys());
	for (const e of report.errors) console.error("✗ " + e);
	if (report.errors.some(e => !/CSV に行がありません/.test(e))) { console.error("何も書き換えていません（上の行を直して、もう一度 import）"); process.exit(1); }
	for (const s of report.changedEn) console.log("英語  " + s);
	for (const s of report.stale) console.warn("⚠ " + s);
	fs.writeFileSync(P.demos, JSON.stringify(nd, null, "\t") + "\n");
	fs.writeFileSync(P.ui, JSON.stringify({ ...uiDoc, ui }, null, "\t") + "\n");
	console.log(`demos.json・i18n/ui.json を更新：英語 ${report.changedEn.length} 件・訳 ${report.changedTr} セル${report.reordered ? "・並びを CSV の順に" : ""}`);
};
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
