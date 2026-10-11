// 日めくりの頁の中身（2026-10-08・日めくりの段）。
//   日（day）＝himekuri の日めくり SVG を真ん中に、その外（右・狭い画面では下）に現在地の太陽・月・予定・場所の札を添える。
//   週（week）＝近傍の日を一行ずつ、上下に際限なく送れる列（IntersectionObserver で前後 7 日ずつ足す）。行を押すとその日の日めくりへ。
//   場所＝navigator.geolocation（許されなければ東京）→ 標高は elevation.js の順（Open-Meteo → 地理院 → GPS → 0）。手で直せる（設定）。
//   予定＝iCal の URL（取得はこの端末から・CORS が無い配信元は .ics の取り込みに逃がす）か .ics ファイル。localStorage に持つ。
//   文言＝英語キー（t()）。暦の中身（六曜・旧暦・節気…）は himekuri の日本語＝訳さない（日本の暦そのもの）。
import { 日カレンダー, 月相, tip } from "himekuri";
import { tr, getLang, LANGUAGES, langName } from "@ortho-earth/globe/i18n.js";
import { dayInfo, createDayCache, iso, parseISO, todayYMD, addDays, diffDays } from "./week.js";
import { nextPhases } from "./astro.js";
import { lookupElevation, SOURCES } from "./elevation.js";
import { parseICS, expand } from "./ical.js";
import { quoteOf } from "./quotes.js";
import { fmtTime, fmtDuration, fmtDeg, fmtCoord, fmtDiffMin, fmtAge, pct, PHASE_KEYS } from "./format.js";

const t = tr();
const STORE = "himekuri.app.v1";
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const TZ_LIST = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return [DEVICE_TZ]; } })();
const TOKYO = { lat: 35.6812, lon: 139.7671, elev: 3, source: "none", auto: true, dip: true, fallback: true };
const el = (tag, attrs = {}, ...kids) => {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "html") e.innerHTML = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v); }
	for (const k of kids.flat()) if (k != null) e.append(k);
	return e;
};
const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; } };
const save = s => { try { localStorage.setItem(STORE, JSON.stringify({ loc: s.loc, tz: s.tz, calendars: s.calendars.map(c => ({ id: c.id, type: c.type, url: c.url, name: c.name, text: c.type === "file" ? c.text : undefined, fetchedAt: c.fetchedAt })), mode: s.mode })); } catch { /* private mode＝持たないだけ */ } };
const WEEKDAY_COLOR = w => w === "日" ? "sun" : w === "土" ? "sat" : "";
const monthLabel = (ymd, lang) => new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : lang, { month: "long", year: "numeric" }).format(new Date(ymd[0], ymd[1] - 1, ymd[2]));
const dateLabel = (ms, lang) => new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : lang, { month: "short", day: "numeric", weekday: "short" }).format(new Date(ms));

export async function mountApp(root) {
	const lang = getLang();
	const q = new URLSearchParams(location.search), saved = load();
	const S = {
		ymd: parseISO(q.get("d")) || today(),
		mode: q.get("mode") === "week" ? "week" : saved.mode === "week" && !q.has("d") ? "week" : "day",
		loc: saved.loc || null,
		calendars: (saved.calendars || []).map(c => ({ ...c, cal: null })),
		cache: null, status: "", tz: saved.tz && TZ_LIST.includes(saved.tz) ? saved.tz : DEVICE_TZ,
	};
	if (q.get("tz") && TZ_LIST.includes(q.get("tz"))) S.tz = q.get("tz");
	for (const c of S.calendars) if (c.text) c.cal = safeParse(c.text, S.tz);
	if (q.has("lat") && q.has("lon")) S.loc = { lat: +q.get("lat"), lon: +q.get("lon"), elev: q.has("alt") ? +q.get("alt") : 0, source: q.has("alt") ? "manual" : "none", auto: !q.has("alt"), dip: true, manual: true };
	const recache = () => { S.cache = createDayCache(S.loc, S.tz); };
	const today = () => todayYMD(new Date(), S.tz);
	S.ymd ??= today();
	recache();

	// ---- 骨組み ----
	const pageEl = el("div", { id: "page" });
	const quoteEl = el("figure", { class: "hk-quote" });
	const hint = el("div", { class: "hk-hint", text: t("← → one day · Shift for a month · swipe the page · T for today") });
	const cards = { sun: el("section", { class: "hk-card", id: "card-sun" }), moon: el("section", { class: "hk-card", id: "card-moon" }), events: el("section", { class: "hk-card", id: "card-events" }), loc: el("section", { class: "hk-card hk-loc", id: "card-loc" }) };
	const weekList = el("div", { class: "hk-week-list", id: "week-list" });
	const pick = el("input", { type: "date", id: "pick", "aria-label": t("Pick a date") });
	const modeBtns = ["day", "week"].map(m => el("button", { type: "button", class: "hk-mode-btn", "data-mode": m, role: "tab", text: m === "day" ? t("Day") : t("Week"), onclick: () => setMode(m) }));
	const langSel = el("select", { id: "lang", "aria-label": t("Change language"), title: t("Change language") }, LANGUAGES.map(l => el("option", { value: l.code, text: l.name, selected: l.code === lang })));
	langSel.addEventListener("change", () => { const u = new URL(location.href); u.searchParams.set("lang", langSel.value); location.href = u.href; });
	const header = el("header", { class: "hk-bar" },
		el("h1", { class: "hk-brand" }, "日めくり", el("small", { text: t("Daily calendar") })),
		el("nav", { class: "hk-nav", "aria-label": t("Date") },
			el("button", { type: "button", id: "prev", title: t("Previous day (←)"), "aria-label": t("Previous day (←)"), text: "◀", onclick: () => move(-1) }),
			el("button", { type: "button", id: "today", text: t("Today"), onclick: () => go(today()) }),
			el("button", { type: "button", id: "next", title: t("Next day (→)"), "aria-label": t("Next day (→)"), text: "▶", onclick: () => move(1) }),
			pick),
		el("div", { class: "hk-mode", role: "tablist" }, modeBtns),
		el("div", { class: "hk-tools" }, langSel, el("button", { type: "button", id: "gear", class: "hk-icon", title: t("Settings"), "aria-label": t("Settings"), text: "⚙", onclick: () => openSettings() })));
	const viewDay = el("main", { id: "view-day", class: "hk-day" }, el("section", { class: "hk-page-wrap" }, pageEl, quoteEl, hint), el("aside", { class: "hk-side" }, cards.sun, cards.moon, cards.events, cards.loc));
	const viewWeek = el("main", { id: "view-week", class: "hk-week", hidden: true }, weekList);
	const dlg = buildSettings();
	root.replaceChildren(header, viewDay, viewWeek, dlg.dialog);
	const fitWeek = () => root.style.setProperty("--barh", header.offsetHeight + "px");   // 上の帯は狭い画面で折り返して高くなる＝週の列の高さを実測で合わせる
	addEventListener("resize", fitWeek); fitWeek();
	pick.addEventListener("change", () => { const v = parseISO(pick.value); if (v) go(v); });
	let hideTip = tip(pageEl);

	// ---- 日（day） ----
	function renderDay(dir = 0) {
		const info = S.cache.get(S.ymd);
		const page = el("div", { class: dir > 0 ? "flip-next" : dir < 0 ? "flip-prev" : "" });
		page.innerHTML = 日カレンダー(S.ymd);
		pageEl.replaceChildren(page);
		hideTip();
		pick.value = iso(S.ymd);
		const qt = quoteOf(S.ymd);
		quoteEl.replaceChildren(el("figcaption", { text: t("Words for the day") }), el("blockquote", { text: qt.text }), el("cite", { text: qt.source }));
		renderSun(info); renderMoon(info); renderEvents(info); renderLoc();
		const u = new URL(location.href);
		diffDays(S.ymd, today()) === 0 ? u.searchParams.delete("d") : u.searchParams.set("d", iso(S.ymd));
		S.tz === DEVICE_TZ ? u.searchParams.delete("tz") : u.searchParams.set("tz", S.tz);
		S.mode === "week" ? u.searchParams.set("mode", "week") : u.searchParams.delete("mode");
		history.replaceState(null, "", u);
	}
	const row = (label, value, extra) => el("div", { class: "hk-row" }, el("span", { class: "hk-k", text: label }), el("span", { class: "hk-v" }, value, extra ? el("small", { text: " " + extra }) : null));
	const timeOf = ms => fmtTime(ms, lang, S.tz);
	const az = a => a == null ? [] : [fmtDeg(a), " ", arrow(a)];
	const arrow = a => el("span", { class: "hk-arrow", style: `transform: rotate(${a}deg)`, "aria-hidden": "true", text: "↑" });
	function renderSun(info) {
		const s = info.sun, c = cards.sun;
		c.replaceChildren(el("h2", { text: t("Sun") }));
		if (!s) { c.append(el("p", { class: "hk-muted", text: t("Allow location access or enter a place in Settings to see sunrise and sunset.") })); return; }
		if (s.polar === "day") c.append(el("p", { class: "hk-note", text: t("The Sun does not set today (midnight sun).") }));
		if (s.polar === "night") c.append(el("p", { class: "hk-note", text: t("The Sun does not rise today (polar night).") }));
		c.append(
			row(t("Sunrise"), timeOf(s.rise), s.rise != null ? null : null), s.riseAz != null ? el("div", { class: "hk-sub" }, t("Azimuth"), " ", ...az(s.riseAz)) : null,
			row(t("Solar noon"), timeOf(s.noon), s.noonAlt != null ? t("altitude $1", fmtDeg(s.noonAlt, 1)) : null),
			row(t("Sunset"), timeOf(s.set)), s.setAz != null ? el("div", { class: "hk-sub" }, t("Azimuth"), " ", ...az(s.setAz)) : null,
			row(t("Day length"), fmtDuration(s.dayLength)),
			el("h3", { text: t("Twilight") }),
			row(t("Civil"), `${timeOf(s.civil.dawn)} – ${timeOf(s.civil.dusk)}`),
			row(t("Nautical"), `${timeOf(s.nautical.dawn)} – ${timeOf(s.nautical.dusk)}`),
			row(t("Astronomical"), `${timeOf(s.astro.dawn)} – ${timeOf(s.astro.dusk)}`),
			el("div", { class: "hk-sub" }, t("Declination $1 · equation of time $2 min", fmtDeg(s.dec, 2), s.eot.toFixed(1))),
		);
		if (s.dip > 0 && s.rise != null && s.rise0 != null && Math.abs(s.rise0 - s.rise) >= 3e4) c.append(el("p", { class: "hk-note", text: t("Horizon dip from $1 m elevation: $2. At sea level sunrise would be $3 and sunset $4.", Math.round(S.loc.elev), fmtDeg(s.dip, 2), fmtDiffMin(s.rise0 - s.rise), fmtDiffMin(s.set0 - s.set)) }));
		else if (S.loc && S.loc.dip === false) c.append(el("p", { class: "hk-note hk-muted", text: t("Horizon dip is off (times are for sea level).") }));
	}
	function renderMoon(info) {
		const m = info.moon, c = cards.moon;
		c.replaceChildren(el("h2", { text: t("Moon") }));
		if (!m) { c.append(el("p", { class: "hk-muted", text: t("Moon times need a location.") })); return; }
		const phase = el("div", { class: "hk-phase", html: 月相(m.age) });
		const next = nextPhases(info.t0, 32).slice(0, 2);
		c.append(
			el("div", { class: "hk-moon-head" }, phase, el("div", {}, row(t("Moon age"), fmtAge(m.age), t("at noon")), row(t("Illumination"), pct(m.illum)), row(t("Distance"), t("$1 km", Math.round(m.dist).toLocaleString(lang))))),
			row(t("Moonrise"), timeOf(m.rise)), row(t("Moon transit"), timeOf(m.transit), m.transitAlt != null ? t("altitude $1", fmtDeg(m.transitAlt, 1)) : null), row(t("Moonset"), timeOf(m.set)),
			el("h3", { text: t("Next phases") }),
			...next.map(p => row(t(PHASE_KEYS[p.phase]), `${dateLabel(p.t, lang)} ${timeOf(p.t)}`)),
		);
	}
	function eventsFor(info) {
		const out = [];
		for (const c of S.calendars) if (c.cal) for (const o of expand(c.cal, info.t0, info.t1)) out.push({ ...o, color: c.color, calName: c.name });
		return out.sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
	}
	function renderEvents(info) {
		const c = cards.events, evs = eventsFor(info);
		c.replaceChildren(el("h2", { text: t("Events") }));
		if (!S.calendars.length) { c.append(el("p", { class: "hk-muted", text: t("Add an iCal link or an .ics file in Settings to see your events here.") }), el("button", { type: "button", class: "hk-btn", text: t("Add a calendar"), onclick: () => openSettings("cal") })); return; }
		for (const cal of S.calendars) if (cal.error) c.append(el("p", { class: "hk-err", text: t("$1: $2", cal.name || cal.url, cal.error) }));
		if (!evs.length) { c.append(el("p", { class: "hk-muted", text: t("No events") })); return; }
		c.append(el("ul", { class: "hk-events" }, evs.map(e => el("li", {}, el("span", { class: "hk-ev-time", text: e.allDay ? t("All day") : `${timeOf(e.start)}${e.end > e.start ? "–" + timeOf(e.end) : ""}` }), el("span", { class: "hk-ev-title", text: e.summary || t("(untitled)"), title: [e.location, e.description].filter(Boolean).join("\n") }), e.location ? el("small", { class: "hk-ev-loc", text: e.location }) : null))));
	}
	function renderLoc() {
		const c = cards.loc, L = S.loc;
		c.replaceChildren(el("h2", { text: t("Location") }));
		if (!L) c.append(el("p", { class: "hk-muted", text: t("No location yet.") }));
		else {
			const src = SOURCES[L.source] || SOURCES.none;
			c.append(row(t("Position"), fmtCoord(L.lat, L.lon)),
				row(t("Elevation"), t("$1 m", Math.round(L.elev ?? 0)), null),
				el("div", { class: "hk-sub" }, t("Source: "), src.href ? el("a", { href: src.href, target: "_blank", rel: "noopener", text: t(src.label) }) : t(src.label)),
				row(t("Time zone"), S.tz));
			if (L.fallback) c.append(el("p", { class: "hk-note", text: t("Location access was not granted — showing Tokyo. Use the buttons below to change it.") }));
		}
		if (S.status) c.append(el("p", { class: "hk-note", text: S.status }));
		c.append(el("div", { class: "hk-actions" }, el("button", { type: "button", class: "hk-btn", text: t("Use my location"), onclick: () => locate() }), el("button", { type: "button", class: "hk-btn", text: t("Change…"), onclick: () => openSettings("loc") })));
	}

	// ---- 週（week） ----
	let weekFrom = null, weekTo = null, io = null;
	const sTop = el("div", { class: "hk-sentinel" }), sBot = el("div", { class: "hk-sentinel" });
	function weekRow(ymd) {
		const info = S.cache.get(ymd), cal = info.cal, isToday = diffDays(ymd, today()) === 0, isSel = diffDays(ymd, S.ymd) === 0;
		const evs = eventsFor(info).slice(0, 4);
		const a = el("a", { class: `hk-wrow ${WEEKDAY_COLOR(cal.曜日)} ${isToday ? "today" : ""} ${isSel ? "sel" : ""}`, href: `?d=${iso(ymd)}`, "data-d": iso(ymd), onclick: e => { e.preventDefault(); S.ymd = ymd; setMode("day"); } },
			el("div", { class: "hk-wdate" }, el("div", { class: "d", text: cal.日 }), el("div", { class: "w", text: `${cal.曜日}曜` }), el("div", { class: "m", text: `${cal.月}月` })),
			el("div", { class: "hk-wcal" },
				el("div", { class: "hk-wtags" }, cal.休日 ? el("span", { class: "tag holiday", text: cal.休日 }) : null, cal.節気 ? el("span", { class: "tag sekki", text: cal.節気 }) : null, el("span", { class: "tag rokuyo", text: cal.六曜 })),
				el("div", { class: "hk-wline" }, `旧暦 ${cal.旧暦名}`, " · ", cal.日干支, " · ", cal.日家九星),
				cal.暦注.length ? el("div", { class: "hk-wline hk-muted", text: cal.暦注.slice(0, 5).join("　") }) : null),
			el("div", { class: "hk-wastro" }, info.sun ? [
				el("div", {}, el("span", { class: "hk-ico", "aria-hidden": "true", text: "☀" }), ` ${timeOf(info.sun.rise)} – ${timeOf(info.sun.set)}`, el("small", { text: ` ${fmtDuration(info.sun.dayLength)}` })),
				el("div", {}, el("span", { class: "hk-ico", "aria-hidden": "true", text: "☾" }), ` ${timeOf(info.moon.rise)} – ${timeOf(info.moon.set)}`, el("small", { text: ` ${t("age $1", fmtAge(info.moon.age))}` })),
			] : el("div", { class: "hk-muted", text: t("No location yet.") })),
			el("div", { class: "hk-wmoon", html: info.moon ? 月相(info.moon.age) : "" }),
			el("div", { class: "hk-wev" }, evs.map(e => el("div", { class: "hk-wev-item" }, el("span", { class: "hk-ev-time", text: e.allDay ? t("All day") : timeOf(e.start) }), " ", e.summary || t("(untitled)")))));
		if (cal.日 === 1 || ymd === weekFrom) a.prepend(el("div", { class: "hk-wmonth", text: monthLabel(ymd, lang) }));
		return a;
	}
	function buildWeek() {
		fitWeek();
		weekFrom = addDays(S.ymd, -7); weekTo = addDays(S.ymd, 7);
		const rows = []; for (let d = weekFrom; diffDays(d, weekTo) <= 0; d = addDays(d, 1)) rows.push(weekRow(d));
		weekList.replaceChildren(sTop, ...rows, sBot);
		io?.disconnect();
		io = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) { extend(e.target === sTop ? -1 : 1); io.unobserve(e.target); io.observe(e.target); } }, { root: weekList, rootMargin: "600px 0px" });   // 足した後も見えたままなら observe し直して続きを呼ぶ
		io.observe(sTop); io.observe(sBot);
		requestAnimationFrame(() => weekList.querySelector(`[data-d="${iso(S.ymd)}"]`)?.scrollIntoView({ block: "start" }));
	}
	function extend(dir) {
		const frag = document.createDocumentFragment();
		if (dir < 0) { const before = weekList.scrollHeight; for (let i = 14; i >= 1; i--) frag.append(weekRow(addDays(weekFrom, -i))); weekFrom = addDays(weekFrom, -14); sTop.after(frag); weekList.scrollTop += weekList.scrollHeight - before; }
		else { for (let i = 1; i <= 14; i++) frag.append(weekRow(addDays(weekTo, i))); weekTo = addDays(weekTo, 14); sBot.before(frag); }
		// 列が長くなりすぎたら遠い側を畳む（200 日まで）＝記憶（S.cache）は残る
		const rows = [...weekList.querySelectorAll(".hk-wrow")];
		if (rows.length > 200) { if (dir > 0) { const h0 = weekList.scrollHeight; rows.slice(0, 50).forEach(r => r.remove()); weekFrom = addDays(weekFrom, 50); weekList.scrollTop -= h0 - weekList.scrollHeight; } else { rows.slice(-50).forEach(r => r.remove()); weekTo = addDays(weekTo, -50); } }
	}

	// ---- 切替・移動 ----
	function setMode(m) {
		S.mode = m;
		for (const b of modeBtns) { const on = b.dataset.mode === m; b.setAttribute("aria-selected", on); b.classList.toggle("on", on); }
		viewDay.hidden = m !== "day"; viewWeek.hidden = m !== "week"; hint.hidden = m !== "day";
		save(S); render();
	}
	function render(dir = 0) { if (S.mode === "week") buildWeek(); renderDay(dir); }
	function go(ymd, dir = 0) { S.ymd = ymd; if (S.mode === "week") { buildWeek(); renderDay(); } else renderDay(dir); }
	const move = n => go(addDays(S.ymd, n), Math.sign(n));
	const moveMonth = n => { let [y, m, d] = S.ymd; m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } const last = new Date(y, m, 0).getDate(); go([y, m, Math.min(d, last)], Math.sign(n)); };
	addEventListener("keydown", e => {
		if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey || dlg.dialog.open) return;
		if (e.key === "ArrowLeft") e.shiftKey ? moveMonth(-1) : move(-1);
		else if (e.key === "ArrowRight") e.shiftKey ? moveMonth(1) : move(1);
		else if (e.key === "t" || e.key === "T") go(today());
		else if (e.key === "w" || e.key === "W") setMode(S.mode === "week" ? "day" : "week");
		else return;
		e.preventDefault();
	});
	let x0 = null;
	pageEl.addEventListener("pointerdown", e => { x0 = e.clientX; });
	pageEl.addEventListener("pointerup", e => { if (x0 === null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 40) move(dx < 0 ? 1 : -1); });
	// 日付が変わったら「今日」を追いかける（今日を表示しているときだけ）
	let shown = iso(today());
	setInterval(() => { const now = iso(today()); if (now !== shown) { if (iso(S.ymd) === shown) go(today(), 1); else render(); shown = now; } }, 30000);

	// ---- 場所 ----
	async function applyLocation(lat, lon, { gpsAlt = null, elev = null, source = null, manual = false } = {}) {
		const prev = S.loc || {};
		S.loc = { lat, lon, elev: elev ?? prev.elev ?? 0, source: source ?? (elev != null ? "manual" : "none"), auto: elev == null, dip: prev.dip !== false, manual };
		recache(); save(S); render();
		if (elev == null) {
			S.status = t("Looking up elevation…"); renderLoc();
			const r = await lookupElevation(lat, lon, { gpsAlt });
			if (S.loc && S.loc.lat === lat && S.loc.lon === lon) { S.loc.elev = r.elevation; S.loc.source = r.source; S.status = ""; recache(); save(S); render(); }
		}
	}
	function locate() {
		if (!navigator.geolocation) { S.status = t("This browser has no location service."); renderLoc(); return; }
		S.status = t("Getting your location…"); renderLoc();
		navigator.geolocation.getCurrentPosition(
			p => { S.status = ""; applyLocation(+p.coords.latitude.toFixed(5), +p.coords.longitude.toFixed(5), { gpsAlt: p.coords.altitude }); },
			e => { S.status = e.code === 1 ? t("Location access was denied.") : t("Could not get your location ($1).", e.message); if (!S.loc) { S.loc = { ...TOKYO }; recache(); } save(S); render(); },
			{ enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
	}

	// ---- 予定（iCal） ----
	async function fetchCalendar(c) {
		try {
			const r = await fetch(c.url, { cache: "no-store" });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const text = await r.text();
			if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error(t("not an iCalendar file"));
			c.text = text; c.cal = parseICS(text, S.tz); c.name = c.cal.name || c.name || new URL(c.url).hostname; c.fetchedAt = Date.now(); c.error = null;
		} catch (e) {
			c.error = /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? t("could not fetch (the server does not allow cross-origin access — download the .ics and import the file instead)") : e.message;
		}
		save(S); render();
	}
	function addUrl(url) {
		url = url.trim().replace(/^webcal:/i, "https:");
		if (!/^https?:\/\//i.test(url)) return false;
		const c = { id: Math.random().toString(36).slice(2), type: "url", url, name: "", cal: null };
		S.calendars.push(c); fetchCalendar(c); return true;
	}
	function addFile(file) {
		return file.text().then(text => { if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error(t("not an iCalendar file")); const cal = parseICS(text, S.tz); S.calendars.push({ id: Math.random().toString(36).slice(2), type: "file", name: cal.name || file.name, text, cal, fetchedAt: Date.now() }); save(S); render(); });
	}

	// ---- 設定 ----
	function buildSettings() {
		const lat = el("input", { type: "number", step: "0.0001", min: -90, max: 90, id: "s-lat" }), lon = el("input", { type: "number", step: "0.0001", min: -180, max: 180, id: "s-lon" });
		const elev = el("input", { type: "number", step: "1", id: "s-elev" }), auto = el("input", { type: "checkbox", id: "s-auto" }), dipChk = el("input", { type: "checkbox", id: "s-dip" });
		const tzSel = el("select", { id: "s-tz" }, TZ_LIST.map(z => el("option", { value: z, text: z })));
		const url = el("input", { type: "url", id: "s-url", placeholder: "https://… .ics", inputmode: "url" }), file = el("input", { type: "file", accept: ".ics,text/calendar", id: "s-file" });
		const list = el("ul", { class: "hk-cal-list" }), msg = el("p", { class: "hk-note" });
		auto.addEventListener("change", () => { elev.disabled = auto.checked; });
		const applyLoc = () => {
			const la = +lat.value, lo = +lon.value;
			if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) { msg.textContent = t("Enter a latitude between −90 and 90 and a longitude between −180 and 180."); return; }
			msg.textContent = "";
			if (tzSel.value !== S.tz) { S.tz = tzSel.value; for (const c of S.calendars) if (c.text) c.cal = safeParse(c.text, S.tz); }
			const dip = dipChk.checked;
			applyLocation(la, lo, auto.checked ? { manual: true } : { elev: +elev.value || 0, source: "manual", manual: true }).then(() => { if (S.loc) { S.loc.dip = dip; recache(); save(S); render(); } });
			if (S.loc) { S.loc.dip = dip; recache(); save(S); render(); }
		};
		const dialog = el("dialog", { id: "settings", class: "hk-dialog", "aria-label": t("Settings") },
			el("form", { method: "dialog", class: "hk-form", onsubmit: e => { e.preventDefault(); dialog.close(); } },
				el("header", {}, el("h2", { text: t("Settings") }), el("button", { type: "button", class: "hk-icon", "aria-label": t("Close"), text: "✕", onclick: () => dialog.close() })),
				el("section", { id: "s-loc" }, el("h3", { text: t("Location") }),
					el("p", { class: "hk-muted", text: t("Sunrise and sunset are computed for this point. Elevation above sea level lowers the horizon (1.76′√h), so the Sun rises earlier and sets later than at sea level.") }),
					el("div", { class: "hk-grid" }, el("label", { for: "s-lat", text: t("Latitude") }), lat, el("label", { for: "s-lon", text: t("Longitude") }), lon, el("label", { for: "s-elev", text: t("Elevation (m)") }), elev, el("label", { for: "s-tz", text: t("Time zone") }), tzSel),
					el("p", { class: "hk-muted", text: t("Times are shown in this time zone (the device’s by default). Pick the zone of the place when you enter a faraway location.") }),
					el("label", { class: "hk-check" }, auto, " ", t("Look up elevation automatically (Open-Meteo, then GSI tiles, then GPS)")),
					el("label", { class: "hk-check" }, dipChk, " ", t("Correct sunrise and sunset for horizon dip")),
					msg,
					el("div", { class: "hk-actions" }, el("button", { type: "button", class: "hk-btn", text: t("Use my location"), onclick: () => { locate(); dialog.close(); } }), el("button", { type: "button", class: "hk-btn primary", text: t("Apply"), onclick: applyLoc }))),
				el("section", { id: "s-cal" }, el("h3", { text: t("Calendars (iCal)") }),
					el("p", { class: "hk-muted", text: t("Paste the iCal address of a calendar (Google Calendar: Settings → “Secret address in iCal format”; Outlook: “Publish calendar” → ICS link). It is fetched by this browser only and kept on this device. If the server blocks cross-origin requests, download the .ics file and import it below.") }),
					el("div", { class: "hk-inline" }, url, el("button", { type: "button", class: "hk-btn", text: t("Add"), onclick: () => { if (addUrl(url.value)) { url.value = ""; refreshList(); } else msg2.textContent = t("Enter an https:// or webcal:// address."); } })),
					el("label", { class: "hk-file" }, t("Import an .ics file"), " ", file),
					list),
				el("footer", {}, el("small", { class: "hk-muted", text: t("Calendar data by himekuri (MIT). Sun and Moon from Meeus / Schlyter low-precision theory (≈1 minute). Elevation: Open-Meteo, GSI.") }), el("button", { type: "submit", class: "hk-btn primary", text: t("Done") }))));
		const msg2 = el("p", { class: "hk-err" }); list.before(msg2);
		file.addEventListener("change", () => { const f = file.files?.[0]; if (f) addFile(f).then(() => { refreshList(); msg2.textContent = ""; }).catch(e => { msg2.textContent = e.message; }); file.value = ""; });
		function refreshList() {
			list.replaceChildren(...S.calendars.map(c => el("li", {},
				el("span", { class: "hk-cal-name", text: c.name || c.url || t("(untitled)") }),
				el("small", { class: c.error ? "hk-err" : "hk-muted", text: c.error ? c.error : c.type === "url" ? t("$1 events · fetched $2", c.cal?.events.length ?? 0, c.fetchedAt ? fmtTime(c.fetchedAt, lang, S.tz) : "—") : t("$1 events · file", c.cal?.events.length ?? 0) }),
				c.type === "url" ? el("button", { type: "button", class: "hk-icon", title: t("Refresh"), "aria-label": t("Refresh"), text: "↻", onclick: () => fetchCalendar(c).then(refreshList) }) : null,
				el("button", { type: "button", class: "hk-icon", title: t("Remove"), "aria-label": t("Remove"), text: "✕", onclick: () => { S.calendars = S.calendars.filter(x => x !== c); save(S); render(); refreshList(); } }))));
			if (!S.calendars.length) list.append(el("li", { class: "hk-muted", text: t("No calendars yet.") }));
		}
		return { dialog, open(section) {
			const L = S.loc || TOKYO; lat.value = L.lat; lon.value = L.lon; elev.value = Math.round(L.elev ?? 0); auto.checked = L.auto !== false; elev.disabled = auto.checked; dipChk.checked = L.dip !== false; tzSel.value = S.tz; msg.textContent = ""; msg2.textContent = "";
			refreshList(); dialog.showModal();
			if (section) dialog.querySelector(section === "cal" ? "#s-cal" : "#s-loc")?.scrollIntoView({ block: "start" });
		} };
	}
	const openSettings = section => dlg.open(section);

	// ---- 起動 ----
	setMode(S.mode);
	if (!S.loc) locate();
	else if (S.loc.auto !== false && (S.loc.source === "none" || S.loc.source === "gps") && !S.loc.fallback) applyLocation(S.loc.lat, S.loc.lon, { manual: S.loc.manual });
	for (const c of S.calendars) if (c.type === "url" && (!c.fetchedAt || Date.now() - c.fetchedAt > 36e5)) fetchCalendar(c);
	return { state: S, go, setMode };
}
function safeParse(text, tz) { try { return parseICS(text, tz); } catch { return null; } }
