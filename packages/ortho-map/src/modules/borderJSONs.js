import * as d3 from "d3";
import { geopbf } from "geopbf";
const borders = {};
export const borderJSONs = async () => {
	if (borders.sphere) return borders;
	borders.sphere = { type: "Sphere" };
	borders.graticule = borders.graticule || await geopbf(d3.geoGraticule10());
	await Promise.all(Object.entries({
		"border":"ne_50m_admin_0_boundary_lines_land",
		"maritime": "ne_50m_admin_0_boundary_lines_maritime_indicator",
		"lines": "ne_50m_geographic_lines",
	//	"land": "ne_50m_land",
		"land110": "ne_110m_land",
		"stars": "stars.6"
	}).map(([k, v]) => (async() => borders[k] = borders[k] || (await geopbf(v)))()));
	return borders;
}