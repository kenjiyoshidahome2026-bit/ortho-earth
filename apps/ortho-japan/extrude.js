// 任意ポリゴンの 3D 押し出し（MapLibre の fill-extrusion 相当・2026-09-21）。model-worker の中で動く。
// 受け取るのは main が解決済みの「面の列」＝高さ・色は main で決める（関数アクセサが使えるように）。ここは幾何だけ。
//   屋根＝各面を重心まわりの局所平面（東・北のメートル）へ落として earcut（穴つき）。法線＝その場の鉛直。
//   壁＝各辺の四角形（頂点 4 つ・共有しない＝角が丸まらない平らな陰影）。法線＝辺の外向き（環の巻きと穴かどうかで決める）。
// 仕上げは GLB 模型と同じ finishMesh（両面・RTE・LOD 並べ替え・被覆マスク）。接地＝一体（minH=0）＝高さは地面からの絶対値、
// base>0（min_height）はそのまま宙に浮く（MapLibre の fill-extrusion-base と同じ意味）。
// 法線は ortho の世界軸（ECEF(x,y,z) → (x, z, y)）で Int8×4。
import earcut from "earcut";
import { finishMesh, MASK_N } from "./meshdecode.js";

const D2R = Math.PI / 180, R = 6371008.8;

// polys＝[{ rings: [Float64Array(lon,lat 度 の平坦列), …]（先頭が外周・以降は穴）, h, base, rgba: [r,g,b,a] 0-255 }]
// 屋根の細分（2026-09-22「ドレープの突き抜け」根治）：メッシュは頂点ごとに地表標高へ持ち上がる（MESH_VS の接地リフト）＝屋根が外周の
// 頂点だけの巨大三角形だと、内側の山が屋根を突き抜ける（市区町村規模の人口密度の押し出しで実測）。earcut 後の三角形を最長辺の中点で
// 二分し続け（中点は辺ごとに共有＝隣と同じ点＝すき間が出ない）、全辺を L 以下にする＝屋根が「地形＋高さ」に沿う。外周の辺も同じ中点で
// 刻まれる＝壁は中点の台帳から刻んだ外周をたどり直す（屋根の縁と壁の上辺が同じ点）。建物規模（辺が短い）は分割されない＝従来と同一。
// 巨大な面は 1 面あたり ROOF_MAX_TRI 程度に収まるよう L を粗くする（国規模の面で頂点が爆発しない）。
const ROOF_EDGE_M = 1500, ROOF_MAX_TRI = 20000;
function refineRoof(xy, t, L) {   // xy＝局所平面(m)の頂点（伸びる配列）・t＝三角形 → { t: 全辺 ≤ L の三角形列, chain(a,b): 辺 a→b の刻み点列（b を含まない） }
	const L2 = L * L, mid = new Map(), out = [], st = [];
	for (let i = 0; i < t.length; i += 3) st.push(t[i], t[i+1], t[i+2]);
	const d2 = (a, b) => (xy[a*2] - xy[b*2]) ** 2 + (xy[a*2+1] - xy[b*2+1]) ** 2;
	const key = (a, b) => a < b ? a * 4194304 + b : b * 4194304 + a;
	const midOf = (a, b) => {
		const k = key(a, b);
		let m = mid.get(k);
		if (m === undefined) { m = xy.length / 2; xy.push((xy[a*2] + xy[b*2]) / 2, (xy[a*2+1] + xy[b*2+1]) / 2); mid.set(k, m); }
		return m;
	};
	while (st.length) {
		const c = st.pop(), b = st.pop(), a = st.pop();
		const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a);
		if (ab <= L2 && bc <= L2 && ca <= L2) { out.push(a, b, c); continue; }
		if (ab >= bc && ab >= ca) { const m = midOf(a, b); st.push(a, m, c, m, b, c); }
		else if (bc >= ca) { const m = midOf(b, c); st.push(a, b, m, a, m, c); }
		else { const m = midOf(c, a); st.push(a, b, m, m, b, c); }
	}
	const chain = (a, b, acc = []) => {   // 外周の辺は隣接する三角形が一つ＝その三角形が L 以下まで割った中点が台帳にある
		const m = mid.get(key(a, b));
		if (m === undefined) { acc.push(a); return acc; }
		chain(a, m, acc); return chain(m, b, acc);
	};
	return { t: out, chain };
}

// polys＝[{ rings: [Float64Array(lon,lat 度 の平坦列), …]（先頭が外周・以降は穴）, h, base, rgba: [r,g,b,a] 0-255 }]
export function extrudeMesh(polys, { mask = true, refine = ROOF_EDGE_M } = {}) {   // refine＝屋根の細分の刻み(m)（平面に浮かせる時は粗く＝弦のたわみだけ消す）
	let nV = 0, nI = 0;
	const tris = [];
	// 一周目＝屋根の三角形分割と細分・壁の刻み・数え上げ（配列の大きさを先に決める）
	for (const p of polys) {
		let n = 0;
		const holes = [];
		for (let k = 0; k < p.rings.length; k++) { if (k) holes.push(n); n += p.rings[k].length / 2; }
		if (n < 3 || !(p.h > p.base)) { tris.push(null); continue; }
		const lat00 = p.rings[0][1], lon0 = p.rings[0][0], kx = Math.cos(lat00 * D2R) * R * D2R, ky = R * D2R;
		const xy = [];
		for (const r of p.rings) for (let i = 0; i < r.length; i += 2) xy.push((r[i] - lon0) * kx, (r[i+1] - lat00) * ky);
		// 刻み＝外周の外接矩形の面積から 1 面あたりの上限に収まる長さ（小さい面は ROOF_EDGE_M のまま＝建物は刻まれない）
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (let i = 0; i < p.rings[0].length; i += 2) { const x = xy[i], y = xy[i+1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
		const L = Math.max(refine, Math.sqrt(4 * (x1 - x0) * (y1 - y0) / ROOF_MAX_TRI));
		const R_ = refineRoof(xy, earcut(xy, holes.length ? holes : null, 2), L);
		// 壁の環＝各辺を中点の台帳でたどり直した頂点番号の列（閉じ点の重複＝長さ 0 の辺は落とす）
		const walls = [];
		let off = 0, nW = 0;
		for (let k = 0; k < p.rings.length; k++) {
			const m = p.rings[k].length / 2, seq = [];
			for (let i = 0; i < m; i++) {
				const a = off + i, b = off + (i + 1) % m;
				if (xy[a*2] === xy[b*2] && xy[a*2+1] === xy[b*2+1]) continue;
				R_.chain(a, b, seq);
			}
			let area = 0;   // 巻き＝元の環の符号付き面積
			for (let i = 0, j = m - 1; i < m; j = i++) area += xy[(off + j) * 2] * xy[(off + i) * 2 + 1] - xy[(off + i) * 2] * xy[(off + j) * 2 + 1];
			walls.push({ seq, sgn: (area > 0 ? 1 : -1) * (k ? -1 : 1) });   // CCW の外周＝右手側 (dy,-dx) が外・穴は逆
			nW += seq.length; off += m;
		}
		tris.push({ t: R_.t, xy, nRoof: xy.length / 2, walls, lon0, lat00, kx, ky });
		nV += xy.length / 2 + nW * 4; nI += R_.t.length + nW * 6;
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
		// 屋根（元の外周の点＋細分で足した点＝局所平面から経緯度へ戻す）
		const ll = q => [T.lon0 + T.xy[q*2] / T.kx, T.lat00 + T.xy[q*2+1] / T.ky];
		const roof = v;
		for (let q = 0; q < T.nRoof; q++) {
			const [lon, lat] = ll(q), lo = lon * D2R, la = lat * D2R, cl = Math.cos(la);
			put(lon, lat, p.h, cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la), p.rgba);
		}
		for (let k = 0; k < T.t.length; k++) idx[w++] = roof + T.t[k];
		nTri += T.t.length / 3;
		// 壁＝環ごと（刻んだ外周）。外向き＝外周は環の外・穴は環の内（＝穴の中心へ向く）
		for (const { seq, sgn } of T.walls) {
			const m = seq.length;
			for (let i = 0; i < m; i++) {
				const qa = seq[i], qb = seq[(i + 1) % m];
				const [ax, ay] = ll(qa), [bx, by] = ll(qb);
				const dx = T.xy[qb * 2] - T.xy[qa * 2], dy = T.xy[qb * 2 + 1] - T.xy[qa * 2 + 1];
				const e = sgn * dy, nn = -sgn * dx;   // 外向き（東・北）
				const lo = (ax + bx) / 2 * D2R, la = (ay + by) / 2 * D2R, sl = Math.sin(lo), cl = Math.cos(lo), sp = Math.sin(la), cp = Math.cos(la);
				const nx = -sl * e - sp * cl * nn, ny = cl * e - sp * sl * nn, nz = cp * nn;   // ENU → ECEF
				const a0 = put(ax, ay, p.base, nx, ny, nz, p.rgba), b0 = put(bx, by, p.base, nx, ny, nz, p.rgba);
				const b1 = put(bx, by, p.h, nx, ny, nz, p.rgba), a1 = put(ax, ay, p.h, nx, ny, nz, p.rgba);
				idx[w++] = a0; idx[w++] = b0; idx[w++] = b1; idx[w++] = a0; idx[w++] = b1; idx[w++] = a1;
				nTri += 2;
			}
		}
	});
	const G = geo.subarray(0, v * 3), N = nrm.subarray(0, v * 4), I = idx.subarray(0, w);
	const maskBbox = mask && lo0 < lo1 ? [lo0, la0, lo1, la1] : null;
	const mesh = finishMesh(G.slice(), N.slice(), I.slice(), 0, null, maskBbox, true, { uv: uv.slice(0, v * 2), col: col.slice(0, v * 4) }, true);
	return { mesh, mask: maskBbox ? { bbox: maskBbox, n: MASK_N } : null, stats: { polygons: nPoly, vertices: v, triangles: nTri, bbox: [lo0, la0, lo1, la1] } };
}
