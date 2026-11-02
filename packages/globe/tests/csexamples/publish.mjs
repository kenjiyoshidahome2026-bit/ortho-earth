#!/usr/bin/env node
// The public gallery of the Cesium examples gate ("Sandcastle", www /sandcastle/, 2026-10-30): every Sandcastle example as a card with the
// real Cesium's picture and Ortho Earth's side by side, its level and its picture agreement. Same form as the MapLibre gallery (/maplibre/,
// scripts/verify-examples.mjs publishGallery) but without runnable examples (they need the user's own Cesium ion token / Google key).
// Usage: node packages/globe/tests/csexamples/publish.mjs <run dir> [<run dir> …] [--out apps/www/public/sandcastle]
//   each run dir holds summary.json, ref/ and ortho/ (run.mjs + grade.mjs); a later run dir replaces the earlier one's examples it graded.
//   checked.json gives the examples the gate does not grade but were compared by eye their level.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBootStatic } from "../../src/boot/screen.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url)), PKG = path.resolve(HERE, "../..");
const argv = process.argv.slice(2);
const oi = argv.indexOf("--out"), OUT = path.resolve(oi >= 0 ? argv[oi + 1] : path.resolve(PKG, "../../apps/www/public/sandcastle"));
const runs = argv.filter((a, i) => !a.startsWith("--") && (oi < 0 || i !== oi + 1)).map(d => path.resolve(d));
if (!runs.length) { console.error("usage: publish.mjs <run dir> [<run dir> …] [--out <dir>]"); process.exit(2); }

const corpus = JSON.parse(fs.readFileSync(path.join(HERE, "corpus.json"), "utf8"));
const checked = JSON.parse(fs.readFileSync(path.join(HERE, "checked.json"), "utf8"));
const engine = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version;
const series = engine.replace(/^(\d+\.\d+)\..*$/, "$1.x");   // the pictures come from main after that release, so not exactly that version
// per example: the last run that has both pictures (a partial re-shoot overrides the full one for what it shot)
const pick = new Map();
let cesium = corpus.cesium?.version ?? corpus.cesium ?? "", at = "";
for (const dir of runs) {
	const s = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
	cesium = s.cesium || cesium; at = s.at > at ? s.at : at;
	for (const g of s.graded) if (fs.existsSync(path.join(dir, "ortho", `${g.name}.png`)) && fs.existsSync(path.join(dir, "ref", `${g.name}.png`))) pick.set(g.name, { dir, g });
}
const LV = [["Doesn't run", "the example does not run on Ortho Earth"], ["Runs", "it runs, but some of it does not work"], ["Same answers", "it works and answers the same (entities, tiles, camera), the picture differs"], ["Same picture", "it works and gives the same picture as Cesium"]];
// 上段・下段の文だけ日英（ブラウザの言語が ja なら日本語・他は英語・右上の札で切替）。カード・絞り込み・対話は英語のまま（2026-11-02 本人）
const LV_JA = [["動かない", "Ortho Earth で例が動かない"], ["動く", "動くが、一部が働かない"], ["同じ答え", "動いて答え（エンティティ・タイル・カメラ）が同じ、絵は違う"], ["同じ絵", "動いて Cesium と同じ絵になる"]];
const i18n = (en, ja) => `<div class="i18n" lang="en">${en}</div><div class="i18n" lang="ja">${ja}</div>`;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
const lvDot = l => l == null ? "" : `<span class="lv lv${l}" title="${esc(LV[l][0])}"></span>`;
// the data shown in each picture: the providers whose imagery / tiles the example asks for (attribution under the card)
const credit = ex => [ex.flags?.google && "Google", /bing/i.test(JSON.stringify(ex.classes ?? []) + (ex.hosts ?? []).join(" ")) && "Bing", ex.flags?.ion && "Cesium ion"].filter(Boolean);
const rows = [];
for (const ex of corpus.examples) {
	const p = pick.get(ex.name), c = checked[ex.name];
	if (!p) continue;
	const g = p.g, level = g.level ?? c?.level ?? null;
	if (level == null) continue;   // not graded (the Moon, Mars, no picture to compare) and not checked by eye
	const pc = g.picture?.n ? Math.round(100 * g.picture.colour) : null;
	rows.push({ name: ex.name, title: ex.title || ex.name, label: ex.labels?.[0] || "", level, pc, note: g.level == null ? c?.note : (g.reasons?.[0] || ""), dev: !!g.dev, credit: credit(ex), dir: p.dir });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "pics"), { recursive: true });
const sharp = (await import("sharp")).default;
for (const r of rows) for (const side of ["ref", "ortho"])
	await sharp(path.join(r.dir, side, `${r.name}.png`)).resize(480, 360, { fit: "cover" }).webp({ quality: 62, effort: 6 }).toFile(path.join(OUT, "pics", `${r.name}.${side}.webp`));

const n = rows.length, cnt = l => rows.filter(r => r.level === l).length, labels = [...new Set(rows.map(r => r.label).filter(Boolean))].sort();
const TITLE = "Sandcastle — the CesiumJS examples on Ortho Earth";
const DESC = `The ${n} official CesiumJS Sandcastle examples, run unchanged on the Ortho Earth globe through its Cesium-compatible facade, pictured next to CesiumJS.`;
const sc = name => `https://sandcastle.cesium.com/?id=${encodeURIComponent(name)}`;
const card = r => `<article class="card" data-level="${r.level}" data-label="${esc(r.label)}" data-name="${esc(r.name)}" tabindex="0" role="button" aria-label="${esc(r.title)}">
<div class="shot"><figure><img loading="lazy" src="pics/${esc(r.name)}.ref.webp" alt="CesiumJS"><figcaption>CesiumJS</figcaption></figure><figure><img loading="lazy" src="pics/${esc(r.name)}.ortho.webp" alt="Ortho Earth"><figcaption>Ortho Earth</figcaption></figure></div>
<div class="body"><h2 title="${esc(r.title)}">${esc(r.title)}</h2>
<p class="meta"><button type="button" class="cat" data-label="${esc(r.label)}">${esc(r.label)}</button> ${lvDot(r.level)}${r.pc == null ? "" : `<span class="pct" title="cells of the picture whose colour matches CesiumJS">${r.pc}%</span>`}${r.dev ? ` <span class="nt" title="A development example of CesiumJS">dev</span>` : ""}</p>
${r.credit.length ? `<p class="cr">Imagery: ${esc(r.credit.join(" · "))}</p>` : ""}</div></article>`;
const payload = Object.fromEntries(rows.map(r => [r.name, { t: r.title, l: r.level, pc: r.pc, note: r.note, cr: r.credit }]));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(TITLE)}</title><script>(()=>{let l="en";try{l=localStorage.getItem("lang")||((navigator.language||"").toLowerCase().startsWith("ja")?"ja":"en")}catch(e){}document.documentElement.dataset.lang=l})()</script>
<meta name="description" content="${esc(DESC)}"><meta name="theme-color" content="#f7f7f5"><link rel="canonical" href="https://www.ortho-earth.com/sandcastle/"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta property="og:title" content="${esc(TITLE)}"><meta property="og:description" content="${esc(DESC)}"><meta property="og:image" content="https://www.ortho-earth.com/thumbs/sandcastle.webp"><meta property="og:url" content="https://www.ortho-earth.com/sandcastle/"><meta name="twitter:card" content="summary_large_image">
<style>
:root{--bg:#f7f7f5;--fg:#17170f;--muted:#6f6e68;--card:#ffffff;--line:#e6e5e0;--acc:#d99a2b;--shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px -12px rgba(0,0,0,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--fg:#eeede8;--muted:#9c9b94;--card:#1c1c1a;--line:#2d2d2a;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.7)}}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1320px;margin:0 auto;padding:40px 16px 72px}
header.top .home{margin:0 0 14px;font-size:13.5px;color:var(--muted)} header.top .home a{color:inherit;text-decoration:none} header.top .home a:hover{color:var(--fg)}
header.top h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px;font-weight:650} header.top p{margin:0 0 6px;color:var(--muted);max-width:76ch} header.top a{color:inherit;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--acc)}
h1 .ver{font-size:.55em;font-weight:600;vertical-align:middle;margin-left:.35em;padding:2px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
nav{position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);padding:12px 0;margin:22px 0 18px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line)}
nav button,nav select{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 14px;font:inherit;font-size:13.5px;cursor:pointer} nav button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)} nav .sp{flex:1} nav .count{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:22px 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column;transition:transform .15s ease,box-shadow .15s ease;cursor:pointer}
.card[hidden]{display:none}
.card:hover,.card:focus-visible{transform:translateY(-2px);box-shadow:0 2px 4px rgba(0,0,0,.06),0 16px 32px -14px rgba(0,0,0,.28);outline:none}
.shot{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--line)} figure{margin:0;position:relative;aspect-ratio:4/3;background:#e9e8e3;overflow:hidden} figure img{width:100%;height:100%;object-fit:cover;display:block}
figcaption{position:absolute;left:6px;bottom:6px;font-size:11px;line-height:1;padding:4px 7px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px}
h2{font-size:15.5px;font-weight:600;margin:0;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta,.cr{margin:0;color:var(--muted);font-size:13px} .cr{font-size:12px}
.pct{font-weight:650;color:var(--fg);font-variant-numeric:tabular-nums;cursor:help}
.lv{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:0} .lv0{background:#8e5bd6} .lv1{background:#d64545} .lv2{background:#e0b020} .lv3{background:#2e9e5b}
.nt{font-size:11px;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:0 7px;margin-left:4px;vertical-align:1px}
.meta .cat{border:0;background:transparent;color:var(--muted);font:inherit;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px} .meta .cat:hover{color:var(--fg);text-decoration-color:var(--acc)}
footer{margin-top:48px;color:var(--muted);font-size:12.5px;line-height:1.7} footer a{color:inherit}
dialog{border:0;border-radius:16px;padding:0;width:min(1080px,calc(100vw - 32px));max-height:calc(100vh - 48px);background:var(--card);color:var(--fg);box-shadow:0 24px 64px -24px rgba(0,0,0,.5)} dialog::backdrop{background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
.dh{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1} .dh h3{margin:0;font-size:16px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dh a,.dh button{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none} .dh a:hover,.dh button:hover{border-color:var(--fg)}
.dp{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 18px} .dp figure{border-radius:10px} @media (max-width:640px){.dp{grid-template-columns:1fr}}
.dm{padding:0 18px 18px;font-size:13.5px;color:var(--muted)} .dm p{margin:0} .dm p+p{margin-top:4px}
.i18n[lang=ja]{display:none} html[data-lang=ja] .i18n[lang=ja]{display:block} html[data-lang=ja] .i18n[lang=en]{display:none} html[data-lang=ja] .i18n .lv{margin-top:1px}
.lang{float:right;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer} .lang:hover{border-color:var(--fg)}
</style></head><body><main>
<header class="top"><p class="home"><a href="/">Ortho Earth</a> · <a href="/start.md">Get started</a> · <a href="/maplibre/">MapLibre examples</a><button type="button" id="lang" class="lang" title="日本語 / English">日本語</button></p>
<h1>Sandcastle <span class="ver">v${esc(series)}</span></h1>
${i18n(`<p>A comparison of the official <a href="https://sandcastle.cesium.com/" target="_blank" rel="noopener">CesiumJS Sandcastle</a> examples run on Ortho Earth — not the official Sandcastle.</p>
<p>Each of the ${n} examples runs unchanged: once on CesiumJS ${esc(cesium)}, once on the Ortho Earth globe through its Cesium-compatible facade (<code>@ortho-earth/cesium</code>: Cesium's own coordinates, time, CZML, entities and 3D Tiles loading, with Ortho Earth doing the drawing), at the same time and from the same camera. Each card shows CesiumJS on the left and Ortho Earth on the right. Click a card for the larger pictures and the example on the official Sandcastle.</p>`,
`<p>公式の <a href="https://sandcastle.cesium.com/" target="_blank" rel="noopener">CesiumJS Sandcastle</a> の例を Ortho Earth で走らせた比較です。公式の Sandcastle ではありません。</p>
<p>${n} 例を、手を加えずにそれぞれ二度走らせました。一度は CesiumJS ${esc(cesium)} で、一度は Cesium 互換の外装（<code>@ortho-earth/cesium</code>＝座標・時刻・CZML・エンティティ・3D Tiles の読み込みは Cesium のまま、描くのは Ortho Earth）を通して Ortho Earth の地球儀で、同じ時刻・同じカメラから。各カードの左が CesiumJS、右が Ortho Earth です。カードを押すと大きな絵と、公式 Sandcastle の例への口が開きます。</p>`)}</header>
<nav><button data-f="all" class="on">All · ${n}</button>${[3, 2, 1, 0].map(l => `<button data-f="l${l}" title="${esc(LV[l][1])}">${lvDot(l)}${esc(LV[l][0])} · ${cnt(l)}</button>`).join("")}<span class="count" id="count"></span><span class="sp"></span>
<select id="cat"><option value="">All labels</option>${labels.map(c => `<option>${esc(c)}</option>`).join("")}</select></nav>
<div class="grid">${rows.map(card).join("\n")}</div>
<footer>${i18n(`Levels: ${[3, 2, 1, 0].map(l => `${lvDot(l)}${l} ${esc(LV[l][0])} = ${esc(LV[l][1])}`).join(" · ")}.<br>
Picture % = the cells of a 64×48 grid over the 800×600 picture whose colour matches CesiumJS (the Cesium widgets masked). The level is a guide; the pictures are what to judge by.<br>
Pictures: CesiumJS ${esc(cesium)} and Ortho Earth (@ortho-earth/globe ${esc(series)}) on a real GPU (Apple M5 Pro, WebGPU), captured ${esc(at.slice(0, 10))}. Examples whose pictures are not compared (the Moon, Mars, examples without a 3D view) are left out.<br>
Examples © Cesium GS, Inc. and contributors (Apache-2.0), run unchanged from CesiumJS ${esc(cesium)}; CesiumJS draws the left pictures. Ortho Earth is not affiliated with or endorsed by Cesium GS, Inc. Imagery, terrain and 3D Tiles in the pictures belong to their providers (Google, Microsoft Bing, Cesium ion and the others each example credits); the providers named under a card are those the example asks for.`,
`段：${[3, 2, 1, 0].map(l => `${lvDot(l)}${l} ${esc(LV_JA[l][0])}＝${esc(LV_JA[l][1])}`).join(" · ")}。<br>
絵の %＝800×600 の絵に 64×48 の格子を置き、色が CesiumJS と合う升の割合（Cesium の部品は覆って比べます）。段は目安で、判断は絵で。<br>
絵：CesiumJS ${esc(cesium)} と Ortho Earth（@ortho-earth/globe ${esc(series)}）を実機の GPU（Apple M5 Pro・WebGPU）で ${esc(at.slice(0, 10))} に撮ったもの。絵を比べない例（月・火星・3D の眺めがない例）は載せていません。<br>
例 © Cesium GS, Inc. and contributors（Apache-2.0）。CesiumJS ${esc(cesium)} の例を手を加えずに走らせ、左の絵は CesiumJS が描いています。Ortho Earth は Cesium GS, Inc. と無関係で、承認も受けていません。絵の中の画像・地形・3D Tiles は各提供元（Google・Microsoft Bing・Cesium ion ほか、各例が記す提供元）のものです。カードの下の提供元は、その例が求めるものです。`)}</footer>
</main>
<dialog id="dlg"><div class="dh"><h3 id="dt"></h3><a id="sc" target="_blank" rel="noopener">Open on Sandcastle</a><button type="button" id="cl">Close</button></div>
<div class="dp"><figure><img id="ir" alt="CesiumJS"><figcaption>CesiumJS</figcaption></figure><figure><img id="io" alt="Ortho Earth"><figcaption>Ortho Earth</figcaption></figure></div>
<div class="dm" id="dm"></div></dialog>
<script type="application/json" id="payload">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>
let f = "all", cat = "";
const $ = id => document.getElementById(id), P = JSON.parse($("payload").textContent), LV = ${JSON.stringify(LV.map(x => x[0]))};
const lgBtn = document.getElementById("lang"); const lgPaint = () => { lgBtn.textContent = document.documentElement.dataset.lang === "ja" ? "English" : "日本語"; }; lgPaint();
lgBtn.onclick = () => { const l = document.documentElement.dataset.lang === "ja" ? "en" : "ja"; document.documentElement.dataset.lang = l; try { localStorage.setItem("lang", l); } catch (e) {} lgPaint(); };
const apply = () => { let k = 0; for (const c of document.querySelectorAll(".card")) { const on = (f === "all" || f === "l" + c.dataset.level) && (!cat || c.dataset.label === cat); c.hidden = !on; if (on) k++; } $("count").textContent = k + " examples"; };
for (const b of document.querySelectorAll("nav button")) b.onclick = () => { document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b)); f = b.dataset.f; apply(); };
$("cat").onchange = e => { cat = e.target.value; apply(); };
for (const b of document.querySelectorAll(".meta .cat")) b.onclick = e => { e.stopPropagation(); cat = cat === b.dataset.label ? "" : b.dataset.label; $("cat").value = cat; apply(); window.scrollTo({ top: 0, behavior: "smooth" }); };
apply();
const open = name => {
	const key = Object.keys(P).find(k => k === name); if (!key) return;   // only names from the payload reach the URLs
	const p = P[key], dm = $("dm");
	$("dt").textContent = p.t; $("sc").href = ${JSON.stringify(sc("X"))}.replace("X", encodeURIComponent(key));
	$("ir").src = "pics/" + key + ".ref.webp"; $("io").src = "pics/" + key + ".ortho.webp";
	const line = t => { const e = document.createElement("p"); e.textContent = t; dm.append(e); };
	dm.replaceChildren();
	line(LV[p.l] + (p.pc == null ? "" : " · picture " + p.pc + "%") + (p.note ? " · " + p.note : ""));
	if (p.cr.length) line("Imagery: " + p.cr.join(" · "));
	$("dlg").showModal();
};
for (const c of document.querySelectorAll(".card")) { c.onclick = () => open(c.dataset.name); c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(c.dataset.name); } }; }
$("cl").onclick = () => $("dlg").close();
$("dlg").onclick = e => { if (e.target === $("dlg")) $("dlg").close(); };
</script></body></html>`;
fs.writeFileSync(path.join(OUT, "index.html"), withBootStatic(html, "images"));
const bytes = fs.readdirSync(path.join(OUT, "pics")).reduce((a, f) => a + fs.statSync(path.join(OUT, "pics", f)).size, 0);
console.log(`sandcastle gallery: ${path.relative(process.cwd(), OUT)} (${n} examples: ${[3, 2, 1, 0].map(l => `L${l} ${cnt(l)}`).join(" · ")} · pictures ${(bytes / 1e6).toFixed(1)} MB)`);
