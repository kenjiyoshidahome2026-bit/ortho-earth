// loaders.gl の「使う 2 名前」だけを束ねる薄い入口。plateaudecode.js はこれを dynamic import する。
// パッケージを直接 dynamic import すると namespace 取得扱いで tree-shaking が効かず、未使用の export まで
// 遅延チャンクに乗る（計量：239 KB → 302 KB に膨れた・2026-09-14）。名前付きの静的 import をここで固定すれば
// 遅延チャンク内で従来どおり刈り込まれる。
export { parse as loadParse } from "@loaders.gl/core";
export { Tiles3DLoader } from "@loaders.gl/3d-tiles";
