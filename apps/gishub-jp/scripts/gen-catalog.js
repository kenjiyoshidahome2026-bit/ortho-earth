/**
 * MAFF / e-stat → gishub カタログ JSON 生成
 *
 * 出力:
 *   apps/gishub/maff-catalog.json   (1892件)
 *   apps/gishub/estat-catalog.json  (1943件)
 *
 * 使い方: node gen-catalog.js
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));

const MAFF_DONE_FILE  = join(__dir, '../maff/geopbf-progress.json');
const ESTAT_DONE_FILE = join(__dir, '../estat/progress.json');
const DL_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';
const SURVEY_ID = 'A002005212020';

function estatUrl(code) {
	return `${DL_BASE}?dlserveyId=${SURVEY_ID}&code=${code}&coordSys=1&format=shape&downloadType=5&datum=2011`;
}

// ── MAFF カタログ ──────────────────────────────────────────────────────────
const maffManifest = JSON.parse(readFileSync(join(__dir, '../maff/manifest.json')));
const maffDone     = existsSync(MAFF_DONE_FILE)
	? new Set(JSON.parse(readFileSync(MAFF_DONE_FILE)))
	: new Set();

const maffCatalog = maffManifest
	.filter(e => maffDone.has(e.prefCityCd))
	.map(e => ({
		name:        `maff_${e.prefCityCd}`,
		description: `筆ポリゴン ${e.prefName} ${e.cityName} ${e.year}年度`,
		target:      `maff_${e.prefCityCd}.geopbf`,   // server.load() 経由
		attribution: `農林水産省 筆ポリゴン > ${e.prefName}`,
		license:     'CC BY 4.0',
		precision:   7,
	}));

writeFileSync('../gishub/maff-catalog.json', JSON.stringify(maffCatalog, null, 2));
console.log(`✅ maff-catalog.json: ${maffCatalog.length} 件`);

// ── e-stat カタログ ────────────────────────────────────────────────────────
let estatManifest = [];
const ESTAT_MANIFEST_PATHS = [join(__dir, '../estat/manifest.json')];
for (const p of ESTAT_MANIFEST_PATHS) {
	if (existsSync(p)) { estatManifest = JSON.parse(readFileSync(p)); break; }
}
if (!estatManifest.length) console.warn('estat-manifest.json が見つかりません');

const PREF_NAME = {
	'01':'北海道','02':'青森県','03':'岩手県','04':'宮城県','05':'秋田県',
	'06':'山形県','07':'福島県','08':'茨城県','09':'栃木県','10':'群馬県',
	'11':'埼玉県','12':'千葉県','13':'東京都','14':'神奈川県','15':'新潟県',
	'16':'富山県','17':'石川県','18':'福井県','19':'山梨県','20':'長野県',
	'21':'岐阜県','22':'静岡県','23':'愛知県','24':'三重県','25':'滋賀県',
	'26':'京都府','27':'大阪府','28':'兵庫県','29':'奈良県','30':'和歌山県',
	'31':'鳥取県','32':'島根県','33':'岡山県','34':'広島県','35':'山口県',
	'36':'徳島県','37':'香川県','38':'愛媛県','39':'高知県','40':'福岡県',
	'41':'佐賀県','42':'長崎県','43':'熊本県','44':'大分県','45':'宮崎県',
	'46':'鹿児島県','47':'沖縄県',
};

// 全域コード (01000等) は空ZIPのため除外
const estatCatalog = estatManifest.filter(e => !e.code.endsWith('000')).map(e => {
	const pref = PREF_NAME[e.prefCode] ?? e.prefCode;
	return {
		name:        `estat_${e.code}`,
		description: `国勢調査2020 小地域 ${e.name}`,
		target:      estatUrl(e.code),              // ブラウザから直接 e-stat へ
		attribution: `総務省 国勢調査2020 > ${pref}`,
		license:     '政府標準利用規約 2.0',
		precision:   7,
	};
});

writeFileSync('../gishub/estat-catalog.json', JSON.stringify(estatCatalog, null, 2));
console.log(`✅ estat-catalog.json: ${estatCatalog.length} 件`);
