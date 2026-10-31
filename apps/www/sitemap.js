// sitemap.xml＝検索エンジンに頁の一覧を渡す（Issue #308 段 1・2026-10-14）。vite.config.js の generateBundle が出す・tests/t-sitemap.mjs が門
// 載せる：トップ・/maplibre/・/equal/・demos.json の各アプリ（? と # を落として重複を除く）・apps/docs/*.html（build:all が dist/docs へ写す頁）
// 各 URL はその頁の canonical と同じ綴り。canonical が別の頁を指す docs（index.html＝/#technologies・GC/MO/ST＝gint.html#…）は載せない
// /equal/ は demos.json に無い（カードは /globe/?start=equal）が、Equal Earth の着地頁なので足す
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://www.ortho-earth.com';
const EXTRA = ['/', '/maplibre/', '/equal/'];

// canonical が無い頁か、canonical が自分自身を指す頁だけ（段 2 の新しい頁は自分を指す canonical を持つ）
// URL は .html を落とした形＝Cloudflare Pages が /docs/x.html を 308 で /docs/x へ送る（本番で実測・2026-10-14）
export const docsUrls = (dir) => readdirSync(dir).filter(f => f.endsWith('.html')).sort().filter(f => {
	const canon = readFileSync(new URL(f, dir), 'utf8').match(/<link rel="canonical" href="([^"]*)"/)?.[1];
	const self = `${ORIGIN}/docs/${f.replace(/\.html$/, '')}`;
	return !canon || new URL(canon, self).href === self;
}).map(f => `/docs/${f.replace(/\.html$/, '')}`);

export const sitemapUrls = (demos, docs) => [...new Set([...EXTRA, ...demos.map(d => d.href.replace(/[?#].*$/, '')), ...docs])].map(p => ORIGIN + p);

// lastmod＝その頁の元ファイルを最後に変えたコミットの日（git）。分からない時は書かない（嘘の日付を渡さない＝検索エンジンが lastmod を信じなくなる）
//   ・git が無い・浅い clone の境目のコミット（.git/shallow に載る＝全ファイルを「足した」ことになっている）が最後なら書かない
//   ・載せるのは元ファイルが repo の中で決まる頁だけ：トップ（index.html・demos.json・stories.json）・/maplibre/・docs。アプリは別の Worker が出すので書かない
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
export const gitLastmod = (files) => {
	try {
		const cwd = fileURLToPath(new URL('.', import.meta.url));
		const shallowFile = git(['rev-parse', '--path-format=absolute', '--git-path', 'shallow'], cwd);
		const shallow = new Set(existsSync(shallowFile) ? readFileSync(shallowFile, 'utf8').split('\n').filter(Boolean) : []);
		const dates = files.map(f => git(['log', '-1', '--format=%H %cs', '--', fileURLToPath(f)], cwd).split(' '));
		if (dates.some(([h, d]) => !h || !d || shallow.has(h))) return null;
		return dates.map(([, d]) => d).sort().at(-1);
	} catch { return null; }
};
// Cloudflare Pages の build は浅い clone（本番で lastmod が 0 件だった・2026-10-23）＝Pages の上でだけ履歴を取り寄せてから日付を読む。
// 取れなければ従来どおり lastmod を書かない（build は止めない）。手元と CI（CF_PAGES 無し）は触らない
export const unshallowOnPages = () => {
	if (!process.env.CF_PAGES) return;
	try {
		const cwd = fileURLToPath(new URL('.', import.meta.url));
		if (git(['rev-parse', '--is-shallow-repository'], cwd) === 'true') git(['fetch', '--quiet', '--unshallow'], cwd);
	} catch { /* 取れない時は lastmod を書かないだけ */ }
};
const SOURCES = {
	'/': ['./index.html', './demos.json', './stories.json'].map(f => new URL(f, import.meta.url)),
	'/maplibre/': [new URL('./public/maplibre/', import.meta.url)],
	'/sandcastle/': [new URL('./public/sandcastle/', import.meta.url)],
};
export const sourcesOf = (u) => {
	const p = u.slice(ORIGIN.length);
	if (SOURCES[p]) return SOURCES[p];
	if (p.startsWith('/docs/')) return [new URL(`../docs/${p.slice(6)}.html`, import.meta.url)];
	return null;
};

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const sitemapXml = (urls, lastmod = () => null) => '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
	+ urls.map(u => { const d = lastmod(u); return `<url><loc>${esc(u)}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>\n`; }).join('') + '</urlset>\n';

// vite.config.js と試験が同じ入口で作る
export const buildSitemap = () => {
	unshallowOnPages();
	const demos = JSON.parse(readFileSync(new URL('./demos.json', import.meta.url), 'utf8')).demos;
	return sitemapXml(sitemapUrls(demos, docsUrls(new URL('../docs/', import.meta.url))), u => { const f = sourcesOf(u); return f && gitLastmod(f); });
};
