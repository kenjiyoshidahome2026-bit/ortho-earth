// 二重焼きの門番（2026-10-15・構造のエントロピーを下げる 項目 1）。
// エンジンの build が、束に入れたソース（リポからの相対パス）を apps/engine/dist/modules.json に書く（engineModules）。
// 各アプリの build（sharedEngine）は、自分の束に入ったソースがそこに載っていたら止める（checkDoubled）＝同じコードを
// アプリとエンジンの 2 か所で配らない。状態を持つ部品（globe の i18n 等）が 2 つの実体に割れる事故もここで止まる。
// 直し方＝その import をエンジンの入口（apps/engine/src/entries.mjs）から読む。入口が無ければ entries.mjs に足す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../..");
export const MODULES = resolve(ROOT, "apps/engine/dist/modules.json");
const rel = id => relative(ROOT, id.split("?")[0]);
const ours = id => !id.startsWith("\0") && !id.includes("/node_modules/") && rel(id).startsWith("packages/");   // npm の部品は数えない（内製のパッケージだけ）

export const engineModules = () => ({
	name: "engine-modules",
	generateBundle(_, bundle) {
		const set = new Set();
		for (const c of Object.values(bundle)) if (c.type === "chunk") for (const id of c.moduleIds) if (ours(id)) set.add(rel(id));
		mkdirSync(dirname(MODULES), { recursive: true });
		writeFileSync(MODULES, JSON.stringify([...set].sort(), null, "\t") + "\n");
	},
});

export function checkDoubled(bundle) {
	if (!existsSync(MODULES)) return [];
	const engine = new Set(JSON.parse(readFileSync(MODULES, "utf8")));
	const hit = new Set();
	for (const c of Object.values(bundle)) if (c.type === "chunk") for (const id of c.moduleIds) if (ours(id) && engine.has(rel(id))) hit.add(rel(id));
	return [...hit].sort();
}
