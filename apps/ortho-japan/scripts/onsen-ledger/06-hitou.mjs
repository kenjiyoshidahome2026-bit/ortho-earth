// 6) 日本秘湯を守る会（https://www.hitou.or.jp/）の会員宿を取る（Kenji 指示 2026-10-06: 秘湯を守る会のデータも参照）
//    会員宿一覧 /provider/list → 各宿 /provider/<id> の JSON-LD（名称・住所・座標）と題名の温泉名・泉質表。
//    持つのは事実（宿名・所在地・座標・温泉名・泉質・URL）だけで、紹介文は転載しない。1 件 / 1.1 秒。
//    出力: hitou.json = [{ id, url, name, onsen, pref, address, postal, lon, lat, quality, season }]
import { getText, writeJSON, inJapan, PREF_RE } from "./lib.mjs";

const BASE = process.env.HITOU || "https://www.hitou.or.jp";
const unesc = s => (s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();   // &amp; は最後（&amp;lt; を二重に戻さない）
const strip = s => unesc((s || "").replace(/<[^>]+>/g, " "));

const list = await getText(`${BASE}/provider/list`, { tag: "hitou" });
const ids = [...new Set([...list.matchAll(/href="\/provider\/(\d+)"/g)].map(m => m[1]))];
console.error("hitou providers", ids.length);
const out = [];
for (const id of ids) {
  const html = await getText(`${BASE}/provider/${id}`, { tag: "hitou" });
  const rec = { id, url: `${BASE}/provider/${id}` };
  const title = strip((html.match(/<title>([^<]*)/) || [])[1]).replace(/\s*宿泊予約.*$/, "");
  // 題名「泥湯温泉 泥湯温泉 奥山旅館」→ 先頭の語が温泉名、残りが宿名
  const parts = title.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /温泉|鉱泉|湯$|温泉郷$/.test(parts[0])) { rec.onsen = parts[0]; rec.name = parts.slice(1).join(" ").replace(new RegExp("^" + parts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*"), ""); }
  else rec.name = title;
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    for (const o of Array.isArray(j) ? j : [j]) {
      if (!o || typeof o !== "object") continue;
      if (o.geo?.latitude != null) { const c = [+(+o.geo.longitude).toFixed(6), +(+o.geo.latitude).toFixed(6)]; if (inJapan(c)) { rec.lon = c[0]; rec.lat = c[1]; } }
      if (o.address) { rec.address ??= unesc(o.address.streetAddress); rec.postal ??= o.address.postalCode; rec.pref ??= o.address.addressRegion; }
      if (o.name && !rec.name) rec.name = unesc(o.name);
    }
  }
  // 表: 泉質・住所（JSON-LD に無い場合の補い）
  const row = k => { const m = html.match(new RegExp(`<th[^>]*>\\s*${k}\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`)); return m ? strip(m[1]).replace(/\[→MAP\]/, "").trim() : undefined; };
  rec.quality = row("泉質"); rec.address ??= (row("住所") || "").replace(/^〒?[\d-]+\s*/, "") || undefined;
  rec.pref ??= ((rec.address || "").match(PREF_RE) || [])[1];
  rec.season = /期間営業/.test(html) ? "期間営業" : /通年営業/.test(html) ? "通年営業" : undefined;
  out.push(rec);
  if (out.length % 20 === 0) console.error(`hitou ${out.length}/${ids.length}`);
}
writeJSON("hitou.json", out);
console.error(JSON.stringify({ inns: out.length, withOnsen: out.filter(r => r.onsen).length, withCoord: out.filter(r => r.lon != null).length }));
