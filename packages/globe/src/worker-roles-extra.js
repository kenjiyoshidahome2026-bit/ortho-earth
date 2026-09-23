// 地域パックが worker の入口（worker.js）へ足す役の既定＝無し。worker.js は "#extra-roles"（package.json の imports）で
// これを読む。地域の役が要るアプリ（japan／census2020＝e-Stat）は vite の alias で "#extra-roles" を @ortho-earth/jp/worker-roles へ
// 差し替える（部品の builtinWorkers を「作らない版」へ差し替えるのと同じ作法・LAYERS.md 段階 2 S3d ④／S4 2026-09-23）。
export const EXTRA_ROLES = {};
