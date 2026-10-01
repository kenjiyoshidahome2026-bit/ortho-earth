// タイル worker：fetch→decode→tessellation（earcut/capsule/建物）を worker 内で実行し、
// 結果の typed array を transfer でメインへ返す。メインは GL アップロード＋カメラだけになる。
// abort: 高速パンで視野から外れたタイルは fetch ごと中断（帯域とデコードCPUを空ける）。
// index.js（全部入り）でなく実装ファイル直参照：index は pipeline（worker生成）を含むため、
// worker から index を引くと vite が「循環worker」と誤認してビルドが落ちる
import { setGlobalState } from "../expr.js";   // style.globalState（main の setGlobalStateProperty）＝基図の filter/layout の global-state
import { fetchMVT, neededSourceLayers } from "../decode.js";
// PMTiles の読み口は pmtiles:// の源が来た時だけ読む（動的 import＝GSI 等の XYZ だけの起動では worker に乗せない・2026-09-22）
const pmSrc = () => import("../pmtiles-src.js");
import { buildTilePayload, opBuffers } from "../tilepayload.js";   // 組み立て（drawlist・水域・ラベル・建物）は main の既定経路と共通
import { tileOutsideCoverage } from "../tile.js";
import { setEllipsoid } from "../camera.js";

let style = null, need = null, coverage = null, encoding = "mvt";   // need＝styleが参照する source-layer 集合（未参照層は decode 省略）。coverage＝配信圏 bbox。encoding＝タイルの形式（mvt｜mlt・#88）
const aborts = new Map();   // id → AbortController（in-flight のみ保持）

self.onmessage = async (e) => {
	const m = e.data;
	if (m.type === "init" || m.type === "setStyle") setGlobalState(m.style?.globalState);
	if (m.type === "init") { style = m.style; need = neededSourceLayers(style); coverage = m.coverage || null; encoding = m.encoding || "mvt"; setEllipsoid(!!m.ell); return; }   // ell＝buildings の世界単位（m→単位）を a 基準へ
	if (m.type === "setStyle") { style = m.style; need = neededSourceLayers(style); if (m.encoding) encoding = m.encoding; return; }   // 配色テーマ生き替え＝色を焼き直す新style。以降のビルドは新styleで（coverage は据置）。setStyle で基図の置き場が替わる時は形式も一緒に来る
	if (m.type === "abort") { const a = aborts.get(m.id); if (a) a.abort(); return; }
	const { id, url, z, x, y, init } = m, body = m.bytes;   // init＝{headers,credentials}・body＝addProtocol が main で取った本体（#37）⚠名前 bytes は下の try で転送量の let に使う（TDZ）
	const ac = new AbortController();
	aborts.set(id, ac);
	try {
		// 配信圏外（日本域外の外洋・国外）は fetch を省いて空タイル扱い＝提供側の 404 への無駄打ちを断つ。
		// 描画は 404 と同一（fetchMVT が 404 で返すのと同じ {__empty:true}）＝下の buildEmptySeaOps が全面水域を敷く。
		const layers = body ? await fetchMVT(url, ac.signal, need, null, body, encoding)
			: url.startsWith("pmtiles://") ? await (await pmSrc()).fetchPMTiles(url, z, x, y, ac.signal, need)   // 全球ソース（PMTiles）＝配信圏(coverage)の外でも正当。形式はアーカイブのヘッダ（tileType）が決める
			: tileOutsideCoverage(x, y, z, coverage) ? { __empty: true } : await fetchMVT(url, ac.signal, need, init, null, encoding);
		const { origin, dl, labels, buildings, bytes } = buildTilePayload(layers, { z, x, y }, style);   // bytes＝scene worker が保持する geometry の実バイト
		self.postMessage({ id, ok: true, origin, dl, labels, buildings, z, bytes }, opBuffers(dl.ops, buildings));   // transfer＝境界跨ぎのコピーを避ける
	} catch (err) {
		self.postMessage({ id, ok: false, error: String(err && err.message || err) });
	} finally {
		aborts.delete(id);
	}
};
