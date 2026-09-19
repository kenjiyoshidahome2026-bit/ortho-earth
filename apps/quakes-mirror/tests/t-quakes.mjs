#!/usr/bin/env node
// quakes-mirror の検定＝偽 R2＋偽 fetch（合成 CSV）。USGS へは一度も触れない。
//   取り込み：12 か月前の月初〜先月末 → 1 回 PER_RUN か月ずつ分割 → 済めば fresh（fetch 0）→ 翌月は先月分＋未確定分だけ
//             → 月末＋30 日以降に取った月は確定（二度と取らない）→ archive を置くと起点が進み古い CSV を消す
//             → 20,000 件上限の月は二分して複数本 → 失敗はそこでやめ、済んだ分は目次に残して次回続き
//   配信：空は 503 → 目次・CSV・archive → CORS → ETag 一致で 304 → 知らない道は 404
//   読み手：apps/ortho-japan/quakes-worker.js に archive（GeoPBF）＋recent.json を渡し、連結件数が合うこと
//   node apps/quakes-mirror/tests/t-quakes.mjs
import { build, serve } from "../worker.js";
import { buildGeoPBF, parseCsvTexts } from "../usgs.js";

// ── 偽 R2（get/put/delete と onlyIf の If-None-Match だけ）───────────────────
const store = new Map();
let etagSeq = 0;
const r2 = {
	async get(k, opts) {
		const o = store.get(k);
		if (!o) return null;
		const obj = { size: o.bytes.byteLength, httpEtag: `"${o.etag}"`, uploaded: o.uploaded, json: async () => JSON.parse(new TextDecoder().decode(o.bytes)) };
		if (opts?.onlyIf?.get?.("if-none-match") === obj.httpEtag) return obj;   // body 無し＝条件不成立
		return { ...obj, body: new Blob([o.bytes]).stream() };
	},
	async put(k, v) { store.set(k, { bytes: typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v), etag: `e${++etagSeq}`, uploaded: new Date() }); },
	async delete(k) { store.delete(k); },
};
const env = { QUAKES: r2 };
const csvKeys = () => [...store.keys()].filter(k => k.startsWith("recent/")).sort();
const manifest = () => JSON.parse(new TextDecoder().decode(store.get("recent.json").bytes));

// ── 偽 USGS：1 日 perDay 件。bigMonth の月だけ 25,000 件 ──────────────────────
const HEAD = "time,latitude,longitude,depth,mag,magType,nst,gap,dmin,rms,net,id,updated,place,type";
let calls = 0, ranges = [], script = [];
function usgs({ perDay = 3, bigMonth = null } = {}) {
	return async url => {
		calls++;
		if (script.length) { const s = script.shift(); if (s) return s(); }
		const q = new URL(url).searchParams;
		const s = Date.parse(q.get("starttime") + "Z"), e = Date.parse(q.get("endtime") + "Z") + 1000, limit = +q.get("limit");
		ranges.push([s, e]);
		const rows = [];
		for (let d = Math.floor(s / 864e5) * 864e5; d < e && rows.length < limit; d += 864e5) {
			const n = bigMonth && new Date(d).toISOString().startsWith(bigMonth) ? Math.ceil(25000 / 30) : perDay;
			for (let i = 0; i < n && rows.length < limit; i++) {
				const t = d + Math.floor(i * 864e5 / n / 1000) * 1000;
				if (t < s || t >= e) continue;
				rows.push(`${new Date(t).toISOString()},${35 + i % 10 * 0.1},${139 + i % 7 * 0.1},${10 + i % 5},${(2 + i % 30 / 10).toFixed(1)},ml,,,,,us,us${t}_${i},,"Somewhere, Japan",earthquake`);
			}
		}
		return rows.length ? new Response(HEAD + "\n" + rows.join("\n") + "\n") : new Response(null, { status: 204 });
	};
}
const noSleep = async () => {};
const run = (now, opts = {}) => build(env, now, { fetchImpl: usgs(opts), sleep: noSleep, ...opts });
const get = (p, headers) => serve(new Request("https://www.ortho-earth.com/quakes" + p, { headers }), env);
let fail = 0;
const ok = (name, cond, got) => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${got !== undefined ? "  (" + got + ")" : ""}`); };
const log = console.log;
console.log = (...a) => a[0]?.startsWith?.("[quakes-mirror]") || log(...a);
console.warn = console.error = () => {};
const days = (a, b) => (b - a) / 864e5;

const T0 = Date.UTC(2026, 8, 19, 3, 17);   // 2026-09-19 03:17 UTC

ok("empty → 503", (await get("/recent.json")).status === 503);

// 1) 初回：2025-09-01〜2026-09-01（先月末まで）の 12 か月を 3 か月ずつ
calls = 0;
const steps = [];
for (let i = 0; i < 6; i++) steps.push(await run(T0 + i * 3600e3));
ok("split into runs of 3 months", steps.join() === "partial,partial,partial,stored,fresh,fresh", steps.join());
ok("one request per month", calls === 12, calls);
let m = manifest();
ok("window 2025-09-01..2026-09-01", m.start === "2025-09-01" && m.end === "2026-09-01", `${m.start}..${m.end}`);
ok("rows = 3/day", m.windows.reduce((n, w) => n + w.rows, 0) === days(Date.UTC(2025, 8, 1), Date.UTC(2026, 8, 1)) * 3);
ok("12 CSV objects", csvKeys().length === 12, csvKeys().length);

// 2) 翌月：Aug（取得が月末＋30 日前＝未確定）を取り直し＋Sep を新規。Jul 以前は確定
calls = 0; ranges = [];
ok("next month → stored", (await run(Date.UTC(2026, 9, 1, 0, 17))) === "stored");
const mo = ([s]) => new Date(s).toISOString().slice(0, 7);
ok("refetched Aug + new Sep only", ranges.map(mo).join() === "2026-08,2026-09", ranges.map(mo).join());
ok("rolled start (dropped 2025-09)", manifest().start === "2025-10-01" && !csvKeys().some(k => k.startsWith("recent/20250901")));
calls = 0;
ok("same month → fresh", (await run(Date.UTC(2026, 9, 9))) === "fresh" && calls === 0, calls);
calls = 0; ranges = [];
await run(Date.UTC(2026, 10, 1, 0, 17));
ok("Nov: Sep refetched once more, Aug final", ranges.map(mo).join() === "2026-09,2026-10", ranges.map(mo).join());

// 3) archive を置く＝起点が進み、archive に入った月の CSV を消す
await r2.put("archive.json", JSON.stringify({ start: "1967-01-01", end: "2026-03-01" }));
await run(Date.UTC(2026, 10, 2));
ok("archive moved → recent starts at archive end", manifest().start === "2026-03-01" && csvKeys()[0].startsWith("recent/20260301"), csvKeys()[0]);

// 4) 20,000 件上限の月は二分して複数本
for (const k of [...store.keys()]) if (k !== "archive.json") store.delete(k);
await r2.put("archive.json", JSON.stringify({ end: "2026-06-01" }));
ranges = [];
while ((await run(T0, { bigMonth: "2026-07" })) === "partial");
const jul = manifest().windows.filter(w => mo([w.from]) === "2026-07");
ok("big July split into 2 files", jul.length === 2 && ranges.filter(r => mo(r) === "2026-07").length === 3, jul.length);
ok("rows exact after split", jul.reduce((n, w) => n + w.rows, 0) === 31 * Math.ceil(25000 / 30));

// 5) 失敗：済んだ月は目次に残り、次回は続きから
for (const k of [...store.keys()]) if (k !== "archive.json") store.delete(k);
await r2.put("archive.json", JSON.stringify({ end: "2026-03-01" }));
script = [null, () => new Response("slow down", { status: 429 })];   // 1 本目は通常・2 本目で 429
calls = 0;
ok("429 → error", (await run(T0)) === "error");
ok("first month kept in manifest", manifest().windows.length === 1, manifest().windows.length);
calls = 0;
while ((await run(T0 + 3600e3)) === "partial");
ok("resumed without refetching kept month", calls === 5 && manifest().windows.length === 6, `${calls} calls, ${manifest().windows.length} windows`);
ok("400 → error", (await build(env, Date.UTC(2026, 11, 1), { fetchImpl: async () => new Response("bad", { status: 400 }), sleep: noSleep })) === "error");

// 6) 配信
const man = await get("/recent.json");
ok("recent.json + CORS", man.status === 200 && man.headers.get("access-control-allow-origin") === "*");
const w0 = (await man.json()).windows[0];
const c = await get(`/${w0.key}?v=${w0.fetchedAt}`);
ok("csv served as text/plain (edge-compressible), long cache", c.status === 200 && /text\/plain/.test(c.headers.get("content-type")) && /max-age=2592000/.test(c.headers.get("cache-control")));
ok("csv body is USGS CSV", (await c.text()).startsWith("time,latitude"));
const etag = (await get(`/${w0.key}`)).headers.get("etag");
ok("If-None-Match → 304", (await get(`/${w0.key}`, { "If-None-Match": etag })).status === 304);
ok("missing csv → 404", (await get("/recent/20000101T000000_20000201T000000.csv")).status === 404);
ok("path traversal-ish → 404", (await get("/recent/../archive.json")).status === 404 && (await get("/archive.json")).status === 404);
ok("status", (await (await get("/status")).json()).recent.months === 6);
ok("POST → 405", (await serve(new Request("https://www.ortho-earth.com/quakes/status", { method: "POST" }), env)).status === 405);

// 7) 読み手：quakes-worker.js に archive（GeoPBF）＋recent.json を渡す → 連結件数が一致
const archCols = parseCsvTexts([HEAD + "\n" + `2020-01-01T00:00:00.000Z,35,139,10,5.5,mw,,,,,us,a1,,"x",earthquake\n2020-02-01T00:00:00.000Z,36,140,20,,mw,,,,,us,a2,,"no mag",earthquake\n`]);
await r2.put("archive.geopbf", await buildGeoPBF(archCols, { minmag: 2, start: "1967-01-01", end: "2026-02-28" }));
globalThis.self = {};
globalThis.fetch = async u => serve(new Request(new URL(u, "https://www.ortho-earth.com/")), env);
await import("../../ortho-japan/quakes-worker.js");
const view = srcs => new Promise(res => { self.postMessage = m => m.type !== "progress" && res(m); self.onmessage({ data: { srcs } }); });
const recentRows = manifest().windows.reduce((n, w) => n + w.rows, 0);
const both = await view(["https://www.ortho-earth.com/quakes/archive.geopbf", "https://www.ortho-earth.com/quakes/recent.json"]);
ok("viewer: archive + recent concatenated (mag 無しは落とす)", both.type === "done" && both.n === 1 + recentRows, `${both.n} vs ${1 + recentRows}`);
ok("viewer: sorted by magnitude", both.attr[0] <= both.attr[(both.n - 1) * 3]);
store.delete("recent.json");
const onlyArch = await view(["https://www.ortho-earth.com/quakes/archive.geopbf", "https://www.ortho-earth.com/quakes/recent.json"]);
ok("viewer: recent missing → archive only", onlyArch.type === "done" && onlyArch.n === 1, onlyArch.n);

log(fail ? `\n${fail} FAILED` : "\nall ok");
process.exit(fail ? 1 : 0);
