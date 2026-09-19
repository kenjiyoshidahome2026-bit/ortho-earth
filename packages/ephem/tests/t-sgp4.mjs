#!/usr/bin/env node
// SGP4/SDP4 の常設検定＝参照実装（Vallado sgp4unit）との照合。標本は tests/sgp4-fixture.json（CelesTrak の実要素 9 機×6 時刻・
// 期待値は satellite.js 7.1.0＝同じ参照実装の JS 移植で一度だけ焼いた。実行時の依存ではない）。
// 近地球（ISS・Starlink）＋深宇宙の三つの枝（共鳴なし・一日共鳴＝静止・半日共鳴＝モルニア/長楕円）＋低傾斜（Lyddane）を網羅。
// 許容 1 m（実測は全 active 16,583 機×±1 週間で最大 1.7 cm＝2026-09-19。式を一つ取り違えると km 単位で外れる＝zmol の轍）。
import fs from "node:fs";
import { parseOMM, parseTLE, sgp4init, sgp4, propagate, gmst, temeToGeodetic, jdOf } from "../src/sgp4.js";

const fix = JSON.parse(fs.readFileSync(new URL("./sgp4-fixture.json", import.meta.url), "utf8"));
let fail = 0;
const check = (name, got, limit, unit) => {
	const ok = got <= limit; if (!ok) fail++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(40)} ${got.toFixed(4)} ${unit}  (limit ${limit} ${unit})`);
};

for (const c of fix.cases) {
	const s = sgp4init(parseOMM(c.omm));
	const err = Math.max(...c.t.map((m, k) => { const p = sgp4(s, m); return p ? Math.hypot(p.r[0] - c.r[k][0], p.r[1] - c.r[k][1], p.r[2] - c.r[k][2]) : Infinity; }));
	check(`${c.omm.OBJECT_NAME} [${s.method}${s.method === "d" ? " irez" + s.irez : ""}]`, err * 1000, 1, "m");
}

// CSV 由来（全部文字列・".123E-4" 形）でも同じ値＝CelesTrak の CSV を parseOMM に直接渡せる
const iss = fix.cases[0].omm;
const asStr = Object.fromEntries(Object.entries(iss).map(([k, v]) => [k, String(v)]));
const a = sgp4(sgp4init(parseOMM(iss)), 90), b = sgp4(sgp4init(parseOMM(asStr)), 90);
check("CSV strings == JSON numbers", Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]) * 1000, 1e-6, "m");

// TLE の読み（Vallado の検定用 00005＝1958-002B）：元期で r は既知値
const tle = parseTLE(
	"1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753",
	"2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667");
const r0 = sgp4(sgp4init(tle), 0).r;
check("TLE 00005 r(t=0) vs Vallado", Math.hypot(r0[0] - 7022.46529266, r0[1] + 1400.08296755, r0[2] - 0.03995155), 1e-3, "km");

// 地上位置：ISS の高度は 370〜440 km に入る（GMST と TEME→測地の向きの取り違えを捕まえる粗い網）
const sIss = sgp4init(parseOMM(iss)), jd = sIss.jdEpoch + 0.3;
const g = temeToGeodetic(propagate(sIss, jd).r, gmst(jd));
check("ISS altitude out of 370-440 km", g.h < 370 ? 370 - g.h : g.h > 440 ? g.h - 440 : 0, 0, "km");
check("jdOf(Date) round trip", Math.abs(jdOf(new Date(Date.UTC(2000, 0, 1, 12))) - 2451545) * 86400, 1e-6, "s");

console.log(fail ? `\n${fail} FAILED` : "\nall ok");
process.exit(fail ? 1 : 0);
