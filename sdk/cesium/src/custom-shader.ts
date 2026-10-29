// CustomShader (Model.customShader, Cesium3DTileset.customShader) → map.setCustomShader: the user's GLSL goes to the globe as it is
// (GL injects it, WebGPU translates it to WGSL). Uniform values follow setUniform; TextureUniform images go up as RGBA or ImageBitmap.
type Any = any;   // eslint-disable-line @typescript-eslint/no-explicit-any

const NEAREST = 9728, REPEAT = 10497;   // WebGL TextureMinificationFilter.NEAREST, TextureWrap.REPEAT
const PF = { ALPHA: 6406, RGB: 6407, RGBA: 6408, LUMINANCE: 6409, LUMINANCE_ALPHA: 6410, RED: 6403, RG: 33319 };
let SEQ = 0;
const reg = new WeakMap<object, { id: string; maps: Set<Any>; texRev: Map<string, Any> }>();

/** a uniform's value as the globe takes it: number | boolean | number[] (vectors, column-major matrices, colours) */
function plain(type: string, v: Any): Any {
	if (v == null) return v;
	if (typeof v === "number" || typeof v === "boolean") return v;
	if (/^mat[234]$/.test(type)) { const n = (+type[3]) ** 2; return Array.from({ length: n }, (_, i) => +(v[i] ?? 0)); }
	if ("red" in v) return [v.red, v.green, v.blue, v.alpha];
	if ("x" in v) return [v.x, v.y, v.z, v.w].filter(c => c !== undefined);
	if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<number>);
	return v;
}
function specOf(cs: Any): Any {
	const uniforms: Record<string, string> = {}, values: Record<string, Any> = {};
	for (const [n, u] of Object.entries<Any>(cs.uniforms ?? {})) { uniforms[n] = u.type; if (u.type !== "sampler2D") values[n] = plain(u.type, u.value); }
	return { vs: cs.vertexShaderText ?? null, fs: cs.fragmentShaderText ?? null, uniforms, values,
		lighting: cs.lightingModel === 0 ? "UNLIT" : cs.lightingModel === 1 ? "PBR" : undefined, translucency: cs.translucencyMode === 2 ? "TRANSLUCENT" : cs.translucencyMode === 1 ? "OPAQUE" : undefined };
}
/** a typed array of the given PixelFormat → RGBA8 */
function rgbaOf(t: Any): Uint8Array | null {
	const a = t.typedArray as ArrayLike<number>, w = t.width | 0, h = t.height | 0, n = w * h;
	if (!a || !n) return null;
	const f = t.pixelFormat ?? PF.RGBA, k = f === PF.RGBA ? 4 : f === PF.RGB ? 3 : f === PF.LUMINANCE_ALPHA || f === PF.RG ? 2 : 1, o = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const s = i * k, d = i * 4;
		if (k >= 3) { o[d] = a[s]; o[d + 1] = a[s + 1]; o[d + 2] = a[s + 2]; o[d + 3] = k === 4 ? a[s + 3] : 255; }
		else if (f === PF.ALPHA) { o[d] = o[d + 1] = o[d + 2] = 0; o[d + 3] = a[s]; }
		else if (f === PF.RG) { o[d] = a[s]; o[d + 1] = a[s + 1]; o[d + 2] = 0; o[d + 3] = 255; }
		else if (f === PF.RED) { o[d] = a[s]; o[d + 1] = o[d + 2] = 0; o[d + 3] = 255; }
		else { o[d] = o[d + 1] = o[d + 2] = a[s]; o[d + 3] = k === 2 ? a[s + 1] : 255; }
	}
	return o;
}
function sendTexture(map: Any, id: string, name: string, t: Any): void {
	if (!t || typeof map.setCustomShaderTexture !== "function") return;
	const opts = { nearest: t.sampler?.minificationFilter === NEAREST, repeat: t.sampler ? t.sampler.wrapS === REPEAT : true };
	if (t.typedArray) { const rgba = rgbaOf(t); if (rgba) map.setCustomShaderTexture(id, name, { rgba, w: t.width, h: t.height }, opts); return; }
	const res = t.resource ?? t.url;
	if (!res?.fetchImage) return;
	// Cesium uploads an image with flipY (v = 0 is the image's bottom row); the globe's model textures keep row 0 at v = 0
	res.fetchImage().then((img: Any) => createImageBitmap(img, { imageOrientation: "flipY" })).then((bitmap: ImageBitmap) => map.setCustomShaderTexture(id, name, { bitmap }, opts))
		.catch((e: Any) => console.warn("[csshim] CustomShader texture", name, e?.message ?? e));
}
/** the globe's name for a CustomShader on this map (defined there on first use). setUniform afterwards re-sends the values (once per task) */
export function customShaderId(map: Any, cs: Any): string | null {
	if (!cs || !map || typeof map.setCustomShader !== "function") return null;
	let r = reg.get(cs);
	if (!r) {
		r = { id: `cesium-cs:${++SEQ}`, maps: new Set(), texRev: new Map() };
		reg.set(cs, r);
		const rr = r, set0 = cs.setUniform?.bind(cs);
		let queued = false;
		cs.setUniform = (name: string, value: Any) => {
			const u = cs.uniforms?.[name];
			if (u?.type === "sampler2D") { if (u) u.value = value; for (const m of rr.maps) sendTexture(m, rr.id, name, value); }
			else try { set0?.(name, value); } catch { if (u) u.value = value?.clone ? value.clone() : value; }
			if (!queued) { queued = true; queueMicrotask(() => { queued = false; for (const m of rr.maps) m.setCustomShader(rr.id, specOf(cs)); }); }
		};
	}
	if (!r.maps.has(map)) {
		r.maps.add(map);
		map.setCustomShader(r.id, specOf(cs));
		for (const [n, u] of Object.entries<Any>(cs.uniforms ?? {})) if (u.type === "sampler2D") sendTexture(map, r.id, n, u.value);
	}
	return r.id;
}
