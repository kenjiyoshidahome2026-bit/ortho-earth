// @loaders.gl/* の型の代わり（globe の型検査だけが読む・tsconfig の paths・2026-10-17）。
//   本物の型の木（@loaders.gl/schema → apache-arrow の /// <reference types="node" />）は Node の大域（setTimeout → NodeJS.Timeout 等）を
//   globe の型検査へ持ち込み、関係の無い main の .ts が壊れる＝globe が使う名前だけをここに書く（src/mesh-loaders.ts・src/i3s-loaders.ts が再輸出する分）。
//   出力（tsc の .js／.d.ts・vite の束）は本物のパッケージを指したまま＝利用者の手元では本物の型が付く。戻りは unknown＝形は読み手（meshdecode.ts・i3s-decode.ts）が決める。
/** loaders.gl の loader（中身は loaders.gl だけが読む） */
export interface LoadersGlLoader { readonly id: string; readonly name: string }
/** @loaders.gl/core の parse */
export function parse(data: ArrayBuffer | Uint8Array, loader: LoadersGlLoader, options?: Record<string, unknown>, context?: { url?: string }): Promise<unknown>;
