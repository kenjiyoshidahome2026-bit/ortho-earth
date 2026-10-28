// CloudCollection on the globe (順 5・2026-10-28).
//   Cesium's CloudCollection and CumulusCloud objects stay the source of truth (add, remove, and every cloud's position, scale, maximumSize,
//   slice, brightness, color and show). The facade packs them into typed arrays and sends them to the globe's "sprites" overlay, which draws
//   each cloud with Cesium's own cloud shader (packages/globe/src/gadgets/cesium-clouds-glsl.ts) and makes the collection's noise texture once
//   for its noiseDetail / noiseOffset. A collection is sent again only when something in it changed.
import * as engine from "@cesium/engine";
import type { Host } from "./scene.ts";

type Any = any;
const { CloudCollection } = engine as Any;

export const isCloudCollection = (p: Any) => !!CloudCollection && p instanceof CloudCollection;

export interface PackedClouds { n: number; origin: number[]; pos: Float32Array; scale: Float32Array; maxSize: Float32Array; slice: Float32Array; bright: Float32Array; rgba: Uint8Array; noise: { detail: number; offset: number[] } }

const c255 = (v: unknown) => Math.max(0, Math.min(255, Math.round((Number.isFinite(v as number) ? (v as number) : 1) * 255)));

/** a collection's shown clouds → the overlay's arrays (ECEF relative to the first cloud) */
export function packClouds(cc: Any): PackedClouds {
	const all: Any[] = (cc._clouds ?? []).filter((c: Any) => c && c.show !== false && c.position);
	const n = all.length;
	const pos = new Float32Array(n * 3), scale = new Float32Array(n * 2), maxSize = new Float32Array(n * 3), slice = new Float32Array(n), bright = new Float32Array(n), rgba = new Uint8Array(n * 4);
	const o = n ? [all[0].position.x, all[0].position.y, all[0].position.z] : [0, 0, 0];
	all.forEach((c, i) => {
		const p = c.position, s = c.scale, m = c.maximumSize, col = c.color;
		pos[i * 3] = p.x - o[0]; pos[i * 3 + 1] = p.y - o[1]; pos[i * 3 + 2] = p.z - o[2];
		scale[i * 2] = s?.x ?? 20; scale[i * 2 + 1] = s?.y ?? 12;
		maxSize[i * 3] = m?.x ?? 0; maxSize[i * 3 + 1] = m?.y ?? 0; maxSize[i * 3 + 2] = m?.z ?? 0;
		slice[i] = Number.isFinite(c.slice) ? c.slice : -1;
		bright[i] = Number.isFinite(c.brightness) ? c.brightness : 1;
		rgba[i * 4] = c255(col?.red); rgba[i * 4 + 1] = c255(col?.green); rgba[i * 4 + 2] = c255(col?.blue); rgba[i * 4 + 3] = c255(col?.alpha);
	});
	const off = cc.noiseOffset;
	return { n, origin: o, pos, scale, maxSize, slice, bright, rgba, noise: { detail: Number.isFinite(cc.noiseDetail) ? cc.noiseDetail : 16, offset: [off?.x ?? 0, off?.y ?? 0, off?.z ?? 0] } };
}

/** what a collection looks like now (sent again only when this changes) */
function keyOf(pk: PackedClouds): string {
	let h = `${pk.n}|${pk.origin.join(",")}|${pk.noise.detail}|${pk.noise.offset.join(",")}`;
	for (const a of [pk.pos, pk.scale, pk.maxSize, pk.slice, pk.bright, pk.rgba] as ArrayLike<number>[]) { let x = 0; for (let i = 0; i < a.length; i++) x = (x * 31 + Math.round(a[i] * 1000)) | 0; h += `|${x}`; }
	return h;
}

interface Rec { q: string; key: string; shown: boolean }

/** draws the scene's CloudCollections */
export class CloudDrawer {
	readonly host: Host;
	#cols = new Map<Any, Rec>(); #ov: Any = null; #seq = 0;
	constructor(host: Host) { this.host = host; }
	add(cc: Any) { if (!this.#cols.has(cc)) this.#cols.set(cc, { q: `cc${++this.#seq}`, key: "", shown: false }); }
	remove(cc: Any) {
		const r = this.#cols.get(cc);
		if (!r) return;
		this.#cols.delete(cc);
		this.#ov?.post({ type: "remove", q: r.q });
	}
	/** per frame (scene.preRender): send the collections that changed */
	update() {
		const map = this.host.map;
		if (!map || !this.#cols.size) return;
		this.#ov ??= map.overlay({ builtin: "sprites" }, { name: "cesium-clouds", opts: { depth: true } });
		for (const [cc, r] of [...this.#cols]) {
			if (cc.isDestroyed?.()) { this.remove(cc); continue; }
			if (cc.show === false) { if (r.shown) { r.shown = false; this.#ov.post({ type: "vis", q: r.q, on: false }); } continue; }
			if (!r.shown) { r.shown = true; this.#ov.post({ type: "vis", q: r.q, on: true }); }
			const pk = packClouds(cc), key = keyOf(pk);
			if (key === r.key) continue;
			r.key = key;
			this.#ov.post({ type: "clouds", q: r.q, ...pk }, [pk.pos.buffer, pk.scale.buffer, pk.maxSize.buffer, pk.slice.buffer, pk.bright.buffer, pk.rgba.buffer]);
		}
	}
	destroy() { this.#cols.clear(); this.#ov?.remove?.(); this.#ov = null; }
}
