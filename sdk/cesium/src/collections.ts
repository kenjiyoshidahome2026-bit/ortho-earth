// BillboardCollection, LabelCollection, PointPrimitiveCollection and PolylineCollection on the globe.
// Each billboard / label / point becomes an entity of a source the display draws (and only the display sees: the viewer's entities
// and data sources are left as they are), refreshed when the item changes. scene.pick on one returns { primitive: item, id: item.id,
// collection } as Cesium does. Polylines go to the 3D lines (their material's colour).
import { Color, Ellipsoid, PolylinePipeline } from "@cesium/core";
import * as engine from "@cesium/engine";
import { unsupported } from "./report.ts";
import type { PrimLine } from "./primitives.ts";

type Any = any;
const { BillboardCollection, LabelCollection, PointPrimitiveCollection, PolylineCollection, BillboardTexture, CustomDataSource, BillboardGraphics, LabelGraphics, PointGraphics, Entity, ConstantPositionProperty } = engine as Any;

// The billboard's image goes to Cesium's texture atlas, which needs WebGL: keep what was given instead (the display loads it itself)
if (BillboardTexture?.prototype && !BillboardTexture.prototype.__csshim) {
	BillboardTexture.prototype.__csshim = true;
	BillboardTexture.prototype.loadImage = async function (this: Any, id: Any, image: Any, width?: number, height?: number) { this._id = id; this.__src = image; this.__w = width; this.__h = height; this._loadState = 2; };
}

export const isCollection = (p: Any) => !!p && [BillboardCollection, LabelCollection, PointPrimitiveCollection, PolylineCollection].some(C => C && p instanceof C);

const itemsOf = (c: Any): Any[] => c._billboards ?? c._labels ?? c._pointPrimitives ?? c._polylines ?? [];
const imgOf = (b: Any) => b._imageTexture?.__src ?? (typeof b.image === "string" ? b.image : undefined);
const keyOf = (o: Any, keys: string[]) => keys.map(k => { const v = o[k]; return v && typeof v === "object" ? JSON.stringify(v) : String(v); }).join("|");
const BB_KEYS = ["show", "position", "scale", "color", "pixelOffset", "eyeOffset", "horizontalOrigin", "verticalOrigin", "rotation", "width", "height", "sizeInMeters", "heightReference", "scaleByDistance", "translucencyByDistance", "pixelOffsetScaleByDistance", "distanceDisplayCondition", "disableDepthTestDistance"];
const LB_KEYS = ["show", "position", "text", "font", "fillColor", "outlineColor", "outlineWidth", "style", "scale", "pixelOffset", "eyeOffset", "horizontalOrigin", "verticalOrigin", "showBackground", "backgroundColor", "heightReference", "scaleByDistance", "translucencyByDistance", "distanceDisplayCondition", "disableDepthTestDistance"];
const PT_KEYS = ["show", "position", "color", "pixelSize", "outlineColor", "outlineWidth", "scaleByDistance", "translucencyByDistance", "distanceDisplayCondition", "disableDepthTestDistance"];

interface Rec { e: Any; key: string }

/** draws the scene's billboard, label, point and polyline collections */
export class CollectionDrawer {
	/** entities for the display (not the viewer's) */
	readonly source = new CustomDataSource("__csshim-collections");
	lines: PrimLine[] = [];
	#colls = new Set<Any>(); #recs = new Map<Any, Rec>(); #linesKey = ""; #arcs = new WeakMap<Any, { k: string; p: number[] }>();
	/** a PolylineCollection with a material the globe has no line style for (glow, arrow, outline, dash, fade…): Cesium's renderer draws it (rawdraw.ts) */
	toCesium: ((c: Any) => void) | null = null;
	add(c: Any) { this.#colls.add(c); }
	remove(c: Any) {
		this.#colls.delete(c);
		for (const it of itemsOf(c)) { const r = this.#recs.get(it); if (r) { this.source.entities.remove(r.e); this.#recs.delete(it); } }
	}
	/** per frame: follow what changed */
	update() {
		const live = new Set<Any>(), lines: PrimLine[] = [];
		let lk = "";
		for (const c of this.#colls) {
			if (c.isDestroyed?.()) { this.#colls.delete(c); continue; }
			const shown = c.show !== false;
			if (PolylineCollection && c instanceof PolylineCollection) {
				if (this.toCesium && itemsOf(c).some((pl: Any) => pl.material?.type && pl.material.type !== "Color")) { this.#colls.delete(c); this.toCesium(c); continue; }
				if (!shown) continue;
				for (const pl of itemsOf(c)) {
					if (pl.show === false || !pl.positions?.length) continue;
					const m = pl.material, col: Color = m?.uniforms?.color ?? Color.WHITE;
					if (m?.type && m.type !== "Color" && m.type !== "PolylineOutline" && m.type !== "PolylineGlow") unsupported(`polyline material ${m.type} (drawn in its colour)`);
					const k = `${pl.positions.length}:${pl.positions[0].x}:${pl.positions[pl.positions.length - 1].x}:${pl.width}:${col.toCssColorString()}:${pl.loop}`;
					lk += k + ";";
					let arc = this.#arcs.get(pl);   // the arc only when its key changed (it was built every tick before being compared; this.lines only took it when lk changed)
					if (arc?.k !== k) {
						const ps = pl.loop ? [...pl.positions, pl.positions[0]] : pl.positions;
						let p: number[];
						try { p = Array.from(PolylinePipeline.generateArc({ positions: ps, height: (PolylinePipeline as Any).extractHeights(ps, Ellipsoid.WGS84), granularity: 0.01, ellipsoid: Ellipsoid.WGS84 })); } catch { p = ps.flatMap((q: Any) => [q.x, q.y, q.z]); }
						this.#arcs.set(pl, arc = { k, p });
					}
					lines.push({ p: arc.p, color: col.toCssColorString(), width: pl.width ?? 1 });
				}
				continue;
			}
			for (const it of itemsOf(c)) {
				live.add(it);
				const isLabel = LabelCollection && c instanceof LabelCollection, isPoint = PointPrimitiveCollection && c instanceof PointPrimitiveCollection;
				const key = `${shown}#${keyOf(it, isLabel ? LB_KEYS : isPoint ? PT_KEYS : BB_KEYS)}#${isLabel || isPoint ? "" : String(imgOf(it)?.src ?? imgOf(it))}`;
				let r = this.#recs.get(it);
				if (!r) { r = { e: new Entity({ id: `__csshim-${Math.random().toString(36).slice(2)}` }), key: "" }; r.e.__csPick = () => ({ primitive: it, id: it.id, collection: c }); this.source.entities.add(r.e); this.#recs.set(it, r); }
				if (r.key === key) continue;
				r.key = key;
				const e = r.e;
				e.show = shown && it.show !== false;
				if (it.position) e.position = new ConstantPositionProperty(it.position);
				const common = { scaleByDistance: it.scaleByDistance, translucencyByDistance: it.translucencyByDistance, distanceDisplayCondition: it.distanceDisplayCondition, disableDepthTestDistance: it.disableDepthTestDistance, heightReference: it.heightReference };
				if (isPoint) e.point = new PointGraphics({ color: it.color, pixelSize: it.pixelSize, outlineColor: it.outlineColor, outlineWidth: it.outlineWidth, ...common });
				else if (isLabel) e.label = new LabelGraphics({ text: it.text, font: it.font, fillColor: it.fillColor, outlineColor: it.outlineColor, outlineWidth: it.outlineWidth, style: it.style, scale: it.scale, pixelOffset: it.pixelOffset, eyeOffset: it.eyeOffset, horizontalOrigin: it.horizontalOrigin, verticalOrigin: it.verticalOrigin, showBackground: it.showBackground, backgroundColor: it.backgroundColor, ...common });
				else e.billboard = new BillboardGraphics({ image: imgOf(it), scale: it.scale, color: it.color, pixelOffset: it.pixelOffset, eyeOffset: it.eyeOffset, horizontalOrigin: it.horizontalOrigin, verticalOrigin: it.verticalOrigin, rotation: it.rotation, width: it.width, height: it.height, sizeInMeters: it.sizeInMeters, ...common });
			}
		}
		for (const [it, r] of this.#recs) if (!live.has(it)) { this.source.entities.remove(r.e); this.#recs.delete(it); }
		if (lk !== this.#linesKey) { this.#linesKey = lk; this.lines = lines; }
	}
	destroy() { this.#colls.clear(); this.#recs.clear(); this.source.entities.removeAll(); this.lines = []; }
}
