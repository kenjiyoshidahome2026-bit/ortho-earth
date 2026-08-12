/**
 * 旧 bousai geojsonl 削除（サーバー最小化・裁定「サーバーは最小限のデータ」）。
 * 安全弁: **対応する .geopbf が bucket に在る geojsonl だけ**削除する（geopbf未生成の穴を作らない）。
 * dry-run 既定＝一覧のみ。実削除は --execute + API_KEY。⚠ a31/a33 の GeoPBF 変換が完了してから実行。
 *
 *   node bousai-drop-geojsonl.mjs --layer a31                 # dry-run（消す対象を数える）
 *   API_KEY=... node bousai-drop-geojsonl.mjs --layer a31 --execute
 */
import { Bucket } from 'native-bucket';
const API_BASE = process.env.API_BASE ?? 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const argv = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1]
	?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : null);
const LAYER = argv('layer');
const EXEC = process.argv.includes('--execute');
if (!['a31', 'a33'].includes(LAYER)) { console.error('--layer a31|a33 が必要'); process.exit(1); }
if (EXEC && !API_KEY) { console.error('--execute には API_KEY が必要'); process.exit(1); }

const bucket = await Bucket(`bousai/${LAYER}`, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
const items = await bucket.list();
const base = k => k.replace(/\.(geojsonl|geopbf)$/,'');
const geopbfSet = new Set(items.filter(i => i.Key?.endsWith('.geopbf')).map(i => base(i.Key)));
const victims = items.filter(i => i.Key?.endsWith('.geojsonl') && geopbfSet.has(base(i.Key)));
const orphans = items.filter(i => i.Key?.endsWith('.geojsonl') && !geopbfSet.has(base(i.Key)));

console.log(`layer=${LAYER}  bucket計 ${items.length}  geopbf ${geopbfSet.size}  geojsonl ${victims.length + orphans.length}`);
console.log(`削除対象(geopbf有りのgeojsonl): ${victims.length} 件`);
if (orphans.length) console.log(`⚠ 温存(geopbf無し=まだ変換されていない): ${orphans.length} 件 ${orphans.slice(0,8).map(i=>i.Key).join(',')}`);

if (!EXEC) { console.log('\n[dry-run] --execute + API_KEY で実削除'); process.exit(0); }
let ok = 0, ng = 0;
for (const v of victims) {
	try { (await bucket.del(v.Key)) ? ok++ : ng++; } catch { ng++; }
	if (ok % 100 === 0) console.log(`  削除 ${ok}/${victims.length}`);
}
console.log(`\n✅ ${LAYER}: 削除 ok=${ok} ng=${ng}  温存(orphan) ${orphans.length}`);
