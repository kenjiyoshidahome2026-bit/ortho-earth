// Gaussian splat の受け口（第 2 波 F8・2026-10-12）＝契約だけ。描く段（視線順のソート・楕円の描画・深度）は registry.dataKinds の "splat" を plugin が足す
//   map.addData(data, { kind: "splat" })：data＝SplatData（下）か、.ply/.splat/.spz/.ksplat/.sog の URL（読み手も plugin＝WASM は opt-in alias・.ksplat/.sog は 2026-10-21）
//   SplatData＝{ n, positions: Float32Array(n*3), scales: Float32Array(n*3), rotations: Float32Array(n*4)（四元数 x,y,z,w）, colors: Uint8Array(n*4)（RGBA 0〜255）, sh?: Float32Array, crs?: "lnglat"|"ecef" }
//   positions は crs "lnglat"（既定）なら [lng, lat, alt(m)] の並び、"ecef" なら地心直交（m）、"local" なら file の座標（m）＋transform（列優先 4×4・local → ECEF＝3D Tiles の glTF の splat・2026-10-18）。plugin はこの形で受け取る＝normSplat が検める
import type { SplatData } from "../globe.d.ts";

/** normSplat が検める前の形（欄は何が来てもよい） */
type SplatIn = { [K in keyof SplatData]?: unknown } & { n?: number; positions?: Float32Array; colors?: Uint8Array; sh?: Float32Array; crs?: string; transform?: ArrayLike<number> };
export const SPLAT_FORMATS: readonly string[] = Object.freeze(["ply", "splat", "spz", "ksplat", "sog"]);
const SPLAT_CRS: readonly string[] = Object.freeze(["lnglat", "ecef", "local"]);
export const isSplatUrl = (u: unknown): u is string => typeof u === "string" && /\.(ply|splat|spz|ksplat|sog)(\?|#|$)/i.test(u);
const f32 = (v: unknown, name: string, len: number) => {
	if (!(v instanceof Float32Array)) throw new TypeError(`splat: ${name} must be a Float32Array`);
	if (v.length !== len) throw new RangeError(`splat: ${name} length ${v.length} != ${len}`);
	return v;
};
// 契約を検めて正規化（URL と bytes（ArrayBuffer／Uint8Array＝opts.format が要る・plugin が読む）はそのまま返す）。sh は任意（長さは n の倍数＝次数は plugin が決める）
export const normSplat = (data: unknown): string | ArrayBuffer | Uint8Array | (SplatData & { n: number; crs: "lnglat" | "ecef" | "local" }) => {
	if (isSplatUrl(data)) return data;
	if (data instanceof ArrayBuffer || data instanceof Uint8Array) return data;
	if (!data || typeof data !== "object") throw new TypeError("splat: data must be SplatData or a .ply/.splat/.spz/.ksplat/.sog URL");
	const n = (data as SplatIn).n ?? ((data as SplatIn).positions instanceof Float32Array ? (data as SplatIn).positions!.length / 3 : NaN);
	if (!Number.isInteger(n) || n < 0) throw new RangeError("splat: n must be a non-negative integer");
	const crs = (data as SplatIn).crs ?? "lnglat";
	if (!SPLAT_CRS.includes(crs)) throw new RangeError(`splat: crs must be ${SPLAT_CRS.join("|")}`);
	const out: SplatData & { n: number; crs: "lnglat" | "ecef" | "local" } = { n, crs, positions: f32((data as SplatIn).positions, "positions", n * 3), scales: f32((data as SplatIn).scales, "scales", n * 3), rotations: f32((data as SplatIn).rotations, "rotations", n * 4) } as SplatData & { n: number; crs: "lnglat" | "ecef" | "local" };
	if (crs === "local") {   // local＝transform（列優先 4×4・16 個の有限な数）が要る
		const m = (data as SplatIn).transform, a = m != null && typeof m === "object" && typeof m.length === "number" ? Array.from(m, Number) : null;
		if (!a || a.length !== 16 || !a.every(Number.isFinite)) throw new TypeError("splat: crs \"local\" needs transform = a column-major 4x4 (16 finite numbers, local meters → ECEF meters)");
		out.transform = a;
	}
	if (!((data as SplatIn).colors instanceof Uint8Array) || (data as SplatIn).colors!.length !== n * 4) throw new TypeError(`splat: colors must be a Uint8Array of length ${n * 4}`);
	out.colors = (data as SplatIn).colors!;
	if ((data as SplatIn).sh != null) { if (!((data as SplatIn).sh instanceof Float32Array) || (n > 0 && (data as SplatIn).sh!.length % n !== 0)) throw new TypeError("splat: sh must be a Float32Array with a multiple of n entries"); out.sh = (data as SplatIn).sh!; }
	return out;
};
