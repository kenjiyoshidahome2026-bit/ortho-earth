import Pbf from 'pbf';
import { deflateRaw, inflateRaw } from "../../../native-bucket/src/gzip.js";
import { Bucket } from "../../../native-bucket/src/Bucket.js";
import { Cache } from "../../../native-bucket/src/Cache.js";
import { ALT_TAGS as TAGS } from "./alt-tags.js";

export async function altpbf(db = "GIS") {
    const bucket = await Bucket(`${db}/alt`, { silent: true });
    const cache = await Cache(`${db}/alt`);
    const worker = new Worker(new URL(`./worker.js`, import.meta.url), { type: 'module' });
    const IndexName = "index";
    let loading = false;

    return { save, load, isLoading, fileName, lnglat, exist, size, saveIndex, loadIndex };

    async function encode(q) {
        const pbf = new Pbf();
        const { width, height, data, name, source, lng, lat } = q;

        // メタデータの埋め込み
        if (name) pbf.writeStringField(TAGS.NAME, name);
        if (source) pbf.writeStringField(TAGS.SOURCE, source);
        if (lng !== undefined) pbf.writeSVarintField(TAGS.LNG, Math.round(lng * 1e6));
        if (lat !== undefined) pbf.writeSVarintField(TAGS.LAT, Math.round(lat * 1e6));

        pbf.writeVarintField(TAGS.WIDTH, width);
        pbf.writeVarintField(TAGS.HEIGHT, height);

        // 標高データのデルタ符号化
        let sum = 0;
        const deltas = data.map(t => {
            const v = t - sum;
            sum = t;
            return v;
        });
        pbf.writePackedSVarint(TAGS.DATA, deltas);

        return await deflateRaw(pbf.finish());
    }

    async function decode(buf) {
        const pbf = new Pbf(await inflateRaw(buf));
        const res = { width: 0, height: 0, data: null, name: "", source: "", lng: 0, lat: 0 };
        const deltas = [];

        pbf.readFields(tag => {
            if (tag === TAGS.NAME) res.name = pbf.readString();
            else if (tag === TAGS.SOURCE) res.source = pbf.readString();
            else if (tag === TAGS.WIDTH) res.width = pbf.readVarint();
            else if (tag === TAGS.HEIGHT) res.height = pbf.readVarint();
            else if (tag === TAGS.LNG) res.lng = pbf.readSVarint() / 1e6;
            else if (tag === TAGS.LAT) res.lat = pbf.readSVarint() / 1e6;
            else if (tag === TAGS.DATA) pbf.readPackedSVarint(deltas);
        });

        let sum = 0;
        res.data = new Int16Array(deltas.map(d => sum += d));
        return res;
    }

    async function save(name, q) { // 保存時に緯度経度を自動推論して埋め込む
        const pos = lnglat(name);
        if (pos) {
            q.lng = q.lng ?? pos[0];
            q.lat = q.lat ?? pos[1];
        }
        q.name = q.name ?? name;

        const file = new File([await encode(q)], name, { type: "application/octet-binary" });
        console.log(` <= ${file.name} [${q.width} x ${q.height}]: ${file.size.toLocaleString()} bytes`);
        return bucket.put(file);
    }

    async function load(name, use_worker = true) {
        var obj = await cache(name); if (obj) return obj;
        loading = true;
        const buf = await bucket.get(name, "arrayBuffer");
        if (!buf) { loading = false; return null; }

        obj = use_worker ? await loadByWorker(name) : await decode(buf);
        loading = false;

        if (!obj) return console.error("ALTPBF Load Error:" + name);
        return cache(name, obj);

        async function loadByWorker(name) {
            return new Promise(resolve => {
                worker.postMessage(bucket.url + name);
                worker.onmessage = e => resolve(e.data.error ? null : e.data);
            });
        }
    }

    function fileName([lng, lat], level = 1) {
        const L2 = n => ("00" + Math.abs(n)).slice(-2);
        const L3 = n => ("000" + Math.abs(n)).slice(-3);
        return `HGT${L2(level)}${(lat < 0 ? "S" : "N") + L2(lat)}${(lng < 0 ? "W" : "E") + L3(lng)}`;
    }

    function lnglat(s) { // HGT01N35E139 のような形式に対応
        const r = s.match(/([NS])(\d{2})([WE])(\d{3})/);
        return r ? [(r[3] == "E" ? 1 : -1) * (+r[4]), (r[1] == "N" ? 1 : -1) * (+r[2])] : null;
    }

    async function exist(name) { return bucket.exist(name); }
    async function size(name) { return bucket.size(name); }
    async function saveIndex(json) {
        const file = new File([JSON.stringify(json)], IndexName, { type: "application/json" });
        await bucket.put(file);
        return json;
    }
    async function loadIndex() { return bucket.exist(IndexName) ? bucket.get(IndexName, "json") : null; }
}