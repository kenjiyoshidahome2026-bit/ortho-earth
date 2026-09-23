// 訳の表を「作るだけ」（書かない）＝i18n:build（書く）と verify:i18n（照合する＝焼き忘れを落とす）が同じ中身を見る。
// 戻り値 files＝Map<絶対パス, 中身の文字列 | null（あってはならない＝消す）>・rows＝言語ごとの件数とバイト（表示用）・pageRows＝ページ辞書の件数
import fs from "node:fs";
import path from "node:path";
import { loadPages } from "./i18n-pages.mjs";
import { hostDir } from "./i18n-scan.mjs";

export function i18nTables(APP) {
	const HOST = hostDir(APP);   // 本体（地球儀のホスト＝packages/globe/src）の訳＝正本 ui.json・焼き先 i18n/lang・langs.js はそこに住む（S4 2026-09-23）。頁の辞書は殻（APP）
	const ui = JSON.parse(fs.readFileSync(path.join(HOST, "i18n/ui.json"), "utf8")).ui ?? {};
	const langs = JSON.parse(fs.readFileSync(path.join(APP, "../../packages/world/i18n/langs.json"), "utf8"));
	const outDir = path.join(HOST, "i18n/lang"), pagesDir = path.join(APP, "i18n/lang");
	const files = new Map(), rows = [], pageRows = [];
	files.set(path.join(HOST, "i18n/langs.js"), "// 生成物＝npm run i18n:build（正本は packages/world/i18n/langs.json）。手で編集しない。\nexport default " + JSON.stringify(langs) + ";\n");
	for (const { code } of langs) {
		if (code === "en") continue;                                   // 英語＝キーそのもの＝表は要らない
		const table = {};
		for (const [key, row] of Object.entries(ui)) if (row[code]) table[key] = row[code];
		const keys = Object.keys(table).sort();
		const body = JSON.stringify(Object.fromEntries(keys.map(k => [k, table[k]])));
		const file = path.join(outDir, `${code}.json`);
		if (!keys.length && code !== "ja") { files.set(file, null); rows.push([code, 0, 0]); continue; }
		files.set(file, body + "\n");
		rows.push([code, keys.length, Buffer.byteLength(body)]);
	}
	// showcase ページの辞書（i18n/pages/<page>.json）＝i18n/lang/<page>/<code>.json へ。SDK（本体）は運ばない＝そのページの chunk だけが読む
	const { tables } = loadPages(APP);
	for (const [page, tbl] of Object.entries(tables)) {
		const dir = path.join(pagesDir, page);
		let nLangs = 0;
		for (const { code } of langs) {
			if (code === "en") continue;
			const table = {};
			for (const [key, row] of Object.entries(tbl)) if (row[code]) table[key] = row[code];
			const keys = Object.keys(table).sort(), file = path.join(dir, `${code}.json`);
			if (!keys.length) { files.set(file, null); continue; }
			files.set(file, JSON.stringify(Object.fromEntries(keys.map(k => [k, table[k]]))) + "\n");
			nLangs++;
		}
		pageRows.push([page, Object.keys(tbl).length, nLangs]);
	}
	return { files, rows, pageRows, total: Object.keys(ui).length };
}

// 書かれている物と作った物の食い違い＝[相対パス, 理由]の列（空＝焼き済み）
export function staleTables(APP, files = i18nTables(APP).files) {
	const bad = [];
	for (const [file, body] of files) {
		const has = fs.existsSync(file);
		if (body == null) { if (has) bad.push([file, "should not exist"]); continue; }
		if (!has) bad.push([file, "missing"]);
		else if (fs.readFileSync(file, "utf8") !== body) bad.push([file, "out of date"]);
	}
	return bad;
}
