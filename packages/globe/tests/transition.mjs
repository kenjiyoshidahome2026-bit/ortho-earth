// paint の transition の走者（src/transition.js・B1 2026-10-12）＝途中値・中断・連続 set・delay・色・補間しない組・優先順位
import { createTransitions, transitionOf, interpolable, mix, EASE, PAINT_DEFAULTS } from "../src/transition.js";
let fail = 0; const ok = (name, c, note = "") => { console.log(`${c ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`); if (!c) fail++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// 優先順位＝層の *-transition > style の transition > 既定 300/0
ok("transitionOf:default", JSON.stringify(transitionOf({ paint: {} }, "fill-opacity")) === '{"duration":300,"delay":0}');
ok("transitionOf:style", JSON.stringify(transitionOf({ paint: {} }, "fill-opacity", { duration: 1000, delay: 10 })) === '{"duration":1000,"delay":10}');
ok("transitionOf:layer", JSON.stringify(transitionOf({ paint: { "fill-opacity-transition": { duration: 50 } } }, "fill-opacity", { duration: 1000 })) === '{"duration":50,"delay":0}');
ok("transitionOf:zero", transitionOf({ paint: { "fill-opacity-transition": { duration: 0 } } }, "fill-opacity").duration === 0);
ok("interpolable", interpolable(0, 1) === "number" && interpolable("#f00", "rgba(0,0,255,0.5)") === "color" && interpolable([0, 0], [10, 5]) === "array" && interpolable(["get", "x"], 1) === null && interpolable("visible", "none") === null && interpolable([0, 0], [1, 2, 3]) === null && interpolable(1, NaN) === null);
ok("mix:color", mix("color", "#ff0000", "#0000ff", 0.5) === "rgba(128,0,128,1)" && mix("color", "rgba(0,0,0,0)", "#000000", 0.25) === "rgba(0,0,0,0.25)", mix("color", "#ff0000", "#0000ff", 0.5));
ok("mix:array", JSON.stringify(mix("array", [0, 0], [10, -4], 0.5)) === "[5,-2]");
ok("ease:ends", near(EASE(0), 0, 1e-6) && near(EASE(1), 1, 1e-6) && EASE(0.5) > 0.5);   // MapLibre の util.ease＝前半が速い
ok("defaults", PAINT_DEFAULTS["fill-opacity"] === 1 && PAINT_DEFAULTS["circle-radius"] === 5 && PAINT_DEFAULTS["line-width"] === 1);

// 走者＝手回しの時計
let T = 0; const sched = []; const tr = createTransitions({ now: () => T, schedule: fn => sched.push(fn) });
const run = () => { const q = sched.splice(0); for (const f of q) f(); };
const log = [];
const started = tr.start("a/fill-opacity", 1, 0, { duration: 300 }, (v, done) => log.push([T, +v.toFixed(4), done]));
ok("start:returns-true", started && tr.active === 1 && sched.length === 1);
T = 150; run();
const mid = log.at(-1);
ok("mid", mid && mid[0] === 150 && mid[1] < 1 && mid[1] > 0 && mid[1] === +(1 - EASE(0.5)).toFixed(4) && !mid[2], JSON.stringify(mid));
ok("current", near(tr.current("a/fill-opacity"), 1 - EASE(0.5), 1e-9));
T = 300; run();
ok("end", log.at(-1)[1] === 0 && log.at(-1)[2] === true && tr.active === 0 && sched.length === 0);
// 中断＝途中で set し直す → その瞬間の値から次の目標へ
T = 1000; log.length = 0;
tr.start("a/fill-opacity", 0, 1, { duration: 400 }, v => log.push([T, +v.toFixed(4)]));
T = 1200; run();                                           // 半分＝EASE(0.5)
const half = log.at(-1)[1];
tr.start("a/fill-opacity", 1, 0, { duration: 200 }, v => log.push([T, "b", +v.toFixed(4)]));   // 引数の from は無視＝今の補間値から
ok("interrupt:active-one", tr.active === 1);
T = 1300; run();
const b1 = log.at(-1);
ok("interrupt:from-current", b1[1] === "b" && b1[2] < half && b1[2] > 0 && near(b1[2], half * (1 - EASE(0.5)), 1e-3), `${half} → ${b1[2]}`);
T = 1400; run();
ok("interrupt:end", log.at(-1)[2] === 0 && tr.active === 0);
// delay＝待っている間は apply しない・終わると to
log.length = 0; T = 2000;
tr.start("c/line-width", 1, 5, { duration: 100, delay: 200 }, (v, d) => log.push([T, v, d]));
T = 2100; run(); ok("delay:quiet", log.length === 0 && tr.active === 1);
T = 2250; run(); ok("delay:mid", log.length === 1 && log[0][1] > 1 && log[0][1] < 5);
T = 2300; run(); ok("delay:end", log.at(-1)[1] === 5 && log.at(-1)[2] === true);
// 補間できない組・duration 0＝すぐ当てる・false
log.length = 0;
ok("immediate:expr", tr.start("d/fill-color", "#f00", ["get", "c"], { duration: 300 }, (v, d) => log.push([v, d])) === false && JSON.stringify(log[0][0]) === '["get","c"]' && log[0][1] === true && tr.active === 0);
ok("immediate:zero", tr.start("e/fill-opacity", 1, 0, { duration: 0 }, () => {}) === false);
// apply が false を返す＝外された層＝走者から消える
tr.start("f/x", 0, 1, { duration: 100 }, () => false); T = 2350; run(); ok("drop-on-false", tr.active === 0);
// cancelPrefix＝層ごとにまとめて消す
tr.start("g/x", 0, 1, { duration: 100 }, () => {}); tr.start("g/y", 0, 1, { duration: 100 }, () => {}); tr.start("h/x", 0, 1, { duration: 100 }, () => {});
tr.cancelPrefix("g/"); ok("cancelPrefix", tr.active === 1); tr.clear(); ok("clear", tr.active === 0);

console.log(fail ? `✗ transition: ${fail} failed` : "✓ transition PASS");
process.exit(fail ? 1 : 0);
