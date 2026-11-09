// PLATEAU 全国 LOD2 建築物モデル＋橋梁モデル カタログを生成する。
// datacatalog API から bldg/lod2/3D Tiles を市区町村ごとに1件へ重複排除し（texture無し版＝我々の loader はテクスチャ未使用なので半分軽い）、
// 各 tileset.json の root.boundingVolume.region から自動ロード用 bbox(deg) を取って
// packages/jp/assets/plateau-sets.json に書き出す。
// LOD2 が無い地区（2026-11 時点で全国 148＝静岡市駿河区・横浜/名古屋/大阪の多くの区等）は LOD1（箱）で埋める＝lod:1 を付ける。
// 旧版は LOD2 だけを拾い、LOD1 しか無い地区はそもそも登録されず「隣の区の被覆マスクで基図まで伏せられた空白」が出た（静岡駅南）。
// 橋梁（brid）は独立エントリ「◯◯（橋梁）」として同じ一覧に足す（LOD 2>3>1 の順で1件）。
// noMask:true＝基図建物を伏せる被覆マスクに参加しない・建物の同時4区枠も奪わない（app.js側の別枠選抜）。
//
// 使い方: node scripts/plateau-catalog-build.mjs

import { writeFileSync } from 'fs';

const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const OUT = 'packages/jp/assets/plateau-sets.json';
const CONCURRENCY = 16;

console.log('カタログ取得中...', CATALOG_URL);
const catalog = await (await fetch(CATALOG_URL)).json();
const all = catalog.latest_datasets; // "-latest" 安定URL＝reearth側の再アップロードでハッシュが変わっても腐らない

// 建物：LOD2 > LOD1（LOD1 は LOD2 の無い地区だけ）。d.city が無い都道府県一括ロールアップは除外（区・市単位と二重被覆）。
const bldg = all.filter(d => d.type_en === 'bldg' && (String(d.lod) === '2' || String(d.lod) === '1') && d.format === '3D Tiles' && d.city);
console.log(`bldg/lod1-2/3D Tiles: ${bldg.length} 件`);

// 市区町村(ward優先)ごとに候補リスト化：LOD2 優先 → 同 LOD は texture:false（我々のloaderはNORMAL/POSITIONのみ使用＝テクスチャ不要、
// fetch半分で済む）優先。候補リスト＝-latest が空殻（例 22102 の lod2-latest は region=日本全域・children 無し）なら次候補へ落ちる。
const byArea = new Map();
for (const d of bldg) {
	const key = d.ward_code || d.city_code;
	if (!byArea.has(key)) byArea.set(key, []);
	byArea.get(key).push(d);
}
for (const cands of byArea.values()) cands.sort((a, b) => (String(b.lod) === '2') - (String(a.lod) === '2') || (!!a.texture - !!b.texture));
console.log(`重複排除後: ${byArea.size} 地区（うち LOD1 のみ ${[...byArea.values()].filter(c => String(c[0].lod) !== '2').length}）`);

// 橋梁（brid）：地区ごとに候補リスト＝LOD 2>3>1 の優先（LOD3は細かいが重い、LOD1は箱）、同LODは
// "-latest" 安定URL優先→年次降順。政令市（横浜・大阪・京都・仙台・広島等）の -latest エイリアスは
// tileset.json が空殻（children/content無し・region全国プレースホルダ）＝変換側の不具合。年次版の
// 実URL（reearth CMS assets）は生きている（横浜2024で確認済＝ベイブリッジ）ので、fetchBbox が殻を
// 検知したら次候補へ落ちる。年次URLはハッシュ入り＝再アップロードで腐り得るが、再生成で追随する。
const LOD_PREF = { 2: 0, 3: 1, 1: 2 };
const bridCand = new Map();   // key → [dataset…]（優先順）
{
	// d.city が無いもの（都道府県一括ロールアップ・例 13_tokyo_pref）は除外＝区・市単位と二重被覆になり
	// 同じ橋が二重に立つ（z-fight）上、名前が「null（橋梁）」になる。
	const isBrid = d => d.type_en === 'brid' && d.format === '3D Tiles' && d.city;
	const pool = all.filter(isBrid).map(d => ({ d, yr: Infinity }))
		.concat(catalog.datasets.filter(isBrid).map(d => ({ d, yr: +d.year || 0 })));
	pool.sort((a, b) => ((LOD_PREF[a.d.lod] ?? 9) - (LOD_PREF[b.d.lod] ?? 9)) || (b.yr - a.yr));
	for (const { d } of pool) {
		const key = d.ward_code || d.city_code;
		if (!bridCand.has(key)) bridCand.set(key, []);
		bridCand.get(key).push(d);
	}
	console.log(`brid: ${pool.length} 件 → ${bridCand.size} 地区（候補リスト化）`);
}

const areas = [...byArea.values()].map(cands => ({ cands, kind: 'bldg' }))
	.concat([...bridCand.values()].map(cands => ({ cands, kind: 'brid' })));
const results = new Array(areas.length);
let done = 0, skipped = 0;

async function fetchBbox(d, kind, attempt = 1) {
	const base = d.url.replace(/tileset\.json$/, '');
	try {
		const ts = await (await fetch(base + 'tileset.json', { signal: AbortSignal.timeout(25000) })).json();
		const region = ts.root?.boundingVolume?.region;
		if (!region) { console.warn(`  bbox無し(region以外) skip: ${d.id}`); return null; }
		// 空殻検知：root に children も content も無い＝タイルへ辿り着けない殻（政令市bridの-latestに多い）。
		if (!ts.root?.children?.length && !ts.root?.content) { console.warn(`  空殻tileset skip: ${d.id} (${d.year || 'latest'})`); return null; }
		const R2D = 180 / Math.PI;
		const bbox = [region[0] * R2D, region[1] * R2D, region[2] * R2D, region[3] * R2D];
		// 廃止区の残骸（浜松旧7区等）は region が日本全域のプレースホルダ（span 30°級）＝全国どこでも自動ロード候補に
		// 引っかかり無駄fetchを生む。市区町村としてあり得ない広さ（最大の正規例=隠岐の島町1.5°）は捨てる。
		if (bbox[2] - bbox[0] > 5 || bbox[3] - bbox[1] > 5) { console.warn(`  bbox異常(全国級プレースホルダ) skip: ${d.id} (${d.year || 'latest'})`); return null; }
		const city = d.city.replace(/（テスト）$/, '');   // カタログ側の仮名（例「多古町（テスト）」）は名前＝区キーへ持ち込まない
		const name = (d.ward ? city.replace(/市$/, '') + d.ward : city) + (kind === 'brid' ? '（橋梁）' : '');
		const r = kind === 'brid' ? { name, base, bbox, noMask: true } : String(d.lod) === '1' ? { name, base, bbox, lod: 1 } : { name, base, bbox };
		Object.defineProperty(r, 'pref', { value: d.pref, enumerable: false });   // 同名の市（府中市＝東京/広島）の見分け用・JSON へは出さない
		return r;
	} catch (e) {
		if (attempt < 3) return fetchBbox(d, kind, attempt + 1);
		console.warn(`  失敗 skip: ${d.id} (${e.message})`);
		return null;
	}
}

let idx = 0;
async function worker() {
	while (idx < areas.length) {
		const i = idx++;
		for (const d of areas[i].cands) {   // 優先順に試し、最初に生きていた候補を採用（殻/失敗は次へ）
			results[i] = await fetchBbox(d, areas[i].kind);
			if (results[i]) break;
		}
		if (!results[i]) skipped++;
		done++;
		if (done % 25 === 0 || done === areas.length) console.log(`[${done}/${areas.length}]`);
	}
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const out = results.filter(Boolean);
// 名前＝区キー（マスク・キャッシュ・表示）＝一意でなければならない。同名は LOD2 側を素の名に残し、他へ「（都道府県）」を足す
for (const [nm, group] of Map.groupBy(out, r => r.name)) {
	if (group.length < 2) continue;
	group.sort((a, b) => (a.lod === 1) - (b.lod === 1));
	for (const r of group.slice(1)) r.name = `${nm}（${r.pref}）`;
	console.warn(`  同名: ${nm} → ${group.map(r => r.name).join(' / ')}`);
}
out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
writeFileSync(OUT, JSON.stringify(out, null, '\t'));
console.log(`\nDone. ${out.length} 地区 → ${OUT}（skip: ${skipped}）`);
