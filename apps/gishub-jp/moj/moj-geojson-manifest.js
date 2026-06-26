/**
 * 法務省14条地図 GeoJSON マニフェスト生成
 *
 * G空間の aigid-moj-{cityCode} パッケージから最新年の GeoJSON URL を取得し、
 * catalog.json 形式のエントリ一覧を moj-geojson.json に出力する。
 *
 * 使い方: node moj-geojson-manifest.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));

const CKAN      = 'https://www.geospatial.jp/ckan/api/3/action';
const CONCURRENCY = 20;
const PROGRESS_EVERY = 50;
const OUT_FILE = join(__dir, 'geojson.json');

const manifest = JSON.parse(readFileSync(join(__dir, 'manifest.json'), 'utf8'));
const total = manifest.length;
console.log(`処理対象: ${total} 市区町村`);

// 最新年の GeoJSON リソースを選ぶ
function pickGeoJSON(resources) {
	const geojsons = resources
		.filter(r => r.format === 'GeoJSON')
		.sort((a, b) => {
			const ya = parseInt(a.name.match(/(\d{4})\.geojson/i)?.[1] || 0);
			const yb = parseInt(b.name.match(/(\d{4})\.geojson/i)?.[1] || 0);
			return yb - ya; // 降順（最新優先）
		});
	return geojsons[0] || null;
}

// 1件フェッチ: aigid-moj-{cityCode} → 最新 GeoJSON エントリ
async function fetchEntry({ cityCode, title }) {
	const pkgId = `aigid-moj-${cityCode}`;
	try {
		const res  = await fetch(`${CKAN}/package_show?id=${pkgId}`);
		const data = await res.json();
		if (!data.success) return null;

		const pkg = data.result;
		const r   = pickGeoJSON(pkg.resources);
		if (!r) return null;

		// ファイル名から年を抽出
		const year = r.name.match(/(\d{4})\.geojson/i)?.[1] || '?';

		return {
			name:        r.name.replace(/\.geojson$/i, ''),
			description: `${year} ${title.replace(/（.*?）/g, '').replace('登記所備付地図データ', '').trim()} 筆ポリゴン`,
			target:      r.url,
			link:        `https://www.geospatial.jp/ckan/dataset/${pkgId}`,
			attribution: '法務省 登記所備付地図',
			license:     'CC_BY_4.0',
			precision:   7,
		};
	} catch {
		return null;
	}
}

// CONCURRENCY 並列でフェッチ
async function main() {
	const results = [];
	let done = 0, ok = 0, ng = 0;

	for (let i = 0; i < total; i += CONCURRENCY) {
		const batch = manifest.slice(i, i + CONCURRENCY);
		const entries = await Promise.all(batch.map(fetchEntry));
		for (const e of entries) {
			if (e) { results.push(e); ok++; } else ng++;
			done++;
		}
		if (done % PROGRESS_EVERY === 0 || done === total) {
			process.stdout.write(`\r  ${done}/${total}  ok=${ok}  ng=${ng}`);
		}
	}

	console.log(`\n完了: ok=${ok}  ng=${ng}`);

	// cityCode 順にソート（name フィールドの先頭5桁が cityCode）
	results.sort((a, b) => a.name.localeCompare(b.name));

	writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
	console.log(`→ ${OUT_FILE}  ${results.length} 件`);
}

main().catch(console.error);
