// 名所の 3D 模型（写真測量スキャン・CC BY）を実在の場所に置いて見せる showcase（models.html から遅移 import）。
// quakes（地下）・sats（地上）と同じ骨格：器＝models.html／一覧と飛行と配線＝ここ／読み込みと描画＝エンジンの model ガジェット（gadgets/model.js＝
// loaders.gl → PLATEAU と同じ建物メッシュ経路・renderer の plateauMesh スロット）。
//
// 台帳＝public/models.json（id・名前 ja/en・設置点・視点・heading/scale・出典）。GLB 本体は台帳の base（bucket GIS/models/<id>.glb）から fetch。
// 一覧のカードをクリック＝①先に視点へ飛ぶ（遷移の時間＝読み込みの準備時間）②並行で GLB を取りに行き、届いたら設置点に立てる（fit はしない＝視点は台帳が正）。
// 未アップロード（404）でも場所へは飛ぶ＝候補の取捨（本人）は場所と絵で判断できる。
// 調整＝heading（北から時計回りの度）と scale（倍率）を打ち直して「適用」＝同じ GLB を読み直して置き直す（ブラウザキャッシュ＝速い）。
// 決まった値は台帳へ書き戻す（この画面は保存しない）。?m=<id> で起動時に選ぶ（共有）。
import { gunzip } from "geopbf/gzip";
import { tr, setLang, getLang, loadPage } from "./i18n.js";   // UI 文言＝英語キー・26 言語（i18n.js の作法）。モジュール評価時に t() を呼ばない
const t = tr();

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = n => n.toLocaleString(getLang());

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountModels(map, { catalog, panelHost } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/models/${c}.json`));   // 本番はこのチャンクの i18n.js が SDK と別実体＝自分で訳を用意してから UI を組む。ページの辞書（i18n/pages/models.json）も足す
	document.title = t("Landmarks in 3D — ortho-japan");   // 器（models.html）の題名と説明もここで＝i18n の走査器は .js だけ読む
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("Photogrammetry scans of castles and cathedrals (CC BY) placed at their real sites on the globe. Click one to fly there."));
	const mapEl = map.mapEl;
	const lang = getLang();
	const L = v => (v && typeof v === "object") ? (v[lang] ?? v.en ?? Object.values(v)[0] ?? "") : (v ?? "");

	// 台帳
	const doc = typeof catalog === "string" ? await (await fetch(catalog, { credentials: "omit" })).json() : catalog;
	const base = doc.base ?? "", models = doc.models ?? [];
	const urlOf = m => m.url ?? (base + m.id + ".glb");

	// ── パネル（quakes/sats と同じ意匠＝暗いガラス）──
	const panel = document.createElement("div");
	panel.className = "models-panel";
	panel.innerHTML = `
<style>
.models-panel{position:absolute;top:12px;right:12px;z-index:30;width:320px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;
 box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;background:rgba(12,17,32,.86);color:#e7ecf5;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.models-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.models-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.models-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e7ecf5;font-size:14px;line-height:1;cursor:pointer}
.models-panel.min .body{display:none}
.models-panel.min{padding-bottom:10px}
.models-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:8px}
.models-panel .status{margin:6px 0 8px;color:#fff;min-height:1.4em}
.models-panel .status.err{color:#ffb86b}
.models-panel .list{display:flex;flex-direction:column;gap:6px}
.models-panel .card{display:grid;grid-template-columns:96px 1fr;gap:10px;align-items:center;width:100%;border:1px solid transparent;background:rgba(255,255,255,.05);
 text-align:start;padding:6px;border-radius:9px;cursor:pointer;font:inherit;color:inherit}
.models-panel .card:hover{background:rgba(255,255,255,.12)}
.models-panel .card.on{border-color:rgba(255,255,255,.55);background:rgba(255,255,255,.14)}
.models-panel .card img{width:96px;height:54px;object-fit:cover;border-radius:6px;background:#1a2236;display:block}
.models-panel .card b{display:block;font-size:13px;line-height:1.3}
.models-panel .card small{display:block;color:#9aa6bd;font-size:11px;line-height:1.4}
.models-panel .cur{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12)}
.models-panel .cur b{font-size:13.5px}
.models-panel .cur .m{color:#b9c3d6;font-size:11.5px}
.models-panel .cur a{color:#9cc4ff}
.models-panel .adj{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:8px;color:#b9c3d6}
.models-panel .adj label{display:flex;align-items:center;gap:5px}
.models-panel .adj input{width:64px;font:inherit;font-size:12px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;padding:3px 6px}
.models-panel .adj button{border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#ff8c1a;color:#1a0d00;font:inherit;font-weight:700;padding:4px 12px;cursor:pointer}
.models-panel .adj code{font:11px ui-monospace,monospace;color:#9aa6bd;flex:1 1 100%;user-select:all;white-space:pre-wrap}
.models-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
@media (max-width:640px){.models-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:50%}}
</style>
<div class="head"><h1>${t("Landmarks in 3D")}</h1><button type="button" class="fold" data-k="fold" aria-label="${t("Collapse panel")}">−</button></div>
<div class="sub">${t("Click a landmark to fly there and see its 3D model. Models are photogrammetry scans shared under CC BY.")}</div>
<div class="body">
<div class="status" data-k="status"></div>
<div class="list" data-k="list"></div>
<div class="cur" data-k="cur" style="display:none"></div>
</div>`;
	(panelHost || mapEl).appendChild(panel);
	const $ = k => panel.querySelector(`[data-k="${k}"]`);
	const setFold = min => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? t("Expand panel") : t("Collapse panel")); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);

	// 一覧
	$("list").innerHTML = models.map(m => `<button type="button" class="card" data-id="${esc(m.id)}">
		<img src="${esc(m.thumb || "")}" alt="" loading="lazy" referrerpolicy="no-referrer">
		<span><b>${esc(L(m.name))}</b><small>${esc(L(m.place))}</small><small>${esc(m.author)} · ${esc(m.license)}${m.mb ? ` · ${fmt(m.mb)} MB` : ""}</small></span></button>`).join("");
	$("list").addEventListener("click", e => { const b = e.target.closest(".card"); if (b) show(b.dataset.id); });

	// ── 表示 ──
	let cur = null, ctl = null, seq = 0;
	const setStatus = (msg, err = false) => { const el = $("status"); el.textContent = msg || ""; el.classList.toggle("err", !!err); };
	const showCur = m => {
		const el = $("cur");
		if (!m) { el.style.display = "none"; return; }
		el.style.display = "";
		el.innerHTML = `<b>${esc(L(m.name))}</b><div class="m">${t("3D model: $1 ($2)", esc(m.author), esc(m.license))} · <a href="${esc(m.source)}" target="_blank" rel="noopener">Sketchfab</a>${m.faces ? ` · ${fmt(m.faces)} ▲` : ""}</div>
			<div class="adj"><label>${t("Heading")} <input type="number" data-k="heading" step="1" value="${+m.heading || 0}">°</label>
			<label>${t("Scale")} <input type="number" data-k="scale" step="0.05" min="0.01" value="${+m.scale || 1}"></label>
			<button type="button" data-k="apply">${t("Apply")}</button>
			<code data-k="json"></code></div>`;
		$("apply").addEventListener("click", () => { m.heading = +$("heading").value || 0; m.scale = +$("scale").value || 1; load(m); });
		syncJson(m);
	};
	const syncJson = m => { const c = $("json"); if (c) c.textContent = JSON.stringify({ lon: m.lon, lat: m.lat, zoom: m.zoom, tilt: m.tilt, bearing: m.bearing, heading: m.heading, scale: m.scale }); };
	async function load(m) {
		const my = ++seq;
		setStatus(t("Loading model…"));
		try {
			// bucket の置き物は uploader が gzip で置く（Content-Type application/gzip＝素の fetch では解かれない）＝自分で取って gunzip（平文は素通し）してから File で渡す
			const r = await fetch(urlOf(m), { credentials: "omit" });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const blob = await gunzip(await r.blob());
			if (my !== seq) return;
			const c = await map.gadget.model(new File([blob], m.id + ".glb", { type: "model/gltf-binary" }), { at: [m.lon, m.lat], heading: +m.heading || 0, scale: +m.scale || 1, fit: false });
			if (my !== seq) return;   // 途中で別の模型が選ばれた＝後勝ち（ガジェットは単一スロット）
			ctl = c; setStatus(""); syncJson(m);
		} catch (e) {
			if (my !== seq) return;
			const s = String(e?.message || e);
			setStatus(/HTTP 40[34]/.test(s) ? t("Model not uploaded yet: $1", urlOf(m)) : t("Failed to load: $1", s), true);
		}
	}
	function show(id, { fly = true } = {}) {
		const m = models.find(x => x.id === id); if (!m) return;
		cur = m;
		for (const b of panel.querySelectorAll(".card")) b.classList.toggle("on", b.dataset.id === id);
		showCur(m);
		if (fly) map.flyTo(m.lon, m.lat, m.zoom ?? 17, m.tilt ?? 55, m.bearing ?? 0);   // 先に飛ぶ＝遷移の裏で読み込む
		try { const u = new URL(location.href); u.searchParams.set("m", id); history.replaceState(null, "", u); } catch {}
		load(m);
	}
	const first = new URLSearchParams(location.search).get("m");
	if (first && models.some(m => m.id === first)) show(first);

	return {
		models, show,
		get current() { return cur; },
		get stats() { return ctl?.stats || null; },
		destroy() { seq++; ctl?.clear?.(); panel.remove(); },
	};
}
