// 訳すべきキーの一覧＝index.html の data-t / data-t-<attr>（HTML の実体参照は戻す）＋ demos.json（cards.js の demoKeys）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoKeys, optionalKeys } from "../cards.js";
export const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export function uiKeys() {
	const html = fs.readFileSync(path.join(APP, "index.html"), "utf8"), k = new Set();
	for (const m of html.matchAll(/\bdata-t(?:-[a-z-]+)?="([^"]*)"/g)) k.add(unesc(m[1]));
	return [...k];
}
const readDemos = () => JSON.parse(fs.readFileSync(path.join(APP, "demos.json"), "utf8"));
export const demoTextKeys = () => demoKeys(readDemos());
export const demoOptionalKeys = () => optionalKeys(readDemos());   // 訳は任意（固有名詞の題・Japanese only）
if (process.argv[1] === fileURLToPath(import.meta.url)) { const u = uiKeys(), d = demoTextKeys(); console.log(JSON.stringify({ ui: u, demos: d }, null, 1)); console.error(u.length, d.length); }
