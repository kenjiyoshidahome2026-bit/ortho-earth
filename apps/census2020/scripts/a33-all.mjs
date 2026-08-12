/**
 * A33（土砂災害警戒区域）全国焼きドライバ：47都道府県 × [DL → a33-batch（市区町村分割・bucket直上げ）→ zip削除]。
 * 年度は新しい順に probe（A33-25..20）＝県ごとに最新の公開年度を拾う。進捗は a33-all-progress.json（再開可）。
 *
 * 使い方: API_KEY=... node a33-all.mjs [--pref 22]（--pref＝単県やり直し）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.API_KEY;
if (!API_KEY) { console.error('API_KEY が必要（bucket 直上げドライバ）'); process.exit(1); }
const ONLY = process.argv.find(a => a.startsWith('--pref'))?.split('=')[1]
	?? (process.argv.includes('--pref') ? process.argv[process.argv.indexOf('--pref') + 1] : null);

const PROG = join(__dir, 'a33-all-progress.json');
const done = new Set(existsSync(PROG) ? JSON.parse(readFileSync(PROG)) : []);
const YEARS = ['25', '24', '23', '22', '21', '20'];   // 新しい順＝県ごとの最新公開年度を拾う
const TMP = join(__dir, 'tmp-a33');

const prefs = ONLY ? [ONLY] : Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, '0'));
for (const pref of prefs) {
	if (!ONLY && done.has(pref)) { console.log(`⏭ ${pref}（済）`); continue; }
	// 年度降順で「Shape 同梱の」最新を探す（A33-25=令和7 は GML 単体＝shapefile パイプラインでは0件の轍。
	// GML デコーダを積むまでは Shape 同梱年度へフォールバック＝現状 22/21 が実質最新）。
	rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
	let zipPath = null, year = null;
	for (const y of YEARS) {
		const u = `https://nlftp.mlit.go.jp/ksj/gml/data/A33/A33-${y}/A33-${y}_${pref}_GML.zip`;
		try {
			const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
			if (!r.ok) continue;
			const zp = join(TMP, u.split('/').pop());
			writeFileSync(zp, Buffer.from(await r.arrayBuffer()));
			const hasShp = new AdmZip(zp).getEntries().some(e => e.entryName.toLowerCase().endsWith('.shp'));
			if (hasShp) { zipPath = zp; year = y; break; }
			rmSync(zp); console.log(`  A33-${y}: Shape 無し（GML単体）＝次の年度へ`);
		} catch { /* 次の年度へ */ }
	}
	if (!zipPath) { console.warn(`⚠ ${pref}: Shape 同梱の年度が見つからない＝スキップ`); continue; }
	console.log(`\n===== 県 ${pref}（A33-${year}）=====`);
	try {
		execFileSync('node', [join(__dir, 'a33-batch.mjs'), '--src', TMP], { stdio: 'inherit', env: { ...process.env, API_KEY } });
		done.add(pref);
		writeFileSync(PROG, JSON.stringify([...done].sort()));
	} catch (e) {
		console.error(`✗ ${pref}: 変換/上げ失敗＝進捗に積まない（再走で再試行）`, e.message);
	}
}
rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ A33 全国: ${done.size}/47 県`);
