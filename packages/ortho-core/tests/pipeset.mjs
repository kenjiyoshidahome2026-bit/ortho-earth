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

// 進行描き（warmPipesBg・?warmpipe=3）：Async で作っている間 getter は null・できたら本物・onReady が鍵ごとに鳴る・作り直さない
{
	const { warmPipesBg, pipePending } = await import("../src/gpu/pipeset.ts");
	const resolvers = {};
	const fakeDevice = { createRenderPipelineAsync: (d) => new Promise((res, rej) => { resolvers[d.label] = { res, rej }; }) };
	let made = 0;
	const set = pipeSet("m1x", true, {
		globe: () => (made++, { l: "globe" }),
		lineOff: () => (made++, fakeDevice.createRenderPipeline({ label: "lineOff" })),
		bld: () => (made++, fakeDevice.createRenderPipeline({ label: "bld" })),
		odd: () => (made++, null),   // createRenderPipeline を通らない工場＝その値がそのまま答え
	});
	const ready = [];
	const bg = warmPipesBg(set, fakeDevice, ["lineOff", "bld", "odd"], k => ready.push(k));
	ok("bg: Async に出した数＝2（odd は即・値をそのまま）", bg.asked === 2 && set.odd === null && !pipePending(set, "odd"));
	ok("bg: 作っている間は pending・getter は null・工場は呼び直さない", pipePending(set, "lineOff") && set.lineOff === null && set.lineOff === null && made === 3);
	ok("bg: 束の他の鍵は従来どおり同期で作る", set.globe.l === "globe" && made === 4);
	ok("bg: 記録モードの差し替えは外してある", fakeDevice.createRenderPipeline === undefined);
	resolvers.lineOff.res({ real: "lineOff" }); await new Promise(r => setTimeout(r, 0));
	ok("bg: できた鍵は本物を返し onReady が鳴る", set.lineOff.real === "lineOff" && !pipePending(set, "lineOff") && ready.join() === "lineOff" && pipeMade(set, "lineOff"));
	resolvers.bld.rej(new Error("boom")); const w = await bg.done;
	ok("bg: 失敗した鍵は pending を外し（同期生成へ落ちる）failed に載る", !pipePending(set, "bld") && w.failed.length === 1 && w.failed[0].startsWith("bld:") && w.made === 1 && ready.join() === "lineOff,bld");
	let sync = 0; fakeDevice.createRenderPipeline = () => (sync++, { real: "bld-sync" });
	ok("bg: 失敗後の初回アクセスは同期で作る", set.bld.real === "bld-sync" && sync === 1);
	ok("bg: 帳に (bg) の印で載る", pipeLog().some(e => e.label === "m1x.lineOff(bg)"));
}
if (fail) { console.error(`${fail} FAIL`); process.exit(1); }
console.log("pipeset bg OK");

// 同時本数 par（?warmpar）：keys の順に par 本ずつ Async に出す・順番待ちの鍵も最初から pending（null）・1 本できたら次が出る
{
	const { warmPipesBg, pipePending } = await import("../src/gpu/pipeset.ts");
	const started = []; const resolvers = {};
	const fakeDevice = { createRenderPipelineAsync: (d) => (started.push(d.label), new Promise((res, rej) => { resolvers[d.label] = { res, rej }; })) };
	const set = pipeSet("m1p", true, {
		lineOff: () => fakeDevice.createRenderPipeline({ label: "lineOff" }),
		fillOff: () => fakeDevice.createRenderPipeline({ label: "fillOff" }),
		bld: () => fakeDevice.createRenderPipeline({ label: "bld" }),
	});
	const ready = [];
	const bg = warmPipesBg(set, fakeDevice, ["lineOff", "fillOff", "bld"], k => ready.push(k), 1);
	ok("par: 3 本頼んで Async に出たのは先頭 1 本", bg.asked === 3 && started.join() === "lineOff");
	ok("par: 順番待ちの鍵も pending＝null", pipePending(set, "bld") && set.bld === null && set.fillOff === null);
	resolvers.lineOff.res({ real: "lineOff" }); await new Promise(r => setTimeout(r, 0));
	ok("par: 1 本できたら次（fillOff）が出る・順は keys の順", started.join() === "lineOff,fillOff" && set.lineOff.real === "lineOff" && ready.join() === "lineOff");
	resolvers.fillOff.rej(new Error("x")); await new Promise(r => setTimeout(r, 0));
	ok("par: 失敗しても列は止まらず次（bld）が出る", started.join() === "lineOff,fillOff,bld" && !pipePending(set, "fillOff"));
	resolvers.bld.res({ real: "bld" }); const w = await bg.done;
	ok("par: 全部終わる＝made 2・failed 1・onReady 3 回", w.made === 2 && w.failed.length === 1 && ready.join() === "lineOff,fillOff,bld" && set.bld.real === "bld");
	// par=0＝全部一度に（従来）
	const started2 = []; const dev2 = { createRenderPipelineAsync: (d) => (started2.push(d.label), new Promise(() => {})) };
	const set2 = pipeSet("m1q", true, { a: () => dev2.createRenderPipeline({ label: "a" }), b: () => dev2.createRenderPipeline({ label: "b" }) });
	warmPipesBg(set2, dev2, ["a", "b"], undefined, 0);
	ok("par=0: 全部一度に出す", started2.join() === "a,b");
}
if (fail) { console.error(`${fail} FAIL`); process.exit(1); }
console.log("pipeset par OK");
