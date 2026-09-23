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
