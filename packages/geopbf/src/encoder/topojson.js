import { GeoPBF } from "../pbf.js";
import { gzip } from "native-bucket";
import { topojson } from "../extension/topojson.js";

onmessage = async (e) => {
    const { buf, name, opts, gintbuf } = e.data, gz = opts && opts.gz;
    try {
        const pbf = await (await new GeoPBF().set(buf)).setGintBUF(gintbuf);
        const topo = await topojson(pbf);
        let out = new File([JSON.stringify(topo)], `${name}.topojson`, { type: "application/json" })
        if (gz) out = await gzip(out);
        postMessage(out);
    } catch (err) {
        console.error("Topojson encode Worker Error:", err);
        postMessage(null);
    }
};