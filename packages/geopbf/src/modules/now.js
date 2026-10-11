// modules/now.js ── 経過時間の時計（ms）。performance.now があれば単調時計、無ければ Date.now（旧＝約 10 ファイルに同じ 1 行の写し・改良点 15）。
export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
