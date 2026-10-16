// geopbf → タイル用 GeoPBF（Gint 付き）の取得（maplibre のタイル protocol の共用部・2026-10-12）。
// fetch → 全体 gzip 透過 → noeval デコード → Gint を焼く（既定 pbf.gint()＝createGeopbf の Worker があればそこで、無ければ main の wasm）。
// 属性は MVT の tags になる（tiler.js propsToTags が JSON-safe に写す）ので GeoJSON 経路のサニタイズは要らない。
import { GeoPBF } from "../pbf-base.js";
import { isGzip, gunzip } from "./gzip.ts";

export interface FetchTilesOptions { signal?: AbortSignal; fetch?: (url: string, init?: RequestInit) => Promise<Response>; /** Gint を自前で焼く（既定＝pbf.gint() か main の wasm） */ bake?: (pbf: GeoPBF) => Promise<unknown> | unknown }

export async function fetchGeopbfTiles(innerUrl: string, { signal, fetch: fetchImpl, bake }: FetchTilesOptions = {}): Promise<GeoPBF> {
	const doFetch = fetchImpl || ((u: string, init?: RequestInit) => fetch(u, { cache: "default", ...init }));
	const res = await doFetch(innerUrl, { signal });
	if (!res.ok) throw new Error(`geopbf protocol: fetch failed (${res.status}) ${innerUrl}`);
	let blob = await res.blob();
	if (await isGzip(blob)) blob = await gunzip(blob);
	const pbf = await new GeoPBF({ worker: false }).set(await blob.arrayBuffer());   // FUNC は常にソース文字列（旧 { noeval: true } は 2.0 で唯一の挙動）
	if (bake) await bake(pbf);
	else if (typeof pbf.gint === "function") await pbf.gint();   // 本体（createGeopbf）が読まれていれば Worker で焼く
	else {   // geopbf/maplibre だけを読んだ頁＝main の wasm で焼く（Node は convert/node-gint の initGintWasm を先に）
		const [{ gint }, { topology }] = await Promise.all([import("../extension/gint.js"), import("../extension/topology.js")]);
		await gint.initialize();
		pbf._gintBuffer = topology(pbf);
	}
	if (!pbf._gintBuffer) throw new Error("geopbf protocol: Gint missing after bake");
	return pbf;
}
