// 花吹雪＝全問正解の結果の面に降らせる（Kenji 2026-10-12「10 問正解は、もう一回は要らない。花吹雪！」）。
// 画面いっぱいの canvas に花びら（桜色の楕円）と色紙を数秒降らせて消える。prefers-reduced-motion では降らせない。
const COLORS = ["#ffb7c5", "#ff8fab", "#ffd166", "#06d6a0", "#8ecae6", "#f4a261", "#fff"];
export function confetti({ ms = 4200, count = 160 } = {}) {
	if (matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => {};
	const cv = document.createElement("canvas");
	cv.setAttribute("aria-hidden", "true");
	cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50";
	document.body.append(cv);
	const cx = cv.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1);
	const fit = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
	fit(); addEventListener("resize", fit);
	const W = () => cv.width, H = () => cv.height, R = (a, b) => a + Math.random() * (b - a);
	const bits = Array.from({ length: count }, (_, i) => ({
		x: R(0, W()), y: R(-H(), -10 * dpr), r: R(5, 10) * dpr, vy: R(1.2, 3.2) * dpr, vx: R(-0.8, 0.8) * dpr,
		a: R(0, Math.PI * 2), va: R(-0.08, 0.08), sway: R(0.01, 0.04), ph: R(0, 6.3), petal: i % 3 !== 0, c: COLORS[i % COLORS.length],
	}));
	const t0 = performance.now(); let raf = 0, done = false;
	const stop = () => { if (done) return; done = true; cancelAnimationFrame(raf); removeEventListener("resize", fit); cv.remove(); };
	const tick = now => {
		const el = now - t0, fade = Math.max(0, Math.min(1, (ms - el) / 800));
		cx.clearRect(0, 0, W(), H()); cx.globalAlpha = fade;
		for (const b of bits) {
			b.ph += b.sway; b.x += b.vx + Math.sin(b.ph) * 0.9 * dpr; b.y += b.vy; b.a += b.va;
			if (b.y > H() + 20 && el < ms - 1200) { b.y = -20; b.x = R(0, W()); }
			cx.save(); cx.translate(b.x, b.y); cx.rotate(b.a); cx.fillStyle = b.c;
			if (b.petal) { cx.scale(1, 0.55 + 0.45 * Math.abs(Math.sin(b.ph))); cx.beginPath(); cx.ellipse(0, 0, b.r, b.r * 0.6, 0, 0, Math.PI * 2); cx.fill(); }
			else { cx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2); }
			cx.restore();
		}
		if (el < ms) raf = requestAnimationFrame(tick); else stop();
	};
	raf = requestAnimationFrame(tick);
	return stop;
}
