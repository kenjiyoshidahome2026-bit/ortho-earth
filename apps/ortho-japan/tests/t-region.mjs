// 地域宣言（jp/region.js・nl/region.js）が、今と同じ台帳を組み立てることを写し取る検定（2026-09-17）。
//
// なぜ要るか：オランダ 3 件は app.js のソースに直書きされていた＝二国目がコードで入ったので三国目も
// コードで入ることになる。宣言（データ）へ移した後も、①日本だけの時は 336 件そのまま、②?nl=1 では
// **日本に足す**形（日本へ飛べば日本の建物も出る）、を固定する。台帳の形（name/bbox/base）も検める。
//
// 使い方: node tests/t-region.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JP_REGION } from "../jp/region.js";
import { NL_REGION } from "../nl/region.js";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let ok = 0, ng = 0;
const eq = (name, got, want) => {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { ok++; return; }
	ng++; console.error(`NG  ${name}\n    got  ${g}\n    want ${w}`);
};
const yes = (name, cond) => eq(name, !!cond, true);

// app.js と同じ合成（宣言の並びから台帳の材料を作る）
const compose = regions => ({
	dtm: regions.find(r => r.dtm)?.dtm ?? null,
	sets: regions.flatMap(r => r.buildings?.sets ?? []),
	catalog: regions.map(r => r.buildings?.catalog).filter(Boolean),
});

// ── ① 日本だけ（既定の入口） ─────────────────────────────────────────────
const jp = compose([JP_REGION]);
eq("日本の台帳は取得する 1 本", jp.catalog, ["plateau-sets.json"]);
eq("その場で足す台帳は無い", jp.sets.length, 0);
yes("裸地標高の申告を持つ", jp.dtm && jp.dtm.brand === "GSI");
eq("裸で開いた時の視点はアプリ既定", JP_REGION.view, null);

// ── ② ?nl=1 / /nl/（オランダを足す） ────────────────────────────────────
const both = compose([JP_REGION, NL_REGION]);
eq("取得する台帳は日本の 1 本のまま", both.catalog, ["plateau-sets.json"]);
eq("足すのはオランダの 3 件", both.sets.length, 3);
eq("裸地標高の申告は日本のものが残る（オランダは持たない）", both.dtm, JP_REGION.dtm);
eq("オランダは裸地標高を宣言しない＝接地リフトしない", NL_REGION.dtm, null);
eq("裸で開いた時はデルフト上空", NL_REGION.view, "#16/52.0116/4.3571/45t");

// ── ③ 台帳 1 件の形（日本の 336 件とオランダの 3 件に同じ物差しを当てる） ──
const jpSets = JSON.parse(fs.readFileSync(path.join(APP, "public/plateau-sets.json"), "utf8"));
const shapeBad = sets => sets.filter(s => !s.name || !s.base || !Array.isArray(s.bbox) || s.bbox.length !== 4
	|| !(s.bbox[0] < s.bbox[2]) || !(s.bbox[1] < s.bbox[3]));
eq("日本の台帳は 336 件", jpSets.length, 336);
eq("日本の台帳に形の崩れは無い", shapeBad(jpSets).map(s => s.name || s.base), []);
eq("オランダの 3 件も同じ形", shapeBad(NL_REGION.buildings.sets).map(s => s.name || s.base), []);
yes("オランダは外部 tileset と切り抜きを持つ", NL_REGION.buildings.sets.every(s => s.tilesetUrl && s.clip));
eq("識別キーは国で衝突しない", NL_REGION.buildings.sets.filter(s => jpSets.some(j => j.base === s.base)).length, 0);

// 識別キーは永続化の鍵（worker 振り分け・IDB・OPFS のファイル名）＝移設で変わっていないこと
eq("オランダの識別キー", NL_REGION.buildings.sets.map(s => s.base), ["nl-3dbag-delft/", "nl-3dbag-rotterdam/", "nl-3dbag-amsterdam/"]);

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok} 件すべて`);
process.exit(ng ? 1 : 0);
