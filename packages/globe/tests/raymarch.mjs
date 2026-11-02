// 地形の上の unproject（src/raymarch.ts）＝光線を歩いて最初に地面をまたぐ所。急斜面の山で、投影した地面の点が戻るか（2026-11-02）
import { marchRay } from "../src/raymarch.ts";
import { cameraState, project, unproject, worldRadiusM } from "@ortho-earth/core";
let fail = 0; const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}  ${d}`); if (!c) fail++; };
const D = Math.PI / 180, EX = 1, Rm = worldRadiusM();
const lift = h => 1 + Math.max(0, h) * EX / Rm;
// Innsbruck の南の山（hybrid の例の辺り）を模した急な山並み：谷 600 m・尾根 2600 m・波長 4 km
const hOf = (lon, lat) => 1600 + 1000 * Math.sin((lat - 47.25) * 111.2 / 4 * 2 * Math.PI) * Math.cos((lon - 11.39) * 75 / 5 * 2 * Math.PI);
const cam = { center: [11.39, 47.27], zoom: 12.5, pitch: 70 * D, bearing: 0, centerAlt: 1600, fovy: 36.87 * D };
const W = 800, H = 600, st = cameraState(cam, W, H);
// 画面の格子ごとに、細かい歩き（2 万歩）を正解として比べる
const truth = (sx, sy) => { const top = Math.min(Math.hypot(...st.eye), lift(9000)); for (let i = 0; i <= 20000; i++) { const R = top + (1 - top) * i / 20000, P = unproject(st, sx, sy, R); if (!P) return null; if (R - lift(hOf(P[0], P[1])) <= 0) return P; } return null; };
const kmOf = (a, b) => Math.hypot((a[0] - b[0]) * 75, (a[1] - b[1]) * 111.2);
// かすめる光線（尾根の輪郭）は 1 px 未満で答えが km 跳ぶ＝距離でなく「戻した画素が 1 px 以内で、正解より奥へ行っていない」で見る（北向き＝奥は緯度が大きい）
const pxOf = (g, sx, sy) => { const q = project(st, g[0], g[1], lift(hOf(g[0], g[1]))); return Math.hypot(q[0] - sx, q[1] - sy); };
const fine = (g, t, sx, sy) => g && (kmOf(g, t) < 0.05 || (pxOf(g, sx, sy) < 1 && g[1] <= t[1] + 0.0005));
let n = 0, bad = 0, worst = 0;
for (let y = 20; y < H; y += 40) for (let x = 20; x < W; x += 60) {
	const t = truth(x, y); if (!t || kmOf(t, cam.center) > 40) continue;   // 40 km より遠い地平線のかすめは外す
	const got = marchRay(st, x, y, R => unproject(st, x, y, R), lift, hOf);
	n++; if (!fine(got, t, x, y)) { bad++; worst = Math.max(worst, got ? kmOf(got, t) : Infinity); }
}
ok("画面の格子で細かい歩きと同じ地面（50 m 以内か、戻して 1 px 以内で奥へ飛ばない）", n > 100 && bad === 0, `n=${n} 外れ=${bad} 最悪=${(worst * 1000).toFixed(0)}m`);
// 投影した地面の点が戻る（隠れていない点＝正解の歩きで同じ点になる所）
let back = 0, tried = 0;
for (let i = 0; i < 200; i++) {
	const lon = 11.33 + 0.12 * ((i * 37) % 200) / 200, lat = 47.24 + 0.1 * ((i * 53) % 200) / 200;
	const p = project(st, lon, lat, lift(hOf(lon, lat))); if (p[2] < 0 || p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
	const t = truth(p[0], p[1]); if (!t || kmOf(t, [lon, lat]) > 0.05) continue;   // 手前の尾根に隠れた点は外す
	tried++; const g = marchRay(st, p[0], p[1], R => unproject(st, p[0], p[1], R), lift, hOf); if (fine(g, [lon, lat], p[0], p[1])) back++;
}
ok("見えている地面の点は project→unproject で戻る（50 m 以内か、戻して 1 px 以内）", tried > 30 && back === tried, `${back}/${tried}`);
// 地形なし（持ち上げ 0）なら海面の球の答えと同じ
const flat = marchRay(st, 400, 400, R => unproject(st, 400, 400, R), lift, () => 0), sea = unproject(st, 400, 400, 1);
ok("平らなら海面の球と同じ", flat && kmOf(flat, sea) < 0.01);
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ raymarch 全 PASS");
process.exit(fail ? 1 : 0);
