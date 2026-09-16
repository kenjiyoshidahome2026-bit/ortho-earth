#!/usr/bin/env node
// Phase 1 の機械置換＝ja キー辞書を畳み、呼び出しを英語キーへ書き換える。
//
//   const t = tr({ "計測開始": "Start measuring" });  →  const t = tr();
//   t("計測開始")                                     →  t("Start measuring")
//   ["出典：…"] のような配列/表の日本語リテラルも同じ表で書き換える（t(x) の間接参照はここを通る）
//
// 入力は out/i18n-keymap.json ただ一つ（＝i18n-extract が作った表）。暗黙の契約に頼らない＝
// 「この file のこの日本語リテラルは、この英語キー」という明示の対応だけで動く。字句解析で
// 文字列リテラルの範囲を採るので、コメント中の同じ日本語や、テンプレート地の中の "…" は触らない。
//
// 使い方: node scripts/i18n-apply.mjs --check   （検分＝置換箇所と危なそうな場所を出す・書かない）
//         node scripts/i18n-apply.mjs           （実行）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lex } from "./lib/i18n-scan.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");
const keymap = JSON.parse(fs.readFileSync(path.join(APP, "out/i18n-keymap.json"), "utf8"));

const OLD_COMMENT = /\s*\/\/ UI二言語化（ja正典[^\n]*/;
const NEW_COMMENT = "   // UI 多言語化（英語キー＝既定値・訳は i18n/<lang>.json＝i18n.js）";

let files = 0, subs = 0, dicts = 0, risky = [];
for (const [rel, map] of Object.entries(keymap)) {
	const abs = path.join(APP, rel);
	const src = fs.readFileSync(abs, "utf8");
	const { isCode, strings } = lex(src);
	const edits = [], dictRanges = [];

	for (const m of src.matchAll(/(?<![\w$.])tr\(\s*\{/g)) {                    // 持参辞書の呼び全体 tr({…}) を畳む
		const open = m.index + m[0].length - 1;
		if (!isCode[open]) continue;
		let depth = 0, j = open;
		for (; j < src.length; j++) {
			if (!isCode[j]) continue;
			if (src[j] === "{") depth++;
			else if (src[j] === "}" && !--depth) break;
		}
		let k = j + 1;
		while (k < src.length && /\s/.test(src[k])) k++;
		if (src[k] !== ")") { console.error(`ERROR  ${rel}: tr({…}) is not closed by ')' at offset ${j}`); process.exit(1); }
		dictRanges.push([m.index, k + 1]);
		edits.push({ start: m.index, end: k + 1, text: "tr()", kind: "dict" });
		dicts++;
	}

	const inDict = i => dictRanges.some(([a, b]) => i >= a && i < b);
	for (const s of strings) {
		if (inDict(s.start)) continue;                                           // 畳む辞書の中身＝個別に触らない
		if (!Object.hasOwn(map, s.value)) continue;   // hasOwn 必須＝JSON 由来の素のオブジェクトは "toString" 等で継承分を返す
		const key = map[s.value];
		const before = src.slice(Math.max(0, s.start - 60), s.start).replace(/\s+/g, " ");
		const after = src.slice(s.end, s.end + 20).replace(/\s+/g, " ");
		const isObjKey = /^\s*:/.test(after);                                     // "…": ＝表の見出し（引き当てに使われていないか）
		const isCompare = /[=!]==?\s*$/.test(before);                             // === "…" ＝比較（表示でなく判定）
		if (isObjKey || isCompare) risky.push(`${rel}:${s.line}  ${isObjKey ? "object-key" : "comparison"}  ${JSON.stringify(s.value)} -> ${JSON.stringify(key)}   …${before.slice(-40)}«»${after}`);
		edits.push({ start: s.start, end: s.end, text: JSON.stringify(key), kind: "key", line: s.line, from: s.value, to: key });
		subs++;
	}

	if (!edits.length) continue;
	files++;
	if (check) {
		console.log(`--- ${rel}  (${edits.filter(e => e.kind === "key").length} strings, ${edits.filter(e => e.kind === "dict").length} dict)`);
		continue;
	}
	let out = src;
	for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	out = out.replace(OLD_COMMENT, NEW_COMMENT);
	fs.writeFileSync(abs, out);
}

console.log(`${check ? "[check] " : ""}${files} files, ${subs} string(s) rewritten, ${dicts} dictionary literal(s) folded into tr()`);
if (risky.length) {
	console.log(`\n${risky.length} site(s) to eyeball (a string used as a table key or in a comparison, not only for display):`);
	for (const x of risky) console.log("  " + x);
}
