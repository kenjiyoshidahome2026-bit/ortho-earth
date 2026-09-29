// MapLibre の口（公式例の門 §8・本人裁定 1「製品の口」）＝`import * as maplibregl from ...` の差し替えだけで MapLibre GL JS のコードがこの地図で動く通訳。
// 中身は通訳だけ（map.js の約束）。無い口は投げずに `[mlshim] unsupported: …` を 1 回記録する＝公式例の門の順位表の材料。
export { Map, Marker, Popup } from "./map.js";
export { Compare } from "../globe.js";   // maplibre-gl-compare と同じ形（#173）・通訳は ../globe.js の部品だけ（mlshim の掟）
export { MaplibreInspect } from "./inspect.js";   // maplibre-gl-inspect と同じ形（#174）＝map.addControl(new MaplibreInspect({...}))・中身はガジェット map.gadget.inspect への通訳
export { LngLat, LngLatBounds, MercatorCoordinate } from "./geo.js";
export { NavigationControl, FullscreenControl, GeolocateControl, ScaleControl, AttributionControl, LogoControl, GlobeControl, TerrainControl } from "./controls.js";
export { addProtocol, removeProtocol } from "../globe.js";

// 名前空間の付き物（MapLibre と同名）。worker・RTL の差し込み・先読みはこの地図が自分で持つ＝受け取るだけ
export const getVersion = () => "ortho-earth";
export const setRTLTextPlugin = async () => {};
export const getRTLTextPluginStatus = () => "loaded";
export const prewarm = () => {};
export const clearPrewarmedResources = () => {};
export const setWorkerCount = () => {};
export const getWorkerCount = () => 1;
export const setMaxParallelImageRequests = () => {};
export const getMaxParallelImageRequests = () => 16;
export const setWorkerUrl = () => {};
export const getWorkerUrl = () => "";
