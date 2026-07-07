/**
 * 全国 moj 市区町村の座標系タグ集計（ディスク非使用・メモリ内で完結）
 * 使い方: node scan-all-moj.mjs [--limit N] [--concurrency N]
 */
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __dir = dirname(fileURLToPath(import.meta.url));
const MOJ_DIR = process.env.MOJ_DIR_OVERRIDE || '/Users/yoshida/ortho-earth/apps/gishub-jp/moj';
const RESULTS_FILE = join(__dir, 'moj-coord-results.jsonl');

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;
const concIdx = args.indexOf('--concurrency');
const CONCURRENCY = concIdx >= 0 ? parseInt(args[concIdx + 1]) : 8;

const manifest = JSON.parse(readFileSync(join(MOJ_DIR, 'manifest.json'), 'utf8'));
const byCity = new Map();
for (const e of manifest) {
	if (!byCity.has(e.cityCode)) byCity.set(e.cityCode, []);
	byCity.get(e.cityCode).push(e);
}
let cities = [...byCity.entries()];
if (limit < Infinity) cities = cities.slice(0, limit);

// 既存結果があれば再開（cityCode 済み分をスキップ）
const done = new Set();
if (existsSync(RESULTS_FILE)) {
	for (const line of readFileSync(RESULTS_FILE, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try { done.add(JSON.parse(line).cityCode); } catch {}
	}
}
const remaining = cities.filter(([code]) => !done.has(code));
console.log(`対象: ${cities.length} 市区町村（済み ${done.size} 件をスキップ、残り ${remaining.length} 件）`);

function parseSysNum(txt) {
	if (!txt) return '?';
	if (txt.includes('任意')) return '任意';
	const m = txt.match(/(\d+)系/);
	return m ? m[1] : txt.trim() || '?';
}

async function fetchBuffer(url) {
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

async function scanCity([cityCode, entries]) {
	const e0 = entries[0];
	const cityName = e0.title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || cityCode;
	const sysCounts = {};
	let fileCount = 0, errCount = 0;

	for (const entry of entries) {
		let outerBuf;
		try { outerBuf = await fetchBuffer(entry.url); }
		catch (err) { errCount++; continue; }

		let outerZip;
		try { outerZip = new AdmZip(outerBuf); } catch { errCount++; continue; }
		const innerEntries = outerZip.getEntries().filter(x => x.entryName.toLowerCase().endsWith('.zip'));

		for (const iz of innerEntries) {
			try {
				const innerZip = new AdmZip(iz.getData());
				const xe = innerZip.getEntries().find(x => x.entryName.toLowerCase().endsWith('.xml'));
				if (!xe) { errCount++; continue; }
				const xml = xe.getData().toString('utf8');
				const m = xml.match(/<座標系>(.*?)<\/座標系>/);
				const sys = parseSysNum(m?.[1]);
				sysCounts[sys] = (sysCounts[sys] || 0) + 1;
				fileCount++;
			} catch { errCount++; }
		}
		// outerBuf/outerZip は次のループで GC 対象（ディスクには一切書かない）
	}

	return { cityCode, cityName, prefCode: cityCode.slice(0, 2), fileCount, errCount, sysCounts };
}

let completed = 0;
const total = remaining.length;

async function worker(queue) {
	while (queue.length) {
		const item = queue.shift();
		const t0 = Date.now();
		const result = await scanCity(item).catch(err => ({
			cityCode: item[0], cityName: item[0], prefCode: item[0].slice(0, 2),
			fileCount: 0, errCount: -1, sysCounts: {}, fatal: err.message,
		}));
		completed++;
		const sysStr = Object.entries(result.sysCounts).sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `${k}系:${v}`.replace('任意系', '任意')).join(' ') || '(no data)';
		const sec = ((Date.now() - t0) / 1000).toFixed(1);
		console.log(`[${completed}/${total}] ${result.cityCode} ${result.cityName}  files=${result.fileCount} err=${result.errCount}  ${sysStr}  (${sec}s)`);
		appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
	}
}

const queue = [...remaining];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
console.log(`\n完了: ${completed}/${total} 市区町村処理`);
