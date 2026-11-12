// 通信なしでもエンジンの worker が起きるように（完全オフライン・2026-11-13）。
// Chrome は頁の new Worker(url) の脚本の取得をサービスワーカーに通さない（容器の Chromium で実測：SW の fetch に届かず、
// 通信なしでは端末の束に入っているのに起動に失敗）。いま本番のオフラインが動くのは、エンジンの worker の脚本が
// ブラウザの HTTP キャッシュに残っているから（MacBook 2026-11-13：no-cache で配ると通信なしで地図が起きない）＝
// 「キャッシュされた画像とファイル」を消した端末や、HTTP キャッシュから追い出された端末では、災害時に地図が起きない。
// 対策：通信が無い時だけ、同じオリジンの module worker を「import するだけの blob」から起こす。blob の worker は作り手の
// サービスワーカーを受け継ぐ＝中の import（エンジンの worker 本体とその chunk）が SW を通り、束から読める。
// 入れ子の worker（render worker の中の標高 worker 等）も同じ包みを worker の中に入れて起こす。
// 通信のある時は何もしない（worker の通信が SW を通らない従来のまま＝速さも挙動も変えない）。

/** worker の中でも同じ物を入れる＝関数の字面を blob へ書き出す（外の名前を参照しない・型も使わない） */
function install(origin: string): void {
	const g = self as unknown as { Worker?: typeof Worker & { __ykBoot?: boolean } };
	const N = g.Worker;
	if (!N || N.__ykBoot) return;
	const made = new Map<string, string>();
	const wrap = (u: string | URL, o?: WorkerOptions): string | URL => {
		if (!o || o.type !== "module") return u;   // classic（importScripts の世界）と blob: はそのまま
		let h: string;
		try { h = (u instanceof URL ? u : new URL(String(u), self.location.href)).href; } catch { return u; }
		if (!h.startsWith(origin + "/")) return u;
		let b = made.get(h);
		if (!b) { b = URL.createObjectURL(new Blob(["(" + install.toString() + ")(" + JSON.stringify(origin) + ");await import(" + JSON.stringify(h) + ");"], { type: "text/javascript" })); made.set(h, b); }   // 解かない＝入れ子の worker もこの URL を使い回す
		return b;
	};
	class W extends N { constructor(u: string | URL, o?: WorkerOptions) { super(wrap(u, o), o); } }
	(W as unknown as { __ykBoot: boolean }).__ykBoot = true;
	g.Worker = W as unknown as typeof Worker & { __ykBoot?: boolean };
}

/** 頁で一度だけ。SW が頁を握っていて、いま通信が無い時に入れる（起動の後で切れたら、その後に起こす worker から） */
export function bootWorkersFromPack(): void {
	if (typeof Worker === "undefined" || typeof Blob === "undefined") return;
	const on = () => { if (!navigator.onLine && navigator.serviceWorker?.controller) install(location.origin); };
	on(); addEventListener("offline", on);
}
