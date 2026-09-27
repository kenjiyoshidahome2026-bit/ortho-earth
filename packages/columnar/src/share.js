// share.js ── 「弧の共有が多い塗り分けデータか」の物差し（#90・振り分けの規則）。
// gint は共有境界を 1 回だけ描き、巻き数で塗り、連続 LOD を持つ＝admin1・行政地図・塗り分けの面（長い共有弧）に向く。
// 列チャンク層は共有境界を 2 回描く＝筆級（小さな面が大量）・点・線・大きなファイルに向く。
// フラットな幾何の先頭（最大 maxVertices 頂点）を標本に：
//   ratio        … 別の feature に既に現れた頂点（同じ座標）の割合（0..1）。行政界は ≈ 0.4〜0.5・筆も高い・線や点は 0 付近
//   meanVertices … 1 feature あたりの頂点数（線・面の頂点だけ）＝弧の長さの目安。行政界は数百〜数千・筆は 10 前後
import { K } from "./flat.js";

export function shareStats(flat, { maxVertices = 200_000 } = {}) {
	const { xy, featPart, partKind, partStart } = flat, seen = new Map();
	let shared = 0, total = 0, feats = 0;
	for (let f = 0; f < flat.n && total < maxVertices; f++) {
		let any = false;
		for (let p = featPart[f]; p < featPart[f + 1]; p++) {
			if (partKind[p] === K.POINT) continue;
			any = true;
			for (let v = partStart[p]; v < partStart[p + 1]; v++) {
				const key = xy[v * 2] + "," + xy[v * 2 + 1], prev = seen.get(key);
				if (prev === undefined) seen.set(key, f); else if (prev !== f) shared++;
				total++;
			}
		}
		if (any) feats++;
	}
	return { ratio: total ? shared / total : 0, meanVertices: feats ? total / feats : 0, features: feats, vertices: total };
}
// 既定の規則＝gint 向き（true）か。bytes＝源の大きさ（gint は全量を符号化するので上限を置く）
export function gintPreferred(share, bytes = 0, { minRatio = 0.3, minMeanVertices = 40, maxBytes = 64e6 } = {}) {
	return !!share && share.ratio >= minRatio && share.meanVertices >= minMeanVertices && bytes <= maxBytes;
}
