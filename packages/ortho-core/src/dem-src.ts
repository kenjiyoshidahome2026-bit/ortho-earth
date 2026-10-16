// 外来の標高タイル（MapLibre の raster-dem 相当・#36・2026-09-23）＝XYZ の標高 PNG/WebP から標高を読む。
//   spec＝{ tiles:[型紙] , encoding:"terrarium"|"mapbox"|"gsi", tileSize:256, minzoom:0, maxzoom:14, bounds:[w,s,e,n]|null, dtm:false, cellZoom? }
//     encoding：terrarium＝(R×256+G+B/256)−32768／mapbox＝−10000+(R×65536+G×256+B)×0.1／gsi＝地理院 PNG 標高タイル（x＝R×65536+G×256+B・2^23＝無効・負は 2^24 を引く・×0.01m）
//     dtm：true＝裸地（DTM）の申告＝その範囲で建物を地面へ持ち上げてよい（表層 DSM なら false）
// 使い方は二つ：
//   cell(lng0, lat0, range) … 1° セル（R01）／10° セル（R10）の標高格子＝altpbf のタイルと同じ形 { data, width, height, lng, lat, range }（row0＝北・格子点）。
//                        地形のアトラスはこれを 1°あたり最大 1024 px に間引いて載せる＝見た目の細かさは約 100m 格子のまま。
//   height(lon, lat)   … 1 点の標高＝DEM の最大ズームのタイルを直に読む（建物の接地・断面図・計測・日影に効く＝「より細かい」の本体）。
// 無効値（海・範囲外・取れなかったタイル）は NaN。呼び手（terrain）は NaN の所だけ既定の標高を残す。
// worker でも main でも動く（fetch・createImageBitmap・OffscreenCanvas のみ）。
import { createQmeshSource } from "./qmesh-src.ts";   // quantized-mesh（#110）＝同じ 4 つの口のソース（type:"quantized-mesh" で振り分け）
import type { QmeshSpec, QmeshSpecInput } from "./qmesh-src.ts";

export type DemEncoding = "terrarium" | "mapbox" | "gsi" | "custom";
/** encoding custom の係数（MapLibre の raster-dem） */
export interface DemFactors { redFactor?: number; greenFactor?: number; blueFactor?: number; baseShift?: number }
/** 利用者が書く spec（raster-dem） */
export interface DemSpecInput extends DemFactors { type?: string; tiles?: string[]; url?: string; encoding?: DemEncoding | string; tileSize?: number | null; minzoom?: number; maxzoom?: number; bounds?: number[] | null; dtm?: boolean; cellZoom?: number | null; headers?: Record<string, string> | null; credentials?: RequestCredentials; [k: string]: unknown }
/** 整えた spec（normalizeDemSpec の戻り） */
export interface DemSpec { tiles: string[]; encoding: string; tileSize: number; minzoom: number; maxzoom: number; bounds: number[] | null; dtm: boolean; cellZoom: number | null; headers: Record<string, string> | null; credentials: RequestCredentials; redFactor: number; greenFactor: number; blueFactor: number; baseShift: number }
/** セルの標高格子（altpbf のタイルと同じ形＋出所と有効率） */
export interface DemCell { data: Float32Array; width: number; height: number; lng: number; lat: number; range: number; source: string; valid: number }
/** 標高ソースの 4 つの口（raster-dem と quantized-mesh で共通） */
export interface DemSource { spec: DemSpec | QmeshSpec; ready?: Promise<unknown>; covers(lng0: number, lat0: number, range?: number): boolean; height(lon: number, lat: number, zHint?: number | null): Promise<number>; cell(lng0: number, lat0: number, range?: number, N?: number): Promise<DemCell | null>; tileSpan?: (z: number) => number }
interface DemTile { h: Float32Array; n: number }

const lon2x = (lon: number, z: number): number => (lon + 180) / 360 * (1 << z);
const lat2y = (lat: number, z: number): number => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << z); };

// custom（MapLibre の raster-dem）＝h＝(R×redFactor＋G×greenFactor＋B×blueFactor)＋baseShift（f＝{ redFactor, greenFactor, blueFactor, baseShift }・2026-09-26）
export function decodeDEM(rgba: Uint8ClampedArray | Uint8Array, encoding: string = "terrarium", f: DemFactors | null = null): Float32Array {
	// encoding の振り分けは画素の外で 1 回（旧＝画素ごとに文字列の比較を 3 回）。式と丸めは旧と同じ＝ビット同値
	const n = rgba.length >> 2, out = new Float32Array(n);
	if (encoding === "mapbox") {
		for (let i = 0; i < n; i++) { const j = i * 4; out[i] = rgba[j + 3] === 0 ? NaN : -10000 + (rgba[j] * 65536 + rgba[j + 1] * 256 + rgba[j + 2]) * 0.1; }
	} else if (encoding === "custom") {
		const rf = f?.redFactor ?? 0, gf = f?.greenFactor ?? 0, bf = f?.blueFactor ?? 0, bs = f?.baseShift ?? 0;
		for (let i = 0; i < n; i++) { const j = i * 4; out[i] = rgba[j + 3] === 0 ? NaN : rgba[j] * rf + rgba[j + 1] * gf + rgba[j + 2] * bf + bs; }
	} else if (encoding === "gsi") {
		for (let i = 0; i < n; i++) { const j = i * 4; if (rgba[j + 3] === 0) { out[i] = NaN; continue; } const x = rgba[j] * 65536 + rgba[j + 1] * 256 + rgba[j + 2]; out[i] = x === 8388608 ? NaN : (x < 8388608 ? x : x - 16777216) * 0.01; }
	} else {
		for (let i = 0; i < n; i++) { const j = i * 4; out[i] = rgba[j + 3] === 0 ? NaN : rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768; }
	}
	return out;
}

export function normalizeDemSpec(spec: DemSpecInput | null | undefined): DemSpec {
	if (!spec?.tiles?.length && !spec?.url) throw new Error("dem: spec needs tiles (or url)");
	// TODO(ts): url だけの spec は tiles が undefined のまま通り、後の url() で落ちる（元の JS からの潜在バグ・挙動は変えない）
	return { tiles: spec.tiles as string[], encoding: spec.encoding || "terrarium", tileSize: spec.tileSize || 256, minzoom: spec.minzoom ?? 0, maxzoom: spec.maxzoom ?? 14,
		bounds: Array.isArray(spec.bounds) && spec.bounds.length === 4 ? spec.bounds.slice() : null, dtm: !!spec.dtm, cellZoom: spec.cellZoom ?? null, headers: spec.headers || null, credentials: spec.credentials || "omit",
		redFactor: spec.redFactor ?? 1, greenFactor: spec.greenFactor ?? 1, blueFactor: spec.blueFactor ?? 1, baseShift: spec.baseShift ?? 0 };   // encoding custom の係数（MapLibre の既定 1/1/1/0）
}

export function createDemSource(spec0: DemSpecInput | QmeshSpecInput): DemSource {
	if (spec0?.type === "quantized-mesh") return createQmeshSource(spec0 as QmeshSpecInput);   // Cesium の地形（layer.json＋.terrain・#110）
	const spec = normalizeDemSpec(spec0 as DemSpecInput);
	const tiles = new Map<string, Promise<DemTile | null>>();   // "z/x/y" → Promise<{ h: Float32Array, n }|null>（直近 256 枚）
	let ctx: OffscreenCanvasRenderingContext2D | null = null;
	const url = (z: number, x: number, y: number): string => spec.tiles[(x + y) % spec.tiles.length].replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
	async function tile(z: number, x: number, y: number): Promise<DemTile | null> {
		const k = `${z}/${x}/${y}`;
		if (tiles.has(k)) { const p = tiles.get(k)!; tiles.delete(k); tiles.set(k, p); return p; }
		const p = (async (): Promise<DemTile | null> => {
			const r = await fetch(url(z, x, y), { credentials: spec.credentials, ...(spec.headers ? { headers: spec.headers } : {}) });
			if (!r.ok) return null;   // 404＝そこに無い（海・範囲外）
			const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
			const n = bmp.width;
			ctx ??= new OffscreenCanvas(n, n).getContext("2d", { willReadFrequently: true });
			if (ctx!.canvas.width !== n) { ctx!.canvas.width = n; ctx!.canvas.height = n; }
			ctx!.clearRect(0, 0, n, n); ctx!.drawImage(bmp, 0, 0); bmp.close?.();
			return { h: decodeDEM(ctx!.getImageData(0, 0, n, n).data, spec.encoding, spec), n };
		})().catch(() => null);
		tiles.set(k, p);
		if (tiles.size > 256) tiles.delete(tiles.keys().next().value!);
		return p;
	}
	const inBounds = (w: number, s: number, e: number, n: number): boolean => !spec.bounds || !(e < spec.bounds[0] || w > spec.bounds[2] || n < spec.bounds[1] || s > spec.bounds[3]);
	// z の点（メルカトルのタイル座標 fx,fy）をバイリニアで。get＝(x,y)→取得済みタイル（同期）
	const sampleSync = (get: (x: number, y: number) => DemTile | null | undefined, z: number, fx: number, fy: number): number => {
		const x = Math.floor(fx), y = Math.floor(fy), t = get(((x % (1 << z)) + (1 << z)) % (1 << z), y);
		if (!t) return NaN;
		const px = (fx - x) * t.n - 0.5, py = (fy - y) * t.n - 0.5;
		const x0 = Math.max(0, Math.min(t.n - 2, Math.floor(px))), y0 = Math.max(0, Math.min(t.n - 2, Math.floor(py))), ax = Math.max(0, Math.min(1, px - x0)), ay = Math.max(0, Math.min(1, py - y0));
		const H = (i: number, j: number): number => t.h[j * t.n + i];
		const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
		return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
	};
	return {
		spec,
		covers: (lng0: number, lat0: number, range = 1): boolean => inBounds(lng0, lat0, lng0 + range, lat0 + range),
		// 1 点＝zHint（今の視点のタイルの z・無ければ最大ズーム）のタイルから。無い（404）なら親へ上がる＝maxzoom の申告が無い source（既定 22）で最大ズームを直に引いて 404 を積まない（2026-09-30）
		async height(lon: number, lat: number, zHint: number | null = null): Promise<number> {
			if (!inBounds(lon, lat, lon, lat)) return NaN;
			let z = Math.max(spec.minzoom, Math.min(spec.maxzoom, Number.isFinite(zHint) ? Math.floor(zHint as number) : spec.maxzoom));
			for (; z >= spec.minzoom; z--) {
				const fx = lon2x(lon, z), fy = lat2y(lat, z);
				const t = await tile(z, ((Math.floor(fx) % (1 << z)) + (1 << z)) % (1 << z), Math.floor(fy));
				if (t) return sampleSync(() => t, z, fx, fy);
				if (z === spec.minzoom) break;
			}
			return NaN;
		},
		// セル（R01＝1°・R10＝10°）＝N×N の格子点（既定 N＝1025）。z＝セルの画素に見合う最小のズーム（R01 は cellZoom で固定可）。
		// 取りに行くのは DEM の範囲（bounds）と重なるタイルだけ＝局所の細かい DEM でも 10° セルが膨れない
		async cell(lng0: number, lat0: number, range = 1, N = 1025): Promise<DemCell | null> {
			if (!inBounds(lng0, lat0, lng0 + range, lat0 + range)) return null;
			const want = N / range * 360 / spec.tileSize;   // 1°あたり N/range 画素
			const z = Math.max(spec.minzoom, Math.min(spec.maxzoom, range === 1 && spec.cellZoom != null ? spec.cellZoom : Math.ceil(Math.log2(want))));
			const b = spec.bounds, w = Math.max(lng0, b ? b[0] : -180), e = Math.min(lng0 + range, b ? b[2] : 180), so = Math.max(lat0, b ? b[1] : -85.05), no = Math.min(lat0 + range, b ? b[3] : 85.05);
			const x0 = Math.floor(lon2x(w, z)), x1 = Math.floor(lon2x(e - 1e-9, z)), y0 = Math.floor(lat2y(no, z)), y1 = Math.floor(lat2y(so + 1e-9, z));
			const need: [number, number][] = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) need.push([x, y]);
			if (need.length > 400) return null;   // 取りすぎ（cellZoom が細かすぎる・範囲が広すぎる）＝既定の標高へ
			// 取ったタイルは矩形 [x0,x1]×[y0,y1] の添字で引く（旧＝標本ごとに "x,y" の文字列の鍵で Map＝1025² 標本で時間の半分）。範囲の外は undefined＝旧と同じ
			const W = x1 - x0 + 1, got: (DemTile | null | undefined)[] = new Array(need.length);
			let i = 0; await Promise.all(Array.from({ length: 8 }, async () => { while (i < need.length) { const k = i++, [x, y] = need[k]; got[k] = await tile(z, x, y); } }));
			const get = (x: number, y: number): DemTile | null | undefined => x >= x0 && x <= x1 && y >= y0 && y <= y1 ? got[(y - y0) * W + (x - x0)] : undefined;
			if (!got.some(Boolean)) return null;
			const data = new Float32Array(N * N);
			let valid = 0;
			for (let r = 0; r < N; r++) {
				const la = lat0 + range - r / (N - 1) * range, fy = lat2y(la, z), inLat = la >= so && la <= no;
				for (let c = 0; c < N; c++) { const lo = lng0 + c / (N - 1) * range; const v = inLat && lo >= w && lo <= e ? sampleSync(get, z, lon2x(lo, z), fy) : NaN; data[r * N + c] = v; if (v === v) valid++; }
			}
			return valid ? { data, width: N, height: N, lng: lng0, lat: lat0, range, source: "dem", valid: valid / (N * N) } : null;
		},
	};
}
