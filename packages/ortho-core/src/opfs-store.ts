// 端末の OPFS に置く PMTiles の出し入れ（UNMAP オフライン版 M2・2026-11-14）。読むのは pmtiles-src（pmtiles://opfs:<道>）。
//   importPMTiles(file, dir)  … 手元のファイル（<input type=file> の File・ダウンロードの Blob）を OPFS の dir/ に写す。PMTiles v3 のヘッダを確かめてから書く。
//                                 書き方は 2 通り：createWritable（Chrome・新しい Safari）→ 無ければ worker の SyncAccessHandle（Safari の古い版は main で書けない）。
//                                 書きかけは <名>.part に置き、書き終えてから正式名へ＝途中で落ちても壊れたアーカイブを読まない
//   listPMTiles(dir)          … dir/ の *.pmtiles（名・大きさ）
//   removePMTiles(dir, name)  … 消す
//   storageInfo() / requestPersist() … 容量の見積もりと持続保存の要求（消されにくくする）
// main でも worker でも動く（DOM 不使用）。M3 の切り出し（planet から矩形を取って書く）も同じ置き場・同じ .part の作法に乗る。

/** OPFS に置いた 1 本 */
export interface StoredPMTiles { name: string; path: string; size: number }
/** PMTiles v3 のヘッダの申告（取り込みの確認に使う分） */
export interface PMTilesHeaderInfo { tileType: number; minZoom: number; maxZoom: number; bounds: [number, number, number, number] }

/** PMTiles v3 のヘッダ（先頭 127 バイト）を読む。違えば null */
export function readPMTilesHeader(buf: ArrayBuffer): PMTilesHeaderInfo | null {
	if (buf.byteLength < 127) return null;
	const v = new DataView(buf), u = new Uint8Array(buf, 0, 7);
	if (String.fromCharCode(...u) !== "PMTiles" || v.getUint8(7) !== 3) return null;
	const e7 = (o: number) => v.getInt32(o, true) / 1e7;
	return { tileType: v.getUint8(99), minZoom: v.getUint8(100), maxZoom: v.getUint8(101), bounds: [e7(102), e7(106), e7(110), e7(114)] };
}

/** 名の門：英数・- _ . だけ・.pmtiles で終わる（道を越えさせない） */
export function safePMTilesName(name: string): string {
	const base = String(name).split(/[\\/]/).pop()!.replace(/\.pmtiles$/i, "").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "archive";
	return base + ".pmtiles";
}

// 道の末尾の / を落とす（正規表現の /\/+$/ は / の長い並びで遅くなる＝CodeQL・素の走査で）
const joinDir = (dir: string): string => { let e = dir.length; while (e > 0 && dir[e - 1] === "/") e--; return dir.slice(0, e); };

async function dirOf(dir: string, create: boolean): Promise<FileSystemDirectoryHandle> {
	let d = await navigator.storage.getDirectory();
	for (const p of dir.split("/").filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
	return d;
}

/** dir/ の *.pmtiles（無ければ []） */
export async function listPMTiles(dir: string): Promise<StoredPMTiles[]> {
	let d: FileSystemDirectoryHandle;
	try { d = await dirOf(dir, false); } catch { return []; }
	const out: StoredPMTiles[] = [];
	for await (const [name, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
		if (h.kind !== "file" || !/\.pmtiles$/i.test(name)) continue;
		out.push({ name, path: `${joinDir(dir)}/${name}`, size: (await (h as FileSystemFileHandle).getFile()).size });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function removePMTiles(dir: string, name: string): Promise<void> {
	const d = await dirOf(dir, false);
	await d.removeEntry(safePMTilesName(name));
}

/** 容量の見積もり（byte）と持続保存の状態 */
export async function storageInfo(): Promise<{ usage: number | null; quota: number | null; persisted: boolean | null }> {
	const e = await navigator.storage.estimate?.().catch(() => null);
	const persisted = await navigator.storage.persisted?.().catch(() => null) ?? null;
	return { usage: e?.usage ?? null, quota: e?.quota ?? null, persisted };
}
export const requestPersist = (): Promise<boolean> => navigator.storage.persist?.().catch(() => false) ?? Promise.resolve(false);

// worker の SyncAccessHandle で書く（createWritable の無い Safari）。worker のソースは文字列＝束ね方に依らない
const SYNC_WRITER = `onmessage = async e => {
	const { dir, part, file } = e.data;
	try {
		let d = await navigator.storage.getDirectory();
		for (const p of dir.split("/").filter(Boolean)) d = await d.getDirectoryHandle(p, { create: true });
		const h = await (await d.getFileHandle(part, { create: true })).createSyncAccessHandle();
		try {
			h.truncate(0);
			const CH = 8 << 20; let at = 0;
			while (at < file.size) { const b = new Uint8Array(await file.slice(at, at + CH).arrayBuffer()); h.write(b, { at }); at += b.byteLength; postMessage({ progress: at }); }
			h.flush();
		} finally { h.close(); }
		postMessage({ done: true });
	} catch (err) { postMessage({ error: String(err && err.message || err) }); }
};`;
function writeViaWorker(dir: string, part: string, file: Blob, onProgress?: (bytes: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(new Blob([SYNC_WRITER], { type: "text/javascript" }));
		const w = new Worker(url);
		const end = (err?: Error) => { w.terminate(); URL.revokeObjectURL(url); if (err) reject(err); else resolve(); };
		w.onmessage = e => { const m = e.data as { progress?: number; done?: boolean; error?: string }; if (m.progress != null) onProgress?.(m.progress); else if (m.done) end(); else if (m.error) end(new Error(m.error)); };
		w.onerror = e => end(new Error(e.message || "opfs writer failed"));
		w.postMessage({ dir, part, file });
	});
}

/** 手元のファイルを OPFS の dir/ に写す。戻り＝置いた 1 本とヘッダの申告。PMTiles v3 でなければ投げる（何も書かない） */
export async function importPMTiles(file: Blob & { name?: string }, dir: string, { name, onProgress }: { name?: string; onProgress?: (bytes: number, total: number) => void } = {}): Promise<StoredPMTiles & { header: PMTilesHeaderInfo }> {
	const header = readPMTilesHeader(await file.slice(0, 127).arrayBuffer());
	if (!header) throw new Error("not a PMTiles v3 archive");
	const fname = safePMTilesName(name ?? file.name ?? "archive"), part = fname + ".part";
	const d = await dirOf(dir, true);
	const fh = await d.getFileHandle(part, { create: true });
	const progress = (b: number) => onProgress?.(b, file.size);
	if (typeof (fh as FileSystemFileHandle & { createWritable?: unknown }).createWritable === "function") {
		const ws = await fh.createWritable();
		try {
			const CH = 8 << 20;
			for (let at = 0; at < file.size; at += CH) { await ws.write(file.slice(at, Math.min(file.size, at + CH))); progress(Math.min(file.size, at + CH)); }
			await ws.close();
		} catch (e) { await ws.abort().catch(() => {}); throw e; }
	} else await writeViaWorker(dir, part, file, progress);
	// .part → 正式名（古い同名は先に消す）。move の無い版は正式名へ写し直して .part を消す
	await d.removeEntry(fname).catch(() => {});
	const mv = (fh as FileSystemFileHandle & { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> }).move;
	if (typeof mv === "function") await mv.call(fh, d, fname);   // (フォルダ, 名前) の 2 引数＝Safari は名前だけの形が無い（"Not enough arguments"・2026-11-14）
	else {   // move の無い版：正式名へ写し直して .part を消す（大きいと時間が掛かる＝稀な経路）
		const src = await fh.getFile();
		const dst = await d.getFileHandle(fname, { create: true });
		if (typeof (dst as FileSystemFileHandle & { createWritable?: unknown }).createWritable === "function") { const ws = await dst.createWritable(); await ws.write(src); await ws.close(); }
		else await writeViaWorker(dir, fname, src);
		await d.removeEntry(part).catch(() => {});
	}
	return { name: fname, path: `${joinDir(dir)}/${fname}`, size: file.size, header };
}
