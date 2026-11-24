// COG を「画像タイル層」と「地形（標高）」の口へ出す（共通化 段 1・2026-11-24）。
//   点群（COPC）と同じ流儀＝ヘッダ一発読み → 索引（TIFF の IFD・overview＝段）→ 要るタイルだけ HTTP Range（geopbf/cog/source＝COPC の worker と同じ口）。
//   画像：map.raster.add(id, { cog: URL }) → port プロバイダ（raster-src の契約 { id, z, x, y } → ImageBitmap）＝render worker の画像タイル層がそのまま描く
//   標高：map.setTerrain({ source: { type: "cog", url } }) → DemLoad（"cog://z/x/y" → { width, height, heights: Float32Array }）＝地形のセル・1 点の標高がそのまま引く
//   どちらも COG の元の座標系（平面直角など）から XYZ(3857) へ再標本化するのは geopbf/cog（画像＝pool worker の warpRGBA・標高＝main の warpFloat）。
//   GPU の共通化（タイルの池・点群からの標本化）は段 3（設計案 2026-11-24）。
// 遅延：使う時だけ dynamic import（geopbf/cog の pool も開いた時に作る）。
import { openCog } from "geopbf/cog";
import type { BrowserCog, BrowserCogOptions } from "geopbf/cog";
import { idbTileCache } from "./cog-idb.ts";

// 読んだタイルの端末キャッシュ（段 2＝COPC と同じ口）＝画像層と地形の COG で 1 つ（main・DB は cog の見比べ表示と分ける）
let sharedCache: ReturnType<typeof idbTileCache> | null = null;

const LONLAT = new Set([4326, 4258, 4269, 4612, 6668]);
const MERC_M = 156543.03392804097;   // z0 の 1 px（赤道・256 px タイル）

/** 開いた COG の自己申告（ズーム域・範囲） */
export interface CogTileInfo { tileSize: number; minZoom: number; maxZoom: number; bbox: number[]; gsdM: number; epsg: number; width: number; height: number }
export interface CogTiles {
	cog: BrowserCog; info: CogTileInfo;
	/** raster-src の port プロバイダとして答える（info を 1 通送ってから { id, z, x, y } に ImageBitmap） */
	serveRaster(port: MessagePort, meta?: { name?: string | null; attribution?: string | null; minZoom?: number; maxZoom?: number }): void;
	/** 地形の取得口（DemLoad）："cog://{z}/{x}/{y}" → 値のまま。範囲外・全部 NaN は null */
	demLoad(url: string): Promise<{ width: number; height: number; heights: Float32Array } | null>;
	close(): void;
}

// 画素の大きさ（m）→ そのくらいの細かさの XYZ のズーム（中心の緯度で）
const zoomFor = (m: number, lat: number) => Math.log2(MERC_M * Math.cos(lat * Math.PI / 180) / Math.max(m, 1e-6));

export async function openCogTiles(src: string | Blob, opts: BrowserCogOptions = {}): Promise<CogTiles> {
	sharedCache ??= idbTileCache(((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4 ? 128 << 20 : 512 << 20, "ortho-cog-tiles");
	const cog = await openCog(src, { cache: sharedCache, ...opts });
	const [w, s, e, n] = cog.bboxLL, lat = (s + n) / 2;
	const k = LONLAT.has(cog.epsg) ? 111320 : 1;   // 経緯度の COG は度→m（中心の緯度で十分）
	const fine = cog.overviews[0].resX * k, coarse = cog.overviews[cog.overviews.length - 1].resX * k;
	const info: CogTileInfo = {
		tileSize: 256,
		maxZoom: Math.max(0, Math.min(24, Math.ceil(zoomFor(fine, lat) - 0.25))),   // 元の画素が 1 px を少し割る所まで
		minZoom: Math.max(0, Math.floor(zoomFor(coarse, lat)) - 2),                  // 最粗の overview の 2 段下まで（それより引くと 1 タイルに広すぎる窓）
		bbox: [w, s, e, n], gsdM: fine, epsg: cog.epsg, width: cog.width, height: cog.height,
	};
	return {
		cog, info,
		serveRaster(port, meta = {}) {
			const acs = new Map<number, AbortController>();
			port.postMessage({ type: "info", info: { tileSize: 256, minZoom: meta.minZoom ?? info.minZoom, maxZoom: meta.maxZoom ?? info.maxZoom, bbox: info.bbox, attribution: meta.attribution ?? null, name: meta.name ?? null } });
			port.onmessage = async (ev: MessageEvent<{ id: number; z: number; x: number; y: number; abort?: boolean }>) => {
				const { id, z, x, y, abort } = ev.data || {} as { id: number; z: number; x: number; y: number; abort?: boolean };
				if (abort) { acs.get(id)?.abort(); acs.delete(id); return; }
				const ac = new AbortController(); acs.set(id, ac);
				try {
					const bitmap = await cog.renderXYZ(z, x, y, { format: "bitmap", signal: ac.signal }) as ImageBitmap | null;
					port.postMessage({ id, bitmap }, bitmap ? [bitmap] : []);
				} catch (err) { if (!ac.signal.aborted) port.postMessage({ id, bitmap: null, error: String((err as Error)?.message || err) }); }
				finally { acs.delete(id); }
			};
		},
		async demLoad(url) {
			const m = /(\d+)\/(\d+)\/(\d+)(?:\D*)$/.exec(url);
			if (!m) return null;
			const h = await cog.renderXYZFloat(+m[1], +m[2], +m[3], { size: 256 }).catch(() => null);
			if (!h) return null;
			for (let i = 0; i < h.length; i++) if (h[i] === h[i]) return { width: 256, height: 256, heights: h };
			return null;   // 全部 NaN＝そこに無い（XYZ の 404 と同じ）
		},
		close() { cog.close(); },
	};
}
