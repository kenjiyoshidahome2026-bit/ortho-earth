#!/usr/bin/env node
// world のデータを GitHub Pages へ置く＝リポ ortho-data の gh-pages 枝の globe/ へ git push（2026-10-13）。
// bucket の鍵（X-API-Key＝機械ごとに違う）が要らない＝git が通る機械ならどこからでも置ける。配信＝https://kenjiyoshidahome2026-bit.github.io/ortho-data/globe/
//   置く物（置く元＝out/・在る物だけ）:
//     DB            NationDB・CityDB・LanguageDB・CurrencyDB・Conflicts・TerrainDB（.json）
//     名前          <DB>.i18n/<lang>.json（DB の隣・同じ push＝DB は新しいのに名前が古い、を作らない・build/names.js）
//     形状台帳      ne-physical.geopbf・plates.geopbf・ne-physical-lines.geopbf・climate-koppen.geopbf（地形の頁）
//     検索の索引    search/base.json・search/<lang>.json（scripts/search-index.mjs）
//     資産          ne-cities/<lang>.json・flags/<key>.svg・geoms/<key>.png・sfx.zip（uploader が作る物＝手元に在れば）
//     宇宙          sky/＝星表 stars.6・星座線・メシエ・月の地名（.geopbf）・名前 sky/names/<lang>.json・sky/moon_nomenclature.i18n/<lang>.json（正本 packages/world/sky・焼く＝npm run sky）
//     人口（H3）    h3/kontur-<版>/＝/globe/hex が読む Kontur Population（焼く＝apps/ortho-globe/scripts/kontur-h3.mjs）
//   目録            manifest.json＝{ updated, files: { 相対パス: 中身の sha1 の頭 12 桁 } }＝置くたびに globe/ 全体から作り直す。
//                   Pages に一覧 API は無い＝world の頁はこれ 1 本で「変わったファイル」と「在る国旗」を知る（packages/world/src/data.ts）
//   使い方: node scripts/publish-pages.mjs            … 予行（何も書かない＝今の Pages と比べて 新規／変更／同じ を出す）
//           node scripts/publish-pages.mjs --write    … commit して push（反映＝配備 30 秒ほど＋エッジのキャッシュ 10 分）
//           --only=NationDB.json,NationDB.i18n … 名指しした物だけ（カンマ区切り・ファイルかフォルダ）
//           --from=DIR … 置く元（既定 out/）
//           --allow-older … 手元の JSON の updated が Pages より古くても置く（既定は止める＝古い版で上書きしない）
//           --scope=us | japan … globe/ 以外の範囲（DATA.md「フォルダはデータの範囲で分ける」）＝置く元はリポの根の ortho-data/<範囲>/
//                                （git で追う正本＝機械ごとに違わない）・その中の全ファイルを置く・目録は <範囲>/manifest.json
//   先に作る物: npm run build（DB と名前）→ plates → ne:physical → koppen → node scripts/search-index.mjs・宇宙は npm run sky
// bucket GIS/world/ には形状（ne-cultural-base／detail・rivers.json）だけが残る＝全アプリが初回に読む 16MB は Pages の帯域（月 100GB の目安）に載せない。
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process"; import { createHash } from "node:crypto"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? "").slice(n.length + 3);
const DIR = arg("scope") || "globe", TRACKED = DIR !== "globe";   // us・japan＝追跡している正本（ortho-data/<範囲>/）を丸ごと・globe＝out/ の決まった物だけ
if (!["globe", "us", "japan"].includes(DIR)) { console.error(`--scope は globe・us・japan のどれか（${DIR}）`); process.exit(1); }
const SRC = path.resolve(arg("from") || (TRACKED ? path.join(ROOT, "../../ortho-data", DIR) : path.join(ROOT, "out")));
const REMOTE = "https://github.com/kenjiyoshidahome2026-bit/ortho-data.git", BRANCH = "gh-pages", MANIFEST = "manifest.json";
const WRITE = process.argv.includes("--write"), ALLOW_OLDER = process.argv.includes("--allow-older");
const ONLY = arg("only").split(",").filter(Boolean);
const DBS = ["NationDB", "CityDB", "LanguageDB", "CurrencyDB", "Conflicts", "TerrainDB"];
const FILES = [...DBS.map(d => d + ".json"), "ne-physical.geopbf", "plates.geopbf", "ne-physical-lines.geopbf", "climate-koppen.geopbf", "sfx.zip"];
const FOLDERS = [...DBS.map(d => d + ".i18n"), "search", "ne-cities", "flags", "geoms", "sky", "h3"];
const walk = (d, rel = "") => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap(e => e.name.startsWith(".") ? [] : e.isDirectory() ? walk(d, rel + e.name + "/") : [rel + e.name]);
const have = TRACKED ? (fs.existsSync(SRC) ? walk(SRC).filter(f => f !== MANIFEST).sort() : []) : [...FILES.filter(f => fs.existsSync(path.join(SRC, f))), ...FOLDERS.filter(f => fs.existsSync(path.join(SRC, f))).flatMap(f => walk(SRC, f + "/"))].sort();
const LIST = have.filter(f => !ONLY.length || ONLY.some(o => f === o || f.startsWith(o.replace(/\/$/, "") + "/")));
{ const unknown = ONLY.filter(o => !LIST.some(f => f === o || f.startsWith(o.replace(/\/$/, "") + "/"))); if (unknown.length) { console.error(`--only に、置く元に無い名前: ${unknown.join(", ")}`); process.exit(1); } }
if (!LIST.length) { console.error(`${SRC} に置く物が無い${TRACKED ? "" : "＝先に build を回す"}`); process.exit(1); }
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 2 ** 20 }).toString().trim();
const updated = b => { try { return JSON.parse(b.toString("utf8")).updated ?? null; } catch { return null; } };
const kb = n => `${(n / 1024).toFixed(0)} KB`;
const group = f => f.includes("/") ? f.slice(0, f.indexOf("/")) + "/" : f;

if (LIST.includes("TerrainDB.json")) {   // 検札（置く前）
	const T = JSON.parse(fs.readFileSync(path.join(SRC, "TerrainDB.json"), "utf8")), items = T.items || T;
	if (items.length < 900 || !items.some(d => d.discharge > 0)) { console.error(`TerrainDB が古い（${items.length} 件・物理量なし）＝npm run build を回す`); process.exit(1); }
}
if (LIST.includes("NationDB.json")) {
	const n = (JSON.parse(fs.readFileSync(path.join(SRC, "NationDB.json"), "utf8")).items || []).length;
	if (n < 200) { console.error(`NationDB が小さい（${n} 件）＝npm run build を回す`); process.exit(1); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ortho-data-"));
try {
	git(tmp, "clone", "-q", "--depth", "1", "--branch", BRANCH, REMOTE, ".");
	console.log(`置く元 ${SRC}\n置く物 ${LIST.length} 本 → ${REMOTE.replace(/\.git$/, "")}（${BRANCH}/${DIR}/）・${WRITE ? "書き込む" : "予行（--write で実際に置く）"}`);
	const sum = new Map();   // 群（ファイルかフォルダ）→ { 新規, 変更, 同じ, 古い, bytes, note }
	for (const name of LIST) {
		const local = fs.readFileSync(path.join(SRC, name)), dst = path.join(tmp, DIR, name);
		const cur = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
		const g = sum.get(group(name)) || sum.set(group(name), { add: 0, mod: 0, same: 0, older: 0, bytes: 0, note: "" }).get(group(name));
		g.bytes += local.length;
		if (!cur) g.add++; else if (cur.equals(local)) g.same++; else {
			g.mod++;
			if (name.endsWith(".json")) { const a = updated(local), b = updated(cur); if (a && b) { g.note = `${b} → ${a}`; if (a < b) g.older++; } }
		}
		if (!cur || !cur.equals(local)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, local); }
	}
	let changed = 0, older = 0;
	for (const [name, g] of sum) {
		changed += g.add + g.mod; older += g.older;
		const what = [g.add && `新規 ${g.add}`, g.mod && `変更 ${g.mod}`, g.same && `同じ ${g.same}`].filter(Boolean).join("・");
		console.log(`  ${name.padEnd(28)} ${kb(g.bytes).padStart(9)}  ${what}${g.note ? `（${g.note}）` : ""}${g.older ? ` ✗ 手元の方が古い ${g.older}` : ""}`);
	}
	if (!changed) { console.log("全部同じ＝置く物は無い"); process.exit(0); }
	if (older && !ALLOW_OLDER) { console.error(`\n手元の方が古い物が ${older} 本＝置かない（古い版で上書きしない）。作り直すか --only で名指しする（承知の上なら --allow-older）`); process.exit(1); }
	// 目録＝globe/ の全ファイル（今回置かなかった物も含む）の中身の要約。updated は中身が変わった時だけ動く（同じ中身なら同じ目録）
	const dir = path.join(tmp, DIR), files = {};
	for (const f of walk(dir).filter(f => f !== MANIFEST).sort()) files[f] = createHash("sha1").update(fs.readFileSync(path.join(dir, f))).digest("hex").slice(0, 12);
	fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ updated: new Date().toISOString(), files }));
	console.log(`  ${MANIFEST.padEnd(28)} ${kb(fs.statSync(path.join(dir, MANIFEST)).size).padStart(9)}  ${Object.keys(files).length} 本の目録`);
	if (!WRITE) { console.log(`\n予行のみ（${changed} 本が変わる）。--write を付けると commit して push する`); process.exit(0); }
	const src = git(ROOT, "rev-parse", "--short", "HEAD"), who = ["user.name", "user.email"].map(k => git(ROOT, "config", k));
	git(tmp, "add", "-A", DIR);
	const names = [...sum].filter(([, g]) => g.add + g.mod).map(([n]) => n);
	git(tmp, "-c", `user.name=${who[0]}`, "-c", `user.email=${who[1]}`, "commit", "-q", "-m", `${DIR}/：${names.slice(0, 8).join("・")}${names.length > 8 ? ` ほか ${names.length - 8}` : ""}（${changed} 本・ortho-earth ${src}・publish-pages.mjs）`);
	git(tmp, "push", "-q", REMOTE, `HEAD:${BRANCH}`);
	console.log(`\n置いた（${changed} 本）: https://kenjiyoshidahome2026-bit.github.io/ortho-data/${DIR}/  ＝反映は配備 30 秒ほど＋キャッシュ 10 分`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
