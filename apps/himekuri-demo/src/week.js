// 一日分の「簡略化されたデータ」＝himekuri の暦（六曜・旧暦・節気・祝日・干支・暦注）＋その場所の太陽と月（出入り・南中・月齢）。
// 日めくり（day）と一週間の列（week）が同じ物を読む。DOM に触らない＝Node の検定（tests/t-week.mjs）が同じ式を走らせる。
import { 日暦情報 } from "himekuri/日カレンダー.js";
import { dayAfter, ymd2jdn } from "himekuri/共通関数.js";
import { sunDay, moonDay, dayBounds } from "./astro.js";

export const iso = ([y, m, d]) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const parseISO = s => { const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(s || ""); return m && [+m[1], +m[2], +m[3]]; };
// 「今日」＝表示の時間帯（tz）での日付。tz 省略＝実行環境のローカル
export function todayYMD(now = new Date(), tz) {
	if (!tz) return [now.getFullYear(), now.getMonth() + 1, now.getDate()];
	const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).filter(x => x.type !== "literal").map(x => [x.type, +x.value]));
	return [p.year, p.month, p.day];
}
export const addDays = (ymd, n) => dayAfter(ymd, n);
export const diffDays = (a, b) => ymd2jdn(a) - ymd2jdn(b);

// loc＝{ lat, lon, elev（m）, dip（true＝標高で地平線の降下を補正）}。tz＝表示の時間帯（IANA・省略＝実行環境）
export function dayInfo(ymd, loc, tz) {
	const [t0, t1] = dayBounds(ymd[0], ymd[1], ymd[2], tz);
	const cal = 日暦情報(ymd);
	if (!loc) return { ymd, t0, t1, cal, sun: null, moon: null };
	const h = loc.dip === false ? 0 : (loc.elev ?? 0);
	return { ymd, t0, t1, cal, sun: sunDay(t0, t1, loc.lat, loc.lon, h), moon: moonDay(t0, t1, loc.lat, loc.lon, h) };
}
// 記憶つき（同じ日・同じ場所は一度だけ）
export function createDayCache(loc, tz) {
	const m = new Map(), key = ymd => iso(ymd);
	return { get: ymd => { const k = key(ymd); if (!m.has(k)) m.set(k, dayInfo(ymd, loc, tz)); return m.get(k); }, clear: () => m.clear() };
}
