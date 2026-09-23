// loaders.gl の I3S だけを束ねる薄い入口（mesh-loaders.js と同じ作法＝名前付きの静的 import で遅延チャンク内の刈り込みを効かせる）。i3s-decode.js が dynamic import する
export { parse } from "@loaders.gl/core";
export { I3SLoader } from "@loaders.gl/i3s";
