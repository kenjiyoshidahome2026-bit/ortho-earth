// サービスワーカー（各アプリ共通の一枚・2026-10-15〜 正本はここ＝各アプリの public/sw.js はこれへの symlink）：
// ビルド成果物（<アプリの base>assets/ 配下の content-hash 名チャンク）を Cache API で版管理する。
// SW は自分の置き場より上を操れない（仕様）＝ファイルは各アプリの base に置くしかない。中身は一つ＝base は登録の scope から読む
// （japan＝/japan/・census2020＝/japan/census2020/・nl＝/nl/）。
// 狙い＝本人年来の手法「読んだモジュールを保存し、未改版なら再ダウンロードせず直に使う（改版された時だけ取り直す）」を
//   標準プリミティブで実現。Vite の content-hash ファイル名が“自動の版ゲート”＝中身が変われば名前(URL)も変わる。
//   ∴ ハッシュ名資産は cache-first（不変＝一度掴めば無通信で再利用）／index.html は network-first（新ハッシュを常に拾う＝新デプロイ即反映）。
// 効能＝再訪は render/plateau worker(187/237KB)・wasm(126KB)・本体(279KB) を無通信で即起動＝転送とトランザクション激減＋オフライン起動の保険。
// 触らない＝地図タイル/標高/PLATEAU/e-Stat 等の巨大データ＆クロスオリジンは素通し（アプリのIDBが面倒を見る領域＝二重管理しない）。
//   非ハッシュの同一オリジン資産(json/png)も素通し＝版ズレの罠を避け、ブラウザのHTTPキャッシュに委ねる。
// 依存ゼロ（[[軽さの訴求]] の掟＝出荷コードに npm を足さない）。★ロジックを変えたら CACHE の版番号を上げる＝activate で旧キャッシュを一掃。
// 前提：登録は本番httpsの index.html だけ（[[gadget-development-principle]] と同じくアプリ本体 app.js には副作用を入れない＝埋め込みを汚さない）。
const CACHE = "oj-assets-v10";     // v10＝2026-11-13 束から返す越境の応答に CORP を付ける（COEP credentialless の頁で横浜の名所写真が通信なしで出なかった）・v9＝2026-11-12 横浜の完全オフライン（パックを oj-pack* の名前で複数持てる・同一オリジンもパックへ退避・ナビは ?query 無視でパックから）・v8＝2026-10-15 japan の一枚を各アプリ共通に（base を scope から読む＝census2020・nl も自分の assets/ を握る）・v7＝2026-10-14 エンジンの入口に jp/*・nl/* が入った（入口の判定を assets/ の外に一般化）・v6＝2026-10-14 共有エンジンの入口（globe.js 等）を network-first へ＝旧版の入口を握ったまま遅延チャンクを旧版へ取りに行って 404（tellus の cog）・v5＝2026-09-30 共有エンジン（/globe/engine/<版>/）を cache-first に足した・v4＝2026-09-25 オフラインパック（#40）＝PACK の cache-first と、起動に要る json の退避を足した
const PACK = "oj-pack";            // オフラインパック（gadgets/offline.js が詰める＝基図タイル・ラスタ）。activate で掃かない（利用者の持ち物）
// パックは名前が PACK で始まる Cache 全部（2026-11-12〜）：oj-pack＝範囲の gadget・oj-pack-<アプリ>＝アプリ丸ごとの束（横浜＝oj-pack-yokohama）。
// 束ごとに置き場を分ける＝gadget の「最後のパックを消す＝置き場ごと消す」がアプリの束を巻き込まない
const isPack = k => k.startsWith(PACK);
// パックがあるか＝SW の生存中に一度だけ調べる（無ければクロスオリジンは素通し＝従来と同じ費用）。gadget／アプリが作る/消すたびに postMessage で取り直す
let packOn = null, packNames = [];
const hasPack = async () => packOn ??= await caches.keys().then(ks => (packNames = ks.filter(isPack)).length > 0).catch(() => false);
// パックから引く（どの束でも・Vary は見ない＝詰めた時の要求と今の要求で Origin 等の頭が違っても同じ物）
const fromPack = async (url, opt = {}) => { if (!(await hasPack())) return null; for (const n of packNames) { const r = await caches.match(url, { cacheName: n, ignoreVary: true, ...opt }).catch(() => null); if (r) return r; } return null; };
// 通信が切れた時の受け皿＝パック → 普段の置き場の順（同一オリジンの要求）
const offline = async (req, opt = {}) => (await fromPack(req.url, opt)) || (await caches.match(req, { ignoreVary: true, ...opt }).catch(() => null)) || Response.error();
// 束から返す越境の応答に Cross-Origin-Resource-Policy: cross-origin を付ける（<img> 等の no-cors の要求だけ）。
// 頁は COEP: credentialless。網から来た no-cors の応答は「資格情報なしで取った」と分かるので CORP 無しでも通るが、
// Cache Storage から返した応答はその印を失い、CORP の無い越境の応答として弾かれる（net::ERR_FAILED）＝
// 横浜の名所写真（upload.wikimedia.org）が束に入っているのに通信なしで出なかった（MacBook 本番 2026-11-13）。
// 中身が読める応答（cors で詰めた物）だけ頭を足せる。不透明な応答（opaque）は触れない＝そのまま返す
const corp = res => {
	if (res.type === "opaque" || res.headers.has("Cross-Origin-Resource-Policy")) return res;
	const h = new Headers(res.headers); h.set("Cross-Origin-Resource-Policy", "cross-origin");
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};
self.addEventListener("message", e => { if (e.data?.type === "oj-pack") packOn = null; });      // v3＝2026-09-22 の大改名（PLATEAU→mesh・遅延ロードの組み替え）で旧チャンクが全部入れ替わった＝古い掴みを一掃する
// v2＝SDK二重構成（2026-08-20）：/japan/lib/ を導入した版
// このアプリの base（登録の scope の path＝"/japan/" など・末尾 /）
const BASE = new URL(self.registration.scope).pathname;
// content-hash 名の不変資産＝cache-first で握るプレフィックス。
//   <base>assets/      … サイト殻（japan＝site.js・scenes台本・scene.html エディタ）のチャンク
//   <base>lib/assets/  … SDK（外へ配る物・japan だけ）のチャンク＝配布 zip と同一物
//   /globe/engine/     … 共有エンジン（本番の japan が食うエンジン実体・2026-09-30）＝<版>が中身のハッシュ＝不変。
//                        古い版の入口は今の版へ 302 される（エンジンの Worker ortho-engine）＝転送された応答は掴まない（下の !res.redirected）
//                        ただし入口（/globe/engine/<版>/globe.js 等＝名前が版を跨いで同じ）は cache-first にしない＝下の ENGINE_ENTRY
const ASSETS = [BASE + "assets/", BASE + "lib/assets/", "/globe/engine/"];
// 共有エンジンの入口＝network-first（HTTP キャッシュも再検証）。cache-first だと版が退役した後も旧版の入口で動き続け、
// まだ掴んでいない遅延チャンクを消えた旧版の住所へ取りに行って 404 になる（2026-10-14・tellus の cog-*.js）。今の版なら 304 で済む
const ENGINE_ENTRY = /^\/globe\/engine\/[0-9a-f]{10}\/(?!assets\/)[\w/-]+\.(js|css)$/;   // 入口＝assets/ の外（regions/app.js 等も・2026-10-14）
// lib の入口（japan＝ortho-japan.js / .css＝<base>lib/ 直下の js・css）はハッシュ無し＝不変と扱えない。navigate と同じ
// network-first＋キャッシュ退避＝新デプロイを常に拾いつつオフライン起動も守る。
const isLibEntry = p => p.startsWith(BASE + "lib/") && !p.slice(BASE.length + 4).includes("/") && /\.(js|css)$/.test(p);

// 即・次バージョンへ（precache はしない＝遅延ロードの精神を守り、資産は「使う時に一度だけ」掴む）。
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => e.waitUntil((async () => {
	// 版を上げた時だけ旧キャッシュを掃く（同一版の中では未改版ハッシュが自然に再利用される＝取り直さない）。
	const keys = await caches.keys();
	await Promise.all(keys.filter(k => k !== CACHE && !isPack(k)).map(k => caches.delete(k)));
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
		if (packOn === false || req.cache === "reload" || req.cache === "no-store") return;   // パック無し＝素通し（照会もしない）・reload＝束を詰め直す取得（パックを見ずに網へ）
		e.respondWith((async () => {
			if (!(await hasPack())) return fetch(req);
			const hit = await fromPack(req.url);
			return hit ? (req.mode === "no-cors" ? corp(hit) : hit) : fetch(req);
		})());
		return;
	}

	// ⓪' 共有エンジンの入口＝network-first（cache: "no-cache"＝HTTP キャッシュの immutable も再検証）・失敗時はキャッシュ（オフライン起動の保険）。
	//     旧版の入口は Worker が今の版へ 302 する＝転送された応答は掴まない（掴むと旧版の名前に今の版の中身が載り、相対 import の住所がずれる）
	if (ENGINE_ENTRY.test(url.pathname)) {
		e.respondWith((async () => {
			try {
				const res = await fetch(req, { cache: "no-cache" });
				if (res.ok && !res.redirected) (await caches.open(CACHE)).put(req, res.clone());
				return res;
			} catch {
				return offline(req);
			}
		})());
		return;
	}

	// ⓪" 共有エンジンの今の版の札（/globe/engine/current.json）＝掴まない（素通し）。エンジンが「旧版を握ったままか」を確かめる時に読む
	//     （packages/globe/scripts/lib/engine-stale.mjs・2026-10-14）＝下の ① の cache-first に入ると古い札を返し続けて確かめが効かない
	//     通信が無い時だけパックの札（アプリの束が詰めた時の版）を返す
	if (url.pathname === "/globe/engine/current.json") { if (packOn !== false) e.respondWith(fetch(req).catch(() => offline(req))); return; }

	// ① ハッシュ名の不変資産＝cache-first（掴んでいれば無通信、無ければ取って保存）。worker/wasm/css/lazyチャンクが全部ここ。
	if (ASSETS.some(p => url.pathname.startsWith(p))) {
		e.respondWith((async () => {
			const cache = await caches.open(CACHE);
			const hit = await cache.match(req);
			if (hit) return hit;
			let res;
			try { res = await fetch(req); } catch { return offline(req); }   // 通信なし＝アプリの束（パック）にあればそれ
			if (res.ok && !res.redirected) cache.put(req, res.clone());   // 成功(200)時のみ保存＝部分/失敗レスポンスと、旧版→今の版の転送は掴まない
			return res;
		})());
		return;
	}

	// ② ナビゲーション（index.html）と lib 入口（ハッシュ無しの <base>lib/*.js・*.css）＝network-first・
	//    失敗時はキャッシュ（新デプロイを常に拾いつつ、オフライン起動の保険）。
	if (req.mode === "navigate" || isLibEntry(url.pathname)) {
		e.respondWith((async () => {
			try {
				const res = await fetch(req);
				if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
				return res;
			} catch {
				// 通信なし：ナビは ?lang= 等を無視してパックの頁を先に（パックの頁はパックの資産と同じ版＝必ず揃う）→ 普段の置き場
				if (req.mode !== "navigate") return offline(req);
				return (await fromPack(req.url, { ignoreSearch: true })) || (await fromPack(new URL("./", req.url).href, { ignoreSearch: true }))
					|| (await caches.match(req, { ignoreVary: true }).catch(() => null)) || (await caches.match(req, { ignoreSearch: true, ignoreVary: true }).catch(() => null)) || Response.error();
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
				return offline(req);
			}
		})());
		return;
	}
	// ④ その他の同一オリジン（png・bin・wasm 等）＝素通し。パックがある時だけ、通信が切れたらパックから
	if (packOn !== false) e.respondWith((async () => { try { return await fetch(req); } catch { return (await fromPack(req.url)) || Response.error(); } })());
});
