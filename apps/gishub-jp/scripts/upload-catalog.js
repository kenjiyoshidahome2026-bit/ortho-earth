/**
 * カタログデータをサーバー（native-bucket）にアップロードする
 *
 * 入力:
 *   catalog.json          — 属性・ライセンス (make-catalog-json.js で生成)
 *   catalog-geojson.csv   — GISファイル一覧 (extract-geojson.js で生成)
 *
 * 出力 (native-bucket の catalog/ ディレクトリ):
 *   catalog/index.json              — 軽量インデックス（一覧表示用）
 *   catalog/{dataset_code}.json     — データセット詳細（属性・ファイル一覧）
 *
 * 使い方:
 *   node upload-catalog.js
 *   node upload-catalog.js --dry-run   # アップロードせずに生成内容を確認
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Bucket } from '../../../packages/native-bucket/src/Bucket.js';
import xlsx from 'xlsx';
import { pool } from './pool.js';
const __dir = dirname(fileURLToPath(import.meta.url));

const CODELIST_CACHE_FILE = join(__dir, 'codelist-cache.json');

const API_BASE = 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const BUCKET_DIR = 'catalog';
const CONCURRENCY = 4;
const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// CSV パーサー（BOM対応・ダブルクォート対応）
// ---------------------------------------------------------------------------
function parseCSV(text) {
	const lines = text.replace(/^﻿/, '').split('\n').filter(Boolean);
	const headers = splitCSVLine(lines[0]);
	return lines.slice(1).map(line => {
		const vals = splitCSVLine(line);
		return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
	});
}

function splitCSVLine(line) {
	const result = [];
	let cur = '', inQ = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') {
			if (inQ && line[i+1] === '"') { cur += '"'; i++; }
			else inQ = !inQ;
		} else if (c === ',' && !inQ) {
			result.push(cur); cur = '';
		} else {
			cur += c;
		}
	}
	result.push(cur);
	return result;
}

// ---------------------------------------------------------------------------
// コードリスト パーサー（Node.js 用）
// ---------------------------------------------------------------------------
function stripTags(s) {
	return s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').trim();
}

function parseCodelistHtml(html) {
	const result = [];
	const tableMatch = html.match(/<table[\s\S]*?>([\s\S]*?)<\/table>/i);
	if (!tableMatch) return result;
	const rows = tableMatch[1].match(/<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi) || [];
	if (rows.length < 2) return result;

	// ヘッダー行でコード列を検出
	const heads = (rows[0].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map(stripTags);
	let codeCol = heads.findIndex(h => /コード$/.test(h) && !/改定/.test(h));
	if (codeCol < 0) codeCol = heads.findIndex(h => /^code$/i.test(h));
	if (codeCol < 0) codeCol = 0; // fallback

	let labelCol = -1;
	for (let j = codeCol + 1; j < heads.length; j++) { if (heads[j]) { labelCol = j; break; } }
	if (labelCol < 0) {
		for (let j = 0; j < heads.length; j++) { if (j !== codeCol && heads[j]) { labelCol = j; break; } }
	}
	if (labelCol < 0) return result;

	for (let i = 1; i < rows.length; i++) {
		const cells = (rows[i].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map(stripTags);
		const code = cells[codeCol] || '', label = cells[labelCol] || '';
		if (code && label && /\S/.test(code)) result.push({ code, label });
	}
	return result;
}

function parseCodelistXlsx(buf) {
	const wb = xlsx.read(buf, { type: 'buffer' });
	const ws = wb.Sheets[wb.SheetNames[0]];
	const data = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
	for (let i = 0; i < data.length; i++) {
		const row = data[i].map(c => String(c).trim());
		let codeCol = row.findIndex(h => /コード$/.test(h) && !/改定/.test(h));
		if (codeCol < 0) codeCol = row.findIndex(h => /^code$/i.test(h));
		if (codeCol < 0) continue;
		const result = [];
		for (let k = i + 1; k < data.length; k++) {
			const cells = data[k].map(c => String(c).trim());
			const code = cells[codeCol] || '';
			// 最後の非空セルを採用（市区町村名など最も詳細なラベル列を得る）
			const label = cells.slice(codeCol + 1).filter(c => c).pop() || '';
			if (code && label) result.push({ code, label });
		}
		if (result.length) return result;
	}
	return [];
}

// ---------------------------------------------------------------------------
// コードリストキャッシュ: CSV文字列形式（TSV: "code\tlabel\n..."）で保存
// ---------------------------------------------------------------------------
function entriesToCsv(entries) {
	return entries.map(e => `${e.code}\t${e.label}`).join('\n');
}

function csvToEntries(csv) {
	return csv.split('\n').filter(Boolean).map(line => {
		const idx = line.indexOf('\t');
		if (idx < 0) return null;
		return { code: line.slice(0, idx), label: line.slice(idx + 1) };
	}).filter(Boolean);
}

function loadDiskCache() {
	if (!existsSync(CODELIST_CACHE_FILE)) return {};
	const raw = JSON.parse(readFileSync(CODELIST_CACHE_FILE, 'utf8'));
	// 旧フォーマット（配列）→ CSV文字列に正規化
	const out = {};
	for (const [url, val] of Object.entries(raw)) {
		if (val === null)                { out[url] = null; }
		else if (typeof val === 'string') { out[url] = val; }
		else if (Array.isArray(val))      { out[url] = entriesToCsv(val); }
	}
	return out;
}

// コードリストURLを一括取得（ローカルキャッシュ付き、レート制限対策）
async function fetchAllCodelists(catalog) {
	const urls = new Set();
	for (const ds of catalog)
		for (const a of ds.attributes || [])
			if (a.codelist) urls.add(a.codelist);

	// ローカルキャッシュ読み込み（TSV文字列形式）
	const diskCache = loadDiskCache();

	const urlList = [...urls];
	const missing = urlList.filter(u => !(u in diskCache));
	console.log(`\nコードリスト: ${urlList.length} URL (キャッシュ済み: ${urlList.length - missing.length}, 取得対象: ${missing.length})`);

	// 未取得URLを1件ずつ 1.2秒間隔で取得（レート制限対策）
	let done = 0;
	for (const url of missing) {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			let entries;
			if (url.endsWith('.xlsx')) {
				const buf = Buffer.from(await res.arrayBuffer());
				entries = parseCodelistXlsx(buf);
			} else {
				const buf = Buffer.from(await res.arrayBuffer());
				// 文字コード判定: BOM → UTF-8確定、なければmeta/Content-Type → 最終手段はバイト列判定
				const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
				let encoding = 'utf-8';
				if (!hasBom) {
					// 優先順位: HTTPヘッダー > meta charset > バイト列判定
					const ctCharset = (res.headers.get('content-type') || '').match(/charset=([^\s;]+)/i)?.[1] || '';
					if (/shift.?jis/i.test(ctCharset)) {
						encoding = 'shift-jis';
					} else if (/utf-?8/i.test(ctCharset)) {
						encoding = 'utf-8'; // HTTPヘッダーでUTF-8確定 → meta charsetは無視
					} else {
						// HTTPヘッダーにcharset宣言なし → meta charsetを参照
						const head = buf.slice(0, 2048).toString('latin1');
						const metaCharset = head.match(/charset=[\"']?([^\"';\s>]+)/i)?.[1] || '';
						if (/shift.?jis/i.test(metaCharset)) {
							encoding = 'shift-jis';
						} else if (!/utf-?8/i.test(metaCharset)) {
							// 宣言なし: Shift-JIS 特有バイト(0x81-0x9F, 0xE0-0xFC)の出現率で判定
							let sjisScore = 0;
							for (let i = 0; i < Math.min(buf.length - 1, 4096); i++) {
								const b = buf[i];
								if ((b >= 0x81 && b <= 0x9F) || (b >= 0xE0 && b <= 0xFC)) sjisScore++;
							}
							if (sjisScore > 10) encoding = 'shift-jis';
						}
					}
				}
				const text = new TextDecoder(encoding).decode(buf);
				entries = parseCodelistHtml(text);
				// CAPTCHAページ検出（テーブルが返らなかった場合は再試行なし・null保存しない）
				if (!entries.length && text.includes('zenedge')) {
					process.stdout.write(`\r  [CAPTCHA] ${url.split('/').pop().slice(0, 50)}\n`);
					done++;
					await new Promise(r => setTimeout(r, 1200));
					continue;
				}
			}
			diskCache[url] = entries.length ? entriesToCsv(entries) : null;
		} catch (e) {
			diskCache[url] = null;
		}
		done++;
		process.stdout.write(`\r  [${String(done).padStart(3)}/${missing.length}] ${url.split('/').pop().slice(0, 48).padEnd(50)}`);
		await new Promise(r => setTimeout(r, 1200));
	}
	if (missing.length) {
		writeFileSync(CODELIST_CACHE_FILE, JSON.stringify(diskCache, null, 2));
		console.log(`\n  キャッシュ保存: ${CODELIST_CACHE_FILE}`);
	}

	// TSV文字列 → {code, label}[] に変換してMapで返す
	const cache = new Map();
	for (const [url, val] of Object.entries(diskCache)) {
		cache.set(url, typeof val === 'string' ? csvToEntries(val) : val);
	}
	const found = [...cache.values()].filter(Boolean).length;
	console.log(`  パース成功: ${found}/${urlList.length}`);
	return cache;
}

// ---------------------------------------------------------------------------
// JSON → gzip Blob（native-bucket の put() に渡す用）
// ---------------------------------------------------------------------------
async function jsonBlob(obj) {
	const text = JSON.stringify(obj);
	return new Blob([text], { type: 'application/json' });
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
	// --- データ読み込み ---
	console.log('データ読み込み中...');
	const catalog = JSON.parse(readFileSync(join(__dir, 'catalog.json'), 'utf8'));
	const csvRows = parseCSV(readFileSync(join(__dir, 'catalog-geojson.csv'), 'utf8'));

	// L03-b_r（ラスタ版）: 変換済みWebPカタログがあれば CSV の TIF エントリを上書き
	const L03BR_CATALOG_FILE = join(__dir, 'l03b-r-catalog.json');
	const l03brByCode = {};
	if (existsSync(L03BR_CATALOG_FILE)) {
		const l03brCatalog = JSON.parse(readFileSync(L03BR_CATALOG_FILE, 'utf8'));
		l03brByCode['L03-b_r'] = Object.entries(l03brCatalog).map(([meshCode, meta]) => ({
			scope:         '1次メッシュ',
			location_code: meshCode,
			format:        'webp',
			target:        `${API_BASE}/bucket/l03b-r/${meta.file}`,
			bbox:          meta.bbox,
			width:         meta.width,
			height:        meta.height,
		}));
		console.log(`L03-b_r WebP: ${l03brByCode['L03-b_r'].length} 件`);
	}

	// CSV を dataset_code でグループ化
	const filesByCode = { ...l03brByCode };
	for (const row of csvRows) {
		// 旧日本測地系（TKY）ファイルは除外
		if (row.coord_sys?.toUpperCase() === 'TKY') continue;
		// L03-b_r は上記 WebP カタログで置換済み
		if (l03brByCode['L03-b_r'] && row.dataset_code === 'L03-b_r') continue;
		const code = row.dataset_code;
		if (!filesByCode[code]) filesByCode[code] = [];
		// target を url#filename 形式に正規化（ZIP内フルパスを basename に短縮）
		const [zipUrl, filePath] = row.target.split('#');
		const fileName = filePath ? filePath.split('/').pop() : null;
		const target   = fileName ? `${zipUrl}#${fileName}` : zipUrl;

		filesByCode[code].push({
			year:          row.year ? parseInt(row.year) : null,
			scope:         row.scope,
			pref_code:     row.pref_code   || undefined,
			location_code: row.location_code || undefined,
			coord_sys:     row.coord_sys   || undefined,
			format:        row.format,
			target,
		});
		// undefinedキーを削除してJSONを軽量化
		const last = filesByCode[code].at(-1);
		for (const k of Object.keys(last)) if (last[k] === undefined || last[k] === '') delete last[k];
	}

	// --- per-dataset オブジェクト構築 ---
	const datasets = catalog.map(ds => {
		const files = filesByCode[ds.dataset_code] || [];
		const formats = [...new Set(files.map(f => f.format))].sort();
		return {
			detail: {
				dataset_code: ds.dataset_code,
				title:        ds.title,
				license:      ds.license,
				page_url:     ds.page_url,
				attributes:   ds.attributes,
				codelist:     ds.codelist,
				files,
			},
			index: {
				dataset_code: ds.dataset_code,
				title:        ds.title,
				license:      ds.license,
				formats,
				file_count:   files.length,
				attr_count:   Object.keys(ds.attributes || {}).length,
			},
		};
	});

	// index.json
	const indexData = datasets.map(d => d.index);

	console.log(`データセット数: ${datasets.length}`);
	console.log(`GISファイル数: ${csvRows.length}`);
	const fmtCounts = {};
	for (const r of csvRows) fmtCounts[r.format] = (fmtCounts[r.format] || 0) + 1;
	console.log(`フォーマット内訳: ${JSON.stringify(fmtCounts)}`);

	if (DRY_RUN) {
		console.log('\n[DRY RUN] アップロードをスキップします');
		console.log('index.json サンプル:', JSON.stringify(indexData.slice(0, 2), null, 2));
		const sample = datasets[0].detail;
		console.log(`\n${sample.dataset_code}.json サンプル (files先頭3件):`, JSON.stringify({
			...sample, files: sample.files.slice(0, 3),
			attributes: Object.fromEntries(Object.entries(sample.attributes || {}).slice(0, 3)),
		}, null, 2));
		return;
	}

	// --- バケット接続 ---
	console.log('\nバケット接続中...');
	const bucket = await Bucket(BUCKET_DIR, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
	if (!bucket) { console.error('バケット接続失敗'); process.exit(1); }
	console.log('接続OK\n');

	// --- index.json アップロード ---
	process.stdout.write('index.json をアップロード中... ');
	await bucket.put('index.json', await jsonBlob(indexData));
	console.log('✓');

	// --- per-dataset JSON アップロード（並列） ---
	let done = 0;
	const total = datasets.length;
	const results = await pool(datasets, CONCURRENCY, async ({ detail }) => {
		const name = `${detail.dataset_code}.json`;
		await bucket.put(name, await jsonBlob(detail));
		done++;
		process.stdout.write(`\r[${String(done).padStart(3)}/${total}] ${name.padEnd(20)}`);
		return { name, ok: true };
	});

	const failed = results.filter(r => r?.error);
	console.log(`\n\n✅ アップロード完了`);
	console.log(`   index.json + ${datasets.length - failed.length}/${datasets.length} データセット`);
	if (failed.length) {
		console.log(`\n⚠️  失敗 ${failed.length}件:`);
		failed.forEach(r => console.log(`   ${r.error}`));
	}
}

main().catch(console.error);
