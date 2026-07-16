/**
 * ui/counts.json 生成 — サイドバー/プレースホルダ用の件数メタ
 *
 * 重いマニフェスト（moj 1.7MB / maff 242KB / estat 148KB）を初期バンドルに
 * 引きずり込まないため、件数だけを軽量JSONに焼き出す。
 * 各省庁のバッチ（moj-batch / maff-batch / estat-batch）でマニフェストを更新したら再実行する。
 *
 * 使い方: node scripts/gen-counts.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const app   = join(__dir, '..');
const read  = p => JSON.parse(readFileSync(join(app, p), 'utf8'));

const mojManifest = read('moj/manifest.json');
const counts = {
    moj:   new Set(mojManifest.map(e => e.cityCode)).size,   // moj/ui.js MOJ_CITIES.size と同一定義
    maff:  read('maff/manifest.json').length,
    estat: read('estat/manifest.json').length,
};

writeFileSync(join(app, 'ui/counts.json'), JSON.stringify(counts) + '\n');
console.log('ui/counts.json:', counts);
