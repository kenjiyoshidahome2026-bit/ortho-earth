// "geopbf/leaflet"（§9）
export { sanitizeProperties, loadGeopbf } from "./load.js";
/** L に L.GeoPBF／L.geoPBF(url, options) を足す（leaflet は import しない） */
export function extendLeaflet<L extends Record<string, any>>(L: L): L;
