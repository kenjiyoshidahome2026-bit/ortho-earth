// japan の「編集中の図形」の置き場（2026-09-19 本人裁定・2026-09-22 再裁定）：japan は編集中の図形を一つ持つ（初めは空）。
// 読み直しても残るのは geoedit（部品）で編集して × で戻したものだけ（edited:true の印つき）。ドロップ/?g= で見ただけのものは
// 次の起動に持ち越さない（旧＝見ただけでも残り「前の人口密度の押し出しがくっついてくる」と本人報告）。単独 geoedit の自動保存（IDB geoedit/session）とは別の置き場
// ＝部品として編集したデータが単独起動の「前回の続き」に混ざらない。中身＝{ buf: GeoPBF の ArrayBuffer, name, t }
/** 編集中の図形の置き場（IndexedDB）の 1 件 */
export interface EditDocRecord { buf: ArrayBuffer; name?: string; t?: number; edited?: boolean }
const DB = "ortho-japan-edit", STORE = "doc", KEY = "current";
const open = () => new Promise<IDBDatabase>((res, rej) => {
	const rq = indexedDB.open(DB, 1);
	rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
	rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => open().then(db => new Promise<T | undefined>((res, rej) => {
	const t = db.transaction(STORE, mode), r = fn(t.objectStore(STORE));
	t.oncomplete = () => { db.close(); res(r?.result); }; t.onerror = t.onabort = () => { db.close(); rej(t.error); };
}));
export const editDocLoad = (): Promise<EditDocRecord | null | undefined> => tx("readonly", s => s.get(KEY) as IDBRequest<EditDocRecord | undefined>).catch(e => { console.warn("[editdoc] load", e); return null; });
export const editDocSave = (buf: ArrayBuffer, name: string): Promise<unknown> => tx("readwrite", s => s.put({ buf, name, t: Date.now(), edited: true }, KEY)).catch(e => console.warn("[editdoc] save", e));
export const editDocClear = (): Promise<unknown> => tx("readwrite", s => s.delete(KEY)).catch(e => console.warn("[editdoc] clear", e));
