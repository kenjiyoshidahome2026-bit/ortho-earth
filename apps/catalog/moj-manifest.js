/**
 * G空間 CKAN から法務省 登記所備付地図の全リソース一覧を取得
 * 出力: moj-manifest.json
 *   [{cityCode, cityName, packageName, resourceId, url, filename}]
 *
 * 使い方: node moj-manifest.js
 */
import { writeFileSync } from 'fs';

const CKAN    = 'https://www.geospatial.jp/ckan/api/3/action';
const QUERY   = '登記所備付地図';
const PAGE    = 100;   // 1リクエストあたりの取得件数

async function fetchPage(start) {
  const url = `${CKAN}/package_search?q=${encodeURIComponent(QUERY)}&rows=${PAGE}&start=${start}`;
  const res  = await fetch(url);
  const data = await res.json();
  return data.result;
}

// ZIPリソースから最新年のものを1件選ぶ
function pickResource(resources) {
  const zips = resources
    .filter(r => r.format === 'ZIP' && r.name.match(/\d{5}-\d+-\d{4}\.zip/i))
    .sort((a, b) => {
      // 年を降順: 2025 > 2024 > ...
      const ya = parseInt(a.name.match(/(\d{4})\.zip/)?.[1] || 0);
      const yb = parseInt(b.name.match(/(\d{4})\.zip/)?.[1] || 0);
      return yb - ya;
    });
  return zips[0] || null;
}

async function main() {
  // 総件数を取得
  const first = await fetchPage(0);
  const total = first.count;
  console.log(`総パッケージ数: ${total}`);

  const manifest = [];
  const results  = [...first.results];
  let done = first.results.length;

  // ページネーション
  while (done < total) {
    process.stdout.write(`\r  取得中: ${done}/${total}`);
    const page = await fetchPage(done);
    results.push(...page.results);
    done += page.results.length;
    if (!page.results.length) break;
  }
  console.log(`\r  取得完了: ${results.length} パッケージ`);

  // 各パッケージから市区町村コードとリソースURLを抽出
  let skipped = 0;
  for (const pkg of results) {
    const res = pickResource(pkg.resources);
    if (!res) { skipped++; continue; }

    // ファイル名から市区町村コード抽出: "01694-4625-2025.zip" → "01694"
    const match = res.name.match(/^(\d{5})-/);
    const cityCode = match ? match[1] : null;
    if (!cityCode) { skipped++; continue; }

    manifest.push({
      cityCode,
      title:       pkg.title,
      packageName: pkg.name,
      resourceId:  res.id,
      filename:    res.name,
      url:         res.url,  // CKAN URL (redirect → S3, fetchで自動追従)
    });
  }

  // 市区町村コードでソート
  manifest.sort((a, b) => a.cityCode.localeCompare(b.cityCode));

  const outPath = 'moj-manifest.json';
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  // 統計
  const codeCounts = {};
  for (const e of manifest) codeCounts[e.cityCode] = (codeCounts[e.cityCode] || 0) + 1;
  const multiZone = Object.values(codeCounts).filter(n => n > 1).length;

  console.log(`\n✅ マニフェスト生成完了`);
  console.log(`   総エントリ:     ${manifest.length}`);
  console.log(`   ユニーク市区町村: ${Object.keys(codeCounts).length}`);
  console.log(`   複数ZONEあり:   ${multiZone} 市区町村`);
  console.log(`   スキップ:        ${skipped}`);
  console.log(`   出力: ${outPath}`);
}

main().catch(console.error);
