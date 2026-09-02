/**
 * 国土数値情報 行政区域コード (AdminiBoundary_CD.xlsx) → CSV 変換
 *
 * 出力: admin-boundary.csv
 *   code,pref,city,prefKana,cityKana,status,changeDate,newCode,newName,newNameKana,changeReason
 *
 *   status: '' = 現役 / '欠番' = 廃止（合併等） / '名称変更' = コード同一・名称のみ変更
 *   changeDate: YYYY-MM-DD 形式（Excel シリアル値から変換）
 *
 * 実行: node gen-admin-boundary.js
 *
 * ─────────────────────────────────────────────────────────────────
 * 【省庁横断で確認した市区町村コードの実態】令和6年1月1日現在
 *
 *   admin-boundary 現役: 1965件
 *   MOJ（登記所備付地図）: 2062件  現役1889 / 欠番126 / 超古い廃止47
 *   MAFF（筆ポリゴン）  : 1892件  現役1892 / 欠番0   / 不明0  ← 最もクリーン
 *   e-Stat（統計）      : 2062件  MOJと完全一致
 *
 *   現役1965件のうち MOJ/e-Stat にない76件の内訳:
 *     - 都道府県アグリゲート（XX000）: 47件  個別データは持たない集計コード
 *     - 政令市アグリゲート  （XX100）: 15件  区単位でデータがあるため市全体は不要
 *     - 北方領土（01695〜01700）      :  6件  ロシア実効支配のためデータなし
 *     - その他（川崎市・福岡市等）    :  8件  政令市本体 + 支庁再編で新コードに移行済の町
 *
 *   MOJ/e-Stat の欠番126件は平成の大合併（2000年代）の痕跡。
 *   不明47件（浦和市=11204 など）は admin-boundary の欠番リストにすら載っていない
 *   2001年以前の廃止コード。MOJは古い境界データをそのまま保持している。
 *
 *   MAFF だけが全件現役コードで整備されている。農水省えらい。
 *   MOJ と e-Stat は省庁が違っても同じ古さ。縦割りの壁を感じる。
 * ─────────────────────────────────────────────────────────────────
 */

import xlsx from 'xlsx';   // 読み込み専用・root の devDependencies（手動実行の整備道具＝出荷物ではない）
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

const XLSX_URL   = 'https://nlftp.mlit.go.jp/ksj/gml/codelist/AdminiBoundary_CD.xlsx';
const XLSX_CACHE = join(__dir, 'AdminiBoundary_CD.xlsx');
const OUT_CSV    = join(__dir, 'admin-boundary.csv');

// 半角カナ → ひらがな
function toHiragana(str) {
    return str.normalize('NFKC')
              .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// Excel 日付シリアル値 → YYYY-MM-DD
function excelDate(serial) {
    if (!serial || isNaN(+serial)) return '';
    const d = new Date((+serial - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
}

// CSV 1セルのエスケープ
function csvCell(v) {
    if (/[,"\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
}

// xlsx ダウンロード（キャッシュ優先）
async function fetchXlsx() {
    if (existsSync(XLSX_CACHE)) {
        console.log(`キャッシュ使用: ${XLSX_CACHE}`);
        return readFileSync(XLSX_CACHE);
    }
    console.log(`ダウンロード中: ${XLSX_URL}`);
    const res = await fetch(XLSX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(XLSX_CACHE, buf);
    console.log(`キャッシュ保存: ${XLSX_CACHE}`);
    return buf;
}

// メイン
const buf  = await fetchXlsx();
const wb   = xlsx.read(buf, { type: 'buffer' });
const ws   = wb.Sheets[wb.SheetNames[0]];
const data = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });

// 先頭3行（タイトル・空行・ヘッダ）をスキップ、5桁コード行のみ
const rows = data.slice(3)
    .map(r => r.map(c => String(c).trim().replace(/\r?\n/g, ' ')))
    .filter(r => /^\d{5}$/.test(r[0]));

const header = 'code,pref,city,prefKana,cityKana,status,changeDate,newCode,newName,newNameKana,changeReason';
const lines  = [header];

let active = 0, obsolete = 0, renamed = 0;

for (const r of rows) {
    const code       = r[0];
    const pref       = r[1];
    const city       = r[2];
    const prefKana   = toHiragana(r[3]);
    const cityKana   = toHiragana(r[4]);
    const rawStatus  = r[5];
    const changeDate = excelDate(r[6]);
    const newCode    = r[7];
    const newName    = r[8];
    const newNameKana = toHiragana(r[9]);
    const changeReason = r[10];

    // status 正規化
    const status = rawStatus === '欠番' ? '欠番'
        : rawStatus === '変更なし（名称変更）' ? '名称変更'
        : '';

    if (status === '欠番')      obsolete++;
    else if (status === '名称変更') renamed++;
    else                         active++;

    lines.push([
        code, pref, city, prefKana, cityKana,
        status, changeDate, newCode, newName, newNameKana, changeReason,
    ].map(csvCell).join(','));
}

writeFileSync(OUT_CSV, lines.join('\n') + '\n', 'utf8');
console.log(`出力完了: ${OUT_CSV}`);
console.log(`  現役: ${active} 件 / 欠番: ${obsolete} 件 / 名称変更: ${renamed} 件 / 合計: ${rows.length} 件`);
