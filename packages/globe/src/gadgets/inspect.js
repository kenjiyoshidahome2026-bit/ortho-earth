// ガジェット本体：検査表示（maplibre-gl-inspect 相当・#174）。ボタン 1 つで地図を「検査表示」へ切り替え、読み込んでいるベクタタイルの全 source-layer を
// 層ごとに色を変えて描く（面＝薄い塗り＋縁・線・点）。ホバー／クリックで、カーソルの下の地物の層名と属性を札に出す。もう一度押すと元の地図へ戻る。
// 形は公式に揃える（オプション名・既定値・層 id・札の class 名）：showInspectMap・showInspectButton・showMapPopup・showInspectMapPopup・showMapPopupOnHover・
// showInspectMapPopupOnHover・blockHoverPopupOnClick・selectThreshold・backgroundColor・assignLayerColor(layerId, alpha)・renderPopup(features)・queryParameters・
// sources（{ source: [source-layer…] }＝台帳に無い層を足す）・popup・toggleCallback(showInspectMap)。
// 公式との違い＝公式は検査用の style を丸ごと作って差し替える。こちらは地図の内側（globe.js の inspectView）が基図・利用者の層・世界の帯を伏せ、
// 検査の層を利用者の層として足す（vector＝vtdraw・geojson＝gint）＝戻すと焼き直しなしで元の絵。問い合わせは非同期（queryRenderedFeatures）。
// 地図の内側から受け取る物（抽象アクセス）：listSources()＝層の台帳・view.set(on, { background })＝下地・canvas／evXY＝ポインタの座標。
import { Popup } from "./marker.js";
import { INSPECT_ICON } from "./inspect-stub.js";
import { tr } from "../i18n.js";
const t = tr();

// 検査中のボタン＝折り畳んだ地図（押すと地図へ戻る・公式の maplibregl-ctrl-map と同じ意味）
const MAP_ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
		<path d="M3 6.5l5.5-2.5 7 2.5 5.5-2.5v13.5l-5.5 2.5-7-2.5L3 20z"/><path d="M8.5 4v13.5M15.5 6.5V20" stroke-width="1.4"/></svg>`;

// 札の見た目（公式 maplibre-gl-inspect.css と同じ class 名＝頁が公式の CSS を読んでいても同じ姿）。長い札は巻物（地図を覆い尽くさない）
const CSS = `
.oe-inspect .oe-popup-body { max-height: min(45vh, 360px); overflow: auto; font-size: 12px; }
.maplibregl-inspect_popup { color: #333; display: table; }
.maplibregl-inspect_feature:not(:last-child) { border-bottom: 1px solid #ccc; padding-bottom: 3px; margin-bottom: 3px; }
.maplibregl-inspect_layer { font-weight: 600; }
.maplibregl-inspect_layer::before { content: "#"; }
.maplibregl-inspect_property { display: table-row; }
.maplibregl-inspect_property-name { display: table-cell; padding-right: 10px; color: #666; }
.maplibregl-inspect_property-value { display: table-cell; word-break: break-all; }`;
let cssOn = false;
const ensureCss = () => { if (cssOn) return; cssOn = true; const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); };

// 層の色（公式の brightColor と同じ考え＝層名を種にした明るい色・よくある層名は色相を寄せる）。randomcolor は持たない＝色相の帯と明るさだけ写す
const HUE = { blue: [179, 257], pink: [283, 334], orange: [18, 46], yellow: [46, 62], green: [62, 178] };
const seeded = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; }; };
const hsl2rgb = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return [f(0), f(8), f(4)].map(v => Math.round(v * 255)); };
export function brightColor(layerId, alpha) {
	const id = String(layerId);
	let lum = "bright", hue = null;
	if (/water|ocean|lake|sea|river/.test(id)) hue = "blue";
	if (/state|country|place/.test(id)) hue = "pink";
	if (/road|highway|transport|streets/.test(id)) hue = "orange";
	if (/contour|building|earth/.test(id)) hue = "monochrome";
	if (/building/.test(id)) lum = "dark";
	if (/earth/.test(id)) lum = "light";
	if (/contour|landuse/.test(id)) hue = "yellow";
	if (/wood|forest|park|landcover|land/.test(id)) hue = "green";
	const r = seeded(id), [h0, h1] = HUE[hue] || [0, 360];
	const H = h0 + r() * (h1 - h0);
	const S = hue === "monochrome" ? 0 : lum === "dark" ? 70 + r() * 25 : lum === "light" ? 45 + r() * 30 : 60 + r() * 35;
	const L = lum === "dark" ? 25 + r() * 15 : lum === "light" ? 72 + r() * 13 : 42 + r() * 16;
	return `rgba(${hsl2rgb(H, S, L).join(", ")}, ${alpha || 1})`;   // alpha 0＝1（公式と同じ）
}

// 札の中身（公式の renderPopup と同じ形）。値は外のデータ＝文字として入れる（innerHTML を使わない＝消毒の要らない組み方）
const val = v => v instanceof Date ? v.toLocaleString() : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
const div = (cls, text) => { const d = document.createElement("div"); d.className = cls; if (text != null) d.textContent = text; return d; };
const prop = (k, v) => { const d = div("maplibregl-inspect_property"); d.append(div("maplibregl-inspect_property-name", k), div("maplibregl-inspect_property-value", val(v))); return d; };
export function renderPopup(features) {
	const root = div("maplibregl-inspect_popup");
	for (const f of features) {
		const fe = div("maplibregl-inspect_feature");
		fe.append(div("maplibregl-inspect_layer", f.sourceLayer ?? f.layer?.["source-layer"] ?? f.source ?? f.layer?.source ?? ""), prop("$id", f.id), prop("$type", f.geometry?.type));
		for (const [k, v] of Object.entries(f.properties || {})) fe.append(prop(k, v));
		root.append(fe);
	}
	return root;
}

const DEFAULTS = {
	showInspectMap: false, showInspectButton: true, showInspectMapPopup: true, showMapPopup: false, showMapPopupOnHover: true, showInspectMapPopupOnHover: true,
	blockHoverPopupOnClick: false, backgroundColor: "#fff", selectThreshold: 5, queryParameters: {}, sources: {},
	assignLayerColor: brightColor, renderPopup, toggleCallback: () => {},
};
const KINDS = ["polygon", "line", "circle"];   // 下から（公式と同じ＝全部の面の上に全部の線・その上に全部の点）
const FILTER = { polygon: ["==", "$type", "Polygon"], line: ["==", "$type", "LineString"], circle: ["==", "$type", "Point"] };

export function inspect(opts = {}) {
	const map = this, o = { ...DEFAULTS, ...opts }, btn = opts.btn || null;
	const { listSources, view, canvas, evXY } = opts;
	ensureCss();
	const ac = new AbortController();
	const popup = o.popup || new Popup({ closeButton: false, closeOnClick: false, maxWidth: "min(420px, 80vw)" });
	const popEl = () => popup.getElement?.() ?? null;
	popEl()?.classList.add("oe-inspect");
	let showing = false, gen = 0, blocked = false, last = [], syncing = null, again = false;
	const mine = new Map();    // 層 id → { sid, sl, kind }（足した順＝下から）
	const idMemo = new Map();  // "sid\0sl\0kind" → 層 id（一度決めた id は変えない）
	const color = (name, a) => o.assignLayerColor(name, a);
	// 層 id＝公式と同じ（[source, sourceLayer, kind].join("_")＝geojson は source__kind）。利用者の層と同じ id なら "inspect:" を前に（利用者の層を置き換えない）
	const idOf = (sid, sl, kind) => {
		const k = `${sid}\u0000${sl ?? ""}\u0000${kind}`;
		let id = idMemo.get(k);
		if (!id) { id = [sid, sl ?? "", kind].join("_"); if (map.getLayer(id)) id = "inspect:" + id; idMemo.set(k, id); }
		return id;
	};
	const layerOf = (sid, sl, kind) => {
		const name = sl ?? sid, base = { id: idOf(sid, sl, kind), source: sid, ...(sl != null ? { "source-layer": sl } : {}), filter: FILTER[kind] };
		if (kind === "polygon") return { ...base, type: "fill", paint: { "fill-color": color(name, 0.3), "fill-antialias": true, "fill-outline-color": color(name, 0.6) } };
		if (kind === "line") return { ...base, type: "line", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color(name, 0.6) } };
		return { ...base, type: "circle", paint: { "circle-color": color(name, 0.8), "circle-radius": 2 } };
	};
	const setBtn = on => {
		if (!btn) return;
		const lbl = on ? t("Back to the map") : t("Inspect vector tiles");
		btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", String(on)); btn.dataset.tip = lbl; btn.setAttribute("aria-label", lbl);
		btn.innerHTML = on ? MAP_ICON : INSPECT_ICON;
	};
	// 台帳を読んで検査の層を合わせる（足す・外す）。走っている間の呼び出しは 1 回に畳む
	const sync = () => {
		if (syncing) { again = true; return syncing; }
		syncing = (async () => {
			do {
				again = false;
				const g = gen, srcs = await listSources();
				if (!showing || g !== gen) break;
				for (const [sid, ls] of Object.entries(o.sources || {})) {   // 明示の層（公式の sources）＝台帳に足す
					const s = srcs.find(x => x.id === sid); if (!s || s.type !== "vector" || !Array.isArray(ls)) continue;
					const have = new Set((s.layers || []).map(l => l.id));
					s.layers = [...(s.layers || []), ...ls.filter(id => typeof id === "string" && !have.has(id)).map(id => ({ id, fields: {} }))];
				}
				last = srcs;
				const want = new Map();
				for (const s of srcs) for (const sl of s.type === "geojson" ? [null] : (s.layers || []).map(l => l.id)) for (const kind of KINDS) want.set(idOf(s.id, sl, kind), { sid: s.id, sl, kind });
				for (const [id] of [...mine]) if (!want.has(id)) { mine.delete(id); try { map.removeLayer(id); } catch { /* 既に無い */ } }
				// 足すのは一斉に（addLayer は登録簿の順を同期で決める＝待たずに並べても順は崩れない・描く側の組み直しが層ごとに走らない）
				const adds = [];
				for (const [ki, kind] of KINDS.entries()) for (const [id, w] of want) {
					if (w.kind !== kind || mine.has(id)) continue;
					const before = [...mine].find(([, m]) => KINDS.indexOf(m.kind) > ki)?.[0];   // 面は線と点の下・線は点の下（後から見つかった層も）
					mine.set(id, w);
					adds.push(map.addLayer(layerOf(w.sid, w.sl, kind), before).catch(err => { mine.delete(id); console.warn(`[inspect] layer "${id}"`, err?.message ?? err); }));
				}
				await Promise.all(adds);
			} while (again && showing);
			syncing = null;
		})();
		return syncing;
	};
	const clearLayers = () => { for (const id of [...mine.keys()].reverse()) { try { map.removeLayer(id); } catch { /* 既に無い */ } } mine.clear(); };
	const api = {
		async open() {
			if (showing) return api;
			showing = true; gen++; blocked = false; setBtn(true);
			view.set(true, { background: o.backgroundColor });   // 先に伏せる（検査の層は後から足す＝伏せる対象に入らない）
			await sync();
			try { o.toggleCallback(true); } catch (err) { console.error("[inspect] toggleCallback", err); }
			return api;
		},
		async close() {
			if (!showing) return api;
			showing = false; gen++; blocked = false; setBtn(false);
			await syncing;
			clearLayers();
			view.set(false);
			popup.remove();
			try { o.toggleCallback(false); } catch (err) { console.error("[inspect] toggleCallback", err); }
			return api;
		},
		toggle: () => showing ? api.close() : api.open(),
		toggleInspector: () => api.toggle(),
		render: () => showing ? sync().then(() => api) : Promise.resolve(api),
		isOpen: () => showing,
		layers: () => [...mine.keys()],
		sources: () => last.map(s => ({ ...s, layers: s.layers ? s.layers.map(l => ({ ...l })) : null })),
		destroy() {   // 外す（互換の removeControl）＝検査中なら元の地図へ戻してから畳む
			if (showing) { showing = false; gen++; setBtn(false); clearLayers(); view.set(false); try { o.toggleCallback(false); } catch (err) { console.error("[inspect] toggleCallback", err); } }
			teardown(); btn?.remove();
		},
	};
	const teardown = () => { ac.abort(); map.off("settle", onSettle); popup.remove(); };
	// 視点が止まるたびに台帳を読み直す＝タイルを解いて集める source（地域の基図など）は新しい z の層が増える
	const onSettle = () => { if (showing) sync(); };
	map.on("settle", onSettle);
	btn?.addEventListener("click", () => api.toggle(), { signal: ac.signal });

	// ── 札（段 4）＝公式と同じ判定（検査中は showInspectMapPopup・通常は showMapPopup／ホバーかクリックか／クリックで札を止める）──
	let raf = 0, lastMove = null, seq = 0, downAt = null;
	const hoverMode = () => showing ? o.showInspectMapPopupOnHover : o.showMapPopupOnHover;
	const onPointer = async (e, type) => {
		const hover = type === "mousemove";
		if (showing) { if (!o.showInspectMapPopup || (hover && !o.showInspectMapPopupOnHover)) return; }
		else if (!o.showMapPopup || (hover && !o.showMapPopupOnHover)) return;
		if (!hover && hoverMode() && o.blockHoverPopupOnClick) { blocked = !blocked; const el = popEl(); if (el) el.style.pointerEvents = blocked ? "" : "none"; }   // 止めた札は触れる（巻物を回せる）
		if (blocked) return;
		const [x, y] = evXY(e), my = ++seq, th = +o.selectThreshold || 0;
		const qp = { ...(o.queryParameters || {}) };
		if (showing && !qp.layers) qp.layers = [...mine.keys()];   // 検査中＝検査の層だけに当てる（伏せた基図のタイルを取り直さない）
		if (qp.layers && !qp.layers.length) { popup.remove(); return; }
		let fs;
		try { fs = await map.queryRenderedFeatures([[x - th, y - th], [x + th, y + th]], qp); } catch (err) { console.warn("[inspect] query", err); return; }
		if (my !== seq) return;   // 追い越された
		const ll = map.unprojectXY(x, y);
		if (!fs.length || !ll) { popup.remove(); return; }
		const body = o.renderPopup(fs);
		popup.setLngLat(ll);
		if (typeof body === "string") popup.setHTML(body); else popup.setDOMContent(body);
		if (!popup.isOpen?.()) popup.addTo(map);
		const el = popEl(); if (el) el.style.pointerEvents = hover ? "none" : "";   // ホバーの札はポインタを奪わない（札の上に乗っても地図が動きを受ける）
	};
	canvas.addEventListener("pointerdown", e => { downAt = evXY(e); }, { signal: ac.signal });
	canvas.addEventListener("pointermove", e => {
		if (e.buttons) return;   // ドラッグ中は当てない（パンの邪魔をしない）
		lastMove = e;
		if (!raf) raf = requestAnimationFrame(() => { raf = 0; onPointer(lastMove, "mousemove"); });
	}, { signal: ac.signal });
	canvas.addEventListener("click", e => { const [x, y] = evXY(e); if (downAt && Math.hypot(x - downAt[0], y - downAt[1]) > 5) return; onPointer(e, "click"); }, { signal: ac.signal });   // ドラッグの終わり＝クリックではない
	canvas.addEventListener("pointerleave", () => { seq++; if (hoverMode() && !blocked) popup.remove(); }, { signal: ac.signal });
	ac.signal.addEventListener("abort", () => { cancelAnimationFrame(raf); }, { once: true });
	opts.signal?.addEventListener("abort", () => { showing = false; gen++; teardown(); }, { once: true });   // 地図ごと壊す（map.destroy）＝戻さずに畳むだけ
	if (o.showInspectMap) api.open();
	return api;
}
