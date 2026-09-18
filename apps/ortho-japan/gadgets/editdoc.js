// japan の「編集中の図形」の置き場（2026-09-19 本人裁定）：japan は編集中の図形を一つ持つ（初めは空）。ドロップ/?g= で読んだもの・
// geoedit（部品）で編集して × で戻したものがそれになり、読み直しても残る。単独 geoedit の自動保存（IDB geoedit/session）とは別の置き場
// ＝部品として編集したデータが単独起動の「前回の続き」に混ざらない。中身＝{ buf: GeoPBF の ArrayBuffer, name, t }
const DB = "ortho-japan-edit", STORE = "doc", KEY = "current";
const open = () => new Promise((res, rej) => {
	const rq = indexedDB.open(DB, 1);
	rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
	rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
	const t = db.transaction(STORE, mode), r = fn(t.objectStore(STORE));
	t.oncomplete = () => { db.close(); res(r?.result); }; t.onerror = t.onabort = () => { db.close(); rej(t.error); };
}));
export const editDocLoad = () => tx("readonly", s => s.get(KEY)).catch(e => { console.warn("[editdoc] load", e); return null; });
export const editDocSave = (buf, name) => tx("readwrite", s => s.put({ buf, name, t: Date.now() }, KEY)).catch(e => console.warn("[editdoc] save", e));
export const editDocClear = () => tx("readwrite", s => s.delete(KEY)).catch(e => console.warn("[editdoc] clear", e));
