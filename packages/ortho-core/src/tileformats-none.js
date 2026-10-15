// "#tile-formats"（package.json の imports）の既定＝追加のタイル形式なし（MVT だけ・decode.js が自分で登録する）。
// MLT を描くアプリは vite の alias で "#tile-formats" を @ortho-earth/core/tileformats-mlt へ向ける（builtinWorkers と同じ作法・#88）。
export {};
