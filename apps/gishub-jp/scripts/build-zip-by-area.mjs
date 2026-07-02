/**
 * 郵便番号 × 国勢調査2020 小地域（町丁・字等）突合 → public/census/zip2020.json
 *
 * 「各小地域に郵便番号を付ける」。日本郵便の新形式 utf_ken_all.csv（2023年6月〜,
 * 1レコード1行・UTF-8・全角カナ＝継続行地獄なし）を、9桁小地域コードの町域名と
 * JIS市区町村コードで突合する。
 *
 * 出力: { "131010010": "1000005", "xxxxxxxxx": "1000005,1000006", "yyyyyyyyy": "~0600000" }
 *   ・値は7桁郵便番号。町域内で丁目により複数ある場合はカンマ区切り。
 *   ・先頭 "~" は「町別番号を引けず市の代表番号（以下に掲載がない場合）を近似で当てた」印。
 *   ・未一致（該当なし）はキーごと省略。
 *
 * node scripts/build-zip-by-area.mjs
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../public/census/zip2020.json');
const SMALL = join(__dir, '../public/census/2020-small.csv');
const ZIPURL = 'https://www.post.japanpost.jp/service/search/zipcode/download/utf/zip/utf_ken_all.zip';
const REFERER = 'https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html';

// ---- 正規化: 注記除去 / 全角英数→半角 / ヶ→ケ / 「一円」除去 / 漢数字→算用 / 空白中黒除去 ----
const K2A = { '〇':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9' };
function kanjiNum(s) {
    s = s.replace(/([一二三四五六七八九]?)十([一二三四五六七八九]?)/g,
        (m, t, o) => String((t ? +K2A[t] : 1) * 10 + (o ? +K2A[o] : 0)));
    return s.replace(/[〇一二三四五六七八九]/g, c => K2A[c]);
}
function norm(s) {
    s = s.replace(/（.*?）|\(.*?\)/g, '');
    s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s.replace(/ヶ/g, 'ケ');
    s = s.replace(/一円$/, '');               // 「○○村一円」→「○○村」
    s = kanjiNum(s);
    return s.replace(/[\s　・]/g, '').trim();
}

// ---- 浜松市 旧区(census2020) → 新区(郵便) 横断先。北区が中央/浜名へ分割されるため全新区を検索 ----
const HAMA_OLD = new Set(['22131','22132','22133','22134','22135','22136','22137']);
const HAMA_NEW = ['22138','22139','22140'];

function pcsvFirstCols(line) {
    // 先頭列(コード,非引用) + 3列目(郵便,引用) + 9列目(町域,引用) だけ取れれば十分だが簡潔に全分割
    const out = []; let cur = '', q = false;
    for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur); return out;
}

async function loadKenAll() {
    // ローカルにあれば使う（scripts/utf_ken_all.csv）。無ければ日本郵便から取得。
    const local = join(__dir, 'utf_ken_all.csv');
    if (existsSync(local)) { console.log('using local utf_ken_all.csv'); return readFileSync(local, 'utf8'); }
    console.log('fetching utf_ken_all.zip …');
    const resp = await fetch(ZIPURL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)', 'Referer': REFERER },
        signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const entry = new AdmZip(buf).getEntries().find(e => /\.csv$/i.test(e.entryName));
    if (!entry) throw new Error('no csv in zip');
    return entry.getData().toString('utf8');
}

function buildKenIndex(text) {
    const town = new Map();       // city5 → Map(normName → Set(zip))
    const whole = new Map();      // city5 → zip（以下に掲載がない場合）
    const all = new Map();        // city5 → Set(zip)（単一番号判定用）
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        const c = pcsvFirstCols(line);
        const city = c[0], zip = c[2], name = c[8];
        if (!city || !zip) continue;
        if (!all.has(city)) all.set(city, new Set());
        all.get(city).add(zip);
        if (name === '以下に掲載がない場合') { whole.set(city, zip); continue; }
        const n = norm(name);
        if (!n) continue;
        if (!town.has(city)) town.set(city, new Map());
        const m = town.get(city);
        if (!m.has(n)) m.set(n, new Set());
        m.get(n).add(zip);
    }
    // 市区町村内に郵便番号が1つだけ＝村全体が単一番号。名前が合わなくても正当に当てられる
    const single = new Map();
    for (const [city, zips] of all) if (zips.size === 1) single.set(city, [...zips][0]);
    return { town, whole, single };
}

function loadSmall9() {
    const m = new Map();          // city5 → [[code9, name], ...]
    for (const line of readFileSync(SMALL, 'utf8').split('\n')) {
        if (!line) continue;
        const ci = line.indexOf(',');
        const code = line.slice(0, ci);
        if (code.length !== 9) continue;
        const rest = line.slice(ci + 1);
        const name = rest.charCodeAt(0) === 34 ? rest.slice(1, rest.indexOf('"', 1)) : rest.slice(0, rest.indexOf(','));
        const city = code.slice(0, 5);
        if (!m.has(city)) m.set(city, []);
        m.get(city).push([code, name]);
    }
    return m;
}

async function main() {
    const { town, whole, single } = buildKenIndex(await loadKenAll());
    const small = loadSmall9();

    const out = {};
    const stat = { exact: 0, hama: 0, single: 0, city: 0, miss: 0 };
    const missSamples = [];

    // 町域名→zip を、指定都市群から検索するヘルパー
    const lookup = (cities, n) => {
        const zips = new Set();
        for (const ct of cities) { const s = town.get(ct)?.get(n); if (s) for (const z of s) zips.add(z); }
        return zips;
    };

    for (const [city, areas] of small) {
        const isHama = HAMA_OLD.has(city);
        const searchCities = isHama ? HAMA_NEW : [city];
        for (const [code, name] of areas) {
            const n = norm(name);
            const zips = lookup(searchCities, n);
            if (zips.size) {
                out[code] = [...zips].sort().join(',');
                isHama ? stat.hama++ : stat.exact++;
                continue;
            }
            // 単一番号の市区町村（村全体で1番号）は名前が合わなくても正当に付与
            if (single.has(city)) { out[code] = single.get(city); stat.single++; continue; }
            // 市の代表番号にフォールバック（浜松旧区は新区の代表番号）
            const cz = whole.get(city) || (isHama ? HAMA_NEW.map(c => whole.get(c)).find(Boolean) : null);
            if (cz) { out[code] = '~' + cz; stat.city++; continue; }
            stat.miss++; if (missSamples.length < 30) missSamples.push(`${city} ${name}`);
        }
    }

    // キー順ソートで安定出力
    const sorted = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k];
    writeFileSync(OUT, JSON.stringify(sorted));

    const total = stat.exact + stat.hama + stat.city + stat.miss;
    const size = (Buffer.byteLength(JSON.stringify(sorted)) / 1024 / 1024).toFixed(2);
    console.log(`\n小地域 ${total} 件:`);
    console.log(`  固有番号 直接一致   : ${stat.exact}`);
    console.log(`  浜松 旧区→新区一致  : ${stat.hama}`);
    console.log(`  単一番号の市区町村  : ${stat.single}`);
    console.log(`  市代表番号(近似, ~) : ${stat.city}`);
    console.log(`  未一致(省略)        : ${stat.miss}`);
    console.log(`✅ → public/census/zip2020.json (${size} MB)`);
    if (missSamples.length) console.log('未一致サンプル:\n  ' + missSamples.join('\n  '));
}

main().catch(e => { console.error(e); process.exit(1); });
