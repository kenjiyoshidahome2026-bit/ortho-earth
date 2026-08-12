/**
 * 指定緊急避難場所（国土地理院）→ bucket bousai/hinan/{都道府県2桁}.json
 *
 * 入力: G空間情報センター（geospatial.jp CKAN・dataset "hinanbasho"・CC BY）の全国一括 GeoJSON。
 *   https://www.geospatial.jp/ckan/dataset/hinanbasho の all.geojson（実測 41MB・115,447件・2026-06確認）。
 *   属性: 指定緊急避難場所(名称)・所在地・災害種別8列（値は "◎" 等の印）。市町村コード列は無い＝
 *   都道府県は所在地の先頭（北海道/東京都/京都府/大阪府/××県）から解決（実測 47県・不明0件）。
 * 出力: 1都道府県 = 1 JSON。1点 = [lon, lat, 名称, 住所, flags8bit]
 *   flags ビット順（bousai.js の HINAN_FLAGS と対）: 洪水/崖崩れ土石流地滑り/高潮/地震/津波/大火事/内水氾濫/火山現象
 *
 * 使い方:
 *   node hinan-batch.mjs --src ~/Downloads/all.geojson [--dry-run]
 *   API_KEY=... node hinan-batch.mjs --src ...   ← bucket へ put（無指定は ./out へローカル出力）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { Bucket } from 'native-bucket';

const API_BASE = process.env.API_BASE ?? 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const argv = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
	?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : null);
const SRC = argv('src');
const DRY = process.argv.includes('--dry-run') || !API_KEY;
if (!SRC) { console.error('--src <all.geojson のパス or URL> が必要'); process.exit(1); }

// 都道府県名 → 2桁コード（正本 jp/codes.js の PREFS は「北海道/東京/大阪…」の短名＝住所接頭辞と揺れるため
// ここは住所接頭辞の正式名で自前対応。順序は JIS コード順）
const PREF_CODES = Object.fromEntries([
	'北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
	'埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
	'岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
	'鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
	'佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
].map((n, i) => [n, String(i + 1).padStart(2, '0')]));

// GeoJSON 属性の災害種別列（bousai.js HINAN_FLAGS のビット順に対応）
const FLAG_KEYS = ['洪水', 'がけ崩れ、土石流及び地滑り', '高潮', '地震', '津波', '大規模な火事', '内水氾濫', '火山現象'];
const mark = v => { const s = String(v ?? '').trim(); return s && s !== '×' && s !== '－' && s !== '0'; };

const raw = SRC.startsWith('http')
	? Buffer.from(await (await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0' } })).arrayBuffer())
	: readFileSync(SRC);
const fc = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
if (!fc?.features?.length) { console.error('GeoJSON が空'); process.exit(1); }

const byPref = new Map();
let bad = 0;
for (const f of fc.features) {
	const c = f.geometry?.coordinates;
	const p = f.properties ?? {};
	const lon = +c?.[0], lat = +c?.[1];
	if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < 122 || lon > 154 || lat < 20 || lat > 46) { bad++; continue; }
	const addr = String(p['所在地'] ?? '').trim();
	const pm = addr.match(/^(北海道|東京都|京都府|大阪府|.{2,3}県)/);
	const pref = pm ? PREF_CODES[pm[0]] : null;
	if (!pref) { bad++; continue; }
	let flags = 0;
	FLAG_KEYS.forEach((k, bit) => { if (mark(p[k])) flags |= 1 << bit; });
	if (!byPref.has(pref)) byPref.set(pref, []);
	byPref.get(pref).push([+lon.toFixed(6), +lat.toFixed(6), String(p['指定緊急避難場所'] ?? '').trim(), addr, flags]);
}
console.log(`地物 ${fc.features.length} → 有効 ${[...byPref.values()].reduce((s, a) => s + a.length, 0)}（除外 ${bad}）・${byPref.size} 都道府県`);

if (DRY) {
	mkdirSync(new URL('./out/hinan/', import.meta.url), { recursive: true });
	for (const [pref, list] of [...byPref].sort()) writeFileSync(new URL(`./out/hinan/${pref}.json`, import.meta.url), JSON.stringify(list));
	console.log('[dry-run/no API_KEY] ./out/hinan/ にローカル出力（bucket へは API_KEY=... で再実行）');
} else {
	const bucket = await Bucket('bousai/hinan', { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
	for (const [pref, list] of [...byPref].sort()) {
		await bucket.put(`${pref}.json`, new File([JSON.stringify(list)], `${pref}.json`, { type: 'application/json' }));
		console.log(`  ✓ ${pref}.json ${list.length}件`);
	}
	console.log('✅ 完了');
}
