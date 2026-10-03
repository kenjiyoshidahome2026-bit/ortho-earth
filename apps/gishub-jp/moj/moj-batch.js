/**
 * 法務省 登記所備付地図 全国バッチ変換
 *
 * moj-manifest.json の各エントリを順次処理:
 *   G空間 → fetch (redirect自動追従) → ZIP展開 → XML変換 → GeoJSONL → native-bucket upload
 *
 * 使い方:
 *   node moj-batch.js              # 全件処理
 *   node moj-batch.js --dry-run    # ダウンロードせず manifest の確認のみ
 *   node moj-batch.js --start 100  # 100番目から再開
 *   node moj-batch.js --code 01694 # 特定市区町村コードのみ
 *
 * 出力先: native-bucket の "moj/" ディレクトリ
 *   moj/{cityCode}.geojsonl  (1行1筆 Feature JSON)
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Bucket } from 'native-bucket';   // workspace解決（アプリ移設で相対深度が壊れた轍・exports封印にも整合）
import AdmZip from 'adm-zip';
// 全XMLが任意座標系の場合の都道府県→系番号フォールバック（正本: jp/codes.js・1か所管理）
import { PREF_SYS } from '../jp/codes.js';
// 地図XML の読み（座標変換・筆の yield）＝moj-xml.js に 1 本（moj-xml-to-pbf / moj-convert と共通・2026-10-03）
import { xmlToFeatures, scanSysNum } from './moj-xml.js';
const __dir = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 設定
// ============================================================
const API_BASE   = 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const BUCKET_DIR = 'moj';
const PROGRESS_FILE = join(__dir, 'progress.json');

// ============================================================
// 1エントリ処理: fetch → convert → GeoJSONL Buffer を返す
// ============================================================
async function processEntry(entry) {
	// fetch (redirect自動追従)
	const res = await fetch(entry.url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${entry.url}`);
	const outerBuf = Buffer.from(await res.arrayBuffer());

	const outerZip  = new AdmZip(outerBuf);
	const innerZips = outerZip.getEntries().filter(e => e.entryName.endsWith('.zip'));

	// 先行スキャン: 番号付き公共座標系を探す (任意座標系のフォールバック用)。XML は一度だけ読んで持つ（旧＝先行スキャンと変換で 2 度展開）
	const prefCode = entry.cityCode?.slice(0, 2) || '13';
	const xmls = innerZips.map(iz => new AdmZip(iz.getData()).getEntries().find(e => e.entryName.endsWith('.xml'))).filter(Boolean).map(xe => xe.getData().toString('utf8'));
	const knownSysNum = scanSysNum(xmls, PREF_SYS[prefCode] || 9);

	const lines = [];
	for (const xml of xmls) {
		for (const feat of xmlToFeatures(xml, knownSysNum)) {
			lines.push(JSON.stringify(feat));
		}
	}
	return lines.join('\n');
}

// ============================================================
// メイン
// ============================================================
async function main() {
	const args     = process.argv.slice(2);
	const dryRun   = args.includes('--dry-run');
	const startIdx = args.indexOf('--start');
	const startAt  = startIdx >= 0 ? (parseInt(args[startIdx + 1]) || 0) : 0;
	const codeIdx  = args.indexOf('--code');
	const onlyCode = codeIdx >= 0 ? args[codeIdx + 1] : null;

	const manifest = JSON.parse(readFileSync(join(__dir, 'manifest.json'), 'utf8'));

	// 進捗ファイル (処理済みキーのセット)
	const progress = existsSync(PROGRESS_FILE)
		? new Set(JSON.parse(readFileSync(PROGRESS_FILE,'utf8')))
		: new Set();

	// 処理対象を絞り込み
	let targets = manifest;
	if (onlyCode) targets = targets.filter(e => e.cityCode === onlyCode);
	targets = targets.filter((e, i) => i >= startAt && !progress.has(e.resourceId));

	console.log(`\n法務省 登記所備付地図 全国バッチ変換`);
	console.log(`  対象エントリ: ${targets.length} / ${manifest.length}`);
	console.log(`  処理済みスキップ: ${progress.size}`);
	if (dryRun) { console.log('  [DRY RUN] 処理せず終了'); return; }

	// バケット接続
	const bucket = await Bucket(BUCKET_DIR, { baseUrl:`${API_BASE}/bucket/`, apiKey:API_KEY, silent:true });
	if (!bucket) { console.error('バケット接続失敗'); process.exit(1); }

	let done=0, errors=0;
	const t0=Date.now();

	// 市区町村コードごとにグループ化（複数ゾーンは追記マージ）
	const byCity = {};
	for (const e of targets) {
		if (!byCity[e.cityCode]) byCity[e.cityCode] = [];
		byCity[e.cityCode].push(e);
	}
	const cityEntries = Object.values(byCity);

	for (const entries of cityEntries) {
		const cityCode = entries[0].cityCode;
		const cityName = entries[0].title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || cityCode;

		try {
			// 複数ゾーンは全部処理してから1ファイルにマージ (途中失敗は全体リトライ)
			const allLines = [];
			for (const entry of entries) {
				allLines.push(await processEntry(entry));
			}

			const content = allLines.filter(Boolean).join('\n');
			if (content) {
				const blob = new Blob([content], { type: 'application/geo+json-seq' });
				await bucket.put(`${cityCode}.geojsonl`, blob);
			}

			// アップロード成功後に進捗マーク
			for (const entry of entries) progress.add(entry.resourceId);
			done++;
			const elapsed = ((Date.now()-t0)/1000).toFixed(0);
			const remain  = done < cityEntries.length ? Math.round((Date.now()-t0)/done*(cityEntries.length-done)/1000) : 0;
			process.stdout.write(`\r  [${done}/${cityEntries.length}] ${cityCode} ${cityName.slice(0,10).padEnd(10)} | 経過:${elapsed}s 残:${remain}s  `);

		} catch (e) {
			errors++;
			process.stdout.write(`\n  ⚠️  ${cityCode} ${e.message.slice(0,60)}\n`);
		}

		// 10件ごとに進捗保存
		if (done % 10 === 0) writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
	}

	writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
	console.log(`\n\n✅ 完了: ${done}/${cityEntries.length} (エラー: ${errors})`);
	console.log(`   所要時間: ${((Date.now()-t0)/1000/60).toFixed(1)} 分`);
}

main().catch(console.error);
