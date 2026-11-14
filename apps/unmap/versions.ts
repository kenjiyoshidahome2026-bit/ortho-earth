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
