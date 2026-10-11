// 注記の鍵（重複排除・当選集合・フェードの同一性）＝一つの式を tile worker（labels.js が焼く）・main（tilemanager.labels の重複排除）・
// render worker（labels2d の当選集合）で共有する。旧＝3 か所がそれぞれ toFixed を回して同じ文字列を組んでいた（2026-10-03）。
// MapLibre 由来の層（mlp）は層の添字 li も鍵に入れる＝同じ点・同じ文字の別の層を 1 つに畳まない（poi_transit／poi_r1 2026-09-28）。
// 記号だけの注記（text ""）は記号名で区別。利用者層の id（L.k）は labels2d が前置する（層またぎの衝突防止）。
// 焼いた鍵（L.key）があればそれ＝文字や錨を変えた写し（mergeChome など）は key を付け直すこと。
export const labelKey = L => L.key ?? ((L.mlp && L.li != null ? L.li + "\u0002" : "") + L.text + (L.icon ? "\u0001" + L.icon : "") + "@" + L.anchor[0].toFixed(5) + "," + L.anchor[1].toFixed(5));
