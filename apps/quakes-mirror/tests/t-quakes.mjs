#!/usr/bin/env node
// quakes-mirror の検定＝偽 R2＋偽 USGS（合成 CSV）。USGS へは一度も触れない。
//   配信：空は 503 → archive.geopbf / archive.json / status → CORS → ETag 一致で 304 → 知らない道は 404 → POST は 405
//   読み手：apps/ortho-globe/quakes-worker.js に archive（GeoPBF）＋USGS 直取り（偽 USGS）を渡し、月ごとに届いて件数が合うこと・USGS 落ちは archive だけで出す
//   node apps/quakes-mirror/tests/t-quakes.mjs
import { serve } from "../worker.js";
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
const get = (p, headers) => serve(new Request("https://www.ortho-earth.com/quakes" + p, { headers }), env);
let fail = 0;
const ok = (name, cond, got) => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${got !== undefined ? "  (" + got + ")" : ""}`); };
const log = console.log;
console.warn = console.error = () => {};
const days = (a, b) => (b - a) / 864e5;

// 1) 配信
ok("empty → 503", (await get("/archive.json")).status === 503 && (await get("/archive.geopbf")).status === 503);
ok("status (empty)", (await (await get("/status")).json()).archive === null);
ok("unknown → 404", (await get("/recent.json")).status === 404 && (await get("/recent/x.csv")).status === 404);
ok("POST → 405", (await serve(new Request("https://www.ortho-earth.com/quakes/status", { method: "POST" }), env)).status === 405);
ok("OPTIONS → 204 + CORS", (await serve(new Request("https://www.ortho-earth.com/quakes/archive.geopbf", { method: "OPTIONS" }), env)).headers.get("access-control-allow-origin") === "*");

// 2) 読み手：quakes-worker.js に archive（GeoPBF）＋{ usgs: archive.json }（USGS 直取り＝偽 USGS）を渡す
//    → 層ごとに part が届き（直近分は月ごとに増える）、最後の part の合計が archive＋起点〜今の件数と一致
const archCols = parseCsvTexts([HEAD + "\n" + `2020-01-01T00:00:00.000Z,35,139,10,5.5,mw,,,,,us,a1,,"x",earthquake\n2020-02-01T00:00:00.000Z,36,140,20,,mw,,,,,us,a2,,"no mag",earthquake\n`]);
await r2.put("archive.geopbf", await buildGeoPBF(archCols, { minmag: 2, start: "1967-01-01", end: "2026-05-31" }));
await r2.put("archive.json", JSON.stringify({ start: "1967-01-01", end: "2026-06-01" }));
ok("archive.json served + CORS", (await (await get("/archive.json")).json()).end === "2026-06-01" && (await get("/archive.json")).headers.get("access-control-allow-origin") === "*");
ok("status", (await (await get("/status")).json()).archive.end === "2026-06-01");
const arch = await get("/archive.geopbf");
ok("archive.geopbf served, long cache", arch.status === 200 && /max-age=86400/.test(arch.headers.get("cache-control")) && +arch.headers.get("content-length") > 0);
ok("If-None-Match → 304", (await get("/archive.geopbf", { "If-None-Match": arch.headers.get("etag") })).status === 304);
ok("HEAD → no body", (await serve(new Request("https://www.ortho-earth.com/quakes/archive.geopbf", { method: "HEAD" }), env)).body === null);
const fakeUsgs = usgs();
let usgsCalls = 0, usgsDown = false;
globalThis.self = {};
globalThis.fetch = async u => {
	u = String(u);
	if (u.startsWith("https://earthquake.usgs.gov/")) { usgsCalls++; return usgsDown ? new Response("down", { status: 503 }) : fakeUsgs(u); }
	return serve(new Request(new URL(u, "https://www.ortho-earth.com/")), env);
};
await import("../../ortho-globe/quakes-worker.js");
const NOW = Date.UTC(2026, 8, 19, 7, 0);   // 2026-09-19 07:00＝6 月〜8 月＋9 月途中
const view = srcs => new Promise(res => {
	const parts = [], last = [];
	self.postMessage = m => { if (m.type === "part") { parts.push(m.q); last[m.q] = m.n; } if (m.type === "done" || m.type === "error") res({ ...m, parts, last }); };
	self.onmessage({ data: { srcs, now: NOW } });
});
const SRCS = ["https://www.ortho-earth.com/quakes/archive.geopbf", { usgs: "https://www.ortho-earth.com/quakes/archive.json" }];
const recentRows = days(Date.UTC(2026, 5, 1), Date.UTC(2026, 8, 19)) * 3 + 1;   // 偽 USGS＝1 日 3 件（0・8・16 時）＝9/19 は 7:00 までに 1 件
const both = await view(SRCS);
const got = both.last.reduce((a, n) => a + n, 0);
ok("viewer: archive + USGS direct (mag 無しは落とす)", both.type === "done" && got === 1 + recentRows && both.n === got, `${got} vs ${1 + recentRows}`);
ok("viewer: USGS layer arrives month by month", both.parts.filter(q => q === 1).length === 4, both.parts.join());
ok("viewer: one USGS request per month", usgsCalls === 4, usgsCalls);
usgsDown = true;
const down = await view(SRCS);
ok("viewer: USGS down → archive only + skipped", down.type === "done" && down.n === 1 && down.skipped.join() === "2026-06,2026-07,2026-08,2026-09", `${down.n} ${down.skipped}`);

log(fail ? `\n${fail} FAILED` : "\nall ok");
process.exit(fail ? 1 : 0);
