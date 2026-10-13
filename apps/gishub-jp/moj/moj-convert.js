/**
 * 法務省 登記所備付地図データ (地図XML) → GeoJSON 変換スクリプト
 *
 * 入力: 市区町村単位の ZIP of ZIPs (G空間情報センターからDL)
 * 出力: {市区町村コード}.geojson (筆ポリゴン)
 *
 * 使い方:
 *   node moj-convert.js <zipfile> [outdir]
 *   node moj-convert.js 01694-4625-2025.zip ./out
 */
import { mkdirSync, createWriteStream, statSync } from 'fs';
import { join } from 'path';
import AdmZip from 'adm-zip';
// 都道府県→系番号フォールバック（正本: jp/codes.js・1か所管理）
import { PREF_SYS } from '../jp/codes.js';

// 地図XML の読み（座標変換・筆の yield）＝moj-xml.js に 1 本（moj-batch / moj-xml-to-pbf と共通・2026-10-03）
import { xmlToFeatures, xmlHeader, parseSysNum } from './moj-xml.js';

// 地図XML パーサー（ジェネレーター — 最初にメタ情報、続いて筆を1件ずつ yield）
// 任意座標系/系不明は都道府県の代表系にフォールバック（旧実装は無条件9系＝関東以外で数百kmズレ）
function* parseChizuXmlGen(xml) {
	const { sysTag, cityCode, cityName } = xmlHeader(xml);
	yield { _meta: true, cityCode, cityName };
	const fallback = (/任意/.test(sysTag) ? 0 : parseSysNum(sysTag)) || PREF_SYS[cityCode.slice(0, 2)] || 9;
	yield* xmlToFeatures(xml, fallback);
}

// ============================================================
// メイン
// ============================================================
async function main() {
	const [,, zipPath, outDir = '.'] = process.argv;
	if (!zipPath) { console.error('Usage: node moj-convert.js <zipfile> [outdir]'); process.exit(1); }

	mkdirSync(outDir, { recursive: true });

	const outerZip    = new AdmZip(zipPath);
	const innerZips   = outerZip.getEntries().filter(e => e.entryName.endsWith('.zip'));
	const total       = innerZips.length;

	console.log(`ZIP: ${zipPath}`);
	console.log(`内側ZIP: ${total} 件`);

	let cityCode = '', cityName = '', outPath = '', count = 0;
	let stream = null;

	for (let i = 0; i < innerZips.length; i++) {
		process.stdout.write(`\r  [${i+1}/${total}] ${innerZips[i].entryName.padEnd(36)}`);

		const innerZip = new AdmZip(innerZips[i].getData());
		const xmlEntry = innerZip.getEntries().find(e => e.entryName.endsWith('.xml'));
		if (!xmlEntry) continue;

		const xml = xmlEntry.getData().toString('utf-8');

		for (const item of parseChizuXmlGen(xml)) {
			if (item._meta) {
				// 最初の XML からメタ情報を取得してファイルをオープン
				if (!stream) {
					cityCode = item.cityCode;
					cityName = item.cityName;
					outPath  = join(outDir, `${cityCode || 'unknown'}.geojson`);
					stream   = createWriteStream(outPath, { encoding: 'utf8' });
					stream.write('{"type":"FeatureCollection","features":[\n');
				}
				continue;
			}
			if (count > 0) stream.write(',\n');
			stream.write(JSON.stringify(item));
			count++;
		}
		// XML バッファと各マップは GC 対象に
	}

	if (stream) {
		stream.write('\n]}');
		await new Promise(r => stream.end(r));
	}

	const sizeMB = (statSync(outPath).size / 1024 / 1024).toFixed(1);
	console.log(`\n\n✅ ${cityName} (${cityCode})`);
	console.log(`   筆数: ${count.toLocaleString()}`);
	console.log(`   出力: ${outPath} (${sizeMB} MB)`);
}

main().catch(console.error);
