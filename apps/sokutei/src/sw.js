// sokutei のサービスワーカー（雛形）。vite.config.js の pwa プラグインがビルド時に下の 3 つの定数（版・アセット一覧・base）を埋めて dist に書く。
// 方針：install で全アセットを溜める（アプリは小さい）→ 同一オリジンの GET は溜め置き優先・無ければ網 → 画面遷移（navigate）は網が無ければ index を返す。
// 現場（山中）は電波が無いことが多い＝一度開いた端末では網なしで全部動くのが要件。写真と記録は IndexedDB（store.js）＝sw の外。
const VER = __VER__;
const ASSETS = __ASSETS__;
const BASE = __BASE__;
const CACHE = "sokutei-" + VER;

self.addEventListener("install", e => {
	e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
	e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("sokutei-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
	const req = e.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
	e.respondWith((async () => {
		const c = await caches.open(CACHE);
		const key = req.mode === "navigate" ? BASE : req;   // 画面遷移は ?query や #hash が付いていても index 1 枚
		// ignoreVary：配信元が Vary: Origin を付けていると（vite preview がそう）、同じ URL でも Origin の有無で照合に外れて網なしで開けない。URL はハッシュ付き＝Vary を見る理由が無い
		const hit = await c.match(key, { ignoreVary: true });
		if (hit) return hit;
		try {
			const res = await fetch(req);
			if (res.ok) c.put(key, res.clone());
			return res;
		} catch (err) {
			if (req.mode === "navigate") return (await c.match(BASE)) || Response.error();
			throw err;
		}
	})());
});
