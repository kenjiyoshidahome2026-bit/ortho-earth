// 農水省 筆ポリゴンの在庫コード表を gishub-jp の正本から焼き出す（node scripts/gen-maff-codes.mjs）。
// manifest（MAFF API の全市区町村）∩ geopbf-progress（bucket GIS/pbf へ焼き済み）＝
// maff_{6桁コード}.geopbf が実在する 6桁コード（検査数字付き）のみを出す。
// 農地の無い都心区などは焼き自体が無い＝in-memory 判定で 404 を一切撒かない（moj probe と違い網羅表が持てる）。
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const MAFF_DIR = join(__dir, '../../gishub-jp/maff');

const manifest = JSON.parse(readFileSync(join(MAFF_DIR, 'manifest.json')));
const baked = new Set(JSON.parse(readFileSync(join(MAFF_DIR, 'geopbf-progress.json'))));
const codes = manifest.map(e => e.prefCityCd).filter(c => baked.has(c)).sort();

writeFileSync(join(__dir, '../data/maff-codes.json'), JSON.stringify(codes));
console.log(`maff-codes.json: ${codes.length} 件（manifest ${manifest.length} − 未焼き ${manifest.length - codes.length}）`);
