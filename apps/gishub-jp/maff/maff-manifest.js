/**
 * 農林水産省 筆ポリゴン公開サイト REST API から全市区町村リストを取得
 * 出力: maff-manifest.json
 *   [{prefCd, prefName, cityCd, cityName, prefCityCd}]
 *
 * 使い方:
 *   node maff-manifest.js          # 最新年度 (デフォルト)
 *   node maff-manifest.js --year 2026
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));

const API = 'https://restapi.fude.maff.go.jp';
const YEAR = process.argv.find(a => a.startsWith('--year='))?.split('=')[1]
					?? (process.argv.includes('--year') ? process.argv[process.argv.indexOf('--year') + 1] : null);

async function getYears() {
	const res = await fetch(`${API}/getprefcitycd/lambda-getprefcitycd?issue_year=0`);
	const d   = await res.json();
	return d[0].map(y => y.issue_year);
}

async function getPrefs(year) {
	const res = await fetch(`${API}/getprefcitycd/lambda-getprefcitycd?issue_year=${year}`);
	const d   = await res.json();
	return d[0]; // [{pref_cd, pref_name}]
}

async function getCities(year, prefCd) {
	const res = await fetch(`${API}/getprefcitycd/lambda-getprefcitycd?issue_year=${year}&pref_cd=${prefCd}`);
	const d   = await res.json();
	return d[0]; // [{city_cd, city_name}]
}

async function main() {
	const years = await getYears();
	const year  = YEAR ? parseInt(YEAR) : years[0];
	console.log(`利用可能な年度: ${years.join(', ')}`);
	console.log(`対象年度: ${year}`);

	const prefs = await getPrefs(year);
	console.log(`都道府県数: ${prefs.length}`);

	const manifest = [];

	for (let i = 0; i < prefs.length; i++) {
		const { pref_cd, pref_name } = prefs[i];
		process.stdout.write(`\r  取得中: ${i + 1}/${prefs.length} ${pref_name}    `);

		const cities = await getCities(year, pref_cd);
		for (const { city_cd, city_name } of cities) {
			manifest.push({
				year,
				prefCd:     pref_cd,
				prefName:   pref_name,
				cityCd:     city_cd,
				cityName:   city_name,
				prefCityCd: pref_cd + city_cd,   // 6桁: "012025"
			});
		}
	}

	console.log(`\n市区町村数: ${manifest.length}`);

	manifest.sort((a, b) => a.prefCityCd.localeCompare(b.prefCityCd));
	writeFileSync(join(__dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

	console.log(`✅ 出力: maff-manifest.json (${manifest.length} 件, ${year}年度)`);
}

main().catch(console.error);
