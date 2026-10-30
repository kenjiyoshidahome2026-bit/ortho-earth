// PLATEAU バッチデコードの実体（②区内デコード並列化・2026-08-28 に meshworker.js から切り出し）。
// 「バッチ＝タイル列の一部」を単一メッシュへ煮る自己完結パイプラインだけを持つ：
// fetch→b3dm/Draco解凍→ECEF→世界座標→重複面dedup→剛体接地→LOD焼き→RTE→被覆マスク断片。
// 呼び出し元は2系統＝meshworker（従来の直列経路・lowMem/mid/slow/preload）と meshdecoder（ハイスペック機の
// 並列プール経路）。経路差はゼロ＝同じ関数を別コアで回すだけ。区単位の状態（IDB/OPFS・far-DB・クレジット・
// レーン）は一切持たない。環境（楕円体・タイル並行数）は setDecodeEnv で注入＝各workerのinitが責任を持つ。
// loaders.gl（core＋3d-tiles＋gltf＋draco ≈ 220 KB）は最初のタイルを解く時に読む（処方②・ortho-earth#12・2026-09-14）。
// 静的 import だと meshworker / meshdecoder の起動（z4 の初期ロード・本番既定は PLATEAU オン）でプール本数分の
// 起動ベースラインとして丸ごと乗っていた。デコード以外（葉走査・fetch・接地・マスク）はこのファイルの軽い部分だけで動く。
let _loaders: Promise<typeof import("./mesh-loaders.ts")> | null = null;
const loaders = () => _loaders ??= import("./mesh-loaders.ts");   // 名前付き再輸出の薄い入口＝遅延チャンク内で tree-shaking が効く
import { weldMesh } from "./meshq.ts";
import { primitiveOutline } from "./outline.ts";
import { gltfMeta, rawGltfJson } from "./gltf-meta.ts";   // 模型の見出し（アニメ・拡張・テクスチャ形式・feature ID＝F4・口だけ）   // 頂点溶接（焼きと共用）
import { rigFromGltf, skinsFromGltf, jointMatrices, skinVertices, I4 as I4_ } from "./gltf-anim.ts";   // skin（2026-10-28）＝静止姿勢で焼く・区間の表を main へ   // rigid アニメ（W4）＝アニメの掛かるノードごとに束を分け、rig と place を返す
import { featureSetOf, featureIdsOf, featureTextureOf, decodePropertyTables, batchTableOf, NO_FEATURE, type FeatureSet, type FeatureTexture } from "./mesh-features.ts";   // 地物の番号と属性（W7）＝EXT_mesh_features／EXT_structural_metadata／b3dm
import type { GltfPlace, GltfRig, SkinSeg } from "./gltf-anim.ts";
import type { GltfMeta, RawGltf } from "./gltf-meta.ts";   // GltfMeta＝globe.d.ts の写し（worker から読まれる頁は globe.d.ts を引けない）
import type { FeaturePrimitive, MeshFeatures, PropertyTable, StructuralMetadata } from "./mesh-features.ts";

// ── 型（loaders.gl の postProcessGLTF 後の glTF・Tiles3DLoader のタイル＝読む欄だけ）──
/** 頂点属性・index の数列 */
export type NumArr = Float32Array | Float64Array | Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array;
/** accessor（value＝型付き配列） */
export interface GltfAccessor { value?: NumArr | null; normalized?: boolean }
/** texture の画像（ImageBitmap か素の { data, width, height }） */
export interface GltfImage { data?: unknown; width: number; height: number }
export interface GltfTexture { source?: { image?: GltfImage | null } | null }
/** KHR_texture_transform */
export interface TexTransform { texCoord?: number; rotation?: number; scale?: number[]; offset?: number[] }
/** material の texture 参照（postProcess が texture を解決・拡張側は index のまま） */
export interface GltfTexRef { texture?: GltfTexture | null; index?: number; texCoord?: number; scale?: number; strength?: number; extensions?: { KHR_texture_transform?: TexTransform } | null }
export interface GltfMaterial {
	pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: GltfTexRef; metallicRoughnessTexture?: GltfTexRef; metallicFactor?: number; roughnessFactor?: number } | null;
	extensions?: { KHR_materials_pbrSpecularGlossiness?: { diffuseFactor?: number[]; diffuseTexture?: GltfTexRef } | null; KHR_materials_emissive_strength?: { emissiveStrength?: number } | null; KHR_materials_clearcoat?: { clearcoatFactor?: number; clearcoatRoughnessFactor?: number } | null; KHR_materials_unlit?: Record<string, never> | null } | null;
	normalTexture?: GltfTexRef; occlusionTexture?: GltfTexRef; emissiveTexture?: GltfTexRef; emissiveFactor?: number[];
	alphaMode?: string; alphaCutoff?: number;
	/** loaders.gl が KHR_materials_unlit を畳んだ印（拡張は material から外される） */ unlit?: boolean;
}
export interface GltfPrimitive extends FeaturePrimitive { attributes?: Record<string, GltfAccessor | undefined> | null; indices?: GltfAccessor | null; mode?: number; material?: GltfMaterial | null }
export interface GltfMesh { primitives?: GltfPrimitive[] }
export interface GltfNode { mesh?: GltfMesh | null; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; children?: GltfNode[]; skin?: GltfSkin | null }
/** skin（postProcessGLTF 後＝joints はノード番号のまま・inverseBindMatrices は accessor の実体） */
export interface GltfSkin { joints?: Array<number | GltfNode>; inverseBindMatrices?: GltfAccessor | null }
export interface GltfBufferView { buffer?: { arrayBuffer?: ArrayBuffer; byteOffset?: number } | null; byteOffset?: number; byteLength: number; data?: Uint8Array }
/** postProcessGLTF 後の glTF（json＝生の json） */
export interface GltfDoc {
	nodes?: GltfNode[]; meshes?: GltfMesh[]; scene?: { nodes?: GltfNode[] } | null; scenes?: Array<{ nodes?: GltfNode[] }>; skins?: GltfSkin[];
	extensions?: { CESIUM_RTC?: { center?: number[] }; EXT_structural_metadata?: StructuralMetadata; KHR_implicit_shapes?: { shapes?: ImplicitShape[] } } | null;
	json?: RawGltf | null; bufferViews?: Array<GltfBufferView | undefined>; textures?: Array<GltfTexture | undefined>;
	accessors?: GltfAccessor[]; animations?: Array<{ name?: unknown; channels?: Array<{ sampler: number; target?: { node?: number; path?: string } }>; samplers?: Array<{ input: number; output: number; interpolation?: string }> }>;
}
/** Tiles3DLoader のタイル（b3dm）＝読む欄だけ */
export interface Tile3DContent { rtcCenter?: number[] | null; gltf?: GltfDoc | null; batchTableJson?: { gml_id?: string[] } | null }
/** 葉タイル（collectLeafTiles の 1 件）＝center は [lon, lat]（度）| null */
export interface LeafTile { uri: string; center: number[] | null; /** 根から積んだタイルの transform（列優先 4x4・Z-up→ECEF）。無ければ null＝PLATEAU・3DBAG */ xf?: number[] | null }
/** tileset.json の境界体積 */
interface BoundingVolume { region?: number[]; box?: number[]; sphere?: number[] }
/** tileset.json のタイル（読む欄だけ） */
interface TilesetTile { boundingVolume?: BoundingVolume; children?: TilesetTile[]; content?: { uri?: string } | null; transform?: number[] }
/** 後段（finishMesh）の出力＝GPU に上げるメッシュ（uv・col は模型・押し出し・colSrgb は押し出しが足す） */
export interface MeshOut {
	pos: Float32Array; nrm: Int8Array; idx: Uint32Array; uv?: Float32Array; col?: Uint8Array; /** 利用者のシェーダ（CustomShader）の positionMC と地物の番号（opts.mc の時だけ） */ mc?: Float32Array; /** property texture の texCoord（opts.mc で property texture のある束だけ） */ uvm?: Float32Array;
	origin: number[]; bbox: number[]; lodH: number[]; lodCounts: number[]; twoSided: number; maskCells: Uint32Array | null; colSrgb?: boolean;
}
/** テクスチャ（ImageBitmap か素の RGBA） */
export interface TexOut { bitmap?: ImageBitmap; rgba?: Uint8Array; w?: number; h?: number }
/** 模型の束（decodeModel の batches の 1 件） */
export interface ModelBatchOut {
	mesh: MeshOut; tex: TexOut | null; texMR: TexOut | null; texN: TexOut | null; texOcc: TexOut | null; texEm: TexOut | null;
	pbr: { metallic: number; roughness: number; normalScale: number; occlusion: number; emissive: number[]; unlit: boolean; clearcoat?: number[] | null };   // unlit＝KHR_materials_unlit か法線無し（Cesium はどちらも照明を掛けない）
	alphaMode: string; alphaCutoff: number; node: number; features: (MeshFeatures & { table: number | null; tblV: Int16Array | null }) | null;
	/** スキンされた区間（2026-10-28）＝main が時計のたびに頂点を焼き直す（gltf-anim.skinBatch）。無ければ無し */
	skin?: SkinSeg[] | null;
	/** property texture（CustomShader の fsInput.metadata）＝性質の読み方と画像（opts.mc の時だけ） */
	meta?: { props: Record<string, MetaProp>; texs: (TexOut | null)[] } | null;
	/** 利用者のシェーダの J＝positionMC の差分 → 世界（単位球）の差分の線形部（列優先 3x3・opts.mc の時だけ） */
	mcJ?: number[] | null;
}
/** 模型の点（経緯度 rad と RGBA） */
export interface ModelPoints { geo: number[]; rgba: number[] }
/** 3D Tiles の glTF の Gaussian splat（KHR_gaussian_splatting・2026-10-18）＝局所の座標のまま＋transform（列優先 4×4・局所 → ECEF＝タイル変換 × ノード変換・heightOffset 込み）。
 *  main（gadgets/tiles3d.ts）が splat の層（SplatData crs "local"）にする＝ECEF を float32 に通さない（0.5m のガタつき）。scales＝線形の σ（m）・rotations＝x,y,z,w・colors＝RGBA（sRGB・A＝不透明度）・
 *  sh＝DC より上の係数（n × K×3・係数が先・K＝3／8／15）。spz＝圧縮の拡張（KHR_gaussian_splatting_compression_spz_*）の本体＝plugin の読み手（parseSpz）が解く（その時 n＝0・配列は空） */
export interface SplatPrimOut { n: number; positions: Float32Array; scales: Float32Array; rotations: Float32Array; colors: Uint8Array; sh: Float32Array | null; shDegree: 0 | 1 | 2 | 3; transform: number[]; spz: Uint8Array | null; colorSpace: string }
/** KHR_implicit_shapes の形（box＝size・原点が中心。EXT_implicit_ellipsoid_region／EXT_implicit_cylinder_region は shape の extensions） */
export interface ImplicitShape { type?: string; box?: { size?: number[] }; extensions?: Record<string, unknown> }
/** 3D Tiles の glTF の voxel（EXT_primitive_voxels＋KHR_implicit_shapes・2026-10-23）＝voxel の VoxelData の形：box＝単位立方体 [0,1]³ → ECEF の transform（列優先 4×4・heightOffset 込み）・region＝[w,s,e,n（度）,h0,h1]。
 *  values は padding を剥いだ物（x が最速）・components 1（スカラー）か 4（RGBA）・noData＝EXT_primitive_voxels.noData[属性]・property＝読んだ属性の名 */
export interface VoxelPrimOut { shape: "box" | "region" | "cylinder"; dims: [number, number, number]; components: 1 | 4; values: Float32Array | Uint16Array | Uint8Array; transform?: number[]; region?: number[]; cylinder?: VoxelCylinderOut; noData?: number; property: string }
/** cylinder＝voxel の契約の cylinder（transform＝局所 m → ECEF・z が軸・角度は +x から反時計回り・度）。dims は [半径, 角度, 高さ] に並べ替え済み */
export interface VoxelCylinderOut { transform: number[]; radius: [number, number]; height: [number, number]; angle: [number, number] }
/** tile.voxels の opts：property＝読む属性（class の性質名でも可・省略＝最初の独自属性）・declared＝tileset の 3DTILES_content_voxels（dimensions・padding）・volume＝タイルの境界体積（ECEF の box＝中心＋半軸 3 本 12 個・region＝rad・cylinder＝3DTILES_bounding_volume_cylinder を ECEF の transform に・角度は度で 3D Tiles の向き）＝glTF に形が無い時（cylinder は glTF に形が有っても境界体積が正） */
export interface VoxelTileOpts { property?: string | null; declared?: { dimensions?: number[]; padding?: { before?: number[]; after?: number[] } } | null; volume?: { box?: number[]; region?: number[]; cylinder?: VoxelCylinderOut } | null }
/** decodeModel の stats */
export interface ModelStats {
	vertices: number; triangles: number; instances: number; mode: string; points?: number; splats?: number; splatPoints?: number; voxels?: number; voxelsSkipped?: number; bbox?: number[]; materials?: number; textures?: number; blended?: number; gltf?: GltfMeta;   // splats＝splat の個数・splatPoints＝splat を点として描いた個数・voxels＝voxel の格子の数・voxelsSkipped＝plugin が無い／形が読めず飛ばした格子（plugin が無い時）
	ktx2?: { textures: number; transcoded: number; failed: number }; features?: { primitives: number; texture: number; tables: number };
}
/** decodeModel の戻り */
export interface ModelOut {
	batches: ModelBatchOut[]; rig?: GltfRig | null; place?: GltfPlace | null; features?: { tables: PropertyTable[]; primitives: number; texture: number; warnings: string[] } | null;
	mask: { bbox: number[]; n: number } | null; points: ModelPoints | null; splats?: SplatPrimOut[] | null; voxels?: VoxelPrimOut[] | null; stats: ModelStats;
}
/** 3D Tiles のタイルとして置く時（#41）＝places（タイル変換×インスタンス・ECEF）・rtc・baseH・points・batchTable・splats（KHR_gaussian_splatting を splat として返す＝false なら点として描く）・voxels（EXT_primitive_voxels を voxel として返す＝false なら飛ばす） */
export interface ModelTileOpts { places: Array<{ L: ArrayLike<number>; t: ArrayLike<number> }>; rtc?: number[] | null; baseH?: number | null; points?: boolean; splats?: boolean; voxels?: boolean | VoxelTileOpts; batchTable?: { json: Record<string, unknown>; bin: Uint8Array | null; count: number } | null }
/** decodeModel の opts */
export interface DecodeModelOpts { /** 3D Tiles 1.0 asset.gltfUpAxis: "Z" = no Y-up → Z-up turn for a tile */ upAxis?: string | null; at?: ArrayLike<number> | null; heading?: number; scale?: number; baseUri?: string | null; textures?: boolean; ground?: string; mask?: boolean; tile?: ModelTileOpts | null; featureIdSet?: number; /** 利用者のシェーダ（Cesium の CustomShader）＝頂点ごとの positionMC（glTF の POSITION そのまま）と束の J を返す */ mc?: boolean; /** タイル本体を取った時の headers／credentials（transformRequest・ion の Bearer）＝同じ origin の外部画像・buffer・i3dm の glTF にも付ける（無いと ion の CDB のテクスチャが 401） */ fetchOpts?: FetchOpts | null }
export interface FetchOpts { headers?: Record<string, string> | null; credentials?: RequestCredentials | null }
/** fetch の代わり＝baseUri と同じ origin の URL にだけ headers／credentials を付ける（別ホストへ委譲された画像に token を漏らさない） */
export const fetchFor = (baseUri: string | null | undefined, o: FetchOpts | null | undefined): typeof fetch => {
	const origin = (() => { try { return baseUri ? new URL(baseUri, self.location?.href).origin : null; } catch { return null; } })();
	const same = (u: RequestInfo | URL) => { try { return !!origin && new URL(typeof u === "string" ? u : u instanceof URL ? u : u.url, baseUri!).origin === origin; } catch { return false; } };
	return (u, init) => fetch(u, { credentials: "omit", ...init, ...(o && same(u) ? { ...(o.credentials && { credentials: o.credentials }), ...(o.headers && { headers: { ...(init?.headers as Record<string, string> | undefined), ...o.headers } }) } : {}) });
};
/** 模型の束の断片（プリミティブ 1 つ分） */
interface ModelSeg { geo: Float64Array; nrm: Int8Array; idx: Uint32Array; uv: Float32Array; col: Uint8Array; fid: Uint32Array | null; tbl: number | null; skin?: Omit<SkinSeg, "start" | "n"> | null; mc?: Float32Array | null; uvm?: Float32Array | null }
/** property texture（EXT_structural_metadata）の性質 1 つ＝ortho-core csshader の CsMeta（tex＝束の meta.texs の何枚目） */
export interface MetaProp { type: string; tex: number; ch: number[]; bytes: number; norm?: boolean; float?: boolean; offset?: number | null; scale?: number | null }
type RawMeta = { schema?: { classes?: Record<string, { properties?: Record<string, { type?: string; componentType?: string; normalized?: boolean; offset?: number; scale?: number; array?: boolean }> }> }; propertyTextures?: Array<{ class?: string; properties?: Record<string, { index?: number; texCoord?: number; channels?: number[]; offset?: number; scale?: number }> }> };
const META_BYTES: Record<string, number> = { INT8: 1, UINT8: 1, INT16: 2, UINT16: 2, INT32: 4, UINT32: 4, FLOAT32: 4 };
/** primitive の property texture（CustomShader の fsInput.metadata）＝性質の読み方・使う texture の番号・texCoord。読めない形（配列・64 bit・成分が channels に足りない）は飛ばす */
function propTexOf(pr: { extensions?: Record<string, unknown> | null }, meta: RawMeta | null): { sig: string; texCoord: number; props: Record<string, MetaProp>; texIdx: number[] } | null {
	const ids = (pr.extensions?.EXT_structural_metadata as { propertyTextures?: number[] } | undefined)?.propertyTextures;
	if (!meta || !ids?.length) return null;
	const props: Record<string, MetaProp> = {}, texIdx: number[] = [];
	let texCoord = -1;
	for (const i of ids) {
		const pt = meta.propertyTextures?.[i], cls = pt?.class ? meta.schema?.classes?.[pt.class] : null;
		for (const [name, p] of Object.entries(pt?.properties || {})) {
			const c = cls?.properties?.[name], bytes = META_BYTES[c?.componentType || ""], n = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[c?.type || ""];
			const ch = p.channels ?? [0];
			if (!c || !bytes || !n || c.array || typeof p.index !== "number" || ch.length < n * bytes) continue;
			if (texCoord < 0) texCoord = p.texCoord ?? 0;
			let k = texIdx.indexOf(p.index); if (k < 0) { k = texIdx.length; texIdx.push(p.index); }
			const flt = c.componentType === "FLOAT32", norm = !!c.normalized && !flt, unsigned = c.componentType!.startsWith("U");
			const sc = flt || norm ? "float" : unsigned ? "uint" : "int", type = n === 1 ? sc : `${sc === "float" ? "" : sc === "uint" ? "u" : "i"}vec${n}`;
			props[name] = { type, tex: k, ch, bytes, ...(norm && { norm }), ...(flt && { float: flt }), offset: p.offset ?? c.offset ?? null, scale: p.scale ?? c.scale ?? null };
		}
	}
	return texIdx.length ? { sig: `${ids.join(",")}`, texCoord: Math.max(0, texCoord), props, texIdx } : null;
}
/** 変換器の module（registry.textureTranscoders の url を import() した物） */
interface TranscoderModule { transcode(bytes: Uint8Array, info: { mimeType: string }): TranscodeResult | null | Promise<TranscodeResult | null> }
interface TranscodeResult { width: number; height: number; rgba: unknown }
// テクスチャの変換器（第 3 波 W5・2026-10-12）＝main の registry.textureTranscoders の写し [{ name, url }]。worker はこの url を import() し、
// KHR_texture_basisu（KTX2/Basis）の画像を transcode(bytes, { mimeType }) → { width, height, rgba } で素の RGBA にして、普通の画像と同じ道（textureOf）へ流す。
// loaders.gl の KHR_texture_basisu（CDN の WASM を勝手に取りに行き、圧縮のままの形で返す）は使わない＝excludeExtensions で外す。変換器が無ければ fallback の画像（texture.source）のまま
let transcoders: Array<{ name: string; url: string }> = [];
const transcoderMods = new Map<string, Promise<TranscoderModule>>();   // url → Promise<module>（失敗したら外す＝次の読みで再挑戦）
export function setTextureTranscoders(list: unknown): void { transcoders = Array.isArray(list) ? list.filter((t): t is { name: string; url: string } => t && typeof t.name === "string" && typeof t.url === "string") : []; }
const transcoderFor = (name: string) => {
	const t = transcoders.find(x => x.name === name); if (!t) return null;
	let p = transcoderMods.get(t.url);
	if (!p) transcoderMods.set(t.url, p = import(/* @vite-ignore */ t.url).then((m: Partial<TranscoderModule> | null) => { if (typeof m?.transcode !== "function") throw new Error(`texture transcoder "${name}": module has no transcode()`); return m as TranscoderModule; }).catch(e => { transcoderMods.delete(t.url); throw e; }));
	return p;
};
// KHR_texture_basisu の texture を変換器で素の RGBA に。raw＝生の json（loaders.gl が拡張を外す前）・gltf＝postProcess 後。戻り＝{ textures, transcoded, failed }
async function transcodeBasisu(gltf: GltfDoc, raw: RawGltf | null, baseUri: string | null, f: typeof fetch = fetch) {
	const out = { textures: 0, transcoded: 0, failed: 0 }, todo: Array<[number, number]> = [];
	(raw?.textures || []).forEach((t, i) => { const src = t?.extensions?.KHR_texture_basisu?.source; if (Number.isInteger(src)) { out.textures++; todo.push([i, src!]); } });
	if (!todo.length) return out;
	const mod = await (transcoderFor("ktx2") ?? Promise.resolve(null)).catch(e => { console.warn("[model] ktx2 transcoder unavailable:", (e as Error | null)?.message); return null; });
	if (!mod) { out.failed = out.textures; return out; }
	const bytesOf = async (img: NonNullable<RawGltf["images"]>[number]) => {
		if (Number.isInteger(img.bufferView)) { const bv = gltf.bufferViews?.[img.bufferView!], b = bv?.buffer; return b?.arrayBuffer ? new Uint8Array(b.arrayBuffer, (b.byteOffset || 0) + (bv!.byteOffset || 0), bv!.byteLength) : null; }
		if (typeof img.uri === "string") { const u = new URL(img.uri, baseUri || self.location?.href), r = await f(u, { credentials: "omit" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); }
		return null;
	};
	const imgs = new Map<number, Promise<GltfImage | null>>();   // image 番号 → Promise<{ data, width, height } | null>（同じ画像は 1 回）
	for (const [ti, si] of todo) {
		let p = imgs.get(si);
		if (!p) imgs.set(si, p = (async () => {
			const img = raw!.images?.[si], bytes = img ? await bytesOf(img) : null; if (!bytes) return null;
			const r = await mod.transcode(bytes, { mimeType: img!.mimeType || "image/ktx2" }), n = ((r?.width as number) | 0) * ((r?.height as number) | 0) * 4;
			if (!r || !(r.width > 0) || !(r.height > 0) || !(r.rgba instanceof Uint8Array || r.rgba instanceof Uint8ClampedArray) || r.rgba.length < n) throw new Error("transcode() must return { width, height, rgba: Uint8Array(width*height*4) }");
			return { data: r.rgba.length === n ? r.rgba : r.rgba.subarray(0, n), width: r.width, height: r.height };
		})().catch(e => { console.warn("[model] ktx2 transcode failed:", (e as Error | null)?.message); return null; }));
		const im = await p, tex = gltf.textures?.[ti];
		if (im && tex) { tex.source = { image: im }; out.transcoded++; } else out.failed++;
	}
	return out;
}

const R2D = 180 / Math.PI;
// デコードパイプライン（接地・dedup・LOD・軸変換）の版＝焼きの互換単位。変えたら上げる＝ブラウザの IDB/OPFS 焼き（meshworker の
// IDB_FMT_VER）も R2 の焼き（scripts/bake-plateau.mjs の置き場 v{n}/）も同じ番号で世代分離される。
export const DECODE_VER = 5;   // v5: 空中部材の借り接地（詳細は meshworker.js IDB_FMT_VER の注記）
export const MASK_N = 256;           // 区単位の被覆マスク解像度（基図建物を伏せるセル）
const LOD_H = [0, 3, 6, 12, 24, 48];   // LOD段の高さ閾値(m)。renderer が「画面上1px未満の建物」を先頭countの打ち切りで捨てる
let TILE_CONCURRENCY = 8;   // バッチ内のタイル並行fetch/デコード数。直列だと往復レイテンシが積み上がり支配的になる。
let ELL = false, EARTH_W = 6371000;   // 楕円体モード（?ell=1）＝β単位球×a（meshworker と同じ分解）。既定は球
const ELL_RAX = 1 - 1 / 298.257223563;   // b/a
let EXCLUDE: Map<string, Set<string>> | null = null;   // base URL → Set(gml_id)＝捨てる地物（public/plateau-exclude.json・焼きと生経路で共用）
export function setDecodeEnv({ ell, tileConcurrency, exclude }: { ell?: boolean; tileConcurrency?: number; exclude?: Record<string, string[]> | null } = {}): void {
	if (ell !== undefined) { ELL = !!ell; EARTH_W = ELL ? 6378137 : 6371000; }
	if (tileConcurrency) TILE_CONCURRENCY = tileConcurrency;
	if (exclude !== undefined) { EXCLUDE = exclude ? new Map(Object.entries(exclude).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, new Set(v)])) : null; }
}

// ECEF(WGS84)→geodetic(lon,lat[rad],h[m])。
// 球面近似(geocentric lat=atan2(z,p))も試したが、緯度が最大0.2°程度ズレて建物群が基図から丸ごと外れる
// （実測で本来位置より南へ約20km）ため不採用＝地表座標そのものは楕円体で正確に解かないといけない。
// 反復はNewton法。地表近傍(h<数km)では2回で高さ誤差0.2mm未満に収束する（1回だと0.1m級誤差が残りdedupの
// 丸め精度(0.1m)と衝突しうるため2回が下限）。
export function ecef2geo(x: number, y: number, z: number): [number, number, number] {
	const a = 6378137, e2 = 0.00669437999014;
	const p = Math.hypot(x, y), lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2)), h = 0;
	for (let i = 0; i < 2; i++) { const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
	return [lon, lat, h];
}

// タイムアウト付き fetch（PLATEAU API はハング接続が起きる＝タイムアウト無しだと worker 枠が数分死ぬ。
// 実測 2026-08-02：API不調時に区の並行8本が全部無応答＝70秒で0タイル「極端に遅い」の実体）。
// abort は body 読み（json/arrayBuffer）まで効かせる＝ヘッダ後の本文ストール（stalled mid-stream）も切る。
async function fetchBody<T>(url: string, read: (r: Response) => Promise<T>, ms = 20000, retries = 1): Promise<T> {
	for (let a = 0; ; a++) {
		const ac = new AbortController();
		const tm = setTimeout(() => ac.abort(), ms);
		try { const r = await fetch(url, { signal: ac.signal }); return await read(r); }
		catch (e) { if (a >= retries) throw e; }
		finally { clearTimeout(tm); }
	}
}
export const fetchJSON = (url: string): Promise<unknown> => fetchBody(url, r => r.json() as Promise<unknown>, 15000);
export const fetchAB = (url: string): Promise<ArrayBuffer> => fetchBody(url, r => r.arrayBuffer(), 25000);

// ── 葉タイル走査（2026-09-07 に meshworker.js から移設＝scripts/bake-plateau.mjs と共有）──
const SCAN_CONCURRENCY = 8;   // ネストtileset走査の並行fetch数（fetchJSONの15sタイムアウトが順番待ちで誤発火しない程度に絞る）
// content.uri は絶対URL（別ホストへの委譲）と相対（同ディレクトリ）の両方があり得る。
export const resolveUrl = (base: string, uri: string): string => /^https?:\/\//.test(uri) ? uri : base + uri;
// boundingVolume → [west,south,east,north]（rad）。3D Tiles の3形式に対応。取れなければ null。
// PLATEAU は region（経緯度そのもの）だけだが、3DBAG（オランダ）は box（ECEF中心＋3半軸）＝
// 8隅を測地変換して外接矩形にする。日付変更線跨ぎは考慮しない（日本・欧州とも無縁）。
// xf＝タイルの transform（列優先 4x4）＝box／sphere はその座標系（PDOK の 3D Basisvoorziening は根に ECEF の行列）。region は経緯度のまま
function volRect(bv: BoundingVolume | undefined, xf: ArrayLike<number> | null = null): number[] | null {
	if (!bv) return null;
	if (bv.region) return [bv.region[0], bv.region[1], bv.region[2], bv.region[3]];
	const P = (x: number, y: number, z: number): [number, number, number] => xf ? [xf[0] * x + xf[4] * y + xf[8] * z + xf[12], xf[1] * x + xf[5] * y + xf[9] * z + xf[13], xf[2] * x + xf[6] * y + xf[10] * z + xf[14]] : [x, y, z];
	const V = (x: number, y: number, z: number): [number, number, number] => xf ? [xf[0] * x + xf[4] * y + xf[8] * z, xf[1] * x + xf[5] * y + xf[9] * z, xf[2] * x + xf[6] * y + xf[10] * z] : [x, y, z];
	if (bv.box) {
		const b0 = bv.box, c = P(b0[0], b0[1], b0[2]), u = V(b0[3], b0[4], b0[5]), v = V(b0[6], b0[7], b0[8]), w0 = V(b0[9], b0[10], b0[11]);
		const b = [...c, ...u, ...v, ...w0];
		let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
		for (let i = 0; i < 8; i++) {
			const sx = (i & 1) ? 1 : -1, sy = (i & 2) ? 1 : -1, sz = (i & 4) ? 1 : -1;
			const g = ecef2geo(b[0] + sx * b[3] + sy * b[6] + sz * b[9],
				b[1] + sx * b[4] + sy * b[7] + sz * b[10],
				b[2] + sx * b[5] + sy * b[8] + sz * b[11]);
			w = Math.min(w, g[0]); e = Math.max(e, g[0]); s = Math.min(s, g[1]); n = Math.max(n, g[1]);
		}
		return [w, s, e, n];
	}
	if (bv.sphere) {
		const g = ecef2geo(...P(bv.sphere[0], bv.sphere[1], bv.sphere[2]));
		const dLa = bv.sphere[3] / 6378137, dLo = dLa / Math.max(0.05, Math.cos(g[1]));
		return [g[0] - dLo, g[1] - dLa, g[0] + dLo, g[1] + dLa];
	}
	return null;
}


// tileset.json を辿って葉（=それ以上 children を持たないタイル）を { uri, center:[lon,lat]|null } で集める。
// center は boundingVolume から＝カメラ近傍優先ソートに使う（region も box も取れる。無い形式なら null＝末尾に回る）。
// 葉の content.uri 自体が別の tileset.json（外部委譲）のことがある地区があるため、拡張子で判定して再帰的に潜る。
// clip（[w,s,e,n]度・任意）＝この矩形と交わらない枝は丸ごと降りない。PLATEAU は区ごとに tileset が分かれて
// いるので不要（既定 null＝従来どおり全走査）だが、3DBAG は国土まるごと1枚＝外部tileset 474本を全部開くと
// 走査だけで数分かかる。街の矩形を渡せば数本で済む＝「区」相当の粒度に切って使える。
// タイルの transform（3D Tiles）は根から積む＝葉に xf として渡す（decodeBatch が頂点に掛ける）。外部 tileset へも親の行列を引き継ぐ。
export async function collectLeafTiles(tilesetUrl: string, depth = 0, onScan: (() => void) | null = null, stop: (() => boolean) | null = null, clip: ArrayLike<number> | null = null, xf0: number[] | null = null): Promise<LeafTile[]> {
	if (stop?.()) return [];   // 協調キャンセル：視野離脱した区のカタログ走査を tileset 単位で打ち切る
	onScan && onScan();   // tileset.json 1枚fetchするたびに数える＝「準備中」の沈黙を進捗にする
	const ts = await fetchJSON(tilesetUrl) as { root?: TilesetTile };
	const tsBase = tilesetUrl.slice(0, tilesetUrl.lastIndexOf("/") + 1);
	const clipR = clip && [clip[0] / R2D, clip[1] / R2D, clip[2] / R2D, clip[3] / R2D];
	const out: LeafTile[] = [], nested: Array<[string, number[] | null]> = [];
	function walk(t: TilesetTile | undefined, xfP: number[] | null) {
		if (!t) return;
		const xf = t.transform?.length === 16 ? (xfP ? Array.from(m4mul(xfP, t.transform)) : t.transform.slice()) : xfP;
		const rect = volRect(t.boundingVolume, xf);
		if (clipR && rect && (rect[2] < clipR[0] || rect[0] > clipR[2] || rect[3] < clipR[1] || rect[1] > clipR[3])) return;   // 枝ごと落とす
		const ch = t.children || [];
		if (ch.length) { for (const c of ch) walk(c, xf); return; }
		const uri = t.content?.uri;
		if (!uri) return;
		const abs = resolveUrl(tsBase, uri);
		if (abs.endsWith(".json") && depth < 4) nested.push([abs, xf]);
		else out.push({ uri: abs, center: rect ? [(rect[0] + rect[2]) / 2 * R2D, (rect[1] + rect[3]) / 2 * R2D] : null, ...(xf ? { xf } : {}) });
	}
	walk(ts.root, xf0);
	// ネストtilesetは並行プールで潜る（旧・await直列＝1枚ごとに往復レイテンシが足し算。外部委譲が数百本の
	// カタログ＝3DBAG級では走査だけで数分の実体）。葉の並びは後段のカメラ近傍ソートが決める＝順序不問。
	// 1枚でも失敗したら従来どおり全体を投げる＝部分カタログを「完全」として下流（焼き・差分再開）に流さない。
	if (nested.length) {
		const subs: LeafTile[][] = new Array(nested.length);
		let ni = 0;
		await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, nested.length) }, async () => {
			while (ni < nested.length) { const i = ni++; subs[i] = await collectLeafTiles(nested[i][0], depth + 1, onScan, stop, clip, nested[i][1]); }
		}));
		for (const sub of subs) out.push(...sub);
	}
	return out;
}

// GLB 修復（EXT_meshopt_compression を使う配信のみ・PLATEAU は非該当＝素通り）：
// 3DBAG（オランダ）の glb は、インデックス用と頂点用の bufferView が どちらも byteOffset 省略(=0) のまま
// 同じ fallback バッファ（長さは両者の合計ぴったり）を指す。CesiumJS/three.js は各 view を個別バッファへ
// 展開するので平気だが、loaders.gl は fallback バッファの実体へ byteOffset で書き戻すため、後から展開された
// 頂点データがインデックス領域を上書きする＝頂点は正しいのにインデックスだけ壊れる（実測：最大index 42.9億／
// 頂点10.9万＝画面いっぱいの破片）。fallback バッファ内で積み上げオフセットを振り直せば衝突しない。
function fixMeshoptGlb(ab: ArrayBuffer): ArrayBuffer {
	const dv = new DataView(ab);
	if (ab.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) return ab;   // "glTF" でなければ b3dm 等＝触らない
	const jsonLen = dv.getUint32(12, true);
	let json: { extensionsUsed?: string[]; bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; extensions?: { EXT_meshopt_compression?: unknown } }> };
	try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jsonLen))); } catch { return ab; }
	if (!(json.extensionsUsed || []).includes("EXT_meshopt_compression")) return ab;
	const next = new Map<number, number>();
	let patched = 0;
	for (const bv of json.bufferViews || []) {
		if (!bv.extensions?.EXT_meshopt_compression) continue;
		const at = next.get(bv.buffer) || 0;
		if ((bv.byteOffset || 0) !== at) { bv.byteOffset = at; patched++; }
		next.set(bv.buffer, at + bv.byteLength);
	}
	if (!patched) return ab;
	let s = JSON.stringify(json);
	while (s.length % 4) s += " ";   // JSONチャンクは4B整列（末尾は空白詰めが仕様）
	const jb = new TextEncoder().encode(s);
	const rest = ab.byteLength - (20 + jsonLen);
	const out = new ArrayBuffer(20 + jb.length + rest);
	const o8 = new Uint8Array(out), odv = new DataView(out);
	o8.set(new Uint8Array(ab, 0, 20));
	odv.setUint32(8, out.byteLength, true); odv.setUint32(12, jb.length, true);
	o8.set(jb, 20);
	o8.set(new Uint8Array(ab, 20 + jsonLen, rest), 20 + jb.length);
	return out;
}

// 頂点の同一視（丸めた座標の 3 つ組が同じ頂点＝同じ点）。canon[i]＝同じ丸め座標で最初に現れた頂点の番号。
// 丸め＝lon/lat（rad）×1e8・高さ×10 を Math.round して >>>0（u32）。旧＝頂点ごとに BigInt を 3 個作り 96bit の鍵で Set/Map
// （三角形は 288bit）＝30 万頂点・20 万三角形で 480ms の大半が BigInt の確保と比較だった。u32 の 3 つ組を開番地ハッシュで引く＝同じ同一性・同じ順（約 5 倍速い）
// sLL／sH＝丸めの刻み（rad・m の逆数）。既定＝1e8（≈6 cm）・10（0.1 m）＝PLATEAU の両面出力の重複を捕まえる粗さ。
// 模型（glb）は 1e10（≈0.6 mm）・1000（1 mm）＝1 m 級の模型（Cesium Man 1.2 m・4672 三角形）を 6 cm で丸めると 6 割の三角形が「重複」で消え、裂けて写った（2026-10-28）
function canonVerts(geo: Float64Array, M: number, sLL = 1e8, sH = 10): Uint32Array {
	const q = new Uint32Array(M * 3);
	for (let i = 0; i < M; i++) { q[i*3] = Math.round(geo[i*3] * sLL) >>> 0; q[i*3+1] = Math.round(geo[i*3+1] * sLL) >>> 0; q[i*3+2] = Math.round(geo[i*3+2] * sH) >>> 0; }
	let cap = 16; while (cap < M * 2) cap <<= 1;
	const tab = new Int32Array(cap).fill(-1), canon = new Uint32Array(M), mask = cap - 1;
	for (let i = 0; i < M; i++) {
		const x = q[i*3], y = q[i*3+1], z = q[i*3+2];
		let h = (Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA77) ^ Math.imul(z, 0xC2B2AE3D)) >>> 0;
		h = (h ^ (h >>> 15)) & mask;
		for (;;) {
			const j = tab[h];
			if (j < 0) { tab[h] = i; canon[i] = i; break; }
			if (q[j*3] === x && q[j*3+1] === y && q[j*3+2] === z) { canon[i] = j; break; }
			h = (h + 1) & mask;
		}
	}
	return canon;
}
// 重複三角形の除去：頂点の代表番号（canon）の組が同じ三角形＝巻き順・頂点共有に依らず同じ面。最初の 1 枚だけ残す（旧と同じ順）
function dedupTris(rawIdx: Uint32Array, canon: Uint32Array): Uint32Array {
	const T = rawIdx.length / 3 | 0, key = new Uint32Array(T * 3), dedup = new Uint32Array(rawIdx.length);
	let cap = 16; while (cap < T * 2) cap <<= 1;
	const tab = new Int32Array(cap).fill(-1), mask = cap - 1;
	let n = 0, di = 0;
	for (let k = 0; k < rawIdx.length; k += 3) {
		const a = rawIdx[k], b = rawIdx[k+1], c = rawIdx[k+2];
		let k0 = canon[a], k1 = canon[b], k2 = canon[c];
		if (k0 > k1) { const t = k0; k0 = k1; k1 = t; }
		if (k1 > k2) { const t = k1; k1 = k2; k2 = t; }
		if (k0 > k1) { const t = k0; k0 = k1; k1 = t; }
		let h = (Math.imul(k0, 0x9E3779B1) ^ Math.imul(k1, 0x85EBCA77) ^ Math.imul(k2, 0xC2B2AE3D)) >>> 0;
		h = (h ^ (h >>> 15)) & mask;
		let dup = false;
		for (;;) {
			const j = tab[h];
			if (j < 0) { tab[h] = n; break; }
			if (key[j*3] === k0 && key[j*3+1] === k1 && key[j*3+2] === k2) { dup = true; break; }
			h = (h + 1) & mask;
		}
		if (dup) continue;
		key[n*3] = k0; key[n*3+1] = k1; key[n*3+2] = k2; n++;
		dedup[di++] = a; dedup[di++] = b; dedup[di++] = c;
	}
	return dedup.slice(0, di);   // 実サイズへトリム（cacheに満杯バッファを残さない）
}

// バッチ1個（タイル列の一部）をデコードして単一メッシュへ。旧・全区一括処理と同じパイプラインをバッチ範囲に適用：
// dedup（重複面は同一タイル内が支配的＝バッチ内で完結）・接地グリッド（バッチbbox基準＝むしろ細かく効く）・RTE origin。
// wardMask には三角形が触れた区単位セルを累積（wardBbox 座標系・null可＝プール経路は maskCells だけ返し発注元が累積）。
// brid＝橋梁モード：①接地を「成分ごと」でなく「バッチ最低点」に＝桁・ケーブルが塔と非連結でも海面へ沈まない
// （成分接地だと吊橋の桁が自分の最低点で接地＝水面すれすれに落ちる。バッチ最低点＝橋脚基部≈ジオイド分を
//   一括で差し引くので、部材同士の相対高さが保たれる）②twoSided=1 を焼き込み＝FS が裏面 discard をやめる
// （ケーブル・柵など厚みゼロの開いた面は表裏2枚組で来る→dedup が1枚に潰す→片側から見えなくなるため）。
export async function decodeBatch(base: string, leaves: LeafTile[], wardMask: Uint8Array | null, wardBbox: ArrayLike<number> | null, onTile: (() => void) | null = null, brid = false, stop: (() => boolean) | null = null, laneOf: (() => string) | null = null): Promise<MeshOut | null> {
	// 中間データは plain JS Array に push しない：バッチで1700万push級になり要素タグ+GCで数秒を失う。
	// プリミティブごとに頂点数が既知なので typed セグメントを作り、バッチ末尾で一括結合（memcpy）する。
	// geo(lon/lat rad)は float64 必須：float32 の相対精度~1e-7 は rad で~0.6m＝dedup の丸め(1e-8rad≈6cm)を壊す。
	const segs: Array<{ geo: Float64Array; nrm: Int8Array; idx: Uint32Array }> = [];   // { geo:Float64Array, nrm:Int8Array(xyz+pad 4B), idx:Uint32Array }（idx はバッチ通し番号で焼き込み済み）
	let totalV = 0, totalI = 0, minH = Infinity;
	const exSet = EXCLUDE?.get(base) || null;   // この base で捨てる gml_id（無ければ従来どおり）
	let excludedTris = 0;
	function mergeTile(tile: Tile3DContent, T: ArrayLike<number> | null = null) {   // T＝タイルの transform（葉の xf・列優先 4x4）＝軸入替と RTC の「後」に掛ける（仕様）
		const tileRtc = tile.rtcCenter || tile.gltf?.extensions?.CESIUM_RTC?.center;
		const gmlIds = exSet ? tile.batchTableJson?.gml_id : null;   // b3dm の batch table（loaders.gl が JSON で持つ）
		// 新しめの地区(2025年生成・nusamai-gltf製)はCESIUM_RTC拡張を使わず、mesh参照ノードの translation/matrix に
		// 平行移動を持たせる。node.translation/matrix は頂点POSITIONと同じY-upローカル系＝頂点と一緒に最後に
		// Yup→Zup軸入替(x,-z,y)を通す（生のまま使うと南半球の別地点へ飛ぶ）。
		// 行列は平行移動だけ拾うのでなく丸ごと使う：3DBAG（オランダ）は node.matrix に「量子化された[-1,1]立方体
		// →タイルbbox」の非等方スケール（実測 497×324×3267m）が入っており、平行移動だけだと66kmの塊になる。
		// PLATEAU は線形部が単位行列＝同じ道を通って従来と1ビットも変わらない。mesh(オブジェクト参照)→変換のマップ。
		const xfByMesh = new Map<GltfMesh, { m: number[] | null; t: number[] }>();
		for (const nd of (tile.gltf?.nodes || [])) {
			if (!nd.mesh) continue;
			const M = nd.matrix;
			if (M) xfByMesh.set(nd.mesh, { m: [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]], t: [M[12], M[13], M[14]] });
			else if (nd.translation) xfByMesh.set(nd.mesh, { m: null, t: nd.translation });
		}
		for (const m of (tile.gltf?.meshes || [])) {
			// 2つの原点は座標系が違う＝足す場所も違う（ここを取り違えると建物が世界中に散り、bboxが巨大化して
			// フラスタムカリングが効かなくなる＝日本が丸ごと重くなる。2026-08-11 に一度やった）：
			//   CESIUM_RTC（b3dm の RTC_CENTER）＝既に ECEF ＝ 軸入替の「後」に足す
			//   node の matrix/translation ＝頂点と同じ Y-up ローカル系 ＝ 軸入替の「前」に掛けて足す
			const xf = xfByMesh.get(m) || { m: null, t: [0, 0, 0] };
			const lin = tileRtc ? null : xf.m, tr: number[] = tileRtc ? [0, 0, 0] : xf.t;
			const rtcE: number[] = tileRtc || [0, 0, 0];
			// 保険：実効原点が地表から明らかに外れていたら(=CESIUM_RTCもnodeの変換も見つからなかった/壊れていた)
			// そのmeshは丸ごと捨てる。ローカル座標をECEF原点近くに置いたまま混ぜるとbbox・接地・マスクまで壊すため。
			const o0 = tr[0] + rtcE[0], o1 = -tr[2] + rtcE[1], o2 = tr[1] + rtcE[2];
			const rtcR = T ? Math.hypot(T[0] * o0 + T[4] * o1 + T[8] * o2 + T[12], T[1] * o0 + T[5] * o1 + T[9] * o2 + T[13], T[2] * o0 + T[6] * o1 + T[10] * o2 + T[14]) : Math.hypot(o0, o1, o2);
			if (rtcR < 6200000 || rtcR > 6500000) { console.warn("[mesh] mesh dropped (bad rtc origin)", tr, rtcE); continue; }
			// 法線は行列の余因子（=逆転置の定数倍。列ごとに c1×c2, c2×c0, c0×c1）で送る＝非等方スケールでも
			// 面の向きが狂わない。長さは後段で正規化するので定数倍は無害。線形部なし（PLATEAU）なら素通し。
			const cof = lin && [
				lin[4] * lin[8] - lin[5] * lin[7], lin[5] * lin[6] - lin[3] * lin[8], lin[3] * lin[7] - lin[4] * lin[6],
				lin[7] * lin[2] - lin[8] * lin[1], lin[8] * lin[0] - lin[6] * lin[2], lin[6] * lin[1] - lin[7] * lin[0],
				lin[1] * lin[5] - lin[2] * lin[4], lin[2] * lin[3] - lin[0] * lin[5], lin[0] * lin[4] - lin[1] * lin[3]];
			for (const pr of (m.primitives || [])) {
				const acc = pr.attributes?.POSITION; const P = acc?.value; if (!P) continue;
				const NRM = pr.attributes?.NORMAL?.value;
				// KHR_mesh_quantization：normalized な整数配列は [-1,1]（符号付き）/[0,1] へ戻してから行列へ。
				// 3DBAG は int16 normalized。PLATEAU は float32 のメートル＝q=1 で素通し。
				const q = acc.normalized ? (P instanceof Int8Array ? 1 / 127 : P instanceof Uint8Array ? 1 / 255
					: P instanceof Int16Array ? 1 / 32767 : P instanceof Uint16Array ? 1 / 65535 : 1) : 1;
				const qLo = (P instanceof Int8Array || P instanceof Int16Array) ? -1 : 0;   // 符号付き normalized の下限クランプ（仕様）
				const I = pr.indices?.value, n = P.length / 3;
				// 法線は int8 量子化（xyz+pad の4B/頂点＝float32×3 の 1/3）。FS が normalize するので精度 1/127 で十分。
				const geoSeg = new Float64Array(n * 3), nrmSeg = new Int8Array(n * 4);
				// 分岐はループの外で決める（頂点は1タイル10万個級＝ここに三項演算子を置くと素の日本経路まで重くなる）。
				// simple＝PLATEAU 経路（メートルのfloat＋平行移動のみ）＝式は改修前と1文字も変わらない足し算3本。
				// ox/oy/oz＝実効ECEFオフセット（node平行移動は軸入替を先に済ませ、CESIUM_RTC はそのまま足す）。
				const simple = q === 1 && !lin;
				const Tc = T && [   // T の線形部の余因子（法線用・列優先 3x3）
					T[5] * T[10] - T[6] * T[9], T[6] * T[8] - T[4] * T[10], T[4] * T[9] - T[5] * T[8],
					T[9] * T[2] - T[10] * T[1], T[10] * T[0] - T[8] * T[2], T[8] * T[1] - T[9] * T[0],
					T[1] * T[6] - T[2] * T[5], T[2] * T[4] - T[0] * T[6], T[0] * T[5] - T[1] * T[4]];
				const ox = tr[0] + rtcE[0], oy = -tr[2] + rtcE[1], oz = tr[1] + rtcE[2];
				for (let i = 0; i < n; i++) {
					// local(Y-up)→ECEF：量子化解除 → 変換行列（線形部＋平行移動）→ Yup→Zup(x,-z,y) → geodetic(lon,lat,h)
					let ex: number, ey: number, ez: number;
					if (simple) { ex = P[i*3] + ox; ey = -P[i*3+2] + oy; ez = P[i*3+1] + oz; }
					else {
						const px = q === 1 ? P[i*3] : Math.max(P[i*3] * q, qLo);
						const py = q === 1 ? P[i*3+1] : Math.max(P[i*3+1] * q, qLo);
						const pz = q === 1 ? P[i*3+2] : Math.max(P[i*3+2] * q, qLo);
						const gx = lin ? lin[0] * px + lin[3] * py + lin[6] * pz + tr[0] : px + tr[0];
						const gy = lin ? lin[1] * px + lin[4] * py + lin[7] * pz + tr[1] : py + tr[1];
						const gz = lin ? lin[2] * px + lin[5] * py + lin[8] * pz + tr[2] : pz + tr[2];
						ex = gx + rtcE[0]; ey = -gz + rtcE[1]; ez = gy + rtcE[2];
					}
					if (T) { const a = ex, b = ey, c = ez; ex = T[0] * a + T[4] * b + T[8] * c + T[12]; ey = T[1] * a + T[5] * b + T[9] * c + T[13]; ez = T[2] * a + T[6] * b + T[10] * c + T[14]; }
					const g = ecef2geo(ex, ey, ez);
					if (g[2] < minH) minH = g[2];
					geoSeg[i*3] = g[0]; geoSeg[i*3+1] = g[1]; geoSeg[i*3+2] = g[2];
					// 法線：glTF(Y-up local)→ortho は方向を (nx, ny, -nz)（Yup→Zup＋ECEF→ortho軸swap の合成）。符号は FS で視線側へ。
					// 正規化してから量子化：非単位法線が混じると ×127 が ±127 を越え Int8 で符号が巻き戻る（壁が黒落ち/ちらつき）ため。
					if (NRM) {
						let ax = NRM[i*3], ay = NRM[i*3+1], az = NRM[i*3+2];
						if (cof) { const a = ax, b = ay, c = az;   // 余因子行列で局所→世界（非等方スケール対応。PLATEAUは cof=null＝素通り）
							ax = cof[0] * a + cof[3] * b + cof[6] * c; ay = cof[1] * a + cof[4] * b + cof[7] * c; az = cof[2] * a + cof[5] * b + cof[8] * c; }
						if (Tc) { const a = ax, b = -az, c = ay;   // タイルの transform＝ECEF 系（x,-z,y）で余因子を掛けて戻す
							const e0 = Tc[0] * a + Tc[3] * b + Tc[6] * c, e1 = Tc[1] * a + Tc[4] * b + Tc[7] * c, e2 = Tc[2] * a + Tc[5] * b + Tc[8] * c; ax = e0; ay = e2; az = -e1; }
						const nx = ax, ny = ay, nz = -az;
						const s = 127 / (Math.hypot(nx, ny, nz) || 1);
						nrmSeg[i*4] = Math.round(nx * s); nrmSeg[i*4+1] = Math.round(ny * s); nrmSeg[i*4+2] = Math.round(nz * s);
					} else { nrmSeg[i*4+1] = 127; }
				}
				let idxSeg = new Uint32Array(I ? I.length : n);
				if (I) for (let k = 0; k < I.length; k++) idxSeg[k] = I[k] + totalV;
				else for (let k = 0; k < n; k++) idxSeg[k] = totalV + k;
				// 除外地物（plateau-exclude.json）：頂点の batch id（Draco は CUSTOM_ATTRIBUTE_3・素の glTF は _BATCHID）→ gml_id で三角形ごと捨てる
				const BID = exSet && gmlIds ? (pr.attributes!.CUSTOM_ATTRIBUTE_3?.value || pr.attributes!._BATCHID?.value) : null;
				if (BID) {
					const keep = new Uint32Array(idxSeg.length); let ki = 0;
					for (let k = 0; k + 2 < idxSeg.length; k += 3) {
						const v = idxSeg[k] - totalV;   // このプリミティブ内の頂点番号
						if (exSet!.has(gmlIds![Math.round(BID[v])])) { excludedTris++; continue; }
						keep[ki++] = idxSeg[k]; keep[ki++] = idxSeg[k + 1]; keep[ki++] = idxSeg[k + 2];
					}
					idxSeg = keep.subarray(0, ki);
				}
				segs.push({ geo: geoSeg, nrm: nrmSeg, idx: idxSeg });
				totalV += n; totalI += idxSeg.length;
			}
		}
	}
	// タイル取得+デコードを並行プールで回す。mergeTile は同期＝JSシングルスレッドなので並行fetch中でも競合しない。
	let ti = 0;
	async function tileWorker(wi: number) {
		while (ti < leaves.length) {
			if (stop?.()) return;   // 協調キャンセル：離脱区の残りタイルは fetch しない（帯域を現役区へ返す）
			if (laneOf?.() === "slow") {
				// slow lane＝実働1本へ縮退。残りは「待機」＝promote(fast復帰)の瞬間に全並行が即蘇る。
				// 旧・return で降ろすと復帰後も現行バッチの末尾まで1本のまま＝復帰直後の目の前のバッチ
				//（近傍優先ソートの先頭）が直列で這う＝「必要になっても回復しない」体感（Kenji 指摘 2026-08-02）。
				if (wi > 0) { await new Promise(r => setTimeout(r, 300)); continue; }
				await new Promise(r => setTimeout(r, 250));    // 間隔を空けて帯域/CPUを現地点の fast ロードへ明け渡す
			}
			const t = leaves[ti++];
			try {
				const ab = await fetchAB(t.uri);   // 25s タイムアウト＋1リトライ＝ハング接続で worker 枠を殺さない
				// excludeExtensions: loaders.gl の流儀＝「キーを載せて値false」で当該拡張の処理を除外。
				// EXT_mesh_features/EXT_structural_metadata＝属性メタデータ用（未使用・特定構成でのassert回避）。
				// EXT_texture_webp＝webpテクスチャ版アセット（2025 re-publish以降のbrid等）が extensionsRequired に
				// 宣言するだけで preprocess が throw する（worker内はwebp判定不能）。テクスチャは不使用＝安全に除外。
				// loadImages:false: テクスチャ版しか無い区(約35)でJPEGデコードを丸ごと省く（色は使わない）。
				const { loadParse, Tiles3DLoader } = await loaders();
				const tile = await loadParse(fixMeshoptGlb(ab), Tiles3DLoader, { "3d-tiles": { loadGLTF: true }, gltf: { loadImages: false, excludeExtensions: { EXT_mesh_features: false, EXT_structural_metadata: false, EXT_texture_webp: false, EXT_texture_avif: false } } });   // EXT_texture_avif: false＝loaders.gl 4.5 の AVIF 判定（getSupportedImageFormats）は worker に無い Image を new して倒れる＝外す
				mergeTile(tile as Tile3DContent, t.xf ?? null);
			} catch (e) { console.warn("[mesh] tile failed", t.uri, (e as Error).message); }
			onTile && onTile();   // 成否に関わらず歩数は進む＝分母が縮まない
		}
	}
	await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, leaves.length) }, (_, wi) => tileWorker(wi)));
	if (excludedTris) console.log(`[mesh] excluded ${excludedTris} tris (plateau-exclude.json)`, base);
	if (!totalI) return null;
	// セグメントを一括結合（memcpy）。idx はセグメント生成時にバッチ通し番号で焼き込み済み＝コピーだけで整合。
	const geo = new Float64Array(totalV * 3), outNrm = new Int8Array(totalV * 4), rawIdx = new Uint32Array(totalI);
	{
		let vtx = 0, io = 0;
		for (const s of segs) { geo.set(s.geo, vtx * 3); outNrm.set(s.nrm, vtx * 4); rawIdx.set(s.idx, io); vtx += s.geo.length / 3; io += s.idx.length; }
		segs.length = 0;
	}
	return finishMesh(geo, outNrm, rawIdx, minH, wardMask, wardBbox, brid);
}

// 後段＝「経緯度＋法線＋index の生メッシュ」を GPU へ送る形に仕上げる（dedup→bbox→剛体接地→LOD 焼き→RTE→被覆マスク断片→溶接）。
// decodeBatch（PLATEAU/3D Tiles）と decodeModel（glTF/GLB 直読み・2026-09-20）が同じ後段を通る＝置き方が違うだけで立ち方は同じ。
// 本体は decodeBatch の末尾からの「動作を変えない移動」（引数＝元のローカル変数そのまま）。
// groundBatch＝接地の単位：true＝バッチ最低点で一体（橋梁・単体の模型）／false＝連結成分ごと（街の一区画＝斜面や
// 高台の建物が浮かない。PLATEAU LOD3 を切り出した名所模型はこちら・2026-09-21 大阪城/岐阜城/松江城が浮いた）
// 経緯度（rad）＋相対高さ hr（m/世界単位）→ 世界座標（finishMesh の頂点と同じ式・#43）。点群（tiles3d-decode の pointsOut）が使う。
//   球＝単位球×(1+hr)／楕円体＝β単位球の面点 u(β) ＋ 測地法線の β空間像に沿うリフト（S は renderer の mvp が畳む）。
export const earthW = (): number => EARTH_W;
export function geoWorld<O extends { [i: number]: number }>(lon: number, lat: number, hr: number, out: O): O {
	const cb = Math.cos(lat), sp = Math.sin(lat);
	if (!ELL) { const r = 1 + hr; out[0] = cb*Math.cos(lon)*r; out[1] = sp*r; out[2] = cb*Math.sin(lon)*r; return out; }
	const w = Math.hypot(cb, ELL_RAX * sp), horiz = cb / w + hr * cb;
	out[0] = horiz * Math.cos(lon); out[1] = ELL_RAX * sp / w + hr * sp / ELL_RAX; out[2] = horiz * Math.sin(lon);
	return out;
}
export function finishMesh(geo: Float64Array, outNrm: Int8Array, rawIdx: Uint32Array, minH: number, wardMask: Uint8Array | null, wardBbox: ArrayLike<number> | null, brid: boolean, extra: { uv: Float32Array; col: Uint8Array; mc?: Float32Array; uvm?: Float32Array } | null = null, groundBatch = brid): MeshOut {   // extra＝{uv,col}（模型）＝頂点属性を素通し・溶接しない
	// 重複三角形（double-sided/coincident 面）除去＝マダラ(z-fight)の元を断つ。頂点位置(丸め)の3つ組で判定＝巻き順・頂点共有に非依存。
	// 重複は同一タイル内（nusamai両面出力等）が支配的＝バッチ内 dedup で実質すべて捕まる。
	const M = geo.length / 3;
	const canon = extra ? canonVerts(geo, M, 1e10, 1000) : canonVerts(geo, M);   // 模型（extra＝uv/頂点色つき）は mm の刻み＝小さな模型の三角形を重複と見ない（2026-10-28）
	const outIdx = dedupTris(rawIdx, canon);
	// bbox(deg)：renderer側フラスタムカリングに使う。geo は rad なので deg へ。
	let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
	for (let i = 0; i < M; i++) { const lo = geo[i*3], la = geo[i*3+1]; if (lo<minLon) minLon=lo; if (lo>maxLon) maxLon=lo; if (la<minLat) minLat=la; if (la>maxLat) maxLat=la; }
	const bbox = [minLon*R2D, minLat*R2D, maxLon*R2D, maxLat*R2D];
	// 接地v3：建物（連結成分）単位の剛体接地＝各成分から「自分の最低頂点（基部）」の標高を差し引く。
	// v2までの「グリッド場（セル最低標高→空セル充填→平滑→バイリニア）」は、建物が疎な急斜面で
	// 空セル充填が谷側の低い値を引きずり、平滑がそれを実測セルへ混ぜて地面を過小評価＝建物が浮く
	// （京都嵯峨野で実測+19〜40m。セルを32mに細かくしても直らない＝方式の欠陥）。
	// 剛体移動なら浮きもセル境界シアーも原理的に無い。斜面の建物は基部最低点で接地＝上り側が僅かに
	// 沈む方向（浮きより無害。地形は都市帯で深度を書かない背景＝沈み込みは見えない）。
	// 連結判定＝三角形の頂点共有 ＋ 丸め座標一致の頂点同一視（壁・屋根が別プリミティブでも境界座標は
	// 厳密一致するため。canonVerts の丸め＝dedup と同じ 6cm/0.1m）。
	const parent = new Int32Array(M);
	for (let i = 0; i < M; i++) parent[i] = i;
	const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
	const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
	for (let i = 0; i < M; i++) if (canon[i] !== i) union(canon[i], i);   // 丸め座標が同じ頂点を同一視（最初に現れた頂点と・旧の firstByKey と同じ順）
	for (let k = 0; k < outIdx.length; k += 3) { union(outIdx[k], outIdx[k+1]); union(outIdx[k], outIdx[k+2]); }
	const minAlt = new Float64Array(M).fill(Infinity);   // 成分代表 → 成分の最低標高（基部）
	const maxAlt = new Float64Array(M).fill(-Infinity);  // 成分代表 → 最高標高（max-min＝建物の高さ。LOD並べ替えのキー）
	for (let i = 0; i < M; i++) { const r = find(i), h = geo[i*3+2]; if (h < minAlt[r]) minAlt[r] = h; if (h > maxAlt[r]) maxAlt[r] = h; }
	// 接地v5＝v3（成分単位の剛体接地）の2つの盲点を塞ぐ。どちらも「自分の最低点を海抜0へ」が仇になるケース：
	// (a) 地下構造物の浮上：完全地下のソリッド（地下駐車場・地下街・坑体）は基部差引で地表に立ち上がる
	//     （実測: 西新宿 z17.8/75t＝新宿中央公園に地下駐車場の函体・青梅街道の坑体2本が巨大な板として並ぶ「二重」）。
	//     対策＝近傍の成分基部の中央値から局所地面を推定し、頂部がどの近傍地面よりも低い成分は「地面下へ沈める」
	//     （頂部を-0.5mへ＝基図の地面が深度で覆う。三角形は削らない＝index/LOD/マスクの再配管なし・不可視の微小オーバードロー）。
	// (b) 空中部材の落下：超高層の冠・段状屋根・塔屋が壁と頂点を共有しない別ソリッドだと、空中の基部ごと接地され
	//     頂部だけが地面に落ちる。対策＝成分中心を2D bboxに含む「8m以上低い成分」の基部を借りて接地（剛体のまま実高度へ）。
	//     閾値8m＝斜面の隣家bbox借用（数mの浮き）を防ぎつつ、冠・塔屋（基部が塔の基部から数十m上）は確実に拾う。
	{
		const roots: number[] = [], rBox = new Map<number, number[]>();   // 成分代表 → 2D bbox [minLon,minLat,maxLon,maxLat]（rad）
		for (let i = 0; i < M; i++) {
			const r = find(i);
			let b = rBox.get(r);
			if (!b) { rBox.set(r, b = [Infinity, Infinity, -Infinity, -Infinity]); roots.push(r); }
			const lo = geo[i*3], la = geo[i*3+1];
			if (lo < b[0]) b[0] = lo; if (la < b[1]) b[1] = la;
			if (lo > b[2]) b[2] = lo; if (la > b[3]) b[3] = la;
		}
		// バッチbbox上のセルグリッド（座標は上のbbox計算と同じrad）：中心セル＝地面推定の票、bbox掛かり＝重なり候補。
		const G = 64, sLo = (maxLon - minLon) || 1e-12, sLa = (maxLat - minLat) || 1e-12;
		const cellX = (v: number) => Math.max(0, Math.min(G - 1, (v - minLon) / sLo * G | 0));
		const cellY = (v: number) => Math.max(0, Math.min(G - 1, (v - minLat) / sLa * G | 0));
		const grid = new Map<number, number[]>();     // セル番号 → bboxが掛かる成分代表（(b)の重なり候補）
		const baseVotes = new Map<number, number[]>();   // セル番号 → 中心がそのセルに落ちる成分の基部標高（(a)の地面票）
		const center = new Map<number, [number, number, number]>();   // 成分代表 → [cx, cy, 中心セル番号]
		for (const r of roots) {
			const b = rBox.get(r)!, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, ck = cellY(cy) * G + cellX(cx);
			center.set(r, [cx, cy, ck]);
			let v = baseVotes.get(ck); if (!v) baseVotes.set(ck, v = []);
			v.push(minAlt[r]);
			for (let y = cellY(b[1]); y <= cellY(b[3]); y++) for (let x = cellX(b[0]); x <= cellX(b[2]); x++) {
				const k = y * G + x;
				let a = grid.get(k); if (!a) grid.set(k, a = []);
				a.push(r);
			}
		}
		const cellGround = new Map<number, number>();   // 占有セル → 地面推定（そのセルに立つ成分基部の中央値）
		for (const [k, v] of baseVotes) { v.sort((a, b) => a - b); cellGround.set(k, v[v.length >> 1]); }
		// (a) 完全地下の判定＝二重条件（両方成立で「地中」確定・候補ゼロの孤立成分は触らない）：
		//   ①頂部 < 近傍（半径3セル）の占有セル地面の「中央値」−1 …大きな函体は自分の基部票で自セル地面を汚染する
		//     （公園の地下駐車場＝自セル−25mが唯一の票）ため、min では永遠に地中にならない。中央値は周囲の街の基部が制す。
		//   ②頂部 < 「自分のbbox外」のセル地面の最小値 −1 …崖下・谷底の実在建物は、自分達の基部が作る低いセル地面が
		//     ①の中央値を守れない事がある（急斜面）。最も低い他人の地面よりさらに低い時だけ地中と認める＝安全側の錠。
		const dead = new Set<number>();
		for (const r of roots) {
			const [, , ck] = center.get(r)!, cx0 = ck % G, cy0 = (ck / G) | 0;
			const b = rBox.get(r)!;
			const bx0 = cellX(b[0]), bx1 = cellX(b[2]), by0 = cellY(b[1]), by1 = cellY(b[3]);   // 自分の足元セル範囲
			const gs: number[] = []; let minOut = Infinity;
			for (let y = Math.max(0, cy0 - 3); y <= Math.min(G - 1, cy0 + 3); y++)
				for (let x = Math.max(0, cx0 - 3); x <= Math.min(G - 1, cx0 + 3); x++) {
					const cg = cellGround.get(y * G + x);
					if (cg === undefined) continue;
					gs.push(cg);
					if ((x < bx0 || x > bx1 || y < by0 || y > by1) && cg < minOut) minOut = cg;
				}
			if (!gs.length || minOut === Infinity) continue;
			gs.sort((a, c) => a - c);
			const med = gs[gs.length >> 1];
			if (maxAlt[r] < med - 1 && maxAlt[r] < minOut - 1) dead.add(r);
		}
		for (const r of dead) minAlt[r] = maxAlt[r] + 0.5;   // 沈める＝頂部が-0.5m（平らな都市地面の下＝不可視）
		// (b) 借り接地：借用は全成分の判定後に一括適用＝元のminAltだけを読む（連鎖の順序依存を断つ）。地下成分は貸借対象外。
		const borrowed = new Map<number, number>();
		for (const r of roots) {
			if (dead.has(r)) continue;
			const [cx, cy, ck] = center.get(r)!;
			let g = minAlt[r];
			for (const o of grid.get(ck) || []) {
				if (dead.has(o) || minAlt[o] >= g) continue;
				const ob = rBox.get(o)!;
				if (cx >= ob[0] && cx <= ob[2] && cy >= ob[1] && cy <= ob[3]) g = minAlt[o];
			}
			if (minAlt[r] - g > 8) borrowed.set(r, g);
		}
		for (const [r, g] of borrowed) minAlt[r] = g;
	}
	// LOD並べ替え＝gintのVWランクのメッシュ版：三角形を建物（連結成分）の高さ降順に並べ、描画は index 先頭 count で
	// 打ち切れる形に焼く。lodCounts[k]＝高さ LOD_H[k] 以上の建物だけ描く時の drawElements count（CPUゼロ・シェーダ変更ゼロ）。
	// キーは Float64 パック（高さ6.25cm刻み16bit + 元三角形番号32bit ＝ 48bit < 仮数53bit）＝コンパレータ無しの高速ソート。
	// 同高さは元順のまま＝同一タイル由来の三角形が隣接（頂点キャッシュの局所性を崩さない）。
	const nTri = outIdx.length / 3;
	const lodKeys = new Float64Array(nTri);
	for (let t = 0; t < nTri; t++) {
		const r = find(outIdx[t*3]);
		const hq = Math.min(65535, (maxAlt[r] - minAlt[r]) * 16 | 0);
		lodKeys[t] = (65535 - hq) * 4294967296 + t;   // 高い建物ほど小さいキー＝先頭へ
	}
	lodKeys.sort();
	const sortedIdx = new Uint32Array(outIdx.length);
	for (let t = 0; t < nTri; t++) {
		const src = (lodKeys[t] % 4294967296) * 3;
		sortedIdx[t*3] = outIdx[src]; sortedIdx[t*3+1] = outIdx[src+1]; sortedIdx[t*3+2] = outIdx[src+2];
	}
	outIdx.set(sortedIdx);
	const lodCounts: number[] = Array(LOD_H.length).fill(outIdx.length);   // 既定＝全描画（その高さ未満の建物が無いバッチ）
	for (let t = 0, li = LOD_H.length - 1; t < nTri && li > 0; t++) {
		const h = (65535 - Math.floor(lodKeys[t] / 4294967296)) / 16;
		while (li > 0 && h < LOD_H[li]) lodCounts[li--] = t * 3;
	}
	// RTE-lite：単位球の絶対座標は float32 だと建物1棟が~60段階に量子化される→重心(origin)相対の delta で精度を桁で戻す。
	const wpos = new Float64Array(geo.length);
	let ox = 0, oy = 0, oz = 0;
	for (let i = 0; i < M; i++) {
		const lon = geo[i*3], lat = geo[i*3+1], cb = Math.cos(lat), sp = Math.sin(lat);
		const hr = (geo[i*3+2] - (groundBatch ? minH : minAlt[find(i)])) / EARTH_W;   // 基部からの相対高さ＝剛体接地（橋梁/単体模型はバッチ最低点＝部材の相対高さ保存）
		let x: number, y: number, z: number;
		if (!ELL) { const r = 1 + hr; x = cb*Math.cos(lon)*r; y = sp*r; z = cb*Math.sin(lon)*r; }
		else {   // β単位球の面点 u(β) ＋ 測地法線の β空間像 m=(cbcosλ, sinφ/r, cbsinλ) に沿うリフト（S は renderer の mvp が畳む）
			const w = Math.hypot(cb, ELL_RAX * sp), horiz = cb / w + hr * cb;
			x = horiz * Math.cos(lon); y = ELL_RAX * sp / w + hr * sp / ELL_RAX; z = horiz * Math.sin(lon);
		}
		wpos[i*3] = x; wpos[i*3+1] = y; wpos[i*3+2] = z; ox += x; oy += y; oz += z;
	}
	const origin = [ox / M, oy / M, oz / M];
	const outPos = new Float32Array(geo.length);
	for (let i = 0; i < M; i++) {
		outPos[i*3] = wpos[i*3] - origin[0]; outPos[i*3+1] = wpos[i*3+1] - origin[1]; outPos[i*3+2] = wpos[i*3+2] - origin[2];
	}
	// 被覆マスク：三角形が触れた wardBbox 座標系のセルを「このバッチの断片(maskCells)」として持つ。
	// 旧・区単位のwardMask累積は継続する（IDB meta 互換・ロールバック安全）が、描画へはもう送らない＝
	// renderer は届いたバッチの断片だけをOR合成する（マスクがメッシュに先行して「基図は伏せたのに
	// PLATEAUが無い」矩形の隙間を作る非対称の根治。demote/cancel/復元中断で顕在化していた）。
	let maskCells: Uint32Array | null = null;
	if (wardBbox) {   // wardMask=null（デコーダプール経路）でも断片は導出＝累積ORは発注元が maskCells で行う
		const wLo = wardBbox[0] / R2D, wLa = wardBbox[1] / R2D;   // マスク座標系は rad で統一（geo が rad のため）
		const spanLo = (wardBbox[2] - wardBbox[0]) / R2D || 1e-12, spanLa = (wardBbox[3] - wardBbox[1]) / R2D || 1e-12;
		const bm = new Uint8Array(MASK_N * MASK_N);   // このバッチ分だけの塗り
		for (let t = 0; t < outIdx.length; t += 3) {
			const a = outIdx[t], b = outIdx[t+1], c = outIdx[t+2];
			const lo0 = geo[a*3], lo1 = geo[b*3], lo2 = geo[c*3], la0 = geo[a*3+1], la1 = geo[b*3+1], la2 = geo[c*3+1];
			let cx0 = (Math.min(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0, cx1 = (Math.max(lo0,lo1,lo2) - wLo) / spanLo * MASK_N | 0;
			let cy0 = (Math.min(la0,la1,la2) - wLa) / spanLa * MASK_N | 0, cy1 = (Math.max(la0,la1,la2) - wLa) / spanLa * MASK_N | 0;
			if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > MASK_N-1) cx1 = MASK_N-1; if (cy1 > MASK_N-1) cy1 = MASK_N-1;
			for (let y = cy0; y <= cy1; y++) { const row = y*MASK_N; for (let x = cx0; x <= cx1; x++) { if (wardMask) wardMask[row+x] = 255; bm[row+x] = 1; } }
		}
		const cells: number[] = [];
		for (let i = 0; i < bm.length; i++) if (bm[i]) cells.push(i);
		maskCells = Uint32Array.from(cells);   // バッチは空間的に密＝典型数十〜数百セル（数百B）。永続化にも同乗する
	}
	// 頂点溶接（2026-09-07）：位置（1mm 格子）＋法線が一致する頂点を束ねる＝Draco 出力の三角形ごと非共有（nv≈3·nt）を
	// 4〜5 割減へ（GPU バイト・IDB/OPFS・頂点シェーダ回数）。三角形の並びは不変＝lodCounts はそのまま。maskCells は上で導出済み。
	if (extra) return { pos: outPos, nrm: outNrm, idx: outIdx, ...extra, origin, bbox, lodH: LOD_H, lodCounts, twoSided: brid ? 1 : 0, maskCells };   // 模型（uv/頂点色つき）＝溶接しない（位置＋法線一致でも uv が違う頂点を束ねてしまう）
	const welded = weldMesh({ pos: outPos, nrm: outNrm, idx: outIdx }, 0.001 / EARTH_W);
	return { pos: welded.pos, nrm: welded.nrm, idx: welded.idx, origin, bbox, lodH: LOD_H, lodCounts, twoSided: brid ? 1 : 0, maskCells };
}

// ── glTF/GLB 直読み（2026-09-20・本人裁定＝落とした地点＋埋め込みがあれば優先／PLATEAU 建物経路／loaders.gl）──
// 単体の glb/gltf を PLATEAU と同じ建物メッシュ（renderer の meshSet スロット）として立てる。decodeBatch と違い fetch も b3dm も
// 無し＝ArrayBuffer 一つを受けて finishMesh へ流すだけ（立ち方は PLATEAU と同じ・置き方だけ違う）。置き方は 3 段（上から順に当たった段）：
//   ① CESIUM_RTC（3D Tiles 由来の glb）… 頂点は RTC 相対の ECEF（Y-up）＝軸入替 (x,-z,y) の後に中心を足す（decodeBatch と同じ道）
//   ② シーン変換後のノード原点が地球半径近傍（ECEF を直に持つ glb）… 軸入替だけ
//   ③ それ以外（普通の 3D モデル＝ローカルのメートル・Y-up）… 錨 at=[lon,lat]（度）の ENU に立てる。X=東・Y=上・−Z=北
//      （Cesium が glTF を置く向きと同じ）。heading＝北から時計回りの度・scale＝倍率。錨の高さは持たない＝接地（下）が地面に置く。
// 接地＝brid と同じ「バッチ最低点」（模型は一体の剛体＝部品ごとに沈めない・空中の部品も相対高さのまま）・両面描画（開いた薄面の裏も
// 見える）・被覆マスクなし（基図の建物は伏せない）。ノード階層は TRS/matrix を根から合成（PLATEAU 経路の「mesh 直付けノードの
// matrix/translation だけ」より一般＝Sketchfab/Blender 書き出しの入れ子・回転・スケールが通る）。法線が無いプリミティブは三角形の
// 面法線を頂点へ積む（PLATEAU 経路の「上向き固定」は模型には粗い）。テクスチャ/マテリアルは読まない（色は建物色＝u_bldColor）。
const D2R = Math.PI / 180;
const I4 = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const m4mul = (a: ArrayLike<number>, b: ArrayLike<number>) => {   // 列優先 4x4（glTF の並び）＝ a·b
	const o = new Float64Array(16);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
	return o;
};
const m4trs = (t: ArrayLike<number> = [0, 0, 0], q: ArrayLike<number> = [0, 0, 0, 1], s: ArrayLike<number> = [1, 1, 1]) => {   // T·R·S（glTF node の既定の合成順）
	const [x, y, z, w] = q as [number, number, number, number], xx = x*x, yy = y*y, zz = z*z, xy = x*y, xz = x*z, yz = y*z, wx = w*x, wy = w*y, wz = w*z;
	return Float64Array.of(
		(1 - 2*(yy+zz)) * s[0], 2*(xy+wz) * s[0], 2*(xz-wy) * s[0], 0,
		2*(xy-wz) * s[1], (1 - 2*(xx+zz)) * s[1], 2*(yz+wx) * s[1], 0,
		2*(xz+wy) * s[2], 2*(yz-wx) * s[2], (1 - 2*(xx+yy)) * s[2], 0,
		t[0], t[1], t[2], 1);
};
const m3mul = (a: ArrayLike<number>, b: ArrayLike<number>) => {   // 列優先 3x3＝ a·b
	const o = new Float64Array(9);
	for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c*3+r] = a[r]*b[c*3] + a[3+r]*b[c*3+1] + a[6+r]*b[c*3+2];
	return o;
};
const m3v = (m: ArrayLike<number>, v: ArrayLike<number>): number[] => [m[0]*v[0] + m[3]*v[1] + m[6]*v[2], m[1]*v[0] + m[4]*v[1] + m[7]*v[2], m[2]*v[0] + m[5]*v[1] + m[8]*v[2]];
const I3 = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
const SWAP = Float64Array.of(1, 0, 0, 0, 0, 1, 0, -1, 0);   // (x,y,z)→(x,−z,y)＝glTF Y-up → ECEF/ENU の Z-up（decodeBatch の軸入替と同じ）
// ── マテリアル（2026-09-20 テクスチャ/マテリアル対応）──
// baseColor（factor＋texture＋COLOR_0）に加え、#46 段 2（2026-09-26）から PBR の材質も読む：metallicRoughness（factor＋texture＝G=粗さ・B=金属）・
// normalTexture（scale）・occlusionTexture（strength）・emissive（factor×texture×KHR_materials_emissive_strength）。描くのは WebGPU の模型パイプライン（GL2 は baseColor だけ）。
// KHR_materials_pbrSpecularGlossiness は diffuse* を baseColor として読む（鏡面側は読まない＝粗さ 1・金属 0）。KHR_texture_transform は uv に畳む（baseColor の物を全テクスチャに使う＝
// 別 TEXCOORD／別 transform の材質は baseColor の uv で読む＝ずれ得る・既知の限界）。alphaMode は MASK（alphaCutoff で抜く）と BLEND（半透明＝renderer が奥から手前に合成）をそのまま渡す。
// doubleSided は読まない＝模型は従来どおり両面（巻き順の怪しい模型に穴を開けない側）。
const texRef = (ti: GltfTexRef | null | undefined, gltf: GltfDoc): GltfTexture | null | undefined => ti ? (ti.texture || (typeof ti.index === "number" ? gltf.textures?.[ti.index] : null)) : null;   // 拡張側は postprocess が解決しない＝index で引く
const baseColorOf = (mat: GltfMaterial | null, gltf: GltfDoc) => {
	const mr = mat?.pbrMetallicRoughness, sg = mat?.extensions?.KHR_materials_pbrSpecularGlossiness;
	const factor = mr?.baseColorFactor || sg?.diffuseFactor || [1, 1, 1, 1];
	const ti = mr?.baseColorTexture || sg?.diffuseTexture || null;
	const texture = texRef(ti, gltf);
	const tt = ti?.extensions?.KHR_texture_transform || null;
	// uv の元＝baseColor の texCoord。baseColor にテクスチャが無い時は他の材質テクスチャ（MR→法線→AO→発光）の texCoord を使う
	const alt = [mr?.metallicRoughnessTexture, mat?.normalTexture, mat?.occlusionTexture, mat?.emissiveTexture].find(Boolean);
	return { factor, texture, texCoord: (tt?.texCoord ?? ti?.texCoord ?? alt?.texCoord) || 0, transform: tt };
};
const pbrOf = (mat: GltfMaterial | null, gltf: GltfDoc) => {   // 材質の数値と 4 枚のテクスチャ参照（無ければ null＝renderer が 1×1 の既定で埋める）
	const mr = mat?.pbrMetallicRoughness, sg = mat?.extensions?.KHR_materials_pbrSpecularGlossiness;
	const es = mat?.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1, ef = mat?.emissiveFactor || [0, 0, 0], cc = mat?.extensions?.KHR_materials_clearcoat;
	return {
		metallic: sg ? 0 : (mr?.metallicFactor ?? 1), roughness: sg ? 1 : (mr?.roughnessFactor ?? 1),
		normalScale: mat?.normalTexture?.scale ?? 1, occlusion: mat?.occlusionTexture?.strength ?? 1,
		emissive: [ef[0] * es, ef[1] * es, ef[2] * es],
		clearcoat: cc && (cc.clearcoatFactor ?? 0) > 0 ? [cc.clearcoatFactor ?? 0, cc.clearcoatRoughnessFactor ?? 0] : null,   // KHR_materials_clearcoat (factors; its textures are not read)
		texMR: sg ? null : texRef(mr?.metallicRoughnessTexture, gltf), texN: texRef(mat?.normalTexture, gltf), texOcc: texRef(mat?.occlusionTexture, gltf), texEm: texRef(mat?.emissiveTexture, gltf),
	};
};
const TEX_MAX = 2048;   // これより大きい画像は縮める（GPU 常駐と転送の上限＝模型 1 体に 4k を何枚も要らない）
async function textureOf(texture: GltfTexture | null | undefined, cache: Map<GltfImage, TexOut | null>): Promise<TexOut | null> {   // 解決済み texture → {bitmap} | {rgba,w,h} | null。同じ画像を複数マテリアルが使う時は 2 回目以降を複製
	// （ImageBitmap は transfer で切り離される＝バッチごとに別の実体が要る。デコード/縮小は 1 回）
	const img = texture?.source?.image; if (!img) return null;
	if (cache.has(img)) { const c = cache.get(img); if (!c) return null; return c.bitmap ? { bitmap: await createImageBitmap(c.bitmap) } : { rgba: c.rgba!.slice(), w: c.w, h: c.h }; }
	let out: TexOut | null = null;
	try {
		if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) {
			const s = Math.min(1, TEX_MAX / Math.max(img.width, img.height));
			out = { bitmap: s < 1 ? await createImageBitmap(img, { resizeWidth: Math.max(1, Math.round(img.width * s)), resizeHeight: Math.max(1, Math.round(img.height * s)), resizeQuality: "high" }) : img };
		} else if (img.data && img.width && img.height) {
			const rgba = img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray ? new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) : null;
			if (rgba && rgba.length === img.width * img.height * 4) out = { rgba: rgba.slice(), w: img.width, h: img.height };
		}
	} catch (e) { console.warn("[model] texture skipped", (e as Error | null)?.message); }
	cache.set(img, out);
	return out;
}
// featureId.texture → 画素ごとの番号。画像は ImageBitmap（loaders.gl が解いた物）か RGBA。画素を読む＝OffscreenCanvas の 2d（worker）
async function featureTexOf(fs: FeatureSet, gltf: GltfDoc, cache: Map<GltfImage, TexOut | null>): Promise<FeatureTexture | null> {
	const t = await textureOf(texRef({ index: fs.texInfo!.index }, gltf), cache); if (!t) return null;
	try {
		if (t.rgba) return featureTextureOf(t.rgba, t.w!, t.h!, fs.texInfo!, fs.nullFeatureId);
		if (!t.bitmap || typeof OffscreenCanvas === "undefined") return null;
		const { width: w, height: h } = t.bitmap, cx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
		if (!cx) return null;
		cx.drawImage(t.bitmap, 0, 0); t.bitmap.close();
		return featureTextureOf(cx.getImageData(0, 0, w, h, { colorSpace: "srgb" }).data, w, h, fs.texInfo!, fs.nullFeatureId);
	} catch (e) { console.warn("[model] feature ID texture skipped", (e as Error | null)?.message); return null; }
}
const dequant = (A: NumArr) => A instanceof Int8Array ? 1 / 127 : A instanceof Uint8Array ? 1 / 255 : A instanceof Int16Array ? 1 / 32767 : A instanceof Uint16Array ? 1 / 65535 : 1;   // 正規化整数属性の係数（float は 1）
// ---- Gaussian splat のプリミティブ（KHR_gaussian_splatting・Khronos の RC 2025・2026-10-18）----
//   mode 0（点）＋ primitive.extensions.KHR_gaussian_splatting。属性＝POSITION・KHR_gaussian_splatting:SCALE（線形の σ・VEC3）・:ROTATION（x,y,z,w）・:OPACITY（0〜1）・
//   :SH_DEGREE_l_COEF_k（VEC3・l＝0 が DC・l≧1 は m の低い方から）・COLOR_0（fallback＝線形の RGB＋α）。Cesium の草案（_SCALE／_ROTATION／_OPACITY・log の尺）も読む＝尺に負があれば log と見る。
//   色＝DC（0.282095×sh0＋0.5）→ sRGB の 0〜255（colorSpace lin_rec709_display は sRGB の伝達関数を掛ける・COLOR_0 は glTF の決まりで線形＝同じく）。SH の並び＝plugin の SplatData（係数が先・色が後）
const SPLAT_EXT = "KHR_gaussian_splatting";
const splatAttr = (pr: GltfPrimitive, name: string): GltfAccessor | undefined => pr.attributes?.[`${SPLAT_EXT}:${name}`] ?? pr.attributes?.[`_${name}`];
const srgb8 = (v: number): number => { const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };
const clamp8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const SH_C0 = 0.28209479177387814;
function splatPrim(pr: GltfPrimitive, gltf: GltfDoc, lin: ArrayLike<number>, o: ArrayLike<number>, lift: number): SplatPrimOut | null {
	const ext = (pr.extensions?.[SPLAT_EXT] ?? {}) as { colorSpace?: string }, colorSpace = typeof ext.colorSpace === "string" ? ext.colorSpace : "srgb_rec709_display", linear = colorSpace === "lin_rec709_display";
	const transform = [lin[0], lin[1], lin[2], 0, lin[3], lin[4], lin[5], 0, lin[6], lin[7], lin[8], 0, o[0], o[1], o[2], 1];   // 列優先（lin は列優先の 3×3）
	const empty = (spz: Uint8Array): SplatPrimOut => ({ n: 0, positions: new Float32Array(0), scales: new Float32Array(0), rotations: new Float32Array(0), colors: new Uint8Array(0), sh: null, shDegree: 0, transform, spz, colorSpace });
	const lifted = (out: SplatPrimOut, cx: number, cy: number, cz: number): SplatPrimOut => {   // heightOffset＝重心の ECEF の上向きに沿って持ち上げる（タイルの中身と同じ「高さへの足し込み」）
		if (!lift) return out;
		const ex = lin[0] * cx + lin[3] * cy + lin[6] * cz + o[0], ey = lin[1] * cx + lin[4] * cy + lin[7] * cz + o[1], ez = lin[2] * cx + lin[5] * cy + lin[8] * cz + o[2], l = Math.hypot(ex, ey, ez) || 1;
		out.transform[12] += lift * ex / l; out.transform[13] += lift * ey / l; out.transform[14] += lift * ez / l;
		return out;
	};
	// 圧縮（SPZ）＝bufferView の本体をそのまま持たせる（plugin の parseSpz が gzip を解いて読む・局所の座標は glTF の軸のまま＝transform で置く）
	const comp = Object.entries(pr.extensions || {}).find(([k]) => k.startsWith(`${SPLAT_EXT}_compression_spz`))?.[1] as { bufferView?: number } | undefined;
	if (comp && Number.isInteger(comp.bufferView)) {
		const data = gltf.bufferViews?.[comp.bufferView!]?.data;
		if (!data) return null;
		const P0 = pr.attributes?.POSITION as (GltfAccessor & { min?: number[]; max?: number[] }) | undefined, mn = P0?.min, mx = P0?.max;   // 重心の当ては accessor の min/max（本体は解いていない）
		return lifted(empty(data.slice()), mn && mx ? (mn[0] + mx[0]) / 2 : 0, mn && mx ? (mn[1] + mx[1]) / 2 : 0, mn && mx ? (mn[2] + mx[2]) / 2 : 0);
	}
	const P = pr.attributes?.POSITION?.value, S = splatAttr(pr, "SCALE")?.value, R = splatAttr(pr, "ROTATION")?.value;
	if (!P || !S || !R) return null;
	const n = P.length / 3 | 0;
	if (S.length < n * 3 || R.length < n * 4) return null;
	const qP = pr.attributes!.POSITION!.normalized ? dequant(P) : 1, qS = splatAttr(pr, "SCALE")!.normalized ? dequant(S) : 1, qR = splatAttr(pr, "ROTATION")!.normalized ? dequant(R) : 1;
	const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4);
	let cx = 0, cy = 0, cz = 0, sMin = Infinity;
	for (let i = 0; i < n * 3; i++) { positions[i] = P[i] * qP; const s = S[i] * qS; scales[i] = s; if (s < sMin) sMin = s; }
	for (let i = 0; i < n; i++) { cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2]; }
	const logScale = sMin < 0 || (!pr.attributes?.[`${SPLAT_EXT}:SCALE`] && !!pr.attributes?._SCALE);   // 草案（_SCALE）＝log の尺。仕様の名でも負があれば log（仕様の尺は非負）
	if (logScale) for (let i = 0; i < n * 3; i++) scales[i] = Math.exp(scales[i]);
	for (let i = 0; i < n; i++) { const x = R[i * 4] * qR, y = R[i * 4 + 1] * qR, z = R[i * 4 + 2] * qR, w = R[i * 4 + 3] * qR, l = Math.hypot(x, y, z, w) || 1; rotations[i * 4] = x / l; rotations[i * 4 + 1] = y / l; rotations[i * 4 + 2] = z / l; rotations[i * 4 + 3] = w / l; }
	// 色＝SH の DC（無ければ COLOR_0）・不透明度＝OPACITY（無ければ COLOR_0 の α・無ければ 1）
	const dcA = splatAttr(pr, "SH_DEGREE_0_COEF_0"), DC = dcA?.value, C0A = pr.attributes?.COLOR_0, C0 = C0A?.value, cN = C0 ? (C0.length / n) | 0 : 0, qC = C0 ? (C0A!.normalized ? dequant(C0) : 1) : 1;
	const OA = splatAttr(pr, "OPACITY"), O = OA?.value, qO = O ? (OA!.normalized ? dequant(O) : 1) : 1;
	const to8 = linear ? srgb8 : clamp8;
	for (let i = 0; i < n; i++) {
		if (DC && DC.length >= n * 3) { for (let c = 0; c < 3; c++) colors[i * 4 + c] = to8(SH_C0 * DC[i * 3 + c] + 0.5); }
		else if (C0 && cN >= 3) { for (let c = 0; c < 3; c++) colors[i * 4 + c] = srgb8(C0[i * cN + c] * qC); }   // COLOR_0 は線形（glTF）
		else { colors[i * 4] = colors[i * 4 + 1] = colors[i * 4 + 2] = 255; }
		colors[i * 4 + 3] = O && O.length >= n ? clamp8(O[i] * qO) : C0 && cN === 4 ? clamp8(C0[i * 4 + 3] * qC) : 255;
	}
	// SH（1〜3 次）＝そろっている次数まで（次数は部分的に欠けない＝欠けた所で止める）
	const coefs: Array<ArrayLike<number>> = [];
	let shDegree: 0 | 1 | 2 | 3 = 0;
	outer: for (let l = 1; l <= 3; l++) {
		const row: Array<ArrayLike<number>> = [];
		for (let k = 0; k < 2 * l + 1; k++) { const a = splatAttr(pr, `SH_DEGREE_${l}_COEF_${k}`)?.value; if (!a || a.length < n * 3) break outer; row.push(a); }
		coefs.push(...row); shDegree = l as 1 | 2 | 3;
	}
	let sh: Float32Array | null = null;
	if (shDegree) { const K = coefs.length; sh = new Float32Array(n * K * 3); for (let i = 0; i < n; i++) for (let k = 0; k < K; k++) { const a = coefs[k]; sh[(i * K + k) * 3] = a[i * 3]; sh[(i * K + k) * 3 + 1] = a[i * 3 + 1]; sh[(i * K + k) * 3 + 2] = a[i * 3 + 2]; } }
	return lifted({ n, positions, scales, rotations, colors, sh, shDegree, transform, spz: null, colorSpace }, n ? cx / n : 0, n ? cy / n : 0, n ? cz / n : 0);
}
// ---- voxel のプリミティブ（EXT_primitive_voxels＋KHR_implicit_shapes・2026-10-23）----
//   mode 2147483647（か extensions.EXT_primitive_voxels）。属性＝独自の意味（_DENSITY など・EXT_structural_metadata の propertyAttributes が class の性質に結ぶ）・accessor の count＝Π(dimensions＋padding)・並びは x が最速。
//   形＝KHR_implicit_shapes の shapes[ext.shape]：box（size・原点が中心）→ 単位立方体 → ECEF の transform、EXT_implicit_ellipsoid_region（rad）→ region、EXT_implicit_cylinder_region → cylinder（2026-10-26）。
//   形が無い（tileset の 3DTILES_content_voxels の経路）＝タイルの境界体積（box・region・cylinder）を使う。noData＝ext.noData[属性名]。padding は剥ぐ（隣のタイルとの補間用＝第 5 段）。
//   cylinder（仕様＝3DTILES_content_voxels の Notes）＝glTF は y が軸で dimensions／並びが [半径, 高さ, 角度]・角度 0 は glTF の −x。3D Tiles（と voxel の契約）は z が軸で [半径, 角度, 高さ]・角度 0 は +x
//     ＝y と z の添字を入れ替え、角度に +180°（全周でない境界体積は並びが同じ＝範囲をそのまま・全周の境界体積だけ添字が半周ずれる＝範囲に +180°）。
//     tileset の経路では glTF の形（大きさは単位の物）より境界体積が正（Cesium の見本も glTF に単位の形を持つ）。
const VOXEL_EXT = "EXT_primitive_voxels", VOXEL_MODE = 2147483647, STD_ATTR = /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+|JOINTS_\d+|WEIGHTS_\d+|_BATCHID|_FEATURE_ID_\d+)$/, R2D_ = 180 / Math.PI;
const liftXf = (T: number[], lift: number): number[] => {   // heightOffset＝箱の中心の地心の上向きに沿って持ち上げる
	if (!lift) return T;
	const cx = T[12] + 0.5 * (T[0] + T[4] + T[8]), cy = T[13] + 0.5 * (T[1] + T[5] + T[9]), cz = T[14] + 0.5 * (T[2] + T[6] + T[10]), l = Math.hypot(cx, cy, cz) || 1;
	T[12] += lift * cx / l; T[13] += lift * cy / l; T[14] += lift * cz / l;
	return T;
};
// 原点を地心の上向きに持ち上げる（cylinder＝原点が軸の上）
const liftOrigin = (T: number[], lift: number): number[] => { if (!lift) return T; const l = Math.hypot(T[12], T[13], T[14]) || 1; T[12] += lift * T[12] / l; T[13] += lift * T[13] / l; T[14] += lift * T[14] / l; return T; };
/** y と z の添字を入れ替える（glTF の [半径, 高さ, 角度] → [半径, 角度, 高さ]） */
function swapYZ<T extends Float32Array | Uint16Array | Uint8Array>(v: T, d: number[], c: number): T {
	const out = new (v.constructor as { new(n: number): T })(v.length);
	for (let k = 0; k < d[2]; k++) for (let j = 0; j < d[1]; j++) { const src = (d[0] * (j + d[1] * k)) * c, dst = (d[0] * (k + d[2] * j)) * c; out.set(v.subarray(src, src + d[0] * c), dst); }
	return out;
}
function voxelPrim(pr: GltfPrimitive, gltf: GltfDoc, lin: ArrayLike<number>, o: ArrayLike<number>, lift: number, tv: VoxelTileOpts): VoxelPrimOut | null {
	const ext = (pr.extensions?.[VOXEL_EXT] ?? {}) as { shape?: number; dimensions?: number[]; padding?: { before?: number[]; after?: number[] }; noData?: Record<string, number[]> };
	const shape = Number.isInteger(ext.shape) ? gltf.extensions?.KHR_implicit_shapes?.shapes?.[ext.shape!] : undefined;
	const cr = shape?.extensions?.EXT_implicit_cylinder_region as { minRadius?: number; maxRadius?: number; height?: number; minAngle?: number; maxAngle?: number } | undefined, volCyl = tv.volume?.cylinder ?? null;
	const cyl = !!(volCyl || cr);   // cylinder＝glTF の並び（[半径, 高さ, 角度]）。宣言（tileset）は [半径, 角度, 高さ]＝並べ替えて読む
	const yUp = (a: number[] | undefined): number[] | undefined => a && cyl ? [a[0], a[2], a[1]] : a;
	const dimsAll = ext.dimensions ?? yUp(tv.declared?.dimensions), pad = ext.padding ?? (tv.declared?.padding ? { before: yUp(tv.declared.padding.before), after: yUp(tv.declared.padding.after) } : undefined);
	if (!dimsAll || dimsAll.length !== 3 || !dimsAll.every(n => Number.isInteger(n) && n > 0)) return null;
	const pb = [0, 1, 2].map(i => pad?.before?.[i] ?? 0), pa = [0, 1, 2].map(i => pad?.after?.[i] ?? 0), full = [0, 1, 2].map(i => dimsAll[i] + pb[i] + pa[i]), dims: [number, number, number] = [dimsAll[0], dimsAll[1], dimsAll[2]];
	// 属性＝指定の名（class の性質名なら propertyAttributes で属性名へ）か、最初の独自属性
	const attrs = pr.attributes ?? {};
	let name: string | null = tv.property ?? null;
	if (name && !attrs[name]) { const pas = (gltf.extensions?.EXT_structural_metadata as { propertyAttributes?: Array<{ properties?: Record<string, { attribute?: string }> }> } | undefined)?.propertyAttributes; name = pas?.map(p => p.properties?.[name!]?.attribute).find(a => a && attrs[a]) ?? null; }
	if (!name) name = Object.keys(attrs).find(k => !STD_ATTR.test(k) && attrs[k]?.value) ?? null;
	const acc = name ? attrs[name] : undefined, V = acc?.value;
	if (!name || !V) return null;
	const total = full[0] * full[1] * full[2], comps = Math.round(V.length / total);
	if (!(comps === 1 || comps === 3 || comps === 4) || comps * total !== V.length) return null;
	// padding を剥ぎ、型を VoxelData の物に（1 成分＝Float32（Uint8／Uint16 はそのまま）・3〜4 成分＝RGBA（Uint8 はそのまま・他は 0〜1 の Float32））
	const outC = comps === 1 ? 1 : 4, n = dims[0] * dims[1] * dims[2], keep8 = V instanceof Uint8Array, keep16 = comps === 1 && V instanceof Uint16Array;
	const out = keep8 ? new Uint8Array(n * outC) : keep16 ? new Uint16Array(n * outC) : new Float32Array(n * outC), q = acc!.normalized && !keep8 && !keep16 ? dequant(V) : 1;
	for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
		const src = ((i + pb[0]) + full[0] * ((j + pb[1]) + full[1] * (k + pb[2]))) * comps, dst = (i + dims[0] * (j + dims[1] * k)) * outC;
		if (comps === 1) out[dst] = V[src] * q;
		else { for (let c = 0; c < 3; c++) out[dst + c] = V[src + c] * q; out[dst + 3] = comps === 4 ? V[src + 3] * q : keep8 ? 255 : 1; }
	}
	const nd = ext.noData?.[name]?.[0], base = { dims, components: outC as 1 | 4, values: out, property: name, ...(comps === 1 && typeof nd === "number" && Number.isFinite(nd) ? { noData: nd } : {}) };
	if (cyl) {   // cylinder＝[半径, 角度, 高さ] に並べ替え・境界体積が有ればそれ（tileset の経路）、無ければ glTF の形
		const cbase = { ...base, dims: [dims[0], dims[2], dims[1]] as [number, number, number], values: swapYZ(out, dims, outC) };
		if (volCyl) {
			const full = volCyl.angle[1] - volCyl.angle[0] >= 360 - 1e-6, T = liftOrigin([...volCyl.transform], lift);
			return { ...cbase, shape: "cylinder", cylinder: { transform: T, radius: [volCyl.radius[0], volCyl.radius[1]], height: [volCyl.height[0], volCyl.height[1]], angle: full ? [volCyl.angle[0] + 180, volCyl.angle[1] + 180] : [volCyl.angle[0], volCyl.angle[1]] } };
		}
		// glTF の局所（y が軸）→ 契約の局所（z が軸）＝x → x・y → −z_gl・z → y_gl（3D Tiles の向き）・角度は +180°
		const h = cr!.height ?? 0, T = [lin[0], lin[1], lin[2], 0, -lin[6], -lin[7], -lin[8], 0, lin[3], lin[4], lin[5], 0, o[0], o[1], o[2], 1];
		const a0 = (cr!.minAngle ?? -Math.PI) * R2D_ + 180, a1 = (cr!.maxAngle ?? Math.PI) * R2D_ + 180;
		if (!(h > 0) || !((cr!.maxRadius ?? 0) > (cr!.minRadius ?? 0))) return null;
		return { ...cbase, shape: "cylinder", cylinder: { transform: liftOrigin(T, lift), radius: [cr!.minRadius ?? 0, cr!.maxRadius!], height: [-h / 2, h / 2], angle: [a0, a1 > a0 ? a1 : a1 + 360] } };
	}
	if (shape) {
		const er = shape.extensions?.EXT_implicit_ellipsoid_region as { minLongitude?: number; maxLongitude?: number; minLatitude?: number; maxLatitude?: number; minHeight?: number; maxHeight?: number } | undefined;
		if (er) return { ...base, shape: "region", region: [(er.minLongitude ?? -Math.PI) * R2D_, (er.minLatitude ?? -Math.PI / 2) * R2D_, (er.maxLongitude ?? Math.PI) * R2D_, (er.maxLatitude ?? Math.PI / 2) * R2D_, (er.minHeight ?? 0) + lift, (er.maxHeight ?? 0) + lift] };
		if (shape.type === "cylinder") return null;   // KHR_implicit_shapes の素の cylinder（上下の半径・領域でない）＝voxel の格子の形ではない
		if (shape.type === "box" || shape.box) {   // 中心が原点＝単位立方体 u → (u − ½)·size → lin·p + o（lin は列優先）
			const s = shape.box?.size ?? [1, 1, 1];
			const T = [lin[0] * s[0], lin[1] * s[0], lin[2] * s[0], 0, lin[3] * s[1], lin[4] * s[1], lin[5] * s[1], 0, lin[6] * s[2], lin[7] * s[2], lin[8] * s[2], 0,
				o[0] - 0.5 * (lin[0] * s[0] + lin[3] * s[1] + lin[6] * s[2]), o[1] - 0.5 * (lin[1] * s[0] + lin[4] * s[1] + lin[7] * s[2]), o[2] - 0.5 * (lin[2] * s[0] + lin[5] * s[1] + lin[8] * s[2]), 1];
			return { ...base, shape: "box", transform: liftXf(T, lift) };
		}
		return null;
	}
	// 形が無い＝タイルの境界体積（tileset の 3DTILES_content_voxels の経路）
	const vol = tv.volume;
	if (vol?.box && vol.box.length === 12) {   // 中心＋半軸 3 本（ECEF）＝単位立方体 u → c + Σ(2u−1)·a
		const b = vol.box, T = [2 * b[3], 2 * b[4], 2 * b[5], 0, 2 * b[6], 2 * b[7], 2 * b[8], 0, 2 * b[9], 2 * b[10], 2 * b[11], 0, b[0] - b[3] - b[6] - b[9], b[1] - b[4] - b[7] - b[10], b[2] - b[5] - b[8] - b[11], 1];
		return { ...base, shape: "box", transform: liftXf(T, lift) };
	}
	if (vol?.region && vol.region.length === 6) { const r = vol.region; return { ...base, shape: "region", region: [r[0] * R2D_, r[1] * R2D_, r[2] * R2D_, r[3] * R2D_, r[4] + lift, r[5] + lift] }; }
	return null;
}
// ground＝"batch"（既定・一体で接地）／"each"（連結成分ごとに接地＝街の一区画を切り出した模型）
// mask＝模型の足元の基図建物を伏せる（PLATEAU と同じ被覆マスク）。街の一区画を切り出した模型は、基図の白い箱と
// 同じ建物を二重に描いて壁の絵が明滅する（本人 2026-09-21）＝模型もマスクを出して下の箱を伏せる。既定 false
// tile＝3D Tiles のタイルとして置く（#41・2026-09-23）＝{ places:[{ L:列優先3x3, t:[x,y,z] }]（タイル変換×インスタンス・ECEF）, rtc:[x,y,z]|null, baseH:m, points:true }。
//   頂点 ECEF = L·(rtc + Y2Z·W·p) + t（仕様どおり glTF の Y-up→Z-up はノード変換の後・RTC とタイル変換の前）。
//   baseH＝高さの基準（接地しない＝絶対高さ − baseH をそのまま持つ・呼び手は noLift で置く）。points＝点のプリミティブ（mode 0）を別に返す。
// Draco の属性の名（KHR_draco_mesh_compression.attributes）＝loaders.gl は glTF の既定の意味を持たない属性（_BATCHID・_FEATURE_ID_n 等）を
// CUSTOM_ATTRIBUTE_<unique id> と名付け、拡張を消してしまう＝生の json の対応で元の名を戻す（NYC の b3dm＝Draco 圧縮の _BATCHID・2026-10-29）
/** the line indices of a primitive's CESIUM_primitive_outline (the accessor resolved by loaders.gl, or its index), or null */
function outlineEdgesOf(pr: GltfPrimitive, gltf: GltfDoc): ArrayLike<number> | null {
	const ext = (pr.extensions as Record<string, { indices?: unknown }> | undefined)?.CESIUM_primitive_outline;
	if (!ext) return null;
	const a = ext.indices as { value?: ArrayLike<number> } | number | undefined;
	const v = typeof a === "number" ? (gltf as { accessors?: { value?: ArrayLike<number> }[] }).accessors?.[a]?.value : a?.value;
	return v && v.length >= 2 ? v : null;
}
/** a primitive's vertices copied where CesiumJS copies them and the outline coordinates packed into the normal's 4th byte (bits 0..2) */
function withOutline(seg: { geo: Float64Array; nrm: Int8Array; idx: Uint32Array; uv: Float32Array; col: Uint8Array; fid: Uint32Array | null; mc: Float32Array | null; uvm: Float32Array | null }, edges: ArrayLike<number>, n: number, base: number): void {
	const local = new Uint32Array(seg.idx.length);
	for (let k = 0; k < local.length; k++) local[k] = seg.idx[k] - base;
	const { idx, extra, bits } = primitiveOutline(local, edges, n);
	const grow = <T extends Float64Array | Float32Array | Int8Array | Uint8Array | Uint32Array>(a: T, c: number): T => {
		if (!extra.length) return a;
		const out = new (a.constructor as new (len: number) => T)((n + extra.length) * c);
		out.set(a);
		for (let i = 0; i < extra.length; i++) for (let j = 0; j < c; j++) out[(n + i) * c + j] = a[extra[i] * c + j];
		return out;
	};
	seg.geo = grow(seg.geo, 3); seg.nrm = grow(seg.nrm, 4); seg.uv = grow(seg.uv, 2); seg.col = grow(seg.col, 4);
	if (seg.fid) seg.fid = grow(seg.fid, 1);
	if (seg.mc) seg.mc = grow(seg.mc, 4);
	if (seg.uvm) seg.uvm = grow(seg.uvm, 2);
	for (let v = 0; v < bits.length; v++) seg.nrm[v * 4 + 3] = bits[v];
	for (let k = 0; k < idx.length; k++) idx[k] += base;
	seg.idx = idx;
}
// WEB3D_quantized_attributes (glTF 1.0 b3dm, e.g. Bentley ContextCapture): loaders.gl keeps the integer values and the extension on the accessor;
// Cesium decodes them with decodeMatrix (v' = M·[v, 1], (n+1)² column-major). Undecoded, a 276 m tile came out 65 km wide (drape-imagery-on-3d-tiles)
function dequantWeb3d(gltf: GltfDoc): void {
	const done = new Set<object>();
	for (const m of gltf.meshes || []) for (const pr of m.primitives || []) for (const a of Object.values(pr.attributes || {}) as Array<(GltfAccessor & { extensions?: Record<string, { decodeMatrix?: number[] }> }) | undefined>) {
		const M = a?.extensions?.WEB3D_quantized_attributes?.decodeMatrix, v = a?.value;
		if (!a || !M || !v || done.has(a)) continue;
		done.add(a);
		const c = Math.round(Math.sqrt(M.length)) - 1;
		if (c < 1 || (c + 1) * (c + 1) !== M.length || v.length % c) continue;
		const out = new Float32Array(v.length);
		for (let i = 0; i < v.length; i += c) for (let k = 0; k < c; k++) {
			let s = M[c * (c + 1) + k];
			for (let j = 0; j < c; j++) s += M[j * (c + 1) + k] * v[i + j];
			out[i + k] = s;
		}
		a.value = out; a.normalized = false; delete a.extensions!.WEB3D_quantized_attributes;
	}
}
function dracoNames(gltf: GltfDoc, raw: unknown): void {
	const rm = (raw as { meshes?: Array<{ primitives?: Array<{ extensions?: { KHR_draco_mesh_compression?: { attributes?: Record<string, number> } } }> }> } | null)?.meshes;
	if (!rm) return;
	(gltf.meshes || []).forEach((m, i) => (m.primitives || []).forEach((pr, j) => {
		const map = rm[i]?.primitives?.[j]?.extensions?.KHR_draco_mesh_compression?.attributes, at = pr.attributes;
		if (!map || !at) return;
		for (const [name, id] of Object.entries(map)) if (!at[name] && at[`CUSTOM_ATTRIBUTE_${id}`]) at[name] = at[`CUSTOM_ATTRIBUTE_${id}`];
	}));
}
// 利用者のシェーダの J（2026-10-29）＝positionMC の差分 → 世界（単位球）の差分＝世界の局所線形化（ECEF の 1 m の差分・ecef2geo＋geoWorld＝頂点と同じ道）× glTF のローカル → ECEF の線形部
function mcJOf(lin: ArrayLike<number> | undefined, e0: number[] | undefined, minH: number): number[] | null {
	if (!lin || !e0) return null;
	const w = (e: ArrayLike<number>) => { const g = ecef2geo(e[0], e[1], e[2]); return geoWorld(g[0], g[1], (g[2] - minH) / EARTH_W, [0, 0, 0]); };
	const w0 = w(e0), L = new Float64Array(9);
	for (let k = 0; k < 3; k++) { const e = [...e0]; e[k] += 1; const wk = w(e); L[k*3] = wk[0] - w0[0]; L[k*3+1] = wk[1] - w0[1]; L[k*3+2] = wk[2] - w0[2]; }
	return Array.from(m3mul(L, lin));
}
const schemaCache = new Map<string, Promise<Record<string, unknown> | null>>();
/** an external metadata schema (schemaUri, relative to the glTF): fetched once per URL; null when it cannot be read */
function externalSchema(uri: string, baseUri: string | null, f: typeof fetch): Promise<Record<string, unknown> | null> {
	let url: string;
	try { url = new URL(uri, baseUri ?? self.location?.href).href; } catch { return Promise.resolve(null); }
	let p = schemaCache.get(url);
	if (!p) {
		p = f(url).then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() as Promise<Record<string, unknown>>; })
			.catch(e => { console.warn("[model] metadata schema", url, (e as Error | null)?.message || e); return null; });
		schemaCache.set(url, p);
	}
	return p;
}
// glTF line primitives (LINES 1 / LINE_LOOP 2 / LINE_STRIP 3) as thin square tubes (a triangle primitive with COLOR_0 and no normals = drawn unlit,
// as Cesium draws lines). Width = 0.24% of the lines' bounding box diagonal (about a pixel when the model fills the view). An index equal to the
// largest value of its type restarts the strip/loop (KHR_mesh_primitive_restart)
function linePrimAsTubes(pr: GltfPrimitive, mode: number): GltfPrimitive | null {
	const acc = pr.attributes?.POSITION, P0 = acc?.value; if (!P0) return null;
	const q = acc!.normalized ? dequant(P0) : 1, n = P0.length / 3, I = pr.indices?.value ?? null;
	const restart = I instanceof Uint8Array ? 0xff : I instanceof Uint16Array ? 0xffff : I instanceof Uint32Array ? 0xffffffff : -1;
	const runs: number[][] = []; let cur: number[] = [];
	const m = I ? I.length : n;
	for (let k = 0; k < m; k++) { const v = I ? I[k] : k; if (v === restart) { if (cur.length) runs.push(cur); cur = []; } else cur.push(v); }
	if (cur.length) runs.push(cur);
	const segs: number[] = [];
	for (const r of runs) {
		if (mode === 1) for (let k = 0; k + 1 < r.length; k += 2) segs.push(r[k], r[k + 1]);
		else { for (let k = 0; k + 1 < r.length; k++) segs.push(r[k], r[k + 1]); if (mode === 2 && r.length > 2) segs.push(r[r.length - 1], r[0]); }
	}
	if (!segs.length) return null;
	let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const x = P0[i * 3 + c] * q; if (x < lo[c]) lo[c] = x; if (x > hi[c]) hi[c] = x; }
	const w = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.0012, 1e-6);   // half width
	const ns = segs.length / 2, P = new Float32Array(ns * 8 * 3), idx = new Uint32Array(ns * 24);
	const C0 = pr.attributes?.COLOR_0?.value, cN = C0 ? (C0.length / n) | 0 : 0, qc = C0 ? (pr.attributes!.COLOR_0!.normalized ? dequant(C0) : 1) : 1, C = C0 ? new Float32Array(ns * 8 * 4) : null;
	for (let s = 0; s < ns; s++) {
		const a = segs[s * 2], b = segs[s * 2 + 1];
		const A = [P0[a * 3] * q, P0[a * 3 + 1] * q, P0[a * 3 + 2] * q], B = [P0[b * 3] * q, P0[b * 3 + 1] * q, P0[b * 3 + 2] * q];
		const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], dl = Math.hypot(d[0], d[1], d[2]) || 1;
		const t = Math.abs(d[0]) < 0.9 * dl ? [1, 0, 0] : [0, 1, 0];
		let u = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]]; const ul = Math.hypot(u[0], u[1], u[2]); u = u.map(x => x / ul * w);
		let v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]; const vl = Math.hypot(v[0], v[1], v[2]); v = v.map(x => x / vl * w);
		const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
		for (let e = 0; e < 2; e++) for (let c = 0; c < 4; c++) {
			const o = (s * 8 + e * 4 + c) * 3, E = e ? B : A, [cu, cv] = corners[c];
			for (let k = 0; k < 3; k++) P[o + k] = E[k] + cu * u[k] + cv * v[k];
			if (C) { const src = e ? b : a; for (let k = 0; k < 4; k++) C[(s * 8 + e * 4 + c) * 4 + k] = k < cN ? C0![src * cN + k] * qc : 1; }
		}
		for (let c = 0; c < 4; c++) {   // 4 side quads
			const a0 = s * 8 + c, a1 = s * 8 + (c + 1) % 4, b0 = a0 + 4, b1 = a1 + 4, o = s * 24 + c * 6;
			idx[o] = a0; idx[o + 1] = a1; idx[o + 2] = b1; idx[o + 3] = a0; idx[o + 4] = b1; idx[o + 5] = b0;
		}
	}
	const attributes: Record<string, GltfAccessor> = { POSITION: { value: P } as GltfAccessor };
	if (C) attributes.COLOR_0 = { value: C } as GltfAccessor;
	return { ...pr, mode: 4, attributes, indices: { value: idx } as GltfAccessor };
}
export async function decodeModel(ab: ArrayBuffer | Uint8Array, { at = null, heading = 0, scale = 1, baseUri = null, textures = true, ground = "batch", mask = false, tile = null, featureIdSet = 0, fetchOpts = null, mc = false, upAxis = null }: DecodeModelOpts = {}): Promise<ModelOut | null> {   // featureIdSet＝EXT_mesh_features の何組目の番号で当てるか（W7）
	const { loadParse, GLTFLoader, postProcessGLTF } = await loaders();
	const parseOpts = (img: boolean) => ({ gltf: { loadImages: img, decompressMeshes: true, excludeExtensions: { EXT_mesh_features: false, EXT_structural_metadata: false, EXT_texture_webp: false, EXT_texture_avif: false, KHR_texture_basisu: false } }, ...(baseUri ? { baseUri } : {}), ...(fetchOpts ? { fetch: f } : {}) });   // KHR_texture_basisu: false＝loaders.gl の excludeExtensions は false が「外す」（W5＝自前の変換器で読む）。EXT_texture_avif も外す（loaders.gl 4.5 の AVIF 判定は worker に無い Image を new して倒れる）
	const f = fetchFor(baseUri, fetchOpts);   // 外部画像・buffer＝タイルと同じ headers で（ion の Bearer）
	const raw = rawGltfJson(ab);   // 生の json（見出し＝F4・KHR_texture_basisu の texture→image＝W5）
	let gltf: GltfDoc;
	try { gltf = postProcessGLTF(await loadParse(ab, GLTFLoader, parseOpts(textures))) as GltfDoc; }
	catch (e) {   // 画像のデコードで倒れた（壊れた画像・worker で解けない形式）＝画像なしで読み直す（形は出す）
		if (!textures) throw e;
		console.warn("[model] parse with images failed = retry without textures:", (e as Error | null)?.message);
		textures = false; gltf = postProcessGLTF(await loadParse(ab, GLTFLoader, parseOpts(false))) as GltfDoc;
	}
	dracoNames(gltf, raw);
	dequantWeb3d(gltf);
	const metaRaw = ((raw as { extensions?: { EXT_structural_metadata?: RawMeta } } | null)?.extensions?.EXT_structural_metadata ?? gltf.extensions?.EXT_structural_metadata ?? null) as RawMeta | null;   // property texture の読み方（生の json）
	// EXT_structural_metadata with schemaUri (Cesium ion's BIM exports: ../../../../schema.json): the schema is fetched once per URL and put where the
	// inline one would be, so the property tables and textures read their classes from it
	for (const m of new Set([raw?.extensions?.EXT_structural_metadata, gltf.extensions?.EXT_structural_metadata] as Array<{ schema?: unknown; schemaUri?: string } | undefined>))
		if (m && !m.schema && m.schemaUri) m.schema = await externalSchema(m.schemaUri, baseUri, f) ?? undefined;
	const ktx2 = textures ? await transcodeBasisu(gltf, raw, baseUri, f) : { textures: 0, transcoded: 0, failed: 0 };   // KTX2/Basis の texture を変換器で素の RGBA に（W5・無ければ fallback の画像）
	// シーン木を根から歩き、mesh を持つノードごとに world 行列（Y-up ローカル）を確定。scene 無しの glb は「親を持たないノード」を根とみなす
	const nodes = gltf.nodes || [];
	let roots = gltf.scene?.nodes || gltf.scenes?.[0]?.nodes;
	if (!roots) { const kids = new Set<GltfNode>(); for (const n of nodes) for (const c of n.children || []) kids.add(c); roots = nodes.filter(n => !kids.has(n)); }
	const inst: Array<{ mesh: GltfMesh; W: Float64Array; node: number; skin: number }> = [];
	const nodeIdx = new Map(nodes.map((n, i) => [n, i]));
	const nodeW: Float64Array[] = [];   // 全ノードの world 行列（skin の joint が引く・2026-10-28）
	const skins = gltf.skins || [];
	// skin の番号＝生の json の nodes[i].skin（postProcessGLTF は node.skin を解く時に skins をまだ解いていない＝実体が skins[] の物と別＝indexOf が外れる・2026-10-28）
	const skinIndexOf = (nd: GltfNode, ni: number): number => {
		if (!nd.skin) return -1;
		const r = ((raw as { nodes?: Array<{ skin?: number }> } | null)?.nodes)?.[ni]?.skin; if (Number.isInteger(r)) return r!;
		const k = skins.indexOf(nd.skin); if (k >= 0) return k;
		const j = (nd.skin.joints || []).map(x => typeof x === "number" ? x : (nodeIdx.get(x as GltfNode) ?? -1)).join();
		return skins.findIndex(sk => (sk.joints || []).map(x => typeof x === "number" ? x : (nodeIdx.get(x as GltfNode) ?? -1)).join() === j);
	};
	const visit = (nd: GltfNode | undefined, P: ArrayLike<number>, depth: number) => {
		if (!nd || depth > 64) return;   // 循環/異常な深さの保険
		const W = m4mul(P, nd.matrix ? Float64Array.from(nd.matrix) : m4trs(nd.translation, nd.rotation, nd.scale));
		const ni = nodeIdx.get(nd) ?? -1; if (ni >= 0) nodeW[ni] = W;
		if (nd.mesh) inst.push({ mesh: nd.mesh, W, node: ni, skin: skinIndexOf(nd, ni) });
		for (const c of nd.children || []) visit(c, W, depth + 1);
	};
	for (const r of roots) visit(r, I4, 0);
	// 置き方＝A（3x3・ローカル Y-up → ECEF の線形部）と T（ECEF の平行移動）。頂点は ECEF = A·(Wlin·p + Wt) + T
	const rtc = gltf.extensions?.CESIUM_RTC?.center || gltf.json?.extensions?.CESIUM_RTC?.center || null;
	let A: Float64Array, T: number[], mode: string, places: Array<{ A: Float64Array; T: number[] }> | null = null;
	if (tile) {   // 3D Tiles：置き方は呼び手のタイル変換（インスタンスごと）。glTF 内の CESIUM_RTC も b3dm の RTC_CENTER と同じ扱い
		const r0 = tile.rtc || rtc || [0, 0, 0];
		const up = upAxis === "Z" ? I3 : SWAP;   // 3D Tiles 1.0 gltfUpAxis Z (Bentley ContextCapture b3dm): the glTF is Z-up already
		places = tile.places.map(({ L, t }) => { const o = m3v(L, r0); return { A: m3mul(L, up), T: [o[0] + t[0], o[1] + t[1], o[2] + t[2]] }; });
		A = places[0].A; T = places[0].T; mode = "tile";
	}
	else if (rtc) { A = SWAP; T = rtc; mode = "rtc"; }
	else if (inst.some(({ W }) => { const r = Math.hypot(W[12], W[14], W[13]); return r > 6200000 && r < 6500000; })) { A = SWAP; T = [0, 0, 0]; mode = "ecef"; }
	else {
		if (!at) throw new Error("no anchor");   // 呼び手（gadgets/model.js）が画面中心を補うので通常は来ない
		const lon = at[0] * D2R, lat = at[1] * D2R, sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
		const a = 6378137, e2 = 0.00669437999014, N = a / Math.sqrt(1 - e2 * sp * sp);
		T = [N * cp * cl, N * cp * sl, N * (1 - e2) * sp];   // 錨＝楕円体面（h=0）。高さは接地が決める
		const Renu = Float64Array.of(-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp);   // 列＝東・北・上（ECEF）
		const ps = heading * D2R, c = Math.cos(ps), s = Math.sin(ps);
		const Rh = Float64Array.of(c, -s, 0, s, c, 0, 0, 0, 1);   // ENU 内で上軸まわりに時計回り heading（北向きが東へ倒れる）
		A = m3mul(Renu, m3mul(Rh, SWAP));
		if (scale !== 1) for (let i = 0; i < 9; i++) A[i] *= scale;
		mode = "anchor";
	}
	// rigid アニメ（W4）：アニメの掛かるノード（と子孫）の下の mesh は、ノードごとに別の束にする＝renderer がバッチ単位の変換（meshXf）で動かせる。
	// 3D Tiles のタイル（tile）はインスタンス配置＝アニメは読まない。rig（ノードの親子・静止の TRS・channel の数列）は main へ返す
	const rig = tile ? null : rigFromGltf(gltf);
	const animated = new Set(rig?.animated || []);
	// マテリアルごとに束ねる（テクスチャは描画バッチ単位でしか替えられない）。鍵＝material オブジェクト（無し＝null）。アニメするノードは (material, node) ごと
	const groups = new Map<GltfMaterial | string | null, { segs: ModelSeg[]; totalV: number; totalI: number; mat: GltfMaterial | null; node: number; noNrm: boolean; skin: number; lin0?: ArrayLike<number>; e0?: number[]; pt?: ReturnType<typeof propTexOf>; ft?: FeatureSet | null }>();   // skin＝スキンされた primitive は (skin, material) ごとに別の束（main が束ごとに頂点を焼き直す）   // material|node → { segs, totalV, totalI, mat, node }
	const matNo = new Map<GltfMaterial | null, number>(); const gkOf = (prefix: string, mat: GltfMaterial | null) => { if (!matNo.has(mat)) matNo.set(mat, matNo.size); return prefix + matNo.get(mat); };
	let minH = Infinity, nTri = 0, nVert = 0, nFid = 0, nFidTex = 0;
	const pts: ModelPoints | null = tile?.points ? { geo: [], rgba: [] } : null;   // 点のプリミティブ（3D Tiles 1.1 の点群 glTF）
	const splats: SplatPrimOut[] = []; let nSplat = 0, nSplatPts = 0;   // Gaussian splat（KHR_gaussian_splatting）＝tile.splats なら層として・でなければ点として（spec の fallback）
	const voxels: VoxelPrimOut[] = []; let nVoxSkip = 0;   // voxel（EXT_primitive_voxels）＝tile.voxels なら層として・でなければ飛ばす（点にも三角形にもならない）
	const rigSkins = skinsFromGltf(gltf as unknown as Parameters<typeof skinsFromGltf>[0]);   // skin の joints と IBM（rig が無くても静止姿勢で焼く）
	const jointMats = new Map<number, Float64Array[]>();   // skin → joint ごとの W·IBM（静止姿勢）
	const frameOf = (W: ArrayLike<number>, A: Float64Array, T: number[]) => {   // インスタンスの置き方＝lin（A·W の線形部）・o（原点）・cof（法線の余因子）
		const Wlin = Float64Array.of(W[0], W[1], W[2], W[4], W[5], W[6], W[8], W[9], W[10]);
		const lin = m3mul(A, Wlin), o = m3v(A, [W[12], W[13], W[14]]);
		const cof = [   // 法線＝余因子（非等方スケールでも面の向きが狂わない。長さは後で正規化）
			lin[4] * lin[8] - lin[5] * lin[7], lin[5] * lin[6] - lin[3] * lin[8], lin[3] * lin[7] - lin[4] * lin[6],
			lin[7] * lin[2] - lin[8] * lin[1], lin[8] * lin[0] - lin[6] * lin[2], lin[6] * lin[1] - lin[7] * lin[0],
			lin[1] * lin[5] - lin[2] * lin[4], lin[2] * lin[3] - lin[0] * lin[5], lin[0] * lin[4] - lin[1] * lin[3]];
		return { lin, ox: o[0] + T[0], oy: o[1] + T[1], oz: o[2] + T[2], cof };
	};
	for (const pl of places || [{ A, T }]) for (const { mesh, W, node, skin: si } of inst) {
		const A = pl.A, T = pl.T, animNode = animated.has(node) ? node : -1;
		const fr0 = frameOf(W, A, T);
		for (let pr of (mesh.primitives || [])) {
			let mode4 = pr.mode ?? 4;
			// skin（2026-10-28）＝JOINTS_0／WEIGHTS_0 を持つ primitive は静止姿勢でスキンして焼く（p' = Σ w·W(joint)·IBM·p＝シーン座標・mesh のノードの変換は掛けない）。
			// 束は (skin, material) ごと＝main（gadgets/model.js）が rig の時計で頂点を焼き直す（gltf-anim.skinBatch）
			const skinIn = si >= 0 && rigSkins?.[si] && mode4 >= 4 && mode4 <= 6 ? skinnedPrim(pr, rigSkins[si], si, jointMats, nodeW) : null;
			const { lin, ox, oy, oz, cof } = skinIn ? frameOf(I4_, A, T) : fr0;
			if (pr.extensions?.[VOXEL_EXT] || mode4 === VOXEL_MODE) {   // voxel＝局所の形＋transform／region のまま main へ（voxel の層）。plugin が無い（tile.voxels 無し）＝飛ばす
				const tv = tile?.voxels;
				const v = tv ? voxelPrim(pr, gltf, lin, [ox, oy, oz], tile!.baseH != null ? -tile!.baseH : 0, tv === true ? {} : tv) : null;
				if (v) voxels.push(v); else nVoxSkip++;
				continue;
			}
			if (mode4 === 0 && pr.extensions?.[SPLAT_EXT] && tile?.splats) {   // Gaussian splat＝局所の座標＋transform のまま main へ（splat の層）
				const sp = splatPrim(pr, gltf, lin, [ox, oy, oz], tile.baseH != null ? -tile.baseH : 0);
				if (sp) { splats.push(sp); nSplat += sp.n; }
				continue;
			}
			if (mode4 === 0 && pts) {   // 点＝経緯度・高さ・色だけ（点のオーバーレイへ）
				if (Object.keys(pr.extensions || {}).some(k => k.startsWith(`${SPLAT_EXT}_compression_spz`))) continue;   // SPZ＝属性の本体が無い（loaders.gl 4.5 は bufferView の無い accessor を 0 で埋める＝原点に点が並ぶ）＝点にしない
				const P = pr.attributes?.POSITION?.value; if (!P) continue;
				if (pr.extensions?.[SPLAT_EXT]) nSplatPts += P.length / 3;
				const q = pr.attributes!.POSITION!.normalized ? dequant(P) : 1, n = P.length / 3;
				const C0 = pr.attributes?.COLOR_0?.value, cN = C0 ? (C0.length / n) | 0 : 0, qc = C0 ? (pr.attributes!.COLOR_0!.normalized ? dequant(C0) : 1) : 1, f = baseColorOf(pr.material || null, gltf).factor;
				for (let i = 0; i < n; i++) {
					const px = P[i*3] * q, py = P[i*3+1] * q, pz = P[i*3+2] * q;
					const g = ecef2geo(lin[0] * px + lin[3] * py + lin[6] * pz + ox, lin[1] * px + lin[4] * py + lin[7] * pz + oy, lin[2] * px + lin[5] * py + lin[8] * pz + oz);
					pts.geo.push(g[0], g[1], g[2]);
					pts.rgba.push(...[0, 1, 2].map(k => Math.max(0, Math.min(255, Math.round((C0 && cN >= 3 ? C0[i*cN+k] * qc : 1) * f[k] * 255)))), C0 && cN === 4 ? Math.round(C0[i*4+3] * qc * 255) : 255);
				}
				continue;
			}
			if (mode4 >= 1 && mode4 <= 3) { const tp = linePrimAsTubes(pr, mode4); if (tp) { pr = tp; mode4 = 4; } }   // lines (Cesium draws them 1 px, unlit) → thin tubes
			if (mode4 !== 4 && mode4 !== 5 && mode4 !== 6) continue;   // 三角形系だけ（点は建物メッシュにならない）
			const acc = pr.attributes?.POSITION; const P = skinIn ? skinIn.P1 : acc?.value; if (!P) continue;
			const NRM = skinIn ? skinIn.N1 : pr.attributes?.NORMAL?.value;
			const q = !skinIn && acc!.normalized ? dequant(P) : 1;
			const qLo = (P instanceof Int8Array || P instanceof Int16Array) ? -1 : 0;
			const n = P.length / 3;
			const ptd = mc && !skinIn ? propTexOf(pr as { extensions?: Record<string, unknown> | null }, metaRaw) : null;   // property texture（CustomShader の fsInput.metadata）＝違えば別の束
			const fbc = baseColorOf(pr.material || null, gltf), fset = featureSetOf(pr, featureIdSet), ft = fset?.texInfo && !skinIn && fbc.texture && !fbc.transform && (fset.texInfo.texCoord ?? 0) === fbc.texCoord ? fset : null;   // 画素ごとの地物の番号＝baseColor と同じ uv の時だけ（photogrammetry の分類）
			const ftk = ft ? `ft${ft.texInfo!.index}:${ft.texInfo!.channels ?? ""}:${ft.nullFeatureId}:${ft.propertyTable}|` : "";
			const mat = pr.material || null, gk = skinIn ? gkOf(`s${si}|`, mat) : ptd ? gkOf(`pt${ptd.sig}|${animNode}|${ftk}`, mat) : animNode >= 0 || ft ? gkOf(`${animNode}|${ftk}`, mat) : mat;   // アニメするノードは別の束（鍵＝ノード番号＋material）・skin も別の束・番号の画像が違えば別の束
			let g = groups.get(gk); if (!g) groups.set(gk, g = { segs: [], totalV: 0, totalI: 0, mat, node: skinIn ? -1 : animNode, noNrm: false, skin: skinIn ? si : -1, pt: ptd, ft });
			if (!NRM) g.noNrm = true;   // 法線の無い primitive＝面法線を積むが、Cesium はこれを照明無し（unlit）で描く
			const base = g.totalV;
			const geoSeg = new Float64Array(n * 3), nrmSeg = new Int8Array(n * 4), ecef = new Float64Array(n * 3);
			const mcSeg = mc && !skinIn ? new Float32Array(n * 4) : null;   // 利用者のシェーダの positionMC（glTF の POSITION＝量子化を解いただけ）
			for (let i = 0; i < n; i++) {
				const px = q === 1 ? P[i*3] : Math.max(P[i*3] * q, qLo), py = q === 1 ? P[i*3+1] : Math.max(P[i*3+1] * q, qLo), pz = q === 1 ? P[i*3+2] : Math.max(P[i*3+2] * q, qLo);
				if (mcSeg) { mcSeg[i*4] = px; mcSeg[i*4+1] = py; mcSeg[i*4+2] = pz; }
				const ex = lin[0] * px + lin[3] * py + lin[6] * pz + ox, ey = lin[1] * px + lin[4] * py + lin[7] * pz + oy, ez = lin[2] * px + lin[5] * py + lin[8] * pz + oz;
				ecef[i*3] = ex; ecef[i*3+1] = ey; ecef[i*3+2] = ez;
				const gg = ecef2geo(ex, ey, ez);
				if (gg[2] < minH) minH = gg[2];
				geoSeg[i*3] = gg[0]; geoSeg[i*3+1] = gg[1]; geoSeg[i*3+2] = gg[2];
			}
			// index（strip/fan は三角形列へ展開）。番号はこのマテリアル束の通し番号
			const I = pr.indices?.value;
			const src = I || null, m = I ? I.length : n;
			let idxSeg: Uint32Array;
			if (mode4 === 4) { idxSeg = new Uint32Array(m); for (let k = 0; k < m; k++) idxSeg[k] = (src ? src[k] : k) + base; }
			else {
				idxSeg = new Uint32Array(Math.max(0, m - 2) * 3);
				for (let k = 0, w = 0; k + 2 < m; k++) {
					let a = src ? src[k] : k, b = src ? src[k+1] : k + 1, c = src ? src[k+2] : k + 2;
					if (mode4 === 6) a = src ? src[0] : 0;
					else if (k & 1) { const t = b; b = c; c = t; }   // strip の偶奇で巻きを揃える
					idxSeg[w++] = a + base; idxSeg[w++] = b + base; idxSeg[w++] = c + base;
				}
			}
			// 法線＝ECEF へ回してから ortho 軸（x, z, y）へ。無ければ面法線を頂点へ積む
			const nE = new Float64Array(n * 3);
			if (NRM) for (let i = 0; i < n; i++) {
				const a = NRM[i*3], b = NRM[i*3+1], c = NRM[i*3+2];
				nE[i*3] = cof[0] * a + cof[3] * b + cof[6] * c; nE[i*3+1] = cof[1] * a + cof[4] * b + cof[7] * c; nE[i*3+2] = cof[2] * a + cof[5] * b + cof[8] * c;
			} else for (let k = 0; k + 2 < idxSeg.length; k += 3) {
				const a = idxSeg[k] - base, b = idxSeg[k+1] - base, c = idxSeg[k+2] - base;
				const ux = ecef[b*3] - ecef[a*3], uy = ecef[b*3+1] - ecef[a*3+1], uz = ecef[b*3+2] - ecef[a*3+2];
				const vx = ecef[c*3] - ecef[a*3], vy = ecef[c*3+1] - ecef[a*3+1], vz = ecef[c*3+2] - ecef[a*3+2];
				const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;   // 面積重み（正規化しない）
				for (const v of [a, b, c]) { nE[v*3] += fx; nE[v*3+1] += fy; nE[v*3+2] += fz; }
			}
			for (let i = 0; i < n; i++) {
				const nx = nE[i*3], ny = nE[i*3+2], nz = nE[i*3+1];   // ECEF(x,y,z) → ortho 世界軸(x, z, y)
				const l = Math.hypot(nx, ny, nz);
				if (l > 0) { const s = 127 / l; nrmSeg[i*4] = Math.round(nx * s); nrmSeg[i*4+1] = Math.round(ny * s); nrmSeg[i*4+2] = Math.round(nz * s); }
				else nrmSeg[i*4+1] = 127;
			}
			// uv（baseColorTexture の TEXCOORD_n＋KHR_texture_transform）と 頂点色（baseColorFactor×COLOR_0、α＝OPAQUE なら 1）
			const bc = baseColorOf(mat, gltf);
			const UV = bc.texture ? pr.attributes?.["TEXCOORD_" + bc.texCoord]?.value : null;
			const uvSeg = new Float32Array(n * 2);
			if (UV && UV.length >= n * 2) {
				const qu = pr.attributes!["TEXCOORD_" + bc.texCoord]!.normalized ? dequant(UV) : 1, tt = bc.transform;
				const ro = tt?.rotation || 0, cs = Math.cos(ro), sn = Math.sin(ro), sx = tt?.scale?.[0] ?? 1, sy = tt?.scale?.[1] ?? 1, tx = tt?.offset?.[0] ?? 0, ty = tt?.offset?.[1] ?? 0;
				for (let i = 0; i < n; i++) {
					const u = UV[i*2] * qu, v = UV[i*2+1] * qu;
					if (tt) { uvSeg[i*2] = cs * sx * u + sn * sy * v + tx; uvSeg[i*2+1] = -sn * sx * u + cs * sy * v + ty; }   // T·R·S（仕様の順）
					else { uvSeg[i*2] = u; uvSeg[i*2+1] = v; }
				}
			}
			let uvmSeg: Float32Array | null = null;   // property texture の texCoord（KHR_texture_transform は掛けない）
			if (ptd) { const T = pr.attributes?.["TEXCOORD_" + ptd.texCoord], A = T?.value; uvmSeg = new Float32Array(n * 2); if (A && A.length >= n * 2) { const qu = T!.normalized ? dequant(A) : 1; for (let i = 0; i < n * 2; i++) uvmSeg[i] = A[i] * qu; } }
			const colSeg = new Uint8Array(n * 4);
			const C0 = pr.attributes?.COLOR_0?.value, cN = C0 ? (C0.length / n) | 0 : 0, qc = C0 ? (pr.attributes!.COLOR_0!.normalized ? dequant(C0) : 1) : 1;
			const opaque = !mat || (mat.alphaMode || "OPAQUE") === "OPAQUE";
			const f = bc.factor;
			for (let i = 0; i < n; i++) {
				const cr = C0 && cN >= 3 ? C0[i*cN] * qc : 1, cg = C0 && cN >= 3 ? C0[i*cN+1] * qc : 1, cb = C0 && cN >= 3 ? C0[i*cN+2] * qc : 1, ca = C0 && cN === 4 ? C0[i*cN+3] * qc : 1;
				colSeg[i*4] = Math.max(0, Math.min(255, Math.round(f[0] * cr * 255)));
				colSeg[i*4+1] = Math.max(0, Math.min(255, Math.round(f[1] * cg * 255)));
				colSeg[i*4+2] = Math.max(0, Math.min(255, Math.round(f[2] * cb * 255)));
				colSeg[i*4+3] = opaque ? 255 : Math.max(0, Math.min(255, Math.round((f[3] ?? 1) * ca * 255)));
			}
			// 地物の番号（W7）＝EXT_mesh_features の attribute／implicit、無ければ _BATCHID（b3dm）。texture の番号は頂点に無い（NO_FEATURE）＝束の ft で画素ごとに
			if (fset) { nFid++; if (fset.texture) nFidTex++; }
			if (mc && !g.lin0 && n) { g.lin0 = lin; g.e0 = [ecef[0], ecef[1], ecef[2]]; }   // 束の J の素（最初の primitive の置き方・頂点）
			const seg = { geo: geoSeg, nrm: nrmSeg, idx: idxSeg, uv: uvSeg, col: colSeg, fid: fset ? featureIdsOf(fset, n) : null, tbl: fset ? fset.propertyTable : null, skin: skinIn ? skinIn.seg : null, mc: mcSeg, uvm: uvmSeg };
			const olE = mode4 === 4 && !skinIn ? outlineEdgesOf(pr, gltf) : null;
			if (olE) withOutline(seg, olE, n, base);   // CESIUM_primitive_outline＝頂点を写し足して法線の 4 バイト目に輪郭の座標（3 bit）
			const nv = seg.geo.length / 3;
			g.segs.push(seg);
			g.totalV += nv; g.totalI += seg.idx.length; nVert += nv; nTri += seg.idx.length / 3;
		}
	}
	if (tile && tile.baseH != null) minH = tile.baseH;   // 3D Tiles＝接地しない（絶対高さ − baseH）
	else if (ground === "origin" && mode === "anchor") minH = 0;   // 錨（模型の原点）を高さの基準に＝最低点で接地しない（Cesium の Model＝原点が position。坑道の模型は原点の 94 m 上から始まる・2026-10-29）
	if (!nTri) return pts?.geo.length || splats.length || voxels.length || nVoxSkip ? { batches: [], mask: null, points: pts?.geo.length ? pts : null, splats: splats.length ? splats : null, voxels: voxels.length ? voxels : null, stats: { vertices: 0, triangles: 0, instances: inst.length, mode, points: pts ? pts.geo.length / 3 : 0, ...(splats.length ? { splats: nSplat } : {}), ...(nSplatPts ? { splatPoints: nSplatPts } : {}), ...(voxels.length ? { voxels: voxels.length } : {}), ...(nVoxSkip ? { voxelsSkipped: nVoxSkip } : {}), gltf: gltfMeta(raw ?? gltf.json ?? gltf) } } : null;
	// マテリアル束ごとに後段（接地＝模型全体の最低点 minH で揃える＝束が違っても一体で沈む/浮く）。テクスチャは同じ画像を 1 回だけ
	const imgCache = new Map<GltfImage, TexOut | null>();
	const batches: ModelBatchOut[] = [];
	const bbox = [Infinity, Infinity, -Infinity, -Infinity];
	// 被覆マスクの座標系＝模型全体の経緯度 bbox（度）。束（マテリアル）が違っても同じ枠＝renderer が断片を OR 合成できる
	let maskBbox: number[] | null = null;
	if (mask) {
		let lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity;
		for (const g of groups.values()) for (const s of g.segs) for (let i = 0; i < s.geo.length; i += 3) {
			const lo = s.geo[i], la = s.geo[i+1];
			if (lo < lo0) lo0 = lo; if (lo > lo1) lo1 = lo; if (la < la0) la0 = la; if (la > la1) la1 = la;
		}
		if (lo0 < lo1) maskBbox = [lo0 * R2D, la0 * R2D, lo1 * R2D, la1 * R2D];
	}
	for (const g of groups.values()) {
		if (!g.totalI) continue;
		const geo = new Float64Array(g.totalV * 3), outNrm = new Int8Array(g.totalV * 4), rawIdx = new Uint32Array(g.totalI), uv = new Float32Array(g.totalV * 2), col = new Uint8Array(g.totalV * 4);
		let vtx = 0, io = 0;
		const withF = g.segs.filter(s => s.fid), tbls = [...new Set(withF.map(s => s.tbl))];
		const fids = withF.length ? new Uint32Array(g.totalV).fill(NO_FEATURE) : null, tblV = tbls.length > 1 ? new Int16Array(g.totalV).fill(-1) : null;   // 表が混ざる束だけ頂点ごとの表番号
		const skinSegs: SkinSeg[] = [];
		const mcV = mc ? new Float32Array(g.totalV * 4) : null, uvmV = g.pt ? new Float32Array(g.totalV * 2) : null;
		for (const s of g.segs) { const nv = s.geo.length / 3; if (mcV && s.mc) mcV.set(s.mc, vtx * 4); if (uvmV && s.uvm) uvmV.set(s.uvm, vtx * 2); geo.set(s.geo, vtx * 3); outNrm.set(s.nrm, vtx * 4); rawIdx.set(s.idx, io); uv.set(s.uv, vtx * 2); col.set(s.col, vtx * 4); if (s.fid) { fids!.set(s.fid, vtx); if (tblV) tblV.fill(s.tbl ?? -1, vtx, vtx + nv); } if (s.skin) skinSegs.push({ ...s.skin, start: vtx, n: nv }); vtx += nv; io += s.idx.length; }
		g.segs.length = 0;
		if (mcV && fids) for (let i = 0; i < g.totalV; i++) mcV[i*4+3] = fids[i] === NO_FEATURE ? 0 : fids[i];   // w＝地物の番号（featureIds.featureId_0）
		const mesh = finishMesh(geo, outNrm, rawIdx, minH, null, maskBbox, true, mcV ? { uv, col, mc: mcV, ...(uvmV && { uvm: uvmV }) } : { uv, col }, ground !== "each");   // brid=true＝両面。接地の単位は ground・マスクは maskBbox があれば出す
		const tex = textures ? await textureOf(baseColorOf(g.mat, gltf).texture, imgCache) : null;
		const pb = pbrOf(g.mat, gltf);   // #46 段 2＝材質（数値）と 4 枚のテクスチャ（無ければ null）
		const [texMR, texN, texOcc, texEm] = textures ? await Promise.all([pb.texMR, pb.texN, pb.texOcc, pb.texEm].map(t => textureOf(t, imgCache))) : [null, null, null, null];
		const ftex = g.ft && fids ? await featureTexOf(g.ft, gltf, imgCache) : null;   // 画素ごとの地物の番号（featureId.texture）
		const meta = g.pt && textures ? { props: g.pt.props, texs: await Promise.all(g.pt.texIdx.map(i => textureOf(texRef({ index: i }, gltf), imgCache))) } : null;   // property texture の画像（同じ画像は複製で 1 回だけ）
		batches.push({ ...(meta && { meta }), mesh, tex, texMR, texN, texOcc, texEm, pbr: { metallic: pb.metallic, roughness: pb.roughness, normalScale: pb.normalScale, occlusion: pb.occlusion, emissive: pb.emissive, clearcoat: pb.clearcoat, unlit: !!g.mat?.unlit || !!g.mat?.extensions?.KHR_materials_unlit || g.noNrm },
			alphaMode: g.mat?.alphaMode || "OPAQUE", alphaCutoff: g.mat?.alphaCutoff ?? 0.5, node: g.node ?? -1, ...(skinSegs.length && rig ? { skin: skinSegs } : {}),   // skin の区間＝rig（アニメ）がある時だけ main へ（静止の模型は焼いた物で足りる）
			features: fids ? { ids: fids, table: tbls.length === 1 ? tbls[0] : null, tblV, ...(ftex && { tex: ftex }) } : null, ...(mcV ? { mcJ: mcJOf(g.lin0, g.e0, minH) } : {}) });   // features（W7）＝頂点ごとの地物の番号（NO_FEATURE＝無し）と property table の番号   // α の扱い＝renderer が cut/blend に畳む。node＝アニメするノード（−1＝動かない束）
		bbox[0] = Math.min(bbox[0], mesh.bbox[0]); bbox[1] = Math.min(bbox[1], mesh.bbox[1]); bbox[2] = Math.max(bbox[2], mesh.bbox[2]); bbox[3] = Math.max(bbox[3], mesh.bbox[3]);
	}
	// property table（W7）＝EXT_structural_metadata（無ければ b3dm の batch table）を素の列へ
	const fWarn: string[] = [], meta = gltf.extensions?.EXT_structural_metadata || raw?.extensions?.EXT_structural_metadata || null;
	const bytesOf = (i: number) => { const bv = gltf.bufferViews?.[i]; if (!bv) throw new Error(`bufferView ${i}`); if (bv.data instanceof Uint8Array) return bv.data; const b = bv.buffer!; return new Uint8Array(b.arrayBuffer!, (b.byteOffset || 0) + (bv.byteOffset || 0), bv.byteLength); };
	const tables = nFid ? (meta ? decodePropertyTables(meta, bytesOf, fWarn) : tile?.batchTable ? [batchTableOf(tile.batchTable.json, tile.batchTable.bin, tile.batchTable.count)].filter(Boolean) as PropertyTable[] : []) : [];
	if (fWarn.length) console.warn("[model] property tables:", fWarn.join("; "));
	for (const b of batches) if (b.features) b.features.tables = tables;   // 束ごとに表の参照（cmpt で結果が混ざっても番号が迷わない・postMessage は同じ参照を 1 回だけ写す）
	// place（W4）＝G：glTF のローカル → ECEF（A・T）、F：ECEF → 単位球の世界座標の局所線形化（模型の錨 T の周りで 1 m の差分＝接地の minH 込み・ecef2geo＋geoWorld と同じ道）
	const place = rig && !places ? (() => {
		const w = (e: ArrayLike<number>) => { const g = ecef2geo(e[0], e[1], e[2]); return geoWorld(g[0], g[1], (g[2] - minH) / EARTH_W, [0, 0, 0]); };
		const c = inst.length ? (() => { const o = m3v(A, [inst[0].W[12], inst[0].W[13], inst[0].W[14]]); return [o[0] + T[0], o[1] + T[1], o[2] + T[2]]; })() : T;
		const w0 = w(c), L = new Float64Array(9);
		for (let k = 0; k < 3; k++) { const e = [...c]; e[k] += 1; const wk = w(e); L[k*3] = wk[0] - w0[0]; L[k*3+1] = wk[1] - w0[1]; L[k*3+2] = wk[2] - w0[2]; }
		return { G: { A: [...A], T: [...T] }, F: { L: [...L], t: [w0[0] - (L[0]*c[0] + L[3]*c[1] + L[6]*c[2]), w0[1] - (L[1]*c[0] + L[4]*c[1] + L[7]*c[2]), w0[2] - (L[2]*c[0] + L[5]*c[1] + L[8]*c[2])] } };
	})() : null;
	const features = nFid ? { tables, primitives: nFid, texture: nFidTex, warnings: fWarn } : null;
	return { batches, rig, place, features, mask: maskBbox ? { bbox: maskBbox, n: MASK_N } : null, points: pts?.geo.length ? pts : null, splats: splats.length ? splats : null, voxels: voxels.length ? voxels : null, stats: { vertices: nVert, triangles: nTri, instances: inst.length, mode, bbox, ...(splats.length ? { splats: nSplat } : {}), ...(nSplatPts ? { splatPoints: nSplatPts } : {}), ...(voxels.length ? { voxels: voxels.length } : {}), ...(nVoxSkip ? { voxelsSkipped: nVoxSkip } : {}), materials: batches.length, textures: batches.filter(b => b.tex).length, blended: batches.filter(b => b.alphaMode === "BLEND").length, gltf: gltfMeta(raw ?? gltf.json ?? gltf), ...(ktx2.textures ? { ktx2 } : {}), ...(nFid ? { features: { primitives: nFid, texture: nFidTex, tables: tables.length } } : {}) } };   // gltf＝見出し（F4・loaders.gl が外す前の生の json から）・ktx2＝変換器の成績（W5・KTX2 の texture がある時だけ）
}

// ── skin（2026-10-28）：primitive を静止姿勢でスキンする ──────────────────────────────────
/** JOINTS_0／WEIGHTS_0 を持つ primitive → 静止姿勢のシーン座標の位置 P1・法線 N1（無ければ null）と、main が焼き直すための区間（ローカルの P/N/J/W）。無ければ null */
function skinnedPrim(pr: GltfPrimitive, skin: { joints: number[]; ibm: Float32Array }, si: number, cache: Map<number, Float64Array[]>, nodeW: Float64Array[]): { P1: Float32Array; N1: Float32Array | null; seg: Omit<SkinSeg, "start" | "n"> } | null {
	const J0 = pr.attributes?.JOINTS_0, W0 = pr.attributes?.WEIGHTS_0, P0 = pr.attributes?.POSITION;
	const Jv = J0?.value, Wv = W0?.value, Pv = P0?.value;
	if (!Jv || !Wv || !Pv) return null;
	const n = Pv.length / 3; if (Jv.length < n * 4 || Wv.length < n * 4) return null;
	const qp = P0!.normalized ? dequant(Pv) : 1, qw = W0!.normalized ? dequant(Wv) : 1;
	const P = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) P[i] = Pv[i] * qp;
	const Nv = pr.attributes?.NORMAL?.value, qn = Nv && pr.attributes!.NORMAL!.normalized ? dequant(Nv) : 1;
	const N = Nv && Nv.length >= n * 3 ? new Float32Array(n * 3) : null; if (N) for (let i = 0; i < n * 3; i++) N[i] = Nv![i] * qn;
	const J = new Uint16Array(n * 4); for (let i = 0; i < n * 4; i++) J[i] = Jv[i];
	const W = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) W[i] = Wv[i] * qw;
	const seg = { skin: si, P, N, J, W };
	let M = cache.get(si); if (!M) cache.set(si, M = jointMatrices(skin, nodeW));
	const P1 = new Float32Array(n * 3), N1 = N ? new Float32Array(n * 3) : null;
	skinVertices({ ...seg, start: 0, n }, M, P1, N1);
	return { P1, N1, seg };
}
