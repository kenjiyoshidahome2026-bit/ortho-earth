// 共有エンジン（縮小計画 項目 9・本人裁定 2026-09-30）をアプリの build に繋ぐ vite プラグイン。
// build の時だけ、エンジンと状態を分かち合う 4 つの import を /globe/engine/<版>/ の URL へ外に出す（external）＝束に焼かない。
// dev はソース直のまま（HMR・編集即反映は従来どおり）。build の頭で毎回エンジンを焼き直す（ortho-globe の build-engine.mjs・十数秒）＝
// <版>（中身のハッシュ）が常に今のソースと一致する（古い current.json を指したまま出す事故を起こさない）。中身が同じなら版も同じ。
//   import { sharedEngine } from "../../packages/globe/scripts/lib/shared-engine.mjs";   plugins: [sharedEngine()]
// 4 つ＝エンジン本体・i18n（言語の状態）・core（楕円体の切替等の状態）・geopbf（worker の口と既定の bucket）。
// ＋ h3（@ortho-earth/h3/core＝h3-js・状態は無いが約 65KB＝エンジンの map.addH3 と同じ実体を使う・2026-10-14）。
// 他の部品（ephem・common・geopbf/gzip 等）は状態を持たない＝従来どおりアプリの束に入る。
// 2026-10-14〜 入口は current.json の imports（apps/ortho-globe/engine/entries.mjs）＝2 つ以上のアプリが使う部品も入口にして共に読む（LAYERS.md 掟 6）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const GLOBE_APP = resolve(import.meta.dirname, "../../../../apps/ortho-globe");
const CURRENT = resolve(GLOBE_APP, "dist/engine/current.json");
const MAP = { "@ortho-earth/globe": "globe", "@ortho-earth/globe/i18n.js": "i18n", "@ortho-earth/core": "core", "geopbf": "geopbf", "@ortho-earth/h3/core": "h3" };

export const buildEngine = () => execFileSync(process.execPath, [resolve(GLOBE_APP, "scripts/build-engine.mjs")], { stdio: "inherit" });
export const engineVersion = () => {
	if (!existsSync(CURRENT)) throw new Error("共有エンジンが無い＝npm run build:engine -w ortho-globe（apps/ortho-globe/dist/engine/current.json）");
	return JSON.parse(readFileSync(CURRENT, "utf8")).version;
};
export const engineBase = () => `/globe/engine/${engineVersion()}/`;
// 入口の一覧＝current.json の imports（apps/ortho-globe/engine/entries.mjs が正本・2026-10-14 に地域パック等を足せるよう外へ出した）。無い古い current.json は MAP
const engineImports = () => JSON.parse(readFileSync(CURRENT, "utf8")).imports ?? Object.fromEntries(Object.entries(MAP).map(([k, v]) => [k, `${v}.js`]));

export function sharedEngine() {
	let base, imports;
	return {
		name: "shared-engine",
		apply: "build",
		enforce: "pre",
		buildStart() { buildEngine(); base = engineBase(); imports = engineImports(); },
		resolveId(id) { return Object.hasOwn(imports, id) ? { id: `${base}${imports[id]}`, external: true } : null; },
	};
}
