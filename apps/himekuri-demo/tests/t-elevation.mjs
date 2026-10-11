// 標高の取り方の順と、地理院 .txt タイルの読み（モック fetch＝器は外部網が閉じている）
import assert from "node:assert/strict";
import { lookupElevation, tileXY, pickGsiTxt } from "../src/elevation.js";
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const res = (ok, body) => ({ ok, json: async () => body, text: async () => body });
let n = 0;
// タイル座標（東京駅 z14 = 14552/6451）
{ const t = tileXY(35.6812, 139.7671, 14); assert.equal(t.x, 14552); assert.equal(t.y, 6451); assert.ok(t.px >= 0 && t.px < 256 && t.py >= 0 && t.py < 256); n += 3; }
// .txt の読み（'e'＝無効）
{ const txt = "1,2,3\n4,e,6\n7,8,9"; assert.equal(pickGsiTxt(txt, 2, 1), 6); assert.equal(pickGsiTxt(txt, 1, 1), null); assert.equal(pickGsiTxt(txt, 0, 5), null); n += 3; }
// ① Open-Meteo が答えればそれ
{ const calls = []; const f = async u => { calls.push(u); return u.includes("open-meteo") ? res(true, { elevation: [3776.2] }) : res(false); };
	const r = await lookupElevation(35.3606, 138.7274, { fetchFn: f, storage: mem() }); assert.equal(r.source, "open-meteo"); assert.equal(r.elevation, 3776.2); assert.equal(calls.length, 1); n += 3; }
// ② Open-Meteo が落ちたら地理院（日本＝dem5a → dem）
{ const f = async u => u.includes("open-meteo") ? res(false) : u.includes("/dem5a/") ? res(true, "e,e\ne,e") : u.includes("/dem/") ? res(true, Array(256).fill(Array(256).fill("12.5").join(",")).join("\n")) : res(false);
	const r = await lookupElevation(35.6812, 139.7671, { fetchFn: f, storage: mem() }); assert.equal(r.source, "dem"); assert.equal(r.elevation, 12.5); n += 2; }
// ② 国外＝demgm（全球）
{ const urls = []; const f = async u => { urls.push(u); return u.includes("/demgm/") ? res(true, Array(256).fill(Array(256).fill("30").join(",")).join("\n")) : res(false); };
	const r = await lookupElevation(21.3069, -157.8583, { fetchFn: f, storage: mem() }); assert.equal(r.source, "demgm"); assert.equal(r.elevation, 30); assert.ok(urls.some(u => u.includes("/demgm/8/")) && !urls.some(u => u.includes("dem5a")), "global tile only"); n += 3; }
// ③ 何も取れなければ GPS の高度、それも無ければ 0
{ const f = async () => { throw new Error("offline"); };
	const r = await lookupElevation(21.3, -157.8, { fetchFn: f, storage: mem(), gpsAlt: 41.7 }); assert.equal(r.source, "gps"); assert.equal(r.elevation, 42);
	const z = await lookupElevation(21.3, -157.8, { fetchFn: f, storage: mem() }); assert.equal(z.source, "none"); assert.equal(z.elevation, 0); n += 4; }
// 記憶＝同じ場所は二度叩かない
{ let calls = 0; const f = async () => { calls++; return res(true, { elevation: [5] }); }; const st = mem();
	await lookupElevation(35.0, 135.0, { fetchFn: f, storage: st }); const r = await lookupElevation(35.0002, 135.0003, { fetchFn: f, storage: st }); assert.equal(calls, 1); assert.equal(r.cached, true); n += 2; }
console.log(`t-elevation: ${n} checks OK`);
