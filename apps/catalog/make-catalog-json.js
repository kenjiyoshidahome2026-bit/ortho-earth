/**
 * 国土数値情報の全カタログを1つのJSONに集約する
 *
 * 出力: catalog.json
 * 構造:
 * [
 *   {
 *     "title":        "行政区域",
 *     "dataset_code": "N03-2026",
 *     "page_url":     "https://...",
 *     "license":      "CC_BY_4.0",
 *     "license_raw":  "オープンデータ（CC_BY_4.0）...",
 *     "attributes": [
 *       { "code": "N03_001", "label": "都道府県名" },
 *       { "code": "N03_007", "label": "全国地方公共団体コード",
 *         "codelist": "https://nlftp.mlit.go.jp/ksj/gml/codelist/AdminiBoundary_CD.xlsx" }
 *     ]
 *   }, ...
 * ]
 *
 * codelist は URL がある属性のみ付与（ない属性は省略）。
 * 属性説明 (description) は出力しない。
 */
import { writeFileSync } from 'fs';

const BASE_URL   = 'https://nlftp.mlit.go.jp/ksj/gml/';
const NLFTP_BASE = 'https://nlftp.mlit.go.jp';
const CONCURRENCY = 8;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// ライセンスパーサー（extract-schema.js と同一ロジック）
// ---------------------------------------------------------------------------
const LICENSE_NORMS = [
  [/CC_B[._]Y_4\.0|CC_BY_4\.0/,  'CC_BY_4.0'],
  [/CC_BY_NC_4\.0/,               'CC_BY_NC_4.0'],
  [/CC_BY_NC/,                    'CC_BY_NC'],
  [/CC_BY_SA/,                    'CC_BY_SA'],
  [/CC_BY/,                       'CC_BY'],
  [/非商用/,                      '非商用'],
  [/商用利用可|商用可|再配信可/,  '商用可'],
  [/オープンデータ/,              'オープンデータ'],
  [/パブリックドメイン/,          'パブリックドメイン'],
];

function parseLicense(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = clean.match(
    /<th[^>]*>[\s\S]*?(?:agreement_01|使用許諾条件)[\s\S]*?(?:<\/th>\s*)?<td[^>]*>([\s\S]*?)<\/td>/i
  );
  if (!m) return { license: '', license_raw: '' };
  const raw = m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, norm] of LICENSE_NORMS) {
    if (re.test(raw)) return { license: norm, license_raw: raw };
  }
  return { license: raw.slice(0, 60), license_raw: raw };
}

// ---------------------------------------------------------------------------
// 属性パーサー（コードリストURLを含む）
// ---------------------------------------------------------------------------

/**
 * HTML から属性定義を抽出する。
 * @returns {{ code, label, codelist? }[]}
 */
function parseAttributes(html, pageUrl) {
  const attrs = [];
  const seen  = new Set();
  const trRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;

  while ((m = trRe.exec(html)) !== null) {
    const inner = m[1];
    // <br>（CODE_NNN）パターンを持つ行のみ対象
    const codeM = inner.match(/<br[^>]*>\s*[（(]([A-Z]\d{2}[a-z*]?_\d{3})[)）]/i);
    if (!codeM) continue;

    const code = codeM[1];
    if (seen.has(code)) continue;
    seen.add(code);

    // ラベル: <br> の前のテキスト
    const firstTd = inner.match(/<td[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? '';
    const label   = firstTd
      .replace(/<br[^>]*>[\s\S]*/i, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // コードリストURL: <tr> 内の <a href="...codelist..."> を探す
    // <td> の先頭が属性名かどうかに関わらず、tr 全体から codelist リンクを収集
    const linkRe   = /<a\s+[^>]*href="([^"]*codelist[^"]*)"[^>]*>/gi;
    const codelistUrls = [...inner.matchAll(linkRe)]
      .map(l => {
        const href = l[1];
        return href.startsWith('http') ? href : new URL(href, pageUrl).href;
      });

    const entry = { code, label };
    if (codelistUrls.length > 0) entry.codelist = codelistUrls[0];
    attrs.push(entry);
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// 並列処理
// ---------------------------------------------------------------------------
async function pool(items, limit, fn) {
  const queue   = [...items];
  let active    = 0, idx = 0;
  const results = new Array(items.length);
  return new Promise(resolve => {
    function next() {
      while (active < limit && queue.length) {
        active++;
        const i = idx++;
        const item = queue.shift();
        fn(item, i)
          .then(r => { results[i] = r; })
          .catch(e => { results[i] = { error: e.message }; })
          .finally(() => { active--; next(); });
      }
      if (!active && !queue.length) resolve(results);
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
  console.log('カタログ一覧を取得中...');
  const indexHtml = await fetchText(`${BASE_URL}gml_datalist.html`);

  const pageRe = /<a\s+[^>]*href=["']([^"']*datalist\/KsjTmplt-[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/g;
  const seen   = new Set();
  const pages  = [];
  let m;
  while ((m = pageRe.exec(indexHtml)) !== null) {
    const url   = new URL(m[1], BASE_URL).href;
    const title = m[2].replace(/<[^>]*>/g, '').trim();
    if (!seen.has(url) && title) { seen.add(url); pages.push({ title, url }); }
  }
  console.log(`${pages.length} 件を処理中...\n`);

  const catalog = await pool(pages, CONCURRENCY, async ({ title, url }) => {
    const codeM      = url.match(/KsjTmplt-([^.]+)\.html/);
    const dataset_code = codeM ? codeM[1] : '';
    try {
      const html       = await fetchText(url);
      const { license, license_raw } = parseLicense(html);
      const attributes = parseAttributes(html, url);
      const attrStr    = attributes.length > 0
        ? `${attributes.length}属性 (コードリスト:${attributes.filter(a=>a.codelist).length}件)`
        : '属性なし';
      console.log(`✓ [${dataset_code}] ${attrStr} / ライセンス:${license || '?'}  ${title}`);
      return { title, dataset_code, page_url: url, license, license_raw, attributes };
    } catch (e) {
      console.log(`✗ [${dataset_code}] エラー: ${e.message}  ${title}`);
      return { title, dataset_code, page_url: url, license: '', license_raw: '', attributes: [], error: e.message };
    }
  });

  writeFileSync('catalog.json', JSON.stringify(catalog, null, 2), 'utf8');

  const totalAttrs     = catalog.reduce((s, c) => s + c.attributes.length, 0);
  const totalCodelists = catalog.reduce((s, c) => s + c.attributes.filter(a => a.codelist).length, 0);
  console.log(`\n✅ catalog.json — ${catalog.length} データセット`);
  console.log(`   属性合計: ${totalAttrs} / うちコードリストあり: ${totalCodelists}`);
}

main().catch(console.error);
