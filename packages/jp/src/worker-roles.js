// 日本の地域パックが worker の入口（@ortho-earth/globe の worker.js）へ足す役＝{ 役名: () => import(脚本) }。
// 入口は globe の "#extra-roles"（既定＝{}）を import する。japan／census2020 の vite が "#extra-roles" をこのファイルへ alias で差し替える
// （部品の builtinWorkers を「作らない版」へ差し替えるのと同じ作法・LAYERS.md 段階 2 S3d ④／S4）。役名は Worker の name（spawnWorker("estat")）。
export const EXTRA_ROLES = {
	estat: () => import("./estat-worker.js"),   // e-Stat 小地域（2026-09-23 S3）
};
