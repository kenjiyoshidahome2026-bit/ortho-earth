// デモ頁の品質の門（2026-10-04・デモ品質の段）＝www のデモ一覧（demos.json）に載る全頁の入口 HTML を同じ物差しで検める。
// ブラウザは要らない（静的）。見るのは「増えたデモが最初の一枚から揃っているか」＝head の共有カード・言語・起動画面の作法：
//   ① <html lang>・<title>・description・viewport（width=device-width・ピンチ拡大を殺さない）・theme-color・canonical・favicon
//   ② 共有カード＝og:title/description/image（絶対 URL・画像はこのリポジトリに実在）・twitter:card
//   ③ 起動画面（#boot）がある頁＝aria-label は "Loading"（head と同じ英語）・prefers-reduced-motion で止まる
// 頁を足したら demos.json にカードを足す＝この門が自動で見る。例外は EXEMPT に理由と共に書く。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WWW = path.dirname(path.dirname(fileURLToPath(import.meta.url))), APPS = path.dirname(WWW);
const demos = JSON.parse(readFileSync(path.join(WWW, "demos.json"), "utf8")).demos;

// デモの URL → 入口 HTML（本番の Worker の規則＝/japan/<名前> は apps/ortho-japan/<名前>.html・拡張子なし）
const ENTRY = [
	[/^\/japan\/census2020\//, "census2020/index.html"],
	[/^\/japan\/(geoedit|scene|tellus|parks|models|fireworks)(?=[#?]|$)/, (m) => `ortho-japan/${m[1]}.html`],
	[/^\/japan\//, "ortho-japan/index.html"],
	[/^\/globe\/(physical|quakes|sats|clouds)(?=[#?]|$)/, (m) => `ortho-globe/${m[1]}.html`],
	[/^\/globe\//, "ortho-globe/index.html"],
	[/^\/world\//, "world/index.html"], [/^\/equal\//, "equal/index.html"], [/^\/solar\//, "solar/index.html"], [/^\/quiz\//, "world-quiz/index.html"],
	[/^\/geopbf\//, "geopbf-demo/index.html"], [/^\/gishub-jp\//, "gishub-jp/index.html"], [/^\/nl\//, "ortho-nl/index.html"],
];
export const entryOf = href => { for (const [re, to] of ENTRY) { const m = href.match(re); if (m) return typeof to === "function" ? to(m) : to; } return null; };

// 共有カードの画像の URL → このリポジトリの実体（www の public は / 直下・各アプリの public はその配信ベース）
const IMG = [
	[/^https:\/\/www\.ortho-earth\.com\/thumbs\/(.+)$/, m => `www/public/thumbs/${m[1]}`],
	[/^https:\/\/www\.ortho-earth\.com\/japan\/og\/(.+)$/, m => `ortho-japan/public/og/${m[1]}`],
	[/^https:\/\/www\.ortho-earth\.com\/japan\/(ogp\.jpg)$/, m => `ortho-japan/public/${m[1]}`],
	[/^https:\/\/www\.ortho-earth\.com\/globe\/og\/(.+)$/, m => `ortho-globe/public/og/${m[1]}`],
	[/^https:\/\/www\.ortho-earth\.com\/solar\/(ogp\.jpg)$/, m => `solar/public/${m[1]}`],
];
const imageFile = url => { for (const [re, to] of IMG) { const m = url.match(re); if (m) return to(m); } return null; };

const meta = (html, re) => { const m = html.match(re); return m ? m[1] : null; };
const prop = (html, p) => meta(html, new RegExp(`<meta\\s+property="${p}"\\s+content="([^"]*)"`));
const name = (html, n) => meta(html, new RegExp(`<meta\\s+name="${n}"\\s+content="([^"]*)"`));

const pages = new Map();   // 入口 HTML → それを使うデモ（同じ頁を複数のカードが指す＝japan の 4 枚）
for (const d of demos) { const e = entryOf(d.href); assert.ok(e, `demos.json: no entry page for ${d.id} (${d.href}) — add a rule to ENTRY`); (pages.get(e) ?? pages.set(e, []).get(e)).push(d); }

test("demos.json の全カードが入口 HTML に辿り着く（22 枚・12 頁以上）", () => {
	assert.equal(demos.length, 22);
	assert.ok(pages.size >= 12, `${pages.size} pages`);
	for (const e of pages.keys()) assert.ok(existsSync(path.join(APPS, e)), `${e} missing`);
});

for (const [entry, ds] of pages) {
	const html = readFileSync(path.join(APPS, entry), "utf8");
	const ids = ds.map(d => d.id).join(",");
	test(`${entry}（${ids}）：head の基本＝lang・title・description・viewport・theme-color・canonical・favicon`, () => {
		const lang = meta(html, /<html[^>]*\slang="([^"]*)"/);
		assert.ok(lang, "html lang");
		// 26 言語の頁は head が英語（共有カードと検索が読む＝本人 2026-09-21「全ての head は英語」）。日本語だけの頁（gishub-jp・census2020・nl）は ja
		// 例外：/nl/ は head（題・説明・出典）が日本語のまま（エンジンの UI は 26 言語）＝英語化は本人の裁定待ち（台帳 apps/www/demos-quality.md）
		const want = ds.every(d => d.lang === "ja") || entry === "ortho-nl/index.html" ? "ja" : "en";
		assert.equal(lang, want, `html lang should be ${want} for ${ids}`);
		assert.ok(/<title>[^<]+<\/title>/.test(html), "title");
		assert.ok(name(html, "description"), "meta description");
		const vp = name(html, "viewport") ?? "";
		assert.ok(/width=device-width/.test(vp), "viewport width=device-width");
		assert.ok(!/user-scalable=no|maximum-scale=1(\.0)?\b/.test(vp), "viewport must not block pinch zoom (a11y)");
		assert.ok(name(html, "theme-color"), "theme-color");
		assert.ok(/<link rel="canonical" href="https:\/\/www\.ortho-earth\.com\/[^"]*">/.test(html), "canonical");
		assert.ok(/<link rel="icon"[^>]*favicon\.svg|<link rel="icon" type="image\/svg\+xml" href="[^"]*favicon\.svg"/.test(html), "favicon");
	});
	test(`${entry}（${ids}）：共有カード＝og:title/description/image（実在する画像）・twitter:card`, () => {
		assert.ok(prop(html, "og:title"), "og:title");
		assert.ok(prop(html, "og:description"), "og:description");
		const img = prop(html, "og:image");
		assert.ok(img && /^https:\/\//.test(img), "og:image (absolute https URL)");
		const file = imageFile(img);
		assert.ok(file, `og:image ${img} is not a URL this repository serves (add a rule to IMG)`);
		assert.ok(existsSync(path.join(APPS, file)), `og:image file missing: apps/${file}`);
		assert.ok(name(html, "twitter:card"), "twitter:card");
	});
	if (html.includes('id="boot"')) test(`${entry}（${ids}）：起動画面＝aria-label "Loading"・reduced-motion で止まる`, () => {
		assert.ok(/id="boot"><svg[^>]*aria-label="Loading"/.test(html), 'boot aria-label="Loading" (not 起動中: the head is English)');
		assert.ok(/prefers-reduced-motion:\s*reduce/.test(html), "prefers-reduced-motion rule for #boot");
	});
}
