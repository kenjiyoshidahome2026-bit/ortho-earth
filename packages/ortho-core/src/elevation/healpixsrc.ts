// 標高の HEALPix タイル（bucket の GIS/hpx/elev・docs/design/healpix.md）を、地形の経緯度のセルとして出す源（2026-11-27・?hpx=1 の裏）。
// 地形（terrain.ts）は視野を覆う経緯度の窓にセルを並べる＝そのセル（10°・N×N texel）を、R10 の生タイル（2400²・1 枚数 MB）の代わりに
// 「セルの密度に合う order の HEALPix タイル」から埋める。8 セルの窓（1 セル 512 texel）なら Norder 3（1 セルに 512px のタイル 2〜4 枚）で足りる。
// 描く側（アトラス・シェーダ）は経緯度の窓のまま＝GL2／WebGPU とも無変更。DOM に触れない＝render worker でそのまま動く。
import { decode } from "altpbf";
import { hpxPath, hpxId } from "../healpix.ts";
import { hpxSampleWindow, hpxOrderFor } from "./healpixread.ts";

/** HEALPix から埋めたセル：grid＝N×N（row0＝南・texel 中心＝アトラスへそのまま書ける）・max＝最大標高（m） */
export interface HpxElevCell { grid: Float32Array; N: number; lng: number; lat: number; range: number; order: number; max: number; sea: boolean }
export interface HpxElevSource {
	/** セル（南西隅 lng0, lat0・幅 range 度）を N×N で。sea＝海底の負値を通す。タイルが取れない＝null（呼び手は従来の経路へ落とす） */
	cell(lng0: number, lat0: number, range: number, N: number, sea?: boolean): Promise<HpxElevCell | null>;
	/** 1 点の標高（m）＝手元に在る最も細かいセルから。無い＝null */
	sample(lon: number, lat: number): number | null;
	clear(): void; bytes(): number; stats(): { tiles: number; fetched: number; cells: number };
}
/** タイルを取りに行く口（検定用の差し込み）：(order, npix) → W×W の画素｜null（そのタイルは無い＝0 m）。届かない＝reject */
export type HpxTileFetcher = (order: number, npix: number) => Promise<ArrayLike<number> | null>;
export interface HpxElevSourceOptions { apiUrl?: string; fetchTile?: HpxTileFetcher | null; tileWidth?: number; minOrder?: number; maxOrder?: number; lowMem?: boolean; /** セルの密度がこの order より細かい段を要る時は出さない（null＝いつも出す）＝細かい段は R10 の生タイルより取り寄せが増える（下の注） */ skipAbove?: number | null; /** 何行ごとに描画スレッドを手放すか（既定 32） */ rowsPerSlice?: number }

export const HPX_ELEV_DIR = "GIS/hpx/elev";

export function createHpxElevSource({ apiUrl = "", fetchTile = null, tileWidth = 512, minOrder = 3, maxOrder = 5, lowMem = false, skipAbove = null, rowsPerSlice = 32 }: HpxElevSourceOptions = {}): HpxElevSource {
	const W = tileWidth;
	const fetchOne: HpxTileFetcher = fetchTile ?? (async (order, npix) => {
		const res = await fetch(`${apiUrl}/bucket/${HPX_ELEV_DIR}/${hpxPath(order, npix, "altpbf")}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`hpx ${order}/${npix} HTTP ${res.status}`);
		const t = await decode(await res.blob());
		if (t.width !== W || t.height !== W) throw new Error(`hpx ${order}/${npix}: ${t.width}x${t.height}`);
		return t.data;
	});
	// タイルの LRU（復号済み Int16 512²＝0.5MB）。null＝無いタイル（0 m）も覚える
	const BUDGET = (lowMem ? 24 : 96) << 20;
	const tiles = new Map<number, ArrayLike<number> | null>(), inflight = new Map<number, Promise<ArrayLike<number> | null>>();
	let tileBytes = 0, fetched = 0;
	const sizeOf = (t: ArrayLike<number> | null): number => t ? t.length * 2 : 0;
	function loadTile(order: number, npix: number): Promise<ArrayLike<number> | null> {
		const id = hpxId(order, npix);
		let p = inflight.get(id);
		if (!p) {
			p = fetchOne(order, npix).then(t => {
				fetched++; tiles.set(id, t); tileBytes += sizeOf(t);
				for (const [k, v] of tiles) { if (tileBytes <= BUDGET || k === id) break; tiles.delete(k); tileBytes -= sizeOf(v); }
				return t;
			}).finally(() => { inflight.delete(id); });
			inflight.set(id, p);
		}
		return p;
	}
	// 埋めたセル（"lng,lat,range,N,sea"）＝窓を作り直しても標本化をやり直さない・sample が引く。直近 64 枚
	const cells = new Map<string, HpxElevCell>(), cellP = new Map<string, Promise<HpxElevCell | null>>();
	const CELLS = lowMem ? 24 : 64;
	async function bake(lng0: number, lat0: number, range: number, N: number, sea: boolean): Promise<HpxElevCell | null> {
		const order = hpxOrderFor(range / N, W, minOrder, maxOrder), grid = new Float32Array(N * N);
		// 要るタイルは「引いてみて、無かった物を取りに行き、引き直す」で集める（手元に在れば 1 回で済む）。行の束ごとに手を放す＝1 セル 512² で数十 ms を 1 フレームに積まない
		for (let j0 = 0; j0 < N; j0 += rowsPerSlice) {
			const rows = Math.min(rowsPerSlice, N - j0), la0 = lat0 + range * j0 / N, span = range * rows / N;
			for (let pass = 0; ; pass++) {
				const need = new Set<number>();
				const get = (npix: number): ArrayLike<number> | null => {
					const id = hpxId(order, npix), t = tiles.get(id);
					if (t === undefined) { need.add(npix); return null; }
					return t;
				};
				const band = hpxSampleWindow(get, order, W, lng0, la0, range, span, N, rows, sea);
				if (!need.size) { grid.set(band, j0 * N); break; }
				if (pass >= 2) return null;   // 取った直後に LRU から落ちた（予算がセル 1 枚に足りない）＝諦めて従来の経路へ
				try { await Promise.all([...need].map(n => loadTile(order, n))); } catch (e) { console.warn("[hpx-elev] tile fetch failed", (e as Error)?.message ?? e); return null; }
			}
			if (j0 + rows < N) await new Promise<void>(r => setTimeout(r, 0));
		}
		let max = 0; for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
		return { grid, N, lng: lng0, lat: lat0, range, order, max, sea };
	}
	function cell(lng0: number, lat0: number, range: number, N: number, sea = false): Promise<HpxElevCell | null> {
		// 取り寄せの量（10° のセル 1 枚・幅 512）：order 3＝タイル 4〜5 枚（1.3 Mpx）・order 4＝12 枚（3.1 Mpx）・order 5＝36 枚（9.4 Mpx）。R10 の生タイルは 1 枚 5.76 Mpx
		// ＝order 5 を要る密度（1 セル 1,400 texel 超）は R10 の方が軽い＝skipAbove 4 ならそこは出さない（呼び手が R10 へ落とす）
		if (skipAbove !== null && hpxOrderFor(range / N, W, 0, 24) > skipAbove) return Promise.resolve(null);
		const k = [lng0, lat0, range, N, sea ? 1 : 0].join(",");
		const hit = cells.get(k);
		if (hit) { cells.delete(k); cells.set(k, hit); return Promise.resolve(hit); }
		let p = cellP.get(k);
		if (!p) {
			p = bake(lng0, lat0, range, N, sea).then(c => {
				if (c) { cells.set(k, c); for (const ok of cells.keys()) { if (cells.size <= CELLS) break; cells.delete(ok); } }
				return c;
			}).finally(() => { cellP.delete(k); });
			cellP.set(k, p);
		}
		return p;
	}
	function sample(lon: number, lat: number): number | null {
		let best: HpxElevCell | null = null;
		for (const c of cells.values()) if (lon >= c.lng && lon < c.lng + c.range && lat >= c.lat && lat < c.lat + c.range && (!best || c.range / c.N < best.range / best.N)) best = c;
		if (!best) return null;
		const { grid, N } = best, gx = Math.min(N - 1, Math.max(0, (lon - best.lng) / best.range * N - 0.5)), gy = Math.min(N - 1, Math.max(0, (lat - best.lat) / best.range * N - 0.5));
		const x0 = Math.min(N - 2, gx | 0), y0 = Math.min(N - 2, gy | 0), tx = gx - x0, ty = gy - y0, i = y0 * N + x0;
		const a = grid[i] + (grid[i + 1] - grid[i]) * tx, b = grid[i + N] + (grid[i + N + 1] - grid[i + N]) * tx;
		return a + (b - a) * ty;
	}
	return {
		cell, sample,
		clear() { cells.clear(); },
		bytes: () => tileBytes + [...cells.values()].reduce((s, c) => s + c.grid.byteLength, 0),
		stats: () => ({ tiles: tiles.size, fetched, cells: cells.size }),
	};
}
