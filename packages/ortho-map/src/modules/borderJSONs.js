import * as d3 from "d3";
import { geopbf } from "geopbf/src/geopbf.js";
export const borderJSONs = async () => ({
	sphere: { type: "Sphere" },
	graticule: d3.geoGraticule10(),
	border: (await geopbf("ne_50m_admin_0_boundary_lines_land")).geojson,
	maritime: (await geopbf("ne_50m_admin_0_boundary_lines_maritime_indicator")).geojson,
	lines: (await geopbf("ne_50m_geographic_lines")).geojson,
	land: (await geopbf("ne_50m_land")).geojson,
	land110: (await geopbf("ne_110m_land")).geojson,
	stars: (await geopbf("stars.8")).geojson
});