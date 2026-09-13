// ortho-japan/worker.js ── アプリ側 worker の唯一の入口（処方③④・ortho-earth#12・2026-09-14）。
//
// render / plateau / plateaudecoder / gintbake / estat を別ファイルの worker として new Worker すると、vite は worker ごとに
// 独立した rollup ビルドを回す＝loaders.gl（plateauworker と plateaudecoder で二重・約 360 KB）や geopbf の核・ortho-core の
// glsl.js が worker の数だけ複製された（dist/lib の計量）。入口をこの 1 本にし、役割を動的 import にすると worker ビルドは
// 1 つ＝共有物はその中の共有チャンク 1 つになる。geopbf/src/worker.js と同じ流儀。
//
// 役割の指名は Worker の name：`new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "render" })`。
// URL に ?query を足す方式は vite の静的検出（new Worker(new URL('…', import.meta.url), {静的 options})）を壊すので使わない。
// 各 worker 脚本（renderworker.js …）は従来どおり「自分で self.onmessage を張る」まま無改修。ここは指名された脚本を読み込み、
// 読み込み中に届いたメッセージを順序を保って手渡すだけ（renderworker の init → 以降の順序契約はそのまま）。
const ROLES = {
	render:         () => import("./renderworker.js"),
	plateau:        () => import("./plateauworker.js"),
	plateaudecoder: () => import("./plateaudecoder.js"),
	gintbake:       () => import("./gintbakeworker.js"),
	estat:          () => import("./estatworker.js"),
};

const pending = [];
const enqueue = e => pending.push(e);
self.onmessage = enqueue;

(async () => {
	const load = ROLES[self.name];
	try {
		if (!load) throw new Error(`unknown worker role "${self.name}"（${Object.keys(ROLES).join(" / ")}）`);
		await load();                                   // 脚本が自分の onmessage を張る
		if (self.onmessage === enqueue) throw new Error(`${self.name}: the script did not install onmessage`);
	} catch (err) {
		console.error("[worker]", err);
		self.onmessage = () => {};                      // 起動失敗＝main 側の onerror / タイムアウト（起動 10 秒の見張り）に委ねる
		throw err;                                      // uncaught にして main の worker.onerror を鳴らす
	}
	const handler = self.onmessage;
	for (const e of pending.splice(0)) handler.call(self, e);
})();
