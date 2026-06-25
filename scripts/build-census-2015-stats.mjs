/**
 * build-census-2015-stats.mjs
 * 2015年国勢調査 GIS データ（認証不要）から census-2015-stats.json を生成する。
 *
 * T-code:
 *   T000848 … 人口総数・世帯数     (4 cols: 人口,男,女,世帯)
 *   T00865  … 産業別就業者         (25 cols: 2020 T001103の26列より「就業者不詳含む」1列少ない)
 *   T00866  … 職業別就業者         (13 cols: 2020 T001104 と同じ)
 *   T00875  … 世帯経済構成         (6 cols:  2020 T001106 と同じ)
 *
 * Usage:
 *   node scripts/build-census-2015-stats.mjs
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import iconv  from 'iconv-lite';

const __dir  = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(__dir, '../apps/catalog');
const PREFS   = Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, '0'));
const BASE    = 'https://www.e-stat.go.jp/gis/statmap-search/data';

const TABLES = {
  pop: 'T000848',   // 人口総数・世帯数
  ind: 'T00865',    // 産業別就業者
  occ: 'T00866',    // 職業別就業者
  eco: 'T00875',    // 世帯経済構成
};

function toInt(v) {
  if (v == null || v === '' || v === '-' || v === 'X') return 0;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/,/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function progress(done, total, label) {
  const pct  = Math.round(done / total * 100);
  const fill = Math.floor(pct / 5);
  const bar  = '█'.repeat(fill) + '░'.repeat(20 - fill);
  process.stderr.write(`\r${label}: [${bar}] ${pct}% (${done}/${total})`);
  if (done === total) process.stderr.write('\n');
}

// GIS ZIP をダウンロードして HYOSYO=1（市区町村）行を Map<code5, int[]> に変換
async function fetchTable(statsId, pref, dataStart = 7) {
  const url = `${BASE}?statsId=${statsId}&downloadType=2&code=${pref}`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;

  const buf   = Buffer.from(await res.arrayBuffer());
  const zip   = new AdmZip(buf);
  const entry = zip.getEntries().find(e => /\.(csv|txt)$/i.test(e.entryName));
  if (!entry) return null;

  const text  = iconv.decode(entry.getData(), 'shift_jis');
  const lines = text.split('\n');
  const map   = new Map();

  for (let i = 2; i < lines.length; i++) {
    const cols   = lines[i].split(',');
    const code   = cols[0];
    const hyosyo = cols[1];
    if (!code || !/^\d{5}$/.test(code) || hyosyo !== '1') continue;
    map.set(code, cols.slice(dataStart).map(toInt));
  }
  return map;
}

// 全47都道府県分を取得して結合
async function fetchAll(statsId, dataStart = 7) {
  const result = new Map();
  let done = 0;
  for (const pref of PREFS) {
    const m = await fetchTable(statsId, pref, dataStart);
    if (m) for (const [k, v] of m) result.set(k, v);
    progress(++done, PREFS.length, `  ${statsId}`);
  }
  return result;
}

// ── main ─────────────────────────────────────────────────────────────────────
process.stderr.write('2015年国勢調査 GIS データ取得\n');

const popMap = await fetchAll(TABLES.pop);
const indMap = await fetchAll(TABLES.ind);
const occMap = await fetchAll(TABLES.occ);
const ecoMap = await fetchAll(TABLES.eco);

process.stderr.write(`\n市区町村数: pop=${popMap.size}, ind=${indMap.size}, occ=${occMap.size}, eco=${ecoMap.size}\n`);

// 統合
const stats = {};
for (const [code, pop] of popMap) {
  const entry = {
    pop: [pop[0], pop[1], pop[2]],   // 人口総数, 男, 女
    hh:  pop[3],                      // 世帯総数
  };
  const ind = indMap.get(code);
  const occ = occMap.get(code);
  const eco = ecoMap.get(code);
  if (ind) entry.ind = ind;  // 25 cols (2020は26列, col[22]「不詳含む」なし)
  if (occ) entry.occ = occ;  // 13 cols
  if (eco) entry.eco = eco;  // 6 cols
  stats[code] = entry;
}

const outPath = path.join(CATALOG, 'census-2015-stats.json');
fs.writeFileSync(outPath, JSON.stringify(stats) + '\n');

const sz    = (fs.statSync(outPath).size / 1024).toFixed(0);
const match = Object.values(stats).filter(s => s.ind).length;
console.log(`\n✅ 完了`);
console.log(`  census-2015-stats.json: ${Object.keys(stats).length} 市区町村 (${sz} KB)`);
console.log(`  産業データあり: ${match} / ${popMap.size}`);
console.log('\n列構造メモ:');
console.log('  ind[0..21]: 産業別 (2020と同じ)');
console.log('  ind[22]: 雇用者(役員含む)  ← 2020では ind[23]');
console.log('  ind[23]: 自営業主(家内職含む) ← 2020では ind[24]');
console.log('  ind[24]: 家族従業者        ← 2020では ind[25]');
