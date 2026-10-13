// 日本の温泉（Wikipedia 日本語版の温泉地 約 2,000 件＋温泉郷 70）を日本の 3D 地図（ortho-japan）に（onsen.html から遅延 import）。
// terrain.js と同じ骨格＝台帳（ortho-data/japan/onsen.json）を、エンジンの MapLibre 互換の口（addSource／addLayer）と anno（面の絵）で描く。
//
// データ（scripts/onsen-ledger が組む・ortho-data/japan/onsen.json）
//   items[] … 温泉（k:"o"）と温泉郷（k:"g"・poly＝構成する温泉を包む面）。座標の無い記事は検索で推定した（a＝精度 m・e＝推定の方法）
//   inns[]  … 日本秘湯を守る会の会員宿（o＝どの温泉の宿か）
//   s       … 源泉が温泉地から離れている物（岳温泉＝8 km 上の鉄山の麓から引湯）。s.c があれば源泉の位置まで線を引く
//
// 表現の決め事
//   色   … 泉質の 10 分類（環境省の掲示用新泉質名）で色分け。複数の泉質を持つ温泉は最初の分類の色（表示の切り替えはどれか一つが合えば出す）
//   推定 … 座標を推定した温泉は白抜きの輪（実測は塗りの丸）。選ぶと推定の誤差の円を出す
//   郷   … 淡い紫の面（構成する温泉の集合）。源泉 … 赤い破線で温泉地と結ぶ・源泉の位置が分からない物は赤い外輪だけ
//   選択 … 地図・一覧のどこで選んでも同じ（赤の縁取り＋詳細カード＋そこへ飛ぶ）。?o=ID で共有できる
import { tr, setLang, getLang, loadPage, LANGUAGES } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない
import { createWikiFrame, langChain, pickTitle, wikiUrl } from "@ortho-earth/globe/wiki.js";
const t = tr();

// ── 泉質の 10 分類（台帳の classes と同じ順）──────────────────────────────────
const CLASS_COLORS = ["#7a8699", "#2f78c4", "#2aa198", "#8e6bbf", "#5bc0eb", "#b5542b", "#d6336c", "#6b4226", "#e0b100", "#3c9a3c"];
const UNKNOWN = "#9aa3ad";
const className = i => [t("Simple spring"), t("Chloride spring"), t("Bicarbonate spring"), t("Sulfate spring"), t("Carbon dioxide spring"),
	t("Iron spring"), t("Acidic spring"), t("Iodine spring"), t("Sulfur spring"), t("Radioactive spring")][i] ?? t("Not recorded");
const SEL = "#d7263d", SRC = "#c0392b", KYO = "#7a4a8c";
const estName = e => ({ osm: t("Estimated from place names on OpenStreetMap"), addr: t("Estimated from the address (GSI geocoder)"), muni: t("Placed at the municipal office"), region: t("Placed in the region only"), kyo: t("Placed at its onsen district") })[e] || t("Estimated position");
const srcKindName = k => ({ 遠隔: t("Piped from a distant source"), 運搬: t("Hot water is carried in by truck"), 引湯元あり: t("Piped from another hot spring"), 源泉座標あり: t("The source lies away from the town") })[k] || t("The source lies away from the town");

// ひらがな・カタカナの区別なく検索する
const kana = s => String(s || "").toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);
// 半径 m の円（推定の誤差・anno の面）
const circle = ([lon, lat], m, n = 48) => { const ring = [], kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110570;
	for (let i = 0; i <= n; i++) { const a = -2 * Math.PI * i / n; ring.push([lon + Math.cos(a) * m / kx, lat + Math.sin(a) * m / ky]); } return { type: "Polygon", coordinates: [ring] }; };
const bboxOf = pts => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountOnsen(map, { base = "./" } = {}) {
	await setLang(); await loadPage(c => import(`./i18n/lang/onsen/${c}.json`));
	document.title = t("Hot springs of Japan — ortho-japan");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("About 2,000 hot springs of Japan from Wikipedia on a 3D map, colored by spring type, with onsen districts, distant sources and member inns of the Japan Secluded Hot Spring Association."));
	const lang = getLang(), mapEl = map.mapEl;

	const db = await fetch(base + "onsen.json", { credentials: "omit" }).then(r => { if (!r.ok) throw new Error("onsen.json HTTP " + r.status); return r.json(); });
	const items = db.items, byId = new Map(items.map(d => [d.id, d])), inns = db.inns || [];
	const onsens = items.filter(d => d.k === "o"), kyos = items.filter(d => d.k === "g");
	const membersOf = new Map(); for (const d of onsens) for (const g of d.par || []) (membersOf.get(g) || membersOf.set(g, []).get(g)).push(d.id);
	// 名前＝日本語の頁は日本語・それ以外は英語名（en 記事の題名か よみのローマ字）→ 日本語
	const nameOf = d => lang === "ja" ? d.n : d.en || d.n;
	const prefOf = d => { const v = d.p && db.prefNames?.[String(d.p).padStart(2, "0")]; return v ? v[lang] || v.en || v.ja : ""; };   // prefNames の鍵は "01"〜"47"
	const wikiOf = d => { const w = d.w ? pickTitle(d.w, lang === "ja" ? ["ja", "en"] : langChain(lang, ["en", "ja"])) : null; return w ? wikiUrl(w.title, w.lang) : null; };
	const srcPos = d => d.s?.c || (d.s?.f && byId.get(d.s.f)?.c) || null;   // 源泉の位置＝座標か、引湯元の温泉の位置

	// ── 地物 ──
	const qflags = d => { const f = { qx: d.qc?.length ? 0 : 1 }; for (let i = 0; i < 10; i++) f["q" + i] = d.qc?.includes(i) ? 1 : 0; return f; };
	const points = onsens.map(d => ({ type: "Feature", geometry: { type: "Point", coordinates: d.c },
		properties: { id: d.id, cls: d.qc?.[0] ?? -1, est: d.a > 0 ? 1 : 0, inn: d.h ? 1 : 0, src: d.s ? 1 : 0, name: nameOf(d), ...qflags(d),
			sort: (d.a > 0 ? 1e4 : 0) - (d.h ? 3000 : 0) - (d.w?.en ? 2000 : 0) - (d.par ? 0 : 500) - (d.s ? 1000 : 0) } }));
	const kyoFeats = kyos.filter(d => d.poly).map(d => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [d.poly] }, properties: { id: d.id, name: nameOf(d) } }));
	const kyoPts = kyos.map(d => ({ type: "Feature", geometry: { type: "Point", coordinates: d.poly ? centerOf(d.poly) : d.c }, properties: { id: d.id, name: nameOf(d) } }));
	const srcFeats = [];
	for (const d of items) { const p = srcPos(d); if (!d.s || !p || kmOf(d.c, p) < 0.05) continue;
		srcFeats.push({ type: "Feature", geometry: { type: "LineString", coordinates: [d.c, p] }, properties: { id: d.id, name: nameOf(d) } });
		srcFeats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { id: d.id, name: nameOf(d) } }); }
	const innFeats = inns.map((x, j) => x.c && ({ type: "Feature", geometry: { type: "Point", coordinates: x.c }, properties: { j, id: x.o || "", name: x.n } })).filter(Boolean);

	// ── 記号の画像（秘湯の宿＝提灯色の家）──
	const icon = (draw, s = 22) => { const c = document.createElement("canvas"); c.width = c.height = s; const x = c.getContext("2d"); x.lineJoin = "round"; draw(x, s); return c; };
	await map.addImage("on-inn", icon((x, s) => { x.beginPath(); x.moveTo(s / 2, 2.5); x.lineTo(s - 3, s / 2 - 1); x.lineTo(s - 5, s / 2 - 1); x.lineTo(s - 5, s - 3); x.lineTo(5, s - 3); x.lineTo(5, s / 2 - 1); x.lineTo(3, s / 2 - 1); x.closePath();
		x.fillStyle = "#a8402a"; x.fill(); x.lineWidth = 1.8; x.strokeStyle = "#fff"; x.stroke(); x.fillStyle = "#fff"; x.fillRect(s / 2 - 2, s - 9, 4, 6); }), { pixelRatio: 2 });

	// ── 層 ──
	map.addSource("on-pts", { type: "geojson", data: { type: "FeatureCollection", features: points } });
	map.addSource("on-kyo", { type: "geojson", data: { type: "FeatureCollection", features: kyoFeats } });
	map.addSource("on-kyo-pts", { type: "geojson", data: { type: "FeatureCollection", features: kyoPts } });
	map.addSource("on-src", { type: "geojson", data: { type: "FeatureCollection", features: srcFeats } });
	map.addSource("on-inns", { type: "geojson", data: { type: "FeatureCollection", features: innFeats } });
	const clsColor = ["match", ["get", "cls"], ...CLASS_COLORS.flatMap((c, i) => [i, c]), UNKNOWN];
	const radius = ["interpolate", ["linear"], ["zoom"], 4, 2.6, 8, 4.5, 12, 7];
	const LAYERS = {
		"on-kyo-fill": { type: "fill", source: "on-kyo", paint: { "fill-color": KYO, "fill-opacity": 0.01 } },   // 当たり判定だけ（塗りは anno）
		"on-src-line": { type: "line", source: "on-src", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round" }, paint: { "line-color": SRC, "line-width": 1.8, "line-dasharray": [2, 2], "line-opacity": 0.9 } },
		"on-src-pt": { type: "circle", source: "on-src", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 12, 5], "circle-color": "#fff", "circle-stroke-color": SRC, "circle-stroke-width": 2 } },
		"on-src-ring": { type: "circle", source: "on-pts", filter: ["==", ["get", "src"], 1], paint: { "circle-radius": ["+", 3.5, radius], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": SRC, "circle-stroke-width": 1.4, "circle-stroke-opacity": 0.9 } },
		"on-est": { type: "circle", source: "on-pts", filter: ["==", ["get", "est"], 1], paint: { "circle-radius": radius, "circle-color": "rgba(255,255,255,.85)", "circle-stroke-color": clsColor, "circle-stroke-width": 1.6, "circle-opacity": 0.75, "circle-stroke-opacity": 0.75 } },
		"on-pt": { type: "circle", source: "on-pts", filter: ["==", ["get", "est"], 0], paint: { "circle-radius": radius, "circle-color": clsColor, "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } },
		"on-inn": { type: "symbol", source: "on-inns", layout: { "icon-image": "on-inn", "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.7, 11, 1.05], "icon-allow-overlap": true } },
		"on-sel": { type: "circle", source: "on-pts", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": ["+", 5, radius], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": SEL, "circle-stroke-width": 2.4 } },
		"on-kyo-label": { type: "symbol", source: "on-kyo-pts", filter: [">=", ["zoom"], 6.2],
			layout: { "text-field": ["get", "name"], "text-size": 13, "text-max-width": 8, "symbol-sort-key": 0 },
			paint: { "text-color": KYO, "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.8 } },
		"on-label": { type: "symbol", source: "on-pts", filter: [">=", ["zoom"], ["case", ["==", ["get", "est"], 1], 9, 7.2]],
			layout: { "text-field": ["get", "name"], "text-size": 11.5, "text-anchor": "left", "text-offset": [0.7, 0], "text-justify": "left", "symbol-sort-key": ["get", "sort"] },
			paint: { "text-color": ["case", ["==", ["get", "est"], 1], "#6a7380", "#33404f"], "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.6 } },
	};
	for (const [id, L] of Object.entries(LAYERS)) await map.addLayer({ id, ...L });

	// 表示の切り替え（泉質・重ね）＝点の層の filter を組み直す
	const shownCls = new Set([...CLASS_COLORS.keys(), -1]);
	const ov = { kyo: true, src: true, est: true, inn: true, innOnly: false };
	const ptFilter = () => {
		const any = [...shownCls].map(i => ["==", ["get", i < 0 ? "qx" : "q" + i], 1]);
		return ["all", any.length ? ["any", ...any] : false, ...(ov.est ? [] : [["==", ["get", "est"], 0]]), ...(ov.innOnly ? [["==", ["get", "inn"], 1]] : [])];
	};
	function apply() {
		const f = ptFilter();
		map.setFilter("on-pt", ["all", LAYERS["on-pt"].filter, f]); map.setFilter("on-est", ["all", LAYERS["on-est"].filter, f]); map.setFilter("on-label", ["all", LAYERS["on-label"].filter, f]);
		map.setFilter("on-src-ring", ["all", LAYERS["on-src-ring"].filter, f]);
		const vis = on => on ? "visible" : "none";
		for (const id of ["on-src-line", "on-src-pt", "on-src-ring"]) map.setLayoutProperty(id, "visibility", vis(ov.src));
		for (const id of ["on-kyo-fill", "on-kyo-label"]) map.setLayoutProperty(id, "visibility", vis(ov.kyo));
		map.setLayoutProperty("on-inn", "visibility", vis(ov.inn));
		drawAnno();
	}

	// 面の絵（anno）：温泉郷の面・選んだ物の縁取り・推定の誤差の円。切り替えと選択のたびに積み直す
	const KYO_FILL = "rgba(122,74,140,.10)", KYO_EDGE = "rgba(122,74,140,.55)";
	let annoSeq = 0, annoChain = Promise.resolve();
	function drawAnno() {
		const fs = [];
		if (ov.kyo) for (const f of kyoFeats) fs.push({ type: "Feature", geometry: f.geometry, properties: { "@fill": KYO_FILL, "@stroke": KYO_EDGE, "@width": 1 } });
		const d = sel && byId.get(sel);
		if (d?.k === "g" && d.poly) fs.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [d.poly] }, properties: { "@fill": "rgba(215,38,61,.08)", "@stroke": SEL, "@width": 2.4 } });
		if (d?.k === "o" && d.a > 0) fs.push({ type: "Feature", geometry: circle(d.c, d.a), properties: { "@fill": "rgba(215,38,61,.06)", "@stroke": "rgba(215,38,61,.6)", "@width": 1.2 } });
		const my = ++annoSeq;   // 呼び出しを 1 列に並べて最後の版だけ流す（terrain と同じ）
		annoChain = annoChain.then(() => my === annoSeq ? map.gadget.anno({ type: "FeatureCollection", features: fs }) : null).catch(e => console.warn("[onsen] anno", e));
	}

	// ── 選択（地図・一覧の共通の口）──
	let sel = null;
	async function select(id, { fly = true } = {}) {
		const d = byId.get(id) || null; sel = d?.id ?? null;
		map.setFilter("on-sel", ["==", ["get", "id"], d?.k === "o" ? sel : ""]);
		drawAnno();
		const u = new URL(location.href); sel ? u.searchParams.set("o", sel) : u.searchParams.delete("o"); history.replaceState(null, "", u);
		wikiFrame.close(); renderDetail(); list.mark();
		if (!d || !fly) return;
		const pts = d.k === "g" ? [...(d.poly || [d.c]), ...(membersOf.get(d.id) || []).map(m => byId.get(m).c)] : [d.c, ...(srcPos(d) ? [srcPos(d)] : [])];
		const bb = bboxOf(pts);
		if (bb[2] - bb[0] > 0.02 || bb[3] - bb[1] > 0.02) await map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(5, Math.min(12.5, map.fitZoomForBbox(bb) - 0.4)));
		else await map.flyTo(d.c[0], d.c[1], d.a > 20000 ? 9 : d.a > 3000 ? 11 : 12.5);
	}

	// ── 地図の操作（ホバー＝名前と泉質・クリック＝選択）──
	const tip = map.gadget.tip();
	const HIT = ["on-pt", "on-est", "on-label", "on-src-pt", "on-src-line", "on-inn", "on-kyo-label", "on-kyo-fill"];
	const top = e => (e.features || []).filter(f => f.properties?.id || f.properties?.j != null).sort((a, b) => HIT.indexOf(a.layer?.id) - HIT.indexOf(b.layer?.id))[0];
	const tipLines = f => {
		if (!f) return null;
		if (f.layer?.id === "on-inn") { const x = inns[f.properties.j]; return [`<b>${esc(x.n)}</b>　${esc(t("Member inn of the Japan Secluded Hot Spring Association"))}`]; }
		const d = byId.get(f.properties.id); if (!d) return null;
		if (f.layer?.id === "on-src-pt") return [`<b>${esc(t("Source of $1", nameOf(d)))}</b>`];
		return [`<b>${esc(nameOf(d))}</b>　${esc(d.k === "g" ? t("Onsen district") : prefOf(d))}`,
			...(d.qc ? [d.qc.map(i => esc(className(i))).join(" · ")] : []), ...(d.t != null ? [`${esc(t("Temperature"))}: ${d.t} °C`] : []), ...(d.a > 0 ? [esc(t("Estimated position"))] : [])];
	};
	map.on("mousemove", HIT, e => tip(tipLines(top(e))));
	map.on("mouseleave", HIT, () => tip(null));
	map.on("click", HIT, e => { const f = top(e); if (!f) return; const id = f.properties.id || inns[f.properties.j]?.o; if (id) select(id, { fly: false }); else if (f.properties.j != null) window.open(inns[f.properties.j].u, "_blank", "noopener"); });

	// ── 案内板（右上）：詳細カード＋タブ（表示・一覧）──
	const count = i => onsens.filter(d => i < 0 ? !d.qc?.length : d.qc?.includes(i)).length;
	const panel = document.createElement("div");
	panel.className = "on-panel";
	panel.innerHTML = `<style>${CSS}</style>
		<div class="head"><h1>${esc(t("Hot springs of Japan"))}</h1><select class="lang" aria-label="Language">${LANGUAGES.map(l => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select><button class="fold" type="button" aria-label="${esc(t("Fold"))}">–</button></div>
		<div class="body">
			<div class="detail" hidden></div>
			<div class="tabs" role="tablist">
				<button type="button" data-tab="layers" class="on">${esc(t("Layers"))}</button>
				<button type="button" data-tab="list">${esc(t("List"))}</button>
			</div>
			<div class="pane" data-pane="layers">
				<h2>${esc(t("Spring type"))}</h2>
				${[...CLASS_COLORS.keys(), -1].map(i => `<label class="grp"><input type="checkbox" data-c="${i}" checked><span class="sw" style="background:${i < 0 ? UNKNOWN : CLASS_COLORS[i]}"></span>${esc(className(i))}<small>${count(i)}</small></label>`).join("")}
				<div class="all"><button type="button" data-all="1">${esc(t("All"))}</button><button type="button" data-all="0">${esc(t("None"))}</button></div>
				<h2>${esc(t("Overlays"))}</h2>
				<label class="grp"><input type="checkbox" data-ov="kyo" checked><span class="sw" style="background:${KYO_FILL};border:1px solid ${KYO_EDGE}"></span>${esc(t("Onsen districts"))}<small>${kyos.length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="src" checked><span class="sw ln" style="background:repeating-linear-gradient(90deg,${SRC} 0 4px,transparent 4px 7px)"></span>${esc(t("Sources away from the town"))}<small>${items.filter(d => d.s).length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="est" checked><span class="sw ring"></span>${esc(t("Estimated positions"))}<small>${onsens.filter(d => d.a > 0).length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="inn" checked><span class="sw inn"></span>${esc(t("Secluded hot spring inns"))}<small>${inns.length}</small></label>
				<label class="grp"><input type="checkbox" data-ov="innOnly"><span class="sw none"></span>${esc(t("Only hot springs with such an inn"))}</label>
				<p class="note">${esc(t("Filled dots have coordinates from Wikipedia or Wikidata; hollow rings were placed by searching place names and addresses. A red outer ring means the source is far from the town."))}</p>
				<p class="src">${esc(t("Data: Japanese Wikipedia (CC BY-SA 4.0), Wikidata (CC0), © OpenStreetMap contributors (ODbL), GSI, Japan Secluded Hot Spring Association"))}</p>
			</div>
			<div class="pane" data-pane="list" hidden>
				<div class="ctl"><select class="pref"><option value="">${esc(t("All prefectures"))}</option>${Object.keys(db.prefNames || {}).map(c => `<option value="${c}">${esc(db.prefNames[c][lang] || db.prefNames[c].en)}</option>`).join("")}</select>
					<select class="kind"><option value="">${esc(t("All"))}</option><option value="g">${esc(t("Onsen districts"))}</option><option value="s">${esc(t("Sources away from the town"))}</option><option value="h">${esc(t("Secluded hot spring inns"))}</option><option value="e">${esc(t("Estimated positions"))}</option></select></div>
				<input class="find" type="search" placeholder="${esc(t("Search by name"))}">
				<p class="cnt"></p>
				<ol class="list"></ol>
			</div>
		</div>`;
	mapEl.appendChild(panel);
	const $ = s => panel.querySelector(s);
	$(".lang").onchange = e => { const u = new URL(location.href); u.searchParams.set("lang", e.target.value); location.assign(u); };   // 言語＝読み直す（視点と選択は URL に残る）
	$(".fold").onclick = () => { panel.classList.toggle("min"); $(".fold").textContent = panel.classList.contains("min") ? "+" : "–"; };
	panel.querySelectorAll("input[data-c]").forEach(inp => inp.onchange = () => { const i = +inp.dataset.c; inp.checked ? shownCls.add(i) : shownCls.delete(i); apply(); });
	panel.querySelectorAll("button[data-all]").forEach(b => b.onclick = () => { panel.querySelectorAll("input[data-c]").forEach(inp => { inp.checked = b.dataset.all === "1"; const i = +inp.dataset.c; inp.checked ? shownCls.add(i) : shownCls.delete(i); }); apply(); });
	panel.querySelectorAll("input[data-ov]").forEach(inp => inp.onchange = () => { ov[inp.dataset.ov] = inp.checked; apply(); });
	panel.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
		panel.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
		panel.querySelectorAll(".pane").forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
		if (b.dataset.tab === "list") list.render();
	});
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) panel.addEventListener(ev, e => e.stopPropagation());

	// Wikipedia＝アプリ内の枠（共通の芯 @ortho-earth/globe/wiki.js）。非対応のブラウザ・修飾キーは別タブ
	const wikiFrame = createWikiFrame({ host: mapEl, className: "on-wiki", labels: { newTab: t("Open in a new tab"), close: t("Close") } });

	// 詳細カード
	function renderDetail() {
		const el = $(".detail"), d = sel && byId.get(sel);
		if (!d) { el.hidden = true; el.innerHTML = ""; return; }
		const w = wikiOf(d), alt = [lang !== "ja" ? d.n : null, d.r].filter(Boolean).filter(s => s !== nameOf(d));
		const row = (k, v) => v == null || v === "" ? "" : `<div class="m"><span>${esc(k)}</span><b>${v}</b></div>`;
		const chips = (d.qc || []).map(i => `<span class="chip" style="--c:${CLASS_COLORS[i]}">${esc(className(i))}</span>`).join("");
		const pos = d.a > 0 ? `${esc(estName(d.e))} <small>(±${d.a >= 1000 ? fmt(d.a / 1000) + " km" : fmt(d.a) + " m"})</small>` : esc(t("From Wikipedia or Wikidata"));
		const par = (d.par || []).map(id => byId.get(id)).filter(Boolean).map(g => `<a href="#" data-go="${g.id}">${esc(nameOf(g))}</a>`).join(" · ");
		const mem = d.k === "g" ? (membersOf.get(d.id) || []).map(id => byId.get(id)).sort((a, b) => kana(a.r || a.n).localeCompare(kana(b.r || b.n), "ja")).map(m => `<a href="#" data-go="${m.id}">${esc(nameOf(m))}</a>`).join(" · ") : "";
		const s = d.s, sp = srcPos(d), from = s?.f && byId.get(s.f);
		const srcHtml = s ? `<div class="srcbox"><b>${esc(srcKindName(s.k))}</b>${s.d ? ` <small>${esc(t("about $1 km", fmt(s.d / 1000)))}</small>` : sp ? ` <small>${esc(t("about $1 km", fmt(kmOf(d.c, sp))))}</small>` : ""}
			${from ? `<div>${esc(t("Source"))}: <a href="#" data-go="${from.id}">${esc(nameOf(from))}</a></div>` : s.fn && lang === "ja" ? `<div>${esc(t("Source"))}: ${esc(s.fn)}</div>` : ""}
			${s.x && lang === "ja" ? `<q>${esc(s.x)}</q>` : ""}${sp ? `<a href="#" class="srcgo">${esc(t("Show the source"))}</a>` : ""}</div>` : "";
		const myInns = (d.h || []).map(j => inns[j]).filter(Boolean).map(x => `<li><a href="${esc(x.u)}" target="_blank" rel="noopener">${esc(x.n)}</a>${x.q && lang === "ja" ? `<small>${esc(x.q)}</small>` : ""}</li>`).join("");
		el.hidden = false;
		el.innerHTML = `<div class="dh"><span class="sw" style="background:${d.k === "g" ? KYO : d.qc ? CLASS_COLORS[d.qc[0]] : UNKNOWN}"></span><div><b class="nm">${esc(nameOf(d))}</b><small>${esc([d.k === "g" ? t("Onsen district") : "", prefOf(d), lang === "ja" ? d.m : ""].filter(Boolean).join(" · "))}${alt.length ? "<br>" + esc(alt.join(" · ")) : ""}</small></div><button class="x" type="button" aria-label="${esc(t("Close"))}">×</button></div>
			${chips ? `<div class="chips">${chips}</div>` : ""}
			${lang === "ja" ? row(t("Spring quality"), esc(d.q)) : ""}
			${row(t("Temperature"), d.t != null ? `${fmt(d.t)} °C` : null)}${row("pH", d.ph != null ? fmt(d.ph) : null)}${lang === "ja" ? row(t("Liquid"), esc(d.l)) : ""}
			${row(t("Position"), pos)}
			${par ? row(t("Part of"), par) : ""}${mem ? `<div class="mem"><span>${esc(t("Hot springs in this district"))}</span><div>${mem}</div></div>` : ""}
			${srcHtml}
			${myInns ? `<div class="inns"><span>${esc(t("Secluded hot spring inns"))}</span><ul>${myInns}</ul></div>` : ""}
			<div class="dl"><span>${d.c[1].toFixed(4)}°, ${d.c[0].toFixed(4)}°</span><span>${w ? `<a class="wk" href="${esc(w)}" target="_blank" rel="noopener">Wikipedia</a>` : ""}${d.site ? ` <a href="${esc(d.site)}" target="_blank" rel="noopener">${esc(t("Official site"))}</a>` : ""}</span></div>`;
		el.querySelector(".x").onclick = () => select(null);
		el.querySelectorAll("[data-go]").forEach(a => a.onclick = e => { e.preventDefault(); select(a.dataset.go); });
		const sg = el.querySelector(".srcgo"); if (sg) sg.onclick = e => { e.preventDefault(); const bb = bboxOf([d.c, sp]); map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(8, Math.min(13, map.fitZoomForBbox(bb) - 0.6))); };
		const wk = el.querySelector(".wk"); if (wk) wikiFrame.link(wk, w, nameOf(d));
	}

	// ── 一覧（都道府県・種別で絞る・名前／よみ／ローマ字で検索）──
	const prefSel = $(".pref"), kindSel = $(".kind"), find = $(".find"), ol = $(".list"), cnt = $(".cnt");
	const KIND = { g: d => d.k === "g", s: d => !!d.s, h: d => !!d.h, e: d => d.a > 0 };
	const list = {
		render() {
			const p = +prefSel.value || 0, k = KIND[kindSel.value], q = kana(find.value.trim());
			let rows = items.filter(d => (!p || d.p === p) && (!k || k(d)) && (!q || kana(d.n).includes(q) || kana(d.r).includes(q) || (d.en || "").toLowerCase().includes(q) || kana(d.m).includes(q)));
			rows.sort((a, b) => lang === "ja" ? kana(a.r || a.n).localeCompare(kana(b.r || b.n), "ja") : nameOf(a).localeCompare(nameOf(b), lang));
			cnt.textContent = t("$1 places", rows.length.toLocaleString(lang));
			ol.innerHTML = rows.slice(0, 400).map(d => `<li data-o="${d.id}"><span class="dot${d.a > 0 ? " est" : ""}" style="--c:${d.k === "g" ? KYO : d.qc ? CLASS_COLORS[d.qc[0]] : UNKNOWN}"></span><span class="n">${esc(nameOf(d))}</span><small>${esc(prefOf(d))}</small>${d.h ? `<i class="ih" title="${esc(t("Secluded hot spring inns"))}"></i>` : ""}</li>`).join("");
			this.mark();
		},
		mark() { ol.querySelectorAll("li").forEach(li => li.classList.toggle("on", li.dataset.o === sel)); },
	};
	prefSel.onchange = () => { list.render(); const p = +prefSel.value; if (p) { const bb = bboxOf(items.filter(d => d.p === p).map(d => d.c)); map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(5, Math.min(10, map.fitZoomForBbox(bb) - 0.3))); } };
	kindSel.onchange = () => list.render();
	find.oninput = () => list.render();
	ol.onclick = e => { const li = e.target.closest("li"); if (li) select(li.dataset.o); };
	ol.onmouseover = e => { const li = e.target.closest("li"); map.setFilter("on-sel", ["match", ["get", "id"], [sel ?? "", li?.dataset.o ?? ""], true, false]); };
	ol.onmouseleave = () => map.setFilter("on-sel", ["==", ["get", "id"], byId.get(sel)?.k === "o" ? sel : ""]);

	apply();
	// 共有 URL（?o=ID）の選択を復元
	const o0 = new URLSearchParams(location.search).get("o");
	if (o0 && byId.has(o0)) select(o0, { fly: !location.hash });

	return { select, items, byId, inns, points, kyoFeats, srcFeats, get sel() { return sel; }, list };
}

function centerOf(ring) { const bb = bboxOf(ring); return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]; }
const fmt = v => (+v).toLocaleString(getLang(), { maximumFractionDigits: v < 10 ? 1 : 0 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ── 意匠（quiet-mono のトークン＝#map の変数を使う＝terrain と同じ）──
const CSS = `
.on-panel{position:absolute;top:12px;right:12px;z-index:30;width:320px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;box-sizing:border-box;
	padding:12px 14px;border-radius:var(--qm-r-l);background:var(--qm-panel-solid);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);
	backdrop-filter:blur(var(--qm-blur));-webkit-backdrop-filter:blur(var(--qm-blur));color:var(--qm-text);font:13px/1.45 var(--qm-font)}
.on-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.on-panel h1{flex:1;min-width:0;font-size:15px;margin:0;font-weight:700;color:var(--qm-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.on-panel .head .lang{flex:none;max-width:120px;font-size:12px;padding:3px 4px}
.on-panel .fold,.on-panel .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer}
.on-panel.min .body{display:none}
.on-panel .tabs{display:flex;gap:4px;margin:10px 0 8px;border-bottom:1px solid var(--qm-border-soft)}
.on-panel .tabs button{flex:1;border:0;background:none;padding:6px 4px;font:inherit;color:var(--qm-text-dim);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.on-panel .tabs button.on{color:var(--qm-ink);font-weight:700;border-bottom-color:var(--qm-ink)}
.on-panel .grp{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
.on-panel .grp small{margin-left:auto;color:var(--qm-text-faint)}
.on-panel h2{font-size:12px;margin:10px 0 2px;color:var(--qm-text-dim);font-weight:600}
.on-panel .sw{flex:none;width:12px;height:12px;border-radius:50%;box-sizing:border-box}
.on-panel .sw.ln{height:4px;border-radius:2px}
.on-panel .sw.ring{background:#fff;border:2px solid #7a8699;opacity:.8}
.on-panel .sw.inn{border-radius:2px;background:#a8402a}
.on-panel .sw.none{background:none}
.on-panel .all{display:flex;gap:6px;margin:2px 0 0 20px}
.on-panel .all button{font:inherit;font-size:11.5px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);border-radius:6px;padding:1px 8px;cursor:pointer}
.on-panel .note{color:var(--qm-text-dim);font-size:12px;margin:8px 0 0}
.on-panel .src{color:var(--qm-text-faint);font-size:11px;margin:6px 0 0}
.on-panel .ctl{display:flex;gap:6px}
.on-panel select,.on-panel .find{flex:1;min-width:0;font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:#fff;color:var(--qm-text);padding:5px 6px}
.on-panel .find{display:block;width:100%;box-sizing:border-box;margin-top:6px}
.on-panel .cnt{margin:6px 0 0;font-size:11.5px;color:var(--qm-text-faint)}
.on-panel .list{list-style:none;margin:4px 0 0;padding:0;max-height:46vh;overflow:auto}
.on-panel .list li{display:flex;gap:7px;align-items:center;padding:4px;border-radius:6px;cursor:pointer}
.on-panel .list li:hover{background:rgba(43,59,87,.06)}
.on-panel .list li.on{background:rgba(215,38,61,.08)}
.on-panel .list .dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--c)}
.on-panel .list .dot.est{background:#fff;border:1.6px solid var(--c);box-sizing:border-box}
.on-panel .list .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.on-panel .list small{flex:none;color:var(--qm-text-faint);font-size:11.5px}
.on-panel .list .ih{flex:none;width:8px;height:8px;border-radius:2px;background:#a8402a}
.on-panel .detail{margin:10px 0 2px;padding:10px;border-radius:var(--qm-r-m);background:rgba(43,59,87,.04);border:1px solid var(--qm-border-soft)}
.on-panel .dh{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}
.on-panel .dh .sw{margin-top:4px}
.on-panel .dh > div{flex:1;min-width:0}
.on-panel .dh .nm{display:block;font-size:15px;color:var(--qm-ink)}
.on-panel .dh small{color:var(--qm-text-dim)}
.on-panel .chips{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px}
.on-panel .chip{font-size:11.5px;padding:1px 7px;border-radius:9px;color:#fff;background:var(--c)}
.on-panel .m{display:flex;align-items:baseline;gap:8px;padding:2px 0}
.on-panel .m span{flex:none;color:var(--qm-text-dim);min-width:84px}
.on-panel .m b{font-weight:500;color:var(--qm-ink)}
.on-panel .m small{color:var(--qm-text-faint)}
.on-panel .mem,.on-panel .inns{margin-top:6px}
.on-panel .mem span,.on-panel .inns span{display:block;color:var(--qm-text-dim);font-size:12px}
.on-panel .mem div{font-size:12.5px;line-height:1.6}
.on-panel .inns ul{margin:2px 0 0;padding-left:16px}
.on-panel .inns small{display:block;color:var(--qm-text-faint);font-size:11px}
.on-panel .srcbox{margin-top:6px;padding:6px 8px;border-left:3px solid ${SRC};background:rgba(192,57,43,.05);border-radius:0 6px 6px 0;font-size:12.5px}
.on-panel .srcbox b{color:${SRC};font-weight:600}
.on-panel .srcbox small{color:var(--qm-text-dim)}
.on-panel .srcbox q{display:block;margin-top:3px;color:var(--qm-text-dim);font-size:12px}
.on-panel .srcbox .srcgo{display:inline-block;margin-top:3px}
.on-panel a{color:var(--qm-ink)}
.on-panel .dl{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:12px;color:var(--qm-text-faint)}
.oe-wiki.on-wiki{left:12px;top:12px;bottom:calc(40px + var(--qm-safe-b));width:min(560px,calc(100% - 356px));z-index:31}
@media (max-width:720px){
	.oe-wiki.on-wiki{left:8px;right:8px;top:8px;width:auto}
	.on-panel{left:12px;right:12px;width:auto;max-height:44vh}
}`;
