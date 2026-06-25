/**
 * build-census-svg.mjs
 * census-{year}-stats.json → 市区町村ごとの SVG チャートファイルを生成する。
 * チャート生成ロジックは apps/catalog/census-charts.mjs を共用。
 *
 * Usage:
 *   node scripts/build-census-svg.mjs              # 2020年
 *   node scripts/build-census-svg.mjs --year 2015  # 2015年
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCensusChartSVG } from '../apps/catalog/census-charts.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(__dir, '..');
const YEAR  = process.argv.includes('--year') ? process.argv[process.argv.indexOf('--year') + 1] : '2020';
const OUT   = path.join(__dir, 'out', 'census', YEAR);
const STATS = path.join(ROOT, 'apps/catalog', `census-${YEAR}-stats.json`);

const stats = JSON.parse(fs.readFileSync(STATS, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const codes = Object.keys(stats);
let done = 0, skipped = 0;

for (const code of codes) {
  const svg = buildCensusChartSVG(stats[code], YEAR);
  if (!svg) { skipped++; continue; }
  fs.writeFileSync(path.join(OUT, `${code}.svg`), '<?xml version="1.0" encoding="UTF-8"?>\n' + svg);
  done++;
  if (done % 200 === 0) process.stderr.write(`  ${done}/${codes.length} ...\n`);
}

console.log(`\n✅ 完了: ${done} SVG 生成 (${skipped} スキップ) → ${OUT}`);
