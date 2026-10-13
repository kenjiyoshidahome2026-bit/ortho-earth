/** @ortho-earth/plugin-splat — Gaussian splats for @ortho-earth/globe (fills the reserved map.addData kind "splat") */
export const VERSION: string;
export const SH_C0: number;

/** the SplatData contract of @ortho-earth/globe, plus crs "local" for file sources (meters, axes as in the file) */
export interface SplatData {
	n?: number;
	/** crs "lnglat" (default): [lng, lat, alt m]; "ecef": earth-centered meters; "local": meters in the file's axes */
	positions: Float32Array;
	/** sigma of each ellipsoid axis in meters (linear) */
	scales: Float32Array;
	/** quaternion x, y, z, w (local ENU for "lnglat", ECEF for "ecef", file axes for "local") */
	rotations: Float32Array;
	/** RGBA 0..255; A is the opacity */
	colors: Uint8Array;
	/** spherical harmonics beyond DC (kept, not drawn) */
	sh?: Float32Array;
	crs?: "lnglat" | "ecef" | "local";
	/** "local" only: which file axis is up ("z"; "y" = right-up-back; "-y" = right-down-forward) */
	axes?: "z" | "y" | "-y";
}
export type SplatFormat = "ply" | "splat" | "spz";
/** your own reader, e.g. a WASM build: bytes → SplatData (crs "local" by default) */
export type SplatDecoder = (bytes: Uint8Array) => SplatData | Promise<SplatData>;

export interface SplatOptions {
	kind?: "splat";
	id?: string;
	/** file sources only: where the file's origin sits, [lng, lat, alt m] */
	origin?: [number, number, number?];
	/** file sources only: the file's up axis (default .ply / .splat "-y", .spz "y") */
	upAxis?: "z" | "y" | "-y";
	/** file sources only: [heading (clockwise from north), pitch, roll] degrees */
	orientation?: [number, number?, number?];
	/** file sources only: meters per file unit (default 1) */
	scale?: number;
	/** format when the URL has no extension, or for bytes */
	format?: SplatFormat;
	/** "relative": alt above the ground (default, except crs "ecef"); "absolute": above the ellipsoid */
	altitude?: "relative" | "absolute";
	/** multiplies every splat's opacity (default 1) */
	opacity?: number;
	/** hidden by terrain and buildings (default true) */
	depthTest?: boolean;
	/** draw above the labels (default false) */
	above?: boolean;
	/** merged into every pick hit's properties (with index) */
	properties?: Record<string, unknown>;
}
export interface SplatHit { id: number; layer: string; index: number; distance: number; lngLat: [number, number]; properties: Record<string, unknown> & { index: number } }
export interface SplatHandle {
	readonly id: string;
	readonly kind: "splat";
	/** number of splats after the last bake */
	readonly n: number;
	/** [lng, lat, alt] the layer is drawn around */
	readonly anchor: [number, number, number] | null;
	readonly overlay: unknown;
	ready: Promise<SplatHandle>;
	setData(data: SplatData | string | URL | ArrayBuffer | Uint8Array): Promise<SplatHandle>;
	setProps(p: Partial<SplatOptions>): Promise<SplatHandle>;
	setVisible(on: boolean): SplatHandle;
	pick(x: number, y: number, r?: number): Promise<SplatHit[]>;
	remove(): void;
}
export function splatPlugin(opts?: { decoders?: Partial<Record<SplatFormat, SplatDecoder>> }): { name: "plugin-splat"; version: string; provides: string[]; install(map: any): () => void };
export default splatPlugin;
export function createSplat(map: any, data: SplatData | string | URL | ArrayBuffer | Uint8Array, opts?: SplatOptions, ctx?: { decoders?: Partial<Record<SplatFormat, SplatDecoder>> }): SplatHandle;
export function checkSplatData(d: SplatData): SplatData & { n: number; crs: "lnglat" | "ecef" | "local" };
export function parsePly(bytes: ArrayBuffer | Uint8Array): SplatData;
export function parseSplat(bytes: ArrayBuffer | Uint8Array): SplatData;
export function parseSpz(bytes: ArrayBuffer | Uint8Array): Promise<SplatData>;
export function decodeSpz(raw: Uint8Array): SplatData;
/** SplatData → what the overlay draws: an anchor, ENU centers (m), ENU covariances (m², xx xy xz yy yz zz) */
export function toEnu(d: SplatData, opts?: { origin?: [number, number, number?]; upAxis?: "z" | "y" | "-y"; orientation?: [number, number?, number?]; scale?: number; opacity?: number }): { n: number; anchor: [number, number, number]; ctr: Float32Array; cov: Float32Array; rgba: Uint8Array; radius: number };
export function quatMat(x: number, y: number, z: number, w: number): number[];
export function placeMat(axes?: "z" | "y" | "-y", hpr?: [number, number?, number?], scale?: number): number[];
export const AXES: Readonly<Record<"z" | "y" | "-y", number[]>>;
