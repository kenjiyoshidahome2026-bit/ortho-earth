import * as d3 from 'd3';
import { gadgetIcons, tooltips, statements } from "./icons.js"
import { geopbf } from "geopbf/src/geopbf.js";
const lang = navigator.language.slice(0, 2);
const resources = {
    icons: gadgetIcons,
    tooltips: tooltips[lang] || tooltips.en,
    statements: statements[lang] || statements.en,
    baseName: name => {
        const whiteEarth = "White Earth";
        const naturalEarth = "Natural Earth";
        const osm = '©︎ OpenStreetMap contributors';
        const google = '©︎ Google';
        const Microsoft = '© Microsoft';
        const cyberjapan = "©︎ 国土地理院";
        const props = {
            "whiteEarth": ["whiteEarth", null, 7, [naturalEarth]],
            "google.street": ["naturalEarth", "google.streets", 22, [naturalEarth, google]],
            "google.terrain": ["naturalEarth", "google.terrain", 22, [naturalEarth, google]],
            "google.satellite": ["google.satellite", "google.satellite", 22, [google]],
            "google.hybrid": ["google.satellite", "google.hybrid", 22, [google]],
            "osm.street": ["naturalEarth", "osm.street", 19, [naturalEarth, osm]],
            "osm.satellite": ["osm.satellite", "osm.satellite", 19, [Microsoft]],
            "cyberjapan.std": ["naturalEarth", "cyberjapan.std", 19, [naturalEarth, cyberjapan]],
            "cyberjapan.pale": ["naturalEarth", "cyberjapan.pale", 19, [naturalEarth, cyberjapan]]
        };
        if (!props[name]) { console.error("Base Name Error: ", name); name = "whiteEarth"; }
        const [base, tile, maxZoom, cr] = props[name];
        const attribution = [whiteEarth].concat(cr).join(" / ");
        return { base, tile, maxZoom, attribution };
    },
    tileURL: function (type) {
        let count = 0;
        const index = ([x, y, z]) => {
            let s = "";
            for (let i = z - 1; i >= 0; i--) s += ((y >> i & 1) << 1 | (x >> i & 1));
            return s || "0";
        };
        const osm = type => {
            return type == "satellite" ?
                t => `https://tiler.ortho-earth.com/bing/${index(t)}` :
                t => `https://tile.openstreetmap.jp/${t[2]}/${t[0]}/${t[1]}.png`;
        };
        const cyberjapan = type => {
            const mime = ["std", "pale", "relief", "blank", "airphoto", "ort_old10", "ort_USA10", "ort_riku10", "afm", "lcmfc2", "swale"].includes(type) ? "png" : "jpg";
            return ([x, y, z]) => {
                const n = 1 << z, lng = (x + 0.5) / n * 360 - 180;
                const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
                if (lat > 20 && lat < 46 && lng > 122 && lng < 154) {
                    return `https://cyberjapandata.gsi.go.jp/xyz/${type}/${z}/${x}/${y}.${mime}`;
                }
                return `https://tile.openstreetmap.jp/${z}/${x}/${y}.png`;
            };
        };
        const google = type => {
            const s = ({ streets: "m", satellite: "s", hybrid: "s,h", terrain: "p" })[type];
            return ([x, y, z]) => `https://mt${(count++) % 4}.google.com/vt/lyrs=${s}&x=${x}&y=${y}&z=${z}`;
        };
        type = type.split(".");
        return ({ cyberjapan, osm, google })[type[0]](type[1]);
    },
};
resources.sphere = { type: "Sphere" };
resources.graticule = d3.geoGraticule10();
resources.border = (await geopbf("ne_50m_admin_0_boundary_lines_land")).geojson;
resources.maritime = (await geopbf("ne_50m_admin_0_boundary_lines_maritime_indicator")).geojson;
resources.lines = (await geopbf("ne_50m_geographic_lines")).geojson;
resources.land = (await geopbf("ne_50m_land")).geojson;
resources.land110 = (await geopbf("ne_110m_land")).geojson;
resources.stars = (await geopbf("stars.8")).geojson;
export { resources };