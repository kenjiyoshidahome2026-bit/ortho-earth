/**
 * e-Stat 統計GIS 国勢調査 小地域（町丁・字等）境界データ マニフェスト生成
 * 出力: manifest.json（2020）/ manifest-{year}.json（それ以外）
 *   [{code, prefCode, name, date}]
 *   code: 5桁市区町村コード (例: "01101")
 *   ダウンロードURLは固定パターンなので manifest には含めない
 *
 * 使い方: node estat-manifest.js [--year 2015]   # 調査年（2000/2005/2010/2015/2020…）
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));

const YEAR = process.argv.find(a => a.startsWith('--year='))?.split('=')[1]
					?? (process.argv.includes('--year') ? process.argv[process.argv.indexOf('--year') + 1] : '2020');
if (!/^\d{4}$/.test(YEAR)) { console.error(`--year が不正: ${YEAR}`); process.exit(1); }

const SEARCH_URL  = 'https://www.e-stat.go.jp/gis/statmap-search/search_detail';
const SURVEY_ID   = `A00200521${YEAR}`;
const PREF_CODES  = Array.from({length: 47}, (_, i) => String(i + 1).padStart(2, '0'));

const BASE_PARAMS = {
	page: '1', type: '2',
	aggregateUnitForBoundary: 'A',
	toukeiCode: '00200521', toukeiYear: YEAR,
	serveyId: SURVEY_ID,
	coordsys: '1', format: 'shape', datum: '2011',
	download_disp_flg: '1',
};

function parseDetail(html, prefCode) {
	const items = [];
	const blockRe = /<article[^>]*>[\s\S]*?<\/article>/g;
	let block;
	while ((block = blockRe.exec(html)) !== null) {
		const codeMatch = block[0].match(/<li[^>]*>(\d{2,5})\s+([^<]+)<\/li>/);
		const dateMatch = block[0].match(/<li[^>]*>(\d{4}-\d{2}-\d{2})<\/li>/);
		if (!codeMatch) continue;
		items.push({
			code:     codeMatch[1].padStart(5, '0'),
			name:     codeMatch[2].trim(),
			prefCode,
			date:     dateMatch?.[1] ?? '',
		});
	}
	return items;
}

async function fetchPage(prefCode, page) {
	const params = new URLSearchParams({ ...BASE_PARAMS, prefCode, page: String(page) });
	const res = await fetch(`${SEARCH_URL}?${params}`, {
		headers: {
			'User-Agent': 'Mozilla/5.0',
			'Accept': 'application/json',
			'Referer': 'https://www.e-stat.go.jp/gis/statmap-search?type=2',
		},
	});
	const d = await res.json();
	const total = parseInt(d.side_mega.match(/js-total_resource">(\d+)/)?.[1] ?? '0');
	const lastPage = parseInt(d.paginate.match(/data-page="(\d+)"[^>]*>&gt;&gt;<\/span>/)?.[ 1] ?? '1');
	return { items: parseDetail(d.detail, prefCode), total, lastPage };
}

async function fetchCityList(prefCode) {
	const first = await fetchPage(prefCode, 1);
	const items = [...first.items];
	for (let p = 2; p <= first.lastPage; p++) {
		const page = await fetchPage(prefCode, p);
		items.push(...page.items);
	}
	return items;
}

async function main() {
	const manifest = [];

	for (let i = 0; i < PREF_CODES.length; i++) {
		const prefCode = PREF_CODES[i];
		process.stdout.write(`\r  取得中: ${i + 1}/47 (${prefCode})    `);
		const cities = await fetchCityList(prefCode);
		manifest.push(...cities);
	}

	console.log(`\n取得件数: ${manifest.length}`);

	// 全域（code が 2桁 = 都道府県全域）と市区町村を分ける
	const pref   = manifest.filter(e => e.code.length <= 2 || e.name.includes('全域'));
	const cities = manifest.filter(e => !e.name.includes('全域'));
	console.log(`  都道府県全域: ${pref.length}`);
	console.log(`  市区町村:     ${cities.length}`);

	manifest.sort((a, b) => a.code.localeCompare(b.code));
	// 2020 は census/ui.js が ../estat/manifest.json を import している既存契約を維持
	const outName = YEAR === '2020' ? 'manifest.json' : `manifest-${YEAR}.json`;
	writeFileSync(join(__dir, outName), JSON.stringify(manifest, null, 2));
	console.log(`✅ 出力: ${outName} (${manifest.length} 件)`);
}

main().catch(console.error);
