/**
 * 国土数値情報の各カタログページから属性定義とライセンスを抽出する
 *
 * 出力:
 *   catalog-schema.csv  — 属性コード・ラベル・説明・型の対応テーブル
 *   catalog-license.csv — データセット別ライセンス
 *
 * 列 (schema):
 *   dataset_title, dataset_code, page_url,
 *   attr_code, attr_label, description, data_type
 *
 * 列 (license):
 *   dataset_title, dataset_code, page_url, license, license_raw
 */
import { writeFileSync } from 'fs';
import { pool } from './pool.js';

const BASE_URL = 'https://nlftp.mlit.go.jp/ksj/gml/';
const CONCURRENCY = 8;

async function fetchText(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
}

// ---------------------------------------------------------------------------
// 属性行パーサー
// ---------------------------------------------------------------------------

/**
 * HTML から属性定義行を抽出する。
 * パターン: <td>ラベル<br>（CODE_NNN）</td><td>説明</td>[<td>型</td>]
 * @returns {{ code, label, description, data_type }[]}
 */
function parseAttributes(html) {
	const attrs  = [];
	const seen   = new Set();
	const trRe   = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
	let trM;

	while ((trM = trRe.exec(html)) !== null) {
		const trInner = trM[1];
		// <td> を列挙
		const tds = [...trInner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
		if (tds.length < 2) continue;

		// 最初の <td> に <br>（CODE_NNN）パターンがあるか
		const codeM = tds[0].match(/<br[^>]*>\s*[（(]([A-Z]\d{2}[a-z]?_\d{3})[)）]/i);
		if (!codeM) continue;

		const code  = codeM[1];
		if (seen.has(code)) continue;
		seen.add(code);

		// ラベル: <br> より前のテキスト
		const label = tds[0]
			.replace(/<br[^>]*>[\s\S]*/i, '')
			.replace(/<[^>]*>/g, '')
			.replace(/\s+/g, ' ')
			.trim();

		// 説明: 2列目
		const desc = tds[1]
			.replace(/<[^>]*>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();

		// 型: 3列目があれば使用、なければ説明の末尾から推定
		let dataType = '';
		if (tds[2]) {
			dataType = tds[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
		} else {
			// 説明末尾に型情報が含まれる場合 (例: "…文字列型（CharacterString）")
			const typeM = desc.match(/(整数型|実数型|文字列型|論理値型|日付型|URI型|コードリスト[^。]*)[^。]*$/);
			if (typeM) dataType = typeM[0].trim();
		}

		attrs.push({ code, label, description: desc, data_type: dataType });
	}

	return attrs;
}

// ---------------------------------------------------------------------------
// ライセンスパーサー
// ---------------------------------------------------------------------------

const LICENSE_NORMS = [
	[/CC_B[._]Y_4\.0|CC_BY_4\.0/,   'CC_BY_4.0'],
	[/CC_BY_NC_4\.0/,               'CC_BY_NC_4.0'],
	[/CC_BY_NC/,                    'CC_BY_NC'],
	[/CC_BY_SA/,                    'CC_BY_SA'],
	[/CC_BY/,                       'CC_BY'],
	[/非商用/,                      '非商用'],
	[/商用利用可|商用可|再配信可/,  '商用可'],
	[/オープンデータ/,              'オープンデータ'],
	[/パブリックドメイン/,          'パブリックドメイン'],
];

/**
 * HTML からライセンスを抽出する。
 * agreement_01.html リンクを含む <th> 直後の <td> を対象とする。
 * <th> と <td> の間にある HTML コメントを考慮して [\s\S]{0,1000}? でスキップ。
 * @returns {{ license: string, license_raw: string }}
 */
function parseLicense(html) {
	// HTML コメントを除去してから処理
	const clean = html.replace(/<!--[\s\S]*?-->/g, '');

	// agreement_01.html リンクまたは "使用許諾条件" を含む <th> 直後の <td> を取得
	// パターン1: 正しい <th>...</th><td>...</td>
	// パターン2: </th> が省略された <th>...<td>...</td> (一部ページの不正HTML)
	const m = clean.match(
		/<th[^>]*>[\s\S]*?(?:agreement_01|使用許諾条件)[\s\S]*?(?:<\/th>\s*)?<td[^>]*>([\s\S]*?)<\/td>/i
	);
	if (!m) return { license: '', license_raw: '' };

	const raw = m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

	// 正規化
	for (const [re, norm] of LICENSE_NORMS) {
		if (re.test(raw)) return { license: norm, license_raw: raw };
	}
	return { license: raw.slice(0, 60), license_raw: raw };
}


// ---------------------------------------------------------------------------
// CSV ユーティリティ
// ---------------------------------------------------------------------------
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvRow  = cols => cols.map(csvCell).join(',');

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
	console.log('カタログ一覧を取得中...');
	const indexHtml = await fetchText(`${BASE_URL}gml_datalist.html`);

	const pageRe  = /<a\s+[^>]*href=["']([^"']*datalist\/KsjTmplt-[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/g;
	const seen    = new Set();
	const pages   = [];
	let m;
	while ((m = pageRe.exec(indexHtml)) !== null) {
		const url   = new URL(m[1], BASE_URL).href;
		const title = m[2].replace(/<[^>]*>/g, '').trim();
		if (!seen.has(url) && title) { seen.add(url); pages.push({ title, url }); }
	}
	console.log(`${pages.length} 件のカタログを処理中...\n`);

	const schemaHeader  = ['dataset_title', 'dataset_code', 'page_url', 'attr_code', 'attr_label', 'description', 'data_type'];
	const licenseHeader = ['dataset_title', 'dataset_code', 'page_url', 'license', 'license_raw'];
	const schemaRows    = [schemaHeader];
	const licenseRows   = [licenseHeader];

	const results = await pool(pages, CONCURRENCY, async ({ title, url }, i) => {
		const codeM   = url.match(/KsjTmplt-([^.]+)\.html/);
		const dsCode  = codeM ? codeM[1] : '';
		try {
			const html    = await fetchText(url);
			const attrs   = parseAttributes(html);
			const { license, license_raw } = parseLicense(html);
			return { title, dsCode, url, attrs, license, license_raw, ok: true };
		} catch (e) {
			return { title, dsCode, url, attrs: [], license: '', license_raw: '', ok: false, error: e.message };
		}
	});

	let totalAttrs = 0;
	for (const r of results) {
		const { title, dsCode, url, attrs, license, license_raw, ok, error } = r;
		const tag = ok
			? `✓ 属性:${String(attrs.length).padStart(3)} ライセンス:${license || '(なし)'}`
			: `✗ エラー: ${error}`;
		console.log(`${tag.padEnd(50)} ${title}`);

		licenseRows.push([title, dsCode, url, license, license_raw]);

		for (const a of attrs) {
			schemaRows.push([title, dsCode, url, a.code, a.label, a.description, a.data_type]);
			totalAttrs++;
		}
	}

	const bom = '﻿';
	writeFileSync('catalog-schema.csv',  bom + schemaRows.map(csvRow).join('\n'),  'utf8');
	writeFileSync('catalog-license.csv', bom + licenseRows.map(csvRow).join('\n'), 'utf8');

	console.log(`\n✅ catalog-schema.csv:  ${totalAttrs} 件の属性定義`);
	console.log(`✅ catalog-license.csv: ${licenseRows.length - 1} 件のライセンス情報`);
}

main().catch(console.error);
