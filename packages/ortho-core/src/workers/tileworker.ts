// タイル worker：fetch→decode→tessellation（earcut/capsule/建物）を worker 内で実行し、
// 結果の typed array を transfer でメインへ返す。メインは GL アップロード＋カメラだけになる。
// abort: 高速パンで視野から外れたタイルは fetch ごと中断（帯域とデコードCPUを空ける）。
// index.ts（全部入り）でなく実装ファイル直参照：index は pipeline（worker生成）を含むため、
// worker から index を引くと vite が「循環worker」と誤認してビルドが落ちる
import { setGlobalState } from "../expr.ts";   // style.globalState（main の setGlobalStateProperty）＝基図の filter/layout の global-state
import { fetchMVT, neededSourceLayers } from "../decode.ts";
// PMTiles の読み口は pmtiles:// の源が来た時だけ読む（動的 import＝GSI 等の XYZ だけの起動では worker に乗せない・2026-09-22）
const pmSrc = () => import("../pmtiles-src.ts");
import { buildTilePayload, opBuffers } from "../tilepayload.ts";   // 組み立て（drawlist・水域・ラベル・建物）は main の既定経路と共通
import { tileOutsideCoverage } from "../tile.ts";
import { setEllipsoid } from "../camera.ts";
import type { Style } from "../build.ts";
import type { TileData } from "../decode.ts";
import type { TileRequest, TileResponse } from "../worker-msg.ts";

let style: Style | null = null, need: Set<string> | null = null, coverage: number[] | null = null, encoding = "mvt", drape = true;   // need＝styleが参照する source-layer 集合（未参照層は decode 省略）。coverage＝配信圏 bbox。encoding＝タイルの形式（mvt｜mlt・#88）。drape＝線の細分（地形の有無・§3.2）
const aborts = new Map<number, AbortController>();   // id → AbortController（in-flight のみ保持）

self.onmessage = async (e: MessageEvent<TileRequest>) => {
	const m = e.data;
	if (m.type === "init" || m.type === "setStyle") setGlobalState(m.style?.globalState as Record<string, unknown> | null | undefined);
	if (m.type === "init") { style = m.style; need = neededSourceLayers(style); coverage = m.coverage || null; encoding = m.encoding || "mvt"; drape = m.drape !== false; setEllipsoid(!!m.ell); return; }   // ell＝buildings の世界単位（m→単位）を a 基準へ
	if (m.type === "setStyle") { style = m.style; need = neededSourceLayers(style); if (m.encoding) encoding = m.encoding; if (m.drape != null) drape = m.drape; return; }   // 配色テーマ生き替え＝色を焼き直す新style。以降のビルドは新styleで（coverage は据置）。setStyle で基図の置き場が替わる時は形式も一緒に来る。drape＝地形の有無が替わる時（setTerrain）
	if (m.type === "abort") { const a = aborts.get(m.id); if (a) a.abort(); return; }
	const { id, url, z, x, y, init } = m, body = m.bytes;   // init＝{headers,credentials}・body＝addProtocol が main で取った本体（#37）⚠名前 bytes は下の try で転送量の let に使う（TDZ）
	const ac = new AbortController();
	aborts.set(id, ac);
	try {
		// 配信圏外（日本域外の外洋・国外）は fetch を省いて空タイル扱い＝提供側の 404 への無駄打ちを断つ。
		// 描画は 404 と同一（fetchMVT が 404 で返すのと同じ {__empty:true}）＝下の buildEmptySeaOps が全面水域を敷く。
		const t0 = performance.now();   // 計器 e（vt perf plan §2）＝取得＋復号と組み立ての時間を荷に添える（main が要求→応答の往復から待ちを引く）
		const layers: TileData = body ? await fetchMVT(url, ac.signal, need, null, body, encoding)
			: url.startsWith("pmtiles://") ? await (await pmSrc()).fetchPMTiles(url, z, x, y, ac.signal, need)   // 全球ソース（PMTiles）＝配信圏(coverage)の外でも正当。形式はアーカイブのヘッダ（tileType）が決める
			: tileOutsideCoverage(x, y, z, coverage) ? { __empty: true } : await fetchMVT(url, ac.signal, need, init, null, encoding);
		const t1 = performance.now();
		const { origin, dl, labels, buildings, bytes } = buildTilePayload(layers, { z, x, y }, style!, { drape });   // bytes＝scene worker が保持する geometry の実バイト
		const t = { fetch: t1 - t0, build: performance.now() - t1 };
		self.postMessage({ id, ok: true, origin, dl, labels, buildings, z, bytes, t } satisfies TileResponse, opBuffers(dl.ops, buildings) as ArrayBuffer[]);   // transfer＝境界跨ぎのコピーを避ける
	} catch (err) {
		self.postMessage({ id, ok: false, error: String(err && (err as Error).message || err) } satisfies TileResponse);
	} finally {
		aborts.delete(id);
	}
};
