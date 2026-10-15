// iCalendar（RFC 5545）の読み取り＝外部カレンダー（Google カレンダーの「iCal 形式の非公開 URL」・Outlook の公開 ICS・.ics ファイル）を日めくりに添える。
// 対応：VEVENT の SUMMARY・DTSTART/DTEND（DATE＝終日・DATE-TIME＝Z／TZID／浮動）・DURATION・RRULE（FREQ=DAILY/WEEKLY/MONTHLY/YEARLY・INTERVAL・COUNT・UNTIL・
// BYDAY（WEEKLY の曜日・MONTHLY の「第 n 曜日」）・BYMONTHDAY・BYMONTH）・EXDATE・RECURRENCE-ID（例外回の差し替え）・LOCATION・DESCRIPTION。
// 対応しない：BYSETPOS・BYWEEKNO・BYYEARDAY・VTODO・VFREEBUSY。取得は呼び手（CORS 不可なら .ics の取り込みに逃がす）。依存なし＝Node の検定（tests/t-ical.mjs）。
import { zonedToUTC } from "./astro.js";

// 行の折り返し（CRLF＋空白）を戻し、"NAME;PARAM=..:VALUE" に割る
export function unfold(text) {
	const lines = String(text).replace(/\r\n?/g, "\n").split("\n"), out = [];
	for (const l of lines) { if ((l.startsWith(" ") || l.startsWith("\t")) && out.length) out[out.length - 1] += l.slice(1); else if (l) out.push(l); }
	return out.map(l => {
		const i = l.indexOf(":");
		if (i < 0) return null;
		const [name, ...ps] = l.slice(0, i).split(";"), params = {};
		for (const p of ps) { const j = p.indexOf("="); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ""); }
		return { name: name.toUpperCase(), params, value: l.slice(i + 1) };
	}).filter(Boolean);
}
const unescape_ = s => s.replace(/\\([\;,nN])/g, (_, c) => c === "n" || c === "N" ? "\n" : c);
// 日時の値 → { ms, allDay, tz }。DATE＝その日の 0 時（呼び手の時間帯 tz0）・浮動時刻＝tz0・TZID＝その帯・Z＝UTC
export function parseDT(value, params, tz0) {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
	if (!m) return null;
	const [, Y, M, D, h, mi, s, z] = m, y = +Y, mo = +M, d = +D;
	if (params?.VALUE === "DATE" || h == null) return { ms: zonedToUTC(y, mo, d, 0, 0, 0, tz0), allDay: true, tz: tz0 };
	if (z) return { ms: Date.UTC(y, mo - 1, d, +h, +mi, +(s || 0)), allDay: false, tz: "UTC" };
	const tz = params?.TZID ? normalizeTZ(params.TZID) : tz0;
	try { return { ms: zonedToUTC(y, mo, d, +h, +mi, +(s || 0), tz), allDay: false, tz }; }
	catch { return { ms: zonedToUTC(y, mo, d, +h, +mi, +(s || 0), tz0), allDay: false, tz: tz0 }; }   // 知らない TZID＝呼び手の帯で読む
}
// Outlook 系の "Tokyo Standard Time" のような Windows 名 → IANA（よく出る物だけ・他はそのまま Intl に渡す）
const WIN_TZ = { "Tokyo Standard Time": "Asia/Tokyo", "Hawaiian Standard Time": "Pacific/Honolulu", "Pacific Standard Time": "America/Los_Angeles", "Eastern Standard Time": "America/New_York",
	"Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
	"Romance Standard Time": "Europe/Paris", "China Standard Time": "Asia/Shanghai", "Korea Standard Time": "Asia/Seoul", "AUS Eastern Standard Time": "Australia/Sydney", "UTC": "UTC" };
const normalizeTZ = id => WIN_TZ[id] || id.replace(/^\/[^/]+\/[^/]+\//, "");   // "/mozilla.org/20050126_1/Asia/Tokyo" の型も
// DURATION（P1DT2H30M・PT15M・P2W）→ ms
export function parseDuration(s) {
	const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim());
	if (!m) return 0;
	const v = ((+m[2] || 0) * 7 * 864e5) + ((+m[3] || 0) * 864e5) + ((+m[4] || 0) * 36e5) + ((+m[5] || 0) * 6e4) + ((+m[6] || 0) * 1e3);
	return m[1] === "-" ? -v : v;
}
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseRRule(s) {
	const r = {};
	for (const part of s.split(";")) { const [k, v] = part.split("="); if (k) r[k.toUpperCase()] = v; }
	return {
		freq: r.FREQ, interval: Math.max(1, +(r.INTERVAL || 1)), count: r.COUNT ? +r.COUNT : null, until: r.UNTIL || null,
		byDay: r.BYDAY ? r.BYDAY.split(",").map(x => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null; }).filter(Boolean) : null,
		byMonthDay: r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null,
		byMonth: r.BYMONTH ? r.BYMONTH.split(",").map(Number) : null,
	};
}
// VCALENDAR → { events: [...], name }。tz0＝浮動・終日を解釈する時間帯（表示の帯）
export function parseICS(text, tz0 = "UTC") {
	const lines = unfold(text), events = [];
	let cur = null, depth = 0, name = "", calTz = null;
	for (const { name: n, params, value } of lines) {
		if (n === "BEGIN") { depth++; if (value === "VEVENT") cur = { tz0 }; continue; }
		if (n === "END") { depth--; if (value === "VEVENT" && cur) { events.push(cur); cur = null; } continue; }
		if (!cur) { if (n === "X-WR-CALNAME") name = unescape_(value); if (n === "X-WR-TIMEZONE") calTz = value; continue; }
		switch (n) {
			case "UID": cur.uid = value; break;
			case "SUMMARY": cur.summary = unescape_(value); break;
			case "LOCATION": cur.location = unescape_(value); break;
			case "DESCRIPTION": cur.description = unescape_(value); break;
			case "DTSTART": cur.start = parseDT(value, params, calTz || tz0); break;
			case "DTEND": cur.end = parseDT(value, params, calTz || tz0); break;
			case "DURATION": cur.duration = parseDuration(value); break;
			case "RRULE": cur.rrule = parseRRule(value); break;
			case "EXDATE": (cur.exdates ??= []).push(...value.split(",").map(v => parseDT(v, params, calTz || tz0)?.ms).filter(x => x != null)); break;
			case "RECURRENCE-ID": cur.recurrenceId = parseDT(value, params, calTz || tz0)?.ms ?? null; break;
			case "STATUS": cur.status = value; break;
			case "TRANSP": cur.transp = value; break;
		}
	}
	return { name, tz: calTz, events: events.filter(e => e.start) };
}
// ---- 繰り返しの展開 ----
// 壁時計の分解（tz）
const parts = (ms, tz) => {
	const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
	const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
	return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
};
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const nthWeekday = (y, m, n, wd) => {   // 第 n（負＝末から）wd 曜日の日（無ければ null）
	const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), len = dim(y, m);
	if (n > 0) { const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7; return d <= len ? d : null; }
	if (n < 0) { const last = new Date(Date.UTC(y, m - 1, len)).getUTCDay(); const d = len - ((last - wd + 7) % 7) + (n + 1) * 7; return d >= 1 ? d : null; }
	const out = []; for (let d = 1 + ((wd - first + 7) % 7); d <= len; d += 7) out.push(d); return out;
};
// 1 イベントの出現を [from, to) の範囲で返す（ms）。繰り返しは最大 2,000 回で打ち切る
export function occurrences(ev, from, to) {
	const tz = ev.start.tz || ev.tz0 || "UTC";
	const dur = ev.end ? ev.end.ms - ev.start.ms : ev.duration ?? (ev.start.allDay ? 864e5 : 0);
	const ex = new Set(ev.exdates ?? []);
	const push = (out, ms) => { if (!ex.has(ms) && ms < to && ms + Math.max(dur, 1) > from) out.push({ start: ms, end: ms + dur }); };
	const out = [];
	if (!ev.rrule) { push(out, ev.start.ms); return out; }
	const r = ev.rrule, p0 = parts(ev.start.ms, tz);
	const until = r.until ? parseDT(r.until, {}, tz)?.ms ?? Infinity : Infinity;
	const hard = Math.min(to, until + 1);
	let n = 0, made = 0;
	const emit = (y, mo, d) => { if (d < 1 || d > dim(y, mo)) return; const ms = zonedToUTC(y, mo, d, p0.h, p0.mi, p0.s, tz); if (ms < ev.start.ms) return; if (ms > hard) return false; made++; if (r.count && made > r.count) return false; push(out, ms); return true; };
	if (r.freq === "DAILY") {
		for (let k = 0; k < 2000; k++) {
			const ms = ev.start.ms + k * r.interval * 864e5, p = parts(ms, tz);   // 壁時計を保つ（夏時間の境）
			if (r.byDay && !r.byDay.some(b => b.wd === p.wd)) continue;
			if (r.byMonth && !r.byMonth.includes(p.mo)) continue;
			if (emit(p.y, p.mo, p.d) === false) break;
		}
	} else if (r.freq === "WEEKLY") {
		const days = r.byDay?.map(b => b.wd) ?? [p0.wd];
		const weekStart = ev.start.ms - ((p0.wd + 6) % 7) * 864e5;   // 月曜始まり（WKST 既定 MO）
		outer: for (let w = 0; w < 2000; w++) {
			for (const wd of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
				const p = parts(weekStart + (w * r.interval * 7 + (wd + 6) % 7) * 864e5 + 12 * 36e5, tz);
				if (r.byMonth && !r.byMonth.includes(p.mo)) continue;
				if (emit(p.y, p.mo, p.d) === false) break outer;
			}
		}
	} else if (r.freq === "MONTHLY") {
		outer: for (let k = 0; k < 2000; k++) {
			let mo = p0.mo - 1 + k * r.interval, y = p0.y + Math.floor(mo / 12); mo = (mo % 12) + 1;
			if (r.byMonth && !r.byMonth.includes(mo)) continue;
			let ds = r.byMonthDay ? r.byMonthDay.map(d => d < 0 ? dim(y, mo) + 1 + d : d) : r.byDay ? r.byDay.flatMap(b => { const v = nthWeekday(y, mo, b.n, b.wd); return v == null ? [] : [].concat(v); }) : [p0.d];
			for (const d of [...new Set(ds)].sort((a, b) => a - b)) if (emit(y, mo, d) === false) break outer;
		}
	} else if (r.freq === "YEARLY") {
		outer: for (let k = 0; k < 2000; k++) {
			const y = p0.y + k * r.interval, months = r.byMonth ?? [p0.mo];
			for (const mo of months) {
				const ds = r.byMonthDay ?? (r.byDay ? r.byDay.flatMap(b => { const v = nthWeekday(y, mo, b.n, b.wd); return v == null ? [] : [].concat(v); }) : [p0.d]);
				for (const d of ds) if (emit(y, mo, d) === false) break outer;
			}
		}
	} else push(out, ev.start.ms);
	return out;
}
// カレンダー全体 → [from, to) の予定（RECURRENCE-ID の差し替えを当て、開始順）
export function expand(cal, from, to) {
	const overrides = new Map();   // uid+recurrenceId → 差し替え
	for (const e of cal.events) if (e.recurrenceId != null) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
	const out = [];
	for (const e of cal.events) {
		if (e.recurrenceId != null) { const o = occurrences({ ...e, rrule: null }, from, to)[0]; if (o) out.push({ ...o, ev: e }); continue; }
		for (const o of occurrences(e, from, to)) {
			if (overrides.has(`${e.uid}|${o.start}`)) continue;   // 差し替え済みの回
			out.push({ ...o, ev: e });
		}
	}
	return out.filter(o => o.ev.status !== "CANCELLED").sort((a, b) => a.start - b.start || (a.ev.summary || "").localeCompare(b.ev.summary || ""))
		.map(o => ({ start: o.start, end: o.end, allDay: !!o.ev.start.allDay, summary: o.ev.summary || "", location: o.ev.location || "", description: o.ev.description || "", uid: o.ev.uid || "" }));
}
