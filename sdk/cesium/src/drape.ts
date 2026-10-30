// Cesium3DTileset.imageryLayers → imagery draped on the tileset (map.setMeshImagery + Tiles3DOptions.imagery).
// The globe reads one picture per tileset over a window, by each mesh pixel's place (straight down). The window is what the camera sees of the
// ground (a grid of pick rays on the ellipsoid, cut to the tileset), at the size of a screen pixel near the eye (≤ MAX_PX across). Each shown
// layer's tiles come through its provider's requestImage (ion tokens, Bing, Google 2D, geographic schemes) at the level whose texel matches,
// are drawn in Web Mercator rows on the layer's own canvas, and the layers go on in collection order with their alpha. The picture is sent
// again as tiles arrive (throttled) and made again when the view leaves the window or its resolution moves by more than ×1.6.
import { Cartesian2, Cartesian3, Cartographic, Ellipsoid, IntersectionTests } from "@cesium/core";

type Any = any;
const MAX_PX = 4096, MAX_TILES = 400, PUSH_MS = 300, SETTLE_MS = 250, R = 6378137;
const D2R = Math.PI / 180;
const mercY = (latRad: number) => Math.log(Math.tan(Math.PI / 4 + Math.max(-1.4844, Math.min(1.4844, latRad)) / 2));
let drapeN = 0, layerN = 0;
const layerIds = new WeakMap<object, number>();

/** the window: degrees + canvas size */
interface Win { west: number; south: number; east: number; north: number; w: number; h: number; mpp: number }

/** the camera's view of the ground as a window (null = it sees no ground) */
export function viewWindow(scene: Any, sphere: { center: Cartesian3; radius: number } | null): Win | null {
	const cam = scene?.camera, W = scene?.drawingBufferWidth || scene?.canvas?.clientWidth || 0, H = scene?.drawingBufferHeight || scene?.canvas?.clientHeight || 0;
	if (!cam?.getPickRay || !W || !H) return null;
	const eye = cam.positionWC as Cartesian3, ell = Ellipsoid.WGS84, eyeC = Cartographic.fromCartesian(eye, ell);
	const hgt = Math.max(1, eyeC?.height ?? 1), reach = Math.max(3000, hgt * 6);   // rays toward the horizon stop here
	const pts: Cartographic[] = []; let near = Infinity;
	const N = 9;
	for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
		const ray = cam.getPickRay(new Cartesian2(i / (N - 1) * W, j / (N - 1) * H));
		if (!ray) continue;
		const hit = IntersectionTests.rayEllipsoid(ray, ell);
		let d = hit ? hit.start : reach;
		if (!hit || d > reach) d = reach;   // past the horizon or far: the point at the reach (keeps the window's far edge bounded)
		const p = Cartesian3.add(ray.origin, Cartesian3.multiplyByScalar(ray.direction, d, new Cartesian3()), new Cartesian3());
		const c = Cartographic.fromCartesian(p, ell);
		if (!c) continue;
		pts.push(c); near = Math.min(near, d);
	}
	if (!pts.length || !Number.isFinite(near)) return null;
	let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
	for (const c of pts) { w = Math.min(w, c.longitude); e = Math.max(e, c.longitude); s = Math.min(s, c.latitude); n = Math.max(n, c.latitude); }
	if (e - w > Math.PI) return null;   // across the antimeridian: not drawn
	if (sphere && sphere.radius < 2e6) {   // cut to the tileset
		const c = Cartographic.fromCartesian(sphere.center, ell);
		if (c) {
			const dLat = sphere.radius / R, dLon = dLat / Math.max(0.05, Math.cos(c.latitude));
			w = Math.max(w, c.longitude - dLon); e = Math.min(e, c.longitude + dLon); s = Math.max(s, c.latitude - dLat); n = Math.min(n, c.latitude + dLat);
			if (e <= w || n <= s) return null;
		}
	}
	const mx = (e - w) * 0.05, my = (n - s) * 0.05;
	w -= mx; e += mx; s -= my; n += my;
	const latC = (s + n) / 2, cosC = Math.cos(latC);
	const wm = (e - w) * R * cosC, hm = (mercY(n) - mercY(s)) * R * cosC;
	const fovy = cam.frustum?.fovy ?? cam.frustum?.fov ?? 1;
	let mpp = Math.max(0.1, near * 2 * Math.tan(fovy / 2) / H);   // a screen pixel at the nearest ground
	mpp = Math.max(mpp, wm / MAX_PX, hm / MAX_PX);
	return { west: w / D2R, south: s / D2R, east: e / D2R, north: n / D2R, w: Math.max(1, Math.ceil(wm / mpp)), h: Math.max(1, Math.ceil(hm / mpp)), mpp };
}
/** does the composed window still serve the wanted one? (inside it, resolution within ×1.6) */
const serves = (have: Win | null, want: Win) => !!have && want.west >= have.west && want.east <= have.east && want.south >= have.south && want.north <= have.north && want.mpp / have.mpp < 1.6 && have.mpp / want.mpp < 1.6;

/** the level of the provider's scheme whose texel is at most mpp at latitude latC (clamped to the provider's levels, fewer than MAX_TILES tiles) */
function levelOf(p: Any, win: Win): number {
	const ts = p.tilingScheme, rect = ts.rectangle, tw = p.tileWidth || 256, cosC = Math.cos((win.south + win.north) / 2 * D2R);
	const lo = p.minimumLevel ?? 0, hi = p.maximumLevel ?? 21;
	let L = lo;
	for (; L < hi; L++) if ((rect.east - rect.west) / ts.getNumberOfXTilesAtLevel(L) * R * cosC / tw <= win.mpp) break;
	for (; L > lo; L--) { const r = tileRange(ts, win, L); if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) <= MAX_TILES) break; }
	return L;
}
function tileRange(ts: Any, win: Win, L: number) {
	const a = ts.positionToTileXY(Cartographic.fromDegrees(win.west, win.north), L), b = ts.positionToTileXY(Cartographic.fromDegrees(win.east, win.south), L);
	return { x0: Math.min(a?.x ?? 0, b?.x ?? 0), x1: Math.max(a?.x ?? 0, b?.x ?? 0), y0: Math.min(a?.y ?? 0, b?.y ?? 0), y1: Math.max(a?.y ?? 0, b?.y ?? 0) };
}

/** one tileset's draped imagery */
export class TilesetDrape {
	readonly id = `__cs-drape-${drapeN++}`;
	#map: Any; #win: Win | null = null; #layersKey = ""; #gen = 0; #on = false;
	#camKey = ""; #camAt = 0; #evalKey = "";
	#cvs: Array<{ c: OffscreenCanvas; alpha: number }> = []; #pushT: ReturnType<typeof setTimeout> | null = null;
	constructor(map: Any) { this.#map = map; }

	/** each frame: the shown layers and the camera → (re)compose when needed */
	sync(tileset: Any, scene: Any, handle: Any) {
		const coll = tileset.imageryLayers, layers: Any[] = [];
		for (let i = 0; i < (coll?.length ?? 0); i++) { const L = coll.get(i); if (L?.show && L.ready && L.imageryProvider && (L.alpha ?? 1) > 0) layers.push(L); }
		if (!layers.length) { if (this.#on) this.clear(handle); return; }
		const lk = layers.map(L => { let n = layerIds.get(L); if (n == null) layerIds.set(L, n = layerN++); return `${n}:${L.alpha ?? 1}`; }).join(",");
		const cam = scene.camera, p = cam.positionWC, d = cam.directionWC;
		const ck = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)},${d.x.toFixed(4)},${d.y.toFixed(4)},${d.z.toFixed(4)},${scene.drawingBufferWidth},${scene.drawingBufferHeight}`;
		const now = performance.now();
		if (ck !== this.#camKey) { this.#camKey = ck; this.#camAt = now; if (this.#on) return; }
		if (this.#on && now - this.#camAt < SETTLE_MS && lk === this.#layersKey) return;   // the camera is moving: wait until it rests
		if (ck + lk === this.#evalKey) return;   // looked at this view already
		this.#evalKey = ck + lk;
		const want = viewWindow(scene, tileset.boundingSphere);
		if (!want) return;
		if (lk === this.#layersKey && serves(this.#win, want)) return;
		this.#layersKey = lk; this.#win = want;
		if (!this.#on) { this.#on = true; handle?.setOptions?.({ imagery: this.id }); }
		this.#compose(want, layers);
	}
	clear(handle?: Any) {
		this.#gen++; this.#on = false; this.#win = null; this.#layersKey = ""; this.#evalKey = ""; this.#cvs = [];
		if (this.#pushT) { clearTimeout(this.#pushT); this.#pushT = null; }
		handle?.setOptions?.({ imagery: null });
		this.#map?.setMeshImagery?.(this.id, null);
	}

	#compose(win: Win, layers: Any[]) {
		const gen = ++this.#gen;
		this.#cvs = layers.map(L => ({ c: new OffscreenCanvas(win.w, win.h), alpha: L.alpha ?? 1 }));
		const yN = mercY(win.north * D2R), yS = mercY(win.south * D2R), w0 = win.west * D2R, w1 = win.east * D2R;
		layers.forEach((L, li) => {
			const p = L.imageryProvider, ts = p?.tilingScheme;
			if (!ts || typeof p.requestImage !== "function") return;
			const lv = levelOf(p, win), r = tileRange(ts, win, lv), ctx = this.#cvs[li].c.getContext("2d")!;
			for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
				const tr = ts.tileXYToRectangle(x, y, lv);
				let im: Any;
				try { im = p.requestImage(x, y, lv); } catch { continue; }
				Promise.resolve(im).then((img: Any) => {
					if (gen !== this.#gen || !img) return;
					if (p.tileDiscardPolicy?.isReady?.() && p.tileDiscardPolicy.shouldDiscardImage?.(img)) return;
					const dx0 = (tr.west - w0) / (w1 - w0) * win.w, dx1 = (tr.east - w0) / (w1 - w0) * win.w;
					const dy0 = (yN - mercY(tr.north)) / (yN - yS) * win.h, dy1 = (yN - mercY(tr.south)) / (yN - yS) * win.h;
					// ImageryProvider.loadImage fetches ImageBitmaps with flipY (ready for a WebGL upload): draw those mirrored (as imagery.ts geoTile)
					if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) { ctx.save(); ctx.translate(dx0, dy1); ctx.scale(1, -1); ctx.drawImage(img, 0, 0, dx1 - dx0, dy1 - dy0); ctx.restore(); }
					else ctx.drawImage(img, dx0, dy0, dx1 - dx0, dy1 - dy0);
					this.#schedulePush(gen, win);
				}, () => {});
			}
		});
	}
	#schedulePush(gen: number, win: Win) {
		if (this.#pushT) return;
		this.#pushT = setTimeout(() => {
			this.#pushT = null;
			if (gen !== this.#gen) return;
			const out = new OffscreenCanvas(win.w, win.h), oc = out.getContext("2d")!;
			for (const { c, alpha } of this.#cvs) { oc.globalAlpha = alpha; oc.drawImage(c, 0, 0); }
			this.#map?.setMeshImagery?.(this.id, { bitmap: out.transferToImageBitmap(), west: win.west, south: win.south, east: win.east, north: win.north });
		}, PUSH_MS);
	}
}
