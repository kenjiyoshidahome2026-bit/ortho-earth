/**
 * 法務省 登記所備付地図データ（moj/manifest.json）のタイトルから
 * 町村の郡名を抽出 → census/gun.json  { "14361": "足柄上郡", ... }
 *
 * moj のタイトルは「（郡名）（町村名）（□□法務局）…」形式。
 * 東京島嶼部（大島町・八丈町・小笠原村 等）は郡でなく支庁のため対象外（郡なしが正）。
 * moj で欠落する北海道2町（支庁移動で旧コード）は手動補完。
 *
 * node scripts/build-gun.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../census/gun.json');

const moj = JSON.parse(readFileSync(join(__dir, '../moj/manifest.json'), 'utf8'));

const gun = {};
for (const e of moj) {
    const name = (e.title || '').split('（')[0];   // 市区町村名部分
    const gi   = name.indexOf('郡');
    if (gi > 0) gun[e.cityCode] = name.slice(0, gi + 1);   // gi>0 で「郡山市/郡上市」等を除外
}

// moj 欠落の補完（北海道: 2010年支庁再編でコード移動）
gun['01472'] = '雨竜郡';   // 幌加内町
gun['01520'] = '天塩郡';   // 幌延町

writeFileSync(OUT, JSON.stringify(gun));
console.log(`✅ ${Object.keys(gun).length} 郡 → census/gun.json`);
