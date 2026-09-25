// サービスワーカー：ビルド成果物（/japan/assets/ 配下の content-hash 名チャンク）を Cache API で版管理する。
// 狙い＝本人年来の手法「読んだモジュールを保存し、未改版なら再ダウンロードせず直に使う（改版された時だけ取り直す）」を
//   標準プリミティブで実現。Vite の content-hash ファイル名が“自動の版ゲート”＝中身が変われば名前(URL)も変わる。
//   ∴ ハッシュ名資産は cache-first（不変＝一度掴めば無通信で再利用）／index.html は network-first（新ハッシュを常に拾う＝新デプロイ即反映）。
// 効能＝再訪は render/plateau worker(187/237KB)・wasm(126KB)・本体(279KB) を無通信で即起動＝転送とトランザクション激減＋オフライン起動の保険。
// 触らない＝地図タイル/標高/PLATEAU/e-Stat 等の巨大データ＆クロスオリジンは素通し（アプリのIDBが面倒を見る領域＝二重管理しない）。
//   非ハッシュの同一オリジン資産(json/png)も素通し＝版ズレの罠を避け、ブラウザのHTTPキャッシュに委ねる。
// 依存ゼロ（[[軽さの訴求]] の掟＝出荷コードに npm を足さない）。★ロジックを変えたら CACHE の版番号を上げる＝activate で旧キャッシュを一掃。
// 前提：登録は本番httpsの index.html だけ（[[gadget-development-principle]] と同じくアプリ本体 app.js には副作用を入れない＝埋め込みを汚さない）。
const CACHE = "oj-assets-v4";      // v4＝2026-09-25 オフラインパック（#40）＝PACK の cache-first と、起動に要る json の退避を足した
const PACK = "oj-pack";            // オフラインパック（gadgets/offline.js が詰める＝基図タイル・ラスタ）。activate で掃かない（利用者の持ち物）
// パックがあるか＝SW の生存中に一度だけ調べる（無ければクロスオリジンは素通し＝従来と同じ費用）。gadget が作る/消すたびに postMessage で取り直す
let packOn = null;
const hasPack = async () => packOn ??= await caches.has(PACK).catch(() => false);
self.addEventListener("message", e => { if (e.data?.type === "oj-pack") packOn = null; });      // v3＝2026-09-22 の大改名（PLATEAU→mesh・遅延ロードの組み替え）で旧チャンクが全部入れ替わった＝古い掴みを一掃する
// v2＝SDK二重構成（2026-08-20）：/japan/lib/ を導入した版
// content-hash 名の不変資産＝cache-first で握るプレフィックス。
//   /japan/assets/     … サイト殻（site.js・scenes台本・scene.html エディタ）のチャンク
//   /japan/lib/assets/ … SDK（本番の index が食うエンジン実体）のチャンク＝配布 zip と同一物
const ASSETS = ["/japan/assets/", "/japan/lib/assets/"];
// lib の入口2枚（ortho-japan.js / .css）はハッシュ無し＝不変と扱えない。navigate と同じ
// network-first＋キャッシュ退避＝新デプロイを常に拾いつつオフライン起動も守る。
const LIB_ENTRY = ["/japan/lib/ortho-japan.js", "/japan/lib/ortho-japan.css"];

// 即・次バージョンへ（precache はしない＝遅延ロードの精神を守り、資産は「使う時に一度だけ」掴む）。
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => e.waitUntil((async () => {
	// 版を上げた時だけ旧キャッシュを掃く（同一版の中では未改版ハッシュが自然に再利用される＝取り直さない）。
	const keys = await caches.keys();
	await Promise.all(keys.filter(k => k !== CACHE && k !== PACK).map(k => caches.delete(k)));
	packOn = null;
	await self.clients.claim();
})()));

self.addEventListener("fetch", e => {
	const req = e.request;
	if (req.method !== "GET") return;                        // 変更系は素通し
	const url = new URL(req.url);
	// ⓪ オフラインパック（#40）＝パックに入っている URL（基図タイル・ラスタ＝クロスオリジン）だけ cache-first。無ければ素の fetch（保存しない＝
	//    パックの外は従来どおり HTTP キャッシュ任せ）。機内モードでパックの範囲が開く仕組み。パックが 1 つも無ければ照会も一度で済む
	if (url.origin !== location.origin) {
		if (packOn === false) return;   // パック無し＝素通し（照会もしない）
		e.respondWith((async () => {
			if (!(await hasPack())) return fetch(req);
			const hit = await caches.match(req.url, { cacheName: PACK }).catch(() => null);
			return hit || fetch(req);
		})());
		return;
	}

	// ① ハッシュ名の不変資産＝cache-first（掴んでいれば無通信、無ければ取って保存）。worker/wasm/css/lazyチャンクが全部ここ。
	if (ASSETS.some(p => url.pathname.startsWith(p))) {
		e.respondWith((async () => {
			const cache = await caches.open(CACHE);
			const hit = await cache.match(req);
			if (hit) return hit;
			const res = await fetch(req);
			if (res.ok) cache.put(req, res.clone());          // 成功(200)時のみ保存＝部分/失敗レスポンスは掴まない
			return res;
		})());
		return;
	}

	// ② ナビゲーション（index.html）と lib 入口（ハッシュ無しの ortho-japan.js/.css）＝network-first・
	//    失敗時はキャッシュ（新デプロイを常に拾いつつ、オフライン起動の保険）。
	if (req.mode === "navigate" || LIB_ENTRY.includes(url.pathname)) {
		e.respondWith((async () => {
			try {
				const res = await fetch(req);
				if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
				return res;
			} catch {
				return (await caches.match(req)) || Response.error();
			}
		})());
		return;
	}
	// ③ 起動に要る非ハッシュの json（台帳・カタログ）＝network-first・失敗時はキャッシュ（オフライン起動の保険・#40）。png 等は素通し。
	if (/\.json$/.test(url.pathname)) {
		e.respondWith((async () => {
			try {
				const res = await fetch(req);
				if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
				return res;
			} catch {
				return (await caches.match(req)) || Response.error();
			}
		})());
	}
});
