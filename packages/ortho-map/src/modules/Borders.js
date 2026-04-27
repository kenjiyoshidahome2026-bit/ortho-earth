import * as d3 from "d3";
import { geopbf } from "geopbf";
const borders = {};
export const Borders = async () => {
	if (borders.graticule) return borders;
	borders.graticule = borders.graticule || await geopbf({ type: "Feature", geometry: d3.geoGraticule().step([10, 10]).precision(1)() }, { name:"graticule"});
	await Promise.all(Object.entries({
		"border":"ne_50m_admin_0_boundary_lines_land",
		"maritime": "ne_50m_admin_0_boundary_lines_maritime_indicator",
		"lines": "ne_50m_geographic_lines",
		"land110": "ne_110m_land",
		"stars": "stars.6"
	}).map(([k, v]) => (async() => borders[k] = borders[k] || (await geopbf(v)))()));
	console.log(borders);
	return borders;
}