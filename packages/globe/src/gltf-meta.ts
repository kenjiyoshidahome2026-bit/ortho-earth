// glTF の見出し（第 2 波 F4・2026-10-12）＝生の json から、アニメ・拡張・テクスチャ形式・feature ID の有無を読む純関数。DOM 無し＝tests/gltf-meta.mjs。
//   描く側（meshdecode）は stats.gltf にこれを載せる＝模型の手綱（gadget model の ctl.animations・ctl.setAnimation）と 3D Tiles の手綱が「何が入っているか」を正直に答えられる。
//   アニメの再生（skin/morph/ノード変換の補間）と KTX2 の変換は描かない（口だけ＝capabilities "spec"）。
import type { StructuralMetadata } from "./mesh-features.ts";

// 公開の型（globe.d.ts の GltfMeta・GltfAnimationInfo・AnimationSpec・AnimationState）の写し。この頁は meshdecode 経由で worker からも読まれ、
// globe.d.ts は src/types/map.ts（DOM）を引く＝worker の型検査（tsconfig.worker.json）では import できない。形は globe.d.ts と同じに保つ
// （gadgets/model.ts・tiles3d.ts が公開の型へ渡す所で食い違いは型エラーになる）
/** glTF の見出し（globe.d.ts の GltfMeta と同形） */
export interface GltfMeta { animations: GltfAnimationInfo[]; skins: number; morphTargets: boolean; extensionsUsed: string[]; extensionsRequired: string[]; textureFormats: string[]; featureIds: boolean; structuralMetadata: boolean; copyright?: string }
/** アニメの見出し（globe.d.ts の GltfAnimationInfo と同形） */
export interface GltfAnimationInfo { index: number; name: string; duration: number; channels: number; paths: string[] }
/** 再生の spec（globe.d.ts の AnimationSpec と同形） */
export interface AnimationSpec { name?: string; index?: number; time?: number; loop?: boolean; speed?: number; playing?: boolean }
/** 再生の状態（globe.d.ts の AnimationState と同形） */
export interface AnimationState extends Required<Omit<AnimationSpec, "name" | "index">> { name: string | null; index: number | null; duration: number }

/** 生の glTF の json（loaders.gl が拡張を外す前）＝見出しと W5・W7 が読む欄だけ */
export interface RawGltf {
	accessors?: Array<{ max?: unknown } | null>;
	extensionsUsed?: string[]; extensionsRequired?: string[];
	animations?: Array<{ name?: unknown; samplers?: Array<{ input: number }>; channels?: Array<{ target?: { path?: string } }> }>;
	images?: Array<{ mimeType?: string; uri?: string; bufferView?: number }>;
	textures?: Array<{ extensions?: { KHR_texture_basisu?: { source?: number } } } | null>;
	skins?: unknown[];
	meshes?: Array<{ primitives?: Array<{ targets?: unknown[]; attributes?: Record<string, unknown> }> }>;
	asset?: { copyright?: unknown };
	extensions?: { EXT_structural_metadata?: StructuralMetadata; CESIUM_RTC?: { center?: number[] }; [k: string]: unknown };
}
const MIME_FMT: Record<string, string> = { "image/ktx2": "ktx2", "image/webp": "webp", "image/png": "png", "image/jpeg": "jpeg", "image/basis": "basis" };
const extFmt = (uri: string | undefined) => { const m = /\.(ktx2|webp|png|jpe?g|basis)(\?|#|$)/i.exec(uri || ""); return m ? m[1].toLowerCase().replace("jpg", "jpeg") : null; };
export function gltfMeta(json: unknown): GltfMeta {
	const j: RawGltf = json && typeof json === "object" ? json : {};
	const acc = j.accessors || [], used = [...(j.extensionsUsed || [])], required = [...(j.extensionsRequired || [])];
	const animations = (j.animations || []).map((a, index) => {
		let duration = 0;
		for (const s of a.samplers || []) { const inp = acc[s.input]; const mx = Array.isArray(inp?.max) ? +inp!.max[0] : NaN; if (Number.isFinite(mx) && mx > duration) duration = mx; }
		const targets = new Set((a.channels || []).map(c => c.target?.path).filter(Boolean) as string[]);
		return { index, name: typeof a.name === "string" && a.name ? a.name : `animation${index}`, duration: +duration.toFixed(4), channels: (a.channels || []).length, paths: [...targets] };
	});
	const fmts = new Set<string>();
	for (const im of j.images || []) { const f = MIME_FMT[im.mimeType!] || extFmt(im.uri); if (f) fmts.add(f); }
	if (used.includes("KHR_texture_basisu")) fmts.add("ktx2");
	return {
		animations, skins: (j.skins || []).length, morphTargets: (j.meshes || []).some(m => (m.primitives || []).some(p => (p.targets || []).length > 0)),
		extensionsUsed: used, extensionsRequired: required, textureFormats: [...fmts].sort(),
		featureIds: used.includes("EXT_mesh_features") || (j.meshes || []).some(m => (m.primitives || []).some(p => p.attributes && Object.keys(p.attributes).some(k => /^_FEATURE_ID_\d+$|^_BATCHID$/.test(k)))),
		structuralMetadata: used.includes("EXT_structural_metadata"),
		...(typeof j.asset?.copyright === "string" && j.asset.copyright.trim() ? { copyright: j.asset.copyright.trim() } : {}),   // asset.copyright（W8）＝3D Tiles の出典の表示義務（Google 等はタイルごとに持つ）
	};
}
// アニメの再生 spec（口だけ・保つ）：{ name|index, time(s), loop, speed, playing }。name/index が無ければ最初のアニメ。知らない name は投げる
export function normAnimation(spec: AnimationSpec | string | number | boolean | null | undefined, animations: GltfAnimationInfo[] = []): AnimationState | null {
	if (spec == null || spec === false) return null;
	const o: AnimationSpec = spec === true ? {} : typeof spec === "string" ? { name: spec } : typeof spec === "number" ? { index: spec } : typeof spec === "object" ? spec : {};
	let a: GltfAnimationInfo | null | undefined = null;
	if (o.name != null) { a = animations.find(x => x.name === String(o.name)); if (!a) throw new Error(`setAnimation: unknown animation "${o.name}" (available: ${animations.map(x => x.name).join(", ") || "none"})`); }
	else if (o.index != null) { a = animations[+o.index]; if (!a) throw new Error(`setAnimation: animation index ${o.index} out of range (${animations.length})`); }
	else a = animations[0] ?? null;
	const fin = (v: unknown, d: number) => (Number.isFinite(+(v as number)) ? +(v as number) : d);
	return { name: a?.name ?? null, index: a?.index ?? null, duration: a?.duration ?? 0, time: Math.max(0, fin(o.time, 0)), loop: o.loop !== false, speed: fin(o.speed, 1), playing: o.playing !== false };
}
// 生の glTF の json（GLB の JSON chunk か .gltf の文字列）。loaders.gl は扱った拡張を extensionsUsed から外す＝見出しは**読む前の生**から取る。読めなければ null
export function rawGltfJson(ab: ArrayBuffer | Uint8Array): RawGltf | null {
	try {
		const u8 = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
		if (u8.byteLength >= 20 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) {   // "glTF"
			const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), len = dv.getUint32(12, true), type = dv.getUint32(16, true);
			if (type !== 0x4e4f534a || 20 + len > u8.byteLength) return null;
			return JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len)));
		}
		const head = new TextDecoder().decode(u8.subarray(0, Math.min(64, u8.byteLength))).trimStart();
		return head.startsWith("{") ? JSON.parse(new TextDecoder().decode(u8)) : null;
	} catch { return null; }
}
