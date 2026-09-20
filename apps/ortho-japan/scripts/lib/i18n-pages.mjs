// showcase ページの辞書の分け方（正本＝i18n/pages.json）。本体（ui.json）と、ページごとの i18n/pages/<page>.json を読む共通の口。
import fs from "node:fs";
import path from "node:path";
export function loadPages(APP) {
	const p = path.join(APP, "i18n/pages.json");
	const pages = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).pages ?? {} : {};
	const fileToPage = new Map();
	for (const [page, files] of Object.entries(pages)) for (const f of files) fileToPage.set(f, page);
	const tables = {};
	for (const page of Object.keys(pages)) {
		const f = path.join(APP, `i18n/pages/${page}.json`);
		tables[page] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).ui ?? {} : {};
	}
	return { pages, fileToPage, tables, pageFiles: new Set(fileToPage.keys()) };
}
