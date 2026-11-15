// 端末に置いた PMTiles（M2）の札：一覧・取り込み・削除・容量。取り込み／削除の後は読み直す（読む源は起動の時に束ねる＝worker の索引の覚えも新しくなる）。
// 地図（ベクタ）か地形（ラスタ）かはヘッダの tileType で決める（sources.ts kindOfTileType）。
import { importPMTiles, listPMTiles, readPMTilesHeader, removePMTiles, requestPersist, storageInfo } from "@ortho-earth/core";
import type { StoredPMTiles } from "@ortho-earth/core";
import { LOCAL_DIRS, kindOfTileType } from "./sources.ts";
import type { LocalKind } from "./sources.ts";
import { areaLabel, boundsKm, groupSaved, readSaved } from "./versions.ts";
import { loadPlaces } from "./search.ts";

export type LocalFiles = Record<LocalKind, StoredPMTiles[]>;

/** OPFS が使えるか（古いブラウザ・非安全な文脈では無い） */
export const opfsAvailable = (): boolean => typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;

export async function listLocal(): Promise<LocalFiles> {
	if (!opfsAvailable()) return { map: [], terrain: [] };
	const [map, terrain] = await Promise.all([listPMTiles(LOCAL_DIRS.map), listPMTiles(LOCAL_DIRS.terrain)]);
	return { map, terrain };
}

const mb = (n: number | null): string => n == null ? "?" : n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : (n / 1e6).toFixed(1) + " MB";
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 端末の地図ファイルの箱（ヘッダの bounds）。world.pmtiles（世界の土台）は除く＝範囲の選択の画面で薄く塗る分 */
export async function savedBounds(files: LocalFiles): Promise<[number, number, number, number][]> {
	const out: [number, number, number, number][] = [];
	for (const f of files.map) {
		if (f.name === "world.pmtiles") continue;
		try {
			let d = await navigator.storage.getDirectory();
			const parts = f.path.split("/").filter(Boolean), name = parts.pop()!;
			for (const p of parts) d = await d.getDirectoryHandle(p);
			const h = readPMTilesHeader(await (await (await d.getFileHandle(name)).getFile()).slice(0, 127).arrayBuffer());
			if (h) out.push(h.bounds);
		} catch { /* 読めない＝塗らない */ }
	}
	return out;
}

/** 範囲の保存（M3）の口：札から開く・書きかけを続ける／捨てる */
export interface SavePanelHooks { saveHere(): void; choose(): void; pending: { name: string }[]; resume(): void; discard(): void; /** 元が新しくなった保存（M5）＝全部を切り直す */ update?: { count: number; run(): void } | null;
	/** 一覧の「Show」＝その範囲へ飛ぶ（箱 [w,s,e,n]） */ show?(bounds: [number, number, number, number]): void; /** 地名の言語（範囲の呼び名） */ lang?(): string; /** 保存の直後の知らせ */ notice?: string | null }

const dateOf = (iso: string | null): string => { if (!iso) return ""; const d = new Date(iso); return isNaN(+d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); };

/** 札の「Saved areas」の段を組む。el＝入れ物。一覧は範囲ごとに 1 行（場所の名前・大きさ・細かさ・日付）＝ファイル名は出さない（本人 2026-11-16「記号でどこか分かりません」） */
export async function mountLocalPanel(el: HTMLElement, files: LocalFiles, hooks?: SavePanelHooks): Promise<void> {
	if (!opfsAvailable()) { el.innerHTML = `<div class="ng">This browser cannot store files (OPFS).</div>`; return; }
	const [st, saved, places] = await Promise.all([storageInfo(), readSaved().catch(() => []), loadPlaces().catch(() => [])]);
	const sizeOf = (k: LocalKind, n: string) => files[k].find(f => f.name === n)?.size ?? 0;
	const g = groupSaved(saved, sizeOf), lang = hooks?.lang?.() ?? "local";
	const areaRows = g.areas.map((a, i) => {
		const [ew, ns] = boundsKm(a.bounds);
		const sub = [`${Math.round(ew)} × ${Math.round(ns)} km`, a.mapZoom != null ? `map detail z${a.mapZoom}` : "", a.terrainZoom != null ? `terrain z${a.terrainZoom}` : "", mb(a.bytes), dateOf(a.savedAt)].filter(Boolean).join(" · ");
		return `<li class="area"><div class="area-name">📍 ${esc(areaLabel(a.bounds, places, lang))} area</div><div class="note">${esc(sub)}</div>
			<div class="area-act">${hooks?.show ? `<button type="button" class="show" data-area="${i}">Show on map</button>` : ""}<button type="button" class="del" data-area="${i}" aria-label="Delete this area">🗑 Delete</button></div></li>`;
	});
	const others = (["map", "terrain"] as const).flatMap(k => files[k].filter(f => !g.tagged.has(`${k}/${f.name}`)).map(f => `<li>${k === "map" ? "🗺 Map file" : "⛰ Terrain file"}: ${esc(f.name)} · ${mb(f.size)} <button type="button" data-del="${k}" data-name="${esc(f.name)}" aria-label="Delete ${esc(f.name)}">🗑</button></li>`));
	const world = g.world ? `<li class="note">🌍 World overview for offline use · ${mb(g.world.bytes)}</li>` : "";
	const pend = hooks?.pending.length ? `<div class="pending">Unfinished save (${hooks.pending.length} file${hooks.pending.length > 1 ? "s" : ""}) <button type="button" class="resume">Resume</button> <button type="button" class="discard">Discard</button></div>` : "";
	const upd = hooks?.update?.count ? `<div class="pending">Newer map data is available for ${hooks.update.count} saved file${hooks.update.count > 1 ? "s" : ""}. <button type="button" class="update">Update all</button></div>` : "";
	el.innerHTML = `<div class="sect">Saved areas</div>
		${hooks?.notice ? `<div class="ok">✓ ${esc(hooks.notice)}</div>` : ""}
		<ul>${areaRows.join("") || (others.length ? "" : "<li>Nothing saved yet. Save an area to use the map without a connection.</li>")}${others.join("")}${world}</ul>
		${hooks ? `<div class="save-btns"><button type="button" class="add save-here">📍 Save area around me</button> <button type="button" class="add choose">Choose area on map</button></div>${pend}${upd}` : ""}
		<div class="note">Storage used: ${mb(st.usage)} of ${mb(st.quota)}${st.persisted ? " · kept by the browser" : ""}</div>
		<label class="add file">＋ Add a .pmtiles file<input type="file" accept=".pmtiles,application/octet-stream" hidden></label>
		<div class="msg"></div>`;
	const msg = el.querySelector(".msg") as HTMLElement;
	if (hooks) {
		el.querySelector(".save-here")!.addEventListener("click", () => hooks.saveHere());
		el.querySelector(".choose")!.addEventListener("click", () => hooks.choose());
		el.querySelector(".resume")?.addEventListener("click", () => hooks.resume());
		el.querySelector(".discard")?.addEventListener("click", () => hooks.discard());
		el.querySelector(".update")?.addEventListener("click", () => hooks.update?.run());
	}
	el.querySelector("input")!.addEventListener("change", async e => {
		const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
		const h = readPMTilesHeader(await f.slice(0, 127).arrayBuffer()), kind = h && kindOfTileType(h.tileType);
		if (!h || !kind) { msg.textContent = h ? "Unsupported tile type." : "Not a PMTiles v3 file."; return; }
		void requestPersist();   // 消されにくくする（返事を待たない）
		try {
			await importPMTiles(f, LOCAL_DIRS[kind], { onProgress: (b, t) => { msg.textContent = `Copying… ${Math.round(b / t * 100)}%`; } });
			msg.textContent = "Done. Reloading…"; location.reload();
		} catch (err) { msg.textContent = `Failed: ${(err as Error).message}`; }
	});
	el.querySelectorAll<HTMLButtonElement>("button.show").forEach(b => b.addEventListener("click", () => hooks?.show?.(g.areas[+b.dataset.area!].bounds)));
	el.querySelectorAll<HTMLButtonElement>("button.del").forEach(b => b.addEventListener("click", async () => {
		if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to delete"; setTimeout(() => { b.dataset.sure = ""; b.textContent = "🗑 Delete"; }, 4000); return; }   // 1 つの範囲＝数百 MB＝押し間違いで消さない
		try { for (const f of g.areas[+b.dataset.area!].files) await removePMTiles(LOCAL_DIRS[f.kind], f.name); location.reload(); }
		catch (err) { msg.textContent = `Failed: ${(err as Error).message}`; }
	}));
	el.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach(b => b.addEventListener("click", async () => {
		try { await removePMTiles(LOCAL_DIRS[b.dataset.del as LocalKind], b.dataset.name!); location.reload(); }
		catch (err) { msg.textContent = `Failed: ${(err as Error).message}`; }
	}));
}
