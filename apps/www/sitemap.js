// sitemap.xml＝検索エンジンに頁の一覧を渡す（Issue #308 段 1・2026-10-14）。vite.config.js の generateBundle が出す・tests/t-sitemap.mjs が門
// 載せる：トップ・/maplibre/・/equal/・demos.json の各アプリ（? と # を落として重複を除く）・apps/docs/*.html（build:all が dist/docs へ写す頁）
// 各 URL はその頁の canonical と同じ綴り。canonical が別の頁を指す docs（index.html＝/#technologies・GC/MO/ST＝gint.html#…）は載せない
// /equal/ は demos.json に無い（カードは /globe/?start=equal）が、Equal Earth の着地頁なので足す
import { readFileSync, readdirSync } from 'node:fs';

export const ORIGIN = 'https://www.ortho-earth.com';
const EXTRA = ['/', '/maplibre/', '/equal/'];

// canonical が無い頁か、canonical が自分自身を指す頁だけ（段 2 の新しい頁は自分を指す canonical を持つ）
export const docsUrls = (dir) => readdirSync(dir).filter(f => f.endsWith('.html')).sort().filter(f => {
	const canon = readFileSync(new URL(f, dir), 'utf8').match(/<link rel="canonical" href="([^"]*)"/)?.[1];
	return !canon || new URL(canon, `${ORIGIN}/docs/${f}`).href === `${ORIGIN}/docs/${f}`;
}).map(f => `/docs/${f}`);

export const sitemapUrls = (demos, docs) => [...new Set([...EXTRA, ...demos.map(d => d.href.replace(/[?#].*$/, '')), ...docs])].map(p => ORIGIN + p);

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const sitemapXml = (urls) => '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
	+ urls.map(u => `<url><loc>${esc(u)}</loc></url>\n`).join('') + '</urlset>\n';

// vite.config.js と試験が同じ入口で作る
export const buildSitemap = () => {
	const demos = JSON.parse(readFileSync(new URL('./demos.json', import.meta.url), 'utf8')).demos;
	return sitemapXml(sitemapUrls(demos, docsUrls(new URL('../docs/', import.meta.url))));
};
