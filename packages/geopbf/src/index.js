import { GeoPBF } from "./pbf.js";
import { createPbfio } from "./pbf-io.js";
import { spawnWorker, setWorkerFactory } from "./modules/workerFactory.js";
import { builtinWorker } from "./modules/builtinWorkers.js";   // geopbf 自身の worker（new Worker の直書きはここ 1 か所＝ホストはビルドの alias で「作らない版」に差し替えられる）
export { setWorkerFactory };   // worker の入口を外から差し替える（役割名 → Worker・null＝既定）
// 変換 worker は入口 1 本（./worker.js）＝形式は Worker の name で指名する（処方②・ortho-earth#12・2026-09-14）。
// 形式ごとに worker ファイルを分けると、バンドラ（vite）が worker ごとに独立ビルドして核（pbf-base 等）を 25〜29 回複製した。
// 2026-09-22：new Worker の直書きは modules/builtinWorkers.js 1 か所へ（COG・タイル書き出しも同じ入口の役割に）。
// ホストは setWorkerFactory / createGeopbf の workerFactory で自分の入口へ寄せられる（spawnWorker が先に聞く）。
// 形式の名簿（読む／書く）。worker を作るのは spawnWorker（ホストの入口が勝つ）→ 無ければ modules/builtinWorkers.js（geopbf 自身の入口）。
const DECODERS = new Set(["fgb", "gint", "gml", "gpkg", "gdb", "parquet", "csv", "czml", "dxf", "gpx", "json", "ndjson", "kmz", "moj", "pbf", "shape", "spatialite"]);
const ENCODERS = new Set(["czml", "fgb", "geojson", "geopbf", "gint", "gml", "gpx", "kmz", "preview", "profile", "shape", "topojson"]);

import { topology } from "./extension/topology.js";
import { gint } from "./extension/gint.js";
import { topo2geo } from "./modules/topo2geo.js";
import { gunzip, isGzip } from "./modules/gzip.js";
import { decodeZIP } from "./modules/decodeZIP.js";
import { isString, isURL, isFile, isObject, isBuffer } from "./modules/utility.js"
import { prewarmWorkers } from "./modules/workerPool.js";

// prototype メソッドとレガシー geopbf が使うアクティブインスタンス
let _activeGetServer = null;
let _activeGeopbf   = null;

// レガシー互換エクスポート（createGeopbf 呼び出し後に使用可能）
export async function geopbf(data, opts) {
    if (!_activeGeopbf) throw new Error("geopbf: call createGeopbf(apiBase) before use");
    return _activeGeopbf(data, opts);
}

export function createGeopbf(apiBase, options = {}) {
    // set()/setGintBUF() の生バッファ解析（フィーチャインデックス走査・gintバッファunpack）はメインスレッド同期実行が既定だが、
    // その worker 版（decoder/pbf.js・decoder/gint.js）は元々用意されているのに配線されていなかった。
    // decoderWorkers 同様 import.meta.url 起点で束ねる＝呼び出し側のバンドラに依存しない。options.worker===false で明示的にオフ可。
    if (options.worker !== false) {
        // 重要：バンドラ(vite)が worker チャンクとして静的検出できるのは「new Worker(new URL('…', import.meta.url), {静的 options})」の
        // 直書きだけ。URL を変数に貯める旧方式はビルドで data:URL にインライン化され、worker 内の相対 import が
        // 解決できず本番ビルドだけ黙って死ぬ（devはソース直配信なので動く＝発見が遅れる罠）。ファクトリで直書きを保つ。
        // 入口は ./worker.js 1 本・形式は name で指名（decoderWorkers と同じ理由＝核の複製を消す）。
        if (options.workerFactory) setWorkerFactory(options.workerFactory);   // ホストの入口（役割名 → Worker）＝核の複製を断つ
        GeoPBF._workerFactory     ??= () => spawnWorker("decoder:pbf", () => builtinWorker("decoder:pbf"));
        GeoPBF._gintWorkerFactory ??= () => spawnWorker("decoder:gint", () => builtinWorker("decoder:gint"));
        // prewarm＝復号レーンを起動直後に起こす（仕事は投げない）。worker のモジュール評価が DB 取得や IDB 読みと重なり、
        // 「最初の 1 本だけ極端に遅い」が消える（apps/equal 本番実測 2026-09-18＝最初の geopbf() 1538ms、同データの
        // メインスレッド解析は 46ms＝差は立ち上げ）。既定 off＝復号しないかもしれない埋め込み先で worker を勝手に起こさない。
        if (options.prewarm) prewarmWorkers([["decoder:pbf", GeoPBF._workerFactory], ["decoder:gint", GeoPBF._gintWorkerFactory]]);
    }
    const pbfio = createPbfio(apiBase, options);
    let _server = null;
    const getServer = async () => {
        _server = _server || pbfio("GIS").catch(e => { console.warn("PBFIO initialization failed.", e); return null; });
        return _server;
    };
    _activeGetServer = getServer;

    const geopbfFn = async function geopbf(data, opts = {}) { if (isString(opts)) opts = { name: opts };
        // 相対パス（"/data/x.gpx" "./x.geojson" "../y.zip"）＝自サイトの URL。旧＝bucket 名と誤認して api/bucket/GIS/pbf//data/… を取りに行き
        // 404→0 件を黙って返した（2026-09-10 SDK ドッグフード）。ブラウザなら location 基準で絶対 URL へ。
        if (isString(data) && /^\.{0,2}\//.test(data) && typeof location !== "undefined") data = new URL(data, location.href).href;
        const dt = performance.now();
        const isInZip = _ => (isString(_) && _.match(/.+\.zip#.+/i));
        const isPBF = _ => (_ instanceof GeoPBF);
        let eventTarget = opts.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
        if (typeof CustomEvent === 'undefined' || !eventTarget?.dispatchEvent) eventTarget = null;   // Node（window/self 無し）で null を参照して落ちていた（1.8.0 tarball 検査で発見・2026-09-14）
        const throwEvent = (type, detail) => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
        const decoder = async (type, file, extra = {}) => {
            const name = opts.name || file.name.replace(/\.[^\.]+$/, "");
            const precision = opts.precision || 6;
            const encoding = (opts.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis");
            const { description, license, attribution } = opts;
            const params = { file, name, precision, encoding, description, license, attribution, ...extra };
            const event = `convrsion from ${type} to GeoPBF`;
            throwEvent("ConvertStart",{name, event});
            const w = DECODERS.has(type) ? spawnWorker(`decoder:${type}`, () => builtinWorker(`decoder:${type}`)) : null;   // ホストの入口が勝つ（setWorkerFactory）
            if (!w) { resolve(null); return; }
            return new Promise(resolve => {
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
            await pbf.gint({gint: opts.gint});
            console.log(`[geopbf] 📥 ${pbf.name()} (${pbf.size.toLocaleString("en-US")} bytes) ${(performance.now()-dt).toFixed(2)} msec`);
            // _staleGint＝キャッシュのGINTが版検札で弾かれた印。上の gint() が再焼き済み＝ここで上書き保存して自己修復完了
            //（これが無いと旧v1が居座り、毎回「Failed to unpack … 旧キャッシュ」＋全量再エンコードを払い続ける。2026-08-20実地）。
            if (pbf._staleGint) console.warn(`[geopbf] ${pbf.name()}: rebaking old GINT cache and overwriting (this warning disappears from next time)`);
            // 0 件の結果は保存しない（旧 fgb デコーダの 0 件を IDB が覚えて、直した後も「Failed to load」を返し続けた・2026-09-22）
            if (!pbf.length) { /* 保存しない */ }
            else if (isURL(data) && (!pbf.originalURL || pbf._staleGint)) {
                const server = await getServer();
                if (server) {
                    const GINT = new Uint8Array(pbf._gintBuffer).slice().buffer;
                    server.cache(data, { PBF: pbf.arrayBuffer, GINT }).catch(console.error);
                }
            } else if (isFile(data) && (!pbf._fileKey || pbf._staleGint)) {
                const server = await getServer().catch(() => null);
                if (server && opts.nocache !== true) {
                    const fileKey = `FILE::${data.name}::${data.size}::${data.lastModified}`;
                    const GINT = new Uint8Array(pbf._gintBuffer).slice().buffer;
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
        async function _geopbf(q) { // eslint-disable-line no-inner-declarations
            if (!q) return null;
            if (isPBF(q)) return q;
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
            if (isObject(q)) {
                q = toFeatureCollection(q);
                return (q && q.features.length > 0) ? await new GeoPBF(opts).set(q) : null;
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
                    if (_shpInZip) return _geopbf(await decoder("shape", fetched, { shpTarget: _inner, crs: opts.crs }));
                    return _geopbf(fetched);
                }
                return _geopbf(await server.load(q, { gint: opts.gint }));
            }
            return null;
            async function file2json(file) {
                const json = toFeatureCollection(JSON.parse(await file.text()));
                json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/, "");
                return json;
            }
            function toFeatureCollection(q) {
                const fc = a => ({ type: "FeatureCollection", features: a });
                const f = g => ({ type: "Feature", geometry: g, properties: {} });
                return Array.isArray(q) ? fc(q.filter(t => isObject(t) && t.type == "Feature")) :
                    (q.type == "Topology") ? topo2geo(q) :
                    (q.type == "FeatureCollection") ? q :
                    (q.type == "Feature") ? fc([q]) :
                    (q.type == "GeometryCollection") ? fc((q.geometries ?? []).map(f)) :
                    q.type ? fc([f(q)]) : fc([]);
            }
        }
    };
    _activeGeopbf = geopbfFn;
    return geopbfFn;
}

const encoder = async (pbf, type, opts = {}) => {
    const eventTarget = typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : null);
    const name = pbf._name, buf = pbf.arrayBuffer, gintbuf = pbf._gintBuffer;
    const event = type =="profile"? `profiling` : `conversion from GeoPBF to ${type}`;
    const throwEvent = (type, detail) => eventTarget && !opts.silent && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
    opts.message == false || throwEvent("ConvertStart", { name, event });
    const w = ENCODERS.has(type) ? spawnWorker(`encoder:${type}`, () => builtinWorker(`encoder:${type}`)) : null;
    if (!w) return null;
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
const methods = {
    async save() { const s = _activeGetServer ? await _activeGetServer() : null; return (s && await s.save(this)) ? this : null; },
    async preview(canvas, props = {}) {
        const htmlCanvas = (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) ? canvas : null;
        if (htmlCanvas) canvas = null;
        else if (isObject(canvas)) { props = canvas; canvas = null; }
        const offscreen = canvas || null;
        const buf = this.arrayBuffer, name = this._name;
        const w = spawnWorker("encoder:preview", () => builtinWorker("encoder:preview"));
        const transferables = offscreen ? [buf, offscreen] : [buf];
        const bitmap = await new Promise(resolve => {
            w.onmessage = e => { w.terminate(); resolve(e.data); };
            w.onerror  = () => { w.terminate(); resolve(null); };
            w.postMessage({ buf, canvas: offscreen, name, props }, transferables);
        });
        if (htmlCanvas && bitmap instanceof ImageBitmap) {
            htmlCanvas.width  = bitmap.width;
            htmlCanvas.height = bitmap.height;
            const dpr = props.dpr || 1;
            htmlCanvas.style.width  = (bitmap.width  / dpr) + "px";
            htmlCanvas.style.height = (bitmap.height / dpr) + "px";
            htmlCanvas.getContext("2d").drawImage(bitmap, 0, 0);
        }
        return bitmap;
    },
    async profile(opts = {}) { return encoder(this, "profile", opts); },
    async gintbuf(opts = {}) { return encoder(this, "gint", opts); },
    async geopbfFile(opts = {}) { return encoder(this, "geopbf", opts); },
    async geojsonFile(opts = {}) { return encoder(this, "geojson", opts); },
    async topojsonFile(opts = {}) { return encoder(this, "topojson", opts); },
    async shapeFile(opts = {}) { return encoder(this, "shape", opts); },
    async kmzFile(opts = {}) { return encoder(this, "kmz", opts); },
    async gpxFile(opts = {}) { return encoder(this, "gpx", opts); },
    async czmlFile(opts = {}) { return encoder(this, "czml", opts); },
    async gmlFile(opts = {}) { return encoder(this, "gml", opts); },
    async fgbFile(opts = {}) { return encoder(this, "fgb", opts); },
    async gint(opts = {}) { if (opts.gint === false) return this;
        if (!this.unPackGint) {
            let buf = await encoder(this, "gint", opts);
            if (!buf) { await gint.initialize(); buf = topology(this); }
            await this.setGintBUF(buf);
        }
        if (!this.unPackGint) throw new Error("Failed to encode Gint buffer.");
        return this;
    },
};

Object.entries(methods).forEach(([name, func]) => {
    Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false });
});
