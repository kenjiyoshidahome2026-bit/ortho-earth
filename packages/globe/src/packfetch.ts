// 作業スレッド（worker）の取りを、端末に保存した束（Cache Storage の oj-pack*）へも落とせるようにする（完全オフライン・横浜 2026-11-12）。
// 頁の Service Worker は worker を制御しない（worker の URL＝/globe/engine/… がアプリの SW の scope＝/yokohama/ の外）＝
// 頁の取りは SW が束から返すが、建物（mesh）・模型（model）の worker の取りは素通しで網へ行き、通信なしでは全部落ちていた
//（束に入っている tileset.json・b3dm でも・Mac 実測：1 分に 17.7 万本の失敗）。worker は caches を直に読める＝ここで引く。
// 通信がある時は従来どおり網（束は見ない）。通信が無い（navigator.onLine=false）か、網で落ちた時だけ束から。HTTP エラーの応答はそのまま返す
const PACK = "oj-pack";
let names: Promise<string[]> | null = null, namesAt = 0;
const packNames = (): Promise<string[]> => {
	const now = Date.now();
	if (!names || now - namesAt > 30000) { namesAt = now; names = typeof caches === "undefined" ? Promise.resolve([]) : caches.keys().then(k => k.filter(n => n.startsWith(PACK))).catch(() => []); }   // 束は保存・削除で増減＝30 秒ごとに見直す
	return names;
};
/** 束の中の応答（どの束でも・Vary は見ない）。無ければ null */
export async function fromPack(url: string): Promise<Response | null> {
	for (const n of await packNames()) {
		const r = await caches.open(n).then(c => c.match(url, { ignoreVary: true })).catch(() => null);
		if (r) return r;
	}
	return null;
}
/** fetch の代わり（文字列の URL のみ）：通信なし＝束を先に・網で落ちた＝束へ。止めた（signal）時は束へ逃げない */
export async function fetchOrPack(url: string, init?: RequestInit): Promise<Response> {
	if (typeof navigator !== "undefined" && navigator.onLine === false) { const r = await fromPack(url); if (r) return r; }
	try { return await fetch(url, init); }
	catch (e) {
		if (init?.signal?.aborted) throw e;
		const r = await fromPack(url); if (r) return r;
		throw e;
	}
}
