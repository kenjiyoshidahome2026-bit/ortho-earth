// ImageBasedLighting.specularEnvironmentMaps (a KTX2 cube map prefiltered by Khronos's glTF IBL Sampler, one roughness per mip, as in the
// image-based-lighting example) → map.setMeshEnvironmentMap. Cesium samples it at the reflected direction in the model's frame with
// lod = roughness × (mip levels − 1) (ImageBasedLightingStageFS); the globe does the same in csLit. Uncompressed RGBA16F / RGBA32F only.
type Any = any;   // eslint-disable-line @typescript-eslint/no-explicit-any

const VK_R16G16B16A16_SFLOAT = 97, VK_R32G32B32A32_SFLOAT = 109;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** float → IEEE half (round to nearest, overflow → inf) */
function half(v: number): number {
	f32[0] = v;
	const x = u32[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
	if (e >= 31) return s | 0x7c00 | ((x & 0x7fffffff) > 0x7f800000 ? 0x200 : 0);
	if (e <= 0) return e < -10 ? s : s | ((m | 0x800000) >> (14 - e));
	return s | (e << 10) | ((m + 0x1000) >> 13);
}

/** the cube's mip levels: each holds the 6 faces (+X −X +Y −Y +Z −Z) as RGBA16F, null when the file is not one we read */
export function parseKtx2Cube(buf: ArrayBuffer): { size: number; levels: Uint16Array[] } | null {
	const dv = new DataView(buf), id = new Uint8Array(buf, 0, 12);
	if (buf.byteLength < 80 || id[0] !== 0xab || id[1] !== 0x4b || id[2] !== 0x54 || id[3] !== 0x58) return null;
	const vk = dv.getUint32(12, true), w = dv.getUint32(20, true), h = dv.getUint32(24, true), faces = dv.getUint32(36, true), n = Math.max(1, dv.getUint32(40, true)), sc = dv.getUint32(44, true);
	if (faces !== 6 || w !== h || sc !== 0 || (vk !== VK_R16G16B16A16_SFLOAT && vk !== VK_R32G32B32A32_SFLOAT)) return null;
	const levels: Uint16Array[] = [];
	for (let m = 0; m < n; m++) {
		const off = Number(dv.getBigUint64(80 + m * 24, true)), s = Math.max(1, w >> m), count = s * s * 4 * 6;
		if (vk === VK_R16G16B16A16_SFLOAT) levels.push(new Uint16Array(buf.slice(off, off + count * 2)));
		else { const src = new Float32Array(buf.slice(off, off + count * 4)), o = new Uint16Array(count); for (let i = 0; i < count; i++) o[i] = half(src[i]); levels.push(o); }
	}
	return { size: w, levels };
}

/** the first shown primitive (two levels deep, as customIbl) whose imageBasedLighting names a specular environment map */
function specularUrl(prims: Any, depth = 0): string | null {
	const n = prims?.length ?? 0;
	for (let i = 0; i < n; i++) {
		const o = prims.get ? prims.get(i) : prims[i], u = o?.imageBasedLighting?.specularEnvironmentMaps;
		if (u && o.show !== false) return typeof u === "string" ? u : (u.url ?? u.getUrlComponent?.(true) ?? null);
		if (depth < 2 && (o?._primitives || (o?.length != null && o.get))) { const r = specularUrl(o._primitives ?? o, depth + 1); if (r) return r; }
	}
	return null;
}

/** per frame: follow the scene's specular environment map (fetched once per url) */
export function syncSpecularEnv(scene: Any, map: Any): () => void {
	let cur: string | null = null, seq = 0;
	return () => {
		if (typeof map.setMeshEnvironmentMap !== "function") return;
		const url = specularUrl(scene.primitives);
		if (url === cur) return;
		cur = url;
		const my = ++seq;
		if (!url) { map.setMeshEnvironmentMap(null); return; }
		fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }).then(b => {
			if (my !== seq) return;
			const cube = parseKtx2Cube(b);
			if (!cube) { console.warn("[csshim] specularEnvironmentMaps: only uncompressed RGBA16F/RGBA32F KTX2 cube maps are read", url); return; }
			map.setMeshEnvironmentMap(cube);
		}).catch(e => console.warn("[csshim] specularEnvironmentMaps", url, e?.message ?? e));
	};
}
