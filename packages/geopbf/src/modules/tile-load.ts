// geopbf → タイル用 GeoPBF（Gint 付き）の取得（maplibre のタイル protocol の共用部・2026-10-12）。
// fetch → 全体 gzip 透過 → noeval デコード → Gint を焼く（既定 pbf.gint()＝createGeopbf の Worker があればそこで、無ければ main の wasm）。
// 属性は MVT の tags になる（tiler.js propsToTags が JSON-safe に写す）ので GeoJSON 経路のサニタイズは要らない。
import { GeoPBFBase } from "../pbf-base.ts";
import type { GeoPBF } from "../pbf.ts";
import { isGzip, gunzip } from "./gzip.ts";

// 入口（index.ts）が読まれていれば、その GeoPBF（gint() を持つ）でタイルを作る（段 4・2026-10-16）。
// 旧＝index.js が gint() を器の class へ後付けしていた＝typeof pbf.gint で見分けた。class を分けたので入口が自分の class をここへ届ける（import すると worker の閉包へ入口が載る）
let EntryClass: (new (options?: { worker?: boolean }) => GeoPBF) | null = null;
/** @internal index.ts が呼ぶ */
export function useEntryClass(C: new (options?: { worker?: boolean }) => GeoPBF): void { EntryClass = C; }

export interface FetchTilesOptions { signal?: AbortSignal; fetch?: (url: string, init?: RequestInit) => Promise<Response>; /** Gint を自前で焼く（既定＝pbf.gint() か main の wasm） */ bake?: (pbf: GeoPBFBase) => Promise<unknown> | unknown }

export async function fetchGeopbfTiles(innerUrl: string, { signal, fetch: fetchImpl, bake }: FetchTilesOptions = {}): Promise<GeoPBFBase> {
	const doFetch = fetchImpl || ((u: string, init?: RequestInit) => fetch(u, { cache: "default", ...init }));
	const res = await doFetch(innerUrl, { signal });
	if (!res.ok) throw new Error(`geopbf protocol: fetch failed (${res.status}) ${innerUrl}`);
	let blob = await res.blob();
	if (await isGzip(blob)) blob = await gunzip(blob);
	const pbf: GeoPBFBase = await new (EntryClass || GeoPBFBase)({ worker: false }).set(await blob.arrayBuffer());   // FUNC は常にソース文字列（旧 { noeval: true } は 2.0 で唯一の挙動）
	if (bake) await bake(pbf);
	else if (EntryClass && pbf instanceof EntryClass) await pbf.gint();   // 本体（createGeopbf）が読まれていれば Worker で焼く
	else {   // geopbf/maplibre だけを読んだ頁＝main の wasm で焼く（Node は convert/node-gint の initGintWasm を先に）
		const [{ gint }, { topology }] = await Promise.all([import("../extension/gint.ts"), import("../extension/topology.ts")]);
		await gint.initialize();
		pbf._gintBuffer = topology(pbf);
	}
	if (!pbf._gintBuffer) throw new Error("geopbf protocol: Gint missing after bake");
	return pbf;
}
