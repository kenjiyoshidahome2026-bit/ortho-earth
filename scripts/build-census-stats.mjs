/**
 * build-census-stats.mjs
 * 2020年国勢調査（産業・職業・世帯）+ 2025年人口速報集計を統合して
 * census-manifest.json と census-stats.json を生成する。
 *
 * データソース（認証不要）:
 *   人口速報集計: e-Stat statInfId=000040454825 (Excel, 2025年10月)
 *   産業別就業者: e-Stat GIS statsId=T001103 (2020年国勢調査小地域集計)
 *   職業別就業者: e-Stat GIS statsId=T001104
 *   世帯経済構成: e-Stat GIS statsId=T001106
 *
 * Usage:
 *   node scripts/build-census-stats.mjs
 *   node scripts/build-census-stats.mjs --pop-only   # 人口だけ
 *   node scripts/build-census-stats.mjs --no-upload  # ローカル確認のみ
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import * as XLSX from 'xlsx';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(__dir, '../apps/catalog');

const ESTAT_BASE   = 'https://www.e-stat.go.jp/';
const POP_INF_ID   = '000040454825';  // 2025年 人口速報集計 Excel
const GIS_URL      = (pref, id) =>
  `${ESTAT_BASE}gis/statmap-search/data?statsId=${id}&downloadType=2&code=${pref}`;

const PREFS = Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, '0'));

// T-code → [label, columns...]
const GIS_TABLES = {
  T001103: {
    label: '産業別就業者',
    cols: [
      '就業者総数','農業・林業','うち農業','漁業','鉱業・採石業・砂利採取業',
      '建設業','製造業','電気・ガス・熱供給・水道業','情報通信業','運輸業・郵便業',
      '卸売業・小売業','金融業・保険業','不動産業・物品賃貸業',
      '学術研究・専門・技術サービス業','宿泊業・飲食サービス業',
      '生活関連サービス業・娯楽業','教育・学習支援業','医療・福祉',
      '複合サービス事業','サービス業(他分類外)','公務(他分類外)','分類不能',
      '就業者総数(不詳含む)','雇用者(役員含む)','自営業主(家内職含む)','家族従業者',
    ],
  },
  T001104: {
    label: '職業別就業者',
    cols: [
      '就業者総数','管理的職業','専門的・技術的職業','事務従事者','販売従事者',
      'サービス職業','保安職業','農林漁業従事者','生産工程従事者',
      '輸送・機械運転従事者','建設・採掘従事者','運搬・清掃・包装等従事者','分類不能',
    ],
  },
  T001106: {
    label: '世帯経済構成',
    cols: [
      '一般世帯総数','農林漁業就業者世帯','農林漁業・非農林漁業混合世帯',
      '非農林漁業就業者世帯','非就業者世帯','分類不能世帯',
    ],
  },
};

// ── utils ──────────────────────────────────────────────────────────────────
function toInt(v) {
  if (v == null || v === '') return 0;
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

// ── 2025年人口速報集計 Excel → Map<code5, {pop:[], hh, pop2020, popChange}> ──
async function fetchPopulation2025() {
  process.stderr.write('人口速報集計 (2025) をダウンロード...\n');
  const url = `${ESTAT_BASE}stat-search/file-download?statInfId=${POP_INF_ID}&fileKind=0`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: ESTAT_BASE },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`人口速報集計 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const wb  = XLSX.read(buf, { type: 'buffer' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // col[2] = "XXXXX_..." or "XXXXX_市区町村名"
  const map = new Map();
  for (const row of rows) {
    const loc = String(row[2] || '');
    const m   = loc.match(/^(\d{5})_/);
    if (!m) continue;
    const code = m[1];
    map.set(code, {
      pop:       [toInt(row[3]), toInt(row[4]), toInt(row[5])],  // 総数,男,女
      pop2020:   toInt(row[6]),
      popChange: typeof row[8] === 'number' ? +row[8].toFixed(2) : 0,
      hh:        toInt(row[12]),
      hh2020:    toInt(row[13]),
      area:      typeof row[10] === 'number' ? +row[10].toFixed(2) : 0,
      density:   typeof row[11] === 'number' ? Math.round(row[11]) : 0,
    });
  }
  process.stderr.write(`  → ${map.size} 市区町村\n`);
  return map;
}

// ── 2020年 GIS 統計データ (T001103/4/6) → Map<code5, int[]> ──────────────
async function fetchGisTable(statsId, pref) {
  const url = GIS_URL(pref, statsId);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const buf  = Buffer.from(await res.arrayBuffer());
  const zip  = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.match(/\.(csv|txt)$/i));
  if (!entry) return null;
  const text  = iconv.decode(entry.getData(), 'shift_jis');
  const lines = text.split('\n');

  const map = new Map();
  for (let i = 2; i < lines.length; i++) {
    const cols = lines[i].split(',');
    // KEY_CODE,HYOSYO,CITYNAME,NAME,HTKSYORI,HTKSAKI,GASSAN,data...
    const code   = cols[0];
    const hyosyo = cols[1];
    if (!code || !/^\d{5}$/.test(code) || hyosyo !== '1') continue;
    const vals = cols.slice(7).map(toInt);
    map.set(code, vals);
  }
  return map;
}

async function fetchAllGisTables() {
  const results = {};
  for (const tableId of Object.keys(GIS_TABLES)) {
    results[tableId] = new Map();
  }

  let done = 0;
  for (const pref of PREFS) {
    await Promise.all(
      Object.keys(GIS_TABLES).map(async tableId => {
        const m = await fetchGisTable(tableId, pref);
        if (m) for (const [k, v] of m) results[tableId].set(k, v);
      })
    );
    progress(++done, PREFS.length, '2020 GIS統計');
  }

  for (const tableId of Object.keys(GIS_TABLES)) {
    process.stderr.write(`  ${tableId} (${GIS_TABLES[tableId].label}): ${results[tableId].size} 市区町村\n`);
  }
  return results;
}

// ── manifest: 市区町村一覧 ────────────────────────────────────────────────
function buildManifest(popMap, prefNameMap) {
  const manifest = [];
  for (const [code, p] of popMap) {
    if (code === '00000') continue;
    const prefCode = code.slice(0, 2);
    const name     = prefNameMap.get(code) || '';
    manifest.push({
      code,
      pref:    prefCode,
      prefName: prefNameMap.get(prefCode + '000') || '',
      name,
      pop:     p.pop[0],
      male:    p.pop[1],
      female:  p.pop[2],
      hh:      p.hh,
      area:    p.area,
      density: p.density,
    });
  }
  manifest.sort((a, b) => a.code < b.code ? -1 : 1);
  return manifest;
}

// ── stats: 産業・職業データを municipality ごとに統合 ─────────────────────
function buildStats(popMap, gisTables) {
  const stats = {};
  for (const [code, p] of popMap) {
    if (code === '00000') continue;
    const entry = {
      pop:       p.pop,
      pop2020:   p.pop2020,
      popChange: p.popChange,
      hh:        p.hh,
      hh2020:    p.hh2020,
    };
    for (const tableId of Object.keys(GIS_TABLES)) {
      const row = gisTables[tableId].get(code);
      if (row) entry[tableId] = row;
    }
    stats[code] = entry;
  }
  return stats;
}

// ── main ──────────────────────────────────────────────────────────────────
const popMap     = await fetchPopulation2025();
const gisTables  = await fetchAllGisTables();

// 市区町村名マップを速報Excelから再構築
const nameMap = new Map();
{
  const url = `${ESTAT_BASE}stat-search/file-download?statInfId=${POP_INF_ID}&fileKind=0`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: ESTAT_BASE } });
  const buf  = Buffer.from(await res.arrayBuffer());
  const wb   = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  for (const row of rows) {
    const loc = String(row[2] || '');
    const m   = loc.match(/^(\d{5})_(.+)/);
    if (!m) continue;
    nameMap.set(m[1], m[2].trim());
  }
}

const manifest = buildManifest(popMap, nameMap);
const stats    = buildStats(popMap, gisTables);

const manifestPath = path.join(CATALOG, 'census-manifest.json');
const statsPath    = path.join(CATALOG, 'census-stats.json');

fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');
fs.writeFileSync(statsPath,    JSON.stringify(stats)    + '\n');

const mSize = (fs.statSync(manifestPath).size / 1024).toFixed(0);
const sSize = (fs.statSync(statsPath).size / 1024).toFixed(0);

console.log(`\n✅ 完了`);
console.log(`  census-manifest.json: ${manifest.length} 市区町村 (${mSize} KB)`);
console.log(`  census-stats.json:    ${Object.keys(stats).length} 件 (${sSize} KB)`);
console.log(`\nカラム定義:`);
for (const [id, t] of Object.entries(GIS_TABLES)) {
  console.log(`  ${id} (${t.label}): ${t.cols.join(', ')}`);
}
