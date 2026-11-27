// HEALPix のベクタタイル数枚を「結合済みの scene」にする（docs/design/healpix.md §6 の 3 段目＝決め打ちの数枚を地球に置く・2026-11-27）。
// 読み口（healpix-vt-src）→ 枠の合わせ（hpxToTileFrame）→ 組み立て（buildHpxTilePayload）→ 結合（mergeTiles）を 1 本にしただけ。
// タイル選び（視野・段の切り替え）は無い＝真ん中の 1 枚とその隣（最大 9 枚）を、頼まれた段で一度だけ取る。globe の ?hpxvt= がこれを呼び、"user" の枠へ流す。
import { lonLatToNest, hpxNeighbors, type HpxTile } from "./healpix.ts";
import { createHpxVtSource, type HpxVtSource } from "./healpix-vt-src.ts";
import { hpxToTileFrame, healpixGrid } from "./tilegrid.ts";
import { buildHpxTilePayload, type TilePayload } from "./tilepayload.ts";
import { mergeTiles, type MergedScene } from "./scene.ts";
import type { Style } from "./build.ts";
import type { DecodedTile } from "./tileformat.ts";

/** 焼いた層（bake-healpix-osm.mjs：water・roads・buildings）に合わせた、確かめ用の地味な style。色は下地（地形の色）の上で見分けが付く程度 */
export const HPX_OSM_TRIAL_STYLE: Style = { layers: [
	{ id: "hpx-water", type: "fill", "source-layer": "water", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#7fb2e5" } },
	{ id: "hpx-waterway", type: "line", "source-layer": "water", filter: ["==", ["geometry-type"], "LineString"], paint: { "line-color": "#7fb2e5", "line-width": 1.5 } },
	{ id: "hpx-buildings", type: "fill", "source-layer": "buildings", paint: { "fill-color": "#c9b8a6" } },
	{ id: "hpx-roads-minor", type: "line", "source-layer": "roads", filter: ["!", ["in", ["get", "kind"], ["literal", ["highway", "major_road", "rail"]]]], paint: { "line-color": "#ffffff", "line-width": 1.2 } },
	{ id: "hpx-roads-major", type: "line", "source-layer": "roads", filter: ["==", ["get", "kind"], "major_road"], paint: { "line-color": "#ffd24d", "line-width": 2.5 } },
	{ id: "hpx-roads-highway", type: "line", "source-layer": "roads", filter: ["==", ["get", "kind"], "highway"], paint: { "line-color": "#e8743b", "line-width": 3.5 } },
	{ id: "hpx-rail", type: "line", "source-layer": "roads", filter: ["==", ["get", "kind"], "rail"], paint: { "line-color": "#555555", "line-width": 1.5 } },
] };

export interface HpxVtSceneOptions {
	apiUrl?: string; source?: HpxVtSource;
	/** 段（Norder）。範囲の外は目録の最小・最大に寄せる */
	order: number;
	/** 真ん中のタイルを決める点 */
	lon: number; lat: number;
	/** 真ん中だけ（false）か、隣の 8 枚も（true・既定） */
	neighbors?: boolean;
	style?: Style;
	/** op の li に足す値（globe の利用者の層の帯＝vtops.USER_LI0）。層の順は style の並びのまま */
	li0?: number;
	signal?: AbortSignal | null;
}
export interface HpxVtSceneResult { scene: MergedScene; order: number; tiles: HpxTile[]; found: number; payloads: Map<number, TilePayload> }

/** 真ん中のタイルと隣を取って組み、1 つの scene に結合する。1 枚も無ければ scene.layers は空 */
export async function loadHpxVtScene({ apiUrl, source, order, lon, lat, neighbors = true, style = HPX_OSM_TRIAL_STYLE, li0 = 0, signal = null }: HpxVtSceneOptions): Promise<HpxVtSceneResult> {
	const src = source ?? createHpxVtSource({ apiUrl: apiUrl! }), idx = await src.index();
	const k = Math.max(idx.minOrder, Math.min(idx.maxOrder, Math.round(order))), home = lonLatToNest(lon, lat, k);
	const npixs = [...new Set([home, ...(neighbors ? hpxNeighbors(k, home).filter(n => n >= 0) : [])])];
	const payloads = new Map<number, TilePayload>();
	await Promise.all(npixs.map(async npix => {
		const data = await src.tile(k, npix, signal);
		if ((data as { __empty?: true }).__empty) return;
		const p = buildHpxTilePayload(hpxToTileFrame(data as DecodedTile), { order: k, npix }, style);
		if (li0) for (const op of p.dl.ops) op.li += li0;
		payloads.set(npix, p);
	}));
	// 結合の鍵は "z/x/y" の形で読まれる（子孫に覆われるタイルの線を伏せる判定）＝同じ z・別々の x にして、どれも「覆われない」にする
	const z = healpixGrid.styleZoom({ order: k, npix: home }), list = npixs.filter(n => payloads.has(n));
	const order_ = list.map((npix, i) => ({ key: `${z}/${i}/0`, origin: payloads.get(npix)!.origin, bld: "no" as const })), byKey = new Map(list.map((npix, i) => [`${z}/${i}/0`, payloads.get(npix)!]));
	const center = healpixGrid.center({ order: k, npix: home });
	const scene = mergeTiles(order_, key => { const p = byKey.get(key); return p ? { ops: p.dl.ops, buildings: null } : null; }, { origin: center });
	return { scene, order: k, tiles: npixs.map(npix => ({ order: k, npix })), found: list.length, payloads };
}
/** scene の配列の下の ArrayBuffer（worker へ transfer する分） */
export function hpxSceneBuffers(s: MergedScene): ArrayBuffer[] {
	const b = new Set<ArrayBuffer>();
	for (const L of s.layers) for (const v of Object.values(L)) if (ArrayBuffer.isView(v)) b.add(v.buffer as ArrayBuffer);
	return [...b];
}
