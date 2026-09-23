// ortho-japan/worker.js ── アプリ側 worker の唯一の入口（処方③④・ortho-earth#12・2026-09-14）。
//
// render / plateau / meshdecoder / gintbake / estat を別ファイルの worker として new Worker すると、vite は worker ごとに
// 独立した rollup ビルドを回す＝loaders.gl（meshworker と meshdecoder で二重・約 360 KB）や geopbf の核・ortho-core の
// glsl.js が worker の数だけ複製された（dist/lib の計量）。入口をこの 1 本にし、役割を動的 import にすると worker ビルドは
// 1 つ＝共有物はその中の共有チャンク 1 つになる。geopbf/src/worker.js と同じ流儀。
//
// 役割の指名は Worker の name：`new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "render" })`。
// URL に ?query を足す方式は vite の静的検出（new Worker(new URL('…', import.meta.url), {静的 options})）を壊すので使わない。
// 各 worker 脚本（renderworker.js …）は従来どおり「自分で self.onmessage を張る」まま無改修。ここは指名された脚本を読み込み、
// 読み込み中に届いたメッセージを順序を保って手渡すだけ（renderworker の init → 以降の順序契約はそのまま）。
// 地域の役（e-Stat 等）は worker-roles-extra.js＝地球儀のホストは地域の worker を知らない（LAYERS.md 段階 2 S3d ④）
import { EXTRA_ROLES } from "./worker-roles-extra.js";
const ROLES = {
	render:         () => import("./renderworker.js"),
	mesh:           () => import("./meshworker.js"),
	meshdecoder: () => import("./meshdecoder.js"),
	gintbake:       () => import("./gintbakeworker.js"),
	rastertiles:    () => import("./rastertiles-worker.js"),   // ローカル GeoPackage/MBTiles の画像タイルを配る（画像タイル層の "port" プロバイダ・2026-09-21）
	imagequad:      () => import("./imagequad-worker.js"),     // 四隅で貼った画像をタイルに焼いて配る（同じ "port" 契約・2026-09-21）
	model:          () => import("./model-worker.js"),         // glTF/GLB と押し出しを建物メッシュへ（2026-09-22 に入口へ統合＝loaders.gl・meshdecode・earcut を render/plateau と共有＝別ビルドの複製を断つ）
	parquet:        () => import("./gadgets/parquet-worker.js"),   // GeoParquet の視野追従（同上・geopbf の核を共有）
	// 部品の worker（2026-09-22・標準の作法＝各部品の setWorkerFactory / 役割名 → この入口）。geopbf の役割（decoder:/encoder:/geopbf:）は下の正規表現
	"ortho:tile":    () => import("@ortho-earth/core/workers/tile"),      // タイルの取得・解読・三角形化（createPipeline の workerFactory）
	"ortho:scene":   () => import("@ortho-earth/core/workers/scene"),     // シーンの結合
	"altpbf:height": () => import("altpbf/worker"),                // 標高タイルの復号（main の createGetHeight・render worker の terrain）
	"geoedit:model": () => import("geoedit/model-worker"),         // geoedit の編集モデル
	...EXTRA_ROLES,
};

const pending = [];
const enqueue = e => pending.push(e);
self.onmessage = enqueue;

(async () => {
	// geopbf の役割（"decoder:*" "encoder:*" "geopbf:*"）＝geopbf の入口（self.name で形式を読む）へ（createGeopbf の workerFactory・2026-09-22）
	const load = ROLES[self.name] ?? (/^(decoder|encoder|geopbf):/.test(self.name) ? () => import("geopbf/worker") : undefined);
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
