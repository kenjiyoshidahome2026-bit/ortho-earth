// GLB（glTF バイナリ）の入口と出口。仕様は glTF 2.0：12 byte のヘッダ＋チャンク列（JSON→BIN）。
// チャンク長は 4 byte 境界まで詰めた長さが入る（詰め物は JSON が空白・BIN がゼロ）。
const enc = new TextEncoder(), dec = new TextDecoder();

// glTF 2.0 の JSON（この道具が読み書きする欄だけ名を付ける＝他の欄は index signature で素通し）
export interface GltfAccessor { bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string; min?: number[]; max?: number[]; [k: string]: unknown }
export interface GltfBufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number; [k: string]: unknown }
export interface GltfImage { mimeType?: string; bufferView?: number; uri?: string; [k: string]: unknown }
export interface GltfTexture { sampler?: number; source?: number; extensions?: { EXT_texture_webp?: { source?: number }; KHR_texture_basisu?: { source?: number }; [k: string]: unknown }; [k: string]: unknown }
export interface GltfTextureRef { index: number; [k: string]: unknown }
export interface GltfMaterial {
	name?: string; doubleSided?: boolean;
	pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: GltfTextureRef; metallicFactor?: number; roughnessFactor?: number; [k: string]: unknown };
	extensions?: { KHR_materials_pbrSpecularGlossiness?: { diffuseFactor?: number[]; diffuseTexture?: GltfTextureRef; [k: string]: unknown }; [k: string]: unknown };
	[k: string]: unknown;
}
export interface GltfPrimitive { attributes?: Record<string, number | undefined>; indices?: number; material?: number; mode?: number; extensions?: { KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> }; [k: string]: unknown }; [k: string]: unknown }
export interface GltfMesh { primitives?: GltfPrimitive[]; [k: string]: unknown }
export interface GltfNode { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; [k: string]: unknown }
export interface GltfScene { nodes?: number[]; [k: string]: unknown }
export interface GltfBuffer { byteLength: number; uri?: string; [k: string]: unknown }
export interface GltfJson {
	asset: { version: string; generator?: string; [k: string]: unknown };
	scene?: number; scenes?: GltfScene[]; nodes?: GltfNode[]; meshes?: GltfMesh[]; materials?: GltfMaterial[];
	accessors?: GltfAccessor[]; bufferViews?: GltfBufferView[]; images?: GltfImage[]; textures?: GltfTexture[]; samplers?: Array<Record<string, unknown>>; buffers?: GltfBuffer[];
	extensions?: { CESIUM_RTC?: { center?: number[] }; [k: string]: unknown }; extensionsUsed?: string[]; extensionsRequired?: string[];
	[k: string]: unknown;
}
/** parseGlb の戻り＝JSON チャンクと BIN チャンク（無ければ空） */
export interface ParsedGlb { json: GltfJson; bin: Uint8Array }

export function parseGlb(input: Uint8Array | ArrayBuffer | ArrayLike<number>): ParsedGlb {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dec.decode(bytes.subarray(0, 4)) !== "glTF") throw new Error("not a GLB (magic)");
	const total = Math.min(dv.getUint32(8, true), bytes.length);
	let off = 12, json: GltfJson | null = null, bin: Uint8Array = new Uint8Array(0);
	while (off + 8 <= total) {
		const len = dv.getUint32(off, true), type = dec.decode(bytes.subarray(off + 4, off + 8));
		const body = bytes.subarray(off + 8, off + 8 + len);
		if (type.startsWith("JSON")) json = JSON.parse(dec.decode(body).replace(/\0+$/, "")) as GltfJson;
		else if (type.startsWith("BIN")) bin = body;
		off += 8 + len;
	}
	if (!json) throw new Error("GLB has no JSON chunk");
	return { json, bin };
}

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

export function buildGlb(json: GltfJson, bin: Uint8Array = new Uint8Array(0)): Uint8Array {
	let jb: Uint8Array = enc.encode(JSON.stringify(json));
	if (pad4(jb.length)) { const t = new Uint8Array(jb.length + pad4(jb.length)); t.set(jb); t.fill(0x20, jb.length); jb = t; }
	const bp = pad4(bin.length);
	const total = 12 + 8 + jb.length + (bin.length ? 8 + bin.length + bp : 0);
	const out = new Uint8Array(total), dv = new DataView(out.buffer);
	out.set(enc.encode("glTF"), 0); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
	dv.setUint32(12, jb.length, true); out.set(enc.encode("JSON"), 16); out.set(jb, 20);
	if (bin.length) {
		const o = 20 + jb.length;
		dv.setUint32(o, bin.length + bp, true); out.set(enc.encode("BIN\0"), o + 4); out.set(bin, o + 8);
	}
	return out;
}

// bufferView の実体（GLB の BIN か、data: URI の buffer）を取り出す
export function viewBytes(json: GltfJson, bin: Uint8Array, index: number): Uint8Array | null {
	const bv = json.bufferViews?.[index];
	if (!bv) return null;
	const off = bv.byteOffset || 0;
	return bin.subarray(off, off + bv.byteLength);
}
