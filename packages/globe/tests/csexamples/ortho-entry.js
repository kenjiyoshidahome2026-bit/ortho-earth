// The ortho side of the Cesium examples gate: the facade (@ortho-earth/cesium) as "cesium", with the same recorder as the ref side (vite.config.mjs REF_WRAPPER).
export * from "../../../../sdk/cesium/src/index.ts";
import * as NS from "../../../../sdk/cesium/src/index.ts";
// Gaussian splats (KHR_gaussian_splatting tilesets) are drawn by @ortho-earth/splat, which a page using them loads as a globe plugin
import { splatPlugin } from "../../../../sdk/splat/src/index.ts";
const withPlugins = (o = {}) => ({ ...o, ortho: { ...o.ortho, plugins: [...(o.ortho?.plugins ?? []), splatPlugin()] } });
const X = (window.__csx ||= { side: "ortho", viewers: [], errors: [] });
X.side = "ortho"; X.Cesium = NS;
// the same random sequence as the ref side (vite.config.mjs REF_WRAPPER): examples colour their shapes with Color.fromRandom, which draws from
// CesiumMath.nextRandomNumber; unseeded, each side picked its own colours and the picture compare counted them as a mismatch (geometry-height-reference)
NS.Math.setRandomNumberSeed(20261031);
export class Viewer extends NS.Viewer {
	constructor(c, o) {
		super(c, withPlugins(o)); X.viewers.push(this);
		this.scene.renderError.addEventListener((s, e) => X.errors.push(String(e?.message || e)));
	}
}
export class CesiumWidget extends NS.CesiumWidget {
	constructor(c, o) {
		super(c, withPlugins(o)); X.viewers.push(this);
		this.scene.renderError.addEventListener((s, e) => X.errors.push(String(e?.message || e)));
	}
}
