#!/usr/bin/env node
// 世界時計（/globe/clock）段 0＝データの照合：「国（admin0）× NE の時間帯の面」の組を全部数え、各組がどの名前に決まるか（clock-zones.ts の resolve）と、
// NE の面の UTC との差（2012 年）と今の標準時の差の食い違いを一覧にする＝手直しの表（clock-zones.ts の OVERRIDE）の大きさをここで測る。
// 組は格子の点（既定 0.5°）で数える＝面積の目安（小さな島は落ちる）。ブラウザは要らない・データは NE の生 zip を展開した物を渡す：
//   curl -sSO https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_time_zones.zip && unzip -o ne_10m_time_zones.zip -d tz
//   curl -sSO https://naturalearth.s3.amazonaws.com/50m_cultural/ne_50m_admin_0_countries.zip && unzip -o ne_50m_admin_0_countries.zip -d a0
//   node scripts/clock-audit.mjs tz/ne_10m_time_zones a0/ne_50m_admin_0_countries [step°] > scripts/clock-audit.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResolver, standardMin, utcLabel } from "../clock-zones.ts";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [tzBase, a0Base, stepArg] = process.argv.slice(2);
if (!tzBase || !a0Base) { console.error("usage: clock-audit.mjs <ne_10m_time_zones base> <ne_50m_admin_0_countries base> [step]"); process.exit(2); }
const STEP = +(stepArg || 0.5);

function readDbf(file) {
	const b = fs.readFileSync(file); const n = b.readUInt32LE(4), hl = b.readUInt16LE(8), rl = b.readUInt16LE(10);
	const fields = []; for (let o = 32; b[o] !== 0x0d; o += 32) fields.push({ name: b.toString("latin1", o, o + 11).replace(/\0.*$/, ""), type: String.fromCharCode(b[o + 11]), len: b[o + 16] });
	const rows = []; for (let i = 0; i < n; i++) { let o = hl + i * rl + 1; const r = {}; for (const f of fields) { let v = b.toString("utf8", o, o + f.len).replace(/\0+/g, "").trim(); if (f.type === "N" || f.type === "F") v = v === "" ? null : +v; r[f.name] = v; o += f.len; } rows.push(r); }
	return rows;
}
// shp の面（type 5）＝外周と穴の輪を偶奇で数える（点が輪の中にある回数の奇偶）
function readShp(file) {
	const b = fs.readFileSync(file); const out = []; let o = 100;
	while (o < b.length) {
		const len = b.readInt32BE(o + 4) * 2; const r = o + 8; const type = b.readInt32LE(r);
		if (type === 5) {
			const bbox = [b.readDoubleLE(r + 4), b.readDoubleLE(r + 12), b.readDoubleLE(r + 20), b.readDoubleLE(r + 28)];
			const np = b.readInt32LE(r + 36), nPts = b.readInt32LE(r + 40);
			const parts = []; for (let i = 0; i < np; i++) parts.push(b.readInt32LE(r + 44 + i * 4));
			const p0 = r + 44 + np * 4; const xy = new Float64Array(nPts * 2);
			for (let i = 0; i < nPts * 2; i++) xy[i] = b.readDoubleLE(p0 + i * 8);
			const rings = parts.map((s, i) => xy.subarray(s * 2, (i + 1 < np ? parts[i + 1] : nPts) * 2));
			out.push({ bbox, rings: rings.map(ring => ({ ring, bb: bbOf(ring) })) });
		} else out.push(null);
		o = r + len;
	}
	return out;
}
const bbOf = ring => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (let i = 0; i < ring.length; i += 2) { a = Math.min(a, ring[i]); c = Math.max(c, ring[i]); b = Math.min(b, ring[i + 1]); d = Math.max(d, ring[i + 1]); } return [a, b, c, d]; };
function inside(poly, x, y) {
	if (!poly || x < poly.bbox[0] || x > poly.bbox[2] || y < poly.bbox[1] || y > poly.bbox[3]) return false;
	let c = false;
	for (const { ring, bb } of poly.rings) {
		if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
		for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
			const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
			if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
		}
	}
	return c;
}
const firstHit = (polys, x, y) => { for (let i = 0; i < polys.length; i++) if (inside(polys[i], x, y)) return i; return -1; };

const tzRows = readDbf(tzBase + ".dbf"), tzPolys = readShp(tzBase + ".shp");
const a0Rows = readDbf(a0Base + ".dbf"), a0Polys = readShp(a0Base + ".shp");
const table = JSON.parse(fs.readFileSync(path.join(APP, "clock-zones.json"), "utf8"));
const resolve = createResolver(table);
const date = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 15, 12));
const Y = date.getUTCFullYear();

const pairs = new Map();   // "a3|tzIdx" → count
for (let y = -89.875; y < 90; y += STEP) for (let x = -179.875; x < 180; x += STEP) {
	const c = firstHit(a0Polys, x, y); if (c < 0) continue;
	const z = firstHit(tzPolys, x, y);
	const k = `${c}|${z}`; pairs.set(k, (pairs.get(k) ?? 0) + 1);
}

const rows = [];
for (const [k, n] of pairs) {
	const [c, z] = k.split("|").map(Number);
	const a = a0Rows[c], t = z >= 0 ? tzRows[z] : null;
	const place = { a3: a.ADM0_A3, iso2: a.ISO_A2_EH, zone: t?.zone ?? null, tz: t?.tz_name1st ?? null };
	const r = resolve(place, date);
	const std = r.tz ? standardMin(r.tz, Y) : r.fixed;
	const delta = t ? std - Math.round(t.zone * 60) : 0;
	rows.push({ a3: a.ADM0_A3, name: a.NAME_EN, ne: t ? t.zone : null, neTz: t?.tz_name1st || "", tz: r.tz || utcLabel(r.fixed), how: r.how, std, delta, n });
}
rows.sort((p, q) => p.a3.localeCompare(q.a3) || (p.ne ?? 99) - (q.ne ?? 99));
const nCountries = new Set(rows.map(r => r.a3)).size;
const off = rows.filter(r => r.delta !== 0);
const by = h => rows.filter(r => r.how === h).length;
console.log(`# 世界時計 段 0：国 × NE の時間帯の面（${new Date().toISOString().slice(0, 10)}）`);
console.log(`\n格子 ${STEP}°・admin0 50m × NE 10m time zones・標準時は ${Y} 年の 1 月と 7 月の小さい方（tzdata＝${process.versions.tz ?? "?"}）。生成＝scripts/clock-audit.mjs。\n`);
console.log(`- 組 ${rows.length}（国 ${nCountries}）。決め方：country ${by("country")}・override ${by("override")}・ne-name ${by("ne-name")}・offset ${by("offset")}・nearest ${by("nearest")}・ne-offset ${by("ne-offset")}・antarctica ${by("antarctica")}・none ${by("none")}`);
console.log(`- NE の面の差（2012）と決まった名前の今の標準時が食い違う組 ${off.length}（＝NE が古い所。決まった名前が正しいので時刻は正しい）`);
console.log(`- 手直しの表（OVERRIDE）が直す組 ${by("override")}`);
console.log(`\n## 食い違う組（NE ≠ 今）\n\n| 国 | NE の面 | NE の名前 | 決まった名前 | 決め方 | 今の標準時 | 点 |\n|---|---|---|---|---|---|---|`);
for (const r of off) console.log(`| ${r.name} (${r.a3}) | ${r.ne == null ? "—" : utcLabel(Math.round(r.ne * 60))} | ${r.neTz} | ${r.tz} | ${r.how} | ${utcLabel(r.std)} | ${r.n} |`);
console.log(`\n## 時間帯が複数ある国の組（決め方が country 以外）\n\n| 国 | NE の面 | NE の名前 | 決まった名前 | 決め方 | 点 |\n|---|---|---|---|---|---|`);
for (const r of rows.filter(r => !["country", "antarctica"].includes(r.how))) console.log(`| ${r.name} (${r.a3}) | ${r.ne == null ? "—" : utcLabel(Math.round(r.ne * 60))} | ${r.neTz} | ${r.tz} | ${r.how} | ${r.n} |`);
