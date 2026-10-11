/**
 * 法務省 登記所備付地図 ZIP/XML → GeoPBF バッチ変換・サーバーアップロード
 *
 * moj-manifest.json のうち moj-geojson.json に GeoJSON がない市区町村を対象に、
 * ZIP → XML 解析 → GeoPBF エンコード → native-bucket アップロード を行う。
 *
 * 使い方:
 *   node moj-xml-to-pbf.js             # 未処理の全件
 *   node moj-xml-to-pbf.js --dry-run   # ダウンロードせず対象一覧のみ表示
 *   node moj-xml-to-pbf.js --code 03305
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Bucket } from 'native-bucket';   // workspace解決（アプリ移設で相対深度が壊れた轍・exports封印にも整合）
import Pbf from "geopbf/pbf";
import AdmZip from 'adm-zip';
const __dir = dirname(fileURLToPath(import.meta.url));

const API_BASE    = 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const BUCKET_DIR  = 'moj';
const PROGRESS_FILE = join(__dir, 'pbf-progress.json');
const MIN_SIZE    = 5000; // バイト未満は空データとみなしてスキップ

// 任意座標系XMLの都道府県→系番号フォールバック（正本: jp/codes.js・1か所管理）
import { PREF_SYS } from '../jp/codes.js';
// 地図XML の読み（座標変換・筆の yield）＝moj-xml.js に 1 本（moj-batch / moj-convert と共通・2026-10-03）
import { xmlToFeatures, scanSysNum } from './moj-xml.js';

// ============================================================
// 軽量 GeoPBF エンコーダー（Polygon + 文字列プロパティのみ）
// ============================================================
const GEOPBF_TAGS = { NAME:1, KEYS:2, PRECISION:3, FARRAY:5, FEATURE:6, GEOMETRY:7, GTYPE:8, LENGTH:9, COORDS:10, VALUE:11, INDEX:12, DESCRIPTION:14, LICENSE:15, ATTRIBUTION:16 };
const STR_TYPE = 4; // DATATYPE.STRING

function encodeToPbf(features, { name, description='', license='', attribution='', precision=7 }) {
	const KEYS = ['市区町村コード','市区町村名','大字コード','大字名','丁目コード','小字コード','地番','精度区分','座標値種別'];
	const fmap = {};
	KEYS.forEach((k, i) => fmap[k] = i);
	const e = Math.pow(10, precision);

	const pbf = new Pbf();

	// Header
	pbf.writeStringField(GEOPBF_TAGS.NAME, name || '');
	if (description) pbf.writeStringField(GEOPBF_TAGS.DESCRIPTION, description);
	if (license)     pbf.writeStringField(GEOPBF_TAGS.LICENSE, license);
	if (attribution) pbf.writeStringField(GEOPBF_TAGS.ATTRIBUTION, attribution);
	pbf.writeVarintField(GEOPBF_TAGS.PRECISION, precision);
	for (const k of KEYS) pbf.writeStringField(GEOPBF_TAGS.KEYS, k);

	// Body
	pbf.writeMessage(GEOPBF_TAGS.FARRAY, () => {
		for (const feat of features) {
			pbf.writeMessage(GEOPBF_TAGS.FEATURE, () => {
				// Geometry (Polygon = type 4)
				pbf.writeMessage(GEOPBF_TAGS.GEOMETRY, () => {
					const rings = feat.geometry.coordinates.map(ring => {
						const src = [];
						let lastX = null, lastY = null;
						for (let i = 0; i < ring.length - 1; i++) { // skip closing point
							const x = Math.round(ring[i][0] * e);
							const y = Math.round(ring[i][1] * e);
							if (x !== lastX || y !== lastY) { src.push([x, y]); lastX = x; lastY = y; }
						}
						// delta encoding
						const deltas = []; let sx = 0, sy = 0;
						for (const [x, y] of src) { deltas.push(x - sx, y - sy); sx = x; sy = y; }
						return { n: src.length, deltas };
					}).filter(r => r.n >= 3);

					if (!rings.length) return;
					pbf.writeVarintField(GEOPBF_TAGS.GTYPE, 4); // Polygon
					pbf.writePackedVarint(GEOPBF_TAGS.LENGTH, rings.map(r => r.n));
					pbf.writePackedSVarint(GEOPBF_TAGS.COORDS, rings.flatMap(r => r.deltas));
				});

				// Properties
				const index = [], props = feat.properties || {};
				for (const key of KEYS) {
					const v = props[key];
					if (v != null) {
						pbf.writeMessage(GEOPBF_TAGS.VALUE, () => pbf.writeStringField(STR_TYPE, String(v)));
						index.push(fmap[key]);
					}
				}
				pbf.writePackedVarint(GEOPBF_TAGS.INDEX, index);
			});
		}
	});

	const end = pbf.pos;
	pbf.finish();
	return Buffer.from(pbf.buf.buffer.slice(0, end));
}

// ============================================================
// 1市区町村処理: ZIP → features[] → GeoPBF Buffer
// ============================================================
async function processCity(entries) {
	const prefCode = entries[0].cityCode?.slice(0, 2) || '13';
	let defaultSys = PREF_SYS[prefCode] || 9;

	// ZIP ダウンロード
	const allFeatures = [];
	for (const entry of entries) {
		const res = await fetch(entry.url, { redirect: 'follow' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		const outerZip = new AdmZip(buf);
		const innerZips = outerZip.getEntries().filter(e => e.entryName.endsWith('.zip'));

		// 座標系を先行スキャン（任意座標系対応）。XML は一度だけ読んで持つ（旧＝先行スキャンと変換で 2 度展開）
		const xmls = innerZips.map(iz => new AdmZip(iz.getData()).getEntries().find(e => e.entryName.endsWith('.xml'))).filter(Boolean).map(xe => xe.getData().toString('utf8'));
		defaultSys = scanSysNum(xmls, defaultSys);
		for (const xml of xmls) for (const feat of xmlToFeatures(xml, defaultSys)) allFeatures.push(feat);
	}

	if (!allFeatures.length) return null;

	const e0 = entries[0];
	const cityName = e0.title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || e0.cityCode;
	return encodeToPbf(allFeatures, {
		name:        e0.cityCode,
		description: cityName + ' 登記所備付地図 筆ポリゴン',
		attribution: '法務省 登記所備付地図',
		license:     'CC_BY_4.0',
		precision:   7,
	});
}

// ============================================================
// メイン
// ============================================================
async function main() {
	const args    = process.argv.slice(2);
	const dryRun  = args.includes('--dry-run');
	const codeIdx = args.indexOf('--code');
	const onlyCode = codeIdx >= 0 ? args[codeIdx + 1] : null;

	const manifest = JSON.parse(readFileSync(join(__dir, 'manifest.json'), 'utf8'));
	const geojson  = JSON.parse(readFileSync(join(__dir, 'geojson.json'),  'utf8'));
	const gjCodes  = new Set(geojson.map(e => e.name.slice(0, 5)));

	// GeoJSON のない市区町村だけを対象
	const byCity = {};
	for (const e of manifest) {
		if (gjCodes.has(e.cityCode)) continue;
		if (onlyCode && e.cityCode !== onlyCode) continue;
		if (!byCity[e.cityCode]) byCity[e.cityCode] = [];
		byCity[e.cityCode].push(e);
	}
	const cityEntries = Object.values(byCity);

	// サイズ 0 or 極小はスキップ
	const targets = cityEntries.filter(entries =>
		entries.some(e => (e.size || 0) >= MIN_SIZE)
	);
	const skipped = cityEntries.length - targets.length;

	console.log(`\n法務省 ZIP/XML → GeoPBF バッチ変換`);
	console.log(`  対象: ${targets.length} 市区町村 (スキップ ${skipped} 件 < ${MIN_SIZE}B)`);
	if (dryRun) {
		for (const entries of targets) {
			const e0 = entries[0];
			const sz = entries.reduce((s,e)=>s+(e.size||0),0);
			const name = e0.title?.replace(/（[^）]*）.*$/,'').replace(/\s*登記所備付地図.*$/,'').trim();
			console.log(`  ${e0.cityCode} ${name} ${(sz/1024/1024).toFixed(1)}MB`);
		}
		return;
	}

	const progress = existsSync(PROGRESS_FILE)
		? new Set(JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')))
		: new Set();

	const remaining = targets.filter(entries => !progress.has(entries[0].cityCode));
	console.log(`  処理済みスキップ: ${targets.length - remaining.length}  残り: ${remaining.length}`);

	const bucket = await Bucket(BUCKET_DIR, { baseUrl:`${API_BASE}/bucket/`, apiKey:API_KEY, silent:true });
	if (!bucket) { console.error('バケット接続失敗'); process.exit(1); }

	let done = 0, errors = 0;
	const t0 = Date.now();

	for (const entries of remaining) {
		const cityCode = entries[0].cityCode;
		const name = entries[0].title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || cityCode;
		try {
			const buf = await processCity(entries);
			if (buf) {
				await bucket.put(`${cityCode}.pbf`, new Blob([buf], { type: 'application/octet-stream' }));
				progress.add(cityCode);
				done++;
				const elapsed = ((Date.now()-t0)/1000).toFixed(0);
				process.stdout.write(`\r  [${done}/${remaining.length}] ${cityCode} ${name.slice(0,10).padEnd(10)} ${(buf.length/1024).toFixed(0)}KB | ${elapsed}s  `);
			} else {
				console.log(`\n  skip ${cityCode} (features=0)`);
				progress.add(cityCode);
			}
		} catch (err) {
			errors++;
			console.log(`\n  ⚠️  ${cityCode} ${err.message?.slice(0, 60)}`);
		}
		if ((done + errors) % 5 === 0) writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
	}

	writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
	console.log(`\n\n✅ 完了: ${done} 件アップロード  エラー: ${errors}`);

	genManifest(manifest, progress);
}

function genManifest(manifest, uploadedCodes) {
	const seen = new Set();
	const entries = [];
	for (const e of manifest) {
		if (!uploadedCodes.has(e.cityCode) || seen.has(e.cityCode)) continue;
		seen.add(e.cityCode);
		const name = e.title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || e.cityCode;
		entries.push({
			cityCode:    e.cityCode,
			name:        `${e.cityCode}_${name}_登記所備付地図`,
			description: `${name} 登記所備付地図 筆ポリゴン`,
			target:      `${API_BASE}/bucket/${BUCKET_DIR}/${e.cityCode}.pbf`,
			attribution: '法務省 登記所備付地図',
			license:     'CC_BY_4.0',
		});
	}
	entries.sort((a, b) => a.cityCode.localeCompare(b.cityCode));
	writeFileSync(join(__dir, 'pbf-manifest.json'), JSON.stringify(entries, null, 2));
	console.log(`→ moj-pbf-manifest.json  ${entries.length} 件`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(console.error);

export { processCity, encodeToPbf };
