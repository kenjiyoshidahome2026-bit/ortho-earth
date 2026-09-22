/**
 * 国土数値情報カタログ（bucket catalog/）の 1 データセットを新しい年版へ差し替える。
 * 全量の作り直し（extract-geojson → make-catalog-json）をせずに、公開された新年版だけ足す道具。
 *
 *   node scripts/nlftp-bump.mjs L02-2025 L02-2026            … 下見（何も書かない）
 *   node scripts/nlftp-bump.mjs L02-2025 L02-2026 --check-data --upload   … catalog/L02-2026.json を置き、index.json の行を差し替える
 *
 * 作り方：前年版の JSON（bucket）を土台に、
 *   files      … 新年版ページの DownLd / DownLd_new の zip のうち新年版のものを、zip の中身（Range で目次だけ読む）から組み直す
 *   attributes … 前年版のラベル・コードリストを引き継ぐ。--check-data で新年版の実データの列を確かめ、
 *                前年のラベル付き列が消えていたら止まる（ラベル・コードリストの読み直しは全量の作り直しで）
 * 鍵は apps/uploader/.env.local の VITE_API_KEY（git 管理外・uploader と同じ bucket の書き込み鍵）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGeoFilesInZip } from './zip-reader.js';
import { Bucket } from '../../../packages/native-bucket/src/Bucket.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://api.ortho-earth.com';
const PAGE = code => `https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-${code}.html`;

const [prevCode, nextCode] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const upload = process.argv.includes('--upload');
if (!prevCode || !nextCode) { console.error('usage: node scripts/nlftp-bump.mjs <前年版コード> <新年版コード> [--upload]'); process.exit(1); }
const nextYear = +nextCode.match(/-(\d{4})$/)?.[1];
const yy = String(nextYear).slice(2);

// 新年版 zip の GeoJSON の列（先頭地物のキー）が前年版の属性ラベルを全部含むか（zip を丸ごと落とす＝数十 MB）
async function checkColumns(url, inner, prev) {
	if (!inner) return;
	const { default: AdmZip } = await import('adm-zip');
	const zip = new AdmZip(Buffer.from(await (await fetch(url)).arrayBuffer()));
	const fc = JSON.parse(zip.readAsText(inner));
	const cols = new Set(Object.keys(fc.features[0]?.properties || {}));
	const lost = Object.keys(prev.attributes || {}).filter(c => !cols.has(c));
	const known = new Set(Object.keys(prev.attributes || {}));
	console.log(`実データ: 地物 ${fc.features.length.toLocaleString()}・列 ${cols.size}（ラベル無しの列 ${[...cols].filter(c => !known.has(c)).length} 本はコード名のまま表示）`);
	if (lost.length) { console.error(`✖ 前年版のラベル付き列が実データから消えた: ${lost.join(',')}＝全量の作り直しで`); process.exit(1); }
}

const gunzipJson = async res => {
	const buf = new Uint8Array(await res.arrayBuffer());
	const txt = buf[0] === 0x1f && buf[1] === 0x8b
		? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
		: new TextDecoder().decode(buf);
	return JSON.parse(txt);
};
const getJson = async url => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`); return gunzipJson(r); };

const prev  = await getJson(`${API_BASE}/bucket/catalog/${prevCode}.json`);
const index = await getJson(`${API_BASE}/bucket/catalog/index.json`);
const html  = await (await fetch(PAGE(nextCode))).text();

// ---- 属性コードの照合（ページ表記の差は参考のみ） ----
// ページの「（L02_001）」表記は年ごとに書式がゆれる（2025→2026 で 043/048 が 046/055 に見える等）＝判定には使わない。
// 判定は --check-data（zip の中の GeoJSON を丸ごと読んで列を比べる）で。前年の列が消えていたら止める（ラベルがずれる）
const pageCodes = new Set([...html.matchAll(/[（(]([A-Z]\d{2}[a-z*]?_\d{3})[)）]/g)].map(m => m[1]));
const prevCodes = new Set(Object.keys(prev.attributes || {}));
const pageDiff = [...pageCodes].filter(c => !prevCodes.has(c)).concat([...prevCodes].filter(c => !pageCodes.has(c)));
if (pageDiff.length) console.log(`（参考）ページ表記の属性コードの差: ${pageDiff.join(',')}`);

// ---- 新年版の zip ----
const links = [...html.matchAll(/DownLd(?:_new)?\(\s*'[^']*',\s*'([^']+)',\s*'([^']+)'/g)]
	.map(m => ({ name: m[1].trim(), url: new URL(m[2].trim(), 'https://nlftp.mlit.go.jp/').href }))
	.filter(l => new RegExp(`-${yy}[_/.-]`).test(l.name) || new RegExp(`-${yy}/`).test(l.url));
if (!links.length) { console.error(`✖ ${nextYear} 年版の zip がページに無い`); process.exit(1); }

// scope＝extract-geojson と同じ書式：zip 名が <code>-<yy>_<2桁>_… なら { scope:'都道府県', pref_code } ・それ以外は全国
const scopeOf = name => {
	const m = name.match(new RegExp(`-${yy}_(\\d{2})_`));
	return m ? { scope: '都道府県', pref_code: m[1] } : { scope: '全国' };
};

const files = [];
for (const { name, url } of links) {
	const head = await fetch(url, { method: 'HEAD' });
	const size = +head.headers.get('content-length') || 0;
	const { paths } = await listGeoFilesInZip(url);
	const pick = fmt => paths.filter(p => new RegExp(`\\.${fmt}$`, 'i').test(p));
	for (const fmt of ['geojson', 'shp']) for (const p of pick(fmt)) {
		files.push({ year: nextYear, ...scopeOf(name), format: fmt, target: `${url}#${p}`, size });
	}
	console.log(`zip ${name}  ${(size / 1048576).toFixed(1)} MB  中身 ${paths.length} 件`);
	if (process.argv.includes('--check-data')) await checkColumns(url, paths.find(p => /\.geojson$/i.test(p)), prev);
}
if (!files.length) { console.error('✖ zip に geojson / shp が無い'); process.exit(1); }

const next = { ...prev, dataset_code: nextCode, page_url: PAGE(nextCode), files };
const row  = index.find(d => d.dataset_code === prevCode);
if (!row) { console.error(`✖ index.json に ${prevCode} の行が無い`); process.exit(1); }
const nextRow = { ...row, dataset_code: nextCode, formats: [...new Set(files.map(f => f.format))], file_count: files.length };
const nextIndex = index.map(d => d === row ? nextRow : d);

console.log(`files: ${files.length}（全国 ${files.filter(f => f.scope === '全国').length}・都道府県 ${files.filter(f => f.pref_code).length}）例:`, JSON.stringify(files.slice(0, 3)));
console.log('index 行:', JSON.stringify(nextRow));
if (!upload) { console.log('\n下見のみ（--upload で bucket へ置く）'); process.exit(0); }

// ---- bucket へ ----
const env = { ...process.env };
for (const f of [path.join(HERE, '../../uploader/.env.local')]) {
	try { for (const line of fs.readFileSync(f, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch { }
}
if (!env.VITE_API_KEY) { console.error('✖ VITE_API_KEY が無い（apps/uploader/.env.local）'); process.exit(1); }
const bucket = await Bucket('catalog', { baseUrl: `${API_BASE}/bucket/`, apiKey: env.VITE_API_KEY, silent: true });
if (!bucket) { console.error('✖ bucket catalog に届かない'); process.exit(1); }
const put = (name, obj) => bucket.put(new File([JSON.stringify(obj)], name, { type: 'application/json' }));
await put(`${nextCode}.json`, next);   // 先に本体（index が先に変わると一瞬 404 の行ができる）
await put('index.json', nextIndex);
console.log(`✓ catalog/${nextCode}.json と index.json を置いた（${prevCode}.json は残す＝旧リンク用）`);
