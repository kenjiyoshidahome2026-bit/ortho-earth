// 1) 日本語版 Wikipedia から温泉記事の題名を集める
//    芯: Category:日本の温泉地 の下の「○○県の温泉」などの下位カテゴリ（深さ 3 まで）
//    補: 「日本の温泉地一覧」と都道府県別の一覧記事（「○○県の温泉地一覧」等）からのリンク
//    出力: pages.json = { title: { sources:[...], cats:[...] } }
import { wikiAll, writeJSON, PREFS } from "./lib.mjs";

const ROOT_CAT = "Category:日本の温泉地";
const SKIP_CAT = /温泉街|温泉宿|温泉旅館|ホテル|温泉施設|温泉関連|温泉法|温泉地図|温泉の画像|銭湯|スーパー銭湯|人物|作品|番組|漫画|小説|楽曲|企業|鉄道|駅|バス|道路|源泉|観光協会|テンプレート|スタブ|出典|画像|泉質|歴史|団体|会社/;
const LISTS = ["日本の温泉地一覧", ...PREFS.map(p => `${p}の温泉地一覧`), ...PREFS.map(p => `${p}の温泉`)];

const pages = {};
const add = (title, src, cat) => { const p = pages[title] ??= { sources: [], cats: [] }; if (!p.sources.includes(src)) p.sources.push(src); if (cat && !p.cats.includes(cat)) p.cats.push(cat); };

// カテゴリ木を辿る
const seen = new Set();
async function walk(cat, depth) {
  if (seen.has(cat) || depth > 3) return; seen.add(cat);
  const subs = [];
  await wikiAll({ action: "query", list: "categorymembers", cmtitle: cat, cmlimit: "500", cmprop: "title|type" }, "cat", j => {
    for (const m of j.query.categorymembers) {
      if (m.type === "subcat") subs.push(m.title);
      else if (m.ns === 0) add(m.title, "category", cat.replace(/^Category:/, ""));
    }
  });
  for (const s of subs) if (!SKIP_CAT.test(s)) await walk(s, depth + 1);
}
await walk(ROOT_CAT, 0);
console.error("categories walked", seen.size, "pages", Object.keys(pages).length);

// 一覧記事のリンク（存在しない一覧は missing で返るので無視）。要求数を減らすため 50 題名ずつまとめて問い合わせる。
for (let i = 0; i < LISTS.length; i += 50) {
  await wikiAll({ action: "query", prop: "links", titles: LISTS.slice(i, i + 50).join("|"), plnamespace: "0", pllimit: "500" }, "list", j => {
    for (const pg of j.query.pages) {
      if (pg.missing) continue;
      for (const l of pg.links || []) if (/温泉|湯|鉱泉|泉$/.test(l.title) && !/一覧|^温泉$|温泉法|温泉街$|温泉地$|温泉郷$|Category|Template|温泉旅館|温泉宿|温泉饅頭|温泉卵|温泉マーク|温泉療法|温泉医学|源泉かけ流し|日帰り入浴|温泉番付|温泉ソムリエ|温泉津/.test(l.title)) add(l.title, "list:" + pg.title);
    }
  });
}
console.error("total pages", Object.keys(pages).length);
writeJSON("pages.json", pages);
