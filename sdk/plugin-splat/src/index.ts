// @ortho-earth/plugin-splat — Gaussian splats for @ortho-earth/globe (third wave W10; WebGPU renderer, worker reader and LoD 2026-10-18).
//   map.use(splatPlugin()) fills the reserved map.addData kind "splat" (contract: globe src/splat.js SplatData, or a .ply / .splat / .spz URL).
//   Drawn as a same-frame overlay (map.overlay): WebGPU first (splat-gpu.ts = spherical harmonics, GPU counting sort, the map's GPUDevice and depth texture shared,
//   no read-back, LoD = the heaviest N splats when the layer is small on screen), WebGL2 where there is no WebGPU (splat-gl.ts = DC color, CPU sort, no LoD). splat-draw.ts picks.
//   Each splat is an ellipse from its 3D covariance, blended back to front, hidden by terrain and buildings (scene depth), picked by the unified picking
//   (handle.pick, map.on("click", id, …), queryRenderedFeatures({ layers: [id] })).
//   Reading (fetch, gunzip, parse, ENU placement, SH packing, LoD ranking) runs in a worker (splat-reader.ts); the main thread only forwards the buffers (transfer).
//   A decoder of your own (e.g. a WASM build) plugs in via splatPlugin({ decoders }) and runs on the main thread (functions cannot cross to the worker).
import type { GlobeMap, OrthoPlugin, OverlayHandle, OverlayPick } from "@ortho-earth/globe";
import { formatOf, checkEnum, checkSplatData, checkTransform, prepare, readerFor, transferables } from "./formats.ts";
import type { SplatData, SplatFormat, SplatCrs, SplatAxes, Hpr, Origin, Prepared, PrepareOptions } from "./formats.ts";
import type { ReaderRequest, ReaderReply } from "./splat-reader.ts";
export { parsePly, parseSplat, parseSpz, decodeSpz, toEnu, packSh, shDegreeOf, importanceRank, prepare, checkSplatData, quatMat, placeMat, AXES, SH_C0 } from "./formats.ts";
export type { SplatData, SplatFormat, SplatCrs, SplatAxes, LocalSplatData, Hpr, Origin, ToEnuOptions, EnuSplats, PackedSh, Prepared, PrepareOptions } from "./formats.ts";
export type { SplatMessage, SplatLayerBody, SplatPickResult, SplatAltitude, OverlayHost, CamState, SplatApi, PickContext, EnuBasis } from "./splat-gl.ts";
export type { SplatBackend, SplatDrawOpts } from "./splat-draw.ts";
import type { SplatBackend } from "./splat-draw.ts";
// 描き手（worker）の URL＝入口（splat-draw.js が WebGPU／WebGL2 を選んで兄弟を import）。字面は .js のまま＝npm の dist では実体・repo の中では Vite が .ts に読み替える
const SPLAT_URL = new URL("./splat-draw.js", import.meta.url).href;
export const VERSION = "0.4.0";

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
	/** file sources and crs "local" data: a column-major 4×4 that takes the file's coordinates (meters) to ECEF, e.g. a glTF node matrix × a 3D Tiles tile transform. Replaces origin / upAxis / orientation / scale; altitude defaults to "absolute" */
	transform?: ArrayLike<number>;
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
	/** highest spherical-harmonics degree to draw (0 = DC only, default 3 = whatever the data has). WebGPU only */
	shDegree?: 0 | 1 | 2 | 3;
	/** level of detail: when the layer is small on screen only its heaviest splats (opacity × size) are drawn. true (default) = about 2 splats per screen pixel of the layer's footprint, a number = that density, false = always every splat. WebGPU only */
	lod?: boolean | number;
}
/** splatPlugin の opts */
export interface SplatPluginOptions {
	/** your own readers (e.g. a WASM .spz decoder) */
	decoders?: SplatDecoders;
	/** "auto" (default): WebGPU when the map draws with WebGPU (shared device), else WebGL2. "webgpu": WebGPU (own device under a WebGL2 map) or fail. "webgl2": always WebGL2 (DC color, CPU sort) */
	backend?: SplatBackend | "auto";
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
	/** which renderer draws this map's splats: "webgpu" | "webgl2", null until the overlay has chosen (after the first frame) */
	readonly backend: SplatBackend | null;
	/** how many splats the last frame drew (LoD; equals n when every splat is drawn or on WebGL2) */
	drawn: number;
	/** where the last source was read and prepared: "worker" (splat-reader.ts) or "main" (own decoder, or no worker in this environment); null before the first bake */
	reader: "worker" | "main" | null;
	ready: Promise<SplatHandle>;
	setData(data: SplatSource): Promise<SplatHandle>;
	setProps(p: Partial<SplatOptions>): Promise<SplatHandle>;
	setVisible(on: boolean): SplatHandle;
	pick(x: number, y: number, r?: number): Promise<SplatHit[]>;
	remove(): void;
}
export interface SplatPlugin extends OrthoPlugin { name: "plugin-splat"; version: string; provides: string[]; install(map: GlobeMap): () => void }
/** この plugin が使う map の口（@ortho-earth/globe の map） */
export type SplatMap = Pick<GlobeMap, "overlay" | "pickOverlays">;
// ---- 一つの map に一つのオーバーレイ（render worker の WebGL 文脈は Chrome で 4 つまで＝層ごとに作ると地球が落ちる） ----
interface SharedSlot { ov: OverlayHandle; refs: number; backend: SplatBackend | null; onLod: Map<string, (drawn: number) => void> }
interface SharedEntry { ids: Set<string>; below?: SharedSlot; above?: SharedSlot }
const shared = new WeakMap<object, SharedEntry>();
function acquire(map: SplatMap, above: boolean, id: string, backend: SplatBackend | "auto"): { ov: OverlayHandle; slot: SharedSlot; release(): void } {
	let m = shared.get(map); if (!m) shared.set(map, (m = { ids: new Set() }));
	if (m.ids.has(id)) throw new Error(`plugin-splat: a layer with id "${id}" already exists`);
	const k = above ? "above" : "below";
	if (!m[k]) {
		const ov = map.overlay(SPLAT_URL, { name: above ? "plugin-splat:above" : "plugin-splat", above, opts: { depth: true, backend } });
		const slot: SharedSlot = { ov, refs: 0, backend: null, onLod: new Map() };
		ov.onmessage = (d: unknown) => {   // 描き手の答え（検定の probe は onmessage を包んで前の物へ流す）
			const e = d as { type?: string; backend?: SplatBackend | null; error?: string; q?: string; drawn?: number } | null;
			if (e?.type === "backend") { slot.backend = e.backend ?? null; if (e.error) console.error("[plugin-splat] overlay failed:", e.error); }
			else if (e?.type === "lod" && e.q != null) slot.onLod.get(e.q)?.(e.drawn ?? 0);
		};
		m[k] = slot;
	}
	m[k].refs++; m.ids.add(id);
	return { ov: m[k].ov, slot: m[k], release() { m.ids.delete(id); if (--m[k]!.refs > 0) return; m[k]!.ov.remove(); delete m[k]; } };
}

// ---- 読み手の worker（一つ・怠けて立てる・手綱が全部外れたら少し待って片付ける） ----
interface Reader { w: Worker; pending: Map<number, { res: (p: Prepared) => void; rej: (e: Error) => void }>; seq: number }
let reader: Reader | null = null, readerBroken = false, liveHandles = 0, readerIdle: ReturnType<typeof setTimeout> | null = null;
function spawnReader(): Reader | null {
	if (reader) return reader;
	if (readerBroken || typeof Worker === "undefined") return null;
	try {
		const w = new Worker(new URL("./splat-reader.ts", import.meta.url), { type: "module", name: "splat-reader" });
		const r: Reader = { w, pending: new Map(), seq: 0 };
		w.onmessage = ({ data: m }: { data: ReaderReply }) => { const p = r.pending.get(m.seq); if (!p) return; r.pending.delete(m.seq); if (m.ok) { const { seq: _s, ok: _o, ...rest } = m; p.res(rest); } else p.rej(new Error(m.error)); };
		w.onerror = (e: ErrorEvent) => {   // worker が立たない（別オリジン・CSP）＝この先は main で読む。待っている物は main でやり直す
			readerBroken = true; reader = null; try { w.terminate(); } catch { /* 既に死んでいる */ }
			const err = new Error(`plugin-splat: reader worker failed (${e?.message || "error"})`); (err as Error & { fallback?: boolean }).fallback = true;
			for (const p of r.pending.values()) p.rej(err); r.pending.clear();
			console.warn("[plugin-splat] reader worker unavailable, reading on the main thread:", e?.message || e);
		};
		return (reader = r);
	} catch (e) { readerBroken = true; console.warn("[plugin-splat] reader worker unavailable, reading on the main thread:", (e as { message?: string } | null)?.message || e); return null; }
}
const readerUsed = (): void => { liveHandles++; if (readerIdle) { clearTimeout(readerIdle); readerIdle = null; } };
const readerFree = (): void => { if (--liveHandles > 0 || !reader) return; readerIdle = setTimeout(() => { readerIdle = null; if (liveHandles || !reader) return; reader.w.terminate(); reader = null; }, 5000); };
// src → Prepared（worker で。自前の読み手の format・worker の無い器は main で）
async function load(src: SplatSource, o: SplatOptions, decoders: SplatDecoders | undefined): Promise<Prepared & { reader: "worker" | "main" }> {
	const popts: PrepareOptions = { origin: o.origin, upAxis: o.upAxis, orientation: o.orientation, scale: o.scale ?? 1, opacity: o.opacity ?? 1, shDegree: o.shDegree ?? 3, lod: o.lod !== false, transform: o.transform != null ? checkTransform(o.transform) : null };   // transform は素の配列に（worker へ写す）
	let fmt: SplatFormat | null = null, bytesOrUrl: string | ArrayBuffer | Uint8Array | null = null;
	if (isFileSource(src)) {
		fmt = o.format ?? formatOf(src);
		if (!fmt) throw new Error(`plugin-splat: cannot tell the format of ${String(src).slice(0, 80)} (pass opts.format "ply" | "splat" | "spz")`);
		checkEnum(fmt, ["ply", "splat", "spz"], "format");
		bytesOrUrl = typeof src === "string" || src instanceof URL ? new URL(String(src), globalThis.location?.href).href : src;
	} else checkSplatData(src);   // 形の間違いは今・同期に投げる（worker へ送ってからでは遅い）
	const own = fmt ? decoders?.[fmt] : undefined;
	if (!own) {
		const r = spawnReader();
		if (r) {
			try {
				const seq = ++r.seq, req: ReaderRequest = { seq, src: bytesOrUrl ?? (src as SplatData), format: fmt, opts: popts };
				const p = await new Promise<Prepared>((res, rej) => { r.pending.set(seq, { res, rej }); r.w.postMessage(req, bytesOrUrl instanceof ArrayBuffer ? [bytesOrUrl] : []); });   // bytes は transfer（URL と SplatData は写し＝渡した人の配列は手放さない）
				return { ...p, reader: "worker" };
			} catch (e) { if (!(e as { fallback?: boolean })?.fallback) throw e; }
		}
	}
	// main の経路（自前の読み手・worker の無い器）
	let d: SplatData & { n: number; crs: SplatCrs };
	if (fmt && bytesOrUrl != null) {
		let bytes: Uint8Array;
		if (typeof bytesOrUrl === "string") { const r = await fetch(bytesOrUrl); if (!r.ok) throw new Error(`plugin-splat: ${bytesOrUrl} → HTTP ${r.status}`); bytes = new Uint8Array(await r.arrayBuffer()); }
		else bytes = bytesOrUrl instanceof ArrayBuffer ? new Uint8Array(bytesOrUrl) : bytesOrUrl;
		d = checkSplatData({ crs: "local", ...(await (own ?? readerFor(fmt))(bytes)) });
	} else d = checkSplatData(src as SplatData);
	return { ...prepare(d, popts, !isFileSource(src)), reader: "main" };
}
const isFileSource = (src: SplatSource): src is string | URL | ArrayBuffer | Uint8Array => typeof src === "string" || src instanceof URL || src instanceof ArrayBuffer || src instanceof Uint8Array;
// 統一 picking の答え（この描き手の pick は id・index・distance・lngLat・properties を必ず入れる）
const isSplatHit = (id: string) => (t: OverlayPick): t is SplatHit => t.layer === id;

let anonSeq = 0;
/** LoD の既定の密度＝層の画面上の足跡 1 px² あたり描く個数 */
export const LOD_DENSITY = 2;
/** map.addData(data, { kind: "splat", … }) の実体 */
export function createSplat(map: SplatMap, data: SplatSource, opts: SplatOptions = {}, { decoders, backend = "auto" }: SplatPluginOptions = {}): SplatHandle {
	if (opts.altitude != null) checkEnum(opts.altitude, ["relative", "absolute"], "altitude");
	if (opts.upAxis != null) checkEnum(opts.upAxis, ["z", "y", "-y"], "upAxis");
	if (opts.shDegree != null && !(Number.isInteger(opts.shDegree) && opts.shDegree >= 0 && opts.shDegree <= 3)) throw new RangeError("plugin-splat: shDegree must be 0 | 1 | 2 | 3");
	if (opts.lod != null && typeof opts.lod !== "boolean" && !(typeof opts.lod === "number" && opts.lod > 0)) throw new RangeError("plugin-splat: lod must be true | false | a positive number (splats per screen pixel)");
	const id = opts.id ?? `splat${++anonSeq}`;
	const { ov, slot, release } = acquire(map, !!opts.above, id, backend);
	try { ov.addLayerId?.(id); } catch (e) { release(); throw e; }   // 同じ id の層が既にある＝投げる
	readerUsed(); slot.onLod.set(id, drawn => { h.drawn = drawn; });
	let cur: SplatSource = data, props: SplatOptions = { ...opts }, removed = false, seq = 0, visible = true;   // visible＝層が立つ前の setVisible も覚える（3D Tiles が読み終わる前に伏せる）
	const run = async (src: SplatSource, o: SplatOptions): Promise<SplatHandle> => {
		const my = ++seq;
		const p = await load(src, o, decoders);
		if (removed || my !== seq) return h;
		h.n = p.n; h.anchor = p.anchor; h.drawn = p.n; h.reader = p.reader; cur = src;
		const lod = o.lod === false ? 0 : typeof o.lod === "number" ? o.lod : LOD_DENSITY;
		const placed = p.crs === "ecef" || (p.crs === "local" && (o.transform != null || (src as SplatData).transform != null));   // ECEF で置いた物＝絶対高さ
		ov.post({ type: "layer", q: id, n: p.n, anchor: p.anchor, alt: o.altitude ?? (placed ? "absolute" : "relative"), ctr: p.ctr, cov: p.cov, rgba: p.rgba, radius: p.radius, depthTest: o.depthTest !== false, properties: o.properties ?? null, on: visible,
			rot: p.rot, shq: p.sh?.shq ?? null, shScale: p.sh?.shScale ?? 1, shDeg: p.sh?.shDeg ?? 0, shWords: p.sh?.words ?? 0, rank: lod ? p.rank : null, lod }, transferables(p));
		return h;
	};
	const h: SplatHandle = {
		id, kind: "splat", overlay: ov, n: 0, anchor: null, drawn: 0, reader: null,
		get backend() { return slot.backend; },
		ready: undefined as unknown as Promise<SplatHandle>,   // 直後に run で埋める（JS の元の形と同じ順）
		setData: (d: SplatSource) => (h.ready = run(d, props)),
		setProps: (p: Partial<SplatOptions>) => { props = { ...props, ...p }; return (h.ready = run(cur, props)); },
		setVisible: (on: boolean) => { visible = !!on; if (!removed) ov.post({ type: "vis", q: id, on: visible }); return h; },
		pick: async (x: number, y: number, r = 4): Promise<SplatHit[]> => (await map.pickOverlays(x, y, { radius: r, names: [ov.name] })).filter(isSplatHit(id)),
		remove: () => { if (removed) return; removed = true; ov.post({ type: "remove", q: id }); ov.removeLayerId?.(id); slot.onLod.delete(id); release(); readerFree(); },
	};
	h.ready = run(data, props);
	return h;
}

/** map.use(splatPlugin({ decoders?, backend? })) → map.addData(data, { kind: "splat", origin?, upAxis?, orientation?, scale?, altitude?, opacity?, depthTest?, above?, properties?, shDegree?, lod? }) */
export function splatPlugin({ decoders, backend = "auto" }: SplatPluginOptions = {}): SplatPlugin {
	if (decoders != null) for (const [k, f] of Object.entries(decoders)) { checkEnum(k, ["ply", "splat", "spz"], "decoders key"); if (typeof f !== "function") throw new TypeError(`plugin-splat: decoders.${k} must be a function (bytes) → SplatData`); }
	checkEnum(backend, ["auto", "webgpu", "webgl2"], "backend");
	return {
		name: "plugin-splat",
		version: VERSION,
		provides: ["data.splat"],
		install(map: GlobeMap): () => void {
			map.registry.dataKinds.add("splat", { create: (m, data, o) => createSplat(m, data as SplatSource, o as SplatOptions, { decoders, backend }) });
			return () => { try { map.registry.dataKinds.remove("splat"); } catch { /* 既に外れた */ } };
		},
	};
}
export default splatPlugin;
