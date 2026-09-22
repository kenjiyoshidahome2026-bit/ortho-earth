// デモカードの HTML を demos.json から組む（ビルド時に vite.config.js の transformIndexHtml が index.html の <!--DEMOS--> へ差し込む）。
// ＝カードは実 <a href>（JS 非依存・Lighthouse の LCP も静的 HTML のまま）。サンプルが増えたら demos.json に 1 件足すだけ。
// 文言は英語のまま焼き、data-t（訳のキー）を残す＝実行時に i18n が貼り替える（訳が無ければ英語のまま）。
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const T = (tag, cls, text, extra = "") => `<${tag} class="${cls}" data-t="${esc(text)}"${extra}>${esc(text)}</${tag}>`;

function card(d) {
	const noT = ` translate="no"`;
	if (d.featured) {
		const im = d.img;
		// LCP 要素＝lazy 禁止・優先取得（旧トップと同じ＝2026-08-21 Lighthouse mobile の実測で決めた形）
		const img = im ? `<img class="card-poster" src="${esc(im.src)}" srcset="${esc(im.srcset)}" sizes="(max-width: 640px) 92vw, 378px" width="${im.width}" height="${im.height}" fetchpriority="high" decoding="async" alt="${esc(im.alt)}" data-t-alt="${esc(im.alt)}" />` : "";
		return `<a class="card featured" href="${esc(d.href)}" data-group="${esc(d.group)}">${img}<span class="card-body">` +
			(d.eyebrow ? T("span", "card-eyebrow", d.eyebrow) : "") +
			`<span class="card-title"${noT}>${esc(d.title)}</span>` + T("span", "card-desc", d.desc) +
			T("span", "card-cta", `${d.cta ?? "Open"} →`) + `</span></a>`;
	}
	// 固有名詞（ortho-equal 等）は訳さない＝英語の普通名詞の題（World earthquakes 等）だけ data-t
	const proper = /^[a-z0-9]|^GeoPBF$/.test(d.title);
	const title = proper ? `<span class="card-title"${noT}>${esc(d.title)}</span>` : T("span", "card-title", d.title);
	return `<a class="card" href="${esc(d.href)}" data-group="${esc(d.group)}">` +
		(d.icon ? `<span class="card-icon" aria-hidden="true">${esc(d.icon)}</span>` : "") +
		title + T("span", "card-desc", d.desc) + `<span class="card-cta" aria-hidden="true">→</span></a>`;
}

export function renderDemos({ groups, demos }) {
	const featured = demos.filter(d => d.featured), rest = demos.filter(d => !d.featured);
	const chips = [`<button class="chip is-active" data-filter="all" data-t="All">All</button>`]
		.concat(groups.filter(g => rest.some(d => d.group === g.id)).map(g => `<button class="chip" data-filter="${esc(g.id)}" data-t="${esc(g.label)}">${esc(g.label)}</button>`));
	return featured.map(card).join("") +
		`<div class="chips" role="toolbar" data-t-aria-label="Filter demos" aria-label="Filter demos">${chips.join("")}</div>` +
		`<div class="grid">${rest.map(card).join("")}</div>`;
}

// 訳すべき文言の一覧（verify-i18n の門が使う）
export function demoKeys({ groups, demos }) {
	const k = new Set(["All", "Filter demos"]);
	for (const g of groups) k.add(g.label);
	for (const d of demos) {
		k.add(d.desc);
		if (d.featured) { d.eyebrow && k.add(d.eyebrow); k.add(`${d.cta ?? "Open"} →`); d.img?.alt && k.add(d.img.alt); }
		else if (!/^[a-z0-9]|^GeoPBF$/.test(d.title)) k.add(d.title);
	}
	return [...k];
}
