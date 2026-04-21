export function createFastOrtho(radius, center, rotate) {
	const rad = Math.PI / 180;
	const [λ, φ, γ] = rotate.map(v => v * rad);
	const [cx, cy] = center;

	// 3軸回転行列の合成係数を事前計算 (3x3行列の要素)
	const sλ = Math.sin(λ), cλ = Math.cos(λ);
	const sφ = Math.sin(φ), cφ = Math.cos(φ);
	const sγ = Math.sin(γ), cγ = Math.cos(γ);

	// λ(y軸), φ(x軸), γ(z軸) の回転を合成
	const m0 = cλ * cγ - sλ * sφ * sγ;
	const m1 = -cφ * sγ;
	const m2 = sλ * cγ + cλ * sφ * sγ;
	const m3 = cλ * sγ + sλ * sφ * cγ;
	const m4 = cφ * cγ;
	const m5 = sλ * sγ - cλ * sφ * cγ;
	const m6 = -sλ * cφ;
	const m7 = sφ;
	const m8 = cλ * cφ;

	/**
	 * @param {CanvasRenderingContext2D} ctx
	 * @param {Float32Array|Array} ring - [lon, lat, lon, lat...]
	 */
	return function renderRing(ctx, ring) {
		let first = true;
		for (let i = 0; i < ring.length; i += 2) {
			const lon = ring[i] * rad;
			const lat = ring[i + 1] * rad;

			const cp = Math.cos(lat);
			const x = cp * Math.sin(lon);
			const y = Math.sin(lat);
			const z = cp * Math.cos(lon);

			// 行列演算 (回転後の座標)
			const zr = x * m6 + y * m7 + z * m8;

			if (zr > 0) { // 可視判定
				const xr = x * m0 + y * m1 + z * m2;
				const yr = x * m3 + y * m4 + z * m5;

				const px = cx + radius * xr;
				const py = cy - radius * yr;

				if (first) {
					ctx.moveTo(px, py);
					first = false;
				} else {
					ctx.lineTo(px, py);
				}
			} else {
				first = true; // 裏側に回ったらパスを切断
			}
		}
	};
} 
class geoOrthoPath {
	constructor(ctx, radius, center) {
		this.ctx = ctx;
		this.r = radius;
		this.cx = center[0];
		this.cy = center[1];
	}
	// 地形データを前処理して、ただの [lon, lat, lon, lat...] という Float32Array に変換しておくとさらに速い
	render(geojson, lambda, phi, gamma) {
		const { ctx, r, cx, cy } = this;
		const toRad = Math.PI / 180;
		// 回転角の事前計算
		const l0 = lambda * toRad, p0 = phi * toRad, g0 = gamma * toRad;
		const sl0 = Math.sin(l0), cl0 = Math.cos(l0);
		const sp0 = Math.sin(p0), cp0 = Math.cos(p0);
		const sg0 = Math.sin(g0), cg0 = Math.cos(g0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		// クリップ処理
		ctx.save();
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, 7); // 7 ≒ 2*PI (少し多めに回す)
		ctx.clip();

		ctx.beginPath();
		const features = geojson.features;
		for (let i = 0; i < features.length; i++) {
			const coords = features[i].geometry.coordinates;
			// Polygon想定の2重ループ（MultiPolygonならもう1段必要）
			for (let j = 0; j < coords.length; j++) {
				const ring = coords[j];
				let first = true;
				let lastVisible = false;

				for (let k = 0; k < ring.length; k++) {
					const p = ring[k];
					const lam = p[0] * toRad - l0;
					const phiVal = p[1] * toRad;

					const sLam = Math.sin(lam), cLam = Math.cos(lam);
					const sPhi = Math.sin(phiVal), cPhi = Math.cos(phiVal);

					// 正射投影 + 可視判定の統合計算
					const dot = sp0 * sPhi + cp0 * cPhi * cLam;

					if (dot >= 0) {
						const x = r * cPhi * sLam;
						const y = r * (cp0 * sPhi - sp0 * cPhi * cLam);

						// Z軸回転の適用
						const rx = cx + (x * cg0 - y * sg0);
						const ry = cy - (x * sg0 + y * cg0);

						if (first || !lastVisible) ctx.moveTo(rx, ry);
						else ctx.lineTo(rx, ry);

						first = false;
						lastVisible = true;
					} else {
						lastVisible = false;
					}
				}
			}
		}

		ctx.fillStyle = "#22d3ee";
		ctx.fill();
		ctx.restore();
	}
	renderFast(vertices, offsets, lambda, phi, gamma) {
		const { ctx, r, cx, cy } = this;
		const toRad = Math.PI / 180;

		const l0 = lambda * toRad, p0 = phi * toRad, g0 = gamma * toRad;
		const sl0 = Math.sin(l0), cl0 = Math.cos(l0);
		const sp0 = Math.sin(p0), cp0 = Math.cos(p0);
		const sg0 = Math.sin(g0), cg0 = Math.cos(g0);

		ctx.beginPath();

		for (let i = 0; i < offsets.length - 1; i++) {
			const start = offsets[i] * 2;
			const end = offsets[i + 1] * 2;

			// --- 簡易カリング (ポリゴンの最初の1点で裏表判定) ---
			const testLon = vertices[start] * toRad - l0;
			const testLat = vertices[start + 1] * toRad;
			if (sp0 * Math.sin(testLat) + cp0 * Math.cos(testLat) * Math.cos(testLon) < -0.2) {
				continue; // 完全に裏側ならスキップ
			}

			let first = true;
			for (let j = start; j < end; j += 2) {
				const lam = vertices[j] * toRad - l0;
				const phiVal = vertices[j + 1] * toRad;

				const sL = Math.sin(lam), cL = Math.cos(lam);
				const sP = Math.sin(phiVal), cP = Math.cos(phiVal);

				if (sp0 * sP + cp0 * cP * cL >= 0) {
					const x = r * cP * sL;
					const y = r * (cp0 * sP - sp0 * cP * cL);
					const rx = cx + (x * cg0 - y * sg0);
					const ry = cy - (x * sg0 + y * cg0);

					if (first) ctx.moveTo(rx, ry);
					else ctx.lineTo(rx, ry);
					first = false;
				}
			}
		}
		ctx.fill();
	}
}