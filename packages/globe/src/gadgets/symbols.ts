// ガジェット：記号帳（sprite）と記号の層（MapLibre の addImage／sprite／symbol 層の icon-image 相当・2026-09-21）。
//   記号帳＝名前→画像（pixelRatio・sdf）。map.addImage / map.loadSprite（sprite.json＋sprite.png・@2x）で足す＝記号を増やすのにコードを書かない。
//   記号の層＝点の地物に layout/paint の式で記号と文字を割り当てる（icon-image・icon-size・icon-rotate・icon-anchor・icon-offset・
//   icon-allow-overlap・icon-ignore-placement・icon-color（SDF）・icon-opacity・text-field・text-size・text-anchor・text-offset・text-color・
//   text-halo-color/width・text-opacity・text-allow-overlap・symbol-sort-key）。意味と既定値は MapLibre どおり。
//   描画は同一フレームの canvas2D オーバーレイ（symbols-2d.js）＝エンジン本体は触らない。式に ["zoom"] があれば止まるたびに評価し直す。
//   ⚠基図（地域パックのスタイル）の注記は従来どおりエンジンの注記層が描く＝ここは利用者の層のための記号帳。
/// <reference path="../types/assets.d.ts" />   // ?url の型（この部品を型で引く他の包み＝equal 等にも届くように）
import { symbolItems } from "./symbols-core.ts";
import symUrl from "../symbols-2d.js?url";
import type { MLLayer } from "@ortho-earth/core";
import type { OverlayHandle } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";
import type { SymbolItem } from "./symbols-core.ts";

/** 記号帳の 1 枚（伸びる記号＝stretchX／stretchY／content は元の px） */
export interface SymbolImage {
	bitmap: ImageBitmap; pixelRatio: number; sdf: boolean;
	stretchX: Array<[number, number]> | null; stretchY: Array<[number, number]> | null; content: [number, number, number, number] | null;
}
export type SymbolImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData | Blob | string | { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export interface SymbolFeature {
	type: "Feature"; properties: Record<string, unknown>; geometry: { type: "Point"; coordinates: [number, number] }; layer: { id: string; type: "symbol" }; source: "symbols";
}
/** 記号帳（sprite）と記号の層 */
export interface Symbols {
	addImage(name: string, src: SymbolImageSource, o?: { pixelRatio?: number; sdf?: boolean; stretchX?: Array<[number, number]> | null; stretchY?: Array<[number, number]> | null; content?: [number, number, number, number] | null }): Promise<SymbolImage>;
	updateImage(name: string, src: SymbolImageSource): Promise<SymbolImage>;
	removeImage(name: string): void;
	hasImage(name: string): boolean;
	getImage(name: string): SymbolImage | null;
	listImages(): string[];
	/** MapLibre の sprite（base.json＋base.png・@2x）。prefix＝複数の sprite の id。戻り値＝足した名前の数 */
	loadSprite(base: string, prefix?: string): Promise<number>;
	addLayer(id: string, src: unknown, layer: Partial<MLLayer>): { features: number };
	removeLayer(id: string): void;
	setOrder(id: string, n: number): void;
	readonly layerIds: string[];
	symbolsAt(x: number, y: number): SymbolFeature[];
	destroy(): void;
}
/** 記号の層の 1 枚（src＝GeoJSON・items＝評価済みの記号・zoomDep＝止まるたびに評価し直す・missing＝記号帳に無かった名前） */
interface SymLayer { src: unknown; layer: Partial<MLLayer>; items: SymbolItem[]; zoomDep: boolean; order: number; missing?: Set<string> }
/** sprite の JSON の 1 項 */
interface SpriteEntry { x: number; y: number; width: number; height: number; pixelRatio?: number; sdf?: boolean; stretchX?: Array<[number, number]>; stretchY?: Array<[number, number]>; content?: [number, number, number, number] }

// onImage(name, e)／onImageRemoved(name)＝記号帳の写しの届け先（globe＝render worker の注記層 labels2d・基図/vector の symbol 層の icon-image が引く・段 3）
// onMissing(name)＝記号帳に無い名前（styleimagemissing）
export function createSymbols(map: GlobeMap, { signal, onImage = null, onImageRemoved = null, onMissing = null }: {
	signal?: AbortSignal; onImage?: ((name: string, e: SymbolImage) => unknown) | null; onImageRemoved?: ((name: string) => void) | null; onMissing?: ((name: string) => void) | null;
} = {}): Symbols {
	const images = new Map<string, SymbolImage>();   // name → { bitmap, pixelRatio, sdf }
	const layers = new Map<string, SymLayer>();   // id → { src, layer, items, zoomDep }
	let ov: OverlayHandle | null = null, order = 0;
	const overlay = () => ov ??= map.overlay(symUrl, { name: "symbols" });
	const toBitmap = async (src: SymbolImageSource) => {
		if (typeof src === "string") { const r = await (map.fetchResource ? map.fetchResource(src, "Image") : fetch(src, { credentials: "omit" })); if (!r.ok) throw new Error(`HTTP ${r.status}`); src = await r.blob(); }
		if (src && !(src instanceof Blob) && (src as { data?: unknown }).data && src.width) src = new ImageData(new Uint8ClampedArray((src as { data: Uint8Array | Uint8ClampedArray }).data), src.width, src.height);   // { width, height, data }（MapLibre の addImage と同じ形）
		return createImageBitmap(src as ImageBitmapSource);
	};
	const send = (name: string, e: SymbolImage) => { onImage?.(name, e); return createImageBitmap(e.bitmap).then(bm => overlay().post({ type: "image", name, bitmap: bm, pixelRatio: e.pixelRatio, sdf: e.sdf, stretchX: e.stretchX ?? null, stretchY: e.stretchY ?? null, content: e.content ?? null }, [bm])); };   // stretchX/Y・content＝伸びる記号
	const push = (id: string) => { const L = layers.get(id); if (!L) return; overlay().post({ type: "layer", id, items: L.items, order: L.order }); };
	const evalLayer = (id: string) => { const L = layers.get(id); if (!L) return; const miss = new Set<string>(); L.items = symbolItems(L.src, L.layer, map.getZoom(), images, miss, map.getGlobalState?.()); L.missing = miss; push(id); for (const n of miss) onMissing?.(n); };
	const onSettle = () => { for (const [id, L] of layers) if (L.zoomDep) evalLayer(id); };
	map.on("settle", onSettle);   // ["zoom"] を含む層は止まるたびに評価し直す（map.on は map を返す＝解除は map.off）
	const ctl: Symbols = {
		async addImage(name, src, { pixelRatio = 1, sdf = false, stretchX = null, stretchY = null, content = null } = {}) {
			const e: SymbolImage = { bitmap: await toBitmap(src), pixelRatio, sdf, stretchX, stretchY, content };   // 伸びる記号（MapLibre の stretchX／stretchY／content・元の px）
			images.set(name, e);
			await send(name, e);
			for (const [id, L] of layers) if (L.missing?.has(name) || JSON.stringify(L.layer.layout || {}).includes(name)) evalLayer(id);   // その名前を待っていた層（式で組んだ名前は missing で）
			return e;
		},
		// 画素だけ差し替える（MapLibre の updateImage・動く記号）＝層の評価し直しをしない軽い口。大きさが変わっても受ける（描く側が箱を組み直す）
		async updateImage(name, src) {
			const e = images.get(name); if (!e) return ctl.addImage(name, src);
			e.bitmap = await toBitmap(src);   // 古い絵は閉じない＝render worker 宛の写し（onImage の createImageBitmap）が並行して読んでいる
			await send(name, e);
			return e;
		},
		removeImage(name) { images.delete(name); ov?.post({ type: "removeImage", name }); onImageRemoved?.(name); },
		hasImage: (name: string) => images.has(name),
		getImage: (name: string) => images.get(name) || null,   // { bitmap, pixelRatio, sdf }（模様の層が使う）
		listImages: () => [...images.keys()],
		// sprite＝MapLibre の書式（base.json＋base.png、高解像度は base@2x.*）。戻り値＝足した名前の数
		async loadSprite(base, prefix = "") {   // prefix＝複数の sprite の id（MapLibre v4＝"id:名前"・default は空）
			base = String(base).replace(/\.(json|png)$/i, "");
			const hi = (devicePixelRatio || 1) > 1;
			const get = (u: string, type: "SpriteJSON" | "SpriteImage") => map.fetchResource ? map.fetchResource(u, type) : fetch(u, { credentials: "omit" });   // transformRequest / addProtocol（#37）
			const pick = async (sfx: string): Promise<[Record<string, SpriteEntry>, ImageBitmap]> => { const [j, p] = await Promise.all([get(`${base}${sfx}.json`, "SpriteJSON"), get(`${base}${sfx}.png`, "SpriteImage")]); if (!j.ok || !p.ok) throw new Error(`sprite HTTP ${j.status}/${p.status}`); return [await j.json(), await createImageBitmap(await p.blob())]; };
			const [idx, sheet] = await (hi ? pick("@2x").catch(() => pick("")) : pick(""));
			const names = Object.keys(idx);
			await Promise.all(names.map(async n => {
				const s = idx[n];
				const e: SymbolImage = { bitmap: await createImageBitmap(sheet, s.x, s.y, s.width, s.height), pixelRatio: s.pixelRatio || 1, sdf: !!s.sdf, stretchX: s.stretchX ?? null, stretchY: s.stretchY ?? null, content: s.content ?? null };   // sprite の JSON も伸びる記号の申告を持つ
				images.set(prefix + n, e); await send(prefix + n, e);
			}));
			for (const id of layers.keys()) evalLayer(id);
			return names.length;
		},
		// 記号の層（src＝GeoJSON・layer＝{ id, layout, paint, filter, minzoom, maxzoom }）。同じ id は置き換え
		addLayer(id, src, layer) {
			const zoomDep = /"zoom"/.test(JSON.stringify([layer.layout, layer.paint, layer.filter])) || layer.minzoom != null || layer.maxzoom != null;   // 出しズームだけの層も止まるたびに当て直す（段 5・台帳 R17）
			layers.set(id, { src, layer, items: [], zoomDep, order: layers.get(id)?.order ?? order++ });
			evalLayer(id);
			return { features: layers.get(id)!.items.length };
		},
		removeLayer(id) { if (layers.delete(id)) ov?.post({ type: "removeLayer", id }); },
		setOrder(id, n) { const L = layers.get(id); if (!L || L.order === n) return; L.order = n; push(id); },   // 重ね順（map.moveLayer・#34）
		get layerIds() { return [...layers.keys()]; },
		// 画面 (x,y) の記号（問い合わせ用・当たりは記号の大きさ／文字は 12px 四方の近似）
		symbolsAt(x, y) {
			const out: SymbolFeature[] = [];
			for (const [id, L] of [...layers].reverse()) for (const it of L.items) {
				const p = map.projectLL(it.lon, it.lat); if (p[2] < 0) continue;
				const im = it.icon && images.get(it.icon), r = im ? Math.max(im.bitmap.width, im.bitmap.height) / im.pixelRatio * it.size / 2 : 8;
				if (Math.hypot(p[0] - x, p[1] - y) <= r + 2) out.push({ type: "Feature", properties: it.props, geometry: { type: "Point", coordinates: [it.lon, it.lat] }, layer: { id, type: "symbol" }, source: "symbols" });
			}
			return out;
		},
		destroy() { layers.clear(); images.clear(); map.off("settle", onSettle); ov?.remove(); ov = null; },
	};
	signal?.addEventListener("abort", () => ctl.destroy(), { once: true });
	return ctl;
}
