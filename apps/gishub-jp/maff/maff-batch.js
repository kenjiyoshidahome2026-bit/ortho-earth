/**
 * 農林水産省 筆ポリゴン 全国バッチ変換
 *
 * maff-manifest.json の各エントリを順次処理:
 *   REST API で署名付きURL取得 → ZIP展開 → GeoJSONL変換 → native-bucket upload
 *
 * 使い方:
 *   node maff-batch.js              # 全件処理
 *   node maff-batch.js --dry-run    # ダウンロードせず manifest 確認のみ
 *   node maff-batch.js --start 100  # 100番目から再開
 *   node maff-batch.js --code 012025 # 特定 prefCityCd のみ
 *
 * 出力先: native-bucket の "maff/" ディレクトリ
 *   maff/{prefCityCd}.geojsonl  (1行1筆 Feature JSON)
 *
 * 形式: API は FeatureCollection JSON を ZIP に格納して返す
 *       CloudFront は Referer + Origin ヘッダーを検証する
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';
import { Bucket } from '../../packages/native-bucket/src/Bucket.js';
const __dir = dirname(fileURLToPath(import.meta.url));

const API_BASE      = 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const BUCKET_DIR    = 'maff';
const PROGRESS_FILE = join(__dir, 'progress.json');
const FUDE_API      = 'https://restapi.fude.maff.go.jp/download/lambda-download';
const DL_HEADERS    = {
	'Referer':    'https://download.fude.maff.go.jp/',
	'Origin':     'https://download.fude.maff.go.jp',
	'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
};

const DRY_RUN = process.argv.includes('--dry-run');
const START   = parseInt(
	process.argv.find(a => a.startsWith('--start='))?.split('=')[1] ??
	(process.argv.includes('--start') ? process.argv[process.argv.indexOf('--start') + 1] : '0')
) || 0;
const ONLY = process.argv.find(a => a.startsWith('--code='))?.split('=')[1]
					?? (process.argv.includes('--code') ? process.argv[process.argv.indexOf('--code') + 1] : null);

const progress = existsSync(PROGRESS_FILE)
	? new Set(JSON.parse(readFileSync(PROGRESS_FILE)))
	: new Set();

function saveProgress() {
	writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
}

// 署名付きダウンロードURLを取得
async function getDownloadUrl(entry) {
	const body = {
		issue_year: String(entry.year),
		pref_cd:    [entry.prefCd],
		pref_name:  [entry.prefName],
		city_cd:    [entry.cityCd],
		city_name:  [entry.cityName],
	};
	const res = await fetch(FUDE_API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`API HTTP ${res.status}`);
	const d = await res.json();
	const found = d.found?.[0];
	if (!found) throw new Error(`URLなし: ${JSON.stringify(d.not_found)}`);
	return found.url;
}

// ZIP内の GeoJSON FeatureCollection → GeoJSONL 文字列
function geojsonToGeojsonl(zipBuf) {
	const zip     = new AdmZip(zipBuf);
	const entries = zip.getEntries();
	const jsonEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.json'));
	if (!jsonEntry) throw new Error('JSON not found in ZIP');

	const fc = JSON.parse(jsonEntry.getData().toString('utf8'));
	if (!fc.features?.length) throw new Error('featuresが空');

	return fc.features.map(f => JSON.stringify(f)).join('\n');
}

async function processEntry(entry, bucket) {
	if (progress.has(entry.prefCityCd)) return 'skip';

	const url = await getDownloadUrl(entry);

	const res = await fetch(url, { headers: DL_HEADERS });
	if (!res.ok) throw new Error(`DL HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());

	const geojsonl = geojsonToGeojsonl(buf);

	await bucket.put(
		`${entry.prefCityCd}.geojsonl`,
		new File([geojsonl], `${entry.prefCityCd}.geojsonl`, { type: 'application/geo+json' })
	);

	progress.add(entry.prefCityCd);
	return 'ok';
}

async function main() {
	const manifest = JSON.parse(readFileSync(join(__dir, 'manifest.json')));
	const targets  = ONLY
		? manifest.filter(e => e.prefCityCd === ONLY)
		: manifest.slice(START);

	console.log(`対象: ${targets.length} 件 / 全 ${manifest.length} 件 (${manifest[0]?.year}年度)`);
	if (DRY_RUN) { console.log('[dry-run] 処理を行いません'); return; }

	const bucket = await Bucket(BUCKET_DIR, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });

	let ok = 0, skip = 0, err = 0;

	for (let i = 0; i < targets.length; i++) {
		const entry = targets[i];
		const label = `[${i + 1 + START}/${manifest.length}] ${entry.prefCityCd} ${entry.prefName} ${entry.cityName}`;
		try {
			const result = await processEntry(entry, bucket);
			if (result === 'skip') {
				skip++;
				process.stdout.write(`\r  ⏭ ${label}    `);
			} else {
				ok++;
				process.stdout.write(`\r  ✓ ${label}    `);
			}
			if ((ok + err) % 20 === 0) saveProgress();
		} catch (e) {
			err++;
			console.error(`\n  ✗ ${label}: ${e.message}`);
		}
	}

	saveProgress();
	console.log(`\n\n✅ 完了: ok=${ok} skip=${skip} err=${err}`);
}

main().catch(console.error);
