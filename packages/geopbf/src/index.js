import { GeoPBF } from "./pbf.js";
import { createPbfio } from "./pbf-io.js";
// Dynamic template literals new URL(`./decoder/${type}.js`, ...) cannot be statically analyzed by Vite
// and are copied as-is without bundling, making relative imports unresolvable in production.
// Listing each decoder/encoder statically allows Vite to bundle them correctly.
const decoderWorkers = {
    fgb:   () => new Worker(new URL('./decoder/fgb.js',   import.meta.url), { type: 'module' }),
    gint:  () => new Worker(new URL('./decoder/gint.js',  import.meta.url), { type: 'module' }),
    gml:   () => new Worker(new URL('./decoder/gml.js',   import.meta.url), { type: 'module' }),
    gpx:   () => new Worker(new URL('./decoder/gpx.js',   import.meta.url), { type: 'module' }),
    json:  () => new Worker(new URL('./decoder/json.js',  import.meta.url), { type: 'module' }),
    kmz:   () => new Worker(new URL('./decoder/kmz.js',   import.meta.url), { type: 'module' }),
    moj:   () => new Worker(new URL('./decoder/moj.js',   import.meta.url), { type: 'module' }),
    pbf:   () => new Worker(new URL('./decoder/pbf.js',   import.meta.url), { type: 'module' }),
    shape: () => new Worker(new URL('./decoder/shape.js', import.meta.url), { type: 'module' }),
};
const encoderWorkers = {
    fgb:      () => new Worker(new URL('./encoder/fgb.js',      import.meta.url), { type: 'module' }),
    geojson:  () => new Worker(new URL('./encoder/geojson.js',  import.meta.url), { type: 'module' }),
    geopbf:   () => new Worker(new URL('./encoder/geopbf.js',   import.meta.url), { type: 'module' }),
    gint:     () => new Worker(new URL('./encoder/gint.js',     import.meta.url), { type: 'module' }),
    gml:      () => new Worker(new URL('./encoder/gml.js',      import.meta.url), { type: 'module' }),
    gpx:      () => new Worker(new URL('./encoder/gpx.js',      import.meta.url), { type: 'module' }),
    kmz:      () => new Worker(new URL('./encoder/kmz.js',      import.meta.url), { type: 'module' }),
    preview:  () => new Worker(new URL('./encoder/preview.js',  import.meta.url), { type: 'module' }),
    profile:  () => new Worker(new URL('./encoder/profile.js',  import.meta.url), { type: 'module' }),
    shape:    () => new Worker(new URL('./encoder/shape.js',    import.meta.url), { type: 'module' }),
    topojson: () => new Worker(new URL('./encoder/topojson.js', import.meta.url), { type: 'module' }),
};

import { topology } from "./extension/topology.js";
import { gint } from "./extension/gint.js";
import { topo2geo } from "./modules/topo2geo.js";
import { gunzip, isGzip } from "native-bucket";
import { isString, isURL, isFile, isObject, isBuffer } from "common"

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
        // 重要：バンドラ(vite)が worker チャンクとして静的検出できるのは「new Worker(new URL('…', import.meta.url))」の
        // 直書きだけ。URL を変数に貯める旧方式はビルドで data:URL にインライン化され、worker 内の相対 import が
        // 解決できず本番ビルドだけ黙って死ぬ（devはソース直配信なので動く＝発見が遅れる罠）。ファクトリで直書きを保つ。
        GeoPBF._workerFactory     ??= () => new Worker(new URL('./decoder/pbf.js',  import.meta.url), { type: 'module' });
        GeoPBF._gintWorkerFactory ??= () => new Worker(new URL('./decoder/gint.js', import.meta.url), { type: 'module' });
    }
    const pbfio = createPbfio(apiBase, options);
    let _server = null;
    const getServer = async () => {
        _server = _server || pbfio("GIS").catch(e => { console.warn("PBFIO initialization failed.", e); return null; });
        return _server;
    };
    _activeGetServer = getServer;

    const geopbfFn = async function geopbf(data, opts = {}) { if (isString(opts)) opts = { name: opts };
        const dt = performance.now();
        const isInZip = _ => (isString(_) && _.match(/.+\.zip#.+/i));
        const isPBF = _ => (_ instanceof GeoPBF);
        let eventTarget = opts.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
        if (typeof CustomEvent === 'undefined' || !eventTarget.dispatchEvent) eventTarget = null;
        const throwEvent = (type, detail) => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
        const decoder = async (type, file, extra = {}) => {
            const name = opts.name || file.name.replace(/\.[^\.]+$/, "");
            const precision = opts.precision || 6;
            const encoding = (opts.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis");
            const { description, license, attribution } = opts;
            const params = { file, name, precision, encoding, description, license, attribution, ...extra };
            const event = `convrsion from ${type} to GeoPBF`;
            throwEvent("ConvertStart",{name, event});
            const w = decoderWorkers[type]?.();
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
            console.log(`[geopbf] 📥 ${pbf.name()} (${pbf.size.toLocaleString()} bytes) ${(performance.now()-dt).toFixed(2)} msec`);
            // _staleGint＝キャッシュのGINTが版検札で弾かれた印。上の gint() が再焼き済み＝ここで上書き保存して自己修復完了
            //（これが無いと旧v1が居座り、毎回「Failed to unpack … 旧キャッシュ」＋全量再エンコードを払い続ける。2026-08-20実地）。
            if (pbf._staleGint) console.warn(`[geopbf] ${pbf.name()}: 旧版GINTキャッシュを再焼きして上書き保存（次回からこの警告は消える）`);
            if (isURL(data) && (!pbf.originalURL || pbf._staleGint)) {
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
            await pbf.fileSize();
            return pbf;
        } else return new GeoPBF(opts);
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
                        if (val?.PBF) {
                            const pbf = await new GeoPBF(opts).set(val.PBF);
                            opts.gint !== false && val.GINT && await pbf.setGintBUF(val.GINT);   // キャッシュ再読込も gint:false を尊重（空gintの誤復号→RangeError根治）
                            if (opts.gint !== false && val.GINT && !pbf.unPackGint) pbf._staleGint = true;   // 旧版GINT→外側で再焼き＋上書き保存（自己修復）
                            pbf._fileKey = fileKey;
                            return pbf;
                        }
                    }
                }
                if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
                if (name.match(/\.geojson$/i)) return _geopbf(await decoder("json", q));
                if (name.match(/\.(topo)?json$/i)) return _geopbf(await file2json(q));
                if (name.match(/\.fgb$/i)) return _geopbf(await decoder("fgb", q));
                if (name.match(/\.zip$/i)) return _geopbf(await decoder(opts.format === "moj" ? "moj" : "shape", q));
                if (name.match(/\.kmz$/i)) return _geopbf(await decoder("kmz", q));
                if (name.match(/\.gpx$/i)) return _geopbf(await decoder("gpx", q));
                if (name.match(/\.(gml|xml)$/i)) return _geopbf(await decoder("gml", q));
                console.warn("illegal file:", name);
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
                    if (val && val.PBF) { const pbf = (await new GeoPBF(opts).set(val.PBF));
                        opts.gint !== false && val.GINT && await pbf.setGintBUF(val.GINT);   // キャッシュ再読込も gint:false を尊重（空gintの誤復号→RangeError根治）
                        // 版検札落ち（unPackGint=null）＝旧フォーマットのGINTがIDBに残っている。印だけ立てて返す＝
                        // 外側の gint() が再焼きし、外側のキャッシュ書き込みが上書き保存（自己修復・pbf-io.load と同じ流儀）。
                        if (opts.gint !== false && val.GINT && !pbf.unPackGint) pbf._staleGint = true;
                        pbf.originalURL = q;
                        return pbf;
                    }
                    const fetched = await server.fetch(fetchUrl);
                    if (_shpInZip) return _geopbf(await decoder("shape", fetched, { shpTarget: _inner }));
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
    const w = encoderWorkers[type]?.();
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
        const w = encoderWorkers.preview();
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
