// 横浜市デジタルツインの案内板と機能（main.ts から遅延 import）。地図は orthoJapan（PLATEAU の建物・地形・基図はエンジンが持つ）。
// ここが足すのは 4 つの面と名所ツアー：
//   まち … 18 区へ飛ぶ・名所へ飛ぶ・名所ツアー（全景 → 名所を巡って回り込む → 全景）
//   防災 … 重ねるハザードマップ（洪水・高潮・津波・土砂災害警戒区域）を 3D の街に重ねる・指定緊急避難場所（対応災害で絞る・押すと標高）
//   時間 … 年代の航空写真（1945 年〜いま）・その時刻の建物の影・冬至の日影図
//   解析 … 可視域・切り取り（断面）・一人称で歩く・距離と面積・断面図
// 状態は URL の search（?tab=&hz=&era=&ward=&spot=）に写す＝その画面をそのまま共有できる（data.ts の parseState／writeState）。
// UI は日本語のみ（横浜市の頁）。選挙・候補者・政策の中身には触れない＝市政の中立な道具として作る（本人 2026-10-18）。
import type { GlobeMap, LayerMouseEvent, GeoJSONFeature, LonLat, WalkHandle } from "@ortho-earth/globe";
import { WARDS, SPOTS, TOUR, HAZARDS, ERAS, CITY_VIEW, HINAN_FLAGS, yokohamaShelters, flagsOf, parseState, writeState } from "./data.ts";
import type { Spot, HinanRow, TwinState, Tab } from "./data.ts";

const HINAN_URL = "https://api.ortho-earth.com/bucket/bousai/hinan/14.json";   // 神奈川県の指定緊急避難場所（census2020 と同じ焼き・[経度, 緯度, 名称, 住所, 対応災害ビット]）
const HAZARD_ATTR = `<a href="https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html" target="_blank" rel="noopener">ハザードマップポータルサイト（国土交通省）</a>`;
const PHOTO_ATTR = `<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル（国土地理院）</a>`;
const JAPAN_BBOX: [number, number, number, number] = [122, 20, 154, 46];
const ERA_BBOX: [number, number, number, number] = [139.3, 35.2, 139.9, 35.7];

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const gunzip = async (buf: ArrayBuffer): Promise<ArrayBuffer> => {
	const h = new Uint8Array(buf, 0, 2);
	return h[0] === 0x1f && h[1] === 0x8b ? new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : buf;
};
// 日本時間の「YYYY-MM-DD」と時（小数）→ Date
const jst = (ymd: string, h: number) => new Date(`${ymd}T${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}:00+09:00`);
const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export async function mountTwin(map: GlobeMap) {
	document.title = "横浜市デジタルツイン";
	const mapEl = map.mapEl;
	const st: TwinState = parseState(location.search);
	const gpu = map.backend === "webgpu";
	const save = () => { const s = writeState(location.search, st); history.replaceState(history.state, "", location.pathname + s + location.hash); };

	// ── カメラ ──
	const flyView = (v: { lon: number; lat: number; zoom: number; tilt: number; bearing: number }) => map.flyTo({ center: [v.lon, v.lat], zoom: v.zoom, pitch: v.tilt, bearing: v.bearing });
	const flySpot = (s: Spot) => flyView(s);

	// ── 案内板（右上）──
	const panel = document.createElement("div");
	panel.className = "yk-panel";
	panel.innerHTML = `<style>${CSS}</style>
		<div class="head">
			<div class="ttl"><h1>横浜市デジタルツイン</h1><p>3D 都市モデルに、防災・歴史・解析を重ねる</p></div>
			<button class="fold" type="button" aria-label="畳む">–</button>
		</div>
		<div class="body">
			<button class="tour" type="button">▶ 名所ツアー</button>
			<nav class="tabs" role="tablist">
				${(["city", "risk", "time", "tools"] as Tab[]).map(t => `<button type="button" role="tab" data-tab="${t}">${{ city: "まち", risk: "防災", time: "時間", tools: "解析" }[t]}</button>`).join("")}
			</nav>
			<section data-pane="city">
				<label class="msel"><span>区へ飛ぶ</span><select class="ward"><option value="">横浜市の全景</option>${WARDS.map(w => `<option value="${w.code}">${esc(w.name)}</option>`).join("")}</select></label>
				<h2>名所</h2>
				<div class="spots">${SPOTS.map(s => `<button type="button" data-spot="${s.id}">${esc(s.name)}</button>`).join("")}</div>
				<div class="spot-note" hidden></div>
				<p class="note">建物は国土交通省 PLATEAU の 3D 都市モデル。傾ける＝右ドラッグか 2 本指。</p>
			</section>
			<section data-pane="risk" hidden>
				<h2>災害の想定を重ねる</h2>
				${HAZARDS.map(h => `<label class="grp"><input type="checkbox" data-hz="${h.id}"><b>${esc(h.name)}</b></label><p class="sub" data-hznote="${h.id}" hidden>${esc(h.note)}</p>`).join("")}
				<label class="msel hzop-w" hidden><span>濃さ</span><input type="range" class="hzop" min="0.2" max="1" step="0.05" value="0.7"></label>
				<div class="legend" hidden></div>
				<h2>指定緊急避難場所</h2>
				<label class="grp"><input type="checkbox" class="hinan"><b>避難場所を出す</b><small class="hn-n"></small></label>
				<label class="msel"><span>対応する災害</span><select class="hnf"><option value="-1">すべて</option>${HINAN_FLAGS.map((f, i) => `<option value="${i}">${esc(f)}</option>`).join("")}</select></label>
				<div class="detail" hidden></div>
				<p class="note">傾けると、浸水の深さと建物の高さを見比べられます。想定は国土交通省・神奈川県などの公表値で、実際の災害はこれを超えることがあります。</p>
			</section>
			<section data-pane="time" hidden>
				<h2>年代の航空写真</h2>
				<div class="eras">${ERAS.map(e => `<label class="grp"><input type="radio" name="yk-era" value="${e.id}">${esc(e.name)}</label>`).join("")}</div>
				<p class="sub flat">1945〜50 年は米軍、それ以降は国土地理院の撮影。古い写真は寄った時（z10 以上）に出ます。</p>
				<h2>建物の影</h2>
				${gpu ? `<label class="grp"><input type="checkbox" class="shadow"><b>その時刻の影を落とす</b></label>
				<div class="dates"><label>日<input type="date" class="sday"></label><label>時刻 <output class="shour-o"></output><input type="range" class="shour" min="5" max="19" step="0.25" value="12"></label></div>`
					: `<p class="sub flat">リアルタイムの影は WebGPU の使えるブラウザ（Chrome・Edge など）で出ます。</p>`}
				<button type="button" class="act sunmap">冬至の日影図（8〜16 時）</button>
				<button type="button" class="act sunclear" hidden>日影図を消す</button>
				<p class="sub sunmsg"></p>
			</section>
			<section data-pane="tools" hidden>
				<h2>画面の中心で</h2>
				<button type="button" class="act vs">可視域（半径 1km・目の高さ 1.6m）</button>
				<button type="button" class="act vsclear" hidden>可視域を消す</button>
				${gpu ? `<button type="button" class="act clip">切り取る（500m 四方）</button>` : ""}
				<button type="button" class="act walk">一人称で歩く（Esc で戻る）</button>
				<h2>測る</h2>
				<button type="button" class="act measure">距離と面積</button>
				<button type="button" class="act profile">断面図（標高）</button>
				<p class="sub toolmsg"></p>
			</section>
			<p class="attr">出典：国土交通省 PLATEAU・国土地理院・ハザードマップポータルサイト・指定緊急避難場所データ（国土地理院）</p>
		</div>`;
	mapEl.appendChild(panel);
	for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) panel.addEventListener(ev, e => e.stopPropagation());
	const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => panel.querySelector<T>(s)!;
	const $$ = <T extends HTMLElement = HTMLInputElement>(s: string) => [...panel.querySelectorAll<T>(s)];
	$(".fold").onclick = () => { panel.classList.toggle("min"); $(".fold").textContent = panel.classList.contains("min") ? "+" : "–"; };

	// ── 面の切り替え ──
	function setTab(t: Tab) {
		st.tab = t; save();
		$$<HTMLButtonElement>("[data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
		$$<HTMLElement>("[data-pane]").forEach(p => { p.hidden = p.dataset.pane !== t; });
	}
	$$<HTMLButtonElement>("[data-tab]").forEach(b => b.onclick = () => setTab(b.dataset.tab as Tab));

	// ── まち：区・名所 ──
	const spotNote = $<HTMLElement>(".spot-note");
	function showSpot(s: Spot | null) {
		st.spot = s?.id || ""; save();
		$$<HTMLButtonElement>("[data-spot]").forEach(b => b.classList.toggle("on", b.dataset.spot === st.spot));
		spotNote.hidden = !s;
		spotNote.innerHTML = s ? `<b>${esc(s.name)}</b><span>${esc(WARDS.find(w => w.code === s.ward)?.name || "")}</span><p>${esc(s.note)}</p>` : "";
	}
	$$<HTMLButtonElement>("[data-spot]").forEach(b => b.onclick = () => { const s = SPOTS.find(x => x.id === b.dataset.spot)!; showSpot(s); flySpot(s); });
	const wardSel = $<HTMLSelectElement>(".ward");
	wardSel.onchange = () => {
		st.ward = wardSel.value; save();
		const w = WARDS.find(x => x.code === st.ward);
		flyView(w ? { lon: w.lon, lat: w.lat, zoom: w.zoom, tilt: 45, bearing: 0 } : CITY_VIEW);
	};

	// ── 名所ツアー（画面の下に札・地図に触れたら止まる）──
	const cap = document.createElement("div");
	cap.className = "yk-cap"; cap.hidden = true;
	mapEl.appendChild(cap);
	let touring = 0;   // ツアーの通し番号（0＝止まっている）
	const stopTour = () => { if (!touring) return; touring = 0; cap.hidden = true; $(".tour").textContent = "▶ 名所ツアー"; };
	for (const ev of ["pointerdown", "wheel"]) mapEl.addEventListener(ev, e => { if (!panel.contains(e.target as Node) && !cap.contains(e.target as Node)) stopTour(); });
	cap.addEventListener("click", e => { if ((e.target as HTMLElement).closest(".x")) stopTour(); });
	async function tour() {
		if (touring) { stopTour(); return; }
		const run = touring = Date.now();
		$(".tour").textContent = "■ ツアーを止める";
		const stops = TOUR.map(id => SPOTS.find(s => s.id === id)!);
		const say = (html: string) => { if (touring === run) { cap.hidden = false; cap.innerHTML = `${html}<button class="x" type="button" aria-label="止める">×</button>`; } };
		say(`<b>横浜市</b><p>18 区・約 437 km²。港から丘陵の住宅地まで、3D の街を巡ります。</p>`);
		await flyView(CITY_VIEW); await sleep(2500);
		for (const [i, s] of stops.entries()) {
			if (touring !== run) return;
			say(`<small>${i + 1} / ${stops.length}・${esc(WARDS.find(w => w.code === s.ward)?.name || "")}</small><b>${esc(s.name)}</b><p>${esc(s.note)}</p>`);
			showSpot(s);
			await flySpot(s);
			if (touring !== run) return;
			await map.easeTo({ bearing: s.bearing + 40, duration: 6000 });   // ゆっくり回り込む
		}
		if (touring !== run) return;
		await flyView(CITY_VIEW);
		stopTour();
	}
	$(".tour").onclick = () => { tour(); };

	// ── 防災：ハザードの画像タイル ──
	const hzOn = new Set<string>();
	let hzOpacity = 0.7;
	const hzIds = (id: string) => HAZARDS.find(h => h.id === id)!.urls.map((_, i) => `yk-hz-${id}-${i}`);
	async function setHazard(id: string, on: boolean) {
		const h = HAZARDS.find(x => x.id === id); if (!h) return;
		on ? hzOn.add(id) : hzOn.delete(id);
		st.hz = HAZARDS.filter(x => hzOn.has(x.id)).map(x => x.id); save();
		$(`[data-hz="${id}"]`).checked = on;
		$<HTMLElement>(`[data-hznote="${id}"]`).hidden = !on;
		renderLegend();
		if (!on) { for (const rid of hzIds(id)) map.raster.remove(rid); return; }
		await Promise.all(h.urls.map((url, i) => map.raster.add(`yk-hz-${id}-${i}`, { url, minZoom: 2, maxZoom: h.maxZoom, bbox: JAPAN_BBOX, attribution: HAZARD_ATTR, name: h.name }, { order: "over", opacity: hzOpacity })
			.catch(e => console.warn("[yokohama] hazard", id, e))));
	}
	function renderLegend() {
		const el = $<HTMLElement>(".legend");
		const hs = HAZARDS.filter(h => hzOn.has(h.id));
		el.hidden = !hs.length; $<HTMLElement>(".hzop-w").hidden = !hs.length;
		// 浸水深の凡例は洪水・高潮・津波で同じ＝1 回だけ出す
		const seen = new Set<string>();
		el.innerHTML = hs.map(h => { const k = h.legend.map(l => l.label).join(); if (seen.has(k)) return ""; seen.add(k);
			return `<div class="lg"><small>${esc(h.id === "dosha" ? "土砂災害" : "浸水の深さ")}</small>${h.legend.map(l => `<span><i style="background:${l.color}"></i>${esc(l.label)}</span>`).join("")}</div>`; }).join("");
	}
	$$("[data-hz]").forEach(inp => inp.onchange = () => setHazard(inp.dataset.hz!, inp.checked));
	$(".hzop").oninput = () => { hzOpacity = +$(".hzop").value; for (const id of hzOn) for (const rid of hzIds(id)) map.raster.set(rid, { opacity: hzOpacity }); };

	// ── 防災：指定緊急避難場所（点の層・押すと詳細と標高）──
	let shelters: HinanRow[] | null = null, hinanOn = false;
	const hnFilter = () => { const f = +$<HTMLSelectElement>(".hnf").value; return f < 0 ? ["==", 1, 1] : ["==", ["get", `f${f}`], 1]; };
	async function setHinan(on: boolean) {
		hinanOn = on; $(".hinan").checked = on;
		if (!on) { if (shelters) map.setLayoutProperty("yk-hinan", "visibility", "none"); $<HTMLElement>(".detail").hidden = true; return; }
		if (!shelters) {
			$<HTMLElement>(".hn-n").textContent = "読み込み中…";
			try {
				const r = await fetch(HINAN_URL, { credentials: "omit" });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				shelters = yokohamaShelters(JSON.parse(new TextDecoder().decode(await gunzip(await r.arrayBuffer()))));
			} catch (e) { console.warn("[yokohama] hinan", e); $<HTMLElement>(".hn-n").textContent = "読めませんでした"; hinanOn = false; $(".hinan").checked = false; return; }
			const feats: GeoJSONFeature[] = shelters.map((r, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r[0], r[1]] },
				properties: { i, ...Object.fromEntries(HINAN_FLAGS.map((_, b) => [`f${b}`, r[4] & (1 << b) ? 1 : 0])) } }));
			map.addSource("yk-hinan", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
			await map.addLayer({ id: "yk-hinan", type: "circle", source: "yk-hinan", filter: hnFilter(),
				paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 5, 18, 8], "circle-color": "#1f9d55", "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } });
			const tip = map.gadget.tip();
			const top = (e: LayerMouseEvent) => (e.features || []).find(f => f.properties?.i != null);
			map.on("mousemove", "yk-hinan", e => { const f = top(e), r = f && shelters![f.properties.i]; tip(r ? [`<b>${esc(r[2])}</b>`, esc(flagsOf(r[4]).join("・") || "対応災害の記載なし")] : null); });
			map.on("mouseleave", "yk-hinan", () => tip(null));
			map.on("click", "yk-hinan", e => { const f = top(e); if (f) showShelter(shelters![f.properties.i]); });
		}
		map.setLayoutProperty("yk-hinan", "visibility", "visible");
		countShelters();
	}
	function countShelters() {
		if (!shelters) return;
		const f = +$<HTMLSelectElement>(".hnf").value;
		$<HTMLElement>(".hn-n").textContent = `${shelters.filter(r => f < 0 || r[4] & (1 << f)).length.toLocaleString("ja")} か所`;
	}
	async function showShelter(r: HinanRow) {
		const el = $<HTMLElement>(".detail");
		el.hidden = false;
		el.innerHTML = `<div class="dh"><b>${esc(r[2])}</b><button class="x" type="button" aria-label="閉じる">×</button></div>
			<p>${esc(r[3])}</p>
			<div class="badges">${flagsOf(r[4]).map(f => `<span>${esc(f)}</span>`).join("") || "<small>対応災害の記載なし</small>"}</div>
			<p class="elev">標高 …</p>`;
		el.querySelector<HTMLButtonElement>(".x")!.onclick = () => { el.hidden = true; };
		const h = await map.getHeight(r[0], r[1]).catch(() => NaN);   // 標高＝高台へ逃げるか（水平避難）の読みどころ
		const ev = el.querySelector(".elev");
		if (ev?.isConnected) ev.textContent = Number.isFinite(h) ? `標高 約 ${Math.round(h)} m` : "";
	}
	$(".hinan").onchange = () => setHinan($(".hinan").checked);
	$<HTMLSelectElement>(".hnf").onchange = () => { if (shelters) map.setFilter("yk-hinan", hnFilter()); countShelters(); };

	// ── 時間：年代の航空写真 ──
	async function setEra(id: string) {
		const e = ERAS.find(x => x.id === id) || ERAS[0];
		st.era = e.id; save();
		$$<HTMLInputElement>('input[name="yk-era"]').forEach(r => { r.checked = r.value === e.id; });
		if (!e.url) { map.raster.remove("yk-era"); return; }
		await map.raster.add("yk-era", { url: e.url, minZoom: e.minZoom, maxZoom: e.maxZoom, bbox: e.id === "now" ? JAPAN_BBOX : ERA_BBOX, attribution: PHOTO_ATTR, name: `航空写真 ${e.name}` }, { order: "under" })
			.catch(err => console.warn("[yokohama] era", id, err));
	}
	$$<HTMLInputElement>('input[name="yk-era"]').forEach(r => r.onchange = () => setEra(r.value));

	// ── 時間：影（WebGPU）と日影図 ──
	if (gpu) {
		const day = $(".sday"), hour = $(".shour"), out = $<HTMLOutputElement>(".shour-o");
		day.value = todayJST();
		const apply = () => {
			const h = +hour.value; out.textContent = `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
			map.setShadows($(".shadow").checked ? { on: true, time: jst(day.value || todayJST(), h) } : false);
		};
		$(".shadow").onchange = apply; hour.oninput = apply; day.onchange = apply;
		apply();
	}
	const sunMsg = $<HTMLElement>(".sunmsg");
	$(".sunmap").onclick = async () => {
		if (map.getZoom() < 14.5) { sunMsg.textContent = "街区まで寄ってから（ズーム 14.5 以上）押してください。"; return; }
		sunMsg.textContent = "計算中…";
		try {
			const r = await map.sunShadow({ mode: "duration" });
			sunMsg.textContent = `建物 ${r.triangles.toLocaleString("ja")} 面から計算。濃いほど長く日影になる所（最長 ${r.maxHours.toFixed(1)} 時間）。`;
			$<HTMLElement>(".sunclear").hidden = false;
		} catch (e) { sunMsg.textContent = "計算できませんでした。"; console.warn("[yokohama] sunShadow", e); }
	};
	$(".sunclear").onclick = () => { map.raster.remove("sunshadow"); $<HTMLElement>(".sunclear").hidden = true; sunMsg.textContent = ""; };

	// ── 解析 ──
	const toolMsg = $<HTMLElement>(".toolmsg");
	const center = (): LonLat => { const c = map.getCenter(); return [c.lng, c.lat]; };
	$(".vs").onclick = async () => {
		toolMsg.textContent = "可視域を計算中…";
		try {
			const r = await map.viewshed({ observer: center(), radius: 1000, eyeH: 1.6 });
			toolMsg.textContent = `緑が見える所（半径 1km の ${Math.round(r.visibleRatio * 100)}%）。建物と地形で隠れる所は色が付きません。`;
			$<HTMLElement>(".vsclear").hidden = false;
		} catch (e) { toolMsg.textContent = "計算できませんでした。"; console.warn("[yokohama] viewshed", e); }
	};
	$(".vsclear").onclick = async () => { await map.clearViewshed(); $<HTMLElement>(".vsclear").hidden = true; toolMsg.textContent = ""; };
	if (gpu) {
		let clipped = false;
		$(".clip").onclick = () => {
			clipped = !clipped;
			map.setClipping(clipped ? { box: { center: center(), size: [500, 500] } } : false);
			$(".clip").textContent = clipped ? "切り取りをやめる" : "切り取る（500m 四方）";
		};
	}
	let walker: WalkHandle | null = null;
	$(".walk").onclick = () => { walker ??= map.walk(); if (map.getZoom() < 15) toolMsg.textContent = "寄ってから歩くと街並みが見えます。"; walker.start(); };
	const measure = map.gadget.measure(), profile = map.gadget.profile();
	$(".measure").onclick = () => { measure.open?.(); };
	$(".profile").onclick = () => { profile.open?.(); };

	// ── 起動時の状態（URL）──
	setTab(st.tab);
	if (st.ward) wardSel.value = st.ward;
	const s0 = SPOTS.find(s => s.id === st.spot);
	if (s0) { showSpot(s0); if (!location.hash) flySpot(s0); }
	else if (st.ward && !location.hash) wardSel.onchange?.(new Event("change"));
	for (const id of st.hz) setHazard(id, true);
	setEra(st.era);

	return { state: st, setTab, setHazard, setHinan, setEra, tour, stopTour, get shelters() { return shelters; } };
}

// ── 意匠（quiet-mono のトークン＝#map の変数・choju の案内板と同じ黒地白文字）──
const CSS = `
.yk-panel{--qm-ink:#fff;--qm-text:#f1f3f6;--qm-text-dim:rgba(255,255,255,.72);--qm-text-faint:rgba(255,255,255,.5);--qm-border-soft:rgba(255,255,255,.22);color-scheme:dark}
.yk-panel{position:absolute;top:12px;right:12px;z-index:30;width:320px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;box-sizing:border-box;
	padding:14px 14px 12px;border-radius:var(--qm-r-l);background:rgba(8,14,26,.9);border:1px solid var(--qm-border-soft);box-shadow:var(--qm-shadow-pop);
	backdrop-filter:blur(var(--qm-blur));-webkit-backdrop-filter:blur(var(--qm-blur));color:var(--qm-text);font:13px/1.45 var(--qm-font)}
.yk-panel .head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.yk-panel .ttl{flex:1;min-width:0}
.yk-panel h1{font-size:17px;margin:0;font-weight:700;color:var(--qm-ink);letter-spacing:.02em}
.yk-panel .ttl p{margin:2px 0 0;color:var(--qm-text-dim);font-size:12px}
.yk-panel .fold,.yk-panel .x{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);font-size:14px;line-height:1;cursor:pointer}
.yk-panel.min .body{display:none}
.yk-panel .tour{width:100%;margin:12px 0 10px;padding:9px 10px;border:0;border-radius:var(--qm-r-m);background:linear-gradient(90deg,#1565c0,#0d8bb0);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.yk-panel .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:8px}
.yk-panel .tabs button{font:inherit;padding:6px 0;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text-dim);cursor:pointer}
.yk-panel .tabs button[aria-selected=true]{background:#fff;color:#0b1220;border-color:#fff;font-weight:700}
.yk-panel h2{font-size:12px;margin:12px 0 4px;color:var(--qm-text-dim);font-weight:600}
.yk-panel .msel{display:flex;flex-direction:column;gap:3px;margin-top:8px;font-size:12px;color:var(--qm-text-dim)}
.yk-panel select,.yk-panel input[type=date]{font:inherit;font-size:12.5px;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:#1b1f26;color:var(--qm-text);padding:5px 6px;min-width:0}
.yk-panel input[type=range]{width:100%;accent-color:#4fc3f7}
.yk-panel .spots{display:flex;flex-wrap:wrap;gap:5px}
.yk-panel .spots button{font:inherit;font-size:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--qm-border-soft);background:transparent;color:var(--qm-text);cursor:pointer}
.yk-panel .spots button.on{background:#4fc3f7;border-color:#4fc3f7;color:#06121f}
.yk-panel .spot-note{margin-top:8px;padding:8px 10px;border-radius:var(--qm-r-m);background:rgba(255,255,255,.06);border:1px solid var(--qm-border-soft)}
.yk-panel .spot-note b{color:var(--qm-ink);font-size:14px}
.yk-panel .spot-note span{margin-left:8px;color:var(--qm-text-faint);font-size:12px}
.yk-panel .spot-note p{margin:4px 0 0;color:var(--qm-text-dim)}
.yk-panel .grp{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
.yk-panel .grp b{font-weight:600;color:var(--qm-ink)}
.yk-panel .grp small{margin-left:auto;color:var(--qm-text-faint);font-variant-numeric:tabular-nums}
.yk-panel .sub{margin:0 0 4px 24px;color:var(--qm-text-dim);font-size:12px}
.yk-panel .sub.flat{margin-left:0}
.yk-panel [hidden]{display:none!important}
.yk-panel .legend{margin-top:8px}
.yk-panel .lg{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:4px;font-size:11.5px;color:var(--qm-text-dim)}
.yk-panel .lg small{width:100%;color:var(--qm-text-faint)}
.yk-panel .lg i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:4px;vertical-align:-2px}
.yk-panel .dates{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0 6px}
.yk-panel .dates label{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--qm-text-dim)}
.yk-panel .act{display:block;width:100%;margin:5px 0 0;padding:7px 10px;text-align:left;font:inherit;border-radius:var(--qm-r-m);border:1px solid var(--qm-border-soft);background:rgba(255,255,255,.05);color:var(--qm-text);cursor:pointer}
.yk-panel .act:hover,.yk-panel .spots button:hover,.yk-panel .tabs button:hover{border-color:rgba(255,255,255,.5)}
.yk-panel .detail{margin:8px 0 2px;padding:10px;border-radius:var(--qm-r-m);background:rgba(255,255,255,.06);border:1px solid var(--qm-border-soft)}
.yk-panel .detail .dh{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}
.yk-panel .detail .dh b{color:var(--qm-ink);font-size:14px}
.yk-panel .detail p{margin:4px 0;color:var(--qm-text-dim)}
.yk-panel .badges{display:flex;flex-wrap:wrap;gap:4px}
.yk-panel .badges span{border:1px solid rgba(143,211,154,.6);color:#bfe8c6;border-radius:4px;padding:0 5px;font-size:11.5px}
.yk-panel .note{color:var(--qm-text-dim);font-size:12px;margin:10px 0 0}
.yk-panel .attr{color:var(--qm-text-faint);font-size:11px;margin:12px 0 0}
.yk-cap{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:31;width:min(560px,calc(100% - 24px));box-sizing:border-box;padding:12px 44px 12px 16px;
	border-radius:var(--qm-r-l);background:rgba(8,14,26,.88);color:#f1f3f6;font:13px/1.5 var(--qm-font);box-shadow:var(--qm-shadow-pop);backdrop-filter:blur(var(--qm-blur));-webkit-backdrop-filter:blur(var(--qm-blur))}
.yk-cap small{display:block;color:rgba(255,255,255,.55);font-size:11.5px}
.yk-cap b{font-size:18px;color:#fff}
.yk-cap p{margin:3px 0 0;color:rgba(255,255,255,.8)}
.yk-cap .x{position:absolute;top:10px;right:10px;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.25);background:transparent;color:rgba(255,255,255,.75);cursor:pointer}
@media (max-width:720px){ .yk-panel{top:auto;bottom:36px;left:12px;right:12px;width:auto;max-height:48vh} .yk-cap{bottom:auto;top:12px} }`;
