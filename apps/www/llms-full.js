// llms-full.txt＝AI エージェントが 1 回の取得で全体を読める一本の Markdown（2026-11-11）。
// 中身＝llms.txt（目次と今の事実）＋ start.md（作り方）＋ 主な docs の本文（HTML から Markdown へ）＋ CHANGELOG の新しい 2 版。
// 正本は各ファイル＝ここは写すだけ（文を足さない）。vite.config.js の generateBundle が出す・門＝tests/t-facts.mjs
import { readFileSync } from 'node:fs';
import { ORIGIN } from './sitemap.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// 英語の頁を先に、比較の記事は最後（日付と版が本文に書いてある）
export const FULL_DOCS = [
	'from-maplibre', 'from-cesium', 'from-leaflet', 'from-google-maps', 'equal-earth',
	'core', 'geopbf', 'gint', 'altpbf',
	'story-features', 'story-benchmark', 'story-benchmark-mobile-jp',
];

const NAMED = { middot: '·', minus: '−', times: '×', alpha: 'α', mdash: '—', ndash: '–', rarr: '→', hellip: '…', deg: '°' };
const unesc = (s) => s.replace(/&nbsp;/g, ' ').replace(/&(middot|minus|times|alpha|mdash|ndash|rarr|hellip|deg);/g, (_, k) => NAMED[k]).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
	.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const abs = (href, base) => { try { return new URL(href, base).href.replace(/\.html(?=$|[?#])/, ''); } catch { return href; } };
const inline = (h, base) => unesc(h
	.replace(/<br\s*\/?>/g, ' ')
	.replace(/<img[^>]*>/g, '')
	.replace(/<code[^>]*>([\s\S]*?)<\/code>/g, (_, c) => '`' + c.replace(/<[^>]+>/g, '') + '`')
	.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/g, '**$2**')
	.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/g, '*$2*')
	.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, t) => `[${t.replace(/<[^>]+>/g, '').trim()}](${abs(unesc(href), base)})`)
	.replace(/<[^>]+>/g, ''))
	.replace(/\s+/g, ' ').trim();

/** docs の HTML の本文を Markdown に。頭・見出し帯・nav・script・style は落とす */
export const htmlToMarkdown = (html, base) => {
	let b = (html.match(/<body[^>]*>([\s\S]*)<\/body>/) || [, html])[1];
	b = b.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<!--[\s\S]*?-->/g, '')
		.replace(/<div class="header-bar">[\s\S]*?<\/div>\s*<\/div>/, '');
	const out = [];
	const re = /<(h[1-4]|p|pre|table|ul|ol|blockquote|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/g;
	let m;
	while ((m = re.exec(b))) {
		const [, tag, inner] = m;
		if (tag === 'h1') continue;   // 題は節の見出しに出す
		if (/^h\d$/.test(tag)) out.push('#'.repeat(+tag[1] + 1) + ' ' + inline(inner, base));
		else if (tag === 'pre') out.push('```\n' + unesc(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, '') + '\n```');
		else if (tag === 'table') {
			const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => inline(c[1], base).replace(/\|/g, '\\|')));
			if (rows.length) {
				const w = Math.max(...rows.map(r => r.length));
				const line = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
				out.push([line(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(line)].join('\n'));
			}
		} else if (tag === 'ul' || tag === 'ol') {
			const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((li, i) => (tag === 'ol' ? `${i + 1}. ` : '- ') + inline(li[1], base));
			if (items.length) out.push(items.join('\n'));
		} else {
			const t = inline(inner, base);
			if (t) out.push(tag === 'blockquote' ? '> ' + t : t);
		}
	}
	return out.join('\n\n');
};

/** CHANGELOG.md の先頭から n 版ぶん（「## 」の見出しで切る） */
export const changelogHead = (md, n) => {
	const parts = md.split(/^(?=## )/m);
	return parts.slice(1, 1 + n).join('').trim();
};

export const buildLlmsFull = (llmsTxt) => {
	const docs = FULL_DOCS.map((name) => {
		const html = read(`../docs/${name}.html`);
		const url = `${ORIGIN}/docs/${name}`;
		const title = unesc(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? name);
		return `## ${title}\n\nSource: ${url}\n\n${htmlToMarkdown(html, url + '.html')}`;
	});
	return [
		llmsTxt.trim(),
		'---\n\n# Full text\n\nThe pages linked above, copied as Markdown so that one fetch is enough. Each section names its source page.',
		`## Build with Ortho Earth\n\nSource: ${ORIGIN}/start.md\n\n${read('./public/start.md').replace(/^# .*\n+/, '').replace(/^(#+) /gm, '#$1 ').trim()}`,
		`## Changelog (latest releases)\n\nSource: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/CHANGELOG.md\n\n${changelogHead(read('../../CHANGELOG.md'), 2).replace(/^## /gm, '### ')}`,
		...docs,
	].join('\n\n') + '\n';
};
