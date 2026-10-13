// 手触りの純関数（A2・2026-10-12）：慣性（MapLibre の handler_inertia の式そのまま）・cubic-bezier・zoomSnap・handler 名。
import { INERTIA, INERTIA_WINDOW_MS, bezierEase, inertiaOf, inertiaOf2, snapZoom, HANDLER_NAMES } from "../src/input.js";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// cubic-bezier(0,0,0.3,1)＝MapLibre の既定の easing（端は 0/1・単調・前半で大きく進む easeOut）
{
	const e = bezierEase(0, 0, 0.3, 1);
	ok("bezier の端", e(0) === 0 && e(1) === 1 && e(-1) === 0 && e(2) === 1);
	let mono = true; for (let i = 1; i <= 100; i++) if (e(i / 100) < e((i - 1) / 100) - 1e-12) mono = false;
	ok("bezier は単調", mono);
	ok("bezier(0,0,0.3,1) は easeOut（半分で 0.8 前後）", e(0.5) > 0.78 && e(0.5) < 0.83, e(0.5).toFixed(4));
	const lin = bezierEase(0.25, 0.25, 0.75, 0.75);
	ok("対角の bezier＝線形", near(lin(0.3), 0.3, 1e-6) && near(lin(0.7), 0.7, 1e-6));
}
// 1 次元（回転・チルト）：speed＝Σv·linearity／秒・頭打ち・dur＝|speed|/(deceleration·linearity)・amount＝speed·dur/2
{
	const recs = [{ t: 0, v: 10 }, { t: 50, v: 10 }, { t: 100, v: 10 }];   // 30° を 100ms で＝300°/s
	const r = inertiaOf(recs, 100, INERTIA.rotate);
	const speed = Math.min(180, 30 * 0.25 / 0.1), dur = speed / (720 * 0.25);
	ok("rotate の慣性＝MapLibre の式", r && near(r.dur, dur * 1000, 1e-9) && near(r.amount, speed * dur / 2, 1e-9), r && `${r.dur.toFixed(1)}ms ${r.amount.toFixed(3)}°`);
	ok("maxSpeed で頭打ち", (() => { const q = inertiaOf([{ t: 0, v: 500 }, { t: 10, v: 500 }], 10, INERTIA.rotate); return q && near(q.dur, 180 / (720 * 0.25) * 1000, 1e-9); })());
	ok("負の向きは負の量", inertiaOf([{ t: 0, v: -10 }, { t: 50, v: -10 }], 50, INERTIA.pitch).amount < 0);
	ok("記録 1 件・差し引き 0・止まって離した＝慣性なし", !inertiaOf([{ t: 0, v: 10 }], 0) && !inertiaOf([{ t: 0, v: 10 }, { t: 50, v: -10 }], 50) && !inertiaOf([{ t: 0, v: 10 }, { t: 50, v: 10 }], 50 + INERTIA_WINDOW_MS + 1));
	ok("窓（160ms）より古い記録は捨てる", (() => { const a = inertiaOf([{ t: 0, v: 100 }, { t: 300, v: 10 }, { t: 350, v: 10 }], 350, INERTIA.rotate), b = inertiaOf([{ t: 300, v: 10 }, { t: 350, v: 10 }], 350, INERTIA.rotate); return a && b && near(a.amount, b.amount); })());
}
// 2 次元（pan）：向きは保ち、大きさで頭打ち
{
	const recs = [{ t: 0, vx: 8, vy: 0 }, { t: 16, vx: 8, vy: 0 }, { t: 32, vx: 8, vy: 0 }, { t: 48, vx: 8, vy: 0 }];   // 32px/48ms≈667px/s
	const q = inertiaOf2(recs, 48, INERTIA.pan);
	const sp = Math.min(1400, 32 * 0.3 / 0.048), dur = sp / (2500 * 0.3);
	ok("pan の慣性＝MapLibre の式", q && near(q.dur, dur * 1000, 1e-9) && near(q.ax, sp * dur / 2, 1e-9) && q.ay === 0, q && `${q.dur.toFixed(1)}ms ${q.ax.toFixed(2)}px`);
	const fast = inertiaOf2([{ t: 0, vx: 300, vy: 400 }, { t: 10, vx: 300, vy: 400 }], 10, INERTIA.pan);
	ok("pan の頭打ちは向きを保つ（3:4）", fast && near(fast.ay / fast.ax, 4 / 3, 1e-9) && near(Math.hypot(fast.ax, fast.ay), 1400 * (1400 / (2500 * 0.3)) / 2, 1e-6));
	ok("pan 記録 1 件＝慣性なし", !inertiaOf2([{ t: 0, vx: 8, vy: 0 }], 0));
}
// zoomSnap・handler 名
ok("snapZoom", snapZoom(3.3, 0.5) === 3.5 && snapZoom(3.2, 0.5) === 3 && snapZoom(3.3, 0) === 3.3 && snapZoom(7.49, 1) === 7);
ok("HANDLER_NAMES（MapLibre の 9＋touchRotate）", HANDLER_NAMES.length === 10 && ["scrollZoom", "dragPan", "dragRotate", "keyboard", "doubleClickZoom", "boxZoom", "touchZoomRotate", "touchRotate", "touchPitch", "cooperativeGestures"].every(n => HANDLER_NAMES.includes(n)));
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ input-inertia 全 PASS");
process.exit(fail ? 1 : 0);
