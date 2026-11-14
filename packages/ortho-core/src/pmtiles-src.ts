// PMTiles ソース：tileUrl が "pmtiles://<archive-url>" を返した時のタイル取得口。
// PMTiles＝MVTタイル群＋索引を1ファイルに固めたコンテナ（HTTP Range 直読み＝鯖無しの流儀そのまま）。
// z/x/y→byte range の解決・内部圧縮(gzip)の解除は pmtiles.js（MIT）に任せ、返る生MVTを既存 decodeMVT へ
// 流すだけ＝下流（build/merge/描画）は bvmap と完全同型。アーカイブごとに1インスタンス＝ヘッダ/
// ディレクトリのキャッシュを worker 内で使い回す（タイル毎の索引再取得はしない）。
// pmtiles 本体は動的 import＝pmtiles:// を実際に使う構成（?world=1 等）でだけチャンクが落ちる。
// タイルの形式はアーカイブのヘッダ（tileType＝1 mvt／6 mlt）が決める＝登録簿（tileformat.js）の pmtilesType から名前を引き、decodeTile へ渡す（#88）
// アーカイブの置き場は 3 通り（UNMAP オフライン版 M2・2026-11-14）：
//   pmtiles://https://…/x.pmtiles          … HTTP（Range 直読み・従来）
//   pmtiles://opfs:<道>                     … 端末の OPFS（navigator.storage.getDirectory() からの道・getFile().slice() で読む＝回線なし）
//   pmtiles://composite:<m1>,<m2>,…        … 複合＝複数のアーカイブを 1 つに束ねる（各 m は上の 2 つの pmtiles:// を除いた形を encodeURIComponent）。
//                                             タイルごとに先頭から「範囲とズーム域に入り、索引に在る」最初のアーカイブを使う＝並びが優先順。
//                                             読めない構成員（回線なしの HTTP・消えたファイル）は飛ばす＝端末の矩形＋オンラインの planet を束ねても、機内モードで矩形だけ描ける
import { decodeTile, loadTileFormat } from "./decode.ts";
import { tileFormatOfPmtilesType } from "./tileformat.ts";
import { tileOutsideCoverage } from "./tile.ts";
import { vectorLayersOf } from "./mlstyle.ts";
import type { PMTiles, Source } from "pmtiles";
import type { TileData } from "./tileformat.ts";
import type { VectorLayerInfo } from "./mlstyle.ts";

/** アーカイブの自己申告（pmtilesInfo の戻り） */
export interface PMTilesInfo { bbox: number[] | null; minZoom: number; maxZoom: number; layers: string[]; vectorLayers: VectorLayerInfo[] | null; attribution: string | null; name: string | null; tileType: string }
/** PMTiles の metadata（読む分だけ） */
interface PMMetadata { vector_layers?: unknown; attribution?: string | null; name?: string | null }

const PREFIX = "pmtiles://";
const archives = new Map<string, Promise<PMTiles>>();   // archive url → Promise<PMTiles>
const infos = new Map<string, Promise<PMTilesInfo>>();      // archive url → Promise<info>（ヘッダ/metadata の自己申告）

export const isPMTiles = (url: string): boolean => url.startsWith(PREFIX);
const srcOf = (url: string): string => url.startsWith(PREFIX) ? url.slice(PREFIX.length) : url;
const OPFS = "opfs:", COMPOSITE = "composite:";
/** OPFS の道（"rects/a.pmtiles"）→ pmtiles://opfs:… */
export const opfsPMTilesUrl = (path: string): string => PREFIX + OPFS + path.replace(/^\/+/, "");
/** 複数のアーカイブ（pmtiles:// 付きでも無しでも）→ 複合の pmtiles://composite:…（並び＝優先順） */
export const compositePMTilesUrl = (urls: string[]): string => PREFIX + COMPOSITE + urls.map(u => encodeURIComponent(srcOf(u))).join(",");
/** 複合の構成員（pmtiles:// を除いた形）。複合でなければ null */
export const compositeMembers = (url: string): string[] | null => { const s = srcOf(url); return s.startsWith(COMPOSITE) ? s.slice(COMPOSITE.length).split(",").filter(Boolean).map(decodeURIComponent) : null; };
// 失敗は覚えっぱなしにしない（2026-09-25）：一時的な失敗（オフライン・5xx）でその archive がセッション中ずっと死んでいた。
// pmtiles.js も失敗したヘッダの Promise を自分のキャッシュに抱える＝インスタンスごと捨てて作り直す。
// 失敗直後の要求はしばらく同じ失敗を返す（RETRY_MS）＝タイル毎に再取得の嵐を起こさない。
const RETRY_MS = 5000;
const forgetLater = <T>(map: Map<string, Promise<T>>, key: string, p: Promise<T>, also?: () => void): Promise<unknown> => p.catch(() => setTimeout(() => {
	if (map.get(key) !== p) return;
	map.delete(key); also?.();
}, RETRY_MS));
const archiveOf = (src: string): Promise<PMTiles> => { let pm = archives.get(src); if (!pm) { pm = openArchive(src); archives.set(src, pm); forgetLater(archives, src, pm); } return pm; };

// Range 対応の自動判別：1バイトのレンジプローブが 206 ならレンジ直読（従来）、200＝全量返し
// （Cloudflare Workers Assets が Range を無視する実測 2026-09-01）ならその応答の全量を丸呑みして
// メモリ Source 化＝Range 非対応の静的ホストでも動く（public 同梱の world-z3.pmtiles=2.4MB は許容）。
// 将来 R2 等の 206 ホストへ移してもコードはこのまま＝プローブが勝手にレンジ直読へ寄る。
// OPFS のファイルを読む Source（pmtiles.js の Source IF）。File は読み出しの写し＝書き換え後の読みは失敗する（NotReadableError）＝取り直して 1 回だけやり直す。
// worker でも main でも動く（navigator.storage.getDirectory は両方にある）。
async function opfsFile(path: string): Promise<File> {
	const parts = path.split("/").filter(Boolean);
	if (!parts.length) throw new Error("opfs: empty path");
	let dir = await navigator.storage.getDirectory();
	for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
	return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}
export function opfsSource(path: string, open: (path: string) => Promise<Blob> = opfsFile): Source {
	let file: Promise<Blob> | null = null;
	const read = async (offset: number, length: number, retry: boolean): Promise<ArrayBuffer> => {
		file ??= open(path);
		try { return await (await file).slice(offset, offset + length).arrayBuffer(); }
		catch (e) { file = null; if (retry) return read(offset, length, false); throw e; }
	};
	return { getKey: () => OPFS + path, getBytes: async (offset, length) => ({ data: await read(offset, length, true) }) };
}

async function openArchive(src: string): Promise<PMTiles> {
	const m = await import("pmtiles");
	if (src.startsWith(OPFS)) return new m.PMTiles(opfsSource(src.slice(OPFS.length)));
	try {
		const res = await fetch(src, { headers: { Range: "bytes=0-0" } });
		if (res.ok && res.status !== 206) {   // Range 無視＝全量が来ている＝そのまま丸呑み
			const buf = await res.arrayBuffer();
			const source: Source = {   // pmtiles.js の Source IF（getKey/getBytes）＝メモリ実装
				getKey: () => src,
				getBytes: async (offset, length) => ({ data: buf.slice(offset, offset + length) }),
			};
			return new m.PMTiles(source);
		}
		res.body?.cancel?.().catch?.(() => {});   // 206＝プローブの1バイトは捨ててレンジ直読へ
	} catch { /* プローブ失敗＝従来経路に任せる（オフライン等は getZxy 側で失敗が見える） */ }
	return new m.PMTiles(src);
}

// アーカイブの自己申告（ヘッダの bbox とズーム域・metadata の層名/出典）。**範囲制御の正本はここ**＝
// 呼び出し側に bbox を手で持たせない（GSI の JP_COVERAGE は配信元が黙って 404 を返す HTTP タイル用の
// 外付け知識だが、PMTiles は「どこを・どのズームで持っているか」を自分で宣言している＝データが先）。
// 一度読んだヘッダは archive ごとにキャッシュ＝タイル毎の再取得はしない。
export function pmtilesInfo(url: string): Promise<PMTilesInfo> {
	const src = srcOf(url);
	let info = infos.get(src);
	if (!info) {
		const members = compositeMembers(src);
		info = members ? compositeInfo(members) : (async (): Promise<PMTilesInfo> => {
			const pm = await archiveOf(src);
			const h = await pm.getHeader();
			const md = await pm.getMetadata().catch(() => null) as PMMetadata | null;   // metadata 欠落は致命ではない（層名が要らない用途もある）
			// 全球（±180）は bbox 判定を掛けない＝縁のタイルを丸め誤差で落とさないため
			const full = h.minLon <= -180 && h.maxLon >= 180;
			return {
				bbox: full ? null : [h.minLon, h.minLat, h.maxLon, h.maxLat],
				minZoom: h.minZoom, maxZoom: h.maxZoom,
				layers: Array.isArray(md?.vector_layers) ? md.vector_layers.map(l => l.id).filter(Boolean) : [],
				vectorLayers: vectorLayersOf(md),   // 層の一覧（id・fields・minzoom・maxzoom＝TileJSON と同じ形・検査表示 #174）
				attribution: md?.attribution || null,
				name: md?.name || null,
				// タイルの種別＝ヘッダの自己申告（pmtiles.js TileType）。ベクタ（mvt／mlt）は登録簿の名前・ラスタ（png/jpeg/webp/avif）＝画像タイル層の領分。
				// ベクタ配管（fetchPMTiles）はラスタのアーカイブを解読器に流さず空タイルで返す（下の門）。
				tileType: tileTypeName(h.tileType),
			};
		})();
		infos.set(src, info);
		forgetLater(infos, src, info, () => archives.delete(src));   // ヘッダの失敗は archive ごと作り直す
	}
	return info;
}

// 複合の申告＝読めた構成員の和（bbox の和・ズーム域の和・層名の和・出典を並べる）。形式は先頭の構成員。どれも読めなければ失敗（＝少し後にやり直す）
async function compositeInfo(members: string[]): Promise<PMTilesInfo> {
	const got = (await Promise.allSettled(members.map(m => pmtilesInfo(PREFIX + m)))).flatMap(r => r.status === "fulfilled" ? [r.value] : []);
	if (!got.length) throw new Error("pmtiles composite: no member could be read");
	const bbox = got.some(i => !i.bbox) ? null : [Math.min(...got.map(i => i.bbox![0])), Math.min(...got.map(i => i.bbox![1])), Math.max(...got.map(i => i.bbox![2])), Math.max(...got.map(i => i.bbox![3]))];
	const vl = new Map<string, VectorLayerInfo>(); for (const i of got) for (const l of i.vectorLayers || []) if (!vl.has(l.id)) vl.set(l.id, l);
	return {
		bbox, minZoom: Math.min(...got.map(i => i.minZoom)), maxZoom: Math.max(...got.map(i => i.maxZoom)),
		layers: [...new Set(got.flatMap(i => i.layers))], vectorLayers: vl.size ? [...vl.values()] : null,
		attribution: [...new Set(got.map(i => i.attribution).filter(Boolean))].join(" · ") || null,
		name: got[0].name, tileType: got[0].tileType,
	};
}
// 1 枚の生タイル（範囲の門つき）＋そのアーカイブの申告。複合＝先頭から順に、門を通り索引に在る最初の構成員（読めない構成員は飛ばす）
async function rawTile(src: string, z: number, x: number, y: number, signal?: AbortSignal | null): Promise<{ data: Uint8Array; info: PMTilesInfo } | null> {
	const members = compositeMembers(src);
	if (members) {
		for (const m of members) {
			const r = await rawTile(m, z, x, y, signal).catch(e => { if ((e as Error)?.name === "AbortError") throw e; return null; });
			if (r) return r;
		}
		return null;
	}
	// 範囲の門＝アーカイブ自身のヘッダ。索引を歩く前に落とす（ズーム域外・bbox 外は「そこに無い」が正しい答え）。
	// 索引ミスでも致命ではないが、日本域アーカイブを全球ビューで開くと毎フレーム無駄な走査が出るため門で止める。
	const info = await pmtilesInfo(src);
	if (z < info.minZoom || z > info.maxZoom) return null;
	if (tileOutsideCoverage(x, y, z, info.bbox)) return null;
	const t = await (await archiveOf(src)).getZxy(z, x, y, signal as AbortSignal | undefined);
	// 索引に無い＝正当な「そこにタイルが無い」（HTTP 404 と同じ扱い）
	if (!t || !t.data || !t.data.byteLength) return null;
	return { data: new Uint8Array(t.data), info };
}

export async function fetchPMTiles(url: string, z: number, x: number, y: number, signal?: AbortSignal | null, need?: Set<string> | null): Promise<TileData> {
	const src = srcOf(url);
	const info = await pmtilesInfo(url);
	if (isRasterTileType(info.tileType)) return { __empty: true };   // ラスタのアーカイブ＝ベクタ配管の領分でない（画像タイル層 raster.js が読む）＝解読器に画像を流さない
	const t = await rawTile(src, z, x, y, signal);
	if (!t || isRasterTileType(t.info.tileType)) return { __empty: true };   // 無い＝空タイルとして ready
	// 形式＝そのタイルを出したアーカイブのヘッダの申告。tileType 0（unknown）は従来どおり MVT として読む（種別を書かない古いアーカイブ）。未登録の形式（mlt のプラグイン無し）＝decodeTile が一度だけ警告して空
	const enc = t.info.tileType === "unknown" ? "mvt" : t.info.tileType;
	await loadTileFormat(enc);
	return decodeTile(t.data, need, enc);
}

// ラスタ PMTiles の生タイル（画像のバイト列＝png/jpeg/webp/avif そのまま・pmtiles.js がタイル圧縮を解く）。
// 範囲の門は fetchPMTiles と同じ（アーカイブの自己申告）。null＝正当な「そこに無い」（索引外・域外）＝呼び手は空扱い。
// 画像タイル層（raster.js）のプロバイダ "pmtiles" が使う＝XYZ の HTTP 404 と同じ意味論に揃える。
export async function fetchPMTilesRaw(url: string, z: number, x: number, y: number, signal?: AbortSignal | null): Promise<Uint8Array | null> {
	return (await rawTile(srcOf(url), z, x, y, signal))?.data ?? null;
}

// pmtiles.js TileType（ヘッダ 1 バイト）→ 名前。0=unknown 1=mvt 2=png 3=jpeg 4=webp 5=avif 6=mlt。
// ベクタの名前は登録簿（pmtilesType）から引く＝プラグインが増えれば表を触らずに増える。既知だが未登録（mlt のプラグイン無し）でも名前は返す
// ＝decodeTile の「未登録」の警告が形式名で言える。
const RASTER_TYPE: Record<number, string> = { 2: "png", 3: "jpeg", 4: "webp", 5: "avif" }, KNOWN_VECTOR_TYPE: Record<number, string> = { 1: "mvt", 6: "mlt" };
const tileTypeName = (code: number): string => tileFormatOfPmtilesType(code) ?? RASTER_TYPE[code] ?? KNOWN_VECTOR_TYPE[code] ?? "unknown";
export const RASTER_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif" };
export const isRasterTileType = (t: unknown): boolean => t === "png" || t === "jpeg" || t === "webp" || t === "avif";
