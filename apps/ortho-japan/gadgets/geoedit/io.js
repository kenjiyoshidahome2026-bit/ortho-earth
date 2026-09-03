import { tr } from "../../i18n.js";   // UI二言語化（ja正典・en辞書引き＝エンジン i18n.js の流儀。辞書は各モジュール持参）
const t = tr({
	"書き出し": "Export",
	"書き出すデータがありません": "Nothing to export",
	"保存: {0}": "Saved: {0}",
	"書き出し失敗: {0}": "Export failed: {0}",
	"閉じる": "Close",
});
// 入出力：ドロップ取込（dropfile.js の depth-counter 作法）・8形式エクスポート（gishub と同じ *File() 群）・
// IndexedDB セッション自動保存（コミット済み geopbf の ArrayBuffer を保存＝JSON化しない＝大規模対応）。

export function initDrop(el, onFile, signal) {
	let depth = 0;
	const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
	el.addEventListener("dragenter", e => { if (hasFiles(e)) { depth++; e.preventDefault(); } }, { signal });
	el.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); }, { signal });
	el.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); }, { signal });
	el.addEventListener("drop", e => {
		depth = 0;
		if (!hasFiles(e)) return;
		e.preventDefault();
		const f = e.dataTransfer.files?.[0];
		if (f) onFile(f);
	}, { signal });
}

export function download(file) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(file);
	a.download = file.name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// エクスポートパネル：getPbf() ＝素の fc から新規エンコードした geopbf（precision=格子段）
export function exportPanel(container, getPbf, toast) {
	container.querySelector(".ge-dialog")?.remove();   // 二重開き防止＝開き直し（クラウドと同じ一枠）
	const panel = document.createElement("div");
	panel.className = "ge-panel ge-dialog";
	panel.innerHTML = `<h3>${t("書き出し")}</h3>`;
	const funcs = [
		["GeoPBF", p => p.geopbfFile()],
		["GeoJSON", p => p.geojsonFile({ gz: false })],
		["TopoJSON", p => p.topojsonFile({ gz: false })],
		["FGB", p => p.fgbFile({ gz: false })],
		["KMZ", p => p.kmzFile({ kmz: true })],
		["Shape", p => p.shapeFile({ encoding: "utf8" })],
		["GML", p => p.gmlFile({ gz: false })],
		["GPX", p => p.gpxFile({ gz: false })],
	];
	for (const [name, fn] of funcs) {
		const b = document.createElement("button");
		b.textContent = name;
		b.onclick = async () => {
			try {
				b.disabled = true;
				const pbf = await getPbf();
				if (!pbf) { toast(t("書き出すデータがありません")); return; }
				const file = await fn(pbf);
				if (file) { download(file); toast(t("保存: {0}", file.name)); }
			} catch (e) { console.error("[geoedit] export failed", e); toast(t("書き出し失敗: {0}", name)); }
			finally { b.disabled = false; }
		};
		panel.append(b);
	}
	const close = document.createElement("button");
	close.textContent = t("閉じる");
	close.onclick = () => panel.remove();
	panel.append(document.createElement("hr"), close);
	container.append(panel);
	return panel;
}

// ---- IndexedDB セッション（geoedit/session 一枠）----
const DB = "geoedit", STORE = "session";
const openDb = () => new Promise((res, rej) => {
	const rq = indexedDB.open(DB, 1);
	rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
	rq.onsuccess = () => res(rq.result);
	rq.onerror = () => rej(rq.error);
});
export async function idbSave(rec) {
	try {
		const db = await openDb();
		await new Promise((res, rej) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put(rec, "last");
			tx.oncomplete = res; tx.onerror = () => rej(tx.error);
		});
		db.close();
	} catch (e) { console.warn("[geoedit] autosave failed", e); }
}
export async function idbLoad() {
	try {
		// headless等でIDBが黙る環境に備えた起動ハング防止（3秒で「無し」扱い＝新規セッションへ）
		const db = await Promise.race([openDb(), new Promise((_, rej) => setTimeout(() => rej(new Error("idb timeout")), 3000))]);
		const rec = await new Promise((res, rej) => {
			const rq = db.transaction(STORE).objectStore(STORE).get("last");
			rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
		});
		db.close();
		return rec || null;
	} catch { return null; }
}
export async function idbClear() {
	try {
		const db = await openDb();
		await new Promise((res, rej) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).delete("last");
			tx.oncomplete = res; tx.onerror = () => rej(tx.error);
		});
		db.close();
	} catch { /* noop */ }
}
