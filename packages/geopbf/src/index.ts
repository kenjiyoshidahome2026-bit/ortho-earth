// "geopbf"（full の入口）＝createGeopbf()・geopbf(input, options)・GeoPBF（拡張つき）。TS 化 段 4（2026-10-16）：旧 types/index.d.ts を畳んだ＝型はここと pbf.ts／pbf-base.ts が正本。
// 値の型（Feature・GeoPBFOptions …）は types/geopbf.d.ts（手書きの正典）をそのまま出す。
import { GeoPBF, wireEntry } from "./pbf.ts";
import type { GeoPBFEntryMethods } from "./pbf.ts";
import { GeoPBFBase } from "./pbf-base.ts";
import { createPbfio } from "./pbf-io.ts";
import type { PBFIO } from "./pbf-io.ts";
import { useEntryClass } from "./modules/tile-load.ts";
import { spawnWorker, setWorkerFactory } from "./modules/workerFactory.ts";
import type { LaneFactory } from "./modules/workerPool.ts";
import { builtinWorker } from "./modules/builtinWorkers.ts";   // geopbf 自身の worker（new Worker の直書きはここ 1 か所＝ホストはビルドの alias で「作らない版」に差し替えられる）
import type {
	CleanTopologyOptions, CreateGeopbfOptions, ExportOptions, Feature, FeatureCollection, Geometry, GeometryCollection, GeoPBFOptions, GintOptions,
} from "../types/geopbf.js";
import type { Topology } from "./modules/topo2geo.ts";
export { GeoPBF };   // 拡張メソッド付きの GeoPBF（1.20〜・改良点 10）。旧＝どの subpath からも拡張付きの class が取れなかった（pbf-base は器だけ・geopbf/pbf は protobuf の wire 読み書き）
export { setWorkerFactory };   // worker の入口を外から差し替える（役割名 → Worker・null＝既定）
export type * from "../types/geopbf.js";   // 値の型（Feature・GeoPBFOptions・UnPackGint …）
export type { GeoPBFBase, FMapEntry } from "./pbf-base.ts";   // 器の class（"geopbf" では型だけの名前＝値は "geopbf/core"・"geopbf/pbf-base" の GeoPBF）
export type { FeatureCallback, CloneMapOptions } from "./pbf.ts";
// 変換 worker は入口 1 本（./worker.js）＝形式は Worker の name で指名する（処方②・ortho-earth#12・2026-09-14）。
// 形式ごとに worker ファイルを分けると、バンドラ（vite）が worker ごとに独立ビルドして核（pbf-base 等）を 25〜29 回複製した。
// 2026-09-22：new Worker の直書きは modules/builtinWorkers.ts 1 か所へ（COG・タイル書き出しも同じ入口の役割に）。
// ホストは setWorkerFactory / createGeopbf の workerFactory で自分の入口へ寄せられる（spawnWorker が先に聞く）。
// 形式の名簿（読む／書く）。worker を作るのは spawnWorker（ホストの入口が勝つ）→ 無ければ modules/builtinWorkers.ts（geopbf 自身の入口）。
const DECODERS = new Set(["fgb", "gint", "gml", "gpkg", "gdb", "parquet", "csv", "czml", "dxf", "gpx", "json", "ndjson", "kmz", "moj", "pbf", "shape", "spatialite"]);
const ENCODERS = new Set(["czml", "fgb", "geojson", "geopbf", "gint", "gml", "gpx", "kmz", "preview", "profile", "shape", "topojson"]);

import { topology } from "./extension/topology.ts";
import { cleanGintBuffer } from "./extension/clean.ts";
import { gint } from "./extension/gint.ts";
import { topo2geo } from "./modules/topo2geo.ts";
import { gunzip, isGzip } from "./modules/gzip.ts";
import { decodeZIP } from "./modules/decodeZIP.ts";
import { isString, isURL, isFile, isObject, isBuffer } from "./modules/utility.ts"
import { prewarmWorkers } from "./modules/workerPool.ts";

// ── 入口の入力（geopbf(input, options)）。各行の番号は下の _geopbf の枝
/** http(s) の URL。相対（"/x"・"./x"・"../x"）は location を基準に絶対 URL へ（ブラウザ） */
export type UrlInput = `http://${string}` | `https://${string}` | `/${string}` | `./${string}` | `../${string}`;
/** リモートの zip の中の 1 本："https://…/a.zip#inner.geojson"（"#x.shp" は shapefile 1 本）。url ＋ options.target でも同じ */
export type ZipMemberInput = `${UrlInput}.zip#${string}`;
/** それ以外の文字列＝bucket の名前（createGeopbf(apiBase, { bucket }) が要る・無ければ読めずに throw） */
export type BucketNameInput = string;
/** FeatureCollection に包む GeoJSON（Feature・Geometry・GeometryCollection） */
export type GeoJSONInput = FeatureCollection | Feature | Geometry | GeometryCollection;
/** TopoJSON の Topology（topo2geo で GeoJSON に） */
export type TopoJSONInput = Topology & { type: "Topology" };
/** geopbf() が受ける物。File は拡張子で振り分け（.gz は先に伸ばす）・bytes は GeoPBF のバイト列・GeoPBF（器も）はそのまま焼いて返す・null／undefined は空の GeoPBF */
export type GeopbfInput =
	| UrlInput | ZipMemberInput | BucketNameInput
	| File
	| Blob
	| ArrayBuffer | ArrayBufferView
	| GeoPBFBase
	| Feature[] | GeoJSONInput | TopoJSONInput
	| null | undefined;

/** `geopbf(input, options)` の options（createGeopbf の返す入口・README「Usage」）。形式ごとの口は README を参照 */
export interface GeopbfOptions extends GeoPBFOptions {
	/** Gint を焼く（既定 true） */
	gint?: boolean;
	/** 焼いた後に交差修復 */
	clean?: boolean | CleanTopologyOptions;
	/** IDB の控えを使わない */
	nocache?: boolean;
	/** 呼び手の鍵で控えを置く（geopbfCached で引く） */
	cacheKey?: string;
	cacheMeta?: Record<string, unknown>;
	/** 文字コード（"utf8"・"sjis" …） */
	encoding?: string;
	/** イベント（ConvertStart／ConvertProgress／ConvertEnd）を dispatch する先（既定 window） */
	eventTarget?: EventTarget | null;
	/** zip の中身の明示（"moj"＝登記所備付地図・"gdb"＝FileGDB・それ以外は shapefile） */
	format?: "moj" | "gdb";
	/** .zip の URL の中の 1 本 */
	target?: string;
	/** 多層ファイル（GeoPackage・FileGDB・XLSX）の層・シート */
	layer?: string; sheet?: string;
	/** CRS（EPSG コード・WKT）と、ファイルの CRS を無視する印 */
	crs?: string | number; wkt?: string; ignoreCrs?: boolean;
	/** JGD の変換（TKY2JGD・PatchJGD のパラメータ・createGeopbf の options と同名で、こちらが優先） */
	tky2jgd?: unknown; patchjgd?: unknown;
	/** CSV／TSV の列名と区切り */
	lon?: string; lat?: string; geometryColumn?: string; delimiter?: string; fallbackEncoding?: string;
	/** GPX／KML の閉じた線を面に */
	closedAsPolygon?: boolean;
	unitScale?: number;
}
/** createGeopbf() が返す入口。null は返さない（読めない文字列・File は throw・それ以外で読めなければ空の GeoPBF） */
export type GeopbfFn = (input: GeopbfInput, options?: GeopbfOptions | string) => Promise<GeoPBF>;

// Worker を作る（ホストの入口 → geopbf 自身の入口）。Worker 自体が無い環境（Node の main スレッド）は null＝呼び手が main スレッドの道へ落とす
const spawnWorkerOrNull = (role: string): Worker | null => { try { return spawnWorker(role, () => builtinWorker(role)); } catch (e) { if (typeof Worker === "undefined") return null; throw e; } };

// prototype メソッドとレガシー geopbf が使うアクティブインスタンス
let _activeGetServer: (() => Promise<PBFIO | null>) | null = null;
let _activeGeopbf: GeopbfFn | null = null;

// レガシー互換エクスポート（createGeopbf 呼び出し後に使用可能）
// ── 呼び手の鍵で置く控え（#176）の台帳＝掃除の物差し。IDB の同じ棚に 1 件（"KEYS::cacheKey"）＝{ entries: { 鍵: { t: 置いた時刻, u: 最後に使った時刻, bytes } } }。
// 台帳を書くのはここだけ（読み書きを 1 本の鎖に並べる＝同時の書き込みで消し合わない）。既存の控え（bucket 名・URL・File）は台帳に載らず、掃除も触らない
const KEYS_REC = "KEYS::cacheKey";
/** 台帳の 1 行（t＝置いた時刻・u＝最後に使った時刻） */
interface KeyEntry { t: number; u?: number; bytes?: number }
// IDB へ置く GintBUF: SAB は IDB に入らない＝ArrayBuffer へ写す。ArrayBuffer ならそのまま（put が structured clone で写す＝旧の .slice() は二重の写し・2026-10-11）
const idbGint = (b: ArrayBuffer | SharedArrayBuffer | null | undefined): ArrayBuffer | null => !b ? null : b instanceof ArrayBuffer ? b : new Uint8Array(b).slice().buffer;
let keysChain: Promise<unknown> = Promise.resolve();
const withKeys = <T>(server: PBFIO, fn: (rec: Record<string, KeyEntry>) => T | Promise<T>): Promise<T | null> => (keysChain = keysChain.then(async () => {
    const rec: Record<string, KeyEntry> = (await server.cache(KEYS_REC).catch(() => null))?.entries || {};
    const out = await fn(rec);
    await server.cache(KEYS_REC, { entries: rec });
    return out;
}).catch(e => { console.error("[geopbf] cache index", e); return null; })) as Promise<T | null>;

/**
 * 呼び手の鍵で置いた控えを掃除する（#176）。prefix は必須＝その接頭辞の鍵だけを見る（他の控えには触らない）。
 * maxAge＝置いてからの時間（ms）を超えた物・maxEntries／maxBytes＝超えた分を最後に使ったのが古い順に。台帳に無い同じ接頭辞の鍵（書きかけ）も消す。
 * @returns {Promise<{ removed: number, kept: number, bytes: number } | null>}（bucket provider が無ければ null）
 */
export async function geopbfCachePrune({ prefix, maxAge = Infinity, maxEntries = Infinity, maxBytes = Infinity }: { prefix: string; maxAge?: number; maxEntries?: number; maxBytes?: number } = {} as { prefix: string }): Promise<{ removed: number; kept: number; bytes: number } | null> {
    if (typeof prefix !== "string" || prefix.length < 3) throw new Error("geopbfCachePrune: prefix is required (at least 3 characters) — only keys with this prefix are touched");
    const server = _activeGetServer ? await _activeGetServer().catch(() => null) : null;
    if (!server) return null;
    return withKeys(server, async rec => {
        const keys = new Set<string>(((await server.cache().catch(() => [])) || []).filter((k: unknown) => typeof k === "string" && k.startsWith(prefix) && k !== KEYS_REC));
        let removed = 0;
        const drop = async (k: string): Promise<void> => { await server.cache(k, null).catch(() => {}); delete rec[k]; removed++; };
        for (const k of keys) if (!rec[k]) await drop(k);                                   // 台帳に無い＝書きかけ・旧版
        for (const k of Object.keys(rec)) if (k.startsWith(prefix) && !keys.has(k)) delete rec[k];   // 台帳だけ残った
        const now = Date.now();
        const live = Object.entries(rec).filter(([k]) => k.startsWith(prefix) && keys.has(k));
        for (const [k, e] of live) if (now - (e.t || 0) > maxAge) await drop(k);
        const rest = Object.entries(rec).filter(([k]) => k.startsWith(prefix)).sort((a, b) => (a[1].u || a[1].t || 0) - (b[1].u || b[1].t || 0));
        let bytes = rest.reduce((s, [, e]) => s + (e.bytes || 0), 0), n = rest.length;
        for (const [k, e] of rest) { if (n <= maxEntries && bytes <= maxBytes) break; await drop(k); n--; bytes -= e.bytes || 0; }
        return { removed, kept: n, bytes };
    });
}

/**
 * 鍵で控えた GeoPBF（＋GintBUF）を IDB から引く（#176・一度読んだ物を網に出ずに使い回す）。無い・古い（maxAge 超え）・壊れている＝null。
 * 置く側＝geopbf(data, { cacheKey, cacheMeta })。鍵は呼び手が決める（フィーチャーサービス＝サービス・版・枡）。bucket provider が無ければ常に null。
 * @param {string} key
 * @param {{ gint?: boolean, maxAge?: number }} [opts]  maxAge＝ms（既定＝期限なし）
 */
export async function geopbfCached(key: string, opts: { gint?: boolean; maxAge?: number; name?: string } = {}): Promise<GeoPBF | null> {
    const server = _activeGetServer ? await _activeGetServer().catch(() => null) : null;
    if (!server) return null;
    const val = await server.cache(key).catch(() => null);
    if (!val?.PBF?.byteLength) return null;
    if (opts.maxAge != null && !(Date.now() - (val.meta?.t || 0) <= opts.maxAge)) return null;
    const pbf = await new GeoPBF({ name: opts.name }).set(val.PBF).catch(() => null);
    if (!pbf?.length) return null;
    if (opts.gint !== false) {
        if (val.GINT) await pbf.setGintBUF(val.GINT).catch(() => {});
        if (!pbf.unPackGint) await pbf.gint({ gint: true });   // GINT 無し（gint:false で置いた）か旧版＝ここで焼く（置き直しはしない）
    }
    pbf._cacheKey = key; pbf.cacheMeta = val.meta || null;
    withKeys(server, rec => { if (rec[key]) rec[key].u = Date.now(); });   // 使った＝掃除の順で後ろへ
    return pbf;
}

/** createGeopbf() を呼んだ後に使える旧来の入口（呼ぶ前は throw） */
export async function geopbf(data: GeopbfInput, opts?: GeopbfOptions | string): Promise<GeoPBF> {
    if (!_activeGeopbf) throw new Error("geopbf: call createGeopbf(apiBase) before use");
    return _activeGeopbf(data, opts);
}

/** 入口を作る（apiBase＝bucket の API・無ければ undefined）。worker の配線と IDB の控えはここで決まる */
export function createGeopbf(apiBase?: string, options: CreateGeopbfOptions = {}): GeopbfFn {
    // set()/setGintBUF() の生バッファ解析（フィーチャインデックス走査・gintバッファunpack）はメインスレッド同期実行が既定だが、
    // その worker 版（decoder/pbf.ts・decoder/gint.ts）は元々用意されているのに配線されていなかった。
    // decoderWorkers 同様 import.meta.url 起点で束ねる＝呼び出し側のバンドラに依存しない。options.worker===false で明示的にオフ可。
    if (options.worker !== false) {
        // 重要：バンドラ(vite)が worker チャンクとして静的検出できるのは「new Worker(new URL('…', import.meta.url), {静的 options})」の
        // 直書きだけ。URL を変数に貯める旧方式はビルドで data:URL にインライン化され、worker 内の相対 import が
        // 解決できず本番ビルドだけ黙って死ぬ（devはソース直配信なので動く＝発見が遅れる罠）。ファクトリで直書きを保つ。
        // 入口は ./worker.js 1 本・形式は name で指名（decoderWorkers と同じ理由＝核の複製を消す）。
        // 配線は器の class（GeoPBFBase）へ＝"geopbf/core"・"geopbf/pbf-base" の器も今までどおり worker で解く（旧＝後付けで同じ class だった）
        if (options.workerFactory) setWorkerFactory(options.workerFactory);   // ホストの入口（役割名 → Worker）＝核の複製を断つ
        GeoPBFBase._workerFactory     ??= () => spawnWorker("decoder:pbf", () => builtinWorker("decoder:pbf"));
        GeoPBFBase._gintWorkerFactory ??= () => spawnWorker("decoder:gint", () => builtinWorker("decoder:gint"));
        // prewarm＝復号レーンを起動直後に起こす（仕事は投げない）。worker のモジュール評価が DB 取得や IDB 読みと重なり、
        // 「最初の 1 本だけ極端に遅い」が消える（apps/equal 本番実測 2026-09-18＝最初の geopbf() 1538ms、同データの
        // メインスレッド解析は 46ms＝差は立ち上げ）。既定 off＝復号しないかもしれない埋め込み先で worker を勝手に起こさない。
        if (options.prewarm) prewarmWorkers([["decoder:pbf", GeoPBFBase._workerFactory as LaneFactory], ["decoder:gint", GeoPBFBase._gintWorkerFactory as LaneFactory]]);
    }
    const pbfio = createPbfio(apiBase, options);
    let _server: Promise<PBFIO | null> | null = null;
    const getServer = async (): Promise<PBFIO | null> => {
        _server = _server || pbfio("GIS").catch(e => { console.warn("PBFIO initialization failed.", e); return null; });
        return _server;
    };
    _activeGetServer = getServer;

    const geopbfFn = async function geopbf(data: GeopbfInput, optsArg: GeopbfOptions | string = {}): Promise<GeoPBF> { const opts: GeopbfOptions = isString(optsArg) ? { name: optsArg } : optsArg;
        if (options.worker === false && opts.worker === undefined) opts.worker = false;   // この入口の worker:false を各インスタンスへ（2026-10-11）
        // 相対パス（"/data/x.gpx" "./x.geojson" "../y.zip"）＝自サイトの URL。旧＝bucket 名と誤認して api/bucket/GIS/pbf//data/… を取りに行き
        // 404→0 件を黙って返した（2026-09-10 SDK ドッグフード）。ブラウザなら location 基準で絶対 URL へ。
        if (isString(data) && /^\.{0,2}\//.test(data) && typeof location !== "undefined") data = new URL(data, location.href).href;
        const dt = performance.now();
        const isInZip = (_: unknown): boolean => (isString(_) && /.\.zip#./i.test(_));   // 前後に 1 字ずつ＝旧 /.+\.zip#.+/ と同じ集合・線形時間（CodeQL js/polynomial-redos）
        // 器（"geopbf/core"・"geopbf/pbf-base" の GeoPBF）も受ける＝旧は後付けで同じ class だった＝GeoPBF の prototype へ付け替えて同じ物を返す（gint() を焼ける）
        const isPBF = (_: unknown): _ is GeoPBFBase => (_ instanceof GeoPBFBase);
        const asFull = (q: GeoPBFBase): GeoPBF => q instanceof GeoPBF ? q : Object.setPrototypeOf(q, GeoPBF.prototype) as GeoPBF;
        let eventTarget: EventTarget | null = opts.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
        if (typeof CustomEvent === 'undefined' || !eventTarget?.dispatchEvent) eventTarget = null;   // Node（window/self 無し）で null を参照して落ちていた（1.8.0 tarball 検査で発見・2026-09-14）
        const throwEvent = (type: string, detail: unknown): false | boolean | null => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
        const decoder = async (type: string, file: File, extra: Record<string, unknown> = {}): Promise<GeoPBF | null> => {
            const name = opts.name || file.name.replace(/\.[^\.]+$/, "");
            const precision = opts.precision || 6;
            const encoding = (opts.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis");
            const { description, license, attribution } = opts;
            const params = { file, name, precision, encoding, description, license, attribution, ...extra };
            const event = `convrsion from ${type} to GeoPBF`;
            throwEvent("ConvertStart",{name, event});
            const w = DECODERS.has(type) ? spawnWorkerOrNull(`decoder:${type}`) : null;   // ホストの入口が勝つ（setWorkerFactory）
            if (!w) { throwEvent("ConvertEnd", { name, error: `no worker for [${type}]` }); throw new Error(`geopbf: decoding ${type} needs a Worker (none in this environment; in Node use the CLI or the converters under geopbf/convert)`); }   // 旧＝黙って null＝空 pbf
            return new Promise<GeoPBF | null>(resolve => {
                w.onmessage = async e => {
                    if (e.data?.type === 'progress') {
                        throwEvent("ConvertProgress", { name, loaded: e.data.loaded, total: e.data.total });
                        return;
                    }
                    if (e.data?.warning) throwEvent("ConvertWarning", { name, warning: e.data.warning });
                    throwEvent("ConvertEnd", { name, event });
                    w.terminate(); resolve(e.data ? new GeoPBF(opts).set(e.data.data) : null); };
                w.onerror = e => {
                    throwEvent("ConvertEnd", { name, error: `file decode error: [${type}]` });
                    w.terminate(); console.error(`file decode error: [${type}]`); resolve(null);
                };
                w.postMessage(params);
            });
        };
        const pbf = await _geopbf(data);
        if (pbf) {
            await pbf.gint({ gint: opts.gint, clean: opts.clean });   // clean は docs の geopbf(input, { clean }) の口（旧＝渡っておらず効かなかった・2026-09-25）
            console.log(`[geopbf] 📥 ${pbf.name()} (${pbf.size.toLocaleString("en-US")} bytes) ${(performance.now()-dt).toFixed(2)} msec`);
            // _staleGint＝キャッシュのGINTが版検札で弾かれた印。上の gint() が再焼き済み＝ここで上書き保存して自己修復完了
            //（これが無いと旧v1が居座り、毎回「Failed to unpack … 旧キャッシュ」＋全量再エンコードを払い続ける。2026-08-20実地）。
            if (pbf._staleGint) console.warn(`[geopbf] ${pbf.name()}: rebaking old GINT cache and overwriting (this warning disappears from next time)`);
            // 0 件の結果は保存しない（旧 fgb デコーダの 0 件を IDB が覚えて、直した後も「Failed to load」を返し続けた・2026-09-22）
            // clean 済みの GINT も保存しない＝同じ URL/File を clean なしで読んだ時に clean 済みが返らないように
            if (!pbf.length || opts.clean) { /* 保存しない */ }
            else if (opts.cacheKey && !pbf._cacheKey) {   // 呼び手の鍵で置く（geopbfCached で引く・#176）。meta.t＝置いた時刻（maxAge の物差し）
                const server = await getServer().catch(() => null);
                if (server && opts.nocache !== true) {
                    const GINT = pbf._gintBuffer ? idbGint(pbf._gintBuffer) : null;
                    const key = opts.cacheKey, t = Date.now(), bytes = (pbf.arrayBuffer?.byteLength || 0) + (GINT?.byteLength || 0);
                    server.cache(key, { PBF: pbf.arrayBuffer, GINT, meta: { ...(opts.cacheMeta || {}), t } })
                        .then(() => withKeys(server, rec => { rec[key] = { t, u: t, bytes }; }))   // 台帳へ（掃除の物差し）
                        .catch(console.error);
                }
            }
            else if (isURL(data) && (!pbf.originalURL || pbf._staleGint)) {
                const server = await getServer();
                if (server) {
                    const GINT = idbGint(pbf._gintBuffer);
                    server.cache(data as string, { PBF: pbf.arrayBuffer, GINT }).catch(console.error);
                }
            } else if (isFile(data) && (!pbf._fileKey || pbf._staleGint)) {
                const server = await getServer().catch(() => null);
                if (server && opts.nocache !== true) {
                    const fileKey = `FILE::${data.name}::${data.size}::${data.lastModified}`;
                    const GINT = idbGint(pbf._gintBuffer);
                    server.cache(fileKey, { PBF: pbf.arrayBuffer, GINT }).catch(console.error);
                }
            }
            delete pbf._staleGint;
            // 旧＝ここで await pbf.fileSize()＝ロードごとに Blob 複製＋全量 gzip（消費者は encoder/profile だけ＝あちらが遅延で呼ぶ）。2026-09-15 撤去
            return pbf;
        } else {
            // 文字列（URL/bucket 名）が読めなかった＝空 pbf を黙って返さず例外（呼び手が features.length を検査せずに済む）。
            // オブジェクト/File は従来どおり空 pbf（0 件の FC は正当な入力）。
            if (isString(data)) throw new Error(`geopbf: could not load ${data} (404/CORS/proxy refused; see [native-bucket]/[Fetch Error] in the console)`);
            if (isFile(data)) throw new Error(`geopbf: could not decode ${data.name} (corrupt zip/KML/GPX etc.; see [kmz]/file decode error in the console)`);   // 1.0.5〜 File も無言の空 pbf にしない
            return new GeoPBF(opts);
        }
        async function _geopbf(q: unknown): Promise<GeoPBF | null> { // eslint-disable-line no-inner-declarations
            if (!q) return null;
            if (isPBF(q)) return asFull(q);
            if (isBuffer(q)) return new GeoPBF(opts).set(q);
            if (isFile(q)) {
                if (await isGzip(q)) return _geopbf(await gunzip(q));
                const name = q.name;
                opts.name = opts.name || name.replace(/\.[^\.]+$/, "");
                const fileKey = `FILE::${q.name}::${q.size}::${q.lastModified}`;
                if (opts.nocache !== true) {
                    const server = await getServer().catch(() => null);
                    if (server) {
                        const val = await server.cache(fileKey).catch(() => null);
                        const cachedPbf = val?.PBF ? await new GeoPBF(opts).set(val.PBF) : null;
                        if (cachedPbf?.length) {   // 0 件の保存分は捨てて読み直す（旧版が覚えた空の結果を自己修復）
                            const pbf = cachedPbf;
                            opts.gint !== false && val.GINT && await pbf.setGintBUF(val.GINT);   // キャッシュ再読込も gint:false を尊重（空gintの誤復号→RangeError根治）
                            if (opts.gint !== false && val.GINT && !pbf.unPackGint) pbf._staleGint = true;   // 旧版GINT→外側で再焼き＋上書き保存（自己修復）
                            pbf._fileKey = fileKey;
                            return pbf;
                        }
                    }
                }
                if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
                if (name.match(/\.(ndjson|geojsonl|geojsons|jsonl)$/i)) return _geopbf(await decoder("ndjson", q));   // 1 行 1 地物 / GeoJSON Text Sequence（2026-09-16）
                if (name.match(/\.geojson$/i)) return _geopbf(await decoder("json", q));
                if (name.match(/\.(topo)?json$/i)) return _geopbf(await file2json(q));
                if (name.match(/\.fgb$/i)) return _geopbf(await decoder("fgb", q, { ignoreCrs: opts.ignoreCrs, tky2jgd: opts.tky2jgd ?? options.tky2jgd, patchjgd: opts.patchjgd ?? options.patchjgd }));   // FlatGeobuf v3（仕様どおり＝公式/GDAL の出力も・2026-09-22）
                if (name.match(/\.(sqlite|sqlite3|spatialite|db)$/i)) return _geopbf(await decoder("spatialite", q, { layer: opts.layer, tky2jgd: opts.tky2jgd ?? options.tky2jgd, patchjgd: opts.patchjgd ?? options.patchjgd }));   // GeoPackage＝自前 SQLite リーダ（読み専用・1 層）   // SpatiaLite（2026-09-16）
                if (name.match(/\.gpkg$/i)) return _geopbf(await decoder("gpkg", q, { layer: opts.layer, tky2jgd: opts.tky2jgd ?? options.tky2jgd, patchjgd: opts.patchjgd ?? options.patchjgd }));   // GeoPackage＝自前 SQLite リーダ（読み専用・1 層）
                if (name.match(/\.(geo)?parquet$/i)) return _geopbf(await decoder("parquet", q, { geometryColumn: opts.geometryColumn, ignoreCrs: opts.ignoreCrs }));   // GeoParquet（WKB・経緯度）
                if (name.match(/\.dxf$/i)) return _geopbf(await decoder("dxf", q, { crs: opts.crs, ignoreCrs: opts.ignoreCrs, unitScale: opts.unitScale, closedAsPolygon: opts.closedAsPolygon, tky2jgd: opts.tky2jgd ?? options.tky2jgd, patchjgd: opts.patchjgd ?? options.patchjgd }));   // DXF（2026-09-16）
                if (name.match(/\.(csv|tsv|xlsx)$/i)) return _geopbf(await decoder("csv", q, { lon: opts.lon, lat: opts.lat, wkt: opts.wkt, sheet: opts.sheet, delimiter: opts.delimiter, fallbackEncoding: opts.fallbackEncoding }));   // 表＝経緯度列か WKT 列
                if (name.match(/\.zip$/i)) {
                    // zip の中身で振り分け: *.gdbtable があれば FileGDB（.gdb をそのまま zip したもの）。一覧だけ読む（展開しない）
                    let kind = opts.format === "moj" ? "moj" : opts.format === "gdb" ? "gdb" : "shape";
                    if (kind === "shape") { const list = await decodeZIP(q, false).catch(() => null); if (list?.some(e => /\.gdbtable$/i.test(e.name))) kind = "gdb"; }
                    return _geopbf(await decoder(kind, q, kind === "gdb" ? { layer: opts.layer, ignoreCrs: opts.ignoreCrs, tky2jgd: opts.tky2jgd ?? options.tky2jgd, patchjgd: opts.patchjgd ?? options.patchjgd } : kind === "shape" ? { crs: opts.crs } : {}));   // shape の crs＝.prj が無い時の座標系
                }
                if (name.match(/\.km[lz]$/i)) return _geopbf(await decoder("kmz", q));   // .kml（生）も kmz デコーダが読む（1.0.5〜）
                if (name.match(/\.gpx$/i)) return _geopbf(await decoder("gpx", q));
                if (name.match(/\.czml$/i)) return _geopbf(await decoder("czml", q));   // Cesium CZML（.json に入った CZML は json デコーダが嗅ぎ分ける・2026-09-17）
                if (name.match(/\.(gml|xml)$/i)) return _geopbf(await decoder("gml", q));
                throw new Error(`geopbf: unsupported file "${name}" (supported: .geopbf .pbf .geojson .json .topojson .fgb .gpkg .parquet .csv .tsv .xlsx .zip(shape/moj/gdb) .kml .kmz .gpx .czml .gml .xml .gz)`);   // 旧＝warn して空 pbf（無言の 0 件）
            }
            // TODO(ts): fixed in the follow-up entry-fix PR — Feature[] never gets here (isObject excludes arrays) and a Blob without a name is read as a GeoJSON object: both resolve to an empty GeoPBF
            if (isObject(q)) {
                const fc = toFeatureCollection(q);
                return (fc && fc.features.length > 0) ? await new GeoPBF(opts).set(fc) : null;
            }
            const server = await getServer();
            if (isString(q) && server) {
                if (isURL(q)) {
                    const _inner = q.includes('#') ? q.split('#')[1] : '';
                    const _shpInZip = _inner && /\.shp$/i.test(_inner);
                    const fetchUrl = _shpInZip ? q.split('#')[0]
                        : isInZip(q) ? q
                        : (q.match(/\.zip$/) && opts.target) ? [q, opts.target].join("#") : q;
                    const val = opts.nocache == true? undefined: await server.cache(fetchUrl).catch(console.error);
                    const cachedPbf = val?.PBF ? await new GeoPBF(opts).set(val.PBF) : null;
                    if (cachedPbf?.length) { const pbf = cachedPbf;   // 0 件の保存分は捨てて取り直す（旧版が覚えた空の結果を自己修復）
                        opts.gint !== false && val.GINT && await pbf.setGintBUF(val.GINT);   // キャッシュ再読込も gint:false を尊重（空gintの誤復号→RangeError根治）
                        // 版検札落ち（unPackGint=null）＝旧フォーマットのGINTがIDBに残っている。印だけ立てて返す＝
                        // 外側の gint() が再焼きし、外側のキャッシュ書き込みが上書き保存（自己修復・pbf-io.load と同じ流儀）。
                        if (opts.gint !== false && val.GINT && !pbf.unPackGint) pbf._staleGint = true;
                        pbf.originalURL = q;
                        return pbf;
                    }
                    const fetched = await server.fetch(fetchUrl);
                    if (_shpInZip) return _geopbf(await decoder("shape", fetched as File, { shpTarget: _inner, crs: opts.crs }));
                    return _geopbf(fetched);
                }
                return _geopbf(await server.load(q, { gint: opts.gint }));
            }
            return null;
            async function file2json(file: File): Promise<FeatureCollection & { name?: string }> {
                const json: FeatureCollection & { name?: string } = toFeatureCollection(JSON.parse(await file.text()));
                json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/, "");
                return json;
            }
            function toFeatureCollection(q: Record<string, unknown> | unknown[]): FeatureCollection {
                const fc = (a: unknown[]): FeatureCollection => ({ type: "FeatureCollection", features: a as Feature[] });
                const f = (g: unknown): Feature => ({ type: "Feature", geometry: g as Geometry, properties: {} });
                return Array.isArray(q) ? fc(q.filter(t => isObject(t) && t.type == "Feature")) :
                    (q.type == "Topology") ? topo2geo(q as unknown as Topology) as FeatureCollection :
                    (q.type == "FeatureCollection") ? q as unknown as FeatureCollection :
                    (q.type == "Feature") ? fc([q]) :
                    (q.type == "GeometryCollection") ? fc(((q.geometries as unknown[]) ?? []).map(f)) :
                    q.type ? fc([f(q)]) : fc([]);
            }
        }
    };
    _activeGeopbf = geopbfFn;
    return geopbfFn;
}

const encoder = async (pbf: GeoPBF, type: string, opts: ExportOptions = {}): Promise<unknown> => {
    const eventTarget = typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : null);
    const name = pbf._name, buf = pbf.arrayBuffer, gintbuf = pbf._gintBuffer;
    const event = type =="profile"? `profiling` : `conversion from GeoPBF to ${type}`;
    const throwEvent = (type: string, detail: unknown): false | boolean | null => eventTarget && !opts.silent && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
    opts.message == false || throwEvent("ConvertStart", { name, event });
    const w = ENCODERS.has(type) ? spawnWorkerOrNull(`encoder:${type}`) : null;
    if (!w) return null;   // Worker が作れない（Node の main 等）＝null＝gint() は main スレッドの topology へ落ちる
    return new Promise(resolve => {
        w.onmessage = e => {
            opts.message == false || throwEvent("ConvertEnd", { name, event });
            w.terminate(); resolve(e.data);
        };
        w.onerror = (e) => {
            opts.message == false || throwEvent("ConvertEnd", { name, error: `file encode error: [${type}]` });
            w.terminate(); console.error(`pbf encode error: [${type}]`, e?.message, e?.filename, `line:${e?.lineno}`); resolve(null);
        };
        w.postMessage({ buf, gintbuf, name, opts }, [buf]);
    });
};
// 14 個の実体（GeoPBF のメンバーが委譲する・pbf.ts の wireEntry）。旧＝ここで GeoPBF.prototype へ defineProperty していた
const methods: GeoPBFEntryMethods = {
    async save() { const s = _activeGetServer ? await _activeGetServer() : null; return (s && await s.save(this)) ? this : null; },
    async preview(canvasArg?: HTMLCanvasElement | OffscreenCanvas | Record<string, unknown> | null, props: Record<string, unknown> = {}) {
        let canvas = canvasArg;
        const htmlCanvas = (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) ? canvas : null;
        if (htmlCanvas) canvas = null;
        else if (isObject(canvas)) { props = canvas; canvas = null; }
        const offscreen = (canvas || null) as OffscreenCanvas | null;
        const buf = this.arrayBuffer, name = this._name;
        const w = spawnWorkerOrNull("encoder:preview");
        if (!w) return null;   // 旧＝factory が拒んだ・Worker が無い時に null を参照して落ちた
        const transferables: Transferable[] = offscreen ? [buf, offscreen] : [buf];
        const bitmap = await new Promise<ImageBitmap | null>(resolve => {
            w.onmessage = e => { w.terminate(); resolve(e.data); };
            w.onerror  = () => { w.terminate(); resolve(null); };
            w.postMessage({ buf, canvas: offscreen, name, props }, transferables);
        });
        if (htmlCanvas && bitmap instanceof ImageBitmap) {
            htmlCanvas.width  = bitmap.width;
            htmlCanvas.height = bitmap.height;
            const dpr = (props.dpr as number) || 1;
            htmlCanvas.style.width  = (bitmap.width  / dpr) + "px";
            htmlCanvas.style.height = (bitmap.height / dpr) + "px";
            htmlCanvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        }
        return bitmap;
    },
    async profile(opts = {}) { return encoder(this, "profile", opts); },
    async gintbuf(opts = {}) { return encoder(this, "gint", opts) as Promise<ArrayBuffer | null>; },
    async geopbfFile(opts = {}) { return encoder(this, "geopbf", opts) as Promise<File | Blob | null>; },
    async geojsonFile(opts = {}) { return encoder(this, "geojson", opts) as Promise<File | Blob | null>; },
    async topojsonFile(opts = {}) { return encoder(this, "topojson", opts) as Promise<File | Blob | null>; },
    async shapeFile(opts = {}) { return encoder(this, "shape", opts) as Promise<File | Blob | null>; },
    async kmzFile(opts = {}) { return encoder(this, "kmz", opts) as Promise<File | Blob | null>; },
    async gpxFile(opts = {}) { return encoder(this, "gpx", opts) as Promise<File | Blob | null>; },
    async czmlFile(opts = {}) { return encoder(this, "czml", opts) as Promise<File | Blob | null>; },
    async gmlFile(opts = {}) { return encoder(this, "gml", opts) as Promise<File | Blob | null>; },
    async fgbFile(opts = {}) { return encoder(this, "fgb", opts) as Promise<File | Blob | null>; },
    async gint(opts: GintOptions = {}) { if (opts.gint === false) return this;
        if (!this.unPackGint) {
            let buf = await encoder(this, "gint", { ...opts, shared: typeof SharedArrayBuffer !== "undefined" }) as ArrayBuffer | SharedArrayBuffer | null;   // Worker が SAB に直に組む（setGintBUF の写しが消える）
            if (!buf) { await gint.initialize(); buf = topology(this); if (opts.clean) buf = cleanGintBuffer(buf, opts.clean); }   // Worker 不成立の予備でも clean を落とさない
            await this.setGintBUF(buf);
        } else if (opts.clean) this.cleanTopology(opts.clean);   // 焼き済み（キャッシュ由来・先の gint()）にも clean を掛ける
        if (!this.unPackGint) throw new Error("Failed to encode Gint buffer.");
        return this;
    },
};

wireEntry(methods);
// geopbf/maplibre のタイル読み（modules/tile-load.ts）も入口が読まれていれば GeoPBF（gint() を持つ）で作る＝Worker で焼く（旧＝後付けが器の class にも生えていた）
useEntryClass(GeoPBF);
