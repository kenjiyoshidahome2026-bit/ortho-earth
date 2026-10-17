// flight.ts の時刻評価プラン（flyPlan・glidePlan・glidePathPlan）の検定。純関数＝外部データ不要・決定的。
//   ・端点：at(0)＝出発・at(dur)＝着地（経度は最短側・方位は最短回転・ズームの床）
//   ・fly の三段（水平へ→巡航→起こす）の境界と、巡航中のズームの下限
//   ・glide の時分割（移動→方位→チルト）と、変化の無いチャンネルを飛ばすこと
//   ・glidePath の通過保証（knots の時刻に各点を通る）と secs の尺
import { flyPlan, glidePlan, glidePathPlan, shortBearingOf } from "../src/flight.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const D2R = Math.PI / 180;
const env = { viewW: 1000, maxPitch: 60 * D2R, minZoom: 0 };
const cam = (o = {}) => ({ lon: 139.76, lat: 35.68, zoom: 10, pitch: 0, bearing: 0, ...o });
const wrapD = d => ((d % 360) + 540) % 360 - 180;
const finite = c => [c.lon, c.lat, c.zoom, c.pitch, c.bearing].every(Number.isFinite);
const sample = (p, n = 200) => Array.from({ length: n + 1 }, (_, i) => p.at(p.dur * i / n));

// ── shortBearingOf ──
ok("shortBearingOf：範囲内は同値", near(shortBearingOf(0.5), 0.5) && near(shortBearingOf(-0.5), -0.5));
ok("shortBearingOf：2π 周回を畳む", near(shortBearingOf(0.3 + 4 * Math.PI), 0.3, 1e-12) && near(shortBearingOf(-0.3 - 6 * Math.PI), -0.3, 1e-12));
ok("shortBearingOf：270° → -90°", near(shortBearingOf(270 * D2R), -90 * D2R, 1e-12));

// ── flyPlan ──
{
	const p = flyPlan(cam(), env, 135.5, 34.7, 12);
	const a = p.at(0), b = p.at(p.dur);
	ok("fly：at(0)＝出発", near(a.lon, 139.76) && near(a.lat, 35.68) && near(a.zoom, 10));
	ok("fly：at(dur)＝着地", near(b.lon, 135.5, 1e-9) && near(b.lat, 34.7) && near(b.zoom, 12));
	ok("fly：北向き水平から z12 着地＝①も③も無い（land＝dur）", p.land === p.dur && p.dur >= 800 && p.dur <= 4200, `dur=${p.dur}`);
	ok("fly：範囲外の時刻は端に留まる", near(p.at(-100).lon, a.lon) && near(p.at(p.dur + 1e4).lon, b.lon));
	ok("fly：途中は全部有限", sample(p).every(finite));
	const zs = sample(p).map(c => c.zoom);
	ok("fly：巡航で一度引いてから寄る（van Wijk の弧）", Math.min(...zs) < 10, `min zoom=${Math.min(...zs).toFixed(2)}`);
}
{
	const p = flyPlan(cam({ pitch: 40 * D2R, bearing: 1 }), env, 140, 36, 16);
	ok("fly：傾き・回転があれば ①500ms で水平・北へ", near(p.at(500).pitch, 0) && near(p.at(500).bearing, 0));
	ok("fly：z15 以上の着地は既定 45°", near(p.at(p.dur).pitch, 45 * D2R, 1e-12) && near(p.dur - p.land, 700, 1e-6));
	ok("fly：①の途中は出発の傾きから下がるだけ", p.at(250).pitch < 40 * D2R && p.at(250).pitch > 0);
}
{
	const p = flyPlan(cam(), env, 140, 36, 12, 80, 270);
	ok("fly：着地チルトは maxPitch で頭打ち", near(p.at(p.dur).pitch, 60 * D2R, 1e-12));
	ok("fly：着地方位 270° は最短回転の -90°", near(p.at(p.dur).bearing, -90 * D2R, 1e-12));
	ok("fly：着地前（land）はまだ北向き水平", near(p.at(p.land).pitch, 0) && near(p.at(p.land).bearing, 0));
}
{
	const p = flyPlan(cam({ lon: 179 }), env, -179, 35.68, 10);
	const lons = sample(p).map(c => c.lon);
	ok("fly：日付変更線は短い側（+2°）を通る", lons.every(l => l >= 179 - 1e-9 && l <= 181 + 1e-9) && near(wrapD(p.at(p.dur).lon), -179, 1e-9));
}
{
	const p = flyPlan(cam(), { ...env, minZoom: 5 }, 140, 36, 1);
	ok("fly：床（minZoom）より下の目標は床に着地", near(p.at(p.dur).zoom, 5));
	const q = flyPlan(cam({ zoom: 0.5 }), env, 140, 36, 6);
	ok("fly：z<2 からの帰りでも巡航が床 2 に貼り付かない（初手でテレポートしない）", q.at(q.land * 0.05).zoom < 2, `z=${q.at(q.land * 0.05).zoom.toFixed(2)}`);
	const r = flyPlan(cam(), env, 139.76, 35.68, 14);
	ok("fly：真上へのズームだけ＝経緯度は動かない", sample(r).every(c => near(c.lon, 139.76, 1e-9) && near(c.lat, 35.68, 1e-9)) && near(r.at(r.dur).zoom, 14));
}

// ── glidePlan ──
{
	const p = glidePlan(cam(), env, 139.8, 35.7, 12, 30, 90);
	const e = p.at(p.dur);
	ok("glide：at(dur)＝目標（経緯度・ズーム・方位・チルト）", near(e.lon, 139.8) && near(e.lat, 35.7) && near(e.zoom, 12) && near(e.bearing, 90 * D2R, 1e-12) && near(e.pitch, 30 * D2R, 1e-12));
	ok("glide：land＝dur", p.land === p.dur);
	// 時分割：move が終わるまで方位・チルトは動かない
	const moveEnd = sample(p, 1000).findIndex(c => near(c.lon, 139.8, 1e-12) && near(c.zoom, 12, 1e-12));
	const before = sample(p, 1000).slice(0, moveEnd);
	ok("glide：移動の間は方位もチルトも初期値", before.every(c => c.bearing === 0 && c.pitch === 0), `moveEnd=${moveEnd}`);
	const mid = sample(p, 1000).filter(c => c.bearing > 0 && c.bearing < 90 * D2R - 1e-9);
	ok("glide：方位の間はチルトが初期値", mid.length > 0 && mid.every(c => c.pitch === 0));
}
{
	const p = glidePlan(cam({ pitch: 20 * D2R }), env, 139.76, 35.68, 10, 20, 0);
	ok("glide：何も変わらない＝尺 0", p.dur === 0 && near(p.at(0).pitch, 20 * D2R));
	const q = glidePlan(cam(), env, 139.76, 35.68, 10, 30);
	ok("glide：チルトだけ＝500..1600ms の一相", q.dur >= 500 && q.dur <= 1600 && near(q.at(q.dur).pitch, 30 * D2R, 1e-12));
	const r = glidePlan(cam({ bearing: 350 * D2R }), env, 139.76, 35.68, 10, 0, 10);
	ok("glide：350°→10° は +20° 回る（最短回転）", near(r.at(r.dur).bearing - shortBearingOf(350 * D2R), 20 * D2R, 1e-12));
	const s = glidePlan(cam(), { ...env, minZoom: 8 }, 139.8, 35.7, 3);
	ok("glide：床より下の目標は床へ", near(s.at(s.dur).zoom, 8));
	const t = glidePlan(cam(), env, 139.76, 35.68, 10, 90);
	ok("glide：チルトは maxPitch で頭打ち", near(t.at(t.dur).pitch, 60 * D2R, 1e-12));
}

// ── glidePathPlan ──
{
	ok("glidePath：空・配列でない＝null", glidePathPlan(cam(), env, []) === null && glidePathPlan(cam(), env, null) === null);
	const one = glidePathPlan(cam(), env, [{ lon: 139.8, lat: 35.7, zoom: 12 }]);
	const g = glidePlan(cam(), env, 139.8, 35.7, 12, 0, 0);
	ok("glidePath：1 点・尺なし＝glide と同じ", one.dur === g.dur && near(one.at(one.dur / 2).lon, g.at(g.dur / 2).lon) && !one.knots);
	const pts = [{ lon: 139.77, lat: 35.69, zoom: 14, secs: 2 }, { lon: 139.79, lat: 35.70, zoom: 15, pitch: 0.5, bearing: 1, secs: 3 }, { lon: 139.80, lat: 35.72, zoom: 15, secs: 1 }];
	const p = glidePathPlan(cam({ zoom: 13 }), env, pts);
	ok("glidePath：尺＝secs の合計", near(p.dur, 6000));
	ok("glidePath：knots は増加・最後は dur", p.knots.length === 3 && p.knots[0] < p.knots[1] && p.knots[1] < p.knots[2] && near(p.knots[2], 6000, 1e-3));
	const hit = pts.every((q, j) => { const c = p.at(p.knots[j]); return near(c.lon, q.lon, 1e-6) && near(c.lat, q.lat, 1e-6) && near(c.zoom, q.zoom, 1e-4); });
	ok("glidePath：knots の時刻に各点を通る", hit);
	ok("glidePath：途中は全部有限", sample(p).every(finite));
	const c = p.at(p.knots[1]);
	ok("glidePath：通過点のチルト・方位", near(c.pitch, 0.5, 1e-4) && near(c.bearing, 1, 1e-4));
	const auto = glidePathPlan(cam(), env, [{ lon: 139.761, lat: 35.681, zoom: 10 }, { lon: 139.762, lat: 35.682, zoom: 10 }]);
	ok("glidePath：全区間尺なし＝総尺 1.5..16s に収める", auto.dur >= 1500 && auto.dur <= 16000, `dur=${auto.dur}`);
	const am = glidePathPlan(cam({ lon: 179.5 }), env, [{ lon: -179.5, lat: 35.68, zoom: 10, secs: 1 }, { lon: -179, lat: 35.68, zoom: 10, secs: 1 }]);
	ok("glidePath：日付変更線を連続に跨ぐ", sample(am).every(q => q.lon >= 179.5 - 1e-6 && q.lon <= 181 + 1e-6));
	const fl = glidePathPlan(cam(), { ...env, minZoom: 9 }, [{ lon: 139.8, lat: 35.7, zoom: 3, secs: 1 }, { lon: 139.9, lat: 35.7, zoom: 3, secs: 1 }]);
	ok("glidePath：ズームは床で止まる", sample(fl).every(q => q.zoom >= 9 - 1e-12));
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ flight-plans 全 PASS");
process.exit(fail ? 1 : 0);
