// scene.primitives.add(new Primitive({ geometryInstances, appearance })) on the globe.
// Cesium's own geometry code makes the triangles (XGeometry.createGeometry: rectangles, polygons, ellipses, boxes, cylinders, walls,
// corridors, ellipsoids…). The triangles go to the globe as a glTF model built here (CESIUM_RTC = ECEF, COLOR_0 = the instance colour,
// _BATCHID = the instance), so picking (scene.pick → { primitive, id }) and getGeometryInstanceAttributes(id).color use the model's
// features. Line geometries (outlines, SimplePolylineGeometry, PolylineGeometry, GroundPolylineGeometry) go to the entity overlay's 3D lines.
// Stripe, Checkerboard, Grid and Image materials are painted into a texture over the geometry's st (materials.ts); other materials draw in
// their colour (else white). Not drawn: per-vertex polyline colours (the first one is used).
import { ArcType, BoundingSphere, Cartesian3, Color, Ellipsoid, Event, GeometryInstance, Matrix3, Matrix4, PolylineGeometry, PolylinePipeline, Quaternion } from "@cesium/core";
import * as engine from "@cesium/engine";
import { unsupported } from "./report.ts";
import { enuRotOf, headingOf } from "./display.ts";
import { gltfNodeNames, gltfSphere } from "./gltf.ts";
import { ownArrays } from "./spheres.ts";
import { matKey, matOfMaterial, matTranslucent, paintSquare } from "./materials.ts";
import type { MatDesc } from "./materials.ts";
import type { Host } from "./scene.ts";

type Any = any;
const { Primitive, GroundPrimitive, GroundPolylinePrimitive, ClassificationPrimitive, Model } = engine as Any;
const TRIANGLES = 4, LINES = 1;

export interface PrimLine { p: number[]; color: string; width: number }
interface Item {
	p: Any; key: string; built: boolean; h: Any; loading: boolean; dead: boolean;
	lines: PrimLine[]; ids: Any[]; colors: Uint8Array[]; shows: boolean[];
	/** each instance's world bounding sphere (getGeometryInstanceAttributes(id).boundingSphere, as Primitive gives once built → camera.viewBoundingSphere) */
	spheres: Array<BoundingSphere | undefined>;
	/** a Model's activeAnimations (addAll / add): what to play, at what multiplier; null = stopped */
	anim?: { name?: string; speed: number } | null;
}

/** a primitive this module draws */
/** DebugModelMatrixPrimitive: the x (red), y (green) and z (blue) axes of its model matrix, length × the unit vectors, as the Primitive it builds */
export const isDebugAxes = (p: Any) => !!(engine as Any).DebugModelMatrixPrimitive && p instanceof (engine as Any).DebugModelMatrixPrimitive;
export function debugAxesPrimitive(p: Any): Any {
	const M = Matrix4.multiplyByUniformScale(p.modelMatrix ?? Matrix4.IDENTITY, p.length ?? 10000000, new Matrix4());
	const axis = (to: Cartesian3, c: Color) => new GeometryInstance({ geometry: new PolylineGeometry({ positions: [Cartesian3.ZERO, to], width: p.width ?? 2, colors: [c, c], arcType: ArcType.NONE }), modelMatrix: M, id: p.id });
	return new Primitive({ geometryInstances: [axis(Cartesian3.UNIT_X, Color.RED), axis(Cartesian3.UNIT_Y, Color.GREEN), axis(Cartesian3.UNIT_Z, Color.BLUE)], appearance: { material: undefined }, asynchronous: false, show: p.show !== false });
}
export const isGeometryPrimitive = (p: Any) => !!p && [Primitive, GroundPrimitive, GroundPolylinePrimitive, ClassificationPrimitive, Model].some(C => C && p instanceof C);

const instancesOf = (p: Any): Any[] => { const g = p.geometryInstances; return g == null ? [] : Array.isArray(g) ? g : [g]; };
const toBytes = (c: Color) => Uint8Array.of(Math.round(c.red * 255), Math.round(c.green * 255), Math.round(c.blue * 255), Math.round(c.alpha * 255));
const css = (b: Uint8Array) => `rgba(${b[0]},${b[1]},${b[2]},${(b[3] / 255).toFixed(3)})`;

/** the colour an instance is drawn in: its colour attribute, else the appearance's material colour, else white */
function colorOf(inst: Any, appearance: Any): Uint8Array {
	const c = inst.attributes?.color?.value;
	if (c && c.length >= 4) return Uint8Array.from(c);
	const m = appearance?.material, u = m?.uniforms;
	if (matOfMaterial(m)) return Uint8Array.of(255, 255, 255, 255);   // painted into a texture (the texture carries the colours)
	const main = u?.color ?? u?.evenColor ?? u?.lightColor ?? u?.baseWaterColor;   // Color, Water: their first colour
	if (main instanceof Color) {
		if (m.type && m.type !== "Color") unsupported(`material ${m.type} (drawn in its colour)`);
		return toBytes(main);
	}
	if (m?.type) unsupported(`material ${m.type} (drawn white)`);
	return Uint8Array.of(255, 255, 255, 255);
}
const shownOf = (inst: Any) => { const s = inst.attributes?.show?.value; return !s || !!s[0]; };

// ── a glTF (glb) of triangles in ECEF ──
/** triangles: idx is drawn in its vertex colours; parts (with uv) each with a texture (an image URL, data: or http) multiplied in */
export interface Tris { pos: number[]; nrm: number[] | null; col: number[]; bid: number[]; idx: number[]; uv?: number[]; parts?: Array<{ idx: number[]; tex: string; blend: boolean }> }
export function glbOf(t: Tris): { glb: Uint8Array; blend: boolean } {
	const n = t.pos.length / 3;
	let cx = 0, cy = 0, cz = 0;
	for (let i = 0; i < n; i++) { cx += t.pos[i * 3]; cy += t.pos[i * 3 + 1]; cz += t.pos[i * 3 + 2]; }
	cx /= n; cy /= n; cz /= n;
	// CESIUM_RTC: glTF is y-up, so ECEF (X, Y, Z) relative to the centre is stored as (X, Z, -Y)
	const P = new Float32Array(n * 3), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < n; i++) {
		const x = t.pos[i * 3] - cx, y = t.pos[i * 3 + 1] - cy, z = t.pos[i * 3 + 2] - cz, v = [x, z, -y];
		for (let k = 0; k < 3; k++) { P[i * 3 + k] = v[k]; lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
	}
	const N = t.nrm ? new Float32Array(n * 3) : null;
	if (N && t.nrm) for (let i = 0; i < n; i++) { N[i * 3] = t.nrm[i * 3]; N[i * 3 + 1] = t.nrm[i * 3 + 2]; N[i * 3 + 2] = -t.nrm[i * 3 + 1]; }
	const C = Uint8Array.from(t.col), B = Float32Array.from(t.bid), tparts = (t.parts ?? []).filter(q => q.idx.length), UV = tparts.length && t.uv ? Float32Array.from(t.uv) : null;
	let blend = false;
	for (let i = 3; i < C.length; i += 4) if (C[i] < 255) { blend = true; break; }
	const groups = [...(t.idx.length ? [{ idx: t.idx, tex: null as string | null, blend }] : []), ...(UV ? tparts.map(q => ({ idx: q.idx, tex: q.tex as string | null, blend: q.blend || blend })) : [])];
	const parts: Array<{ data: ArrayBufferView; target: number }> = [{ data: P, target: 34962 }, { data: C, target: 34962 }, { data: B, target: 34962 }, ...(N ? [{ data: N, target: 34962 }] : []), ...(UV ? [{ data: UV, target: 34962 }] : []),
		...groups.map(g => ({ data: Uint32Array.from(g.idx), target: 34963 }))];
	const views: Any[] = [], chunks: Uint8Array[] = [];
	let off = 0;
	for (const p of parts) {
		const u8 = new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength), pad = (4 - (u8.length % 4)) % 4;
		views.push({ buffer: 0, byteOffset: off, byteLength: u8.length, target: p.target });
		chunks.push(u8, new Uint8Array(pad)); off += u8.length + pad;
	}
	let a = 0;
	const accessors: Any[] = [
		{ bufferView: a++, componentType: 5126, count: n, type: "VEC3", min: lo, max: hi },
		{ bufferView: a++, componentType: 5121, normalized: true, count: n, type: "VEC4" },
		{ bufferView: a++, componentType: 5126, count: n, type: "SCALAR" },
		...(N ? [{ bufferView: a++, componentType: 5126, count: n, type: "VEC3" }] : []),
		...(UV ? [{ bufferView: a++, componentType: 5126, count: n, type: "VEC2" }] : []),
	];
	const attributes: Any = { POSITION: 0, COLOR_0: 1, _BATCHID: 2, ...(N && { NORMAL: 3 }), ...(UV && { TEXCOORD_0: N ? 4 : 3 }) };
	const images: Any[] = [], materials: Any[] = [], prims: Any[] = [];
	for (const g of groups) {
		const ia = accessors.length;
		accessors.push({ bufferView: a++, componentType: 5125, count: g.idx.length, type: "SCALAR" });
		const pbr: Any = { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 };
		if (g.tex) { pbr.baseColorTexture = { index: images.length }; images.push({ uri: g.tex }); }
		materials.push({ pbrMetallicRoughness: pbr, doubleSided: true, alphaMode: g.blend ? "BLEND" : "OPAQUE" });
		prims.push({ attributes, indices: ia, material: materials.length - 1, mode: TRIANGLES });
		if (g.blend) blend = true;
	}
	const json = {
		asset: { version: "2.0", generator: "@ortho-earth/cesium" }, extensionsUsed: ["CESIUM_RTC"], extensions: { CESIUM_RTC: { center: [cx, cy, cz] } },
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: prims }], materials, accessors, bufferViews: views, buffers: [{ byteLength: off }],
		...(images.length && { images, textures: images.map((_, i) => ({ source: i, sampler: 0 })), samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }] }),
	};
	let js = new TextEncoder().encode(JSON.stringify(json));
	if (js.length % 4) { const q = new Uint8Array(js.length + 4 - (js.length % 4)).fill(0x20); q.set(js); js = q; }
	const glb = new Uint8Array(12 + 8 + js.length + 8 + off), dv = new DataView(glb.buffer);
	dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true);
	dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true); glb.set(js, 20);
	let o = 20 + js.length;
	dv.setUint32(o, off, true); dv.setUint32(o + 4, 0x004e4942, true); o += 8;
	for (const c of chunks) { glb.set(c, o); o += c.length; }
	return { glb, blend };
}

const v3 = new Cartesian3(), n3 = new Cartesian3(), m3 = new Matrix3();
const { GroundPolylineGeometry } = engine as Any;
const lineGeometry = (g: Any) => !!g && (g instanceof PolylineGeometry || (GroundPolylineGeometry && g instanceof GroundPolylineGeometry));

let SEQ = 0;   // the globe's model slots: one count for every drawer (the scene's and the entity display's)
/** draws the scene's geometry primitives on the globe */
export class PrimitiveDrawer {
	readonly host: Host;
	#items = new Map<Any, Item>();
	/** 3D lines for the entity overlay (EntityDisplay adds them to its own) */
	lines: PrimLine[] = [];
	/** the scene (the camera for minimumPixelSize) */
	scene: Any = null;
	constructor(host: Host) { this.host = host; }
	/** the globe's model handles of the primitives (primitive → ModelHandle | null while loading or with no triangles) */
	get orthoModels() { return new Map([...this.#items].map(([p, it]) => [p, it.h])); }
	add(p: Any) {
		if (this.#items.has(p)) return;
		const it: Item = { p, key: `cesium-prim:${++SEQ}`, built: false, h: null, loading: false, dead: false, lines: [], ids: [], colors: [], shows: [], spheres: [] };
		this.#items.set(p, it);
		this.#instrument(it);
	}
	remove(p: Any) {
		const it = this.#items.get(p);
		if (!it) return;
		it.dead = true; it.h?.clear?.(); this.#items.delete(p); this.#collectLines();
	}
	/** per frame: build what is new, follow show / modelMatrix */
	update() {
		const map = this.host.map;
		if (!map) return;
		let linesChanged = false;
		for (const it of this.#items.values()) {
			const p = it.p;
			if (p.isDestroyed?.()) { this.remove(p); continue; }
			const show = p.show !== false;
			if ((it as Any).shown !== show) { (it as Any).shown = show; linesChanged = true; }
			if (!show) { if (it.h) { it.h.clear(); it.h = null; it.built = false; } continue; }   // hidden: off the globe, built again when shown
			const isModel = Model && p instanceof Model, pl = isModel ? this.#placeOf(p) : null;
			const mk = Matrix4.toArray(p.modelMatrix ?? Matrix4.IDENTITY).join(",") + (pl ? `|${pl.scale.toPrecision(3)}` : "");
			if (isModel && it.h) this.#syncAnim(it);
			if (isModel) { if (!it.built) { it.built = true; (it as Any).mk = mk; this.#loadModel(map, it); } else if ((it as Any).mk !== mk && it.h) { (it as Any).mk = mk; if (pl) it.h.setTransform({ at: pl.at, altitude: pl.altitude, heading: pl.heading, rot: pl.rot, scale: pl.scale }); } continue; }
			if (!it.built || (it as Any).mk !== mk) { (it as Any).mk = mk; this.#build(map, it); linesChanged = true; }
		}
		if (linesChanged) this.#collectLines();
	}
	/** the instance under a screen point: { primitive, id } */
	pick(x: number, y: number): Any {
		let best: Any = null, bd = Infinity;
		for (const it of this.#items.values()) {
			if (!it.h || it.p.show === false) continue;
			const hit = it.h.pick?.(x, y);
			if (hit && hit.featureId != null && hit.distance < bd) { bd = hit.distance; best = { primitive: it.p, id: it.ids[hit.featureId] }; }
		}
		return best ?? undefined;
	}
	destroy() { for (const it of this.#items.values()) { it.dead = true; it.h?.clear?.(); } this.#items.clear(); this.lines = []; }

	#collectLines() {
		const out: PrimLine[] = [];
		for (const it of this.#items.values()) if (it.p.show !== false) for (const l of it.lines) out.push(l);
		this.lines = out;
	}
	/** getGeometryInstanceAttributes(id): colour and show the instance's feature follows */
	#instrument(it: Item) {
		it.p.getGeometryInstanceAttributes = function (id: Any) {
			const i = it.ids.indexOf(id);
			if (i < 0) return undefined;
			return {
				get color() { return it.colors[i]; },
				set color(v: Any) { it.colors[i] = Uint8Array.from(v); it.h?.setFeatureState?.(i, { color: css(it.colors[i]) }); },
				get show() { return Uint8Array.of(it.shows[i] ? 1 : 0); },
				set show(v: Any) { it.shows[i] = !!v?.[0]; it.built = false; },   // rebuilt without it
				get depthFailColor() { return undefined; }, set depthFailColor(_v: Any) { /* none */ },
				get distanceDisplayCondition() { return undefined; }, set distanceDisplayCondition(_v: Any) { unsupported("instance distanceDisplayCondition"); },
				get offset() { return undefined; }, set offset(_v: Any) { unsupported("instance offset"); },
				get boundingSphere() { return it.spheres[i]; },
			};
		};
	}
	#build(map: Any, it: Item) {
		const p = it.p, M = p.modelMatrix ?? Matrix4.IDENTITY, insts = instancesOf(p);
		const firstBuild = !it.built;
		it.built = true;
		const tris: Tris = { pos: [], nrm: [], col: [], bid: [], idx: [], uv: [] };
		const lines: PrimLine[] = [], painted = new Map<string, { mat: MatDesc; idx: number[] }>(), appMat = matOfMaterial(p.appearance?.material);
		insts.forEach((inst, i) => {
			if (firstBuild) { it.ids[i] = inst.id; it.colors[i] = colorOf(inst, p.appearance); it.shows[i] = shownOf(inst); }
			if (!it.shows[i]) return;
			const g = inst.geometry, col = it.colors[i];
			const W = Matrix4.multiply(M, inst.modelMatrix ?? Matrix4.IDENTITY, new Matrix4());
			if (lineGeometry(g)) {   // wide polylines: the input positions, not the screen-space triangles
				const width = g._width ?? g.width ?? 1, moved = !Matrix4.equals(W, Matrix4.IDENTITY);
				const ps: Cartesian3[] = moved ? g._positions.map((q: Cartesian3) => Matrix4.multiplyByPoint(W, q, new Cartesian3())) : g._positions;
				const pc = g._colors?.[0] ? toBytes(g._colors[0]) : col;
				let pts: number[] = [];
				if (g._arcType === ArcType.NONE) pts = ps.flatMap(q => [q.x, q.y, q.z]);   // straight in space (DebugModelMatrixPrimitive's axes)
				else try { pts = Array.from(PolylinePipeline.generateArc({ positions: ps, height: (PolylinePipeline as Any).extractHeights(ps, Ellipsoid.WGS84), granularity: 0.01, ellipsoid: Ellipsoid.WGS84 })); } catch { pts = ps.flatMap(q => [q.x, q.y, q.z]); }
				lines.push({ p: pts, color: css(pc), width });
				return;
			}
			let geom: Any = g;
			if (g && !g.attributes) {
				const C = g.constructor;
				try { geom = C?.createGeometry?.(ownArrays(g)); } catch (e) { console.warn("[csshim] createGeometry", C?.name, e); geom = undefined; }
				if (!geom) { if (!C?.createGeometry) unsupported(`geometry ${C?.name ?? typeof g}`); return; }
			}
			const pv = geom.attributes?.position?.values;
			if (!pv) return;
			const nv = geom.attributes?.normal?.values, nVert = pv.length / 3;
			const idx: ArrayLike<number> = geom.indices ?? Uint32Array.from({ length: nVert }, (_, k) => k);
			const mode = geom.primitiveType ?? TRIANGLES;
			const world: number[] = new Array(nVert * 3);
			for (let k = 0; k < nVert; k++) {
				Cartesian3.fromElements(pv[k * 3], pv[k * 3 + 1], pv[k * 3 + 2], v3);
				Matrix4.multiplyByPoint(W, v3, v3);
				world[k * 3] = v3.x; world[k * 3 + 1] = v3.y; world[k * 3 + 2] = v3.z;
			}
			it.spheres[i] = BoundingSphere.fromVertices(world);
			if (mode === LINES) {
				const lw = p.appearance?.renderState?.lineWidth ?? 1;
				for (let k = 0; k + 1 < idx.length; k += 2) { const a = idx[k], b = idx[k + 1]; lines.push({ p: [world[a * 3], world[a * 3 + 1], world[a * 3 + 2], world[b * 3], world[b * 3 + 1], world[b * 3 + 2]], color: css(col), width: lw }); }
				return;
			}
			if (mode !== TRIANGLES) { unsupported(`primitive type ${mode}`); return; }
			const base = tris.pos.length / 3;
			const mat: MatDesc | null = inst.__mat ?? appMat, st = mat ? geom.attributes?.st?.values : null;
			Matrix4.getMatrix3(W, m3);
			for (let k = 0; k < nVert; k++) {
				tris.pos.push(world[k * 3], world[k * 3 + 1], world[k * 3 + 2]);
				if (nv && tris.nrm) { Cartesian3.fromElements(nv[k * 3], nv[k * 3 + 1], nv[k * 3 + 2], n3); Matrix3.multiplyByVector(m3, n3, n3); Cartesian3.normalize(n3, n3); tris.nrm.push(n3.x, n3.y, n3.z); }
				else tris.nrm = null;
				tris.col.push(col[0], col[1], col[2], col[3]); tris.bid.push(i);
				tris.uv!.push(st ? st[k * 2] : 0, st ? 1 - st[k * 2 + 1] : 0);   // glTF's v runs down the picture
			}
			let into = tris.idx;
			if (mat && st) { const k = matKey(mat); let g = painted.get(k); if (!g) painted.set(k, g = { mat, idx: [] }); into = g.idx; }
			for (let k = 0; k < idx.length; k++) into.push(base + idx[k]);
		});
		it.lines = mergeLines(lines);
		const old = it.h; it.h = null;
		if (!tris.idx.length && !painted.size) { old?.clear?.(); this.#markReady(p); return; }
		if (tris.nrm && tris.nrm.length !== tris.pos.length) tris.nrm = null;
		it.loading = true;
		const gen = (it as Any).gen = ((it as Any).gen ?? 0) + 1;
		void Promise.all([...painted.values()].map(async g => ({ idx: g.idx, tex: (await paintSquare(g.mat))?.toDataURL() ?? null, blend: matTranslucent(g.mat) }))).then(ps => {
			if (it.dead || (it as Any).gen !== gen) return;
			tris.parts = [];
			for (const q of ps) if (q.tex) tris.parts.push({ idx: q.idx, tex: q.tex, blend: q.blend }); else tris.idx.push(...q.idx);   // not painted (an image that did not load): white
			this.#place(map, it, p, tris, old);
		});
	}
	#place(map: Any, it: Item, p: Any, tris: Tris, old: Any) {
		const { glb } = glbOf(tris);
		let minH = Infinity;
		for (let k = 0; k < tris.pos.length; k += 3) { const c = Ellipsoid.WGS84.cartesianToCartographic(Cartesian3.fromElements(tris.pos[k], tris.pos[k + 1], tris.pos[k + 2], v3)); if (c && c.height < minH) minH = c.height; }
		it.loading = true;
		const file = new File([glb as BlobPart], `${it.key}.glb`, { type: "model/gltf-binary" });
		map.gadget.model(file, { slot: it.key, name: it.key, fit: false, gizmo: false, keep2d: true, lighting: "globe", altitude: Number.isFinite(minH) ? minH : 0, lift: false })   // Cesium shades geometry with Phong, not the model lighting: the globe's own light is the nearer look   // the globe grounds a model's lowest point: lift it back to its (ellipsoid) height, absolute = not onto the terrain
			.then((h: Any) => {
				it.loading = false;
				if (it.dead) { h.clear(); return; }
				old?.clear?.();
				it.h = h;
				this.#markReady(p);
			}, (err: unknown) => { it.loading = false; (it as Any).error = String((err as Error)?.message || err); console.warn("[csshim] primitive", err); });
	}
	#markReady(p: Any) { p._ready = true; p._readyEvent?.raiseEvent?.(p); }
	/** a Model's animation ⇄ the clock (Cesium's Model advances its animations by the clock's delta × the animation's multiplier): plays while the
	 *  clock animates and an animation is active, keeping its time; stops otherwise */
	#syncAnim(it: Item) {
		const h = it.h, a = it.anim;
		if (!h?.animations?.length) return;
		const ck = this.host.clock, playing = !!a && (ck ? !!ck.shouldAnimate : true), speed = (a?.speed ?? 1) * (ck && Number.isFinite(ck.multiplier) ? ck.multiplier : 1);
		const cur = h.getAnimation?.();
		if (!playing) { if (cur?.playing) h.stop(); return; }
		if (!cur?.playing || cur.speed !== speed || (a!.name != null && cur.name !== a!.name)) h.play({ ...(cur || {}), ...(a!.name != null ? { name: a!.name } : {}), speed });
	}
	/** placeOf with Cesium's minimumPixelSize (a far model is enlarged to that many pixels across: Model's scaleInPixels) and maximumScale */
	#placeOf(p: Any): ReturnType<typeof placeOf> {
		const pl = placeOf(p), minPx = p.minimumPixelSize ?? 0, r0 = p._initialRadius, cam = this.scene?.camera;
		if (!pl || !(minPx > 0) || !(r0 > 0) || !cam) return pl;
		const c = Matrix4.getTranslation(p.modelMatrix ?? Matrix4.IDENTITY, new Cartesian3()), r = r0 * pl.scale;
		const mpp = cam.getPixelSize(new BoundingSphere(c, r), this.scene.drawingBufferWidth, this.scene.drawingBufferHeight);
		let k = pl.scale;
		if (Number.isFinite(mpp) && mpp > 0 && (2 * r) / mpp < minPx) k = (minPx * mpp) / (2 * r0);
		return { ...pl, scale: p.maximumScale != null ? Math.min(k, p.maximumScale) : k };
	}
	/** a Model (Model.fromGltfAsync): the globe loads the same glTF where the model matrix puts it */
	#loadModel(map: Any, it: Item) {
		const p = it.p, url: string | undefined = p._resource?.url ?? p._resource?._url;
		const pl = this.#placeOf(p);
		if (!url || !pl) { unsupported("Model without a URL (a glTF given as JSON or a buffer)"); return; }
		if (p.color && !Color.equals(p.color, Color.WHITE)) unsupported("Model color");
		if (p.silhouetteSize) unsupported("Model silhouette");
		it.loading = true;
		// animations: the globe plays the glTF's own (all of them, looping) while any is active
		const anims = p.activeAnimations, started: Any[] = [];
		if (anims) {
			const spec = (o: Any) => { if (typeof o.animationTime === "function") unsupported("model animation animationTime (a time function)"); return { name: o.name != null ? String(o.name) : undefined, speed: Number.isFinite(o.multiplier) ? o.multiplier : 1 }; };
			anims.addAll = (o: Any = {}) => { it.anim = spec(o); started.push(o); this.#syncAnim(it); return []; };
			anims.add = (o: Any = {}) => { it.anim = spec(o); started.push(o); this.#syncAnim(it); return { ...o, start: new Event(), update: new Event(), stop: new Event() }; };
			anims.removeAll = () => { started.length = 0; it.anim = null; this.#syncAnim(it); };
			Object.defineProperty(anims, "length", { configurable: true, get: () => started.length });
		}
		void gltfNodeNames(url).then(names => {   // nodes (getNode): there, but the globe does not move them one by one
			p._nodesByName = Object.fromEntries(names.map(n => [n, { name: n, show: true, matrix: Matrix4.clone(Matrix4.IDENTITY), originalMatrix: Matrix4.clone(Matrix4.IDENTITY) }]));
		});
		// what Model's own update would give once loaded: the bounding sphere (zoomTo, flyToBoundingSphere) and ready
		void gltfSphere(url).then(sph => {
			if (!sph || it.dead) return;
			p._sceneGraph ??= { boundingSphere: new BoundingSphere(new Cartesian3(sph.center[0], sph.center[1], sph.center[2]), sph.radius) };
			p._initialRadius ??= sph.radius;
			p._boundingSphere ??= new BoundingSphere();
		});
		map.gadget.model(url, { at: pl.at, altitude: pl.altitude, lift: false, heading: pl.heading, rot: pl.rot, scale: pl.scale, slot: it.key, name: it.key, fit: false, gizmo: false, keep2d: true })   // the matrix's height is absolute (ellipsoid): not lifted onto the terrain
			.then(async (h: Any) => {
				it.loading = false;
				if (it.dead) { h.clear(); return; }
				it.h = h;
				this.#syncAnim(it);
				await gltfSphere(url);
				this.#markReady(p);
				if (started.length && h.animations?.length) h.play();
			}, (err: unknown) => { it.loading = false; console.warn("[csshim] model", url, err); });
	}
}

/** where a Model's matrix puts it on the globe: position, altitude above the ellipsoid, heading, scale */
function placeOf(p: Any): { at: [number, number]; altitude: number; heading: number; rot: number[] | null; scale: number } | null {
	const M = p.modelMatrix ?? Matrix4.IDENTITY, pos = Matrix4.getTranslation(M, new Cartesian3());
	const c = Ellipsoid.WGS84.cartesianToCartographic(pos);
	if (!c) return null;
	const R = Matrix4.getMatrix3(M, new Matrix3()), sc = Matrix3.getScale(R, new Cartesian3());
	const k = (sc.x + sc.y + sc.z) / 3 || 1;
	const q = Quaternion.fromRotationMatrix(Matrix3.multiplyByScalar(R, 1 / k, new Matrix3()));
	return { at: [c.longitude * 180 / Math.PI, c.latitude * 180 / Math.PI], altitude: c.height, heading: headingOf(q, pos), rot: enuRotOf(q, pos), scale: k * (p.scale ?? 1) };
}

/** join segments that continue one another (outlines come as separate segments) */
function mergeLines(ls: PrimLine[]): PrimLine[] {
	const out: PrimLine[] = [];
	for (const l of ls) {
		const last = out[out.length - 1];
		if (last && last.color === l.color && last.width === l.width && l.p.length === 6 && last.p.length >= 6) {
			const n = last.p.length;
			if (last.p[n - 3] === l.p[0] && last.p[n - 2] === l.p[1] && last.p[n - 1] === l.p[2]) { last.p.push(l.p[3], l.p[4], l.p[5]); continue; }
		}
		out.push({ ...l, p: l.p.slice() });
	}
	return out;
}
