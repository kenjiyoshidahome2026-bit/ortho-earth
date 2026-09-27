// convert/spatial-order.js ── 行の空間整列（GeoParquet の行グループ・列チャンク（#90）の切り分けで共有）。
// 元は geoparquet.js の中（2026-09-27 に切り出し＝列チャンクの worker が parquet の書き手ごと抱えないため）。
import { zxyToTileId } from "./pmtiles.js";

// 行の空間整列（行グループの bbox 統計を締めて、読み手が AoI 外の行グループを読まずに飛ばせるようにする）。
// "str"（既定・Sort-Tile-Recursive＝x で √(P) 枚に切り各スライスを y で並べる＝行グループ bbox が互いに重ならない）／
// "hilbert"／"morton"（gint と同じ交互ビット＝最も安い）／"none"（入力順＝行番号が fid）。鍵は feature bbox の中心。
// 井口 (2026) Spatial sort for well-packed GeoParquet の追試: 100 万点で行グループ bbox の重なり率 none 24.5 / morton 0.87 /
// hilbert 0.28 / str 0.00、AoI の候補行グループ 50 / 3-4 / 2 / 1-2。
export function spatialOrder(kind, bbox, has, n, rowGroupSize) {
	const idx = [];
	for (let i = 0; i < n; i++) if (has(i)) idx.push(i);
	const tail = [];
	for (let i = 0; i < n; i++) if (!has(i)) tail.push(i);   // 幾何なしは末尾
	if (kind === "none") return null;
	const cx = new Float64Array(n), cy = new Float64Array(n);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const i of idx) { cx[i] = (bbox[i * 4] + bbox[i * 4 + 2]) / 2; cy[i] = (bbox[i * 4 + 1] + bbox[i * 4 + 3]) / 2; if (cx[i] < x0) x0 = cx[i]; if (cx[i] > x1) x1 = cx[i]; if (cy[i] < y0) y0 = cy[i]; if (cy[i] > y1) y1 = cy[i]; }
	if (kind === "str") {
		idx.sort((a, b) => cx[a] - cx[b] || a - b);
		const P = Math.ceil(idx.length / rowGroupSize), S = Math.ceil(Math.sqrt(P)), per = S * rowGroupSize, out = [];
		for (let s = 0; s * per < idx.length; s++) { const sl = idx.slice(s * per, (s + 1) * per).sort((a, b) => cy[a] - cy[b] || a - b); for (const v of sl) out.push(v); }
		return out.concat(tail);
	}
	const G = 65536, key = new Float64Array(n);
	const sx = x1 > x0 ? (G - 1) / (x1 - x0) : 0, sy = y1 > y0 ? (G - 1) / (y1 - y0) : 0;
	const spread = (v) => { v = (v | (v << 8)) & 0x00FF00FF; v = (v | (v << 4)) & 0x0F0F0F0F; v = (v | (v << 2)) & 0x33333333; v = (v | (v << 1)) & 0x55555555; return v >>> 0; };
	for (const i of idx) {
		const gx = Math.floor((cx[i] - x0) * sx), gy = Math.floor((cy[i] - y0) * sy);
		key[i] = kind === "hilbert" ? zxyToTileId(16, gx, gy) : (spread(gx) | (spread(gy) << 1)) >>> 0;
	}
	idx.sort((a, b) => key[a] - key[b] || a - b);
	return idx.concat(tail);
}

