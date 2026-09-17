#!/usr/bin/env node
// ephem の常設検定＝一次資料（JPL Horizons）との照合。solar と japan の太陽系圏が同じ臓器に乗っている＝
// ここが狂うと両方が黙って狂う（2026-09-18：月だけ「日付の黄道」のままだった 0.37° のズレをこの照合で発見）。
// 標本は tests/horizons-fixture.json（取得手順は source 欄）。許容は実測誤差の約 2 倍＝理論の限界でなく「退行の検知線」。
//   惑星の日心方向   JPL 近似軌道要素の素性（土星が最大 0.17°＝大不等項を持たないため）
//   月の地心方向     Schlyter 月理論＋J2000 への歳差補正（実測 0.06° 以内）
//   ガリレオ衛星     円軌道モデル（実測 最大 1.2°＝離心率と秤動を捨てた分）
import fs from "node:fs";
import { bodyPos, moonGeo, satRel, satPos, orientation, SATELLITES, AU_KM } from "../src/index.js";

const fix = JSON.parse(fs.readFileSync(new URL("./horizons-fixture.json", import.meta.url), "utf8"));
const ang = (a, b) => Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b))) * 180 / Math.PI;
let fail = 0;
const check = (name, got, limit, unit = "°") => {
	const ok = got <= limit; if (!ok) fail++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(34)} ${got.toFixed(3)}${unit}  (limit ${limit}${unit})`);
};

for (const [id, rows] of Object.entries(fix.bodies)) {
	if (id === "moon") continue;
	check(`${id} heliocentric direction`, Math.max(...rows.map((h, i) => ang(bodyPos(id, new Date(fix.dates[i])), h))), 0.35);
	check(`${id} heliocentric distance`, Math.max(...rows.map((h, i) => Math.abs(Math.hypot(...bodyPos(id, new Date(fix.dates[i]))) / Math.hypot(...h) - 1) * 100)), 0.6, "%");
}
const moonH = i => fix.bodies.moon[i].map((v, j) => v - fix.bodies.earth[i][j]);
check("moon geocentric direction", Math.max(...fix.dates.map((d, i) => ang(moonGeo(new Date(d)), moonH(i)))), 0.12);
check("moon geocentric distance", Math.max(...fix.dates.map((d, i) => Math.abs(Math.hypot(...moonGeo(new Date(d))) / Math.hypot(...moonH(i)) - 1) * 100)), 0.5, "%");
for (const [id, rows] of Object.entries(fix.sats)) {
	check(`${id} jovicentric direction`, Math.max(...rows.map((h, i) => ang(satRel(id, new Date(fix.dates[i])), h))), 2.0);
	check(`${id} jovicentric distance`, Math.max(...rows.map((h, i) => Math.abs(Math.hypot(...satRel(id, new Date(fix.dates[i]))) * AU_KM / Math.hypot(...h) - 1) * 100)), 1.5, "%");
}

// 2026-08-12 皆既日食（最大食 17:46 UT）：月影の軸が地心から何地球半径を通るか＝γ。NASA の食要素は γ=0.8977
// （北寄りをかすめる食）。月が 0.37° ずれていた頃は γ≈0.5 になっていた＝影が 2,500km 南へ落ちる。
{
	const d = new Date("2026-08-12T17:46:00Z"), e = bodyPos("earth", d), m = moonGeo(d);
	const s = [e[0] + m[0], e[1] + m[1], e[2] + m[2]], sl = Math.hypot(...s), u = s.map(v => v / sl);   // 太陽→月の向き＝影の軸
	const t = m[0] * u[0] + m[1] * u[1] + m[2] * u[2], perp = [m[0] - t * u[0], m[1] - t * u[1], m[2] - t * u[2]];
	check("2026-08-12 eclipse: |gamma - 0.8977|", Math.abs(Math.hypot(...perp) * AU_KM / 6378.14 - 0.8977), 0.03, "");
}
// 同期自転＝本初子午線（体固定 +x）が木星を向く。IAU の W0 の写し間違いを捕まえる網（秤動と円軌道の粗さで数°は動く）
for (const b of SATELLITES) {
	const d = new Date("2026-01-01T00:00:00Z"), M = orientation(b.id, d), x = [M[0][0], M[1][0], M[2][0]];
	check(`${b.id} prime meridian faces Jupiter`, ang(x, satRel(b.id, d).map(v => -v)), 6);
}
{
	const d = new Date("2026-01-01T00:00:00Z"), j = bodyPos("jupiter", d), p = satPos("io", d);
	check("satPos = parent + satRel", Math.abs(Math.hypot(p[0] - j[0], p[1] - j[1], p[2] - j[2]) * AU_KM - 421745), 1, " km");
}
console.log(fail ? `\nFAIL  ${fail}` : "\nPASS");
process.exit(fail ? 1 : 0);
