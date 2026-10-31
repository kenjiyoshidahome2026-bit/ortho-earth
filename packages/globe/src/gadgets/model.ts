// ガジェット：glTF/GLB（3D 模型）の直読み（2026-09-20・本人裁定＝落とした地点＋埋め込みがあれば優先／PLATEAU 建物経路／loaders.gl）。
//   入口：app.js の INTAKE（ドロップ・?g=）と map.gadget.model(src, opts)。src＝File か URL（https・gh: は app の門が展開済み）。
//   読む：相方の worker（model-worker.js）が loaders.gl（PLATEAU 用の遅延チャンク）で解き、meshdecode.decodeModel＝PLATEAU と同じ後段
//         （剛体接地・RTE・LOD・溶接）で建物メッシュに焼く。main は塞がない。
//   置く：opts.at=[lon,lat]（落とした地点・?at=）。無ければ画面中心（center()）。glb に CESIUM_RTC/ECEF が埋まっていればそちらが勝つ（worker が判定）。
//         heading＝北から時計回りの度・scale＝倍率（?at=lon,lat,heading,scale）。
//   描く：renderer の meshSet スロット（setMesh＝app が wPost を注入）＝建物 3D と同じシェーダ（法線陰影・両面）。マテリアルごとに 1 バッチ
//         （key=名前#k・ward=名前）＝uv・頂点色（baseColorFactor×COLOR_0）・baseColorTexture を持つ派生パイプラインで描く（両バックエンド）。
//         PLATEAU の manager は関与しない（登録簿に無い名前は evict されない）。真俯瞰（pitch<0.02）では建物ごと描かれない＝fit はチルト付き。
//   スロット（2026-10-18・生成 AI の模型を「並べる」）：opts.slot（既定 "default"）ごとに 1 体＝同じ slot は置き換え（ドロップの掟「最後の 1 枚が勝つ」は default の中で）・
//         別の slot は並ぶ。load の戻り＝その模型の手綱（ModelHandle）。ガジェット（ctl）の stats/bbox/name は最後に置いた模型・pick は全部から一番手前・clear()＝全部外す。
//   動かす（2026-10-18）：handle.setLngLat／setHeading／setScale／setAltitude／setTransform＝頂点は焼き直さず、束の剛体変換（W4 の meshXf）に
//         「元の ENU → 今の ENU」の回転＋倍率＋平行移動を畳んで renderer へ（アニメの姿勢と合成）。地形への持ち上げは shader が頂点の今の経緯度で引く＝動かした先の地面に乗る。
//         ギズモ（handle.gizmo(true)・model-gizmo.js）＝錨の取っ手（移動）・輪（回転）・角（倍率）を DOM で描き、つまんで動かす。
import { workerPool } from "../worker-rpc.ts";   // worker への往復（id つき postMessage）＝ガジェット共通
import { normAnimation } from "../gltf-meta.ts";   // アニメの spec（F4）
import { samplePose, worldXf, batchXf, wrapTime, skinBatch } from "../gltf-anim.ts";
import { createGizmo } from "./model-gizmo.ts";   // 置き方の取っ手（2026-10-18）
import type { Gizmo } from "./model-gizmo.ts";
import { pickMeshes, tintColors, lngLatOfWorld } from "../meshpick.ts";   // 当たりと feature state の色（W7）
import { featureProperties } from "../mesh-features.ts";
import { transcodersOf } from "../transcoders.ts";   // registry.textureTranscoders の写し（W5）＝worker が import() する変換器の { name, url }   // rigid アニメの再生（W4）＝worker の rig/place から、時計ごとにバッチの剛体変換を出す
import { tr } from "../i18n.ts";
import { HEIGHT_KEYS, LEVEL_KEYS } from "../extrude-keys.ts";
import { evalExpr, truthy, parseRGBA, originOfLayer, lonlatTo3D, worldRadiusM, ellNormal3D } from "@ortho-earth/core";   // MapLibre 式の評価器（基図スタイルと同じ一本）・lonlatTo3D＝β単位球の世界座標（模型を動かす回転の土台）
import type { ExprContext } from "@ortho-earth/core";
import type { AnimationState, Bbox, LonLat, ModelHandle, ModelTransform } from "../../globe.d.ts";
import type { GltfPlace, GltfRig, WorldXf, SkinSeg, GltfPose } from "../gltf-anim.ts";
import type { MeshFeatures } from "../mesh-features.ts";
import type { MeshPickEnv } from "../types/install.ts";
import type { MeshItemRef } from "../meshpick.ts";
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
	/** "phong"＝Cesium の czm_phong（目の向きと上からの 2 灯・太陽に依らない＝Cesium の entity の押し出し） */ lighting?: "phong" | null;
}
/** ctl.load の opts（gadget.model の opts＋ground・mask） */
export interface ModelLoadOptions {
	at?: LonLat | null; heading?: number; scale?: number; name?: string | null; fit?: boolean; textures?: boolean;
	/** "each"＝連結成分ごとに接地・既定 "batch"＝一体で接地 */
	ground?: string; mask?: boolean; pickable?: boolean; featureIdSet?: number;
	/** 利用者のシェーダ（Cesium の CustomShader）＝map.setCustomShader の名・mc＝positionMC（glTF の POSITION）を頂点ごとに持つ */
	customShader?: string | null; mc?: boolean;
	/** 置き場（既定 "default"）＝同じ slot は置き換え・別の slot は並ぶ（2026-10-18） */
	slot?: string;
	/** 地面からの高さ（m・既定 0）＝置いた後も setAltitude で変えられる */
	altitude?: number;
	/** false＝地形へ持ち上げない（altitude を海面からの絶対高として置く＝Cesium の互換の口の模型・楕円体高で置く物・2026-10-27）。既定 true＝地面に乗せて altitude 分浮かす */
	lift?: boolean;
	/** 置き方の取っ手を出す。"auto"＝錨で置いた模型（CESIUM_RTC・ECEF 入りでない）だけ＝ドロップの既定 */
	gizmo?: boolean | "auto";
	/** 真俯瞰（pitch 0）でも描く（既定 false＝建物と同じく傾けた時だけ・Cesium の互換の口の Primitive は真上からも見える） */
	keep2d?: boolean;
	/** 姿勢を丸ごと（ModelTransform.rot＝ENU での回転 3x3・列優先）＝heading より勝つ */
	rot?: number[] | null;
	/** "globe"＝setMeshLighting（Cesium の照明）があっても globe の固定光で描く（Cesium の entity geometry＝Phong の見た目・@ortho-earth/cesium の primitives が使う） */
	lighting?: "globe" | "phong";
}
/** worker の stats（公開の ModelHandle.stats＋地物の番号の数） */
type ModelStats = NonNullable<ModelHandle["stats"]> & { features?: { primitives: number; texture: number; tables: number } };
/** 模型の束（node＝アニメするノード・xfA＝アニメの剛体変換・xf＝renderer に渡した合成（アニメ×置き方）・pos 以下＝当たりの写し（W7）） */
interface ModelBatch { node: number; origin: number[]; xfOn: boolean; xf: Float32Array | null; xfA: Float32Array | null; pos?: Float32Array; idx?: Uint32Array; features?: MeshFeatures | null; col0?: Uint8Array | null; skin?: SkinSeg[] | null; nV: number }   // skin＝スキンされた区間（2026-10-28）＝時計のたびに頂点を焼き直す・nV＝頂点数
/** 置いた模型（slot ごとに 1 体） */
interface ModelItem {
	slot: string; name: string; stats: ModelStats; src: string; animation: AnimationState | null; rig: GltfRig | null; place: GltfPlace | null;
	batches: ModelBatch[]; pickable: boolean; states: Map<number, Record<string, unknown>>;
	/** 地形へ持ち上げない（load の lift:false＝絶対高）＝当たりも持ち上げずに判定 */
	noLift: boolean;
	/** 焼いた時の置き方（at＝錨・CESIUM_RTC/ECEF の模型は bbox の中心・bbox＝焼いた時の外接矩形） */
	base: { at: LonLat; heading: number; scale: number; bbox: Bbox };
	/** 今の置き方 */
	now: { at: LonLat; heading: number; scale: number; altitude: number; rot?: number[] | null };
	/** 世界座標の剛体変換（base → now・恒等なら null）と、束ごとの xt（原点相対の平行移動＝pick が原点を動かす分） */
	xfM: WorldXf | null;
	animRaf: number; animLast: number | null;
	handle: ModelHandle; gizmo: Gizmo | null; gizmoAuto: boolean;
	tfListeners: Set<(t: ModelTransform, model: ModelHandle) => void>;
}
/** worker（model 役）の答え */
interface LoadReply { stats: ModelStats; rig?: GltfRig | null; place?: GltfPlace | null; batches: Array<TileBatch & { node?: number; skin?: SkinSeg[] | null }>; mask?: { bbox: number[]; n: number } | null }
interface ExtrudeReply { stats: ExtrudeStats; batches: Array<{ mesh: TileBatch["mesh"] }>; mask?: { bbox: number[]; n: number } | null }
/** createModel の戻り（公開の ModelHandle＋押し出し・読み込み） */
export interface ModelGadget extends ModelHandle {
	/** 置いてある模型（置いた順） */
	readonly models: ModelHandle[];
	/** slot の模型（無ければ null） */
	get(slot?: string): ModelHandle | null;
	/** 押し出しの stats（"default" のスロット・無ければ最後のスロット） */
	readonly extruded: ExtrudeStats | null;
	readonly extrudedFeatures: Array<ExtrudeUsed & { slot: string }>;
	readonly extrudeSets: Array<{ slot: string; used: ExtrudeUsed[]; mode: ExtrudeMode; lift: number }>;
	readonly extrudeSlots: string[];
	clearExtrude(slot?: string | null): void;
	extrude(src: ExtrudeSrc, opts?: ModelExtrudeOptions): Promise<ExtrudeStats | null>;
	load(src: File | string, opts?: ModelLoadOptions): Promise<ModelHandle>;
	/** 読み込んである模型の三角形の束（map.sampleHeight） */
	meshItems(): MeshItemRef[];
}
/** createModel の deps（globe.js の modelCtlGet が渡す） */
export interface ModelEnv {
	setMesh(name: string, data: MeshSetData | null): void;
	/** バッチの剛体変換（glTF の rigid アニメ・W4）＝Float32Array(12)｜null */
	setMeshXf?: ((name: string, xf: Float32Array | null) => void) | null;
	/** feature state の色（W7）＝頂点色の列（RGBA8） */
	setMeshCol?: ((name: string, data: Uint8Array) => void) | null;
	/** スキン（2026-10-28）＝焼き直した頂点（原点相対の pos と量子化法線）。無ければスキンのアニメは動かない（静止姿勢のまま） */
	setMeshPos?: ((name: string, data: { pos: Float32Array; nrm: Int8Array }) => void) | null;
	/** 模型の色（Cesium の Model.color）＝[r,g,b,a, blend]｜null（renderer の meshTint） */
	setMeshTint?: ((name: string, tint: number[] | null) => void) | null;
	/** 模型の輪郭線＝[r,g,b,a, 太さ device px]｜null（renderer の meshSil） */
	setMeshSil?: ((name: string, sil: number[] | null) => void) | null;
	/** 模型ごとの環境光（Cesium の照明の SH9・27 値）｜null（renderer の meshEnv） */
	setMeshEnv?: ((name: string, sh: number[] | null) => void) | null;
	/** 利用者のシェーダの名（map.setCustomShader）｜null（renderer の meshCustom） */
	setMeshCustom?: ((name: string, id: string | null) => void) | null;
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
// ── 置き方の算術（2026-10-18）─────────────────────────────────────────────────
// 世界座標（β単位球・lonlatTo3D と同じ軸＝y が北極）の ENU 基底。E＝経度方向・U＝動径・N＝E×U（右手系・lon=0,lat=0 で (0,1,0)）
const m3v = (L: ArrayLike<number>, v: ArrayLike<number>) => [L[0]*v[0] + L[3]*v[1] + L[6]*v[2], L[1]*v[0] + L[4]*v[1] + L[7]*v[2], L[2]*v[0] + L[5]*v[1] + L[8]*v[2]];   // 列優先 3x3 × ベクトル
const m3mulF = (a: ArrayLike<number>, b: ArrayLike<number>) => { const o = new Float64Array(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c*3+r] = a[r]*b[c*3] + a[3+r]*b[c*3+1] + a[6+r]*b[c*3+2]; return o; };
function enuBasis(lon: number, lat: number): { P: number[]; E: number[]; N: number[]; U: number[] } {
	const P = lonlatTo3D(lon, lat), l = lon * Math.PI / 180;
	const U = P, E = [-Math.sin(l), 0, Math.cos(l)];
	const N = [E[1]*U[2] - E[2]*U[1], E[2]*U[0] - E[0]*U[2], E[0]*U[1] - E[1]*U[0]];
	return { P, E, N, U };
}
/** base（焼いた置き方）→ now の世界座標の剛体変換（倍率込み）。恒等なら null。
 *  v' = C1 + alt·U1 + k·Q·(v − C0)、Q＝[E1 N1 U1]·Rh(Δheading)·[E0 N0 U0]ᵀ、k＝scale1/scale0。heading は北から時計回り（ENU 内で e'=c·e+s·n・n'=−s·e+c·n） */
export function modelWorldXf(base: { at: LonLat; heading: number; scale: number }, now: { at: LonLat; heading: number; scale: number; altitude: number; rot?: ArrayLike<number> | null }): WorldXf | null {
	const same = (a: number, b: number) => Math.abs(a - b) < 1e-12;
	const rot = now.rot && now.rot.length >= 9 ? now.rot : null;
	if (!rot && same(base.at[0], now.at[0]) && same(base.at[1], now.at[1]) && same(base.heading, now.heading) && same(base.scale, now.scale) && same(0, now.altitude)) return null;
	const b0 = enuBasis(base.at[0], base.at[1]), b1 = enuBasis(now.at[0], now.at[1]);
	const B0 = Float64Array.of(...b0.E, ...b0.N, ...b0.U), B1 = Float64Array.of(...b1.E, ...b1.N, ...b1.U);   // 列＝E・N・U
	const B0t = Float64Array.of(B0[0], B0[3], B0[6], B0[1], B0[4], B0[7], B0[2], B0[5], B0[8]);
	const ps = (now.heading - base.heading) * Math.PI / 180, c = Math.cos(ps), s = Math.sin(ps);
	let Rh = Float64Array.of(c, -s, 0, s, c, 0, 0, 0, 1);   // meshdecode と同じ並び（列優先）
	if (rot) {   // 姿勢を丸ごと（pitch・roll も）：rot·Rh(base.heading)ᵀ＝焼いた姿勢（heading だけ）を戻してから回す
		const b = base.heading * Math.PI / 180, cb = Math.cos(b), sb = Math.sin(b);
		Rh = m3mulF(Float64Array.from(rot as ArrayLike<number>), Float64Array.of(cb, sb, 0, -sb, cb, 0, 0, 0, 1));
	}
	const k = (now.scale || 1) / (base.scale || 1);
	const L = m3mulF(B1, m3mulF(Rh, B0t)); for (let i = 0; i < 9; i++) L[i] *= k;
	const ar = (now.altitude || 0) / worldRadiusM(), up = ellNormal3D(now.at[0], now.at[1]);   // 高さは測地法線の向き（β空間の像）＝楕円体で動径に足すと高度×0.3% ほど赤道側へずれる（5000m で約 17m・Cesium の互換の口の門で判明 2026-10-25）。球では動径と同じ
	const C1 = [b1.P[0] + ar * up[0], b1.P[1] + ar * up[1], b1.P[2] + ar * up[2]], LC0 = m3v(L, b0.P);
	return { L, t: [C1[0] - LC0[0], C1[1] - LC0[1], C1[2] - LC0[2]] };
}
/** 外接矩形（度）を base → now に写す（錨の周りで回して倍率を掛け、新しい錨へ） */
export function transformBbox(bbox: Bbox, base: { at: LonLat; heading: number; scale: number }, now: { at: LonLat; heading: number; scale: number; rot?: ArrayLike<number> | null }): Bbox {
	const mLon0 = 111320 * Math.cos(base.at[1] * Math.PI / 180), mLon1 = 111320 * Math.cos(now.at[1] * Math.PI / 180), mLat = 110950;
	if (now.rot && now.rot.length >= 9) {   // pitch・roll で倒すと足元の矩形の外へ出る：錨から一番遠い角までの円（高さは知らない＝横幅の倍まで見込む）
		const k = (now.scale || 1) / (base.scale || 1);
		let r = 0;
		for (const [x, y] of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]) r = Math.max(r, Math.hypot((x - base.at[0]) * mLon0, (y - base.at[1]) * mLat));
		r *= 2 * k;
		return [now.at[0] - r / (mLon1 || 1e-9), now.at[1] - r / mLat, now.at[0] + r / (mLon1 || 1e-9), now.at[1] + r / mLat];
	}
	const ps = (now.heading - base.heading) * Math.PI / 180, c = Math.cos(ps), s = Math.sin(ps), k = (now.scale || 1) / (base.scale || 1);
	const out: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
	for (const [x, y] of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]) {
		const e = (x - base.at[0]) * mLon0, n = (y - base.at[1]) * mLat;
		const e2 = (c * e + s * n) * k, n2 = (-s * e + c * n) * k;
		const lon = now.at[0] + e2 / (mLon1 || 1e-9), lat = now.at[1] + n2 / mLat;
		if (lon < out[0]) out[0] = lon; if (lon > out[2]) out[2] = lon; if (lat < out[1]) out[1] = lat; if (lat > out[3]) out[3] = lat;
	}
	return out;
}
/** 束の剛体変換の合成：置き方 m（Float32Array(12)・原点相対）∘ アニメ a（同）。ap → L_m·(L_a·ap + xt_a) + xt_m */
export function composeXf(m: Float32Array | null, a: Float32Array | null): Float32Array | null {
	if (!m) return a; if (!a) return m;
	const o = new Float32Array(12);
	for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c*3+r] = m[r]*a[c*3] + m[3+r]*a[c*3+1] + m[6+r]*a[c*3+2];
	for (let r = 0; r < 3; r++) o[9+r] = m[r]*a[9] + m[3+r]*a[10] + m[6+r]*a[11] + m[9+r];
	return o;
}

export function createModel(map: GlobeMap, { setMesh, setMeshXf = null, setMeshCol = null, setMeshPos = null, setMeshTint = null, setMeshEnv = null, setMeshSil = null, setMeshCustom = null, pickEnv = null, fit, center, ell = false, signal }: ModelEnv = {} as ModelEnv) {   // setMeshCol・pickEnv＝当たりと feature state の色（W7）
	const t = tr();
	let seq = 0;   // seq＝模型・押し出しの名前の連番
	const models = new Map<string, ModelItem>();   // slot → 模型（置いた順）
	let cur: ModelItem | null = null;   // 最後に置いた模型（ガジェットの stats/bbox/name はこれ）
	const live = (it: ModelItem | null | undefined): it is ModelItem => !!it && models.get(it.slot) === it;   // 置き換え・clear された手綱は死ぬ
	const animListeners = new Set<(state: AnimationState | null, model: ModelHandle) => void>();   // setAnimation の合図（F4）
	// rigid アニメの再生（W4）：rig（ノードの親子・静止 TRS・channel）・place（ローカル→ECEF→世界座標の写し）・batches（束ごとのノード番号と原点）から、
	// アニメの時刻でノードの world 行列を標本化し、束ごとの剛体変換（L 3x3＋原点相対の平行移動）を renderer の "meshXf" へ。頂点は焼き直さない。
	// 時計＝map.getNow（setNow で止められる＝決定論の撮影）。playing の間は rAF で進め、loop 無しは端で止まる（playing=false）。skin／morph は読まない（spec のまま）
	// 置き方（2026-10-18）＝世界座標の剛体変換 xfM を束ごとに原点相対へ直し（batchXf）、アニメの姿勢と合成（composeXf）して同じ "meshXf" へ。
	const nowMs = () => map?.getNow?.() ?? performance.now();
	const poseAt = (it: ModelItem, time: number) => {   // → { xs: 束ごとの Float32Array(12)|null（アニメが無い／動かない束は null）, pose }
		const a = it.animation; if (!it.rig || !it.place || !a || a.index == null) return null;
		const pose = samplePose(it.rig, a.index, wrapTime(time, a.duration, a.loop)); if (!pose) return null;
		return { xs: it.batches.map(b => b.node >= 0 ? batchXf(worldXf(pose, b.node, it.place!), b.origin) : null), pose };
	};
	// skin（2026-10-28）＝スキンされた束は頂点を焼き直す（gltf-anim.skinBatch）＝原点相対の pos と法線を renderer の "meshPos" へ。当たりの写し（pos）も同じ姿勢に
	const pushSkin = (it: ModelItem, pose: GltfPose) => {
		if (!setMeshPos) return;
		it.batches.forEach((b, k) => {
			if (!b.skin?.length) return;
			const r = skinBatch(b.skin, pose, it.rig?.skins, it.place, b.origin, b.nV); if (!r) return;
			if (b.pos) b.pos = r.pos.slice();
			setMeshPos(`${it.name}#${k}`, r);
		});
	};
	const pushXf = (it: ModelItem) => {   // 束ごとに（置き方 ∘ アニメ）を renderer へ（変わった束だけ・恒等は null で戻す）
		if (!setMeshXf) return;
		it.batches.forEach((b, k) => { const xf = composeXf(batchXf(it.xfM, b.origin), b.xfA); b.xf = xf; if (xf || b.xfOn) { setMeshXf(`${it.name}#${k}`, xf); b.xfOn = !!xf; } });   // b.xf＝当たり（W7）も同じ姿勢で
	};
	const applyPose = (it: ModelItem, time: number) => { const p = poseAt(it, time); it.batches.forEach((b, k) => { b.xfA = p ? p.xs[k] : null; }); pushXf(it); if (p) pushSkin(it, p.pose); };
	const stopLoop = (it: ModelItem) => { if (it.animRaf) cancelAnimationFrame(it.animRaf); it.animRaf = 0; it.animLast = null; };
	const tick = (it: ModelItem) => {
		it.animRaf = 0; const a = it.animation; if (!live(it) || !a || !a.playing) { it.animLast = null; return; }
		const t = nowMs(), dt = it.animLast == null ? 0 : Math.min(0.25, Math.max(0, (t - it.animLast) / 1000)); it.animLast = t;
		let time = a.time + dt * a.speed, playing = true;
		if (!a.loop && a.duration > 0 && (time >= a.duration || time <= 0)) { time = time <= 0 ? 0 : a.duration; playing = false; }   // 端で止まる
		else time = wrapTime(time, a.duration, a.loop);
		it.animation = { ...a, time, playing };
		applyPose(it, time);
		if (playing) it.animRaf = requestAnimationFrame(() => tick(it)); else it.animLast = null;
	};
	const repaintStates = (it: ModelItem) => {   // feature state の色（W7）＝束ごとに元の頂点色から差し替えた列を renderer の "meshCol" へ（state の無い束も一度戻す）
		if (!setMeshCol) return;
		const colorOf = (id: number) => { const c = it.states.get(id)?.color; const v = c ? rgbaOf(String(c)) : null; return v ? v.slice(0, 3) : null; };
		it.batches.forEach((b, k) => { if (!b.col0 || !b.features) return; setMeshCol(`${it.name}#${k}`, tintColors(b.col0, b.features.ids, colorOf)); });
	};
	const syncAnim = (it: ModelItem) => { const a = it.animation; stopLoop(it); applyPose(it, a ? a.time : 0); if (a?.playing && it.rig && typeof requestAnimationFrame === "function") it.animRaf = requestAnimationFrame(() => tick(it)); };
	const pool = workerPool(() => new Worker(new URL("../worker.ts", import.meta.url), { type: "module", name: "model" }), { tag: "model" });   // 入口 1 本（worker.js）＝役割は name（model-worker.js）・最初の rpc で作る
	const rpc = pool.rpc;
	const removeItem = (it: ModelItem) => {
		stopLoop(it); it.gizmo?.destroy(); it.gizmo = null;
		setMesh(it.name, null);
		if (models.get(it.slot) === it) models.delete(it.slot);
		if (cur === it) cur = [...models.values()].pop() || null;
	};
	const clear = (slot?: string | null) => { for (const it of [...models.values()]) if (slot == null || it.slot === slot) removeItem(it); };
	// ── 置き方（2026-10-18）──────────────────────────────────────────────────────
	const transformOf = (it: ModelItem): ModelTransform => ({ at: [it.now.at[0], it.now.at[1]], heading: it.now.heading, scale: it.now.scale, altitude: it.now.altitude, ...(it.now.rot ? { rot: [...it.now.rot] } : {}) });
	const setTransform = (it: ModelItem, tf: Partial<ModelTransform>) => {
		if (!live(it)) return;
		const n = it.now;
		if (tf.at) { const lon = +tf.at[0], lat = +tf.at[1]; if (Number.isFinite(lon) && Number.isFinite(lat)) n.at = [((lon + 180) % 360 + 360) % 360 - 180, Math.max(-89.9, Math.min(89.9, lat))]; }
		if (tf.heading != null && Number.isFinite(+tf.heading)) n.heading = ((+tf.heading % 360) + 360) % 360;
		if (tf.scale != null && Number.isFinite(+tf.scale) && +tf.scale > 0) n.scale = Math.max(1e-4, Math.min(1e5, +tf.scale));
		if (tf.altitude != null && Number.isFinite(+tf.altitude)) n.altitude = +tf.altitude;
		if (tf.rot === null) n.rot = null;
		else if (tf.rot && tf.rot.length >= 9 && [...tf.rot].slice(0, 9).every(Number.isFinite)) n.rot = [...tf.rot].slice(0, 9).map(Number);
		it.xfM = modelWorldXf(it.base, n);
		it.stats = { ...it.stats, bbox: transformBbox(it.base.bbox, it.base, n) };
		pushXf(it);
		it.gizmo?.refresh();
		const snap = transformOf(it);
		for (const f of it.tfListeners) { try { f(snap, it.handle); } catch (e) { console.warn("[model] transform listener", e); } }
	};
	const gizmoOf = (it: ModelItem, on: boolean) => {
		if (!on) { it.gizmo?.destroy(); it.gizmo = null; return; }
		if (it.gizmo || !live(it) || typeof document === "undefined") return;
		it.gizmo = createGizmo(map, it.handle, { onDone: () => { it.gizmo?.destroy(); it.gizmo = null; } });
	};
	// 模型をクリック→（✓ で畳んだ）取っ手を出し直す（gizmo:"auto" の模型だけ）。地図を動かした指のクリックは無視（4px 以上動いたら）
	let clickBound = false, downAt: [number, number] | null = null;
	const bindClick = () => {
		if (clickBound || typeof document === "undefined" || !map?.mapEl) return; clickBound = true;
		map.mapEl.addEventListener("pointerdown", e => { downAt = [e.clientX, e.clientY]; }, { passive: true });
		map.mapEl.addEventListener("click", e => {
			if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
			if (![...models.values()].some(it => it.gizmoAuto && !it.gizmo)) return;
			const r = map.mapEl.getBoundingClientRect(), h = pickAll(e.clientX - r.left, e.clientY - r.top);
			if (h && h.it.gizmoAuto && !h.it.gizmo) gizmoOf(h.it, true);
		});
	};
	// ── 当たり（第 3 波 W7）＝全部の模型から一番手前 ────────────────────────────────
	// pick(x, y)＝画面の点（CSS px）に一番手前の三角形 → { featureId, properties, table, batch, distance, lngLat } | null。
	// featureId＝EXT_mesh_features（組は load の featureIdSet・attribute／implicit）か _BATCHID の番号（無ければ null＝模型そのものに当たった）
	// 動かした模型（xfM）＝原点を動かした先（O'＝O＋xt_m）に置き直し、xf からその分を抜く＝地形への持ち上げも動かした先の地面で
	const pickItems = (it: ModelItem, env: MeshPickEnv) => it.batches.map(b => {
		if (!b.pos) return null;
		const xm = batchXf(it.xfM, b.origin);
		const origin = xm ? [b.origin[0] + xm[9], b.origin[1] + xm[10], b.origin[2] + xm[11]] : b.origin;
		const xf = xm && b.xf ? Float32Array.of(b.xf[0], b.xf[1], b.xf[2], b.xf[3], b.xf[4], b.xf[5], b.xf[6], b.xf[7], b.xf[8], b.xf[9] - xm[9], b.xf[10] - xm[10], b.xf[11] - xm[11]) : b.xf;
		return { pos: b.pos, idx: b.idx!, origin, xf, lift: it.noLift ? 0 : env.lift(origin), features: b.features };
	});
	const pickOne = (it: ModelItem, x: number, y: number, env: MeshPickEnv) => {
		if (!it.pickable) return null;
		const h = pickMeshes(pickItems(it, env), env.view, x, y); if (!h) return null;
		const b = it.batches[h.item], f = b.features, tIdx = f ? (f.tblV ? f.tblV[h.vertex] : f.table) : null, table = tIdx != null && tIdx >= 0 ? f!.tables?.[tIdx] : null;
		return { featureId: h.featureId, properties: h.featureId != null ? featureProperties(table, h.featureId) : {}, table: table ? { index: tIdx!, name: table.name, class: table.class } : null,
			batch: h.item, distance: h.w, lngLat: lngLatOfWorld(h.world), state: h.featureId != null ? { ...(it.states.get(h.featureId) || {}) } : {} };
	};
	const envNow = () => { if (!pickEnv) return null; const env = pickEnv(); return env && env.show3d ? env : null; };   // 真俯瞰＝模型は描かれない（renderer の show3d）＝当てない
	const pickAll = (x: number, y: number) => {
		const env = envNow(); if (!env) return null;
		let best: { it: ModelItem; hit: NonNullable<ReturnType<typeof pickOne>> } | null = null;
		for (const it of models.values()) { const h = pickOne(it, x, y, env); if (h && (!best || h.distance < best.hit.distance)) best = { it, hit: h }; }
		return best;
	};
	// ── 模型の手綱（slot ごと）────────────────────────────────────────────────────
	const makeHandle = (it: ModelItem): ModelHandle => {
		const h: ModelHandle = {
			get slot() { return it.slot; },
			get stats() { return live(it) ? it.stats : null; },
			get bbox() { return live(it) ? it.stats.bbox : null; },
			get name() { return live(it) ? it.name : null; },
			// glTF の口（F4・2026-10-12・src/gltf-meta.js）：animations＝模型に入っているアニメの見出し（name/duration/paths）・setAnimation(spec)＝再生の spec を受けて保つ
			get animations() { return (it.stats.gltf?.animations || []).map(a => ({ ...a, paths: [...a.paths] })); },
			get gltf() { return it.stats.gltf ? { ...it.stats.gltf, animations: h.animations } : null; },
			setAnimation(spec) { if (!live(it)) throw new Error("setAnimation: no model loaded"); it.animation = normAnimation(spec, it.stats.gltf?.animations || []); syncAnim(it); for (const f of animListeners) { try { f(it.animation, h); } catch (e) { console.warn("[model] animation listener", e); } } return h; },
			getAnimation() { return it.animation ? { ...it.animation } : null; },
			setColor(c) {   // Cesium の ModelColorStage：blend＝0 HIGHLIGHT・1 REPLACE・MIX＝amount（0〜1）
				if (!live(it) || !setMeshTint) return h;
				const t = c && Array.isArray(c.color) ? [c.color[0], c.color[1], c.color[2], c.color[3] ?? 1, c.blend === "replace" ? 1 : c.blend === "mix" ? Math.min(1, Math.max(0, c.amount ?? 0.5)) : 0] : null;
				it.batches.forEach((_, k) => setMeshTint(`${it.name}#${k}`, t));
				return h;
			},
			setSilhouette(s) {   // Cesium の Model.silhouetteColor／silhouetteSize＝size は CSS px（Cesium は czm_pixelRatio を掛ける）
				if (!live(it) || !setMeshSil) return h;
				const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
				const v = s && Array.isArray(s.color) && s.size > 0 && (s.color[3] ?? 1) > 0 ? [s.color[0], s.color[1], s.color[2], s.color[3] ?? 1, s.size * dpr] : null;
				it.batches.forEach((_, k) => setMeshSil(`${it.name}#${k}`, v));
				return h;
			},
			setEnvironment(sh) {   // Cesium の照明（setMeshLighting）の環境光をこの模型だけ替える（Cesium は模型の位置で環境を作る）
				if (!live(it) || !setMeshEnv) return h;
				const v = sh && sh.length >= 27 ? Array.from(sh).slice(0, 27) : null;
				it.batches.forEach((_, k) => setMeshEnv(`${it.name}#${k}`, v));
				return h;
			},
			setCustomShader(id) {   // 利用者のシェーダ（Cesium の Model.customShader）＝map.setCustomShader の名・null＝外す
				if (!live(it) || !setMeshCustom) return h;
				it.batches.forEach((_, k) => setMeshCustom(`${it.name}#${k}`, id ?? null));
				return h;
			},
			play(nameOrSpec) { return h.setAnimation(typeof nameOrSpec === "object" && nameOrSpec ? { ...nameOrSpec, playing: true } : { name: nameOrSpec ?? undefined, playing: true }); },
			stop() { if (it.animation) { it.animation = { ...it.animation, playing: false }; stopLoop(it); } return h; },
			// 再生の時刻での束ごとの剛体変換（検定・台本の口）：time 省略＝今の spec の時刻。[Float32Array(12)|null]（L 3x3 列優先＋原点相対の平行移動）｜null（アニメ無し）
			pose(time) { return poseAt(it, time ?? it.animation?.time ?? 0)?.xs ?? null; },
			get animating() { return !!it.animRaf; },
			onAnimation(f) { animListeners.add(f); return () => animListeners.delete(f); },   // plugin が再生を担う時の合図（spec が変わるたび）
			// 置き方（2026-10-18）
			getTransform() { return transformOf(it); },
			setTransform(tf) { setTransform(it, tf || {}); return h; },
			getLngLat() { return [it.now.at[0], it.now.at[1]]; },
			setLngLat(ll) { setTransform(it, { at: Array.isArray(ll) ? [ll[0], ll[1]] : [(ll.lng ?? ll.lon)!, ll.lat] }); return h; },
			getHeading() { return it.now.heading; }, setHeading(d) { setTransform(it, { heading: d }); return h; },
			getScale() { return it.now.scale; }, setScale(s) { setTransform(it, { scale: s }); return h; },
			getAltitude() { return it.now.altitude; }, setAltitude(m) { setTransform(it, { altitude: m }); return h; },
			onTransform(f) { it.tfListeners.add(f); return () => it.tfListeners.delete(f); },
			gizmo(on = true) { gizmoOf(it, on !== false); return h; },
			get gizmoOn() { return !!it.gizmo; },
			pick(x, y) { if (!live(it)) return null; const env = envNow(); return env ? pickOne(it, x, y, env) : null; },
			// 地物の一覧の見出し＝{ primitives, tables: [{ name, class, count, columns }] } | null
			get features() {
				if (!live(it)) return null;   // 外した（clear／置き換えた）手綱は pick と同じく null
				const fb = it.batches.find(b => b.features); if (!fb) return it.stats.features ? { ...it.stats.features, tables: [] } : null;
				return { ...(it.stats.features || {}) as NonNullable<ModelStats["features"]>, tables: (fb.features!.tables || []).map(T => ({ name: T.name, class: T.class, count: T.count, columns: Object.keys(T.columns) })) };
			},
			// feature state（MapLibre の setFeatureState と同じ置き場の考え方）＝{ color: CSS 色 } を描きに効かせる（頂点色を差し替え＝テクスチャに掛かる）。他の鍵は保つだけ
			setFeatureState(id, state) {
				if (!live(it) || id == null) return h;
				const prev = it.states.get(+id) || {}, next = state == null ? {} : { ...prev, ...state };
				if (Object.keys(next).length) it.states.set(+id, next); else it.states.delete(+id);
				repaintStates(it); return h;
			},
			getFeatureState(id) { return { ...(it.states.get(+id) || {}) }; },
			removeFeatureState(id) { if (!live(it)) return h; if (id == null) it.states.clear(); else it.states.delete(+id); repaintStates(it); return h; },
			toastLength() { return t("$1 triangles", it.stats.triangles); },
			clear() { if (live(it)) removeItem(it); },
			destroy() { h.clear(); },
		};
		return h;
	};
	// 押し出しの今＝slot → { name, stats, used }（模型とは別スロット＝GLB と並べて立てられる）。
	// slot＝層の名前（map.addLayer の fill-extrusion は層 id ごと＝複数並べられる・#34）。ガジェット直呼びは "default"＝従来どおり置き換え
	const exts = new Map<string, ExtSlot>();
	const clearExtrude = (slot?: string | null) => {
		for (const [k, e] of [...exts]) if (slot == null || k === slot) { setMesh(e.name, null); exts.delete(k); }
	};
	// ガジェット（ctl）＝最後に置いた模型の顔（stats/bbox/name/アニメ/feature state は cur へ）＋全部の模型の口（models・get・pick は一番手前・clear は全部）
	const curH = () => cur?.handle || null;
	const ctl: ModelGadget = {
		get slot() { return cur?.slot ?? "default"; },
		get models() { return [...models.values()].map(it => it.handle); },
		get(slot = "default") { return models.get(slot)?.handle || null; },
		get stats() { return cur?.stats || null; },
		get animations() { return curH()?.animations || []; },
		get gltf() { return curH()?.gltf || null; },
		setAnimation(spec) { if (!cur) throw new Error("setAnimation: no model loaded"); cur.handle.setAnimation(spec); return ctl; },
		getAnimation() { return curH()?.getAnimation() || null; },
		setColor(c) { curH()?.setColor(c); return ctl; },
		setEnvironment(sh) { curH()?.setEnvironment(sh); return ctl; },
		setSilhouette(s) { curH()?.setSilhouette(s); return ctl; },
		setCustomShader(id) { curH()?.setCustomShader(id); return ctl; },
		play(nameOrSpec) { return ctl.setAnimation(typeof nameOrSpec === "object" && nameOrSpec ? { ...nameOrSpec, playing: true } : { name: nameOrSpec ?? undefined, playing: true }); },
		stop() { curH()?.stop(); return ctl; },
		pose(time) { return curH()?.pose(time) ?? null; },
		get animating() { return !!cur?.animRaf; },
		onAnimation(f) { animListeners.add(f); return () => animListeners.delete(f); },
		getTransform() { return curH()?.getTransform() || { at: [0, 0], heading: 0, scale: 1, altitude: 0 }; },
		setTransform(tf) { curH()?.setTransform(tf); return ctl; },
		getLngLat() { return curH()?.getLngLat() || [0, 0]; }, setLngLat(ll) { curH()?.setLngLat(ll); return ctl; },
		getHeading() { return curH()?.getHeading() ?? 0; }, setHeading(d) { curH()?.setHeading(d); return ctl; },
		getScale() { return curH()?.getScale() ?? 1; }, setScale(s) { curH()?.setScale(s); return ctl; },
		getAltitude() { return curH()?.getAltitude() ?? 0; }, setAltitude(m) { curH()?.setAltitude(m); return ctl; },
		onTransform(f) { return curH()?.onTransform(f) || (() => {}); },
		gizmo(on = true) { curH()?.gizmo(on); return ctl; },
		get gizmoOn() { return !!cur?.gizmo; },
		get bbox() { return cur?.stats?.bbox || null; },
		get name() { return cur?.name || null; },
		clear() { clear(); },
		get extruded() { return exts.get("default")?.stats ?? [...exts.values()].pop()?.stats ?? null; },
		get extrudedFeatures() { return [...exts].flatMap(([slot, e]) => e.used.map(u => ({ ...u, slot }))); },   // [{ f: Feature, h, base, slot }]（新しいスロットが後ろ）
		// map.queryRenderedFeatures の押し出し層（立体の当たり）＝スロットごと [{ slot, used: [{ f, h, base }], mode: "plane"|"ground"|"drape", lift: 床の平面の高さ[m] }]（新しいスロットが後ろ）
		get extrudeSets() { return [...exts].map(([slot, e]) => ({ slot, used: e.used, mode: e.mode, lift: e.lift })); },
		get extrudeSlots() { return [...exts.keys()]; },
		clearExtrude,
		// 押し出し：src＝GeoJSON（Feature/FeatureCollection/features 配列）。opts＝{ height: 鍵名|数|fn, base, color: css|fn, scale, mask, fit }
		//   または MapLibre の層そのもの（{ type:"fill-extrusion", paint:{ "fill-extrusion-height": 式, … }, filter: 式 }）＝MapLibre と同じ意味で評価
		// 高さ無し（自動の鍵に当たらない）の面は立てない。戻り値＝stats（polygons/triangles/bbox）か、立つ面が無ければ null
		async extrude(src, { height, base, color, scale = 1, mask = "auto", bottom = null, fit: doFit = false, paint = null, filter = null, zoom = 16, type = null, slot = "default", metadata = null, layout = null, lighting = null } = {}) {   // bottom＝床の高さ[m]＝その高さの平面に浮かせる（全体の床・面ごとの base とは別）。"drape"＝地形に沿わせる。"ground"＝大きさに関わらず建物と同じ接地。無指定で MapLibre 形の層＝接地。それ以外の無指定＝広い面（対角の中央値 ≥ 500m＝下の buildingLike）は 2,000m の平面・建物らしい面は接地（地形に沿わせない＝山が突き抜けない・高さ＝値はその平面から測る）＝400m 角の箱でも 2,000m に立つ（t-extrude-size）   // mask="auto"＝建物らしい大きさ（面の中央値 < 500m）の時だけ足元の基図建物を伏せる
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
			r.batches.forEach((b, k) => setMesh(`${key}#${k}`, { ...b.mesh, noLift: mode === "plane", drape: mode === "drape", keep2d: true, castShadow: buildingLike, ward: key, tex: null, ...(lighting === "phong" && { csLit: "phong" }), alphaMode: blend ? "BLEND" : "OPAQUE", alphaCutoff: 0.5, maskBbox: r.mask?.bbox || null, maskN: r.mask?.n || 0 }));
			console.info(`[extrude] ${r.stats.polygons} polygons, ${r.stats.triangles} tris`, r.stats.bbox);
			if (doFit && fit) fit(r.stats.bbox);
			return r.stats;
		},
		destroy() { clear(); clearExtrude(); pool.destroy(); },
		// src＝File | URL 文字列。戻り値＝その模型の手綱（ModelHandle）。失敗は throw（dropFile がトーストへ出す）
		// ground="each"＝連結成分ごとに接地（街の一区画を切り出した模型＝高台の建物が浮かない）。既定 "batch"＝一体で接地
		// mask=true＝模型の足元の基図建物を伏せる（街の一区画を切り出した模型＝白い箱と二重に描いて壁が明滅するのを断つ）
		// slot＝置き場（既定 "default"＝置き換え・別名＝並ぶ）。altitude＝地面からの高さ（m）。gizmo＝置き方の取っ手（true／"auto"＝錨で置いた時だけ）
		async load(src, { at = null, heading = 0, scale = 1, name = null, fit: doFit = true, textures = true, ground = "batch", mask = false, pickable = true, featureIdSet = 0, customShader = null, mc = false, slot = "default", altitude = 0, lift = true, gizmo = false, keep2d = false, lighting = undefined, rot = null } = {}) {   // pickable＝当たりの写し（頂点・index）を main に持つ（W7・false＝持たない＝pick は null）   // textures=false＝形だけ（画像を読まない）
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
			const r = await rpc<LoadReply>({ ab, at: anchor, heading, scale, baseUri, ell, textures, ground, mask, featureIdSet, mc: mc || !!customShader, transcoders: transcodersOf(map) }, [ab]).catch(err => {
				if (err.message === "no-triangles") throw new Error(t("3D model has no triangles"));
				throw err;
			});
			clear(slot);
			const key = `model/${++seq}`;
			const bb = r.stats.bbox, at0: LonLat = r.stats.mode === "anchor" && anchor ? [anchor[0], anchor[1]] : [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];   // 錨で置いた＝錨・埋め込み（rtc/ecef）＝外接矩形の中心を錨に見立てる
			const it: ModelItem = { slot, name: key, stats: r.stats, src: name, animation: null, rig: r.rig || null, place: r.place || null, batches: r.batches.map(b => ({ node: b.node ?? -1, origin: b.mesh.origin ? [...b.mesh.origin] : [0, 0, 0], skin: b.skin || null, nV: b.mesh.pos.length / 3, xfOn: false, xf: null, xfA: null,
				...(pickable ? { pos: b.mesh.pos.slice(), idx: b.mesh.idx.slice(), features: b.features || null, col0: b.features && b.mesh.col ? b.mesh.col.slice() : null } : {}) })), pickable, states: new Map(),   // 当たりの写し（W7）＝setMesh が transfer する前に取る   // rig/place/batches＝rigid アニメ（W4）
				base: { at: at0, heading: r.stats.mode === "anchor" ? heading : 0, scale: r.stats.mode === "anchor" ? scale : 1, bbox: [bb[0], bb[1], bb[2], bb[3]] },
				now: { at: [at0[0], at0[1]], heading: r.stats.mode === "anchor" ? heading : 0, scale: r.stats.mode === "anchor" ? scale : 1, altitude: 0 },
				xfM: null, animRaf: 0, animLast: null, handle: null as unknown as ModelHandle, gizmo: null, gizmoAuto: gizmo === "auto" || gizmo === true, tfListeners: new Set(), noLift: lift === false };
			it.handle = makeHandle(it);
			models.set(slot, it); cur = it;
			r.batches.forEach((b, k) => setMesh(`${key}#${k}`, { ...b.mesh, ward: key, ...(keep2d && { keep2d: true }), ...(lift === false && { noLift: true }), tex: b.tex, texMR: b.texMR, texN: b.texN, texOcc: b.texOcc, texEm: b.texEm, pbr: b.pbr, ...((lighting === "phong" || lighting === "globe") && { colSrgb: true }), /* the @ortho-earth/cesium geometry writes its style colours (sRGB) into COLOR_0 = WebGPU decodes them like an extrusion */ csLit: lighting === "phong" ? "phong" : lighting === "globe" ? "off" : (b.pbr as { unlit?: boolean } | null)?.unlit ? "unlit" : "pbr", alphaMode: b.alphaMode, alphaCutoff: b.alphaCutoff, maskBbox: r.mask?.bbox || null, maskN: r.mask?.n || 0, mcJ: b.mcJ ?? null, meta: b.meta ?? null, custom: customShader ?? null }));   // pbr＋材質 4 枚＝#46 段 2・csLit＝Cesium の照明の掛け方（pbr／unlit＝素の色／off＝固定光）   // ward＝自分の名前（解放は名前#* の一括・マスク不参加）。バッチ＝マテリアル
			console.info(`[model] ${name}: ${r.stats.triangles} tris, ${r.stats.vertices} verts, ${r.stats.instances} instances, ${r.stats.materials} materials (${r.stats.textures} textured, ${r.stats.blended} blended), placed by ${r.stats.mode}`, r.stats.bbox);
			if (altitude || (rot && r.stats.mode === "anchor")) setTransform(it, { altitude, ...(rot && r.stats.mode === "anchor" ? { rot } : {}) });   // rot＝姿勢を丸ごと（pitch・roll も）
			if (gizmo === true || (gizmo === "auto" && r.stats.mode === "anchor")) gizmoOf(it, true);
			if (it.gizmoAuto) bindClick();
			if (doFit && fit) fit(it.stats.bbox);
			return it.handle;
		},
		pick(x, y) { return pickAll(x, y)?.hit || null; },
		// 読み込んである模型の三角形の束（map.sampleHeight・2026-10-25）。動かした模型は動かした先（pickItems と同じ）・地形へは "drape"（lift は呼ぶ側が入れる）
		meshItems() {
			const out: MeshItemRef[] = [];
			for (const it of models.values()) { if (!live(it) || !it.pickable) continue; for (const p of pickItems(it, { lift: () => 0 } as unknown as MeshPickEnv)) if (p) out.push({ id: it.slot, mode: "drape", item: p }); }
			return out;
		},
		get features() { return curH()?.features || null; },
		setFeatureState(id, state) { curH()?.setFeatureState(id, state); return ctl; },
		getFeatureState(id) { return curH()?.getFeatureState(id) || {}; },
		removeFeatureState(id) { curH()?.removeFeatureState(id); return ctl; },
		toastLength() { return cur ? t("$1 triangles", cur.stats.triangles) : "?"; },
	};
	signal?.addEventListener("abort", () => ctl.destroy(), { once: true });
	return ctl;
}
