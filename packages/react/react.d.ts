// @ortho-earth/react の型（F9・2026-10-12）
import type { ReactNode, CSSProperties, ForwardRefExoticComponent, RefAttributes, Context } from "react";
import type { OrthoJapanMap, OrthoJapanOptions, MapLibreSource, MapLibreLayer, MarkerOptions, LonLat } from "@ortho-earth/globe";

export interface GlobeProps {
	/** createGlobe の options（target は <Globe> が足す）。mount の 1 回だけ読む */ options?: Omit<OrthoJapanOptions, "target">;
	style?: CSSProperties; className?: string;
	/** map ができた時（children はこの後に描かれる） */ onLoad?: (map: OrthoJapanMap) => void;
	onError?: (e: unknown) => void;
	/** 検定・差し替え用＝createGlobe の代わり */ create?: (opts: OrthoJapanOptions) => Promise<OrthoJapanMap> | OrthoJapanMap;
	children?: ReactNode;
}
/** 地球儀を 1 つ描く。ref は map（できる前は null） */
export const Globe: ForwardRefExoticComponent<GlobeProps & RefAttributes<OrthoJapanMap | null>>;
export const GlobeContext: Context<OrthoJapanMap | null>;
export const SourceContext: Context<string | null>;
/** 親の <Globe> の map（できる前は null） */
export function useGlobe(): OrthoJapanMap | null;
/** map.on(type[, layerId], handler)／off を mount/unmount で。handler は ref＝描き直しで付け替えない */
export function useGlobeEvent(type: string, handler: (e: any) => void, layerId?: string | string[]): void;

export type SourceProps = MapLibreSource & { id: string; children?: ReactNode };
/** addSource／removeSource。geojson の data が変わると setData。子の <Layer> は source を省ける */
export function Source(props: SourceProps): ReactNode;

export type LayerProps = MapLibreLayer & { id: string; beforeId?: string; source?: string };
/** addLayer／removeLayer。paint/layout は鍵ごとに set*Property・filter・minzoom/maxzoom も追う。type/source/source-layer が変わると作り直し */
export function Layer(props: LayerProps): null;

export interface DataProps { id?: string; kind?: string; data: unknown; [accessor: string]: unknown }
/** map.addData（builtin の kind と plugin の kind）。data が変わると setData、accessor が変わると setProps、unmount で remove */
export function Data(props: DataProps): null;

export type MarkerProps = Omit<MarkerOptions, "element" | "draggable" | "altitude"> & {
	lngLat: LonLat | { lng: number; lat: number }; altitude?: number; draggable?: boolean;
	onDragStart?: (e: any) => void; onDrag?: (e: any) => void; onDragEnd?: (e: { lngLat: { lng: number; lat: number } | null }) => void; onClick?: (e: MouseEvent) => void;
	/** あれば marker の要素の中身（createPortal）。無ければ既定のピン */ children?: ReactNode;
};
/** DOM の Marker（map.Marker）。lngLat/altitude/draggable/offset の変化を追う */
export function Marker(props: MarkerProps): ReactNode;

export function shallowEqual(a: unknown, b: unknown): boolean;
export function diffProps(prev?: Record<string, unknown>, next?: Record<string, unknown>): Record<string, unknown>;
export function syncLayer(map: OrthoJapanMap, id: string, prev: MapLibreLayer, next: MapLibreLayer): "recreate" | string[];
export function layerSpecOf(props: LayerProps, ctxSource: string | null): MapLibreLayer;
export function splitDataProps(props: DataProps): { id?: string; kind?: string; data: unknown; acc: Record<string, unknown> };
