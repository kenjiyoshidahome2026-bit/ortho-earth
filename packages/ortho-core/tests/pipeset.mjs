// パイプラインの束（pipeset.ts）：lazy の束は初回アクセスで 1 回だけ作る・named() の帳（label・ms・at）に lazy／eager とも載る（HUD の「遅いフレーム」行が読む・2026-11-07）
import { pipeSet, pipeMade, named, lbl, pipeLog } from "../src/gpu/pipeset.ts";

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

let made = 0;
const eager = pipeSet("e", false, { a: () => (made++, { l: lbl() }), b: () => (made++, { l: lbl() }) });
ok("eager＝その場で全部", made === 2 && eager.a.l === "e.a" && eager.b.l === "e.b");
ok("eager の束は pipeMade 常に true", pipeMade(eager, "a") && pipeMade(eager, "zzz"));
const n0 = pipeLog().length;
ok("eager の 2 本が帳に載る", n0 >= 2 && pipeLog().slice(-2).map(e => e.label).join() === "e.a,e.b");

made = 0;
const lazy = pipeSet("m1x", true, { a: () => (made++, { l: lbl() }), b: () => (made++, { l: lbl() }) });
ok("lazy＝触るまで作らない", made === 0 && !pipeMade(lazy, "a") && pipeLog().length === n0);
ok("初回アクセスで作る・label は 束.鍵", lazy.a.l === "m1x.a" && made === 1 && pipeMade(lazy, "a") && !pipeMade(lazy, "b"));
ok("2 回目は memo", lazy.a === lazy.a && made === 1);
const e = pipeLog()[pipeLog().length - 1];
ok("帳に label・ms・at が載る", pipeLog().length === n0 + 1 && e.label === "m1x.a" && e.ms >= 0 && e.at > 0);
ok("lbl() は作っている間だけ", lbl() === "");
named("solo", () => 1);
ok("named() の 1 本も帳に載る", pipeLog()[pipeLog().length - 1].label === "solo");
let threw = false; try { named("boom", () => { throw new Error("x"); }); } catch { threw = true; }
ok("工場が投げても lbl() は戻り・帳には載る", threw && lbl() === "" && pipeLog()[pipeLog().length - 1].label === "boom");

if (fail) { console.error(`${fail} FAIL`); process.exit(1); }
console.log("pipeset OK");
