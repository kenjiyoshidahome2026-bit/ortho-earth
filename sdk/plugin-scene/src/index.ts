// @ortho-earth/plugin-scene — instanced meshes, billboards and 3D text for @ortho-earth/globe (third wave W9).
//   map.use(scenePlugin()) registers three map.addData kinds on the dataKinds extension point:
//     "instanced"  one mesh drawn many times (box / cylinder / cone / sphere / your mesh / an uncompressed .glb), per item position, scale (m), heading-pitch-roll, color
//     "billboards" images at 3D positions, facing the screen, lying flat or standing upright, sized in pixels or meters
//     "labels3d"   text at 3D positions (drawn to an atlas on the main thread with the page's fonts, then the same path as billboards)
//   Each kind is a same-frame overlay (map.overlay): drawn with the globe's camera, hidden by terrain and buildings (scene depth), picked by the
//   unified picking (handle.pick, map.on("click", id, …), queryRenderedFeatures({ layers: [id] })).
import type { OrthoJapanMap, OrthoPlugin, OverlayHandle, OverlayPick } from "@ortho-earth/globe";
import { shapeMesh, parseGlb, packAtlas } from "./shapes.ts";
import type { Mesh, NormalizedMesh, ShapeName, AtlasRect } from "./shapes.ts";
import type { MeshLayerBody, QuadLayerBody, AtlasPayload, SceneAltitude } from "./scene-gl.ts";
export { box, cylinder, cone, sphere, parseGlb, packAtlas, normMesh } from "./shapes.ts";
export type { Mesh, NormalizedMesh, ShapeName, AtlasRect, AtlasLayout } from "./shapes.ts";
export type { SceneMessage, LayerMessage, MeshLayerBody, QuadLayerBody, ScenePickResult, OverlayHost, CamState, SceneApi, PickContext } from "./scene-gl.ts";
// 描き手（worker）の URL。字面は .js のまま＝npm の dist では実体（dist/scene-gl.js）・repo の中では Vite が .ts に読み替える
const SCENE_URL = new URL("./scene-gl.js", import.meta.url).href;
export const VERSION = "0.1.0";

// ---- 公開の型（map.addData の opts と手綱） ----
export type Color = [number, number, number, number?] | string;
export type RGBA = [number, number, number, number];
/** d => 値 か定数（deck.gl の accessor と同じ） */
export type Accessor<T, D = any> = T | ((d: D, i: number) => T);
export type Position = [number, number, number?];
export type AnchorName = "center" | "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Anchor = AnchorName | [number, number];
export type Data<D = any> = D[] | { type: "FeatureCollection"; features: D[] } | Iterable<D>;
export type SceneKind = "instanced" | "billboards" | "labels3d";
/** 画像の素（icons の値・getIcon の戻り）：URL か描ける画像（ImageBitmap / HTMLImageElement / canvas / ImageData） */
export type IconSource = string | URL | ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData;
/** 束（atlas）に描ける画像＝幅・高さを持つ CanvasImageSource */
export type AtlasImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

export interface CommonOptions<D = any> {
	id?: string;
	/** [lon, lat, h m]; default: the Point geometry of a GeoJSON feature */
	getPosition?: Accessor<Position | number[] | null, D>;
	/** "relative" (default): h above the ground; "absolute": h above the ellipsoid */
	altitude?: SceneAltitude;
	/** properties returned by pick / queryRenderedFeatures (default { index }) */
	getProperties?: (d: D, i: number) => any;
	/** hidden by terrain and buildings (default true) */
	depthTest?: boolean;
	/** draw above the labels (default false) */
	above?: boolean;
}
export interface InstancedOptions<D = any> extends CommonOptions<D> {
	kind?: "instanced";
	/** a built-in shape, a Mesh, a .glb URL or the bytes of an uncompressed .glb (no Draco / meshopt) */
	shape?: ShapeName | Mesh | string | URL | ArrayBuffer | ArrayBufferView;
	/** 旧名（shape と同じ） */
	mesh?: InstancedOptions<D>["shape"];
	/** meters: one number or [east, north, up] */
	getScale?: Accessor<number | [number, number, number], D>;
	/** degrees: heading (clockwise from north), pitch, roll */
	getOrientation?: Accessor<number | [number, number?, number?], D>;
	getColor?: Accessor<Color, D>;
	sizeScale?: number;
	/** color when getColor is not given (multiplied with the mesh colors) */
	color?: Color;
}
export interface QuadOptions<D = any> extends CommonOptions<D> {
	/** "screen" (default): faces the camera; "flat": lies on the ground (east/north); "upright": stands and turns around the vertical */
	facing?: "screen" | "flat" | "upright";
	sizeUnits?: "pixels" | "meters";
	anchor?: Anchor;
	/** degrees, clockwise */
	getAngle?: Accessor<number, D>;
}
export interface BillboardOptions<D = any> extends QuadOptions<D> {
	kind?: "billboards";
	/** a key of icons, an image URL or an image (ImageBitmap / HTMLImageElement / canvas / ImageData) */
	getIcon: Accessor<IconSource, D>;
	icons?: Record<string, IconSource>;
	/** height in sizeUnits (default 32 px / 20 m); width follows the image */
	getSize?: Accessor<number, D>;
	getColor?: Accessor<Color, D>;
}
export interface Labels3dOptions<D = any> extends QuadOptions<D> {
	kind?: "labels3d";
	getText: Accessor<string, D>;
	/** font size in sizeUnits (default 16 px / 20 m) */
	getSize?: Accessor<number, D>;
	getColor?: Accessor<Color, D>;
	/** CSS font family (default system-ui) */
	font?: string;
	fontWeight?: number | string;
	haloColor?: Color;
	/** px (default 2) */
	haloWidth?: number;
}
/** handle.pick の 1 件＝統一 picking の答え（layer＝手綱の id・index＝描いた番号）に元の data（object・dataIndex）を添えた物 */
export interface SceneHit extends OverlayPick { layer: string; index: number; dataIndex: number | null; object: any; properties?: any }
export interface SceneHandle<O = any> {
	id: string;
	kind: SceneKind;
	/** the overlay handle (map.overlay) */
	overlay: OverlayHandle;
	/** number of drawn items */
	n: number;
	ready: Promise<SceneHandle<O>>;
	setData(data: Data): Promise<SceneHandle<O>>;
	setProps(props: Partial<O>): Promise<SceneHandle<O>>;
	setVisible(on: boolean): SceneHandle<O>;
	pick(x: number, y: number, r?: number): Promise<SceneHit[]>;
	remove(): void;
}
export interface ScenePlugin extends OrthoPlugin { name: "plugin-scene"; version: string; provides: string[]; install(map: OrthoJapanMap): () => void }
/** この plugin が使う map の口（@ortho-earth/globe の map） */
export type SceneMap = Pick<OrthoJapanMap, "overlay" | "pickOverlays">;
export interface BakedInstances { n: number; ll: Float64Array<ArrayBuffer>; scl: Float32Array<ArrayBuffer>; ori: Float32Array<ArrayBuffer>; rgba: Uint8Array<ArrayBuffer> | null; color: number[]; keep: number[] }
export interface LabelMetrics { lines: string[]; lh: number; w: number; h: number }
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Fn<T, D> = (d: D, i: number) => T;

// accessor（関数か定数）を関数に。値が関数そのものの accessor は無い＝typeof で見分ける
const acc = <T, D>(a: Accessor<T, D> | undefined, dflt: T): Fn<T, D> => typeof a === "function" ? a as Fn<T, D> : a === undefined ? (() => dflt) : (() => a as T);
const accOpt = <T, D>(a: Accessor<T, D> | undefined): Fn<T, D> | null => a === undefined ? null : typeof a === "function" ? a as Fn<T, D> : (() => a as T);
export function items<D = any>(data: Data<D>): D[] {
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object" && "type" in data && data.type === "FeatureCollection") return data.features || [];
	if (data && typeof (data as Iterable<D>)[Symbol.iterator] === "function") return [...(data as Iterable<D>)];
	throw new Error("plugin-scene: data must be an array, a GeoJSON FeatureCollection or an iterable");
}
interface PointFeature { type?: string; geometry?: { type?: string; coordinates: number[] } | null }
const geomPos = (d: unknown): number[] | null => { const f = d as PointFeature | null | undefined; return f && f.type === "Feature" && f.geometry?.type === "Point" ? f.geometry.coordinates : null; };   // 形だけ見る（GeoJSON の Point）
// 色＝[r,g,b,a?]（0〜255）か CSS の色（#rgb・#rrggbb・#rrggbbaa・rgb()/rgba()・名前は canvas が使える所だけ）
let colorCtx: OffscreenCanvasRenderingContext2D | null = null;
const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
export function parseColor(c: Color | ArrayLike<number> | null | undefined, dflt: RGBA = [210, 210, 210, 255]): RGBA {
	if (c == null) return dflt;
	if (Array.isArray(c) || ArrayBuffer.isView(c)) { const a = c as ArrayLike<number | undefined>; const f = (v: number | undefined): number => clamp255(+(v as number) || 0); return [f(a[0] ?? 0), f(a[1] ?? 0), f(a[2] ?? 0), f(a[3] ?? 255)]; }
	let s = String(c).trim();
	if (!/^#|^rgba?\(/i.test(s) && typeof OffscreenCanvas !== "undefined") { colorCtx ||= new OffscreenCanvas(1, 1).getContext("2d")!; colorCtx.fillStyle = "#000"; colorCtx.fillStyle = s; s = colorCtx.fillStyle; }
	let m = s.match(/^#([0-9a-f]{3,8})$/i);
	if (m) { let h = m[1]; if (h.length <= 4) h = [...h].map(x => x + x).join(""); const v = (h.match(/../g) || []).map(x => parseInt(x, 16)); return [v[0], v[1], v[2], v[3] ?? 255]; }
	m = s.match(/^rgba?\(([^)]+)\)$/i);
	if (m) { const v = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return [clamp255(v[0]), clamp255(v[1]), clamp255(v[2]), clamp255(v[3] == null ? 255 : v[3] <= 1 ? Math.round(v[3] * 255) : v[3])]; }
	throw new Error(`plugin-scene: unknown color ${JSON.stringify(c)}`);
}
const triple = (v: number | ArrayLike<number | undefined> | null | undefined, d: number): [number, number, number] => v == null ? [d, d, d] : typeof v === "number" ? [v, v, v] : [v[0] ?? d, v[1] ?? v[0] ?? d, v[2] ?? v[0] ?? d];
// 並びの位置・色・大きさ・向きを型付き配列へ（純関数）。位置の無い物は飛ばす＝index は元の data の番号のまま keep に残す
export function bakeInstances<D = any>(data: Data<D>, { getPosition, getColor, getScale, getOrientation, sizeScale = 1, color }: InstancedOptions<D> = {}): BakedInstances {
	const arr = items(data), gp = acc<Position | number[] | null, D>(getPosition, null), gc = accOpt<Color, D>(getColor), gs = acc<number | [number, number, number], D>(getScale, 1), go = acc<number | [number, number?, number?], D>(getOrientation, [0, 0, 0]);
	const N = arr.length, ll = new Float64Array(N * 3), scl = new Float32Array(N * 3), ori = new Float32Array(N * 3), rgba = gc ? new Uint8Array(N * 4) : null, keep: number[] = [];
	let n = 0;
	for (let i = 0; i < N; i++) {
		const d = arr[i], p = gp(d, i) ?? geomPos(d); if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
		ll[n * 3] = +p[0]; ll[n * 3 + 1] = +p[1]; ll[n * 3 + 2] = +(p[2] as number) || 0;
		const s = triple(gs(d, i), 1); scl[n * 3] = s[0] * sizeScale; scl[n * 3 + 1] = s[1] * sizeScale; scl[n * 3 + 2] = s[2] * sizeScale;
		const o = go(d, i) || [0, 0, 0];
		if (typeof o === "number") { ori[n * 3] = +o || 0; ori[n * 3 + 1] = 0; ori[n * 3 + 2] = 0; }
		else { ori[n * 3] = +(o[0] as number) || 0; ori[n * 3 + 1] = +(o[1] as number) || 0; ori[n * 3 + 2] = +(o[2] as number) || 0; }
		if (rgba) rgba.set(parseColor(gc!(d, i)), n * 4);
		keep.push(i); n++;
	}
	return { n, ll: ll.slice(0, n * 3), scl: scl.slice(0, n * 3), ori: ori.slice(0, n * 3), rgba: rgba ? rgba.slice(0, n * 4) : null, color: parseColor(color).map(v => v / 255), keep };
}
const ANCHORS: Record<AnchorName, [number, number]> = { center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5], "top-left": [0, 0], "top-right": [1, 0], "bottom-left": [0, 1], "bottom-right": [1, 1] };
export function anchorOf(a: Anchor | null | undefined, dflt: AnchorName): [number, number] {
	if (a == null) return ANCHORS[dflt];
	if (Array.isArray(a)) return [+a[0], +a[1]];
	const v = (ANCHORS as Partial<Record<string, [number, number]>>)[a]; if (!v) throw new Error(`plugin-scene: anchor must be one of ${Object.keys(ANCHORS).join("/")} or [x, y]`); return v;
}
const checkEnum = <T>(v: T, list: readonly string[], name: string): T => { if (!list.some(x => x === v)) throw new Error(`plugin-scene: ${name} must be ${list.join(" | ")} (got ${JSON.stringify(v)})`); return v; };

// ---- 画像と文字を束（atlas）にする（ブラウザ） ----
const canvas2d = (w: number, h: number): Ctx2D => typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h).getContext("2d")! : Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d")!;
async function loadImage(src: IconSource | null | undefined, signal?: AbortSignal): Promise<AtlasImage> {
	if (src == null) throw new Error("plugin-scene: icon is missing");
	if (typeof src === "string" || src instanceof URL) {
		const r = await fetch(new URL(String(src), globalThis.location?.href).href, { signal });
		if (!r.ok) throw new Error(`plugin-scene: icon ${src} → HTTP ${r.status}`);
		return createImageBitmap(await r.blob());
	}
	if (typeof ImageData !== "undefined" && src instanceof ImageData) return createImageBitmap(src);
	if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement && !src.complete) await src.decode();
	return src as AtlasImage;   // ImageBitmap / HTMLImageElement / HTMLCanvasElement / OffscreenCanvas（ImageData は上で bitmap にした）
}
interface AtlasEntry { w: number; h: number; draw(ctx: Ctx2D, x: number, y: number): void }
function atlasOf<E extends AtlasEntry>(entries: E[]): { atlas: AtlasPayload & { data: Uint8Array<ArrayBuffer> }; rects: AtlasRect[] } {   // entries＝[{ w, h, draw(ctx, x, y) }] → { atlas:{ w, h, data }, rects }
	const { w, h, rects } = packAtlas(entries.map(e => ({ w: Math.max(1, Math.ceil(e.w)), h: Math.max(1, Math.ceil(e.h)) })));
	const ctx = canvas2d(w, h);
	entries.forEach((e, i) => e.draw(ctx, rects[i].x, rects[i].y));
	const data = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
	return { atlas: { w, h, data }, rects };
}
export function measureLabel(ctx: Ctx2D, text: string, { fontPx, font, weight = 600, halo = 0 }: { fontPx: number; font: string; weight?: number | string; halo?: number }): LabelMetrics {
	ctx.font = `${weight} ${fontPx}px ${font}`;
	const lines = String(text).split("\n"), lh = Math.ceil(fontPx * 1.25), w = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
	return { lines, lh, w: Math.ceil(w + halo * 2 + 2), h: lh * lines.length + Math.ceil(halo * 2) + 2 };
}

// ---- 共通の描き手：一つの map に一つのオーバーレイ（above の物は別にもう一つ） ----
// render worker の WebGL 文脈は Chrome で 4 つまで（地球が 1 つ使う）＝手綱ごとにオーバーレイを作ると 4 つ目で地球の文脈が落ちる。
// 全部の手綱の層を一つの canvas に載せ、層の id は本体の addLayerId で名乗る（統一 picking が手綱の id で当たる）。
interface SharedSlot { ov: OverlayHandle; refs: number }
interface SharedEntry { ids: Set<string>; below?: SharedSlot; above?: SharedSlot }
const shared = new WeakMap<object, SharedEntry>();   // map → { ids:Set（使っている手綱の id）, below?, above? }＝{ ov, refs }
function acquire(map: SceneMap, above: boolean, id: string): { ov: OverlayHandle; release(): void } {
	let m = shared.get(map); if (!m) shared.set(map, (m = { ids: new Set() }));
	if (m.ids.has(id)) throw new Error(`plugin-scene: a layer with id "${id}" already exists`);
	const k = above ? "above" : "below";
	if (!m[k]) m[k] = { ov: map.overlay(SCENE_URL, { name: above ? "plugin-scene:above" : "plugin-scene", above, opts: { depth: true } }), refs: 0 };
	m[k].refs++; m.ids.add(id);
	return { ov: m[k].ov, release() { m.ids.delete(id); if (--m[k]!.refs > 0) return; m[k]!.ov.remove(); delete m[k]; } };
}

// ---- 共通の手綱 ----
type LayerBody = MeshLayerBody | QuadLayerBody;
interface Baked { n: number; keep: number[]; msg: LayerBody; transfer: Transferable[] }
type HandleOpts<D, O extends CommonOptions<D>> = O & { __data: Data<D> };
// 統一 picking の答え（この描き手の pick は index を必ず入れる）
type RawHit = OverlayPick & { layer: string; index: number };
function makeHandle<D, O extends CommonOptions<D>>(map: SceneMap, kind: SceneKind, id: string, opts: HandleOpts<D, O>, bake: (data: Data<D>, o: O) => Promise<Baked>): SceneHandle<O> {
	const { ov, release } = acquire(map, !!opts.above, id);
	try { ov.addLayerId?.(id); } catch (e) { release(); throw e; }   // 同じ id の層が既にある＝投げる
	let cur: Data<D> | null = null, keep: number[] = [], removed = false, seq = 0;
	const run = async (data: Data<D>, o: O): Promise<SceneHandle<O>> => {
		const my = ++seq, b = await bake(data, o);
		if (removed || my !== seq) return h;
		keep = b.keep; h.n = b.n; cur = data;
		ov.post({ type: "layer", q: id, depthTest: o.depthTest !== false, ...b.msg }, b.transfer);
		return h;
	};
	let props: O = { ...opts };
	const h: SceneHandle<O> = {
		id, kind, overlay: ov, n: 0,
		ready: run(opts.__data, props),
		setData: (d: Data) => (h.ready = run(d, props)),
		setProps: (p: Partial<O>) => { props = { ...props, ...p }; return (h.ready = run(cur ?? opts.__data, props)); },
		setVisible: (on: boolean) => { if (!removed) ov.post({ type: "vis", q: id, on: !!on }); return h; },
		pick: async (x: number, y: number, r = 4): Promise<SceneHit[]> => {
			const hits = (await map.pickOverlays(x, y, { radius: r, names: [ov.name] })).filter((t): t is RawHit => t.layer === id);
			const arr = cur ? items(cur) : [];
			return hits.map(t => ({ ...t, object: arr[keep[t.index]] ?? null, dataIndex: keep[t.index] ?? null }));
		},
		remove: () => { if (removed) return; removed = true; ov.post({ type: "remove", q: id }); ov.removeLayerId?.(id); release(); },
	};
	return h;
}
const propsOf = <D>(arr: D[], keep: number[], getProperties?: (d: D, i: number) => unknown): unknown[] | null => getProperties ? keep.map(i => { const p = getProperties(arr[i], i); return p && typeof p === "object" ? JSON.parse(JSON.stringify(p)) as unknown : { value: p }; }) : null;

// ---- kind "instanced" ----
const meshCache = new Map<string, Promise<NormalizedMesh>>();
async function meshFor(shape: InstancedOptions["shape"], signal?: AbortSignal): Promise<NormalizedMesh> {
	if (shape == null) return shapeMesh("box");
	if (typeof shape === "string" && /\.(glb)(\?|#|$)/i.test(shape) || shape instanceof URL) {
		const u = new URL(String(shape), globalThis.location?.href).href;
		if (!meshCache.has(u)) meshCache.set(u, fetch(u, { signal }).then(r => { if (!r.ok) throw new Error(`plugin-scene: ${u} → HTTP ${r.status}`); return r.arrayBuffer(); }).then(parseGlb));
		return meshCache.get(u)!;
	}
	if (shape instanceof ArrayBuffer || ArrayBuffer.isView(shape)) return parseGlb(shape);
	return shapeMesh(shape);
}
export function createInstanced<D = any>(map: SceneMap, data: Data<D>, opts: InstancedOptions<D> = {}): SceneHandle<InstancedOptions<D>> {
	if (opts.altitude != null) checkEnum(opts.altitude, ["relative", "absolute"], "altitude");
	return makeHandle<D, InstancedOptions<D>>(map, "instanced", opts.id!, { ...opts, __data: data }, async (d, o) => {   // id は plugin（withId）が必ず付ける
		const mesh = await meshFor(o.shape ?? o.mesh);
		const b = bakeInstances(d, o), arr = items(d);
		const m = { pos: mesh.pos.slice(), nrm: mesh.nrm.slice(), idx: mesh.idx.slice(), ...(mesh.col ? { col: mesh.col.slice() } : {}) };
		const msg: MeshLayerBody = { kind: "mesh", mesh: m, n: b.n, ll: b.ll, scl: b.scl, ori: b.ori, rgba: b.rgba, color: b.color, alt: o.altitude || "relative", props: propsOf(arr, b.keep, o.getProperties) };
		return { n: b.n, keep: b.keep, msg, transfer: [m.pos.buffer, m.nrm.buffer, m.idx.buffer, ...(m.col ? [m.col.buffer] : []), b.ll.buffer, b.scl.buffer, b.ori.buffer, ...(b.rgba ? [b.rgba.buffer] : [])] };
	});
}

// ---- kind "billboards" / "labels3d"（同じ描き手） ----
interface QuadBase { keep: number[]; ll: Float64Array<ArrayBuffer>; angle: Float32Array<ArrayBuffer>; rgba: Uint8Array<ArrayBuffer> | null }
function bakeQuads<D>(arr: D[], o: QuadOptions<D> & { getColor?: Accessor<Color, D> }): QuadBase {
	const gp = acc<Position | number[] | null, D>(o.getPosition, null), ga = acc<number, D>(o.getAngle, 0), gc = accOpt<Color, D>(o.getColor);
	const keep: number[] = [], pos: number[] = [], ang: number[] = [], col: number[] = [];
	for (let i = 0; i < arr.length; i++) {
		const d = arr[i], p = gp(d, i) ?? geomPos(d); if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
		keep.push(i); pos.push(+p[0], +p[1], +(p[2] as number) || 0); ang.push(+ga(d, i) || 0); if (gc) col.push(...parseColor(gc(d, i)));
	}
	return { keep, ll: Float64Array.from(pos), angle: Float32Array.from(ang), rgba: gc ? Uint8Array.from(col) : null };
}
function quadMsg(base: QuadBase, n: number, size: Float32Array<ArrayBuffer>, uv: Float32Array<ArrayBuffer>, anchor: Float32Array<ArrayBuffer>, atlas: AtlasPayload & { data: Uint8Array<ArrayBuffer> }, o: QuadOptions & { __props: unknown[] | null }): Baked {
	return {
		n, keep: base.keep,
		msg: { kind: "quad", n, ll: base.ll, size, uv, anchor, angle: base.angle, rgba: base.rgba, atlas, facing: o.facing || "screen", units: o.sizeUnits || "pixels", alt: o.altitude || "relative", props: o.__props },
		transfer: [base.ll.buffer, size.buffer, uv.buffer, anchor.buffer, base.angle.buffer, atlas.data.buffer, ...(base.rgba ? [base.rgba.buffer] : [])],
	};
}
const checkQuadOpts = (o: QuadOptions): void => {
	if (o.facing != null) checkEnum(o.facing, ["screen", "flat", "upright"], "facing");
	if (o.sizeUnits != null) checkEnum(o.sizeUnits, ["pixels", "meters"], "sizeUnits");
	if (o.altitude != null) checkEnum(o.altitude, ["relative", "absolute"], "altitude");
};
export function createBillboards<D = any>(map: SceneMap, data: Data<D>, opts: BillboardOptions<D>): SceneHandle<BillboardOptions<D>> {
	checkQuadOpts(opts);
	return makeHandle<D, BillboardOptions<D>>(map, "billboards", opts.id!, { ...opts, __data: data }, async (d, o) => {
		const arr = items(d), base = bakeQuads(arr, o), gi = acc<IconSource | null, D>(o.getIcon, null), gs = acc<number, D>(o.getSize, o.sizeUnits === "meters" ? 20 : 32);
		const keys = base.keep.map(i => gi(arr[i], i)), uniq = [...new Set(keys.map(k => typeof k === "string" ? k : k))];
		const imgs = await Promise.all(uniq.map(k => loadImage(typeof k === "string" && o.icons?.[k] != null ? o.icons[k] : k)));
		const { atlas, rects } = atlasOf(imgs.map(im => ({ w: im.width, h: im.height, draw: (ctx: Ctx2D, x: number, y: number) => ctx.drawImage(im, x, y) })));
		const n = base.keep.length, size = new Float32Array(n * 2), uv = new Float32Array(n * 4), anchor = new Float32Array(n * 2), A = anchorOf(o.anchor, "bottom");
		base.keep.forEach((i, k) => {
			const r = rects[uniq.indexOf(keys[k])], hh = +gs(arr[i], i) || 0;
			size[k * 2] = hh * r.w / r.h; size[k * 2 + 1] = hh;
			uv.set([r.x / atlas.w, r.y / atlas.h, (r.x + r.w) / atlas.w, (r.y + r.h) / atlas.h], k * 4); anchor.set(A, k * 2);
		});
		return quadMsg(base, n, size, uv, anchor, atlas, { ...o, __props: propsOf(arr, base.keep, o.getProperties) });
	});
}
export function createLabels3d<D = any>(map: SceneMap, data: Data<D>, opts: Labels3dOptions<D>): SceneHandle<Labels3dOptions<D>> {
	checkQuadOpts(opts);
	return makeHandle<D, Labels3dOptions<D>>(map, "labels3d", opts.id!, { ...opts, __data: data }, async (d, o) => {
		const arr = items(d), base = bakeQuads(arr, { ...o, getColor: undefined }), gt = acc<string, D>(o.getText, ""), gs = acc<number, D>(o.getSize, o.sizeUnits === "meters" ? 20 : 16), gc = acc<Color, D>(o.getColor, [255, 255, 255, 255]);
		const meters = o.sizeUnits === "meters", ratio = meters ? 1 : Math.min(2, globalThis.devicePixelRatio || 1);   // 文字を焼く倍率（m は 64px で焼いて縮める）
		const family = o.font || "system-ui, -apple-system, 'Segoe UI', sans-serif", weight = o.fontWeight ?? 600, hc = parseColor(o.haloColor ?? [0, 0, 0, 200]);
		// 字形が読めるまで待つ（その字の font だけ・長くても 3 秒＝届かない web font で止まらない）
		if (typeof document !== "undefined" && document.fonts?.load) await Promise.race([document.fonts.load(`${weight} 32px ${family}`, base.keep.map(i => String(gt(arr[i], i) ?? "")).join("").slice(0, 500) || "A").catch(() => null), new Promise(r => setTimeout(r, 3000))]);
		const meas = canvas2d(4, 4), entries: Array<AtlasEntry & { fontPx: number }> = [], keyIdx = new Map<string, number>(), per: Array<{ e: number; sz: number }> = [];
		for (const i of base.keep) {
			const text = String(gt(arr[i], i) ?? ""), sz = +gs(arr[i], i) || 16, fontPx = Math.round(meters ? 64 : sz * ratio), color = parseColor(gc(arr[i], i));
			const hw = (o.haloWidth ?? 2) * (meters ? 4 : ratio), fstr = `${weight} ${fontPx}px ${family}`, key = `${text}\u0000${fontPx}\u0000${color}`;
			if (!keyIdx.has(key)) {
				const m = measureLabel(meas, text, { fontPx, font: `${family}`, weight, halo: hw });
				keyIdx.set(key, entries.length);
				entries.push({ w: m.w, h: m.h, fontPx, draw: (ctx, x, y) => {
					ctx.font = fstr; ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.lineJoin = "round";
					m.lines.forEach((l, j) => {
						const tx = x + hw + 1, ty = y + hw + 1 + j * m.lh + (m.lh - fontPx) / 2;
						if (hw > 0) { ctx.strokeStyle = `rgba(${hc[0]},${hc[1]},${hc[2]},${hc[3] / 255})`; ctx.lineWidth = hw * 2; ctx.strokeText(l, tx, ty); }
						ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255})`; ctx.fillText(l, tx, ty);
					});
				} });
			}
			per.push({ e: keyIdx.get(key)!, sz });
		}
		const { atlas, rects } = atlasOf(entries);
		const n = base.keep.length, size = new Float32Array(n * 2), uv = new Float32Array(n * 4), anchor = new Float32Array(n * 2), A = anchorOf(o.anchor, "center");
		per.forEach(({ e, sz }, k) => {
			const r = rects[e], s = meters ? sz / entries[e].fontPx : 1 / ratio;
			size[k * 2] = r.w * s; size[k * 2 + 1] = r.h * s;
			uv.set([r.x / atlas.w, r.y / atlas.h, (r.x + r.w) / atlas.w, (r.y + r.h) / atlas.h], k * 4); anchor.set(A, k * 2);
		});
		return quadMsg(base, n, size, uv, anchor, atlas, { ...o, __props: propsOf(arr, base.keep, o.getProperties) });
	});
}

let anonSeq = 0;
const withId = <O extends { id?: string }>(o: O, kind: SceneKind): O & { id: string } => ({ ...o, id: o.id ?? `${kind}${++anonSeq}` });
// registry（dataKinds）から来る opts は素の Record＝各 create* が実行時に検める（checkEnum）
type Maker = (map: SceneMap, data: Data, opts: Record<string, unknown> & { id?: string }) => SceneHandle;
/** map.use(scenePlugin()) → map.addData(data, { kind: "instanced" | "billboards" | "labels3d", … }) */
export function scenePlugin({ kinds = ["instanced", "billboards", "labels3d"] }: { kinds?: SceneKind[] } = {}): ScenePlugin {
	const make: Record<SceneKind, Maker> = {
		instanced: (m, d, o) => createInstanced(m, d, o as InstancedOptions),
		billboards: (m, d, o) => createBillboards(m, d, o as unknown as BillboardOptions),
		labels3d: (m, d, o) => createLabels3d(m, d, o as unknown as Labels3dOptions),
	};
	for (const k of kinds) if (!make[k]) throw new Error(`scenePlugin: unknown kind "${k}" (instanced / billboards / labels3d)`);
	return {
		name: "plugin-scene",
		version: VERSION,
		provides: kinds.map(k => `data.${k}`),
		install(map: OrthoJapanMap): () => void {
			for (const k of kinds) map.registry.dataKinds.add(k, { create: (m, data, o) => make[k](m, data as Data, withId(o, k)) });
			return () => { for (const k of kinds) { try { map.registry.dataKinds.remove(k); } catch { /* 既に外れた */ } } };
		},
	};
}
export default scenePlugin;
