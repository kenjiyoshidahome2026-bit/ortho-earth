// 共通: 取得（プロキシ対応・再試行・生応答のキャッシュ）と小道具
import fs from "node:fs";
import path from "node:path";

// 作業場＝raw/（生応答のキャッシュ）・中間 JSON・data/（出力）。既定は scripts/onsen-ledger/.cache（git に入れない）
export const ROOT = process.env.ONSEN_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), ".cache");
export const RAW = path.join(ROOT, "raw");
export const UA = { "User-Agent": "ortho-earth-onsen/0.1 (https://github.com/kenjiyoshidahome2026-bit/ortho-earth)", "Accept": "application/json" };
// 端点は環境変数で差し替え可能（模擬サーバでの検定用）
export const WIKI_API = process.env.WIKI_API || "https://ja.wikipedia.org/w/api.php";
export const WIKI_RAW = process.env.WIKI_RAW || WIKI_API.replace(/api\.php$/, "index.php"); // ?action=raw&title=…
export const WD_API = process.env.WD_API || "https://www.wikidata.org/w/api.php";
export const SPARQL = process.env.SPARQL || "https://query.wikidata.org/sparql";
export const REFRESH = process.argv.includes("--refresh");

fs.mkdirSync(RAW, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 要求の間隔（ms）。Wikimedia の縁は共有 IP だと 429 を返しやすいので既定は 1 件 / 9 秒（実測: 共有 IP では約 35 秒窓に数件しか通らない）。環境変数で変更可。
export const GAP = +(process.env.ONSEN_GAP ?? 9000);
// Wikimedia 以外（国土地理院の住所検索・Nominatim）は 1 件 / 1.1 秒（Nominatim の利用規約は 1 件 / 秒）。
export const GAP_OTHER = +(process.env.ONSEN_GAP_OTHER ?? 1100);
// index.php?action=raw（記事の wikitext）は api.php と別の枡で、実測 1 件 / 秒で 9 割強通る。
export const GAP_RAW = +(process.env.ONSEN_GAP_RAW ?? 1000);
const lastReq = {};
async function pace(url) {
  const u = new URL(url), host = u.host;
  const key = /wiki(pedia|data|media)\.org$/.test(host) ? (u.pathname.endsWith("/index.php") ? host + ":raw" : host) : host;
  const gap = key.endsWith(":raw") ? GAP_RAW : /wiki(pedia|data|media)\.org$/.test(host) ? GAP : GAP_OTHER;
  const w = (lastReq[key] || 0) + gap - Date.now(); if (w > 0) await sleep(w); lastReq[key] = Date.now();
}
const hash = s => { let h = 0x811c9dc5; for (const c of Buffer.from(s)) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };

/** JSON を取る。raw/<tag>/<hash>.json にキャッシュ（--refresh で取り直し）。 */
export async function getJSON(url, { tag = "misc", accept, retries = 8, body } = {}) {
  const dir = path.join(RAW, tag); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, hash(url + (body ? "\n" + body : "")) + ".json");
  if (!REFRESH && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  let wait = 2000;
  for (let i = 0; ; i++) {
    try {
      await pace(url);
      const res = await fetch(url, body ? { method: "POST", body, headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" } } : { headers: { ...UA, ...(accept ? { Accept: accept } : {}) } });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error("HTTP " + res.status), { retryAfter: +res.headers.get("retry-after") || 0 });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { fatal: true });
      const j = await res.json();
      if (j.error) { if (j.error.code === "maxlag") throw new Error("maxlag"); throw Object.assign(new Error(j.error.code + ": " + j.error.info), { fatal: true }); }
      fs.writeFileSync(file, JSON.stringify(j));
      return j;
    } catch (e) {
      if (e.fatal || i >= retries) throw e;
      // 429 は Retry-After（秒）に従って待つ。それ以外は指数的に。
      const w = e.retryAfter ? (e.retryAfter + 1) * 1000 : wait;
      console.error(`  retry ${i + 1} (${e.message}, wait ${w / 1000}s) ${url.slice(0, 100)}`);
      await sleep(w); if (!e.retryAfter) wait *= 2;
    }
  }
}

/** HTML などテキストを取る。raw/<tag>/<hash>.txt にキャッシュ。 */
export async function getText(url, { tag = "html", retries = 4 } = {}) {
  const dir = path.join(RAW, tag); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, hash(url) + ".txt");
  if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  let wait = 2000;
  for (let i = 0; ; i++) {
    try {
      await pace(url);
      const res = await fetch(url, { headers: { "User-Agent": UA["User-Agent"], Accept: "text/html" } });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error("HTTP " + res.status), { retryAfter: +res.headers.get("retry-after") || 0 });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { fatal: true });
      const t = await res.text(); fs.writeFileSync(file, t); return t;
    } catch (e) {
      if (e.fatal || i >= retries) throw e;
      const w = e.retryAfter ? (e.retryAfter + 1) * 1000 : wait;
      console.error(`  retry ${i + 1} (${e.message}, wait ${w / 1000}s) ${url.slice(0, 100)}`); await sleep(w); if (!e.retryAfter) wait *= 2;
    }
  }
}

/** MediaWiki API: continue を追って全部集める（formatversion=2）。題名が多く URL が長くなる時は POST。 */
export async function wikiAll(params, tag, each) {
  let cont = {};
  for (;;) {
    const q = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params, ...cont }).toString();
    const j = q.length > 1500 ? await getJSON(WIKI_API, { tag, body: q }) : await getJSON(WIKI_API + "?" + q, { tag });
    each(j);
    if (!j.continue) break;
    cont = j.continue;
  }
}

export const sparql = async (q, tag = "sparql") =>
  (await getJSON(SPARQL + "?format=json&query=" + encodeURIComponent(q), { tag, accept: "application/sparql-results+json" })).results.bindings;

/** 日本の範囲内か（経度 122–154・緯度 20–46） */
export const inJapan = c => !!c && c[0] >= 122 && c[0] <= 154 && c[1] >= 20 && c[1] <= 46;
export const readJSON = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
export const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(path.join(ROOT, f)), { recursive: true }); fs.writeFileSync(path.join(ROOT, f), JSON.stringify(v, null, 1)); console.error("wrote", f); };

export const PREFS = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split(" ");
export const PREF_RE = new RegExp("(" + PREFS.join("|") + ")");
