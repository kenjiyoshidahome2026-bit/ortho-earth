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
import { Bucket } from '../../packages/native-bucket/src/Bucket.js';
import xlsx from 'xlsx';

const CODELIST_CACHE_FILE = 'codelist-cache.json';

const API_BASE = 'https://api.ortho-earth.com';
const API_KEY  = '***REMOVED***';
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
// 並列処理
// ---------------------------------------------------------------------------
async function pool(items, limit, fn) {
  const queue = [...items];
  let active = 0, idx = 0;
  const results = new Array(items.length);
  return new Promise(resolve => {
    function next() {
      while (active < limit && queue.length) {
        active++;
        const i = idx++, item = queue.shift();
        fn(item, i)
          .then(r  => { results[i] = r; })
          .catch(e => { results[i] = { error: e.message }; })
          .finally(() => { active--; next(); if (!active && !queue.length) resolve(results); });
      }
      if (!active && !queue.length) resolve(results);
    }
    next();
  });
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
    let labelCol = -1;
    for (let j = codeCol + 1; j < row.length; j++) { if (row[j]) { labelCol = j; break; } }
    if (labelCol < 0) labelCol = codeCol + 1;
    const result = [];
    for (let k = i + 1; k < data.length; k++) {
      const cells = data[k].map(c => String(c).trim());
      const code = cells[codeCol] || '', label = cells[labelCol] || '';
      if (code && label) result.push({ code, label });
    }
    if (result.length) return result;
  }
  return [];
}

// コードリストURLを一括取得（ローカルキャッシュ付き、レート制限対策）
async function fetchAllCodelists(catalog) {
  const urls = new Set();
  for (const ds of catalog)
    for (const a of ds.attributes || [])
      if (a.codelist) urls.add(a.codelist);

  // ローカルキャッシュ読み込み
  const diskCache = existsSync(CODELIST_CACHE_FILE)
    ? JSON.parse(readFileSync(CODELIST_CACHE_FILE, 'utf8'))
    : {};

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
        // HTMLメタタグを優先（サーバーがContent-Type: utf-8を返しても実体はSJISなケースがある）
        const head = buf.slice(0, 1024).toString('latin1');
        const metaMatch = head.match(/charset=[\"']?([^\"';\s>]+)/i);
        const charset = metaMatch ? metaMatch[1] : (res.headers.get('content-type') || '');
        const encoding = /shift.?jis/i.test(charset) ? 'shift-jis' : 'utf-8';
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
      diskCache[url] = entries.length ? entries : null;
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

  const cache = new Map(Object.entries(diskCache));
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
  const catalog = JSON.parse(readFileSync('catalog.json', 'utf8'));
  const csvRows = parseCSV(readFileSync('catalog-geojson.csv', 'utf8'));

  // CSV を dataset_code でグループ化
  const filesByCode = {};
  for (const row of csvRows) {
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
        license_raw:  ds.license_raw,
        page_url:     ds.page_url,
        attributes:   ds.attributes,
        files,
      },
      index: {
        dataset_code: ds.dataset_code,
        title:        ds.title,
        license:      ds.license,
        formats,
        file_count:   files.length,
        attr_count:   ds.attributes.length,
      },
    };
  });

  // index.json
  const indexData = datasets.map(d => d.index);

  // --- コードリスト一括取得 ---
  const clCache = DRY_RUN ? new Map() : await fetchAllCodelists(catalog);

  // 属性の codelist を URL → パース済み配列 に置換
  for (const { detail } of datasets) {
    for (const a of detail.attributes || []) {
      if (!a.codelist) continue;
      const parsed = clCache.get(a.codelist);
      a.codelist = parsed || undefined; // nullの場合は削除
      if (a.codelist === undefined) delete a.codelist;
    }
  }

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
      ...sample, files: sample.files.slice(0, 3), attributes: sample.attributes.slice(0, 2)
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
