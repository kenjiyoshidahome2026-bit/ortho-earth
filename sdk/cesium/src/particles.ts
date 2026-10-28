// ParticleSystem on the globe (順 5・2026-10-28).
//   Cesium's own ParticleSystem runs unchanged (emitters, bursts, updateCallback, life, colours and scales): each frame the facade calls its
//   update with a frame state at the viewer clock's time, so the particles move only while the clock animates, as in Cesium. The billboards it
//   would hand to a BillboardCollection (WebGL) go to a stand-in that just keeps them; their positions, colours and sizes are packed into
//   typed arrays and sent to the globe's "sprites" overlay (packages/globe/src/gadgets/sprites-gl.ts): one layer per system, its image
//   uploaded once, hidden behind terrain, buildings and models by the scene depth.
import * as engine from "@cesium/engine";
import type { Host } from "./scene.ts";

type Any = any;
const { ParticleSystem } = engine as Any;

export const isParticleSystem = (p: Any) => !!ParticleSystem && p instanceof ParticleSystem;

/** a BillboardCollection stand-in: Cesium's ParticleSystem adds, shows/hides and removes its billboards here; nothing is drawn by Cesium */
function billboardKeeper() {
	const items = new Set<Any>();
	return {
		items,
		add(o: Any = {}) { const b = { show: true, ...o }; items.add(b); return b; },
		remove(b: Any) { return items.delete(b); },
		removeAll() { items.clear(); },
		update() { /* drawn by the globe */ },
		isDestroyed() { return false; },
		destroy() { items.clear(); return undefined; },
		get length() { return items.size; },
	};
}

/** the particles of one system → the overlay's layer (ECEF relative to the first particle, colours 0..255, size w,h scaled) */
export function packParticles(ps: Any): { n: number; origin: number[]; pos: Float32Array; rgba: Uint8Array; size: Float32Array; meters: boolean } | null {
	const parts: Any[] = ps._particles ?? [];
	let n = 0;
	for (const p of parts) if (p._billboard?.show !== false && p._billboard?.position) n++;
	if (!n) return null;
	const pos = new Float32Array(n * 3), rgba = new Uint8Array(n * 4), size = new Float32Array(n * 2);
	let origin: number[] | null = null, k = 0;
	const c255 = (v: unknown) => Math.max(0, Math.min(255, Math.round((Number.isFinite(v as number) ? (v as number) : 1) * 255)));
	for (const p of parts) {
		const b = p._billboard;
		if (!b || b.show === false || !b.position) continue;
		const q = b.position;
		origin ??= [q.x, q.y, q.z];
		pos[k * 3] = q.x - origin[0]; pos[k * 3 + 1] = q.y - origin[1]; pos[k * 3 + 2] = q.z - origin[2];
		const c = b.color;
		rgba[k * 4] = c255(c?.red); rgba[k * 4 + 1] = c255(c?.green); rgba[k * 4 + 2] = c255(c?.blue); rgba[k * 4 + 3] = c255(c?.alpha);
		const s = Number.isFinite(b.scale) ? b.scale : 1;
		size[k * 2] = (b.width ?? 1) * s; size[k * 2 + 1] = (b.height ?? 1) * s;
		k++;
	}
	return { n, origin: origin!, pos, rgba, size, meters: !!ps.sizeInMeters };
}

/** an image a ParticleSystem was given (url, Resource, canvas, image, bitmap) → an ImageBitmap */
async function bitmapOf(img: Any): Promise<ImageBitmap | null> {
	if (!img) return null;
	if (typeof img === "function") return bitmapOf(img());
	if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return createImageBitmap(img);
	if (typeof img === "string" || typeof img.url === "string" || typeof img.getUrlComponent === "function") {
		const url = typeof img === "string" ? img : img.url ?? img.getUrlComponent(true);
		const r = await fetch(new URL(url, location.href).href);
		if (!r.ok) throw new Error(`${r.status} ${url}`);
		return createImageBitmap(await r.blob());
	}
	if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement && !img.complete) await img.decode().catch(() => undefined);
	return createImageBitmap(img);
}

interface Rec { q: string; img: Any; imgSent: boolean; shown: boolean }

/** draws the scene's ParticleSystems */
export class ParticleDrawer {
	readonly host: Host;
	#systems = new Map<Any, Rec>(); #ov: Any = null; #seq = 0; #frame = 0; #busy = 0;
	constructor(host: Host) { this.host = host; }
	add(ps: Any) {
		if (this.#systems.has(ps)) return;
		this.#systems.set(ps, { q: `ps${++this.#seq}`, img: undefined, imgSent: false, shown: false });
	}
	remove(ps: Any) {
		const r = this.#systems.get(ps);
		if (!r) return;
		this.#systems.delete(ps);
		this.#ov?.post({ type: "remove", q: r.q });
	}
	/** per frame (scene.preRender): step each system at the clock's time and send its particles */
	update(time: Any) {
		const map = this.host.map;
		if (!map || !this.#systems.size || !time) return;
		if (!this.#ov) {
			this.#ov = map.overlay({ builtin: "sprites" }, { name: "cesium-particles", opts: { depth: true } });
			this.#ov.onmessage = (d: Any) => { if (d?.type === "drawn") this.#busy = 0; };
		}
		// the overlay answers "drawn" after drawing what it was sent: until then (a slow GPU) the systems keep stepping but nothing new is sent
		const now = performance.now(), send = !this.#busy || now - this.#busy > 1000;
		const fs = { time, frameNumber: ++this.#frame };
		for (const [ps, r] of [...this.#systems]) {
			if (ps.isDestroyed?.()) { this.remove(ps); continue; }
			if (!ps._billboardCollection || !ps._billboardCollection.items) ps._billboardCollection = billboardKeeper();
			if (ps.show === false) { if (r.shown) { r.shown = false; this.#ov.post({ type: "vis", q: r.q, on: false }); } continue; }
			try { ps.update(fs); } catch (e) { console.warn("[csshim] particle system", e); this.remove(ps); continue; }
			if (r.img !== ps.image) {   // the image changed (or is new): load it once and send it
				r.img = ps.image; r.imgSent = false;
				const q = r.q, want = ps.image;
				bitmapOf(want).then(bmp => {
					if (this.#systems.get(ps) !== r || r.img !== want) { bmp?.close(); return; }
					r.imgSent = true;
					this.#ov?.post({ type: "image", q, image: bmp }, bmp ? [bmp] : []);
				}, err => console.warn("[csshim] particle image", err));
			}
			if (!send) continue;
			const pk = packParticles(ps);
			if (!r.shown) { r.shown = true; this.#ov.post({ type: "vis", q: r.q, on: true }); }
			if (!pk) { this.#ov.post({ type: "layer", q: r.q, n: 0, origin: [0, 0, 0], pos: new Float32Array(0), rgba: new Uint8Array(0), size: new Float32Array(0) }); continue; }
			this.#ov.post({ type: "layer", q: r.q, ...pk }, [pk.pos.buffer, pk.rgba.buffer, pk.size.buffer]);
		}
		if (send) this.#busy = now;
	}
	destroy() { this.#systems.clear(); this.#ov?.remove?.(); this.#ov = null; }
}
