// Imagery draped on meshes (set "meshDrape" / "meshImagery": Cesium3DTileset.imageryLayers). A drape is one picture over a geographic window
// (Web Mercator: rows evenly spaced in Mercator y, north at the top). A batch's fragment maps its origin-relative place to the picture's uv
// with a plane map made here in double: the inverse of [∂P/∂lon, ∂P/∂lat, up] at the window's centre (β space, as lonlatTo3D), so a point
// above the ground reads the picture under it (Cesium projects imagery straight down on the tiles). The map is linear: over a window of
// 10 km the Mercator rows bend by ~5 m, far below a pixel of a picture that wide. GL (u_drU/u_drV/u_drOn) and WebGPU (PB dr0/dr1/dr2) share it.
import { lonlatTo3D, ellNormal3D } from "./camera.ts";

/** what set("meshDrape", d, id) takes: the picture (an ImageBitmap, or RGBA bytes) and its window in degrees */
export interface DrapeIn { bitmap?: ImageBitmap | null; rgba?: Uint8Array | null; w?: number; h?: number; west: number; south: number; east: number; north: number }
/** the window's plane map: u = U·(P − C) + 0.5, v = V·(P − C) + 0.5 (P in β space) */
export interface DrapeMap { U: number[]; V: number[]; C: number[] }

const D2R = Math.PI / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85.06, Math.min(85.06, lat)) * D2R / 2));

export function drapeMap(d: DrapeIn): DrapeMap | null {
	const { west, south, east, north } = d;
	if (![west, south, east, north].every(Number.isFinite) || east <= west || north <= south) return null;
	const yN = mercY(north), yS = mercY(south), lonC = (west + east) / 2, latC = Math.atan(Math.sinh((yN + yS) / 2)) / D2R;
	const C = lonlatTo3D(lonC, latC), e = 1e-4;
	const a = lonlatTo3D(lonC + e, latC), b = lonlatTo3D(lonC - e, latC), c = lonlatTo3D(lonC, latC + e), f = lonlatTo3D(lonC, latC - e);
	const Pl = [0, 1, 2].map(i => (a[i] - b[i]) / (2 * e)), Pp = [0, 1, 2].map(i => (c[i] - f[i]) / (2 * e)), m = ellNormal3D(lonC, latC);
	// rows of [Pl Pp m]⁻¹ (columns): r0·x = Δlon, r1·x = Δlat for x = Δlon·Pl + Δlat·Pp + h·m
	const cr = (x: number[], y: number[]) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
	const det = Pl[0] * (Pp[1] * m[2] - Pp[2] * m[1]) - Pp[0] * (Pl[1] * m[2] - Pl[2] * m[1]) + m[0] * (Pl[1] * Pp[2] - Pl[2] * Pp[1]);
	if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
	const r0 = cr(Pp, m).map(v => v / det), r1 = cr(m, Pl).map(v => v / det);
	const du = 1 / (east - west), dv = -D2R / Math.cos(latC * D2R) / (yN - yS);   // v grows southward: dv/dlat = −(dy/dlat)/(yN − yS), dy/dlat = 1/cos φ per radian
	return { U: r0.map(v => v * du), V: r1.map(v => v * dv), C };
}

/** the batch's 12 floats (dr0, dr1, dr2 / u_drU, u_drV, u_drOn): the plane map against the batch origin, offset in double */
export function drapeUniforms(out: Float32Array | number[], o: number, m: DrapeMap | null, origin: ArrayLike<number>): void {
	if (!m) { for (let i = 0; i < 12; i++) out[o + i] = 0; return; }
	const dx = origin[0] - m.C[0], dy = origin[1] - m.C[1], dz = origin[2] - m.C[2];
	out[o] = m.U[0]; out[o + 1] = m.U[1]; out[o + 2] = m.U[2]; out[o + 3] = m.U[0] * dx + m.U[1] * dy + m.U[2] * dz + 0.5;
	out[o + 4] = m.V[0]; out[o + 5] = m.V[1]; out[o + 6] = m.V[2]; out[o + 7] = m.V[0] * dx + m.V[1] * dy + m.V[2] * dz + 0.5;
	out[o + 8] = 1; out[o + 9] = 0; out[o + 10] = 0; out[o + 11] = 0;
}
