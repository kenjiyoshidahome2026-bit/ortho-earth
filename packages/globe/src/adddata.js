// map.addData（deck.gl の Layer props／accessor の相当・差分 PR-4・2026-10-12）の焼き：配列＋accessor → typed array。
// deck.gl と同じ流儀＝accessor は (d, i) → 値 か 定数、色は [r, g, b, a?]（0〜255）、更新は差分でなく全焼き。
// 点（getPosition/getColor/getRadius[px]）→ points-gl の layer、弧（getSourcePosition/getTargetPosition/getSourceColor/getTargetColor/getWidth[px]/getHeight[弦長比]）→ arcs-gl の layer、
// 面・線・柱（getPolygon/getPath/getPosition＋getRadius[m]・getFillColor/getLineColor/getLineWidth/getElevation[m]）→ GeoJSON＝既存の層経路（fill／line／fill-extrusion・H3 と同じ）。
// 位置は β 単位球の xyz を倍精度で求め、重心を原点に原点相対（RTE）で f32 へ＝points-gl/arcs-gl の origin。純関数（DOM 無し）＝node の検定 tests/arcs.mjs が読む。
import { lonlatTo3D } from "@ortho-earth/core/camera";

export const accessor = (a, dflt) => typeof a === "function" ? a : a === undefined ? (() => dflt) : (() => a);
const items = data => Array.isArray(data) ? data : data?.features ? data.features : Array.from(data ?? []);   // 配列・GeoJSON FeatureCollection・iterable
const posOf = (d, i, get, dflt) => { const p = get(d, i) ?? dflt?.(d); return (Array.isArray(p) || (p && typeof p.length === "number")) && p.length >= 2 ? p : null; };
const fcPos = d => d?.geometry?.type === "Point" ? d.geometry.coordinates : null;   // GeoJSON の Feature なら位置の既定は geometry
const putColor = (out, i, c) => { out[i * 4] = c?.[0] ?? 0; out[i * 4 + 1] = c?.[1] ?? 0; out[i * 4 + 2] = c?.[2] ?? 0; out[i * 4 + 3] = c?.[3] ?? 255; };
// 位置の集合の重心（単位球の上）＝原点。空なら [0,0,0]（原点無し）
export function originOf(xyz, n) {
	if (!n) return null;
	let x = 0, y = 0, z = 0; for (let i = 0; i < n; i++) { x += xyz[i * 3]; y += xyz[i * 3 + 1]; z += xyz[i * 3 + 2]; }
	const r = Math.hypot(x, y, z); if (r < 1e-9) return [xyz[0], xyz[1], xyz[2]];
	return [x / r, y / r, z / r];
}
const relative = (xyz, n, o) => { const f = new Float32Array(n * 3); for (let i = 0; i < n * 3; i += 3) { f[i] = xyz[i] - o[0]; f[i + 1] = xyz[i + 1] - o[1]; f[i + 2] = xyz[i + 2] - o[2]; } return f; };

// 点 → { n, pos, rgba?, size?, origin, lngLat（Float64Array n*2・pick の返し用）}
export function bakePoints(data, { getPosition, getColor, getRadius } = {}) {
	const arr = items(data), gp = accessor(getPosition, null), gc = getColor !== undefined ? accessor(getColor) : null, gr = getRadius !== undefined ? accessor(getRadius) : null;
	const xyz = new Float64Array(arr.length * 3), ll = new Float64Array(arr.length * 2), rgba = gc ? new Uint8Array(arr.length * 4) : null, size = gr ? new Float32Array(arr.length) : null;
	let n = 0;
	for (let i = 0; i < arr.length; i++) {
		const d = arr[i], p = posOf(d, i, gp, fcPos); if (!p) continue;
		const u = lonlatTo3D(+p[0], +p[1]); xyz[n * 3] = u[0]; xyz[n * 3 + 1] = u[1]; xyz[n * 3 + 2] = u[2]; ll[n * 2] = +p[0]; ll[n * 2 + 1] = +p[1];
		if (rgba) putColor(rgba, n, gc(d, i)); if (size) size[n] = +gr(d, i) || 0;
		n++;
	}
	const origin = originOf(xyz, n);
	return { n, pos: n ? relative(xyz, n, origin) : new Float32Array(0), rgba: rgba?.subarray(0, n * 4) ?? null, size: size?.subarray(0, n) ?? null, origin, lngLat: ll.subarray(0, n * 2) };
}
// 弧 → { n, src, dst, theta, rgba?, rgba2?, width?, height?, origin }
export function bakeArcs(data, { getSourcePosition, getTargetPosition, getSourceColor, getTargetColor, getColor, getWidth, getHeight } = {}) {
	const arr = items(data), gs = accessor(getSourcePosition, null), gt = accessor(getTargetPosition, null);
	const gc0 = getSourceColor !== undefined ? accessor(getSourceColor) : getColor !== undefined ? accessor(getColor) : null, gc1 = getTargetColor !== undefined ? accessor(getTargetColor) : null;
	const gw = getWidth !== undefined ? accessor(getWidth) : null, gh = getHeight !== undefined ? accessor(getHeight) : null;
	const N = arr.length, sx = new Float64Array(N * 3), dx = new Float64Array(N * 3), theta = new Float32Array(N);
	const rgba = gc0 ? new Uint8Array(N * 4) : null, rgba2 = gc1 ? new Uint8Array(N * 4) : null, width = gw ? new Float32Array(N) : null, height = gh ? new Float32Array(N) : null;
	let n = 0;
	for (let i = 0; i < N; i++) {
		const d = arr[i], a = posOf(d, i, gs), b = posOf(d, i, gt); if (!a || !b) continue;
		const A = lonlatTo3D(+a[0], +a[1]), B = lonlatTo3D(+b[0], +b[1]);
		for (let k = 0; k < 3; k++) { sx[n * 3 + k] = A[k]; dx[n * 3 + k] = B[k]; }
		theta[n] = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));   // 開き角は倍精度で（f32 の acos は近い 2 点で崩れる）
		if (rgba) putColor(rgba, n, gc0(d, i)); if (rgba2) putColor(rgba2, n, gc1(d, i)); if (width) width[n] = +gw(d, i) || 0; if (height) height[n] = +gh(d, i) || 0;
		n++;
	}
	const all = new Float64Array(n * 6); all.set(sx.subarray(0, n * 3)); all.set(dx.subarray(0, n * 3), n * 3);
	const origin = originOf(all, n * 2);
	return { n, src: n ? relative(sx, n, origin) : new Float32Array(0), dst: n ? relative(dx, n, origin) : new Float32Array(0), theta: theta.subarray(0, n), rgba: rgba?.subarray(0, n * 4) ?? null, rgba2: rgba2?.subarray(0, n * 4) ?? null, width: width?.subarray(0, n) ?? null, height: height?.subarray(0, n) ?? null, origin };
}
// 面・線・柱 → GeoJSON FeatureCollection（properties に色・幅・高さを文字列／数で持つ＝層の paint は ["get", …]）
const css = c => c ? `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${((c[3] ?? 255) / 255).toFixed(3)})` : null;
const ringsOf = poly => (!poly ? null : typeof poly[0]?.[0] === "number" ? [poly] : poly);   // [[lon,lat],…]（1 環）か [[[lon,lat],…],…]（環の列）
const closed = ring => { const r = ring.map(p => [+p[0], +p[1]]); const a = r[0], z = r[r.length - 1]; if (a && (a[0] !== z[0] || a[1] !== z[1])) r.push([a[0], a[1]]); return r; };
export function columnRing(lon, lat, radiusM, k = 20, R = 6378137) {
	const dLat = radiusM / R * 180 / Math.PI, dLon = dLat / Math.max(1e-6, Math.cos(lat * Math.PI / 180)), ring = [];
	for (let i = 0; i <= k; i++) { const a = i / k * 2 * Math.PI; ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
	return ring;
}
export function toGeoJSON(data, kind, { getPolygon, getPath, getPosition, getRadius, getFillColor, getLineColor, getLineWidth, getElevation, getProperties, diskResolution = 20 } = {}) {
	const arr = items(data), gf = getFillColor !== undefined ? accessor(getFillColor) : null, gl = getLineColor !== undefined ? accessor(getLineColor) : null, gw = getLineWidth !== undefined ? accessor(getLineWidth) : null, ge = getElevation !== undefined ? accessor(getElevation) : null, gpr = getProperties !== undefined ? accessor(getProperties) : null;
	const gpoly = accessor(getPolygon, null), gpath = accessor(getPath, null), gpos = accessor(getPosition, null), grad = accessor(getRadius, 100);
	if (kind !== "polygons" && kind !== "paths" && kind !== "columns") throw new Error(`addData: unknown kind "${kind}"`);
	const features = [];
	for (let i = 0; i < arr.length; i++) {
		const d = arr[i]; let geometry = null;
		if (kind === "polygons") { const p = gpoly(d, i) ?? (d?.geometry?.type === "Polygon" || d?.geometry?.type === "MultiPolygon" ? d.geometry : null); if (!p) continue; geometry = p.type ? p : { type: "Polygon", coordinates: ringsOf(p).map(closed) }; }
		else if (kind === "paths") { const p = gpath(d, i) ?? (d?.geometry?.type === "LineString" || d?.geometry?.type === "MultiLineString" ? d.geometry : null); if (!p) continue; geometry = p.type ? p : { type: "LineString", coordinates: p.map(q => [+q[0], +q[1]]) }; }
		else if (kind === "columns") { const p = posOf(d, i, gpos, fcPos); if (!p) continue; geometry = { type: "Polygon", coordinates: [columnRing(+p[0], +p[1], +grad(d, i) || 0, diskResolution)] }; }
		const properties = { ...(gpr ? gpr(d, i) : (d?.properties && !Array.isArray(d) ? d.properties : {})), _i: i };
		if (gf) properties._fill = css(gf(d, i)); if (gl) properties._line = css(gl(d, i)); if (gw) properties._lw = +gw(d, i) || 0; if (ge) properties._h = +ge(d, i) || 0;
		features.push({ type: "Feature", id: i, geometry, properties });
	}
	return { type: "FeatureCollection", features };
}
