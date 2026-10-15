// glbconv — GLB（glTF バイナリ）を他の 3D 形式へ変換する小さな道具。依存ゼロ。
//
//   import { convert, FORMATS } from "glbconv";
//   const files = await convert(glbBytes, "obj", { name: "osaka-castle", decodeDraco });
//   // files＝[{ name, bytes }]。2 本以上なら zip でまとめて渡す（zipFiles）
//
// 形式：glb（素の GLB＝Draco も量子化も解いた配布用）・gltf（.gltf＋.bin）・gltf-embedded（1 ファイル）・
//       obj（+.mtl+画像）・ply・stl・usdz（Apple AR クイックルック）・3dtiles（tileset.json＋model.glb）
//
// テクスチャ：OBJ・USDZ は webp を読めない相手が多い＝呼び手が transcodeImage を渡せば jpeg へ寄せる（注入口・任意）。
//   transcodeImage(bytes, mime, want) → { mime, bytes }（ブラウザなら createImageBitmap＋OffscreenCanvas の 5 行）
// Draco（KHR_draco_mesh_compression）は自前で解かない＝呼び手が decodeDraco を渡す（注入口）。
//   decodeDraco(bytes, attrIds) → { attributes: { POSITION: {value,size}, … }, indices: { value } }
// 位置情報：GLB が CESIUM_RTC（ECEF の原点）を持っていれば、glb / gltf / 3dtiles はそのまま引き継ぐ。
//   OBJ・PLY・STL・USDZ にはその欄が無い＝先頭のコメントやヘッダに原点を書き残す（相手が地球へ戻せるように）。
import { glbToScene, sceneStats } from "./scene.ts";
import type { Scene, SceneImage, DecodeDraco } from "./scene.ts";
import { parseGlb, buildGlb } from "./glb.ts";
import { zipStore } from "./zip.ts";
import { toGlb, toGltf, toObj, toPly, toStl, toUsdz, toTileset } from "./writers.ts";
import type { OutFile } from "./writers.ts";

export { parseGlb, buildGlb, glbToScene, sceneStats, zipStore };
export { toGlb, toGltf, toObj, toPly, toStl, toUsdz, toTileset };
export type { GltfJson, ParsedGlb } from "./glb.ts";
export type { Scene, ScenePrim, SceneMaterial, SceneImage, SceneBbox, SceneStats, DecodeDraco, DracoDecoded, DracoAttribute, AttrArray, GlbToSceneOptions } from "./scene.ts";
export type { OutFile, WriteOptions } from "./writers.ts";
export type { ZipInputFile, ZipStoreOptions } from "./zip.ts";

export type FormatName = "glb" | "gltf" | "gltf-embedded" | "obj" | "ply" | "stl" | "usdz" | "3dtiles";
export interface FormatInfo { label: string; ext: string; zip: boolean; needsGeometry: boolean; wantImage?: string[] }
/** 画像の形式を寄せる注入口（OBJ・USDZ 向け）：(bytes, mime, want) → { mime, bytes } */
export type TranscodeImage = (bytes: Uint8Array, mime: string, want: string) => SceneImage | Promise<SceneImage>;
export interface ConvertOptions { name?: string; decodeDraco?: DecodeDraco | null; scene?: Scene | null; transcodeImage?: TranscodeImage | null }
/** bundle の戻り＝保存できる 1 個（type は MIME） */
export interface BundledFile { name: string; bytes: Uint8Array; type: string }

export const FORMATS: Record<FormatName, FormatInfo> = {
	glb: { label: "GLB", ext: "glb", zip: false, needsGeometry: true },
	gltf: { label: "glTF", ext: "zip", zip: true, needsGeometry: true },
	"gltf-embedded": { label: "glTF (1 file)", ext: "gltf", zip: false, needsGeometry: true },
	obj: { label: "OBJ", ext: "zip", zip: true, needsGeometry: true, wantImage: ["image/jpeg", "image/png"] },
	ply: { label: "PLY", ext: "ply", zip: false, needsGeometry: true },
	stl: { label: "STL", ext: "stl", zip: false, needsGeometry: true },
	usdz: { label: "USDZ", ext: "usdz", zip: false, needsGeometry: true, wantImage: ["image/jpeg", "image/png"] },
	"3dtiles": { label: "3D Tiles", ext: "zip", zip: true, needsGeometry: true },
};

type Writer = (s: Scene, o: { name: string }) => OutFile[];
const WRITE: Record<FormatName, Writer> = {
	glb: toGlb, gltf: toGltf, "gltf-embedded": (s, o) => toGltf(s, { ...o, embed: true }),
	obj: toObj, ply: toPly, stl: toStl, usdz: toUsdz, "3dtiles": toTileset,
};

// GLB のバイト列 → その形式のファイル群
export async function convert(glbBytes: Uint8Array | ArrayBuffer | ArrayLike<number>, format: FormatName, { name = "model", decodeDraco = null, scene = null, transcodeImage = null }: ConvertOptions = {}): Promise<OutFile[]> {
	const w = (WRITE as Partial<Record<string, Writer>>)[format];   // 外（JS）から知らない形式が来る＝実行時にも検める
	if (!w) throw new Error("unknown format: " + format);
	const s = scene || await glbToScene(glbBytes, { decodeDraco });
	const want = (FORMATS as Partial<Record<string, FormatInfo>>)[format]?.wantImage;
	return w(want && transcodeImage ? await retexture(s, transcodeImage, want) : s, { name });
}

// 望ましくない形式の画像だけ差し替えた「浅い写し」を返す（元のシーンは触らない＝別形式でもう一度使える）
export async function retexture(scene: Scene, transcodeImage: TranscodeImage, want: string[]): Promise<Scene> {
	const done = new Map<Uint8Array, SceneImage>();
	const prims: Scene["prims"] = [];
	for (const p of scene.prims) {
		const im = p.material.image;
		if (!im || want.includes(im.mime)) { prims.push(p); continue; }
		let next = done.get(im.bytes);
		if (!next) {
			try { next = await transcodeImage(im.bytes, im.mime, want[0]); }
			catch (e) { console.warn("[glbconv] texture transcode failed, keeping", im.mime, (e as { message?: string } | null)?.message); next = im; }
			done.set(im.bytes, next);
		}
		prims.push({ ...p, material: { ...p.material, image: next } });
	}
	return { ...scene, prims };
}

// 1 本ならそのまま、2 本以上なら zip に畳む → { name, bytes, type }
export function bundle(files: OutFile[], { name = "model", type = null }: { name?: string; type?: string | null } = {}): BundledFile {
	if (files.length === 1) return { name: files[0].name, bytes: files[0].bytes, type: type || guessType(files[0].name) };
	return { name: `${name}.zip`, bytes: zipStore(files), type: "application/zip" };
}
const guessType = (n: string): string => n.endsWith(".glb") ? "model/gltf-binary" : n.endsWith(".gltf") ? "model/gltf+json"
	: n.endsWith(".usdz") ? "model/vnd.usdz+zip" : n.endsWith(".zip") ? "application/zip" : "application/octet-stream";

// よくある使い方の 1 行：変換して「保存できる 1 個」に畳む
export async function convertToFile(glbBytes: Uint8Array | ArrayBuffer | ArrayLike<number>, format: FormatName, opts: ConvertOptions = {}): Promise<BundledFile> {
	const base = opts.name || "model";
	// zip に畳む形式は名前に形式を入れる（osaka-castle-obj.zip）＝同じ模型の別形式を並べて落としても上書きしない
	return bundle(await convert(glbBytes, format, opts), { name: (FORMATS as Partial<Record<string, FormatInfo>>)[format]?.zip ? `${base}-${format}` : base });
}
