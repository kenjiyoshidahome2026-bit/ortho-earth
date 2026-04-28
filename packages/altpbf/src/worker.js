import { L3 } from "common";
import { Fetch, Bucket, Cache } from "native-bucket";
import { encode, decode, encodeName, decodeName, tiff2raster } from "./altpbf.js";

const dire = `GIS/alt`;
const bucket = await Bucket(dire, { silent: true });
const cache = await Cache(dire);

class getAltPBF {
    constructor() {
        this.baseUrl = "https://www.eorc.jaxa.jp/ALOS";
        this.index = null;
    }
    async init() {
        const indexName = "index";
        this.index = (await loadIndex()) || (await createIndex());
        return this;
        async function loadIndex() { return (await bucket.exist(indexName)) ? bucket.get(indexName, "json") : null; }
        async function createIndex() {
            const tub = {};
            const txt = (await Fetch(`${baseUrl}/jp/dataset/aw3d30/data/List_of_all_tiles_in_AW3D30.txt`, "text")).split("\n");
            txt.forEach(t => {
                const [fname, ver] = t.split(/\s+/);
                lnglat(fname) && (tub[fname] = ver);
            });
            await bucket.put(new File([JSON.stringify(tub)], indexName, { type: "application/json" }));
            return tub;
        }
    }
    async get(name) {
        [lng, lat, range] = decodeName(name);
        if (range !== 1) return bucket.get(name);
        const fname = encodeName(lng, lat); if (!this.index[fname]) return false;
        const source = ["ALOS AW3D30", this.index[fname]].join(" ");
        const f3 = n => (n < 0 ? Math.ceil : Math.floor)(Math.abs(n) / 5) * 5 * (n < 0 ? -1 : 1);
        const LNG = n => (n < 0 ? "W" : "E") + L3(Math.abs(n)), LAT = n => (n < 0 ? "S" : "N") + L3(Math.abs(n));
        const dname = LAT(f3(lat)) + LNG(f3(lng)) + "_" + LAT(f3(lat + 5)) + LNG(f3(lng + 5));
        try {
            const url = `${this.baseUrl}/aw3d30/data/release_v2404/${dname}.zip`;
            const target = `${dname}/ALPSMLC30_${fname}_DSM.tif`;
            const file = await Fetch(url, { target, cors:true });
            const raster = await tiff2raster(file);
            if (!raster || !raster[0]) { console.error("geotiff raster error", raster); return null; }
            const { width, height } = raster, data = raster[0];
            return await encode({ name, source, lng, lat, range, width, height, data });
        } catch(e) { return null; }
    }
}
const AltPBF = await (new getAltPBF()).init();

onmessage = async e => { const { name, lng, lat, range } = e.data;
    try { 
        const dt = performance.now();
        const pbf = AltPBF.get(name); if (!pbf) return postMessage(null);
        const v = decode(pbf); if (!v) return postMessage(null);
        postMessage(v, (v.data && v.data.buffer) ? [v.data.buffer] : []);
        console.log(`[altpbf]  📥 ${name} (${pbf.size.toLocaleString() } bytes) ${(performance.now() - dt).toFixed(2) } msec`);
        await cache(new File([pbf], name, {type:"application/x-altpbf"}));
    } catch (err) { postMessage(null); }
};