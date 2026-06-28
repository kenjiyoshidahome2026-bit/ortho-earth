/**
 * MAFF 筆ポリゴン GeoJSONL → GeoPBF 変換バッチ
 *
 * native-bucket の maff/{code}.geojsonl を読み込み
 * GeoPBF エンコード → gzip → GIS/pbf/maff_{code}.geopbf にアップロード
 *
 * 使い方:
 *   node maff-to-geopbf.js              # 全件
 *   node maff-to-geopbf.js --code 011011 # 特定コードのみ
 *   node maff-to-geopbf.js --pref 01    # 特定都道府県のみ
 *   node maff-to-geopbf.js --dry-run
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { gunzip } from 'zlib';
const __dir = dirname(fileURLToPath(import.meta.url));
import { promisify } from 'util';
import Pbf from 'pbf';

const gunzipAsync = promisify(gunzip);
import { Bucket } from '../../packages/native-bucket/src/Bucket.js';

const API_BASE   = 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const SRC_DIR    = 'maff';
const DST_DIR    = 'GIS/pbf';
const PROGRESS = join(__dir, 'geopbf-progress.json');
const PRECISION  = 7;

const DRY_RUN  = process.argv.includes('--dry-run');
const ONLY     = process.argv.find(a => a.startsWith('--code='))?.split('=')[1]
							?? (process.argv.includes('--code') ? process.argv[process.argv.indexOf('--code') + 1] : null);
const ONLY_PREF = process.argv.find(a => a.startsWith('--pref='))?.split('=')[1]
							?? (process.argv.includes('--pref') ? process.argv[process.argv.indexOf('--pref') + 1] : null);

const done = existsSync(PROGRESS)
	? new Set(JSON.parse(readFileSync(PROGRESS)))
	: new Set();
const saveProgress = () => writeFileSync(PROGRESS, JSON.stringify([...done]));

// ── GeoPBF エンコーダー ──────────────────────────────────────────────────────

const TAGS = {
	NAME:1, KEYS:2, PRECISION:3, FARRAY:5, FEATURE:6, GEOMETRY:7,
	GTYPE:8, LENGTH:9, COORDS:10, VALUE:11, INDEX:12,
	DESCRIPTION:14, LICENSE:15, ATTRIBUTION:16,
};
const GTYPE = { Point:0, MultiPoint:1, LineString:2, MultiLineString:3, Polygon:4, MultiPolygon:5 };
const DTYPE = { NULL:0, BOOL:1, INTEGER:2, FLOAT:3, STRING:4 };
const isFloat = n => typeof n === 'number' && !Number.isInteger(n);

// 連続重複除去 + delta + closing vertex 除去（ポリゴン環用）
function diffRing(ring, e) {
	const src = [];
	for (const pt of ring) {
		const ix = Math.round(pt[0] * e), iy = Math.round(pt[1] * e);
		if (!src.length || src[src.length-1][0] !== ix || src[src.length-1][1] !== iy)
			src.push([ix, iy]);
	}
	if (src.length < 3) return [];
	const p = []; let px = 0, py = 0;
	for (const [ix, iy] of src) { p.push([ix - px, iy - py]); px = ix; py = iy; }
	p.pop(); // closing vertex delta を除去
	return p;
}

// 連続重複除去 + delta（ライン/ポイント用）
function diffLine(line, e) {
	const src = [];
	for (const pt of line) {
		const ix = Math.round(pt[0] * e), iy = Math.round(pt[1] * e);
		if (!src.length || src[src.length-1][0] !== ix || src[src.length-1][1] !== iy)
			src.push([ix, iy]);
	}
	const p = []; let px = 0, py = 0;
	for (const [ix, iy] of src) { p.push([ix - px, iy - py]); px = ix; py = iy; }
	return p;
}

function writeGeometry(pbf, geom, e) {
	if (!geom?.coordinates) return;
	let gtype = GTYPE[geom.type];
	if (gtype === undefined) return;
	let c = geom.coordinates;
	// Multi系で要素1つ → ダウングレード
	if (gtype % 2 === 1 && c.length === 1) { gtype--; c = c[0]; }

	pbf.writeMessage(TAGS.GEOMETRY, () => {
		pbf.writeVarintField(TAGS.GTYPE, gtype);
		if (gtype === 0) { // Point
			pbf.writePackedSVarint(TAGS.COORDS, [Math.round(c[0]*e), Math.round(c[1]*e)]);
		} else if (gtype === 1) { // MultiPoint
			const d = diffLine(c, e);
			pbf.writePackedSVarint(TAGS.COORDS, d.flat());
		} else if (gtype === 2) { // LineString
			const d = diffLine(c, e);
			pbf.writePackedSVarint(TAGS.COORDS, d.flat());
		} else if (gtype === 3) { // MultiLineString
			const rings = c.map(l => diffLine(l, e)).filter(r => r.length > 0);
			pbf.writePackedVarint(TAGS.LENGTH, rings.map(r => r.length));
			pbf.writePackedSVarint(TAGS.COORDS, rings.flat().flat());
		} else if (gtype === 4) { // Polygon
			const rings = c.map(r => diffRing(r, e)).filter(r => r.length > 0);
			pbf.writePackedVarint(TAGS.LENGTH, rings.map(r => r.length));
			pbf.writePackedSVarint(TAGS.COORDS, rings.flat().flat());
		} else if (gtype === 5) { // MultiPolygon
			const polys = c.map(poly => poly.map(r => diffRing(r, e)).filter(r => r.length > 0))
										 .filter(p => p.length > 0);
			// len3: [numPolys, numRings_p0, numVerts_p0r0, numVerts_p0r1, ..., numRings_p1, ...]
			const lens = [polys.length];
			for (const poly of polys) {
				lens.push(poly.length);
				for (const ring of poly) lens.push(ring.length);
			}
			pbf.writePackedVarint(TAGS.LENGTH, lens);
			pbf.writePackedSVarint(TAGS.COORDS, polys.flat(2).flat());
		}
	});
}

function writeProperties(pbf, props, keyIdx) {
	if (!props) return;
	const index = [];
	for (const [key, val] of Object.entries(props)) {
		if (val == null || !(key in keyIdx)) continue;
		pbf.writeMessage(TAGS.VALUE, () => {
			if (typeof val === 'string')         pbf.writeStringField(DTYPE.STRING, val);
			else if (isFloat(val))               pbf.writeDoubleField(DTYPE.FLOAT, val);
			else if (typeof val === 'number')    pbf.writeSVarintField(DTYPE.INTEGER, val);
			else if (typeof val === 'boolean')   pbf.writeBooleanField(DTYPE.BOOL, val);
		});
		index.push(keyIdx[key]);
	}
	if (index.length) pbf.writePackedVarint(TAGS.INDEX, index);
}

function encodeGeoPBF(features, opts = {}) {
	const { name='', description='', license='', attribution='' } = opts;
	const e = Math.pow(10, PRECISION);

	// キー辞書構築
	const keySet = new Set();
	for (const f of features) if (f.properties) for (const k of Object.keys(f.properties)) keySet.add(k);
	const keys = [...keySet].sort();
	const keyIdx = Object.fromEntries(keys.map((k, i) => [k, i]));

	const pbf = new Pbf();
	if (name)        pbf.writeStringField(TAGS.NAME, name);
	if (description) pbf.writeStringField(TAGS.DESCRIPTION, description);
	if (license)     pbf.writeStringField(TAGS.LICENSE, license);
	if (attribution) pbf.writeStringField(TAGS.ATTRIBUTION, attribution);
	pbf.writeVarintField(TAGS.PRECISION, PRECISION);
	for (const k of keys) pbf.writeStringField(TAGS.KEYS, k);

	pbf.writeMessage(TAGS.FARRAY, () => {
		for (const f of features) {
			pbf.writeMessage(TAGS.FEATURE, () => {
				writeGeometry(pbf, f.geometry, e);
				writeProperties(pbf, f.properties, keyIdx);
			});
		}
	});

	return Buffer.from(pbf.finish());
}

// ── メイン ───────────────────────────────────────────────────────────────────

async function processCode(code, manifest, dstBucket) {
	if (done.has(code)) return 'skip';

	// GeoJSONL を取得
	const url = `${API_BASE}/bucket/${SRC_DIR}/${code}.geojsonl`;
	const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
	if (!res.ok) throw new Error(`fetch ${code}: HTTP ${res.status}`);
	const buf  = Buffer.from(await res.arrayBuffer());
	const text = (buf[0] === 0x1f && buf[1] === 0x8b)
		? (await gunzipAsync(buf)).toString('utf8')
		: buf.toString('utf8');

	const features = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
	if (!features.length) throw new Error('features が空');

	const entry = manifest.find(e => e.prefCityCd === code);
	const meta  = {
		name:        `maff_${code}`,
		description: entry ? `筆ポリゴン ${entry.prefName} ${entry.cityName} ${entry.year}年度` : '',
		license:     'CC BY 4.0',
		attribution: '農林水産省 筆ポリゴン',
	};

	const raw = encodeGeoPBF(features, meta);
	await dstBucket.put(
		`maff_${code}.geopbf`,
		new File([raw], `maff_${code}.geopbf`, { type: 'application/x-geopbf' })
	);

	done.add(code);
	return 'ok';
}

async function main() {
	const manifest = JSON.parse(readFileSync(join(__dir, 'manifest.json')));
	let targets = manifest.map(e => e.prefCityCd);
	if (ONLY)      targets = targets.filter(c => c === ONLY);
	else if (ONLY_PREF) targets = targets.filter(c => c.startsWith(ONLY_PREF));

	console.log(`対象: ${targets.length} 件`);
	if (DRY_RUN) { console.log('[dry-run]'); return; }

	const dstBucket = await Bucket(DST_DIR, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });

	let ok = 0, skip = 0, err = 0;

	for (let i = 0; i < targets.length; i++) {
		const code  = targets[i];
		const label = `[${i+1}/${targets.length}] maff_${code}`;
		try {
			const result = await processCode(code, manifest, dstBucket);
			if (result === 'skip') { skip++; process.stdout.write(`\r  ⏭ ${label}    `); }
			else                   { ok++;   process.stdout.write(`\r  ✓ ${label}    `); }
			if ((ok + err) % 20 === 0) saveProgress();
		} catch (e) {
			err++;
			console.error(`\n  ✗ ${label}: ${e.message}`);
		}
	}

	saveProgress();
	console.log(`\n\n✅ 完了: ok=${ok} skip=${skip} err=${err}`);
}

main().catch(console.error);
