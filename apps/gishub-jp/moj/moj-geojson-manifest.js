/**
 * 法務省14条地図 GeoJSON マニフェスト生成
 *
 * G空間の aigid-moj-{cityCode} パッケージから最新年の GeoJSON URL を取得し、
 * catalog.json 形式のエントリ一覧を geojson.json に出力する。
 *
 * package_search のページネーションで一括取得（約21リクエスト）。
 * 旧実装の package_show × 2062市区町村は、約1400リクエストで CKAN の
 * WAF に 403 ブロックされ、それが catch { return null } で「無い」に
 * 化けて偽の欠落を量産した（2026-08-27 実測）。
 *
 * 使い方: node moj-geojson-manifest.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));

const CKAN     = 'https://www.geospatial.jp/ckan/api/3/action';
const PAGE     = 100;      // 1リクエストあたりの取得件数
const PAGE_WAIT = 500;     // ページ間ウェイト(ms) — WAF様子見
const OUT_FILE = join(__dir, 'geojson.json');

// manifest は「XML の存在する市区町村」の正本（複数ZONE持ちは複数エントリ）
const manifest    = JSON.parse(readFileSync(join(__dir, 'manifest.json'), 'utf8'));
const cityTitles  = new Map(manifest.map(e => [e.cityCode, e.title]));
console.log(`manifest: ${cityTitles.size} 市区町村 (${manifest.length} エントリ)`);

// 最新年の GeoJSON リソースを選ぶ（任意座標系は原点不明＝変換不能なので除外）
function pickGeoJSON(resources) {
	const geojsons = resources
		.filter(r => r.format === 'GeoJSON' && !r.name.includes('任意'))
		.sort((a, b) => {
			const ya = parseInt(a.name.match(/(\d{4})\.geojson/i)?.[1] || 0);
			const yb = parseInt(b.name.match(/(\d{4})\.geojson/i)?.[1] || 0);
			return yb - ya; // 降順（最新優先）
		});
	return geojsons[0] || null;
}

// 1ページ取得（403/429 等は指数バックオフで最大5回リトライ→駄目なら throw）
async function fetchPage(start) {
	// name:aigid-moj-* はハイフンのトークン化でヒットせず0件＝組織で絞る
	const url = `${CKAN}/package_search?fq=organization:aigid-moj-map&rows=${PAGE}&start=${start}`;
	for (let i = 0; ; i++) {
		const res = await fetch(url).catch(() => null);
		if (res?.ok) {
			const data = await res.json();
			if (data.success) return data.result;
		}
		if (i >= 5) throw new Error(`HTTP ${res?.status ?? 'network'} at start=${start}`);
		await new Promise(r => setTimeout(r, 2000 * 2 ** i));
	}
}

function toEntry(pkg) {
	const m = pkg.name.match(/^aigid-moj-(\d{5})$/);
	if (!m) return null;                       // aigid-moj-* でも市区町村パッケージ以外は除外
	const cityCode = m[1];
	const r = pickGeoJSON(pkg.resources);
	if (!r) return null;

	const title = cityTitles.get(cityCode) || pkg.title || '';
	const year  = r.name.match(/(\d{4})\.geojson/i)?.[1] || '?';

	return {
		name:        r.name.replace(/\.geojson$/i, ''),
		description: `${year} ${title.replace(/（.*?）/g, '').replace('登記所備付地図データ', '').trim()} 筆ポリゴン`,
		target:      r.url,
		link:        `https://www.geospatial.jp/ckan/dataset/${pkg.name}`,
		attribution: '法務省 登記所備付地図',
		license:     'CC_BY_4.0',
		precision:   7,
	};
}

async function main() {
	// 総件数を取得してページネーション
	const first = await fetchPage(0);
	const total = first.count;
	console.log(`aigid-moj パッケージ: ${total} 件`);

	const packages = [...first.results];
	while (packages.length < total) {
		await new Promise(r => setTimeout(r, PAGE_WAIT));
		process.stdout.write(`\r  取得中: ${packages.length}/${total}`);
		const page = await fetchPage(packages.length);
		if (!page.results.length) break;
		packages.push(...page.results);
	}
	console.log(`\r  取得完了: ${packages.length} パッケージ`);
	if (packages.length < total) throw new Error(`取得不足: ${packages.length}/${total}`);

	// cityCode でユニーク化しつつエントリ化
	const byCity = new Map();
	for (const pkg of packages) {
		const e = toEntry(pkg);
		if (!e) continue;
		byCity.set(e.name.slice(0, 5), e);
	}
	const results = [...byCity.values()].sort((a, b) => a.name.localeCompare(b.name));

	// manifest（XML あり）のうち aigid GeoJSON が無い市区町村＝XML フォールバック対象
	const absent = [...cityTitles.keys()].filter(c => !byCity.has(c));
	console.log(`GeoJSON あり: ${results.length} 市区町村 / aigidに無し: ${absent.length} 市区町村`);

	writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
	console.log(`→ ${OUT_FILE}  ${results.length} 件`);
}

main().catch(e => { console.error(e); process.exit(1); });
