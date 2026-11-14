// アプリ自体を端末に置く（M4）：通信なしでも頁が開く＝地図は OPFS（M2/M3）・アプリとエンジンはここ。
// 共有の Service Worker（public/sw.js）を登録し、このビルドの全ファイル（offline.json の目録）を Cache "oj-pack-unmap" に詰める。
// SW は名前が oj-pack で始まる置き場にある URL を通信なしで返す（ナビは ?query を無視して頁を返す）＝?osm= などを付けて開いても同じ頁。
// 詰めるのは通信のある起動で黙って：版（offline.json の build）が変わった時だけ、無いファイルを足して古いファイルを掃く。
// 端末の HTTP 頁（localhost 以外）では SW が動かない＝何もしない。?nosw=1＝登録しない（切り分け用）。

export const PACK = "oj-pack-unmap";
const REC_KEY = "unmap.app-pack";
interface Manifest { build: string; base: string; files: string[] }
export interface AppPackState { state: "saved" | "saving" | "unsupported" | "error" | "none"; build?: string; done?: number; total?: number; message?: string }

const canPack = () => typeof caches !== "undefined" && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1") && !/[?&]nosw=1/.test(location.search);
const readRec = (): string | null => { try { return localStorage.getItem(REC_KEY); } catch { return null; } };
const writeRec = (b: string) => { try { localStorage.setItem(REC_KEY, b); } catch { /* 覚えられない端末＝毎回確かめるだけ */ } };
const swNotify = () => { try { navigator.serviceWorker?.controller?.postMessage({ type: "oj-pack" }); } catch { /* SW 無し */ } };

/** SW を登録して、版が変わっていればアプリを詰める。onState＝札の表示 */
export async function setupAppPack(onState: (s: AppPackState) => void): Promise<void> {
	if (!canPack()) { onState({ state: "unsupported" }); return; }
	try { await navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js", { updateViaCache: "none" }); }
	catch (e) { onState({ state: "error", message: `service worker: ${(e as Error).message}` }); return; }
	const have = readRec(), packed = have && await caches.has(PACK).catch(() => false);
	if (packed) onState({ state: "saved", build: have! });
	if (navigator.onLine === false) { if (!packed) onState({ state: "none" }); return; }
	let man: Manifest | null = null;
	try { const r = await fetch(import.meta.env.BASE_URL + "offline.json", { cache: "no-cache" }); man = r.ok ? await r.json() : null; } catch { /* 通信なし */ }
	if (!man) { if (!packed) onState({ state: "none", message: "dev server (no offline.json)" }); return; }
	if (packed && man.build === have) return;
	try { await packApp(man, (done, total) => onState({ state: "saving", done, total })); writeRec(man.build); swNotify(); onState({ state: "saved", build: man.build }); }
	catch (e) { onState({ state: "error", message: (e as Error).message }); }
}

/** 目録のファイルを詰める（有る物は飛ばす＝content-hash 名は不変）。頁と目録は最後。古い版のファイルは掃く */
async function packApp(man: Manifest, onProgress: (done: number, total: number) => void): Promise<void> {
	const cache = await caches.open(PACK);
	const abs = (f: string) => new URL(man.base + f, location.origin).href;
	const want = man.files.map(abs), page = new URL(man.base, location.origin).href, mf = abs("offline.json");
	let done = 0, i = 0, failed = 0;
	const worker = async () => {
		while (i < want.length) {
			const u = want[i++];
			try {
				if (!(await cache.match(u))) { const r = await fetch(u, { cache: "no-cache" }); if (r.ok) await cache.put(u, r); else failed++; }
			} catch { failed++; }
			if (++done % 10 === 0 || done === want.length) onProgress(done, want.length);
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));
	if (failed) throw new Error(`${failed} file(s) could not be saved`);
	// 頁は最後（頁が指す資産が揃ってから差し替える）
	for (const u of [page, mf]) { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`); await cache.put(u, r); }
	const keep = new Set([...want, page, mf]);
	for (const k of await cache.keys()) if (!keep.has(k.url)) await cache.delete(k);
}
