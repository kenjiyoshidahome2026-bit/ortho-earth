// ジオイド高（楕円体高 → 標高の直し・#110 段 5・2026-09-29）。この地図の標高はジオイド基準（DEM＝標高）＝楕円体高のソース（Cesium World Terrain・PDOK の
// quantized-mesh）は N（ジオイド高）を引いてから載せる＝データ範囲の縁の段差（日本で約 40m）を消す。格子＝EGM96 の 30 分（geoid/egm96-30m.bin・298KB）。
// 格子の形式＝361 行×720 列・cm の int16・行ごとの差分・gzip のバイト列そのまま（元＝NGA の EGM96・パブリックドメイン。PROJ-data の
// us_nga_egm96_15.tif から 2 点おきに間引いた＝格子点の値そのまま・平均の誤差 0.1 m・最大 3.9 m）。
// 2026-09-30 に 16 進の JS（597KB・主スレッドと worker の束に 1 本ずつ）から .bin の資産 1 本へ＝配布物は 1 束あたり約 0.9MB 減・取得は 1 回。
// 読み方は new URL(…, import.meta.url)＝バンドラ（vite・webpack 5）が資産として出す標準の書き方。Node（検定・fixture 作り）は file: をファイルとして読む。
// 轍：vite は geoid を使わない束（equal・japan のサイト殻）にも .bin を出す（資産は変換時に出る＝木刈りの後で消えない）。取りには行かれない＝配信の容量だけ。
// 格子は要る時だけ読む（loadGeoid＝一度だけ）。読んだ後は geoidHeight が同期で引ける。同じ格子は 3D Tiles の高さにも使える見込み。
let grid = null, loading = null;
const R = 361, C = 720, STEP = 0.5;

export function loadGeoid() {
	if (grid) return Promise.resolve(grid);
	return loading ??= (async () => {
		const url = new URL("./geoid/egm96-30m.bin", import.meta.url);
		const bin = url.protocol === "file:" ? await globalThis.process.getBuiltinModule("node:fs/promises").readFile(url)   // Node（22.3+）＝import 文を書かない＝束に node の口が入らない
			: await fetch(url).then(r => { if (!r.ok) throw new Error(`geoid: ${r.status} ${url}`); return r.arrayBuffer(); });
		const ab = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
		const d = new Int16Array(ab), q = new Float32Array(R * C);
		for (let r = 0; r < R; r++) { let v = 0; for (let c = 0; c < C; c++) { v += d[r * C + c]; q[r * C + c] = v / 100; } }   // 行ごとの差分を戻す（cm → m）
		return (grid = q);
	})();
}
export const geoidReady = () => !!grid;
// N（m）＝楕円体高 − 標高。双一次（経度は周回）。格子を読む前は NaN
export function geoidHeight(lon, lat) {
	if (!grid) return NaN;
	const gr = Math.min(R - 1, Math.max(0, (90 - lat) / STEP)), gc = (((lon + 180) % 360) + 360) % 360 / STEP;
	const r0 = Math.min(R - 2, Math.floor(gr)), c0 = Math.floor(gc) % C, c1 = (c0 + 1) % C, fr = gr - r0, fc = gc - Math.floor(gc);
	const a = grid[r0 * C + c0], b = grid[r0 * C + c1], c = grid[(r0 + 1) * C + c0], d = grid[(r0 + 1) * C + c1];
	return (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr;
}
