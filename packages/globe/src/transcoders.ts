// テクスチャの変換器の写し（第 3 波 W5・2026-10-12）＝main の registry.textureTranscoders（plugin が add した { url }）を、worker が import() できる [{ name, url }] の列にする。
// 模型（gadgets/model.js）と 3D Tiles（gadgets/tiles3d.js）が rpc のたびに添える＝worker 側（meshdecode.setTextureTranscoders）は最後に受けた物を使う。
// 契約：url の module は export transcode(bytes: Uint8Array, { mimeType }) → { width, height, rgba: Uint8Array(width*height*4) }（Promise でもよい）。@ortho-earth/ktx2 が basis_universal の WASM で実装
import type { GlobeMap } from "./types/map.ts";

export const transcodersOf = (map: GlobeMap | null | undefined): Array<{ name: string; url: string }> => { const reg = map?.registry?.textureTranscoders; return reg ? reg.names().map(n => ({ name: n, url: reg.get(n)?.url })).filter((t): t is { name: string; url: string } => typeof t.url === "string") : []; };
