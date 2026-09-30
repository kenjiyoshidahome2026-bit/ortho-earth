// hillshade.js の shadeTile＝MapLibre 6.11.2 の hillshade_prepare＋hillshade fragment を画素で写した物の検定（node・網なし）。
// 2026-09-30：傾き atan(0.625·|d|)・勾配×DEM の実寸・頭打ち ±4・向き atan(d.y,−d.x)・method 5 つ（公式例の門で斜面が暗すぎた）。
import { shadeTile, hillshadeParams } from "../src/hillshade.js";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const W = [1, 1, 1, 1], K = [0, 0, 0, 1];
const plane = (n, fx, fy) => Float32Array.from({ length: n * n }, (_, i) => fx * (i % n) + fy * Math.floor(i / n));   // 高さ＝fx·x＋fy·y（y は南へ）
const px = (rgba, n, x, y) => { const o = (y * n + x) * 4; return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]; };
const run = (h, n, paint, z = 12) => shadeTile({ h, n, z, lat0: 0.01, lat1: -0.01, p: hillshadeParams({ "hillshade-shadow-color": K, "hillshade-highlight-color": W, "hillshade-accent-color": K, ...paint }) });

// 平ら＝何も塗らない（standard）
{ const n = 8, r = run(plane(n, 0, 0), n, {}); ok("平らは透明", px(r, n, 4, 4)[3] === 0, px(r, n, 4, 4).join(",")); }

// 向き：東へ上る斜面（西向きの面）＝西からの光で明るい・東からの光で暗い（旧の式は 45° の線で折り返していた＝315° 以外で狂う）
{
	const n = 16, h = plane(n, 20, 0);
	const west = px(run(h, n, { "hillshade-illumination-direction": 270 }), n, 8, 8), east = px(run(h, n, { "hillshade-illumination-direction": 90 }), n, 8, 8);
	ok("西からの光＝明るい（highlight）", west[0] > 200 && west[3] > 0, west.join(","));
	ok("東からの光＝暗い（shadow）", east[0] < 50 && east[3] > 0, east.join(","));
	const north = px(run(plane(n, 0, -20), n, { "hillshade-illumination-direction": 0 }), n, 8, 8);   // 北へ上る＝南向きの面・北からの光＝影
	ok("北へ上る面に北からの光＝暗い", north[0] < 50 && north[3] > 0, north.join(","));
}

// 強さ：MapLibre の式をそのまま手で計算した値と一致（standard・z12・赤道・実寸 n で割る）
{
	const n = 16, z = 12, fx = 300, h = plane(n, fx, 0);
	const ex = (z - 15) * 0.3, k0 = n / Math.pow(2, ex + 28.2562 - z);
	const raw = 8 * fx * k0, packed = Math.round(Math.max(0, Math.min(1, raw / 8 + 128 / 255)) * 255) / 255, d = (packed - 128 / 255) * 8 / Math.cos(0);
	const slope = Math.atan(0.625 * Math.abs(d)), I = 0.5, k = 1, alpha = Math.sin(slope) * k;   // I＝0.5 は scaled＝slope・accent は黒×(1−cos)
	const accentA = (1 - Math.cos(slope)) * k, want = accentA * (1 - alpha) + alpha;
	const got = px(run(h, n, {}, z), n, 8, 8)[3] / 255;
	ok("standard の不透明度＝MapLibre の式（意味のある強さで）", want > 0.2 && Math.abs(got - want) < 0.01, `got ${got.toFixed(3)} want ${want.toFixed(3)} (旧の式なら ${(Math.sin(Math.atan(1.25 * Math.min(1, raw))) ).toFixed(3)} 前後)`);
	const got256 = px(run(plane(32, fx, 0), 32, {}, z), 32, 16, 16)[3] / 255;
	ok("DEM の実寸で勾配が変わる（32px は 16px の 2 倍の勾配）", got256 > got, `${got256.toFixed(3)} > ${got.toFixed(3)}`);
}

// 頭打ち ±4：急な崖でも d は 4 を超えない（旧 ±1）
{
	const n = 8, r = run(plane(n, 1e6, 0), n, { "hillshade-exaggeration": 0.5 }), a = px(r, n, 4, 4)[3] / 255;
	const want = (() => { const s = Math.atan(0.625 * (1 - 128 / 255) * 8), al = Math.sin(s); return (1 - Math.cos(s)) * (1 - al) + al; })();
	ok("急な崖は ±4 で頭打ち", Math.abs(a - want) < 0.01, `${a.toFixed(3)} vs ${want.toFixed(3)}`);
}

// multidirectional：光ごとの色が混ざる（旧＝最初の光だけ）
{
	const n = 16, h = plane(n, 20, 0);
	const p = hillshadeParams({ "hillshade-method": "multidirectional", "hillshade-illumination-direction": [270, 90], "hillshade-illumination-altitude": [30, 30],
		"hillshade-highlight-color": [[1, 0, 0, 1], [0, 1, 0, 1]], "hillshade-shadow-color": [[0, 0, 1, 1], [1, 1, 0, 1]] });
	ok("光の本数＝最長に揃う", p.directions.length === 2 && p.altitudes.length === 2 && p.highlights.length === 2 && p.shadows.length === 2);
	const c = px(shadeTile({ h, n, z: 12, lat0: 0.01, lat1: -0.01, p }), n, 8, 8);
	ok("西の光の highlight（赤）と東の光の shadow（黄）が混ざる", c[0] > 100 && c[1] > 30 && c[3] > 0, c.join(","));
	const q = hillshadeParams({ "hillshade-illumination-direction": [0, 90, 180], "hillshade-highlight-color": "#fff" });
	ok("足りない光は最後の値で埋める", q.highlights.length === 3 && q.altitudes.join() === "45,45,45");
}

// basic・combined・igor も色を出す（未知の method は standard）
{
	const n = 16, h = plane(n, 20, 0);
	for (const m of ["basic", "combined", "igor"]) { const c = px(run(h, n, { "hillshade-method": m, "hillshade-illumination-direction": 270 }), n, 8, 8); ok(`method ${m}`, c[3] > 0, c.join(",")); }
	ok("未知の method＝standard", hillshadeParams({ "hillshade-method": "nope" }).method === "standard");
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ hillshade 全 PASS");
process.exit(fail ? 1 : 0);
