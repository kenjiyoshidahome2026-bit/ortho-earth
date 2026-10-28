// A data source's clustering (EntityCluster) on the globe (順 5・2026-10-28).
//   The engine's EntityCluster works on the billboard / label / point collections of Cesium's own visualizers, which the facade does not make;
//   here the same algorithm (EntityCluster.js createDeclutterCallback) runs on the entities' marks: each shown mark is projected to the screen,
//   its screen box (Billboard / Label / PointPrimitive.getScreenSpaceBoundingBox, widened by pixelRange) gathers the unclustered marks inside it,
//   and minimumClusterSize of them become one cluster at their mean position. The cluster's billboard / label / point start as Cesium's
//   (a label with the count, the others hidden) and clusterEvent lets the page restyle them; they are drawn as entities of their own.
//   While zooming in, the previous clusters are kept first (shrunk by the height ratio), as Cesium does.
import { BoundingRectangle, Cartesian2, Cartesian3, Color, Ellipsoid, EllipsoidalOccluder, JulianDate } from "@cesium/core";
import * as engine from "@cesium/engine";
import { Entity, HorizontalOrigin, LabelStyle, SceneTransforms, VerticalOrigin } from "@cesium/engine";

type Any = any;
const { Property } = engine as Any;
const val = (p: Any, t: JulianDate, d?: Any) => { const v = Property.getValueOrUndefined(p, t); return v === undefined ? d : v; };

/** one mark on the screen: its window position, its widened box, its world position and its entity */
export interface ClusterPoint { coord: { x: number; y: number }; bbox: BoundingRectangle; position: Cartesian3; id: Any; clustered?: boolean }
export interface PrevCluster { position: Cartesian3; width: number; height: number; minimumWidth: number; minimumHeight: number }
export interface ClusterOut { position: Cartesian3; ids: Any[] }

const expand = (b: BoundingRectangle, r: number) => { b.x -= r; b.y -= r; b.width += r * 2; b.height += r * 2; return b; };
const inRange = (ps: ClusterPoint[], x0: number, y0: number, x1: number, y1: number) => { const out: number[] = []; for (let i = 0; i < ps.length; i++) { const c = ps[i].coord; if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) out.push(i); } return out; };   // KDBush.range (inclusive)

/** EntityCluster's declutter pass: the clusters, the marks left on their own, and the clusters to keep for the next pass */
export function clusterPoints(points: ClusterPoint[], minimumClusterSize: number, prev: PrevCluster[], currentHeight: number, previousHeight: number, project: (p: Cartesian3) => { x: number; y: number } | undefined, visible: (p: Cartesian3) => boolean = () => true) {
	const clusters: ClusterOut[] = [], alone: Any[] = [], next: PrevCluster[] = [];
	if (currentHeight < previousHeight) {
		for (const cl of prev) {
			if (!visible(cl.position)) continue;
			const coord = project(cl.position);
			if (!coord) continue;
			const factor = 1.0 - currentHeight / previousHeight;
			let width = (cl.width = cl.width * factor), height = (cl.height = cl.height * factor);
			width = Math.max(width, cl.minimumWidth); height = Math.max(height, cl.minimumHeight);
			const nb = inRange(points, coord.x - width * 0.5, coord.y - height * 0.5, coord.x + width, coord.y + height);
			const ids = nb.filter(j => !points[j].clustered).map(j => points[j].id);
			if (ids.length >= minimumClusterSize) {
				clusters.push({ position: cl.position, ids }); next.push(cl);
				for (const j of nb) points[j].clustered = true;
			}
		}
	}
	for (const point of points) {
		if (point.clustered) continue;
		point.clustered = true;
		const bbox = point.bbox, total = BoundingRectangle.clone(bbox);
		const nb = inRange(points, bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height);
		const sum = Cartesian3.clone(point.position), ids = [point.id];
		for (const j of nb) {
			const q = points[j];
			if (q.clustered) continue;
			Cartesian3.add(q.position, sum, sum);
			BoundingRectangle.union(total, q.bbox, total);
			ids.push(q.id);
		}
		if (ids.length >= minimumClusterSize) {
			const position = Cartesian3.multiplyByScalar(sum, 1.0 / ids.length, sum);
			clusters.push({ position, ids });
			next.push({ position, width: total.width, height: total.height, minimumWidth: bbox.width, minimumHeight: bbox.height });
			for (const j of nb) points[j].clustered = true;
		} else alone.push(point.id);
	}
	return { clusters, alone, next };
}

// ── the screen boxes of an entity's marks ──
let ctx2d: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string): number {
	if (ctx2d === undefined) { try { ctx2d = document.createElement("canvas").getContext("2d"); } catch { ctx2d = null; } }
	if (!ctx2d) return text.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "30") * 0.55);
	ctx2d.font = font; return ctx2d.measureText(text).width;
}
const fontPx = (f: string) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(f)?.[1] ?? "30");
function box(x: number, y: number, w: number, h: number, ho: number, vo: number, defH: number) {
	if (ho === HorizontalOrigin.RIGHT) x -= w; else if (ho === HorizontalOrigin.CENTER || (ho == null && defH === HorizontalOrigin.CENTER)) x -= w * 0.5;
	if (vo === VerticalOrigin.BOTTOM || vo === VerticalOrigin.BASELINE) y -= h; else if (vo === VerticalOrigin.CENTER) y -= h * 0.5;
	return new BoundingRectangle(x, y, w, h);
}
/** the marks the cluster may gather: an entity's billboard or point, else its label (with the label's box joined in), as getScreenSpacePositions / getBoundingBox */
export function markOf(e: Any, t: JulianDate, c: Any, coord: { x: number; y: number }, pixelRange: number, imageSize: (src: Any) => { w: number; h: number } | null): BoundingRectangle | null {
	const bb = e.billboard && val(e.billboard.show, t, true) && c.clusterBillboards ? e.billboard : null;
	const pt = !bb && e.point && val(e.point.show, t, true) && c.clusterPoints ? e.point : null;
	const lb = e.label && val(e.label.show, t, true) && c.clusterLabels && val(e.label.text, t) ? e.label : null;
	let r: BoundingRectangle | null = null;
	if (bb) {
		const sz = imageSize(val(bb.image, t)), sc = val(bb.scale, t, 1);
		const w = (val(bb.width, t) ?? sz?.w ?? 32) * sc, h = (val(bb.height, t) ?? sz?.h ?? 32) * sc;
		r = expand(box(coord.x, coord.y, w, h, val(bb.horizontalOrigin, t, HorizontalOrigin.CENTER), val(bb.verticalOrigin, t, VerticalOrigin.CENTER), HorizontalOrigin.CENTER), pixelRange);
	} else if (pt) {
		const s = val(pt.pixelSize, t, 1);
		r = expand(new BoundingRectangle(coord.x - s / 2, coord.y - s / 2, s, s), pixelRange);
	}
	if (lb) {
		const font = val(lb.font, t, "30px sans-serif"), sc = val(lb.scale, t, 1), text = String(val(lb.text, t));
		const lr = expand(box(coord.x, coord.y, textWidth(text, font) * sc, fontPx(font) * sc, val(lb.horizontalOrigin, t, HorizontalOrigin.LEFT), val(lb.verticalOrigin, t, VerticalOrigin.BASELINE), HorizontalOrigin.LEFT), pixelRange);
		r = r ? BoundingRectangle.union(r, lr, r) : lr;
	}
	return r;
}

/** the cluster's billboard / label / point as the page sees them in clusterEvent (Cesium's defaults: the count as a label, the others hidden) */
export function clusterGraphics(n: number, ids: Any[], position: Cartesian3) {
	const billboard: Any = { show: false, image: undefined, scale: 1, color: Color.WHITE, verticalOrigin: VerticalOrigin.CENTER, horizontalOrigin: HorizontalOrigin.CENTER, pixelOffset: Cartesian2.ZERO, width: undefined, height: undefined, id: undefined, position };
	const label: Any = { show: true, text: n.toLocaleString(), font: "30px sans-serif", fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 1, style: LabelStyle.FILL, scale: 1, verticalOrigin: VerticalOrigin.BASELINE, horizontalOrigin: HorizontalOrigin.LEFT, pixelOffset: Cartesian2.ZERO, id: ids, position };
	const point: Any = { show: false, pixelSize: 10, color: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 0, id: undefined, position };
	return { billboard, label, point };
}
/** a cluster drawn as an entity (what clusterEvent left shown) */
export function clusterEntity(key: string, c: ReturnType<typeof clusterGraphics>, ids: Any[]): Any {
	const pick = (k: string) => (o: Any) => { const out: Any = {}; for (const f of k.split(",")) if (o[f] !== undefined) out[f] = o[f]; return out; };
	const e: Any = new Entity({
		id: key, position: c.label.position ?? c.billboard.position,
		billboard: c.billboard.show && c.billboard.image ? pick("image,scale,color,verticalOrigin,horizontalOrigin,pixelOffset,width,height")(c.billboard) : undefined,
		label: c.label.show ? pick("text,font,fillColor,outlineColor,outlineWidth,style,scale,verticalOrigin,horizontalOrigin,pixelOffset")(c.label) : undefined,
		point: c.point.show ? pick("pixelSize,color,outlineColor,outlineWidth")(c.point) : undefined,
	});
	e.__csPick = () => ({ id: ids, primitive: { id: ids }, collection: undefined });
	return e;
}

/** the per-data-source state (the clusters kept for zooming in, the camera they were made for) */
export interface ClusterState { key: string; prev: PrevCluster[]; prevHeight: number; hidden: Set<Any>; ents: Any[] }

/** cluster one data source's entities now: which entities the clusters hide, and the cluster entities to draw */
export function runClustering(ds: Any, ents: Any[], t: JulianDate, scene: Any, st: ClusterState, imageSize: (src: Any) => { w: number; h: number } | null, seq: () => number): void {
	const c = ds.clustering;
	const cam = scene.camera, eye: Cartesian3 = cam.positionWC;
	const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, eye);
	const project = (p: Cartesian3) => SceneTransforms.worldToWindowCoordinates(scene, p) ?? undefined;
	const points: ClusterPoint[] = [];
	// the marks in Cesium's order: its billboards are taken from the pool of returned ones (a stack) once clustering is on, so the collection holds
	// the entities last first (clustering example: billboard i = entity n−1−i), and the greedy pass starts from the last entity
	for (let i = ents.length - 1; i >= 0; i--) {
		const e = ents[i];
		if (!e.isShowing || !e.isAvailable(t)) continue;
		const p: Cartesian3 | undefined = val(e.position, t);
		if (!p || !occluder.isPointVisible(p)) continue;
		const coord = project(p);
		if (!coord) continue;
		const bbox = markOf(e, t, c, coord, c.pixelRange, imageSize);
		if (bbox) points.push({ coord, bbox, position: p, id: e });
	}
	const height = cam.positionCartographic?.height ?? 0;
	const { clusters, next } = clusterPoints(points, c.minimumClusterSize, st.prev, height, st.prevHeight, project, p => occluder.isPointVisible(p));
	st.prev = next; st.prevHeight = height;
	st.hidden = new Set(clusters.flatMap(k => k.ids));
	st.ents = clusters.map(k => {
		const g = clusterGraphics(k.ids.length, k.ids, k.position);
		try { c.clusterEvent.raiseEvent(k.ids, g); } catch (err) { console.warn("[csshim] clusterEvent", err); }
		return clusterEntity(`__cluster${seq()}`, g, k.ids);
	});
}
