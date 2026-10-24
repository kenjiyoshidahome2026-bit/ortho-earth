import { tr } from "./i18n.ts";   // UI 多言語化（英語キー＝既定値・訳はパッケージ持参の i18n/ui.json → i18n/lang/<code>.json）
import type { GeoPBF } from "geopbf";
const t = tr();
// 入出力：ドロップ取込（dropfile.js の depth-counter 作法）・10形式エクスポート（gishub と同じ *File() 群＋GeoParquet）・
// IndexedDB セッション自動保存（コミット済み geopbf の ArrayBuffer を保存＝JSON化しない＝大規模対応）。

export function initDrop(el: HTMLElement, onFile: (f: File) => unknown, signal: AbortSignal): void {
	let depth = 0;
	const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types || [])].includes("Files");
	el.addEventListener("dragenter", e => { if (hasFiles(e)) { depth++; e.preventDefault(); } }, { signal });
	el.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); }, { signal });
	el.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); }, { signal });
	el.addEventListener("drop", e => {
		depth = 0;
		if (!hasFiles(e)) return;
		e.preventDefault();
		const f = e.dataTransfer!.files?.[0];
		if (f) onFile(f);
	}, { signal });
}

export function download(file: File): void {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(file);
	a.download = file.name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// エクスポートパネル：getPbf() ＝素の fc から新規エンコードした geopbf（precision=格子段）
export function exportPanel(container: HTMLElement, getPbf: () => Promise<GeoPBF | null | undefined> | GeoPBF | null | undefined, toast: (msg: string) => void): HTMLDivElement {
	container.querySelector(".ge-dialog")?.remove();   // 二重開き防止＝開き直し（クラウドと同じ一枠）
	const panel = document.createElement("div");
	panel.className = "ge-panel ge-dialog";
	// 見出し行＝選択パネルと同じ形（.ge-head：見出し＋右上の ×）。旧＝素の <h3> と下端の「閉じる」ボタン
	const head = document.createElement("div");
	head.className = "ge-head";
	const h3 = document.createElement("h3"); h3.textContent = t("Export");
	const close = Object.assign(document.createElement("button"), { className: "ge-icon-btn", innerHTML: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' });
	close.dataset.tip = t("Close"); close.setAttribute("aria-label", t("Close"));
	close.onclick = () => panel.remove();
	head.append(h3, close);
	panel.append(head);
	const funcs: [string, (p: GeoPBF) => Promise<File | Blob | null>][] = [
		["GeoPBF", p => p.geopbfFile()],
		["GeoJSON", p => p.geojsonFile({ gz: false })],
		["TopoJSON", p => p.topojsonFile({ gz: false })],
		["FGB", p => p.fgbFile({ gz: false })],
		["KMZ", p => p.kmzFile({ kmz: true })],
		["Shape", p => p.shapeFile({ encoding: "utf8" })],
		["GML", p => p.gmlFile({ gz: false })],
		["GPX", p => p.gpxFile({ gz: false })],
		["CZML", p => p.czmlFile({ gz: false })],   // Cesium の時系列/3D 記述（2026-10-24）
		["GeoParquet", async p => {   // 列指向（DuckDB/GeoPandas/BigQuery 向け・2026-10-24）。書き手は geopbf/geoparquet＝初回押下で遅延 import（gishub と同じ）
			p.propertiesTable;   // 遅延復号の属性を全部起こしてから（toGeoParquet は pbf.props を直に読む）
			const { toGeoParquet } = await import("geopbf/geoparquet");
			const { buffer } = await toGeoParquet(p);
			return new File([buffer as Uint8Array<ArrayBuffer>], `${p.name()}.parquet`, { type: "application/vnd.apache.parquet" });
		}],
	];
	for (const [name, fn] of funcs) {
		const b = document.createElement("button");
		b.textContent = name;
		b.onclick = async () => {
			try {
				b.disabled = true;
				const pbf = await getPbf();
				if (!pbf) { toast(t("Nothing to export")); return; }
				const file = await fn(pbf);
				if (file) { download(file as File); toast(t("Saved: $1", (file as File).name)); }
			} catch (e) { console.error("[geoedit] export failed", e); toast(t("Export failed: $1", name)); }
			finally { b.disabled = false; }
		};
		panel.append(b);
	}
	container.append(panel);
	return panel;
}

// ---- IndexedDB セッション（geoedit/session 一枠）----
/** 自動保存の 1 件（コミット済み geopbf のバイト列＋格子段＋視点＋時刻） */
export interface SessionRec { buf: ArrayBuffer; gridExp?: number; view?: string; t?: number }
const DB = "geoedit", STORE = "session";
const openDb = (): Promise<IDBDatabase> => new Promise((res, rej) => {
	const rq = indexedDB.open(DB, 1);
	rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
	rq.onsuccess = () => res(rq.result);
	rq.onerror = () => rej(rq.error);
});
export async function idbSave(rec: SessionRec): Promise<void> {
	try {
		const db = await openDb();
		await new Promise<void>((res, rej) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put(rec, "last");
			tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
		});
		db.close();
	} catch (e) { console.warn("[geoedit] autosave failed", e); }
}
export async function idbLoad(): Promise<SessionRec | null> {
	try {
		// headless等でIDBが黙る環境に備えた起動ハング防止（3秒で「無し」扱い＝新規セッションへ）
		const db = await Promise.race([openDb(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("idb timeout")), 3000))]);
		const rec = await new Promise<SessionRec | undefined>((res, rej) => {
			const rq = db.transaction(STORE).objectStore(STORE).get("last");
			rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
		});
		db.close();
		return rec || null;
	} catch { return null; }
}
export async function idbClear(): Promise<void> {
	try {
		const db = await openDb();
		await new Promise<void>((res, rej) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).delete("last");
			tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
		});
		db.close();
	} catch { /* noop */ }
}
