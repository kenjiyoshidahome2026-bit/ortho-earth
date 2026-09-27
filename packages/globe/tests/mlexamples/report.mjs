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

export function buildReport({ rows, summary, ranking, thresh, refLabel, orthoLabel, when }) {
	const card = r => {
		const g = r.grade, lvl = g.level == null ? "分母の外" : LEVEL[g.level], ref = g.level == null ? `本物も落ちる：${g.refWhy}` : `本物は ${LEVEL[g.refLevel]} まで`;
		const W = r.R?.container?.W || 800, H = r.R?.container?.H || 600;
		const img = (side, label, rec, marks) => `<figure><div class="shot"><img loading="lazy" src="../../runs/${label}/${side}/${esc(r.name)}.full.png" alt="">${dots(rec, marks, W, H)}</div><figcaption>${side === "ref" ? "本物 MapLibre 6.11.2" : "こちら（MapLibre の口）"} · ${esc(rec?.end ?? "-")}</figcaption></figure>`;
		const cm = g.color, u = g.unsupported;
		return `<article class="card" data-level="${g.level ?? "x"}" data-behind="${g.level != null && g.level < g.refLevel ? 1 : 0}" data-cat="${esc(r.category)}">
<header><h2>${esc(r.name)}</h2><span class="lv lv${g.level ?? "x"}">${esc(lvl)}</span><span class="muted">${esc(ref)} · ${esc(r.category)}</span></header>
<p class="muted">${esc(r.title)}</p>
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
.lv{font-weight:600;border-radius:4px;padding:0 6px;color:#fff} .lv0{background:var(--l0)} .lv1{background:var(--l1)} .lv2{background:var(--l2)} .lv3{background:var(--l3)} .lvx{background:var(--muted)}
.why{margin:6px 0;padding-left:20px} code{font-size:12px;border-radius:3px;padding:0 4px} code.sem{background:#f3d9d9;color:#7a1f1f} code.cos{background:#e6e4de;color:#555}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:10px}
figure{margin:0} .shot{position:relative;aspect-ratio:4/3;background:#000} .shot img,.shot svg{position:absolute;inset:0;width:100%;height:100%} figcaption{font-size:12px;color:var(--muted)}
</style></head><body><main>
<h1>公式例の門 見比べ帳</h1>
<p class="muted">本物 runs/${esc(refLabel)} · こちら runs/${esc(orthoLabel)} · ${esc(when)} · 閾値 色の許し ${thresh.colorTol}・足した層 ${thresh.addedMin}・基図 ${thresh.baseMin}・問い合わせ ${thresh.queryMin}</p>
<div class="stats">${lvRow}<div class="stat"><b>${summary.plain3}/${summary.plainN}</b><span>同じ絵（鍵・外部ライブラリ・custom 無しの例）</span></div><div class="stat"><b>${summary.pictureOnly}/${summary.pictureN}</b><span>絵だけ見れば同じ（段 2 に依らない）</span></div></div>
<h2>足りない口の順位表（こちらの段が本物より低い例を塞いでいる物）</h2>
<table><tr><th>塞いでいる物</th><th>例の数</th><th>例</th></tr>${ranking.slice(0, 40).map(b => `<tr><td>${esc(b.blocker)}</td><td class="n">${b.n}</td><td class="muted">${esc(b.examples.slice(0, 6).join(", "))}${b.examples.length > 6 ? " …" : ""}</td></tr>`).join("")}</table>
<nav><button data-f="all" class="on">全部</button><button data-f="behind">本物より低い</button>${[0, 1, 2, 3].map(l => `<button data-f="l${l}">${LEVEL[l]}</button>`).join("")}<button data-f="lx">分母の外</button></nav>
${rows.map(card).join("\n")}
</main><script>
for (const b of document.querySelectorAll("nav button")) b.onclick = () => {
	document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
	const f = b.dataset.f;
	for (const c of document.querySelectorAll(".card")) c.hidden = !(f === "all" || (f === "behind" && c.dataset.behind === "1") || f === "l" + c.dataset.level);
};
</script></body></html>`;
}
