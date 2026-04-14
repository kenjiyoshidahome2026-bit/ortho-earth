import Pbf from 'pbf';
import { inflateRaw } from "../../../native-bucket/src/gzip.js";
import { ALT_TAGS as TAGS } from "./alt-tags.js";

self.onmessage = async function (e) {
    try {
        const v = await fetch(e.data);
        if (!v.ok) throw new Error('not found');

        const pbf = new Pbf(await inflateRaw(await v.arrayBuffer()));
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

        self.postMessage(res);
    } catch (err) {
        self.postMessage({ error: err.message });
    }
};