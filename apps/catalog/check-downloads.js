const BASE_URL = 'https://nlftp.mlit.go.jp/ksj/gml/';
const MAIN_LIST_URL = `${BASE_URL}gml_datalist.html`;

async function fetchHtml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function findDownloadLinks(html, baseUrl) {
  const seen = new Set();
  const links = [];
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

async function main() {
  console.log('カタログ一覧を取得中...\n');
  const html = await fetchHtml(MAIN_LIST_URL);

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

  console.log(`合計 ${items.length} 件を確認します...\n`);

  const noLinks = [];
  let okCount = 0;

  for (let i = 0; i < items.length; i++) {
    const { title, url } = items[i];
    try {
      const pageHtml = await fetchHtml(url);
      const links = findDownloadLinks(pageHtml, url);
      if (links.length > 0) {
        okCount++;
        console.log(`✓ [${i + 1}/${items.length}] ${title} (${links.length}件)`);
      } else {
        noLinks.push({ title, url });
        console.log(`✗ [${i + 1}/${items.length}] ${title} — ダウンロードリンクなし`);
      }
    } catch (e) {
      noLinks.push({ title, url });
      console.log(`✗ [${i + 1}/${items.length}] ${title} — エラー: ${e.message}`);
    }
  }

  console.log(`\n===== 結果 =====`);
  console.log(`✓ ダウンロードあり: ${okCount} 件`);
  console.log(`✗ ダウンロードなし: ${noLinks.length} 件`);
  if (noLinks.length > 0) {
    console.log('\nダウンロードリンクがないカタログ:');
    noLinks.forEach(({ title, url }) => console.log(`  - ${title}\n    ${url}`));
  }
}

main().catch(console.error);
