/**
 * e-Stat 国勢調査2020 小地域境界データ バッチ変換
 * SHP → GeoJSONL → native-bucket upload
 *
 * 使い方:
 *   node estat-batch.js              # 全件処理
 *   node estat-batch.js --code 01101 # 特定コードのみ
 *   node estat-batch.js --pref 01    # 特定都道府県のみ
 *   node estat-batch.js --start 100  # N番目から再開
 *   node estat-batch.js --dry-run    # 確認のみ
 *
 * 出力: native-bucket "estat/" ディレクトリ
 *   estat/{code}.geojsonl  (1行1小地域 Feature JSON)
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import { Bucket } from 'native-bucket';   // workspace解決（アプリ移設で相対深度が壊れた轍・exports封印にも整合）
const __dir = dirname(fileURLToPath(import.meta.url));

const API_BASE      = 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const BUCKET_DIR    = 'estat';
const PROGRESS_FILE = join(__dir, 'progress.json');
const SURVEY_ID     = 'A002005212020';

const DL_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';
function dlUrl(code) {
	return `${DL_BASE}?dlserveyId=${SURVEY_ID}&code=${code}&coordSys=1&format=shape&downloadType=5&datum=2011`;
}

const DRY_RUN = process.argv.includes('--dry-run');
const START   = parseInt(
	process.argv.find(a => a.startsWith('--start='))?.split('=')[1] ??
	(process.argv.includes('--start') ? process.argv[process.argv.indexOf('--start') + 1] : '0')
) || 0;
const ONLY_CODE = process.argv.find(a => a.startsWith('--code='))?.split('=')[1]
							 ?? (process.argv.includes('--code') ? process.argv[process.argv.indexOf('--code') + 1] : null);
const ONLY_PREF = process.argv.find(a => a.startsWith('--pref='))?.split('=')[1]
							 ?? (process.argv.includes('--pref') ? process.argv[process.argv.indexOf('--pref') + 1] : null);

const progress = existsSync(PROGRESS_FILE)
	? new Set(JSON.parse(readFileSync(PROGRESS_FILE)))
	: new Set();

function saveProgress() {
	writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
}

async function processEntry(entry, bucket) {
	if (progress.has(entry.code)) return 'skip';

	const res = await fetch(dlUrl(entry.code), {
		headers: {
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
			'Referer':    'https://www.e-stat.go.jp/gis/statmap-search?type=2',
		},
	});
	if (!res.ok) throw new Error(`DL HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());

	const zip      = new AdmZip(buf);
	const entries  = zip.getEntries();
	const shpEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.shp'));
	const dbfEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.dbf'));
	if (!shpEntry || !dbfEntry) throw new Error('SHP/DBF not found');

	const source   = await shapefile.open(shpEntry.getData().buffer, dbfEntry.getData().buffer, { encoding: 'shift_jis' });
	const lines    = [];
	let result     = await source.read();
	while (!result.done) {
		if (result.value?.geometry) lines.push(JSON.stringify(result.value));
		result = await source.read();
	}
	if (!lines.length) throw new Error('変換結果が空');
	const geojsonl = lines.join('\n');

	await bucket.put(
		`${entry.code}.geojsonl`,
		new File([geojsonl], `${entry.code}.geojsonl`, { type: 'application/geo+json' })
	);

	progress.add(entry.code);
	return 'ok';
}

async function main() {
	const manifest = JSON.parse(readFileSync(join(__dir, 'manifest.json')));
	let targets = manifest;
	if (ONLY_CODE) targets = targets.filter(e => e.code === ONLY_CODE);
	else if (ONLY_PREF) targets = targets.filter(e => e.prefCode === ONLY_PREF);
	else targets = targets.slice(START);

	console.log(`対象: ${targets.length} 件 / 全 ${manifest.length} 件`);
	if (DRY_RUN) { console.log('[dry-run]'); return; }

	const bucket = await Bucket(BUCKET_DIR, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });

	let ok = 0, skip = 0, err = 0;

	for (let i = 0; i < targets.length; i++) {
		const entry = targets[i];
		const n     = ONLY_CODE || ONLY_PREF ? i + 1 : i + 1 + START;
		const label = `[${n}/${manifest.length}] ${entry.code} ${entry.name}`;
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
