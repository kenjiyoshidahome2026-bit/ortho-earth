/**
 * 市区町村のオープンデータ台帳の生成（G空間情報センター CKAN の自治体組織）
 *
 * 出力: munic/manifest.json（アプリ同梱・「市区町村」一覧を開いた時だけ dynamic import）
 *   [{ code, pref, city, org, orgTitle, sets: [{ id, title, cat, license, crs, res: [{ name, fmt, url }] }] }]
 * データ本体は置かない＝ブラウザが配布元（G空間＝CORS 可）を直読みしてその場で GeoPBF 変換（bucket には置かない大前提）。
 *
 * 自治体の見分け方: 組織名の頭が都道府県のローマ字（saitama-… 等・…pref は県庁＝除外）で、表示名が市区町村名。
 *   団体コードは scripts/admin-boundary.csv（現役）と（都道府県・名称）で突き合わせる。組織名に 5〜6 桁の数字があればそれを優先。
 * 資料の選び方: 地図で開ける形式だけ（GeoJSON / KML / KMZ / Shapefile の zip / GML / GPKG / FGB / CSV・Excel＝緯度経度列があれば点）。
 *   PDF・画像・単体の .shp/.dbf（zip でない）・LAS 等は落とす。
 *
 * 使い方: node munic/munic-manifest.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));

const CKAN = 'https://www.geospatial.jp/ckan/api/3/action';
const WAIT = 400;   // 組織ごとの間（CKAN の WAF 様子見・moj-geojson-manifest の轍）
const OUT  = join(__dir, 'manifest.json');

const PREF_ROMAJI = ['hokkaido','aomori','iwate','miyagi','akita','yamagata','fukushima','ibaraki','tochigi','gunma','saitama','chiba','tokyo','kanagawa','niigata','toyama','ishikawa','fukui','yamanashi','nagano','gifu','shizuoka','aichi','mie','shiga','kyoto','osaka','hyogo','nara','wakayama','tottori','shimane','okayama','hiroshima','yamaguchi','tokushima','kagawa','ehime','kochi','fukuoka','saga','nagasaki','kumamoto','oita','miyazaki','kagoshima','okinawa'];
const prefOf = slug => { const i = PREF_ROMAJI.indexOf(slug); return i < 0 ? null : String(i + 1).padStart(2, '0'); };

// 行政区域コード表（現役＝status 空）→ (都道府県2桁, 名称) → 5桁
const ADMIN = readFileSync(join(__dir, '../scripts/admin-boundary.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
	.map(l => l.split(',')).filter(c => c[2] && !c[5]).map(c => ({ code: c[0], pref: c[1], city: c[2] }));
const byName = new Map();
for (const a of ADMIN) {
	const k = `${a.code.slice(0, 2)}:${a.city}`;
	byName.set(k, a);
	const ward = a.city.match(/^(.+?市)(.+区)$/);   // 政令市の区は「区名だけ」でも引ける（例 横浜市中区 ← 中区）は曖昧なので登録しない
	if (ward) byName.set(`${a.code.slice(0, 2)}:${a.city.replace(/\s/g, '')}`, a);
}
const byCode = new Map(ADMIN.map(a => [a.code, a]));

function municipalityOf(org) {
	const [slug, rest = ''] = org.name.split('-');
	const pref = prefOf(slug);
	if (!pref) return null;                                   // moj-／…pref／企業・大学等は対象外
	const digits = rest.match(/^(\d{5})\d?\d?$/)?.[1];        // 5〜7 桁（検査数字つきの 6 桁・誤記の 7 桁も先頭 5 桁）
	if (digits && byCode.has(digits) && digits.startsWith(pref)) return byCode.get(digits);
	const title = org.title.replace(/\s/g, '').replace(/^(北海道|東京都|京都府|大阪府|.{2,3}県)/, '');
	return byName.get(`${pref}:${title}`) || null;
}

const FMT = [
	[/geo\s*json/i, 'geojson'], [/\bkmz\b/i, 'kmz'], [/\bkml\b/i, 'kml'], [/\bgpkg|geopackage/i, 'gpkg'], [/\bfgb|flatgeobuf/i, 'fgb'],
	[/\bgml\b/i, 'gml'], [/\bzip\b|shape|shp/i, 'zip'], [/\bxlsx\b/i, 'xlsx'], [/\bcsv\b/i, 'csv'],
];
function fmtOf(r) {
	const ext = (r.url || '').split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
	if (ext && ['geojson', 'json', 'kml', 'kmz', 'gpkg', 'fgb', 'gml', 'zip', 'csv', 'xlsx'].includes(ext)) return ext === 'json' ? (/geo\s*json/i.test(r.format) ? 'geojson' : null) : ext;
	if (ext && ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'las', 'laz', 'shp', 'dbf', 'shx', 'prj', 'cpg', 'txt', 'xls', 'docx', 'doc', 'html', 'htm', 'rdf', 'ttl', 'xml', '7z', 'lzh'].includes(ext)) return null;
	for (const [re, f] of FMT) if (re.test(r.format || '')) return f === 'zip' && ext && ext !== 'zip' ? null : f;
	return null;
}
// data_crs（例 "EPSG:2452/Japan Plane Rectangular CS X"・"EPSG:4612: JGD2000"）→ EPSG 番号（経緯度系は null＝指定不要）
function crsOf(s) {
	const n = +String(s || '').match(/EPSG\s*:\s*(\d{4,5})/i)?.[1];
	if (!n || [4326, 4612, 6668, 4301].includes(n)) return null;
	return n;
}
const CATS = [
	[/地番|筆界|地籍|公図|字限/, '地番図・地籍'], [/避難|防災|ハザード|浸水|土砂|津波|洪水/, '防災'], [/AED|医療|病院|診療/, '医療・AED'],
	[/都市計画|用途地域|道路|建物|建築|地区計画/, '都市計画・道路'], [/公園|施設|学校|公共|トイレ|文化財|観光/, '施設・観光'],
];
const catOf = t => CATS.find(([re]) => re.test(t))?.[1] || 'その他';
const cleanTitle = t => t.replace(/^\d{5,6}_[^_]+_[^_]+_/, '').trim();   // 「072044_福島県_いわき市_公園」→「公園」

async function getJson(url) {
	for (let i = 0; ; i++) {
		const res = await fetch(url).catch(() => null);
		if (res?.ok) { const d = await res.json(); if (d.success) return d.result; }
		if (i >= 5) throw new Error(`HTTP ${res?.status ?? 'network'}: ${url}`);
		await new Promise(r => setTimeout(r, 2000 * 2 ** i));
	}
}

// organization_list は 1 回 25 件で打ち切られる（limit を無視）＝offset で送る
const orgs = [];
for (let off = 0; ; off += 25) {
	const page = await getJson(`${CKAN}/organization_list?all_fields=true&limit=25&offset=${off}`);
	orgs.push(...page);
	if (page.length < 25) break;
	await new Promise(r => setTimeout(r, 200));
}
const munis = orgs.filter(o => o.package_count > 0).map(o => ({ o, m: municipalityOf(o) })).filter(x => x.m);
console.log(`組織 ${orgs.length}・市区町村と判定 ${munis.length}`);

const out = new Map();   // code → entry（同じ団体に組織が複数あれば束ねる）
let nSets = 0, nRes = 0;
for (const { o, m } of munis) {
	const pkgs = [];
	for (let start = 0; ; start += 100) {
		const r = await getJson(`${CKAN}/package_search?fq=${encodeURIComponent(`organization:${o.name}`)}&rows=100&start=${start}`);
		pkgs.push(...r.results);
		if (start + 100 >= r.count) break;
		await new Promise(r => setTimeout(r, WAIT));
	}
	const sets = pkgs.map(p => {
		const res = (p.resources || []).map(r => ({ name: (r.name || '').trim() || r.url.split('/').pop(), fmt: fmtOf(r), url: r.url, crs: crsOf(r.data_crs) }))
			.filter(r => r.fmt && /^https?:\/\//.test(r.url));
		if (!res.length) return null;
		const crs = res.find(r => r.crs)?.crs ?? null;
		const title = cleanTitle(p.title || p.name);
		// ページ URL は id から作れる（https://www.geospatial.jp/ckan/dataset/<id>）＝台帳には持たない
		return { id: p.name, title, cat: catOf(`${title} ${p.notes || ''}`.slice(0, 400)), license: p.license_title || p.license_id || '', crs,
			res: res.map(({ crs, ...r }) => r) };
	}).filter(Boolean);
	if (!sets.length) continue;
	const e = out.get(m.code) || { code: m.code, pref: m.pref, city: m.city, org: o.name, orgTitle: o.title, sets: [] };
	e.sets.push(...sets); out.set(m.code, e);
	nSets += sets.length; nRes += sets.reduce((s, x) => s + x.res.length, 0);
	process.stdout.write(`\r${out.size} 団体 ${nSets} データセット ${nRes} 資料   `);
	await new Promise(r => setTimeout(r, WAIT));
}
const list = [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
list.forEach(e => e.sets.sort((a, b) => (a.cat === '地番図・地籍' ? -1 : 0) - (b.cat === '地番図・地籍' ? -1 : 0) || a.title.localeCompare(b.title, 'ja')));
writeFileSync(OUT, JSON.stringify(list));
const cad = list.filter(e => e.sets.some(s => s.cat === '地番図・地籍'));
console.log(`\n✓ ${OUT}: ${list.length} 団体・${nSets} データセット・${nRes} 資料（地番図・地籍あり ${cad.length} 団体: ${cad.map(e => e.city).join('・')}）`);
