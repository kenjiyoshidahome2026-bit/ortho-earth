// 端末に置いた PMTiles（M2）の札：一覧・取り込み・削除・容量。取り込み／削除の後は読み直す（読む源は起動の時に束ねる＝worker の索引の覚えも新しくなる）。
// 地図（ベクタ）か地形（ラスタ）かはヘッダの tileType で決める（sources.ts kindOfTileType）。
import { importPMTiles, listPMTiles, readPMTilesHeader, removePMTiles, requestPersist, storageInfo } from "@ortho-earth/core";
import type { StoredPMTiles } from "@ortho-earth/core";
import { LOCAL_DIRS, kindOfTileType } from "./sources.ts";
import type { LocalKind } from "./sources.ts";

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
export interface SavePanelHooks { saveHere(): void; choose(): void; pending: { name: string }[]; resume(): void; discard(): void; /** 元が新しくなった保存（M5）＝全部を切り直す */ update?: { count: number; run(): void } | null }

/** 札の「Offline data」の段を組む。el＝入れ物 */
export async function mountLocalPanel(el: HTMLElement, files: LocalFiles, hooks?: SavePanelHooks): Promise<void> {
	if (!opfsAvailable()) { el.innerHTML = `<div class="ng">This browser cannot store files (OPFS).</div>`; return; }
	const st = await storageInfo();
	const rows = (["map", "terrain"] as const).flatMap(k => files[k].map(f => `<li>${k === "map" ? "🗺" : "⛰"} ${esc(f.name)} · ${mb(f.size)} <button type="button" data-del="${k}" data-name="${esc(f.name)}" aria-label="Delete ${esc(f.name)}">🗑</button></li>`));
	const pend = hooks?.pending.length ? `<div class="pending">Unfinished save (${hooks.pending.length} file${hooks.pending.length > 1 ? "s" : ""}) <button type="button" class="resume">Resume</button> <button type="button" class="discard">Discard</button></div>` : "";
	const upd = hooks?.update?.count ? `<div class="pending">Newer map data is available for ${hooks.update.count} saved file${hooks.update.count > 1 ? "s" : ""}. <button type="button" class="update">Update all</button></div>` : "";
	el.innerHTML = `<div class="sect">Offline data</div>
		${hooks ? `<div class="save-btns"><button type="button" class="add save-here">📍 Save area around me</button> <button type="button" class="add choose">Choose area on map</button></div>${pend}${upd}` : ""}
		<ul>${rows.join("") || "<li>No files on this device yet.</li>"}</ul>
		<label class="add">＋ Add .pmtiles<input type="file" accept=".pmtiles,application/octet-stream" hidden></label>
		<div class="note">Stored ${mb(st.usage)} of ${mb(st.quota)}${st.persisted ? " · persistent" : ""}</div>
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
	el.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach(b => b.addEventListener("click", async () => {
		try { await removePMTiles(LOCAL_DIRS[b.dataset.del as LocalKind], b.dataset.name!); location.reload(); }
		catch (err) { msg.textContent = `Failed: ${(err as Error).message}`; }
	}));
}
