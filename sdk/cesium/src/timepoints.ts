// TimeDynamicPointCloud on the globe (順 5・2026-10-29).
//   Cesium plays one .pnts per time interval (intervals[i].data.uri), showing the frame for the clock's time. Here each frame becomes a one-tile
//   3D Tiles tileset (a tileset.json made in memory whose root content is the .pnts) on the globe's own 3D Tiles; all frames load up front and
//   the one whose interval holds the clock's time is shown (the last shown stays until the next has loaded, as Cesium keeps its last rendered
//   frame). The first frame's bounding sphere (the points + RTC_CENTER) is what zoomTo frames: it is set as Cesium's last rendered frame and
//   frameChanged is raised, which CesiumWidget.zoomTo waits for.
import { BoundingSphere, Matrix4 } from "@cesium/core";
import * as engine from "@cesium/engine";
import type { Host } from "./scene.ts";
import { pointSizeOf, styleOf } from "./tileset.ts";

type Any = any;
const { TimeDynamicPointCloud } = engine as Any;

export const isTimeDynamicPointCloud = (p: Any) => !!TimeDynamicPointCloud && p instanceof TimeDynamicPointCloud;

/** a .pnts's bounding sphere in the fixed frame: its POSITION (float) points + RTC_CENTER (null: quantized or unreadable) */
export function pntsSphere(ab: ArrayBuffer, modelMatrix: Matrix4 = Matrix4.IDENTITY): BoundingSphere | null {
	const dv = new DataView(ab);
	if (ab.byteLength < 28 || dv.getUint32(0, true) !== 0x73746e70) return null;   // "pnts"
	const fj = dv.getUint32(12, true), fb = dv.getUint32(16, true);
	let ft: Any;
	try { ft = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 28, fj))); } catch { return null; }
	const n = ft.POINTS_LENGTH, rtc = ft.RTC_CENTER ?? [0, 0, 0], body = 28 + fj;
	let pts: number[] = [];
	if (ft.POSITION && n > 0 && body + ft.POSITION.byteOffset + n * 12 <= body + fb) {
		const f = new Float32Array(ab.slice(body + ft.POSITION.byteOffset, body + ft.POSITION.byteOffset + n * 12));
		pts = Array.from(f, (v, i) => v + rtc[i % 3]);
	} else if (ft.POSITION_QUANTIZED && ft.QUANTIZED_VOLUME_OFFSET && ft.QUANTIZED_VOLUME_SCALE) {   // the quantized volume's corners
		const o = ft.QUANTIZED_VOLUME_OFFSET, s = ft.QUANTIZED_VOLUME_SCALE;
		for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) pts.push(o[0] + i * s[0] + rtc[0], o[1] + j * s[1] + rtc[1], o[2] + k * s[2] + rtc[2]);
	} else return null;
	return BoundingSphere.transform(BoundingSphere.fromVertices(pts), modelMatrix, new BoundingSphere());
}

interface Frame { url: string; sphere: BoundingSphere | null }
interface Rec { frames: Frame[]; h: Any | null; at: number; loading: number; next: { h: Any; i: number; seen: number } | null; dead: boolean }

export class TimePointsDrawer {
	readonly host: Host;
	#clouds = new Map<Any, Rec>();
	constructor(host: Host) { this.host = host; }
	add(p: Any) {
		if (this.#clouds.has(p)) return;
		const iv = p._intervals, frames: Frame[] = [];
		for (let i = 0; i < (iv?.length ?? 0); i++) {
			const uri = iv.get(i)?.data?.uri;
			frames.push({ url: uri ? new URL(String(uri), document.baseURI).href : "", sphere: null });
		}
		const rec: Rec = { frames, h: null, at: -1, loading: -1, next: null, dead: false };
		this.#clouds.set(p, rec);
		// the first frame's sphere: what zoomTo frames (CesiumWidget.zoomTo waits for frameChanged)
		const f0 = frames[0];
		if (f0?.url) void this.#sphereOf(p, f0).then(s => { if (s && !p._lastRenderedFrame) { p._lastRenderedFrame = { pointCloud: { boundingSphere: s } }; p.frameChanged?.raiseEvent(p); } });
	}
	remove(p: Any) {
		const r = this.#clouds.get(p);
		if (!r) return;
		r.dead = true;
		r.h?.remove?.(); r.next?.h?.remove?.();
		this.#clouds.delete(p);
	}
	async #sphereOf(p: Any, f: Frame): Promise<BoundingSphere | null> {
		if (f.sphere) return f.sphere;
		try { f.sphere = pntsSphere(await (await fetch(f.url)).arrayBuffer(), p.modelMatrix ?? Matrix4.IDENTITY); } catch (e) { console.warn("[csshim] TimeDynamicPointCloud frame", f.url, e); }
		return f.sphere;
	}
	// one tileset on the globe at a time (five hidden ones slowed every frame): the wanted frame is loaded, then the shown one is replaced
	async #show(map: Any, p: Any, r: Rec, i: number) {
		const f = r.frames[i];
		r.loading = i;
		try {
			const s = await this.#sphereOf(p, f);
			if (!s || r.dead) return;
			const json = { asset: { version: "1.0" }, geometricError: 1, root: { boundingVolume: { sphere: [s.center.x, s.center.y, s.center.z, s.radius] }, geometricError: 1, refine: "ADD", content: { uri: f.url } } };
			const url = URL.createObjectURL(new Blob([JSON.stringify(json)], { type: "application/json" }));
			const style = styleOf(p.style), ps = pointSizeOf(p.style);
			const h = await map.add3DTiles(url, { fit: false, ...(style && { style }), pointSize: ps, pickable: false });
			URL.revokeObjectURL(url);
			if (r.dead) { h?.remove?.(); return; }
			r.next = { h, i, seen: 0 };   // swapped in by update once its points are drawn
			map.requestDraw?.();
		} catch (e) { console.warn("[csshim] TimeDynamicPointCloud frame", f.url, e); }
		finally { if (!r.next) r.loading = -1; }
	}
	/** per frame: the frame whose interval holds the time (the shown one stays until the next has loaded, as Cesium keeps its last rendered frame) */
	update(time: Any) {
		const map = this.host.map;
		if (!map) return;
		for (const [p, r] of this.#clouds) {
			const t = time ?? p._clock?.currentTime;
			let want = -1;
			if (p.show !== false && t) { const i = p._intervals?.indexOf?.(t); want = Number.isInteger(i) && i >= 0 && i < r.frames.length && r.frames[i].url ? i : -1; }
			if (want < 0) { if (r.h && p.show === false) { r.h.remove?.(); r.h = null; r.at = -1; } continue; }
			const nx = r.next;
			if (nx && (nx.h.stats?.shown > 0 || nx.h.stats?.failed > 0) && ++nx.seen > 2) {   // the loaded frame has been on the globe a few frames (uploaded): it replaces the shown one
				r.h?.remove?.();
				r.h = nx.h; r.at = nx.i; r.next = null; r.loading = -1;
				const s = r.frames[nx.i].sphere;
				if (s) p._lastRenderedFrame = { pointCloud: { boundingSphere: s } };
				map.requestDraw?.();
			}
			if (want !== r.at && r.loading < 0) void this.#show(map, p, r, want);
		}
	}
}
