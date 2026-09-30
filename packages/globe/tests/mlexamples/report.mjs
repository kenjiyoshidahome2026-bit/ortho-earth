// 公式例の門（台帳 §8）の見比べ帳＝手元の HTML 1 枚（<repo>/.cache/mlexamples/report/<label>/index.html）。公開しない（地図タイルの画像を含む）。
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

export function buildReport({ rows, summary, ranking, thresh, refLabel, orthoLabel, when, notes = {} }) {
	const card = r => {
		const note = notes[r.name];
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
<table><tr><th>例</th><th>段</th><th>コメント</th></tr>${rows.filter(r => notes[r.name]).map(r => `<tr><td><a href="#${esc(r.name)}">${esc(r.name)}</a></td><td class="n">${r.grade.level == null ? "外" : r.grade.level}</td><td>${esc(notes[r.name])}</td></tr>`).join("")}</table>
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
export function buildGallery({ rows, refLabel, orthoLabel, when, notes = {}, base = "http://localhost:5253", summary = null }) {
	const LV = { 3: ["Same picture", "l3"], 2: ["Same answers", "l2"], 1: ["Runs", "l1"], 0: ["Does not run", "l0"], x: ["Excluded", "lx"] };
	const cats = [...new Set(rows.map(r => r.category).filter(Boolean))].sort();
	const n = l => rows.filter(r => (r.grade.level ?? "x") === l).length;
	const card = r => {
		const g = r.grade, k = g.level ?? "x", [lvName, lvCls] = LV[k], note = notes[r.name];
		const ours = `${base}/ortho/test/examples/${r.name}.html`, real = `${base}/ref/test/examples/${r.name}.html`, docs = `https://maplibre.org/maplibre-gl-js/docs/examples/${r.name}/`;
		return `<article class="card" data-level="${k}" data-cat="${esc(r.category)}" data-note="${note ? 1 : 0}">
<a class="shot" href="${esc(ours)}" target="_blank" rel="noopener"><img loading="lazy" src="../../runs/${esc(orthoLabel)}/ortho/${esc(r.name)}.full.png" alt=""></a>
<div class="body">
<h2 title="${esc(r.title || r.name)}">${esc(r.title || r.name)}</h2>
<p class="meta"><span class="dot ${lvCls}"></span>${lvName}<span class="sep">·</span>${esc(r.category || "")}</p>
<p class="links"><a href="${esc(docs)}" target="_blank" rel="noopener">Docs</a><a href="${esc(real)}" target="_blank" rel="noopener">MapLibre</a><a href="${esc(ours)}" target="_blank" rel="noopener">ortho</a>${note ? `<button class="tg" type="button">Note</button>` : ""}</p>
${note ? `<p class="note" hidden>${esc(note)}</p>` : ""}
</div></article>`;
	};
	const stat = (k, label) => `<div class="stat"><b>${n(k)}</b><span>${label}</span></div>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MapLibre examples on ortho</title>
<style>
:root{--bg:#f7f7f5;--fg:#17170f;--muted:#6f6e68;--card:#ffffff;--line:#e6e5e0;--l0:#c8412f;--l1:#d99a2b;--l2:#3b6fd6;--l3:#1f9d5a;--lx:#9a9993;--shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px -12px rgba(0,0,0,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--fg:#eeede8;--muted:#9c9b94;--card:#1c1c1a;--line:#2d2d2a;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.7)}}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1320px;margin:0 auto;padding:40px 24px 72px}
header.top h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px;font-weight:650} header.top p{margin:0;color:var(--muted);max-width:70ch}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 8px} .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 16px;min-width:132px;box-shadow:var(--shadow)} .stat b{display:block;font-size:24px;font-weight:650;letter-spacing:-.02em} .stat span{color:var(--muted);font-size:12.5px}
nav{position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);padding:12px 0;margin:8px 0 18px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line)}
nav button,nav select{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 14px;font:inherit;font-size:13.5px;cursor:pointer} nav button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)} nav .sp{flex:1}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:22px 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column;transition:transform .15s ease,box-shadow .15s ease}
.card:hover{transform:translateY(-2px);box-shadow:0 2px 4px rgba(0,0,0,.06),0 16px 32px -14px rgba(0,0,0,.28)}
.shot{display:block;aspect-ratio:4/3;background:#e9e8e3;overflow:hidden} .shot img{width:100%;height:100%;object-fit:cover;display:block}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px}
h2{font-size:15.5px;font-weight:600;margin:0;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{margin:0;color:var(--muted);font-size:13px;display:flex;align-items:center;gap:6px} .dot{width:9px;height:9px;border-radius:50%;display:inline-block} .l0{background:var(--l0)} .l1{background:var(--l1)} .l2{background:var(--l2)} .l3{background:var(--l3)} .lx{background:var(--lx)} .sep{opacity:.5}
.links{margin:2px 0 0;display:flex;gap:6px;flex-wrap:wrap} .links a,.links .tg{font-size:12.5px;text-decoration:none;color:var(--fg);border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:transparent;font-family:inherit;cursor:pointer} .links a:hover,.links .tg:hover{border-color:var(--fg)}
.note{margin:6px 0 0;font-size:13px;line-height:1.5;color:var(--fg);background:color-mix(in srgb,var(--l1) 10%,var(--card));border-left:3px solid var(--l1);padding:8px 10px;border-radius:6px}
footer{margin-top:48px;color:var(--muted);font-size:12.5px;line-height:1.7}
</style></head><body><main>
<header class="top"><h1>MapLibre GL JS examples, on ortho</h1>
<p>The 139 official MapLibre GL JS examples, run unchanged against the ortho globe engine through its MapLibre-compatible API. Each card shows ortho's rendering. Open the same example in real MapLibre and in ortho side by side and compare for yourself.</p></header>
<div class="stats">${stat(3, "Same picture")}${stat(2, "Same answers")}${stat(1, "Runs")}${stat(0, "Does not run")}${stat("x", "Excluded")}${summary ? `<div class="stat"><b>${summary.plain3}/${summary.plainN}</b><span>Same picture · no keys, libs, custom</span></div>` : ""}</div>
<nav><button data-f="all" class="on">All</button><button data-f="l3">Same picture</button><button data-f="l2">Same answers</button><button data-f="l1">Runs</button><button data-f="l0">Does not run</button><button data-f="lx">Excluded</button><button data-f="note">With notes</button><span class="sp"></span>
<select id="cat"><option value="">All categories</option>${cats.map(c => `<option>${esc(c)}</option>`).join("")}</select></nav>
<div class="grid">${rows.map(card).join("\n")}</div>
<footer>Examples © MapLibre contributors (BSD-3-Clause), reproduced unchanged from MapLibre GL JS 6.11.2. ortho is not affiliated with or endorsed by the MapLibre project. Basemap data and imagery in each example belong to their respective providers; see attributions inside each example.<br>
Grading: <em>Same picture</em> = colors match at sampled points; <em>Same answers</em> = layers, queries and camera agree; <em>Runs</em> = loads without errors; <em>Excluded</em> = the reference capture itself is invalid in this rig (see note). Captures: ortho runs/${esc(orthoLabel)} · reference runs/${esc(refLabel)} · ${esc(when)}. "MapLibre" and "ortho" links work while the local rig is up (<code>npm run verify:examples -- --serve</code>, ${esc(base)}).</footer>
</main><script>
let f = "all", cat = "";
const apply = () => { for (const c of document.querySelectorAll(".card")) c.hidden = !((f === "all" || (f === "note" && c.dataset.note === "1") || f === "l" + c.dataset.level) && (!cat || c.dataset.cat === cat)); };
for (const b of document.querySelectorAll("nav button")) b.onclick = () => { document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b)); f = b.dataset.f; apply(); };
document.getElementById("cat").onchange = e => { cat = e.target.value; apply(); };
for (const t of document.querySelectorAll(".tg")) t.onclick = () => { const p = t.closest(".body").querySelector(".note"); p.hidden = !p.hidden; };
</script></body></html>`;
}
