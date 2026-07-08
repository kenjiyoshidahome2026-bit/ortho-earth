// PLATEAU 全国 LOD2 建築物モデル カタログを生成する。
// datacatalog API から bldg/lod2/3D Tiles を市区町村ごとに1件へ重複排除し（texture無し版＝我々の loader はテクスチャ未使用なので半分軽い）、
// 各 tileset.json の root.boundingVolume.region から自動ロード用 bbox(deg) を取って
// apps/ortho-japan-poc/public/plateau-sets.json に書き出す。
//
// 使い方: node scripts/plateau-catalog-build.mjs

import { writeFileSync } from 'fs';

const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const OUT = 'apps/ortho-japan-poc/public/plateau-sets.json';
const CONCURRENCY = 16;

console.log('カタログ取得中...', CATALOG_URL);
const catalog = await (await fetch(CATALOG_URL)).json();
const all = catalog.latest_datasets; // "-latest" 安定URL＝reearth側の再アップロードでハッシュが変わっても腐らない

const bldgLod2 = all.filter(d => d.type_en === 'bldg' && String(d.lod) === '2' && d.format === '3D Tiles');
console.log(`bldg/lod2/3D Tiles: ${bldgLod2.length} 件`);

// 市区町村(ward優先)ごとに集約 → texture:false（我々のloaderはNORMAL/POSITIONのみ使用＝テクスチャ不要、fetch半分で済む）を優先
const byArea = new Map();
for (const d of bldgLod2) {
	const key = d.ward_code || d.city_code;
	const cur = byArea.get(key);
	if (!cur || (cur.texture && !d.texture)) byArea.set(key, d);
}
console.log(`重複排除後: ${byArea.size} 地区`);

const areas = [...byArea.values()];
const results = new Array(areas.length);
let done = 0, skipped = 0;

async function fetchBbox(d, attempt = 1) {
	const base = d.url.replace(/tileset\.json$/, '');
	try {
		const ts = await (await fetch(base + 'tileset.json', { signal: AbortSignal.timeout(25000) })).json();
		const region = ts.root?.boundingVolume?.region;
		if (!region) { console.warn(`  bbox無し(region以外) skip: ${d.id}`); skipped++; return null; }
		const R2D = 180 / Math.PI;
		const bbox = [region[0] * R2D, region[1] * R2D, region[2] * R2D, region[3] * R2D];
		const name = (d.ward ? d.city.replace(/市$/, '') + d.ward : d.city);
		return { name, base, bbox };
	} catch (e) {
		if (attempt < 3) return fetchBbox(d, attempt + 1);
		console.warn(`  失敗 skip: ${d.id} (${e.message})`);
		skipped++;
		return null;
	}
}

let idx = 0;
async function worker() {
	while (idx < areas.length) {
		const i = idx++;
		results[i] = await fetchBbox(areas[i]);
		done++;
		if (done % 25 === 0 || done === areas.length) console.log(`[${done}/${areas.length}]`);
	}
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const out = results.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
writeFileSync(OUT, JSON.stringify(out, null, '\t'));
console.log(`\nDone. ${out.length} 地区 → ${OUT}（skip: ${skipped}）`);
