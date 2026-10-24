// ガジェット：任意の 3D Tiles を画面上の誤差で流す（#41・2026-09-23・Cesium の 3D Tiles ストリーミング相当）。
//   map.gadget.tiles3d(url, opts) / map.add3DTiles(url, opts) / ?tiles3d=<tileset.json の URL>。
//   選び方＝画面上の誤差（SSE）：タイルの geometricError を今の距離で画面の px に直し、maxSSE（既定 16px）を超えるなら子へ降りる。
//   refine REPLACE＝子が揃うまで親を出したまま（穴を開けない）・ADD＝親も子も描く。外部 tileset（content が .json）はその時に読む。
//   中身（b3dm・i3dm・pnts・cmpt・glb/glTF）は worker（model 役・tiles3d-decode.js）が取りに行って解く＝main は URL と変換行列だけ渡す。
//   三角形＝建物メッシュ（PLATEAU・模型と同じ GPU 経路・noLift＝絶対高さ）・点＝点のオーバーレイ（points-gl.js・原点相対）。
//   GPU に上げたタイルは表示を切り替えるだけで残し（meshVis）、予算（既定 512MB・LOW_MEM 160MB）を超えたら使っていない物から捨てる。
// 高さ＝既定は tileset の高さのまま（絶対高さ・写真測量の街並みや点群）。地形とずれる時は heightOffset[m] で合わせるか、
//   建物の tileset なら ground:"terrain"＝1 棟ずつ最低点で地面に接地（PLATEAU の経路と同じ）。
// implicit tiling（3D Tiles 1.1 の subtree・1.0 の 3DTILES_implicit_tiling・2026-10-16）＝implicit の根の下は subtree のビット列から子を作る（tiles3d-implicit.ts）。
//   subtree は main で読む（小さく、ビット列は選びに要る）。子 subtree を読んでいる間は子が「まだ分からない」＝REPLACE の親を出したまま。
//   長く使っていない implicit の部分木は刈る（中身が上がっている子孫がいない時だけ）。
// 複数 content（3D Tiles 1.1 の contents・1.0 の 3DTILES_multiple_contents・2026-10-16）＝2 個目からはタイルに付く「content の節点」（extra）。
//   木は歩かず、タイルと一緒に読み・出し・伏せる（全部が読めた／失敗してから出す＝REPLACE の親と重ねない）。implicit は content ごとのテンプレートと availability。
//   外部 tileset（.json）は content が 1 個の時だけ（複数の中の .json は警告して読まない）。
// metadata（3D Tiles 1.1・2026-10-16）＝schema（直書き／schemaUri）で tileset・groups・tile・content の metadata を読み（tiles3d-metadata.ts）、pick の答えに出す。
//   implicit は subtree の property table の行（available の中の順位）。意味 TILE_BOUNDING_*／TILE_*_HEIGHT／TILE_GEOMETRIC_ERROR で境界と誤差を上書き。
// スタイル（2026-10-16）＝地物ごとの color・show を MapLibre の式で（tiles3d-style.ts）・Cesium の 3D Tiles Styling は訳して（tiles3d-cesium-style.ts）。属性＝tileset ＜ group ＜ tile ＜ content の metadata ＜ 地物の属性。
//   頂点色の書き換え（feature state と同じ meshCol・state の color が勝つ）。show:false＝α 0（OPAQUE の束は MASK で上げ直す）。点群（pnts）には効かない。
// 楕円体表示（#43）：選び（worldOf）は β 単位球＋測地法線のリフト・中身は worker へ ell を渡して建物メッシュと同じ式（meshdecode の geoWorld）。
// I3S（#48）も同じ選び・同じ GPU 経路（addI3S）＝節点の木と中身は worker が @loaders.gl/i3s で読む（i3s-decode.js）。
// Gaussian splat（KHR_gaussian_splatting・2026-10-18）＝glTF の splat のプリミティブは worker が局所の座標＋transform（列優先 4×4・ECEF）のまま返し、
//   main がタイルごとに map.addData({ crs: "local", transform, … }, { kind: "splat" }) の層にする（描き手＝@ortho-earth/splat・タイルの出し入れ＝setVisible／remove）。
//   plugin が無い（registry.dataKinds に "splat" が無い）時は worker に splats:false を渡す＝仕様の fallback どおり点として描き、tileset ごとに一度だけ warn。opts.splat＝層に渡す opts（lod・shDegree・opacity…）
import { pickMeshes, tintColors, lngLatOfWorld } from "../meshpick.ts";   // 当たりと feature state の色（W7）
import { featureProperties } from "../mesh-features.ts";
import { workerPool } from "../worker-rpc.ts";   // worker への往復（id つき postMessage）＝ガジェット共通
import { transcodersOf } from "../transcoders.ts";   // registry.textureTranscoders の写し（W5）＝タイルの glb の KTX2 も変換器で
import { implicitOf, contentsOf, isAvailable, indexIn, childSubtreeIndex, childCoord, expandUri, geometricErrorAt, volumeAt, parseSubtree, rankOf } from "../tiles3d-implicit.ts";   // implicit tiling（3D Tiles 1.1）
import { entityOf, subtreeTables, rowEntity, semanticsOf, applySemantics } from "../tiles3d-metadata.ts";   // metadata（tileset・group・tile・content）
import { compileStyle, paintBatch } from "../tiles3d-style.ts";   // スタイル（地物ごとの color・show）
import { isCesiumStyle, cesiumToSpec } from "../tiles3d-cesium-style.ts";   // Cesium の 3D Tiles Styling → MapLibre の式
import { cameraState, ellipsoidOn } from "@ortho-earth/core";
import type { Bbox, OverlayHandle, Tiles3DHandle, Tiles3DOptions, Tiles3DRequestTransform, Tiles3DStyle } from "../../globe.d.ts";
import type { MeshFeatures } from "../mesh-features.ts";
import type { BoundingVolume, ImplicitTiling, ImplicitTilingJson, Subtree, TileCoord } from "../tiles3d-implicit.ts";
import type { MetadataEntity, MetadataEntityJson, MetadataSchema } from "../tiles3d-metadata.ts";
import type { CompiledStyle, StyleSpec } from "../tiles3d-style.ts";
import type { PickItem } from "../meshpick.ts";
import type { Requester, ResolvedRequest } from "../request.ts";
import type { MeshPickEnv } from "../types/install.ts";
import type { GlobeMap } from "../types/map.ts";
import type { GlobeCam } from "../types/scope.ts";

/** タイルの content（読む欄だけ） */
interface ContentJson { uri?: string; url?: string; metadata?: MetadataEntityJson; group?: number }
/** tileset.json のタイル（読む欄だけ）。contents＝複数 content（1.1）・implicitTiling／extensions＝implicit tiling の根（1.1／1.0 拡張）と 1.0 の 3DTILES_multiple_contents */
interface TileJson { transform?: number[]; content?: ContentJson; contents?: ContentJson[]; geometricError?: number; metadata?: MetadataEntityJson; refine?: string; boundingVolume?: BoundingVolume; children?: TileJson[];
	implicitTiling?: ImplicitTilingJson; extensions?: Record<string, unknown> }
/** tileset.json の根（読む欄だけ） */
interface TilesetJson {
	root?: TileJson; geometricError?: number; schema?: MetadataSchema; schemaUri?: string; groups?: MetadataEntityJson[]; asset?: (Record<string, unknown> & { extras?: Record<string, unknown> }) | null;
	metadata?: Record<string, unknown> | null; extras?: Record<string, unknown> | null; extensionsUsed?: string[]; extensionsRequired?: string[];
}
/** I3S の節の見出し（worker の答え）＝c＝[lon,lat,h]・r＝境界球の半径（m）・thr＝子へ降りる直径（px）・kids＝子の id・mesh＝中身を持つ */
interface I3SNodeMsg { id: number | string; c: number[]; r: number; thr: number; kids: Array<number | string>; mesh: boolean }
/** ECEF の境界球 */
interface Sphere { c: number[]; r: number }
/** worker が解いたメッシュの束（meshdecode の形・中身は renderer の meshSet へそのまま） */
export interface TileMesh { pos: Float32Array<ArrayBuffer>; nrm: Float32Array<ArrayBuffer>; idx: Uint32Array<ArrayBuffer>; uv?: Float32Array<ArrayBuffer>; col?: Uint8Array<ArrayBuffer>; origin?: number[]; bbox?: number[] }
/** 画像（素の RGBA か ImageBitmap） */
export interface TileTex { rgba?: Uint8Array; bitmap?: ImageBitmap }
export interface TileBatch {
	mesh: TileMesh; features?: MeshFeatures | null; tex?: TileTex | null; texMR?: TileTex | null; texN?: TileTex | null; texOcc?: TileTex | null; texEm?: TileTex | null;
	pbr?: unknown; alphaMode?: string; alphaCutoff?: number;
}
/** worker（tile3d・i3sContent）の答え */
interface TileReply {
	batches: TileBatch[];
	points: Array<{ n: number; pos: Float32Array<ArrayBuffer>; rgba: Uint8Array<ArrayBuffer>; origin: number[] }>;
	splats?: TileSplat[];
	voxels?: TileVoxel[];
	stats: { triangles: number; points: number; splats?: number; splatPoints?: number; voxels?: number; voxelsSkipped?: number; bytes?: number; copyright?: string[] | null };
}
/** worker が返す voxel（meshdecode の VoxelPrimOut）＝box は単位立方体 → ECEF の transform・region は経緯度高（voxel の VoxelData にそのまま） */
interface TileVoxel { shape: "box" | "region"; dims: [number, number, number]; components: 1 | 4; values: Float32Array | Uint16Array | Uint8Array; transform?: number[]; region?: number[]; noData?: number; property: string }
/** worker が返す Gaussian splat（meshdecode の SplatPrimOut）＝局所の座標＋transform（ECEF）・spz＝圧縮の本体（plugin が解く） */
interface TileSplat { n: number; positions: Float32Array; scales: Float32Array; rotations: Float32Array; colors: Uint8Array; sh: Float32Array | null; shDegree: number; transform: number[]; spz: Uint8Array | null; colorSpace: string }
/** splat の手綱（使う口だけ） */
interface SplatLayer { ready?: Promise<unknown>; setVisible(on: boolean): unknown; remove(): void }
/** worker（i3sOpen）の答え */
interface I3SInfo { name: string | null; copyright: string | null; root: I3SNodeMsg }
/** renderer の meshSet に渡す物（束のメッシュ＋描き方の印） */
export type MeshSetData = TileMesh & { [k: string]: unknown };
/** 当たりの写し（W7）＝束ごとの頂点・index・地物の番号・元の頂点色。pos・idx＝null＝頂点の写しは持たない（lowMem の "auto"・2026-10-20）＝当たりは引けないが feature state の色（col0・features）は効く */
interface PickPart { k: number; pos: Float32Array | null; idx: Uint32Array | null; origin: number[]; features: MeshFeatures | null; col0: Uint8Array | null }
/** tileset.json ごとの metadata の前提（schema と groups）＝その tileset のタイルが引き継ぐ（外部 tileset は自分の物があれば差し替え） */
interface T3dScope { schema: MetadataSchema | null; groups: Array<MetadataEntity | null> }
/** implicit tiling の根ごとの共有（t＝分け方・bv／ge／refine＝根の境界・誤差・継ぎ方・contents＝content ごとのテンプレート URI と group・subtrees＝"L/x/y/z" → 読み込み） */
interface ImpRoot { t: ImplicitTiling; bv: BoundingVolume; ge: number; refine: string; contents: Array<{ uri: string; group?: number }>; base: string; subtrees: Map<string, SubtreeSlot> }
interface SubtreeSlot { state: "loading" | "ready" | "failed"; st: Subtree | null }
/** implicit の節点＝c＝自分の座標・r＝自分を含む subtree の根の座標・st＝その subtree（null＝まだ読んでいない＝自分が subtree の根） */
interface ImpNode { R: ImpRoot; c: TileCoord; r: TileCoord; st: Subtree | null }
/** スタイルの塗り直しの写し（束ごと）＝元の頂点色・地物・元の alphaMode・mask＝OPAQUE を MASK に切り替えて上げた（show で抜くため） */
interface PaintPart { k: number; col0: Uint8Array; features: MeshFeatures | null; alpha0: string; mask: boolean }
/** 選びの節点（3D Tiles のタイルか I3S の節） */
interface T3dNode {
	id: number; set: T3dSet; parent: T3dNode | null; M?: ArrayLike<number>; ge: number; refine: string; sphere: Sphere | null; uri: string | null; children: T3dNode[] | null;
	json?: TileJson; base?: string; external?: boolean; i3s?: I3SNodeMsg; kidsState?: "none" | "loading" | "ready" | "failed"; imp?: ImpNode;
	scope?: T3dScope; tileMeta?: MetadataEntity | null; contentMeta?: MetadataEntity | null; group?: number;
	paint?: PaintPart[] | null;
	/** 複数 content＝2 個目からの content の節点（タイルと一緒に読み・出す）／owner＝content の節点が付くタイル */
	extra?: T3dNode[] | null; owner?: T3dNode;
	state: "none" | "loading" | "ready" | "failed"; ward: string | null; bytes: number; /** main のヒープに持つ写しの量（当たり・塗り直し・地物の番号）＝予算に数える（2026-10-20） */ mainBytes: number; pts: string[] | null; splat?: SplatLayer[] | null; voxel?: SplatLayer[] | null; on: boolean; used: number; err: number;
	pick?: PickPart[] | null; copyright?: string[] | null; meshN?: number; bbox?: number[] | null;
}
/** add／addI3S の opts（既定を補った物） */
type T3dOpts = Tiles3DOptions & { heightOffset: number; lodScale?: number; token?: string; splat?: Record<string, unknown> | null; voxel?: Record<string, unknown> | null };
/** 1 つの tileset（3D Tiles か I3S＝kind "i3s"）。asset 等は 3D Tiles だけ・states は両方（I3S は手綱に setFeatureState が無い＝常に空） */
interface T3dSet {
	id: string; kind?: "i3s"; url: string; opts: T3dOpts; stats: { loaded: number; shown: number; failed: number; triangles: number; points: number; splats: number; voxels: number; bytes: number; subtrees: number };
	states: Map<number, Record<string, unknown>>; query: Array<[string, string]>; pts: OverlayHandle | null; removed: boolean; hidden: boolean; splatWarned?: boolean; voxelWarned?: boolean; voxDecl?: { dimensions?: number[]; padding?: { before?: number[]; after?: number[] } } | null;
	asset?: Record<string, unknown> | null; metadata?: Record<string, unknown> | null; extras?: Record<string, unknown> | null; extensionsUsed?: string[]; extensionsRequired?: string[];
	name?: string | null; copyright?: string | null;
	root: T3dNode; ready: Set<T3dNode>; scope?: T3dScope; style?: CompiledStyle | null; styleSpec?: Tiles3DStyle | null; metaBase?: Record<string, unknown>; loaded: () => T3dNode[]; copyrights?: string[]; attrText?: string | null;
}
/** add の手綱（公開の Tiles3DHandle＋検分用の tiles） */
type T3dHandle = Tiles3DHandle & { readonly tiles: Array<{ id: number; uri: string | undefined; on: boolean; ward: string | null; meshes: number | undefined; pts: number; splats: number; voxels: number; bbox: number[] | null | undefined }> };
/** addI3S の opts と手綱（map.addI3S と同じ） */
type I3SOptions = Parameters<GlobeMap["addI3S"]>[1];
type I3SHandle = Awaited<ReturnType<GlobeMap["addI3S"]>>;
/** createTiles3D の deps（globe.js の t3dGet が渡す） */
export interface Tiles3DEnv {
	cam: GlobeCam; size: () => { w: number; h: number }; dpr: number;
	setMesh(name: string, data: MeshSetData | null): void;
	meshVis(ward: string, on: boolean): void;
	setMeshCol?: ((name: string, data: Uint8Array) => void) | null;
	pickEnv?: (() => MeshPickEnv | null) | null;
	setAttribution?: ((id: string, text: string | null) => void) | null;
	lowMem?: boolean; signal?: AbortSignal; requester?: Requester | null; ell?: boolean;
}

const RAX = 1 - 1 / 298.257223563;   // b/a（楕円体表示の世界＝β 単位球 × S＝diag(1, b/a, 1)・S は mvp が畳む）
const R2D = 180 / Math.PI;
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const m4mul = (a: ArrayLike<number>, b: ArrayLike<number>) => { const o = new Array<number>(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3]; return o; };
const m4pt = (m: ArrayLike<number>, v: ArrayLike<number>) => [m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12], m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13], m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]];
const m4vec = (m: ArrayLike<number>, v: ArrayLike<number>) => [m[0]*v[0] + m[4]*v[1] + m[8]*v[2], m[1]*v[0] + m[5]*v[1] + m[9]*v[2], m[2]*v[0] + m[6]*v[1] + m[10]*v[2]];
const len = (v: ArrayLike<number>) => Math.hypot(v[0], v[1], v[2]);
function ecef2geo(x: number, y: number, z: number) {   // meshdecode と同じ（Newton 2 回）
	const a = 6378137, e2 = 0.00669437999014, p = Math.hypot(x, y), lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2)), h = 0;
	for (let i = 0; i < 2; i++) { const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
	return [lon, lat, h];
}
function geo2ecef(lon: number, lat: number, h: number) { const a = 6378137, e2 = 0.00669437999014, s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); return [(N + h) * Math.cos(lat) * Math.cos(lon), (N + h) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h) * s]; }
// ECEF → この地図の世界座標（メッシュの finishMesh と同じ軸・同じ式）。ell＝楕円体表示＝β 単位球の面点＋測地法線の β空間像に沿うリフト（#43）。
//   EW＝世界単位の m（球 6371000・楕円体 a）。球の枝は従来の式のまま（ビット同値）。
const worldOf = (e: ArrayLike<number>, baseH: number, ell: boolean, EW: number) => {
	const [lon, lat, h] = ecef2geo(e[0], e[1], e[2]), cb = Math.cos(lat);
	if (!ell) { const r = 1 + (h - baseH) / EW; return [cb * Math.cos(lon) * r, Math.sin(lat) * r, cb * Math.sin(lon) * r]; }
	const sp = Math.sin(lat), hr = (h - baseH) / EW, w = Math.hypot(cb, RAX * sp), horiz = cb / w + hr * cb;
	return [horiz * Math.cos(lon), RAX * sp / w + hr * sp / RAX, horiz * Math.sin(lon)];
};

// 境界体積 → ECEF の球 { c, r }
function sphereOf(bv: BoundingVolume | undefined, M: ArrayLike<number>): Sphere | null {
	if (bv?.box) {
		const b = bv.box, c = m4pt(M, [b[0], b[1], b[2]]);
		const u = m4vec(M, [b[3], b[4], b[5]]), v = m4vec(M, [b[6], b[7], b[8]]), w = m4vec(M, [b[9], b[10], b[11]]);
		return { c, r: Math.sqrt(len(u) ** 2 + len(v) ** 2 + len(w) ** 2) };
	}
	if (bv?.region) {
		const [w, s, e, n, h0, h1] = bv.region, lon = (w + e) / 2, lat = (s + n) / 2, c = geo2ecef(lon, lat, (h0 + h1) / 2);
		let r = 0; for (const x of [w, e]) for (const y of [s, n]) for (const h of [h0, h1]) { const p = geo2ecef(x, y, h); r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])); }
		return { c, r };
	}
	if (bv?.sphere) { const s = bv.sphere, c = m4pt(M, [s[0], s[1], s[2]]); const k = Math.max(len(m4vec(M, [1, 0, 0])), len(m4vec(M, [0, 1, 0])), len(m4vec(M, [0, 0, 1]))); return { c, r: s[3] * k }; }
	return null;
}
// mvp（列優先）から視錐台の 6 面（法線は内向き・正規化）
function planesOf(m: ArrayLike<number>) {
	const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
	const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3), out: number[][] = [];
	for (const [a, sg] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]] as Array<[number[], number]>) {
		const p = [r3[0] + sg * a[0], r3[1] + sg * a[1], r3[2] + sg * a[2], r3[3] + sg * a[3]], l = Math.hypot(p[0], p[1], p[2]) || 1;
		out.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
	}
	return out;
}

let ctxRGB: OffscreenCanvasRenderingContext2D | null = null;
const cssRGB = (c: string): number[] | null => { const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim()); if (m) { let h = m[1]; if (h.length === 3) h = [...h].map(x => x + x).join(""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
	try { ctxRGB ??= new OffscreenCanvas(1, 1).getContext("2d"); ctxRGB!.fillStyle = "#000"; ctxRGB!.fillStyle = c; const f = ctxRGB!.fillStyle as string, h = /^#([0-9a-f]{6})$/i.exec(f)?.[1]; if (h) return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); const r = /rgba?\(([^)]+)\)/.exec(f); return r ? r[1].split(",").slice(0, 3).map(v => +v) : null; } catch { return null; }
};   // feature state の色（CSS 色 → [r,g,b]）
export function createTiles3D(map: GlobeMap, { cam, size, dpr, setMesh, meshVis, setMeshCol = null, pickEnv = null, setAttribution = null, lowMem = false, signal, requester = null, ell = ellipsoidOn() }: Tiles3DEnv = {} as Tiles3DEnv) {   // setMeshCol・pickEnv＝当たりと feature state の色（W7）
	const EARTH_M = ell ? 6378137 : 6371000;   // 世界単位の m（core の worldRadiusM と同じ）
	// 取得の前の手入れ＝地図の transformRequest（#37）の上に、tileset ごとの opts.requestTransform(url, type) → { url?, headers?, credentials? }（F5・2026-10-12）。
	//   Google Photorealistic 3D Tiles の鍵・session の付与や、署名つき URL への差し替えはここで（鍵は repo に置かない＝呼び手の closure）。type＝"Source"（tileset.json・外部 tileset）か "Tile"（タイルの本体）
	const applyRT = (rt: Tiles3DRequestTransform | null | undefined, r: ResolvedRequest, type: "Source" | "Tile"): ResolvedRequest => {
		if (typeof rt !== "function") return r;
		try { const o = rt(r.url, type); if (!o) return r; const out = { ...r, url: o.url ?? r.url }; if (o.headers) out.headers = { ...(r.headers || {}), ...o.headers }; if (o.credentials) out.credentials = o.credentials; return out; }
		catch (err) { console.error("[tiles3d] requestTransform", err); return r; }
	};
	const resolveFor = (rt: Tiles3DRequestTransform | null | undefined, url: string, type: "Source" | "Tile") => applyRT(rt, requester ? requester.resolve(url, type) : { url, headers: undefined, credentials: undefined }, type);
	const getJSON = async (url: string, type: "Source" | "Tile", rt: Tiles3DRequestTransform | null | undefined = null): Promise<TilesetJson> => {
		const rq = resolveFor(rt, url, type);
		const r: { ok: boolean; status?: number; json(): Promise<unknown> } = rq.load ? { ok: true, json: async () => rq.load!("json") } : await fetch(rq.url, { credentials: rq.credentials || "omit", ...(rq.headers ? { headers: rq.headers } : {}) });   // 独自スキーム（addProtocol）は読み口で
		if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<TilesetJson>;
	};   // transformRequest / addProtocol（#37）
	const getBin = async (url: string, rt: Tiles3DRequestTransform | null | undefined): Promise<ArrayBuffer> => {   // subtree・その外部 buffer＝type "Source"（tileset.json と同じ）
		const rq = resolveFor(rt, url, "Source");
		if (rq.load) return rq.load("arrayBuffer") as Promise<ArrayBuffer>;
		const r = await fetch(rq.url, { credentials: rq.credentials || "omit", ...(rq.headers ? { headers: rq.headers } : {}) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer();
	};
	// metadata の前提＝schema（直書きか schemaUri）と groups（schema で読む）
	const scopeOf = async (j: TilesetJson, base: string, rt: Tiles3DRequestTransform | null | undefined, inherit: T3dScope | null = null): Promise<T3dScope> => {
		if (!j.schema && !j.schemaUri && !j.groups && inherit) return inherit;
		let schema = j.schema ?? null;
		if (!schema && j.schemaUri) schema = await (getJSON(new URL(j.schemaUri, base).href, "Source", rt) as Promise<MetadataSchema>).catch(err => { console.warn("[tiles3d] schemaUri", j.schemaUri, err.message); return null; });
		schema ??= inherit?.schema ?? null;
		return { schema, groups: (j.groups || []).map(g => entityOf(g, schema)) };
	};
	const sets = new Map<string, T3dSet>();   // id → tileset
	let seq = 0, tileSeq = 0;
	// worker（model 役）を 2 本＝取りに行く・解くを並列に（順繰り）。1 本あたり同時 3 件まで
	const pool = workerPool(() => new Worker(new URL("../worker.ts", import.meta.url), { type: "module", name: "model" }), { size: 2, tag: "tiles3d" });
	// Gaussian splat の描き手が居るか＝registry.dataKinds の "splat"（@ortho-earth/splat）。無ければ worker は splat を点として返す（仕様の fallback）
	const hasSplat = (): boolean => { try { return typeof (map.registry?.dataKinds?.get("splat") as { create?: unknown } | undefined)?.create === "function"; } catch { return false; } };
	// voxel の描き手が居るか＝registry.dataKinds の "voxel"（@ortho-earth/voxel）。無ければ worker は EXT_primitive_voxels を飛ばす（tileset ごとに一度 warn）
	const hasVoxel = (): boolean => { try { return typeof (map.registry?.dataKinds?.get("voxel") as { create?: unknown } | undefined)?.create === "function"; } catch { return false; } };
	// タイルの境界体積（ECEF の box＝中心＋半軸 3 本・region＝rad）＝glTF に形（KHR_implicit_shapes）が無い voxel（tileset の 3DTILES_content_voxels の経路）の置き場
	const voxVolume = (n: T3dNode): { box?: number[]; region?: number[] } | null => {
		const bv = n.imp ? volumeAt(n.imp.R.bv, n.imp.c, n.imp.R.t.n) : n.json?.boundingVolume ?? null, M = n.M ?? I4;
		if (bv?.box && bv.box.length === 12) { const b = bv.box; return { box: [...m4pt(M, [b[0], b[1], b[2]]), ...m4vec(M, [b[3], b[4], b[5]]), ...m4vec(M, [b[6], b[7], b[8]]), ...m4vec(M, [b[9], b[10], b[11]])] }; }
		if (bv?.region && bv.region.length === 6) return { region: [...bv.region] };
		return null;
	};
	const voxOpts = (set: T3dSet, n: T3dNode): false | { property: string | null; declared: T3dSet["voxDecl"]; volume: { box?: number[]; region?: number[] } | null } => hasVoxel() ? { property: typeof set.opts.voxel?.property === "string" ? set.opts.voxel.property : null, declared: set.voxDecl ?? null, volume: voxVolume(n) } : false;
	const rpc = pool.rpc;
	const BUDGET = (lowMem ? 160 : 512) * 1024 * 1024, DEF_INFLIGHT = lowMem ? 3 : 6;
	// 同時取得数の上限＝既定は lowMem 3／他 6。tileset の opts.maxInflight（1〜32）があれば、その最大で上書き（全 tileset で共通の枠・2026-10-20）。
	// 使い道＝ベンチで端末判定の差を外して比べる時（iPhone はタッチで一律 lowMem＝3 本）。setOptions での変更も次の選びから効く
	const maxInflight = (): number => { let m = 0; for (const s of sets.values()) { const v = s.opts.maxInflight; if (typeof v === "number" && v > 0) m = Math.max(m, v); } return m ? Math.min(32, Math.floor(m)) || 1 : DEF_INFLIGHT; };
	// gpuBytes＝GPU へ送った量・mainBytes＝main のヒープに残る写し（当たりの頂点・index、塗り直しの元の頂点色、地物の番号）。予算（BUDGET）は両方の和で見る（2026-10-20 の総点検：
	// 写しはタイル実バイトの約 7 割（合成 161 MB で main 115 MB）あり、どの予算にも数えていなかった）
	let inflight = 0, gpuBytes = 0, mainBytes = 0, rafPending = 0;
	// 予算の SSE 引き上げ（2026-10-21・総点検の残件 1）：捨てられる物（表示も選びもしていない物）を捨てても予算を越えていれば、次の選びから maxSSE を
	// sseScale 倍（1.25 倍ずつ・上限 16 倍）にして粗い段で止める＝表示中の塊そのものを縮める（Cesium の memory-adaptive SSE と同じ考え）。旧＝表示中の塊が
	// 予算を越えると越えたまま持ち続けた（iPhone の 160 MB は密な街区で越え得る）。戻し＝使っている物（表示中＋今回の選びで塊の一員）の量が予算の 7 割を
	// 切っていれば、動いた時に 1 s に 1 段ずつ 0.9 倍で 1 倍まで（止まっている間は戻さない・取っておいた物（捨てていない隠れた子）は量に数えない＝戻せなくなる）
	let sseScale = 1, moved = false, sseDownAt = 0;   // moved＝前回の選びから動いた（戻しは動いた時だけ）・sseDownAt＝最後に戻した時刻
	const schedule = () => { if (rafPending) return; rafPending = requestAnimationFrame(() => { rafPending = 0; update(); }); };

	const withQuery = (uri: string, set: T3dSet) => { if (!set.query.length) return uri; const u = new URL(uri); for (const [k, v] of set.query) if (!u.searchParams.has(k)) u.searchParams.set(k, v); return u.href; };   // 親の URL の鍵（?key= 等）を子へ引き継ぐ
	const tileNode = (json: TileJson, parentM: ArrayLike<number>, base: string, set: T3dSet, parent: T3dNode | null, scope: T3dScope | null = parent?.scope ?? null): T3dNode => {
		const M = json.transform ? m4mul(parentM, json.transform) : parentM;
		const t = implicitOf(json);   // implicit の根＝content の URI はテンプレート・子は subtree から
		const uriOf = (c: ContentJson) => c.uri ?? c.url ?? null;
		let cs = contentsOf<ContentJson>(json).filter(c => uriOf(c) != null);
		if (cs.length > 1 && cs.some(c => isJsonUri(uriOf(c)!))) { console.warn("[tiles3d] external tileset among multiple contents is not supported", cs.map(uriOf).join(" ")); cs = cs.filter(c => !isJsonUri(uriOf(c)!)); }
		const c0 = cs[0], uri = c0 ? uriOf(c0) : null;
		const tileMeta = entityOf(json.metadata, scope?.schema), { bv, ge } = applySemantics(json.boundingVolume ?? null, json.geometricError ?? 0, semanticsOf(tileMeta, scope?.schema));   // 意味（TILE_*）で境界と誤差を上書き
		const n: T3dNode = { id: ++tileSeq, set, parent, M, ge, refine: (json.refine || parent?.refine || "REPLACE").toUpperCase(),
			sphere: sphereOf(bv ?? undefined, M), uri: uri && !t ? withQuery(new URL(uri, base).href, set) : null, children: null, json, base,
			state: "none", ward: null, bytes: 0, mainBytes: 0, pts: null, on: false, used: 0, err: 0, scope: scope ?? undefined, tileMeta, contentMeta: t ? null : entityOf(c0?.metadata, scope?.schema), group: c0?.group };
		n.external = !!n.uri && isJsonUri(n.uri);
		if (t) {
			const r0: TileCoord = t.n === 8 ? { level: 0, x: 0, y: 0, z: 0 } : { level: 0, x: 0, y: 0 };
			n.imp = { R: { t, bv: json.boundingVolume || {}, ge: json.geometricError ?? 0, refine: n.refine, contents: cs.map(c => ({ uri: uriOf(c)!, group: c.group })), base, subtrees: new Map() }, c: r0, r: r0, st: null };
			n.tileMeta = null;   // implicit の根の metadata は subtree から
		}
		else if (cs.length > 1) n.extra = cs.slice(1).map(c => contentNode(n, withQuery(new URL(uriOf(c)!, base).href, set), entityOf(c.metadata, scope?.schema), c.group));
		return n;
	};
	const isJsonUri = (u: string) => /\.json(\?|$)/i.test(u);
	// 複数 content の 2 個目から＝タイルの境界・誤差・metadata を写した content の節点（木は歩かない＝子は空）
	const contentNode = (owner: T3dNode, uri: string, contentMeta: MetadataEntity | null, group: number | undefined): T3dNode => ({ id: ++tileSeq, set: owner.set, parent: owner.parent, owner, M: owner.M, ge: owner.ge, refine: owner.refine, sphere: owner.sphere,
		uri, children: [], base: owner.base, external: false, state: "none", ward: null, bytes: 0, mainBytes: 0, pts: null, on: false, used: 0, err: 0, scope: owner.scope, tileMeta: owner.tileMeta, contentMeta, group });
	// implicit の節点（subtree の中＝st を親から・subtree の根＝st は読んでから impInit）
	const impNode = (parent: T3dNode, c: TileCoord, r: TileCoord, st: Subtree | null): T3dNode => {
		const R = parent.imp!.R, M = parent.M!;
		const n: T3dNode = { id: ++tileSeq, set: parent.set, parent, M, ge: geometricErrorAt(R.ge, c.level), refine: R.refine, sphere: sphereOf(volumeAt(R.bv, c, R.t.n) ?? undefined, M),
			uri: null, children: null, base: R.base, external: false, imp: { R, c, r, st }, state: "none", ward: null, bytes: 0, mainBytes: 0, pts: null, on: false, used: 0, err: 0, scope: parent.scope };
		if (st) impInit(n);
		return n;
	};
	const impInit = (n: T3dNode) => {   // subtree が揃った節点＝content ごとの有無と URI・metadata（tileMetadata／contentMetadata の行＝available の中の順位）と意味の上書き
		const { R, c, r, st } = n.imp!, i = indexIn(r, c, R.t.n), schema = n.scope?.schema;
		const tables = schema && st!.json.propertyTables?.length ? subtreeTables(st!, schema) : null, tm = st!.json.tileMetadata;
		n.tileMeta = tables && tm != null ? rowEntity(tables[tm], rankOf(st!.tile, i)) : null;
		const sem = semanticsOf(n.tileMeta, schema);
		if (sem) { const o = applySemantics(volumeAt(R.bv, c, R.t.n), geometricErrorAt(R.ge, c.level), sem); n.ge = o.ge; n.sphere = sphereOf(o.bv ?? undefined, n.M!); }
		const parts = R.contents.map((ct, k) => {
			const ca = st!.content[k], has = !!ca && isAvailable(ca, i), cm = st!.json.contentMetadata?.[k];
			return has ? { uri: withQuery(new URL(expandUri(ct.uri, c), R.base).href, n.set), meta: tables && cm != null ? rowEntity(tables[cm], rankOf(ca, i)) : null, group: ct.group } : null;
		});
		const p0 = parts[0];
		n.uri = p0?.uri ?? null; n.contentMeta = p0?.meta ?? null; n.group = p0?.group ?? R.contents[0]?.group;
		const more = parts.slice(1).filter(p => p != null);
		n.extra = more.length ? more.map(p => contentNode(n, p.uri, p.meta, p.group)) : null;
	};
	// 自分が根の subtree を読む（同じ座標の subtree は根ごとに 1 回＝刈った後に作り直した節点も読み込みを共有）。戻り＝揃ったか
	const impSubtree = (n: T3dNode): "ready" | "loading" | "failed" => {
		const I = n.imp!, R = I.R, key = `${I.c.level}/${I.c.x}/${I.c.y}/${I.c.z ?? 0}`;
		let slot = R.subtrees.get(key);
		if (!slot) {
			const set = n.set, url = withQuery(new URL(expandUri(R.t.subtreeUri, I.c), R.base).href, set);
			slot = { state: "loading", st: null }; R.subtrees.set(key, slot);
			const sl = slot;
			getBin(url, set.opts.requestTransform).then(ab => parseSubtree(ab, R.t, uri => getBin(withQuery(new URL(uri, url).href, set), set.opts.requestTransform)))
				.then(st => { sl.st = st; sl.state = "ready"; set.stats.subtrees++; })
				.catch(err => { sl.state = "failed"; console.warn("[tiles3d] subtree", url, err.message); })
				.finally(schedule);
		}
		else if (slot.state === "ready") { R.subtrees.delete(key); R.subtrees.set(key, slot); }   // 使った順（Map の挿入順）
		if (slot.state === "ready" && !I.st) { I.st = slot.st; impInit(n); }
		if (R.subtrees.size > MAX_SUBTREES) for (const [k, s2] of R.subtrees) { if (R.subtrees.size <= MAX_SUBTREES) break; if (s2.state === "ready" && k !== key) { R.subtrees.delete(k); n.set.stats.subtrees--; } }   // 古い物から（節点が持つ st はそのまま・作り直した時に読み直す）
		return slot.state;
	};
	// 子＝明示的な tileset は JSON の children から・implicit は subtree のビット列から（null＝まだ分からない＝自分の subtree を読んでいる）
	const kidsOf = (n: T3dNode): T3dNode[] | null => {
		if (n.children) return n.children;
		if (!n.imp) return n.children = (n.json!.children || []).map(c => tileNode(c, n.M!, n.base!, n.set, n));
		const { R, c, r, st } = n.imp, t = R.t;
		if (!st) return null;
		const kids: T3dNode[] = [];
		if (c.level + 1 < t.availableLevels) for (let k = 0; k < t.n; k++) {
			const cc = childCoord(c, k);
			if (cc.level - r.level === t.subtreeLevels) { if (isAvailable(st.child, childSubtreeIndex(r, cc, t.n))) kids.push(impNode(n, cc, cc, null)); }   // 子 subtree の根
			else if (isAvailable(st.tile, indexIn(r, cc, t.n))) kids.push(impNode(n, cc, r, st));
		}
		return n.children = kids;
	};
	// 刈り込み＝長く選びに来ていない implicit の部分木を落とす（中身が上がっている／読んでいる子孫がいない時だけ）。subtree の読み込みは根に残す
	const PRUNE_AGE = 240, MAX_SUBTREES = 1024;
	const busy = (n: T3dNode): boolean => n.state !== "none" || !!n.extra?.some(busy) || !!n.children?.some(busy);
	const prune = (n: T3dNode) => {
		if (!n.children) return;
		if (n.imp && n.children.every(k => frameNo - k.used > PRUNE_AGE) && !n.children.some(busy)) { n.children = null; return; }
		for (const k of n.children) prune(k);
	};
	// ── I3S（#48）：節点＝worker が返す見出し { id, c:[lon,lat,h], r, thr(px の直径), kids, mesh }。子の見出しは要る時に worker へ（nodepages）
	const D2R = Math.PI / 180;
	const i3sNode = (sm: I3SNodeMsg, set: T3dSet, parent: T3dNode | null): T3dNode => ({ id: ++tileSeq, set, parent, i3s: sm, sphere: { c: geo2ecef(sm.c[0] * D2R, sm.c[1] * D2R, sm.c[2]), r: sm.r }, uri: sm.mesh ? `i3s:${sm.id}` : null,
		refine: "REPLACE", ge: 0, children: null, kidsState: "none", state: "none", ward: null, bytes: 0, mainBytes: 0, pts: null, on: false, used: 0, err: 0 });
	const i3sKids = (n: T3dNode): T3dNode[] | null => {   // 揃っていれば子の配列・取りに行っている間は null
		if (n.children) return n.children;
		if (n.kidsState === "none") {
			n.kidsState = "loading";
			rpc<{ nodes: I3SNodeMsg[] }>({ kind: "i3sNodes", url: n.set.url, ids: n.i3s!.kids, token: n.set.opts.token }).then(r => { if (!n.set.removed) n.children = r.nodes.map(sm => i3sNode(sm, n.set, n)); n.kidsState = "ready"; })
				.catch(err => { n.kidsState = "failed"; console.warn("[i3s] node page", err.message); }).finally(schedule);
		}
		return n.kidsState === "failed" ? [] : null;
	};

	// 外部 tileset（content が .json）＝読めたらその根を子にする
	const loadExternal = (n: T3dNode) => {
		if (n.state !== "none") return;
		n.state = "loading"; inflight++;
		getJSON(n.uri!, "Source", n.set.opts.requestTransform).then(async j => {
			const scope = await scopeOf(j, n.uri!, n.set.opts.requestTransform, n.scope ?? null);   // 外部 tileset の schema／groups（無ければ親の物）
			n.children = [tileNode(j.root!, n.M!, n.uri!, n.set, n, scope)];
			n.uri = null; n.external = false; n.state = "ready";
		}).catch(err => { n.state = "failed"; console.warn("[tiles3d] external tileset", n.uri, err.message); })
			.finally(() => { inflight--; schedule(); });
	};
	const load = (n: T3dNode) => {   // 同時取得の上限（maxInflight）は塊の途中でも守る（旧 force＝兄弟は上限を越えても投げた・2026-10-20 に廃止）
		if (n.state !== "none" || inflight >= maxInflight()) return;
		n.state = "loading"; inflight++;
		const set = n.set;
		const onGround = set.opts.ground === "terrain";
		const rq: Partial<ResolvedRequest> = set.kind !== "i3s" ? resolveFor(set.opts.requestTransform, n.uri!, "Tile") : { url: n.uri! };
		const body = (rq.load ? rq.load("arrayBuffer") : Promise.resolve(null)) as Promise<ArrayBuffer | null>;   // 独自スキーム＝main が読み口で取って本体を worker へ
		body.then(ab => set.kind === "i3s" ? rpc<TileReply>({ kind: "i3sContent", ell, url: set.url, nodeId: n.i3s!.id, token: set.opts.token, baseH: -set.opts.heightOffset, groundMode: onGround ? "terrain" : "absolute" })
			: rpc<TileReply>({ kind: "tile3d", ell, url: rq.url, ab, headers: rq.headers, credentials: rq.credentials, transform: n.M, baseH: -set.opts.heightOffset, textures: set.opts.textures !== false, groundMode: onGround ? "terrain" : "absolute", featureIdSet: set.opts.featureIdSet ?? 0, transcoders: transcodersOf(map), splats: hasSplat(), voxels: voxOpts(set, n) }, ab ? [ab] : [])).then(r => {
			if (set.removed) return;
			n.ward = `t3d:${set.id}:${n.id}`;
			n.bytes = 0;

			// 当たりの写し（W7）＝"auto"＝地物の番号がある束だけ・true＝全部・false＝持たない。
			// 頂点・index の写し（geom）は lowMem の "auto" では持たない（2026-10-20）＝iPhone 等では pick が引けない代わりに main のヒープがタイル実バイトの約 7 割分減る。要るなら pickable:true で明示
			const pk = set.opts.pickable ?? "auto", geom = pk === true || (pk === "auto" && !lowMem);
			n.pick = pk === false ? null : r.batches.map((b, k) => (pk === true || b.features) ? { k, pos: geom ? b.mesh.pos.slice() : null, idx: geom ? b.mesh.idx.slice() : null, origin: b.mesh.origin ? [...b.mesh.origin] : [0, 0, 0], features: b.features || null, col0: b.features && b.mesh.col ? b.mesh.col.slice() : null } : null).filter(Boolean) as PickPart[];
			const sty = set.style, opaque = (b: TileBatch) => (b.alphaMode ?? "OPAQUE") === "OPAQUE";
			n.paint = sty ? r.batches.map((b, k) => b.mesh.col ? { k, col0: b.mesh.col.slice(), features: b.features || null, alpha0: b.alphaMode ?? "OPAQUE", mask: !!sty.show && opaque(b) } : null).filter(Boolean) as PaintPart[] : null;   // スタイル＝元の頂点色を写して持つ
			// main に残る写しの量＝当たりの頂点・index・元の頂点色＋塗り直しの元の頂点色＋地物の番号（ids・tblV＝束ごとに 1 回）。属性の表（文字列の配列）は数えない
			n.mainBytes = 0;
			const featBytes = (f: MeshFeatures | null) => f ? f.ids.byteLength + ((f.tblV as ArrayBufferView | null)?.byteLength || 0) : 0;
			for (const p of n.pick || []) n.mainBytes += (p.pos?.byteLength || 0) + (p.idx?.byteLength || 0) + (p.col0?.byteLength || 0) + featBytes(p.features);
			for (const p of n.paint || []) n.mainBytes += p.col0.byteLength + (n.pick?.some(q => q.k === p.k) ? 0 : featBytes(p.features));
			if (r.batches.length) meshVis(n.ward, false);   // 伏せてから上げる（同じ列＝転送より先に効く）＝出すかは次の update が決める（兄弟が揃う前に出さない）
			r.batches.forEach((b, k) => {
				const m = b.mesh, mask = !!sty?.show && opaque(b);   // show で抜く＝OPAQUE を MASK に（見える地物は α 255）
				n.bytes += (m.pos?.byteLength || 0) + (m.nrm?.byteLength || 0) + (m.idx?.byteLength || 0) + (m.uv?.byteLength || 0) + (m.col?.byteLength || 0) + (b.tex?.rgba?.byteLength || (b.tex?.bitmap ? b.tex.bitmap.width * b.tex.bitmap.height * 4 : 0));
				setMesh(`${n.ward}#${k}`, { ...m, noLift: !onGround, drape: onGround, keep2d: true, castShadow: true, ward: n.ward, tex: b.tex, texMR: b.texMR, texN: b.texN, texOcc: b.texOcc, texEm: b.texEm, pbr: b.pbr, alphaMode: mask ? "MASK" : b.alphaMode, alphaCutoff: mask ? 0.5 : b.alphaCutoff, maskBbox: null, maskN: 0 });   // pbr＋材質 4 枚＝#46 段 2
			});
			if (set.states.size || n.paint) paintNode(n);   // feature state の色とスタイルは後から読んだタイルにも
			n.copyright = r.stats?.copyright || null;   // glTF の asset.copyright（W8）＝出典の欄へ
			n.meshN = r.batches.length; n.bbox = r.batches[0]?.mesh.bbox?.map(v => +v.toFixed(5)) ?? null;
			if (r.points.length) {
				set.pts ??= map.overlay({ builtin: "points" }, { name: `tiles3d:${set.id}` });
				set.pts.post({ type: "style", size: set.opts.pointSize ?? 1.5, color: [0.85, 0.85, 0.85, 1] });
				n.pts = r.points.map((p, k) => { const q = `${n.id}:${k}`; n.bytes += p.pos.byteLength + p.rgba.byteLength; set.pts!.post({ type: "layer", q, n: p.n, pos: p.pos, rgba: p.rgba, origin: p.origin }, [p.pos.buffer, p.rgba.buffer]); return q; });
			}
			if (r.splats?.length) {   // Gaussian splat＝タイルごとに splat の層（crs "local"＋transform・絶対高さ）。spz＝bytes＋format で読み手へ
				n.splat = [];
				r.splats.forEach((s, k) => {
					const q = `tiles3d:${set.id}:${n.id}:${k}`, bytes = s.spz ? s.spz.byteLength : s.positions.byteLength + s.scales.byteLength + s.rotations.byteLength + s.colors.byteLength + (s.sh?.byteLength || 0);
					const common = { kind: "splat", id: q, altitude: "absolute", depthTest: true, properties: { tile: n.id }, ...(set.opts.splat || {}) };
					try {
						const h = (s.spz ? map.addData(s.spz, { ...common, format: "spz", transform: s.transform }) : map.addData({ n: s.n, crs: "local", transform: s.transform, positions: s.positions, scales: s.scales, rotations: s.rotations, colors: s.colors, ...(s.sh ? { sh: s.sh } : {}) }, common)) as unknown as SplatLayer;
						h.ready?.catch?.((err: Error) => console.warn("[tiles3d] splat", n.uri, err?.message || err));
						n.splat!.push(h); n.bytes += bytes;
					} catch (err) { console.warn("[tiles3d] splat", n.uri, (err as Error)?.message || err); }
				});
			}
			if (r.stats.splatPoints && !set.splatWarned) { set.splatWarned = true; console.warn(`[tiles3d] ${set.id}: KHR_gaussian_splatting drawn as points (${r.stats.splatPoints}+); map.use(splatPlugin()) from @ortho-earth/splat to draw Gaussian splats`); }
			if (r.voxels?.length) {   // voxel（EXT_primitive_voxels）＝タイルごとに voxel の層（box＝transform・region＝経緯度高・絶対高さ）
				n.voxel = [];
				r.voxels.forEach((v, k) => {
					const q = `tiles3d:${set.id}:${n.id}:v${k}`;
					const data = v.shape === "box" ? { shape: "box", dims: v.dims, box: { transform: v.transform }, values: v.values, components: v.components, ...(v.noData != null ? { noData: v.noData } : {}) }
						: { shape: "region", dims: v.dims, region: v.region, values: v.values, components: v.components, ...(v.noData != null ? { noData: v.noData } : {}) };
					try {
						const h = map.addData(data, { kind: "voxel", id: q, altitude: "absolute", depthTest: true, properties: { tile: n.id, property: v.property }, ...(set.opts.voxel || {}) }) as unknown as SplatLayer;
						h.ready?.catch?.((err: Error) => console.warn("[tiles3d] voxel", n.uri, err?.message || err));
						n.voxel!.push(h); n.bytes += v.values.byteLength;
					} catch (err) { console.warn("[tiles3d] voxel", n.uri, (err as Error)?.message || err); }
				});
			}
			if (r.stats.voxelsSkipped && !set.voxelWarned) { set.voxelWarned = true; console.warn(`[tiles3d] ${set.id}: EXT_primitive_voxels skipped (${r.stats.voxelsSkipped}+ grids)${hasVoxel() ? " (unsupported shape or attribute)" : "; map.use(voxelPlugin()) from @ortho-earth/voxel to draw voxels"}`); }
			gpuBytes += n.bytes; mainBytes += n.mainBytes; set.stats.loaded++; set.stats.triangles += r.stats.triangles; set.stats.points += r.stats.points; set.stats.splats += r.stats.splats || 0; set.stats.voxels += r.stats.voxels || 0; set.stats.bytes += r.stats.bytes || 0;
			// 上げた直後は伏せておく（次の update が出す物だけ出す）。旧＝上げた直後は見えていて次の update で消した＝兄弟が揃う前の子が
			// 1 枚ずつ現れては消える（描いては消す・2026-10-19）。メッシュは上で転送の前に伏せた。点と splat はここで伏せる
			if (n.pts) for (const q of n.pts) set.pts?.post({ type: "vis", q, on: false });
			if (n.splat) for (const h of n.splat) h.setVisible(false);
			if (n.voxel) for (const h of n.voxel) h.setVisible(false);
			n.state = "ready"; n.on = false;
			if (n.ward || n.pts || n.splat || n.voxel) set.ready.add(n);
		}).catch(err => { n.state = "failed"; n.err++; set.stats.failed++; console.warn("[tiles3d] tile", n.uri, err.message); })
			.finally(() => { inflight--; schedule(); });
	};
	// feature state の色（W7）＝タイルの束ごとに元の頂点色から差し替えた列を renderer の "meshCol" へ
	const paintNode = (n: T3dNode) => {
		if (n.paint) return paintStyled(n);
		if (!setMeshCol || !n.ward || !n.pick) return;
		const set = n.set, colorOf = (id: number) => { const c = set.states.get(id)?.color; const v = c ? cssRGB(String(c)) : null; return v; };
		for (const p of n.pick) if (p.col0 && p.features) setMeshCol(`${n.ward}#${p.k}`, tintColors(p.col0, p.features.ids, colorOf));
	};
	// スタイル（＋feature state の色）＝束ごとに元の頂点色から塗り直す。属性＝tileset ＜ group ＜ tile ＜ content の metadata ＜ 地物の属性
	const paintStyled = (n: T3dNode) => {
		if (!setMeshCol || !n.ward) return;
		const set = n.set, sty = set.style ?? null;
		set.metaBase ??= { ...(entityOf(set.metadata as MetadataEntityJson | null, set.scope?.schema)?.properties || {}) };
		const base = { ...set.metaBase, ...(n.group != null ? n.scope?.groups[n.group]?.properties : null), ...n.tileMeta?.properties, ...n.contentMeta?.properties };
		for (const p of n.paint!) {
			const f = p.features, cache = new Map<string, number[] | null>();
			const rgbaOf = (id: number | null, t: number | null) => {
				const key = `${id}:${t}`;
				if (cache.has(key)) return cache.get(key)!;
				const state = id != null ? set.states.get(id) ?? null : null, table = id != null && t != null && t >= 0 ? f?.tables?.[t] : null;
				const props = table ? { ...base, ...featureProperties(table, id!) } : base, x = { props, id, state };
				let c: number[] = [NaN, NaN, NaN, NaN];
				const sc = sty?.color?.(x); if (sc) c = [sc[0], sc[1], sc[2], NaN];
				const st = state?.color ? cssRGB(String(state.color)) : null; if (st) c = [st[0], st[1], st[2], NaN];   // feature state の色が勝つ
				const shown = sty?.show ? sty.show(x) : true;
				c[3] = !shown ? 0 : p.mask ? 255 : NaN;
				const out = c.every(v => Number.isNaN(v)) ? null : c;
				cache.set(key, out); return out;
			};
			setMeshCol(`${n.ward}#${p.k}`, paintBatch(p.col0, f?.ids, i => f ? (f.tblV ? f.tblV[i] : f.table ?? null) : null, rgbaOf));
		}
	};
	// スタイルを差し替え＝上げてあるタイルは塗り直す（元の色を持っていない・show に MASK が要るのに無い＝読み直す）
	const styleOf = (spec: Tiles3DStyle | null | undefined) => compileStyle(isCesiumStyle(spec) ? cesiumToSpec(spec) : spec as StyleSpec | null | undefined);   // Cesium 形は訳す（訳せなければ例外）
	const setStyle = (set: T3dSet, spec: Tiles3DStyle | null | undefined) => {
		const st = styleOf(spec);
		set.styleSpec = spec ?? null; set.style = st;
		const sty = set.style;
		for (const n of set.loaded()) {
			if (n.state !== "ready" || !n.ward) continue;
			if ((sty && !n.paint) || (sty?.show && n.paint?.some(p => p.alpha0 === "OPAQUE" && !p.mask))) unload(n);
			else paintNode(n);
		}
		schedule();
	};
	// 画面の点（CSS px）→ 一番手前のタイルの三角形と地物 { featureId, properties, table, tile, distance, lngLat } | null
	const pickSet = (set: T3dSet, x: number, y: number) => {
		const env = pickEnv?.(); if (!env) return null;
		const onGround = set.opts.ground === "terrain", items: PickItem[] = [], refs: Array<[T3dNode, PickPart]> = [];
		for (const n of set.loaded()) if (n.on && n.pick) for (const p of n.pick) { if (!p.pos || !p.idx) continue; items.push({ pos: p.pos, idx: p.idx, origin: p.origin, features: p.features, lift: env.lift(p.origin, onGround ? "drape" : "plane") }); refs.push([n, p]); }
		const h = pickMeshes(items, env.view, x, y); if (!h) return null;
		const [n, p] = refs[h.item], f = p.features, tIdx = f ? (f.tblV ? f.tblV[h.vertex] : f.table) : null, table = tIdx != null && tIdx >= 0 ? f!.tables?.[tIdx] : null;
		return { featureId: h.featureId, properties: h.featureId != null ? featureProperties(table, h.featureId) : {}, table: table ? { index: tIdx!, name: table.name, class: table.class } : null,
			tile: (n.owner ?? n).id, distance: h.w, lngLat: lngLatOfWorld(h.world), state: h.featureId != null ? { ...(set.states.get(h.featureId) || {}) } : {},
			tileMetadata: n.tileMeta ?? null, contentMetadata: n.contentMeta ?? null, groupMetadata: n.group != null ? n.scope?.groups[n.group] ?? null : null };   // metadata（3D Tiles 1.1）
	};
	// 出典（W8）＝表示しているタイルの glTF asset.copyright を「;」で割って数え、多い順（Google Map Tiles の表示の決まり）。
	//   opts.attribution＝文字列（そのまま）か関数（copyrights の列 → 文字列）。無ければ出典の欄に何も足さない（従来どおり）
	const copyrightsOf = (set: T3dSet, nodes: Iterable<T3dNode>) => {
		const cnt = new Map<string, number>();
		for (const n of nodes) for (const c of n.copyright || []) for (const p of String(c).split(";")) { const k = p.trim(); if (k) cnt.set(k, (cnt.get(k) || 0) + 1); }
		return [...cnt].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
	};
	const updateAttr = (set: T3dSet, shown: Set<T3dNode>) => {
		set.copyrights = copyrightsOf(set, shown);
		const a = set.opts.attribution, text = a == null ? null : typeof a === "function" ? (() => { try { return a(set.copyrights!); } catch (e) { console.error("[tiles3d] attribution", e); return null; } })() : String(a);
		if ((text ?? null) !== (set.attrText ?? null)) { set.attrText = text ?? null; setAttribution?.(set.id, set.attrText); }
	};
	const unload = (n: T3dNode) => {
		if (n.state !== "ready") return;
		if (n.ward) setMesh(n.ward, null);
		if (n.pts) for (const q of n.pts) n.set.pts?.post({ type: "remove", q });
		if (n.splat) for (const h of n.splat) { try { h.remove(); } catch (err) { console.warn("[tiles3d] splat remove", (err as Error)?.message || err); } }
		if (n.voxel) for (const h of n.voxel) { try { h.remove(); } catch (err) { console.warn("[tiles3d] voxel remove", (err as Error)?.message || err); } }
		gpuBytes -= n.bytes; mainBytes -= n.mainBytes; n.bytes = 0; n.mainBytes = 0; n.pts = null; n.splat = null; n.voxel = null; n.pick = null; n.paint = null; n.ward = null; n.state = "none"; n.on = false; n.set.stats.loaded--; n.set.ready.delete(n);
	};
	const setOn = (n: T3dNode, on: boolean) => {
		if (n.on === on || n.state !== "ready") return;
		n.on = on;
		if (n.ward) meshVis(n.ward, on);
		if (n.pts) for (const q of n.pts) n.set.pts?.post({ type: "vis", q, on });
		if (n.splat) for (const h of n.splat) h.setVisible(on);
		if (n.voxel) for (const h of n.voxel) h.setVisible(on);
	};

	// 選び（毎移動・rAF に畳む）
	let frameNo = 0;
	function update() {
		if (!sets.size) return;
		frameNo++;
		const W = size().w, H = size().h, s = cameraState(cam, W, H), planes = planesOf(s.mvp), eye = s.eye, fpx = s.focal / (cam.dpr || dpr || 1);
		// 読みたいタイル。並べ方＝親ごとの塊（2026-10-19）：gp＝親の SSE（塊の優先度）・g＝親（同じ親の兄弟を連続して投げる）・pri＝自分の SSE。
		// 旧＝自分の SSE だけで並べた＝兄弟の距離の差で他の塊と混ざって届き、塊が揃う（＝親から入れ替わる）のが遅れた
		const want: Array<{ n: T3dNode; pri: number; gp: number; g: number }> = [];
		for (const set of sets.values()) {
			if (!set.root || set.hidden) continue;
			const show = new Set<T3dNode>();
			const baseH = -set.opts.heightOffset, maxSSE = (set.opts.maxSSE ?? (lowMem ? 24 : 16)) * sseScale;
			const visible = (n: T3dNode): { ok: true; dist: number; distC?: number } | { ok: false } => {
				if (!n.sphere) return { ok: true, dist: 1 };
				const c = worldOf(n.sphere.c, baseH, ell, EARTH_M), r = n.sphere.r / EARTH_M;
				for (const p of planes) if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return { ok: false };
				// 地平線の向こう（球の裏側）＝地平面（接点の面 dot(X,E)=1）より向こうに境界球ごと居る
				const d = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]], dl = len(d), el = len(eye);
				if (el > 1 && (c[0] * eye[0] + c[1] * eye[1] + c[2] * eye[2]) / el + r < 1 / el) return { ok: false };
				return { ok: true, dist: Math.max(1e-9, dl - r) * EARTH_M, distC: Math.max(1e-9, dl) * EARTH_M };
			};
			const walk = (n: T3dNode, out: T3dNode[], gp = Infinity, sib = false): boolean => {   // 戻り＝描くべき物が全部揃ったか。gp＝親の SSE（読む順の塊の優先度）。sib＝親が中身を持つ REPLACE（この塊がそろうまで親が受け持つ）
				const g = n.parent?.id ?? 0;
				const v = visible(n);
				if (!v.ok) {
					// 画面外の兄弟（2026-10-20・本人報告「周回で遠方が一瞬白抜き」）：親が中身を持つ REPLACE の塊は、画面外の子も読んで
					// そろうのを待つ（描きはしない）＝Cesium の基本の巡回と同じ。旧＝画面外の子を「そろった」と数えた＝周回で視野へ入った子が
					// 未着だと、出ていた兄弟の塊ごと親へ巻き戻し、届くとまた子へ戻した（親の中身が粗い・疎だと一角が抜けて見える）
					if (!sib || n.i3s || n.external || (n.imp && !n.imp.st)) return true;
					n.used = frameNo;   // 塊の一員＝予算の追い出しでは「使っている」側
					const parts = n.extra ? (n.uri ? [n, ...n.extra] : n.extra) : n.uri ? [n] : [];
					let ok = true;
					for (const x of parts) { if (x.state === "none") want.push({ n: x, pri: 0, gp, g }); ok = (x.state === "ready" || x.state === "failed") && ok; }   // 同じ塊（g）で見えている兄弟と一緒に投げる
					return ok;
				}
				n.used = frameNo;
				if (n.i3s) {   // I3S＝境界球の画面上の直径が lodThreshold（px）を超えたら子へ（loaders.gl の i3s-lod と同じ規則）
					const diam = 2 * n.sphere!.r * fpx / v.distC!;
					if (diam < 2) return true;
					const need = (x: T3dNode) => { if (x.state === "none") want.push({ n: x, pri: diam, gp, g }); return x.state === "ready" || x.state === "failed"; };
					const dig = n.i3s.kids.length > 0 && diam > n.i3s.thr * (set.opts.lodScale ?? 1);
					if (!dig) { if (!n.uri) return true; const ok = need(n); if (n.state === "ready") out.push(n); return ok; }
					const kids = i3sKids(n);
					const mark = out.length;
					let all = !!kids;
					for (const k of kids || []) all = walk(k, out, diam) && all;
					if (all) return true;
					if (n.uri) { need(n); if (n.state === "ready") { out.length = mark; out.push(n); return true; } }
					return false;
				}
				const sse = n.ge * fpx / v.dist;
				if (n.external) { if (n.state === "none") loadExternal(n); return n.state === "failed"; }
				if (n.imp && !n.imp.st) { const st = impSubtree(n); if (st !== "ready") return st === "failed"; }   // subtree の根＝読めるまで中身も子も分からない（親を出したまま）
				const kids = kidsOf(n);
				const parts = n.extra ? (n.uri ? [n, ...n.extra] : n.extra) : n.uri ? [n] : [], has = parts.length > 0;   // タイルの content（複数 content＝extra も）
				const leaf = (!!kids && !kids.length) || (sse <= maxSSE && has);   // 中身を持たない節点（外部 tileset の口・空の根）は子へ降りる
				const settled = (x: T3dNode) => x.state === "ready" || x.state === "failed";
				const need = () => { let ok = true; for (const x of parts) { if (x.state === "none") want.push({ n: x, pri: sse, gp, g }); ok = settled(x) && ok; } return ok; };   // 戻り＝content が全部読めた（か失敗した）
				const ready = () => parts.every(settled) && parts.some(x => x.state === "ready");   // 出せる＝全部揃って 1 つは読めた
				const put = () => { for (const x of parts) if (x.state === "ready") out.push(x); };
				if (leaf) { if (!has) return true; const ok = need(); if (ready()) put(); return ok; }
				if (!kids) { if (has) { need(); if (ready()) put(); } return false; }   // 子がまだ分からない＝自分を出す
				if (n.refine === "ADD") {
					let ok = true;
					if (has) { ok = need(); if (ready()) put(); }
					for (const k of kids) ok = walk(k, out, sse) && ok;
					return ok;
				}
				const mark = out.length;
				let all = true;
				for (const k of kids) all = walk(k, out, sse, has) && all;
				if (all) return true;
				if (has) {   // 子が揃うまで親を出す（揃った子は伏せる＝重ねない）
					// 揃っていない兄弟は親が未着でも出さない（同じ親の子は揃った時に一度に入れ替える＝Cesium と同じ「塊で出る」・2026-10-19）。
					// 旧＝親より先に着いた子をばらばらに出し、親が着くと伏せ、子が揃うとまた出す＝描いては消す（表示切替と描き直しの空回り）。
					// 親が未着の間は祖父母（読めていれば）がこの塊を受け持つ。中身の無い親（空の根など）は従来どおり揃った子から出す（塊が巨大で何も出なくなる）
					out.length = mark;
					need();
					if (ready()) { put(); return true; }
					return false;
				}
				return false;
			};
			const out: T3dNode[] = [];
			walk(set.root, out);
			for (const n of out) show.add(n);
			// 出す/伏せる
			for (const n of set.loaded()) setOn(n, show.has(n));
			set.stats.shown = show.size;
			updateAttr(set, show);
		}
		if (frameNo % 64 === 0) for (const set of sets.values()) if (set.root) prune(set.root);   // implicit の部分木の刈り込み（時々）
		// 読む（SSE の大きい＝粗すぎて目立つ物から）
		want.sort((a, b) => b.gp - a.gp || a.g - b.g || b.pri - a.pri);   // 親の SSE の大きい塊から・同じ親の兄弟は続けて・塊の中は自分の SSE 順
		// 塊ごとに投げる（2026-10-19）：want は塊順（同じ親の兄弟が続く）＝上限の枠が空くたびに同じ塊の続きから投げる＝塊は切れ目なく揃う。
		// 旧＝塊の始めだけ上限を見て、兄弟は上限を越えても一緒に投げた＝同時取得が「上限 + 一番大きな塊 − 1」まで伸び（兄弟 48 枚で 49 本・iPhone の 3 本は効かない）、
		// model worker の外部メモリ（取った本体＋解く途中の配列）の山が 2 倍になった（2026-10-20 の総点検・合成 48 枚で 244 MB → 123 MB・初回表示は遅くならない）
		for (const w of want) { if (inflight >= maxInflight()) break; load(w.n); }
		// 予算＝使っていない物（今回選ばれず表示もしていない）から古い順に捨てる。量＝GPU へ送った分＋main に残る写し（2026-10-20）。
		// 今回の選びで塊の一員だった物（used === frameNo・兄弟が揃うのを待って伏せている子）は捨てない（2026-10-20）：旧＝伏せている子も捨てた＝
		// 揃いかけの塊が予算を越えると、着いた兄弟を捨てては取り直す空回り（合成 48 枚・lowMem 160 MB で 150 s に 5.4 GB を取り直し・表示は根のまま・
		// render worker の受け箱が 760 MB まで膨らむ）。塊が予算を越える時は越えたまま揃えて出す（表示中の物を捨てないのと同じ扱い）
		if (gpuBytes + mainBytes > BUDGET) {
			const cand = [...sets.values()].flatMap(s2 => s2.loaded()).filter(n => !n.on && n.used !== frameNo).sort((a, b) => a.used - b.used);
			for (const n of cand) { if (gpuBytes + mainBytes <= BUDGET * 0.85) break; unload(n); }
		}
		// 予算の SSE 引き上げ／戻し（上の sseScale の注釈）。上げたら選び直す（止まっていても効く）・戻すのは今回の選び（動いた時）の分だけ
		if (gpuBytes + mainBytes > BUDGET) { if (sseScale < 16) { sseScale = Math.min(16, sseScale * 1.25); schedule(); } }
		else if (sseScale > 1 && moved && performance.now() - sseDownAt > 1000) {
			let live = 0;
			for (const set of sets.values()) for (const n of set.loaded()) if (n.on || n.used === frameNo) live += n.bytes + n.mainBytes;
			if (live < BUDGET * 0.7) { sseScale = sseScale * 0.9 < 1.05 ? 1 : sseScale * 0.9; sseDownAt = performance.now(); }
		}
		moved = false;
	}

	const onMove = () => { moved = true; schedule(); };
	map.on("move", onMove); map.on("settle", onMove);
	const ctl = {
		// url＝tileset.json。opts＝{ maxSSE:16, heightOffset:0（m・高さへの足し込み）, ground:"absolute"|"terrain"（1 棟ずつ地面へ接地）, pointSize:1.5（px）, textures:true, fit:true（寄る）, maxInflight（同時取得数・既定 lowMem 3／他 6）}
		async add(url: string, opts: Tiles3DOptions = {}): Promise<T3dHandle> {
			const abs = /^[a-z][\w+.-]*:\/\//i.test(url) ? new URL(url) : new URL(url, location.href);
			const j = await getJSON(abs.href, "Source", opts.requestTransform);
			if (!j.root) throw new Error("not a 3D Tiles tileset (no root)");
			const id = opts.id ?? `t${++seq}`;
			if (sets.has(id)) ctl.remove(id);
			const set = { id, url: abs.href, opts: { heightOffset: 0, ...opts }, stats: { loaded: 0, shown: 0, failed: 0, triangles: 0, points: 0, splats: 0, voxels: 0, bytes: 0, subtrees: 0 }, states: new Map(), ready: new Set(), query: [...abs.searchParams], pts: null, removed: false, hidden: false,
				asset: j.asset ?? null, metadata: j.metadata ?? null, extras: j.extras ?? j.asset?.extras ?? null, extensionsUsed: j.extensionsUsed ?? [], extensionsRequired: j.extensionsRequired ?? [] } as T3dSet;   // root の見出し（F5）＝手綱から読める
			set.scope = await scopeOf(j, abs.href, opts.requestTransform);
			// voxel の tileset（Cesium の経路＝root.content の 3DTILES_content_voxels が dimensions／padding／class を宣言し、タイルの glb は属性だけ・形はタイルの境界体積）
			const vd = (j.root?.content as { extensions?: Record<string, unknown> } | undefined)?.extensions?.["3DTILES_content_voxels"] as { dimensions?: number[]; padding?: { before?: number[]; after?: number[] } } | undefined;
			set.voxDecl = vd && Array.isArray(vd.dimensions) ? { dimensions: vd.dimensions, padding: vd.padding } : null;
			set.styleSpec = opts.style ?? null; set.style = styleOf(opts.style);
			set.root = tileNode(j.root, I4, abs.href, set, null, set.scope);
			if (!set.root.ge) set.root.ge = j.geometricError ?? 0;
			set.loaded = () => [...set.ready];   // 中身が上がっている節点（load／unload が保つ＝毎回木を歩かない）
			sets.set(id, set);
			const sp = set.root.sphere;
			if (opts.fit !== false && sp) {   // 寄る＝境界球が画面に収まる所へ（傾けて）
				const [lon, lat] = ecef2geo(sp.c[0], sp.c[1], sp.c[2]);
				const z = Math.log2(Math.min(size().w, size().h) / (cam.dpr || dpr || 1) * 360 / (256 * Math.max(1e-6, 2.4 * sp.r / 111320)));
				map.flyTo(lon * R2D, lat * R2D, Math.max(2, Math.min(18, z)), 50);
			}
			schedule();
			return { id, get stats() { return { ...set.stats, gpuMB: +(gpuBytes / 1048576).toFixed(1), mainMB: +(mainBytes / 1048576).toFixed(1), inflight, sseScale: +sseScale.toFixed(2) } }, get bbox() { return sp ? (() => { const [lo, la] = ecef2geo(sp.c[0], sp.c[1], sp.c[2]), d = sp.r / 111320; return [lo * R2D - d / Math.cos(la), la * R2D - d, lo * R2D + d / Math.cos(la), la * R2D + d] as Bbox; })() : null; },
				get tiles() { return set.loaded().map(n => ({ id: n.id, uri: n.uri?.split("/").pop(), on: n.on, ward: n.ward, meshes: n.meshN, pts: n.pts?.length || 0, splats: n.splat?.length || 0, voxels: n.voxel?.length || 0, bbox: n.bbox })); },   // 検分用
				get asset() { return set.asset!; }, get metadata() { return set.metadata!; },
				/** metadata（3D Tiles 1.1）：schema・tileset の metadata を schema で読んだ物・groups */
				get schema() { return (set.scope?.schema ?? null) as Record<string, unknown> | null; }, get tilesetMetadata() { return entityOf(set.metadata as MetadataEntityJson | null, set.scope?.schema); }, get groups() { return [...(set.scope?.groups || [])]; }, get extras() { return set.extras!; }, get extensionsUsed() { return [...set.extensionsUsed!]; }, get extensionsRequired() { return [...set.extensionsRequired!]; },   // root の見出し（F5）
				remove: () => ctl.remove(id), setVisible: v => { set.hidden = !v; for (const n of set.loaded()) setOn(n, false); schedule(); },
				setOptions: o => { Object.assign(set.opts, o); if ("style" in o) setStyle(set, o.style); schedule(); },
				/** スタイル（地物ごとの color・show を MapLibre の式で）。null で外す */
				setStyle(style) { setStyle(set, style); return this; }, get style() { return set.styleSpec ?? null; },
				// 当たりと feature state（W7）＝EXT_mesh_features／_BATCHID の番号。色は { color } を頂点色へ（他の鍵は保つだけ）。状態は tileset ごと（タイルを跨いで同じ番号＝同じ地物）
				pick: (x, y) => pickSet(set, x, y),
				/** 表示しているタイルの出典（glTF asset.copyright・多い順・W8） */
				get copyrights() { return [...(set.copyrights || [])]; },
				setFeatureState(fid, state) { if (fid == null) return this; const nx = state == null ? {} : { ...(set.states.get(+fid) || {}), ...state }; if (Object.keys(nx).length) set.states.set(+fid, nx); else set.states.delete(+fid); for (const n of set.loaded()) paintNode(n); return this; },
				getFeatureState: fid => ({ ...(set.states.get(+fid) || {}) }),
				removeFeatureState(fid) { if (fid == null) set.states.clear(); else set.states.delete(+fid); for (const n of set.loaded()) paintNode(n); return this; } } satisfies T3dHandle;
		},
		// I3S（#48）：url＝…/SceneServer（layers/0 を補う）か …/SceneServer/layers/N。opts＝add と同じ＋lodScale（>1 で粗く・<1 で細かく）・token
		async addI3S(url: string, opts: I3SOptions = {}): Promise<I3SHandle> {
			let u = String(url), e = u.length; while (e > 0 && u.charCodeAt(e - 1) === 47) e--; u = u.slice(0, e); if (/\/SceneServer$/i.test(u)) u += "/layers/0";   // 末尾の "/" を落とす（旧 replace(/\/+$/) は "/" の長い列で二乗＝CodeQL の polynomial-redos）
			const abs = new URL(u, location.href).href;
			const info = await rpc<I3SInfo>({ kind: "i3sOpen", url: abs, token: opts.token });
			const id = opts.id ?? `i${++seq}`;
			if (sets.has(id)) ctl.remove(id);
			const set = { id, kind: "i3s", url: abs, opts: { heightOffset: 0, ...opts }, stats: { loaded: 0, shown: 0, failed: 0, triangles: 0, points: 0, splats: 0, voxels: 0, bytes: 0, subtrees: 0 }, states: new Map(), ready: new Set(), query: [] as Array<[string, string]>, pts: null, removed: false, hidden: false, name: info.name, copyright: info.copyright } as T3dSet;
			set.root = i3sNode(info.root, set, null);
			set.loaded = () => [...set.ready];
			sets.set(id, set);
			const sp = set.root.sphere;
			if (opts.fit !== false && sp) { const z = Math.log2(Math.min(size().w, size().h) / (cam.dpr || dpr || 1) * 360 / (256 * Math.max(1e-6, 2.4 * sp.r / 111320))); map.flyTo(info.root.c[0], info.root.c[1], Math.max(2, Math.min(18, z)), 50); }
			schedule();
			return { id, name: info.name, copyright: info.copyright, get stats() { return { ...set.stats, gpuMB: +(gpuBytes / 1048576).toFixed(1), mainMB: +(mainBytes / 1048576).toFixed(1), inflight, sseScale: +sseScale.toFixed(2) } },
				remove: () => ctl.remove(id), setVisible: v => { set.hidden = !v; for (const n of set.loaded()) setOn(n, false); schedule(); }, setOptions: o => { Object.assign(set.opts, o); schedule(); } };
		},
		remove(id: string) {
			const set = sets.get(id); if (!set) return;
			set.removed = true;
			for (const n of set.loaded()) unload(n);
			set.pts?.remove();
			if (set.attrText) setAttribution?.(id, null);
			sets.delete(id);
		},
		get ids() { return [...sets.keys()]; },
		pickAll(x: number, y: number) { return [...sets.values()].filter(s => !s.hidden).map(s => { const h = pickSet(s, x, y); return h && { id: s.id, ...h }; }).filter(Boolean); },   // 全 tileset の当たり（W7・queryRenderedFeatures が使う）
		destroy() { for (const id of [...sets.keys()]) ctl.remove(id); pool.destroy(); map.off("move", onMove); map.off("settle", onMove); },
	};
	signal?.addEventListener("abort", () => ctl.destroy(), { once: true });
	return ctl;
}
