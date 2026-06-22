import { readFileSync, writeFileSync } from 'fs';

function parseRow(line) {
  const m = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)","((?:[^"]|"")*)"$/);
  if (!m) return null;
  return {
    title: m[1].replace(/""/g, '"'),
    filename: m[2].replace(/""/g, '"'),
    url: m[3].replace(/""/g, '"'),
    raw: line
  };
}

// URLディレクトリから年度を抽出 (A19s-95, L03-b_r-14 等の非標準コードも対応)
function extractYear(url) {
  const m = url.match(/\/[^/]+-(\d{2,4})\//);
  if (!m) return -1;
  const y = parseInt(m[1]);
  if (m[1].length === 4) return y;
  return y >= 50 ? 1900 + y : 2000 + y;
}

// ファイル名を CODE-YEAR_SUFFIX に分解
// A19s-a-95_01_GML.zip → { base:'A19s-a', suffix:'_01_GML.zip' }
// L03-b-14_3036.zip    → { base:'L03-b',  suffix:'_3036.zip'   }
// N03-20260101_GML.zip → { base:'N03',     suffix:'_GML.zip'   }
// P28-22.zip           → { base:'P28',     suffix:'.zip'        }
function parseFilename(filename) {
  // アンダースコアあり: CODE-YEAR_SUFFIX
  const m = filename.match(/^(.+?)-\d{2,8}(_.*)/);
  if (m) {
    return {
      base: m[1],
      suffix: m[2].replace(/-jgd\d*/gi, '-jgd').replace(/-tky/gi, '')
    };
  }
  // アンダースコアなし: CODE-YEAR.ext
  const m2 = filename.match(/^(.+?)-\d{2,8}(\.\w+)$/);
  if (m2) return { base: m2[1], suffix: m2[2] };
  return { base: filename, suffix: '' };
}

const raw = readFileSync('catalog-downloads.csv', 'utf8').replace(/^﻿/, '');
const lines = raw.split('\n').filter(Boolean);
const header = lines[0];
const rows = lines.slice(1).map(parseRow).filter(Boolean);

// (title, baseCode, suffix) をキーとして最新年のエントリを保持
const groups = new Map();
for (const row of rows) {
  const { base, suffix } = parseFilename(row.filename);
  const year = extractYear(row.url);
  const key = `${row.title}|${base}|${suffix}`;

  const existing = groups.get(key);
  if (!existing || year > existing.year) {
    groups.set(key, { row, year });
  }
}

// パス1の結果行
let filtered = Array.from(groups.values()).map(v => v.row);

// パス2: tky/jgd 重複除去
// JGD（世界測地系）を優先。同一(title, meshCode)でJGDがあれば、TKY・無印を除外
const jgdSet = new Set();
for (const row of filtered) {
  const m = row.filename.match(/_(\d{4})-jgd\d*[_.]/i);
  if (m) jgdSet.add(`${row.title}|${m[1]}`);
}
const before2 = filtered.length;
filtered = filtered.filter(row => {
  // メッシュコードを持つファイルのみ対象
  const meshM = row.filename.match(/_(\d{4})([_.-])/);
  if (!meshM) return true;
  const meshKey = `${row.title}|${meshM[1]}`;
  if (!jgdSet.has(meshKey)) return true; // JGDなし → そのまま保持
  // JGDがある → JGDのみ残し、TKY・無印は除外
  return /-jgd\d*[_.]/i.test(row.filename);
});

// パス3: GEOJSONがあればGML/SHPを除外
// ファイル名末尾の _GML/_SHP/_GEOJSON を除いた部分をキーとする
function formatKey(row) {
  const base = row.filename.replace(/_(GML|SHP|GEOJSON)\.zip$/i, '');
  return `${row.title}|${base}`;
}
const geojsonSet = new Set();
for (const row of filtered) {
  if (/_GEOJSON\.zip$/i.test(row.filename)) geojsonSet.add(formatKey(row));
}
const before3 = filtered.length;
filtered = filtered.filter(row => {
  if (!/_(?:GML|SHP)\.zip$/i.test(row.filename)) return true;
  return !geojsonSet.has(formatKey(row));
});

// パス4: 全国ファイルがある(title, base)から地方区分(51-59)を除外
// 全国ファイル = ロケーションコードなし (例: _GML.zip, _GEOJSON.zip, .zip)
// 地方区分    = サフィックスが _5X_ or _5X. で始まる (例: _52_GML.zip, _52.zip)
const nationalSet = new Set();
for (const row of filtered) {
  const { base, suffix } = parseFilename(row.filename);
  if (/^_[A-Za-z]/.test(suffix) || /^\.\w+$/.test(suffix)) nationalSet.add(`${row.title}|${base}`);
}
const before4 = filtered.length;
filtered = filtered.filter(row => {
  const { base, suffix } = parseFilename(row.filename);
  if (!/^_5[1-9][_.]/.test(suffix)) return true;
  return !nationalSet.has(`${row.title}|${base}`);
});

const URL_PREFIX = 'https://nlftp.mlit.go.jp/ksj/gml/data/';
const result = [header, ...filtered.map(r =>
  r.raw.replace(`"${URL_PREFIX}`, '"')
)];
writeFileSync('catalog-downloads-latest.csv', '﻿' + result.join('\n'), 'utf8');

console.log(`元のCSV: ${rows.length} 行`);
console.log(`年度フィルタ後: ${groups.size} 行 (-${rows.length - groups.size})`);
console.log(`測地系フィルタ後: ${before3} 行 (-${before2 - before3})`);
console.log(`フォーマットフィルタ後: ${before4} 行 (-${before3 - before4})`);
console.log(`地方区分フィルタ後: ${filtered.length} 行 (-${before4 - filtered.length})`);
console.log(`合計削減: ${rows.length - filtered.length} 行`);
