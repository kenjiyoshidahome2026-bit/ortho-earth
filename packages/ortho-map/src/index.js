import * as d3 from 'd3';
import "common/src/d3/selection.js";
import "common/src/d3/loader.js";
import { gadgetIcons, tooltips } from "./modules/icons.js"
import { layerList } from "./modules/layerList.js"
import { borderJSONs } from "./modules/borderJSONs.js"
////-------------------------------------------------------
import { orthographic } from "./orthographic.js";
import { createLayers } from "./createLayers.js";
import { createAccessories } from "./createAccessories.js";
import { createGadgets } from "./createGadgets.js";
import "./index.scss";
export async function orthoEarth(opts = {}) { debugger
//	console.clear();
	const systemName = orthoEarth.name;
	console.time(systemName)
	console.log("--------------------------\n%c ortho Earth%c\n--------------------------", "font-size:2em", "font-size:1em");
	////------------------------------------------------------------------------------------------------
	const base = (opts.target || d3.select("body")).empty();
	const map = base.append("div");
	map.base = base.classed("orthoEarthBase", true);
	map.mapFrame = map.attr("name", "mapFrame");
	//------------------------------------------------------------------------------------------------
	map.setProperties = q => {
		const props = [
			"--space-color", "--earth-filter", "--bg-color", "--fg-color",
			"--border-width", "--border-color", "--border-hover", "--radius",
			"--button-size", "--modal-color", "--font-size", "--font-family",
			"--gadget-filter", "--bg-backpanel", "--fg-backpanel", "--backpanel-filter"];
		Object.entries(q).forEach(([name, prop]) => {
			name = "--" + name.split("").map(t => t.match(/[A-Z]/) ? "-" + t.toLowerCase() : t).join("");
			props.includes(name) && document.documentElement.style.setProperty(name, prop);
		});
	};
	//------------------------------------------------------------------------------------------------
	const loader = map.prepend("div").loader({ mess: "ortho-earth" });
	const language = navigator.language.slice(0, 2);
	const lang = tooltips[language] ? language: "en";
	map.resources = { lang, layers:layerList, borders: await borderJSONs(), icons:gadgetIcons, tips:tooltips[lang] };
	console.log(map.resources);
	await orthographic(map, opts || {});
	loader.removeLoader(); //ローダーの消去
	
	await createLayers(map);
	// latlng scale credit globe night
	opts.noAccessories || createAccessories(map, opts || {});
	// 1) leftPanel, rightPanel, layers, zoom, north, cpos, full, shot, print, measure
	// 2) explain, legend, loading, tip, pop, contextmenu
	opts.noGadgets || createGadgets(map);
	console.log("----- Layer List -----\n" + map.listOfLayers());
	console.timeEnd(systemName);
	console.log("--------------------------");
	return map;
};