/**
 * geoExec — Common pipeline for GIS data loading and preview generation.
 *
 * @param info  - { target, name, precision, license, description, attribution, link, nocache, format }
 * @param opts
 * @param opts.geopbf     - geopbf() function (dependency-injected)
 * @param [opts.logger]   - screenLogger instance (optional)
 * @param [opts.cache]    - IDB cache function (key, value?) → value (optional)
 * @param [opts.onSuccess]- callback(pbf, { previewCanvas, profileHtml, logger })
 * @param [opts.onError]  - callback(err, { logger, info })
 */
import type { screenLogger, LogLine } from "./screenLogger.ts";

/** 読む物の記述（target＝URL か File・crs＝.prj の無い Shapefile の座標系） */
export interface GeoExecInfo {
	target?: string | File | Blob; name?: string; precision?: number; license?: string; description?: string;
	attribution?: string; link?: string; nocache?: boolean; format?: string; crs?: string | number | null;
}
/** 注入される geopbf() の返り＝ここで使う口だけ（型の正本は geopbf の GeoPBF） */
export interface GeoExecPbf {
	readonly length: number;
	readonly size?: unknown;
	preview(canvas: HTMLCanvasElement, props: Record<string, unknown>): Promise<unknown>;
	profile(opts: Record<string, unknown>): Promise<unknown>;
}
/** IDB の控え（key）＝読む・（key, value）＝書く */
export type GeoExecCache = (key: string, value?: { PREVIEW: Blob; PROFILE: unknown }) => Promise<unknown>;
interface CachedPreview { PREVIEW?: Blob; PROFILE?: unknown }
export interface GeoExecContext { previewCanvas: HTMLCanvasElement | null; profileHtml: unknown; logger: screenLogger | null | undefined }
export interface GeoExecOpts {
	geopbf: (target: unknown, opts: Record<string, unknown>) => Promise<GeoExecPbf | null | undefined>;
	logger?: screenLogger | null;
	cache?: GeoExecCache | null;
	onSuccess?: (pbf: GeoExecPbf, ctx: GeoExecContext) => unknown;
	onError?: (err: Error, ctx: { logger: screenLogger | null | undefined; info: GeoExecInfo }) => unknown;
}
// URL の %E5%8D%83… を読める字に戻す（表示専用・壊れた符号はそのまま）
const readable = (s: unknown): string => { try { return decodeURI(String(s ?? "")); } catch { return String(s ?? ""); } };

export async function geoExec(info: GeoExecInfo, { geopbf, logger, cache = null, onSuccess, onError }: GeoExecOpts = {} as GeoExecOpts): Promise<void> {
	const def = { target:"", name:"", precision:6, license:"", description:"", attribution:"", link:"", nocache:false, format:"", crs:null };
	const { target, name, precision, license, description, attribution, link, nocache, format, crs } =
		Object.assign({}, def, info) as Required<GeoExecInfo>;   // crs＝.prj の無い Shapefile の座標系（EPSG 番号か WKT）＝geopbf へ素通し

	try {
		logger?.clear().show();
		let inExec = true;

		let p: LogLine | undefined = logger?.title(name, description);
		if (p && link) p.style("cursor","pointer").on("click", () => open(link, "_link_"));

		const cacheKey = typeof target === 'string' ? target
			: (target instanceof File
				? `FILE::${target.name}::${target.size}::${target.lastModified}`
				: null);
		const cached: CachedPreview | null = cacheKey && !nocache && cache ? await cache(cacheKey).catch(() => null) as CachedPreview | null : null;

		const shown = readable((target as Partial<File>).name || target).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");   // %E5… を読める字で・html へ流すのでエスケープ
		p = logger?.log(`Requesting: ${shown} <span class="cancel">cancel</span>`);
		const cancel = p?.select?.("span").hide().on("click", () => location.reload());
		setTimeout(() => inExec && cancel?.show?.(), 1000);

		const pbf = await geopbf(target, { name, precision, license, description, attribution, nocache, format, ...(crs ? { crs } : {}) });

		inExec = false;
		cancel?.hide?.();

		if (!pbf?.length) {
			logger?.error("Failed to load data.");
			await onError?.(new Error("Empty data"), { logger, info });
			return;
		}

		logger?.success(`${name} (length: ${pbf.size})`);

		let previewCanvas: HTMLCanvasElement | null = null, profileHtml: unknown = null;

		if (cached?.PREVIEW && cached?.PROFILE) {
			profileHtml = cached.PROFILE;
			const bitmap = await createImageBitmap(cached.PREVIEW);
			previewCanvas = document.createElement("canvas");
			previewCanvas.width  = bitmap.width;
			previewCanvas.height = bitmap.height;
			previewCanvas.style.width  = (bitmap.width  / 2) + "px";
			previewCanvas.style.height = (bitmap.height / 2) + "px";
			previewCanvas.getContext("2d", { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
			trimCanvas(previewCanvas);
		} else {
			previewCanvas = document.createElement("canvas");
			previewCanvas.getContext("2d", { willReadFrequently: true }); // pre-warm so pbf.preview's internal getContext inherits the flag
			const [bitmap, html] = await Promise.all([
				pbf.preview(previewCanvas, { size:256, stroke:"#fff", fill:"#222", minDist:0.5, dpr:2 }),
				pbf.profile({ nohead: true }),
			]);
			profileHtml = html;

			if (cacheKey && cache && bitmap instanceof ImageBitmap) {
				const oc = new OffscreenCanvas(previewCanvas.width, previewCanvas.height);
				oc.getContext("2d")!.drawImage(previewCanvas, 0, 0);
				oc.convertToBlob({ type:'image/png', quality:0.9 }).then(blob =>
					cache(cacheKey, { PREVIEW: blob, PROFILE: profileHtml }).catch(console.error)
				);
			}
			trimCanvas(previewCanvas);
		}

		if (logger) {
			const p = logger.empty();
			p.node()!.appendChild(previewCanvas);
			logger.log(profileHtml);
		}

		await onSuccess?.(pbf, { previewCanvas, profileHtml, logger });

	} catch (err) {
		logger?.error(`Failed to load ${(target as Partial<File> | undefined)?.name || target}: ${(err as Error).message}`);
		await onError?.(err as Error, { logger, info });
	}
}

export function trimCanvas(canvas: HTMLCanvasElement): void {
	const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
	const w = canvas.width, h = canvas.height;
	const px = ctx.getImageData(0, 0, w, h).data;
	const row = (y: number): boolean | undefined => { for (let x = 0; x < w; x++) if (px[(y*w+x)*4+3]) return true; };
	let t = 0, b = h - 1;
	while (t < h && !row(t)) t++;
	if (t >= h) return;
	while (b > t && !row(b)) b--;
	if (t === 0 && b === h - 1) return;
	const dpr = w / parseFloat(canvas.style.width);
	const trimH = b - t + 1;
	const img = ctx.getImageData(0, t, w, trimH);
	canvas.height = trimH;
	ctx.putImageData(img, 0, 0);
	canvas.style.height = (trimH / dpr) + "px";
}
