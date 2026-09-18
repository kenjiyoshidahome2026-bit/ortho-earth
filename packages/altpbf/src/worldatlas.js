// 全球アトラス（WORLD_ATLAS）＝R90 8 枚（各 2700²・計 55MB）を 1024/90° へ再標本化して 1 枚（4096×2048・Int16）にした焼き済み標高。
// 用途＝ハイプソ/地形の「R90 床」：equal の全球ハイプソと ortho-japan の R90 固定窓（z<5.5 の近窓・z<8 の far 床）は
// どちらも同じ 4×2@1024 を毎回 8 枚から作っていた（復号 8 回＋再標本化 8 回）。焼き済み 1 本（3.25MB・復号 1 回＝実測 2026-09-18）で置き換える。
// 焼くのは apps/uploader（bakeWorldAtlas → encode → bucket GIS/alt）。消費は loadTile.byName(WORLD_ATLAS) → worldAtlasCell。
// 純関数＝Node 検定（tests/t-worldatlas.mjs）。依存なし。

// bucket/IDB のキー。中身を焼き直したら末尾の版を上げる（派生キャッシュは版を刻む＝IDB の旧版が永久に勝つ事故の予防）。
export const WORLD_ATLAS = "WORLD1024_1";
export const WORLD_ATLAS_CELL = 1024;   // 90° セルあたりの texel（4 × 2 セル＝4096 × 2048）

// タイル 1 枚を N×N へバイリニア再標本化して out（Int16・row0=北＝altpbf の格納規約）の (ox,oy) へ置く。
// 標本規約は ortho-core elevation.js downsampleFlipped と同一：texel 中心 (i+0.5)/N・最外周 M=2px（縁の fill 値）を読まない・
// 異常値（<-420 / >9000）は 0＝深海も 0 になる（downsampleFlipped と同じ規約＝海底地形は持たない）。-420..0 の負値（死海・海面下の陸）は
// 保持し、消費側（worldAtlasCell/sampleWorldAtlas）が 0 へ寄せる＝出力は従来と同一。海底が要る用途は R90 生タイルから別に焼くこと。
// Int16 格納＝丸めで ±0.5m（R90 の格子 3.7km に対し無視できる）。
export function resampleTile(tile, N, out, W, ox, oy) {
	const { data, width: w, height: h } = tile;
	const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };   // y:0=南
	const M = 2;
	for (let j = 0; j < N; j++) {   // j＝南から
		const gy = Math.min(Math.max((j + 0.5) / N * (h - 1), M), h - 1 - M), y0 = Math.min(gy | 0, h - 2), fy = gy - y0;
		const row = (oy + (N - 1 - j)) * W + ox;   // 出力は北上げ
		for (let i = 0; i < N; i++) {
			const gx = Math.min(Math.max((i + 0.5) / N * (w - 1), M), w - 1 - M), x0 = Math.min(gx | 0, w - 2), fx = gx - x0;
			const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
			const top = a + (b - a) * fx;
			out[row + i] = Math.round(top + ((c + (d - c) * fx) - top) * fy);
		}
	}
}

// R90 タイル群（{lng,lat,range:90,width,height,data,source}）→ altpbf の encode に渡せる 1 枚。lng∈{-180,-90,0,90}・lat∈{-90,0} の 8 枚が揃うこと。
export function bakeWorldAtlas(tiles, N = WORLD_ATLAS_CELL) {
	const W = 4 * N, H = 2 * N, data = new Int16Array(W * H), seen = new Set();
	for (const t of tiles) {
		if (!(t?.data && t.width && t.range === 90)) throw new Error(`bakeWorldAtlas: not an R90 tile: ${t?.name ?? t}`);
		const cx = (t.lng + 180) / 90, cy = (t.lat + 90) / 90;   // cy: 0=南半球
		if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cx > 3 || cy < 0 || cy > 1) throw new Error(`bakeWorldAtlas: bad origin ${t.lng},${t.lat}`);
		resampleTile(t, N, data, W, cx * N, (1 - cy) * N);   // 北上げ＝北半球の段（cy=1）が行 0
		seen.add(cx + "," + cy);
	}
	if (seen.size !== 8) throw new Error(`bakeWorldAtlas: ${seen.size}/8 cells`);
	const src = [...new Set(tiles.map(t => t.source).filter(Boolean))].join("+");
	return { name: WORLD_ATLAS, source: `WORLD ${N}/90deg from ${src || "R90"}`, lng: -180, lat: -90, range: 360, width: W, height: H, data };
}

// アトラスから R90 セル (cx 0..3 西から・cy 0..1 南から) を N² の Float32（row0=南・負値は 0）で取り出す＝
// 従来の downsampleFlipped(tile, N) と同じ物（丸め ±0.5m の差だけ）。N がセル寸法の約数なら k×k の箱平均（texel 中心整合）。
// out/W/ox/oy を渡せば大きな Float32 アトラスの一部へ直接書く（equal の 4096×2048 用）。
export function worldAtlasCell(atlas, cx, cy, N, out = new Float32Array(N * N), W = N, ox = 0, oy = 0) {
	const C = atlas.width >> 2, AW = atlas.width, d = atlas.data;
	if (C % N !== 0) throw new Error(`worldAtlasCell: ${N} does not divide cell ${C}`);
	const k = C / N, inv = 1 / (k * k);
	const rowN0 = (1 - cy) * C, col0 = cx * C;   // アトラス内のセル左上（北上げ）
	for (let j = 0; j < N; j++) {   // j＝南から
		const o = (oy + j) * W + ox;
		const srcRow = rowN0 + (C - 1 - j * k);   // セル内の最南行から
		if (k === 1) {
			const s = srcRow * AW + col0;
			for (let i = 0; i < N; i++) { const v = d[s + i]; out[o + i] = v < 0 ? 0 : v; }
		} else {
			for (let i = 0; i < N; i++) {
				let sum = 0;
				for (let jj = 0; jj < k; jj++) { const s = (srcRow - jj) * AW + col0 + i * k; for (let ii = 0; ii < k; ii++) sum += d[s + ii]; }
				const v = sum * inv; out[o + i] = v < 0 ? 0 : v;
			}
		}
	}
	return out;
}

// アトラスを経緯度でバイリニア標本（m・負値は 0）。texel 中心規約＝((i+0.5)/W)·360−180。terrain.js sampleElev の最後の床。
export function sampleWorldAtlas(atlas, lon, lat) {
	const { width: W, height: H, data: d } = atlas;
	let gx = ((lon + 180) / 360) * W - 0.5, gy = ((90 - lat) / 180) * H - 0.5;   // gy＝北から
	gx = Math.min(W - 1, Math.max(0, gx)); gy = Math.min(H - 1, Math.max(0, gy));
	const x0 = Math.min(W - 2, gx | 0), y0 = Math.min(H - 2, gy | 0), fx = gx - x0, fy = gy - y0;
	const a = d[y0 * W + x0], b = d[y0 * W + x0 + 1], c = d[(y0 + 1) * W + x0], e = d[(y0 + 1) * W + x0 + 1];
	const top = a + (b - a) * fx, v = top + ((c + (e - c) * fx) - top) * fy;
	return v < 0 ? 0 : v;
}
