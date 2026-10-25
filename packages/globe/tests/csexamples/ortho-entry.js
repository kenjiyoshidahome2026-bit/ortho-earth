// The ortho side of the Cesium examples gate: the facade (@ortho-earth/cesium) as "cesium", with the same recorder as the ref side (vite.config.mjs REF_WRAPPER).
export * from "../../../../sdk/cesium/src/index.ts";
import * as NS from "../../../../sdk/cesium/src/index.ts";
const X = (window.__csx ||= { side: "ortho", viewers: [], errors: [] });
X.side = "ortho"; X.Cesium = NS;
export class Viewer extends NS.Viewer {
	constructor(c, o) {
		super(c, o); X.viewers.push(this);
		this.scene.renderError.addEventListener((s, e) => X.errors.push(String(e?.message || e)));
	}
}
export class CesiumWidget extends NS.CesiumWidget {
	constructor(c, o) {
		super(c, o); X.viewers.push(this);
		this.scene.renderError.addEventListener((s, e) => X.errors.push(String(e?.message || e)));
	}
}
