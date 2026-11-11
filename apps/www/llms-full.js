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
	'story-v240', 'story-features', 'story-benchmark', 'story-benchmark-mobile-jp',
];

const NAMED = { middot: '·', minus: '−', times: '×', alpha: 'α', mdash: '—', ndash: '–', rarr: '→', hellip: '…', deg: '°' };
const unesc = (s) => s.replace(/&nbsp;/g, ' ').replace(/&(middot|minus|times|alpha|mdash|ndash|rarr|hellip|deg);/g, (_, k) => NAMED[k]).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
	.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
// 入力は repo の自前の docs・出力は text/plain（HTML として描かない）。タグの剥がしは正規表現でなく 1 文字ずつ読む
// （正規表現の置き換えは入れ子や大文字・崩れた閉じタグを取りこぼす＝CodeQL の指摘・2026-11-11）
/** < から > までを全部落とす（> が無ければ < 以降を落とす） */
const stripTags = (s) => {
	let out = '', inTag = false;
	for (const ch of s) {
		if (inTag) { if (ch === '>') inTag = false; }
		else if (ch === '<') inTag = true;
		else out += ch;
	}
	return out;
};
/** 中身ごと落とす要素（script・style・nav）と注釈。大文字小文字を問わず、閉じタグが無ければ残りを全部落とす */
const dropBlocks = (s) => {
	const lower = s.toLowerCase();
	let out = '', i = 0;
	const opens = [['<script', '</script'], ['<style', '</style'], ['<nav', '</nav'], ['<!--', '-->']];
	while (i < s.length) {
		let best = null;
		for (const [o, c] of opens) {
			const j = lower.indexOf(o, i);
			if (j >= 0 && (!best || j < best.j)) best = { j, c };
		}
		if (!best) { out += s.slice(i); break; }
		out += s.slice(i, best.j);
		const k = lower.indexOf(best.c, best.j);
		if (k < 0) break;
		const end = best.c === '-->' ? k + 3 : lower.indexOf('>', k);
		if (end < 0) break;
		i = best.c === '-->' ? end : end + 1;
	}
	return out;
};
const abs = (href, base) => { try { return new URL(href, base).href.replace(/\.html(?=$|[?#])/, ''); } catch { return href; } };
const inline = (h, base) => unesc(stripTags(h
	.replace(/<br\s*\/?>/g, ' ')
	.replace(/<img[^>]*>/g, '')
	.replace(/<code[^>]*>([\s\S]*?)<\/code>/g, (_, c) => '`' + stripTags(c) + '`')
	.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/g, '**$2**')
	.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/g, '*$2*')
	.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, t) => `[${stripTags(t).trim()}](${abs(unesc(href), base)})`)
	))
	.replace(/\s+/g, ' ').trim();

/** docs の HTML の本文を Markdown に。頭・見出し帯・nav・script・style は落とす */
export const htmlToMarkdown = (html, base) => {
	let b = (html.match(/<body[^>]*>([\s\S]*)<\/body>/) || [, html])[1];
	b = dropBlocks(b)
		.replace(/<div class="header-bar">[\s\S]*?<\/div>\s*<\/div>/, '');
	const out = [];
	const re = /<(h[1-4]|p|pre|table|ul|ol|blockquote|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/g;
	let m;
	while ((m = re.exec(b))) {
		const [, tag, inner] = m;
		if (tag === 'h1') continue;   // 題は節の見出しに出す
		if (/^h\d$/.test(tag)) out.push('#'.repeat(+tag[1] + 1) + ' ' + inline(inner, base));
		else if (tag === 'pre') out.push('```\n' + unesc(stripTags(inner)).replace(/^\n+|\s+$/g, '') + '\n```');
		else if (tag === 'table') {
			const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => inline(c[1], base).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')));
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
