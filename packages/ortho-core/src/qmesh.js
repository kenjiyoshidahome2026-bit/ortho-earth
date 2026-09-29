// quantized-mesh（Cesium の地形形式・layer.json＋.terrain・#110・2026-09-29）の純関数＝解読・タイルの数え方・格子へ焼く・1 点の標本。
// 仕様＝quantized-mesh-1.0（https://github.com/CesiumGS/quantized-mesh）：EPSG:4326 の TMS（ルート 2 枚・y は南から）・頂点は u/v/高さの u16（zigzag の差分）・
// 索引は高水位の符号（頂点 65536 超は 32bit）・縁の索引・拡張（1＝法線・2＝水域・4＝メタデータ）。本体は 88B のヘッダ（中心・高さの範囲・外接球・地平線の遮蔽点）。
// この地図の標高はアトラスの格子（R01・R10 のセル）＝三角形は格子点の高さへ焼き直す（本人裁定 2026-09-29・三角形のまま描くのは別 Issue）。
// 高さの基準：仕様は楕円体高（Cesium World Terrain・PDOK）。swisstopo は標高（ジオイド）で配っている＝ソースの heights で申告（geoid.js）。
// worker でも main でも node でも動く（DataView・DecompressionStream のみ）。

// ── タイルの数え方（EPSG:4326・TMS）──
export const qmTileSpan = z => 180 / 2 ** z;   // 1 枚の幅（度）＝縦も横も同じ（ルート 2×1）
export function qmTileBounds(z, x, y) { const d = qmTileSpan(z); return [-180 + x * d, -90 + y * d, -180 + (x + 1) * d, -90 + (y + 1) * d]; }   // [w,s,e,n]
export function qmTileAt(z, lon, lat) {
	const d = qmTileSpan(z), nx = 2 ** (z + 1), ny = 2 ** z;
	return [Math.min(nx - 1, Math.max(0, Math.floor((lon + 180) / d))), Math.min(ny - 1, Math.max(0, Math.floor((lat + 90) / d)))];
}

// ── layer.json ──
// base＝layer.json の URL（相対の型紙の起点・問い合わせ＝鍵は引き継ぐ）。戻り＝{ tiles:[絶対 URL の型紙], version, minzoom, maxzoom, bounds, available, extensions, metadataAvailability, attribution }
export function parseLayerJson(j, base) {
	if (!j || (j.format && !/^quantized-mesh/.test(j.format))) throw new Error("quantized-mesh: layer.json format is not quantized-mesh");
	if (j.projection && j.projection !== "EPSG:4326") throw new Error("quantized-mesh: only EPSG:4326 is supported (got " + j.projection + ")");
	if ((j.scheme || j.schema || "tms") !== "tms") throw new Error("quantized-mesh: only the tms scheme is supported");
	const b = new URL(base), q = b.search;
	const abs = t => { const u = new URL(t.replace(/\{(z|x|y|version)\}/g, "__$1__"), b); if (q) for (const [k, v] of b.searchParams) if (!u.searchParams.has(k)) u.searchParams.set(k, v); return u.toString().replace(/__(z|x|y|version)__/g, "{$1}"); };
	const bounds = Array.isArray(j.bounds) && j.bounds.length === 4 ? j.bounds.slice() : null;
	return { tiles: (j.tiles || ["{z}/{x}/{y}.terrain?v={version}"]).map(abs), version: j.version || "1.0.0", minzoom: j.minzoom ?? 0,
		maxzoom: j.maxzoom ?? (Array.isArray(j.available) && j.available.length ? j.available.length - 1 : 20), bounds: bounds && !(bounds[0] <= -180 && bounds[2] >= 180) ? bounds : null,
		available: Array.isArray(j.available) ? j.available : null, extensions: j.extensions || [], metadataAvailability: j.metadataAvailability ?? null, attribution: j.attribution || "" };
}
// 在庫：layer.json の available（段ごとの矩形の列）＝無ければ「分からない」（true＝取りに行く・無ければ 404/403）
export function qmAvailable(layer, z, x, y) {
	const a = layer.available; if (!a) return true;
	const lv = a[z]; if (!lv) return false;
	return lv.some(r => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY);
}

// ── 解読 ──
const zz = v => (v >> 1) ^ -(v & 1);
// 戻り＝{ minH, maxH, n, u:Float64Array(0..1), v:Float64Array(0..1), h:Float32Array(m), tri:Uint32Array, empty }。empty＝中身のない置き物（高さの範囲が 0..0 ちょうど＝PDOK の粗い段）
export function decodeQuantizedMesh(buf) {
	const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const dv = new DataView(ab);
	if (ab.byteLength < 92) throw new Error("quantized-mesh: too short");
	const minH = dv.getFloat32(24, true), maxH = dv.getFloat32(28, true);
	let p = 88;
	const n = dv.getUint32(p, true); p += 4;
	const rd = () => { const out = new Int32Array(n); let v = 0; for (let i = 0; i < n; i++) { v += zz(dv.getUint16(p, true)); p += 2; out[i] = v; } return out; };
	const U = rd(), V = rd(), Hq = rd();
	const u = new Float64Array(n), v = new Float64Array(n), h = new Float32Array(n), dh = (maxH - minH) / 32767;
	for (let i = 0; i < n; i++) { u[i] = U[i] / 32767; v[i] = V[i] / 32767; h[i] = minH + Hq[i] * dh; }
	const wide = n > 65536, W = wide ? 4 : 2;
	if (p % W) p += W - (p % W);   // 索引は幅に揃える（16bit＝2B・32bit＝4B）
	const tc = dv.getUint32(p, true); p += 4;
	const tri = new Uint32Array(tc * 3);
	let hi = 0;
	// 高水位の差は索引の幅で折り返す（16bit＝2^16・32bit＝2^32）＝Cesium の読み手（型付き配列へ代入＝自然に折り返す）と同じ。PDOK の書き手は差が負になる並びで書いている（2026-09-29 実測）
	for (let i = 0; i < tc * 3; i++) { const c = wide ? dv.getUint32(p, true) : dv.getUint16(p, true); p += W; tri[i] = wide ? (hi - c) >>> 0 : (hi - c) & 0xffff; if (c === 0) hi++; }
	for (let e = 0; e < 4; e++) { const k = dv.getUint32(p, true); p += 4 + k * W; }   // 縁（西・南・東・北）＝焼きでは使わない（隣と同じ頂点を持つ）
	return { minH, maxH, n, u, v, h, tri, empty: minH === 0 && maxH === 0 };
}
// gzip のまま来る配信（Content-Encoding なしで .terrain を gzip で置く）＝先頭 1f 8b なら解く
export async function qmGunzip(ab) {
	const b = new Uint8Array(ab);
	if (b[0] !== 0x1f || b[1] !== 0x8b) return ab;
	const s = new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"));
	return await new Response(s).arrayBuffer();
}

// ── 格子へ焼く ──
// mesh（decodeQuantizedMesh）＋タイルの範囲 tb＝[w,s,e,n] を格子 grid へ書く：grid＝{ data:Float32Array, N, lng, lat, range }（row0＝北・格子点・lon＝lng＋c/(N−1)·range）。
// 三角形の外接矩形の格子点だけを重心座標で内挿（辺の上は両側で同じ値＝タイルの継ぎ目に穴を空けない・許し 1e-9）。書いた点の数を返す
export function qmBake(mesh, tb, grid) {
	const { data, N, lng, lat, range } = grid, st = range / (N - 1);
	const [w, s, e, n] = tb, dx = e - w, dy = n - s;
	const X = new Float64Array(mesh.n), Y = new Float64Array(mesh.n);
	for (let i = 0; i < mesh.n; i++) { X[i] = w + mesh.u[i] * dx; Y[i] = s + mesh.v[i] * dy; }
	const top = lat + range;
	let cnt = 0;
	for (let t = 0; t < mesh.tri.length; t += 3) {
		const a = mesh.tri[t], b = mesh.tri[t + 1], c = mesh.tri[t + 2];
		const ax = X[a], ay = Y[a], bx = X[b], by = Y[b], cx = X[c], cy = Y[c];
		const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
		if (Math.abs(det) < 1e-24) continue;
		const c0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - lng) / st - 1e-9)), c1 = Math.min(N - 1, Math.floor((Math.max(ax, bx, cx) - lng) / st + 1e-9));
		const r0 = Math.max(0, Math.ceil((top - Math.max(ay, by, cy)) / st - 1e-9)), r1 = Math.min(N - 1, Math.floor((top - Math.min(ay, by, cy)) / st + 1e-9));
		for (let r = r0; r <= r1; r++) {
			const py = top - r * st;
			for (let col = c0; col <= c1; col++) {
				const px = lng + col * st;
				const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det, l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det, l2 = 1 - l0 - l1;
				if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
				data[r * N + col] = l0 * mesh.h[a] + l1 * mesh.h[b] + l2 * mesh.h[c];
				cnt++;
			}
		}
	}
	return cnt;
}
// 1 点の標本（そのタイルの三角形を線形に）＝当たる三角形が無ければ NaN
export function qmSample(mesh, tb, lon, lat) {
	const [w, s, e, n] = tb, dx = e - w, dy = n - s, px = (lon - w) / dx, py = (lat - s) / dy;
	for (let t = 0; t < mesh.tri.length; t += 3) {
		const a = mesh.tri[t], b = mesh.tri[t + 1], c = mesh.tri[t + 2];
		const ax = mesh.u[a], ay = mesh.v[a], bx = mesh.u[b], by = mesh.v[b], cx = mesh.u[c], cy = mesh.v[c];
		if (px < Math.min(ax, bx, cx) - 1e-12 || px > Math.max(ax, bx, cx) + 1e-12 || py < Math.min(ay, by, cy) - 1e-12 || py > Math.max(ay, by, cy) + 1e-12) continue;
		const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
		if (Math.abs(det) < 1e-24) continue;
		const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det, l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det, l2 = 1 - l0 - l1;
		if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
		return l0 * mesh.h[a] + l1 * mesh.h[b] + l2 * mesh.h[c];
	}
	return NaN;
}

// ── 書き手（試料・検定用）＝仕様どおりの .terrain を作る（extensions なし）。verts＝[[u,v,h]…]（u/v は 0..32767 の整数）・tris＝[[a,b,c]…] ──
// wrap＝索引が高水位の順でなくてもよい（差を幅で折り返して書く＝PDOK の書き手の形の試料）
export function encodeQuantizedMesh({ verts, tris, minH, maxH, west = [], south = [], east = [], north = [], wrap = false }) {
	const n = verts.length, wide = n > 65536, W = wide ? 4 : 2;
	let size = 88 + 4 + n * 6;
	if (size % W) size += W - (size % W);
	size += 4 + tris.length * 3 * W + 4 * 4 + (west.length + south.length + east.length + north.length) * W;
	const ab = new ArrayBuffer(size), dv = new DataView(ab);
	dv.setFloat32(24, minH, true); dv.setFloat32(28, maxH, true);
	let p = 88; dv.setUint32(p, n, true); p += 4;
	const enc = v => (v << 1) ^ (v >> 31);
	for (let k = 0; k < 3; k++) { let prev = 0; for (const vt of verts) { const q = k === 2 ? Math.round((vt[2] - minH) / ((maxH - minH) || 1) * 32767) : vt[k]; dv.setUint16(p, enc(q - prev) & 0xffff, true); prev = q; p += 2; } }
	if (p % W) p += W - (p % W);
	dv.setUint32(p, tris.length, true); p += 4;
	let hi = 0;
	for (const t of tris) for (const i of t) { let c = hi - i; if (c < 0 && !wrap) throw new Error("encodeQuantizedMesh: indices must be in high-water-mark order"); c = wide ? c >>> 0 : c & 0xffff; if (wide) dv.setUint32(p, c, true); else dv.setUint16(p, c, true); p += W; if (c === 0) hi++; }
	for (const edge of [west, south, east, north]) { dv.setUint32(p, edge.length, true); p += 4; for (const i of edge) { if (wide) dv.setUint32(p, i, true); else dv.setUint16(p, i, true); p += W; } }
	return ab;
}
