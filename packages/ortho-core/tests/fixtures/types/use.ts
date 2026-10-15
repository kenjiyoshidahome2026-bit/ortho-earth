// 型の門の素材：公開の口を TypeScript から呼ぶ（tsc --noEmit で型が通ることだけを見る・実行しない）。
import { cameraState, project, unproject, evalExpr, geodesicDistance, parseRGBA, parseViewHash, buildViewHash, WORLD_PX, registerTileFormat, normalizeMLLayer, createFlight, createInput } from "@ortho-earth/core";
import type { CameraPose, CameraState, ExprContext, MLLayer } from "@ortho-earth/core";
import { geodesicArea } from "@ortho-earth/core/geodesic";
import { clipBox, CLIP_MAX } from "@ortho-earth/core/clip";
import { lonlatTo3D } from "@ortho-earth/core/camera";
import { KNOWN_OPS } from "@ortho-earth/core/expr";
import { wmsTemplate } from "@ortho-earth/core/raster-src";

const cam: CameraPose = { center: [139.767, 35.681], zoom: 12, pitch: 0.5, bearing: 0 };
const st: CameraState = cameraState(cam, 800, 600);
const xy: [number, number] | null = project(st, 139.7, 35.6);
const ll = unproject(st, 400, 300);
const px: 256 = WORLD_PX;
const ctx: ExprContext = { zoom: 12, props: { name: "x" }, origin: "ml" };
const v = evalExpr<string>(["get", "name"], ctx);
const d: number = geodesicDistance([139, 35], [140, 36]);
const a: number = geodesicArea([[139, 35], [140, 35], [140, 36], [139, 35]]);
const c = parseRGBA("#ff000080");
const h: string = buildViewHash(cam);
const parsed = parseViewHash(h);
registerTileFormat({ name: "mvt", pmtilesType: 1 });
const L: MLLayer = normalizeMLLayer({ id: "a", type: "fill", filter: ["==", "k", 1] }, 1);
const planes = clipBox({ center: [139.7, 35.7], size: [100, 100] });
const n: 6 = CLIP_MAX;
const p3 = lonlatTo3D(0, 0);
const known: boolean = KNOWN_OPS.has("get");
const tpl: string = wmsTemplate({ url: "https://x/wms", layers: "a" });
declare const canvas: HTMLCanvasElement;
const fc = createFlight({ cam, viewW: () => 800, maxPitch: 1.3, onMove: () => {} });
const ic = createInput({ canvas, cam, size: { w: 800, h: 600 }, dpr: 1, maxPitch: 1.3, onMove: () => {} });
void [xy, ll, px, v, d, a, c, parsed, L, planes, n, p3, known, tpl, fc.active, ic.evXY];

// A1: roll は CameraPose の任意項・parseViewHash は roll を返す
const rolled = cameraState({ center: [0, 0], zoom: 3, roll: 0.1 }, 10, 10);
const rollVal: number = rolled.camDist;
void rollVal;

// A2: 慣性の純関数と handler 名
import { inertiaOf, INERTIA, snapZoom, type HandlerName } from "@ortho-earth/core";
const inr = inertiaOf([{ t: 0, v: 10 }, { t: 50, v: 10 }], 60, INERTIA.rotate);
const hn: HandlerName = "scrollZoom";
void [inr?.dur, snapZoom(3.3, 0.5), hn];

// 段 2（2.0）：契約を正した口
import { projectClip, viewRays, sphereRayUniforms, anchorUV, ellAxisRatio, featureGeomLL, withinGeom, distanceGeom, setWorkerFactory } from "@ortho-earth/core";
import type { WorkerRole, GeoJSONGeometry } from "@ortho-earth/core";
import { normPost, TONEMAP_MODES, LUT_SIZES } from "@ortho-earth/core/postfx";
import { lerpColorLab, lerpColorHcl } from "@ortho-earth/core/expr";
import { worldAtlasCell, decodeName, createGetHeight, createTileLoader, staleDSM, WORLD_ATLAS_CELL } from "@ortho-earth/core/elevation";
import type { AltTile } from "@ortho-earth/core/elevation";
import { paintKeys, compileFidStyleWGSL, buildPropColumns, Dict } from "@ortho-earth/core/fidexpr";
import { createGintLayerGPU, createRendererGPU } from "@ortho-earth/core/gpu";
import { createLabelLayer } from "@ortho-earth/core/labels";
import { WORLD_DATA, loadNames } from "@ortho-earth/core/worldcontent";
import type { RGBA } from "@ortho-earth/core/color";
// camera.js は根から全部（projectClip など）
const clip4: number[] = projectClip(st, 139.7, 35.6);
const rays = viewRays(st.mvp, st.invMvp!);
const sru = sphereRayUniforms(st, [1, 0, 0]);
const auv: number[] = anchorUV([1, 0, 0], [0, 0, 1, 1]);
const ratio: number = ellAxisRatio();
// parseRGBA は配列を素通し・null は返さない
const black: RGBA = parseRGBA(42);
const passed: readonly [number, number, number, number] = parseRGBA([1, 0, 0, 1] as const);
const r0: number = parseRGBA("red")[0];
// 式の地理
const geom: GeoJSONGeometry | null = featureGeomLL(ctx);
const inside: boolean = withinGeom({ type: "Point", coordinates: [0, 0] }, [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]);
const dist: number | null = distanceGeom(geom, { type: "Point", coordinates: [1, 1] });
// worker 工場は役割だけを受け取る
const role: WorkerRole = "ortho:height";
setWorkerFactory(r => (r === role ? null : undefined));
setWorkerFactory(null);
// postfx：fxaa/tonemap/lut
const np = normPost({ bloom: true, fxaa: true, tonemap: { mode: "agx", exposure: 1.2 }, lut: { url: "x.cube", size: 32 } });
const tm: string | undefined = np?.tonemap?.mode;
const modes: readonly string[] = TONEMAP_MODES;
const sizes: readonly number[] = LUT_SIZES;
// 色の補間
const lab: string = lerpColorLab("red", "#00f", 0.5);
const hcl: string = lerpColorHcl([1, 0, 0, 1], "blue", 0.5);
// 標高
declare const atlas: AltTile;
const cell: Float32Array = worldAtlasCell(atlas, 2, 1, 256);
const big = new Float32Array(1024 * 512);
worldAtlasCell(atlas, 0, 0, 256, big, 1024, 0, 256);
const nm: [number, number, number] = decodeName("R90N000E000");
const cellN: number = WORLD_ATLAS_CELL;
const stale: boolean = staleDSM("R10N030E130", atlas, { brand: "GSI", range: 10, bbox: [122, 20, 154, 46] });
async function heights() {
	const gh = await createGetHeight({ level1: 7, level2: 12 });
	const h: number = await gh(139.7, 35.6, 14, { wait: true });
	gh.terminate();
	const load = await createTileLoader({ apiUrl: "https://x/" });
	const t: AltTile | null = await load(130, 30, 10);
	const w: AltTile | null = await load.byName("WORLD1024_1");
	void [h, t, w];
}
// fidexpr：paintKeys(paint, filter)・compile の戻り
const keys = paintKeys({ "fill-color": ["get", "c"] }, ["==", ["get", "k"], 1]);
const hasK: boolean = keys.props.has("k");
const dict = new Dict();
const cols = buildPropColumns([{ properties: { c: "red" } }], [...keys.props], dict);
const compiled = compileFidStyleWGSL({ "fill-color": ["get", "c"] }, null, { dict, kinds: cols.kinds });
const code: string | null = "wgsl" in compiled ? compiled.wgsl : null;
// gpu：createGintLayerGPU は renderer を受け取る
async function gpuLayer() { const ren = await createRendererGPU(canvas); return createGintLayerGPU(ren, { quad4: true, layerH: 0 }); }
// labels：glyphAtlas・lineFlatPx
const ll2 = createLabelLayer(canvas, { glyphAtlas: false, lineFlatPx: [4, 6] });
// worldcontent
const wd: string = WORLD_DATA;
const names = loadNames("ja", ["NationDB"]);
void [clip4, rays.F, sru.c, auv, ratio, black, passed, r0, inside, dist, tm, modes, sizes, lab, hcl, cell, nm, cellN, stale, heights, hasK, code, gpuLayer, ll2, wd, names];
