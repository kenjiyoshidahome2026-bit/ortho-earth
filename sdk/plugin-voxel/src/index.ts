// @ortho-earth/plugin-voxel — voxel grids for @ortho-earth/globe (stage 1 box grids + WebGL2, stage 2 WebGPU / region grids / iso surfaces / clipping; 2026-10-23).
//   map.use(voxelPlugin()) fills the reserved map.addData kind "voxel" (contract: globe src/voxel.ts VoxelData; the globe validates it before create()).
//   Drawn as a same-frame overlay (map.overlay): the grid's bounding box (or the curved shell of a region grid) is rasterised (back faces) and the fragment shader marches a ray
//   through the cells (voxel-gl.ts / voxel-gpu.ts, chosen by voxel-draw.ts): "blocks" = DDA to the first solid cell, shaded by its face (Minecraft-like); "volume" = fixed steps,
//   trilinear samples, colormap colour and alpha composited front to back; "iso" = the surface where the value crosses the threshold, shaded by the gradient. `clip` keeps a sub-box.
//   Hidden by terrain and buildings (scene depth), picked by the unified picking (handle.pick, map.on("click", id, …), queryRenderedFeatures({ layers: [id] })).
//   Preparation (quantising values to R8 / RGBA8, the colormap, placement, the region shell) runs in a worker (voxel-reader.ts); the main thread forwards the buffers (transfer).
//   Stage 4 adds the 3D Tiles EXT_primitive_voxels. Stage 5 (2026-10-24): a grid with an axis beyond BRICK_LIMIT (256) is split into bricks (BRICK = 126 cells + a 1-cell apron,
//   one texture each, drawn far to near, empty bricks skipped); LoD / time / file sources follow. Plan: ../PLAN.md.
import type { GlobeMap, OrthoPlugin, OverlayHandle, OverlayPick, VoxelData } from "@ortho-earth/globe";
import { prepareGrid, transferables, checkVoxelData, checkClip, buildColormap, thrOf, frameAt } from "./grid.ts";
import type { PrepareOptions, PreparedGrid, ColormapSpec, RenderMode, Clip } from "./grid.ts";
import type { ReaderRequest, ReaderReply } from "./voxel-reader.ts";
import type { VoxelStyle } from "./voxel-gl.ts";
export { prepare, checkVoxelData, checkClip, thrOf, buildColormap, colorStops, parseColor, quantize, toRgba8, valueRange, placeBox, placeRegion, unitAt, hprMat, enuBasis, ecefToLngLat, ecefEnuRows, inv3, mul3, rayBox, marchBlocks, COLORMAPS, COLORMAP_NAMES, SHELL_N, prepareGrid, maxOf, needsBricks, brickSpans, extract, parentIndex, frameValues, frameAt, BRICK, BRICK_LIMIT } from "./grid.ts";
export type { PrepareOptions, Prepared, PreparedGrid, Brick, ColormapSpec, ColorStop, RenderMode, Clip, Hpr, Placement, GeoGrid, RayHit, EnuBasis, Mat3 } from "./grid.ts";
export type { VoxelMessage, VoxelLayerBody, VoxelStyle, VoxelPickResult, VoxelAltitude, OverlayHost, CamState, VoxelApi, PickContext } from "./voxel-gl.ts";
export type { VoxelBackend, VoxelDrawOpts } from "./voxel-draw.ts";
export type { VoxelGpuModule } from "./voxel-gpu.ts";
import type { VoxelBackend } from "./voxel-draw.ts";
// 描き手（worker）の URL＝入口（voxel-draw.js が兄弟を import）。字面は .js のまま＝npm の dist では実体・repo の中では Vite が .ts に読み替える
const VOXEL_URL = new URL("./voxel-draw.js", import.meta.url).href;
export const VERSION = "0.4.0";

// ---- 公開の型（map.addData の opts と手綱） ----
export type VoxelSource = VoxelData | string | URL | ArrayBuffer | Uint8Array;
export interface VoxelOptions {
	kind?: "voxel";
	id?: string;
	/** "volume" (default): trilinear samples composited front to back with the colormap's colour and alpha; "blocks": opaque cells, the first solid cell along the ray, shaded by its face;
	 *  "iso": the surface where the value crosses `threshold`, shaded by the field's gradient */
	render?: RenderMode;
	/** keep only this part of the grid: [x0, x1, y0, y1, z0, z1] fractions 0..1 of each axis (a slice is a thin range). Changes without re-uploading the grid */
	clip?: Clip | null;
	/** a name (viridis | magma | inferno | plasma | turbo | grey | heat | cool | blues | reds), a list of colours (evenly spaced) or [t, colour] stops. Colours "#rrggbb" / "#rrggbbaa" / [r, g, b, a?]. Scalar grids only */
	colormap?: ColormapSpec;
	/** values mapped to the colormap's 0..1 (default data.range, else the data's min / max) */
	range?: [number, number];
	/** cells below this value (data units) are empty */
	threshold?: number;
	/** volume: alpha over the colormap's 0..1 when the colours carry none (default [0, 1]) */
	alphaRamp?: [number, number];
	/** volume: distance between samples in cells (default 0.5) */
	step?: number;
	/** multiplies every cell's opacity (default 1) */
	opacity?: number;
	/** "relative": the box origin's alt is above the ground (default for origin boxes); "absolute": above the ellipsoid (default for transform boxes and region grids) */
	altitude?: "relative" | "absolute";
	/** hidden by terrain and buildings (default true) */
	depthTest?: boolean;
	/** draw above the labels (default false) */
	above?: boolean;
	/** merged into every pick hit's properties (with index, cell, value) */
	properties?: Record<string, unknown>;
	/** grids with `times` (a time dimension): "clock" (default) shows the frame of the map's clock (map.clock: the last frame at or before its time) and follows it as it plays;
	 *  a number (ms) pins that time. Changes without re-uploading the grid */
	time?: number | "clock";
}
export interface VoxelPluginOptions {
	/** "auto" (default): WebGPU when the map draws with WebGPU (shared device and depth texture), else WebGL2. "webgpu": WebGPU (own device under a WebGL2 map) or fail. "webgl2": always WebGL2 */
	backend?: VoxelBackend | "auto";
}
/** handle.pick の 1 件＝統一 picking の答え（layer＝手綱の id・index＝セルの番号・cell＝[i, j, k]・value＝セルの値） */
export interface VoxelHit extends OverlayPick { id: number; layer: string; index: number; cell: [number, number, number]; value: number | null; distance: number; lngLat: [number, number]; properties: Record<string, unknown> & { index: number; cell: [number, number, number]; value: number | null } }
export interface VoxelHandle {
	readonly id: string;
	readonly kind: "voxel";
	/** [nx, ny, nz] after the last bake */
	dims: [number, number, number] | null;
	/** number of cells after the last bake */
	n: number;
	/** [lng, lat, alt] of the box origin */
	anchor: [number, number, number] | null;
	/** values mapped to the colormap (scalar grids) */
	range: [number, number] | null;
	/** the overlay handle (map.overlay) */
	readonly overlay: OverlayHandle;
	/** which renderer draws this map's voxels: "webgpu" | "webgl2", null until the overlay has chosen */
	readonly backend: VoxelBackend | null;
	/** "box" | "region" after the last bake */
	shape: "box" | "region" | null;
	/** where the last source was prepared: "worker" (voxel-reader.ts) or "main"; null before the first bake */
	reader: "worker" | "main" | null;
	/** the renderer refused the layer (e.g. dims beyond MAX_3D_TEXTURE_SIZE); null when it draws */
	error: string | null;
	/** number of bricks the grid was split into (an axis beyond 256 cells); 0 = one texture */
	bricks: number;
	/** the frame times (ms) of a grid with a time dimension, null otherwise */
	times: number[] | null;
	/** the frame shown (0 without a time dimension) */
	frame: number;
	ready: Promise<VoxelHandle>;
	setData(data: VoxelSource): Promise<VoxelHandle>;
	setProps(p: Partial<VoxelOptions>): Promise<VoxelHandle>;
	setVisible(on: boolean): VoxelHandle;
	pick(x: number, y: number, r?: number): Promise<VoxelHit[]>;
	remove(): void;
}
export interface VoxelPlugin extends OrthoPlugin { name: "plugin-voxel"; version: string; provides: string[]; install(map: GlobeMap): () => void }
export type VoxelMap = Pick<GlobeMap, "overlay" | "pickOverlays"> & { ellipsoidOn?: () => boolean; clock?: Pick<GlobeMap["clock"], "time" | "on" | "off"> };
/** 楕円体表示の b/a（region の殻を本体と同じ形で作る） */
const R_AX_ELL = 1 - 1 / 298.257223563;
const rAxOf = (map: VoxelMap): number => { try { return map.ellipsoidOn?.() ? R_AX_ELL : 1; } catch { return 1; } };

// ---- 一つの map に一つのオーバーレイ（render worker の WebGL 文脈は Chrome で 4 つまで） ----
interface SharedSlot { ov: OverlayHandle; refs: number; backend: VoxelBackend | null; errors: Map<string, (e: string) => void>; idle: ReturnType<typeof setTimeout> | null }
interface SharedEntry { ids: Set<string>; below?: SharedSlot; above?: SharedSlot }
const shared = new WeakMap<object, SharedEntry>();
/** 手綱が全部外れてからオーバーレイを片付けるまでの猶予（ms）＝場面の切り替え（remove → すぐ addData）で同じ名のオーバーレイを壊して作り直さない（render worker の片付けと新しい登録が競う） */
export const OVERLAY_LINGER_MS = 250;
function acquire(map: VoxelMap, above: boolean, id: string, backend: VoxelBackend | "auto"): { ov: OverlayHandle; slot: SharedSlot; release(): void } {
	let m = shared.get(map); if (!m) shared.set(map, (m = { ids: new Set() }));
	if (m.ids.has(id)) throw new Error(`plugin-voxel: a layer with id "${id}" already exists`);
	const k = above ? "above" : "below";
	if (m[k]?.idle) { clearTimeout(m[k]!.idle!); m[k]!.idle = null; }   // 片付けの猶予の中＝そのまま使う
	if (!m[k]) {
		const ov = map.overlay(VOXEL_URL, { name: above ? "plugin-voxel:above" : "plugin-voxel", above, opts: { depth: true, backend } });
		const slot: SharedSlot = { ov, refs: 0, backend: null, errors: new Map(), idle: null };
		ov.onmessage = (d: unknown) => {
			const e = d as { type?: string; backend?: VoxelBackend | null; error?: string; q?: string } | null;
			if (e?.type === "backend") { slot.backend = e.backend ?? null; if (e.error) console.error("[plugin-voxel] overlay failed:", e.error); }
			else if (e?.type === "error" && e.q != null) { console.warn("[plugin-voxel]", e.q, e.error); slot.errors.get(e.q)?.(e.error || "error"); }
		};
		m[k] = slot;
	}
	m[k].refs++; m.ids.add(id);
	return { ov: m[k].ov, slot: m[k], release() {
		m.ids.delete(id);
		const s = m[k]; if (!s || --s.refs > 0) return;
		s.idle = setTimeout(() => { if (s.refs > 0 || m[k] !== s) return; s.ov.remove(); delete m[k]; }, OVERLAY_LINGER_MS);   // 猶予の後に片付ける（その間に acquire が来れば続投）
	} };
}

// ---- 読み手の worker（一つ・怠けて立てる・手綱が全部外れたら少し待って片付ける） ----
interface Reader { w: Worker; pending: Map<number, { res: (p: PreparedGrid) => void; rej: (e: Error) => void }>; seq: number }
let reader: Reader | null = null, readerBroken = false, liveHandles = 0, readerIdle: ReturnType<typeof setTimeout> | null = null;
function spawnReader(): Reader | null {
	if (reader) return reader;
	if (readerBroken || typeof Worker === "undefined") return null;
	try {
		const w = new Worker(new URL("./voxel-reader.ts", import.meta.url), { type: "module", name: "voxel-reader" });
		const r: Reader = { w, pending: new Map(), seq: 0 };
		w.onmessage = ({ data: m }: { data: ReaderReply }) => { const p = r.pending.get(m.seq); if (!p) return; r.pending.delete(m.seq); if (m.ok) { const { seq: _s, ok: _o, ...rest } = m; p.res(rest); } else p.rej(new Error(m.error)); };
		w.onerror = (e: ErrorEvent) => {
			readerBroken = true; reader = null; try { w.terminate(); } catch { /* 既に死んでいる */ }
			const err = new Error(`plugin-voxel: reader worker failed (${e?.message || "error"})`); (err as Error & { fallback?: boolean }).fallback = true;
			for (const p of r.pending.values()) p.rej(err); r.pending.clear();
			console.warn("[plugin-voxel] reader worker unavailable, preparing on the main thread:", e?.message || e);
		};
		return (reader = r);
	} catch (e) { readerBroken = true; console.warn("[plugin-voxel] reader worker unavailable, preparing on the main thread:", (e as { message?: string } | null)?.message || e); return null; }
}
const readerUsed = (): void => { liveHandles++; if (readerIdle) { clearTimeout(readerIdle); readerIdle = null; } };
const readerFree = (): void => { if (--liveHandles > 0 || !reader) return; readerIdle = setTimeout(() => { readerIdle = null; if (liveHandles || !reader) return; reader.w.terminate(); reader = null; }, 5000); };
const isFileSource = (src: VoxelSource): src is string | URL | ArrayBuffer | Uint8Array => typeof src === "string" || src instanceof URL || src instanceof ArrayBuffer || src instanceof Uint8Array;
async function load(src: VoxelSource, o: VoxelOptions, rAx: number): Promise<PreparedGrid & { reader: "worker" | "main" }> {
	if (isFileSource(src)) throw new Error("plugin-voxel: file sources (.nc / .zarr / .vox / .npy) are not read yet (stage 5); pass VoxelData");
	const d = checkVoxelData(src);
	const popts: PrepareOptions = { colormap: o.colormap, range: o.range ?? null, alphaRamp: o.alphaRamp ?? null, threshold: o.threshold ?? null, rAx };
	const r = spawnReader();
	if (r) {
		try {
			const seq = ++r.seq, req: ReaderRequest = { seq, data: d, opts: popts };
			const p = await new Promise<PreparedGrid>((res, rej) => { r.pending.set(seq, { res, rej }); r.w.postMessage(req); });   // data は写し＝渡した人の配列は手放さない
			return { ...p, reader: "worker" };
		} catch (e) { if (!(e as { fallback?: boolean })?.fallback) throw e; }
	}
	return { ...prepareGrid(d, popts), reader: "main" };
}
const isVoxelHit = (id: string) => (t: OverlayPick): t is VoxelHit => t.layer === id;
const checkEnum = (v: unknown, allowed: readonly string[], name: string): void => { if (!allowed.includes(v as string)) throw new RangeError(`plugin-voxel: ${name} must be ${allowed.map(a => JSON.stringify(a)).join(" | ")}`); };
const MODE: Record<RenderMode, 0 | 1 | 2> = { blocks: 0, volume: 1, iso: 2 };
/** 格子を上げ直さずに変えられる opts（setProps はこれだけなら "style" を送る） */
export const STYLE_KEYS: readonly (keyof VoxelOptions)[] = Object.freeze(["render", "opacity", "step", "threshold", "clip", "depthTest", "properties", "colormap", "alphaRamp", "time"]);
function checkOpts(opts: Partial<VoxelOptions>): void {
	if (opts.render != null) checkEnum(opts.render, ["blocks", "volume", "iso"], "render");
	if (opts.altitude != null) checkEnum(opts.altitude, ["relative", "absolute"], "altitude");
	if (opts.step != null && !(typeof opts.step === "number" && opts.step > 0)) throw new RangeError("plugin-voxel: step must be a positive number (cells)");
	if (opts.opacity != null && !(typeof opts.opacity === "number" && opts.opacity >= 0 && opts.opacity <= 1)) throw new RangeError("plugin-voxel: opacity must be 0..1");
	if (opts.threshold != null && !Number.isFinite(opts.threshold)) throw new TypeError("plugin-voxel: threshold must be a finite number (data units)");
	checkClip(opts.clip);
	if (opts.time != null && opts.time !== "clock" && !(typeof opts.time === "number" && Number.isFinite(opts.time))) throw new TypeError("plugin-voxel: time must be \"clock\" or a time in ms");
}

let anonSeq = 0;
/** map.addData(data, { kind: "voxel", … }) の実体 */
export function createVoxel(map: VoxelMap, data: VoxelSource, opts: VoxelOptions = {}, { backend = "auto" }: VoxelPluginOptions = {}): VoxelHandle {
	checkOpts(opts);
	if (!isFileSource(data)) checkVoxelData(data);   // 形の間違いは今・同期に投げる（worker へ送ってからでは遅い）
	const id = opts.id ?? `voxel${++anonSeq}`;
	const { ov, slot, release } = acquire(map, !!opts.above, id, backend);
	try { ov.addLayerId?.(id); } catch (e) { release(); throw e; }
	readerUsed();
	let cur: VoxelSource = data, props: VoxelOptions = { ...opts }, removed = false, seq = 0, visible = true, values: VoxelData["values"] | null = null, comps: 1 | 4 = 1, baked = false;
	let qs: string[] = [];   // 描き手に送った層の名前（一枚＝id・ブリック＝id#0, id#1, …）
	// 時間の次元＝見せるこま（opts.time＝"clock"（既定）は map.clock に付いて行く・数は固定）。こまの切り替えは "style" の frame だけ（上げ直さない）
	let times: number[] | null = null, following = false;
	const frameNow = (): number => { if (!times) return 0; const t = props.time ?? "clock"; return frameAt(times, t === "clock" ? (map.clock?.time ?? Date.now()) : t); };
	const showFrame = (): void => { const f = frameNow(); if (f === h.frame || removed) return; h.frame = f; for (const q of qs) ov.post({ type: "style", q, frame: f }); };
	const onClock = (): void => showFrame();
	const follow = (on: boolean): void => { if (on === following || !map.clock) return; following = on; if (on) map.clock.on("tick", onClock).on("change", onClock); else map.clock.off("tick", onClock).off("change", onClock); };
	const run = async (src: VoxelSource, o: VoxelOptions): Promise<VoxelHandle> => {
		const my = ++seq;
		const p = await load(src, o, rAxOf(map));
		if (removed || my !== seq) return h;
		h.dims = p.dims; h.n = p.n; h.anchor = p.anchor; h.range = p.range; h.reader = p.reader; h.error = null; h.shape = p.shape; h.bricks = p.bricks?.length ?? 0; times = h.times = p.times; h.frame = frameNow(); follow(!!times && (o.time ?? "clock") === "clock"); cur = src; values = (src as VoxelData).values; comps = p.comps; baked = true;
		const style = { mode: MODE[o.render ?? "volume"], thr: p.thr, step: o.step ?? 0.5, opacity: o.opacity ?? 1, clip: checkClip(o.clip), depthTest: o.depthTest !== false, properties: o.properties ?? null, range: p.range, on: visible, frame: h.frame, alt: o.altitude ?? (p.placed ? "absolute" : "relative") };
		const next = p.bricks ? p.bricks.map((_, b) => `${id}#${b}`) : [id];
		for (const q of qs) if (!next.includes(q)) { ov.post({ type: "remove", q }); slot.errors.delete(q); }   // 前の形の層（一枚 ↔ ブリック・ブリックの数）を片付ける
		qs = next;
		for (const q of qs) slot.errors.set(q, e => { h.error = e; });   // 描き手の build の失敗（3D テクスチャの上限など）は非同期に届く＝warn と手綱の error（ready は解決する）
		if (!p.bricks) ov.post({ type: "layer", q: id, shape: p.shape, dims: p.dims, comps: p.comps, tex: p.tex, frames: p.frames, cmap: p.cmap, anchor: p.anchor, A: p.A, radius: p.radius, geo: p.geo, vmax: p.vmax, ...style }, transferables(p));
		else p.bricks.forEach((b, i) => ov.post({ type: "layer", q: qs[i], layer: id, shape: p.shape, dims: b.dims, comps: p.comps, tex: b.tex, frames: b.frames, cmap: i ? p.cmap.slice() : p.cmap, anchor: b.anchor, A: b.A, radius: b.radius, geo: b.geo, vmax: b.vmax, off: b.off, own: b.own, full: p.dims, ...style },
			[b.tex.buffer as ArrayBuffer, b.A.buffer as ArrayBuffer, ...(b.geo ? [b.geo.shell.buffer as ArrayBuffer] : []), ...(b.frames ?? []).map(f => f.buffer as ArrayBuffer)].filter((x, k, a) => a.indexOf(x) === k)));
		return h;
	};
	// 見た目だけの変更＝格子を上げ直さない（render・opacity・step・threshold・clip・depthTest・properties・colormap・alphaRamp）
	const restyle = (p: Partial<VoxelOptions>): void => {
		const s: VoxelStyle = {};
		if ("render" in p) s.mode = MODE[props.render ?? "volume"]; if ("opacity" in p) s.opacity = props.opacity ?? 1; if ("step" in p) s.step = props.step ?? 0.5;
		if ("threshold" in p) s.thr = comps === 4 || !h.range ? 0 : thrOf(props.threshold, h.range); if ("clip" in p) s.clip = checkClip(props.clip); if ("depthTest" in p) s.depthTest = props.depthTest !== false; if ("properties" in p) s.properties = props.properties ?? null;
		if ("time" in p && times) { follow((props.time ?? "clock") === "clock"); const f = frameNow(); if (f !== h.frame) { h.frame = f; s.frame = f; } }
		const cmap = "colormap" in p || "alphaRamp" in p ? buildColormap(props.colormap, props.alphaRamp ?? null) : null;
		if (!Object.keys(s).length && !cmap) return;
		qs.forEach((q, i) => { const c = cmap && i < qs.length - 1 ? cmap.slice() : cmap; ov.post({ type: "style", q, ...s, ...(c ? { cmap: c } : {}) }, c ? [c.buffer as ArrayBuffer] : []); });
	};
	// 当たりの value＝main が持つ元の値（worker の答えは番号だけ）
	const withValue = (t: VoxelHit): VoxelHit => { const k = t.index + (h.frame || 0) * (h.n || 0); if (values && comps === 1 && t.index >= 0 && k < values.length) { const v = values[k]; t.value = v; t.properties = { ...t.properties, value: v }; } return t; };
	const h: VoxelHandle = {
		id, kind: "voxel", overlay: ov, dims: null, n: 0, anchor: null, range: null, reader: null, error: null, shape: null, bricks: 0, times: null, frame: 0,
		get backend() { return slot.backend; },
		ready: undefined as unknown as Promise<VoxelHandle>,
		setData: (d: VoxelSource) => { if (!isFileSource(d)) checkVoxelData(d); return (h.ready = run(d, props)); },
		setProps: (p: Partial<VoxelOptions>) => {
			checkOpts(p); props = { ...props, ...p };
			if (baked && !removed && Object.keys(p).every(k => (STYLE_KEYS as readonly string[]).includes(k))) { restyle(p); return h.ready; }
			return (h.ready = run(cur, props));
		},
		setVisible: (on: boolean) => { visible = !!on; if (!removed) for (const q of qs) ov.post({ type: "vis", q, on: visible }); return h; },
		pick: async (x: number, y: number, r = 4): Promise<VoxelHit[]> => (await map.pickOverlays(x, y, { radius: r, names: [ov.name] })).filter(isVoxelHit(id)).map(withValue),
		remove: () => { if (removed) return; removed = true; follow(false); for (const q of qs) { ov.post({ type: "remove", q }); slot.errors.delete(q); } ov.removeLayerId?.(id); release(); readerFree(); },
	};
	h.ready = run(data, props);
	return h;
}

/** map.use(voxelPlugin()) → map.addData(data, { kind: "voxel", render?, colormap?, range?, threshold?, alphaRamp?, step?, opacity?, altitude?, depthTest?, above?, properties? }) */
export function voxelPlugin({ backend = "auto" }: VoxelPluginOptions = {}): VoxelPlugin {
	checkEnum(backend, ["auto", "webgpu", "webgl2"], "backend");
	return {
		name: "plugin-voxel",
		version: VERSION,
		provides: ["data.voxel"],
		install(map: GlobeMap): () => void {
			map.registry.dataKinds.add("voxel", { create: (m, data, o) => createVoxel(m, data as VoxelSource, o as VoxelOptions, { backend }) });
			return () => { try { map.registry.dataKinds.remove("voxel"); } catch { /* 既に外れた */ } };
		},
	};
}
export default voxelPlugin;
