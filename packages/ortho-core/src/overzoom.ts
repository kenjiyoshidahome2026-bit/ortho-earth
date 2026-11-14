// 過拡大（overzoom）：祖先のタイル（z−d）の中表現を、子 (z, x, y) の枠の座標へ写す＝MapLibre が maxzoom を越えて親を引き伸ばすのと同じ絵。
// 複合の PMTiles（pmtiles-src の composite）で、どの構成員にもそのタイルが無い時に使う（UNMAP オフライン：保存範囲の外は世界の土台 z5 を引き伸ばす・
// 範囲の上限ズームより上は範囲の最後のズームを引き伸ばす＝「無い所が下地の色（海に見える）」にならない・2026-11-14 タブレットの試験）。
// 写すだけ：面は build の clipToExtent が枠で切る・線は余白の外の線分を build が描かない。ここでは枠に掛からない地物を落とす（点は枠の中だけ＝注記が子ごとに重ならない）。
import type { DecodedFeature, DecodedTile } from "./tileformat.ts";

/** 祖先の中表現 → 子の枠。d＝段数（1 以上）・cx, cy＝祖先の中の子の位置（0..2^d−1）。buffer＝残す余白（extent に対する比） */
export function overzoomTile(tile: DecodedTile, d: number, cx: number, cy: number, buffer = 1 / 16): DecodedTile {
	const s = 2 ** d, out: DecodedTile = {};
	for (const [name, L] of Object.entries(tile)) {
		const E = L.extent, b = E * buffer, ox = cx * E, oy = cy * E, feats: DecodedFeature[] = [];
		for (const f of L.features) {
			const g = f.geom; if (!g) continue;
			const src = g.coords, n = src.length, c = new Int32Array(n);
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (let i = 0; i < n; i += 2) {
				const x = src[i] * s - ox, y = src[i + 1] * s - oy; c[i] = x; c[i + 1] = y;
				if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
			}
			if (f.type === "Point") {   // 枠の中の点だけ（多点は中の点だけ残す）
				const keep: number[] = [];
				for (let i = 0; i < n; i += 2) if (c[i] >= 0 && c[i] < E && c[i + 1] >= 0 && c[i + 1] < E) keep.push(c[i], c[i + 1]);
				if (!keep.length) continue;
				feats.push({ ...f, geom: { coords: Int32Array.from(keep), ends: keep.length === n ? g.ends : keep.map((_, i) => i + 2).filter(i => i % 2 === 0) } });   // 多点＝1 点ごとに ends
				continue;
			}
			if (x1 < -b || y1 < -b || x0 > E + b || y0 > E + b) continue;   // 枠と余白に掛からない
			feats.push({ ...f, geom: { ...g, coords: c } });
		}
		if (feats.length) out[name] = { extent: E, features: feats };
	}
	return out;
}
