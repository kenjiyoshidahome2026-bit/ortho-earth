#!/usr/bin/env node
// 法務省マニフェストのファイルサイズを CKAN API から取得
// geospatial.jp は CKAN ベースなので resource_show API でサイズが取れる
// 使い方: node moj-size-fetch.js
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dir, 'manifest.json');
const PARALLEL = 12;
const CKAN_API = 'https://www.geospatial.jp/ckan/api/3/action/resource_show?id=';

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const queue = manifest.map((e, i) => ({ ...e, _idx: i }));

let done = 0, errors = 0;
const total = queue.length;

console.log(`${total}件の CKAN API リクエスト開始 (${PARALLEL}並列)`);

const worker = async () => {
	while (queue.length) {
		const entry = queue.shift();
		try {
			const res = await fetch(CKAN_API + entry.resourceId, {
				signal: AbortSignal.timeout(15000),
			});
			const data = await res.json();
			const size = data?.result?.size;
			manifest[entry._idx].size = (size && size > 1000) ? size : null;
			done++;
			if (done % 100 === 0) console.log(`  ${done} / ${total}...`);
		} catch (e) {
			manifest[entry._idx].size = null;
			errors++;
			process.stderr.write(`ERR ${entry.filename}: ${e.message}\n`);
		}
	}
};

await Promise.all(Array.from({ length: PARALLEL }, worker));

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

const withSize = manifest.filter(e => e.size).length;
const totalGB  = (manifest.reduce((s, e) => s + (e.size || 0), 0) / 1024 / 1024 / 1024).toFixed(1);
console.log(`\n完了: ${done}件取得, ${errors}件エラー`);
console.log(`サイズ取得成功: ${withSize}/${total}件`);
console.log(`合計: ${totalGB} GB`);
