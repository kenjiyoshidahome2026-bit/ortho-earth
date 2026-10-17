// @loaders.gl/gltf の型の代わり（理由は core.d.ts）
import type { LoadersGlLoader } from "./core.d.ts";
export const GLTFLoader: LoadersGlLoader;
/** GLTFLoader の生の答え → accessor を型付き配列に・node/mesh の参照を実体に */
export function postProcessGLTF(gltf: unknown): unknown;
