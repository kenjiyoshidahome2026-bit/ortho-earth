// 2) 各記事の座標・Wikidata ID・カテゴリ・本文（wikitext）を取り、属性を抜く
//    出力: articles.json = [{ title, pageid, qid, coord:[lon,lat]|null, coordSource, reading, pref, muni, address, quality, temp, ph, ..., cats }]
import { wikiAll, getText, readJSON, writeJSON, WIKI_RAW } from "./lib.mjs";
import { parse, sourceInfo } from "./parse.mjs";

/** 本文中の内部リンクのうち温泉らしい題名（温泉郷の構成員・所属先の推定に使う） */
const linksOf = text => [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim().replace(/^./, c => c.toUpperCase())).filter(t => /温泉|鉱泉|湯$|の湯/.test(t) && !/^(Category|ファイル|File|画像|Template|Wikipedia):/i.test(t)))];
const pages = readJSON("pages.json");
const titles = Object.keys(pages);
const out = {};

// a. 記事の属性（座標・Wikidata ID・カテゴリ）。本文は含めない: 本文込みだと 1 応答に数件しか入らず api.php の要求数が増えるため。
for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  await wikiAll({ action: "query", titles: batch.join("|"), redirects: "1",
    prop: "coordinates|pageprops|categories", coprimary: "primary", ppprop: "wikibase_item|disambiguation", cllimit: "500" }, "meta", j => {
    for (const pg of j.query.pages) {
      if (pg.missing) continue;
      const a = out[pg.title] ??= { title: pg.title, pageid: pg.pageid, cats: [], redirectFrom: [] };
      if (pg.coordinates?.[0]) { const c = pg.coordinates[0]; a.coord = [c.lon, c.lat]; a.coordSource = "wikipedia"; }
      if (pg.pageprops?.wikibase_item) a.qid = pg.pageprops.wikibase_item;
      if (pg.pageprops && "disambiguation" in pg.pageprops) a.disambig = true;
      for (const c of pg.categories || []) if (!a.cats.includes(c.title.replace(/^Category:/, ""))) a.cats.push(c.title.replace(/^Category:/, ""));
    }
    for (const r of j.query.redirects || []) { const a = out[r.to]; if (a && !a.redirectFrom.includes(r.from)) a.redirectFrom.push(r.from); }
  });
  console.error(`meta ${Math.min(i + 50, titles.length)}/${titles.length}`);
}
// b. 本文（wikitext）は index.php?action=raw で 1 記事ずつ（api.php とは別のレート枡）。曖昧さ回避は読まない。
const arts = Object.values(out).filter(a => !a.disambig);
let n = 0;
for (const a of arts) {
  let text;
  try { text = await getText(`${WIKI_RAW}?action=raw&title=${encodeURIComponent(a.title.replace(/ /g, "_"))}`, { tag: "rawtext", retries: 6 }); }
  catch (e) { console.error("  raw failed", a.title, e.message); }
  if (text && /^\s*#(REDIRECT|転送)/i.test(text)) { const m = text.match(/\[\[([^\]|#]+)/); if (m) try { text = await getText(`${WIKI_RAW}?action=raw&title=${encodeURIComponent(m[1].trim().replace(/ /g, "_"))}`, { tag: "rawtext", retries: 6 }); } catch {} }
  if (text) { Object.assign(a, parse(text), sourceInfo(text, a.title)); a.links = linksOf(text); a.textLength = text.length; }
  if (++n % 100 === 0) console.error(`raw ${n}/${arts.length}`);
}
// 元の題名（一覧・カテゴリの出所）を結び直す
for (const a of Object.values(out)) {
  const srcs = new Set(), cats = new Set(a.cats);
  for (const t of [a.title, ...a.redirectFrom]) for (const s of pages[t]?.sources || []) srcs.add(s);
  a.sources = [...srcs];
  a.cats = [...cats];
}
writeJSON("articles.json", Object.values(out).sort((x, y) => x.title.localeCompare(y.title, "ja")));
