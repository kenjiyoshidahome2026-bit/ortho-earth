// ガジェット：glTF/GLB（3D 模型）の直読み（2026-09-20・本人裁定＝落とした地点＋埋め込みがあれば優先／PLATEAU 建物経路／loaders.gl）。
//   入口：app.js の INTAKE（ドロップ・?g=）と map.gadget.model(src, opts)。src＝File か URL（https・gh: は app の門が展開済み）。
//   読む：相方の worker（model-worker.js）が loaders.gl（PLATEAU 用の遅延チャンク）で解き、meshdecode.decodeModel＝PLATEAU と同じ後段
//         （剛体接地・RTE・LOD・溶接）で建物メッシュに焼く。main は塞がない。
//   置く：opts.at=[lon,lat]（落とした地点・?at=）。無ければ画面中心（center()）。glb に CESIUM_RTC/ECEF が埋まっていればそちらが勝つ（worker が判定）。
//         heading＝北から時計回りの度・scale＝倍率（?at=lon,lat,heading,scale）。
//   描く：renderer の meshSet スロット（setMesh＝app が wPost を注入）＝建物 3D と同じシェーダ（法線陰影・両面）。マテリアルごとに 1 バッチ
//         （key=名前#k・ward=名前）＝uv・頂点色（baseColorFactor×COLOR_0）・baseColorTexture を持つ派生パイプラインで描く（両バックエンド）。
//         PLATEAU の manager は関与しない（登録簿に無い名前は evict されない）。真俯瞰（pitch<0.02）では建物ごと描かれない＝fit はチルト付き。
//   単一スロット＝次の模型は前を置き換える（ドロップの掟「最後の 1 枚が勝つ」）。clear()＝外す。destroy()＝worker も畳む。
import { workerPool } from "../worker-rpc.ts";   // worker への往復（id つき postMessage）＝ガジェット共通
import { normAnimation } from "../gltf-meta.js";   // アニメの spec（F4）
import { samplePose, worldXf, batchXf, wrapTime } from "../gltf-anim.js";
import { pickMeshes, tintColors, lngLatOfWorld } from "../meshpick.js";   // 当たりと feature state の色（W7）
import { featureProperties } from "../mesh-features.js";
import { transcodersOf } from "../transcoders.js";   // registry.textureTranscoders の写し（W5）＝worker が import() する変換器の { name, url }   // rigid アニメの再生（W4）＝worker の rig/place から、時計ごとにバッチの剛体変換を出す
import { tr } from "../i18n.js";
import { HEIGHT_KEYS, LEVEL_KEYS } from "../extrude-keys.js";
import { evalExpr, truthy, parseRGBA, originOfLayer } from "@ortho-earth/core";   // MapLibre 式の評価器（基図スタイルと同じ一本）
import type { ExprContext } from "@ortho-earth/core";
import type { AnimationState, Bbox, LonLat, ModelHandle } from "../../globe.d.ts";
import type { GltfPlace, GltfRig } from "../gltf-anim.d.ts";
import type { MeshFeatures } from "../mesh-features.d.ts";
import type { MeshPickEnv } from "../types/install.ts";
import type { GlobeMap } from "../types/map.ts";
import type { MeshSetData, TileBatch } from "./tiles3d.ts";

/** 押し出しの元（GeoJSON の Feature／FeatureCollection／features を持つ物・その配列）＝読む欄だけ */
export interface GeoLike { type?: string; features?: GeoLike[]; geometry?: { type: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null }
export type ExtrudeSrc = GeoLike[] | GeoLike | null | undefined;
/** 高さ・床の指定（鍵名 | 数 | (props)=>m | 省略＝自動） */
export type HeightSpec = string | number | ((props: Record<string, unknown>) => number) | null | undefined;
/** extrudePolys の opts（ネイティブの height/base/color か MapLibre の paint/filter/layout） */
export interface ExtrudePolysOptions {
	height?: HeightSpec; base?: HeightSpec; color?: string | ((props: Record<string, unknown>, height: number) => string) | null; scale?: number;
	paint?: Record<string, unknown> | null; filter?: unknown; zoom?: number; type?: string | null;
	/** "ml"＝MapLibre の層＝MapLibre の意味で評価 */
	origin?: ExprContext["origin"];
	/** 地図の global-state（#173 段 3b） */
	gs?: Record<string, unknown> | null;
	layout?: Record<string, unknown> | null;
}
/** worker へ渡す面（環は度の平坦 Float64Array・fi＝元の地物の番号・grad／round＝MapLibre の層の壁の陰影と角の丸め） */
export interface ExtrudePoly { rings: Float64Array<ArrayBuffer>[]; h: number; base: number; rgba: number[]; fi: number; grad?: boolean; round?: number }
/** 押し出しの stats（gadget.extrude の戻り） */
interface ExtrudeStats { polygons: number; vertices: number; triangles: number; bbox: Bbox }
/** 立てた地物（問い合わせ用・幾何と属性は元の参照・h/base は床の持ち上げ前） */
interface ExtrudeUsed { f: GeoLike; h: number; base: number }
type ExtrudeMode = "plane" | "ground" | "drape";
interface ExtSlot { name: string; stats: ExtrudeStats; used: ExtrudeUsed[]; mode: ExtrudeMode; lift: number }
/** ctl.extrude の opts（extrudePolys の opts＋床・伏せ・寄り・スロット・層の metadata） */
export interface ModelExtrudeOptions extends Omit<ExtrudePolysOptions, "origin" | "gs"> {
	mask?: boolean | "auto"; bottom?: number | "drape" | "ground" | null; fit?: boolean; slot?: string; metadata?: Record<string, unknown> | null;
}
/** ctl.load の opts（gadget.model の opts＋ground・mask） */
export interface ModelLoadOptions {
	at?: LonLat | null; heading?: number; scale?: number; name?: string | null; fit?: boolean; textures?: boolean;
	/** "each"＝連結成分ごとに接地・既定 "batch"＝一体で接地 */
	ground?: string; mask?: boolean; pickable?: boolean; featureIdSet?: number;
}
/** worker の stats（公開の ModelHandle.stats＋地物の番号の数） */
type ModelStats = NonNullable<ModelHandle["stats"]> & { features?: { primitives: number; texture: number; tables: number } };
/** 模型の束（node＝アニメするノード・xf＝今の剛体変換・pos 以下＝当たりの写し（W7）） */
interface ModelBatch { node: number; origin: number[]; xfOn: boolean; xf: Float32Array | null; pos?: Float32Array; idx?: Uint32Array; features?: MeshFeatures | null; col0?: Uint8Array | null }
/** 今の模型 */
interface ModelCur {
	name: string; stats: ModelStats; src: string; animation: AnimationState | null; rig: GltfRig | null; place: GltfPlace | null;
	batches: ModelBatch[]; pickable: boolean; states: Map<number, Record<string, unknown>>;
}
/** worker（model 役）の答え */
interface LoadReply { stats: ModelStats; rig?: GltfRig | null; place?: GltfPlace | null; batches: Array<TileBatch & { node?: number }>; mask?: { bbox: number[]; n: number } | null }
interface ExtrudeReply { stats: ExtrudeStats; batches: Array<{ mesh: TileBatch["mesh"] }>; mask?: { bbox: number[]; n: number } | null }
/** createModel の戻り（公開の ModelHandle＋押し出し・読み込み） */
export interface ModelGadget extends ModelHandle {
	/** 押し出しの stats（"default" のスロット・無ければ最後のスロット） */
	readonly extruded: ExtrudeStats | null;
	readonly extrudedFeatures: Array<ExtrudeUsed & { slot: string }>;
	readonly extrudeSets: Array<{ slot: string; used: ExtrudeUsed[]; mode: ExtrudeMode; lift: number }>;
	readonly extrudeSlots: string[];
	clearExtrude(slot?: string | null): void;
	extrude(src: ExtrudeSrc, opts?: ModelExtrudeOptions): Promise<ExtrudeStats | null>;
	load(src: File | string, opts?: ModelLoadOptions): Promise<ModelGadget>;
}
/** createModel の deps（globe.js の modelCtlGet が渡す） */
export interface ModelEnv {
	setMesh(name: string, data: MeshSetData | null): void;
	/** バッチの剛体変換（glTF の rigid アニメ・W4）＝Float32Array(12)｜null */
	setMeshXf?: ((name: string, xf: Float32Array | null) => void) | null;
	/** feature state の色（W7）＝頂点色の列（RGBA8） */
	setMeshCol?: ((name: string, data: Uint8Array) => void) | null;
	pickEnv?: (() => MeshPickEnv | null) | null;
	/** 模型・押し出しへ寄る */
	fit?: ((bbox: Bbox) => void) | null;
	/** 置き場所の既定（画面中心） */
	center?: (() => LonLat) | null;
	ell?: boolean; signal?: AbortSignal;
}

const MAX_BYTES = 256e6;   // 正気上限（?g= と同じ・敵入力の巨大確保よけ）

// ── 押し出し（extrude・2026-09-21＝MapLibre の fill-extrusion 相当）──────────────────────────
// 高さの鍵は extrude-keys.js（app の自動判定と共有）
const BASE_KEYS = ["min_height", "base_height", "building:min_height", "base"];
const num = (v: unknown) => { if (v == null || v === "") return NaN; if (typeof v === "number") return v; const m = String(v).match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : NaN; };   // "12m"・"約 12.5" も数に
export function heightOf(props: Record<string, unknown> | null | undefined, spec: HeightSpec) {   // spec＝鍵名 | 数 | (props)=>m | undefined（自動）
	if (typeof spec === "function") return +spec(props || {});
	if (typeof spec === "number") return spec;
	if (!props) return NaN;
	if (typeof spec === "string") return num(props[spec]);
	for (const k of HEIGHT_KEYS) { const h = num(props[k]); if (h > 0) return h; }
	for (const k of LEVEL_KEYS) { const n = num(props[k]); if (n > 0) return n * 3; }
	return NaN;
}
// 色＝#rgb/#rrggbb/#rrggbbaa/rgb()/色名。色名などは canvas に正規化させる（main スレッドだけで呼ぶ）
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;
function rgbaOf(c: unknown): number[] | null {
	if (typeof c !== "string" || !c) return null;
	let m = c.trim().match(/^#([0-9a-f]{3,8})$/i);
	if (!m) { ctx2d ??= new OffscreenCanvas(1, 1).getContext("2d"); ctx2d!.fillStyle = "#000"; ctx2d!.fillStyle = c; const f = ctx2d!.fillStyle as string; m = f.match(/^#([0-9a-f]{6})$/i); if (!m) { const r = f.match(/[\d.]+/g); return r ? [+r[0], +r[1], +r[2], 255] : null; } }
	let h = m[1]; if (h.length <= 4) h = [...h].map(x => x + x).join("");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];   // α は捨てる＝壁は不透明（半透明の塗り色でも建物は立つ色で）
}
// ── MapLibre の fill-extrusion をそのまま受ける口（2026-09-21・「形式で相乗り」）──────────────────
// paint の "fill-extrusion-height" / "-base" / "-color" / "-opacity" と filter を、MapLibre と同じ意味で評価する。
// 式は基図スタイルと同じ評価器（ortho-core の evalExpr）。色の補間（interpolate の出力が色）は評価器が数しか補間しない
// ＝ここで色として補間する（MapLibre の定番＝高さで lightgray→royalblue）。色名・hsl は canvas に正規化させる。
// 既定値は MapLibre の仕様どおり（height 0・base 0・color "#000000"・opacity 1）＝height を書かない層は立たない。
export const FX = { height: "fill-extrusion-height", base: "fill-extrusion-base", color: "fill-extrusion-color", opacity: "fill-extrusion-opacity" };
export function cssRGBA(c: unknown): number[] | null {   // → [r,g,b（0-255）, a（0-1）] | null
	if (Array.isArray(c)) return c.length >= 3 ? [c[0] * 255, c[1] * 255, c[2] * 255, c[3] ?? 1] : null;   // 評価器の rgba 配列（0-1）
	if (typeof c !== "string" || !c) return null;
	if (typeof OffscreenCanvas === "undefined") { const q = parseRGBA(c); return [q[0] * 255, q[1] * 255, q[2] * 255, q[3]]; }   // Node（検定）＝hex/rgb だけ
	ctx2d ??= new OffscreenCanvas(1, 1).getContext("2d");
	ctx2d!.fillStyle = "#000"; ctx2d!.fillStyle = c;
	const f = ctx2d!.fillStyle as string, m = f.match(/^#([0-9a-f]{6})$/i);
	if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
	const r = f.match(/[\d.]+/g);
	return r ? [+r[0], +r[1], +r[2], r[3] != null ? +r[3] : 1] : null;
}
export function evalColor(e: unknown, ctx: ExprContext): number[] | null {
	if (Array.isArray(e) && e[0] === "interpolate") {
		const input = evalExpr<number>(e[2], ctx), stops: Array<[number, unknown]> = [];
		if (ctx?.origin === "ml" && typeof input !== "number") return null;   // MapLibre の文書＝入力が数でなければ評価エラー＝既定値へ
		for (let i = 3; i < e.length; i += 2) stops.push([e[i], e[i + 1]]);
		if (!stops.length) return null;
		const col = (k: number) => cssRGBA(evalExpr(stops[k][1], ctx));
		if (!(input > stops[0][0])) return col(0);
		if (input >= stops[stops.length - 1][0]) return col(stops.length - 1);
		let k = 0; while (k < stops.length - 1 && stops[k + 1][0] <= input) k++;
		const x0 = stops[k][0], x1 = stops[k + 1][0], type = e[1];
		let t = (input - x0) / (x1 - x0);
		if (type?.[0] === "exponential" && type[1] !== 1) t = (Math.pow(type[1], input - x0) - 1) / (Math.pow(type[1], x1 - x0) - 1);
		const a = col(k), b = col(k + 1);
		return a && b ? a.map((v, i) => v + (b[i] - v) * t) : (a || b);
	}
	return cssRGBA(evalExpr(e, ctx));
}
// MapLibre の層（{ type:"fill-extrusion", paint, filter }）か paint/filter を持つ opts か
export const isMapLibreLayer = (o: { type?: unknown; paint?: Record<string, unknown> | null } | null | undefined) => !!o && (o.type === "fill-extrusion" || (o.paint && Object.keys(o.paint).some(k => k.startsWith("fill-extrusion-"))));

// 既定の色＝高さの段彩（低い＝明るい砂色 → 高い＝群青）。@fill（geoedit の面の色）があればそちらが勝つ
const RAMP: Array<[number, number[]]> = [[0, [236, 226, 204]], [15, [214, 196, 160]], [40, [150, 170, 196]], [100, [86, 118, 170]], [250, [44, 62, 120]]];
function rampOf(h: number) {
	for (let i = 1; i < RAMP.length; i++) if (h <= RAMP[i][0]) {
		const [h0, a] = RAMP[i - 1], [h1, b] = RAMP[i], t = (h - h0) / (h1 - h0);
		return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * t)).concat(255);
	}
	return RAMP[RAMP.length - 1][1].concat(255);
}
// GeoJSON（Feature/FeatureCollection/features 配列）→ worker へ渡す面の列（環は度の平坦 Float64Array）
export function extrudePolys(src: ExtrudeSrc, { height, base, color, scale = 1, paint = null, filter = null, zoom = 16, type = null, origin = undefined, gs = undefined, layout = null }: ExtrudePolysOptions = {}) {   // gs＝地図の global-state（#173 段 3b）・origin＝"ml"（MapLibre の層＝MapLibre の意味で評価）
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features! : src?.type === "Feature" ? [src] : src?.features || [];
	const out: ExtrudePoly[] = [];
	const ml = isMapLibreLayer({ type, paint });
	const op0 = ml ? evalExpr<number>(paint![FX.opacity] ?? 1, { zoom, props: {}, geom: null, vars: {}, gs, origin }) : 1;
	const opacity = ml ? Math.max(0, Math.min(1, +(op0 === undefined && origin ? 1 : op0))) : 1;   // ML の評価エラー＝既定 1   // MapLibre では層単位（データ駆動しない）
	// C6（2026-10-12）：壁の縦の陰影（fill-extrusion-vertical-gradient・既定 true・層単位）と角の丸め（layout の fill-extrusion-rounded-corner-distance・m・既定 0）＝MapLibre の層だけ（ネイティブの opts は従来どおり平らな壁・角のまま）
	const lctx = { zoom, props: {}, geom: null, vars: {}, gs, origin };
	const grad = ml ? evalExpr(paint!["fill-extrusion-vertical-gradient"] ?? true, lctx) !== false : false;
	const round = ml ? Math.max(0, +evalExpr<number>(layout?.["fill-extrusion-rounded-corner-distance"] ?? 0, lctx) * scale || 0) : 0;
	for (let fi = 0; fi < feats.length; fi++) {
		const f = feats[fi];
		const g = f?.geometry; if (!g) continue;
		const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : g.type === "MultiPolygon" ? g.coordinates as number[][][][] : null;
		if (!polys) continue;
		const p = f.properties || {};
		if (ml || filter) {   // MapLibre の意味（filter は真偽式・paint は式）。geometry-type は MapLibre と同じ "Polygon"（Multi も Polygon）
			const ctx = { zoom, props: p, geom: "Polygon", vars: {}, gs, origin };
			if (filter != null && !truthy(evalExpr(filter, ctx))) continue;
			if (ml) {
				const h = +evalExpr<number>(paint![FX.height] ?? 0, ctx) * scale, b = Math.max(0, +evalExpr<number>(paint![FX.base] ?? 0, ctx) * scale);
				if (!(h > b)) continue;
				const c = evalColor(paint![FX.color] ?? "#000000", ctx) || [0, 0, 0, 1];
				const rgba = [c[0], c[1], c[2], (c[3] ?? 1) * opacity * 255].map(v => Math.max(0, Math.min(255, Math.round(v))));
				for (const rings of polys) {
					const rs: Float64Array<ArrayBuffer>[] = [];
					for (const r of rings || []) { if (!r || r.length < 3) continue; const a = new Float64Array(r.length * 2); r.forEach((q, i) => { a[i*2] = q[0]; a[i*2+1] = q[1]; }); rs.push(a); }
					if (rs.length) out.push({ rings: rs, h, base: b, rgba, fi, grad, round });
				}
				continue;
			}
		}
		const h = heightOf(p, height) * scale;
		if (!(h > 0)) continue;
		let b = typeof base === "function" ? +base(p) : typeof base === "number" ? base : typeof base === "string" ? num(p[base]) : NaN;
		if (!(b >= 0)) { b = 0; for (const k of BASE_KEYS) { const v = num(p[k]); if (v > 0) { b = v; break; } } }
		b *= base == null || typeof base === "string" ? scale : 1;
		if (!(h > b)) continue;
		const rgba = (typeof color === "function" ? rgbaOf(color(p, h)) : rgbaOf(color)) || rgbaOf(p["@fill"]) || rgbaOf(p.color) || rgbaOf(p["building:colour"]) || rampOf(h);
		for (const rings of polys) {
			const rs: Float64Array<ArrayBuffer>[] = [];
			for (const r of rings || []) { if (!r || r.length < 3) continue; const a = new Float64Array(r.length * 2); r.forEach((c, i) => { a[i*2] = c[0]; a[i*2+1] = c[1]; }); rs.push(a); }
			if (rs.length) out.push({ rings: rs, h, base: b, rgba, fi });   // fi＝元の地物の番号（問い合わせで属性へ戻る）
		}
	}
	return out;
}

const DEFAULT_BOTTOM = 2000;   // 統計の押し出しの既定の床[m]（本人裁定 2026-09-22「bottom=2000 ぐらい」＝日本の大半の山地より上・超える峰は寄ると頭が出る）
export function createModel(map: GlobeMap, { setMesh, setMeshXf = null, setMeshCol = null, pickEnv = null, fit, center, ell = false, signal }: ModelEnv = {} as ModelEnv) {   // setMeshCol・pickEnv＝当たりと feature state の色（W7）
	const t = tr();
	let seq = 0, cur: ModelCur | null = null;   // seq＝模型・押し出しの名前の連番・cur＝{ name, stats, src }
	const animListeners = new Set<(state: AnimationState | null, model: ModelHandle) => void>();   // setAnimation の合図（F4）
	// rigid アニメの再生（W4）：cur.rig（ノードの親子・静止 TRS・channel）・cur.place（ローカル→ECEF→世界座標の写し）・cur.batches（束ごとのノード番号と原点）から、
	// アニメの時刻でノードの world 行列を標本化し、束ごとの剛体変換（L 3x3＋原点相対の平行移動）を renderer の "meshXf" へ。頂点は焼き直さない。
	// 時計＝map.getNow（setNow で止められる＝決定論の撮影）。playing の間は rAF で進め、loop 無しは端で止まる（playing=false）。skin／morph は読まない（spec のまま）
	let animRaf = 0, animLast: number | null = null;
	const nowMs = () => map?.getNow?.() ?? performance.now();
	const poseAt = (time: number) => {   // → 束ごとの Float32Array(12)|null（アニメが無い／動かない束は null）
		const a = cur?.animation; if (!cur?.rig || !cur.place || !a || a.index == null) return null;
		const pose = samplePose(cur.rig, a.index, wrapTime(time, a.duration, a.loop)); if (!pose) return null;
		return cur.batches.map(b => b.node >= 0 ? batchXf(worldXf(pose, b.node, cur!.place!), b.origin) : null);
	};
	const applyPose = (time: number) => { const xs = poseAt(time); if (!cur || !setMeshXf) return; cur.batches.forEach((b, k) => { const xf = xs ? xs[k] : null; b.xf = xf; if (xf || b.xfOn) { setMeshXf(`${cur!.name}#${k}`, xf); b.xfOn = !!xf; } }); };   // b.xf＝当たり（W7）も同じ姿勢で
	const stopLoop = () => { if (animRaf) cancelAnimationFrame(animRaf); animRaf = 0; animLast = null; };
	const tick = () => {
		animRaf = 0; const a = cur?.animation; if (!a || !a.playing) { animLast = null; return; }
		const t = nowMs(), dt = animLast == null ? 0 : Math.min(0.25, Math.max(0, (t - animLast) / 1000)); animLast = t;
		let time = a.time + dt * a.speed, playing = true;
		if (!a.loop && a.duration > 0 && (time >= a.duration || time <= 0)) { time = time <= 0 ? 0 : a.duration; playing = false; }   // 端で止まる
		else time = wrapTime(time, a.duration, a.loop);
		cur!.animation = { ...a, time, playing };
		applyPose(time);
		if (playing) animRaf = requestAnimationFrame(tick); else animLast = null;
	};
	const repaintStates = () => {   // feature state の色（W7）＝束ごとに元の頂点色から差し替えた列を renderer の "meshCol" へ（state の無い束も一度戻す）
		if (!cur || !setMeshCol) return;
		const colorOf = (id: number) => { const c = cur!.states.get(id)?.color; const v = c ? rgbaOf(String(c)) : null; return v ? v.slice(0, 3) : null; };
		cur.batches.forEach((b, k) => { if (!b.col0 || !b.features) return; setMeshCol(`${cur!.name}#${k}`, tintColors(b.col0, b.features.ids, colorOf)); });
	};
	const syncAnim = () => { if (!cur) return; const a = cur.animation; stopLoop(); applyPose(a ? a.time : 0); if (a?.playing && cur.rig && typeof requestAnimationFrame === "function") animRaf = requestAnimationFrame(tick); };
	const pool = workerPool(() => new Worker(new URL("../worker.ts", import.meta.url), { type: "module", name: "model" }), { tag: "model" });   // 入口 1 本（worker.js）＝役割は name（model-worker.js）・最初の rpc で作る
	const rpc = pool.rpc;
	const clear = () => { stopLoop(); if (cur) { setMesh(cur.name, null); cur = null; } };
	// 押し出しの今＝slot → { name, stats, used }（模型とは別スロット＝GLB と並べて立てられる）。
	// slot＝層の名前（map.addLayer の fill-extrusion は層 id ごと＝複数並べられる・#34）。ガジェット直呼びは "default"＝従来どおり置き換え
	const exts = new Map<string, ExtSlot>();
	const clearExtrude = (slot?: string | null) => {
		for (const [k, e] of [...exts]) if (slot == null || k === slot) { setMesh(e.name, null); exts.delete(k); }
	};
	const ctl: ModelGadget = {
		get stats() { return cur?.stats || null; },
		// glTF の口（F4・2026-10-12・src/gltf-meta.js）：animations＝模型に入っているアニメの見出し（name/duration/paths）・setAnimation(spec)＝再生の spec を受けて保つ（描くのは第 3 波か plugin＝capabilities "gltf.animation" は spec）
		get animations() { return (cur?.stats?.gltf?.animations || []).map(a => ({ ...a, paths: [...a.paths] })); },
		get gltf() { return cur?.stats?.gltf ? { ...cur.stats.gltf, animations: ctl.animations } : null; },
		setAnimation(spec) { if (!cur) throw new Error("setAnimation: no model loaded"); cur.animation = normAnimation(spec, cur.stats.gltf?.animations || []); syncAnim(); for (const f of animListeners) { try { f(cur.animation, ctl); } catch (e) { console.warn("[model] animation listener", e); } } return ctl; },
		getAnimation() { return cur?.animation ? { ...cur.animation } : null; },
		play(nameOrSpec) { return ctl.setAnimation(typeof nameOrSpec === "object" && nameOrSpec ? { ...nameOrSpec, playing: true } : { name: nameOrSpec ?? undefined, playing: true }); },
		stop() { if (cur?.animation) { cur.animation = { ...cur.animation, playing: false }; stopLoop(); } return ctl; },
		// 再生の時刻での束ごとの剛体変換（検定・台本の口）：time 省略＝今の spec の時刻。[Float32Array(12)|null]（L 3x3 列優先＋原点相対の平行移動）｜null（アニメ無し）
		pose(time) { return poseAt(time ?? cur?.animation?.time ?? 0); },
		get animating() { return !!animRaf; },
		onAnimation(f) { animListeners.add(f); return () => animListeners.delete(f); },   // plugin が再生を担う時の合図（spec が変わるたび）
		get bbox() { return cur?.stats?.bbox || null; },
		get name() { return cur?.name || null; },
		clear,
		get extruded() { return exts.get("default")?.stats ?? [...exts.values()].pop()?.stats ?? null; },
		get extrudedFeatures() { return [...exts].flatMap(([slot, e]) => e.used.map(u => ({ ...u, slot }))); },   // [{ f: Feature, h, base, slot }]（新しいスロットが後ろ）
		// map.queryRenderedFeatures の押し出し層（立体の当たり）＝スロットごと [{ slot, used: [{ f, h, base }], mode: "plane"|"ground"|"drape", lift: 床の平面の高さ[m] }]（新しいスロットが後ろ）
		get extrudeSets() { return [...exts].map(([slot, e]) => ({ slot, used: e.used, mode: e.mode, lift: e.lift })); },
		get extrudeSlots() { return [...exts.keys()]; },
		clearExtrude,
		// 押し出し：src＝GeoJSON（Feature/FeatureCollection/features 配列）。opts＝{ height: 鍵名|数|fn, base, color: css|fn, scale, mask, fit }
		//   または MapLibre の層そのもの（{ type:"fill-extrusion", paint:{ "fill-extrusion-height": 式, … }, filter: 式 }）＝MapLibre と同じ意味で評価
		// 高さ無し（自動の鍵に当たらない）の面は立てない。戻り値＝stats（polygons/triangles/bbox）か、立つ面が無ければ null
		async extrude(src, { height, base, color, scale = 1, mask = "auto", bottom = null, fit: doFit = false, paint = null, filter = null, zoom = 16, type = null, slot = "default", metadata = null, layout = null } = {}) {   // bottom＝床の高さ[m]＝その高さの平面に浮かせる（全体の床・面ごとの base とは別）。"drape"＝地形に沿わせる。"ground"＝大きさに関わらず建物と同じ接地。無指定で MapLibre 形の層＝接地。それ以外の無指定＝広い面（対角の中央値 ≥ 500m＝下の buildingLike）は 2,000m の平面・建物らしい面は接地（地形に沿わせない＝山が突き抜けない・高さ＝値はその平面から測る）＝400m 角の箱でも 2,000m に立つ（t-extrude-size）   // mask="auto"＝建物らしい大きさ（面の中央値 < 500m）の時だけ足元の基図建物を伏せる
			const polys = extrudePolys(src, { height, base, color, scale, paint, filter, zoom, type, origin: originOfLayer({ metadata }), gs: map.getGlobalState?.(), layout });
			const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features! : src?.type === "Feature" ? [src] : src?.features || [];
			const first = new Map<number, ExtrudePoly>(); for (const p of polys) if (!first.has(p.fi)) first.set(p.fi, p);
			const used = [...first].map(([fi, p]) => ({ f: feats[fi], h: p.h, base: p.base }));   // 立てた地物（問い合わせ用・幾何と属性は元の参照・h/base は床の持ち上げ前）
			const blend = polys.some(p => p.rgba[3] < 255);   // fill-extrusion-opacity<1／半透明の色＝BLEND（模型と同じ派生パイプライン）
			if (!polys.length) { clearExtrude(slot); return null; }
			const tr: ArrayBuffer[] = []; for (const p of polys) for (const r of p.rings) tr.push(r.buffer);
			const buildingLike = (() => { const diag = polys.map(p => { const r0 = p.rings[0]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < r0.length; i += 2) { if (r0[i] < x0) x0 = r0[i]; if (r0[i] > x1) x1 = r0[i]; if (r0[i+1] < y0) y0 = r0[i+1]; if (r0[i+1] > y1) y1 = r0[i+1]; } return Math.hypot((x1 - x0) * 111320 * Math.cos((y0 + y1) / 2 * Math.PI / 180), (y1 - y0) * 110540); }).sort((a, b) => a - b); return diag[diag.length >> 1] < 500; })();
			// 地面の扱い（2026-09-22 本人裁定：「bottom=n で最低高を外から指定すればそれに合わせる」→ドレープは寄ると R01 の起伏に屋根が追いつかず
			// まだらに抜けた＝「ドレイプはやっぱり厳しい・bottom=2000 ぐらいで」）：
			//   bottom（数値）＝その高さ[m]の平面に浮かせる＝地形へ持ち上げない（noLift）・屋根は弦のたわみだけ消す刻み
			//   bottom:"drape"＝頂点ごとに地表へ持ち上げる（DTM 保証域に縛らず全ズーム・屋根は起伏に沿う刻み）
			//   bottom:"ground"＝大きさに関わらず建物と同じ接地（DTM 保証域の中で持ち上げる・外は海抜 0m）
			//   無指定＝広い面（市区町村・メッシュの統計）は DEFAULT_BOTTOM の平面／建物らしい面は従来どおり接地（DTM 保証域の中で持ち上げる）
			//   無指定で MapLibre 形の層（origin "ml"）＝大きさに関わらず接地（本人裁定 2026-10-14＝MapLibre は常に地面から。浮かせたければ層に bottom:<m>）
			const ml = originOfLayer({ metadata }) === "ml";
			const mode = bottom === "drape" ? "drape" : bottom === "ground" ? "ground" : Number.isFinite(bottom) ? "plane" : ml || buildingLike ? "ground" : "plane";
			const lift = mode === "plane" ? (Number.isFinite(bottom) ? bottom as number : DEFAULT_BOTTOM) : null;
			if (lift != null) for (const p of polys) { p.base += lift; p.h += lift; }
			if (mask === "auto") {   // 市区町村・メッシュのような広い面で伏せると、日本中の基図建物が消える＝建物らしい大きさの時だけ
				const diag = polys.map(p => { const r0 = p.rings[0]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < r0.length; i += 2) { if (r0[i] < x0) x0 = r0[i]; if (r0[i] > x1) x1 = r0[i]; if (r0[i + 1] < y0) y0 = r0[i + 1]; if (r0[i + 1] > y1) y1 = r0[i + 1]; } return Math.hypot((x1 - x0) * 111320 * Math.cos(y0 * Math.PI / 180), (y1 - y0) * 111320); }).sort((a, b) => a - b);
				mask = diag[diag.length >> 1] < 500;
			}
			const r = await rpc<ExtrudeReply>({ kind: "extrude", polys, ell, mask: mask && !blend, refine: mode === "plane" ? 20000 : 1500 }, tr);   // 屋根の細分の刻み(m)＝沿わせる時は起伏に・平面は弦のたわみ（75km 角で約 240m・20km 刻みなら約 8m）を消すだけ   // 半透明は足元の基図建物を伏せない（透けて見える先が消えると不自然）
			clearExtrude(slot);
			const key = `extrude/${++seq}`;
			exts.set(slot, { name: key, stats: r.stats, used, mode, lift: lift ?? 0 });   // mode/lift＝問い合わせの立体の当たり（描いた地面と同じ所で当てる）
			r.batches.forEach((b, k) => setMesh(`${key}#${k}`, { ...b.mesh, noLift: mode === "plane", drape: mode === "drape", keep2d: true, castShadow: buildingLike, ward: key, tex: null, alphaMode: blend ? "BLEND" : "OPAQUE", alphaCutoff: 0.5, maskBbox: r.mask?.bbox || null, maskN: r.mask?.n || 0 }));
			console.info(`[extrude] ${r.stats.polygons} polygons, ${r.stats.triangles} tris`, r.stats.bbox);
			if (doFit && fit) fit(r.stats.bbox);
			return r.stats;
		},
		destroy() { clear(); clearExtrude(); pool.destroy(); },
		// src＝File | URL 文字列。戻り値＝ctl（stats/bbox）。失敗は throw（dropFile がトーストへ出す）
		// ground="each"＝連結成分ごとに接地（街の一区画を切り出した模型＝高台の建物が浮かない）。既定 "batch"＝一体で接地
		// mask=true＝模型の足元の基図建物を伏せる（街の一区画を切り出した模型＝白い箱と二重に描いて壁が明滅するのを断つ）
		async load(src, { at = null, heading = 0, scale = 1, name = null, fit: doFit = true, textures = true, ground = "batch", mask = false, pickable = true, featureIdSet = 0 } = {}) {   // pickable＝当たりの写し（頂点・index）を main に持つ（W7・false＝持たない＝pick は null）   // textures=false＝形だけ（画像を読まない）
			let ab: ArrayBuffer, baseUri: string | null = null;
			if (typeof src === "string") {
				const r = await fetch(src, { credentials: "omit" });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				if (+r.headers.get("content-length")! > MAX_BYTES) throw new Error("too large");
				ab = await r.arrayBuffer();
				baseUri = src;   // .gltf の外部 .bin/画像は URL 相対で解決（File では埋め込み buffer だけ）
				name ??= decodeURIComponent(src.split("/").pop() || "") || "model.glb";
			} else {
				if (src.size > MAX_BYTES) throw new Error("too large");
				ab = await src.arrayBuffer();
				name ??= src.name || "model.glb";
			}
			const anchor = at || center?.() || null;
			const r = await rpc<LoadReply>({ ab, at: anchor, heading, scale, baseUri, ell, textures, ground, mask, featureIdSet, transcoders: transcodersOf(map) }, [ab]).catch(err => {
				if (err.message === "no-triangles") throw new Error(t("3D model has no triangles"));
				throw err;
			});
			clear();
			const key = `model/${++seq}`;
			cur = { name: key, stats: r.stats, src: name, animation: null, rig: r.rig || null, place: r.place || null, batches: r.batches.map(b => ({ node: b.node ?? -1, origin: b.mesh.origin ? [...b.mesh.origin] : [0, 0, 0], xfOn: false, xf: null,
				...(pickable ? { pos: b.mesh.pos.slice(), idx: b.mesh.idx.slice(), features: b.features || null, col0: b.features && b.mesh.col ? b.mesh.col.slice() : null } : {}) })), pickable, states: new Map() };   // 当たりの写し（W7）＝setMesh が transfer する前に取る   // rig/place/batches＝rigid アニメ（W4）
			r.batches.forEach((b, k) => setMesh(`${key}#${k}`, { ...b.mesh, ward: key, tex: b.tex, texMR: b.texMR, texN: b.texN, texOcc: b.texOcc, texEm: b.texEm, pbr: b.pbr, alphaMode: b.alphaMode, alphaCutoff: b.alphaCutoff, maskBbox: r.mask?.bbox || null, maskN: r.mask?.n || 0 }));   // pbr＋材質 4 枚＝#46 段 2   // ward＝自分の名前（解放は名前#* の一括・マスク不参加）。バッチ＝マテリアル
			console.info(`[model] ${name}: ${r.stats.triangles} tris, ${r.stats.vertices} verts, ${r.stats.instances} instances, ${r.stats.materials} materials (${r.stats.textures} textured, ${r.stats.blended} blended), placed by ${r.stats.mode}`, r.stats.bbox);
			if (doFit && fit) fit(r.stats.bbox);
			return ctl;
		},
		// ── 当たりと feature state（第 3 波 W7）──────────────────────────────────────
		// pick(x, y)＝画面の点（CSS px）に一番手前の三角形 → { featureId, properties, table, batch, distance, lngLat } | null。
		// featureId＝EXT_mesh_features（組は load の featureIdSet・attribute／implicit）か _BATCHID の番号（無ければ null＝模型そのものに当たった）
		pick(x, y) {
			if (!cur?.pickable || !pickEnv) return null;
			const env = pickEnv(); if (!env) return null;
			if (!env.show3d) return null;   // 真俯瞰＝模型は描かれない（renderer の show3d）＝当てない
			const items = cur.batches.map(b => b.pos ? { pos: b.pos, idx: b.idx!, origin: b.origin, xf: b.xf, lift: env.lift(b.origin), features: b.features } : null);
			const h = pickMeshes(items, env.view, x, y); if (!h) return null;
			const b = cur.batches[h.item], f = b.features, tIdx = f ? (f.tblV ? f.tblV[h.vertex] : f.table) : null, table = tIdx != null && tIdx >= 0 ? f!.tables?.[tIdx] : null;
			return { featureId: h.featureId, properties: h.featureId != null ? featureProperties(table, h.featureId) : {}, table: table ? { index: tIdx!, name: table.name, class: table.class } : null,
				batch: h.item, distance: h.w, lngLat: lngLatOfWorld(h.world), state: h.featureId != null ? { ...(cur.states.get(h.featureId) || {}) } : {} };
		},
		// 地物の一覧の見出し＝{ primitives, tables: [{ name, class, count, columns }] } | null
		get features() {
			const fb = cur?.batches?.find(b => b.features); if (!fb) return cur?.stats?.features ? { ...cur.stats.features, tables: [] } : null;
			return { ...(cur!.stats.features || {}) as NonNullable<ModelStats["features"]>, tables: (fb.features!.tables || []).map(T => ({ name: T.name, class: T.class, count: T.count, columns: Object.keys(T.columns) })) };
		},
		// feature state（MapLibre の setFeatureState と同じ置き場の考え方）＝{ color: CSS 色 } を描きに効かせる（頂点色を差し替え＝テクスチャに掛かる）。他の鍵は保つだけ
		setFeatureState(id, state) {
			if (!cur || id == null) return ctl;
			const prev = cur.states.get(+id) || {}, next = state == null ? {} : { ...prev, ...state };
			if (Object.keys(next).length) cur.states.set(+id, next); else cur.states.delete(+id);
			repaintStates(); return ctl;
		},
		getFeatureState(id) { return { ...(cur?.states.get(+id) || {}) }; },
		removeFeatureState(id) { if (!cur) return ctl; if (id == null) cur.states.clear(); else cur.states.delete(+id); repaintStates(); return ctl; },
		toastLength() { return cur ? t("$1 triangles", cur.stats.triangles) : "?"; },
	};
	signal?.addEventListener("abort", () => ctl.destroy(), { once: true });
	return ctl;
}
