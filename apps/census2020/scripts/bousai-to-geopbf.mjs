/**
 * bousai geojsonl → GeoPBF 変換（サーバー最小化）。裁定 2026-08-12:「サーバーは最小限のデータ・通信も最小」。
 * 既存の bucket/local geojsonl を読み、bake時に**ランク/区分でマージ**（a31=浸水深ランク6地物・
 * a33=区分×現象）してから共有エンコーダ encodeGeoPBF で GeoPBF 化し bucket/bousai/{layer}/{code}.geopbf へ。
 * native-bucket が gzip 自動。gint は載せない（クライアントWASMで焼く・スタック再マージで無駄になるため）。
 *   ・a31 ソース = ローカル out-a31-mesh/{mesh}/{code}.geojsonl（メッシュ横断連結・再fetch回避）
 *   ・a33 ソース = bucket/bousai/a33/{code}.geojsonl（ローカルに無いため fetch）
 *
 * 使い方:
 *   node bousai-to-geopbf.mjs --layer a31 --code 13112 --dry-run   # 1市パイロット（./out-geopbf へ）
 *   API_KEY=... node bousai-to-geopbf.mjs --layer a31 [--codes 13112,27127]   # bucket 上げ
 *   API_KEY=... node bousai-to-geopbf.mjs --layer a33 --all                    # 全市（bucketから列挙）
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { gunzipSync } from 'zlib';
import { Bucket } from 'native-bucket';
import { encodeGeoPBF } from '../../gishub-jp/scripts/geopbf-encode.mjs';
const __dir = dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.API_BASE ?? 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const argv = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
	?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : null);
const LAYER = argv('layer');
const DRY = process.argv.includes('--dry-run') || !API_KEY;
if (!['a31', 'a33'].includes(LAYER)) { console.error('--layer a31|a33 が必要'); process.exit(1); }

const ATTR = { a31: '国土交通省 国土数値情報（洪水浸水想定区域 A31）', a33: '国土交通省 国土数値情報（土砂災害警戒区域 A33）' };
const MESH_OUT = join(__dir, 'out-a31-mesh');

// バケットの geojsonl（生gzip）→ Feature[]
async function fetchJsonl(url) {
	const res = await fetch(url);
	if (!res.ok) return null;
	let buf = Buffer.from(await res.arrayBuffer());
	if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
	const feats = [];
	for (const line of buf.toString('utf8').split('\n')) { const s = line.trim(); if (s) { try { feats.push(JSON.parse(s)); } catch { /* skip */ } } }
	return feats.length ? feats : null;
}
// ローカル out-a31-mesh をメッシュ横断連結（a31-all.mjs mergeUpload と同じ思想＝境界市を壊さない連結）
function localA31(code) {
	if (!existsSync(MESH_OUT)) return null;
	const feats = [];
	for (const m of readdirSync(MESH_OUT)) {
		const f = join(MESH_OUT, m, `${code}.geojsonl`);
		if (!existsSync(f)) continue;
		for (const line of readFileSync(f, 'utf8').split('\n')) { const s = line.trim(); if (s) { try { feats.push(JSON.parse(s)); } catch { /* skip */ } } }
	}
	return feats.length ? feats : null;
}

// バケット/ローカルから生 Feature[] を取る
async function rawFeatures(code) {
	if (LAYER === 'a31') return localA31(code) ?? await fetchJsonl(`${API_BASE}/bucket/bousai/a31/${code}.geojsonl`);
	return await fetchJsonl(`${API_BASE}/bucket/bousai/a33/${code}.geojsonl`);
}

// bousai.js の mergeBy と同一規準＝fid を1桁に抑える（WebGPU idfill fid≤2047・識別粒度もランク/区分で十分）。
// 同一キーの全 Polygon を1つの MultiPolygon へ集約。プロパティは数値のまま（encodeGeoPBF が INTEGER 保存）。
function mergeFeatures(feats) {
	const groups = new Map();
	const keyOf = LAYER === 'a31' ? p => `r${p.rank}` : p => `${p.kbn}/${p.gensho}`;
	const propsOf = LAYER === 'a31'
		? p => ({ _src: 'a31', rank: +p.rank || 1, depth: String(p.depth ?? '') })
		: p => ({ _src: 'a33', kbn: +p.kbn === 2 ? 2 : 1, gensho: String(p.gensho ?? '') });
	for (const f of feats) {
		const g = f.geometry; if (!g) continue;
		const comps = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
		if (!comps.length) continue;
		const k = keyOf(f.properties ?? {});
		if (!groups.has(k)) groups.set(k, { props: propsOf(f.properties ?? {}), comps: [] });
		groups.get(k).comps.push(...comps);
	}
	// マージ順を安定化（ランク昇順＝描画時の重なりが手前ほど深い）
	return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, { props, comps }]) => ({
		type: 'Feature', properties: props,
		geometry: comps.length === 1 ? { type: 'Polygon', coordinates: comps[0] } : { type: 'MultiPolygon', coordinates: comps },
	}));
}

async function convertCity(code, bucket) {
	const raw = await rawFeatures(code);
	if (!raw) return { code, skip: true };
	const merged = mergeFeatures(raw);
	if (!merged.length) return { code, skip: true };
	const buf = encodeGeoPBF(merged, { name: `bousai/${LAYER}/${code}`, license: 'CC_BY_4.0', attribution: ATTR[LAYER] });
	if (DRY) {
		const dir = join(__dir, 'out-geopbf', LAYER); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${code}.geopbf`), buf);
		return { code, feats: merged.length, raw: raw.length, bytes: buf.length };
	}
	await bucket.put(`${code}.geopbf`, new File([buf], `${code}.geopbf`, { type: 'application/octet-stream' }));
	return { code, feats: merged.length, raw: raw.length, bytes: buf.length };
}

// 対象コード列
async function targetCodes() {
	const codes = argv('codes')?.split(',').map(s => s.trim()).filter(Boolean);
	if (codes?.length) return codes;
	const one = argv('code'); if (one) return [one];
	if (LAYER === 'a31') {
		const prog = join(__dir, 'a31-up-progress.json');
		if (existsSync(prog)) return JSON.parse(readFileSync(prog));
		return existsSync(MESH_OUT) ? [...new Set(readdirSync(MESH_OUT).flatMap(m => readdirSync(join(MESH_OUT, m)).map(f => f.replace('.geojsonl', ''))))].sort() : [];
	}
	// a33: estat manifest の全市区町村コードを対象（無い市は 404→skip）
	const est = JSON.parse(readFileSync(new URL('../estat/manifest.json', import.meta.url)));
	return [...new Set(est.map(e => e.code).filter(c => !/000$/.test(c)))].sort();
}

const codes = await targetCodes();
console.log(`layer=${LAYER} 対象 ${codes.length} 市区町村 ${DRY ? '[dry-run→./out-geopbf]' : '[bucket上げ]'}`);
const bucket = DRY ? null : await Bucket(`bousai/${LAYER}`, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
let ok = 0, skip = 0, totRaw = 0, totPbf = 0;
for (const code of codes) {
	try {
		const r = await convertCity(code, bucket);
		if (r.skip) { skip++; continue; }
		ok++; totPbf += r.bytes;
		if (codes.length <= 10 || ok % 100 === 0) console.log(`  ✓ ${code} ${r.feats}地物 ${(r.bytes / 1024).toFixed(0)}KB (raw ${r.raw}地物)`);
	} catch (e) { console.error(`  ✗ ${code}: ${e.message}`); }
}
console.log(`\n✅ ${LAYER}: ok=${ok} skip=${skip}  GeoPBF計 ${(totPbf / 1024 / 1024).toFixed(1)}MB（gzip前・native-bucketで更に圧縮）`);
