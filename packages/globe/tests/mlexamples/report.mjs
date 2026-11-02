// 公式例の門（台帳 §8）の見比べ帳＝手元の HTML 1 枚（<repo>/.cache/mlexamples/report/<label>/index.html）。公開しない（地図タイルの画像を含む）。
import { completeness } from "./compare.mjs";
// 左に本物・右にこちら（頁の写し＝操作部品も写る）・段と理由・標本点（緑＝色が合う・赤＝合わない・青い輪＝例が足した層に当たる点）。
// 上に段ごとの本数と足りない口の順位表。本人が閾値（THRESH）を目で決めるための帳面。
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const LEVEL = ["0 動かない", "1 動く", "2 同じ答え", "3 同じ絵"];

function dots(rec, marks, W, H) {
	if (!rec?.probes) return "";
	const c = rec.probes.map((p, i) => {
		const m = marks?.[i];
		if (!m || p.x == null) return "";
		return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${m.hit ? "#1a9e5c" : "#d23c3c"}" fill-opacity=".85" ${m.added ? 'stroke="#2f6fe0" stroke-width="3"' : 'stroke="#fff" stroke-width="1"'}/>`;
	}).join("");
	return `<svg class="dots" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${c}</svg>`;
}

const noteOf = (notes, name) => { const n = notes[name]; return !n ? null : typeof n === "string" ? { ja: n, en: "" } : n; };   // notes.json＝{ ja, en }（旧＝文字列）
export function buildReport({ rows, summary, ranking, thresh, refLabel, orthoLabel, when, notes = {} }) {
	const card = r => {
		const note = noteOf(notes, r.name)?.ja;
		const g = r.grade, lvl = g.level == null ? "分母の外" : LEVEL[g.level], ref = g.level == null ? `本物も落ちる：${g.refWhy}` : `本物は ${LEVEL[g.refLevel]} まで`;
		const W = r.R?.container?.W || 800, H = r.R?.container?.H || 600;
		const img = (side, label, rec, marks) => `<figure><div class="shot"><img loading="lazy" src="../../runs/${label}/${side}/${esc(r.name)}.full.png" alt="">${dots(rec, marks, W, H)}</div><figcaption>${side === "ref" ? "本物 MapLibre 6.11.2" : "こちら（MapLibre の口）"} · ${esc(rec?.end ?? "-")}</figcaption></figure>`;
		const cm = g.color, u = g.unsupported;
		return `<article class="card" data-level="${g.level ?? "x"}" data-behind="${g.level != null && g.level < g.refLevel ? 1 : 0}" data-cat="${esc(r.category)}" data-note="${note ? 1 : 0}">
<header><h2 id="${esc(r.name)}">${esc(r.name)}</h2><span class="lv lv${g.level ?? "x"}">${esc(lvl)}</span><span class="muted">${esc(ref)} · ${esc(r.category)}</span></header>
<p class="muted">${esc(r.title)}</p>
${note ? `<p class="note">${esc(note)}</p>` : ""}
${g.reasons.length ? `<ul class="why">${g.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
${u.semantic.length || u.cosmetic.length ? `<p class="unsup">${u.semantic.map(x => `<code class="sem">${esc(x)}</code>`).join(" ")} ${u.cosmetic.map(x => `<code class="cos">${esc(x)}</code>`).join(" ")}</p>` : ""}
${cm ? `<p class="muted">色：足した層 ${cm.added.ok}/${cm.added.n} · 基図 ${cm.base.ok}/${cm.base.n} · 比べられる点 ${cm.comparable}/${cm.total}${g.query ? ` · 問い合わせ ${g.query.ok}/${g.query.n}` : ""}${g.text?.n ? ` · 文字 ${g.text.hit}/${g.text.n}（インク ${g.text.ink}/${g.text.inkN}・こちらだけ ${g.text.extra}${g.text.line ? `・線沿い ${g.text.line}` : ""}）` : ""}</p>` : ""}
<div class="pair">${img("ref", refLabel, r.R, cm?.marks)}${img("ortho", orthoLabel, r.O, cm?.marks)}</div>
</article>`;
	};
	const lvRow = Object.entries(summary.levels).map(([k, v]) => `<div class="stat"><b>${v}</b><span>${esc(k)}</span></div>`).join("");
	return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公式例の門 見比べ帳</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#dedcd6;--l0:#d23c3c;--l1:#d08a1c;--l2:#2f6fe0;--l3:#1a9e5c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9c9a93;--card:#1e1e1c;--line:#34332f}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Hiragino Sans",sans-serif}
main{max-width:1760px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:0}
.muted{color:var(--muted)} .stats{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;display:flex;flex-direction:column;min-width:120px}
.stat b{font-size:22px} table{border-collapse:collapse;background:var(--card);margin:8px 0 16px;width:100%;max-width:1100px}
td,th{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top} td.n{text-align:right;font-variant-numeric:tabular-nums}
nav{position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
nav button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer} nav button.on{outline:2px solid var(--l2)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0}
.card header{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.note{background:#fff7e0;border-left:4px solid #d08a1c;padding:6px 10px;border-radius:4px;color:var(--fg)} @media (prefers-color-scheme:dark){.note{background:#2b2414}}
.lv{font-weight:600;border-radius:4px;padding:0 6px;color:#fff} .lv0{background:var(--l0)} .lv1{background:var(--l1)} .lv2{background:var(--l2)} .lv3{background:var(--l3)} .lvx{background:var(--muted)}
.why{margin:6px 0;padding-left:20px} code{font-size:12px;border-radius:3px;padding:0 4px} code.sem{background:#f3d9d9;color:#7a1f1f} code.cos{background:#e6e4de;color:#555}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:10px}
figure{margin:0} .shot{position:relative;aspect-ratio:4/3;background:#000} .shot img,.shot svg{position:absolute;inset:0;width:100%;height:100%} figcaption{font-size:12px;color:var(--muted)}
</style></head><body><main>
<h1>公式例の門 見比べ帳</h1>
<p class="muted">本物 runs/${esc(refLabel)} · こちら runs/${esc(orthoLabel)} · ${esc(when)} · 閾値 色の許し ${thresh.colorTol}・足した層 ${thresh.addedMin}・基図 ${thresh.baseMin}・問い合わせ ${thresh.queryMin}</p>
<div class="stats">${lvRow}<div class="stat"><b>${summary.plain3}/${summary.plainN}</b><span>同じ絵（鍵・外部ライブラリ・custom 無しの例）</span></div><div class="stat"><b>${summary.pictureOnly}/${summary.pictureN}</b><span>絵だけ見れば同じ（段 2 に依らない）</span></div></div>
<h2>問題のある例とコメント</h2>
<table><tr><th>例</th><th>段</th><th>コメント</th></tr>${rows.filter(r => noteOf(notes, r.name)).map(r => `<tr><td><a href="#${esc(r.name)}">${esc(r.name)}</a></td><td class="n">${r.grade.level == null ? "外" : r.grade.level}</td><td>${esc(noteOf(notes, r.name).ja)}</td></tr>`).join("")}</table>
<h2>足りない口の順位表（こちらの段が本物より低い例を塞いでいる物）</h2>
<table><tr><th>塞いでいる物</th><th>例の数</th><th>例</th></tr>${ranking.slice(0, 40).map(b => `<tr><td>${esc(b.blocker)}</td><td class="n">${b.n}</td><td class="muted">${esc(b.examples.slice(0, 6).join(", "))}${b.examples.length > 6 ? " …" : ""}</td></tr>`).join("")}</table>
<nav><button data-f="all" class="on">全部</button><button data-f="behind">本物より低い</button><button data-f="note">コメントあり</button>${[0, 1, 2, 3].map(l => `<button data-f="l${l}">${LEVEL[l]}</button>`).join("")}<button data-f="lx">分母の外</button></nav>
${rows.map(card).join("\n")}
</main><script>
for (const b of document.querySelectorAll("nav button")) b.onclick = () => {
	document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
	const f = b.dataset.f;
	for (const c of document.querySelectorAll(".card")) c.hidden = !(f === "all" || (f === "behind" && c.dataset.behind === "1") || (f === "note" && c.dataset.note === "1") || f === "l" + c.dataset.level);
};
</script></body></html>`;
}

// 丸（標本点）の無い一覧＝人が見比べる用（2026-09-30 本人「比較の丸を抜いて・リンク先を入れれば比較はユーザーでできる」「美しく・絵を横に揃えて・英語で」）。
// 1 例＝こちらの写し（上・同じ比率で横に揃う）＋題＋段＋分類＋リンク（公式サイトの例・本物をこの走らせ台で・こちらで）。コメント（日本語）は畳んでおく。本物の写しは載せない（公式の頁で見る）
// publish＝www に置く形（2026-10-01 本人「Get Started に MapLibre コンパチを謳い、今回作ったデモを入れて」）：{ thumb: name => 画像の URL, run: name => 走らせる頁の URL }。
//   無し＝手元の見比べ帳（写しは runs/ の full.png・Run は走らせ台）
// 例の本文→ortho で動く形：替えるのは 2 つの道だけ（MapLibre の module → 通訳の npm の口・CSS → unpkg の本物）。例の本文は他に一文字も変えない
export const toOrthoForm = src => src
	.replace(/(['"])\.\.\/\.\.\/dist\/maplibre-gl-dev\.mjs\1/g, "\"@ortho-earth/globe/maplibre\"")
	.replace(/(['"])\.\.\/\.\.\/dist\/maplibre-gl\.css\1/g, "\"https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.css\"");
// 走らせる頁＝ortho の形の本文に import map を 1 つ差すだけ（bare の "@ortho-earth/globe/maplibre" → 共有エンジンの maplibre 入口）
export const runnableForm = (src, engineUrl) => toOrthoForm(src).replace(/<head([^>]*)>/i, (m) => `${m}\n<script type="importmap">{"imports":{"@ortho-earth/globe/maplibre":${JSON.stringify(engineUrl)}}}</script>`);
// 公開の頁の head（www のデモ一覧に載る頁の作法＝apps/www/tests/t-demo-pages.mjs・2026-10-14 本人「このページも一つのアプリとして www に」）
const PUBLISH_DESC = "The official MapLibre GL JS examples, run unchanged on the Ortho Earth 3D globe (WebGPU) by changing one import — pictured next to MapLibre GL JS, each with its source and a Run button.";
const PUBLISH_TITLE = "MapLibre GL JS examples on a 3D globe — Ortho Earth";   // 公開の頁の title（Issue #308 段 2＝MapLibre の語で着く頁・見出しと本文は変えない）
const PUBLISH_HEAD = `<meta name="description" content="${PUBLISH_DESC}"><meta name="theme-color" content="#f7f7f5"><link rel="canonical" href="https://www.ortho-earth.com/maplibre/"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta property="og:title" content="${PUBLISH_TITLE}"><meta property="og:description" content="${PUBLISH_DESC}"><meta property="og:image" content="https://www.ortho-earth.com/thumbs/maplibre.webp"><meta property="og:url" content="https://www.ortho-earth.com/maplibre/"><meta name="twitter:card" content="summary_large_image">`;
// 段の印（2026-10-23 本人「1/2/3 に赤黄緑のマークを入れた方が分かりやすい(0は紫？)」）＝カードの % の前の丸と、段ごとの絞り込み
// 段の名と説明＝Sandcastle のギャラリー（tests/csexamples/publish.mjs の LV）と同じ言い回し（2026-11-02 本人「比較表の表現を Cesium と合わせる」）
const GLV = [["Doesn't run", "the example does not run on Ortho Earth"], ["Runs", "it runs, but some of it does not work"], ["Same answers", "it works and answers the same (layers, queries, markers, popups, camera), the picture differs"], ["Same picture", "it works and gives the same picture as MapLibre"]];
// 上段・下段の文だけ日英（ブラウザの言語が ja なら日本語・他は英語・右上の札で切替）。カード・絞り込み・対話は英語のまま（2026-11-02 本人）
const GLV_JA = [["動かない", "Ortho Earth で例が動かない"], ["動く", "動くが、一部が働かない"], ["同じ答え", "動いて答え（層・問い合わせ・マーカー・ポップアップ・カメラ）が同じ、絵は違う"], ["同じ絵", "動いて MapLibre と同じ絵になる"]];
const i18n = (en, ja) => `<div class="i18n" lang="en">${en}</div><div class="i18n" lang="ja">${ja}</div>`;
const I18N_BOOT = `<script>(()=>{let l="en";try{l=localStorage.getItem("lang")||((navigator.language||"").toLowerCase().startsWith("ja")?"ja":"en")}catch(e){}document.documentElement.dataset.lang=l})()</script>`;
const I18N_CSS = `.i18n[lang=ja]{display:none} html[data-lang=ja] .i18n[lang=ja]{display:block} html[data-lang=ja] .i18n[lang=en]{display:none} html[data-lang=ja] .i18n .lv{margin-top:1px}
.lang{float:right;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer} .lang:hover{border-color:var(--fg)}`;
const I18N_JS = `const lgBtn = document.getElementById("lang"); const lgPaint = () => { lgBtn.textContent = document.documentElement.dataset.lang === "ja" ? "English" : "日本語"; }; lgPaint();
lgBtn.onclick = () => { const l = document.documentElement.dataset.lang === "ja" ? "en" : "ja"; document.documentElement.dataset.lang = l; try { localStorage.setItem("lang", l); } catch (e) {} lgPaint(); };`;
const lvDot = (l, tip = true) => l == null ? "" : `<span class="lv lv${l}"${tip ? ` title="${GLV[l][0]}"` : ""}></span>`;
// 本物の写しを出さない例（本物の記録が例の狙いを写していない＝並べると誤解を招く）：理由はカードの代わりの札に
export const REF_PIC_UNAVAILABLE = {
	"3d-terrain": "OpenStreetMap blocked the reference's tile requests (403 picture)",
	"add-3d-terrain-from-quantized-mesh-tiles": "OpenStreetMap blocked the reference's tile requests (403 picture)",
	"add-a-raster-tile-source": "OpenStreetMap blocked the reference's tile requests (403 picture)",
	"add-a-cog-raster-source": "the reference capture could not read the COG (recorded network data)",
};
// 絵の一致＝標本点のうち色が本物と合う割合（基図＋足した層・両側とも止まって撮れた例だけ）＝Sandcastle の Picture % と同じ置き方。動く例・比べられない例は出さない
export const picturePct = g => { const c = g?.color; if (!g?.pictureCompared || !c) return null; const n = c.base.n + c.added.n; return n ? Math.round(100 * (c.base.ok + c.added.ok) / n) : null; };
const mlDocs = name => `https://maplibre.org/maplibre-gl-js/docs/examples/${encodeURIComponent(name)}/`;
export function buildGallery({ rows, refLabel, orthoLabel, when, notes = {}, sources = {}, base = "http://localhost:5253", publish = null, engine = "", maplibre = "6.11.2" }) {
	// 絵＝本物（左）とこちら（右）を並べる（Sandcastle のギャラリーと同じ形・2026-11-02）。publish.pic(name, side) か、手元は runs/ の full.png
	const pic = (name, side) => publish ? publish.pic(name, side) : `../../runs/${side === "ref" ? refLabel : orthoLabel}/${side}/${name}.full.png`;
	const shot = r => {
		const why = REF_PIC_UNAVAILABLE[r.name] || (r.grade?.level == null ? r.grade?.refWhy : null);
		const ref = why ? `<figure class="na" title="${esc(why)}"><p>Reference picture not shown</p><figcaption>MapLibre GL JS</figcaption></figure>` : `<figure><img loading="lazy" src="${esc(pic(r.name, "ref"))}" alt="MapLibre GL JS"><figcaption>MapLibre GL JS</figcaption></figure>`;
		return `<div class="shot">${ref}<figure><img loading="lazy" src="${esc(pic(r.name, "ortho"))}" alt="Ortho Earth"><figcaption>Ortho Earth</figcaption></figure></div>`;
	};
	// 段（同じ絵／同じ答え）はこちらの解釈＝載せない（2026-09-30 本人）。ただし絞り込みは note でなく段で数える（2026-10-23 本人「noteではなく、段１を数えるようにした方がいい」）＝カードに data-level。載せるのは写し・題・分類 (一致度 %)。カードを押すと覗き窓＝ortho で動く形の本文（例の 2 つの道だけ替えた物）＋英日の注釈＋ Run（走らせ台の頁を iframe で・タブを増やさない）＋コピー／ダウンロード
	const cats = [...new Set(rows.map(r => r.category).filter(Boolean))].sort();
	const toOrtho = toOrthoForm;
	const payload = {};
	for (const r of rows) {
		const n = noteOf(notes, r.name), why = REF_PIC_UNAVAILABLE[r.name] || (r.grade?.level == null ? r.grade?.refWhy : null);
		payload[r.name] = { title: r.title || r.name, html: sources[r.name] ? toOrtho(sources[r.name]) : "", note: n ? { en: n.en || "", ja: n.ja || "" } : null, l: r.grade?.level ?? null, pc: picturePct(r.grade), ref: why ? null : pic(r.name, "ref"), ortho: pic(r.name, "ortho"), why: why || null };
	}
	const card = r => {
		const note = noteOf(notes, r.name), pc = picturePct(r.grade), c = completeness(r.grade);
		const pct = r.grade?.level == null ? `<span class="pct na" title="${esc(r.grade?.refWhy || "reference not available")}">n/a</span>` : pc == null ? "" : `<span class="pct" title="sampled points of the picture whose colour matches MapLibre GL JS${c ? ` · ${esc(c.detail)}` : ""}" data-pct="${pc}">${pc}%</span>`;
		return `<article class="card" data-cat="${esc(r.category)}" data-note="${note ? 1 : 0}" data-level="${r.grade?.level ?? "x"}" data-name="${esc(r.name)}" tabindex="0" role="button" aria-label="${esc(r.title || r.name)}">
${shot(r)}
<div class="body">
<h2 title="${esc(r.title || r.name)}">${esc(r.title || r.name)}</h2>
<p class="meta"><button type="button" class="cat" data-cat="${esc(r.category || "")}" title="Show this category">${esc(r.category || "")}</button> ${lvDot(r.grade?.level)}${pct}${note ? ` <span class="nt" title="Has a note">note</span>` : ""}</p>
</div></article>`;
	};
	const n = rows.length, cnt = l => rows.filter(r => r.grade?.level === l).length;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${publish ? PUBLISH_TITLE : "MapLibre examples on ortho-earth"}</title>${publish ? PUBLISH_HEAD : ""}${I18N_BOOT}
<style>
:root{--bg:#f7f7f5;--fg:#17170f;--muted:#6f6e68;--card:#ffffff;--line:#e6e5e0;--acc:#d99a2b;--code:#f1f0ec;--shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px -12px rgba(0,0,0,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--fg:#eeede8;--muted:#9c9b94;--card:#1c1c1a;--line:#2d2d2a;--code:#161615;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.7)}}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1320px;margin:0 auto;padding:40px 24px 72px}
header.top .home{margin:0 0 14px;font-size:13.5px;color:var(--muted)} header.top .home a{color:inherit;text-decoration:none} header.top .home a:hover{color:var(--fg)}
header.top h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px;font-weight:650} header.top p{margin:0;color:var(--muted);max-width:70ch} header.top a{color:inherit;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--acc)}
nav{position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);padding:12px 0;margin:22px 0 18px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line)}
nav button,nav select{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 14px;font:inherit;font-size:13.5px;cursor:pointer} nav button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)} nav .sp{flex:1} nav .count{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:22px 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column;transition:transform .15s ease,box-shadow .15s ease;cursor:pointer}
.card[hidden]{display:none}   /* display:flex が UA の [hidden] に勝つ＝絞り込みで消えなかった（2026-09-30 本人「セレクトできてない」） */
.card:hover,.card:focus-visible{transform:translateY(-2px);box-shadow:0 2px 4px rgba(0,0,0,.06),0 16px 32px -14px rgba(0,0,0,.28);outline:none}
.shot{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--line)} figure{margin:0;position:relative;aspect-ratio:4/3;background:#e9e8e3;overflow:hidden} figure img{width:100%;height:100%;object-fit:cover;display:block}
figcaption{position:absolute;left:6px;bottom:6px;font-size:11px;line-height:1;padding:4px 7px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff}
figure.na{display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(135deg,#e9e8e3 0 10px,#e2e1dc 10px 20px)} figure.na p{margin:0;padding:0 12px;font-size:12px;color:var(--muted);text-align:center} @media (prefers-color-scheme:dark){figure,figure.na{background:#232321}}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px}
h2{font-size:15.5px;font-weight:600;margin:0;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{margin:0;color:var(--muted);font-size:13px}
.dh a{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none} .dh a:hover{border-color:var(--fg)}
.dp{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 18px 0} .dp figure{border-radius:10px} @media (max-width:640px){.dp{grid-template-columns:1fr}}
.dm{padding:12px 18px 0;font-size:13.5px;color:var(--muted)} .dm p{margin:0}
${I18N_CSS}
.pct{font-weight:650;color:var(--fg);font-variant-numeric:tabular-nums;cursor:help} .pct.na{color:var(--muted);font-weight:500}
.lv{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:0} .lv0{background:#8e5bd6} .lv1{background:#d64545} .lv2{background:#e0b020} .lv3{background:#2e9e5b}
.nt{font-size:11px;border:1px solid var(--acc);color:var(--acc);border-radius:999px;padding:0 7px;margin-left:4px;vertical-align:1px}
.meta .cat{border:0;background:transparent;color:var(--muted);font:inherit;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px} .meta .cat:hover{color:var(--fg);text-decoration-color:var(--acc)}
footer{margin-top:48px;color:var(--muted);font-size:12.5px;line-height:1.7}
dialog{border:0;border-radius:16px;padding:0;width:min(1080px,calc(100vw - 32px));max-height:calc(100vh - 48px);background:var(--card);color:var(--fg);box-shadow:0 24px 64px -24px rgba(0,0,0,.5)} dialog::backdrop{background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
.dh{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1} .dh h3{margin:0;font-size:16px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dh button{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer} .dh button:hover{border-color:var(--fg)} .dh button.ok,.dh button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.fr{margin:14px 18px 0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#e9e8e3;aspect-ratio:16/9} .fr iframe{width:100%;height:100%;border:0;display:block}
.dn{margin:14px 18px 0;font-size:13.5px;line-height:1.55;background:color-mix(in srgb,var(--acc) 10%,var(--card));border-left:3px solid var(--acc);padding:10px 12px;border-radius:8px} .dn p{margin:0} .dn p+p{margin-top:6px} .dn .ja{color:var(--muted)}
.hw{margin:12px 18px 0;font-size:13px;line-height:1.55;color:var(--muted)} .hw p{margin:0} .hw p+p{margin-top:4px} .hw code{font-size:12px;background:var(--code);padding:1px 5px;border-radius:4px} .hw a{color:inherit}
pre{margin:12px 0 0;padding:16px 18px 20px;background:var(--code);font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:auto;tab-size:4;white-space:pre}
h1 .ver{font-size:.55em;font-weight:600;vertical-align:middle;margin-left:.35em;padding:2px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
</style></head><body><main>
<header class="top"><p class="home">${publish ? `<a href="/">Ortho Earth</a> · <a href="/start.md">Get started</a> · <a href="/sandcastle/">Sandcastle examples</a> · <a href="https://www.npmjs.com/package/@ortho-earth/globe">npm</a>` : ""}<button type="button" id="lang" class="lang" title="日本語 / English">日本語</button></p><h1>MapLibre GL JS examples${publish && engine ? ` <span class="ver">v${esc(engine)}</span>` : ""}</h1>
${i18n(`<p>A comparison of the <a href="https://maplibre.org/maplibre-gl-js/docs/examples/" target="_blank" rel="noopener">official MapLibre GL JS examples</a> run on Ortho Earth — not the official MapLibre site.</p>
<p>Each of the ${n} examples runs unchanged: once on MapLibre GL JS ${esc(maplibre)}, once on the Ortho Earth globe through its MapLibre-compatible API (<code>@ortho-earth/globe/maplibre</code>: MapLibre's own Map, style, sources, layers, expressions, markers and popups, with Ortho Earth doing the drawing), from the same recorded network data and the same camera. Each card shows MapLibre GL JS on the left and Ortho Earth on the right. Click a card for the larger pictures and the example's source in its Ortho Earth form — run it here, copy it, or download it.</p>
<p><b>Mercator is not drawn here.</b> Ortho Earth always draws the globe and has no flat Mercator view, so where MapLibre fills the screen with a world map at low zoom, the right-hand picture shows a small globe by design; the notes say so where it matters.</p>`,
`<p><a href="https://maplibre.org/maplibre-gl-js/docs/examples/" target="_blank" rel="noopener">MapLibre GL JS の公式の例</a>を Ortho Earth で走らせた比較です。MapLibre の公式サイトではありません。</p>
<p>${n} 例を、手を加えずにそれぞれ二度走らせました。一度は MapLibre GL JS ${esc(maplibre)} で、一度は MapLibre 互換の API（<code>@ortho-earth/globe/maplibre</code>＝Map・style・ソース・層・式・マーカー・ポップアップは MapLibre のまま、描くのは Ortho Earth）を通して Ortho Earth の地球儀で、同じ記録済みの通信と同じカメラから。各カードの左が MapLibre GL JS、右が Ortho Earth です。カードを押すと大きな絵と、Ortho Earth の形にした例の本文が開きます（ここで走らせる・写す・落とす）。</p>
<p><b>メルカトルは描きません。</b>Ortho Earth はいつも地球儀を描き、平らなメルカトルの眺めがありません。MapLibre が低いズームで世界地図を画面いっぱいに出す所では、右の絵は小さな地球儀になります。それは設計どおりで、要る所には注記があります。</p>`)}</header>
<nav><button data-f="all" class="on">All · ${n}</button>${[3, 2, 1, 0].map(l => `<button data-f="l${l}" title="${esc(GLV[l][1])}">${lvDot(l, false)}${GLV[l][0]} · ${cnt(l)}</button>`).join("")}<span class="count" id="count"></span><span class="sp"></span>
<select id="cat"><option value="">All categories</option>${cats.map(c => `<option>${esc(c)}</option>`).join("")}</select></nav>
<div class="grid">${rows.map(card).join("\n")}</div>
<footer>${i18n(`Levels: ${[3, 2, 1, 0].map(l => `${lvDot(l, false)}${l} ${GLV[l][0]} = ${esc(GLV[l][1])}`).join(" · ")}.<br>
Picture % = the sampled points of the 800×600 picture whose colour matches MapLibre GL JS (basemap and the layers the example adds; animated examples are not compared). The level is a guide; the pictures are what to judge by. Hover the number for the counts.<br>
${publish ? `Pictures: MapLibre GL JS ${esc(maplibre)} and Ortho Earth (@ortho-earth/globe ${esc(engine)}) on a real GPU (Apple M5 Pro, WebGPU), captured ${esc(when.slice(0, 10))}, both run from the same recorded network data. Some examples use map services whose keys only work on maplibre.org — those do not load here when you press Run.` : `Captures: ortho runs/${esc(orthoLabel)} · reference runs/${esc(refLabel)} · ${esc(when)}. "Run" works while the local rig is up (<code>npm run verify:examples -- --serve</code>, ${esc(base)}).`}<br>
Examples © MapLibre contributors (BSD-3-Clause), run unchanged from MapLibre GL JS ${esc(maplibre)}; MapLibre GL JS draws the left pictures. Ortho Earth is not affiliated with or endorsed by the MapLibre project. Basemap data and imagery in the pictures belong to their providers; see the attribution inside each example.`,
`段：${[3, 2, 1, 0].map(l => `${lvDot(l, false)}${l} ${esc(GLV_JA[l][0])}＝${esc(GLV_JA[l][1])}`).join(" · ")}。<br>
絵の %＝800×600 の絵の標本点のうち、色が MapLibre GL JS と合う割合（基図と、例が足す層。動く例は比べません）。段は目安で、判断は絵で。数字に重ねると内訳が出ます。<br>
${publish ? `絵：MapLibre GL JS ${esc(maplibre)} と Ortho Earth（@ortho-earth/globe ${esc(engine)}）を実機の GPU（Apple M5 Pro・WebGPU）で ${esc(when.slice(0, 10))} に撮ったもの。両方とも同じ記録済みの通信から走らせています。鍵が maplibre.org でしか働く地図サービスを使う例は、ここで Run を押しても読み込めません。` : `写し：ortho runs/${esc(orthoLabel)}・本物 runs/${esc(refLabel)}・${esc(when)}。「Run」は手元の rig が上がっている間だけ働きます（<code>npm run verify:examples -- --serve</code>・${esc(base)}）。`}<br>
例 © MapLibre contributors（BSD-3-Clause）。MapLibre GL JS ${esc(maplibre)} の例を手を加えずに走らせ、左の絵は MapLibre GL JS が描いています。Ortho Earth は MapLibre プロジェクトと無関係で、承認も受けていません。絵の中の基図データと画像は各提供元のものです。出典は各例の中の表示を見てください。`)}</footer>
</main>
<dialog id="dlg"><div class="dh"><h3 id="dt"></h3><a id="ml" target="_blank" rel="noopener">Open on maplibre.org</a><button type="button" id="run" title="Run this example here">Run</button><button type="button" id="cp">Copy</button><button type="button" id="dl">Download</button><button type="button" id="cl">Close</button></div>
<div class="dp"><figure id="fref"><img id="ir" alt="MapLibre GL JS"><figcaption>MapLibre GL JS</figcaption></figure><figure><img id="io" alt="Ortho Earth"><figcaption>Ortho Earth</figcaption></figure></div>
<div class="dm" id="dm"></div>
<div class="fr" id="fr" hidden></div>
<div class="dn" id="dn" hidden></div>
<div class="hw"><p><b>Run it yourself.</b> This is the example's HTML with only two paths changed: the MapLibre module import is now <code>@ortho-earth/globe/maplibre</code>, and the CSS comes from unpkg. Save it as <code>index.html</code> in a Vite project that has <code>@ortho-earth/globe</code> installed (<a href="https://www.ortho-earth.com/start.md" target="_blank" rel="noopener">Get started</a>, Route A), then <code>npm run dev</code>. The engine's workers must come from your own origin, so a bare CDN import does not work. <b>Run</b> above plays this very source right here${publish ? "" : " (local rig)"}.</p>
<p class="ja">自分で動かす：例の HTML のうち 2 つの道だけを替えたものです（MapLibre の import → <code>@ortho-earth/globe/maplibre</code>・CSS は unpkg の本物）。<code>@ortho-earth/globe</code> を入れた Vite の企画に <code>index.html</code> として置き、<code>npm run dev</code>。エンジンの worker は自分の origin から配る必要があるので、CDN からの直 import では動きません。上の <b>Run</b> はこの本文そのものをこの場で動かします${publish ? "" : "（手元の走らせ台）"}。</p></div>
<pre><code id="dc"></code></pre></dialog>
<script type="application/json" id="payload">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>
let f = "all", cat = "";
const apply = () => { let n = 0; for (const c of document.querySelectorAll(".card")) { const on = (f === "all" || f === "l" + c.dataset.level) && (!cat || c.dataset.cat === cat); c.hidden = !on; if (on) n++; } document.getElementById("count").textContent = n + " examples"; };
for (const b of document.querySelectorAll("nav button")) b.onclick = () => { document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b)); f = b.dataset.f; apply(); };
document.getElementById("cat").onchange = e => { cat = e.target.value; apply(); };
for (const b of document.querySelectorAll(".meta .cat")) b.onclick = e => { e.stopPropagation(); cat = cat === b.dataset.cat ? "" : b.dataset.cat; document.getElementById("cat").value = cat; apply(); window.scrollTo({ top: 0, behavior: "smooth" }); };   // カードの分類＝押すと絞る（もう一度で解除）
apply();
const P = JSON.parse(document.getElementById("payload").textContent), dlg = document.getElementById("dlg"), $ = id => document.getElementById(id), BASE = ${JSON.stringify(base)}, RUN = ${publish ? JSON.stringify(Object.fromEntries(rows.map(r => [r.name, publish.run(r.name)]))) : "null"}, LV = ${JSON.stringify(GLV.map(x => x[0]))}, DOCS = ${JSON.stringify(mlDocs("X"))};
${I18N_JS}
let cur = null;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;" })[c]);
const stop = () => { $("fr").hidden = true; $("fr").innerHTML = ""; $("run").textContent = "Run"; $("run").classList.remove("on"); };
const open = name => {
	const p = P[name]; if (!p) return; cur = name; stop();
	$("dt").textContent = p.title; $("dc").textContent = p.html || "(source not captured)";
	$("ml").href = DOCS.replace("X", encodeURIComponent(name));
	const fr0 = $("fref"); fr0.classList.toggle("na", !p.ref); fr0.title = p.why || ""; $("ir").hidden = !p.ref; $("ir").src = p.ref || ""; $("io").src = p.ortho;
	fr0.querySelector("p")?.remove(); if (!p.ref) { const q = document.createElement("p"); q.textContent = "Reference picture not shown"; fr0.prepend(q); }
	const dm = $("dm"); dm.replaceChildren(); const ln = document.createElement("p"); ln.textContent = (p.l == null ? "Not scored" : LV[p.l]) + (p.pc == null ? "" : " · picture " + p.pc + "%"); dm.append(ln);
	const dn = $("dn"); dn.hidden = !p.note; dn.innerHTML = p.note ? (p.note.en ? "<p>" + esc(p.note.en) + "</p>" : "") + (p.note.ja ? "<p class=\\"ja\\">" + esc(p.note.ja) + "</p>" : "") : "";
	$("cp").textContent = "Copy"; $("cp").classList.remove("ok");
	if (!dlg.open) dlg.showModal(); dlg.scrollTop = 0; history.replaceState(null, "", "#" + name);
};
for (const c of document.querySelectorAll(".card")) { c.onclick = () => open(c.dataset.name); c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(c.dataset.name); } }; }
// Run＝同じ本文を通訳で走らせる走らせ台の頁を、この窓の中（iframe）で（タブを増やさない・2026-09-30 本人）。もう一度で止める
$("run").onclick = () => { if (!$("fr").hidden) return stop(); const fr = $("fr"); fr.hidden = false; const f = document.createElement("iframe"); f.src = ${publish ? `Object.hasOwn(RUN, cur) ? RUN[cur] : "about:blank"` : `BASE + "/ortho/test/examples/" + cur + ".html"`}; f.allow = "fullscreen"; f.loading = "eager"; fr.replaceChildren(f); $("run").textContent = "Stop"; $("run").classList.add("on"); };   // 要素で組む（HTML の文字列を組まない）
$("cl").onclick = () => dlg.close();
dlg.onclick = e => { if (e.target === dlg) dlg.close(); };
dlg.onclose = () => { stop(); history.replaceState(null, "", location.pathname + location.search); };
$("cp").onclick = async () => { const b = $("cp"); try { await navigator.clipboard.writeText(P[cur].html); } catch { const r = document.createRange(); r.selectNodeContents($("dc")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand("copy"); sel.removeAllRanges(); } b.textContent = "Copied"; b.classList.add("ok"); setTimeout(() => { b.textContent = "Copy"; b.classList.remove("ok"); }, 1400); };
$("dl").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([P[cur].html], { type: "text/html" })); a.download = cur + ".html"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
{ const h = location.hash.slice(1), k = Object.keys(P).find(x => x === h); if (k) open(k); }   // 開く名前は一覧の鍵から取る（URL の文字をそのまま使わない）
</script></body></html>`;
}
