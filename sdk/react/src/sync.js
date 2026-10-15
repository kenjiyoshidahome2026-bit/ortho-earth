// @ortho-earth/react の純関数（検定は node・tests/t-react.mjs）：props の差分と、差分を map へ写す手順。React に依らない
export const shallowEqual = (a, b) => {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const ka = Object.keys(a), kb = Object.keys(b);
	return ka.length === kb.length && ka.every(k => Object.is(a[k], b[k]));
};
// 2 つの object の違う鍵（消えた鍵は値 undefined で出る）＝setPaintProperty(id, name, undefined) が既定へ戻す
export const diffProps = (prev = {}, next = {}) => {
	const out = {};
	for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) if (!Object.is(prev[k], next[k]) && !deepEqualJSON(prev[k], next[k])) out[k] = next[k];
	return out;
};
const deepEqualJSON = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
// 層の props の変化を map へ：paint/layout は鍵ごとに set*Property、filter は setFilter、minzoom/maxzoom は setLayerZoomRange。
// type/source/source-layer が変わる時は作り直し（戻り値 "recreate"）＝呼び手が remove → add する
export const syncLayer = (map, id, prev, next) => {
	if (prev.type !== next.type || prev.source !== next.source || prev["source-layer"] !== next["source-layer"]) return "recreate";
	const touched = [];
	for (const [k, v] of Object.entries(diffProps(prev.paint, next.paint))) { map.setPaintProperty(id, k, v); touched.push("paint." + k); }
	for (const [k, v] of Object.entries(diffProps(prev.layout, next.layout))) { map.setLayoutProperty(id, k, v); touched.push("layout." + k); }
	if (!deepEqualJSON(prev.filter, next.filter)) { map.setFilter(id, next.filter ?? null); touched.push("filter"); }
	if ((prev.minzoom ?? 0) !== (next.minzoom ?? 0) || (prev.maxzoom ?? 24) !== (next.maxzoom ?? 24)) { map.setLayerZoomRange(id, next.minzoom ?? 0, next.maxzoom ?? 24); touched.push("zoom"); }
	return touched;
};
// Layer の props から MapLibre の層の spec を作る（React だけの props を除く）
export const layerSpecOf = ({ id, beforeId, source, children, ...rest }, ctxSource) => ({ id, source: source ?? ctxSource, ...rest });
// Data の props を data・accessor（map.addData の opts）に分ける
export const splitDataProps = ({ id, kind, data, children, ...acc }) => ({ id, kind, data, acc });
