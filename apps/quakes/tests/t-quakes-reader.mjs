#!/usr/bin/env node
// 地震ビューアの読み手（quakes-worker.js）の検定＝偽の配信（archive.geopbf・archive.json）＋偽 USGS（合成 CSV）。外へは一度も触れない。
//   archive（GeoPBF）＋{ usgs: archive.json }（USGS 直取り）を渡し、月ごとに届いて件数が合うこと・USGS 落ちは archive だけで出す。
//   形の約束（GeoPBF の焼き方・archive.json の end）は apps/quakes/usgs.js（焼く scripts/usgs-quakes-build.mjs と読む quakes-worker.js が共有）
//  （2026-10-15・旧＝apps/quakes-mirror/tests/t-quakes.mjs が globe の worker を直に読んでいた＝アプリはアプリを読まない）。
//   node apps/quakes/tests/t-quakes-reader.mjs
import { buildGeoPBF, parseCsvTexts } from "../usgs.js";

const HEAD = "time,latitude,longitude,depth,mag,magType,nst,gap,dmin,rms,net,id,updated,place,type";
// 偽 USGS：1 日 3 件（0・8・16 時）
function usgs(perDay = 3) {
	return async url => {
		const q = new URL(url).searchParams;
		const s = Date.parse(q.get("starttime") + "Z"), e = Date.parse(q.get("endtime") + "Z") + 1000, limit = +q.get("limit");
		const rows = [];
		for (let d = Math.floor(s / 864e5) * 864e5; d < e && rows.length < limit; d += 864e5) {
			for (let i = 0; i < perDay && rows.length < limit; i++) {
				const t = d + Math.floor(i * 864e5 / perDay / 1000) * 1000;
				if (t < s || t >= e) continue;
				rows.push(`${new Date(t).toISOString()},${35 + i % 10 * 0.1},${139 + i % 7 * 0.1},${10 + i % 5},${(2 + i % 30 / 10).toFixed(1)},ml,,,,,us,us${t}_${i},,"Somewhere, Japan",earthquake`);
			}
		}
		return rows.length ? new Response(HEAD + "\n" + rows.join("\n") + "\n") : new Response(null, { status: 204 });
	};
}
let fail = 0;
const ok = (name, cond, got) => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${got !== undefined ? "  (" + got + ")" : ""}`); };
const log = console.log;
console.warn = console.error = () => {};
const days = (a, b) => (b - a) / 864e5;

// 偽の配信（ミラーの /quakes/archive.*）：archive＝2 件（1 件は mag 無し＝読み手が落とす）
const archCols = parseCsvTexts([HEAD + "\n" + `2020-01-01T00:00:00.000Z,35,139,10,5.5,mw,,,,,us,a1,,"x",earthquake\n2020-02-01T00:00:00.000Z,36,140,20,,mw,,,,,us,a2,,"no mag",earthquake\n`]);
const files = new Map([
	["/quakes/archive.geopbf", await buildGeoPBF(archCols, { minmag: 2, start: "1967-01-01", end: "2026-05-31" })],
	["/quakes/archive.json", JSON.stringify({ start: "1967-01-01", end: "2026-06-01" })],
]);
const fakeUsgs = usgs();
let usgsCalls = 0, usgsDown = false;
globalThis.self = {};
globalThis.fetch = async u => {
	u = String(u);
	if (u.startsWith("https://earthquake.usgs.gov/")) { usgsCalls++; return usgsDown ? new Response("down", { status: 503 }) : fakeUsgs(u); }
	const body = files.get(new URL(u, "https://www.ortho-earth.com/").pathname);
	return body == null ? new Response("nf", { status: 404 }) : new Response(body);
};
await import("../quakes-worker.js");
const NOW = Date.UTC(2026, 8, 19, 7, 0);   // 2026-09-19 07:00＝6 月〜8 月＋9 月途中
const view = srcs => new Promise(res => {
	const parts = [], last = [];
	self.postMessage = m => { if (m.type === "part") { parts.push(m.q); last[m.q] = m.n; } if (m.type === "done" || m.type === "error") res({ ...m, parts, last }); };
	self.onmessage({ data: { srcs, now: NOW } });
});
const SRCS = ["https://www.ortho-earth.com/quakes/archive.geopbf", { usgs: "https://www.ortho-earth.com/quakes/archive.json" }];
const recentRows = days(Date.UTC(2026, 5, 1), Date.UTC(2026, 8, 19)) * 3 + 1;   // 9/19 は 7:00 までに 1 件
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
