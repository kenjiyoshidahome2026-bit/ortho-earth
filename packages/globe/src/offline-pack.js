// オフラインパック（#40・2026-09-25）＝範囲（bbox）とズーム上限を決めて、基図タイル・標高・（任意で）建物を先に取って残す。
// ここは純関数と実行器だけ（DOM なし・node の検定が回る）。UI は gadgets/offline.js、保存の仕組みは：
//   ・基図タイル・ラスタ・bucket の JSON … Cache Storage（PACK_CACHE）に URL ごと。配信は Service Worker（japan の public/sw.js）が
//     「パックにある URL」だけ cache-first で返す＝エンジン（fetchMVT）は触らない。SW の無い埋め込み先では単なる先読み（HTTP キャッシュ）
//   ・標高（R10/R01）… core の loadTile.byName＝IDB GIS/alt へ（描画なしの先読み口・www の prefetch と同じ）
//   ・建物（PLATEAU 等）… 既存の meshMgr.prefetch（IDB＋OPFS・予算と LRU はそちら）
// 台帳（パックの一覧）＝IDB GIS/pack（native-bucket の Cache）。再開＝もう一度走らせる（Cache にある URL は飛ばす）。
import { lonLatToTile } from "@ortho-earth/core";
export const PACK_CACHE = "oj-pack";   // Cache Storage の名前（sw.js の PACK と同じ・変えたら両方）
const LAT_MAX = 85.0511;   // Web メルカトルの縁（これより外は y が範囲外になる）

// bbox（[w,s,e,n]）を列挙できる形に：緯度を ±85.05 に切り、±180 を跨ぐ（w>e）なら 2 つに分け、coverage（基図の申告）で切る
export function splitBbox(bbox, coverage = null) {
	const [w0, s0, e0, n0] = bbox, s = Math.max(-LAT_MAX, s0), n = Math.min(LAT_MAX, n0);
	const parts = w0 > e0 ? [[w0, s, 180, n], [-180, s, e0, n]] : [[w0, s, e0, n]];
	return parts.map(([w, s, e, n]) => coverage ? [Math.max(w, coverage[0]), Math.max(s, coverage[1]), Math.min(e, coverage[2]), Math.min(n, coverage[3])] : [w, s, e, n]).filter(([w, s, e, n]) => w < e && s < n);
}
// bbox と z の範囲からタイル列
export function tilesFor(bbox, zmin, zmax, coverage = null) {
	const out = [];
	for (const [w, s, e, n] of splitBbox(bbox, coverage)) for (let z = zmin; z <= zmax; z++) {
		const [x0, y0] = lonLatToTile(w, n, z), [x1, y1] = lonLatToTile(e, s, z);   // 北西→(minx,miny) 南東→(maxx,maxy)
		for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push([z, x, y]);
	}
	return out;
}
// 枚数だけ（見積りの入口＝列を作らない）
export function tileCount(bbox, zmin, zmax, coverage = null) {
	let c = 0;
	for (const [w, s, e, n] of splitBbox(bbox, coverage)) for (let z = zmin; z <= zmax; z++) {
		const [x0, y0] = lonLatToTile(w, n, z), [x1, y1] = lonLatToTile(e, s, z);
		c += (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
	}
	return c;
}
// tileUrl(z,x,y) の関数から URL の型紙（{z}/{x}/{y}）を取り出す＝台帳に残す（後で基図が変わっても、そのパックの URL を作り直せる）
export function tplOf(tileUrl) {
	const u = String(tileUrl(27, 1234567, 7654321) ?? "");
	return u.split("7654321").join("{y}").split("1234567").join("{x}").replace(/(?<![0-9])27(?![0-9])/, "{z}");
}
// 標高のセル名（altpbf の encodeName と同じ綴り＝R{2 桁の幅}{N|S}{lat3}{E|W}{lng3}・南西隅を幅で切り下げ）
export function demCells(bbox, range) {
	const [w, s, e, n] = bbox, f = v => Math.floor(v / range) * range, out = [];
	for (let lat = f(s); lat < n; lat += range) for (let lng = f(w); lng < e; lng += range) {
		const la = Math.abs(lat), lo = Math.abs(lng);
		out.push(`R${String(range).padStart(2, "0")}${lat < 0 ? "S" : "N"}${String(la).padStart(3, "0")}${lng < 0 ? "W" : "E"}${String(lo).padStart(3, "0")}`);
	}
	return out;
}
// 標高＝R10 は常に・R01（1° 級＝DEM10B/AW3D30）は寄る時だけ（z≥9 で R10 から R01 へ切り替わる）
export function demNames(bbox, zmax) { return [...demCells(bbox, 10), ...(zmax >= 9 ? demCells(bbox, 1) : [])]; }
// 見積り＝標本の平均 × 枚数（標本が無ければ既定の 1 枚あたり）
export function estimateBytes(count, samples, perTile = 24 * 1024) {
	const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : perTile;
	return Math.round(avg * count);
}
export const bboxIntersects = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
export const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB";

// 実行器：URL の列を並列 n で取って store へ。has(url) が真の物は飛ばす（再開）。進捗＝onProgress({ done, total, bytes, skipped, failed })。
// 戻り＝{ bytes, failed, aborted }。signal で中断（取りかけの物は捨てる）
export async function runFetches(urls, { fetchOne, has = async () => false, concurrency = 6, onProgress = () => {}, signal = null } = {}) {
	const total = urls.length;
	let i = 0, done = 0, bytes = 0, skipped = 0, failed = 0, aborted = false;
	const tick = () => onProgress({ done, total, bytes, skipped, failed });
	const worker = async () => {
		while (i < total) {
			if (signal?.aborted) { aborted = true; return; }
			const url = urls[i++];
			try {
				if (await has(url)) { skipped++; }
				else { const b = await fetchOne(url, signal); if (b >= 0) bytes += b; else failed++; }
			} catch (e) { if (signal?.aborted) { aborted = true; return; } failed++; }
			done++; tick();
		}
	};
	tick();
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
	return { bytes, failed, aborted };
}
