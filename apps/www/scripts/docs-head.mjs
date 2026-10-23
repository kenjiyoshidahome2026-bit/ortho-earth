#!/usr/bin/env node
// docs の共有カード（og:image・twitter:card）と JSON-LD を head に写す（2026-10-23）。仕組みは ../docs-head.js。
// docs の title・description を直したら `node apps/www/scripts/docs-head.mjs` で写し直す（門 tests/t-docs-head.mjs がずれを止める）
import { readFileSync, writeFileSync } from 'node:fs';
import { docsUrls } from '../sitemap.js';
import { withDocsHead } from '../docs-head.js';

const DIR = new URL('../../docs/', import.meta.url);
export const targets = () => docsUrls(DIR).map(p => new URL(p.replace('/docs/', '') + '.html', DIR));

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
	let n = 0;
	for (const f of targets()) {
		const src = readFileSync(f, 'utf8'), out = withDocsHead(src);
		if (out !== src) { writeFileSync(f, out); n++; }
	}
	console.log(`docs-head: ${n} file(s) updated`);
}
