// OSM planet（Protomaps basemaps v4 の層と kind）を描く MapLibre style。試作の間の素の配色＝UNMAP に替える時は style ごと差し替える。
// ズームは MapLibre の z（エンジンは style を MapLibre の z として読む＝globe.d.ts の style）。
// この地図の掟：破線を使わない・静かな色域・地形の陰影を潰さない（塗りは淡く）。書体はエンジンの文字（text-font は読まない）。
// 層名と kind の正本：https://docs.protomaps.com/basemaps/layers（v4）
import { OSM_ATTRIBUTION } from "./sources.ts";

type Layer = Record<string, unknown> & { id: string; type: string };
const W = (pairs: number[]): unknown[] => ["interpolate", ["exponential", 1.6], ["zoom"], ...pairs];   // 線幅のズーム補間
const kindIs = (...k: string[]): unknown[] => k.length === 1 ? ["==", ["get", "kind"], k[0]] : ["in", ["get", "kind"], ["literal", k]];

export const COLORS = {
	sea: "#c4d7e3", earth: "#f2efe8", water: "#b2cad9",
	forest: "#d9e6cf", grass: "#e6ecd6", farmland: "#eceedf", barren: "#ece6dc", glacier: "#f7fafc", urban: "#e8e3dc",
	park: "#d6e6c8", building: "#dcd6cd",
	highway: "#e0a66f", major: "#d4c4a6", minor: "#d8d0c3", path: "#ddd6cb", rail: "#a9a2ae",
	country: "#7f7490", region: "#b4abc0",
	label: "#3b3a40", halo: "#ffffff",
};

export function osmStyle(osmUrl: string): Record<string, unknown> {
	const C = COLORS;
	const layers: Layer[] = [
		{ id: "background", type: "background", paint: { "background-color": C.sea } },
		{ id: "earth", type: "fill", source: "osm", "source-layer": "earth", paint: { "fill-color": C.earth } },
		// 低ズームの土地被覆（v4 は z0–7 だけ持つ）
		{ id: "landcover-forest", type: "fill", source: "osm", "source-layer": "landcover", filter: kindIs("forest"), paint: { "fill-color": C.forest } },
		{ id: "landcover-grass", type: "fill", source: "osm", "source-layer": "landcover", filter: kindIs("grassland", "scrub"), paint: { "fill-color": C.grass } },
		{ id: "landcover-farmland", type: "fill", source: "osm", "source-layer": "landcover", filter: kindIs("farmland"), paint: { "fill-color": C.farmland } },
		{ id: "landcover-barren", type: "fill", source: "osm", "source-layer": "landcover", filter: kindIs("barren"), paint: { "fill-color": C.barren } },
		{ id: "landcover-glacier", type: "fill", source: "osm", "source-layer": "landcover", filter: kindIs("glacier"), paint: { "fill-color": C.glacier } },
		{ id: "landcover-urban", type: "fill", source: "osm", "source-layer": "landcover", filter: kindIs("urban_area"), paint: { "fill-color": C.urban } },
		// 中〜高ズームの土地利用
		{ id: "landuse-green", type: "fill", source: "osm", "source-layer": "landuse", minzoom: 8, filter: kindIs("park", "national_park", "nature_reserve", "protected_area", "garden", "golf_course", "recreation_ground", "grass", "meadow", "cemetery", "pitch", "playground"), paint: { "fill-color": C.park } },
		{ id: "landuse-forest", type: "fill", source: "osm", "source-layer": "landuse", minzoom: 8, filter: kindIs("forest", "wood", "orchard", "wetland", "scrub"), paint: { "fill-color": C.forest } },
		{ id: "landuse-farmland", type: "fill", source: "osm", "source-layer": "landuse", minzoom: 9, filter: kindIs("farmland", "farmyard"), paint: { "fill-color": C.farmland } },
		{ id: "landuse-barren", type: "fill", source: "osm", "source-layer": "landuse", minzoom: 9, filter: kindIs("bare_rock", "sand", "beach", "glacier"), paint: { "fill-color": C.barren } },
		{ id: "landuse-urban", type: "fill", source: "osm", "source-layer": "landuse", minzoom: 11, filter: kindIs("residential", "commercial", "industrial", "hospital", "school", "college", "university", "military", "aerodrome"), paint: { "fill-color": C.urban } },
		// 水
		{ id: "water", type: "fill", source: "osm", "source-layer": "water", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": C.water } },
		{ id: "waterway", type: "line", source: "osm", "source-layer": "water", minzoom: 9, filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": C.water, "line-width": W([9, 0.5, 14, 2, 18, 6]) } },
		// 建物（v4：z0–14 は寄せ集め・z15＋は 1 棟ずつ）
		{ id: "buildings", type: "fill", source: "osm", "source-layer": "buildings", minzoom: 13, filter: kindIs("building", "building_part"), paint: { "fill-color": C.building } },
		// 境界（実線だけ）
		{ id: "boundary-region", type: "line", source: "osm", "source-layer": "boundaries", minzoom: 3, filter: kindIs("region"), paint: { "line-color": C.region, "line-width": W([3, 0.4, 10, 1.2]) } },
		{ id: "boundary-country", type: "line", source: "osm", "source-layer": "boundaries", filter: kindIs("country"), paint: { "line-color": C.country, "line-width": W([0, 0.6, 6, 1.2, 12, 2.4]) } },
		// 道路と鉄道（v4 は鉄道も roads の kind:rail）
		{ id: "road-path", type: "line", source: "osm", "source-layer": "roads", minzoom: 14, filter: kindIs("path"), paint: { "line-color": C.path, "line-width": W([14, 0.5, 18, 2]) } },
		{ id: "road-minor", type: "line", source: "osm", "source-layer": "roads", minzoom: 12, filter: kindIs("minor_road"), paint: { "line-color": C.minor, "line-width": W([12, 0.5, 16, 3, 18, 8]) } },
		{ id: "rail", type: "line", source: "osm", "source-layer": "roads", minzoom: 8, filter: kindIs("rail"), paint: { "line-color": C.rail, "line-width": W([8, 0.4, 14, 1.2, 18, 2.5]) } },
		{ id: "road-major", type: "line", source: "osm", "source-layer": "roads", minzoom: 7, filter: kindIs("major_road"), paint: { "line-color": C.major, "line-width": W([7, 0.4, 12, 1.5, 16, 5, 18, 12]) } },
		{ id: "road-highway", type: "line", source: "osm", "source-layer": "roads", minzoom: 4, filter: kindIs("highway"), paint: { "line-color": C.highway, "line-width": W([4, 0.4, 10, 1.6, 14, 4, 18, 14]) } },
		// 地名（点の注記）。名前は現地語の name（UN の 6 公用語の切替は後で）
		{ id: "place-country", type: "symbol", source: "osm", "source-layer": "places", maxzoom: 7, filter: kindIs("country"),
			layout: { "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 15] },
			paint: { "text-color": C.label, "text-halo-color": C.halo, "text-halo-width": 1.4 } },
		{ id: "place-region", type: "symbol", source: "osm", "source-layer": "places", minzoom: 4, maxzoom: 9, filter: kindIs("region"),
			layout: { "text-field": ["get", "name"], "text-size": 11 },
			paint: { "text-color": "#6c6578", "text-halo-color": C.halo, "text-halo-width": 1.2 } },
		{ id: "place-locality", type: "symbol", source: "osm", "source-layer": "places", minzoom: 3, filter: kindIs("locality"),
			layout: { "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 12, 14] },
			paint: { "text-color": C.label, "text-halo-color": C.halo, "text-halo-width": 1.2 } },
		{ id: "place-neighbourhood", type: "symbol", source: "osm", "source-layer": "places", minzoom: 12, filter: kindIs("macrohood", "neighbourhood"),
			layout: { "text-field": ["get", "name"], "text-size": 11 },
			paint: { "text-color": "#5d5a63", "text-halo-color": C.halo, "text-halo-width": 1.2 } },
	];
	return {
		version: 8, name: "UNMAP prototype (OSM)",
		sources: { osm: { type: "vector", url: "pmtiles://" + osmUrl, attribution: OSM_ATTRIBUTION, maxzoom: 15 } },
		layers,
	};
}
