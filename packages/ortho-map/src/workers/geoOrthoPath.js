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