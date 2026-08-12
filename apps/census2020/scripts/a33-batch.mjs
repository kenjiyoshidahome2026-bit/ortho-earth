/**
 * 国土数値情報 A33（土砂災害警戒区域）→ bucket bousai/a33/{市区町村5桁}.geojsonl
 * gint v2 が「性能の一級市民」と定めたベンチマークデータそのもの（全国散在の小ポリゴン群）。
 *
 * 入力: nlftp.mlit.go.jp から手動DLした県別 zip（GML/SHP版）を --src のディレクトリへ。
 *   属性名は年度・県で揺れる＝ --inspect で実フィールドを確認し FIELD を確定してから本走する。
 * 割当て: 区域ポリゴンの重心を e-Stat 小地域境界（bucket/estat/2020）への点in面で市区町村に振る。
 * 出力 props: { _src:'a33', kbn:1|2（1=警戒/2=特別警戒）, gensho:現象種類, name:区域名 }
 *
 * 使い方:
 *   node a33-batch.mjs --src ~/Downloads/ksj-a33 --inspect          ← フィールド偵察のみ
 *   API_KEY=... node a33-batch.mjs --src ~/Downloads/ksj-a33 [--pref 22] [--dry-run]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import { Bucket } from 'native-bucket';
import { loadCityIndex, centroidOf, quantizeGeom, zipFeatures, pickField } from './ksj-common.mjs';

const ESTAT_MANIFEST = JSON.parse(readFileSync(new URL('../estat/manifest.json', import.meta.url)));
const API_BASE = process.env.API_BASE ?? 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const argv = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1]
	?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : null);
const SRC = argv('src'), ONLY_PREF = argv('pref');
const INSPECT = process.argv.includes('--inspect');
const DRY = process.argv.includes('--dry-run') || !API_KEY;
if (!SRC) { console.error('--src <KSJ A33 zipのディレクトリ> が必要'); process.exit(1); }

// 属性マップ（v2.0・令和4＝A33-22 静岡の --inspect で実確定 2026-08-12）
// A33_003=県コード / A33_004=区域番号 / A33_007=指定日 / A33_008=解除フラグ？（未使用）
const FIELD = {
	gensho: ['A33_001'],            // 現象の種類: 1=急傾斜地の崩壊 2=土石流 3=地滑り
	kbn:    ['A33_002'],            // 区域区分: 1=警戒区域(イエロー) 2=特別警戒区域(レッド)
	name:   ['A33_005', '区域名'],   // 区域名（白助沢 等）
	addr:   ['A33_006', '所在地'],
};
const GENSHO = { 1: '急傾斜地の崩壊', 2: '土石流', 3: '地滑り' };

const zips = readdirSync(SRC).filter(f => f.toLowerCase().endsWith('.zip'))
	.filter(f => !ONLY_PREF || f.includes(`-${ONLY_PREF}_`) || f.includes(`_${ONLY_PREF}_`) || f.includes(`_${ONLY_PREF}.`));
if (!zips.length) { console.error('zip が見つからない'); process.exit(1); }
console.log(`対象 zip: ${zips.length} 本`);

const prefOfZip = f => f.match(/_(\d{2})_(?:GML|SHP)/i)?.[1] ?? null;   // A33-22_13_GML.zip＝2つ目の2桁が県（1つ目は年度＝誤爆の轍）
const perCity = new Map();   // code → lines[]
const fieldStats = new Map();

for (const zf of zips) {
	const pref = prefOfZip(zf);
	console.log(`\n📦 ${zf}（県 ${pref ?? '不明'}）`);
	const zip = new AdmZip(join(SRC, zf));
	let cityIdx = null, n = 0, un = 0;
	for await (const { feature } of zipFeatures(zip, shapefile)) {
		const p = feature.properties ?? {};
		if (INSPECT) {   // フィールド偵察：名前と値見本を貯めるだけ
			for (const [k, v] of Object.entries(p)) {
				if (!fieldStats.has(k)) fieldStats.set(k, new Set());
				const s = fieldStats.get(k); if (s.size < 8) s.add(String(v));
			}
			continue;
		}
		if (!cityIdx) { if (!pref) break; cityIdx = await loadCityIndex(pref, ESTAT_MANIFEST); }
		const c = centroidOf(feature.geometry);
		const code = c && cityIdx.assign(c[0], c[1]);
		if (!code) { un++; continue; }
		const fGensho = pickField(p, FIELD.gensho), fKbn = pickField(p, FIELD.kbn), fName = pickField(p, FIELD.name), fAddr = pickField(p, FIELD.addr);
		const props = {
			_src: 'a33',
			kbn: +p[fKbn] === 2 ? 2 : 1,
			gensho: GENSHO[+p[fGensho]] ?? String(p[fGensho] ?? ''),
			name: String(p[fName] ?? ''),
			addr: String(p[fAddr] ?? ''),
		};
		if (!perCity.has(code)) perCity.set(code, []);
		perCity.get(code).push(JSON.stringify({ type: 'Feature', geometry: quantizeGeom(feature.geometry), properties: props }));
		n++;
	}
	if (!INSPECT) console.log(`  ${n} 区域（未割当 ${un}）`);
}

if (INSPECT) {
	console.log('\n=== フィールド偵察（FIELD 候補の確定に使う） ===');
	for (const [k, vs] of fieldStats) console.log(`  ${k}: ${[...vs].join(' / ')}`);
	process.exit(0);
}

console.log(`\n市区町村 ${perCity.size} 件へ分配`);
if (DRY) {
	mkdirSync(new URL('./out/a33/', import.meta.url), { recursive: true });
	for (const [code, lines] of [...perCity].sort()) writeFileSync(new URL(`./out/a33/${code}.geojsonl`, import.meta.url), lines.join('\n'));
	console.log('[dry-run/no API_KEY] ./out/a33/ にローカル出力');
} else {
	const bucket = await Bucket('bousai/a33', { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
	for (const [code, lines] of [...perCity].sort()) {
		await bucket.put(`${code}.geojsonl`, new File([lines.join('\n')], `${code}.geojsonl`, { type: 'application/geo+json' }));
		console.log(`  ✓ ${code}.geojsonl ${lines.length}区域`);
	}
	console.log('✅ 完了');
}
