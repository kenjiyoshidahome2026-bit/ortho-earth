// PMTiles ソース：tileUrl が "pmtiles://<archive-url>" を返した時のタイル取得口。
// PMTiles＝MVTタイル群＋索引を1ファイルに固めたコンテナ（HTTP Range 直読み＝鯖無しの流儀そのまま）。
// z/x/y→byte range の解決・内部圧縮(gzip)の解除は pmtiles.js（MIT）に任せ、返る生MVTを既存 decodeMVT へ
// 流すだけ＝下流（build/merge/描画）は bvmap と完全同型。アーカイブごとに1インスタンス＝ヘッダ/
// ディレクトリのキャッシュを worker 内で使い回す（タイル毎の索引再取得はしない）。
// pmtiles 本体は動的 import＝pmtiles:// を実際に使う構成（?world=1 等）でだけチャンクが落ちる。
import { decodeMVT } from "./decode.js";

const PREFIX = "pmtiles://";
const archives = new Map();   // archive url → Promise<PMTiles>

export const isPMTiles = url => url.startsWith(PREFIX);

export async function fetchPMTiles(url, z, x, y, signal, need) {
	const src = url.slice(PREFIX.length);
	let pm = archives.get(src);
	if (!pm) { pm = import("pmtiles").then(m => new m.PMTiles(src)); archives.set(src, pm); }
	const t = await (await pm).getZxy(z, x, y, signal);
	// 索引に無い＝正当な「そこにタイルが無い」（HTTP 404 と同じ扱い＝空タイルとして ready）
	if (!t || !t.data || !t.data.byteLength) return { __empty: true };
	return decodeMVT(new Uint8Array(t.data), need);
}
