import * as d3 from 'd3';
import { Logger } from "common";
import "common/d3/selection.js";
import "common/d3/loader.js";
////-------------------------------------------------------
import { orthographic } from "./orthographic.js";
import { createLayers } from "./createLayers.js";
import { createAccessories } from "./createAccessories.js";
import { createGadgets } from "./createGadgets.js";
import "./index.scss";
const logger = new Logger();
export async function orthoEarth(opts = {}) {
	console.clear();
	const systemName = orthoEarth.name;
	console.time(systemName)
	logger.title("ortho Earth");
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
	console.log("----- Layer List -----\n" + map.listOfLayers());
	console.timeEnd(systemName);
	console.log("--------------------------");
	return map;
};