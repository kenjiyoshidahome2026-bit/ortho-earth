// VoxelPrimitive on the globe: the provider's tiles (procedural providers, Cesium3DTilesVoxelProvider) are read with Cesium's own
// requestData, put together into one grid at the finest level that fits (a child tile overwrites its parent; a missing one leaves the
// parent's cells), and handed to @ortho-earth/voxel as map.addData(VoxelData, { kind: "voxel" }). BOX → a box transform, ELLIPSOID → a
// lon/lat/height region; CYLINDER is reported. The custom shader is not run: a shader that reads fsInput.metadata.<name> draws that field
// (RGBA fields as their colour), anything else (the default shader included) draws white cells. nearestSampling → blocks, else volume.
// scene.pickVoxel answers with the last hit near that position (the hit itself is found asynchronously).
import { Cartesian3, Matrix4, Math as CesiumMath } from "@cesium/core";
import * as engine from "@cesium/engine";
import { unsupported } from "./report.ts";
import type { Host } from "./scene.ts";

type Any = any;
const { VoxelPrimitive, MetadataType } = engine as Any;
const MAX_CELLS = 1 << 21;   // 128³

export const isVoxelPrimitive = (p: Any) => !!VoxelPrimitive && p instanceof VoxelPrimitive;

interface Grid { dims: [number, number, number]; comps: 1 | 4; values: Float32Array; field: string }

/** the grid of a provider at the finest level that fits in MAX_CELLS */
export async function gridOf(p: Any, ctx?: Any): Promise<Grid | null> {
	const pr = p.provider, d = pr.dimensions, pb = pr.paddingBefore ?? Cartesian3.ZERO, pa = pr.paddingAfter ?? Cartesian3.ZERO;
	const yUp = pr.metadataOrder === 1 && p.shape === "BOX";
	const levels = Math.max(1, pr.availableLevels ?? 1);
	let L = levels - 1;
	while (L > 0 && d.x * d.y * d.z * 8 ** L > MAX_CELLS) L--;
	const n = 2 ** L, D: [number, number, number] = [d.x * n, d.y * n, d.z * n];
	const type = pr.types?.[0], tc = MetadataType?.getComponentCount?.(type) ?? 1;
	const comps: 1 | 4 = tc >= 3 ? 4 : 1;
	const values = new Float32Array(D[0] * D[1] * D[2] * comps);   // 0 = empty (RGBA α 0)
	const P = [d.x + pb.x + pa.x, d.y + pb.y + pa.y, d.z + pb.z + pa.z];   // padded tile dims (shape axes)
	// shape cell (x, y, z) of the padded tile → index in the stored array (glTF y-up tiles store (x, z, flipped y))
	const srcIdx = (x: number, y: number, z: number) => yUp ? x + P[0] * (z + P[2] * (P[1] - 1 - y)) : x + P[0] * (y + P[1] * z);
	let painted = 0;
	const paint = async (lv: number, tx: number, ty: number, tz: number): Promise<void> => {
		let c: Any;
		try { c = await pr.requestData({ tileLevel: lv, tileX: tx, tileY: ty, tileZ: tz, keyframe: 0 }); } catch { return; }
		if (!c) return;
		if (c._loader && !c._ready) {   // glTF content: Cesium's loader needs a frame state to finish
			const fs = { afterRender: [] as Any[], context: ctx, mode: 3 };
			for (let i = 0; i < 600 && !c._ready; i++) { try { c.update(p, fs); } catch (e) { console.warn("[csshim] voxel tile", e); return; } if (!c._ready) await new Promise(r => setTimeout(r, 5)); }
		}
		const a = c.metadata?.[0];
		if (!a) return;
		const s = 2 ** (L - lv);
		for (let z = 0; z < d.z; z++) for (let y = 0; y < d.y; y++) for (let x = 0; x < d.x; x++) {
			const si = srcIdx(x + pb.x, y + pb.y, z + pb.z) * tc;
			const v0 = a[si], v1 = tc > 1 ? a[si + 1] : v0, v2 = tc > 2 ? a[si + 2] : v0, v3 = tc > 3 ? a[si + 3] : 1;
			const X = (tx * d.x + x) * s, Y = (ty * d.y + y) * s, Z = (tz * d.z + z) * s;
			for (let k = 0; k < s; k++) for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
				const o = (X + i) + D[0] * ((Y + j) + D[1] * (Z + k));
				if (comps === 1) values[o] = v0;
				else { values[o * 4] = v0; values[o * 4 + 1] = v1; values[o * 4 + 2] = v2; values[o * 4 + 3] = v3; }
			}
		}
		painted++;
		if (lv < L) { const k: Promise<void>[] = []; for (let q = 0; q < 8; q++) k.push(paint(lv + 1, 2 * tx + (q & 1), 2 * ty + ((q >> 1) & 1), 2 * tz + (q >> 2))); await Promise.all(k); }
	};
	await paint(0, 0, 0, 0);
	return painted ? { dims: D, comps, values, field: String(pr.names?.[0] ?? "") } : null;
}

/** box local [min, max] → ECEF, as the column-major transform of the unit cube */
const compoundOf = (p: Any) => {
	const pr = p.provider, C = Matrix4.multiplyTransformation(pr.globalTransform ?? Matrix4.IDENTITY, p.modelMatrix ?? Matrix4.IDENTITY, new Matrix4());
	return Matrix4.multiplyTransformation(C, pr.shapeTransform ?? Matrix4.IDENTITY, C);
};
/** the VoxelData placement of the primitive (null: a shape the globe does not draw) */
export function placementOf(p: Any): Record<string, unknown> | null {
	const mn = p.minBounds, mx = p.maxBounds, C = compoundOf(p);
	if (p.shape === "BOX") {
		const T = Matrix4.multiplyByTranslation(C, new Cartesian3(mn.x, mn.y, mn.z), new Matrix4());
		Matrix4.multiplyByScale(T, new Cartesian3(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z), T);
		return { shape: "box", box: { transform: Matrix4.toArray(T) } };
	}
	if (p.shape === "ELLIPSOID") {
		const t = Matrix4.getTranslation(C, new Cartesian3());
		if (Cartesian3.magnitude(t) > 1) unsupported("VoxelPrimitive ellipsoid off the earth's centre (drawn at it)");
		const deg = CesiumMath.toDegrees;
		return { shape: "region", region: [deg(mn.x), deg(mn.y), deg(mx.x), deg(mx.y), mn.z, mx.z] };
	}
	unsupported(`VoxelPrimitive shape ${p.shape}`);
	return null;
}

/** what the custom shader draws (it is not run): the field it reads, or white */
const drawsField = (p: Any, field: string) => {
	const t = String(p.customShader?.fragmentShaderText ?? "");
	return !!field && t.includes(`metadata.${field}`) && p.customShader !== VoxelPrimitive?.DefaultCustomShader;
};

interface Rec { h?: Any; key: string; gen: number; last?: { x: number; y: number; cell: Any } }

/** draws the scene's voxel primitives */
export class VoxelDrawer {
	#host: Host; #ctx: Any; #recs = new Map<Any, Rec>(); #plugin: Promise<void> | null = null;
	constructor(host: Host, context?: Any) { this.#host = host; this.#ctx = context; }
	add(p: Any) { if (!this.#recs.has(p)) { this.#recs.set(p, { key: "", gen: 0 }); } }
	remove(p: Any) { const r = this.#recs.get(p); if (r) { r.gen++; r.h?.remove?.(); this.#recs.delete(p); } }
	#ensurePlugin(map: Any) {
		return this.#plugin ??= (async () => {
			if (map.registry?.dataKinds?.get?.("voxel") !== undefined) return;
			const { voxelPlugin } = await import("@ortho-earth/voxel");
			if (map.registry?.dataKinds?.get?.("voxel") === undefined) map.use(voxelPlugin());
		})();
	}
	/** per frame: build what is new, follow show / nearestSampling */
	update() {
		const map = this.#host.map;
		if (!map) return;
		for (const [p, r] of this.#recs) {
			if (p.isDestroyed?.()) { this.remove(p); continue; }
			const key = `${p.nearestSampling ? "blocks" : "volume"}`;
			if (r.h) { r.h.setVisible(p.show !== false); if (r.key !== key) { r.key = key; r.h.setProps({ render: key }); } continue; }
			if (r.key) continue;   // building
			r.key = key;
			const gen = r.gen;
			this.#build(map, p, key).then(h => { if (!h) return; if (r.gen !== gen || !this.#recs.has(p)) { h.remove(); return; } r.h = h; p._ready = true; })
				.catch((e: unknown) => console.warn("[csshim] VoxelPrimitive", e));
		}
	}
	async #build(map: Any, p: Any, render: string) {
		const place = placementOf(p);
		if (!place) return null;
		const g = await gridOf(p, this.#ctx);
		if (!g) { unsupported("VoxelPrimitive provider without tiles"); return null; }
		let { values } = g;
		const field = drawsField(p, g.field);
		if (!field) {   // the default shader (and shaders we cannot read): white cells where the grid has any
			const w = new Float32Array(g.dims[0] * g.dims[1] * g.dims[2] * 4);
			for (let i = 0, n = w.length / 4; i < n; i++) { const on = g.comps === 4 ? values[i * 4 + 3] > 0 || values[i * 4] || values[i * 4 + 1] || values[i * 4 + 2] : true; if (on) w.fill(1, i * 4, i * 4 + 4); }
			values = w;
		} else if (g.comps === 1) unsupported("VoxelPrimitive scalar field in a custom shader (drawn with a colormap)");
		await this.#ensurePlugin(map);
		const comps = values.length === g.dims[0] * g.dims[1] * g.dims[2] ? 1 : 4;
		const h = map.addData({ ...place, dims: g.dims, components: comps, values }, { kind: "voxel", render, colormap: "grey", altitude: "absolute", properties: { field: g.field }, lighting: !(field && g.comps === 4) });   // a VEC4 colour field is drawn unlit (buildVoxelCustomShader's colour shader); the default and the colormap shaders shade by the light
		await h.ready;
		h.__values = g.comps === 4 ? g.values : null;   // the provider's values, for VoxelCell.getProperty
		return h;
	}
	/** scene.pickVoxel: a VoxelCell-like answer from the last hit near (x, y) */
	pickVoxel(x: number, y: number): Any {
		for (const [p, r] of this.#recs) {
			if (!r.h) continue;
			const near = r.last && Math.hypot(r.last.x - x, r.last.y - y) < 4 ? r.last.cell : undefined;
			r.h.pick(x, y).then((hits: Any[]) => { const hit = hits?.[0]; r.last = { x, y, cell: hit ? cellOf(p, r.h, hit) : undefined }; }).catch(() => {});
			if (near) return near;
		}
		return undefined;
	}
	destroy() { for (const p of [...this.#recs.keys()]) this.remove(p); }
}

/** the hit as Cesium's VoxelCell (tileIndex / sampleIndex are the cell's index in the whole grid) */
function cellOf(p: Any, h: Any, hit: Any) {
	const [i, j, k] = hit.cell, [nx, ny, nz] = h.dims ?? [1, 1, 1];
	const vals = h.__values as Float32Array | undefined;
	const center = Cartesian3.fromDegrees(hit.lngLat[0], hit.lngLat[1], 0);
	const name = String(p.provider?.names?.[0] ?? "");
	return {
		primitive: p, tileIndex: 0, sampleIndex: i + nx * (j + ny * k), orientedBoundingBox: { center, halfAxes: undefined },
		getNames: () => [name], hasProperty: (n: string) => n === name,
		getProperty: (n: string) => n !== name ? undefined : vals ? Array.from(vals.subarray(hit.index * 4, hit.index * 4 + 4)) : hit.value,
		__cell: [i, j, k], __dims: [nx, ny, nz],
	};
}
