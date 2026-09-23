// ガジェット：記号帳（sprite）と記号の層（MapLibre の addImage／sprite／symbol 層の icon-image 相当・2026-09-21）。
//   記号帳＝名前→画像（pixelRatio・sdf）。map.addImage / map.loadSprite（sprite.json＋sprite.png・@2x）で足す＝記号を増やすのにコードを書かない。
//   記号の層＝点の地物に layout/paint の式で記号と文字を割り当てる（icon-image・icon-size・icon-rotate・icon-anchor・icon-offset・
//   icon-allow-overlap・icon-ignore-placement・icon-color（SDF）・icon-opacity・text-field・text-size・text-anchor・text-offset・text-color・
//   text-halo-color/width・text-opacity・text-allow-overlap・symbol-sort-key）。意味と既定値は MapLibre どおり。
//   描画は同一フレームの canvas2D オーバーレイ（symbols-2d.js）＝エンジン本体は触らない。式に ["zoom"] があれば止まるたびに評価し直す。
//   ⚠基図（地域パックのスタイル）の注記は従来どおりエンジンの注記層が描く＝ここは利用者の層のための記号帳。
import { symbolItems } from "./symbols-core.js";
import symUrl from "../symbols-2d.js?url";

export function createSymbols(map, { signal } = {}) {
	const images = new Map();   // name → { bitmap, pixelRatio, sdf }
	const layers = new Map();   // id → { src, layer, items, zoomDep }
	let ov = null, order = 0;
	const overlay = () => ov ??= map.overlay(symUrl, { name: "symbols" });
	const toBitmap = async src => {
		if (typeof src === "string") { const r = await fetch(src, { credentials: "omit" }); if (!r.ok) throw new Error(`HTTP ${r.status}`); src = await r.blob(); }
		if (src && !(src instanceof Blob) && src.data && src.width) src = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);   // { width, height, data }（MapLibre の addImage と同じ形）
		return createImageBitmap(src);
	};
	const send = (name, e) => createImageBitmap(e.bitmap).then(bm => overlay().post({ type: "image", name, bitmap: bm, pixelRatio: e.pixelRatio, sdf: e.sdf }, [bm]));
	const push = id => { const L = layers.get(id); if (!L) return; overlay().post({ type: "layer", id, items: L.items, order: L.order }); };
	const evalLayer = id => { const L = layers.get(id); if (!L) return; L.items = symbolItems(L.src, L.layer, map.getZoom(), images); push(id); };
	const onSettle = () => { for (const [id, L] of layers) if (L.zoomDep) evalLayer(id); };
	map.on("settle", onSettle);   // ["zoom"] を含む層は止まるたびに評価し直す（map.on は map を返す＝解除は map.off）
	const ctl = {
		async addImage(name, src, { pixelRatio = 1, sdf = false } = {}) {
			const e = { bitmap: await toBitmap(src), pixelRatio, sdf };
			images.set(name, e);
			await send(name, e);
			for (const [id, L] of layers) if (JSON.stringify(L.layer.layout || {}).includes(name)) evalLayer(id);   // その名前を待っていた層
			return e;
		},
		removeImage(name) { images.delete(name); ov?.post({ type: "removeImage", name }); },
		hasImage: name => images.has(name),
		getImage: name => images.get(name) || null,   // { bitmap, pixelRatio, sdf }（模様の層が使う）
		listImages: () => [...images.keys()],
		// sprite＝MapLibre の書式（base.json＋base.png、高解像度は base@2x.*）。戻り値＝足した名前の数
		async loadSprite(base) {
			base = String(base).replace(/\.(json|png)$/i, "");
			const hi = (devicePixelRatio || 1) > 1;
			const pick = async sfx => { const [j, p] = await Promise.all([fetch(`${base}${sfx}.json`, { credentials: "omit" }), fetch(`${base}${sfx}.png`, { credentials: "omit" })]); if (!j.ok || !p.ok) throw new Error(`sprite HTTP ${j.status}/${p.status}`); return [await j.json(), await createImageBitmap(await p.blob())]; };
			const [idx, sheet] = await (hi ? pick("@2x").catch(() => pick("")) : pick(""));
			const names = Object.keys(idx);
			await Promise.all(names.map(async n => {
				const s = idx[n];
				const e = { bitmap: await createImageBitmap(sheet, s.x, s.y, s.width, s.height), pixelRatio: s.pixelRatio || 1, sdf: !!s.sdf };
				images.set(n, e); await send(n, e);
			}));
			for (const id of layers.keys()) evalLayer(id);
			return names.length;
		},
		// 記号の層（src＝GeoJSON・layer＝{ id, layout, paint, filter, minzoom, maxzoom }）。同じ id は置き換え
		addLayer(id, src, layer) {
			const zoomDep = /"zoom"/.test(JSON.stringify([layer.layout, layer.paint, layer.filter]));
			layers.set(id, { src, layer, items: [], zoomDep, order: layers.get(id)?.order ?? order++ });
			evalLayer(id);
			return { features: layers.get(id).items.length };
		},
		removeLayer(id) { if (layers.delete(id)) ov?.post({ type: "removeLayer", id }); },
		setOrder(id, n) { const L = layers.get(id); if (!L || L.order === n) return; L.order = n; push(id); },   // 重ね順（map.moveLayer・#34）
		get layerIds() { return [...layers.keys()]; },
		// 画面 (x,y) の記号（問い合わせ用・当たりは記号の大きさ／文字は 12px 四方の近似）
		symbolsAt(x, y) {
			const out = [];
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
