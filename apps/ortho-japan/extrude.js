// 任意ポリゴンの 3D 押し出し（MapLibre の fill-extrusion 相当・2026-09-21）。model-worker の中で動く。
// 受け取るのは main が解決済みの「面の列」＝高さ・色は main で決める（関数アクセサが使えるように）。ここは幾何だけ。
//   屋根＝各面を重心まわりの局所平面（東・北のメートル）へ落として earcut（穴つき）。法線＝その場の鉛直。
//   壁＝各辺の四角形（頂点 4 つ・共有しない＝角が丸まらない平らな陰影）。法線＝辺の外向き（環の巻きと穴かどうかで決める）。
// 仕上げは GLB 模型と同じ finishMesh（両面・RTE・LOD 並べ替え・被覆マスク）。接地＝一体（minH=0）＝高さは地面からの絶対値、
// base>0（min_height）はそのまま宙に浮く（MapLibre の fill-extrusion-base と同じ意味）。
// 法線は ortho の世界軸（ECEF(x,y,z) → (x, z, y)）で Int8×4。
import earcut from "earcut";
import { finishMesh, MASK_N } from "./plateaudecode.js";

const D2R = Math.PI / 180, R = 6371008.8;

// polys＝[{ rings: [Float64Array(lon,lat 度 の平坦列), …]（先頭が外周・以降は穴）, h, base, rgba: [r,g,b,a] 0-255 }]
export function extrudeMesh(polys, { mask = true } = {}) {
	let nV = 0, nI = 0;
	const tris = [];
	// 一周目＝屋根の三角形分割と数え上げ（配列の大きさを先に決める）
	for (const p of polys) {
		let n = 0;
		const holes = [];
		for (let k = 0; k < p.rings.length; k++) { if (k) holes.push(n); n += p.rings[k].length / 2; }
		if (n < 3 || !(p.h > p.base)) { tris.push(null); continue; }
		const lat0 = p.rings[0][1] * D2R, lon0 = p.rings[0][0], kx = Math.cos(lat0) * R * D2R, ky = R * D2R;
		const flat = new Float64Array(n * 2);
		let o = 0;
		for (const r of p.rings) for (let i = 0; i < r.length; i += 2) { flat[o++] = (r[i] - lon0) * kx; flat[o++] = (r[i+1] - p.rings[0][1]) * ky; }
		const t = earcut(flat, holes.length ? holes : null, 2);
		tris.push({ t, flat, n });
		nV += n + n * 4; nI += t.length + n * 6;
	}
	if (!nI) return null;
	const geo = new Float64Array(nV * 3), nrm = new Int8Array(nV * 4), idx = new Uint32Array(nI), uv = new Float32Array(nV * 2), col = new Uint8Array(nV * 4);
	let v = 0, w = 0, nTri = 0, nPoly = 0;
	let lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity;
	const put = (lon, lat, h, nx, ny, nz, c) => {   // nx,ny,nz＝ECEF の向き（長さ任意）
		geo[v*3] = lon * D2R; geo[v*3+1] = lat * D2R; geo[v*3+2] = h;
		const l = Math.hypot(nx, ny, nz) || 1, s = 127 / l;
		nrm[v*4] = Math.round(nx * s); nrm[v*4+1] = Math.round(nz * s); nrm[v*4+2] = Math.round(ny * s);   // ECEF → ortho (x, z, y)
		col[v*4] = c[0]; col[v*4+1] = c[1]; col[v*4+2] = c[2]; col[v*4+3] = c[3];
		if (lon < lo0) lo0 = lon; if (lon > lo1) lo1 = lon; if (lat < la0) la0 = lat; if (lat > la1) la1 = lat;
		return v++;
	};
	polys.forEach((p, pi) => {
		const T = tris[pi]; if (!T) return;
		nPoly++;
		// 屋根
		const roof = v;
		for (const r of p.rings) for (let i = 0; i < r.length; i += 2) {
			const lo = r[i] * D2R, la = r[i+1] * D2R, cl = Math.cos(la);
			put(r[i], r[i+1], p.h, cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la), p.rgba);
		}
		for (let k = 0; k < T.t.length; k++) idx[w++] = roof + T.t[k];
		nTri += T.t.length / 3;
		// 壁＝環ごと。外向き＝外周は環の外・穴は環の内（＝穴の中心へ向く）。巻きは符号付き面積で見る
		let off = 0;
		p.rings.forEach((r, k) => {
			const m = r.length / 2;
			let area = 0;
			for (let i = 0, j = m - 1; i < m; j = i++) area += T.flat[(off + j) * 2] * T.flat[(off + i) * 2 + 1] - T.flat[(off + i) * 2] * T.flat[(off + j) * 2 + 1];
			const sgn = (area > 0 ? 1 : -1) * (k ? -1 : 1);   // CCW の外周＝右手側 (dy,-dx) が外
			for (let i = 0; i < m; i++) {
				const j = (i + 1) % m;
				const ax = r[i*2], ay = r[i*2+1], bx = r[j*2], by = r[j*2+1];
				if (ax === bx && ay === by) continue;   // 閉じ点の重複（GeoJSON の環は先頭＝末尾）
				const dx = T.flat[(off + j) * 2] - T.flat[(off + i) * 2], dy = T.flat[(off + j) * 2 + 1] - T.flat[(off + i) * 2 + 1];
				const e = sgn * dy, nn = -sgn * dx;   // 外向き（東・北）
				const lo = (ax + bx) / 2 * D2R, la = (ay + by) / 2 * D2R, sl = Math.sin(lo), cl = Math.cos(lo), sp = Math.sin(la), cp = Math.cos(la);
				const nx = -sl * e - sp * cl * nn, ny = cl * e - sp * sl * nn, nz = cp * nn;   // ENU → ECEF
				const a0 = put(ax, ay, p.base, nx, ny, nz, p.rgba), b0 = put(bx, by, p.base, nx, ny, nz, p.rgba);
				const b1 = put(bx, by, p.h, nx, ny, nz, p.rgba), a1 = put(ax, ay, p.h, nx, ny, nz, p.rgba);
				idx[w++] = a0; idx[w++] = b0; idx[w++] = b1; idx[w++] = a0; idx[w++] = b1; idx[w++] = a1;
				nTri += 2;
			}
			off += m;
		});
	});
	const G = geo.subarray(0, v * 3), N = nrm.subarray(0, v * 4), I = idx.subarray(0, w);
	const maskBbox = mask && lo0 < lo1 ? [lo0, la0, lo1, la1] : null;
	const mesh = finishMesh(G.slice(), N.slice(), I.slice(), 0, null, maskBbox, true, { uv: uv.slice(0, v * 2), col: col.slice(0, v * 4) }, true);
	return { mesh, mask: maskBbox ? { bbox: maskBbox, n: MASK_N } : null, stats: { polygons: nPoly, vertices: v, triangles: nTri, bbox: [lo0, la0, lo1, la1] } };
}
