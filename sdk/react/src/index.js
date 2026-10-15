// @ortho-earth/react（第 2 波 F9・2026-10-12）＝@ortho-earth/globe の React 束ね。JSX は使わない（createElement）＝束ねる側の JSX runtime に依らない
//   <Globe options onLoad ref>…</Globe>：div を 1 つ描き、mount で createGlobe({ ...options, target }) を 1 回。子は map ができてから（GlobeContext）。unmount で destroy
//   useGlobe()：map（できる前は null）。useGlobeEvent(type, handler, layerId?)：map.on/off（handler は ref＝描き直しで付け替えない）
//   <Source id {...spec}>…</Source>：addSource／removeSource、geojson の data が変わると getSource(id).setData。子の <Layer> は source を省ける
//   <Layer id type source beforeId paint layout filter minzoom maxzoom>：addLayer／removeLayer、paint/layout は鍵ごとに set*Property、filter・zoom 範囲も追う。type/source が変わると作り直し
//   <Data kind data {...accessors} id>：map.addData（points/arcs/trips/polygons/paths/columns と plugin の kind）、data が変われば setData・accessor が変われば setProps、unmount で remove
//   <Marker lngLat altitude draggable onDragEnd {...MarkerOptions}>子</Marker>：map.Marker（DOM）・子は createPortal で marker の要素へ
//   options は mount の 1 回だけ読む（MapLibre の react 束ねと同じ流儀）。視点は map の jumpTo/easeTo を useGlobe() で直接呼ぶ
import { createElement as h, createContext, useContext, useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
// @ortho-earth/globe は mount の時に動的 import（CSS を import する本体を SSR・node の検定へ持ち込まない・束ねる側の code splitting にも乗る）
const defaultCreate = opts => import("@ortho-earth/globe").then(m => m.createGlobe(opts));
import { shallowEqual, syncLayer, layerSpecOf, splitDataProps } from "./sync.js";
export { shallowEqual, diffProps, syncLayer, layerSpecOf, splitDataProps } from "./sync.js";

export const GlobeContext = createContext(null);
export const SourceContext = createContext(null);
export const useGlobe = () => useContext(GlobeContext);

export const Globe = forwardRef(function Globe({ options, style, className, onLoad, onError, create = defaultCreate, children }, ref) {
	const el = useRef(null);
	const [map, setMap] = useState(null);
	useImperativeHandle(ref, () => map, [map]);
	useEffect(() => {
		let alive = true, m = null;
		Promise.resolve().then(() => create({ ...(options || {}), target: el.current })).then(mm => {
			if (!alive) { mm?.destroy?.(); return; }
			m = mm; setMap(mm); onLoad?.(mm);
		}, e => { if (alive) { if (onError) onError(e); else console.error(e); } });
		return () => { alive = false; m?.destroy?.(); setMap(null); };
	}, []);   // eslint-disable-line react-hooks/exhaustive-deps -- options は mount の 1 回だけ
	return h("div", { ref: el, className, style: { width: "100%", height: "100%", position: "relative", ...(style || {}) } },
		map ? h(GlobeContext.Provider, { value: map }, children) : null);
});

export const useGlobeEvent = (type, handler, layerId) => {
	const map = useGlobe(), fn = useRef(handler); fn.current = handler;
	useEffect(() => {
		if (!map || !type) return;
		const cb = e => fn.current?.(e);
		if (layerId != null) map.on(type, layerId, cb); else map.on(type, cb);
		return () => { if (layerId != null) map.off(type, layerId, cb); else map.off(type, cb); };
	}, [map, type, Array.isArray(layerId) ? layerId.join("\u0000") : layerId]);
};

export function Source({ id, children, ...spec }) {
	const map = useGlobe();
	const [ready, setReady] = useState(false);
	const first = useRef(true);
	useEffect(() => {
		if (!map) return;
		map.addSource(id, spec); setReady(true); first.current = true;
		return () => { setReady(false); try { map.removeSource(id); } catch { /* 層が先に消える順は React の unmount が保つ・destroy 済みは無視 */ } };
	}, [map, id, spec.type, spec.url, spec.tiles?.join?.()]);
	useEffect(() => {
		if (!map || !ready) return;
		if (first.current) { first.current = false; return; }
		if (spec.type === "geojson" && spec.data !== undefined) map.getSource(id)?.setData?.(spec.data);
	}, [map, ready, spec.data]);
	return ready ? h(SourceContext.Provider, { value: id }, children) : null;
}

export function Layer(props) {
	const map = useGlobe(), ctxSource = useContext(SourceContext);
	const spec = layerSpecOf(props, ctxSource), prev = useRef(null);
	const { id, beforeId } = props;
	const [gen, setGen] = useState(0);   // type/source が変わった時の作り直し
	useEffect(() => {
		if (!map) return;
		let alive = true;
		Promise.resolve(map.addLayer(spec, beforeId)).catch(e => console.error(e));
		prev.current = spec;
		return () => { alive = false; prev.current = null; try { map.removeLayer(id); } catch { /* destroy 済み */ } };
	}, [map, id, beforeId, gen]);
	useEffect(() => {
		if (!map || !prev.current || prev.current === spec) return;
		const r = syncLayer(map, id, prev.current, spec);
		if (r === "recreate") setGen(g => g + 1); else prev.current = spec;
	});
	return null;
}

export function Data(props) {
	const map = useGlobe();
	const { id, kind, data, acc } = splitDataProps(props);
	const hRef = useRef(null), last = useRef(null);
	useEffect(() => {
		if (!map) return;
		const hd = map.addData(data, { kind, id, ...acc });
		hRef.current = hd; last.current = { data, acc };
		return () => { hRef.current = null; last.current = null; try { hd.remove(); } catch { /* destroy 済み */ } };
	}, [map, id, kind]);
	useEffect(() => {
		const hd = hRef.current; if (!hd || !last.current) return;
		if (!shallowEqual(last.current.acc, acc)) hd.setProps(acc);
		if (last.current.data !== data) hd.setData(data);
		last.current = { data, acc };
	});
	return null;
}

export function Marker({ lngLat, altitude, draggable, onDragStart, onDrag, onDragEnd, onClick, children, ...opts }) {
	const map = useGlobe();
	const [el] = useState(() => (typeof document !== "undefined" ? document.createElement("div") : null));
	const mk = useRef(null), cbs = useRef({}); cbs.current = { onDragStart, onDrag, onDragEnd, onClick };
	useEffect(() => {
		if (!map || !el) return;
		const m = new map.Marker({ ...(children ? { element: el } : {}), ...opts, draggable: !!draggable, altitude }).setLngLat(lngLat).addTo(map);
		mk.current = m;
		const ds = e => cbs.current.onDragStart?.(e), dr = e => cbs.current.onDrag?.(e), de = e => cbs.current.onDragEnd?.({ ...e, lngLat: m.getLngLat() });
		m.on("dragstart", ds); m.on("drag", dr); m.on("dragend", de);
		const click = e => cbs.current.onClick?.(e); m.getElement().addEventListener("click", click);
		return () => { m.getElement().removeEventListener("click", click); m.remove(); mk.current = null; };
	}, [map, el, !!children, opts.color, opts.scale, opts.anchor]);
	useEffect(() => { mk.current?.setLngLat(lngLat); }, [lngLat?.[0] ?? lngLat?.lng, lngLat?.[1] ?? lngLat?.lat]);
	useEffect(() => { if (altitude != null) mk.current?.setAltitude(altitude); }, [altitude]);
	useEffect(() => { mk.current?.setDraggable(!!draggable); }, [draggable]);
	useEffect(() => { if (opts.offset) mk.current?.setOffset(opts.offset); }, [opts.offset?.[0], opts.offset?.[1]]);
	return children && el ? createPortal(children, el) : null;
}
