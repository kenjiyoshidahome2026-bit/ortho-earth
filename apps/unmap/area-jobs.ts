// 範囲の保存（M3）の決まり：仕事の組み方・見積もりの足し方・名前。DOM 不使用（node で検定する＝tests/t-areas.mjs）。
// 範囲＝z8 タイルの矩形（端は z8 に揃う・本人の計画 2026-11-14）。日付変更線を跨ぐ範囲は東西 2 本のファイルに割る（ヘッダの箱が跨がない＝読む側の範囲の門がそのまま効く）。
// 地図＝OSM planet の z0–地図の上限（既定 z14）・地形＝GEL の z2–地形の上限（既定 z10）。世界の土台＝planet の z0–5 を一度だけ（world.pmtiles）＝回線なしでも地球が白くならない。
import { splitZ8Rect, z8Bbox, z8Count, trimPlan, RECT_ZOOM } from "@ortho-earth/core/pmtiles-extract";
import type { ExtractPlan, Z8Rect } from "@ortho-earth/core/pmtiles-extract";
import type { SaveJob } from "./save-worker.ts";
import { LOCAL_DIRS } from "./sources.ts";

export const MAP_ZOOM = 14, TERRAIN_ZOOM = 10, WORLD_ZOOM = 5, GEL_MIN = 2;
/** 1 つの範囲の上限（地図＋地形）。越える時は地図の上限ズームを下げる */
export const AREA_CAP = 1e9;
/** 選べる範囲の大きさの上限（z8 で 1 辺の枚数） */
export const MAX_SIDE = 24;
export const WORLD_NAME = "world";
const SIDES = ["w", "e"];

export interface AreaChoice { rect: Z8Rect; mapZoom: number; terrainZoom: number | null; world: boolean }
export interface AreaSources { osm: string; gel: string | null }

/** 範囲の id（保存した時刻・36 進） */
export const areaId = (t = Date.now()): string => t.toString(36);
/** ファイル名（拡張子なし）。跨ぐ範囲は -w / -e */
export const areaName = (id: string, part: number, parts: number): string => `area-${id}${parts > 1 ? "-" + SIDES[part] : ""}`;
/** ファイル名から範囲の id（area-<id>[-w|-e].pmtiles）。範囲でなければ null */
export const areaIdOf = (file: string): string | null => /^area-([0-9a-z]+)(?:-[we])?\.pmtiles$/.exec(file)?.[1] ?? null;

/** 仕事の列（世界の土台 → 地図 → 地形）。tag は metadata に入る印 */
export function jobsFor(c: AreaChoice, src: AreaSources, id: string, savedAt = new Date().toISOString()): SaveJob[] {
	const parts = splitZ8Rect(c.rect), tag = { area: id, rect: c.rect, savedAt };
	const jobs: SaveJob[] = [];
	if (c.world) jobs.push({ dir: LOCAL_DIRS.map, name: WORLD_NAME, url: src.osm, rect: null, minZoom: 0, maxZoom: WORLD_ZOOM, bbox: [-180, -85.0511, 180, 85.0511], tag: { world: true, savedAt } });
	parts.forEach((p, i) => jobs.push({ dir: LOCAL_DIRS.map, name: areaName(id, i, parts.length), url: src.osm, rect: p, minZoom: 0, maxZoom: c.mapZoom, bbox: z8Bbox(p), tag }));
	if (src.gel && c.terrainZoom != null) parts.forEach((p, i) => jobs.push({ dir: LOCAL_DIRS.terrain, name: areaName(id, i, parts.length), url: src.gel!, rect: p, minZoom: GEL_MIN, maxZoom: Math.max(GEL_MIN, c.terrainZoom!), bbox: z8Bbox(p), tag }));
	return jobs;
}

/** 範囲の大きさ（km・中心の緯度で）：[東西, 南北] */
export function areaKm(r: Z8Rect): [number, number] {
	const [w, s, e, n] = z8Bbox(r), dlon = ((e - w) % 360 + 360) % 360 || 360, lat = (s + n) / 2;
	return [dlon * 111.32 * Math.cos(lat * Math.PI / 180), (n - s) * 110.57];
}
export const areaTiles = z8Count;

/** 計画（割った分の和）を上限 cap に収める地図の上限ズーム。戻り＝[ズーム, その時のバイト] */
export function fitZoom(plans: ExtractPlan[], want: number, cap: number, minZoom = 6): [number, number] {
	for (let z = want; z >= minZoom; z--) { const b = plans.reduce((s, p) => s + trimPlan(p, Math.min(z, p.maxZoom)).bytes, 0); if (b <= cap || z === minZoom) return [z, b]; }
	return [minZoom, 0];
}

const MB = 1e6;
/** バイトを人の読む形に */
export const human = (n: number | null | undefined): string => n == null ? "?" : n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 10 * MB ? Math.round(n / MB) + " MB" : (n / MB).toFixed(1) + " MB";

/** 国の箱（z8）を 1 範囲の大きさ（MAX_SIDE）に収める。収まらない向きは (tx, ty) の周りを国の中で切り取る（M5「国をタップして端子で詰める」） */
export function countryRect(r: Z8Rect, tx: number, ty: number, max = MAX_SIDE): { rect: Z8Rect; clipped: boolean } {
	const N = 2 ** RECT_ZOOM, wrap = (x: number) => ((x % N) + N) % N;
	const w = wrap(r.x1 - r.x0) + 1, h = r.y1 - r.y0 + 1;
	let { x0, x1, y0, y1 } = r, clipped = false;
	if (w > max) {
		clipped = true;
		const off = wrap(tx - r.x0) < w ? wrap(tx - r.x0) : 0;   // 国の箱の中のタップの位置（外なら西の端）
		const start = Math.max(0, Math.min(w - max, off - Math.floor(max / 2)));
		x0 = wrap(r.x0 + start); x1 = wrap(x0 + max - 1);
	}
	if (h > max) {
		clipped = true;
		const cy = Math.max(r.y0, Math.min(r.y1, ty));
		y0 = Math.max(r.y0, Math.min(r.y1 - max + 1, cy - Math.floor(max / 2))); y1 = y0 + max - 1;
	}
	return { rect: { x0, x1, y0, y1 }, clipped };
}
