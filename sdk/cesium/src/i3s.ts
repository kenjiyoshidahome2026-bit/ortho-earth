// I3SDataProvider on the globe's I3S (map.addI3S). fromUrl reads the scene layer's JSON for what the examples ask of the provider before anything
// draws (extent for the camera, name, the raw data); adding the provider to scene.primitives puts the layer on the globe, which reads the nodes
// and their meshes itself (globe gadgets/tiles3d.ts addI3S). Cesium converts I3S into 3D Tiles in the page; here nothing of that runs.
import { Event, Rectangle } from "@cesium/core";
import { Resource } from "@cesium/engine";
import { unsupported } from "./report.ts";

type Any = any;

export interface I3SHost { map: Any | null; ready: Promise<Any> }

/** the extent (degrees) of a scene layer's JSON: fullExtent (xmin…ymax) or store.extent ([xmin, ymin, xmax, ymax]); null without either */
export function extentOfLayerJson(data: Any): number[] | null {
	const fe = data?.fullExtent;
	if (fe && [fe.xmin, fe.ymin, fe.xmax, fe.ymax].every(Number.isFinite)) return [fe.xmin, fe.ymin, fe.xmax, fe.ymax];
	const se = data?.store?.extent;
	if (Array.isArray(se) && se.length >= 4 && se.slice(0, 4).every(Number.isFinite)) return [se[0], se[1], se[2], se[3]];
	return null;
}
/** the union of extents (degrees) */
export function unionExtents(exts: number[][]): number[] | null {
	let out: number[] | null = null;
	for (const e of exts) out = out ? [Math.min(out[0], e[0]), Math.min(out[1], e[1]), Math.max(out[2], e[2]), Math.max(out[3], e[3])] : e.slice();
	return out;
}

/** the facade's I3SDataProvider */
export class I3SDataProvider {
	name: string | undefined; #show = true;
	readonly layers: Any[] = []; readonly sublayers: Any[] = [];
	get show(): boolean { return this.#show; }
	set show(v: boolean) { this.#show = !!v; this.#handle?.setVisible?.(this.#show); }
	readonly data: Any; readonly resource: Any; readonly extent: Rectangle | undefined;
	readonly geoidTiledTerrainProvider: Any; readonly showFeatures: boolean; readonly adjustMaterialAlphaMode: boolean; readonly applySymbology: boolean; readonly calculateNormals: boolean;
	readonly readyEvent = new Event();
	#destroyed = false; #host: I3SHost | null = null; #handle: Any = null; #url = "";
	constructor(options: Any = {}, resource?: Any, data?: Any, extent?: number[] | null) {
		this.name = options.name; this.#show = options.show ?? true;
		this.geoidTiledTerrainProvider = options.geoidTiledTerrainProvider; this.showFeatures = !!options.showFeatures; this.adjustMaterialAlphaMode = !!options.adjustMaterialAlphaMode;
		this.applySymbology = !!options.applySymbology; this.calculateNormals = !!options.calculateNormals;
		this.resource = resource; this.data = data;
		this.extent = extent ? Rectangle.fromDegrees(extent[0], extent[1], extent[2], extent[3]) : undefined;
	}
	/** as Cesium: the scene layer (…/SceneServer/layers/N) or the service (…/SceneServer, every layer) */
	static async fromUrl(url: string | Any, options: Any = {}): Promise<I3SDataProvider> {
		const resource = (Resource as Any).createIfNeeded(url);
		resource.setQueryParameters({ f: "pjson" }, true);
		const data = await resource.fetchJson();
		if (data?.error) throw new Error(`I3S: ${data.error.message ?? JSON.stringify(data.error)}`);
		let extent = extentOfLayerJson(data);
		if (!extent && Array.isArray(data?.layers)) {   // a service: the layers' own JSON (the service listing has no extents)
			const exts: number[][] = [];
			for (const L of data.layers) {
				const e = extentOfLayerJson(L);
				if (e) { exts.push(e); continue; }
				try { const lr = resource.getDerivedResource({ url: `layers/${L.id}` }); lr.setQueryParameters({ f: "pjson" }, true); const le = extentOfLayerJson(await lr.fetchJson()); if (le) exts.push(le); } catch { /* a layer without JSON: no extent from it */ }
			}
			extent = unionExtents(exts);
		}
		const p = new I3SDataProvider(options, resource, data, extent);
		p.#url = String(resource.url).replace(/\?.*$/, "");
		// geoidTiledTerrainProvider needs nothing here: Cesium converts the gravity-related I3S heights onto its ellipsoid, but the globe's heights are
		// already geoid-based (its terrain is orthometric), so the I3S heights sit on its ground as they are
		return p;
	}
	/** scene.primitives.add: on the globe */
	__attach(host: I3SHost): void {
		this.#host = host;
		const token = this.resource?.queryParameters?.token;
		host.ready.then(async (map: Any) => {
			if (this.#destroyed || this.#host !== host || typeof map?.addI3S !== "function") return;
			try {
				this.#handle = await map.addI3S(this.#url, { fit: false, ...(token ? { token } : {}) });
				if (this.#destroyed || this.#host !== host) { this.#handle?.remove?.(); this.#handle = null; return; }
				if (!this.show) this.#handle?.setVisible?.(false);
				this.readyEvent.raiseEvent(this);
			} catch (e) { console.error("[csshim] I3S", this.#url, e); }
		});
	}
	__detach(): void { this.#host = null; this.#handle?.remove?.(); this.#handle = null; }
	/** the globe's handle (its stats: loaded / shown / triangles) once the layer is on the globe; the gate reads it */
	get orthoHandle(): Any { return this.#handle; }
	getAttributeNames(): string[] { return []; }
	getAttributeValues(): Any[] { return []; }
	/** no filter (what I3SBuildingSceneLayerExplorer passes for "show all") shows everything, as the globe already does; a real filter is not drawn */
	filterByAttributes(filters?: Any[]): Promise<void> { if (filters?.length) unsupported("I3SDataProvider.filterByAttributes"); return Promise.resolve(); }
	isDestroyed(): boolean { return this.#destroyed; }
	destroy(): void { this.#destroyed = true; this.__detach(); }
}
