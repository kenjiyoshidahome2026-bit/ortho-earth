// 範囲を選んで端末に保存する画面（M3）。地球儀の上に Equal Earth（packages/equal の createEqual）を重ね、z8 に揃った四角を描く。
// 入口は 2 つ：「現在地周辺を保存」（本人 2026-11-14「現在地周辺は絶対入れて」＝GPS の点を中心に 3×3 を最初から置く）と「地図で選ぶ」（今の視点の中心に置く）。
// 位置が取れない時（許可なし・屋内）は IP で推さない＝「地図をタップして置く」へ。
// 操作：四角の中をドラッグ＝動かす・角と辺の丸（指で 44px）＝大きさ・四角の外をタップ＝そこへ置き直す・地図のドラッグ／ピンチ＝そのまま Equal Earth が動く。
// 見積もり：planet と GEL の索引（根＋要る葉だけ）を Range で読んで正確なバイト数を足す（core planExtract）＝端末の空きと並べる。1 範囲 1 GB を越える時は地図の上限ズームを下げる。
// 保存は worker（save-worker.ts）＝閉じても覚え（.json）が残り、次に開いた時に続きから。
import { kOfLat, yOfLat, pxPerUnit, unproject } from "@ortho-earth/equal/equalearth";
import { openExtractSource, planExtract, idRanges, worldRanges, splitZ8Rect, z8Around, z8Bbox, RECT_ZOOM } from "@ortho-earth/core/pmtiles-extract";
import type { ExtractPlan, ExtractSource, Z8Rect } from "@ortho-earth/core/pmtiles-extract";
import { requestPersist, storageInfo } from "@ortho-earth/core/opfs-store";
import { AREA_CAP, MAP_ZOOM, MAX_SIDE, TERRAIN_ZOOM, WORLD_ZOOM, GEL_MIN, areaId, areaKm, fitZoom, human, jobsFor } from "./area-jobs.ts";
import type { AreaSources } from "./area-jobs.ts";
import { runSave } from "./save-run.ts";

const N8 = 2 ** RECT_ZOOM;
const wrapX = (x: number) => ((x % N8) + N8) % N8;
const widthOf = (r: Z8Rect) => wrapX(r.x1 - r.x0) + 1;
const tileX = (lon: number) => (lon + 180) / 360 * N8;
const tileY = (lat: number) => { const r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N8; };

export interface PickerOptions {
	/** 重ねる先（地球儀の mapEl） */
	host: HTMLElement;
	/** 切り出しの元（オンライン）。osm が無い＝保存できない */
	sources: AreaSources | null;
	/** 地球儀の今の視点 */
	view: () => { lon: number; lat: number; zoom: number };
	/** 端末に既にある範囲（ヘッダの箱 [w,s,e,n]）＝薄く塗る */
	saved: [number, number, number, number][];
	/** 世界の土台が端末に無い＝最初の保存に足す */
	needWorld: boolean;
	/** UI と地名の言語 */
	lang: string;
}

/** 位置（[lon, lat]）。許可なし・失敗・10 秒で null */
export function locate(): Promise<[number, number] | null> {
	return new Promise(res => {
		if (!navigator.geolocation) return res(null);
		navigator.geolocation.getCurrentPosition(p => res([p.coords.longitude, p.coords.latitude]), () => res(null), { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 });
	});
}

/** 保存が終わって読み直した後に「保存しました」を出す印（sessionStorage・値＝書いたファイルの数） */
export const SAVED_KEY = "unmap.saved";

let open = false;
/** 開く。start＝"here"（現在地周辺）か "view"（今の視点の中心） */
export async function openAreaPicker(o: PickerOptions, start: "here" | "view"): Promise<void> {
	if (open) return; open = true;
	const box = document.createElement("div");
	box.className = "area-picker";
	o.host.append(box);
	for (const ev of ["contextmenu", "dragenter", "dragover", "dragleave", "drop"]) box.addEventListener(ev, e => e.stopPropagation());
	const sheet = document.createElement("div");
	sheet.className = "ap-sheet";
	sheet.innerHTML = `<div class="ap-msg" role="status"></div>
		<div class="ap-row"><span class="ap-k">Area</span><button type="button" data-n="1">1×1</button><button type="button" data-n="3">3×3</button><button type="button" data-n="5">5×5</button><span class="ap-km"></span></div>
		<div class="ap-row"><label><span class="ap-k">Map detail</span> <select class="ap-mz"></select></label> <label><span class="ap-k">Terrain</span> <select class="ap-tz"></select></label></div>
		<div class="ap-est"></div>
		<progress class="ap-prog" max="1" value="0" hidden></progress>
		<div class="ap-row ap-act"><button type="button" class="ap-save">Save this area</button><button type="button" class="ap-here">📍 My location</button><button type="button" class="ap-close">Close</button></div>`;
	const $ = <T extends HTMLElement>(s: string) => sheet.querySelector(s) as T;
	const msg = $(".ap-msg"), est = $(".ap-est"), km = $(".ap-km"), mzSel = $<HTMLSelectElement>(".ap-mz"), tzSel = $<HTMLSelectElement>(".ap-tz"), saveBtn = $<HTMLButtonElement>(".ap-save"), prog = $<HTMLProgressElement>(".ap-prog");
	mzSel.innerHTML = [10, 11, 12, 13, 14, 15].map(z => `<option value="${z}"${z === MAP_ZOOM ? " selected" : ""}>up to z${z}</option>`).join("");
	tzSel.innerHTML = `<option value="">off</option>` + [8, 9, 10, 11, 12].map(z => `<option value="${z}"${z === TERRAIN_ZOOM ? " selected" : ""}>up to z${z}</option>`).join("");
	if (!o.sources?.gel) { tzSel.value = ""; tzSel.disabled = true; }

	// ── 状態 ──
	let rect: Z8Rect | null = null, side = 3, saving = false, closed = false;
	const life = new AbortController(), signal = life.signal;   // 頁（window）に付けた聞き手＝閉じたら外す
	const g0 = o.view();
	let loc: [number, number] | null = null;
	// ── Equal Earth ──
	const { createEqual } = await import("@ortho-earth/equal");
	const eqBox = document.createElement("div"); eqBox.className = "ap-eq"; box.append(eqBox);
	const app = await createEqual({ target: eqBox, params: new URLSearchParams({ embed: "1", lang: o.lang }), view: `#${Math.min(8, Math.max(1, g0.zoom)).toFixed(2)}/${g0.lat.toFixed(5)}/${g0.lon.toFixed(5)}`, hash: false, keyboard: false, geopbf: false });
	const cv = document.createElement("canvas"); cv.className = "ap-draw"; eqBox.append(cv);
	box.append(sheet);
	const ctx = cv.getContext("2d")!;
	app.on("closed", () => close());   // Equal Earth の「地球儀」＝閉じる

	const size = (): [number, number] => [eqBox.clientWidth, eqBox.clientHeight];
	const project = (lon: number, lat: number): [number, number, number] => {
		const v = app.view, [W, H] = size(), s = pxPerUnit(v.zoom); let d = lon - v.lon; d = ((d + 180) % 360 + 360) % 360 - 180;
		return [W / 2 + d * Math.PI / 180 * kOfLat(lat) * s, H / 2 - (yOfLat(lat) - yOfLat(v.lat)) * s, Math.abs(d) > 179.5 ? -1 : 1];
	};
	const llAt = (cx: number, cy: number): [number, number] | null => { const r = eqBox.getBoundingClientRect(); return unproject(app.view, cx - r.left - r.width / 2, cy - r.top - r.height / 2); };
	const fitView = (r: Z8Rect) => {   // 四角が画面の 6 割ほどに収まる視点
		const [w, s, , n] = z8Bbox(r), lon = w + widthOf(r) * 360 / N8 / 2, [W, H] = size();
		const z = RECT_ZOOM - Math.log2(Math.max(widthOf(r), r.y1 - r.y0 + 1) * 256 / (0.6 * Math.min(W, H - 160)));
		app.setView({ lon: ((lon + 540) % 360) - 180, lat: (s + n) / 2, zoom: Math.max(1, Math.min(8, z)) });
	};
	const place = (lon: number, lat: number, n = side) => { rect = z8Around(lon, lat, n); changed(); };

	// ── 描く（毎フレーム・変わった時だけ） ──
	let drawKey = "";
	const outline = (w: number, s: number, dlon: number, n: number): [number, number][][] => {   // 経緯度の箱の輪郭を画面の折れ線へ（裏の経線で切る）
		const pts: [number, number][] = [], K = 24;
		for (let i = 0; i <= K; i++) pts.push([w + dlon * i / K, n]);
		for (let i = 0; i <= K; i++) pts.push([w + dlon, n - (n - s) * i / K]);
		for (let i = 0; i <= K; i++) pts.push([w + dlon * (1 - i / K), s]);
		for (let i = 0; i <= K; i++) pts.push([w, s + (n - s) * i / K]);
		const out: [number, number][][] = []; let cur: [number, number][] = [];
		for (const [lon, lat] of pts) { const [x, y, f] = project(lon, lat); if (f < 0 || (cur.length && Math.abs(x - cur[cur.length - 1][0]) > size()[0] / 2)) { if (cur.length > 1) out.push(cur); cur = []; if (f < 0) continue; } cur.push([x, y]); }
		if (cur.length > 1) out.push(cur);
		return out;
	};
	const handles = (): { id: string; x: number; y: number }[] => {
		if (!rect) return [];
		const [w, s, , n] = z8Bbox(rect), dl = widthOf(rect) * 360 / N8, m = (s + n) / 2, lm = w + dl / 2, e = w + dl;
		return ([["nw", w, n], ["n", lm, n], ["ne", e, n], ["e", e, m], ["se", e, s], ["s", lm, s], ["sw", w, s], ["w", w, m]] as [string, number, number][])
			.map(([id, lon, lat]) => { const [x, y, f] = project(lon, lat); return { id, x, y, f }; }).filter(h => h.f > 0);
	};
	function draw(): void {
		if (closed) return;
		requestAnimationFrame(draw);
		const [W, H] = size(), dpr = Math.min(devicePixelRatio || 1, 2), v = app.view;
		const key = `${v.lon},${v.lat},${v.zoom},${W},${H},${JSON.stringify(rect)}`;
		if (key === drawKey) return; drawKey = key;
		if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
		const poly = (w: number, s: number, dlon: number, n: number, fill: string, stroke: string, lw: number) => {
			for (const line of outline(w, s, dlon, n)) {
				ctx.beginPath(); line.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
				if (fill) { ctx.fillStyle = fill; ctx.fill(); }
				ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
			}
		};
		for (const [w, s, e, n] of o.saved) poly(w, s, ((e - w) % 360 + 360) % 360 || 360, n, "rgba(46,160,90,.18)", "rgba(46,160,90,.8)", 1);   // 端末にある範囲
		if (rect) {
			const [w, s, , n] = z8Bbox(rect);
			poly(w, s, widthOf(rect) * 360 / N8, n, "rgba(31,120,220,.14)", "#1f78dc", 2);
			for (const h of handles()) { ctx.beginPath(); ctx.arc(h.x, h.y, 8, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#1f78dc"; ctx.lineWidth = 2; ctx.stroke(); }
		}
	}
	requestAnimationFrame(draw);

	// ── 指 ──
	type Drag = { kind: "move"; tx: number; ty: number; r: Z8Rect } | { kind: "edge"; id: string; r: Z8Rect };
	let drag: Drag | null = null, tap: [number, number, number] | null = null;
	const insideRect = (lon: number, lat: number) => { if (!rect) return false; const tx = Math.floor(tileX(lon)), ty = Math.floor(tileY(lat)); return wrapX(tx - rect.x0) < widthOf(rect) && ty >= rect.y0 && ty <= rect.y1; };
	box.addEventListener("pointerdown", e => {
		if (saving || !(e.target as HTMLElement).closest(".ap-eq") || (e.target as HTMLElement).closest("button, select, input, a, #gadgets, #dock")) return;
		tap = e.isPrimary ? [e.clientX, e.clientY, performance.now()] : null;
		if (!rect || !e.isPrimary) return;
		const r = eqBox.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
		const h = handles().map(h => ({ h, d: Math.hypot(h.x - x, h.y - y) })).sort((a, b) => a.d - b.d)[0];
		const ll = llAt(e.clientX, e.clientY);
		if (h && h.d <= 22) drag = { kind: "edge", id: h.h.id, r: { ...rect } };
		else if (ll && insideRect(ll[0], ll[1])) drag = { kind: "move", tx: Math.floor(tileX(ll[0])), ty: Math.floor(tileY(ll[1])), r: { ...rect } };
		if (drag) { e.stopPropagation(); e.preventDefault(); tap = null; }   // 四角を掴んだ＝地図は動かさない
	}, { capture: true });
	addEventListener("pointermove", e => {
		if (!drag) return;
		const ll = llAt(e.clientX, e.clientY); if (!ll) return;
		const tx = Math.floor(tileX(ll[0])), ty = Math.max(0, Math.min(N8 - 1, Math.floor(tileY(ll[1]))));
		const r = drag.r;
		if (drag.kind === "move") {
			const dx = ((tx - drag.tx + N8 / 2) % N8 + N8) % N8 - N8 / 2, h = r.y1 - r.y0;
			const y0 = Math.max(0, Math.min(N8 - 1 - h, r.y0 + ty - drag.ty));
			rect = { x0: wrapX(r.x0 + dx), x1: wrapX(r.x1 + dx), y0, y1: y0 + h };
		} else {
			const n: Z8Rect = { ...r }, id = drag.id;
			const span = (a: number, b: number) => wrapX(b - a) + 1;   // a から東へ b まで
			if (id.includes("w")) { let w = span(tx, r.x1); if (w > N8 / 2) w = 1; n.x0 = wrapX(r.x1 - Math.min(w, MAX_SIDE) + 1); }
			if (id.includes("e")) { let w = span(r.x0, tx); if (w > N8 / 2) w = 1; n.x1 = wrapX(r.x0 + Math.min(w, MAX_SIDE) - 1); }
			if (id.includes("n")) n.y0 = Math.max(r.y1 - MAX_SIDE + 1, Math.min(r.y1, ty));
			if (id.includes("s")) n.y1 = Math.min(r.y0 + MAX_SIDE - 1, Math.max(r.y0, ty));
			rect = n;
		}
		e.preventDefault();
	}, { capture: true, signal });
	const up = (e: PointerEvent) => {
		if (drag) { drag = null; changed(); return; }
		const t = tap; tap = null;
		if (!t || saving || e.pointerType === "mouse" && e.button !== 0) return;
		if (Math.hypot(e.clientX - t[0], e.clientY - t[1]) > 8 || performance.now() - t[2] > 450) return;   // ドラッグ・長押しは地図の物
		if (!(e.target as HTMLElement).closest?.(".ap-eq canvas")) return;
		const ll = llAt(e.clientX, e.clientY); if (!ll || insideRect(ll[0], ll[1])) return;
		place(ll[0], ll[1], rect ? Math.max(widthOf(rect), rect.y1 - rect.y0 + 1) : side); say("");
		if (Math.max(widthOf(rect!), rect!.y1 - rect!.y0 + 1) * 256 * 2 ** (app.view.zoom - RECT_ZOOM) < 120) fitView(rect!);   // 小さすぎて角を掴めない＝寄る
	};
	addEventListener("pointerup", up, { capture: true, signal });
	addEventListener("pointercancel", () => { drag = null; tap = null; }, { capture: true, signal });

	// ── 見積もり ──
	const sources = new Map<string, Promise<ExtractSource>>(), caches = new Map<string, Map<number, import("@ortho-earth/core/pmtiles-extract").PMEntry[]>>();
	const srcOf = (url: string) => { let p = sources.get(url); if (!p) { p = openExtractSource(url); p.catch(() => sources.delete(url)); sources.set(url, p); } return p; };
	const planOf = async (url: string, r: Z8Rect, minZoom: number, maxZoom: number, signal: AbortSignal): Promise<ExtractPlan> => {
		const cache = caches.get(url) ?? new Map(); caches.set(url, cache);
		return planExtract(await srcOf(url), idRanges(r, minZoom, maxZoom), { minZoom, maxZoom, bbox: z8Bbox(r), cache, signal });
	};
	let worldBytes: Promise<number> | null = null;
	let estAc: AbortController | null = null, estT = 0, chosenMapZoom = MAP_ZOOM, ready = false;
	function changed(): void {
		if (!rect) { km.textContent = ""; est.textContent = ""; saveBtn.disabled = true; return; }
		const [a, b] = areaKm(rect); km.textContent = `≈ ${Math.round(a)} × ${Math.round(b)} km`;
		sheet.querySelectorAll<HTMLButtonElement>("[data-n]").forEach(btn => btn.classList.toggle("on", +btn.dataset.n! === widthOf(rect!) && +btn.dataset.n! === rect!.y1 - rect!.y0 + 1));
		ready = false; saveBtn.disabled = true;
		if (!o.sources) { est.textContent = "Saving needs the online map sources (open without ?online=0)."; return; }
		est.textContent = "Estimating size…";
		clearTimeout(estT); estAc?.abort();
		estT = window.setTimeout(estimate, 350);
	}
	async function estimate(): Promise<void> {
		if (!rect || !o.sources) return;
		const ac = estAc = new AbortController(), r = rect, want = +mzSel.value, tz = tzSel.value ? +tzSel.value : null;
		try {
			const parts = splitZ8Rect(r);
			const maps = await Promise.all(parts.map(p => planOf(o.sources!.osm, p, 0, want, ac.signal)));
			const terr = tz != null && o.sources.gel ? await Promise.all(parts.map(p => planOf(o.sources!.gel!, p, GEL_MIN, tz, ac.signal))) : [];
			const tb = terr.reduce((s, p) => s + p.bytes, 0);
			const [mz, mb] = fitZoom(maps, want, AREA_CAP - tb);
			if (o.needWorld) worldBytes ??= srcOf(o.sources.osm).then(s => planExtract(s, worldRanges(0, WORLD_ZOOM), { minZoom: 0, maxZoom: WORLD_ZOOM, bbox: [-180, -85, 180, 85] })).then(p => p.bytes);
			const wb = o.needWorld ? await worldBytes!.catch(() => 0) : 0;
			const st = await storageInfo(), free = st.quota != null && st.usage != null ? st.quota - st.usage : null, total = mb + tb + wb;
			if (ac.signal.aborted) return;
			chosenMapZoom = mz;
			const lines = [`Map ${human(mb)}${mz < want ? ` (detail lowered to z${mz} to stay under ${human(AREA_CAP)})` : ""}`];
			if (tz != null) lines.push(`terrain ${human(tb)}`);
			if (wb) lines.push(`world overview ${human(wb)} (once)`);
			const fits = free == null || total < free * 0.9;
			est.innerHTML = `${lines.join(" · ")}<br><b>Total ${human(total)}</b> · free on this device ${human(free)}${fits ? "" : ` · <b class="ng">not enough space</b>`}`;
			ready = fits; saveBtn.disabled = !fits;
		} catch (e) {
			if (ac.signal.aborted) return;
			est.textContent = `Could not read the map sources: ${(e as Error).message}`;
		}
	}
	mzSel.addEventListener("change", changed); tzSel.addEventListener("change", changed);
	sheet.querySelectorAll<HTMLButtonElement>("[data-n]").forEach(b => b.addEventListener("click", () => {
		side = +b.dataset.n!;
		const [w, s, , n] = rect ? z8Bbox(rect) : [g0.lon, g0.lat, 0, g0.lat];
		place(rect ? w + widthOf(rect) * 360 / N8 / 2 : w, (s + n) / 2, side); if (rect) fitView(rect);
	}));

	// ── 保存 ──
	saveBtn.addEventListener("click", async () => {
		if (!rect || !o.sources || !ready || saving) return;
		saving = true; void requestPersist();   // 押した時＝利用者の操作の内（Safari は操作の内でないと持続保存を断る）
		const id = areaId(), tz = tzSel.value ? +tzSel.value : null;
		const jobs = jobsFor({ rect, mapZoom: chosenMapZoom, terrainZoom: tz, world: o.needWorld }, o.sources, id);
		saveBtn.disabled = true; prog.hidden = false; mzSel.disabled = tzSel.disabled = true;
		const closeBtn = $<HTMLButtonElement>(".ap-close"); closeBtn.textContent = "Stop";
		const [w, s, , n] = z8Bbox(rect), center = `#9/${((s + n) / 2).toFixed(4)}/${(((w + widthOf(rect) * 360 / N8 / 2) + 540) % 360 - 180).toFixed(4)}`;
		const res = await runSave(jobs, p => {
			if (p.phase === "index") { say(`Indexing place names (${p.index + 1}/${p.count})…`); prog.value = p.total ? p.bytes / p.total : 0; return; }
			const what = p.name === "world" ? "world overview" : p.dir.endsWith("terrain") ? "terrain" : "map";
			say(p.phase === "plan" ? `Reading the index for the ${what} (${p.index + 1}/${p.count})…` : `Saving ${what} (${p.index + 1}/${p.count}) · ${human(p.bytes)} of ${human(p.total)}`);
			prog.value = p.total ? (p.index + p.bytes / p.total) / p.count : p.index / p.count;
		}, stop => { closeBtn.onclick = () => { stop(); }; });
		if (res.ok) { say("Saved. Opening the area…"); try { sessionStorage.setItem(SAVED_KEY, String(jobs.length)); } catch { /* 札が出ないだけ */ } location.hash = center; location.reload(); return; }
		saving = false; closeBtn.textContent = "Close"; closeBtn.onclick = null; prog.hidden = true; mzSel.disabled = false; tzSel.disabled = !o.sources.gel;
		say(res.cancelled ? "Stopped. You can resume it later from the Data card." : `Saving failed: ${res.message}. Try again — it continues where it stopped.`);
		changed();
	});
	function say(t: string): void { msg.textContent = t; msg.hidden = !t; }
	$(".ap-close").addEventListener("click", () => { if (!saving) close(); });
	$(".ap-here").addEventListener("click", () => goHere());
	function close(): void {
		if (closed) return; closed = true; open = false; estAc?.abort();
		life.abort();
		box.style.opacity = "0";
		setTimeout(() => { try { app.destroy(); } catch { /* 済み */ } box.remove(); }, 250);
	}
	async function goHere(): Promise<void> {
		say("Finding your location…");
		loc = await locate();
		if (closed) return;
		if (loc) { say(""); place(loc[0], loc[1], side); fitView(rect!); }
		else { say("Couldn't get your location. Tap the map where you want to save."); if (!rect) changed(); }
	}

	// ── 始め ──
	say("");
	if (start === "here") await goHere();
	else { place(g0.lon, g0.lat, side); fitView(rect!); }
	requestAnimationFrame(() => box.classList.add("on"));
}
