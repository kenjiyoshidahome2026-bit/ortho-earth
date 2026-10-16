// @ortho-earth/react（第 2 波 F9・2026-10-12）＝@ortho-earth/globe の React 束ね。JSX は使わない（createElement）＝束ねる側の JSX runtime に依らない
//   <Globe options onLoad ref>…</Globe>：div を 1 つ描き、mount で createGlobe({ ...options, target }) を 1 回。子は map ができてから（GlobeContext）。unmount で destroy
//   useGlobe()：map（できる前は null）。useGlobeEvent(type, handler, layerId?)：map.on/off（handler は ref＝描き直しで付け替えない）
//   <Source id {...spec}>…</Source>：addSource／removeSource、geojson の data が変わると getSource(id).setData。子の <Layer> は source を省ける
//   <Layer id type source beforeId paint layout filter minzoom maxzoom>：addLayer／removeLayer、paint/layout は鍵ごとに set*Property、filter・zoom 範囲も追う。type/source が変わると作り直し
//   <Data kind data {...accessors} id>：map.addData（points/arcs/trips/polygons/paths/columns と plugin の kind）、data が変われば setData・accessor が変われば setProps、unmount で remove
//   <Marker lngLat altitude draggable onDragEnd {...MarkerOptions}>子</Marker>：map.Marker（DOM）・子は createPortal で marker の要素へ
//   options は mount の 1 回だけ読む（MapLibre の react 束ねと同じ流儀）。視点は map の jumpTo/easeTo を useGlobe() で直接呼ぶ
import { createElement as h, createContext, useContext, useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import type { ReactNode, CSSProperties, ForwardRefExoticComponent, RefAttributes, Context } from "react";
import { createPortal } from "react-dom";
import type { GlobeMap, OrthoJapanOptions, MapLibreSource, MarkerOptions, LonLat, DataLayerHandle, Marker as GlobeMarker } from "@ortho-earth/globe";
// @ortho-earth/globe は mount の時に動的 import（CSS を import する本体を SSR・node の検定へ持ち込まない・束ねる側の code splitting にも乗る）
const defaultCreate = (opts: OrthoJapanOptions): Promise<GlobeMap> => import("@ortho-earth/globe").then(m => m.createGlobe(opts));
import { shallowEqual, syncLayer, layerSpecOf, splitDataProps } from "./sync.ts";
import type { LayerProps, DataProps } from "./sync.ts";
export { shallowEqual, diffProps, syncLayer, layerSpecOf, splitDataProps } from "./sync.ts";
export type { LayerProps, DataProps, LayerSyncMap } from "./sync.ts";

// ---- 公開の型 ----
export interface GlobeProps {
	/** createGlobe の options（target は <Globe> が足す）。mount の 1 回だけ読む */ options?: Omit<OrthoJapanOptions, "target">;
	style?: CSSProperties; className?: string;
	/** map ができた時（children はこの後に描かれる） */ onLoad?: (map: GlobeMap) => void;
	onError?: (e: unknown) => void;
	/** 検定・差し替え用＝createGlobe の代わり */ create?: (opts: OrthoJapanOptions) => Promise<GlobeMap> | GlobeMap;
	children?: ReactNode;
}
export type SourceProps = MapLibreSource & { id: string; children?: ReactNode };
export type MarkerLngLat = LonLat | { lng: number; lat: number };
export type MarkerProps = Omit<MarkerOptions, "element" | "draggable" | "altitude"> & {
	lngLat: MarkerLngLat; altitude?: number; draggable?: boolean;
	onDragStart?: (e: any) => void; onDrag?: (e: any) => void; onDragEnd?: (e: { lngLat: { lng: number; lat: number } | null }) => void; onClick?: (e: MouseEvent) => void;
	/** あれば marker の要素の中身（createPortal）。無ければ既定のピン */ children?: ReactNode;
};
// map.on/off の総称の口（useGlobeEvent は type を文字列で受ける＝globe の個別の overload を通さない）
interface GenericEvents { on(ev: string, ...args: unknown[]): unknown; off(ev: string, ...args: unknown[]): unknown }

export const GlobeContext: Context<GlobeMap | null> = createContext<GlobeMap | null>(null);
export const SourceContext: Context<string | null> = createContext<string | null>(null);
/** 親の <Globe> の map（できる前は null） */
export const useGlobe = (): GlobeMap | null => useContext(GlobeContext);

/** 地球儀を 1 つ描く。ref は map（できる前は null） */
export const Globe: ForwardRefExoticComponent<GlobeProps & RefAttributes<GlobeMap | null>> = forwardRef<GlobeMap | null, GlobeProps>(function Globe({ options, style, className, onLoad, onError, create = defaultCreate, children }, ref) {
	const el = useRef<HTMLDivElement | null>(null);
	const [map, setMap] = useState<GlobeMap | null>(null);
	useImperativeHandle<GlobeMap | null, GlobeMap | null>(ref, () => map, [map]);
	useEffect(() => {
		let alive = true, m: GlobeMap | null = null;
		Promise.resolve().then(() => create({ ...(options || {}), target: el.current as HTMLElement })).then(mm => {
			if (!alive) { mm?.destroy?.(); return; }
			m = mm; setMap(mm); onLoad?.(mm);
		}, (e: unknown) => { if (alive) { if (onError) onError(e); else console.error(e); } });
		return () => { alive = false; m?.destroy?.(); setMap(null); };
	}, []);   // eslint-disable-line react-hooks/exhaustive-deps -- options は mount の 1 回だけ
	return h("div", { ref: el, className, style: { width: "100%", height: "100%", position: "relative", ...(style || {}) } },
		map ? h(GlobeContext.Provider, { value: map }, children) : null);
});

/** map.on(type[, layerId], handler)／off を mount/unmount で。handler は ref＝描き直しで付け替えない */
export const useGlobeEvent = (type: string, handler: (e: any) => void, layerId?: string | string[]): void => {
	const map = useGlobe(), fn = useRef(handler); fn.current = handler;
	useEffect(() => {
		if (!map || !type) return;
		const ev = map as unknown as GenericEvents, cb = (e: unknown): void => fn.current?.(e);
		if (layerId != null) ev.on(type, layerId, cb); else ev.on(type, cb);
		return () => { if (layerId != null) ev.off(type, layerId, cb); else ev.off(type, cb); };
	}, [map, type, Array.isArray(layerId) ? layerId.join("\u0000") : layerId]);
};

/** addSource／removeSource。geojson の data が変わると setData。子の <Layer> は source を省ける */
export function Source({ id, children, ...spec }: SourceProps): ReactNode {
	const map = useGlobe();
	const [ready, setReady] = useState(false);
	const first = useRef(true);
	const loose = spec as { url?: string; tiles?: string[] };   // url／tiles は raster・vector だけ（依存の鍵）
	useEffect(() => {
		if (!map) return;
		map.addSource(id, spec); setReady(true); first.current = true;
		return () => { setReady(false); try { map.removeSource(id); } catch { /* 層が先に消える順は React の unmount が保つ・destroy 済みは無視 */ } };
	}, [map, id, spec.type, loose.url, loose.tiles?.join?.()]);
	useEffect(() => {
		if (!map || !ready) return;
		if (first.current) { first.current = false; return; }
		if (spec.type === "geojson" && spec.data !== undefined) map.getSource(id)?.setData?.(spec.data);
	}, [map, ready, (spec as { data?: unknown }).data]);
	return ready ? h(SourceContext.Provider, { value: id }, children) : null;
}

/** addLayer／removeLayer。paint/layout は鍵ごとに set*Property・filter・minzoom/maxzoom も追う。type/source/source-layer が変わると作り直し */
export function Layer(props: LayerProps): null {
	const map = useGlobe(), ctxSource = useContext(SourceContext);
	const spec = layerSpecOf(props, ctxSource), prev = useRef<ReturnType<typeof layerSpecOf> | null>(null);
	const { id, beforeId } = props;
	const [gen, setGen] = useState(0);   // type/source が変わった時の作り直し
	useEffect(() => {
		if (!map) return;
		let alive = true;
		Promise.resolve(map.addLayer(spec, beforeId)).catch((e: unknown) => console.error(e));
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

/** map.addData（builtin の kind と plugin の kind）。data が変わると setData、accessor が変わると setProps、unmount で remove */
export function Data(props: DataProps): null {
	const map = useGlobe();
	const { id, kind, data, acc } = splitDataProps(props);
	const hRef = useRef<DataLayerHandle | null>(null), last = useRef<{ data: unknown; acc: Record<string, unknown> } | null>(null);
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

type MarkerCallbacks = Pick<MarkerProps, "onDragStart" | "onDrag" | "onDragEnd" | "onClick">;
const lngOf = (ll: MarkerLngLat | null | undefined): number | undefined => ll == null ? undefined : Array.isArray(ll) ? ll[0] : ll.lng;
const latOf = (ll: MarkerLngLat | null | undefined): number | undefined => ll == null ? undefined : Array.isArray(ll) ? ll[1] : ll.lat;
/** DOM の Marker（map.Marker）。lngLat/altitude/draggable/offset の変化を追う */
export function Marker({ lngLat, altitude, draggable, onDragStart, onDrag, onDragEnd, onClick, children, ...opts }: MarkerProps): ReactNode {
	const map = useGlobe();
	const [el] = useState<HTMLDivElement | null>(() => (typeof document !== "undefined" ? document.createElement("div") : null));
	const mk = useRef<GlobeMarker | null>(null), cbs = useRef<MarkerCallbacks>({}); cbs.current = { onDragStart, onDrag, onDragEnd, onClick };
	useEffect(() => {
		if (!map || !el) return;
		const m = new map.Marker({ ...(children ? { element: el } : {}), ...opts, draggable: !!draggable, altitude }).setLngLat(lngLat).addTo(map);
		mk.current = m;
		const ds = (e: unknown): void => cbs.current.onDragStart?.(e), dr = (e: unknown): void => cbs.current.onDrag?.(e), de = (e: object): void => cbs.current.onDragEnd?.({ ...e, lngLat: m.getLngLat() });
		m.on("dragstart", ds); m.on("drag", dr); m.on("dragend", de);
		const click = (e: MouseEvent): void => cbs.current.onClick?.(e); m.getElement().addEventListener("click", click);
		return () => { m.getElement().removeEventListener("click", click); m.remove(); mk.current = null; };
	}, [map, el, !!children, opts.color, opts.scale, opts.anchor]);
	useEffect(() => { mk.current?.setLngLat(lngLat); }, [lngOf(lngLat), latOf(lngLat)]);
	useEffect(() => { if (altitude != null) mk.current?.setAltitude(altitude); }, [altitude]);
	useEffect(() => { mk.current?.setDraggable(!!draggable); }, [draggable]);
	useEffect(() => { if (opts.offset) mk.current?.setOffset(opts.offset); }, [opts.offset?.[0], opts.offset?.[1]]);
	return children && el ? createPortal(children, el) : null;
}
