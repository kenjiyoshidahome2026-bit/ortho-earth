/**
 * fetch-manifest-sizes.mjs
 * e-Stat・MAFF manifest に size フィールド（ダウンロードバイト数）を追加する。
 * Content-Length 非対応のため body をストリームで読んでカウントする。
 *
 * Usage:
 *   node scripts/fetch-manifest-sizes.mjs [--estat] [--maff] [--concurrency 20]
 *   node scripts/fetch-manifest-sizes.mjs           # 両方実行
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(__dir, '../apps/catalog');

const API_BASE   = 'https://api.ortho-earth.com';
const ESTAT_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';
const SURVEY     = 'A002005212020';

const args = process.argv.slice(2);
const doEstat = args.includes('--estat') || !args.some(a => a.startsWith('--'));
const doMaff  = args.includes('--maff')  || !args.some(a => a.startsWith('--'));
const CONC    = parseInt(args[args.indexOf('--concurrency') + 1] || '20');

// ── GET でストリームサイズ計測 ──────────────────────────────────
async function fetchSize(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 ortho-earth/manifest-builder', ...headers },
    });
    if (!res.ok) { await res.body?.cancel(); return null; }
    // Content-Length があれば読まずに終了（圧縮後サイズ）
    const cl = res.headers.get('content-length');
    if (cl) { await res.body?.cancel(); return parseInt(cl); }
    // なければストリームをカウント
    let size = 0;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
    }
    return size || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 並列キュー ─────────────────────────────────────────────────
async function runParallel(tasks, concurrency, onProgress) {
  const queue = [...tasks];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const task = queue.shift();
      await task();
      onProgress(++done, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function progress(done, total, label) {
  const pct  = Math.round(done / total * 100);
  const fill = Math.floor(pct / 5);
  const bar  = '█'.repeat(fill) + '░'.repeat(20 - fill);
  process.stderr.write(`\r${label}: [${bar}] ${pct}% (${done}/${total})`);
  if (done === total) process.stderr.write('\n');
}

// ── e-Stat ────────────────────────────────────────────────────
async function fetchEstatSizes() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CATALOG, 'estat-manifest.json'), 'utf8'));
  const results  = manifest.map(e => ({ ...e }));
  let errors = 0;

  const tasks = results.map((entry, i) => async () => {
    const url = `${ESTAT_BASE}?dlserveyId=${SURVEY}&code=${entry.code}&coordSys=1&format=shape&downloadType=5&datum=2011`;
    const size = await fetchSize(url);
    if (size) results[i].size = size; else errors++;
  });

  await runParallel(tasks, CONC, (d, t) => progress(d, t, 'e-Stat'));

  const out = path.join(CATALOG, 'estat-manifest.json');
  fs.writeFileSync(out, JSON.stringify(results) + '\n');
  const withSize = results.filter(e => e.size).length;
  console.log(`e-Stat: ${withSize}/${results.length} 取得 (${errors} エラー) → ${path.relative(process.cwd(), out)}`);
}

// ── MAFF ─────────────────────────────────────────────────────
async function fetchMaffSizes() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CATALOG, 'maff-manifest.json'), 'utf8'));
  const results  = manifest.map(e => ({ ...e }));
  let errors = 0;

  const tasks = results.map((entry, i) => async () => {
    const url = `${API_BASE}/bucket/GIS/pbf/maff_${entry.prefCityCd}.geopbf`;
    const size = await fetchSize(url);
    if (size) results[i].size = size; else errors++;
  });

  await runParallel(tasks, CONC, (d, t) => progress(d, t, 'MAFF  '));

  const out = path.join(CATALOG, 'maff-manifest.json');
  fs.writeFileSync(out, JSON.stringify(results) + '\n');
  const withSize = results.filter(e => e.size).length;
  console.log(`MAFF: ${withSize}/${results.length} 取得 (${errors} エラー) → ${path.relative(process.cwd(), out)}`);
}

// ── main ──────────────────────────────────────────────────────
console.log(`並列数: ${CONC}`);
if (doEstat) await fetchEstatSizes();
if (doMaff)  await fetchMaffSizes();
