// voxel（3 次元格子）の受け口（第 4 波 V0・2026-10-23）＝契約だけ。描く段（箱の裏面から光線を入れて DDA で辿る・体積／ブロック／等値面・深度）は registry.dataKinds の "voxel" を plugin が足す
//   map.addData(data, { kind: "voxel" })：data＝VoxelData（下）か、URL／bytes（読み手も plugin＝NetCDF／Zarr は後の段）
//   VoxelData＝{ shape: "box"|"region"|"cylinder", dims: [nx, ny, nz], box?: { origin:[lng,lat,alt], size:[m,m,m], orientation?:[h,p,r] } | { transform: 列優先 4×4（局所の単位立方体 [0,1]³ → ECEF m） }, region?: [w,s,e,n（度）, h0,h1（m）],
//               cylinder?: { origin, orientation? } | { transform: 列優先 4×4（局所 m → ECEF m） } ＋ radius: [内, 外] m・height: [下, 上] m・angle?: [始め, 終わり] 度（dims＝[半径, 角度, 高さ]・局所の z が軸・角度は +x から反時計回り＝3D Tiles の円柱と同じ）,
//               values: Float32Array|Uint16Array|Uint8Array（nx*ny*nz*components・x が最も速く変わる＝i + nx*(j + ny*k)）, components?: 1|4（1＝スカラー・4＝RGBA 直）, noData?, range?: [min,max],
//               times?: number[]（時間の次元＝こまの時刻 ms・昇順。values はこまを順に並べて ×こま数）}
//   shape は box・region・cylinder のどれかが在れば省略できる。plugin はこの形で受け取る＝normVoxel が検める。計画＝sdk/voxel/PLAN.md
import type { VoxelData } from "../globe.d.ts";

/** normVoxel が検める前の形（欄は何が来てもよい） */
type VoxelIn = { [K in keyof VoxelData]?: unknown };
export const VOXEL_SHAPES: readonly string[] = Object.freeze(["box", "region", "cylinder"]);
export const isVoxelUrl = (u: unknown): u is string => typeof u === "string" && /\.(nc|zarr|vox|npy)(\?|#|$)/i.test(u);
const nums = (v: unknown, name: string, len: number): number[] => {
	const a = v != null && typeof v === "object" && typeof (v as ArrayLike<number>).length === "number" ? Array.from(v as ArrayLike<number>, Number) : null;
	if (!a || a.length !== len || !a.every(Number.isFinite)) throw new TypeError(`voxel: ${name} must be ${len} finite numbers`);
	return a;
};
/** 検めた VoxelData（shape・dims・components は必ず埋まる） */
export type NormVoxel = VoxelData & { shape: "box" | "region" | "cylinder"; dims: [number, number, number]; components: 1 | 4 };
/** 検めた cylinder（radius／height／angle は [lo, hi]・angle は hi > lo で幅 360 まで） */
export type NormCylinder = ({ origin: [number, number, number]; orientation?: [number, number, number] } | { transform: number[] }) & { radius: [number, number]; height: [number, number]; angle: [number, number] };
/** 一つの数か [lo, hi] → [lo, hi]（数一つ＝[0, v]） */
const span = (v: unknown, name: string): [number, number] => typeof v === "number" ? [0, v] : nums(v, name, 2) as [number, number];
/** cylinder の検め（2026-10-26）＝置き方（origin＋orientation か transform）・radius／height（数一つ＝[0, v]）・angle（度・既定 [-180, 180]・終わり ≤ 始め＝±180 を跨ぐ＝終わりに 360 を足す） */
export function normCylinder(c: unknown): NormCylinder {
	if (!c || typeof c !== "object") throw new TypeError("voxel: shape \"cylinder\" needs cylinder = { origin, orientation?, radius, height, angle? } | { transform, radius, height, angle? }");
	const o = c as { origin?: unknown; orientation?: unknown; transform?: unknown; radius?: unknown; height?: unknown; angle?: unknown };
	const radius = span(o.radius, "cylinder.radius"), height = span(o.height, "cylinder.height");
	if (!(radius[0] >= 0 && radius[0] < radius[1])) throw new RangeError("voxel: cylinder.radius must be [inner, outer] with 0 <= inner < outer");
	if (!(height[0] < height[1])) throw new RangeError("voxel: cylinder.height must be [bottom, top] with bottom < top");
	let angle: [number, number] = [-180, 180];
	if (o.angle != null) {
		const [a0, a1] = nums(o.angle, "cylinder.angle", 2), b = a1 > a0 ? a1 : a1 + 360;
		if (!(b - a0 <= 360 + 1e-9)) throw new RangeError("voxel: cylinder.angle must span at most 360 degrees");
		angle = [a0, Math.min(b, a0 + 360)];
	}
	if (o.transform != null) return { transform: nums(o.transform, "cylinder.transform", 16), radius, height, angle };
	const out: NormCylinder = { origin: nums(o.origin, "cylinder.origin", 3) as [number, number, number], radius, height, angle };
	if (o.orientation != null) out.orientation = nums(o.orientation, "cylinder.orientation", 3) as [number, number, number];
	return out;
}
// 契約を検めて正規化（URL と bytes（ArrayBuffer／Uint8Array＝opts.format が要る・plugin が読む）はそのまま返す）
export const normVoxel = (data: unknown): string | ArrayBuffer | Uint8Array | NormVoxel => {
	if (isVoxelUrl(data)) return data;
	if (data instanceof ArrayBuffer || data instanceof Uint8Array) return data;
	if (!data || typeof data !== "object") throw new TypeError("voxel: data must be VoxelData or a .nc/.zarr/.vox/.npy URL");
	const d = data as VoxelIn;
	const dims = nums(d.dims, "dims", 3) as [number, number, number];
	if (!dims.every(n => Number.isInteger(n) && n > 0)) throw new RangeError("voxel: dims must be three positive integers");
	const shape = d.shape ?? (d.box != null ? "box" : d.region != null ? "region" : d.cylinder != null ? "cylinder" : undefined);
	if (!VOXEL_SHAPES.includes(shape as string)) throw new RangeError(`voxel: shape must be ${VOXEL_SHAPES.join("|")} (or pass box / region / cylinder)`);
	const components = d.components ?? 1;
	if (components !== 1 && components !== 4) throw new RangeError("voxel: components must be 1 | 4");
	const out = { shape, dims, components } as NormVoxel;
	if (shape === "box") {   // box＝origin＋size（＋orientation）か transform（列優先 4×4・16 個の有限な数）
		const b = d.box as VoxelData["box"] | undefined;
		if (!b || typeof b !== "object") throw new TypeError("voxel: shape \"box\" needs box = { origin, size, orientation? } | { transform }");
		if ("transform" in b && b.transform != null) out.box = { transform: nums(b.transform, "box.transform", 16) };
		else {
			const o = b as { origin?: unknown; size?: unknown; orientation?: unknown };
			const origin = nums(o.origin, "box.origin", 3) as [number, number, number], size = nums(o.size, "box.size", 3) as [number, number, number];
			if (!size.every(s => s > 0)) throw new RangeError("voxel: box.size must be positive meters");
			out.box = { origin, size };
			if (o.orientation != null) out.box.orientation = nums(o.orientation, "box.orientation", 3) as [number, number, number];
		}
	} else if (shape === "cylinder") out.cylinder = normCylinder(d.cylinder);
	else {   // region＝[w, s, e, n（度）, h0, h1（m）]＝3D Tiles の region と同じ並び（単位は度）
		const r = nums(d.region, "region", 6) as VoxelData["region"] & number[];
		if (!(r[1] < r[3]) || Math.abs(r[1]) > 90 || Math.abs(r[3]) > 90) throw new RangeError("voxel: region south must be < north within ±90°");
		if (!(r[4] < r[5])) throw new RangeError("voxel: region h0 must be < h1");
		out.region = r;
	}
	// times＝時間の次元（2026-10-24・voxel 第 5 段）＝各こまの時刻（ms・昇順）。values はこまを順に並べた物（こま t は t*nx*ny*nz*components から）
	let frames = 1;
	if (d.times != null) {
		const t = d.times as ArrayLike<number>;
		if (typeof t !== "object" || typeof t.length !== "number" || t.length < 1) throw new TypeError("voxel: times must be a non-empty list of times (ms)");
		const a = Array.from(t, Number);
		if (!a.every(Number.isFinite) || a.some((x, i) => i > 0 && !(x > a[i - 1]))) throw new RangeError("voxel: times must be finite and strictly ascending (ms)");
		out.times = a; frames = a.length;
	}
	const v = d.values, len = dims[0] * dims[1] * dims[2] * components * frames;
	if (!(v instanceof Float32Array || v instanceof Uint16Array || v instanceof Uint8Array)) throw new TypeError("voxel: values must be a Float32Array | Uint16Array | Uint8Array");
	if (v.length !== len) throw new RangeError(`voxel: values length ${v.length} != ${len} (nx*ny*nz*components${frames > 1 ? "*times" : ""})`);
	out.values = v;
	if (d.noData != null) { if (typeof d.noData !== "number" || !Number.isFinite(d.noData)) throw new TypeError("voxel: noData must be a finite number"); out.noData = d.noData; }
	if (d.range != null) { const [lo, hi] = nums(d.range, "range", 2); if (!(lo < hi)) throw new RangeError("voxel: range must be [min, max] with min < max"); out.range = [lo, hi]; }
	return out;
};
