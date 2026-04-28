import * as d3 from 'd3';
import "common/d3/selection.js";
import "common/d3/loader.js";
////-------------------------------------------------------
import { orthographic } from "./orthographic.js";
import { createLayers } from "./createLayers.js";
import { createAccessories } from "./createAccessories.js";
import { createGadgets } from "./createGadgets.js";
import "./index.scss";
export async function orthoEarth(opts = {}) {
	const dt = performance.now(); console.clear();
	console.log(`%c ✨ ortho-earth ✨ `, 'background: #2c3e50; color: #ecf0f1; padding: 2px 10px; border-radius: 5px; font-size: 1.5em;');
	////------------------------------------------------------------------------------------------------
	const base = (opts.target || d3.select("body")).empty();
	const map = base.append("div");
	map.base = base.classed("orthoEarthBase", true);
	map.mapFrame = map.attr("name", "mapFrame");
	map.lang = { "ja": "ja", "en": "en", "zh": "zh", "ko": "ko" }[navigator.language.slice(0, 2)]||"en";
	//------------------------------------------------------------------------------------------------
	const loader = map.prepend("div").loader({ mess: "ortho-earth" });
	await orthographic(map, opts || {});
	loader.removeLoader(); //ローダーの消去
	await createLayers(map);
	opts.noAccessories || createAccessories(map, opts || {});
	opts.noGadgets || createGadgets(map);
	const meas = (performance.now() - dt).toFixed(2);
	console.log(`[ortho-earth] %c✅ [SUCCESS] %c launched in %c${meas}%c [msec]`, 'color: #2ecc71; font-weight: bold;', 'color: inherit;', 'color: #00FFFF; font-weight: bold;', 'color: inherit;');
	return map;
};