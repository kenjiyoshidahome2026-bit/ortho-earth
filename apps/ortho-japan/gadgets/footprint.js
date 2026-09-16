// シーンのフットプリント（撮影範囲）を自前 canvas で描く小部品＝stac ガジェットと tellus.html が共用。
// map の公開面（makeProjector / makeProjectorH / getHeight / onFrame）だけを使う（measure/anno と同じ作法）。
// 辺は大円で 16 分割（経緯度線形だと広いシーンで辺が緯線寄りに曲がる）。標高は非同期プリフェッチ＝未着の間は海抜 0 で即描き。
import { gcInterpolate } from "geopbf/edit/sphere";

export function createFootprint(map, mapEl = map.mapEl) {
	const cv = document.createElement("canvas");
	cv.style.cssText = "position:absolute;inset:0;pointer-events:none;";
	mapEl.append(cv);
	let pts = null, hs = null, seq = 0, unsub = null;
	const draw = () => {
		const dpr = devicePixelRatio || 1, W = mapEl.clientWidth, H = mapEl.clientHeight;
		if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
		const ctx = cv.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		if (!pts) return;
		const prH = map.makeProjectorH?.(), pr = map.makeProjector();
		ctx.beginPath();
		let started = false;
		for (let i = 0; i < pts.length; i++) {
			const q = pts[i];
			const p = (prH && hs) ? prH(q[0], q[1], hs[i]) : pr(q[0], q[1]);   // 標高到着後は地形の高さで投影＝画像と視差ゼロ
			if (!p || p[2] < 0) { started = false; continue; }
			started ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); started = true;
		}
		ctx.lineWidth = 4.5; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke();   // 白フチ＝衛星画像の上でも読める
		ctx.lineWidth = 2; ctx.strokeStyle = "#3f4757"; ctx.stroke();
	};
	const ringOf = (g) => g?.type === "Polygon" ? g.coordinates[0] : g?.type === "MultiPolygon" ? g.coordinates[0][0] : null;
	return {
		ringOf,
		// geometry（GeoJSON）か ring（[[lon,lat],…]）か null（消す）
		set(g) {
			const ring = Array.isArray(g) ? g : ringOf(g);
			if (!ring) { pts = null; hs = null; unsub?.(); unsub = null; draw(); return; }
			const out = [];
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i], b = ring[(i + 1) % ring.length];
				for (let k = 0; k < 16; k++) out.push(gcInterpolate(a, b, k / 16));
			}
			pts = out; hs = null;
			unsub ??= map.onFrame(draw); draw(); map.requestDraw?.();
			const my = ++seq;
			Promise.all(out.map(q => map.getHeight?.(q[0], q[1]) ?? 0))
				.then(h => { if (my === seq && pts === out) { hs = h; draw(); } })
				.catch(() => {});
		},
		destroy() { unsub?.(); unsub = null; cv.remove(); },
	};
}
