import { writeFileSync } from 'fs';

const BASE_URL = 'https://nlftp.mlit.go.jp/ksj/gml/';
const NLFTP_BASE = 'https://nlftp.mlit.go.jp';

async function fetchHtml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// DownLd パターンからリンク抽出
function findDownloadLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const regex = /DownLd\([^,]+,\s*'([^']+)',\s*'([^']+)'/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const name = match[1].trim();
    const url = new URL(match[2].trim(), baseUrl).href;
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ name, url });
    }
  }
  return links;
}

// 全国 > 都道府県 > 市区町村 の粒度で重複除去
// - 都道府県コード: ファイル名に _01_ ～ _47_ のパターン
// - 市区町村コード: ファイル名に _\d{5}[_.] のパターン
// - 全国: 上記パターンなし
function deduplicateLinks(links) {
  const prefRe = /_([0-4]\d)[_.]|_([0-4]\d)$/;
  const cityRe = /_\d{5}[_.]/;

  const national = links.filter(l => !prefRe.test(l.name) && !cityRe.test(l.name));
  const pref     = links.filter(l =>  prefRe.test(l.name) && !cityRe.test(l.name));
  const city     = links.filter(l =>  cityRe.test(l.name));

  if (national.length > 0 && (pref.length > 0 || city.length > 0)) return national;
  if (pref.length     > 0 && city.length > 0)                        return pref;
  return links;
}

// tokei_data*.js から GEOJSON リンク抽出（都道府県レベルのみ）
async function findTokeiLinks(html, baseUrl) {
  const scriptRegex = /src="([^"]*tokei_data\d+\.js)"/g;
  const allEntries = [];
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const jsUrl = new URL(match[1], baseUrl).href;
    try {
      const jsText = await fetchHtml(jsUrl);
      const jsonText = jsText.replace(/^const\s+\w+\s*=\s*/, '').replace(/;\s*$/, '');
      const data = JSON.parse(jsonText);
      for (const entry of data) {
        if (entry.data === 'GEOJSON形式' && entry.dl) allEntries.push(entry);
      }
    } catch (e) {}
  }

  if (allEntries.length === 0) return [];

  // 全国 > 都道府県 > 市区町村 の粒度で絞り込む
  // citycode: 00000=全国, XX000=都道府県, XXXXX=市区町村
  const hasNational = allEntries.some(e => e.citycode === '00000');
  const hasPref     = allEntries.some(e => e.citycode?.slice(-3) === '000' && e.citycode !== '00000');

  const filtered = hasNational ? allEntries.filter(e => e.citycode === '00000')
                 : hasPref     ? allEntries.filter(e => e.citycode?.slice(-3) === '000')
                 : allEntries;

  return filtered.map(e => ({
    name: e.file,
    url: new URL(e.dl, NLFTP_BASE).href
  }));
}

async function main() {
  console.log('カタログ一覧を取得中...');
  const html = await fetchHtml(`${BASE_URL}gml_datalist.html`);

  const linkRegex = /<a\s+[^>]*href=["']([^"']*datalist\/KsjTmplt-[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set();
  const items = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const url = new URL(match[1], BASE_URL).href;
    const title = match[2].replace(/<[^>]*>/g, '').trim();
    if (!seen.has(url) && title) {
      seen.add(url);
      items.push({ title, url });
    }
  }

  console.log(`${items.length} 件のカタログを処理中...\n`);

  const rows = [['title', 'filename', 'url']];

  for (let i = 0; i < items.length; i++) {
    const { title, url } = items[i];
    try {
      const pageHtml = await fetchHtml(url);
      let links = findDownloadLinks(pageHtml, url);

      if (links.length > 0) {
        links = deduplicateLinks(links);
      } else {
        links = await findTokeiLinks(pageHtml, url);
      }

      for (const link of links) {
        rows.push([title, link.name, link.url]);
      }

      console.log(`✓ [${i + 1}/${items.length}] ${title}: ${links.length}件`);
    } catch (e) {
      console.log(`✗ [${i + 1}/${items.length}] ${title}: エラー - ${e.message}`);
    }
  }

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  writeFileSync('catalog-downloads.csv', '﻿' + csv, 'utf8');

  console.log(`\n✅ ${rows.length - 1} 件のURLを catalog-downloads.csv に出力しました`);
}

main().catch(console.error);
