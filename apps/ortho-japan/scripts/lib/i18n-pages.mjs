// showcase ページの辞書の分け方（正本＝i18n/pages.json）。本体（ui.json）と、ページごとの i18n/pages/<page>.json を読む共通の口。
import fs from "node:fs";
import path from "node:path";
import { scanApp } from "./i18n-scan.mjs";
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

// 本体（ui.json）のキーが「生きている」かの判定＝抽出（i18n-extract）と検定（verify-i18n）の共通の物差し（2026-09-22 一本化）。
// showcase ページは実行時に本体の表へ自分の表を**足して**引く（i18n.js loadPage）＝複数ページで共有する文言（Collapse panel 等）は
// わざと本体に置いてある＝ページからの参照でも本体のキーは生きている。以前は抽出だけが本体の走査しか見ず、この共有キーを退役させていた
//（検定は通る＝食い違い。ページ分離 4472a1d7 で検定だけ直っていた）。
// 返り＝{ P, r（本体の走査）, rp（ページごとの走査）, alive(key) }。
export function scanAll(APP, ctx) {
	const P = loadPages(APP);
	const r = scanApp(APP, ctx, { exclude: P.pageFiles });
	const rp = Object.fromEntries(Object.keys(P.pages).map(page => [page, scanApp(APP, ctx, { only: new Set(P.pages[page]) })]));
	const alive = k => r.keys.has(k) || r.literals.has(k) || Object.values(rp).some(rr => rr.keys.has(k) || rr.literals.has(k));
	return { P, r, rp, alive };
}
