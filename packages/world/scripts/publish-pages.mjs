#!/usr/bin/env node
// 地形の頁（/globe/physical）が読むデータを GitHub Pages へ置く＝リポ ortho-data の gh-pages 枝の globe/ へ git push（2026-10-13）。
// bucket の鍵（X-API-Key＝機械ごとに違う）が要らない＝git が通る機械ならどこからでも置ける。配信＝https://kenjiyoshidahome2026-bit.github.io/ortho-data/globe/
//   置く物＝out/ の TerrainDB.json・ne-physical.geopbf・plates.geopbf・ne-physical-lines.geopbf・climate-koppen.geopbf（5 本）
//           ＋ TerrainDB.i18n/<lang>.json（25 本＝地形の名前だけ・DB と同じ push で置く）
//   使い方: node scripts/publish-pages.mjs            … 予行（何も書かない＝今の Pages と比べて 新規／変更／同じ を出す）
//           node scripts/publish-pages.mjs --write    … commit して push（反映＝配備 30 秒ほど＋エッジのキャッシュ 10 分）
//           node scripts/publish-pages.mjs --only=climate-koppen.geopbf [--write] … 名指しした物だけ（カンマ区切り）
//           --allow-older … 手元の JSON の updated が Pages より古くても置く（既定は止める＝古い版で上書きしない・publish-physical の --only と同じ轍）
//   先に作る物: npm run build → npm run plates → npm run ne:physical → npm run koppen（publish-physical.mjs と同じ）
// bucket GIS/world/ の同名の物（world・equal・japan の地形・検索の索引が読む）は別＝そちらは publish-physical.mjs。
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), OUT = path.join(ROOT, "out");
const REMOTE = "https://github.com/kenjiyoshidahome2026-bit/ortho-data.git", BRANCH = "gh-pages", DIR = "globe";
const WRITE = process.argv.includes("--write"), ALLOW_OLDER = process.argv.includes("--allow-older");
const ONLY = (process.argv.find(a => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const FILES = ["TerrainDB.json", "ne-physical.geopbf", "plates.geopbf", "ne-physical-lines.geopbf", "climate-koppen.geopbf"];
const NAMES = fs.existsSync(path.join(OUT, "TerrainDB.i18n")) ? fs.readdirSync(path.join(OUT, "TerrainDB.i18n")).filter(f => f.endsWith(".json")).sort().map(f => "TerrainDB.i18n/" + f) : [];
const LIST = [...FILES, ...NAMES].filter(f => !ONLY.length || ONLY.includes(f));
{ const unknown = ONLY.filter(f => !LIST.includes(f)); if (unknown.length) { console.error(`--only に知らない名前: ${unknown.join(", ")}`); process.exit(1); } }
const missing = LIST.filter(f => !fs.existsSync(path.join(OUT, f)));
if (missing.length || (!ONLY.length && !NAMES.length)) { console.error(`out/ に無い: ${missing.join(", ") || "TerrainDB.i18n/"}＝先に build・plates・ne:physical・koppen を回す`); process.exit(1); }
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const updated = b => { try { return JSON.parse(b.toString("utf8")).updated ?? null; } catch { return null; } };
const kb = b => `${(b.length / 1024).toFixed(0)} KB`;

if (LIST.includes("TerrainDB.json")) {   // 検札（置く前）＝publish-physical.mjs と同じ線
	const T = JSON.parse(fs.readFileSync(path.join(OUT, "TerrainDB.json"), "utf8")), items = T.items || T;
	if (items.length < 900 || !items.some(d => d.discharge > 0)) { console.error(`TerrainDB が古い（${items.length} 件・物理量なし）＝npm run build を回す`); process.exit(1); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ortho-data-"));
try {
	git(tmp, "clone", "-q", "--depth", "1", "--branch", BRANCH, REMOTE, ".");
	console.log(`置く物 ${LIST.length} 本 → ${REMOTE.replace(/\.git$/, "")}（${BRANCH}/${DIR}/）・${WRITE ? "書き込む" : "予行（--write で実際に置く）"}`);
	let changed = 0, older = 0;
	for (const name of LIST) {
		const local = fs.readFileSync(path.join(OUT, name)), dst = path.join(tmp, DIR, name);
		const cur = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
		let note = !cur ? "新規" : cur.equals(local) ? "同じ" : `変更（今 ${kb(cur)}）`;
		if (cur && !cur.equals(local) && name.endsWith(".json")) {
			const a = updated(local), b = updated(cur);
			if (a && b) { note += ` ${b} → ${a}`; if (a < b) { note += " ✗ 手元の方が古い"; older++; } }
		}
		if (!cur || !cur.equals(local)) { changed++; fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, local); }
		if (!name.startsWith("TerrainDB.i18n/") || note !== "同じ") console.log(`  ${name.padEnd(28)} ${kb(local).padStart(8)}  ${note}`);
	}
	if (!changed) { console.log("全部同じ＝置く物は無い"); process.exit(0); }
	if (older && !ALLOW_OLDER) { console.error(`\n手元の方が古い物が ${older} 本＝置かない（古い版で上書きしない）。作り直すか --only で名指しする（承知の上なら --allow-older）`); process.exit(1); }
	if (!WRITE) { console.log(`\n予行のみ（${changed} 本が変わる）。--write を付けると commit して push する`); process.exit(0); }
	const src = git(ROOT, "rev-parse", "--short", "HEAD"), who = ["user.name", "user.email"].map(k => git(ROOT, "config", k));
	git(tmp, "add", "-A", DIR);
	git(tmp, "-c", `user.name=${who[0]}`, "-c", `user.email=${who[1]}`, "commit", "-q", "-m", `${DIR}/：${ONLY.length ? ONLY.join("・") : "地形の頁のデータ一式"}（${changed} 本・ortho-earth ${src}・publish-pages.mjs）`);
	git(tmp, "push", "-q", REMOTE, `HEAD:${BRANCH}`);
	console.log(`\n置いた（${changed} 本）: https://kenjiyoshidahome2026-bit.github.io/ortho-data/${DIR}/  ＝反映は配備 30 秒ほど＋キャッシュ 10 分`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
