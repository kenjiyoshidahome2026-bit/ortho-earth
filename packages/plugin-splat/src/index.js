// @ortho-earth/plugin-splat — Gaussian splats for @ortho-earth/globe (third wave W10).
//   map.use(splatPlugin()) fills the reserved map.addData kind "splat" (contract: globe src/splat.js SplatData, or a .ply / .splat / .spz URL).
//   Drawn as a same-frame overlay (map.overlay, WebGL2): back-to-front by view depth, each splat an ellipse from its 3D covariance,
//   hidden by terrain and buildings (scene depth), picked by the unified picking (handle.pick, map.on("click", id, …), queryRenderedFeatures({ layers: [id] })).
//   Readers run on the main thread in plain JS (.spz is gunzipped with the built-in DecompressionStream); a decoder of your own (e.g. a WASM build) plugs in via splatPlugin({ decoders }).
import { parsePly, parseSplat, parseSpz, formatOf, toEnu } from "./formats.js";
export { parsePly, parseSplat, parseSpz, decodeSpz, toEnu, quatMat, placeMat, AXES, SH_C0 } from "./formats.js";
const SPLAT_URL = new URL("./splat-gl.js", import.meta.url).href;
export const VERSION = "0.1.0";
const READERS = { ply: parsePly, splat: parseSplat, spz: parseSpz };

const checkEnum = (v, list, name) => { if (!list.includes(v)) throw new Error(`plugin-splat: ${name} must be ${list.join(" | ")} (got ${JSON.stringify(v)})`); return v; };
// 契約の形（globe の normSplat と同じ検め＝plugin を直に呼んだ時のため）
export function checkSplatData(d) {
	if (!d || typeof d !== "object") throw new TypeError("plugin-splat: data must be SplatData or a .ply/.splat/.spz URL");
	const n = d.n ?? (d.positions instanceof Float32Array ? d.positions.length / 3 : NaN), crs = d.crs ?? "lnglat";
	if (!Number.isInteger(n) || n < 0) throw new RangeError("plugin-splat: n must be a non-negative integer");
	checkEnum(crs, ["lnglat", "ecef", "local"], "crs");
	const f = (v, nm, len) => { if (!(v instanceof Float32Array) || v.length !== len) throw new TypeError(`plugin-splat: ${nm} must be a Float32Array of length ${len}`); };
	f(d.positions, "positions", n * 3); f(d.scales, "scales", n * 3); f(d.rotations, "rotations", n * 4);
	if (!(d.colors instanceof Uint8Array) || d.colors.length !== n * 4) throw new TypeError(`plugin-splat: colors must be a Uint8Array of length ${n * 4}`);
	return { ...d, n, crs };
}

// ---- 一つの map に一つのオーバーレイ（render worker の WebGL 文脈は Chrome で 4 つまで＝層ごとに作ると地球が落ちる） ----
const shared = new WeakMap();
function acquire(map, above, id) {
	let m = shared.get(map); if (!m) shared.set(map, (m = { ids: new Set() }));
	if (m.ids.has(id)) throw new Error(`plugin-splat: a layer with id "${id}" already exists`);
	const k = above ? "above" : "below";
	if (!m[k]) m[k] = { ov: map.overlay(SPLAT_URL, { name: above ? "plugin-splat:above" : "plugin-splat", above, opts: { depth: true } }), refs: 0 };
	m[k].refs++; m.ids.add(id);
	return { ov: m[k].ov, release() { m.ids.delete(id); if (--m[k].refs > 0) return; m[k].ov.remove(); delete m[k]; } };
}

async function load(src, o, decoders) {
	const fmt = o.format ?? formatOf(src);
	if (!fmt) throw new Error(`plugin-splat: cannot tell the format of ${String(src).slice(0, 80)} (pass opts.format "ply" | "splat" | "spz")`);
	checkEnum(fmt, ["ply", "splat", "spz"], "format");
	let bytes = src;
	if (typeof src === "string" || src instanceof URL) {
		const u = new URL(String(src), globalThis.location?.href).href, r = await fetch(u);
		if (!r.ok) throw new Error(`plugin-splat: ${u} → HTTP ${r.status}`);
		bytes = new Uint8Array(await r.arrayBuffer());
	} else if (src instanceof ArrayBuffer) bytes = new Uint8Array(src);
	const d = await (decoders?.[fmt] ?? READERS[fmt])(bytes);
	return checkSplatData({ crs: "local", ...d });
}

let anonSeq = 0;
/** map.addData(data, { kind: "splat", … }) の実体 */
export function createSplat(map, data, opts = {}, { decoders } = {}) {
	if (opts.altitude != null) checkEnum(opts.altitude, ["relative", "absolute"], "altitude");
	if (opts.upAxis != null) checkEnum(opts.upAxis, ["z", "y", "-y"], "upAxis");
	const id = opts.id ?? `splat${++anonSeq}`;
	const { ov, release } = acquire(map, !!opts.above, id);
	try { ov.addLayerId?.(id); } catch (e) { release(); throw e; }   // 同じ id の層が既にある＝投げる
	let cur = data, props = { ...opts }, removed = false, seq = 0;
	const h = { id, kind: "splat", overlay: ov, n: 0, anchor: null };
	const run = async (src, o) => {
		const my = ++seq;
		const d = typeof src === "string" || src instanceof URL || src instanceof ArrayBuffer || src instanceof Uint8Array ? await load(src, o, decoders) : checkSplatData(src);
		const e = toEnu(d, { origin: o.origin, upAxis: o.upAxis, orientation: o.orientation, scale: o.scale ?? 1, opacity: o.opacity ?? 1 });
		if (removed || my !== seq) return h;
		const rgba = e.rgba === d.colors && !(typeof src === "string") ? e.rgba.slice() : e.rgba;   // 渡した人の配列は手放さない（transfer は写しで）
		h.n = e.n; h.anchor = e.anchor; cur = src;
		ov.post({ type: "layer", q: id, n: e.n, anchor: e.anchor, alt: o.altitude ?? (d.crs === "ecef" ? "absolute" : "relative"), ctr: e.ctr, cov: e.cov, rgba, radius: e.radius, depthTest: o.depthTest !== false, properties: o.properties ?? null }, [e.ctr.buffer, e.cov.buffer, rgba.buffer]);
		return h;
	};
	h.ready = run(data, props);
	h.setData = d => (h.ready = run(d, props));
	h.setProps = p => { props = { ...props, ...p }; return (h.ready = run(cur, props)); };
	h.setVisible = on => { if (!removed) ov.post({ type: "vis", q: id, on: !!on }); return h; };
	h.pick = async (x, y, r = 4) => (await map.pickOverlays(x, y, { radius: r, names: [ov.name] })).filter(t => t.layer === id);
	h.remove = () => { if (removed) return; removed = true; ov.post({ type: "remove", q: id }); ov.removeLayerId?.(id); release(); };
	return h;
}

/** map.use(splatPlugin()) → map.addData(data, { kind: "splat", origin?, upAxis?, orientation?, scale?, altitude?, opacity?, depthTest?, above?, properties? }) */
export function splatPlugin({ decoders } = {}) {
	if (decoders != null) for (const [k, f] of Object.entries(decoders)) { checkEnum(k, ["ply", "splat", "spz"], "decoders key"); if (typeof f !== "function") throw new TypeError(`plugin-splat: decoders.${k} must be a function (bytes) → SplatData`); }
	return {
		name: "plugin-splat",
		version: VERSION,
		provides: ["data.splat"],
		install(map) {
			map.registry.dataKinds.add("splat", { create: (m, data, o) => createSplat(m, data, o, { decoders }) });
			return () => { try { map.registry.dataKinds.remove("splat"); } catch { /* 既に外れた */ } };
		},
	};
}
export default splatPlugin;
