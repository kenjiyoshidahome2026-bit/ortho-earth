// mesh-loaders.js（JS のまま）の型。meshdecode.ts が dynamic import する分だけ（TS 化 段 4・batch 3）。
//   JS のまま置く理由：中身は @loaders.gl/* の再輸出だけ。.ts にすると loaders.gl の型の木（@loaders.gl/schema → apache-arrow の
//   /// <reference types="node" />）が globe の型検査に Node の大域（setTimeout → NodeJS.Timeout 等）を持ち込み、関係の無い main の .ts が壊れる。
//   戻りは unknown＝形は読み手（meshdecode.ts の GltfDoc／Tile3DContent）が決める。
/** loaders.gl の loader（中身は loaders.gl だけが読む） */
export interface LoadersGlLoader { readonly id: string; readonly name: string }
export const Tiles3DLoader: LoadersGlLoader;
export const GLTFLoader: LoadersGlLoader;
export const DracoLoader: LoadersGlLoader;
/** @loaders.gl/core の parse */
export function loadParse(data: ArrayBuffer | Uint8Array, loader: LoadersGlLoader, options?: Record<string, unknown>): Promise<unknown>;
export function loadersParse(data: ArrayBuffer | Uint8Array, loader: LoadersGlLoader, options?: Record<string, unknown>): Promise<unknown>;
/** GLTFLoader の生の答え → accessor を型付き配列に・node/mesh の参照を実体に */
export function postProcessGLTF(gltf: unknown): unknown;
