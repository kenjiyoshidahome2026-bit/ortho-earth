// plugin 契約・registry・capabilities（拡張点の整備・第 2 波 PR-F0・2026-10-12）
// 方針（本人裁定 2026-10-12）：機能そのものを先に作るのではなく、「個別の機能を実装すればそれが実現できる口」を明示的に用意する。
// ここはその土台＝
//   definePlugin({ name, install(map, opts), uninstall? })  … 拡張の形を 1 つに（地域パック・gadget・addData の kind・タイル形式・後処理・光源が同じ門をくぐる）
//   map.use(p, opts) / map.unuse(name) / map.plugins()      … 搭載・撤去・一覧。install が返した関数は撤去の時に呼ぶ（uninstall が無い時）
//   map.registry.<kind>                                      … 名前→実装の表。dataKinds（map.addData の kind）・gadgets（map.gadget）・tileFormats（core の registerTileFormat）・lights（F1）・clouds（F2）・postEffects（F3）・handlers（F6）は結線済み、
//                                                              lights（F1）・clouds（F2）・postEffects（F3）は結線済み（plugin の type＝{ apply(map, …) } を set〜 が呼ぶ）、textureTranscoders（F4）は表だけ先に在る（登録は受けて保つ・絵はまだ変わらない＝capabilities は "spec"）
//   map.supports(key) / map.capabilities()                   … 正直な答え。"builtin"＝今の版で絵が出る・"plugin"＝搭載した plugin が担う・"spec"＝口は受けて保つが絵は変わらない・
//                                                              "no"＝口も無い（後の PR の番号を note に）・"never"＝作らない（Mercator＝常に地球儀）。supports は builtin|plugin の時だけ true
// 台帳＝packages/globe/maplibre-compat.md §9「拡張点の台帳」。DOM も worker も触らない純関数＝tests/plugin.mjs（node）で検める。

import type { Capability, CapabilityKey, MapRegistry, OrthoPlugin, PluginRegistry } from "../globe.d.ts";
import type { GlobeMap } from "./types/map.ts";

const NAME_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i;

export function definePlugin<O = Record<string, unknown>>(spec: OrthoPlugin<O> | Readonly<OrthoPlugin<O>>): Readonly<OrthoPlugin<O>> {
	if (!spec || typeof spec !== "object") throw new Error("definePlugin: spec object is required");
	if (typeof spec.name !== "string" || !NAME_RE.test(spec.name)) throw new Error(`definePlugin: name must match ${NAME_RE} (got ${JSON.stringify(spec.name)})`);
	if (typeof spec.install !== "function") throw new Error(`definePlugin("${spec.name}"): install(map, opts) is required`);
	if (spec.uninstall != null && typeof spec.uninstall !== "function") throw new Error(`definePlugin("${spec.name}"): uninstall must be a function`);
	return Object.freeze({ version: null, provides: [], ...spec });
}

// 名前→実装の表。builtin＝この版が持つ物（上書き・撤去は不可）。wired＝実際に効く（false＝受けて保つだけ）
// liveBuiltin()＝実行時に増える builtin の名前（map.gadget の鍵＝起動後も gadget が足される）
/** 表の 1 件（impl＝builtin は null・plugin＝登録した plugin の名） */
interface RegEntry<T> { impl: T | null; builtin: boolean; plugin: string | null }
/** 表（公開の PluginRegistry＋install の持ち主を付け外しする内部の口） */
export interface RegistryImpl<T> extends Omit<PluginRegistry<T>, "add"> {
	add(name: string, impl: T): RegistryImpl<T>;
	_setCurrent(p: string | null): void;
	_dropOwned(p: string): void;
}
interface RegistryOpts<T> {
	wired?: boolean; builtin?: ReadonlyArray<string | { name: string; impl?: T | null }>; liveBuiltin?: (() => string[]) | null;
	onAdd?: ((name: string, impl: T) => void) | null; onRemove?: ((name: string, impl: T | null) => void) | null; pending?: string;
}
function createRegistry<T>(kind: string, { wired = true, builtin = [], liveBuiltin = null, onAdd = null, onRemove = null, pending = "" }: RegistryOpts<T> = {}): RegistryImpl<T> {
	const entries = new Map<string, RegEntry<T>>();
	for (const b of builtin) entries.set(typeof b === "string" ? b : b.name, { impl: typeof b === "string" ? null : b.impl ?? null, builtin: true, plugin: null });
	const live = () => (liveBuiltin?.() ?? []).filter(n => !entries.has(n));
	let current: string | null = null;   // いま install 中の plugin の名前（登録の持ち主）
	const reg: RegistryImpl<T> = {
		kind, wired, pending,
		add(name: string, impl: T) {
			if (typeof name !== "string" || !name) throw new Error(`registry.${kind}.add: name is required`);
			if (impl == null) throw new Error(`registry.${kind}.add("${name}"): implementation is required`);
			if (entries.has(name) || live().includes(name)) throw new Error(`registry.${kind}: "${name}" already exists${entries.get(name)?.builtin ?? true ? " (builtin)" : ""}`);
			onAdd?.(name, impl);
			entries.set(name, { impl, builtin: false, plugin: current });
			return reg;
		},
		remove(name: string) {
			const e = entries.get(name);
			if (!e) return false;
			if (e.builtin) throw new Error(`registry.${kind}: "${name}" is builtin`);
			onRemove?.(name, e.impl);
			entries.delete(name);
			return true;
		},
		get: (name: string) => entries.get(name)?.impl,
		has: (name: string) => entries.has(name) || live().includes(name),
		isBuiltin: (name: string) => !!entries.get(name)?.builtin || live().includes(name),
		ownerOf: (name: string) => entries.get(name)?.plugin ?? null,
		names: () => [...live(), ...entries.keys()],
		_setCurrent: (p: string | null) => { current = p; },
		_dropOwned(p: string) { for (const [n, e] of [...entries]) if (!e.builtin && e.plugin === p) { try { onRemove?.(n, e.impl); } catch { /* 撤去は進める */ } entries.delete(n); } },
	};
	return reg;
}

// 静的な答え（この版の事実）。dynamic な鍵（data.*・gadget.*・tiles.*・post.*・light.*・texture.*・render.webgpu・pointcloud.laz）は capabilities() が足す
export const STATIC_CAPABILITIES: Readonly<Record<CapabilityKey, Capability>> = Object.freeze({
	"projection.globe": { status: "builtin", note: "always a globe (ortho/perspective continuum; ellipsoid via opts.ellipsoid)" },
	"projection.mercator": { status: "never", note: "not built by design (compat.md section 4, 2026-10-12)" },
	"camera.roll": { status: "builtin", note: "setRoll/getRoll, setVerticalFieldOfView (A1)" },
	"camera.lookAt": { status: "builtin", note: "lookAt/follow/setCamera/getCamera (A4)" },
	"camera.constrain": { status: "builtin", note: "setConstrain (= setTransformConstrain), padding, setCenterElevation (A3)" },
	"camera.walk": { status: "builtin", note: "map.walk(opts): first-person walk (W3) with WASD/arrows, mouse look, terrain under foot and simple building collision; a plugin registered in registry.handlers as \"walk\" takes over" },
	"handlers": { status: "builtin", note: "inertia, double-click, box zoom, keyboard, setHandler (A2)" },
	"style.transition": { status: "builtin", note: "paint transitions, default 300ms (B1)" },
	"style.diff": { status: "builtin", note: "setStyle diff (B2)" },
	"light.directional": { status: "builtin", note: "setLight = MapLibre light (B3); also setLights([{ type: \"directional\" }]) (F1)" },
	"light.point": { status: "builtin", note: "setLights: shades meshes (models, LOD2 buildings) on WebGL2 and WebGPU, up to 8 local lights (W2)" },
	"light.spot": { status: "builtin", note: "setLights: direction or target, angle/penumbra, range/decay; meshes only (W2)" },
	"light.ambient": { status: "builtin", note: "setLights: adds to mesh shading regardless of normal (W2)" },
	"light.hemisphere": { status: "builtin", note: "setLights: skyColor/groundColor mixed by the normal's up component; meshes only (W2)" },
	"light.ibl": { status: "spec", note: "accepted and kept by setLights (F1); HDR environment not loaded yet" },
	"sky": { status: "builtin", note: "setSky (B4): simple sky on GL2, fog on both renderers" },
	"sun.direction": { status: "builtin", note: "getSunPosition/getMoonPosition (ephem) and setSun (drives the directional light) (F2)" },
	"clouds": { status: "builtin", note: "setClouds({ type: \"image\", url, altitude, opacity, color, wind }) draws a global equirectangular cloud image as a shell above the globe, drifting with wind (W6); procedural clouds and precipitation are kept but not drawn (see clouds.procedural / precipitation). A plugin can take over via registry.clouds" },
	"clouds.procedural": { status: "spec", note: "coverage/density/thickness without an image are kept (F2); not drawn" },
	"precipitation": { status: "spec", note: "setClouds({ precipitation }) is kept (F2); rain/snow are not drawn" },
	"background": { status: "builtin", note: "background layer, setClearColor (B5)" },
	"post.chain": { status: "builtin", note: "setPostChain/getPostChain: ordered passes; bloom, vignette, fxaa, tonemap and lut render (fixed order fxaa→bloom→tonemap→lut→vignette), smaa/dof/ssr are kept (F3, W1)" },
	"post.bloom": { status: "builtin", note: "setPostProcess / setPostChain (PR-8)" }, "post.vignette": { status: "builtin", note: "setPostProcess / setPostChain (PR-8)" },
	"post.fxaa": { status: "builtin", note: "FXAA 3.11 (reduced) on the scene color, WebGL2 and WebGPU (W1)" }, "post.smaa": { status: "spec", note: "accepted and kept (F3); not rendered yet" },
	"post.tonemap": { status: "builtin", note: "linear/reinhard/aces/agx/filmic + exposure on the LDR scene color, WebGL2 and WebGPU (W1)" }, "post.lut": { status: "builtin", note: "3D LUT (.cube or a size²×size strip image), WebGL2 and WebGPU (W1)" },
	"post.dof": { status: "spec", note: "accepted and kept (F3); needs a real-GPU pass" }, "post.ssr": { status: "spec", note: "accepted and kept (F3); needs a real-GPU pass" },
	"gltf.model": { status: "builtin", note: "glb models (gadget model, 3D Tiles b3dm/glb)" },
	"gltf.meta": { status: "builtin", note: "model handle .gltf / .animations: animations, skins, morph targets, extensions, texture formats, feature ids (F4)" },
	"gltf.animation": { status: "builtin", note: "rigid node animation (translation/rotation/scale; LINEAR/STEP/CUBICSPLINE) played by the model handle setAnimation/play/stop (W4); skins and morph targets are not applied (see gltf.skin / gltf.morph)" },
	"gltf.skin": { status: "spec", note: "skinned meshes (joints/weights) are drawn in their rest pose; .gltf.skins counts them (F4)" },
	"gltf.morph": { status: "spec", note: "morph targets are not applied; .gltf.morphTargets reports them (F4)" },
	"gltf.featureIds": { status: "builtin", note: "EXT_mesh_features feature IDs (attribute _FEATURE_ID_n or implicit) and 3D Tiles 1.0 _BATCHID: model handle / 3D Tiles handle pick(x, y) -> { featureId, properties }, queryRenderedFeatures (layer \"model\" or the tileset id), setFeatureState(id, { color }) (W7)" },
	"gltf.featureIds.texture": { status: "spec", note: "feature ID textures (featureIds[].texture) are detected but not sampled; those features pick as null (W7)" },
	"gltf.structuralMetadata": { status: "builtin", note: "EXT_structural_metadata property tables (SCALAR/VECn/MATn/STRING/BOOLEAN/ENUM, fixed and variable arrays, offset/scale/normalized) and b3dm batch tables become pick properties; property textures and attributes are not read (W7)" },
	"texture.ktx2": { status: "spec", note: "KHR_texture_basisu textures are transcoded in the worker by the module registered as registry.textureTranscoders \"ktx2\" ({ url } exporting transcode(bytes) -> { width, height, rgba }; W5); none registered = the fallback image is used. @ortho-earth/ktx2 provides one (basis_universal WASM, opt-in)" },
	"tiles3d": { status: "builtin", note: "add3DTiles (b3dm/i3dm/cmpt/glb), addI3S" },
	"tiles3d.requestTransform": { status: "builtin", note: "add3DTiles(url, { requestTransform(url, type) }) rewrites every tileset/tile request (key, session, signed URLs, headers); root asset/metadata/extras on the handle (F5)" },
	"tiles3d.attribution": { status: "builtin", note: "add3DTiles(url, { attribution: text | (copyrights) => text }) shows the data providers of the tiles on screen (glTF asset.copyright, most frequent first) in the attribution panel; handle.copyrights (W8)" },
	"terrain.dem": { status: "builtin", note: "setTerrain (raster-dem, quantized-mesh)" },
	"terrain.queryElevation": { status: "builtin", note: "queryTerrainElevation (sync, 100m grid cache)" },
	"terrain.sample": { status: "builtin", note: "sampleTerrain(positions) resolves heights from the drawn terrain (DEM first, then the default DTM) (F6)" },
	"picking": { status: "builtin", note: "unified picking (map.on(ev, id), queryRenderedFeatures, pickOverlays)" },
	"three": { status: "builtin", note: "map.addThree (three.js inside the render worker)" },
	"h3": { status: "builtin", note: "@ortho-earth/h3" },
	"data.splat": { status: "spec", note: "Gaussian splat: addData(data, { kind: \"splat\" }) accepts SplatData / .ply .splat .spz .ksplat .sog URLs and validates the contract (F8); sorting and drawing come from a plugin registered in registry.dataKinds as \"splat\"" },
	"data.voxel": { status: "spec", note: "voxel grid: addData(data, { kind: \"voxel\" }) accepts VoxelData (box | region, dims, values) / .nc .zarr .vox .npy URLs and validates the contract (V0); ray marching (volume / blocks / iso) comes from a plugin registered in registry.dataKinds as \"voxel\" (@ortho-earth/voxel); 3D Tiles whose glTF carries EXT_primitive_voxels (KHR_implicit_shapes box / EXT_implicit_ellipsoid_region, or the tileset's 3DTILES_content_voxels) become one layer per tile (add3DTiles opts.voxel)" },
	"react": { status: "builtin", note: "@ortho-earth/react: <Globe> <Source> <Layer> <Data> <Marker>, useGlobe, useGlobeEvent (F9)" },
	"types.core": { status: "builtin", note: "core d.ts (PR-0 #256)" },
	"types.globe": { status: "builtin", note: "globe.d.ts" },
	"types.shim": { status: "builtin", note: "maplibre.d.ts for @ortho-earth/globe/maplibre (exports types; gate tests/mlshim-dts.mjs) (F10)" },
	"plugin": { status: "builtin", note: "definePlugin, map.use, registry (PR-F0)" },
});

// 登録は受けて保つが絵はまだ変わらない表の答え
const specOf = <T>(reg: RegistryImpl<T>, name: string): Capability => ({ status: reg.wired ? "plugin" : "spec", via: reg.ownerOf(name), note: reg.wired ? `registry.${reg.kind}` : `registered in registry.${reg.kind}; rendering lands in ${reg.pending}` });

// host＝map 本体が渡す今の事実。getBackend()＝"webgl2"|"webgpu"|null、gadgetNames()＝map.gadget の鍵、tileFormats＝core の { names(), register(spec), has(name) }、pointcloud＝"#pointcloud-formats" の表
/** registry の各表の実装の型（MapRegistry の PluginRegistry<T> の T） */
type ImplOf<K extends keyof MapRegistry> = MapRegistry[K] extends PluginRegistry<infer T> ? T : never;
/** createPluginHost が map 本体から受ける今の事実 */
export interface PluginHostOptions {
	getBackend?: () => string | null; gadgetNames?: () => string[];
	defineGadget?: ((name: string, impl: ImplOf<"gadgets">) => void) | null; removeGadget?: ((name: string) => void) | null;
	/** core の { names(), register(spec), has(name) } */
	tileFormats?: { names(): string[]; register(spec: { name: string } & ImplOf<"tileFormats">): unknown; has(name: string): boolean } | null;
	/** "#pointcloud-formats" の表（名前 → 在る） */
	pointcloud?: Record<string, unknown> | null;
	builtinDataKinds?: readonly string[]; builtinPostEffects?: readonly string[]; builtinLights?: readonly string[]; builtinTileFormats?: readonly string[];
}
/** 搭載中の plugin の 1 件 */
interface Installed { spec: Readonly<OrthoPlugin<unknown>>; opts: unknown; cleanup: (() => void) | null }
export function createPluginHost(map: GlobeMap, { getBackend = () => null, gadgetNames = () => [], defineGadget = null, removeGadget = null, tileFormats = null, pointcloud = null, builtinDataKinds = [], builtinPostEffects = [], builtinLights = [], builtinTileFormats = [] }: PluginHostOptions = {}) {
	const plugins = new Map<string, Installed>();   // name → { spec, opts, cleanup }
	const registry = Object.freeze({
		dataKinds: createRegistry<ImplOf<"dataKinds">>("dataKinds", { builtin: builtinDataKinds }),
		gadgets: createRegistry<ImplOf<"gadgets">>("gadgets", { liveBuiltin: gadgetNames, onAdd: (name, impl) => { if (typeof impl !== "function") throw new Error(`registry.gadgets.add("${name}"): a function is required`); defineGadget?.(name, impl); }, onRemove: name => removeGadget?.(name) }),
		tileFormats: createRegistry<ImplOf<"tileFormats">>("tileFormats", { builtin: builtinTileFormats, onAdd: (name, impl) => { if (!tileFormats) throw new Error("registry.tileFormats: core decode is not available"); tileFormats.register({ name, ...impl }); }, onRemove: name => { throw new Error(`registry.tileFormats: "${name}" is process-wide (core registerTileFormat has no unregister)`); } }),
		lights: createRegistry<ImplOf<"lights">>("lights", { builtin: builtinLights, onAdd: (name, impl) => { if (typeof impl !== "object" || typeof impl.apply !== "function") throw new Error(`registry.lights.add("${name}"): { apply(map, lights) } is required`); } }),   // F1 で結線＝setLights が type ごとに impl.apply(map, lightsOfThatType) を呼ぶ
		postEffects: createRegistry<ImplOf<"postEffects">>("postEffects", { builtin: builtinPostEffects, onAdd: (name, impl) => { if (typeof impl !== "object" || typeof impl.apply !== "function") throw new Error(`registry.postEffects.add("${name}"): { apply(map, passes) } is required`); } }),   // F3 で結線＝setPostChain が type ごとに impl.apply(map, passesOfThatType) を呼ぶ
		textureTranscoders: createRegistry<ImplOf<"textureTranscoders">>("textureTranscoders", { onAdd: (name, impl) => { if (typeof impl !== "object" || typeof impl.url !== "string") throw new Error(`registry.textureTranscoders.add("${name}"): { url } (module exporting transcode(bytes) -> { width, height, rgba }) is required`); } }),   // 契約だけ（F4）
		handlers: createRegistry<ImplOf<"handlers">>("handlers", { onAdd: (name, impl) => { if (typeof impl !== "object" || typeof impl.create !== "function") throw new Error(`registry.handlers.add("${name}"): { create(map, opts) -> { start, stop, active } } is required`); } }),   // F6 で結線＝map.walk が "walk" を引く（他の名は plugin の自由）
		clouds: createRegistry<ImplOf<"clouds">>("clouds", { onAdd: (name, impl) => { if (typeof impl !== "object" || typeof impl.apply !== "function") throw new Error(`registry.clouds.add("${name}"): { apply(map, clouds) } is required`); } }),   // F2 で結線＝setClouds が impl.apply(map, clouds|null) を呼ぶ
	});
	const regs = Object.values(registry);
	const setCurrent = (p: string | null) => regs.forEach(r => r._setCurrent(p));

	function use<O>(p: OrthoPlugin<O> | Readonly<OrthoPlugin<O>>, opts: O = {} as O): GlobeMap {
		const spec = definePlugin(p);   // 素の object も受ける（形の検札は同じ）
		if (plugins.has(spec.name)) throw new Error(`map.use: plugin "${spec.name}" is already installed`);
		setCurrent(spec.name);
		let cleanup: (() => void) | null = null;
		try { const r: unknown = spec.install(map, opts ?? {} as O); if (typeof r === "function") cleanup = r as () => void; else if (r && typeof (r as { then?: unknown }).then === "function") console.warn(`[plugin] ${spec.name}: install returned a Promise; map.use does not await it (do async work inside and keep install synchronous)`); }
		catch (e) { regs.forEach(r => r._dropOwned(spec.name)); setCurrent(null); throw e; }
		setCurrent(null);
		plugins.set(spec.name, { spec, opts, cleanup });
		return map;
	}
	function unuse(name: string | OrthoPlugin<never> | Readonly<OrthoPlugin<never>> | null | undefined): boolean {
		const p = plugins.get((typeof name === "string" ? name : name?.name) as string);
		if (!p) return false;
		try { (p.spec.uninstall ?? p.cleanup as ((map: GlobeMap) => void) | null)?.call(p.spec, map); } finally { regs.forEach(r => r._dropOwned(p.spec.name)); plugins.delete(p.spec.name); }
		return true;
	}
	const list = () => [...plugins.values()].map(p => ({ name: p.spec.name, version: p.spec.version ?? null, provides: p.spec.provides ?? [] }));

	function capabilities(): Record<CapabilityKey, Capability> {
		const out: Record<CapabilityKey, Capability> = {};
		for (const [k, v] of Object.entries(STATIC_CAPABILITIES)) out[k] = { ...v };
		const be = getBackend();
		out["render.webgl2"] = { status: be === "webgpu" ? "no" : "builtin", note: "WebGL2 renderer" };
		out["render.webgpu"] = { status: be === "webgpu" ? "builtin" : "no", note: be === "webgpu" ? "WebGPU renderer (this map)" : "this map runs WebGL2 (?gpu=1 or a capable device for WebGPU)" };
		for (const n of registry.dataKinds.names()) out[`data.${n}`] = registry.dataKinds.isBuiltin(n) ? { status: "builtin", note: "map.addData" } : { status: "plugin", via: registry.dataKinds.ownerOf(n), note: "registry.dataKinds" };
		for (const n of registry.gadgets.names()) out[`gadget.${n}`] = registry.gadgets.isBuiltin(n) ? { status: "builtin", note: "map.gadget" } : { status: "plugin", via: registry.gadgets.ownerOf(n), note: "registry.gadgets" };
		for (const n of registry.tileFormats.names()) out[`tiles.${n}`] = registry.tileFormats.isBuiltin(n) ? { status: "builtin", note: "core decode" } : { status: "plugin", via: registry.tileFormats.ownerOf(n), note: "registry.tileFormats (core registerTileFormat)" };
		for (const n of registry.postEffects.names()) if (!registry.postEffects.isBuiltin(n)) out[`post.${n}`] = { status: "plugin", via: registry.postEffects.ownerOf(n), note: "registry.postEffects (rendered by the plugin's apply)" };   // builtin の type は静的な表にある
		for (const n of registry.lights.names()) if (!registry.lights.isBuiltin(n)) out[`light.${n}`] = { status: "plugin", via: registry.lights.ownerOf(n), note: "registry.lights (rendered by the plugin's apply)" };   // builtin の type は静的な表にある
		for (const n of registry.textureTranscoders.names()) out[`texture.${n}`] = specOf(registry.textureTranscoders, n);
		{ const cl = registry.clouds.names(); if (cl.length) out.clouds = { status: "plugin", via: registry.clouds.ownerOf(cl[0]), note: "registry.clouds (rendered by the plugin's apply)" }; }
		if (registry.handlers.has("walk")) out["camera.walk"] = { status: "plugin", via: registry.handlers.ownerOf("walk"), note: "registry.handlers \"walk\" (map.walk drives it)" };
		for (const n of registry.handlers.names()) if (n !== "walk") out[`handler.${n}`] = { status: "plugin", via: registry.handlers.ownerOf(n), note: "registry.handlers" };
		out["pointcloud.laz"] = pointcloud && pointcloud.laz ? { status: "builtin", note: 'laz-perf bundled via the "#pointcloud-formats" alias' } : { status: "no", note: 'alias "#pointcloud-formats" to @ortho-earth/tile-formats/pointcloud to read COPC (LAZ)' };
		return out;
	}
	const supports = (key: CapabilityKey) => { const c = capabilities()[key]; return !!c && (c.status === "builtin" || c.status === "plugin"); };
	const destroy = () => { for (const n of [...plugins.keys()].reverse()) { try { unuse(n); } catch (e) { console.warn(`[plugin] ${n}: uninstall failed`, e); } } };

	return { use, unuse, plugins: list, registry, supports, capabilities, destroy };
}
