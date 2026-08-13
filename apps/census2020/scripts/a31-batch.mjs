/**
 * 国土数値情報 A31 v4.0（洪水浸水想定区域・1次メッシュ単位・令和4=A31-22）→ bucket bousai/a31/{市区町村5桁}.geojsonl
 * zip には 10_計画規模 / 20_想定最大規模 / 30_浸水継続時間 / 40_家屋倒壊 の4層が同居＝**20_ だけ**を読む
 * （ファイル名 A31-20-*.shp・属性 A31_201=浸水深ランク・実確認 2026-08-12 メッシュ5339）。
 * ポリゴンは流域スケール＝市区町村を跨ぐため、bbox 交差で該当市区町村すべてへ複製（各市ファイル自己完結）。
 *
 * 入力: A31-22_[10|20河川区分]_[メッシュ4桁]_SHP.zip 群を --src へ
 *   （URL例 https://nlftp.mlit.go.jp/ksj/gml/data/A31/A31-22/A31-22_10_5339_SHP.zip・直GET可）。
 *   メッシュは県を跨ぐ＝対象都道府県を --prefs 11,12,13,14 で明示（市区町村インデックスの構築範囲）。
 * 出力 props: { _src:'a31', rank:1..6, depth:'0.5〜3.0m' 等 }
 *
 * 使い方:
 *   node a31-batch.mjs --src ~/ksj-a31 --inspect
 *   API_KEY=... node a31-batch.mjs --src ~/ksj-a31 --prefs 11,12,13,14 [--dry-run]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import { Bucket } from 'native-bucket';
import { loadCityIndex, bboxOfGeom, bboxHit, quantizeGeom, clipGeomToBbox, zipFeatures, pickField } from './ksj-common.mjs';

const ESTAT_MANIFEST = JSON.parse(readFileSync(new URL('../estat/manifest.json', import.meta.url)));
const API_BASE = process.env.API_BASE ?? 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const argv = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1]
	?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : null);
const SRC = argv('src');
const OUT_DIR = argv('out');   // ローカル出力先の上書き（全国ドライバがメッシュ別 dir を指す）
const PREFS_ARG = (argv('prefs') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const INSPECT = process.argv.includes('--inspect');
const DRY = process.argv.includes('--dry-run') || !API_KEY;
if (!SRC) { console.error('--src <KSJ A31 zipのディレクトリ> が必要'); process.exit(1); }

// ★実ファイルで確定させる属性マップ（--inspect の出力を見て更新）
const RANK_FIELD = ['A31_201', 'A31_101', '浸水深ランク'];   // A31_201＝想定最大規模の浸水深ランク（v4.0 実確認）
const RANK_MAP = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };   // 生コード→標準6区分（年度で 11/12… 等の変種あり）
const DEPTH_LABEL = { 1: '〜0.5m', 2: '0.5〜3.0m', 3: '3.0〜5.0m', 4: '5.0〜10.0m', 5: '10.0〜20.0m', 6: '20.0m〜' };

const zips = readdirSync(SRC).filter(f => f.toLowerCase().endsWith('.zip'));
if (!zips.length) { console.error('zip が見つからない'); process.exit(1); }
if (!INSPECT && !PREFS_ARG.length) { console.error('--prefs 11,12,… が必要（メッシュzipは県を跨ぐ＝インデックス範囲の明示）'); process.exit(1); }
console.log(`対象 zip: ${zips.length} 本 / 対象県: ${PREFS_ARG.join(',') || '(inspect)'}`);

const perCity = new Map();
const fieldStats = new Map();
// 市区町村インデックスは全 zip 共有（--prefs の合併＝1回だけ構築）
let cityIdx = null;
if (!INSPECT) {
	const parts = [];
	for (const pf of PREFS_ARG) parts.push(await loadCityIndex(pf, ESTAT_MANIFEST));
	cityIdx = { cities: parts.flatMap(p => p.cities) };
	console.log(`市区町村インデックス: ${cityIdx.cities.length} 市区町村`);
}
for (const zf of zips) {
	console.log(`\n📦 ${zf}`);
	const zip = new AdmZip(join(SRC, zf));
	let n = 0, dup = 0;
	for await (const { feature } of zipFeatures(zip, shapefile, { match: /^A31-20-/i })) {
		const p = feature.properties ?? {};
		if (INSPECT) {
			for (const [k, v] of Object.entries(p)) {
				if (!fieldStats.has(k)) fieldStats.set(k, new Set());
				const s = fieldStats.get(k); if (s.size < 8) s.add(String(v));
			}
			continue;
		}
		const fRank = pickField(p, RANK_FIELD);
		const rank = RANK_MAP[+p[fRank]] ?? null;
		if (!rank) continue;   // ランク不明＝描けない（--inspect で RANK_MAP を直す）
		const geom = feature.geometry;   // 原典（ラスタ起源メッシュ）の階段辺をそのまま保持＝間引き禁止（本人裁定2026-08-14「thinRingsは完全に間違い」）
		const fb = bboxOfGeom(geom);
		let hits = 0;
		for (const c of cityIdx.cities) if (bboxHit(fb, c.bbox)) {
			// 丸ごと複製でなく市 bbox で矩形クリップ＝各市ファイルは自分の窓の分だけ（2.1GB/メッシュ爆発の根治）
			const cg = clipGeomToBbox(geom, c.bbox);
			if (!cg) continue;
			if (!perCity.has(c.code)) perCity.set(c.code, []);
			perCity.get(c.code).push(JSON.stringify({ type: 'Feature', geometry: quantizeGeom(cg), properties: { _src: 'a31', rank, depth: DEPTH_LABEL[rank] } }));
			hits++;
		}
		n++; if (hits > 1) dup += hits - 1;
	}
	if (!INSPECT) console.log(`  ${n} ポリゴン（複製 +${dup}）`);
}

if (INSPECT) {
	console.log('\n=== フィールド偵察（RANK_FIELD/RANK_MAP の確定に使う） ===');
	for (const [k, vs] of fieldStats) console.log(`  ${k}: ${[...vs].join(' / ')}`);
	process.exit(0);
}

console.log(`\n市区町村 ${perCity.size} 件へ分配`);
if (DRY) {
	const dir = OUT_DIR ?? new URL('./out/a31/', import.meta.url).pathname;
	mkdirSync(dir, { recursive: true });
	for (const [code, lines] of [...perCity].sort()) writeFileSync(join(dir, `${code}.geojsonl`), lines.join('\n'));
	console.log(`[dry-run/no API_KEY] ${dir} にローカル出力`);
} else {
	const bucket = await Bucket('bousai/a31', { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
	for (const [code, lines] of [...perCity].sort()) {
		await bucket.put(`${code}.geojsonl`, new File([lines.join('\n')], `${code}.geojsonl`, { type: 'application/geo+json' }));
		console.log(`  ✓ ${code}.geojsonl ${lines.length}`);
	}
	console.log('✅ 完了');
}
