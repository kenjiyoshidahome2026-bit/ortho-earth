// 地域パックが worker の入口（worker.js）へ足す役＝{ 役名: () => import(脚本) }。ホストの役表（render/mesh/gintbake/…・部品の役）はこの外。
// 今は日本（e-Stat 小地域）だけ。S4（packages/globe への移動）後は globe 側の既定＝{}・japan/census2020 の vite が
// この相対 import を @ortho-earth/jp の役表へ alias で差し替える（部品の builtinWorkers を「作らない版」へ差し替えるのと同じ作法・vite.config.js）。
// 役名は Worker の name（spawnWorker("estat")）。脚本は自分で self.onmessage を張る（worker.js の契約）。
export const EXTRA_ROLES = {
	estat: () => import("@ortho-earth/jp/estat-worker"),   // e-Stat 小地域＝日本の地域パックの部品（2026-09-23 S3）
};
