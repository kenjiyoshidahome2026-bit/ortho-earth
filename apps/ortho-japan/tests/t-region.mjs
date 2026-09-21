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

// app.js と同じ合成（宣言の並びから材料を作る）
const compose = regions => ({
	dtm: regions.find(r => r.dtm)?.dtm ?? null,
	sets: regions.flatMap(r => r.buildings?.sets ?? []),
	catalog: regions.map(r => r.buildings?.catalog).filter(Boolean),
	basemap: regions.map(r => r.basemap).find(Boolean) ?? null,
	attr: regions.map(r => r.attribution).filter(Boolean),
	home: regions.map(r => r.home).find(Boolean) ?? null,
	search: regions.map(r => r.search).find(Boolean) ?? null,
	poi: regions.map(r => r.poi).find(Boolean) ?? null,
	rail: regions.map(r => r.rail).find(Boolean) ?? null,
});
// app.js と同じ入口の裁き（"only"=/nl/ 独立／"with-jp"=?nl=1 重ね／null=日本）
const pick = mode => mode === "only" ? [NL_REGION] : mode === "with-jp" ? [JP_REGION, NL_REGION] : [JP_REGION];

// ── ① 日本だけ（既定の入口） ─────────────────────────────────────────────
const jp = compose(pick(null));
eq("日本の台帳は取得する 1 本", jp.catalog, ["plateau-sets.json"]);
eq("その場で足す台帳は無い", jp.sets.length, 0);
yes("裸地標高の申告を持つ", jp.dtm && jp.dtm.brand === "GSI");
eq("裸で開いた時の視点はアプリ既定", JP_REGION.view, null);

// ── ② ?nl=1 / /nl/（オランダを足す） ────────────────────────────────────
const both = compose(pick("with-jp"));
eq("取得する台帳は日本の 1 本のまま", both.catalog, ["plateau-sets.json"]);
eq("足すのはオランダの 3 件", both.sets.length, 3);
eq("裸地標高の申告は日本のものが残る（オランダは持たない）", both.dtm, JP_REGION.dtm);
eq("オランダは裸地標高を宣言しない＝接地リフトしない", NL_REGION.dtm, null);
eq("裸で開いた時はデルフト上空", NL_REGION.view, "#16/52.0116/4.3571/45t");

// 基図と出典（第二段・2026-09-17）
yes("日本は基図を宣言する", jp.basemap && jp.basemap.kind === "gsi");
eq("配信圏は本土＋離島を内包", jp.basemap.coverage, [121, 19, 155, 46]);
eq("タイル URL は地理院の最適化ベクトルタイル", jp.basemap.tileUrl(12, 3637, 1612), "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/12/3637/1612.pbf");
eq("出典は日本のもの 1 組", jp.attr.length, 1);
yes("出典の 1 行目は地理院の正式名称", jp.attr[0].lines[0][0].key.includes("Geospatial Information Authority"));

// ── ②' /nl/ ＝独立の入口（この地域だけ） ────────────────────────────────
const only = compose(pick("only"));
eq("取得する台帳は無い（日本の 336 件を持ち込まない）", only.catalog, []);
eq("建物はオランダの 3 件だけ", only.sets.length, 3);
eq("裸地標高の申告は無い＝接地リフトしない", only.dtm, null);
eq("基図を宣言しない＝タイルを要求しない（図郭外と同じ全面水域）", only.basemap, null);
eq("出典はオランダのものだけ", only.attr.length, 1);
yes("出典に 3DBAG と CC BY 4.0", only.attr[0].lines[0][0].key.includes("3DBAG") && only.attr[0].lines[0][0].key.includes("CC BY 4.0"));
yes("日本の出典は混ざらない", !JSON.stringify(only.attr).includes("GSI"));

// ?nl=1（重ね）は日本の基図と出典のまま＝開発の重ね確認
yes("?nl=1 は日本の基図を使う", both.basemap && both.basemap.kind === "gsi");
eq("?nl=1 は出典を両方出す", both.attr.length, 2);

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

// ── 宣言から注入する 4 つの口（2026-09-22：app.js の直書きから移設）──────────────────────────
// 日本＝全部持つ／/nl/＝どれも持たない（検索窓・日本ボタン・POI・N02 を作らない）／?nl=1＝日本のものが効く
eq("日本の戻り先＝列島ビュー（移設前の JAPAN_VIEW と同値）", jp.home?.view, [137, 37, 6.6]);
yes("日本の検索供給元＝契約の形", jp.search && typeof jp.search.query === "function" && typeof jp.search.viewFor === "function" && jp.search.histKey === "ortho-japan.searches");
eq("日本の POI 台帳の在り処（移設前と同値）", jp.poi, { api: "https://api.ortho-earth.com", base: "https://api.ortho-earth.com/bucket/GIS/pbf/", overrides: "poi/overrides.json" });
yes("日本の路線オーバーレイ＝生成関数", typeof jp.rail === "function");
eq("着地ズーム：自然地名は地形ビュー", jp.search.viewFor("富士山"), { zoom: 12.8, tilt: 55 });
eq("着地ズーム：市区町村", jp.search.viewFor("東京都渋谷区"), { zoom: 13 });
{
	const o = compose(pick("only"));
	eq("/nl/ は 4 つの口をどれも持たない", [o.home, o.search, o.poi, o.rail], [null, null, null, null]);
	const b = compose(pick("with-jp"));
	yes("?nl=1 は日本の 4 つがそのまま効く", b.home === jp.home && b.search === jp.search && b.poi === jp.poi && b.rail === jp.rail);
}

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok} 件すべて`);
process.exit(ng ? 1 : 0);
