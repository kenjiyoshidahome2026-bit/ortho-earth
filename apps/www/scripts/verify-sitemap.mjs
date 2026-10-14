// マージ後の確かめ（Issue #308 段 1）：本番の /sitemap.xml が XML の型で返り、載せた URL が全部 200、頁に canonical があればそれと同じ綴り
// 使い方：npm run verify:sitemap -w www（既定は本番。別の先は引数：node scripts/verify-sitemap.mjs https://<枝>.www-ortho-earth.pages.dev）
const base = (process.argv[2] || 'https://www.ortho-earth.com').replace(/\/$/, '');
let bad = 0;
const fail = (...a) => { bad++; console.log('FAIL', ...a); };

const r = await fetch(`${base}/sitemap.xml`);
const type = r.headers.get('content-type') || '';
const xml = await r.text();
if (r.status !== 200) fail('/sitemap.xml', r.status);
if (!/xml/.test(type)) fail('/sitemap.xml content-type', type);
if (!xml.startsWith('<?xml')) fail('/sitemap.xml is not XML (top page HTML?)');
const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
console.log(`sitemap: ${locs.length} URLs (${type})`);

for (const u of locs) {
	const res = await fetch(base + new URL(u).pathname, { redirect: 'manual' });
	const html = res.status === 200 ? await res.text() : '';
	const canon = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
	if (res.status !== 200) fail(u, res.status);
	else if (canon && new URL(canon, u).href !== u) fail(u, 'canonical', canon);
	else console.log('PASS', res.status, u);
}
console.log(bad ? `${bad} FAIL` : 'all PASS');
process.exit(bad ? 1 : 0);
