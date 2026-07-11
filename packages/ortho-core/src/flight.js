// 球面フライト＝三段の振り付け「①水平・北向きへ → ②平面のまま飛ぶ → ③着地してから起こす」。
// ①紙地図の作法＝場所の把握はまず真俯瞰・北向きで（回転や傾きを持ったまま飛ぶと現在地を見失う）。
// ②van Wijk & Nuij の厳密解（d3.interpolateZoom と同式・ρ=√2）＝知覚速度一定の最適経路。
//   「行程が視野に入る高度まで上げる」式の近似は上がりすぎて低ズーム滞在が長く、画面速度が暴れる（実証済み）。
// ③着地の瞬間 onFlying(false)＝重い自動ロード（PLATEAU等）の解禁は呼び出し側がここで行う＝
//   デコード/GPU転送が飛行アニメと帯域を取り合わない。立ち上がりが着陸の演出になる。
// ユーザーのドラッグ/ホイールで即中断＝主導権は常に人（呼び出し側が cancel() を叩く）。
const D2R = Math.PI / 180;

// 方位角を最短回転(-π..π]へ正規化（コンパスの読みと同じ）
export const shortBearingOf = b => ((b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

// createFlight({ cam, viewW, maxPitch, onMove, onFlying }) → { flyTo(lon,lat,zoom,tiltDeg), cancel(), active }
//   cam＝{center,zoom,pitch,bearing} を直接書く（描画は onMove が飛ばす）。viewW()＝視野幅px（van Wijk の尺）。
export function createFlight({ cam, viewW, maxPitch, onMove, onFlying = () => {} }) {
	let flight = null;
	function flyTo(lon, lat, zoom, tiltDeg) {
		if (flight) flight.cancel();
		let cancelled = false;
		flight = { cancel: () => { cancelled = true; onFlying(false); flight = null; } };
		onFlying(true);
		// 着地チルト：指定（自然地名=55°等）＞ z14+着地の既定45°。出発時の姿勢に依存しない＝毎回同じ振り付け
		const p1 = tiltDeg != null ? Math.min(maxPitch, tiltDeg * D2R) : (zoom >= 14 ? 45 * D2R : 0);
		const tween = (ms, apply, done, linear) => {
			const t0 = performance.now();
			const step = () => {
				if (cancelled) return;
				const k = Math.min(1, (performance.now() - t0) / ms), e = linear ? k : k * k * (3 - 2 * k);   // 巡航はlinear（経路自体が緩急を持つ）
				apply(e); onMove();
				if (k < 1) requestAnimationFrame(step); else done();
			};
			requestAnimationFrame(step);
		};
		const P0 = cam.pitch, B0 = shortBearingOf(cam.bearing);
		const flatten = (Math.abs(P0) > 0.01 || Math.abs(B0) > 0.01)
			? done => tween(500, e => { cam.pitch = P0 * (1 - e); cam.bearing = B0 * (1 - e); }, done)
			: done => done();
		flatten(() => {
			const z0 = cam.zoom, z1 = zoom, lon0 = cam.center[0], lat0 = cam.center[1];
			let dLon = lon - lon0; dLon -= Math.round(dLon / 360) * 360;   // 最短経路（antimeridian 安全側）
			const dLat = lat - lat0;
			const rho = Math.SQRT2, rho2 = 2, rho4 = 4;
			const wOf = z => 360 * viewW() / (512 * Math.pow(2, z));       // 視野幅[deg]
			const zOf = w => Math.log2(360 * viewW() / (512 * w));
			const w0 = wOf(z0), w1 = wOf(z1), d2 = dLon * dLon + dLat * dLat, d1 = Math.sqrt(d2);
			let S, frameAt;   // S＝経路長（ρ単位）、frameAt(e)＝[経路割合u(0..1), 視野幅w]
			if (d1 < 1e-6 * Math.max(w0, w1)) {   // ほぼ真上＝指数ズームのみ
				S = Math.abs(Math.log(w1 / w0)) / rho;
				frameAt = e => [e, w0 * Math.pow(w1 / w0, e)];
			} else {
				const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
				const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
				const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
				const ch0 = Math.cosh(r0), sh0 = Math.sinh(r0);
				S = (r1 - r0) / rho;
				frameAt = e => {
					const s = e * S;
					return [w0 / (rho2 * d1) * (ch0 * Math.tanh(rho * s + r0) - sh0), w0 * ch0 / Math.cosh(rho * s + r0)];
				};
			}
			const dur = Math.max(700, Math.min(4000, S * 280));            // d3既定(≈250ms/単位)より一拍ゆったり・上限4秒
			tween(dur, e => {
				const [u, w] = frameAt(e);
				cam.center = [lon0 + dLon * u, lat0 + dLat * u];
				cam.zoom = Math.max(2, zOf(w));
			}, () => {
				onFlying(false);   // 着地＝重い自動ロード解禁（次の onMove から動く）
				if (p1 < 0.01) { flight = null; onMove(); return; }
				tween(700, e => { cam.pitch = p1 * e; }, () => { flight = null; onMove(); });   // 北向きのまま起こす
			}, true);   // 巡航はlinear＝van Wijk経路自体が緩急を持つ（smoothstepを重ねると速度が暴れる）
		});
	}
	return { flyTo, cancel: () => { if (flight) flight.cancel(); }, get active() { return !!flight; } };
}
