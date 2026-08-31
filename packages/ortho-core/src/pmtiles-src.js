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

// Range 対応の自動判別：1バイトのレンジプローブが 206 ならレンジ直読（従来）、200＝全量返し
// （Cloudflare Workers Assets が Range を無視する実測 2026-09-01）ならその応答の全量を丸呑みして
// メモリ Source 化＝Range 非対応の静的ホストでも動く（public 同梱の world-z3.pmtiles=2.4MB は許容）。
// 将来 R2 等の 206 ホストへ移してもコードはこのまま＝プローブが勝手にレンジ直読へ寄る。
async function openArchive(src) {
	const m = await import("pmtiles");
	try {
		const res = await fetch(src, { headers: { Range: "bytes=0-0" } });
		if (res.ok && res.status !== 206) {   // Range 無視＝全量が来ている＝そのまま丸呑み
			const buf = await res.arrayBuffer();
			const source = {   // pmtiles.js の Source IF（getKey/getBytes）＝メモリ実装
				getKey: () => src,
				getBytes: async (offset, length) => ({ data: buf.slice(offset, offset + length) }),
			};
			return new m.PMTiles(source);
		}
		res.body?.cancel?.().catch?.(() => {});   // 206＝プローブの1バイトは捨ててレンジ直読へ
	} catch { /* プローブ失敗＝従来経路に任せる（オフライン等は getZxy 側で失敗が見える） */ }
	return new m.PMTiles(src);
}

export async function fetchPMTiles(url, z, x, y, signal, need) {
	const src = url.slice(PREFIX.length);
	let pm = archives.get(src);
	if (!pm) { pm = openArchive(src); archives.set(src, pm); }
	const t = await (await pm).getZxy(z, x, y, signal);
	// 索引に無い＝正当な「そこにタイルが無い」（HTTP 404 と同じ扱い＝空タイルとして ready）
	if (!t || !t.data || !t.data.byteLength) return { __empty: true };
	return decodeMVT(new Uint8Array(t.data), need);
}
