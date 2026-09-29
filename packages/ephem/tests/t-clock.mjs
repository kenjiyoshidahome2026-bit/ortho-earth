#!/usr/bin/env node
// 共通の時計（clock.js・#42）の常設ハーネス（Node）。偽の now() で実時間の張り付き・段・範囲・URL・anchor を確かめる。
// 使い方: node packages/ephem/tests/t-clock.mjs
import { createClock, clockNow, fmtUTC, CLOCK_MIN, CLOCK_MAX } from "../src/clock.js";

let fails = 0;
const ok = (cond, label) => { if (cond) return; fails++; console.error(`  ✗ ${label}`); };
let wall = Date.UTC(2026, 8, 23, 3, 0, 0);
const now = () => wall;

// 1. 既定＝実時間（Date.now に張り付く・t を書かない）
const c = createClock({ now });
ok(c.time === wall && c.isLive() && c.step === 1, "live by default");
wall += 5000; ok(c.time === wall, "live follows the wall clock without tick");
ok(!c.toParams().has("t") && !c.toParams().has("s"), "live writes neither t nor s");
// 2. 段＝◀◀ は停止を通り越して逆再生
c.faster(); ok(c.step === 2 && c.speed === 60 && !c.isLive(), "faster → 1 min/s, no longer live");
const t0 = c.time; c.tick(2); ok(c.time === t0 + 120e3, "tick 2 s at 1 min/s = +120 s");
c.setStep(0); c.slower(); ok(c.step === -1 && c.speed === -1 && c.label() === "−1 sec/s", "slower from pause = reverse, neg label");
c.toggle(); ok(c.step === 0 && !c.playing, "toggle pauses"); c.toggle(); ok(c.step === -1, "toggle resumes the last play step");
// 3. 範囲の端＝止まる
c.setTime(CLOCK_MIN + 1000).setStep(-5); c.tick(10); ok(c.time === CLOCK_MIN && c.step === 0, "clamps at min and pauses");
c.setTime(CLOCK_MAX + 9e9); ok(c.time === CLOCK_MAX, "setTime clamps to max");
// 4. URL
const T = Date.UTC(2011, 2, 11, 5, 46, 0);
c.setTime(T).setStep(3);
const p = c.toParams(); ok(p.get("t") === "2011-03-11T05:46Z" && p.get("s") === "3", "toParams t (UTC, minutes) and s");
const d = createClock({ now }).fromParams("?t=2011-03-11T05:46Z&s=0");
ok(d.time === T && d.step === 0 && !d.isLive(), "fromParams fixed time, paused");
const e = createClock({ now }).fromParams("#s=1"); ok(e.isLive() && e.time === wall, "t-less s=1 = live link");
// 5. 範囲（#124）＝CLAMPED は両端で止まる・LOOP_STOP は順行で始まりへ戻り逆行は始まりで止まる・UNBOUNDED は縛らない
{
	const A = Date.UTC(2012, 2, 15, 10), B = A + 3600e3;   // 1 時間の区間
	const k = createClock({ now }).setTime(A).setRange(A, B, "CLAMPED").setStep(2);   // 1 min/s
	ok(k.rangeMode === "clamped" && k.range[0] === A && k.range[1] === B, "setRange stores the window (CZML names accepted)");
	k.tick(70); ok(k.time === B && k.step === 0, "clamped: stops at the end");
	k.setTime(A - 9e9); ok(k.time === A, "clamped: setTime is kept inside");
	const l = createClock({ now }).setTime(B - 30e3).setRange(A, B, "LOOP_STOP").setStep(2);
	let changed = 0; l.on("change", () => changed++);
	l.tick(1); ok(l.time === A + 30e3 && l.step === 2 && changed === 1, "loop: wraps to the start and keeps playing (emits change for the worker anchor)");
	l.setTime(A + 10e3).setStep(-2); l.tick(1); ok(l.time === A && l.step === 0, "loop: going backward stops at the start");
	const u = createClock({ now }).setTime(A).setRange(A, B, "unbounded").setStep(2);
	u.tick(120); ok(u.time === A + 7200e3 && u.step === 2 && u.range[1] === B, "unbounded: the window does not bind time");
	const f = createClock({ now }); f.setRange(wall - 1000, wall + 5000, "clamped");
	ok(f.isLive() && f.time === wall, "live stays live while now is inside the window");
	wall += 10e3; f.tick(0.016); ok(!f.isLive() && f.time === wall - 10e3 + 5000, "live leaves the window → clamped at the end");
	const g = createClock({ now }).setRange(Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 2));
	ok(!g.isLive() && g.time === Date.UTC(2000, 0, 2), "live outside the window → moved to the nearest end");
	g.clearRange(); ok(g.rangeMode === null && g.range[0] === CLOCK_MIN && g.range[1] === CLOCK_MAX, "clearRange restores the outer bounds");
	let threw = 0; try { g.setRange(B, A); } catch { threw = 1; } ok(threw, "setRange rejects start >= end");
	const q = createClock({ now }).setRange(A, B, "clamped").fromParams("?t=1999-01-01T00:00Z&s=0");
	ok(q.time === A, "URL t= outside a clamped window is kept inside");
}
const f = createClock({ now }).fromParams("t=2011-03-11T05:46:30Z"); ok(f.time === T + 30e3 && f.step === 1 && !f.isLive(), "seconds kept; s missing = step 1 but not live (past)");
ok(fmtUTC(T + 30e3) === "2011-03-11T05:46:30Z", "fmtUTC seconds");
// 5. anchor → clockNow（worker 側の毎フレーム）
const g = createClock({ now }).setTime(T).setStep(5);   // 1 day/s
const a = g.anchor(); wall += 1000; ok(clockNow(a, wall) === T + 86400e3, "clockNow advances by rate × wall dt");
const h = createClock({ now }); const b = h.anchor(); wall += 777; ok(clockNow(b, wall) === wall, "live anchor = wall clock");
// 6. 今ボタン
g.live(); ok(g.isLive() && g.step === 1 && g.time === wall, "live() returns to now");
// 7. change イベント
let n = 0; g.on("change", () => n++); g.setStep(4); g.setTime(T); ok(n === 2, "change fires on setStep/setTime");

console.log(fails ? `✗ clock: ${fails} failed` : "✓ clock: all passed");
process.exit(fails ? 1 : 0);
