// Gaussian splat の受け口（第 2 波 F8・2026-10-12）＝契約だけ。描く段（視線順のソート・楕円の描画・深度）は registry.dataKinds の "splat" を plugin が足す
//   map.addData(data, { kind: "splat" })：data＝SplatData（下）か、.ply/.splat/.spz の URL（読み手も plugin＝WASM は opt-in alias）
//   SplatData＝{ n, positions: Float32Array(n*3), scales: Float32Array(n*3), rotations: Float32Array(n*4)（四元数 x,y,z,w）, colors: Uint8Array(n*4)（RGBA 0〜255）, sh?: Float32Array, crs?: "lnglat"|"ecef" }
//   positions は crs "lnglat"（既定）なら [lng, lat, alt(m)] の並び、"ecef" なら地心直交（m）。plugin はこの形で受け取る＝normSplat が検める
export const SPLAT_FORMATS = Object.freeze(["ply", "splat", "spz"]);
export const SPLAT_CRS = Object.freeze(["lnglat", "ecef"]);
export const isSplatUrl = u => typeof u === "string" && /\.(ply|splat|spz)(\?|#|$)/i.test(u);
const f32 = (v, name, len) => {
	if (!(v instanceof Float32Array)) throw new TypeError(`splat: ${name} must be a Float32Array`);
	if (v.length !== len) throw new RangeError(`splat: ${name} length ${v.length} != ${len}`);
	return v;
};
// 契約を検めて正規化（URL はそのまま返す）。sh は任意（長さは n の倍数＝次数は plugin が決める）
export const normSplat = data => {
	if (isSplatUrl(data)) return data;
	if (!data || typeof data !== "object") throw new TypeError("splat: data must be SplatData or a .ply/.splat/.spz URL");
	const n = data.n ?? (data.positions instanceof Float32Array ? data.positions.length / 3 : NaN);
	if (!Number.isInteger(n) || n < 0) throw new RangeError("splat: n must be a non-negative integer");
	const crs = data.crs ?? "lnglat";
	if (!SPLAT_CRS.includes(crs)) throw new RangeError(`splat: crs must be ${SPLAT_CRS.join("|")}`);
	const out = { n, crs, positions: f32(data.positions, "positions", n * 3), scales: f32(data.scales, "scales", n * 3), rotations: f32(data.rotations, "rotations", n * 4) };
	if (!(data.colors instanceof Uint8Array) || data.colors.length !== n * 4) throw new TypeError(`splat: colors must be a Uint8Array of length ${n * 4}`);
	out.colors = data.colors;
	if (data.sh != null) { if (!(data.sh instanceof Float32Array) || (n > 0 && data.sh.length % n !== 0)) throw new TypeError("splat: sh must be a Float32Array with a multiple of n entries"); out.sh = data.sh; }
	return out;
};
