// docs の共有カードと構造化データ（Issue #308 の続き・2026-10-23）＝head だけに足す（本文・見た目は触らない）
// 足すもの：og:title・og:description・og:url・og:type（無い頁だけ・title と description から）、og:image と twitter:card（全頁・トップと同じ og-image.jpg）、
// JSON-LD の TechArticle（見出し・説明・言語・著者・公開日＝article:published_time がある頁だけ）。
// 正本は各 docs の title・description・canonical・lang＝`node apps/www/scripts/docs-head.mjs` で写し直す（門 tests/t-docs-head.mjs がずれを止める）
import { ORIGIN } from './sitemap.js';

export const OG_IMAGE = `${ORIGIN}/og-image.jpg`;
export const AUTHOR = { '@type': 'Person', name: 'Kenji Yoshida', url: `${ORIGIN}/docs/introduction` };

const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (html, re) => { const m = html.match(re); return m ? unesc(m[1]) : null; };

/** head の素性（title・description・canonical・lang・og:title・公開日） */
export const docsMeta = (html) => ({
	title: attr(html, /<title>([^<]*)<\/title>/),
	description: attr(html, /<meta name="description" content="([^"]*)">/),
	canonical: attr(html, /<link rel="canonical" href="([^"]*)">/),
	lang: attr(html, /<html lang="([^"]*)"/),
	ogTitle: attr(html, /<meta property="og:title" content="([^"]*)">/),
	published: attr(html, /<meta property="article:published_time" content="([^"]*)">/),
});

// </script> を JSON の中で閉じさせない
export const jsonLd = (m) => JSON.stringify({
	'@context': 'https://schema.org',
	'@type': 'TechArticle',
	headline: m.ogTitle || m.title,
	description: m.description,
	url: m.canonical,
	mainEntityOfPage: m.canonical,
	inLanguage: m.lang,
	image: OG_IMAGE,
	...(m.published ? { datePublished: m.published } : {}),
	author: AUTHOR,
	publisher: AUTHOR,
	isPartOf: { '@type': 'WebSite', name: 'Ortho Earth', url: `${ORIGIN}/` },
}).replace(/</g, '\\u003c');

const LD_RE = /<script type="application\/ld\+json">[^\n]*<\/script>\n/;
const ICON = '<link rel="icon"';

/** 同じ物を何度通しても同じ（冪等）。sitemap に載る docs（自分を指す canonical を持つ頁）だけに使う */
export const withDocsHead = (html) => {
	const m = docsMeta(html);
	let out = html.replace(LD_RE, '').replace(/<meta property="og:image[^"]*" content="[^"]*">\n/g, '').replace(/<meta name="twitter:card" content="[^"]*">\n/g, '');
	const q = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
	const add = [];
	if (!m.ogTitle) add.push(
		`<meta property="og:title" content="${q(m.title)}">`,
		`<meta property="og:description" content="${q(m.description)}">`,
		`<meta property="og:url" content="${q(m.canonical)}">`,
		'<meta property="og:type" content="article">');
	add.push(
		`<meta property="og:image" content="${OG_IMAGE}">`,
		'<meta property="og:image:width" content="1200">',
		'<meta property="og:image:height" content="630">',
		'<meta name="twitter:card" content="summary_large_image">',
		`<script type="application/ld+json">${jsonLd(m)}</script>`);
	return out.replace(ICON, add.join('\n') + '\n' + ICON);
};
