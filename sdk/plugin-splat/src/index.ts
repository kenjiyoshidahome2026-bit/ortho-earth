// @ortho-earth/plugin-splat — Gaussian splats for @ortho-earth/globe (third wave W10).
//   map.use(splatPlugin()) fills the reserved map.addData kind "splat" (contract: globe src/splat.js SplatData, or a .ply / .splat / .spz URL).
//   Drawn as a same-frame overlay (map.overlay, WebGL2): back-to-front by view depth, each splat an ellipse from its 3D covariance,
//   hidden by terrain and buildings (scene depth), picked by the unified picking (handle.pick, map.on("click", id, …), queryRenderedFeatures({ layers: [id] })).
//   Readers run on the main thread in plain JS (.spz is gunzipped with the built-in DecompressionStream); a decoder of your own (e.g. a WASM build) plugs in via splatPlugin({ decoders }).
import type { OrthoJapanMap, OrthoPlugin, OverlayHandle, OverlayPick } from "@ortho-earth/globe";
import { parsePly, parseSplat, parseSpz, formatOf, toEnu } from "./formats.ts";
import type { SplatData, SplatFormat, SplatCrs, SplatAxes, Hpr, Origin } from "./formats.ts";
export { parsePly, parseSplat, parseSpz, decodeSpz, toEnu, quatMat, placeMat, AXES, SH_C0 } from "./formats.ts";
export type { SplatData, SplatFormat, SplatCrs, SplatAxes, LocalSplatData, Hpr, Origin, ToEnuOptions, EnuSplats } from "./formats.ts";
export type { SplatMessage, SplatLayerBody, SplatPickResult, SplatAltitude, OverlayHost, CamState, SplatApi, PickContext, EnuBasis } from "./splat-gl.ts";
// 描き手（worker）の URL。字面は .js のまま＝npm の dist では実体（dist/splat-gl.js）・repo の中では Vite が .ts に読み替える
const SPLAT_URL = new URL("./splat-gl.js", import.meta.url).href;
export const VERSION = "0.1.0";

// ---- 公開の型（map.addData の opts と手綱） ----
/** your own reader, e.g. a WASM build: bytes → SplatData (crs "local" by default) */
export type SplatDecoder = (bytes: Uint8Array) => SplatData | Promise<SplatData>;
export type SplatDecoders = Partial<Record<SplatFormat, SplatDecoder>>;
export type SplatSource = SplatData | string | URL | ArrayBuffer | Uint8Array;
export interface SplatOptions {
	kind?: "splat";
	id?: string;
	/** file sources only: where the file's origin sits, [lng, lat, alt m] */
	origin?: Origin;
	/** file sources only: the file's up axis (default .ply / .splat "-y", .spz "y") */
	upAxis?: SplatAxes;
	/** file sources only: [heading (clockwise from north), pitch, roll] degrees */
	orientation?: Hpr;
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
/** handle.pick の 1 件＝統一 picking の答え（layer＝手綱の id・index＝描いた番号） */
export interface SplatHit extends OverlayPick { id: number; layer: string; index: number; distance: number; lngLat: [number, number]; properties: Record<string, unknown> & { index: number } }
export interface SplatHandle {
	readonly id: string;
	readonly kind: "splat";
	/** number of splats after the last bake */
	n: number;
	/** [lng, lat, alt] the layer is drawn around */
	anchor: [number, number, number] | null;
	/** the overlay handle (map.overlay) */
	readonly overlay: OverlayHandle;
	ready: Promise<SplatHandle>;
	setData(data: SplatSource): Promise<SplatHandle>;
	setProps(p: Partial<SplatOptions>): Promise<SplatHandle>;
	setVisible(on: boolean): SplatHandle;
	pick(x: number, y: number, r?: number): Promise<SplatHit[]>;
	remove(): void;
}
export interface SplatPlugin extends OrthoPlugin { name: "plugin-splat"; version: string; provides: string[]; install(map: OrthoJapanMap): () => void }
/** この plugin が使う map の口（@ortho-earth/globe の map） */
export type SplatMap = Pick<OrthoJapanMap, "overlay" | "pickOverlays">;
type Reader = (bytes: Uint8Array) => SplatData | Promise<SplatData>;
const READERS: Record<SplatFormat, Reader> = { ply: parsePly, splat: parseSplat, spz: parseSpz };

const checkEnum = <T>(v: T, list: readonly string[], name: string): T => { if (!list.some(x => x === v)) throw new Error(`plugin-splat: ${name} must be ${list.join(" | ")} (got ${JSON.stringify(v)})`); return v; };
// 契約の形（globe の normSplat と同じ検め＝plugin を直に呼んだ時のため）
export function checkSplatData(d: SplatData): SplatData & { n: number; crs: SplatCrs } {
	if (!d || typeof d !== "object") throw new TypeError("plugin-splat: data must be SplatData or a .ply/.splat/.spz URL");
	const n = d.n ?? (d.positions instanceof Float32Array ? d.positions.length / 3 : NaN), crs = d.crs ?? "lnglat";
	if (!Number.isInteger(n) || n < 0) throw new RangeError("plugin-splat: n must be a non-negative integer");
	checkEnum(crs, ["lnglat", "ecef", "local"], "crs");
	const f = (v: unknown, nm: string, len: number): void => { if (!(v instanceof Float32Array) || v.length !== len) throw new TypeError(`plugin-splat: ${nm} must be a Float32Array of length ${len}`); };
	f(d.positions, "positions", n * 3); f(d.scales, "scales", n * 3); f(d.rotations, "rotations", n * 4);
	if (!(d.colors instanceof Uint8Array) || d.colors.length !== n * 4) throw new TypeError(`plugin-splat: colors must be a Uint8Array of length ${n * 4}`);
	return { ...d, n, crs };
}

// ---- 一つの map に一つのオーバーレイ（render worker の WebGL 文脈は Chrome で 4 つまで＝層ごとに作ると地球が落ちる） ----
interface SharedSlot { ov: OverlayHandle; refs: number }
interface SharedEntry { ids: Set<string>; below?: SharedSlot; above?: SharedSlot }
const shared = new WeakMap<object, SharedEntry>();
function acquire(map: SplatMap, above: boolean, id: string): { ov: OverlayHandle; release(): void } {
	let m = shared.get(map); if (!m) shared.set(map, (m = { ids: new Set() }));
	if (m.ids.has(id)) throw new Error(`plugin-splat: a layer with id "${id}" already exists`);
	const k = above ? "above" : "below";
	if (!m[k]) m[k] = { ov: map.overlay(SPLAT_URL, { name: above ? "plugin-splat:above" : "plugin-splat", above, opts: { depth: true } }), refs: 0 };
	m[k].refs++; m.ids.add(id);
	return { ov: m[k].ov, release() { m.ids.delete(id); if (--m[k]!.refs > 0) return; m[k]!.ov.remove(); delete m[k]; } };
}

async function load(src: string | URL | ArrayBuffer | Uint8Array, o: SplatOptions, decoders: SplatDecoders | undefined): Promise<SplatData & { n: number; crs: SplatCrs }> {
	const fmt = o.format ?? formatOf(src);
	if (!fmt) throw new Error(`plugin-splat: cannot tell the format of ${String(src).slice(0, 80)} (pass opts.format "ply" | "splat" | "spz")`);
	checkEnum(fmt, ["ply", "splat", "spz"], "format");
	let bytes: Uint8Array;
	if (typeof src === "string" || src instanceof URL) {
		const u = new URL(String(src), globalThis.location?.href).href, r = await fetch(u);
		if (!r.ok) throw new Error(`plugin-splat: ${u} → HTTP ${r.status}`);
		bytes = new Uint8Array(await r.arrayBuffer());
	} else if (src instanceof ArrayBuffer) bytes = new Uint8Array(src);
	else bytes = src;
	const d = await (decoders?.[fmt] ?? READERS[fmt])(bytes);
	return checkSplatData({ crs: "local", ...d });
}
const isFileSource = (src: SplatSource): src is string | URL | ArrayBuffer | Uint8Array => typeof src === "string" || src instanceof URL || src instanceof ArrayBuffer || src instanceof Uint8Array;
// 統一 picking の答え（この描き手の pick は id・index・distance・lngLat・properties を必ず入れる）
const isSplatHit = (id: string) => (t: OverlayPick): t is SplatHit => t.layer === id;

let anonSeq = 0;
/** map.addData(data, { kind: "splat", … }) の実体 */
export function createSplat(map: SplatMap, data: SplatSource, opts: SplatOptions = {}, { decoders }: { decoders?: SplatDecoders } = {}): SplatHandle {
	if (opts.altitude != null) checkEnum(opts.altitude, ["relative", "absolute"], "altitude");
	if (opts.upAxis != null) checkEnum(opts.upAxis, ["z", "y", "-y"], "upAxis");
	const id = opts.id ?? `splat${++anonSeq}`;
	const { ov, release } = acquire(map, !!opts.above, id);
	try { ov.addLayerId?.(id); } catch (e) { release(); throw e; }   // 同じ id の層が既にある＝投げる
	let cur: SplatSource = data, props: SplatOptions = { ...opts }, removed = false, seq = 0;
	const run = async (src: SplatSource, o: SplatOptions): Promise<SplatHandle> => {
		const my = ++seq;
		const d = isFileSource(src) ? await load(src, o, decoders) : checkSplatData(src);
		const e = toEnu(d, { origin: o.origin, upAxis: o.upAxis, orientation: o.orientation, scale: o.scale ?? 1, opacity: o.opacity ?? 1 });
		if (removed || my !== seq) return h;
		const rgba = e.rgba === d.colors && !(typeof src === "string") ? e.rgba.slice() : e.rgba;   // 渡した人の配列は手放さない（transfer は写しで）
		h.n = e.n; h.anchor = e.anchor; cur = src;
		ov.post({ type: "layer", q: id, n: e.n, anchor: e.anchor, alt: o.altitude ?? (d.crs === "ecef" ? "absolute" : "relative"), ctr: e.ctr, cov: e.cov, rgba, radius: e.radius, depthTest: o.depthTest !== false, properties: o.properties ?? null }, [e.ctr.buffer, e.cov.buffer, rgba.buffer as ArrayBuffer]);
		return h;
	};
	const h: SplatHandle = {
		id, kind: "splat", overlay: ov, n: 0, anchor: null,
		ready: undefined as unknown as Promise<SplatHandle>,   // 直後に run で埋める（JS の元の形と同じ順）
		setData: (d: SplatSource) => (h.ready = run(d, props)),
		setProps: (p: Partial<SplatOptions>) => { props = { ...props, ...p }; return (h.ready = run(cur, props)); },
		setVisible: (on: boolean) => { if (!removed) ov.post({ type: "vis", q: id, on: !!on }); return h; },
		pick: async (x: number, y: number, r = 4): Promise<SplatHit[]> => (await map.pickOverlays(x, y, { radius: r, names: [ov.name] })).filter(isSplatHit(id)),
		remove: () => { if (removed) return; removed = true; ov.post({ type: "remove", q: id }); ov.removeLayerId?.(id); release(); },
	};
	h.ready = run(data, props);
	return h;
}

/** map.use(splatPlugin()) → map.addData(data, { kind: "splat", origin?, upAxis?, orientation?, scale?, altitude?, opacity?, depthTest?, above?, properties? }) */
export function splatPlugin({ decoders }: { decoders?: SplatDecoders } = {}): SplatPlugin {
	if (decoders != null) for (const [k, f] of Object.entries(decoders)) { checkEnum(k, ["ply", "splat", "spz"], "decoders key"); if (typeof f !== "function") throw new TypeError(`plugin-splat: decoders.${k} must be a function (bytes) → SplatData`); }
	return {
		name: "plugin-splat",
		version: VERSION,
		provides: ["data.splat"],
		install(map: OrthoJapanMap): () => void {
			map.registry.dataKinds.add("splat", { create: (m, data, o) => createSplat(m, data as SplatSource, o as SplatOptions, { decoders }) });
			return () => { try { map.registry.dataKinds.remove("splat"); } catch { /* 既に外れた */ } };
		},
	};
}
export default splatPlugin;
