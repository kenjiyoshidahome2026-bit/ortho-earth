// Cesium's globe.material on the globe (2026-10-28): the globe paints elevation / slope / aspect colour ramps, contour lines and
// "land only" over the terrain's imagery (map.setGroundMaterial). A Cesium Material is read, not run: its type (or the sub-materials of a
// composite fabric) and uniforms become one GroundMaterialSpec. The fabric's own component expressions are not evaluated; the examples'
// compositions are recognised by their parts:
//   ElevationRamp / SlopeRamp / AspectRamp (image, minimumHeight, maximumHeight) → ramp · ElevationContour (color, spacing, width) → contour
//   ElevationBand (createElevationBandMaterial: ours keeps the layers) → the layers baked into a ramp · WaterMask in a composite → land only
// The ramp image (a canvas in every Sandcastle example) is read back once per image through readImage.
import { Color } from "@cesium/core";
import { Material } from "@cesium/engine";
import { unsupported } from "./report.ts";

type Any = any;
/** the globe's setGroundMaterial argument (packages/globe/globe.d.ts GroundMaterialSpec) */
export interface GroundMaterialSpec { ramp?: { kind: "elevation" | "slope" | "aspect"; colors: Uint8Array; min?: number; max?: number } | null; contour?: { spacing: number; width?: number; color: [number, number, number, number] } | null; landOnly?: boolean; opacity?: number }
/** createElevationBandMaterial's layers */
export interface BandLayer { entries: { height: number; color: Color }[]; extendDownwards?: boolean; extendUpwards?: boolean }

const RAMP_KIND: Record<string, "elevation" | "slope" | "aspect"> = { ElevationRamp: "elevation", SlopeRamp: "slope", AspectRamp: "aspect" };
const rgba = (c: Any, d: [number, number, number, number]): [number, number, number, number] => c && typeof c.red === "number" ? [c.red, c.green, c.blue, c.alpha ?? 1] : d;

/** the colour of one band layer at a height (straight alpha, 0..1), or transparent outside the layer */
function layerColor(L: BandLayer, h: number, out: number[]): number[] {
	const es = L.entries;
	let down = L.extendDownwards ?? false, up = L.extendUpwards ?? false;
	if (es.length === 1 && !down && !up) { down = true; up = true; }   // as createElevationBandMaterial: a single entry extends both ways
	const set = (c: Any) => { out[0] = c.red; out[1] = c.green; out[2] = c.blue; out[3] = c.alpha ?? 1; return out; };
	if (h < es[0].height) return down ? set(es[0].color) : (out[3] = 0, out);
	const last = es[es.length - 1];
	if (h > last.height) return up ? set(last.color) : (out[3] = 0, out);
	for (let i = 1; i < es.length; i++) {
		const a = es[i - 1], b = es[i];
		if (h <= b.height) {
			const t = b.height === a.height ? 1 : (h - a.height) / (b.height - a.height);
			out[0] = a.color.red + (b.color.red - a.color.red) * t; out[1] = a.color.green + (b.color.green - a.color.green) * t;
			out[2] = a.color.blue + (b.color.blue - a.color.blue) * t; out[3] = (a.color.alpha ?? 1) + ((b.color.alpha ?? 1) - (a.color.alpha ?? 1)) * t;
			return out;
		}
	}
	return set(last.color);
}

/** the band layers baked into one colour ramp over [min, max] (n samples; later layers over earlier ones, as the material composites them) */
export function bandRamp(layers: BandLayer[], n = 1024): { colors: Uint8Array; min: number; max: number } | null {
	const Ls = layers.map(L => ({ ...L, entries: [...(L.entries || [])].filter(e => e && Number.isFinite(e.height) && e.color).sort((a, b) => a.height - b.height) })).filter(L => L.entries.length);
	if (!Ls.length) return null;
	let min = Infinity, max = -Infinity;
	for (const L of Ls) { min = Math.min(min, L.entries[0].height); max = Math.max(max, L.entries[L.entries.length - 1].height); }
	if (!(max > min)) { max = min + 1; }
	const anyDown = Ls.some(L => L.extendDownwards || (L.entries.length === 1 && !L.extendUpwards)), anyUp = Ls.some(L => L.extendUpwards || (L.entries.length === 1 && !L.extendDownwards));
	// the ramp is clamped at its ends when sampled: a half step outside the range takes the end sample, so when no layer extends that way the end sample is transparent
	const pad = (max - min) / n;
	const lo = anyDown ? min : min - pad, hi = anyUp ? max : max + pad;
	const colors = new Uint8Array(n * 4), c = [0, 0, 0, 0];
	for (let i = 0; i < n; i++) {
		const h = lo + (hi - lo) * (n === 1 ? 0 : i / (n - 1));
		let r = 0, g = 0, b = 0, a = 0;
		for (const L of Ls) {
			layerColor(L, h, c);
			const la = c[3];
			if (la <= 0) continue;
			const oa = la + a * (1 - la);
			r = (c[0] * la + r * a * (1 - la)) / oa; g = (c[1] * la + g * a * (1 - la)) / oa; b = (c[2] * la + b * a * (1 - la)) / oa; a = oa;
		}
		colors[i * 4] = Math.round(Math.min(1, Math.max(0, r)) * 255); colors[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
		colors[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255); colors[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
	}
	return { colors, min: lo, max: hi };
}

/** Cesium's createElevationBandMaterial without a GL context: the Material of type ElevationBand keeps its layers for the globe */
export function createElevationBandMaterial(options: { scene?: unknown; layers: BandLayer[] }): Any {
	const layers = options?.layers;
	if (!Array.isArray(layers) || !layers.length) throw new Error("createElevationBandMaterial: options.layers is required");
	const m: Any = Material.fromType("ElevationBand");
	m.__orthoBand = { layers: layers.map(L => ({ entries: (L.entries || []).map(e => ({ height: e.height, color: Color.clone(e.color) })), extendDownwards: L.extendDownwards, extendUpwards: L.extendUpwards })) };
	return m;
}

const imageIds = new WeakMap<object, number>(); let nextImageId = 1;
const imageId = (im: Any): string => {
	if (!im || typeof im !== "object") return typeof im === "string" ? im : "";
	let id = imageIds.get(im); if (!id) imageIds.set(im, id = nextImageId++);
	return `#${id}`;
};
const num = (v: Any, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** a string that changes when the painted result would (uniform values, image identity): the facade re-reads the material only then */
export function materialKey(material: Any): string {
	if (!material) return "";
	const parts: string[] = [];
	const one = (m: Any) => {
		const u = m?.uniforms ?? {}, t = m?.type ?? "?";
		const c = rgba(u.color, [0, 0, 0, 0]);
		parts.push(`${t}|${imageId(u.image)}|${num(u.minimumHeight, 0)}|${num(u.maximumHeight, 0)}|${num(u.spacing, 0)}|${num(u.width, 0)}|${c.map(v => v.toFixed(3)).join(",")}|${m?.__orthoBand ? "band" : ""}`);
	};
	one(material);
	if (material.materials) for (const k of Object.keys(material.materials)) { parts.push(k); one(material.materials[k]); }
	return parts.join(";");
}

/**
 * a Cesium Material (globe.material) → the globe's ground material, or null when nothing in it is painted (reported once).
 * readImage(image) → the image's pixels as one row of RGBA (the ramp), or null when it cannot be read.
 */
export function groundMaterialOf(material: Any, readImage: (im: Any) => Uint8Array | null): GroundMaterialSpec | null {
	if (!material) return null;
	const spec: GroundMaterialSpec = {};
	let painted = false;
	const subs: Any[] = material.materials ? Object.values(material.materials) : [];
	const composite = subs.length > 0;
	for (const m of composite ? subs : [material]) {
		const t = m?.type, u = m?.uniforms ?? {};
		if (RAMP_KIND[t]) {
			const colors = readImage(u.image);
			if (colors && colors.length >= 4) { spec.ramp = { kind: RAMP_KIND[t], colors, min: num(u.minimumHeight, 0), max: num(u.maximumHeight, 1) }; painted = true; }
			else unsupported(`globe.material ${t} (the ramp image could not be read)`);
		} else if (t === "ElevationContour") {
			spec.contour = { spacing: num(u.spacing, 100), width: num(u.width, 1), color: rgba(u.color, [1, 0, 0, 1]) }; painted = true;
		} else if (t === "ElevationBand") {
			const r = m.__orthoBand ? bandRamp(m.__orthoBand.layers) : null;
			if (r) { spec.ramp = { kind: "elevation", colors: r.colors, min: r.min, max: r.max }; painted = true; }
			else unsupported("globe.material ElevationBand (made without createElevationBandMaterial)");
		} else if (t === "WaterMask") {
			if (composite) spec.landOnly = true;   // "alpha: 1.0 - waterMaskMaterial.alpha": the other parts are painted on land only
			else unsupported("globe.material WaterMask");
		} else unsupported(`globe.material ${t ?? "?"}`);
	}
	return painted ? spec : null;
}

/** the pixels of a ramp image (a canvas, an image or a bitmap) as one row of RGBA, in the browser; null elsewhere */
export function readRampImage(im: Any): Uint8Array | null {
	if (!im || typeof document === "undefined") return null;
	try {
		const w = im.width | 0, h = im.height | 0;
		if (!(w > 0) || !(h > 0)) return null;
		let cv: HTMLCanvasElement = im;
		if (!(typeof HTMLCanvasElement !== "undefined" && im instanceof HTMLCanvasElement)) { cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d")!.drawImage(im, 0, 0); }
		const d = cv.getContext("2d", { willReadFrequently: true })!.getImageData(0, Math.floor(h / 2), w, 1).data;   // the middle row (the ramps are 1 px high; bathymetry's is 15)
		return Uint8Array.from(d);
	} catch (e) { console.warn("[csshim] globe.material ramp image", e); return null; }
}
