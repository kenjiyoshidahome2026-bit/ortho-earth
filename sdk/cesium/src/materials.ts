// Cesium's procedural and image materials (Stripe, Checkerboard, Grid, Image) painted into a picture over the geometry's texture
// coordinates (st): the same formulas as Cesium's material shaders (StripeMaterial.glsl, CheckerboardMaterial.glsl, GridMaterial.glsl),
// evaluated per pixel. The picture goes on the triangles as a glTF texture (primitives.ts) or, for a shape on the ground, onto the
// globe as an image layer over the shape's longitude/latitude box (display.ts).
// Grid's lines are measured in screen pixels in Cesium; here they are a fixed share of the picture (about the same at the size it is seen).
import { Color, JulianDate } from "@cesium/core";

type Any = any;
/** a material to paint: its type and uniforms (from a MaterialProperty at a time, or an appearance's Material) */
export interface MatDesc { type: string; u: Record<string, Any> }
const PAINTED = new Set(["Stripe", "Checkerboard", "Grid", "Image"]);

/** an entity graphic's material (MaterialProperty) → what to paint, or null (a plain colour, or a kind not painted) */
export function matOfProperty(m: Any, t: JulianDate): MatDesc | null {
	if (!m || m instanceof Color || typeof m.getType !== "function") return null;
	const type = m.getType(t);
	return PAINTED.has(type) ? { type, u: m.getValue(t, {}) ?? {} } : null;
}
/** a Primitive appearance's Material → what to paint, or null */
export function matOfMaterial(m: Any): MatDesc | null {
	return m && PAINTED.has(m.type) ? { type: m.type, u: m.uniforms ?? {} } : null;
}
/** a key that changes when the picture would */
export function matKey(d: MatDesc): string {
	return JSON.stringify(d, (_k, v) => (v instanceof Color ? [v.red, v.green, v.blue, v.alpha] : typeof HTMLElement !== "undefined" && v instanceof HTMLElement ? (v as Any).src ?? "element" : v));
}
/** does the picture have see-through parts (the triangles are blended) */
export function matTranslucent(d: MatDesc): boolean {
	const u = d.u, a = (c: Any) => (c instanceof Color ? c.alpha : 1);
	switch (d.type) {
		case "Stripe": return a(u.evenColor) < 1 || a(u.oddColor) < 1;
		case "Checkerboard": return a(u.lightColor) < 1 || a(u.darkColor) < 1;
		case "Grid": return a(u.color) < 1 || (u.cellAlpha ?? 0.1) < 1;
		case "Image": return true;   // the image may have alpha (Cesium's transparent flag is off by default, but PNGs drawn so are rare)
	}
	return false;
}

const rgba = (c: Any, d: number[]): number[] => (c instanceof Color ? [c.red * 255, c.green * 255, c.blue * 255, c.alpha * 255] : d);
const xy = (v: Any, d: number): [number, number] => (typeof v === "number" ? [v, v] : v ? [v.x ?? d, v.y ?? d] : [d, d]);
const fract = (x: number) => x - Math.floor(x);

/** the colour (0..255 rgba) of a procedural material at st; px = the picture's pixels per st unit (for line widths) */
function sampler(d: MatDesc, px: number): ((s: number, t: number) => number[]) | null {
	const u = d.u;
	switch (d.type) {
		case "Solid": { const c = rgba(u.color, [255, 255, 255, 255]); return () => c; }   // a plain colour (a ground fill stacked under a painted one)
		case "Stripe": {
			const even = rgba(u.evenColor, [255, 255, 255, 255]), odd = rgba(u.oddColor, [0, 0, 0, 255]), rep = u.repeat ?? 5, off = u.offset ?? 0, hz = u.horizontal ?? true;
			return (s, t) => (fract(((hz ? t : s) - off) * rep * 0.5) < 0.5 ? even : odd);
		}
		case "Checkerboard": {
			const light = rgba(u.lightColor, [255, 255, 255, 255]), dark = rgba(u.darkColor, [0, 0, 0, 255]), [rx, ry] = xy(u.repeat, 5);
			return (s, t) => ((Math.floor(rx * s) + Math.floor(ry * t)) % 2 === 0 ? light : dark);
		}
		case "Grid": {
			const c = rgba(u.color, [255, 255, 255, 255]), cell = u.cellAlpha ?? 0.1, [nx, ny] = xy(u.lineCount, 8), [tx, ty] = xy(u.lineThickness, 1), [ox, oy] = xy(u.lineOffset, 0);
			const cellC = [c[0], c[1], c[2], c[3] * cell], hx = nx * (tx + 0.2) / px, hy = ny * (ty + 0.2) / px;   // half a line, in cell units
			return (s, t) => {
				const w = fract(nx * s - ox), h = fract(ny * t - oy), dw = Math.abs(w - Math.floor(w + 0.5)), dh = Math.abs(h - Math.floor(h + 0.5));
				return dw < hx || dh < hy ? c : cellC;
			};
		}
	}
	return null;
}

const images = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(src: string): Promise<HTMLImageElement | null> {
	let p = images.get(src);
	if (!p) {
		p = new Promise(res => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
		images.set(src, p);
	}
	return p;
}
const imageUrl = (im: Any): string | null => (typeof im === "string" ? new URL(im, location.href).href : im?.url ? new URL(im.url, location.href).href : im instanceof HTMLCanvasElement ? im.toDataURL() : im instanceof HTMLImageElement ? im.src : null);

/**
 * paint the material into a W×H canvas; stOf(x, y) gives the st of a pixel centre (null = outside the shape: transparent).
 * Image: the picture repeated `repeat` times over st (st by the canvas axes, as Cesium's rectangles and polygons map it), tinted by its colour.
 */
export async function paint(d: MatDesc, W: number, H: number, stOf: (x: number, y: number) => [number, number] | null): Promise<HTMLCanvasElement | null> {
	const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
	const ctx = cv.getContext("2d");
	if (!ctx) return null;
	if (d.type === "Image") {
		const src = imageUrl(d.u.image);
		const im = src ? await loadImage(src) : null;
		if (!im) return null;
		const [rx, ry] = xy(d.u.repeat, 1), tint = rgba(d.u.color, [255, 255, 255, 255]);
		const tile = document.createElement("canvas"); tile.width = im.naturalWidth; tile.height = im.naturalHeight;
		const tc = tile.getContext("2d")!; tc.drawImage(im, 0, 0);
		const src4 = tc.getImageData(0, 0, tile.width, tile.height).data, out = ctx.createImageData(W, H), o = out.data;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const st = stOf(x + 0.5, y + 0.5);
			if (!st) continue;
			const ix = Math.min(tile.width - 1, Math.floor(fract(st[0] * rx) * tile.width)), iy = Math.min(tile.height - 1, Math.floor((1 - fract(st[1] * ry)) * tile.height)), k = (iy * tile.width + ix) * 4, j = (y * W + x) * 4;
			for (let c = 0; c < 4; c++) o[j + c] = src4[k + c] * tint[c] / 255;
		}
		ctx.putImageData(out, 0, 0);
		return cv;
	}
	const f = sampler(d, Math.max(W, H));
	if (!f) return null;
	const out = ctx.createImageData(W, H), o = out.data;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const st = stOf(x + 0.5, y + 0.5);
		if (!st) continue;
		const c = f(st[0], st[1]), j = (y * W + x) * 4;
		o[j] = c[0]; o[j + 1] = c[1]; o[j + 2] = c[2]; o[j + 3] = c[3];
	}
	ctx.putImageData(out, 0, 0);
	return cv;
}
/** the material over the whole st square (row 0 = t 1: the top of the picture, as glTF reads it with v = 1 − t) */
export const paintSquare = (d: MatDesc, size = 512) => paint(d, size, size, (x, y) => [x / size, 1 - y / size]);
