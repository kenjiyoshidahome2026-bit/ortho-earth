// loaders.gl の「使う 3 名前」だけを束ねる薄い入口。plateaudecode.js はこれを dynamic import する。
// パッケージを直接 dynamic import すると namespace 取得扱いで tree-shaking が効かず、未使用の export まで
// 遅延チャンクに乗る（計量：239 KB → 302 KB に膨れた・2026-09-14）。名前付きの静的 import をここで固定すれば
// 遅延チャンク内で従来どおり刈り込まれる。GLTFLoader は Tiles3DLoader が内部で使う同じ物＝チャンクは増えない（glb 直読み・2026-09-20）。
export { parse as loadParse } from "@loaders.gl/core";
export { Tiles3DLoader } from "@loaders.gl/3d-tiles";
export { GLTFLoader, postProcessGLTF } from "@loaders.gl/gltf";
export { DracoLoader } from "@loaders.gl/draco";   // 模型の書き出し（glbconv）が Draco を解くための注入口。PLATEAU の復号と同じ実体＝チャンクは増えない
export { parse as loadersParse } from "@loaders.gl/core";   // GLTFLoader 単体は生の json＋buffers を返す＝後処理（accessor→typed array・node/mesh の参照解決）は明示に呼ぶ（Tiles3DLoader は内部で呼んでいる）
