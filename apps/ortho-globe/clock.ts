// 世界時計（/globe/clock・clock.html から遅延 import）＝地球儀の上で「その場所がいま何時か」を見せる部品（issue #309）。
// 骨格：器＝clock.html（URL を読んで置くだけ）／ここ＝部品（mountClock(map, geopbf) → { destroy }）／時刻の芯＝clock-zones.ts（純な関数・tests/t-clock.mjs）。
//
// データ：
//   ・時間帯の面＝Natural Earth ne_10m_time_zones（naturalearth.s3.amazonaws.com は CORS 開放＝ブラウザが直に読む・bucket に置かない・geopbf が IDB に残す）
//   ・国＝Natural Earth admin0（地球儀が国境に使う物と同じ名前の GeoPBF＝bucket → 無ければ NE の生 zip）
//   ・国 → IANA の名前＝clock-zones.json（IANA zone.tab・scripts/clock-zones-build.mjs）
//   ・時刻・夏時間・時間帯の名前＝ブラウザの Intl（規則の表は同梱しない）
// 時刻の源＝地図の共通の時計（map.clock＝既定は実時間・URL の t= で決まった時刻・時計の操作盤で動かせる＝夜の側と同じ時刻）。
//
// 操作：
//   デスクトップ＝地図に乗せる → その時間帯の現在時刻（tip）。Shift を押している間 → その国の時間帯の一覧（複数ある国は全部）
//   どの端末も＝案内板の「時間帯 — 国」のスイッチ（Shift はその逆を一時的に）・クリック／タップ＝案内板に留める
// 光らせる単位＝NE の面 1 枚（形は一年中同じ・出る時刻だけが夏時間で変わる）／国の表示＝admin0 の国の輪郭。
import { tr, getLang } from "@ortho-earth/globe/i18n.js";   // UI 文言＝英語キー・26 言語。モジュール評価時に t() を呼ばない（辞書は startPage が足す）
import { createResolver, describe, groupZones, cityOf } from "./clock-zones.ts";
import { createPanel } from "common/panel";   // 案内パネルの枠（共有エンジンの入口）
import type { Described } from "./clock-zones.ts";
import ZONES from "./clock-zones.json";
import type { GlobeMap, GeoPBF, LonLat } from "@ortho-earth/globe";
type ZoneTable = Record<string, string[]>;   // 国 → 名前の列（"_" の注記の欄は引かない）
const t = tr();
type Geopbf = typeof import("@ortho-earth/globe").geopbf;
/** 点のある所（placeAt の戻り） */
interface Place { zf: number | null; cf: number | null; a3: string | null; iso2: string | null; zone: number | null; tz: string | null; country: string }
type Mode = "zone" | "country";


export const NE_TIME_ZONES = "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_time_zones.zip";
const A0_NAME = "ne_50m_admin_0_countries";
const A0_ZIP = `https://naturalearth.s3.amazonaws.com/50m_cultural/${A0_NAME}.zip`;
// NE の map_color8（1..8）＝隣の面が同じ色にならない塗り分け
const PALETTE = ["#e8c37a", "#9cc9a8", "#a9b9e6", "#e6a9a9", "#c9b0e0", "#9fd3d6", "#e3b98f", "#b9cf8a"];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

export async function mountClock(map: GlobeMap, geopbf: Geopbf, { tzSrc = NE_TIME_ZONES, panelHost }: { tzSrc?: string; panelHost?: HTMLElement | null } = {}) {
	document.title = t("World clock — ortho-globe");
	document.querySelector('meta[name="description"]')?.setAttribute("content", t("What time is it there? Hover over the globe to see the local time of every time zone, with daylight saving time — or hold Shift to see all the time zones of a country."));
	const mapEl = map.mapEl;
	const lang = getLang();
	const resolve = createResolver(ZONES as unknown as ZoneTable);
	const now = () => map.clock?.date ?? new Date();
	const coarse = matchMedia("(pointer: coarse)").matches;
	const hours = new Intl.NumberFormat(lang, { style: "unit", unit: "hour", unitDisplay: "short", maximumFractionDigits: 2 });

	// ── 案内板 ──
	// 枠（見出し・副題・折り畳み・PC は右上／スマホは下端のシート）＝共通の器 common/panel。ここは中身だけ
	const P = createPanel({ host: panelHost || mapEl, title: t("World clock"), cls: "clock-panel", foldMobile: false,   // 時計は畳まない＝「あなたの時刻」が主役
		labels: { fold: t("Collapse panel"), unfold: t("Expand panel") } });
	const panel = P.el;
	P.body.insertAdjacentHTML("beforebegin", `<style>
.clock-panel *{box-sizing:border-box}
.clock-panel .you{margin-top:8px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.clock-panel .you small{color:#9aa6bd;font-size:11px;letter-spacing:.08em;text-transform:uppercase;flex-basis:100%}
.clock-panel .big{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}
.clock-panel .muted{color:#9aa6bd}
.clock-panel .switch{display:flex;margin:10px 0 6px;border-radius:9px;border:1px solid rgba(255,255,255,.16);overflow:hidden}
.clock-panel .switch button{flex:1;border:0;background:rgba(255,255,255,.05);color:#cfd8e8;padding:6px 8px;font:inherit;cursor:pointer}
.clock-panel .switch button[aria-pressed="true"]{background:#f2c46d;color:#0b1021;font-weight:700}
.clock-panel .hint{color:#9aa6bd;font-size:11.5px}
.clock-panel .status{color:#9aa6bd;font-size:11.5px;margin-top:4px}
.clock-panel .status:empty{display:none}
.clock-panel .pin{margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:8px}
.clock-panel .pin:empty{display:none}
.clock-panel .note{margin-top:8px;color:#8793aa;font-size:10.5px;line-height:1.5}
.clock-tip .zt{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.clock-tip .row{display:flex;gap:8px;align-items:baseline;white-space:nowrap}
.clock-tip .row b{font-variant-numeric:tabular-nums;min-width:4.2em}
.clock-tip .dst{display:inline-block;border-radius:5px;background:#f2c46d;color:#0b1021;font-size:10.5px;font-weight:700;padding:0 5px;margin-inline-start:4px}
.clock-tip .c{color:#7c8698;font-size:11px}
@media (max-width:640px){.clock-panel .big{font-size:22px}.clock-panel .note{display:none}.clock-panel .switch{margin:8px 0 4px}}
</style>`);
	P.body.innerHTML = `
	<div class="you"><small>${t("Your time")}</small><span class="big" data-k="you"></span><span class="muted" data-k="youz"></span></div>
	<div class="switch" role="group" aria-label="${t("Show by")}"><button type="button" data-mode="zone" aria-pressed="true">${t("Time zones")}</button><button type="button" data-mode="country" aria-pressed="false">${t("Countries")}</button></div>
	<div class="hint">${coarse ? t("Tap the globe to see the time there.") : t("Hover over the globe to see the time there. Hold Shift to see a country's time zones. Click to pin.")}</div>
	<div class="status" data-k="status">${t("Loading…")}</div>
	<div class="pin clock-tip" data-k="pin"></div>
	<div class="note">${t("Time zones and countries: Natural Earth. Times and daylight saving: your browser's time zone database (IANA).")}</div>`;
	const $ = (k: string) => panel.querySelector<HTMLElement>(`[data-k="${k}"]`)!;

	let mode: Mode = "zone", shift = false;
	const effMode = () => shift ? (mode === "zone" ? "country" : "zone") : mode;
	const markMode = () => { for (const b of panel.querySelectorAll<HTMLElement>(".switch button")) b.setAttribute("aria-pressed", String(b.dataset.mode === effMode())); };   // Shift の間は逆の側を光らせる
	const setMode = (m: Mode) => { mode = m; refresh(); };
	panel.querySelector(".switch")!.addEventListener("click", e => { const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-mode]"); if (b) setMode(b.dataset.mode as Mode); });

	// ── データ（面と国）──
	let tzPbf: GeoPBF | null = null, a0Pbf: GeoPBF | null = null, layer: ReturnType<NonNullable<GlobeMap["addGint"]>> | null = null;
	const loadA0 = async () => {
		const p = await geopbf(A0_NAME).catch(() => null);
		return p?.length ? p : geopbf(A0_ZIP, { name: A0_NAME });
	};
	try {
		[tzPbf, a0Pbf] = await Promise.all([geopbf(tzSrc, { name: "ne_10m_time_zones", gint: true }), loadA0()]);
		$("status").textContent = "";
	} catch (e) {
		console.warn("[clock] data", e);
		$("status").textContent = t("Failed to load: $1", String((e as Error)?.message || e));
	}
	if (tzPbf && map.addGint) {
		layer = map.addGint(tzPbf, { order: -4, interactive: false });
		layer?.ready.then(() => layer!.setPaint({ "fill-color": ["match", ["get", "map_color8"], ...PALETTE.flatMap((c, i) => [i + 1, rgba(c, 0.22)]), "rgba(0,0,0,0)"], "line-color": "rgba(80,90,110,0.55)", "line-width": 0.6 })).catch(() => {});
	}

	// ── 点 → 見せる物 ──
	const props = (pbf: GeoPBF, fid: number): Record<string, any> => { try { return pbf.getProperties(fid) || {}; } catch { return {}; } };
	const countryName = (p: Record<string, any>) => p["NAME_" + lang.toUpperCase()] || p.NAME_EN || p.NAME || p.ADMIN || "";
	const placeAt = (ll: LonLat): Place => {
		const zf = tzPbf?.contain(ll) ?? null, cf = a0Pbf?.contain(ll) ?? null;
		const z = zf != null ? props(tzPbf!, zf) : null, c = cf != null ? props(a0Pbf!, cf) : null;
		const iso2 = c ? (/^[A-Z]{2}$/.test(c.ISO_A2_EH) ? c.ISO_A2_EH : /^[A-Z]{2}$/.test(c.ISO_A2) ? c.ISO_A2 : null) : null;
		return { zf, cf, a3: c?.ADM0_A3 || null, iso2, zone: z?.zone ?? null, tz: z?.tz_name1st || null, country: c ? countryName(c) : "" };
	};
	const mine = () => describe({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, now(), lang);
	const diffText = (off: number) => {
		const d = off - (mine()?.offset ?? 0);
		if (!d) return t("Same time as you");
		return d > 0 ? t("$1 ahead of you", hours.format(d / 60)) : t("$1 behind you", hours.format(-d / 60));
	};
	const dstMark = (d: Described) => d.dst ? `<span class="dst">${t("Daylight saving time")}</span>` : "";
	const zoneRows = (pl: Place) => {
		const d = describe(resolve(pl, now()), now(), lang); if (!d) return null;
		return [`<span class="zt">${esc(d.time)}</span> <span class="c">${esc(d.date)}</span>`,
			...(d.name !== d.utc || d.dst ? [`${esc(d.name)}${dstMark(d)}`] : []),   // 海の上＝名前が UTC±n だけ＝次の行と重なる
			`<span class="c">${esc(d.utc)} · ${esc(diffText(d.offset))}</span>`,
			`<span class="c">${esc(pl.country || t("Open sea"))}</span>`];
	};
	const countryRows = (pl: Place) => {
		if (!pl.a3) return zoneRows(pl);   // 海の上＝国が無い＝時間帯のまま
		const own = resolve(pl, now()).tz;
		const list = new Set((ZONES as unknown as ZoneTable)[pl.iso2!] ?? []);
		if (own) list.add(own);
		const groups = list.size ? groupZones([...list], now(), lang) : [];
		if (groups.length <= 1) return [`<b>${esc(pl.country)}</b>`, ...(zoneRows(pl) ?? []).slice(0, 3)];
		return [`<b>${esc(pl.country)}</b> <span class="c">${esc(t("$1 time zones", groups.length))}</span>`,
			...groups.slice(0, 14).map(g => `<div class="row"><b>${esc(g.time)}</b><span>${esc(g.name)}${dstMark(g)} <span class="c">${esc(g.utc)} · ${esc(g.zones.slice(0, 3).map(cityOf).join(", "))}</span></span></div>`)];
	};
	const rowsFor = (pl: Place) => effMode() === "country" ? countryRows(pl) : zoneRows(pl);
	const outlineFor = (pl: Place) => {
		try {
			if (effMode() === "country" && pl.cf != null) return a0Pbf!.getFeature(pl.cf);
			if (pl.zf != null) return tzPbf!.getFeature(pl.zf);
		} catch { /* 壊れ feature */ }
		return null;
	};

	// ── ホバー（tip）・クリック（留める）──
	const tip = map.gadget.tip();
	let hoverLL: LonLat | null = null, pinned: (Place & { ll: LonLat }) | null = null, raf = 0;
	const showHover = () => {
		if (!hoverLL) { tip(null); setOutline(pinned); return; }
		const pl = placeAt(hoverLL);
		if (pl.zf == null && pl.cf == null) { tip(null); setOutline(pinned); return; }
		const rows = rowsFor(pl);
		tip(rows ? [`<div class="clock-tip">${rows.map(r => `<div>${r}</div>`).join("")}</div>`] : null);
		setOutline(pl);
	};
	let outKey: string | null = null;
	const setOutline = (pl: Place | null) => {
		const key = pl ? `${effMode()}|${effMode() === "country" && pl.cf != null ? "c" + pl.cf : "z" + pl.zf}` : null;
		if (key === outKey) return; outKey = key;
		const f = pl && outlineFor(pl);
		map.gadget.outline((f || null) as Parameters<GlobeMap["gadget"]["outline"]>[0], { color: effMode() === "country" ? [1, 0.85, 0.45, 0.95] : [1, 1, 1, 0.95], width: 2 });
	};
	const renderPin = () => {
		const el = $("pin");
		if (!pinned) { el.innerHTML = ""; return; }
		const rows = rowsFor(placeAt(pinned.ll));
		el.innerHTML = rows ? rows.map(r => `<div>${r}</div>`).join("") : "";
	};
	const xyOf = (e: PointerEvent): [number, number] => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	const onMove = (e: PointerEvent) => {
		if (e.pointerType === "touch") return;
		if (shift !== e.shiftKey) { shift = e.shiftKey; markMode(); }
		const ll = map.unprojectXY(...xyOf(e));
		hoverLL = ll ? [(ll as any)[0] ?? (ll as any).lng, (ll as any)[1] ?? (ll as any).lat] : null;
		if (!raf) raf = requestAnimationFrame(() => { raf = 0; showHover(); });
	};
	const onLeave = () => { hoverLL = null; tip(null); setOutline(pinned); };
	let down: [number, number] | null = null;
	const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
	const onUp = (e: PointerEvent) => {
		if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) { down = null; return; }   // ドラッグ＝回しただけ
		down = null;
		if ((e.target as Element).closest?.(".clock-panel")) return;
		const ll = map.unprojectXY(...xyOf(e));
		const p: LonLat | null = ll ? [(ll as any)[0] ?? (ll as any).lng, (ll as any)[1] ?? (ll as any).lat] : null;
		const pl = p && placeAt(p);
		pinned = pl && (pl.zf != null || pl.cf != null) ? { ...pl, ll: p } : null;
		renderPin();
		if (e.pointerType === "touch") setOutline(pinned);
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "Shift" || shift === (e.type === "keydown")) return;
		shift = e.type === "keydown";
		refresh();
	};
	mapEl.addEventListener("pointermove", onMove, { passive: true });
	mapEl.addEventListener("pointerleave", onLeave);
	mapEl.addEventListener("pointerdown", onDown, { passive: true });
	mapEl.addEventListener("pointerup", onUp);
	window.addEventListener("keydown", onKey);
	window.addEventListener("keyup", onKey);
	const onBlur = () => { if (shift) { shift = false; refresh(); } };
	window.addEventListener("blur", onBlur);

	// ── 時刻を進める（1 分ごと・時計が動いた時）──
	const renderYou = () => { const d = mine(); if (!d) return; $("you").textContent = d.time; $("youz").innerHTML = `${esc(d.date)} · ${esc(d.name)} (${esc(d.utc)})`; };
	function refresh() { markMode(); renderYou(); renderPin(); if (hoverLL) showHover(); else setOutline(pinned); }
	let lastMinute = -1, timer = 0;
	const minuteOf = () => Math.floor(now().getTime() / 60000);
	const tick = () => { const m = minuteOf(); if (m !== lastMinute) { lastMinute = m; refresh(); } };
	const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { tick(); schedule(); }, 60000 - (Date.now() % 60000) + 50); };
	map.clock?.on?.("change", tick); map.clock?.on?.("tick", tick);
	schedule(); tick();

	return {
		get mode() { return mode; }, setMode,
		/** 試験・console 用：その点の表示（[経度, 緯度]・mode 省略＝今の側） */
		at(ll: LonLat, m?: Mode) { const keep = mode; if (m) mode = m; const pl = placeAt(ll); const r = { place: pl, resolved: resolve(pl, now()), rows: rowsFor(pl) }; mode = keep; return r; },
		pin(ll: LonLat) {
 const pl = placeAt(ll); pinned = { ...pl, ll }; renderPin(); setOutline(pinned); },
		get layer() { return layer; },
		destroy() {
			clearTimeout(timer); cancelAnimationFrame(raf);
			map.clock?.off?.("change", tick); map.clock?.off?.("tick", tick);
			mapEl.removeEventListener("pointermove", onMove); mapEl.removeEventListener("pointerleave", onLeave);
			mapEl.removeEventListener("pointerdown", onDown); mapEl.removeEventListener("pointerup", onUp);
			window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey); window.removeEventListener("blur", onBlur);
			tip(null); map.gadget.outline(null); layer?.remove?.(); P.destroy();
		},
	};
}
