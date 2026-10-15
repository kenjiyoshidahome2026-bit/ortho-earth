#!/usr/bin/env node
// quakes-mirror の検定＝偽 R2（合成 CSV を焼いた archive）。USGS へは一度も触れない。
//   配信：空は 503 → archive.geopbf / archive.json / status → CORS → ETag 一致で 304 → 知らない道は 404 → POST は 405
//   読み手（globe の quakes-worker.js）の検定は apps/ortho-globe/tests/t-quakes-reader.mjs（形の約束＝packages/quakes/src/usgs.js・2026-10-15 に分けた＝アプリはアプリを読まない）
//   node apps/quakes-mirror/tests/t-quakes.mjs
import { serve } from "../worker.js";
import { buildGeoPBF, parseCsvTexts } from "../../../packages/quakes/src/usgs.js";

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

const HEAD = "time,latitude,longitude,depth,mag,magType,nst,gap,dmin,rms,net,id,updated,place,type";
const get = (p, headers) => serve(new Request("https://www.ortho-earth.com/quakes" + p, { headers }), env);
let fail = 0;
const ok = (name, cond, got) => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${got !== undefined ? "  (" + got + ")" : ""}`); };
const log = console.log;
console.warn = console.error = () => {};

// 1) 配信
ok("empty → 503", (await get("/archive.json")).status === 503 && (await get("/archive.geopbf")).status === 503);
ok("status (empty)", (await (await get("/status")).json()).archive === null);
ok("unknown → 404", (await get("/recent.json")).status === 404 && (await get("/recent/x.csv")).status === 404);
ok("POST → 405", (await serve(new Request("https://www.ortho-earth.com/quakes/status", { method: "POST" }), env)).status === 405);
ok("OPTIONS → 204 + CORS", (await serve(new Request("https://www.ortho-earth.com/quakes/archive.geopbf", { method: "OPTIONS" }), env)).headers.get("access-control-allow-origin") === "*");

// 2) 中身あり：archive.geopbf・archive.json を置いて配る
const archCols = parseCsvTexts([HEAD + "\n" + `2020-01-01T00:00:00.000Z,35,139,10,5.5,mw,,,,,us,a1,,"x",earthquake\n2020-02-01T00:00:00.000Z,36,140,20,,mw,,,,,us,a2,,"no mag",earthquake\n`]);
await r2.put("archive.geopbf", await buildGeoPBF(archCols, { minmag: 2, start: "1967-01-01", end: "2026-05-31" }));
await r2.put("archive.json", JSON.stringify({ start: "1967-01-01", end: "2026-06-01" }));
ok("archive.json served + CORS", (await (await get("/archive.json")).json()).end === "2026-06-01" && (await get("/archive.json")).headers.get("access-control-allow-origin") === "*");
ok("status", (await (await get("/status")).json()).archive.end === "2026-06-01");
const arch = await get("/archive.geopbf");
ok("archive.geopbf served, long cache", arch.status === 200 && /max-age=86400/.test(arch.headers.get("cache-control")) && +arch.headers.get("content-length") > 0);
ok("If-None-Match → 304", (await get("/archive.geopbf", { "If-None-Match": arch.headers.get("etag") })).status === 304);
ok("HEAD → no body", (await serve(new Request("https://www.ortho-earth.com/quakes/archive.geopbf", { method: "HEAD" }), env)).body === null);
log(fail ? `\n${fail} FAILED` : "\nall ok");
process.exit(fail ? 1 : 0);
