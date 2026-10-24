#!/usr/bin/env node
// 打ち上げ花火（fireworks-gl.js）の純関数の常設検定：①玉は表の高度で開く ②星は減衰の下で表の直径に届く ③重力で垂れる ④モジュールは WebGL 無しで import できる（依存ゼロ）
import { SHELLS, COLORS, launchOf, starSpeedOf, starPos } from "../fireworks-gl.js";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };

t("表：号数は昇順・10 号＝直径 320 m・高度 330 m", SHELLS.every((s, i) => !i || s.go > SHELLS[i - 1].go) && SHELLS.find(s => s.go === 10).diam === 320 && SHELLS.find(s => s.go === 10).apex === 330);
t("色の表：0..1 の rgb", COLORS.every(c => c.length === 3 && c.every(v => v >= 0 && v <= 1)));
for (const s of SHELLS) {
	const { v0, tApex } = launchOf(s.apex);
	const z = v0 * tApex - 0.5 * 9.8 * tApex * tApex;
	t(`${s.go} 号：頂点 ${s.apex} m で開く（${z.toFixed(1)} m・${tApex.toFixed(1)} s）`, Math.abs(z - s.apex) < 0.01);
	const v = starSpeedOf(s.diam);
	const r = Math.hypot(...starPos([v, 0, 0], 4).slice(0, 2));   // 水平に飛んだ星＝4 秒で半径の 98% まで
	t(`${s.go} 号：星は直径 ${s.diam} m に届く（4 s で ${(2 * r).toFixed(0)} m）`, r > s.diam / 2 * 0.97 && r <= s.diam / 2 + 1e-6);
}
const up = starPos([0, 0, 50], 3), flat = starPos([50, 0, 0], 3);
t("重力：上へ飛んだ星も 3 秒で垂れ始める（z<50/k）", up[2] < 50 && flat[2] < 0, JSON.stringify([up, flat]));
t("t=0 で原点", starPos([10, 20, 30], 0).every(v => Math.abs(v) < 1e-9));

console.log(`\n${ng ? "✗" : "✓"} fireworks: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
