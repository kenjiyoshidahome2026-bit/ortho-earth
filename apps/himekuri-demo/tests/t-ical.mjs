// iCalendar の読みと繰り返しの展開（終日・TZID・UTC・DAILY/WEEKLY/MONTHLY/YEARLY・COUNT/UNTIL・EXDATE・RECURRENCE-ID・折り返し行）
import assert from "node:assert/strict";
import { parseICS, expand, parseDuration, unfold } from "../src/ical.js";
import { zonedToUTC } from "../src/astro.js";
const TZ = "Asia/Tokyo", day = (y, m, d) => zonedToUTC(y, m, d, 0, 0, 0, TZ);
const ICS = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:テスト\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:終日の予定\\, 句読点つき\r\nDTSTART;VALUE=DATE:20261008\r\nDTEND;VALUE=DATE:20261009\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:朝会\r\nDTSTART;TZID=Asia/Tokyo:20261001T090000\r\nDTEND;TZID=Asia/Tokyo:20261001T093000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261031T000000Z\r\nEXDATE;TZID=Asia/Tokyo:20261009T090000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:c\r\nSUMMARY:UTC の予定で長い題名が折り返されて\r\n いる\r\nDTSTART:20261008T030000Z\r\nDURATION:PT45M\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:d\r\nSUMMARY:月例（第 2 木曜）\r\nDTSTART;TZID=Asia/Tokyo:20260108T190000\r\nDTEND;TZID=Asia/Tokyo:20260108T200000\r\nRRULE:FREQ=MONTHLY;BYDAY=2TH;COUNT=12\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:e\r\nSUMMARY:誕生日\r\nDTSTART;VALUE=DATE:19900715\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:f\r\nSUMMARY:毎日（3 回）\r\nDTSTART;TZID=Asia/Tokyo:20261007T120000\r\nDTEND;TZID=Asia/Tokyo:20261007T123000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nRECURRENCE-ID;TZID=Asia/Tokyo:20261012T090000\r\nSUMMARY:朝会（時間変更）\r\nDTSTART;TZID=Asia/Tokyo:20261012T100000\r\nDTEND;TZID=Asia/Tokyo:20261012T103000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
let n = 0;
const cal = parseICS(ICS, TZ);
assert.equal(cal.name, "テスト"); assert.equal(cal.events.length, 7); n += 2;
assert.equal(unfold("A:1\r\n 2\r\nB:3")[0].value, "12"); assert.equal(parseDuration("P1DT2H30M"), 864e5 + 2.5 * 36e5); assert.equal(parseDuration("PT45M"), 45 * 6e4); n += 3;
// 2026-10-08（木）の予定
{ const o = expand(cal, day(2026, 10, 8), day(2026, 10, 9)), s = o.map(x => x.summary);
	assert.ok(s.includes("終日の予定, 句読点つき"), "all-day"); assert.ok(s.includes("UTC の予定で長い題名が折り返されている"), "unfolded summary"); assert.ok(s.includes("月例（第 2 木曜）"), "2nd Thursday"); assert.ok(s.includes("毎日（3 回）"), "daily 2nd of 3");
	assert.ok(!s.includes("朝会"), "Thursday is not MO/WE/FR");
	const utc = o.find(x => x.summary.startsWith("UTC")); assert.equal(utc.start, Date.UTC(2026, 9, 8, 3)); assert.equal(utc.end - utc.start, 45 * 6e4); assert.equal(utc.allDay, false);
	assert.equal(o.find(x => x.allDay).start, day(2026, 10, 8)); n += 9; }
// 週の繰り返し：10/5(月)〜10/16(金)＝月水金 6 回のうち 10/9 は EXDATE、10/12 は差し替え（10:00）
{ const o = expand(cal, day(2026, 10, 5), day(2026, 10, 17)).filter(x => x.summary.startsWith("朝会"));
	assert.equal(o.length, 5, JSON.stringify(o.map(x => new Date(x.start).toISOString())));
	assert.ok(!o.some(x => x.start === zonedToUTC(2026, 10, 9, 9, 0, 0, TZ)), "EXDATE removed");
	const mon = o.find(x => x.start === zonedToUTC(2026, 10, 12, 10, 0, 0, TZ)); assert.ok(mon && mon.summary === "朝会（時間変更）", "RECURRENCE-ID override"); n += 3; }
// UNTIL：11 月には無い
{ assert.equal(expand(cal, day(2026, 11, 1), day(2026, 12, 1)).filter(x => x.summary.startsWith("朝会")).length, 0); n++; }
// COUNT：毎日 3 回＝10/7・8・9 だけ
{ const o = expand(cal, day(2026, 10, 1), day(2026, 11, 1)).filter(x => x.summary === "毎日（3 回）"); assert.equal(o.length, 3); assert.equal(o[2].start, zonedToUTC(2026, 10, 9, 12, 0, 0, TZ)); n += 2; }
// YEARLY：2026-07-15 の誕生日・COUNT=12 の月例は 2027 年 1 月には無い
{ assert.equal(expand(cal, day(2026, 7, 15), day(2026, 7, 16)).filter(x => x.summary === "誕生日").length, 1);
	assert.equal(expand(cal, day(2027, 1, 1), day(2027, 2, 1)).filter(x => x.summary.startsWith("月例")).length, 0);
	assert.equal(expand(cal, day(2026, 12, 1), day(2027, 1, 1)).filter(x => x.summary.startsWith("月例")).length, 1); n += 3; }
// Windows の時間帯名・浮動時刻・X-WR-TIMEZONE
{ const c = parseICS("BEGIN:VCALENDAR\nX-WR-TIMEZONE:Pacific/Honolulu\nBEGIN:VEVENT\nUID:x\nSUMMARY:floating\nDTSTART:20261008T080000\nEND:VEVENT\nBEGIN:VEVENT\nUID:y\nSUMMARY:win\nDTSTART;TZID=Tokyo Standard Time:20261008T080000\nEND:VEVENT\nEND:VCALENDAR", TZ);
	const o = expand(c, Date.UTC(2026, 9, 7), Date.UTC(2026, 9, 9));
	assert.equal(o.find(x => x.summary === "floating").start, zonedToUTC(2026, 10, 8, 8, 0, 0, "Pacific/Honolulu")); assert.equal(o.find(x => x.summary === "win").start, zonedToUTC(2026, 10, 8, 8, 0, 0, "Asia/Tokyo")); n += 2; }
console.log(`t-ical: ${n} checks OK`);
