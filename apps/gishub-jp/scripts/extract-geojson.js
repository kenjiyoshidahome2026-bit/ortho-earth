/**
 * 国土数値情報から全GeoJSONファイルを動的に抽出する
 *
 * 処理フロー:
 *   1. NLFTP カタログ一覧ページを取得
 *   2. 各データセットページから全ダウンロードリンク (GML / GEOJSON) を収集
 *   3. (title, location, format) ごとに最新年度のみ残す
 *   4. 各ZIPのセントラルディレクトリをHTTP Rangeリクエストで読み取り、
 *      内包する .geojson ファイルを列挙
 *   5. 結果を catalog-geojson.csv に出力
 *      列: title, dataset_code, year, scope, pref_code, location_code,
 *          coord_sys, zip_filename, zip_url, geojson_path, target
 *      target = zip_url#geojson_path (gishub catalog.json 互換フォーマット)
 *
 * 同じZIPに複数のGeoJSONが含まれる場合は複数行を出力する。
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { listGeoFilesInZip } from './zip-reader.js';
const __dir = dirname(fileURLToPath(import.meta.url));

const BASE_URL   = 'https://nlftp.mlit.go.jp/ksj/gml/';
const NLFTP_BASE = 'https://nlftp.mlit.go.jp';
const CONCURRENCY = 6;  // 同時ZIP検査数

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

// ---------------------------------------------------------------------------
// NLFTP カタログページのパース
// ---------------------------------------------------------------------------

/** DownLd() パターンから全フォーマットのダウンロードリンクを取得 */
function findDownloadLinks(html, baseUrl) {
    const seen  = new Set();
    const links = [];
    const re    = /DownLd\([^,]+,\s*'([^']+)',\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const name = m[1].trim();
        const url  = new URL(m[2].trim(), baseUrl).href;
        if (!seen.has(url)) { seen.add(url); links.push({ name, url }); }
    }

    // DownLd() がない場合は HTML 内の直接 ZIP パスを探す（例: L02-2025）
    if (links.length === 0) {
        const directRe = /(?:href|src|['"])(\/(ksj\/gml\/data|data)\/[^'"<\s]+\.zip)/gi;
        while ((m = directRe.exec(html)) !== null) {
            const path = m[1];
            const url  = new URL(path, baseUrl).href;
            const name = path.split('/').pop();
            if (!seen.has(url)) { seen.add(url); links.push({ name, url }); }
        }
    }

    return links;
}

/** tokei_data*.js から全フォーマットのエントリを取得 */
async function findTokeiLinks(html, baseUrl) {
    const scriptRe = /src="([^"]*tokei_data\d*\.js)"/g;
    const links    = [];
    const seen     = new Set();
    let m;
    while ((m = scriptRe.exec(html)) !== null) {
        const jsUrl = new URL(m[1], baseUrl).href;
        try {
            const js       = await fetchText(jsUrl);
            const jsonText = js.replace(/^const\s+\w+\s*=\s*/, '').replace(/;\s*$/, '');
            const data     = JSON.parse(jsonText);
            for (const e of data) {
                if (!e.dl || seen.has(e.dl)) continue;
                seen.add(e.dl);
                const url = new URL(e.dl, NLFTP_BASE).href;
                links.push({ name: e.file, url, citycode: e.citycode, datafmt: e.data });
            }
        } catch (_) {}
    }
    return links;
}

// ---------------------------------------------------------------------------
// 年度抽出・重複除去
// ---------------------------------------------------------------------------

/** URL または ファイル名から年度 (4桁) を抽出 */
function extractYear(url) {
    const m = url.match(/\/[A-Za-z][^/]+-[a-z]?-?(\d{2,8})[/_]/i);
    if (!m) return 0;
    const raw = m[1];
    if (raw.length >= 4) return parseInt(raw.slice(0, 4));
    const y2 = parseInt(raw);
    return y2 >= 50 ? 1900 + y2 : 2000 + y2;
}

/**
 * (title, base_code, location_suffix) ごとに最新年度のURLだけ残す。
 * base_code = ファイル名から年度部分を除いたプレフィックス
 * location_suffix = 都道府県コード・メッシュコード等
 */
function dedupeToLatest(links) {
    const map = new Map();
    for (const link of links) {
        // ファイル名の CODE-YEAR_SUFFIX 構造から (base, suffix) を抽出
        const noExt  = link.name.replace(/\.(zip)$/i, '');
        const baseM  = noExt.match(/^(.+?)-[a-z]?-?\d{2,8}(.*)/i);
        const base   = baseM ? baseM[1] : noExt;
        const suffix = baseM ? baseM[2].replace(/\.(GML|SHP|GEOJSON)$/i, '') : '';
        const key    = `${link.title}||${base}||${suffix}`;
        const year   = extractYear(link.url);
        const cur    = map.get(key);
        if (!cur || year > cur.year) map.set(key, { ...link, year });
    }
    return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// 空間スコープ判定
// ---------------------------------------------------------------------------

/** ファイル名からスコープと位置コードを判定 */
function detectScope(name, citycode) {
    // tokei_data の citycode が利用可能な場合はそちらを優先
    if (citycode !== undefined && citycode !== null) {
        if (!citycode || citycode === '00000') return { scope: '全国',  pref_code: '', location_code: citycode || '' };
        if (citycode.endsWith('000'))          return { scope: '都道府県', pref_code: citycode.slice(0, 2), location_code: citycode };
        return { scope: '市区町村', pref_code: citycode.slice(0, 2), location_code: citycode };
    }

    const base  = name.replace(/_(GEOJSON|GML|SHP)\.zip$/i, '').replace(/\.zip$/i, '');
    // CODE-YEAR プレフィックス除去 (例: A45-24, N03-20240101, A31b-25, L03-b-14)
    const after = base.replace(/^[A-Za-z0-9]+-[a-z]?-?\d{2,8}/, '');
    const nums  = after.split('_').filter(t => /^\d+$/.test(t));

    if (!nums.length) return { scope: '全国', pref_code: '', location_code: '' };

    // メッシュコード: 4桁(1次), 6桁(2次), 8桁(3次)
    for (const t of nums) {
        if (t.length === 8) return { scope: '3次メッシュ', pref_code: '', location_code: t };
        if (t.length === 6) return { scope: '2次メッシュ', pref_code: '', location_code: t };
        if (t.length === 4) {
            const n = parseInt(t);
            if (n >= 3036 && n <= 6954) return { scope: '1次メッシュ', pref_code: '', location_code: t };
        }
    }

    const loc = nums[0];
    const n   = parseInt(loc);
    if (loc.length === 5) {
        const pref = loc.slice(0, 2);
        return loc.endsWith('000')
            ? { scope: '都道府県', pref_code: pref, location_code: loc }
            : { scope: '市区町村', pref_code: pref, location_code: loc };
    }
    if (loc.length === 2) {
        if (n >= 51 && n <= 59) return { scope: '地方区分',  pref_code: '',  location_code: loc };
        if (n >= 1  && n <= 47) return { scope: '都道府県', pref_code: loc.padStart(2, '0'), location_code: loc };
    }
    return { scope: '全国', pref_code: '', location_code: loc };
}

function detectCoordSys(name) {
    if (/-jgd2011/i.test(name)) return 'JGD2011';
    if (/-jgd/i.test(name))     return 'JGD';
    if (/-tky/i.test(name))     return 'TKY';
    return '';
}

// ---------------------------------------------------------------------------
// 並列処理ユーティリティ
// ---------------------------------------------------------------------------

async function pool(tasks, limit, onDone) {
    const queue = [...tasks];
    let active  = 0;
    let idx     = 0;
    return new Promise((resolve, reject) => {
        function next() {
            while (active < limit && queue.length) {
                active++;
                const task = queue.shift();
                const i    = idx++;
                task(i).then(r => { onDone(i, r); active--; next(); }).catch(e => { onDone(i, { error: e }); active--; next(); });
            }
            if (!active && !queue.length) resolve();
        }
        next();
    });
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
    console.log('カタログ一覧を取得中...');
    const indexHtml = await fetchText(`${BASE_URL}gml_datalist.html`);

    // カタログページ一覧を取得
    const pageRe = /<a\s+[^>]*href=["']([^"']*datalist\/KsjTmplt-[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/g;
    const seenPages = new Set();
    const pages = [];
    let m;
    while ((m = pageRe.exec(indexHtml)) !== null) {
        const url   = new URL(m[1], BASE_URL).href;
        const title = m[2].replace(/<[^>]*>/g, '').trim();
        if (!seenPages.has(url) && title) { seenPages.add(url); pages.push({ title, url }); }
    }
    console.log(`${pages.length} 件のカタログを処理中...\n`);

    // 全カタログページを走査してダウンロードリンクを収集
    const allLinks = [];
    for (let i = 0; i < pages.length; i++) {
        const { title, url } = pages[i];
        const codeM = url.match(/KsjTmplt-([^.]+)\.html/);
        const dsCode = codeM ? codeM[1] : '';
        try {
            const html  = await fetchText(url);
            const dl    = findDownloadLinks(html, url).map(l => ({ ...l, title, dsCode }));
            const tokei = (await findTokeiLinks(html, url)).map(l => ({ ...l, title, dsCode }));
            // URL重複除去でマージ
            const usedUrls = new Set(dl.map(l => l.url));
            for (const t of tokei) if (!usedUrls.has(t.url)) { usedUrls.add(t.url); dl.push(t); }
            allLinks.push(...dl);
            process.stdout.write(`[${String(i+1).padStart(3)}/${pages.length}] ${dl.length.toString().padStart(4)}件  ${title}\n`);
        } catch (e) {
            process.stdout.write(`[${String(i+1).padStart(3)}/${pages.length}] エラー: ${title} — ${e.message}\n`);
        }
    }

    // 最新年度に絞り込み
    const latest = dedupeToLatest(allLinks);
    console.log(`\n全リンク: ${allLinks.length} 件 → 最新年度に絞り込み: ${latest.length} 件`);
    console.log('各ZIPのセントラルディレクトリを確認中...\n');

    // ZIP検査タスク生成 (SHPは後回し: GeoJSONを持つ可能性が低い)
    // _SHP.zip を後回しにして _GML.zip と _GEOJSON.zip と無印を先に処理
    const priority = (name) => {
        if (/_GEOJSON\.zip$/i.test(name)) return 0;
        if (/_GML\.zip$/i.test(name))     return 1;
        if (/_SHP\.zip$/i.test(name))     return 3;
        return 2;
    };
    latest.sort((a, b) => priority(a.name) - priority(b.name));

    // 出力行
    const header = ['title','dataset_code','year','scope','pref_code','location_code',
                                    'coord_sys','zip_filename','zip_url','file_path','format','target'];
    const rows   = [header];

    const tasks = latest.map(link => async (i) => {
        const { title, dsCode, name, url, citycode } = link;
        const year               = extractYear(url) || '';
        const coordSys           = detectCoordSys(name);
        const { scope, pref_code, location_code } = detectScope(name, citycode);

        try {
            const { paths, format } = await listGeoFilesInZip(url);
            if (paths.length === 0) return { title, found: 0 };

            for (const fp of paths) {
                rows.push([title, dsCode, year, scope, pref_code, location_code,
                                     coordSys, name, url, fp, format, `${url}#${fp}`]);
            }
            return { title, found: paths.length, format };
        } catch (e) {
            return { title, found: 0, error: e.message };
        }
    });

    let done = 0;
    const total = tasks.length;
    await pool(tasks, CONCURRENCY, (i, result) => {
        done++;
        const { title, found, error } = result;
        const tag = error  ? `✗ ${error.slice(0,40)}`
                            : found  ? `✓ ${result.format?.toUpperCase()}: ${found}件`
                            : '-  なし';
        if (found || error) {
            process.stdout.write(`[${String(done).padStart(4)}/${total}] ${tag.padEnd(24)} ${title}\n`);
        }
    });

    const csv = rows.map(r =>
        r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    writeFileSync(join(__dir, 'catalog-geojson.csv'), '﻿' + csv, 'utf8');
    const fileCount    = rows.length - 1;
    const geojsonCount = rows.slice(1).filter(r => r[10] === 'geojson').length;
    const shpCount     = rows.slice(1).filter(r => r[10] === 'shp').length;
    console.log(`\n✅ ${fileCount} 件を catalog-geojson.csv に出力しました`);
    console.log(`   GeoJSON: ${geojsonCount}件 / SHP: ${shpCount}件`);
    console.log(`   (zip_url#file_path 形式で target 列に記載)`);
}

main().catch(console.error);
