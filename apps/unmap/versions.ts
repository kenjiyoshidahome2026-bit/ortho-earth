// 保存した範囲の版（M5）：範囲ごとに元（planet・GEL）の版の印を metadata に持つ（save-worker）。元が作り直されたら全部の範囲を同じ範囲・同じズームで切り直す
// ＝範囲どうしの縁で道がずれない（計画「全部の矩形を同じ版に揃える」）。
//   readSaved()             … 端末の地図・地形ファイルのヘッダと metadata（unmap の印）
//   staleOf(saved, current) … 今の元の版と違う物（版の分からない古い保存は、揃っていない時だけ数える）
//   recutJobs(stale, src)   … 切り直しの仕事（同じ名前に書き戻す＝.part から差し替える）
import { parseHeader, z8OfBbox } from "@ortho-earth/core/pmtiles-extract";
import type { Z8Rect } from "@ortho-earth/core/pmtiles-extract";
import type { SaveJob } from "./save-worker.ts";
import { LOCAL_DIRS } from "./sources.ts";
import type { LocalKind } from "./sources.ts";

/** metadata の unmap の印（save-worker が書く） */
export interface SavedTag { area?: string; rect?: Z8Rect; part?: Z8Rect | null; world?: boolean; savedAt?: string; source?: string; version?: string; minZoom?: number; maxZoom?: number }
export interface SavedFile { kind: LocalKind; dir: string; name: string; minZoom: number; maxZoom: number; bounds: [number, number, number, number]; tag: SavedTag }

/** PMTiles の頭と metadata から保存の印を読む（読めなければ null） */
export async function savedOf(file: Blob, kind: LocalKind, name: string): Promise<SavedFile | null> {
	try {
		const h = parseHeader(new Uint8Array(await file.slice(0, 127).arrayBuffer()));
		let tag: SavedTag = {};
		if (h.metadataLength && h.internalCompression <= 1) {   // 自分で書いた物は無圧縮（gzip の metadata＝手で入れた物＝印なし）
			const md = JSON.parse(await file.slice(h.metadataOffset, h.metadataOffset + h.metadataLength).text());
			if (md && typeof md.unmap === "object") tag = md.unmap;
		}
		return { kind, dir: LOCAL_DIRS[kind], name, minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], tag };
	} catch { return null; }
}

/** 端末の保存（地図・地形） */
export async function readSaved(): Promise<SavedFile[]> {
	const out: SavedFile[] = [];
	for (const kind of ["map", "terrain"] as LocalKind[]) {
		let d: FileSystemDirectoryHandle;
		try { d = await navigator.storage.getDirectory(); for (const p of LOCAL_DIRS[kind].split("/")) d = await d.getDirectoryHandle(p); } catch { continue; }
		for await (const [n, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
			if (h.kind !== "file" || !n.endsWith(".pmtiles")) continue;
			const s = await savedOf(await (h as FileSystemFileHandle).getFile(), kind, n);
			if (s && (s.tag.area || s.tag.world)) out.push(s);   // 範囲の保存だけ（手で取り込んだ物は切り直せない）
		}
	}
	return out;
}

/** 今の元の版と違う保存。版の印が無い保存（M3 の物）は、印のある保存がどれか違う時に一緒に揃える */
export function staleOf(saved: SavedFile[], current: Partial<Record<LocalKind, string | undefined>>): SavedFile[] {
	return saved.filter(s => {
		const cur = current[s.kind]; if (!cur) return false;
		if (s.tag.version) return s.tag.version !== cur;
		return saved.some(o => o.kind === s.kind && o.tag.version && o.tag.version !== cur);
	});
}

/** 切り直しの仕事。範囲＝印の part（無い古い保存はヘッダの箱を z8 へ・縁の丸め誤差を内へ寄せて）。ズームはヘッダのまま */
export function recutJobs(stale: SavedFile[], src: Record<LocalKind, string | null>, now = new Date().toISOString()): SaveJob[] {
	const out: SaveJob[] = [];
	for (const s of stale) {
		const url = src[s.kind]; if (!url) continue;
		const e = 1e-5, [w, so, ea, n] = s.bounds;
		const rect = s.tag.world ? null : s.tag.part ?? z8OfBbox(w + e, so + e, ea - e, n - e);
		const { version: _v, source: _s, part: _p, minZoom: _a, maxZoom: _b, ...keep } = s.tag;
		out.push({ dir: s.dir, name: s.name.replace(/\.pmtiles$/, ""), url, rect, minZoom: s.minZoom, maxZoom: s.maxZoom, bbox: s.bounds, tag: { ...keep, recutAt: now } });
	}
	// 世界の土台 → 地図 → 地形の順（保存と同じ）
	const rank = (j: SaveJob) => (j.rect ? 1 : 0) + (j.dir === LOCAL_DIRS.terrain ? 2 : 0);
	return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ── 札の一覧（2026-11-16・本人「保存されている場所が記号でどこか分かりません」）：ファイル名（area-<36 進の時刻>）ではなく、範囲ごとに 1 行＝場所の名前・大きさ・細かさ・日付 ──
/** 一覧の 1 行＝1 つの範囲（地図と地形・跨ぐ範囲の東西 2 本をまとめる） */
export interface SavedArea { id: string; bounds: [number, number, number, number]; savedAt: string | null; mapZoom: number | null; terrainZoom: number | null; bytes: number; files: { kind: LocalKind; name: string }[] }
export interface SavedGroups { areas: SavedArea[]; world: { kind: LocalKind; name: string; bytes: number } | null; tagged: Set<string> }

/** 保存の印から範囲ごとにまとめる。sizeOf＝ファイルの大きさ（kind/name → バイト）。新しい順 */
export function groupSaved(saved: SavedFile[], sizeOf: (kind: LocalKind, name: string) => number): SavedGroups {
	const by = new Map<string, SavedArea>(), tagged = new Set<string>();
	let world: SavedGroups["world"] = null;
	for (const s of saved) {
		tagged.add(`${s.kind}/${s.name}`);
		if (s.tag.world) { world = { kind: s.kind, name: s.name, bytes: sizeOf(s.kind, s.name) }; continue; }
		const id = s.tag.area; if (!id) continue;
		let a = by.get(id);
		if (!a) { a = { id, bounds: [...s.bounds], savedAt: s.tag.savedAt ?? null, mapZoom: null, terrainZoom: null, bytes: 0, files: [] }; by.set(id, a); }
		else {   // 東西 2 本（日付変更線を跨ぐ）＝箱を足す：西の本の西端〜東の本の東端（w > e のまま持つ＝跨ぐ印）
			const [w, so, e, n] = s.bounds, b = a.bounds;
			if (s.kind === "map" || !a.files.some(f => f.kind === "map")) {
				if (/-w\.pmtiles$/.test(s.name)) b[0] = w; else if (/-e\.pmtiles$/.test(s.name)) b[2] = e; else { b[0] = Math.min(b[0], w); b[2] = Math.max(b[2], e); }
				b[1] = Math.min(b[1], so); b[3] = Math.max(b[3], n);
			}
		}
		if (s.kind === "map") a.mapZoom = Math.max(a.mapZoom ?? 0, s.maxZoom); else a.terrainZoom = Math.max(a.terrainZoom ?? 0, s.maxZoom);
		a.bytes += sizeOf(s.kind, s.name); a.files.push({ kind: s.kind, name: s.name });
	}
	return { areas: [...by.values()].sort((x, y) => (y.savedAt ?? "").localeCompare(x.savedAt ?? "") || y.id.localeCompare(x.id)), world, tagged };
}

/** 箱の中か（w > e＝日付変更線を跨ぐ箱） */
const inBox = (lon: number, lat: number, [w, s, e, n]: [number, number, number, number]) => lat >= s && lat <= n && (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);
/** 範囲の呼び名：箱の中でいちばん大きい町（population_rank）の名前。無ければ地方・国、それも無ければ中心の経緯度 */
export function areaLabel(bounds: [number, number, number, number], places: { name: string; names?: Record<string, string>; kind: string; rank: number; lon: number; lat: number }[], lang = "local"): string {
	const nameOf = (p: { name: string; names?: Record<string, string> }) => p.names?.[lang === "local" ? "en" : lang] || p.name;   // 札は英語の UI＝「現地語」の時は英語名を先に（「東京都 area」より「Tokyo area」）・無ければ現地語
	let best: typeof places[number] | null = null;
	for (const kind of ["locality", "region", "country"]) {
		for (const p of places) if (p.kind === kind && inBox(p.lon, p.lat, bounds) && (!best || p.rank > best.rank)) best = p;
		if (best) return nameOf(best);
	}
	const [w, s, e, n] = bounds, lat = (s + n) / 2, lon = w <= e ? (w + e) / 2 : ((w + e + 360) / 2 + 540) % 360 - 180;
	return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
}
/** 箱の大きさ（km・中心の緯度で）：[東西, 南北] */
export function boundsKm([w, s, e, n]: [number, number, number, number]): [number, number] {
	const dlon = ((e - w) % 360 + 360) % 360 || 360;
	return [dlon * 111.32 * Math.cos((s + n) / 2 * Math.PI / 180), (n - s) * 110.57];
}
